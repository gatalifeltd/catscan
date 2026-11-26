// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 06 through the CLI and real Vision: the synthetic truncation slice (D11) with and without boxes, right to
// left, the catalog prefix rule, the converter end to end, serve, and the CLI's own diagnostics.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");
const set = require("./fixtures/truncation-set");
const { Server } = require("../packages/core-js/src/client");

setup();
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-truncation-"));
const LIST = set.draw(2, DIR).map((s) => ({ ...s, path: path.join(DIR, s.name) })); // 12 locales x 2 strings x 3 cases x 2 modes
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));
const draw = (shots) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-t-"));
  fs.writeFileSync(path.join(d, "s.json"), JSON.stringify(shots));
  execFileSync(path.join(ROOT, ".build/synth"), [path.join(d, "s.json"), d]);
  return d;
};
const reasons = (env) => env.findings.map((f) => f.reason);

function runSlice(mode) {
  const envs = [];
  for (const l of set.LOCALES) {
    const d = path.join(DIR, mode, l);
    const r = cli(["truncated", d, "--locale", l, "--json", ...(mode === "box" ? ["--boxes", d] : [])]);
    assert.ok([0, 1].includes(r.code), r.stderr);
    for (const env of r.json) assert.ok(validate(env), `${env.path}: ${JSON.stringify(validate.errors)}`);
    envs.push(...r.json);
  }
  return set.score(LIST.filter((s) => s.mode === mode), envs);
}

// Value: protects=the rules end to end on Vision boxes, per mode; fails_when=a rule, the boxes path or the request field breaks; why_new=new; seam=none; no_claim=real screens (the owner's gate, D1)
test("synthetic slice with boxes: fit passes, ellipsis and clip are found", () => {
  const s = runSlice("box");
  assert.ok(s.precision >= 0.95 && s.recall >= 0.95, JSON.stringify(s));
  assert.ok(s.reasons.edge?.findings > 0 && s.reasons.prefix?.findings > 0 && s.reasons.ellipsis?.findings > 0, JSON.stringify(s.reasons));
});

test("synthetic slice without boxes (the image is the container): screen edge and ellipsis", () => {
  const s = runSlice("crop");
  assert.ok(s.precision >= 0.95 && s.recall >= 0.85, JSON.stringify(s));
  assert.ok(s.reasons["screen-edge"]?.findings > 0, JSON.stringify(s.reasons));
});

