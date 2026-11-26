// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-054 T2: `contrast` arguments, the gate (D28), the scale chain (D6), the fix colour (D23), rendering, the summary
// (D25, D29), --quiet (D24) and CI outputs. Synthetic envelopes only; Vision runs in test/contrast.test.js, the
// estimator in ContrastTests.swift.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parse, UsageError } = require("../src/args");
const render = require("../src/render");
const ci = require("../src/ci");
const contrast = require("../src/contrast");

const usage = (fn, code, re) => assert.throws(fn, (e) => e instanceof UsageError && e.code === code && (!re || re.test(`${e.message} | ${e.hint}`)));

const low = {
  kind: "low-contrast", box: [0.1, 0.2, 0.5, 0.03], line: "Forgot password?", ratio: 2.85, threshold: 4.5, size: "normal", ink: "#999999",
  background: "#FFFFFF", edges: 0, scale: 3, scale_source: "size-table", confidence: 1,
};
const busy = { ...low, kind: "busy-background", line: "Play now", ratio: 5.1, threshold: 3, size: "large", edges: 0.07 };

// Value: protects=D27 contrast's argument surface and D28 gate errors; fails_when=a flag is not allowlisted, --experimental is rejected for contrast, or a gate message stops naming kind, mode and rerun; why_new=new command; seam=none; no_claim=the measured gate state (results/contrast*.json)
test("args: contrast takes its flags, --experimental, and every ungated kind is a usage error naming the rerun", () => {
  const o = parse(["contrast", "shots/", "--experimental", "--level", "aaa", "--scale", "2.5", "--kinds", "low-contrast", "--allow", "a.txt", "--boxes", "b/", "--locale", "de"]);
  assert.equal(o.level, "AAA");
  assert.equal(o.scale, 2.5);
  assert.deepEqual(o.kinds, ["low-contrast"]);
  for (const flag of ["--results", "--report", "--junit", "--gitlab-codequality", "--baseline", "--known", "--min-severity"]) {
    assert.doesNotThrow(() => parse(["contrast", "shots/", "--experimental", flag, flag === "--min-severity" ? "major" : "x.json"]), flag);
  }
  usage(() => parse(["contrast", "shots/"]), "experimental-command", /low-contrast without --boxes has not passed its gate.*--experimental/);
  usage(() => parse(["contrast", "shots/", "--boxes", "b/"]), "experimental-command", /low-contrast with --boxes has not passed its gate.*; rerun with --experimental \|/);
  usage(() => parse(["contrast", "shots/", "--kinds", "busy-background"]), "experimental-command", /busy-background without --boxes/);
  usage(() => parse(["contrast", "shots/", "--experimental", "--level", "A"]), "invalid-level", /AA or AAA/);
  usage(() => parse(["contrast", "shots/", "--experimental", "--scale", "5"]), "invalid-scale", /--scale 3/);
  usage(() => parse(["contrast", "shots/", "--experimental", "--scale", "x"]), "invalid-scale");
  usage(() => parse(["contrast", "shots/", "--experimental", "--kinds", "low-contrst"]), "unknown-kind", /did you mean low-contrast/);
  usage(() => parse(["read", "shots/", "--scale", "2"]), "option-not-valid");
  usage(() => parse(["truncated", "shots/", "--level", "AA"]), "option-not-valid");
  usage(() => parse(["contrast", "shots/", "--experimental", "--fail-on-skip"]), "option-not-valid");
  usage(() => parse(["--uncatalogued", "contrast", "shots/", "--experimental"]), "option-not-valid", /--uncatalogued and --pseudo work only/);
});

// Value: protects=D28 the four kind x mode messages; fails_when=a mode that passed is not offered as the rerun, or a passed case still errors; why_new=new; seam=a gated table passed in instead of CONTRAST_GATED; no_claim=which kinds passed
test("gate: each kind x mode case words its own rerun", () => {
  const g = { "low-contrast": { boxes: true, "no-boxes": false }, "busy-background": { boxes: false, "no-boxes": true } };
  assert.match(contrast.gateError(["low-contrast"], false, g).message, /without --boxes has not passed its gate.*give --boxes <dir> \(it passed with boxes\)/);
  assert.equal(contrast.gateError(["low-contrast"], true, g), null);
  assert.match(contrast.gateError(["busy-background"], true, g).message, /with --boxes has not passed its gate.*drop --boxes \(it passed without boxes\)/);
  assert.equal(contrast.gateError(["busy-background"], false, g), null);
  assert.ok(Object.values(contrast.CONTRAST_GATED).every((m) => Object.isFrozen(m)));
});

