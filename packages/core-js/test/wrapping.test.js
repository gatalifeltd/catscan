// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-074 (Node layer): fit's wrap reasons in the CLI: reasons and defaults, base pairing by --layout, --base-locale,
// catalog pairs, the wrap diagnostics, max_lines, the schema and every renderer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Ajv = require("ajv");
const { UsageError } = require("../src/args");
const render = require("../src/render");
const ci = require("../src/ci");
const fit = require("../src/fit");
const boxes = require("../src/boxes");
const scale = require("../src/scale");
const known = require("../src/known");
const overlay = require("../src/report/overlay");

const usage = (fn, code, re) => assert.throws(fn, (e) => e instanceof UsageError && e.code === code && (!re || re.test(`${e.message} | ${e.hint}`)));
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../../../core/schema/result.schema.json"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wrap-"));

const wrapped = {
  kind: "fit", box: [0.3, 0.4, 0.4, 0.07], line: "Jetzt kostenlos / testen", reason: "wrapped", element: { id: "cta-trial", box: [0.25, 0.39, 0.5, 0.09] },
  rows: 2, base_rows: 1, evidence: "base", base_path: "shots/en/paywall.png", confidence: 0.8,
};
const orphan = {
  kind: "fit", box: [0.1, 0.2, 0.8, 0.12], line: "Ihre Einstellungen für / Benachrichtigungen / ändern", reason: "orphan", element: { id: "title", box: [0.1, 0.2, 0.8, 0.12] },
  rows: 3, orphan: "ändern", evidence: null, confidence: 0.9,
};
const env = (findings, extra = {}) => ({
  schema: 1, catscan: "0.56.0", command: "fit", path: "shots/de/paywall.png", verdict: findings.length ? "fail" : "pass", engine: "vision-accurate-rev3",
  locale: "de", image: { width: 1206, height: 2622 }, screen: "paywall", device: null, platform: null, device_profile: null,
  reasons_run: ["wrapped", "orphan"], reasons_skipped: [],
  host: { chip: "Apple M1", arch: "arm64", host_class: "physical", macos: "26.1 (25B78)", vision_revision: 3 }, ms: 60, checks: [], findings, warnings: [], ...extra,
});

function shots(locales, screens = ["paywall"]) {
  const d = tmp();
  const list = [];
  for (const l of locales) {
    fs.mkdirSync(path.join(d, l), { recursive: true });
    for (const s of screens) {
      const p = path.join(d, l, `${s}.png`);
      fs.writeFileSync(p, "");
      fs.writeFileSync(path.join(d, l, `${s}.boxes.json`), JSON.stringify({ image: { width: 100, height: 200 }, elements: [{ id: "cta", text: "x", box: [0, 0, 0.5, 0.1], control: true }] }));
      list.push({ path: p, arg: d, argIsDir: true });
    }
  }
  return { d, list };
}
const opts = (d, extra = {}) => ({ orientation: null, reasons: null, deviceProfile: null, allow: null, experimental: true, boxes: d, argv: ["fit", d], catalogs: [], baseLocale: null, ...extra });
const mapped = (list, locale = (p) => path.basename(path.dirname(p)), device = () => null) => list.map((x) => ({ locale: locale(x.path), screen: path.basename(x.path, ".png"), device: device(x.path) }));

test("reasons: orphan only when named (D7), wrap reasons need boxes (D11), demoted evidence said once (D20)", () => {
  // Value: protects=the default reasons, the no-boxes warning and usage error, the evidence gate and the request field; fails_when=orphan runs unnamed, a wrap-only run without boxes is not exit 2, or demoted evidence is sent; why_new=new reasons; seam=fit.build; no_claim=the gate numbers (bench/wrapping.js)
  const { d, list } = shots(["en", "de"]);
  let r = fit.build(opts(d), list);
  assert.deepEqual(r.reasons, ["cutout", "corner", "home-indicator", "wrapped"]);
  assert.ok(r.wrap);
  assert.deepEqual(r.forInput(list[1], null).field.wrap, { evidence: ["declared", "base", "control"] });
  r = fit.build(opts(d, { reasons: "wrapped,orphan" }), list);
  assert.deepEqual(r.forInput(list[1], null).field.reasons, ["wrapped", "orphan"]);
  assert.deepEqual(r.runWarnings, [], "a wrap-only run has no zone controls to warn about");
  r = fit.build(opts(null), list);
  assert.equal(r.wrap, false);
  assert.deepEqual(r.runWarnings.map((w) => w.code), ["wrap-needs-boxes", "fit-controls-need-boxes"]);
  usage(() => fit.build(opts(null, { reasons: "orphan" }), list), "wrap-needs-boxes", /need element boxes \| catscan fit .* --boxes /);
  assert.deepEqual(fit.build(opts(null, { reasons: "corner,wrapped" }), list).reasons, ["corner"]);
  usage(() => fit.build(opts(d, { reasons: "wraped" }), list), "unknown-reason", /did you mean wrapped\?/);
});