test("exit 0 on a fit screen; findings carry the element and the full string", () => {
  const fit = LIST.find((s) => s.mode === "box" && s.locale === "de" && s.case === "fit");
  const ok = cli(["truncated", fit.path, "--locale", "de", "--boxes", fit.path.replace(/\.png$/, ".boxes.json")]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const clip = LIST.find((s) => s.mode === "box" && s.locale === "de" && s.case === "clip");
  const r = cli(["truncated", clip.path, "--locale", "de", "--json", "--boxes", clip.path.replace(/\.png$/, ".boxes.json")]);
  assert.equal(r.code, 1);
  const f = r.json[0].findings[0];
  assert.equal(f.element.id, "e0");
  assert.equal(f.expected, clip.spec.lines[0].full);
  // --reasons edge reports the same cut by its edge.
  const e = cli(["truncated", clip.path, "--locale", "de", "--json", "--reasons", "edge", "--boxes", clip.path.replace(/\.png$/, ".boxes.json")]);
  assert.deepEqual(reasons(e.json[0]), ["edge"]);
});

test("right to left: a line cut at its left end is found, a fit line is not (ar)", () => {
  const ar = "الإعدادات المتقدمة";
  const d = draw([
    { name: "cut.png", locale: "ar", width: 1179, height: 600, lines: [{ text: ar, x: 300, y: 260, size: 48, cut: 0.6, full: ar }] },
    { name: "fit.png", locale: "ar", width: 1179, height: 600, lines: [{ text: ar, x: 300, y: 260, size: 48, cut: 1.15 }] },
  ]);
  const r = cli(["truncated", d, "--locale", "ar", "--json", "--boxes", d]);
  const by = Object.fromEntries(r.json.map((e) => [path.basename(e.path), e.findings]));
  // Vision drops the partly clipped word, so the cut is found by its full text; the edge geometry is TruncationTests'.
  assert.equal(by["cut.png"].length, 1, JSON.stringify(by));
  assert.ok(["edge", "prefix"].includes(by["cut.png"][0].reason));
  assert.equal(by["cut.png"][0].element.id, "e0");
  assert.deepEqual(by["fit.png"], []);
});

// Value: protects=TODO-036 T1 end to end on Vision boxes (golden: overflow found with its amount and element, a D68 overhang and --reasons opt-out silent); fails_when=the rule, the request field or the overflow field breaks; why_new=new reason; seam=none; no_claim=real screens (the gate's real-set count, results/truncation.json)
test("overflow: text drawn 2.5 font sizes past its element is found; a D68 overhang and the opt-out are silent", () => {
  const t = "Jetzt kostenlos testen";
  const d = draw([
    { name: "over.png", locale: "de", width: 1179, height: 600, lines: [{ text: t, x: 160, y: 260, size: 44, over: 2.5, clips: false }] },
    { name: "hang.png", locale: "de", width: 1179, height: 600, lines: [{ text: t, x: 160, y: 260, size: 44, over: 0.5, clips: false }] },
  ]);
  const r = cli(["truncated", d, "--locale", "de", "--json", "--boxes", d]);
  for (const env of r.json) assert.ok(validate(env), JSON.stringify(validate.errors));
  const by = Object.fromEntries(r.json.map((e) => [path.basename(e.path), e.findings]));
  assert.deepEqual(by["over.png"].map((f) => [f.reason, f.element.id, f.expected]), [["overflow", "e0", t]], JSON.stringify(by));
  assert.ok(by["over.png"][0].overflow >= 2 && by["over.png"][0].overflow <= 4.5, JSON.stringify(by["over.png"][0]));
  assert.deepEqual(by["hang.png"], []);
  const off = cli(["truncated", path.join(d, "over.png"), "--locale", "de", "--json", "--boxes", path.join(d, "over.boxes.json"), "--reasons", "ellipsis,prefix,edge,screen-edge"]);
  assert.equal(off.code, 0, off.stdout + off.stderr);
  const text = cli(["truncated", path.join(d, "over.png"), "--locale", "de", "--boxes", path.join(d, "over.boxes.json")]);
  assert.match(text.stdout, /truncated \(overflow\) "Jetzt kostenlos testen" at \[.*\] past e0 \[.*\] by \d+(\.\d+)? line heights/);
});

test("catalog prefix without boxes: a label cut mid-screen is a prefix of its catalog string", () => {
  const clip = LIST.find((s) => s.mode === "box" && s.locale === "de" && s.case === "clip");
  const cat = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-c-")), "de.json");
  fs.writeFileSync(cat, JSON.stringify({ k: clip.spec.lines[0].full }));
  const r = cli(["truncated", clip.path, "--locale", "de", "--json", "--catalog", cat]);
  assert.deepEqual(reasons(r.json[0]), ["prefix"], r.stdout);
  assert.equal(r.json[0].findings[0].expected, clip.spec.lines[0].full);
  assert.equal(r.json[0].findings[0].element, null);
});

test("catscan boxes maestro writes boxes that find the same cut", () => {
  const clip = LIST.find((s) => s.mode === "box" && s.locale === "de" && s.case === "clip");
  const gen = JSON.parse(fs.readFileSync(clip.path.replace(/\.png$/, ".boxes.json"), "utf8"));
  // An iOS dump in points (the image is 3x): the element and a root window of 393x200.
  const b = gen.elements[0].box.map((v, i) => Math.round(v * (i % 2 ? 200 : 393)));
  const dump = { attributes: { bounds: "[0,0][393,200]" }, children: [{ attributes: { text: gen.elements[0].text, "resource-id": "title", bounds: `[${b[0]},${b[1]}][${b[0] + b[2]},${b[1] + b[3]}]` } }] };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-m-"));
  fs.writeFileSync(path.join(d, "shop.maestro.json"), JSON.stringify(dump));
  const conv = cli(["boxes", "maestro", path.join(d, "shop.maestro.json")]);
  assert.equal(conv.code, 0, conv.stderr);
  fs.writeFileSync(path.join(d, "shop.boxes.json"), conv.stdout);
  const r = cli(["truncated", clip.path, "--locale", "de", "--json", "--boxes", path.join(d, "shop.boxes.json")]);
  assert.equal(r.json[0].findings[0].element.id, "title");
  assert.equal(r.json[0].findings[0].expected, gen.elements[0].text);
});

test("diagnostics: boxes-missing is shown under --quiet, boxes-mismatch is exit 4, usage errors are exit 2", () => {
  const de = path.join(DIR, "box/de");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-e-"));
  const one = LIST.find((s) => s.mode === "box" && s.locale === "de" && s.case === "fit");
  const q = cli(["truncated", one.path, "--locale", "de", "--quiet", "--boxes", empty]);
  const want = path.join(empty, path.basename(one.path, ".png") + ".boxes.json");
  assert.match(q.stderr, new RegExp(`^catscan: boxes-missing: no boxes for ${one.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(looked for ${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\); checked without boxes - try: `, "m"));
  const sideways = path.join(empty, "sideways.json");
  fs.writeFileSync(sideways, JSON.stringify({ image: { width: 600, height: 1179 }, elements: [] }));
  const m = cli(["truncated", one.path, "--locale", "de", "--boxes", sideways]);
  assert.equal(m.code, 4);
  assert.match(m.stderr, new RegExp(`catscan: boxes-mismatch: ${one.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: the screenshot is 1179x600 but its boxes are for 600x1179 \\(aspect differs by 74%\\) - try: convert the dump taken with this screenshot again`));
  const u = cli(["truncated", de, "--boxes", sideways]);
  assert.equal(u.code, 2);
  assert.match(u.stderr, /^catscan: boxes-one-image: /);
  assert.equal(cli(["truncated", de, "--reasons", "edg"]).code, 2);
  assert.equal(cli(["boxes", "nope", "x"]).code, 2);
});

// Value: protects=protocol 5 serve accepts the truncated field and rejects a malformed one; fails_when=Serve.swift drops the command or the field validation; why_new=new; seam=none; no_claim=none beyond protects
test("serve answers a truncated request and names a malformed field", async () => {
  const clip = LIST.find((s) => s.mode === "crop" && s.locale === "de" && s.case === "ellipsis");
  const s = new Server();
  await s.ready;
  const env = await s.request({ id: "t1", command: "truncated", path: clip.path, locale: "de", truncated: { reasons: ["ellipsis"] } });
  assert.equal(env.command, "truncated");
  assert.deepEqual(env.findings.map((f) => f.reason), ["ellipsis"]);
  const bad = await s.request({ id: "t2", command: "truncated", path: clip.path, truncated: { reasons: ["nope"] } });
  assert.equal(bad.error.code, "invalid-request");
  assert.match(bad.error.message, /^truncated\.reasons must be a non-empty array of ellipsis, prefix, edge, overflow, screen-edge, pseudo-cut\.$/);
  await s.close();
});
