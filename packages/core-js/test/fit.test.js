// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-073: `fit` arguments, profiles, the request field, rendering, schema, CI outputs and run diagnostics.
// Synthetic envelopes only; Vision runs in test/fit.test.js, the rule in SafeAreaTests.swift.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Ajv = require("ajv");
const { parse, UsageError } = require("../src/args");
const render = require("../src/render");
const ci = require("../src/ci");
const fit = require("../src/fit");
const profiles = require("../src/device-profiles");
const boxes = require("../src/boxes");
const scale = require("../src/scale");

const usage = (fn, code, re) => assert.throws(fn, (e) => e instanceof UsageError && e.code === code && (!re || re.test(`${e.message} | ${e.hint}`)));
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../../../core/schema/result.schema.json"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "catscan-fit-"));

const text = {
  kind: "fit", box: [0.33, 0.012, 0.31, 0.02], line: "Einstellungen", reason: "cutout", hidden: "Einst", hidden_box: [0.34, 0.013, 0.13, 0.017],
  zone_box: [0.34, 0.013, 0.31, 0.042], element: { id: "title", box: [0.3, 0.01, 0.4, 0.03] }, profile: "iphone-17-pro", covered: null, confidence: 0.97,
};
const control = {
  kind: "fit", box: [0, 0, 0.1, 0.05], line: null, reason: "corner", hidden: null, hidden_box: [0, 0, 0.1, 0.05], zone_box: [0, 0, 0.12, 0.05],
  element: { id: "close-button", box: [0, 0, 0.1, 0.05] }, profile: "iphone-17-pro", covered: 0.41, confidence: null,
};
const env = (findings, extra = {}) => ({
  schema: 1, catscan: "0.51.0", command: "fit", path: "shots/de/home.png", verdict: findings.length ? "fail" : "pass", engine: "vision-accurate-rev3",
  locale: "de", image: { width: 1206, height: 2622 }, screen: null, device: null, platform: null,
  device_profile: { id: "iphone-17-pro", ids: ["iphone-17-pro"], orientation: "portrait", matched_by: "size", version: "2026-11-20" },
  reasons_run: ["cutout", "corner"], reasons_skipped: [],
  host: { chip: "Apple M1", arch: "arm64", host_class: "physical", macos: "26.1 (25B78)", vision_revision: 3 }, ms: 60, checks: [], findings, warnings: [], ...extra,
});

test("args: fit options and where they are valid", () => {
  // Value: protects=the fit argument table (--device-profile, --orientation, --list-devices, --fail-on-skip, --reasons, --boxes, --allow, --experimental); fails_when=fit rejects one of its options or another command accepts a fit-only one; why_new=new command; seam=none; no_claim=none beyond protects
  const o = parse(["fit", "shots", "--device-profile", "pixel-8", "--orientation", "landscape-left", "--fail-on-skip", "--reasons", "corner", "--boxes", "b", "--allow", "a.txt", "--experimental"]);
  assert.deepEqual([o.command, o.deviceProfile, o.orientation, o.failOnSkip, o.reasons, o.experimental], ["fit", "pixel-8", "landscape-left", true, "corner", true]);
  assert.equal(parse(["fit", "--list-devices"]).listDevices, true);
  usage(() => parse(["fit"]), "missing-path");
  usage(() => parse(["fit", "s", "--list-devices"]), "option-not-valid", /takes no paths/);
  usage(() => parse(["truncated", "s", "--device-profile", "x"]), "option-not-valid");
  usage(() => parse(["--orientation", "portrait", "read", "s"]), "option-not-valid", /only with fit/);
  assert.equal(parse(["fit", "s", "--min-severity", "major"]).minSeverity, "major");
});

