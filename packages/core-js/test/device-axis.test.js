// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-075: the device axis in the layout, coverage, the results file, merge and validate. No binary needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const results = require("../src/results");
const args = require("../src/args");
const scale = require("../src/scale");

const KNOWN = results.knownLocales({ languages: [{ locale: "de", aliases: [] }, { locale: "fr", aliases: [] }, { locale: "ja", aliases: [] }] });
const HOST = { chip: "Apple M1", arch: "arm64", host_class: "physical", macos: "26.1 (25B78)", vision_revision: 3 };
const env = (p, locale, screen, device = null, extra = {}) => ({
  schema: 1, catscan: "0.49.0", command: "check", path: p, verdict: "pass", engine: "vision-accurate-rev3", locale,
  image: { width: 10, height: 20 }, screen, device, platform: results.platformOf(device), host: HOST, ms: 5, checks: [], findings: [], warnings: [], ...extra,
});
const fileOf = (entries, exp, { layout = "{device}/{locale}/{screen}", started = "2026-12-01T10:00:00Z", thresholds } = {}) => {
  const cov = results.coverage(entries, exp, layout, "check");
  for (const m of cov.missing) scale.annotate(m, thresholds ?? scale.DEFAULTS);
  return results.build({ results: [...entries, ...cov.missing], coverage: cov.coverage, argv: ["check", "shots"], build: null, host: HOST, ci: null,
    started: new Date(started), finished: new Date(started), ...(thresholds ? { thresholds } : {}) });
};
const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

test("layout: {device}/ on each base pattern, grammar, case, and the no-match cases", () => {
  const m = (layout, rel) => results.mapPath(layout, rel, KNOWN);
  assert.deepEqual(m("{device}/{locale}/{screen}", "ios/de/home.png"), { device: "ios", text_size: null, locale: "de", screen: "home" });
  assert.deepEqual(m("{device}/{screen}.{locale}", "android-pixel-9/onboarding/1.de.png"), { device: "android-pixel-9", text_size: null, locale: "de", screen: "onboarding/1" });
  assert.deepEqual(m("{device}/{screen}/{locale}", "ios.se/home/fr.png"), { device: "ios.se", text_size: null, locale: "fr", screen: "home" });
  assert.deepEqual(m("{device}/{locale}/{screen}", "iOS-SE/de/home.png"), { device: "ios-se", text_size: null, locale: "de", screen: "home" }, "lower case");
  // The rest must match the base pattern; a device folder breaking the grammar does not match.
  assert.equal(m("{device}/{locale}/{screen}", "de/home.png"), null);
  assert.equal(m("{device}/{locale}/{screen}", "ios/xx/home.png"), null);
  assert.equal(m("{device}/{locale}/{screen}", "-ios/de/home.png"), null);
  assert.equal(m("{device}/{locale}/{screen}", "i os/de/home.png"), null);
  assert.equal(m("{device}/{locale}/{screen}", `${"a".repeat(65)}/de/home.png`), null);
  assert.equal(m("{device}/{screen}.{locale}", "home.de.png"), null);
  // D11: the documented nested-folder misread.
  assert.deepEqual(m("{device}/{screen}.{locale}", "onboarding/1.de.png"), { device: "onboarding", text_size: null, locale: "de", screen: "1" });
  assert.equal(results.needsLocales("{device}/{locale}/{screen}", ["ios/de/home.png"]), true);
});

test("platform: the label's first token when it names one", () => {
  for (const p of ["ios", "ipados", "android", "web", "macos", "watchos", "tvos", "visionos"]) {
    assert.equal(results.platformOf(p), p);
    assert.equal(results.platformOf(`${p}-x`), p);
  }
  assert.equal(results.platformOf("ios_se"), "ios");
  assert.equal(results.platformOf("ios.se"), "ios");
  assert.equal(results.platformOf("iphone-17-pro"), null);
  assert.equal(results.platformOf("iosx"), null);
  assert.equal(results.platformOf(null), null);
});

