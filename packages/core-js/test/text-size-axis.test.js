// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-076: the text-size axis in the layout, inputs, coverage, the results file, merge, baseline and the report.
// No binary needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const results = require("../src/results");
const args = require("../src/args");
const scale = require("../src/scale");
const baseline = require("../src/baseline");
const report = require("../src/report");

const KNOWN = results.knownLocales({ languages: [{ locale: "de", aliases: [] }, { locale: "fr", aliases: [] }] });
const HOST = { chip: "Apple M5", arch: "arm64", host_class: "physical", macos: "27.2.1 (26B131)", vision_revision: 3 };
const env = (p, locale, screen, size = null, extra = {}) => ({
  schema: 1, catscan: "0.55.0", command: "check", path: p, verdict: "pass", engine: "vision-accurate-rev3", locale,
  image: { width: 10, height: 20 }, screen, device: null, platform: null, text_size: size, host: HOST, ms: 5, checks: [], findings: [], warnings: [], ...extra,
});
const fileOf = (entries, exp, { layout = "{text_size}/{locale}/{screen}", started = "2026-12-01T10:00:00Z" } = {}) => {
  const cov = results.coverage(entries, exp, layout, "check");
  for (const m of cov.missing) scale.annotate(m, scale.DEFAULTS);
  return results.build({ results: [...entries, ...cov.missing], coverage: cov.coverage, argv: ["check", "shots"], build: null, host: HOST, ci: null,
    started: new Date(started), finished: new Date(started) });
};
const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
const dataOf = (file) => JSON.parse(report.html(file).match(/<script type="application\/json" id="catscan-data">([\s\S]*?)<\/script>/)[1]);
const fail = (extra = {}) => ({ verdict: "fail", checks: [{ kind: "present", text: "Weiter", verdict: "fail", gate: true, severity: "major", certainty: "high" }], ...extra });

