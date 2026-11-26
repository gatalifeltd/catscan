// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 06 D13, D21, D31, D32: the real-screen gate's scoring math and manifest, on synthetic data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "../../../scripts/truncation-labels.mjs");
const lib = () => import(SCRIPT);

test("wilson: known 95% intervals and empty input", async () => {
  const { wilson } = await lib();
  assert.deepEqual(wilson(27, 30), [0.7438, 0.9654]); // hand-checked: center 0.8546, half-width 0.1108
  assert.deepEqual(wilson(0, 10), [0, 0.2775]);
  assert.equal(wilson(0, 0), null);
});

test("score: precision per reason, recall per class, too few cases under 30 (D21, D32)", async () => {
  const { score } = await lib();
  const cut = { box: [0.1, 0.1, 0.3, 0.02], truncated: true, class: "clip" };
  const ell = { box: [0.1, 0.5, 0.3, 0.02], truncated: true, class: "ellipsis" };
  const fine = { box: [0.1, 0.8, 0.3, 0.02], truncated: false, class: null };
  const r = score([
    // An edge finding on a clipped line, an ellipsis finding on an ellipsis line: both true, whatever the reason.
    { lines: [cut, ell, fine], findings: [{ reason: "edge", box: [0.1, 0.1, 0.29, 0.02] }, { reason: "ellipsis", box: ell.box }] },
    // A screen-edge finding on a fit line is false; the missed clip lowers clip recall.
    { lines: [fine, cut], findings: [{ reason: "screen-edge", box: fine.box }] },
  ]);
  assert.deepEqual([r.precision.k, r.precision.n, r.precision.value], [2, 3, 0.6667]);
  assert.deepEqual([r.recall.k, r.recall.n], [2, 3]);
  assert.equal(r.precision_by_reason.edge.value, 1);
  assert.equal(r.precision_by_reason["screen-edge"].value, 0);
  assert.deepEqual([r.recall_by_class.clip.k, r.recall_by_class.clip.n, r.recall_by_class.ellipsis.value], [1, 2, 1]);
  assert.equal(r.precision.too_few_cases, true);
  // A finding overlapping a label by less than IoU 0.3 is not a match.
  const off = score([{ lines: [cut], findings: [{ reason: "edge", box: [0.35, 0.1, 0.3, 0.02] }] }]);
  assert.equal(off.precision.k, 0);
});

test("scoredImages: draft labels never count; one layout counts once per locale (D13)", async () => {
  const { scoredImages } = await lib();
  const screens = [
    { image: "app-1/de/profile.png", layout: "profile", locale: "de" },
    { image: "app-2/de/profile.png", layout: "profile", locale: "de" },
    { image: "app-2/ru/profile.png", layout: "profile", locale: "ru" },
    { image: "app-1/de/shop.png", layout: "app-1/shop", locale: "de" },
  ];
  const labels = {
    "app-1/de/profile.png": { status: "checked" }, "app-2/de/profile.png": { status: "checked" },
    "app-2/ru/profile.png": { status: "checked" }, "app-1/de/shop.png": { status: "draft" },
  };
  const r = scoredImages(screens, labels);
  assert.deepEqual(r.images.map((s) => s.image), ["app-1/de/profile.png", "app-2/ru/profile.png"]);
  assert.deepEqual([r.drafts, r.duplicates], [1, 1]);
});

test("manifest: pairs a screenshot with its dump, writes the sidecar, prints counts and hashes only (D31)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-man-"));
  const dir = path.join(root, "app-1/de");
  fs.mkdirSync(dir, { recursive: true });
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8); png.write("IHDR", 12);
  png.writeUInt32BE(1080, 16); png.writeUInt32BE(2400, 20);
  fs.writeFileSync(path.join(dir, "shop.png"), png);
  fs.copyFileSync(path.join(__dirname, "fixtures/boxes/shop.uia.xml"), path.join(dir, "shop.uia.xml"));
  fs.writeFileSync(path.join(dir, "bare.png"), png);
  const r = spawnSync(process.execPath, [SCRIPT, "manifest", root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.deepEqual([summary.screens, summary.with_boxes, summary.by_locale], [2, 1, { de: 2 }]);
  assert.match(summary.hashes["app-1/de/shop.png"], /^[0-9a-f]{64}$/);
  assert.ok(!r.stdout.includes("Einstellungen"), "no screen text in the publishable summary");
  const m = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(m.screens.find((s) => s.screen === "shop"), { image: "app-1/de/shop.png", dump: "app-1/de/shop.uia.xml", source: "uiautomator", app: "app-1", locale: "de", screen: "shop", layout: "app-1/shop" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "shop.boxes.json"), "utf8")).image.width, 1080);
  // A hand-set layout survives the next run.
  m.screens[0].layout = "profile";
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(m));
  spawnSync(process.execPath, [SCRIPT, "manifest", root], { encoding: "utf8" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).screens[0].layout, "profile");
});

