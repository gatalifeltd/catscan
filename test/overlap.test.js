// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 12 through the CLI and real Vision: screens drawn by the overlap generator (D10), exit codes, the schema, the
// --experimental gate (D18) and serve.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");
const { Server } = require("../packages/core-js/src/client");

setup();
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-overlap-"));
const shot = (n) => path.join(DIR, n);
const base = { locale: "de", theme: "light", a: "Einstellungen", b: "Benachrichtigungen", distractors: ["Start", "Optionen", "Hilfe"] };
// Measured on macOS 27.2.1: the icon caption 8 px under its label is read as two lines sharing 0.26 of the smaller
// box (found at --min-overlap 0.2, not at the default 0.3); the 4 px gap is never found.
const PLAN = [
  { ...base, name: "hit.png", layout: "icon", amount: 8, size: 17, shift: 0.2 },
  { ...base, name: "gap.png", layout: "vv", amount: -4, size: 17, shift: 0.15 },
  // TODO-046 D5: elements goldens. A 10 px stack Vision merges into one line; a label drawn over the 48 px icon (an
  // empty caption puts the label at the icon's center, `amount` -14 lifts it onto the icon).
  { ...base, name: "el/stack.png", layout: "vv", amount: 10, size: 17, shift: 0.15 },
  { ...base, name: "el/icon.png", layout: "icon", amount: -14, size: 17, a: "", b: "Angebote", shift: 0 },
  { ...base, name: "el/gap.png", layout: "vv", amount: -4, size: 17, shift: 0.15 },
];
const gen = path.join(DIR, "gen");
execFileSync("swiftc", ["-O", path.join(ROOT, "bench/overlap/generate.swift"), "-o", gen]);
fs.writeFileSync(path.join(DIR, "plan.json"), JSON.stringify(PLAN));
const drawn = JSON.parse(execFileSync(gen, [path.join(DIR, "plan.json"), DIR], { encoding: "utf8" }));
// TODO-046 D5: each golden's boxes sidecar from the generator's typographic boxes, frames padded 6 px (so the gap
// golden's frames intersect while its ink does not); the icon's rect is generate.swift's fixed 48 px icon at 3x.
for (const im of drawn.images.filter((i) => i.name.startsWith("el/"))) {
  const pad = 18, { width: W, height: H } = im;
  const n = ([x, y, w, h]) => { const x0 = Math.max(0, x - pad), y0 = Math.max(0, y - pad); return [x0 / W, y0 / H, (Math.min(W, x + w + pad) - x0) / W, (Math.min(H, y + h + pad) - y0) / H]; };
  const elements = im.lines.filter((l) => l.text && l.box[2] > 0).map((l, i) => ({ id: l.role === "d" ? `d${i}` : l.role, box: n(l.box), text: l.text }));
  if (im.name === "el/icon.png") elements.push({ id: "bell", box: [90 / W, 630 / H, 144 / W, 144 / H], graphic: true });
  fs.writeFileSync(shot(im.name.replace(/\.png$/, ".boxes.json")), JSON.stringify({ image: { width: W, height: H }, elements }));
}
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));

// Value: protects=the rule end to end on Vision boxes, --min-overlap through to the core, exit codes; fails_when=the request field, the threshold or the envelope breaks; why_new=new command; seam=none; no_claim=recall (bench/overlap.js)
test("a stacked pair is found at --min-overlap 0.2 and passes at the default; a gap passes", () => {
  const hit = cli(["overlap", shot("hit.png"), "--locale", "de", "--experimental", "--min-overlap", "0.2", "--json"]);
  assert.equal(hit.code, 1, hit.stderr);
  const env = hit.json[0];
  assert.ok(validate(env), JSON.stringify(validate.errors));
  assert.equal(env.command, "overlap");
  assert.deepEqual(env.findings.map((f) => [f.kind, f.signal]), [["overlap", "boxes"]]);
  assert.ok(env.findings[0].overlap >= 0.2 && env.findings[0].overlap < 0.3, String(env.findings[0].overlap));
  assert.equal(cli(["overlap", shot("hit.png"), "--locale", "de", "--experimental"]).code, 0);
  const gap = cli(["overlap", shot("gap.png"), "--locale", "de", "--experimental", "--min-overlap", "0.01", "--json"]);
  assert.equal(gap.code, 0, gap.stderr);
  assert.deepEqual(gap.json[0].findings, []);
});

