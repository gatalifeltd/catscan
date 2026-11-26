// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-088 unit tests (Test plan / coverage, Unit): the opt-in save folder, its names, retries, content and errors,
// through the matchers with the spec 13 fakes (no binary, no browser).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { harness, envelope } = require("./helpers");
const save = require("../src/save");
const coreBoxes = require("@catscan/core-js/src/boxes");
const pwBoxes = require("../src/boxes");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "catscan-save-"));
const hash = (titles) => crypto.createHash("sha1").update(JSON.stringify(titles)).digest("hex").slice(0, 6);
const listPngs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(png|boxes\.json)$/.test(f)).sort() : []);
const H = hash(["shows the menu"]);
const STABLE = { viewport: { width: 1280, height: 720 }, dpr: 1, elements: [{ text: "Play", rect: { x: 10, y: 10, width: 100, height: 20 } }] };
const MOVED = { ...STABLE, elements: [{ text: "Play", rect: { x: 12, y: 10, width: 100, height: 20 } }] };
const cut = (req) => envelope(req, req.command === "truncated" ? { verdict: "fail", findings: [{ kind: "truncated", reason: "ellipsis", line: "Sett...", box: [0, 0, 0.1, 0.1] }] } : {});
const notReady = (req) => envelope(req, req.command === "check" ? { verdict: "fail", checks: [{ kind: "present", text: "Play", verdict: "fail", line: null, closest: null }] } : {});

test.beforeEach(() => save._reset());

test("opt-out: no saveDir and no CATSCAN_SAVE_DIR write nothing; saveDir false wins over the env var (D1)", async () => {
  // Value: protects=off by default; fails_when=saving runs without the opt-in, or false does not turn the env var off.
  const dir = tmpDir();
  const off = harness({ collects: [STABLE] });
  await off.matchers.toHaveNoTruncation.call(off.ctx(), off.page, { readyText: false });
  const no = harness({ collects: [STABLE], envVars: { CATSCAN_SAVE_DIR: dir }, defaults: { saveDir: false } });
  await no.matchers.toHaveNoTruncation.call(no.ctx(), no.page, { readyText: false });
  assert.deepEqual(listPngs(dir), []);
  assert.doesNotMatch(off.stderr + no.stderr, /saving checked screens/);
});

test("opt-in: the env var alone saves, saveDir wins over it, a relative path resolves against the working directory (D1)", async () => {
  const envDir = tmpDir(), optDir = tmpDir();
  const e = harness({ collects: [STABLE], envVars: { CATSCAN_SAVE_DIR: envDir } });
  await e.matchers.toHaveNoTruncation.call(e.ctx(), e.page, { readyText: false });
  assert.deepEqual(listPngs(envDir), [`en/chromium-1280x720/menu.spec/shows-the-menu-${H}-1.boxes.json`, `en/chromium-1280x720/menu.spec/shows-the-menu-${H}-1.png`]);
  const o = harness({ collects: [STABLE], envVars: { CATSCAN_SAVE_DIR: envDir }, defaults: { saveDir: optDir } });
  await o.matchers.toShowText.call(o.ctx(), o.page, "Play", { readyText: false });
  assert.equal(listPngs(optDir).length, 2);
  assert.equal(save.root({ saveDir: "test-results/catscan" }), path.resolve("test-results/catscan"));
  assert.equal(save.root({}, () => "   "), null);
});

test("names: render, spec path, title, hash and call order; slugs keep every segment inside the folder (D2, D4)", async () => {
  const dir = tmpDir();
  const h = harness({ collects: [STABLE], defaults: { saveDir: dir }, render: { width: 390, height: 844, dpr: 3, dark: true }, browser: "webkit" });
  h.info.file = path.join(h.info.project.testDir, "shop", "cart.spec.ts");
  h.info.titlePath = ["shop/cart.spec.ts", "cart", "../../etc/passwd: ok?"];
  await h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: false });
  await h.matchers.toShowText.call(h.ctx(), h.page, "Play", { readyText: false, screen: "../shop//checkout " });
  const t = hash(["cart", "../../etc/passwd: ok?"]);
  assert.deepEqual(listPngs(dir).filter((f) => f.endsWith(".png")), [
    "en/webkit-390x844-3x-dark/shop/cart.spec/cart-..-..-etc-passwd-ok-" + t + "-1.png",
    "en/webkit-390x844-3x-dark/shop/checkout.png",
  ].sort());
  assert.ok(listPngs(dir).every((f) => !f.split("/").includes("..")));
});