test("anchors: every anchor screen of any build is reported, flagged only by a finding naming its text (D82)", async () => {
  const { anchorReport } = await lib();
  const crypto = require("node:crypto");
  const text = "Come back tomorrow: day 2";
  const anchors = [{ id: "a", app: "game-2", locale: "ru", screen: "result-toast", text_sha256: crypto.createHash("sha256").update(text).digest("hex") }];
  const screens = [
    { image: "game-2/ru/result-toast--b1.png", app: "game-2", locale: "ru", screen: "result-toast--b1" },
    { image: "game-2/ru/result-toast--b2.png", app: "game-2", locale: "ru", screen: "result-toast--b2" },
    { image: "game-2/ru/result-toast-bonus--b1.png", app: "game-2", locale: "ru", screen: "result-toast-bonus--b1" },
    { image: "game-2/de/result-toast--b1.png", app: "game-2", locale: "de", screen: "result-toast--b1" },
    // Generated by /ship coverage audit.
    // Value: protects=anchorReport matches a screen name with no build suffix and treats a finding with no expected
    // text (D66 screen-edge) as not naming the anchor; fails_when=the expected != null guard is dropped (hashing null
    // throws) or the suffix split stops matching a bare name; why_new=existing rows all carry --<build> and an expected
    // string; seam=none; no_claim=real catscan findings (synthetic envelopes; unit only)
    { image: "game-2/ru/result-toast.png", app: "game-2", locale: "ru", screen: "result-toast" },
  ];
  const found = new Map([
    ["game-2/ru/result-toast--b1.png", { findings: [{ reason: "screen-edge", expected: text }] }],
    ["game-2/ru/result-toast--b2.png", { findings: [{ reason: "edge", expected: "Another string" }] }],
    ["game-2/ru/result-toast.png", { findings: [{ reason: "screen-edge", expected: null }, { reason: "edge" }] }],
  ]);
  assert.deepEqual(anchorReport(screens, found, anchors), [
    { anchor: "a", image: "game-2/ru/result-toast--b1.png", flagged: true },
    { anchor: "a", image: "game-2/ru/result-toast--b2.png", flagged: false },
    { anchor: "a", image: "game-2/ru/result-toast.png", flagged: false },
  ]);
});

// Value: protects=score runs an unchecked anchor screen, prints MISSED and lists it unflagged; a set without it says "not in set";
// fails_when=anchor screens are dropped from the run or the absent anchor is silent; why_new=only anchorReport was unit-tested;
// seam=none; no_claim=the exit code (precision is empty here; gateFails below covers it) and the flagged path, which needs a
// real anchor screen (proprietary set)
test("score: an anchor screen no finding names is MISSED, and a set without it says so (D82)", () => {
  const blank = (w, h) => { // a white RGB PNG: Vision reads nothing on it
    const crc = (b) => { let x = ~0; for (const v of b) { x ^= v; for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1; } return ~x >>> 0; };
    const chunk = (t, d) => { const td = Buffer.concat([Buffer.from(t), d]), o = Buffer.alloc(8 + td.length); o.writeUInt32BE(d.length); td.copy(o, 4); o.writeUInt32BE(crc(td), 4 + td.length); return o; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h, 255); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", require("zlib").deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-anchor-"));
  fs.mkdirSync(path.join(root, "game-2/ru"), { recursive: true });
  fs.writeFileSync(path.join(root, "game-2/ru/result-toast--b1.png"), blank(64, 64));
  fs.writeFileSync(path.join(root, "game-2/ru/result-toast--b1.boxes.json"), JSON.stringify({ image: { width: 64, height: 64 }, elements: [] }));
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ screens: [{ image: "game-2/ru/result-toast--b1.png", source: "playwright", app: "game-2", locale: "ru", screen: "result-toast--b1", layout: "game-2/result-toast" }] }));
  fs.writeFileSync(path.join(root, "labels.json"), "{}");
  const r = spawnSync(process.execPath, [SCRIPT, "score", root], { encoding: "utf8" });
  assert.match(r.stderr, /anchor dnt-ru-result-toast: MISSED game-2\/ru\/result-toast--b1\.png/);
  assert.deepEqual(JSON.parse(r.stdout).anchors.filter((a) => a.anchor === "dnt-ru-result-toast"), [{ anchor: "dnt-ru-result-toast", image: "game-2/ru/result-toast--b1.png", flagged: false }]);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-anchor-"));
  fs.writeFileSync(path.join(empty, "manifest.json"), JSON.stringify({ screens: [] }));
  const e = spawnSync(process.execPath, [SCRIPT, "score", empty], { encoding: "utf8" });
  assert.match(e.stderr, /anchor dnt-ru-result-toast: not in set/);
  assert.ok(JSON.parse(e.stdout).anchors_absent.includes("dnt-ru-result-toast"));
});

// Value: protects=a missed anchor fails the gate even when precision passes; fails_when=the anchor clause is dropped;
// why_new=the spawn test above cannot isolate it (empty precision fails too); seam=none; no_claim=none beyond protects
test("gate: a missed anchor fails a run whose precision passes; a flagged one does not (D82)", async () => {
  const { gateFails } = await lib();
  const ok = { precision: { value: 0.95 } };
  assert.equal(gateFails(ok, []), false);
  assert.equal(gateFails(ok, [{ anchor: "a", image: "x.png", flagged: true }]), false);
  assert.equal(gateFails(ok, [{ anchor: "a", image: "x.png", flagged: true }, { anchor: "a", image: "y.png", flagged: false }]), true);
  assert.equal(gateFails({ precision: { value: 0.89 } }, []), true);
  assert.equal(gateFails({ precision: { value: null } }, []), true);
});

test("score: a failed catscan run stops the score instead of counting as clean screens", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-score-"));
  const dir = path.join(root, "app-1/de");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "shop.png"), Buffer.alloc(8));
  fs.writeFileSync(path.join(dir, "shop.boxes.json"), "{"); // exit 2 before any recognition
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ screens: [{ image: "app-1/de/shop.png", source: "uiautomator", app: "app-1", locale: "de", screen: "shop", layout: "app-1/shop" }] }));
  fs.writeFileSync(path.join(root, "labels.json"), JSON.stringify({ "app-1/de/shop.png": { status: "checked", lines: [] } }));
  const r = spawnSync(process.execPath, [SCRIPT, "score", root], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /catscan truncated .*: exit 2: .*invalid-boxes/);
  assert.equal(r.stdout, "");
});