test("wrapPlan: base inputs by locale and screen, ambiguous and missing bases, --base-locale (D3, D10, D16)", () => {
  // Value: protects=base pairing by screen and device, wrap-no-base once with the count, wrap-base-ambiguous, the base-locale default and unknown-base-locale; fails_when=a target pairs with another screen's base, two bases pick one silently, or a missing base is silent; why_new=new pairing; seam=fit.wrapPlan; no_claim=element pairing in the core (WrappingTests)
  const { d, list } = shots(["en", "de", "fr"], ["paywall", "home"]);
  const m = mapped(list);
  m.splice(1, 1, { ...m[1], screen: "settings" }); // en/home is now en/settings: de/home and fr/home have no base
  const p = fit.wrapPlan(opts(d), list, m);
  assert.equal(p.baseLocale, "en");
  assert.deepEqual(p.roles.map((r) => [r.base, r.baseIndex]), [[true, null], [true, null], [false, 0], [false, null], [false, 0], [false, null]]);
  assert.deepEqual(p.warnings.map((w) => w.code), ["wrap-no-base"]);
  assert.match(p.warnings[0].message, /^1 of 2 screens has no en screenshot in this run; wrapped uses only declared and control evidence there$/);
  assert.equal(p.warnings[0].hint, `catscan fit ${d} --boxes ${d} --layout '{locale}/{screen}'`);
  // Two en screenshots of one screen (two devices, no device axis): base evidence skipped there.
  const two = mapped(list).map((x, i) => (i === 1 ? { ...x, screen: "paywall" } : x));
  const a = fit.wrapPlan(opts(d), list, two);
  assert.deepEqual(a.warnings.map((w) => w.code), ["wrap-no-base", "wrap-base-ambiguous"]);
  assert.deepEqual(a.warnings.map((w) => w.hint), [`catscan fit ${d} --boxes ${d} --layout '{locale}/{screen}'`, `catscan fit ${d} --boxes ${d} --layout '{device}/{locale}/{screen}'`]);
  assert.equal(a.warnings[1].message, "1 screen has two en screenshots (no device axis); base evidence skipped there");
  assert.equal(a.roles[2].baseIndex, null);
  // With the TODO-075 device axis the same screen pairs per device.
  const dev = fit.wrapPlan(opts(d), list, mapped(list, undefined, (q) => (q.includes("home") ? "ipad" : "iphone")));
  assert.deepEqual(dev.roles.map((r) => r.baseIndex), [null, null, 0, 1, 0, 1]);
  usage(() => fit.wrapPlan(opts(d, { baseLocale: "ja" }), list, mapped(list)), "unknown-base-locale", /--base-locale ja: no input maps to locale ja/);
  // A run with en-US screens and no plain en pairs with them.
  const us = fit.wrapPlan(opts(d), list, mapped(list, (q) => (q.includes("/en/") ? "en-US" : path.basename(path.dirname(q)))));
  assert.equal(us.roles[2].baseIndex, 0);
});