test("profiles: shipped ids, files, label tier (D21) and invalid files", () => {
  // Value: protects=profile resolution and every invalid-device-profile path; fails_when=a typo is not named, a bad file reaches the core, or a prefixed label misses its profile; why_new=new loader; seam=device-profiles.js; no_claim=the measured numbers
  const id = profiles.table().profiles[0].id;
  assert.equal(profiles.resolve(id).profile.id, id);
  assert.equal(profiles.resolve(id).version, profiles.table().version);
  usage(() => profiles.resolve(id.slice(0, -1) + "x"), "unknown-device-profile", new RegExp(`did you mean ${id}\\?.*\\| catscan fit --list-devices`));
  assert.equal(profiles.forLabel(id).id, id);
  assert.equal(profiles.forLabel(`ios-${id}`).id, id);
  assert.equal(profiles.forLabel("ios-se"), null);
  assert.equal(profiles.forLabel(null), null);
  const d = tmp();
  const good = { device_profile: 1, id: "pixel-9", platform: "android", screen: { width: 1080, height: 2424 }, zones: [{ kind: "cutout", runs: [[40, 500, 580]] }, { kind: "home-indicator", box: [400, 2380, 280, 12] }], landscape: { "home-indicator": { box: [1100, 1040, 280, 12] } } };
  const f = path.join(d, "pixel9.json");
  fs.writeFileSync(f, JSON.stringify(good));
  const r = profiles.resolve(f);
  assert.deepEqual([r.profile.id, r.version], ["pixel-9", null]);
  const bad = (o, re) => { fs.writeFileSync(f, JSON.stringify(o)); usage(() => profiles.resolve(f), "invalid-device-profile", re); };
  bad({ ...good, zones: [{ kind: "cutout", runs: [[40, 500, 580], [41, 500, 2000]] }] }, /pixel9\.json: zones\[0\]\.runs\[1\] must be \[y, x0, x1\) inside the 1080x2424 screen \| catscan fit --list-devices/);
  bad({ ...good, screen: { width: 2424, height: 1080 } }, /portrait size/);
  bad({ ...good, zones: [{ kind: "notch", runs: [[0, 0, 1]] }] }, /zones\[0\]\.kind must be one of cutout, corner, home-indicator/);
  bad({ ...good, device_profile: 2 }, /device_profile must be 1/);
  bad({ ...good, landscape: { "home-indicator": { box: [0, 0, 0, 1] } } }, /landscape/);
  // D40: a home indicator without its landscape box would neither run nor skip on a landscape image.
  bad({ ...good, landscape: undefined }, /landscape\["home-indicator"\]\.box is required with a home-indicator zone/);
  fs.writeFileSync(f, "{");
  usage(() => profiles.resolve(f), "invalid-device-profile", /not JSON/);
});

test("list-devices: text and JSON rows", () => {
  // Value: protects=--list-devices output; fails_when=a profile row drops its size, zones or tool; why_new=new output; seam=device-profiles.list; no_claim=none
  const rows = profiles.list();
  assert.equal(rows.length, profiles.table().profiles.length);
  for (const r of rows) assert.deepEqual(Object.keys(r), ["id", "name", "platform", "width", "height", "zones", "measured"]);
  const t = profiles.listText();
  assert.match(t, new RegExp(`^device profiles ${profiles.table().version} \\(${rows.length}\\)\\nid +platform +size +zones +measured on\\n`));
  assert.match(t, new RegExp(`${rows[0].id} +${rows[0].platform} +${rows[0].width}x${rows[0].height}`));
});

test("request field: flag, label, size table, orientation, boxes and reasons", () => {
  // Value: protects=what the CLI sends the core per input (D3, D5, D10, D21); fails_when=a label is ignored, the sidecar orientation dropped, or an Android label matched by size; why_new=new field; seam=fit.build; no_claim=matching in the core (SafeAreaTests)
  const d = tmp();
  const img = path.join(d, "a.png");
  fs.writeFileSync(img, "");
  fs.writeFileSync(path.join(d, "a.boxes.json"), JSON.stringify({ image: { width: 1080, height: 2400 }, orientation: "landscape-right", elements: [{ id: "x", box: [0, 0, 0.1, 0.1], control: true }] }));
  const list = [{ path: img, arg: d, argIsDir: true }];
  const base = { orientation: null, reasons: null, deviceProfile: null, allow: null, experimental: true, boxes: d, argv: ["fit", d] };
  // D32: every reason missed its gate, so without --experimental or named reasons nothing would run.
  usage(() => fit.build({ ...base, experimental: false }, list), "experimental-command", /fit is experimental: cutout, corner, home-indicator, wrapped missed their gate.*--experimental/);
  assert.deepEqual(fit.build({ ...base, experimental: false, reasons: "corner" }, list).reasons, ["corner"]);
  const id = profiles.table().profiles[0].id;
  let r = fit.build(base, list);
  assert.deepEqual(r.runWarnings, []);
  let f = r.forInput(list[0], null).field;
  assert.deepEqual([f.table, f.profile, f.orientation, f.reasons, f.boxes.elements[0].control], [profiles.TABLE, undefined, "landscape-right", ["cutout", "corner", "home-indicator", "wrapped"], true]);
  f = r.forInput(list[0], `ios-${id}`).field;
  assert.deepEqual([f.profile.id, f.matched_by, f.platform, f.table], [id, "label", "ios", undefined]);
  assert.equal(r.forInput(list[0], "android-pixel-x").field.platform, "android");
  r = fit.build({ ...base, deviceProfile: id, orientation: "portrait", reasons: "corner,cutout" }, list);
  f = r.forInput(list[0], `ios-${id}`).field;
  assert.deepEqual([f.profile.id, f.matched_by, f.orientation, f.reasons], [id, "flag", "portrait", ["corner", "cutout"]]);
  usage(() => fit.build({ ...base, reasons: "cutot" }, list), "unknown-reason", /did you mean cutout\?/);
  usage(() => fit.build({ ...base, orientation: "landscape" }, list), "invalid-orientation", /--orientation landscape-left/);
  // D18: without boxes, textless controls are not checked, and the run says how to add them.
  r = fit.build({ ...base, boxes: null }, list);
  // TODO-074 D11: the default wrapped reason needs boxes too; the run checks safe areas and says so once.
  assert.deepEqual(r.runWarnings.map((w) => [w.code, w.hint]), [["wrap-needs-boxes", `catscan fit ${d} --boxes ${d}`], ["fit-controls-need-boxes", `catscan fit ${d} --boxes ${d}`]]);
  assert.deepEqual(r.reasons, ["cutout", "corner", "home-indicator"]);
});