test("args: --device, --expect-devices and the prefixed layouts", () => {
  for (const l of ["{device}/{locale}/{screen}", "{device}/{screen}.{locale}", "{device}/{screen}/{locale}"]) {
    assert.equal(args.parse(["check", "shots", "--present", "x", "--layout", l]).layout, l);
  }
  assert.throws(() => args.parse(["check", "shots", "--present", "x", "--layout", "{locale}/{device}/{screen}"]), { code: "invalid-layout" });
  assert.equal(args.parse(["check", "shots", "--present", "x", "--device", "iOS-SE"]).device, "ios-se");
  for (const bad of ["-ios", "i os", "ios/se", "a".repeat(65), ""]) {
    assert.throws(() => args.parse(["check", "shots", "--present", "x", "--device", bad]), (e) => e.code === "invalid-device" && e.hint === "--device ios-se");
  }
  assert.throws(() => args.parse(["report", "r.json", "--device", "ios"]), { code: "option-not-valid" });
  assert.equal(args.parse(["results", "merge", "a.json", "--out", "m.json", "--expect-devices", "ios,android"]).expectDevices, "ios,android");
  assert.deepEqual(results.expectations({ expectLocales: null, expectLocalesFrom: null, expectScreens: null, expectDevices: "iOS, android ,ios" }).devices, ["android", "ios"]);
  assert.throws(() => results.expectations({ expectLocales: null, expectLocalesFrom: null, expectScreens: null, expectDevices: "ios,-x" }), { code: "invalid-device" });
  assert.throws(() => results.expectations({ expectLocales: null, expectLocalesFrom: null, expectScreens: null, expectDevices: " , " }), { code: "invalid-device" });
});

test("inputs: --device wins with device-path-mismatch; device-missing once the axis is in use; duplicates per device", () => {
  const map = (layout, rels, o = {}) => results.mapInputs(layout, rels, KNOWN, { paths: rels, ...o });
  const a = map("{device}/{locale}/{screen}", ["ios/de/home.png", "android/de/home.png"], { device: "ios" });
  assert.deepEqual(a.map((o) => o.device), ["ios", "ios"]);
  assert.deepEqual(a[0].warnings.map((w) => w.code), ["duplicate-cell"]);
  assert.deepEqual(a[1].warnings.map((w) => w.code), ["device-path-mismatch", "duplicate-cell"]);
  assert.equal(a[1].warnings[0].hint, "drop --device or move the file");
  // The same locale and screen on two devices are two cells.
  const b = map("{device}/{locale}/{screen}", ["ios/de/home.png", "android/de/home.png"]);
  assert.deepEqual(b.map((o) => [o.device, o.screen, o.warnings.length]), [["ios", "home", 0], ["android", "home", 0]]);
  // --device alone sets every input's device; without it and without the axis the device is null.
  assert.deepEqual(map("{locale}/{screen}", ["de/home.png"], { device: "android" }).map((o) => o.cell), [{ device: "android", text_size: null, locale: "de", screen: "home" }]);
  assert.deepEqual(map("{locale}/{screen}", ["de/home.png"]).map((o) => o.cell), [{ device: null, text_size: null, locale: "de", screen: "home" }]);
  // --expect-devices with an input that has no device: unmapped, named by input, devices and next command (D9, D14).
  const c = map("{locale}/{screen}", ["de/home.png"], { exp: { locales: null, screens: null, devices: ["ios", "android"] } });
  assert.equal(c[0].cell, null);
  assert.equal(c[0].screen, null);
  assert.deepEqual(c[0].warnings, [{ code: "device-missing", message: "de/home.png has no device, but this run has devices (android, ios), so it is in no cell",
    hint: "rerun its command with --device <one of android, ios>, or leave results written before the device axis out of the merge" }]);
});

test("layout suggestion: names the {device}/ variant only when it maps every unmapped input (D13)", () => {
  const exp = { locales: ["de"], screens: null, devices: null };
  const map = (rels) => results.mapInputs("{locale}/{screen}", rels, KNOWN, { paths: rels, exp });
  const w = map(["ios/de/home.png", "android/de/home.png"])[0].warnings[0];
  assert.equal(w.code, "layout-mismatch");
  assert.equal(w.message, "ios/de/home.png does not match --layout {locale}/{screen}, so it is in no expected cell - try: --layout '{device}/{locale}/{screen}'");
  assert.equal(w.hint, "--layout '{device}/{locale}/{screen}'");
  const g = map(["ios/de/home.png", "loose.png"])[0].warnings[0];
  assert.equal(g.hint, "move it to the layout or pass --layout");
  assert.equal(results.suggestLayout("{device}/{locale}/{screen}", ["x/y.png"], KNOWN), null);
});