test("wrapPlan: a base pairs within its text size; size-aware wrap-no-base and wrap-base-ambiguous (TODO-084)", () => {
  // Value: protects=TODO-084 D2, D3, D6 base pairing per text size and the warnings' sizes and hints; fails_when=default and large bases collide, a large target pairs with a default base, or a hint drops {text_size}/; why_new=new axis in the key; seam=fit.wrapPlan; no_claim=element pairing in the core
  const { d, list } = shots(["en", "de"]);
  const L = "{text_size}/{locale}/{screen}";
  const at = (locale, text_size, device = null) => ({ locale, screen: "paywall", device, text_size });
  // Default and large base shots of one screen: each target pairs with its own size, no warning.
  const both = fit.wrapPlan(opts(d), list, [at("en", null), at("en", "large"), at("de", "default"), at("de", "large")], L);
  assert.deepEqual(both.roles.map((r) => r.baseIndex), [null, null, 0, 1]);
  assert.deepEqual(both.warnings, []);
  // Only a default base: the large target gets none, and the hint says which size to capture.
  // `default` alone is no size axis (TODO-076 D13): a missing base keeps today's message and hint.
  const plain = fit.wrapPlan(opts(d), list, [{ ...at("en", null), screen: "home" }, at("de", "default")], L);
  assert.deepEqual(plain.warnings.map((w) => [w.message, w.hint]), [["1 of 1 screen has no en screenshot in this run; wrapped uses only declared and control evidence there", `catscan fit ${d} --boxes ${d} --layout '{locale}/{screen}'`]]);
  const one = fit.wrapPlan(opts(d), list, [at("en", null), at("de", null), at("de", "large")], L);
  assert.deepEqual(one.roles.map((r) => r.baseIndex), [null, 0, null]);
  assert.deepEqual(one.warnings.map((w) => [w.code, w.message, w.hint]), [["wrap-no-base", "1 of 2 screens has no en screenshot at the same text size in this run; wrapped uses only declared and control evidence there", `capture en screenshots at text size large, then: catscan fit ${d} --boxes ${d} --layout '${L}'`]]);
  // Two large base shots (two device trees, no device axis): named size, {device}/ before the run's layout.
  const two = fit.wrapPlan(opts(d), list, [at("en", "large"), at("en", "large"), at("de", "large")], L);
  assert.deepEqual(two.warnings.map((w) => [w.code, w.message, w.hint]), [["wrap-base-ambiguous", "1 screen has two en screenshots at text size large (no device axis); base evidence skipped there", `catscan fit ${d} --boxes ${d} --layout '{device}/${L}'`]]);
  // With a device axis the duplicate is not a missing axis: no "(no device axis)", and the hint names the duplicate cell.
  const dup = fit.wrapPlan(opts(d), list, [at("en", null, "iphone"), at("en", null, "iphone"), at("de", null, "iphone")], "{device}/{locale}/{screen}");
  assert.deepEqual(dup.warnings.map((w) => [w.message, w.hint]), [["1 screen has two en screenshots; base evidence skipped there", "two inputs map to one device, text size, en locale and screen; check --layout '{device}/{locale}/{screen}' and the file names"]]);
  // A size from --text-size (not the layout) goes into the rerun; a device from --device gets the duplicate-cell hint.
  const flag = fit.wrapPlan(opts(d, { textSize: "large" }), list, [{ ...at("en", "large"), screen: "home" }, at("de", "large")], "{locale}/{screen}");
  assert.deepEqual(flag.warnings.map((w) => w.hint), [`capture en screenshots at text size large, then: catscan fit ${d} --boxes ${d} --layout '{locale}/{screen}' --text-size large`]);
  const dev = fit.wrapPlan(opts(d), list, [at("en", null, "iphone"), at("en", null, "iphone"), at("de", null, "iphone")], "{locale}/{screen}");
  assert.deepEqual(dev.warnings.map((w) => w.hint), ["two inputs map to one device, text size, en locale and screen; check --layout '{locale}/{screen}' and the file names"]);
});

test("wrapPlan: catalog pairs per target locale, plain strings only, base locale from the xcstrings source (D13, D18)", () => {
  // Value: protects=the pairs entries the core matches (key, target, base, target file), plurals left out, the base-locale default; fails_when=a plural or reference is paired, or the base locale ignores the catalog; why_new=new field; seam=fit.wrapPlan; no_claim=normalization (core)
  const { d, list } = shots(["fr", "de"]);
  const cat = path.join(d, "Localizable.xcstrings");
  const unit = (v) => ({ stringUnit: { state: "translated", value: v } });
  fs.writeFileSync(cat, JSON.stringify({ sourceLanguage: "fr", version: "1.0", strings: {
    "cta.trial": { localizations: { fr: unit("Essai gratuit"), de: unit("Jetzt kostenlos testen") } },
    "items": { localizations: { fr: { variations: { plural: { one: unit("%d article"), other: unit("%d articles") } } }, de: { variations: { plural: { one: unit("%d Artikel"), other: unit("%d Artikel") } } } } },
  } }));
  const p = fit.wrapPlan(opts(d, { catalogs: [cat] }), list, mapped(list));
  assert.equal(p.baseLocale, "fr");
  const de = p.pairs("de");
  assert.deepEqual(de.entries, [["cta.trial", "Jetzt kostenlos testen", "Essai gratuit", cat]]);
  assert.match(de.digest, /^[0-9a-f]{32}$/);
  assert.equal(p.pairs("de"), de, "loaded once per locale");
});

