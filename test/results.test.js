// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 27 through the CLI with Vision: --results, --layout, expected coverage, results merge and validate.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { ROOT, setup, cli, golden } = require("./helpers");

const synth = setup();
// A {locale}/{screen} tree from the synthetic screens: de and fr have home; de also has paywall.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-results-"));
const put = (rel, name) => { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.copyFileSync(path.join(synth, name), path.join(work, rel)); };
put("shots/de/home.png", "03-de-phone.png");
put("shots/de/paywall.png", "03-de-phone.png");
put("shots/fr/home.png", "04-fr-tablet.png");
const run = (argv, opts = {}) => cli(argv, { cwd: work, ...opts });
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(work, f), "utf8"));
// What varies between identical runs (spec 27 "Determinism").
const normalize = (f) => ({
  ...f, run: null,
  results: f.results.map((r) => ({ ...r, ms: 0, host: r.host && "host" })),
});

test("check --results with --expect-locales: missing entries on stdout, in the file and in the exit code", () => {
  const r = run(["check", "shots", "--present", "Weiter", "--expect-locales", "de,fr,ja", "--results", "out.json", "--build", "4512", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  const missing = r.json.filter((e) => e.path === null);
  assert.deepEqual(missing.map((e) => [e.locale, e.screen, e.findings[0].expected_path]),
    [["fr", "paywall", "fr/paywall"], ["ja", "home", "ja/home"], ["ja", "paywall", "ja/paywall"]]);
  const f = readJSON("out.json");
  assert.deepEqual(f.coverage.missing, [{ device: null, text_size: null, locale: "fr", screen: "paywall" }, { device: null, text_size: null, locale: "ja", screen: "home" }, { device: null, text_size: null, locale: "ja", screen: "paywall" }]);
  assert.equal(f.coverage.received, 3);
  assert.deepEqual(f.run.build, { id: "4512", version: null });
  assert.deepEqual(f.results.filter((e) => e.path).map((e) => [e.path, e.locale, e.screen]),
    [["shots/de/home.png", "de", "home"], ["shots/de/paywall.png", "de", "paywall"], ["shots/fr/home.png", "fr", "home"]]);
  assert.equal(run(["results", "validate", "out.json"]).code, 0);
  golden(test, "results-check.json", JSON.stringify(normalize(f), (k, v) => (k === "catscan" ? "X" : v), 2) + "\n");
  // Text mode prints each missing cell as one FAIL line after the inputs.
  const t = run(["check", "shots", "--present", "Weiter", "--expect-locales", "de,fr,ja"]);
  assert.match(t.stdout, /FAIL {2}missing: fr\/paywall\nFAIL {2}missing: ja\/home\nFAIL {2}missing: ja\/paywall\n/);
});

test("no expectation flag: coverage null, the layout still sets locale and screen", () => {
  const r = run(["read", "shots", "--results", "read.json"]);
  assert.equal(r.code, 0, r.stderr);
  const f = readJSON("read.json");
  assert.equal(f.coverage, null);
  assert.deepEqual(f.results.map((e) => [e.locale, e.screen]), [["de", "home"], ["de", "paywall"], ["fr", "home"]]);
  // --layout none turns the mapping off; --locale beats the path and says so.
  const none = run(["read", "shots", "--layout", "none", "--json"]);
  assert.deepEqual(none.json.map((e) => [e.locale, e.screen]), [["en", null], ["en", null], ["en", null]]);
  // The cell is the envelope's (locale, screen) (D6), so fr/home read as de lands in de's cell.
  const loc = run(["read", "shots", "--locale", "de", "--json"]);
  const fr = loc.json.find((e) => e.path === "shots/fr/home.png");
  assert.deepEqual([fr.locale, fr.screen, fr.warnings.map((w) => w.code)], ["de", "home", ["locale-path-mismatch", "duplicate-cell"]]);
});

test("TODO-075: a {device}/{locale}/{screen} tree with --expect-devices; one device lacks a locale", () => {
  put("dev/ios/de/home.png", "03-de-phone.png");
  put("dev/ios/fr/home.png", "04-fr-tablet.png");
  put("dev/android/de/home.png", "03-de-phone.png");
  const r = run(["read", "dev", "--layout", "{device}/{locale}/{screen}", "--expect-devices", "ios,android", "--expect-locales", "de,fr", "--results", "dev.json", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json.filter((e) => e.path).map((e) => [e.path, e.device, e.platform, e.locale, e.screen]),
    [["dev/android/de/home.png", "android", "android", "de", "home"], ["dev/ios/de/home.png", "ios", "ios", "de", "home"], ["dev/ios/fr/home.png", "ios", "ios", "fr", "home"]]);
  const f = readJSON("dev.json");
  assert.equal(f.results_schema, 2);
  assert.deepEqual(f.axes, ["device"]);
  assert.deepEqual(f.coverage.expected_devices, ["android", "ios"]);
  assert.deepEqual(f.coverage.missing, [{ device: "android", text_size: null, locale: "fr", screen: "home" }]);
  const m = f.results.find((e) => e.path === null);
  assert.deepEqual([m.device, m.platform, m.findings[0].expected_path], ["android", "android", "android/fr/home"]);
  assert.equal(run(["results", "validate", "dev.json"]).code, 0);
  // --device over one device's folder, then a merge of both devices into one schema-2 file.
  const a = run(["read", "dev/ios", "--device", "ios", "--expect-locales", "de,fr", "--results", "ios.json"]);
  assert.equal(a.code, 0, a.stderr);
  const b = run(["read", "dev/android", "--device", "android", "--expect-locales", "de,fr", "--results", "android.json"]);
  assert.equal(b.code, 1, b.stderr);
  assert.deepEqual(readJSON("android.json").results.find((e) => e.path === null).findings[0].expected_path, "android/fr/home");
  const mm = run(["results", "merge", "ios.json", "android.json", "--expect-devices", "ios,android", "--out", "both.json"]);
  assert.equal(mm.code, 1, mm.stderr);
  assert.deepEqual(readJSON("both.json").coverage.missing, [{ device: "android", text_size: null, locale: "fr", screen: "home" }]);
  // A file naming an axis this version does not know is refused (D16).
  const later = { ...readJSON("both.json"), axes: ["device", "orientation"] };
  fs.writeFileSync(path.join(work, "later.json"), JSON.stringify(later));
  const u = run(["results", "merge", "later.json", "ios.json", "--out", "x.json"]);
  assert.equal(u.code, 2);
  assert.match(u.stderr, /results-axis-unknown: later\.json uses the axis orientation/);
  assert.equal(run(["results", "validate", "later.json"]).code, 1);
  const ur = run(["report", "later.json", "--out", "later.html"]);
  assert.equal(ur.code, 2);
  assert.match(ur.stderr, /results-axis-unknown: later\.json uses the axis orientation/);
  const ub = run(["read", "dev/ios", "--device", "ios", "--baseline", "later.json"]);
  assert.equal(ub.code, 2);
  assert.match(ub.stderr, /results-axis-unknown: .*later\.json uses the axis orientation/);
  // An invalid label is a usage error.
  assert.equal(run(["read", "dev/ios", "--device", "iOS SE"]).code, 2);
});

test("TODO-076: a {device}/{text_size}/{screen}.{locale} tree; a run before the axis merges as default; one report", () => {
  put("ts/ios/large/home.de.png", "03-de-phone.png");
  const r = run(["read", "ts", "--layout", "{device}/{text_size}/{screen}.{locale}", "--expect-text-sizes", "default,large", "--results", "ts-large.json", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json.filter((e) => e.path).map((e) => [e.device, e.text_size, e.locale, e.screen]), [["ios", "large", "de", "home"]]);
  const f = readJSON("ts-large.json");
  assert.deepEqual([f.results_schema, f.axes, f.coverage.expected_text_sizes], [2, ["device", "text_size"], ["default", "large"]]);
  assert.deepEqual(f.coverage.missing, [{ device: "ios", text_size: "default", locale: "de", screen: "home" }]);
  assert.equal(f.results.find((e) => e.path === null).findings[0].expected_path, "ios/default/home.de");
  // --text-size over a plain folder; a run with no size is the default cell (D6), so the merge has nothing missing.
  const big = run(["read", "dev/ios", "--device", "ios", "--text-size", "large", "--expect-locales", "de", "--results", "ios-large.json"]);
  assert.equal(big.code, 0, big.stderr);
  const plain = run(["read", "dev/ios", "--device", "ios", "--expect-locales", "de", "--results", "ios-plain.json"]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(readJSON("ios-plain.json").results_schema, 2, "the device axis only");
  const mm = run(["results", "merge", "ios-plain.json", "ios-large.json", "--out", "ios-both.json"]);
  assert.equal(mm.code, 0, mm.stderr);
  const both = readJSON("ios-both.json");
  assert.deepEqual([both.axes, both.coverage.expected_text_sizes, both.coverage.missing], [["device", "text_size"], ["default", "large"], []]);
  assert.equal(run(["results", "validate", "ios-both.json"]).code, 0);
  const rep = run(["report", "ios-both.json", "--expect-text-sizes", "default,large", "--out", "ios-both.html"]);
  assert.equal(rep.code, 0, rep.stderr);
  // A size folder that differs from --text-size warns and --text-size wins; a bad label is exit 2.
  const mis = run(["read", "ts", "--layout", "{device}/{text_size}/{screen}.{locale}", "--text-size", "default", "--json"]);
  assert.deepEqual(mis.json.map((e) => [e.text_size, e.warnings.map((w) => w.code)]), [["default", ["text-size-path-mismatch"]]]);
  const bad = run(["read", "ts", "--text-size", "x y"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /invalid-text-size/);
});

test("every command writes a file that validates", () => {
  const video = path.join(ROOT, ".build/video");
  const src = path.join(__dirname, "fixtures/video.swift");
  if (!fs.existsSync(video) || fs.statSync(video).mtimeMs < fs.statSync(src).mtimeMs) execFileSync("swiftc", ["-O", src, "-o", video]);
  const vdir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-results-video-"));
  execFileSync(video, [path.join(__dirname, "fixtures/videos.json"), vdir], { encoding: "utf8" });
  const mp4 = fs.readdirSync(vdir).find((n) => n.endsWith(".mp4"));
  for (const argv of [
    ["check", "shots", "--present", "Weiter"],
    ["read", "shots"],
    ["truncated", "shots"],
    ["untranslated", "shots/de", "--locale", "de"],
    ["video", path.join(vdir, mp4), "--present", "x"],
  ]) {
    const r = run([...argv, "--results", `${argv[0]}.json`]);
    assert.ok([0, 1].includes(r.code), `${argv[0]}: ${r.stderr}`);
    const v = run(["results", "validate", `${argv[0]}.json`, "--json"]);
    assert.deepEqual(v.json, [{ file: `${argv[0]}.json`, valid: true, errors: [] }], argv[0]);
  }
  // A path outside the working directory is written as abs: with no absolute path in the file.
  const text = fs.readFileSync(path.join(work, "video.json"), "utf8");
  assert.ok(!text.includes(os.tmpdir()) && !text.includes(os.homedir()), "no absolute path in the file");
  assert.equal(JSON.parse(text).results[0].path, `abs:${mp4}`);
});

test("determinism: two runs differ only in run, ms and host", () => {
  run(["check", "shots", "--present", "Weiter", "--expect-locales", "de,fr", "--results", "a.json"]);
  run(["check", "shots", "--present", "Weiter", "--expect-locales", "de,fr", "--results", "b.json"]);
  const [a, b] = [readJSON("a.json"), readJSON("b.json")];
  assert.deepEqual(normalize(a), normalize(b));
});

test("a write failure is exit 4 with results-write-failed; stdout still has every result", () => {
  const r = run(["check", "shots", "--present", "Weiter", "--results", "no/such/dir/out.json", "--json"]);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /catscan: results-write-failed: cannot write the results file no\/such\/dir\/out\.json: ENOENT - try: /);
  assert.equal(r.json.length, 3);
});

test("results merge: shards per locale, expectations at merge time, any input order", () => {
  // shots/de as an argument maps nothing ({locale}/{screen} is below the argument), so each shard gets a tree.
  fs.mkdirSync(path.join(work, "frtree/fr"), { recursive: true });
  fs.copyFileSync(path.join(work, "shots/fr/home.png"), path.join(work, "frtree/fr/home.png"));
  fs.mkdirSync(path.join(work, "detree/de"), { recursive: true });
  fs.copyFileSync(path.join(work, "shots/de/home.png"), path.join(work, "detree/de/home.png"));
  fs.copyFileSync(path.join(work, "shots/de/paywall.png"), path.join(work, "detree/de/paywall.png"));
  assert.equal(run(["check", "detree", "--present", "Weiter", "--results", "de.json"]).code, 0);
  assert.equal(run(["check", "frtree", "--present", "Weiter", "--results", "fr.json"]).code, 1);
  const m1 = run(["results", "merge", "de.json", "fr.json", "--expect-locales", "de,fr,ja", "--out", "m1.json"]);
  const m2 = run(["results", "merge", "fr.json", "de.json", "--expect-locales", "de,fr,ja", "--out", "m2.json"]);
  assert.equal(m1.code, 1, m1.stderr);
  assert.equal(m2.code, 1);
  const [a, b] = [readJSON("m1.json"), readJSON("m2.json")];
  a.run.argv = b.run.argv = null;
  assert.deepEqual(a, b);
  assert.deepEqual(a.coverage.missing, [{ device: null, text_size: null, locale: "fr", screen: "paywall" }, { device: null, text_size: null, locale: "ja", screen: "home" }, { device: null, text_size: null, locale: "ja", screen: "paywall" }]);
  assert.equal(a.run.shards.length, 2);
  assert.equal(run(["results", "validate", "m1.json"]).code, 0);
  // An invalid shard is exit 4; a missing file is exit 4; a broken file is exit 1 for validate.
  fs.writeFileSync(path.join(work, "broken.json"), "{");
  assert.equal(run(["results", "merge", "de.json", "broken.json", "--out", "x.json"]).code, 4);
  assert.equal(run(["results", "merge", "de.json", "gone.json", "--out", "x.json"]).code, 4);
  const v = run(["results", "validate", "broken.json"]);
  assert.equal(v.code, 1);
  assert.match(v.stderr, /^catscan: results-invalid: broken\.json#\/: not JSON: /m);
  assert.equal(run(["results", "validate", "gone.json"]).code, 4);
  const err = (argv, code, re) => { const r = run(argv); assert.equal(r.code, code, r.stderr); assert.match(r.stderr, re); };
  err(["results", "merge", "de.json", "--layout", "none", "--out", "x.json"], 2, /invalid-layout/);
  err(["results", "merge", "de.json", "m1.json", "--out", "m1.json"], 2, /results-duplicate-shard: --out m1\.json is also an input/);
  err(["results", "merge", "de.json", "--out", "no/such/dir/m.json"], 4, /results-write-failed/);
});

test("privacy: an absolute argument inside the working folder is recorded relative, with no absolute path or user name", () => {
  const r = run(["truncated", path.join(work, "shots"), "--expect-locales", "de,ja", "--results", "abs.json"]);
  assert.ok([0, 1].includes(r.code), r.stderr);
  const text = fs.readFileSync(path.join(work, "abs.json"), "utf8");
  for (const s of [work, fs.realpathSync(work), os.homedir(), os.userInfo().username]) assert.ok(!text.includes(s), `the file contains ${s}`);
  // The argument names the working folder absolutely (through /var -> /private/var on a Mac): still relative.
  assert.deepEqual(JSON.parse(text).results.filter((e) => e.path).map((e) => e.path), ["shots/de/home.png", "shots/de/paywall.png", "shots/fr/home.png"]);
});

test("TODO-087: --layout {screen}-{locale} maps a locale token at the end of the file name; a missing cell keeps that name", () => {
  put("names/home-de.png", "03-de-phone.png");
  put("names/home-pt-BR.png", "04-fr-tablet.png");
  const r = run(["read", "names", "--layout", "{screen}-{locale}", "--expect-locales", "de,fr,pt-BR", "--results", "names.json", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json.filter((e) => e.path).map((e) => [e.path, e.locale, e.screen]), [["names/home-de.png", "de", "home"], ["names/home-pt-BR.png", "pt-BR", "home"]]);
  const f = readJSON("names.json");
  assert.equal(f.coverage.layout, "{screen}-{locale}");
  assert.equal(f.results.find((e) => e.path === null).findings[0].expected_path, "home-fr");
  assert.equal(run(["results", "validate", "names.json"]).code, 0);
  // Under the default layout the same names are unmapped, and the warning names the pattern that fits.
  const d = run(["read", "names", "--expect-locales", "de", "--json"]);
  assert.match(JSON.stringify(d.json), /try: --layout '\{screen\}-\{locale\}'/);
});