// Value: protects=D6 scale chain order and scale_source; fails_when=a later source wins over an earlier one or an unknown size is not scale 1; why_new=new; seam=none; no_claim=the device profile table's sizes (TODO-073)
test("scale: flag, then boxes, then the iOS size table, else 1 with source none", () => {
  assert.deepEqual(contrast.resolveScale({ flag: 2, boxes: { scale: 3 }, size: { width: 1170, height: 2532 } }), { scale: 2, source: "flag" });
  assert.deepEqual(contrast.resolveScale({ boxes: { scale: 3 }, size: { width: 750, height: 1334 } }), { scale: 3, source: "boxes" });
  assert.deepEqual(contrast.resolveScale({ size: { width: 1170, height: 2532 } }), { scale: 3, source: "size-table" });
  assert.deepEqual(contrast.resolveScale({ size: { width: 2532, height: 1170 } }), { scale: 3, source: "size-table" });
  assert.deepEqual(contrast.resolveScale({ size: { width: 828, height: 1792 } }), { scale: 2, source: "size-table" });
  assert.deepEqual(contrast.resolveScale({ size: { width: 1080, height: 2400 } }), { scale: 1, source: "none" });
  assert.deepEqual(contrast.resolveScale({}), { scale: 1, source: "none" });
});

// Value: protects=D23 the fix colour passes at its threshold, keeps the hue and is the nearest such; fails_when=the search goes the wrong way, ignores hex rounding, or overshoots to black; why_new=new; seam=none; no_claim=perceptual nearness beyond same-hue blending
test("suggest: the nearest same-hue ink that passes, darker or lighter as the background needs", () => {
  const cases = [["#999999", "#FFFFFF", 4.5], ["#5B5B5B", "#1C1C1E", 3], ["#4A90D9", "#FFFFFF", 4.5], ["#FFFFFF", "#43A047", 4.5], ["#D3D3D3", "#FFFFFF", 7]];
  for (const [ink, bg, t] of cases) {
    const s = contrast.suggest(ink, bg, t);
    const r = contrast.ratioOf(contrast.lum(contrast.rgb(s)), contrast.lum(contrast.rgb(bg)));
    assert.ok(r >= t && r < t * 1.04, `${ink} on ${bg}: ${s} gives ${r}`);
    const [a, b] = [contrast.rgb(ink), contrast.rgb(s)];
    const hue = ([r_, g, b_]) => Math.atan2(Math.sqrt(3) * (g - b_), 2 * r_ - g - b_);
    if (Math.max(...a) - Math.min(...a) > 0.1) assert.ok(Math.abs(hue(a) - hue(b)) < 0.05, `${ink} -> ${s} keeps its hue`);
  }
  assert.equal(contrast.suggest("#999999", "#FFFFFF", 4.5), "#767676");
  assert.equal(contrast.suggest("#777777", "#808080", 7), null); // mid grey: neither black nor white reaches 7:1
});