// Value: protects=TODO-067 D17 (plain overlap runs the default-on stacked reader only; the OCR-only reader still runs only by name); fails_when=the CLI stops sending geometry false or the core ignores it; why_new=D17 replaced the usage error; seam=none; no_claim=stacked recall (bench/stacked-real.js)
test("without --experimental only the stacked reader runs", () => {
  const r = cli(["overlap", shot("hit.png"), "--locale", "de", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json[0].findings, []);
});

// Value: protects=the serve contract (protocol 7, the overlap field, invalid-request); fails_when=the core and client drift; why_new=new field; seam=none; no_claim=none beyond protects
test("serve: an overlap request; a malformed min_overlap is invalid-request", async () => {
  const s = new Server();
  await s.ready;
  const ok = await s.request({ id: "o1", command: "overlap", path: shot("hit.png"), locale: "de", overlap: { min_overlap: 0.2 } });
  assert.deepEqual(ok.findings.map((f) => f.signal), ["boxes"]);
  const off = await s.request({ id: "o1g", command: "overlap", path: shot("hit.png"), locale: "de", overlap: { min_overlap: 0.2, geometry: false, stacked: true } });
  assert.deepEqual(off.findings, []); // TODO-067 D17: the geometry pair is not reported
  const none = await s.request({ id: "o1i", command: "overlap", path: shot("hit.png"), locale: "de", overlap: { geometry: false } });
  assert.equal(none.error.code, "invalid-request"); // D35: no reader would run
  const badGeometry = await s.request({ id: "o1h", command: "overlap", path: shot("hit.png"), overlap: { geometry: "no" } });
  assert.equal(badGeometry.error.code, "invalid-request");
  const bad = await s.request({ id: "o2", command: "overlap", path: shot("hit.png"), overlap: { min_overlap: 2 } });
  assert.equal(bad.error.code, "invalid-request");
  assert.match(bad.error.message, /overlap\.min_overlap/);
  await s.close();
});

// Value: protects=the TODO-046 elements reader end to end on Vision (a merged stack confirmed through a shared line, a label over an icon, padded frames with an ink gap passing), exit codes and the schema; fails_when=the boxes field, the ranges or the envelope break; why_new=new reader; seam=none; no_claim=recall and precision (bench/overlap-elements.js)
test("overlap --boxes: a merged stack and a label over an icon fail, padded frames with a gap pass", () => {
  const el = path.join(DIR, "el");
  const r = cli(["overlap", el, "--boxes", el, "--locale", "de", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  const by = Object.fromEntries(r.json.map((e) => [path.basename(e.path), e]));
  for (const e of r.json) assert.ok(validate(e), JSON.stringify(validate.errors));
  assert.deepEqual(by["stack.png"].findings.map((f) => [f.signal, f.a.element.id, f.b.element.id]), [["elements", "a", "b"]]);
  assert.deepEqual(by["icon.png"].findings.map((f) => [f.signal, f.line, f.b.text, f.b.confidence]), [["elements", "Angebote / [bell]", null, null]]);
  assert.deepEqual(by["gap.png"].findings, []);
  assert.equal(by["gap.png"].verdict, "pass");
  // Text output names the graphic by its id; the image-only run exits 0.
  assert.match(cli(["overlap", shot("el/icon.png"), "--boxes", shot("el/icon.boxes.json"), "--locale", "de"]).stdout, /overlap "Angebote" \/ \[bell\] \(\d+%\)/);
  assert.equal(cli(["overlap", shot("el/gap.png"), "--boxes", shot("el/gap.boxes.json"), "--locale", "de"]).code, 0);
});

// Value: protects=TODO-046 D3, D10, D12 in the CLI (overlap-no-boxes exit 4 naming the sidecar, --experimental falls back with boxes-missing, stdin, no-graphic-elements once, --allow by id and text); fails_when=a missing sidecar passes silently or a diagnostic drifts; why_new=new behavior; seam=none; no_claim=none beyond protects
test("overlap --boxes <dir>: a missing sidecar is overlap-no-boxes; --experimental falls back; --allow drops", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-overlap-nb-"));
  fs.copyFileSync(shot("el/stack.png"), path.join(dir, "stack.png"));
  fs.copyFileSync(shot("el/stack.boxes.json"), path.join(dir, "stack.boxes.json"));
  fs.copyFileSync(shot("el/gap.png"), path.join(dir, "shop.png"));
  const r = cli(["overlap", dir, "--boxes", dir, "--locale", "de", "--json"]);
  assert.equal(r.code, 4, r.stderr);
  const shop = r.json.find((e) => e.path.endsWith("shop.png"));
  assert.equal(shop.verdict, "error");
  assert.ok(validate(shop), JSON.stringify(validate.errors));
  const sidecar = path.join(dir, "shop.boxes.json");
  assert.deepEqual(shop.error, { code: "overlap-no-boxes", message: `no boxes for ${path.join(dir, "shop.png")} (looked for ${sidecar}); element overlap needs its boxes`, hint: `catscan boxes <source> <dump> --image ${path.join(dir, "shop.png")} > ${sidecar}, or add --experimental for the OCR-only check` });
  // D12: the run has no graphic element, said once.
  assert.equal(r.stderr.split("no-graphic-elements").length - 1, 1, r.stderr);
  const x = cli(["overlap", dir, "--boxes", dir, "--locale", "de", "--json", "--experimental", "--quiet"]);
  assert.equal(x.code, 1, x.stderr);
  assert.match(x.stderr, new RegExp(`boxes-missing: no boxes for ${path.join(dir, "shop.png").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(looked for .*\\); checked with the OCR-only overlap reader`));
  assert.equal(x.json.find((e) => e.path.endsWith("shop.png")).verdict, "pass");
  const stdin = cli(["overlap", "-", "--boxes", dir, "--locale", "de", "--json"], { input: fs.readFileSync(shot("el/stack.png")) });
  assert.equal(stdin.code, 4);
  assert.match(stdin.json[0].error.message, /^no boxes for - \(stdin has no path to find a sidecar by\)/);
  for (const allow of ["b", "Einstellungen"]) {
    fs.writeFileSync(path.join(dir, "allow.txt"), `# intended\n${allow}\n`);
    const a = cli(["overlap", path.join(dir, "stack.png"), "--boxes", path.join(dir, "stack.boxes.json"), "--locale", "de", "--allow", path.join(dir, "allow.txt"), "--json"]);
    assert.equal(a.code, 0, `${allow}: ${a.stderr}`);
  }
});

// Value: protects=the serve contract for overlap boxes (protocol 11, 12 since TODO-049, boxes, graphic validation, boxes-mismatch); fails_when=the core and client drift; why_new=new field; seam=none; no_claim=none beyond protects
test("serve: overlap with boxes; a bad graphic is invalid-request; boxes for another aspect are boxes-mismatch", async () => {
  const s = new Server();
  await s.ready;
  const boxes = JSON.parse(fs.readFileSync(shot("el/icon.boxes.json"), "utf8"));
  const ok = await s.request({ id: "e1", command: "overlap", path: shot("el/icon.png"), locale: "de", overlap: { boxes } });
  assert.deepEqual(ok.findings.map((f) => f.signal), ["elements"]);
  const bad = await s.request({ id: "e2", command: "overlap", path: shot("el/icon.png"), overlap: { boxes: { ...boxes, elements: [{ box: [0.1, 0.1, 0.1, 0.1], graphic: "yes" }] } } });
  assert.equal(bad.error.code, "invalid-request");
  assert.match(bad.error.message, /overlap\.boxes\.elements\[0\]\.graphic must be true or false/);
  const mis = await s.request({ id: "e3", command: "overlap", path: shot("el/icon.png"), overlap: { boxes: { ...boxes, image: { width: 1000, height: 1000 } } } });
  assert.equal(mis.error.code, "boxes-mismatch");
  await s.close();
});

// Value: protects=TODO-049 end to end on Vision reads (a label cut by an opaque bar is occluded only with --experimental; the same boxes over the unpainted screen pass, the ink deciding; the two run warnings); fails_when=the request field, the rule's edge test or the warnings break; why_new=new kind; seam=none; no_claim=recall and precision (bench/overlap-elements.js)
test("occluded: a label cut by an opaque bar, only with --experimental; the same boxes on the bare screen pass (TODO-049)", () => {
  const im = drawn.images.find((i) => i.name === "el/gap.png");
  const a = im.lines.find((l) => l.role === "a");
  const { width: W, height: H } = im;
  const bar = [Math.round(a.box[0] + 0.55 * a.box[2]), Math.round(a.box[1] - 30), W - Math.round(a.box[0] + 0.55 * a.box[2]), Math.round(a.box[3] + 34)];
  const panelBin = path.join(DIR, "panel");
  execFileSync("swiftc", ["-O", path.join(ROOT, "test/fixtures/panel.swift"), "-o", panelBin]);
  execFileSync(panelBin, [shot("el/gap.png"), shot("el/occ.png"), ...bar.map(String)]);
  const n = ([x, y, w, h]) => [x / W, y / H, w / W, h / H];
  const boxes = { image: { width: W, height: H }, elements: [
    { id: "a", box: n([a.box[0] - 18, a.box[1] - 18, a.box[2] + 36, a.box[3] + 36]), text: "Einstellungen" },
    { id: "toast", box: n(bar), panel: true },
  ] };
  fs.writeFileSync(shot("el/occ.boxes.json"), JSON.stringify(boxes));
  const r = cli(["overlap", shot("el/occ.png"), "--boxes", shot("el/occ.boxes.json"), "--locale", "de", "--experimental", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  const f = r.json[0].findings.filter((x) => x.kind === "occluded");
  assert.equal(f.length, 1, JSON.stringify(r.json[0].findings));
  assert.equal(f[0].line, "Einstellungen / [toast]");
  assert.ok(validate(r.json[0]), JSON.stringify(validate.errors));
  assert.match(cli(["overlap", shot("el/occ.png"), "--boxes", shot("el/occ.boxes.json"), "--locale", "de", "--experimental"]).stdout, /occluded "Einstellungen" under \[toast\] \(\d+% of its box under the panel\)/);
  // D6, D17: without --experimental nothing is checked and the run says so once, with the command to rerun.
  const off = cli(["overlap", shot("el/occ.png"), "--boxes", shot("el/occ.boxes.json"), "--locale", "de", "--json", "--quiet"]);
  assert.equal(off.code, 0, off.stderr);
  assert.equal(off.stderr.split("occlusion-experimental").length - 1, 1, off.stderr);
  // The flag goes first (options may precede the command, and a `--` would turn a trailing flag into a path).
  assert.match(off.stderr, /was not checked on 1 image with panels - try: catscan --experimental overlap \S+occ\.png --boxes .* --quiet$/m);
  // D2: the same boxes on the bare screen; Vision reads the label whole into the panel's box, so the panel is see-through.
  fs.copyFileSync(shot("el/occ.boxes.json"), shot("el/gap-panel.boxes.json"));
  const bare = cli(["overlap", shot("el/gap.png"), "--boxes", shot("el/gap-panel.boxes.json"), "--locale", "de", "--experimental", "--json"]);
  assert.deepEqual(bare.json[0].findings, [], bare.stderr);
  // D17: --experimental with boxes that have no panel says occlusion was not checked.
  assert.match(cli(["overlap", shot("el/stack.png"), "--boxes", shot("el/stack.boxes.json"), "--locale", "de", "--experimental"]).stderr, /no-panel-elements: no boxes file has panel elements/);
});

// TODO-067: stacked text through the CLI and real Vision. Goldens from bench/stacked/generate.swift: three pages of a
// German sheet drawn at the same place (both correction branches fire on it on macOS 27.2.1), a clean sheet, a
// drop-shadowed one, and the stacked sheet under 3800 px of paper, so the image is read in tiles (D2).
const ST = path.join(DIR, "stacked");
const stGen = path.join(DIR, "stacked-gen");
execFileSync("swiftc", ["-O", path.join(ROOT, "bench/stacked/generate.swift"), "-o", stGen]);
execFileSync(stGen, [ST, "--only", "de/0052,de/0036,de/0037"], { cwd: ROOT });
execFileSync(stGen, [path.join(ST, "tall"), "--only", "de/0052", "--tall"], { cwd: ROOT });
const stLabel = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, "labels.json"), "utf8")).find((l) => l.file === f);
const covers = (box, r) => {
  const ix = Math.max(0, Math.min(box[0] + box[2], r[0] + r[2]) - Math.max(box[0], r[0]));
  const iy = Math.max(0, Math.min(box[1] + box[3], r[1] + r[3]) - Math.max(box[1], r[1]));
  return ix * iy >= 0.3 * Math.min(box[2] * box[3], r[2] * r[3]) && ix * iy > 0;
};

// Value: protects=the stacked reader end to end (second read without correction, both branches, the request field under --experimental, the schema, quantized 0.3 confidence per D6); fails_when=the CLI stops asking for it, the core stops reading twice, or a Vision update moves the confidence; why_new=new reader; seam=none; no_claim=recall (bench/stacked.js) and real-screen false alarms (bench/stacked-real.js)
test("stacked: a sheet of three pages at one place is found, clean and shadowed sheets pass, a tiled image too (TODO-067)", () => {
  const hit = cli(["overlap", path.join(ST, "de/0052-stack3-dark-0.00.png"), "--locale", "de", "--experimental", "--json"]);
  assert.equal(hit.code, 1, hit.stderr);
  assert.ok(validate(hit.json[0]), JSON.stringify(validate.errors));
  const st = hit.json[0].findings.filter((f) => f.signal === "stacked");
  const ev = new Set(st.flatMap((f) => f.stacked_evidence));
  assert.ok(ev.has("correction-changed") && ev.has("correction-dropped"), [...ev].join());
  for (const f of st.filter((x) => x.stacked_evidence[0].startsWith("correction"))) assert.equal(f.a.confidence, 0.3, "Vision's lowest confidence (D6)");
  const plain = cli(["overlap", path.join(ST, "de/0052-stack3-dark-0.00.png"), "--locale", "de", "--json"]); // D17: default-on
  assert.equal(plain.code, 1, plain.stderr);
  assert.ok(plain.json[0].findings.length && plain.json[0].findings.every((f) => f.signal === "stacked"));
  const regions = stLabel(ST, "de/0052-stack3-dark-0.00.png").regions.filter((r) => r.stacked);
  for (const f of st) assert.ok(regions.some((r) => covers(f.box, r.box)), JSON.stringify(f.box));
  for (const clean of ["de/0036-clean-light-0.00.png", "de/0037-shadow-light-0.00.png"]) {
    const r = cli(["overlap", path.join(ST, clean), "--locale", "de", "--experimental", "--json"]);
    assert.deepEqual(r.json[0].findings.filter((f) => f.signal === "stacked"), [], clean);
  }
  const tall = cli(["overlap", path.join(ST, "tall/de/0052-stack3-dark-0.00.png"), "--locale", "de", "--experimental", "--json"]);
  const tst = tall.json[0].findings.filter((f) => f.signal === "stacked");
  const tregions = stLabel(path.join(ST, "tall"), "de/0052-stack3-dark-0.00.png").regions.filter((r) => r.stacked);
  assert.ok(tst.length >= 1 && tst.every((f) => tregions.some((r) => covers(f.box, r.box))), JSON.stringify(tst.map((f) => f.box)));
});

// Value: protects=TODO-072 D1, D2, D9 end to end on Vision (two pages of a sheet drawn at one place, their sidecar from the generator: centred, same-height title boxes one inside the other, found as signal sheets; a clean sheet passes), the schema and the text line with its fix; fails_when=the D2 nesting gate drops the stack again, the signal or schema enum drifts, or the text line loses the fix; why_new=new rule; seam=none; no_claim=recall and precision (bench/overlap-sheets.js)
test("overlap --boxes: two sheet pages drawn at one place are sheets; a clean sheet passes (TODO-072)", () => {
  const dir = path.join(ST, "sheets");
  execFileSync(stGen, [dir, "--only", "de/0039,de/0036"], { cwd: ROOT });
  const de = path.join(dir, "de");
  const r = cli(["overlap", de, "--boxes", de, "--locale", "de", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  for (const e of r.json) assert.ok(validate(e), JSON.stringify(validate.errors));
  const by = Object.fromEntries(r.json.map((e) => [path.basename(e.path), e]));
  const hit = by["0039-stack2-light-0.00.png"].findings;
  assert.ok(hit.length >= 1 && hit.every((f) => f.signal === "sheets" && f.overlap === 1), JSON.stringify(hit));
  assert.ok(hit.some((f) => [f.a.element.id, f.b.element.id].sort().join() === "page1-title,page2-title"), JSON.stringify(hit.map((f) => f.line)));
  assert.deepEqual(by["0036-clean-light-0.00.png"].findings, []);
  const text = cli(["overlap", path.join(de, "0039-stack2-light-0.00.png"), "--boxes", path.join(de, "0039-stack2-light-0.00.boxes.json"), "--locale", "de"]);
  assert.match(text.stdout, /overlap \(sheets\) ".+" \/ ".+" \(100%\).*: two sheets drawn over each other; if one is hidden on purpose, leave it out of the boxes or allow it by its id or text/);
});

// Value: protects=D22/D32 (the second read runs with boxes by default), the render hint (--allow keeps a stacked line, by the read it shows) and D33 (allowing an element by id drops the stack inside it); fails_when=cli.js stops sending stacked with boxes, the Engine guard or its dropAllowed call goes, or allow stops reaching the stacked reader; why_new=default-on replaced the --experimental guard; seam=none; no_claim=recall (bench/stacked-real.js)
test("stacked: runs with boxes by default; --allow with the shown read keeps it (TODO-067 D22, D32)", () => {
  const img = path.join(ST, "de/0052-stack3-dark-0.00.png");
  const side = path.join(ST, "de/0052-stack3-dark-0.00.boxes.json");
  fs.writeFileSync(side, JSON.stringify({ image: { width: 900, height: 1400 }, elements: [] }));
  const stacked = (...a) => cli(["overlap", img, "--locale", "de", "--json", ...a]).json[0].findings.filter((f) => f.signal === "stacked");
  const st = stacked("--boxes", side);
  assert.ok(st.length >= 1, "default-on with boxes, no --experimental needed");
  const allow = path.join(ST, "allow.txt");
  fs.writeFileSync(allow, st.map((f) => f.a.text).join("\n") + "\n");
  assert.deepEqual(stacked("--allow", allow), []);
  // D33: with boxes, allowing the element the stack sits in (by id) keeps the stacked finding quiet too.
  fs.writeFileSync(side, JSON.stringify({ image: { width: 900, height: 1400 }, elements: [{ id: "sheet", box: [0, 0, 1, 1], text: "Blatt" }] }));
  assert.ok(stacked("--boxes", side).length >= 1, "an element alone allows nothing");
  fs.writeFileSync(allow, "sheet\n");
  assert.deepEqual(stacked("--boxes", side, "--allow", allow), []);
});