test("pairing: en then de in one test are both call 1; a not-ready call still advances the count (D3)", async () => {
  // Value: protects=fit's locale pairing by screen name; fails_when=the count is per test, not per locale, or skips a not-ready call.
  const dir = tmpDir();
  const h = harness({ collects: [STABLE], defaults: { saveDir: dir }, respond: notReady });
  await h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: false, locale: "en" });
  await h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: false, locale: "de" });
  await h.matchers.toHaveNoTruncation.call(h.ctx(false, 300), h.page, { readyText: "Play", locale: "de" });
  await h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: false, locale: "de" });
  assert.deepEqual(listPngs(dir).filter((f) => f.endsWith(".png")), [
    `de/chromium-1280x720/menu.spec/shows-the-menu-${H}-1.png`, `de/chromium-1280x720/menu.spec/shows-the-menu-${H}-3.png`,
    `en/chromium-1280x720/menu.spec/shows-the-menu-${H}-1.png`,
  ]);
});

test("retries overwrite their own files; a repeatEach repeat gets -repeat<k>; two renders of one test never share a path (D2, D5)", async () => {
  const dir = tmpDir();
  const first = harness({ collects: [STABLE], defaults: { saveDir: dir } });
  await first.matchers.toHaveNoTruncation.call(first.ctx(), first.page, { readyText: false });
  const same = { project: first.info.project, file: first.info.file };
  const retry = harness({ collects: [STABLE], defaults: { saveDir: dir }, info: { ...same, retry: 1 } });
  await retry.matchers.toHaveNoTruncation.call(retry.ctx(), retry.page, { readyText: false });
  assert.equal(listPngs(dir).length, 2);
  const repeat = harness({ collects: [STABLE], defaults: { saveDir: dir }, info: { ...same, repeatEachIndex: 1 } });
  await repeat.matchers.toHaveNoTruncation.call(repeat.ctx(), repeat.page, { readyText: false });
  const dark = harness({ collects: [STABLE], defaults: { saveDir: dir }, info: same, render: { width: 1280, height: 720, dpr: 1, dark: true } });
  await dark.matchers.toHaveNoTruncation.call(dark.ctx(), dark.page, { readyText: false });
  assert.deepEqual(listPngs(dir).filter((f) => f.endsWith(".png")), [
    `en/chromium-1280x720-dark/menu.spec/shows-the-menu-${H}-1.png`,
    `en/chromium-1280x720/menu.spec/shows-the-menu-${H}-1-repeat1.png`,
    `en/chromium-1280x720/menu.spec/shows-the-menu-${H}-1.png`,
  ]);
});

test("content: the checked PNG and a sidecar boxes.load accepts; toShowText saves boxes it never sends; a fail saves too (D8)", async () => {
  const dir = tmpDir();
  const t = harness({ collects: [STABLE], defaults: { saveDir: dir }, respond: cut });
  const r = await t.matchers.toHaveNoTruncation.call(t.ctx(), t.page, { readyText: false });
  assert.equal(r.pass, false);
  const base = path.join(dir, `en/chromium-1280x720/menu.spec/shows-the-menu-${H}-1`);
  assert.deepEqual(fs.readFileSync(`${base}.png`), fs.readFileSync(path.join(t.tmp, fs.readdirSync(t.tmp).find((f) => f.endsWith(".png")))));
  const side = coreBoxes.load(`${base}.boxes.json`);
  assert.equal(side.elements[0].text, "Play");
  assert.equal(side.scale, 1, "a scale-1 sidecar states its scale, for contrast");
  assert.match(r.message(), new RegExp(`saved: ${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.png`));
  const sDir = tmpDir();
  const s = harness({ collects: [STABLE], defaults: { saveDir: sDir } });
  await s.matchers.toShowText.call(s.ctx(), s.page, "Play", { readyText: false });
  assert.ok(s.commands().every((q) => !q.truncated && !q.overlap && !q.boxes), "toShowText sends no boxes");
  assert.equal(coreBoxes.load(path.join(sDir, `en/chromium-1280x720/menu.spec/shows-the-menu-${H}-1.boxes.json`)).elements.length, 1);
});