test("controls per zone: corner passed its gate, cutout and home indicator only with --experimental; a missing sidecar is said (D16, D37)", () => {
  // Value: protects=D9 per reason and target for controls, and no silent boxes skip; fails_when=controls under an unmeasured zone run without --experimental, fit-experimental never fires, or an image without a sidecar is checked silently; why_new=review findings (global controls flag, dropped `looked`); seam=fit.build; no_claim=the core's per-zone filter (SafeAreaTests)
  const d = tmp();
  for (const n of ["a.png", "b.png"]) fs.writeFileSync(path.join(d, n), "");
  fs.writeFileSync(path.join(d, "a.boxes.json"), JSON.stringify({ image: { width: 1206, height: 2622 }, elements: [{ id: "close", box: [0, 0, 0.1, 0.05], control: true }] }));
  const list = ["a.png", "b.png"].map((n) => ({ path: path.join(d, n), arg: d, argIsDir: true }));
  const base = { orientation: null, reasons: "corner,cutout", deviceProfile: null, allow: null, experimental: false, boxes: d, argv: ["fit", d, "--reasons", "corner,cutout"] };
  let r = fit.build(base, list);
  assert.deepEqual(r.forInput(list[0], null).field.controls, ["corner"]);
  assert.deepEqual(r.runWarnings.map((w) => [w.code, w.message, w.hint]), [["fit-experimental", "controls under the cutout are experimental (not measured, docs/BENCHMARKS.md#fit) and were not checked", `catscan fit ${d} --reasons corner,cutout --experimental`]]);
  assert.deepEqual(fit.build({ ...base, reasons: "corner" }, list).runWarnings, [], "corner alone: nothing is off");
  r = fit.build({ ...base, reasons: null, experimental: true }, list);
  assert.deepEqual(r.forInput(list[0], null).field.controls, ["cutout", "corner", "home-indicator"]);
  assert.deepEqual(r.runWarnings, []);
  assert.deepEqual(r.forInput(list[0], null).warnings, []);
  const w = r.forInput(list[1], null).warnings;
  assert.deepEqual(w.map((x) => x.code), ["boxes-missing"]);
  assert.match(w[0].message, /^no boxes for .*b\.png \(looked for .*b\.boxes\.json\); icon buttons not checked$/);
  // The hint is one copy-paste command: paths with spaces are quoted.
  const sp = path.join(d, "my shots");
  fs.mkdirSync(sp);
  fs.writeFileSync(path.join(sp, "c d.png"), "");
  const one = [{ path: path.join(sp, "c d.png"), arg: sp, argIsDir: true }];
  assert.equal(fit.build({ ...base, boxes: sp, experimental: true }, one).forInput(one[0], null).warnings[0].hint, `catscan boxes <source> <dump> --image '${path.join(sp, "c d.png")}' > '${path.join(sp, "c d.boxes.json")}'`);
});