test("boxes: max_lines is an integer of at least 1 (D2)", () => {
  // Value: protects=the sidecar check of the new field; fails_when=a bad max_lines reaches the core or a good one is dropped; why_new=new field; seam=boxes.check; no_claim=none
  const el = (x) => ({ image: { width: 1, height: 1 }, elements: [{ id: "a", box: [0, 0, 1, 1], ...x }] });
  assert.equal(boxes.check(el({ max_lines: 1 }), "f").elements[0].max_lines, 1);
  assert.equal(boxes.check(el({}), "f").elements[0].max_lines, undefined);
  for (const bad of [0, 1.5, "1", true]) assert.throws(() => boxes.check(el({ max_lines: bad }), "f"), /max_lines must be an integer of at least 1/);
});

test("schema: wrapped and orphan findings and envelopes validate; their required fields are enforced", () => {
  // Value: protects=core/schema/result.schema.json for the new reasons, evidence and fields; fails_when=a field becomes optional or an orphan carries evidence; why_new=new reasons; seam=none; no_claim=what the core emits (WrappingTests encoding)
  assert.ok(validate(env([wrapped, orphan])), JSON.stringify(validate.errors));
  assert.ok(validate(env([{ ...wrapped, evidence: "control", base_rows: null, base_path: null }])), JSON.stringify(validate.errors));
  assert.ok(validate(env([{ ...wrapped, key: "cta.trial", catalog: "de.lproj/Localizable.strings" }])), JSON.stringify(validate.errors));
  assert.ok(validate(env([], { reasons_run: [], reasons_skipped: [{ reason: "wrapped", cause: "boxes-missing" }] })), JSON.stringify(validate.errors));
  for (const k of ["rows", "evidence", "base_rows", "base_path", "element"]) {
    const f = { ...wrapped };
    delete f[k];
    assert.equal(validate(env([f])), false, k);
  }
  assert.equal(validate(env([{ ...orphan, evidence: "base" }])), false);
  assert.equal(validate(env([{ ...orphan, orphan: undefined }].map((f) => JSON.parse(JSON.stringify(f))))), false);
});

test("renderers: text, GitHub, JUnit, GitLab, report overlay and known identity for wrapped and orphan", () => {
  // Value: protects=every renderer's row for the two reasons (table-driven) and the severity (minor, TODO-077); fails_when=a renderer drops the reason, the rows or the evidence, or the overlay draws nothing; why_new=new reasons through generic code; seam=render, ci, overlay, known; no_claim=the HTML page layout
  const rows = [
    [wrapped, '  fit (wrapped) "Jetzt kostenlos / testen" in [cta-trial] at [0.3, 0.4, 0.4, 0.07]: 2 rows, 1 in the base locale (shots/en/paywall.png)', /fit \(wrapped\)/],
    [{ ...wrapped, evidence: "control", base_rows: null, base_path: null }, '  fit (wrapped) "Jetzt kostenlos / testen" in [cta-trial] at [0.3, 0.4, 0.4, 0.07]: 2 rows, a one-line control', /a one-line control/],
    [{ ...wrapped, evidence: "declared", base_rows: null, base_path: null }, '  fit (wrapped) "Jetzt kostenlos / testen" in [cta-trial] at [0.3, 0.4, 0.4, 0.07]: 2 rows, max_lines 1', /max_lines 1/],
    [{ ...wrapped, key: "cta.trial", catalog: "de.json" }, '  fit (wrapped) "Jetzt kostenlos / testen" in [cta-trial] at [0.3, 0.4, 0.4, 0.07]: 2 rows, 1 in the base locale (shots/en/paywall.png) @cta.trial', /@cta\.trial/],
    [orphan, '  fit (orphan) "ändern" ends [title] at [0.1, 0.2, 0.8, 0.12] (row 3 of 3)', /fit \(orphan\) "ändern"/],
  ];
  for (const [f, line, re] of rows) {
    assert.equal(render.findingDetail(f), line);
    const e = scale.annotate(env([f]));
    assert.equal(e.findings[0].severity, "minor");
    assert.match(ci.junit([e]), re);
    assert.match(ci.githubLines([e]).join("\n"), re);
    assert.match(ci.codequality([e])[0].description, re);
    const s = overlay.shapes(e).find((x) => x.ref === "f0");
    assert.deepEqual([s.style, s.boxes], ["fit-wrap", [f.box]]);
    assert.ok(known.identity(f));
  }
});