// Value: protects=spec "Outputs" text line and D23 fix in text, D25/D29 summary with skipped counts; fails_when=a field or the fix drops from the line, or skipped lines are not counted; why_new=new; seam=none; no_claim=none beyond protects
test("render and summary: finding lines carry ratio, size, colours and the fix; the summary counts screens, worst and skips", () => {
  const env = { verdict: "fail", path: "de/login.png", command: "contrast", checks: [], warnings: [], findings: [{ ...low }, { ...busy }],
    lines: [{ text: "x", contrast: { skipped: "not-text" } }, { text: "y", contrast: { skipped: "too-small" } }, { text: "z", contrast: { ratio: 3, uncertain: true } }] };
  contrast.enrich(env);
  assert.equal(env.findings[0].suggest, "#767676");
  assert.equal(env.findings[1].suggest, undefined);
  const lines = render.renderText(env).join("\n");
  assert.match(lines, /low-contrast "Forgot password\?" 2\.85:1 < 4\.5:1 \(normal, ink #999999 on #FFFFFF\) at \[0\.1, 0\.2, 0\.5, 0\.03\]; fix: ink #767676 or darker/);
  assert.match(lines, /busy-background "Play now" \(edges 0\.07 around the line\) at .*; fix: put the text on a solid or scrimmed panel/);
  const s = contrast.summary([env, { path: "de/ok.png", findings: [], lines: [] }]);
  assert.ok(!contrast.summary([{ path: "a\n::error::x.png", findings: [{ ...low }], lines: [] }]).includes("\n"), "a control character in a path never breaks the summary line");
  assert.equal(s, 'contrast: 1 low-contrast, 1 busy-background on 1 of 2 screens; worst 2.85:1 "Forgot password?" (de/login.png); 2 lines not measured (1 too-small, 1 not-text); 1 line uncertain (two ink colours or a weak split; not judged)');
});

// Value: protects=D24 the three contrast warnings survive --quiet and the docs --quiet row lists every always-shown code; fails_when=ALWAYS_SHOWN and docs/cli.md drift apart; why_new=the two lists were hand-synced (spec "Errors, warnings"); seam=reads the source and the docs; no_claim=codes written outside ALWAYS_SHOWN
test("--quiet: the docs list names every ALWAYS_SHOWN code, the contrast warnings included", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/cli.js"), "utf8");
  const codes = [.../const ALWAYS_SHOWN = new Set\(\[([\s\S]*?)\]\);/.exec(src)[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  for (const c of ["contrast-scale-unknown", "contrast-size-uncertain", "contrast-behind-scrim"]) assert.ok(codes.includes(c), c);
  const row = fs.readFileSync(path.join(__dirname, "../../../docs/cli.md"), "utf8").split("\n").find((l) => l.startsWith("| `--quiet`"));
  const documented = new Set([...row.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]));
  assert.deepEqual(codes.filter((c) => !documented.has(c)), []);
});

// Value: protects=spec "CI formats" message shapes for both kinds (spec 15 pattern); fails_when=a kind falls through to a generic message without ratio or fix; why_new=new kinds; seam=none; no_claim=GitHub's and GitLab's own rendering
test("CI: JUnit, GitHub and GitLab carry the ratio and the fix", () => {
  const env = { verdict: "fail", path: "de/login.png", locale: "de", screen: "login", command: "contrast", checks: [], warnings: [], findings: [{ ...low, suggest: "#767676", severity: "major", certainty: "low", gate: true }, { ...busy, severity: "minor", certainty: "low", gate: true }] };
  const junit = ci.junit([env]);
  assert.match(junit, /low-contrast/);
  assert.match(junit, /2\.85:1 &lt; 4\.5:1/);
  const gh = ci.githubLines([env], { more: "x" }).join("\n");
  assert.match(gh, /low-contrast.*2\.85:1 < 4\.5:1.*fix: ink #767676/);
  assert.match(gh, /busy-background.*solid or scrimmed panel/);
  const cq = ci.codequality([env]);
  assert.equal(cq.length, 2);
  assert.match(cq[0].description, /2\.85:1/);
});

// Value: protects=D7 `enabled` and D6 `scale` in the boxes sidecar from converter to check; fails_when=a converter drops a
// disabled flag, normalize stops writing the scale, or check lets a bad value through to the core; why_new=new fields;
// seam=temp dumps; no_claim=Vision
test("boxes: converters keep disabled controls, normalize writes the scale, check rejects bad enabled or scale", () => {
  const boxes = require("../src/boxes");
  const os = require("os");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-contrast-u-"));
  const f = path.join(d, "tree.txt");
  fs.writeFileSync(f, ["    Window (Main), 0x0, {{0.0, 0.0}, {390.0, 844.0}}",
    "      Button, 0x1, {{10.0, 50.0}, {80.0, 20.0}}, label: 'Weiter', Disabled",
    "      Button, 0x2, {{10.0, 90.0}, {80.0, 20.0}}, label: 'Zurück'"].join("\n"));
  const els = boxes.convert("xcuitest", f, null).boxes.elements;
  assert.deepEqual(els.filter((e) => e.text).map((e) => [e.text, e.enabled]), [["Weiter", false], ["Zurück", undefined]]);
  // A label that itself says ", Disabled," is text, not the flag (red-team review).
  fs.writeFileSync(f, ["    Window (Main), 0x0, {{0.0, 0.0}, {390.0, 844.0}}",
    "      Button, 0x1, {{10.0, 50.0}, {200.0, 20.0}}, label: 'Face ID, Disabled, Set up'"].join("\n"));
  assert.deepEqual(boxes.convert("xcuitest", f, null).boxes.elements.filter((e) => e.text).map((e) => [e.text, e.enabled]), [["Face ID, Disabled, Set up", undefined]]);
  const png = path.join(d, "s.png");
  const hdr = Buffer.alloc(33); hdr.writeUInt32BE(0x89504e47, 0); hdr.writeUInt32BE(0x0d0a1a0a, 4); hdr.writeUInt32BE(13, 8); hdr.write("IHDR", 12); hdr.writeUInt32BE(1080, 16); hdr.writeUInt32BE(2400, 20);
  fs.writeFileSync(png, hdr);
  const uia = path.join(d, "u.xml");
  fs.writeFileSync(uia, '<?xml version="1.0"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" text="" bounds="[0,0][1080,2400]"><node class="android.widget.Button" text="Weiter" enabled="false" clickable="true" bounds="[48,200][560,280]" /><node class="android.widget.Button" text="Zurück" enabled="true" clickable="true" bounds="[48,300][560,380]" /></node></hierarchy>');
  assert.deepEqual(boxes.convert("uiautomator", uia, png).boxes.elements.filter((e) => e.text).map((e) => [e.text, e.enabled]), [["Weiter", false], ["Zurück", undefined]]);
  const ma = path.join(d, "m.json");
  const node = (text, enabled, b, children = []) => ({ attributes: { text, enabled, bounds: b, "resource-id": "", accessibilityText: "", hintText: "" }, children });
  fs.writeFileSync(ma, JSON.stringify(node("", "true", "[0,0][1080,2400]", [node("Weiter", "false", "[48,200][560,280]"), node("Zurück", "true", "[48,300][560,380]")])));
  assert.deepEqual(boxes.convert("maestro", ma, png).boxes.elements.filter((e) => e.text).map((e) => [e.text, e.enabled]), [["Weiter", false], ["Zurück", undefined]]);
  const raw = [{ id: "a", x: 0, y: 0, w: 100, h: 20, text: "x" }];
  assert.equal(boxes.normalize(raw, { width: 390, height: 844 }, { width: 1170, height: 2532 }).scale, 3);
  assert.equal(boxes.normalize(raw, { width: 390, height: 844 }, null).scale, undefined);
  const ok = { image: { width: 100, height: 200 }, scale: 2, elements: [{ box: [0.1, 0.1, 0.5, 0.05], enabled: false }] };
  assert.deepEqual([boxes.check(ok, "b.json").scale, boxes.check(ok, "b.json").elements[0].enabled], [2, false]);
  for (const bad of [{ ...ok, scale: 0.5 }, { ...ok, scale: 5 }, { ...ok, elements: [{ box: [0.1, 0.1, 0.5, 0.05], enabled: "no" }] }]) {
    assert.throws(() => boxes.check(bad, "b.json"), /scale must be|enabled must be/);
  }
});

// Value: protects=D6 the per-input scale source and the boxes-missing warning; fails_when=a sidecar scale is not used or
// mislabelled, or a missing sidecar passes silently; why_new=new; seam=temp dir with header-only PNGs; no_claim=none
test("build: a sidecar's scale is source boxes, a missing sidecar warns boxes-missing, stdin is source none", () => {
  const os = require("os");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-contrast-b-"));
  const png = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write("IHDR", 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  fs.mkdirSync(path.join(d, "shots")); fs.mkdirSync(path.join(d, "boxes"));
  for (const n of ["a", "b"]) fs.writeFileSync(path.join(d, "shots", `${n}.png`), png(1080, 2400));
  fs.writeFileSync(path.join(d, "boxes", "a.boxes.json"), JSON.stringify({ image: { width: 1080, height: 2400 }, scale: 2.75, elements: [] }));
  const list = ["a", "b"].map((n) => ({ arg: path.join(d, "shots"), argIsDir: true, path: path.join(d, "shots", `${n}.png`) }));
  const b = contrast.build({ boxes: path.join(d, "boxes"), scale: null, level: null, kinds: null, allow: null }, list);
  const a = b.forInput(list[0]);
  assert.deepEqual([a.field.scale, a.field.scale_source, a.warnings], [2.75, "boxes", []]);
  // A sidecar made from a 2160-wide capture of the same screen: its scale is halved for this 1080-wide image.
  fs.writeFileSync(path.join(d, "boxes", "a.boxes.json"), JSON.stringify({ image: { width: 2160, height: 4800 }, scale: 3, elements: [] }));
  const r = contrast.build({ boxes: path.join(d, "boxes"), scale: null, level: null, kinds: null, allow: null }, list).forInput(list[0]);
  assert.deepEqual([r.field.scale, r.field.scale_source], [1.5, "boxes"]);
  const m = b.forInput(list[1]);
  assert.deepEqual([m.field.scale_source, m.warnings.map((w) => w.code)], ["none", ["boxes-missing"]]);
  assert.match(m.warnings[0].hint, /catscan boxes <source> <dump> --image .*b\.png > .*b\.boxes\.json/);
  const s = contrast.build({ boxes: null, scale: null, level: null, kinds: null, allow: null }, [{ stdin: true }]).forInput({ stdin: true });
  assert.equal(s.field.scale_source, "none");
});