test("boxes: control and orientation pass the sidecar check; converters mark controls (D7, D12)", () => {
  // Value: protects=the new boxes fields and each converter's control column; fails_when=control or orientation is dropped or a bad orientation passes; why_new=new fields; seam=boxes.check, boxes.convert; no_claim=real dumps (golden fixtures cover those)
  assert.deepEqual(boxes.check({ image: { width: 1, height: 2 }, orientation: "landscape-left", elements: [{ box: [0, 0, 1, 1], control: true }] }, "f").elements[0].control, true);
  usage(() => boxes.check({ image: { width: 1, height: 2 }, orientation: "upside", elements: [] }, "f"), "invalid-boxes", /orientation must be one of portrait, landscape-left, landscape-right, portrait-upside-down/);
  usage(() => boxes.check({ image: { width: 1, height: 2 }, elements: [{ box: [0, 0, 1, 1], control: "yes" }] }, "f"), "invalid-boxes", /control must be true or false/);
  const d = tmp();
  const uia = path.join(d, "s.uia.xml"), png = path.join(d, "s.png");
  fs.writeFileSync(uia, '<?xml version="1.0"?><hierarchy rotation="1"><node class="android.widget.ImageButton" clickable="true" bounds="[0,0][100,100]" text="" resource-id="close"/><node class="android.widget.TextView" clickable="false" bounds="[100,0][400,100]" text="Titel" resource-id="t"/></hierarchy>');
  // A 1x1 PNG header is enough for the size reader: width 2400, height 1080.
  const ihdr = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(ihdr);
  ihdr.writeUInt32BE(13, 8); ihdr.write("IHDR", 12); ihdr.writeUInt32BE(2400, 16); ihdr.writeUInt32BE(1080, 20);
  fs.writeFileSync(png, ihdr);
  const b = boxes.convert("uiautomator", uia, png).boxes;
  assert.equal(b.orientation, "landscape-left");
  // D39: rotation 2 is upside down (fit skips the cutout), not silently portrait.
  fs.writeFileSync(uia, fs.readFileSync(uia, "utf8").replace('rotation="1"', 'rotation="2"'));
  ihdr.writeUInt32BE(1080, 16); ihdr.writeUInt32BE(2400, 20);
  fs.writeFileSync(png, ihdr);
  assert.equal(boxes.convert("uiautomator", uia, png).boxes.orientation, "portrait-upside-down");
  fs.writeFileSync(uia, fs.readFileSync(uia, "utf8").replace('rotation="2"', 'rotation="1"'));
  ihdr.writeUInt32BE(2400, 16); ihdr.writeUInt32BE(1080, 20);
  fs.writeFileSync(png, ihdr);
  assert.deepEqual(b.elements.map((e) => [e.id, e.control === true]), [["close", true], ["t", false]]);
  const xc = path.join(d, "s.xcui.txt");
  fs.writeFileSync(xc, "Window, 0x1, {{0.0, 0.0}, {402.0, 874.0}}\n  Button, 0x2, {{0.0, 0.0}, {44.0, 44.0}}, identifier: 'close'\n  Link, 0x3, {{50.0, 0.0}, {100.0, 44.0}}, label: 'Mehr'\n  StaticText, 0x4, {{50.0, 50.0}, {100.0, 44.0}}, label: 'Titel'\n");
  assert.deepEqual(boxes.convert("xcuitest", xc).boxes.elements.map((e) => [e.id ?? e.text, e.control === true]), [["close", true], ["Mehr", true], ["Titel", false]]);
});

test("render: text and control lines (Output)", () => {
  // Value: protects=the Output text lines; fails_when=the hidden part, zone or profile is dropped, or a control renders as text; why_new=new kind; seam=none; no_claim=none beyond protects
  assert.equal(render.findingDetail(text), '  fit (cutout) "Einstellungen" at [0.33, 0.012, 0.31, 0.02]: "Einst" under the cutout of iphone-17-pro');
  assert.equal(render.findingDetail(control), "  fit (corner) [close-button] 41% under the corner of iphone-17-pro at [0, 0, 0.1, 0.05]");
  assert.match(render.findingDetail({ ...text, reason: "home-indicator" }), /under the home indicator of/);
});