test("content: unstable or failing box reads save the PNG only and delete a stale sidecar; a not-ready final frame saves nothing (D6, D8)", async () => {
  // Value: protects=no stale boxes for a new frame; fails_when=the old sidecar stays, or a read error throws.
  const dir = tmpDir();
  const rel = `en/chromium-1280x720/menu.spec/shows-the-menu-${H}-1`;
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, `${rel}.boxes.json`), "{}");
  const u = harness({ collects: [STABLE, MOVED], defaults: { saveDir: dir } });
  const r = await u.matchers.toShowText.call(u.ctx(), u.page, "Play", { readyText: false });
  assert.equal(r.pass, true);
  assert.deepEqual(listPngs(dir), [`${rel}.png`]);
  const dir2 = tmpDir();
  const b = harness({ collects: [STABLE], defaults: { saveDir: dir2 } });
  const evaluate = b.page.evaluate;
  b.page.evaluate = async (fn) => { if (fn === pwBoxes.collect) throw new Error("page closed"); return evaluate(fn); };
  assert.equal((await b.matchers.toHaveNoUntranslated.call(b.ctx(), b.page, { readyText: false })).pass, true);
  assert.deepEqual(listPngs(dir2), [`${rel}.png`]);
  const dir3 = tmpDir();
  const n = harness({ collects: [STABLE], defaults: { saveDir: dir3 }, respond: notReady });
  await n.matchers.toHaveNoTruncation.call(n.ctx(false, 300), n.page, { readyText: "Play" });
  assert.deepEqual(listPngs(dir3), []);
});

test("save-failed: throws with the path on a pass, is a message line on a fail, and keeps no file of the shot (D7, D10)", async () => {
  const file = path.join(tmpDir(), "not-a-folder");
  fs.writeFileSync(file, "");
  const dir = path.join(file, "shots");
  const p = harness({ collects: [STABLE], defaults: { saveDir: dir } });
  await assert.rejects(p.matchers.toHaveNoTruncation.call(p.ctx(), p.page, { readyText: false }),
    (e) => e.code === "save-failed" && e.message.includes(dir) && /Fix: make .* writable, or unset saveDir and CATSCAN_SAVE_DIR/.test(e.message) && e.anchor === "save-failed");
  const f = harness({ collects: [STABLE], defaults: { saveDir: dir }, respond: cut });
  const r = await f.matchers.toHaveNoTruncation.call(f.ctx(), f.page, { readyText: false });
  assert.equal(r.pass, false);
  assert.match(r.message(), /cut off[\s\S]*catscan save-failed: cannot save/);
  assert.doesNotMatch(r.message(), /saved: /);
});

test("save-collision: two tests that pass one screen throw; a retry of the same call does not (D11)", async () => {
  const dir = tmpDir();
  const a = harness({ collects: [STABLE], defaults: { saveDir: dir }, testId: "a" });
  await a.matchers.toShowText.call(a.ctx(), a.page, "Play", { readyText: false, screen: "home" });
  const retry = harness({ collects: [STABLE], defaults: { saveDir: dir }, testId: "a" });
  await retry.matchers.toShowText.call(retry.ctx(), retry.page, "Play", { readyText: false, screen: "home" });
  const b = harness({ collects: [STABLE], defaults: { saveDir: dir }, testId: "b", info: { titlePath: ["menu.spec.js", "other test"] } });
  await assert.rejects(b.matchers.toShowText.call(b.ctx(), b.page, "Play", { readyText: false, screen: "home" }),
    (e) => e.code === "save-collision" && /other test and menu.spec.js > shows the menu both save to/.test(e.message) && /Fix: pass a screen option/.test(e.message));
});

test("usage: saveDir on a call, screen in the defaults, and wrong types are playwright-usage; screen with saving off is fine (D12, D13)", async () => {
  const h = harness({ collects: [STABLE] });
  const usage = (re) => (e) => e.code === "playwright-usage" && re.test(e.message);
  await assert.rejects(h.matchers.toShowText.call(h.ctx(), h.page, "Play", { saveDir: "x" }), usage(/saveDir is a project default/));
  await assert.rejects(h.matchers.toShowText.call(h.ctx(), h.page, "Play", { screen: "/../" }), usage(/screen is "\/..\/"/));
  assert.throws(() => harness({ defaults: { screen: "home" } }), usage(/not a catscanMatchers\(\) default/));
  assert.throws(() => harness({ defaults: { saveDir: 5 } }), usage(/saveDir is 5/));
  assert.equal((await h.matchers.toShowText.call(h.ctx(), h.page, "Play", { readyText: false, screen: "home" })).pass, true);
});

test("visibility: the first save in a worker prints the folder once (D13)", async () => {
  const dir = tmpDir();
  const h = harness({ collects: [STABLE], defaults: { saveDir: dir } });
  await h.matchers.toShowText.call(h.ctx(), h.page, "Play", { readyText: false });
  await h.matchers.toShowText.call(h.ctx(), h.page, "Play", { readyText: false });
  assert.equal(h.stderr.split(`catscan: saving checked screens under ${dir}\n`).length, 2);
});