test("layout: {text_size}/ alone and after {device}/, fixed order, label grammar", () => {
  // Value: protects=TODO-076 D2 layout grammar; fails_when=the size folder is read as a locale, or the reverse order is accepted; why_new=new; seam=TODO-075 layout module; no_claim=none
  const m = (layout, rel) => results.mapPath(layout, rel, KNOWN);
  assert.deepEqual(m("{text_size}/{screen}.{locale}", "large/home.de.png"), { device: null, text_size: "large", locale: "de", screen: "home" });
  assert.deepEqual(m("{text_size}/{locale}/{screen}", "Large/de/onboarding/1.png"), { device: null, text_size: "large", locale: "de", screen: "onboarding/1" }, "lower case");
  assert.deepEqual(m("{device}/{text_size}/{screen}.{locale}", "ios/fs1.3/home.de.png"), { device: "ios", text_size: "fs1.3", locale: "de", screen: "home" });
  assert.deepEqual(m("{device}/{text_size}/{screen}/{locale}", "android/default/home/fr.png"), { device: "android", text_size: "default", locale: "fr", screen: "home" });
  assert.equal(m("{text_size}/{screen}.{locale}", "home.de.png"), null, "no size folder");
  assert.equal(m("{device}/{text_size}/{screen}.{locale}", "ios/home.de.png"), null, "one folder for two segments");
  assert.equal(m("{text_size}/{locale}/{screen}", "-x/de/home.png"), null, "not a label");
  // D2: the order is fixed; the reverse is not a layout.
  assert.throws(() => args.parse(["check", "shots", "--present", "x", "--layout", "{text_size}/{device}/{screen}.{locale}"]), (e) => e.code === "invalid-layout" && /\{device\}\/, then \{text_size\}\//.test(e.message));
  for (const l of ["{text_size}/{locale}/{screen}", "{device}/{text_size}/{screen}.{locale}"]) assert.equal(args.parse(["check", "shots", "--present", "x", "--layout", l]).layout, l);
  // A filled layout prepends a size the layout does not hold, so two sizes' missing cells never share a name.
  assert.equal(results.fillLayout("{screen}.{locale}", { device: null, text_size: "large", locale: "de", screen: "home" }), "large/home.de");
  assert.equal(results.fillLayout("{device}/{text_size}/{locale}/{screen}", { device: "ios", text_size: "default", locale: "de", screen: "home" }), "ios/default/de/home");
  // The {device}/ suggestion keeps the size segment.
  assert.equal(results.suggestLayout("{text_size}/{screen}.{locale}", ["ios/large/home.de.png"], KNOWN), "{device}/{text_size}/{screen}.{locale}");
});

test("args: --text-size and --expect-text-sizes take labels; invalid-text-size is a usage error", () => {
  // Value: protects=TODO-076 "Interface" flags; fails_when=a bad label reaches the file or the hint is wrong; why_new=new; seam=none; no_claim=none
  assert.equal(args.parse(["truncated", "shots", "--text-size", "LARGE"]).textSize, "large");
  assert.equal(args.parse(["report", "a.json", "--expect-text-sizes", "default,large", "--out", "r.html"]).expectTextSizes, "default,large");
  assert.throws(() => args.parse(["truncated", "shots", "--text-size", "x/y"]), (e) => e.code === "invalid-text-size" && e.hint === "--text-size large");
  assert.throws(() => args.parse(["results", "validate", "a.json", "--text-size", "large"]), (e) => e.code === "option-not-valid" || e.code === "unknown-option");
  const exp = (v) => results.expectations({ expectLocales: null, expectLocalesFrom: null, expectScreens: null, expectTextSizes: v });
  assert.deepEqual(exp("zoom200,Large,default,ax1,custom,xl").textSizes, ["default", "large", "xl", "ax1", "zoom200", "custom"], "label order");
  assert.throws(() => exp(" , "), (e) => e.code === "invalid-text-size");
  assert.throws(() => exp("default,x y"), (e) => e.code === "invalid-text-size");
});

test("inputs: --text-size wins with text-size-path-mismatch; no size is default; null and default are one cell", () => {
  // Value: protects=TODO-076 D6 and --text-size precedence; fails_when=a sizeless input drops out of the cube, or default and null count twice; why_new=new; seam=none; no_claim=none
  const map = (layout, rels, o = {}) => results.mapInputs(layout, rels, KNOWN, { paths: rels, ...o });
  const a = map("{text_size}/{locale}/{screen}", ["default/de/home.png", "large/de/home.png"], { textSize: "large" });
  assert.deepEqual(a.map((o) => o.cell.text_size), ["large", "large"]);
  assert.deepEqual(a[0].warnings.map((w) => w.code), ["text-size-path-mismatch", "duplicate-cell"]);
  assert.match(a[0].warnings[0].message, /under text size default but is read as large/);
  assert.match(a[1].warnings[0].message, /text size large, locale de, screen home/);
  // Unlike a missing device (TODO-075 D9), a missing size keeps its cell: it is the default one.
  const b = map("{locale}/{screen}", ["de/home.png"], { exp: { textSizes: ["default", "large"] } });
  assert.deepEqual(b[0].cell, { device: null, text_size: null, locale: "de", screen: "home" });
  assert.deepEqual(b[0].warnings, []);
  assert.equal(results.cellKey({ device: null, text_size: null, locale: "de", screen: "home" }), results.cellKey({ device: null, text_size: "default", locale: "DE", screen: "home" }));
  assert.notEqual(results.cellKey({ device: null, text_size: "large", locale: "de", screen: "home" }), results.cellKey({ device: null, text_size: null, locale: "de", screen: "home" }));
});

test("coverage and file: the size cube, null counts as default, results_schema 2 with axes in key order", () => {
  // Value: protects=TODO-076 coverage, D6 and the axes list; fails_when=a pre-axis input is missing at default, or axes order drifts; why_new=new; seam=TODO-075 D16 axes; no_claim=report
  const got = [env("s/de/home.png", "de", "home"), env("s/large/fr/home.png", "fr", "home", "large")];
  const a = results.coverage(got, { locales: ["de", "fr"], screens: null }, "{screen}.{locale}", "check");
  assert.deepEqual(a.coverage.expected_text_sizes, ["default", "large"]);
  assert.equal(a.coverage.received, 2);
  assert.deepEqual(a.coverage.missing, [{ device: null, text_size: "default", locale: "fr", screen: "home" }, { device: null, text_size: "large", locale: "de", screen: "home" }]);
  assert.deepEqual(a.missing.map((m) => [m.text_size, m.findings[0].expected_path]), [["default", "default/home.fr"], ["large", "large/home.de"]]);
  // No axis: null and nothing changes.
  assert.equal(results.coverage([env("s/de/home.png", "de", "home")], { locales: ["de"], screens: null }, "{locale}/{screen}", "check").coverage.expected_text_sizes, null);
  // The file: only this axis, then both axes in key order.
  const one = fileOf([env("s/default/de/home.png", "de", "home", "default"), env("s/large/de/home.png", "de", "home", "large")], { locales: ["de"], screens: null });
  assert.equal(one.results_schema, 2);
  assert.deepEqual(one.axes, ["text_size"]);
  assert.deepEqual(results.check(one), []);
  const both = fileOf([env("s/ios/large/de/home.png", "de", "home", "large", { device: "ios", platform: "ios" })], { locales: ["de"], screens: null, textSizes: ["default", "large"] }, { layout: "{device}/{text_size}/{locale}/{screen}" });
  assert.deepEqual(both.axes, ["device", "text_size"]);
  assert.deepEqual(both.results.filter(results.isMissing).map((e) => e.findings[0].expected_path), ["ios/default/de/home"]);
  assert.deepEqual(results.check(both), []);
  // --expect-text-sizes alone uses the axis.
  const exp = fileOf([], { locales: ["de"], screens: ["home"], textSizes: ["large"] });
  assert.deepEqual([exp.results_schema, exp.axes], [2, ["text_size"]]);
  assert.deepEqual(results.check(exp), []);
  const bad = (mutate) => { const f = structuredClone(one); mutate(f); return results.check(f).map((e) => e.pointer); };
  assert.ok(bad((f) => { f.coverage.expected_text_sizes = ["large"]; }).includes("/coverage/received"));
  assert.ok(bad((f) => { f.results_schema = 1; delete f.axes; }).includes("/results_schema"));
  assert.ok(bad((f) => { f.axes = ["device", "text_size"]; }).includes("/axes"));
  assert.ok(bad((f) => { f.results[0].text_size = "Large"; }).length, "a label is lower case");
  // An older reader's AXES lacks text_size; this one knows it.
  assert.deepEqual(results.unknownAxes({ axes: ["device", "text_size"] }), []);
});

test("merge: a run from before the axis joins a --text-size large run as its default cells, in any order", () => {
  // Value: protects=TODO-076 D6 merge; fails_when=old shards need a rerun, or the merge depends on input order; why_new=new; seam=TODO-075 merge union; no_claim=none
  const old = fileOf([env("s/de/home.png", "de", "home")], { locales: ["de"], screens: null }, { layout: "{locale}/{screen}" });
  assert.equal(old.results_schema, 1);
  const large = fileOf([env("s/de/home.png", "de", "home", "large")], { locales: ["de"], screens: null }, { layout: "{locale}/{screen}", started: "2026-12-01T10:01:00Z" });
  const outs = permutations([old, large]).map((p) => JSON.stringify(results.merge(structuredClone(p), { exp: null, layout: null, argv: [] }).file));
  assert.equal(outs[0], outs[1]);
  const m = JSON.parse(outs[0]);
  assert.deepEqual(results.check(m), []);
  assert.deepEqual([m.results_schema, m.axes, m.coverage.expected_text_sizes, m.coverage.missing, m.coverage.received], [2, ["text_size"], ["default", "large"], [], 2]);
  // --expect-text-sizes at merge: a size that never ran is missing.
  const e = results.merge([structuredClone(old)], { exp: { locales: null, screens: null, devices: null, textSizes: ["default", "large"] }, layout: null, argv: [] }).file;
  assert.deepEqual(e.coverage.missing, [{ device: null, text_size: "large", locale: "de", screen: "home" }]);
  assert.deepEqual(results.check(e), []);
  // Two runs with no size stay schema 1.
  const old2 = fileOf([env("s/fr/home.png", "fr", "home")], { locales: ["fr"], screens: null }, { layout: "{locale}/{screen}", started: "2026-12-01T10:02:00Z" });
  assert.equal(results.merge([old, old2], { exp: null, layout: null, argv: [] }).file.results_schema, 1);
  // A merged file merges again to the same coverage.
  assert.deepEqual(results.merge([m], { exp: null, layout: null, argv: [] }).file.coverage, m.coverage);
  // A shard with no coverage and no mapped cell adds no `default` size (review fix).
  const unmapped = results.build({ results: [env("s/x.png", "de", null)], coverage: null, argv: ["check", "s"], build: null, host: HOST, ci: null,
    started: new Date("2026-12-01T10:03:00Z"), finished: new Date("2026-12-01T10:03:00Z") });
  const u = results.merge([structuredClone(large), unmapped], { exp: null, layout: null, argv: [] }).file;
  assert.deepEqual([u.coverage.expected_text_sizes, u.coverage.missing], [["large"], []]);
});

test("baseline: a baseline from before the axis matches the default cells; large cells are new", () => {
  // Value: protects=TODO-076 "Baseline" and D6; fails_when=an old baseline makes every default cell new, or a large cell compares with a default one; why_new=new; seam=TODO-038 compare; no_claim=report
  const rec = (words) => { const tokens = [...words].sort(); return { algo: 1, tokens, lines: [words.join(" ")], digest: baseline.tokensDigest(tokens), ignore: null }; };
  const shot = (p, size, words) => env(p, "de", "home", size, { text: rec(words), change: null });
  const base = results.build({ results: [shot("s/de/home.png", null, ["start"])], coverage: null, argv: ["check", "s"], started: new Date(0), finished: new Date(0), build: null, host: HOST, ci: null });
  base.approved = { at: "2026-11-01T00:00:00Z", from: baseline.fileDigest(base) };
  const cur = results.build({ results: [shot("s/default/de/home.png", "default", ["start"]), shot("s/large/de/home.png", "large", ["start"])], coverage: null, argv: ["check", "s"], started: new Date(0), finished: new Date(0), build: null, host: HOST, ci: null });
  const r = baseline.compare(cur, base, { file: "base.json" });
  assert.deepEqual(r.block.cells.map((c) => [c.text_size, c.state]), [["default", "unchanged"], ["large", "new"]]);
  cur.baseline = r.block;
  assert.deepEqual(results.check(cur), []);
  // One size per job: a --text-size large run against that baseline has no overlap by design; its cells are new, not
  // baseline-no-overlap (review fix). A wrong layout at a size the baseline has still exits 2.
  const largeOnly = results.build({ results: [shot("s/large/de/home.png", "large", ["start"])], coverage: null, argv: ["check", "s"], started: new Date(0), finished: new Date(0), build: null, host: HOST, ci: null });
  const l = baseline.compare(largeOnly, base, { file: "base.json" });
  assert.deepEqual(l.block.cells.map((c) => [c.text_size, c.state]), [["large", "new"], [null, "gone"]]);
  const other = results.build({ results: [env("s/de/menu.png", "de", "menu", null, { text: rec(["start"]), change: null })], coverage: null, argv: ["check", "s"], started: new Date(0), finished: new Date(0), build: null, host: HOST, ci: null });
  assert.throws(() => baseline.compare(other, base, { file: "base.json" }), (e) => e.code === "baseline-no-overlap");
  // A large-only run whose screens the baseline has at no size is a wrong layout or file, not new cells (review fix).
  const largeOther = results.build({ results: [env("s/large/de/menu.png", "de", "menu", "large", { text: rec(["start"]), change: null })], coverage: null, argv: ["check", "s"], started: new Date(0), finished: new Date(0), build: null, host: HOST, ci: null });
  assert.throws(() => baseline.compare(largeOther, base, { file: "base.json" }), (e) => e.code === "baseline-no-overlap");
  // The report keeps a large cell only the baseline holds apart from the default one (review fix).
  largeOnly.baseline = l.block;
  const back = results.build({ results: [shot("s/de/home.png", null, ["start"])], coverage: null, argv: ["check", "s"], started: new Date(0), finished: new Date(0), build: null, host: HOST, ci: null });
  back.baseline = baseline.compare(back, largeOnly, { file: "base.json" }).block;
  const m = dataOf(back).matrix;
  assert.deepEqual(m.cells.map((c) => [c.text_size, c.state]).sort(), [["default", "pass"], ["large", "gone"]]);
});

test("report: sizes are sub-columns in label order; the large text badge and filter; coverage factor", () => {
  // Value: protects=TODO-076 D8 badge and report layout; fails_when=the badge marks a cell whose default fails or is missing, or sizes sort by code point; why_new=new; seam=TODO-075 report sub-columns; no_claim=browser rendering
  const entries = [
    env("s/default/de/home.png", "de", "home", "default"), env("s/large/de/home.png", "de", "home", "large", fail()), env("s/xl/de/home.png", "de", "home", "xl"),
    env("s/default/de/menu.png", "de", "menu", "default", fail()), env("s/large/de/menu.png", "de", "menu", "large", fail()),
    env("s/large/de/pay.png", "de", "pay", "large", fail()),
  ];
  const f = fileOf(entries, { locales: ["de"], screens: null });
  const d = dataOf(f);
  assert.deepEqual(d.matrix.textSizes, ["default", "large", "xl"]);
  const cellAt = (screen, size) => d.matrix.cells.find((c) => c.screen === screen && c.text_size === size);
  assert.deepEqual(cellAt("home", "large").badges, ["large text"]);
  assert.deepEqual(cellAt("home", "default").badges, []);
  assert.deepEqual(cellAt("menu", "large").badges, [], "default fails too");
  assert.deepEqual(cellAt("pay", "large").badges, [], "default is missing");
  assert.equal(cellAt("pay", "default").state, "missing");
  assert.deepEqual(d.items.filter((it) => it.large_text).map((it) => it.path), ["s/large/de/home.png"]);
  assert.match(d.matrix.coverageLine, /of 9 expected cells \(3 screens x 1 locales x 3 text sizes\)/);
  // A run before the axis has no size column; the shell has the filter's code.
  const plain = dataOf(fileOf([env("s/de/home.png", "de", "home")], { locales: ["de"], screens: null }, { layout: "{locale}/{screen}" }));
  assert.deepEqual([plain.matrix.textSizes, plain.items[0].text_size], [[], null]);
  assert.match(report.html(f), /"large-text", "Large text"/);
});