test("coverage: the device cube with and without --expect-devices, missing items and expected_path", () => {
  const got = [env("s/ios/de/home.png", "de", "home", "ios"), env("s/android/de/home.png", "android", "home", "android")];
  got[1].locale = "de";
  // Without --expect-devices: the devices of mapped inputs, ordered by platform then label.
  const a = results.coverage(got, { locales: ["de", "fr"], screens: null, devices: null }, "{device}/{locale}/{screen}", "check");
  assert.deepEqual(a.coverage.expected_devices, ["android", "ios"]);
  assert.equal(a.coverage.received, 2);
  assert.deepEqual(a.coverage.missing, [{ device: "android", text_size: null, locale: "fr", screen: "home" }, { device: "ios", text_size: null, locale: "fr", screen: "home" }]);
  assert.deepEqual(a.missing.map((m) => [m.device, m.platform, m.findings[0].expected_path]), [["android", "android", "android/fr/home"], ["ios", "ios", "ios/fr/home"]]);
  // A device that never arrived, with --expect-devices; a device outside the list is not received.
  const b = results.coverage(got, { locales: ["de"], screens: null, devices: ["ios", "web"] }, "{device}/{locale}/{screen}", "check");
  assert.deepEqual(b.coverage.expected_devices, ["ios", "web"]);
  assert.equal(b.coverage.received, 1);
  assert.deepEqual(b.coverage.missing, [{ device: "web", text_size: null, locale: "de", screen: "home" }]);
  // D6: a device from --device is prepended to a layout without one.
  const c = results.coverage([env("s/de/home.png", "de", "home", "ios")], { locales: ["de", "fr"], screens: null, devices: null }, "{screen}.{locale}", "check");
  assert.equal(c.missing[0].findings[0].expected_path, "ios/home.fr");
  // No axis: the dimension is null and nothing changes.
  const d = results.coverage([env("s/de/home.png", "de", "home")], { locales: ["de"], screens: null }, "{locale}/{screen}", "check");
  assert.equal(d.coverage.expected_devices, null);
  // Labels with no platform sort after those with one.
  assert.deepEqual(["ios-se", "pixel", "android-x", "ios-pro"].sort(results.byDevice), ["android-x", "ios-pro", "ios-se", "pixel"]);
});

test("file: schema 1 without the axis, 2 with axes [device]; missing sorted by device; validate checks device cells", () => {
  const one = fileOf([env("s/de/home.png", "de", "home")], { locales: ["de", "fr"], screens: null }, { layout: "{locale}/{screen}" });
  assert.equal(one.results_schema, 1);
  assert.equal("axes" in one, false);
  assert.deepEqual(results.check(one), []);
  const two = fileOf([env("s/ios/de/home.png", "de", "home", "ios"), env("s/android/fr/home.png", "fr", "home", "android")], { locales: ["de", "fr"], screens: null });
  assert.equal(two.results_schema, 2);
  assert.deepEqual(two.axes, ["device"]);
  assert.deepEqual(Object.keys(two).slice(0, 3), ["results_schema", "axes", "run"]);
  assert.deepEqual(results.check(two), []);
  assert.deepEqual(two.results.filter(results.isMissing).map((e) => `${e.device}/${e.locale}`), ["android/de", "ios/fr"]);
  // --expect-devices alone uses the axis, even when no input has a device.
  const exp = fileOf([], { locales: ["de"], screens: ["home"], devices: ["ios"] });
  assert.equal(exp.results_schema, 2);
  assert.deepEqual(results.check(exp), []);
  const bad = (mutate) => { const f = structuredClone(two); mutate(f); return results.check(f).map((e) => e.pointer); };
  assert.ok(bad((f) => { f.coverage.missing[0].device = "ios"; }).includes("/coverage/missing"));
  assert.ok(bad((f) => { f.coverage.expected_devices = ["ios"]; }).includes("/coverage/received"));
  assert.ok(bad((f) => { f.results.find(results.isMissing).device = "web"; f.coverage.missing[0].device = "web"; }).some((p) => p.startsWith("/results/")));
  assert.ok(bad((f) => { f.axes = ["device", "orientation"]; }).includes("/axes"));
  assert.ok(bad((f) => { delete f.axes; }).length);
  assert.ok(bad((f) => { f.results[0].device = "iOS"; }).length, "a label is lower case");
  // D9 on read: a mapped entry beside device entries has a device; a platform is the one its label gives.
  assert.ok(bad((f) => { const e = f.results.find((x) => !results.isMissing(x)); e.device = null; e.platform = null; }).some((p) => /^\/results\/\d+\/device$/.test(p)));
  assert.ok(bad((f) => { f.results.find((x) => !results.isMissing(x)).platform = "web"; }).some((p) => /^\/results\/\d+\/platform$/.test(p)));
});