test("pseudo: an en-XA page saves under a -pseudo render, apart from the en project's shot of the same test (review)", async () => {
  // Value: protects=the en base shot fit pairs against; fails_when=pseudo shots land on the en path and collide or overwrite it.
  const dir = tmpDir();
  const en = harness({ collects: [STABLE], defaults: { saveDir: dir }, testId: "en" });
  await en.matchers.toHaveNoTruncation.call(en.ctx(), en.page, { readyText: false });
  const xa = harness({ collects: [STABLE], defaults: { saveDir: dir }, nav: "en-XA", testId: "xa" });
  await xa.matchers.toHaveNoOverlap.call(xa.ctx(), xa.page, { readyText: false });
  assert.deepEqual(listPngs(dir).filter((f) => f.endsWith(".png")), [
    `en/chromium-1280x720-pseudo/menu.spec/shows-the-menu-${H}-1.png`, `en/chromium-1280x720/menu.spec/shows-the-menu-${H}-1.png`,
  ]);
});

test("save-collision: screen names that differ only in case are one file on macOS (review)", { skip: process.platform !== "darwin" }, async () => {
  const dir = tmpDir();
  const a = harness({ collects: [STABLE], defaults: { saveDir: dir }, testId: "a" });
  await a.matchers.toShowText.call(a.ctx(), a.page, "Play", { readyText: false, screen: "Settings" });
  const b = harness({ collects: [STABLE], defaults: { saveDir: dir }, testId: "b" });
  await assert.rejects(b.matchers.toShowText.call(b.ctx(), b.page, "Play", { readyText: false, screen: "settings" }), (e) => e.code === "save-collision");
});

test("temp files: a symlink planted at the temp name or the final name is never written through (TODO-107)", () => {
  // Value: protects=a writer in the save folder cannot redirect the save into another file; fails_when=temp names are predictable or opened without O_EXCL|O_NOFOLLOW; why_new=temp scheme; seam=suffix hook; no_claim=cleanup after a failed save
  const dir = tmpDir();
  const victim = path.join(tmpDir(), "victim.txt");
  fs.writeFileSync(victim, "keep");
  const png = path.join(tmpDir(), "shot.png");
  fs.writeFileSync(png, "PNGDATA");
  const owner = (k) => ({ key: k, title: k });
  const abs = path.join(dir, "en/s1.png");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // The old predictable names and the final names as symlinks: the save replaces the links, never their target.
  for (const f of [`${abs}.${process.pid}.tmp`, path.join(dir, `en/s1.boxes.json.${process.pid}.tmp`), abs, path.join(dir, "en/s1.boxes.json")]) fs.symlinkSync(victim, f);
  assert.equal(save.write({ dir, rel: "en/s1", owner: owner("a"), png, boxes: STABLE, stderr: () => {} }), abs);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  assert.ok(fs.lstatSync(abs).isFile() && fs.lstatSync(path.join(dir, "en/s1.boxes.json")).isFile());
  assert.equal(fs.readFileSync(abs, "utf8"), "PNGDATA");
  // The exact random name the next save uses, planted in advance: the save fails and the target is untouched.
  save._tempSuffix(() => "fixed");
  try {
    fs.symlinkSync(victim, path.join(dir, "en/s2.png.fixed.tmp"));
    assert.throws(() => save.write({ dir, rel: "en/s2", owner: owner("b"), png, boxes: null, stderr: () => {} }), (e) => e.code === "save-failed");
    assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  } finally { save._tempSuffix(null); }
});

test("temp files: a folder of the save path planted as a symlink is refused, and nothing past it is written or deleted (TODO-107 review)", () => {
  // Value: protects=a writer in the save folder cannot redirect the save through a linked folder; fails_when=the save follows a symlinked segment; why_new=review fix; seam=none; no_claim=a link swapped in after the check
  const dir = tmpDir();
  const outside = tmpDir();
  fs.writeFileSync(path.join(outside, "s1.png"), "keep");
  fs.symlinkSync(outside, path.join(dir, "en"));
  const png = path.join(tmpDir(), "shot.png");
  fs.writeFileSync(png, "PNGDATA");
  assert.throws(() => save.write({ dir, rel: "en/s1", owner: { key: "a", title: "a" }, png, boxes: null, stderr: () => {} }), (e) => e.code === "save-failed" && /links outside the save folder/.test(e.message));
  assert.deepEqual(fs.readdirSync(outside), ["s1.png"]);
  assert.equal(fs.readFileSync(path.join(outside, "s1.png"), "utf8"), "keep");
  // A link above the last folder: refused before mkdir makes any folder past it (review).
  assert.throws(() => save.write({ dir, rel: "en/r/s1", owner: { key: "b", title: "b" }, png, boxes: null, stderr: () => {} }), (e) => e.code === "save-failed");
  assert.deepEqual(fs.readdirSync(outside), ["s1.png"]);
});