test("schema: fit envelope and findings validate; required fields and reasons are enforced", () => {
  // Value: protects=the schema for kind fit, device_profile, reasons_run/skipped and null line only for fit; fails_when=a field becomes optional, a truncated reason passes for fit, or null lines leak to other kinds; why_new=new kind; seam=none; no_claim=what the core emits (SafeAreaTests encoding)
  assert.ok(validate(env([text, control])), JSON.stringify(validate.errors));
  assert.ok(validate(env([], { device_profile: null, reasons_run: [], reasons_skipped: [{ reason: "cutout", cause: "device-unknown" }] })), JSON.stringify(validate.errors));
  // D39: an upside-down screen's envelope validates.
  assert.ok(validate(env([], { device_profile: { id: "pixel-7", ids: ["pixel-7"], orientation: "portrait-upside-down", matched_by: "label", version: "2026-11-22" }, reasons_run: ["corner", "home-indicator"], reasons_skipped: [{ reason: "cutout", cause: "orientation-unknown" }] })), JSON.stringify(validate.errors));
  for (const k of ["hidden", "hidden_box", "zone_box", "element", "profile", "covered", "reason", "line"]) {
    const f = { ...text };
    delete f[k];
    assert.equal(validate(env([f])), false, `without ${k}`);
  }
  assert.equal(validate(env([{ ...text, reason: "ellipsis" }])), false);
  assert.equal(validate(env([], { device_profile: { ...env([]).device_profile, matched_by: "guess" } })), false);
  const t = { kind: "truncated", box: [0, 0, 1, 1], line: null, reason: "ellipsis", element: null, expected: null, confidence: 0.9 };
  assert.equal(validate({ ...env([t]), command: "truncated" }), false, "null line only for fit");
});

test("registry: fit severity and rule, CI outputs carry fit findings", () => {
  // Value: protects=D20 (fit rows by reason, major) and the generic reporters on the new kind; fails_when=annotate throws for fit or a reporter drops it; why_new=new kind through generic code; seam=scale.annotate; no_claim=certainty values (findings-registry.test.js)
  const e = scale.annotate(env([text, control]));
  assert.deepEqual(e.findings.map((f) => f.severity), ["major", "major"]);
  assert.match(ci.junit([e]), /Einstellungen/);
  assert.match(ci.githubLines([e]).join("\n"), /::(error|warning|notice) .*fit \(cutout\)/);
  assert.equal(ci.codequality([e]).length, 2);
  assert.match(ci.codequality([e])[0].description, /cutout/);
});

test("run diagnostics: device-unknown per size, device-no-zones, checks-skipped (D16, D18)", () => {
  // Value: protects=the run-level skip lines and --fail-on-skip wording; fails_when=one line per image, a size's candidates are missing, or a partly skipped image is not counted; why_new=new diagnostics; seam=fit.afterRun, fit.skippedLine; no_claim=the CLI's stderr ordering
  const unknown = (p) => ({ env: env([], { path: p, image: { width: 1080, height: 2400 }, device_profile: null, reasons_run: [], reasons_skipped: fit.ZONES.map((r) => ({ reason: r, cause: "device-unknown" })) }) });
  const side = { env: env([], { path: "g.png", reasons_run: ["corner"], reasons_skipped: [{ reason: "cutout", cause: "orientation-unknown" }] }) };
  const se = { env: env([], { device_profile: { id: "iphone-se", ids: ["iphone-se"], orientation: "portrait", matched_by: "size", version: "v" }, reasons_run: [] }) };
  const out = fit.afterRun([unknown("a.png"), unknown("b.png"), side, se]);
  assert.deepEqual(out.map((d) => d.code), ["device-unknown", "device-no-zones"]);
  assert.match(out[0].message, /^2 images of 1080x2400 \(first: a\.png\) have no device profile; safe-area reasons skipped \(Android needs a named profile; profiles of this size: /);
  assert.equal(out[1].message, "1 image matched iphone-se, which has no cutout, rounded corner or home indicator; nothing to check there");
  const s = fit.skippedLine([unknown("a.png"), unknown("b.png"), side]);
  assert.equal(s.code, "checks-skipped");
  assert.equal(s.message, "fit: 2 images skipped cutout, corner and home-indicator (device-unknown), 1 image skipped cutout (orientation-unknown)");
  assert.equal(fit.skippedLine([se]), null);
  // TODO-074: one image skipping zones and wrapped for different causes keeps each cause; boxes-missing alone hints --boxes.
  const mixed = { env: env([], { path: "c.png", reasons_run: [], reasons_skipped: [{ reason: "cutout", cause: "device-unknown" }, { reason: "wrapped", cause: "boxes-missing" }] }) };
  assert.equal(fit.skippedLine([mixed]).message, "fit: 1 image skipped cutout (device-unknown), 1 image skipped wrapped (boxes-missing)");
  const nobox = { env: env([], { path: "d.png", reasons_run: ["cutout"], reasons_skipped: [{ reason: "wrapped", cause: "boxes-missing" }] }) };
  assert.equal(fit.skippedLine([nobox]).hint, "--boxes <folder of .boxes.json sidecars>");
  // Only the reasons the run checked are named: --reasons cutout on a device without one.
  assert.equal(fit.afterRun([se], ["cutout"])[0].message, "1 image matched iphone-se, which has no cutout; nothing to check there");
});