test("merge: schema 1 and 2 shards; a deviceless shard is unmapped, never a null column; any order is byte-identical", () => {
  const ios = fileOf([env("s/ios/de/home.png", "de", "home", "ios")], { locales: ["de"], screens: null }, { started: "2026-12-01T10:00:00Z" });
  const android = fileOf([env("s/android/de/home.png", "de", "home", "android")], { locales: ["de"], screens: null }, { started: "2026-12-01T10:01:00Z" });
  const old = fileOf([env("s/de/home.png", "de", "home")], { locales: ["de"], screens: null }, { layout: "{device}/{locale}/{screen}", started: "2026-12-01T10:02:00Z" });
  assert.equal(old.results_schema, 1);
  const outs = permutations([ios, android, old]).map((p) => JSON.stringify(results.merge(structuredClone(p), { exp: null, layout: null, argv: [] }).file));
  for (const o of outs) assert.equal(o, outs[0]);
  const m = JSON.parse(outs[0]);
  assert.deepEqual(results.check(m), []);
  assert.equal(m.results_schema, 2);
  assert.deepEqual(m.coverage.expected_devices, ["android", "ios"], "the union of the shards' devices");
  assert.deepEqual(m.coverage.missing, []);
  const o = m.results.find((e) => e.path === "s/de/home.png");
  assert.equal(o.screen, null);
  assert.deepEqual(o.warnings.map((w) => w.code), ["device-missing"]);
  // --expect-devices at merge: a platform job that never ran is missing.
  const e = results.merge([structuredClone(ios)], { exp: { locales: ["de"], screens: null, devices: ["ios", "android"] }, layout: null, argv: [] }).file;
  assert.deepEqual(e.coverage.missing, [{ device: "android", text_size: null, locale: "de", screen: "home" }]);
  assert.deepEqual(e.results.find(results.isMissing).findings[0].expected_path, "android/de/home");
  assert.deepEqual(results.check(e), []);
  // A merge flag replaces its own axis only (D22): --expect-devices alone keeps the shards' expected locales.
  const iosFr = fileOf([env("s/ios/de/home.png", "de", "home", "ios")], { locales: ["de", "fr"], screens: null });
  const only = results.merge([structuredClone(iosFr)], { exp: { locales: null, screens: null, devices: ["ios"] }, layout: null, argv: [] }).file;
  assert.deepEqual(only.coverage.expected_locales, ["de", "fr"]);
  assert.deepEqual(only.coverage.missing, [{ device: "ios", text_size: null, locale: "fr", screen: "home" }]);
  // A shard with no coverage adds the devices of its mapped envelopes.
  const nc = structuredClone(android); nc.coverage = null;
  assert.deepEqual(results.merge([structuredClone(ios), nc], { exp: null, layout: null, argv: [] }).file.coverage.expected_devices, ["android", "ios"]);
  // Merging a merged file again is idempotent: one device-missing warning, the same cells.
  const again = results.merge([m], { exp: null, layout: null, argv: [] }).file;
  assert.deepEqual(again.results.find((x) => x.path === "s/de/home.png").warnings.map((w) => w.code), ["device-missing"]);
  assert.deepEqual(again.coverage, m.coverage);
  // Two schema-1 shards stay schema 1.
  const old2 = fileOf([env("s/fr/home.png", "fr", "home")], { locales: ["fr"], screens: null }, { layout: "{device}/{locale}/{screen}", started: "2026-12-01T10:03:00Z" });
  assert.equal(results.merge([old, old2], { exp: null, layout: null, argv: [] }).file.results_schema, 1);
});

test("merge: device shards with different thresholds stay two shards and warn mixed-thresholds (D17, D18)", () => {
  const ios = fileOf([env("s/ios/de/home.png", "de", "home", "ios")], { locales: ["de"], screens: null }, { started: "2026-12-01T10:00:00Z" });
  const android = fileOf([env("s/android/de/home.png", "de", "home", "android")], { locales: ["de"], screens: null }, { started: "2026-12-01T10:00:00Z", thresholds: { min_severity: "critical", min_certainty: "high" } });
  android.run.argv = ios.run.argv;
  const r = results.merge([ios, android], { exp: null, layout: null, argv: [] });
  assert.equal(r.file.run.shards.length, 2);
  assert.deepEqual(r.warnings.map((w) => w.code), ["mixed-thresholds"]);
  assert.equal(r.file.run.thresholds, null);
  assert.deepEqual(results.check(r.file), []);
});
