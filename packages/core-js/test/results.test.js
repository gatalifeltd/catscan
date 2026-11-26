// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// spec 27: layout, coverage, the results file, merge and validate. No binary needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const results = require("../src/results");
const args = require("../src/args");
const render = require("../src/render");
const { CatscanError } = require("../src/client");

const FIX = path.join(__dirname, "fixtures/results");
const KNOWN = results.knownLocales({ languages: [
  { locale: "en", aliases: [] }, { locale: "de", aliases: [] }, { locale: "fr", aliases: [] }, { locale: "ja", aliases: [] },
  { locale: "pt-BR", aliases: ["pt"] }, { locale: "zh-Hant", aliases: ["zh-TW"] },
] });
const HOST = { chip: "Apple M1 (Virtual)", arch: "arm64", host_class: "vm", macos: "15.6 (24G84)", vision_revision: 3 };
const env = (p, locale, screen, verdict = "pass", extra = {}) => ({
  schema: 1, catscan: "0.12.6", command: "check", path: p, verdict, engine: "vision-accurate-rev3", locale,
  image: { width: 10, height: 20 }, screen, host: HOST, ms: 5, checks: [], findings: [], warnings: [], ...extra,
});
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "catscan-results-"));

test("layout: each pattern maps matching paths and rejects the rest", () => {
  const m = (layout, rel) => results.mapPath(layout, rel, KNOWN);
  assert.deepEqual(m("{locale}/{screen}", "de/home.png"), { device: null, text_size: null, locale: "de", screen: "home" });
  assert.deepEqual(m("{locale}/{screen}", "de/onboarding/1.png"), { device: null, text_size: null, locale: "de", screen: "onboarding/1" });
  assert.deepEqual(m("{screen}.{locale}", "home.de.png"), { device: null, text_size: null, locale: "de", screen: "home" });
  assert.deepEqual(m("{screen}.{locale}", "onboarding/1.ja.png"), { device: null, text_size: null, locale: "ja", screen: "onboarding/1" });
  assert.deepEqual(m("{screen}/{locale}", "home/fr.png"), { device: null, text_size: null, locale: "fr", screen: "home" });
  assert.deepEqual(m("{screen}/{locale}", "a/b/fr.png"), { device: null, text_size: null, locale: "fr", screen: "a/b" });
  // Aliases and case resolve to the table's spelling.
  assert.deepEqual(m("{locale}/{screen}", "pt/home.png"), { device: null, text_size: null, locale: "pt", screen: "home" });
  assert.deepEqual(m("{locale}/{screen}", "zh-hant/home.png"), { device: null, text_size: null, locale: "zh-Hant", screen: "home" });
  // No match: a folder that is not a known locale, a file at the top, no screen, the wrong pattern, stdin.
  assert.equal(m("{locale}/{screen}", "ios/home.png"), null);
  assert.equal(m("{locale}/{screen}", "xx/home.png"), null);
  assert.equal(m("{locale}/{screen}", "home.png"), null);
  assert.equal(m("{screen}.{locale}", "home.png"), null);
  assert.equal(m("{screen}/{locale}", "de.png"), null);
  assert.equal(m("{locale}/{screen}", null), null);
  assert.equal(m("none", "de/home.png"), null);
  assert.equal(results.needsLocales("none", ["de/home.png"]), false);
  assert.equal(results.needsLocales("{locale}/{screen}", ["home.png", null]), false);
  assert.equal(results.needsLocales("{locale}/{screen}", ["de/home.png"]), true);
});

test("coverage: missing locale and screen, duplicates count twice, unmapped inputs, null without flags", () => {
  const entries = [env("s/de/home.png", "de", "home"), env("s/de/home.jpg", "de", "home"), env("s/fr/pay.png", "fr", "pay"), env("s/x.png", "en", null)];
  assert.deepEqual(results.coverage(entries, null, "{locale}/{screen}", "check"), { coverage: null, missing: [] });
  const r = results.coverage(entries, { locales: ["de", "fr", "ja"], screens: null }, "{screen}.{locale}", "check");
  assert.deepEqual(r.coverage, {
    layout: "{screen}.{locale}", expected_locales: ["de", "fr", "ja"], expected_screens: ["home", "pay"], expected_devices: null, expected_text_sizes: null, received: 3,
    missing: [{ device: null, text_size: null, locale: "de", screen: "pay" }, { device: null, text_size: null, locale: "fr", screen: "home" }, { device: null, text_size: null, locale: "ja", screen: "home" }, { device: null, text_size: null, locale: "ja", screen: "pay" }],
  });
  assert.equal(r.missing.length, 4);
  assert.deepEqual(r.missing[0], {
    schema: 1, catscan: r.missing[0].catscan, command: "check", path: null, verdict: "fail", engine: null, locale: "de", screen: "pay",
    device: null, platform: null, text_size: null, image: null, host: null, ms: 0, checks: [], findings: [{ kind: "missing", box: null, expected_path: "pay.de" }], warnings: [], text: null,
  });
  // Expected screens from the flag; locales from the mapped inputs.
  const s = results.coverage(entries, { locales: null, screens: ["home"] }, "{locale}/{screen}", "read");
  assert.deepEqual(s.coverage.expected_locales, ["de", "fr"]);
  assert.deepEqual(s.coverage.missing, [{ device: null, text_size: null, locale: "fr", screen: "home" }]);
  assert.equal(s.missing[0].command, "read");
  assert.equal(s.coverage.received, 2);
  // Locale codes compare case-insensitively: the received spelling wins.
  const c = results.coverage([env("s/pt-BR/home.png", "pt-BR", "home"), env("s/de/home.png", "de", "home"), env("s/DE/menu.png", "DE", "menu")], { locales: ["pt-br", "DE"], screens: ["home"] }, "{locale}/{screen}", "check");
  assert.deepEqual([c.coverage.missing, c.coverage.received], [[], 2]);
  assert.deepEqual(results.check(results.build({ results: [env("s/de/home.png", "de", "home")], coverage: c.coverage, argv: [], build: null, host: null, ci: null, started: new Date(), finished: new Date() })).map((e) => e.pointer), ["/coverage/received"]);
});

test("expectations: --expect-screens comments, --expect-locales syntax, catalogs of every format", () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, "screens.txt"), "# screens\nhome\n\npaywall  # the paywall\nhome\n");
  const e = results.expectations({ expectLocales: "ja,de", expectLocalesFrom: null, expectScreens: path.join(d, "screens.txt") });
  assert.deepEqual([e.locales, e.screens], [["de", "ja"], ["home", "paywall"]]);
  assert.equal(results.expectations({ expectLocales: null, expectLocalesFrom: null, expectScreens: null }), null);
  assert.throws(() => results.expectations({ expectLocales: "de,not_a_code", expectLocalesFrom: null, expectScreens: null }), { code: "invalid-locale" });
  assert.throws(() => results.expectations({ expectLocales: null, expectLocalesFrom: null, expectScreens: path.join(d, "none.txt") }), { code: "expect-screens-unreadable" });

  const c = path.join(d, "cat");
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(c, rel)), { recursive: true }); fs.writeFileSync(path.join(c, rel), text); };
  put("Localizable.xcstrings", JSON.stringify({ sourceLanguage: "en", strings: { a: { localizations: { de: { stringUnit: { state: "translated", value: "A" } }, it: {} } } } }));
  put("ios/fr.lproj/Localizable.strings", '"a" = "A";');
  put("ios/Base.lproj/Main.strings", '"a" = "A";');
  put("android/values/strings.xml", "<resources/>");
  put("android/values-pt-rBR/strings.xml", "<resources/>");
  put("android/values-b+zh+Hant/strings.xml", "<resources/>");
  put("android/values-night/colors.xml", "<resources/>");
  put("web/ja.json", "{}");
  put("web/ko/common.json", "{}");
  put("web/common/misc.json", "{}");
  // A stem shaped like a code that names no language takes the folder's locale (data/text/<locale>/ui.json).
  put("data/text/ru/ui.json", "{}");
  put("data/text/en/ui.json", "{}");
  put("data/text/es/app.json", "{}");
  put("data/text/it/UI.json", "{}");
  // A real code ICU does not name (nah, me-ME) keeps its stem outside a language folder; ui.json in a folder that
  // names no language is no locale either way.
  put("locales/nah.json", "{}");
  put("locales/me-ME.json", "{}");
  const r = results.localesFromCatalogs(c);
  assert.deepEqual(r.locales, ["de", "en", "es", "fr", "it", "ja", "ko", "me-ME", "nah", "pt-BR", "ru", "zh-Hant"]);
  assert.deepEqual(r.warnings.map((w) => w.code), ["catalog-locale-unknown"]);
  assert.match(r.warnings[0].message, /misc\.json/);
  assert.throws(() => results.localesFromCatalogs(path.join(d, "screens.txt")), { code: "expect-locales-from-not-found" });
  fs.mkdirSync(path.join(d, "empty"));
  assert.throws(() => results.localesFromCatalogs(path.join(d, "empty")), { code: "expect-locales-from-empty" });
});

test("locale discovery: Flutter .arb and gettext .po catalogs, and a reader for a committed tree (TODO-065 D3)", () => {
  // Value: protects=one discovery for --expect-locales-from, doctor and catscan-adopt; fails_when=an .arb or .po locale is missed, a pot or plain JSON is called a catalog, or the reader is bypassed; why_new=new catalog kinds; seam=read; no_claim=git itself
  const files = {
    "lib/l10n/app_en.arb": JSON.stringify({ "@@locale": "en", hello: "Hello" }),
    "lib/l10n/app_pt_BR.arb": JSON.stringify({ hello: "Ola" }),
    "lib/l10n/intl_messages.arb": "{}",
    "locale/el/LC_MESSAGES/django.po": 'msgid ""\nmsgstr ""\n',
    "po/hr.po": "",
    "po/messages.pot": "",
    "po/strings.po": 'msgid ""\nmsgstr ""\n"Language: is\\n"\n',
    "po/broken.po": 'msgid ""\n',
    "po/sr@latin.po": "",
    "i18n/de/web.po": 'msgid ""\nmsgstr ""\n"Language: de\\n"\n',
    "i18n/fr/app.po": "",
    "lib/l10n/app.arb": "{not json",
    "lib/l10n/intl_es.arb": "{not json",
    "src/ja.po": "",
    "ko/app.po": "",
    "de/fr.po": "",
    "Localizable.xcstrings": JSON.stringify({ sourceLanguage: "en", strings: { a: { localizations: { constructor: { stringUnit: { state: "translated", value: "x" } } } } } }),
  };
  const read = (f) => { if (!(f in files)) throw new Error("not in tree"); return files[f]; };
  const r = results.localesFromFiles(Object.keys(files).sort(), read);
  // src/ja.po, ko/app.po, i18n/fr/app.po: the 2-letter name or folder is the language; a "constructor" key is data.
  assert.deepEqual(r.locales, ["constructor", "de", "el", "en", "es", "fr", "hr", "is", "ja", "ko", "pt-BR", "sr-Latn"]);
  assert.deepEqual(r.sources.el, ["locale/el/LC_MESSAGES/django.po"]);
  assert.deepEqual(r.sources.de, ["i18n/de/web.po"], "the header wins over a 3-letter domain");
  // A template is no catalog; a 3-letter name with no locale inside, or two different 2-letter codes, is unknown.
  assert.deepEqual(r.warnings.map((w) => w.message.split(" ").at(-1)).sort(), ["de/fr.po", "lib/l10n/app.arb", "po/broken.po"]);
  assert.equal(results.catalogFileLocales("po/messages.pot", read), undefined, "a template has no locale");
  assert.equal(results.catalogFileLocales("lib/l10n/intl_messages.arb", read), undefined, "nor does the .arb template");
});

test("paths and argv: inside the working directory relative, outside as abs:", () => {
  const cwd = "/work/app";
  assert.equal(results.privatePath("shots/de/home.png", "shots", cwd), "shots/de/home.png");
  assert.equal(results.privatePath("/work/app/shots/de/home.png", "/work/app/shots", cwd), "shots/de/home.png");
  assert.equal(results.privatePath("/tmp/shots/de/home.png", "/tmp/shots", cwd), "abs:shots/de/home.png");
  assert.equal(results.privatePath("../other/de/home.png", "../other", cwd), "abs:other/de/home.png");
  assert.equal(results.privatePath("/tmp/one.png", "/tmp/one.png", cwd), "abs:one.png");
  assert.equal(results.privatePath("-", "-", cwd), "-");
  assert.deepEqual(results.privateArgv(["check", "/Users/me/shots", "--expect=/Users/me/c.yaml", "--expect", "../c.yaml", "rel/x", "shots/../../up/x.png",
    "--present", "/Settings", "--absent=../x", "--results", "/tmp/r.json"], cwd),
  ["check", "abs:shots", "--expect=abs:c.yaml", "--expect", "abs:c.yaml", "rel/x", "abs:x.png", "--present", "/Settings", "--absent=../x", "--results", "abs:r.json"]);
  assert.deepEqual(results.privateArgv(["results", "merge", "/tmp/a.json", "--out", "m.json"], cwd), ["results", "merge", "abs:a.json", "--out", "m.json"]);
  // Messages lose the absolute path too, in every form the input was named.
  const e = env("/Users/me/shots/de/home.png", "de", "home", "error", {
    error: { code: "input-not-found", message: "No such file: /Users/me/shots/de/home.png" },
    warnings: [{ code: "layout-mismatch", message: "/Users/me/shots/de/home.png does not match" }],
  });
  const p = results.privateEnvelope(e, "/Users/me/shots", [], cwd);
  assert.equal(p.path, "abs:shots/de/home.png");
  assert.ok(!JSON.stringify(p).includes("/Users/me"), JSON.stringify(p));
  assert.equal(p.error.message, "No such file: abs:shots/de/home.png");
  const rel = env("../app2/de/home.png", "de", "home", "pass", { warnings: [{ code: "x", message: "/work/app2/de/home.png and ../app2/de/home.png" }] });
  assert.equal(results.privateEnvelope(rel, "../app2", [], cwd).warnings[0].message, "abs:app2/de/home.png and abs:app2/de/home.png");
  assert.equal(results.privatePath("..foo/a.png", "..foo", cwd), "..foo/a.png");
  // Paths of options and catalog templates in messages: the run's other paths, the working folder, the home folder.
  const pairs = results.scrubPairs(["untranslated", "shots", "--catalog", "/Users/me/l10n/{locale}.json", "--boxes=/Users/me/b", "--present", "/Users/me/x"], cwd);
  const w = results.privateEnvelope(env("shots/de/home.png", "de", "home", "pass", { warnings: [
    { code: "catalog-missing", message: "no file /Users/me/l10n/de.json; boxes in /Users/me/b/home.boxes.json; /work/app/shots/de/home.png; " + os.homedir() + "/z" },
  ] }), "shots", pairs, cwd);
  assert.equal(w.warnings[0].message, "no file abs:l10n/de.json; boxes in abs:b/home.boxes.json; shots/de/home.png; ~/z");
  // Only at a path boundary, only in messages: recognized text and findings are data.
  const v = results.privateEnvelope(env("shots/a.png", "en", null, "fail", {
    findings: [{ kind: "truncated", box: [0, 0, 1, 1], line: "Settings... /Users/me/l10n", reason: "ellipsis", element: null, expected: null, confidence: 1 }],
    warnings: [{ code: "x", message: os.homedir() + "x/y and ../z" }],
  }), "shots", results.scrubPairs(["check", "..", "--catalog", "../{locale}.json", "--catalog", "/Users/me/l10n/{locale}.json"], cwd), cwd);
  assert.equal(v.findings[0].line, "Settings... /Users/me/l10n");
  const u = results.privateEnvelope(env("shots/a.png", "de", null, "fail", {
    findings: [{ kind: "untranslated", box: [0, 0, 1, 1], key: "k", catalog: "/Users/me/l10n/de.json", base: "Hi", expected: null, line: "Hi" }],
  }), "shots", results.scrubPairs(["untranslated", "shots", "--catalog", "/Users/me/l10n/{locale}.json"], cwd), cwd);
  assert.equal(u.findings[0].catalog, "abs:l10n/de.json");
  assert.equal(v.warnings[0].message, os.homedir() + "x/y and ../z");
});

test("run.ci: every provider row, first marker wins, null outside CI", () => {
  assert.equal(results.ciInfo({}), null);
  const rows = [
    [{ GITHUB_ACTIONS: "true", ImageOS: "macos15", GITHUB_SHA: "c", GITHUB_REF: "r", GITHUB_RUN_ID: "1" }, ["github-actions", "macos15"]],
    [{ GITLAB_CI: "true", CI_RUNNER_DESCRIPTION: "m1", CI_COMMIT_SHA: "c", CI_COMMIT_REF_NAME: "r", CI_PIPELINE_ID: "1" }, ["gitlab-ci", "m1"]],
    [{ CIRCLECI: "true", CIRCLE_SHA1: "c", CIRCLE_BRANCH: "r", CIRCLE_WORKFLOW_ID: "1" }, ["circleci", null]],
    [{ BITRISE_IO: "true", BITRISE_GIT_COMMIT: "c", BITRISE_GIT_BRANCH: "r", BITRISE_BUILD_SLUG: "1" }, ["bitrise", null]],
    [{ CM_BUILD_ID: "1", CM_COMMIT: "c", CM_BRANCH: "r" }, ["codemagic", null]],
    [{ TF_BUILD: "True", AGENT_NAME: "a", BUILD_SOURCEVERSION: "c", BUILD_SOURCEBRANCH: "r", BUILD_BUILDID: "1" }, ["azure-pipelines", "a"]],
    [{ BUILDKITE: "true", BUILDKITE_AGENT_NAME: "a", BUILDKITE_COMMIT: "c", BUILDKITE_BRANCH: "r", BUILDKITE_BUILD_ID: "1" }, ["buildkite", "a"]],
    [{ JENKINS_URL: "http://j", NODE_NAME: "a", GIT_COMMIT: "c", BRANCH_NAME: "r", BUILD_ID: "1" }, ["jenkins", "a"]],
  ];
  for (const [e, [provider, runner]] of rows) {
    assert.deepEqual(results.ciInfo(e), { provider, runner, commit: "c", ref: "r", run_id: "1" }, provider);
  }
  assert.equal(results.ciInfo({ JENKINS_URL: "x", GITHUB_ACTIONS: "true" }).provider, "github-actions");
  assert.deepEqual(results.ciInfo({ GITHUB_ACTIONS: "true" }), { provider: "github-actions", runner: null, commit: null, ref: null, run_id: null });
});

const runFile = (entries, extra = {}) => {
  const cov = results.coverage(entries, extra.exp ?? null, "{locale}/{screen}", "check");
  return results.build({
    results: [...entries, ...cov.missing], coverage: cov.coverage, argv: ["check", "shots"], build: extra.build ?? null, host: HOST, ci: null,
    started: new Date(extra.started ?? "2026-12-01T10:00:00.123Z"), finished: new Date(extra.finished ?? "2026-12-01T10:01:00Z"),
  });
};

test("file: sorted results, totals, timestamps, validates", () => {
  const f = runFile([env("shots/fr/home.png", "fr", "home", "fail"), env("shots/de/home.png", "de", "home"), env("shots/de/home.png", "de", "home", "pass", { command: "read", lines: [] })],
    { exp: { locales: ["de", "fr", "ja"], screens: null } });
  assert.deepEqual(f.results.map((r) => [r.path, r.command, r.locale]), [["shots/de/home.png", "check", "de"], ["shots/de/home.png", "read", "de"], ["shots/fr/home.png", "check", "fr"], [null, "check", "ja"]]);
  assert.deepEqual(f.totals, { pass: 2, fail: 2, "needs-reader": 0, unsupported: 0, error: 0 });
  assert.equal(f.run.started_at, "2026-12-01T10:00:00Z");
  assert.deepEqual(results.check(f), []);
  // The order never depends on the input order.
  const g = runFile([env("shots/de/home.png", "de", "home", "pass", { command: "read", lines: [] }), env("shots/de/home.png", "de", "home"), env("shots/fr/home.png", "fr", "home", "fail")],
    { exp: { locales: ["de", "fr", "ja"], screens: null } });
  assert.equal(JSON.stringify(g), JSON.stringify(f));
});

test("validate: one failing fixture per schema rule and per consistency rule", () => {
  const good = runFile([env("shots/de/home.png", "de", "home")], { exp: { locales: ["de", "ja"], screens: null } });
  assert.deepEqual(results.check(good), []);
  const bad = (mutate) => { const f = structuredClone(good); mutate(f); return results.check(f); };
  assert.ok(bad((f) => { delete f.run; }).some((e) => e.pointer === "/"));
  assert.ok(bad((f) => { f.results_schema = 3; }).some((e) => e.pointer === "/results_schema"));
  // TODO-075 D1, D16: schema 2 needs `axes`, an axis in use, and schema 1 has neither.
  assert.ok(bad((f) => { f.results_schema = 2; }).length);
  assert.deepEqual(bad((f) => { f.results_schema = 2; f.axes = ["device"]; }).map((e) => e.message), ["names device, but no entry or expectation uses it"]);
  assert.ok(bad((f) => { f.results_schema = 2; f.axes = []; }).some((e) => e.pointer === "/axes"));
  assert.ok(bad((f) => { f.axes = ["device"]; }).length, "schema 1 has no axes");
  assert.ok(bad((f) => { f.results[0].device = "ios"; }).some((e) => e.pointer === "/results_schema"));
  assert.ok(bad((f) => { f.run.started_at = "yesterday"; }).some((e) => e.pointer === "/run/started_at"));
  assert.ok(bad((f) => { f.results[0].verdict = "great"; }).some((e) => e.pointer === "/results/0/verdict"));
  assert.ok(bad((f) => { f.results[1].findings[0].expected_path = undefined; delete f.results[1].findings[0].expected_path; }).length);
  assert.deepEqual(bad((f) => { f.totals.pass = 5; }), [{ pointer: "/totals/pass", message: "is 5, but results[] has 1 pass" }]);
  assert.deepEqual(bad((f) => { f.coverage.missing = []; }).map((e) => e.pointer), ["/coverage/missing"]);
  assert.deepEqual(bad((f) => { f.coverage.received = 7; }).map((e) => e.pointer), ["/coverage/received"]);
  assert.deepEqual(bad((f) => { f.coverage = null; }).map((e) => e.pointer), ["/coverage"]);
  // A missing entry outside the expected cells, or for a cell another entry received.
  assert.ok(bad((f) => { f.results[1].locale = "ko"; f.coverage.missing[0].locale = "ko"; }).some((e) => e.pointer === "/results/1"));
  assert.ok(bad((f) => { f.results[1].locale = "de"; f.coverage.missing[0].locale = "de"; }).some((e) => /another entry received/.test(e.message)));
});

test("write: atomic, no temp file left, a failed write keeps the old file", () => {
  const d = tmpdir();
  const file = path.join(d, "r.json");
  results.write(file, { a: 1 });
  results.write(file, { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 2 });
  assert.deepEqual(fs.readdirSync(d), ["r.json"]);
  fs.chmodSync(d, 0o500);
  try {
    if (process.getuid && process.getuid() === 0) return; // root writes anyway
    assert.throws(() => results.write(file, { a: 3 }), (e) => e instanceof CatscanError && e.code === "results-write-failed");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 2 });
    assert.deepEqual(fs.readdirSync(d), ["r.json"]);
  } finally { fs.chmodSync(d, 0o700); }
  assert.throws(() => results.write(path.join(d, "no/such/dir.json"), {}), { code: "results-write-failed" });
});

const shard = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
// The catscan version changes every release; the golden holds a placeholder.
const stable = (f) => JSON.stringify(f, (k, v) => (k === "catscan" ? "X" : v), 2) + "\n";
const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

test("merge: shards with overlapping and disjoint locales equal the golden, in every input order", () => {
  const shards = ["shard-de-fr.json", "shard-fr-ja.json", "shard-ko.json"].map(shard);
  for (const s of shards) assert.deepEqual(results.check(s), [], "fixture shards are valid");
  const argv = ["results", "merge", "shard-*.json", "--expect-locales", "de,fr,ja,ko,zh-Hant", "--out", "merged.json"];
  const exp = { locales: ["de", "fr", "ja", "ko", "zh-Hant"], screens: null };
  const outs = permutations(shards).map((p) => stable(results.merge(p, { exp, layout: null, argv }).file));
  for (const o of outs) assert.equal(o, outs[0]);
  const golden = path.join(FIX, "merged.json");
  if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(golden, outs[0]);
  assert.equal(outs[0], fs.readFileSync(golden, "utf8"));
  const merged = JSON.parse(outs[0]);
  assert.deepEqual(results.check(merged), []);
  // fr/paywall is missing in shard-fr-ja but received in shard-de-fr, so it is not missing after merge.
  assert.ok(shard("shard-fr-ja.json").coverage.missing.some((c) => c.locale === "fr" && c.screen === "paywall"));
  assert.ok(!merged.coverage.missing.some((c) => c.locale === "fr" && c.screen === "paywall"));
  assert.ok(merged.coverage.missing.some((c) => c.locale === "zh-Hant"), "a shard that never ran is missing with merge-time flags");
  // fr/home arrived in two shards: both kept, both marked.
  const frHome = merged.results.filter((r) => r.locale === "fr" && r.screen === "home");
  assert.equal(frHome.length, 2);
  for (const r of frHome) assert.deepEqual(r.warnings.map((w) => w.code), ["duplicate-cell"]);
  assert.equal(merged.run.shards.length, 3);
  assert.equal(merged.run.started_at, "2026-12-01T10:00:00Z");
  assert.equal(merged.run.finished_at, "2026-12-01T10:09:00Z");
});

test("merge: duplicate-cell counts per command; a real duplicate still warns; a stale one is dropped (TODO-043)", () => {
  const shots = (command, extra = {}) => [env("s/de/home.png", "de", "home", "pass", { command, ...extra }), env("s/de/pay.png", "de", "pay", "pass", { command })];
  const exp = { locales: ["de"], screens: ["home", "pay"] };
  const stale = { code: "duplicate-cell", message: "2 inputs map to locale de, screen home", hint: "h" };
  // The same two screenshots under check and untranslated, one shard each; the check shard carries a stale warning.
  // An unmapped input (no screen) is in no cell and never a duplicate.
  const unmapped = env("s/de-home.png", "de", null, "pass", { command: "check" });
  const m = results.merge([runFile([...shots("check", { warnings: [stale] }), unmapped]), runFile(shots("untranslated"), { started: "2026-12-01T10:02:00Z", finished: "2026-12-01T10:03:00Z" })], { exp, layout: null, argv: [] }).file;
  assert.deepEqual(results.check(m), []);
  assert.equal(m.results.length, 5);
  assert.deepEqual(m.results.flatMap((r) => r.warnings), [], "check + untranslated over one cell is not a duplicate");
  assert.equal(m.coverage.received, 4, "received counts envelopes (spec 27 D17, D1)");
  // Two check screenshots for de/home stay a duplicate, named by command, even beside an untranslated result.
  const dup = results.merge([runFile([...shots("check"), env("t/de/home.png", "de", "home")]), runFile(shots("untranslated"), { started: "2026-12-01T10:02:00Z" })], { exp, layout: null, argv: [] }).file;
  const warned = dup.results.filter((r) => r.warnings.length);
  assert.deepEqual(warned.map((r) => [r.command, r.path]), [["check", "s/de/home.png"], ["check", "t/de/home.png"]]);
  for (const r of warned) assert.deepEqual(r.warnings, [results.DUPLICATE({ device: null, locale: "de", screen: "home" }, 2, "check")]);
  assert.equal(warned[0].warnings[0].message, "2 inputs map to locale de, screen home under check");
  // A single run has one command, so its message names none (D2).
  assert.equal(results.DUPLICATE({ device: null, locale: "de", screen: "home" }, 2).message, "2 inputs map to locale de, screen home");
  assert.equal(results.DUPLICATE({ device: "ios", locale: "de", screen: "home" }, 2).message, "2 inputs map to device ios, locale de, screen home");
});

test("merge: without flags the union of the shards' expectations; null coverage stays null", () => {
  const [a, b] = ["shard-de-fr.json", "shard-fr-ja.json"].map(shard);
  const m = results.merge([a, b], { exp: null, layout: null, argv: [] }).file;
  assert.deepEqual(m.coverage.expected_locales, ["de", "fr", "ja"]);
  assert.ok(!m.coverage.missing.some((c) => c.locale === "zh-Hant"), "a shard that never ran is not missing without merge-time flags");
  const k = shard("shard-ko.json");
  assert.equal(results.merge([k], { exp: null, layout: null, argv: [] }).file.coverage, null);
});

test("merge: unknown axis, build and layout mismatches exit 2; mixed versions warn", () => {
  const [a, b] = ["shard-de-fr.json", "shard-fr-ja.json"].map(shard);
  // TODO-075 D16: a later version's axis is refused, naming the version that wrote it.
  assert.throws(() => results.merge([a, { ...b, results_schema: 2, axes: ["device", "orientation"], run: { ...b.run, catscan: "1.4.0" } }], { exp: null, layout: null, argv: [] }),
    (e) => e instanceof args.UsageError && e.code === "results-axis-unknown" && /orientation/.test(e.message) && /catscan 1\.4\.0 or later/.test(e.hint));
  assert.throws(() => results.merge([a, { ...b, run: { ...b.run, build: null } }], { exp: null, layout: null, argv: [] }), { code: "results-build-mismatch" });
  assert.throws(() => results.merge([a, { ...b, coverage: { ...b.coverage, layout: "{screen}.{locale}" } }], { exp: null, layout: null, argv: [] }), { code: "results-layout-mismatch" });
  assert.equal(results.merge([a, { ...b, coverage: { ...b.coverage, layout: "{screen}.{locale}" } }], { exp: null, layout: "{locale}/{screen}", argv: [] }).file.coverage.layout, "{locale}/{screen}");
  const w = results.merge([a, { ...b, run: { ...b.run, catscan: "0.13.0" } }], { exp: null, layout: null, argv: [] }).warnings;
  assert.deepEqual(w.map((x) => x.code), ["mixed-versions"]);
  // The same shard twice, directly or inside a merged file, would count twice.
  assert.throws(() => results.merge([a, a], { exp: null, layout: null, argv: [] }), { code: "results-duplicate-shard" });
  assert.throws(() => results.merge([results.merge([a, b], { exp: null, layout: null, argv: [] }).file, a], { exp: null, layout: null, argv: [] }), { code: "results-duplicate-shard" });
  // Review fix: a merged file from before TODO-077 has records without thresholds and registry; its shard is still a duplicate.
  const old = results.merge([a, b], { exp: null, layout: null, argv: [] }).file;
  for (const r of old.run.shards) { delete r.thresholds; delete r.registry; }
  assert.throws(() => results.merge([old, a], { exp: null, layout: null, argv: [] }), { code: "results-duplicate-shard" });
  const ab = results.merge([a, b], { exp: null, layout: null, argv: [] }).file;
  assert.throws(() => results.merge([ab, results.merge([a, shard("shard-ko.json")], { exp: null, layout: null, argv: [] }).file], { exp: null, layout: null, argv: [] }), { code: "results-duplicate-shard" });
  // Two matrix jobs with the same run fields but different results are two shards, flat or staged.
  const twin = { ...a, results: a.results.map((e) => ({ ...e, ms: e.ms + 1 })) };
  assert.equal(results.merge([a, twin], { exp: null, layout: null, argv: [] }).file.run.shards.length, 2);
  assert.equal(results.merge([ab, twin], { exp: null, layout: null, argv: [] }).file.run.shards.length, 3);
  // A merged file merges again: its shards are flattened.
  const once = results.merge([a, b], { exp: null, layout: null, argv: [] }).file;
  assert.equal(results.merge([once, shard("shard-ko.json")], { exp: null, layout: null, argv: [] }).file.run.shards.length, 3);
});

test("args: results options, layouts and subcommands", () => {
  const o = args.parse(["check", "shots", "--present", "x", "--results", "r.json", "--build", "1", "--build-version", "2.0", "--layout", "{screen}.{locale}", "--expect-locales", "de", "--expect-screens", "s.txt"]);
  assert.deepEqual([o.results, o.build, o.buildVersion, o.layout, o.expectLocales, o.expectScreens], ["r.json", "1", "2.0", "{screen}.{locale}", "de", "s.txt"]);
  assert.throws(() => args.parse(["check", "s", "--present", "x", "--layout", "{lang}/{screen}"]), { code: "invalid-layout" });
  assert.throws(() => args.parse(["check", "s", "--present", "x", "--layout", "none", "--expect-locales", "de"]), { code: "conflicting-options" });
  assert.throws(() => args.parse(["doctor", "--results", "r.json"]), { code: "option-not-valid" });
  assert.throws(() => args.parse(["--results", "r.json", "languages"]), { code: "option-not-valid" });
  assert.throws(() => args.parse(["check", "s", "--present", "x", "--out", "o.json"]), { code: "option-not-valid" });
  assert.throws(() => args.parse(["check", "s", "--present", "x", "--results", "a", "--results", "b"]), { code: "repeated-option" });
  const v = args.parse(["results", "validate", "r.json", "--json"]);
  assert.deepEqual([v.subcommand, v.paths, v.format], ["validate", ["r.json"], "json"]);
  const m = args.parse(["results", "merge", "a.json", "b.json", "--out", "m.json", "--expect-locales", "de"]);
  assert.deepEqual([m.subcommand, m.paths, m.out], ["merge", ["a.json", "b.json"], "m.json"]);
  assert.throws(() => args.parse(["results", "merg", "a.json"]), (e) => e.code === "unknown-command" && /did you mean merge/.test(e.message));
  assert.throws(() => args.parse(["results"]), { code: "missing-command" });
  assert.throws(() => args.parse(["results", "merge", "a.json"]), { code: "missing-value" });
  assert.throws(() => args.parse(["results", "validate"]), { code: "missing-path" });
  assert.throws(() => args.parse(["results", "validate", "a.json", "b.json"]), { code: "missing-path" });
  assert.throws(() => args.parse(["results", "validate", "a.json", "--layout", "{locale}/{screen}"]), { code: "option-not-valid" });
  assert.throws(() => args.parse(["results", "merge", "a.json", "--out", "m.json", "--json"]), { code: "option-not-valid" });
  assert.throws(() => args.parse(["results", "merge", "a.json", "--out", "m.json", "--locale", "de"]), { code: "option-not-valid" });
});

test("render: a missing entry is one FAIL line with its expected path", () => {
  const [m] = results.coverage([], { locales: ["ja"], screens: ["paywall"] }, "{locale}/{screen}", "check").missing;
  assert.deepEqual(render.renderText(m), ["FAIL  missing: ja/paywall"]);
});

// ---- TODO-077: severity, certainty and thresholds in results files -------------------------------------------------

const scale = require("../src/scale");
const TH = (s, c) => ({ min_severity: s, min_certainty: c });
const boxesF = () => ({ kind: "overlap", signal: "boxes", box: [0.1, 0.1, 0.5, 0.1], line: "Kopf / Fuss", a: { text: "Kopf", box: [0.1, 0.1, 0.5, 0.05], confidence: 1 }, b: { text: "Fuss", box: [0.1, 0.12, 0.5, 0.05], confidence: 1 }, overlap: 0.4 }); // the OCR-only overlap reader, still experimental/low
const edgeF = () => ({ kind: "truncated", box: null, line: "Weit", reason: "edge", element: null, expected: null, confidence: 1 });
const scaledFile = (th, findings, extra = {}) => {
  const e = scale.annotate(env("shots/de/home.png", "de", "home", "fail", { command: "overlap", findings }), th);
  const f = results.build({ results: [e], coverage: null, argv: ["overlap", "shots"], started: new Date("2026-12-01T10:00:00Z"), finished: new Date("2026-12-01T10:01:00Z"), build: null, host: HOST, ci: null, thresholds: th, ...extra });
  return f;
};

test("results: new files carry the fields, run.thresholds and run.registry, and validate; old files still validate", () => {
  const f = scaledFile(TH("minor", "medium"), [boxesF(), edgeF()]);
  assert.deepEqual(f.run.thresholds, TH("minor", "medium"));
  assert.match(f.run.registry, /^[0-9a-f]{12}$/);
  assert.deepEqual(f.results[0].findings.map((x) => [x.severity, x.certainty, x.gate]), [["major", "low", false], ["major", "medium", true]]);
  assert.deepEqual(results.check(JSON.parse(JSON.stringify(f))), []);
  for (const s of ["shard-de-fr.json", "shard-fr-ja.json", "shard-ko.json"]) assert.deepEqual(results.check(shard(s)), [], `${s}: a pre-scale file`);
});

test("merge: threshold flags recompute gate, verdicts and totals; without them each shard's gate is kept", () => {
  const a = scaledFile(TH("minor", "low"), [boxesF()]);
  assert.equal(a.results[0].verdict, "fail");
  const kept = results.merge([a], { exp: null, layout: null, argv: [] });
  assert.equal(kept.file.results[0].verdict, "fail");
  assert.deepEqual(kept.file.run.thresholds, TH("minor", "low"));
  const re = results.merge([a], { exp: null, layout: null, argv: [], thresholds: TH("minor", "medium") });
  assert.equal(re.file.results[0].verdict, "pass");
  assert.equal(re.file.results[0].findings[0].gate, false);
  assert.deepEqual(re.file.totals, { pass: 1, fail: 0, "needs-reader": 0, unsupported: 0, error: 0 });
  assert.deepEqual(re.file.run.thresholds, TH("minor", "medium"));
  assert.deepEqual(re.warnings, []);
  assert.deepEqual(results.check(JSON.parse(JSON.stringify(re.file))), []);
  // Review fix: the records follow the applied flags, so a later merge of this file with a default shard sees a mixture,
  // and the shard inside it is still a duplicate of itself.
  assert.deepEqual(re.file.run.shards.map((r) => r.thresholds), [TH("minor", "medium")]);
  const b = scaledFile(TH("minor", "low"), [edgeF()], { started: new Date("2026-12-01T11:00:00Z") });
  b.results[0].path = "shots/fr/home.png";
  const outer = results.merge([re.file, b], { exp: null, layout: null, argv: [] });
  assert.deepEqual(outer.warnings.map((w) => w.code), ["mixed-thresholds"]);
  assert.deepEqual(results.check(JSON.parse(JSON.stringify(outer.file))), []);
  // A fresh copy: the merge above regated a's own objects in place, as the CLI never does with files it read.
  assert.throws(() => results.merge([re.file, scaledFile(TH("minor", "low"), [boxesF()])], { exp: null, layout: null, argv: [] }), { code: "results-duplicate-shard" });
});

test("merge: mixed thresholds and registries warn with null run values; a merge of merged files keeps per-shard values", () => {
  const a = scaledFile(TH("minor", "low"), [edgeF()]);
  const b = scaledFile(TH("minor", "medium"), [boxesF()], { started: new Date("2026-12-01T11:00:00Z") });
  b.results[0].path = "shots/fr/home.png";
  b.run.registry = "000000000000";
  const m = results.merge([a, b], { exp: null, layout: null, argv: [] });
  assert.deepEqual(m.warnings.map((w) => w.code), ["mixed-thresholds", "mixed-registry"]);
  assert.match(m.warnings[0].message, /--min-severity minor --min-certainty low; --min-severity minor --min-certainty medium/);
  assert.equal(m.file.run.thresholds, null);
  assert.equal(m.file.run.registry, null);
  assert.deepEqual(m.file.run.shards.map((s) => s.thresholds), [TH("minor", "low"), TH("minor", "medium")]);
  // validate checks each gate against a shard's thresholds when run.thresholds is null.
  assert.deepEqual(results.check(JSON.parse(JSON.stringify(m.file))), []);
  const again = results.merge([m.file], { exp: null, layout: null, argv: [] });
  assert.deepEqual(again.warnings.map((w) => w.code), ["mixed-thresholds", "mixed-registry"], "the mixture survives a second merge");
});

test("applyThresholds drops a stored baseline comparison, made under the old verdicts (review fix)", () => {
  const f = scaledFile(TH("minor", "medium"), [boxesF()]);
  assert.equal(f.results[0].verdict, "pass");
  f.baseline = { cells: [{ locale: "de", screen: "home", state: "unchanged", review: false }] };
  f.results[0].change = "unchanged";
  f.approved = { from: "x" };
  results.applyThresholds(f, TH("minor", "low"));
  assert.equal(f.results[0].verdict, "fail");
  assert.deepEqual([f.baseline, f.results[0].change, f.approved], [null, null, undefined]);
  assert.deepEqual(results.check(JSON.parse(JSON.stringify(f))), []);
});

test("merge: an item with no severity gates under any threshold and adds unscaled-items", () => {
  const old = shard("shard-de-fr.json");
  old.results[0].verdict = "fail";
  old.results[0].command = "truncated";
  old.results[0].findings = [edgeF()];
  const m = results.merge([old], { exp: null, layout: null, argv: [], thresholds: TH("critical", "high") });
  assert.equal(m.file.results.find((e) => e.findings.length && e.findings[0].kind === "truncated").verdict, "fail");
  const w = m.warnings.find((x) => x.code === "unscaled-items");
  assert.match(w.message, /^1 finding from an older catscan has no severity and still gates$/);
});

test("validate: a gate that disagrees with the thresholds, a failed check that does not gate, a fail with no gating item", () => {
  const f = JSON.parse(JSON.stringify(scaledFile(TH("minor", "medium"), [boxesF(), edgeF()])));
  f.results[0].findings[0].gate = true;
  assert.deepEqual(results.check(f).map((e) => e.pointer), ["/results/0/findings/0/gate"]);
  const g = JSON.parse(JSON.stringify(scaledFile(TH("minor", "medium"), [boxesF()])));
  g.results[0].verdict = "fail";
  g.totals = { pass: 0, fail: 1, "needs-reader": 0, unsupported: 0, error: 0 };
  assert.deepEqual(results.check(g).map((e) => e.pointer), ["/results/0/verdict"]);
  const c = scale.annotate(env("shots/de/a.png", "de", "a", "fail", { checks: [{ kind: "present", text: "x", verdict: "fail", box: null, line: null, confidence: null, closest: null }] }));
  c.checks[0].gate = false;
  const h = results.build({ results: [c], coverage: null, argv: [], started: new Date(0), finished: new Date(0), build: null, host: HOST, ci: null });
  assert.deepEqual(results.check(JSON.parse(JSON.stringify(h))).map((e) => e.pointer), ["/results/0/checks/0/gate"]);
  // Review fix: the converse, a pass that still holds a gating finding.
  const p = JSON.parse(JSON.stringify(scaledFile(TH("minor", "low"), [edgeF()])));
  assert.equal(p.results[0].findings[0].gate, true);
  p.results[0].verdict = "pass";
  p.totals = { pass: 1, fail: 0, "needs-reader": 0, unsupported: 0, error: 0 };
  assert.deepEqual(results.check(p).map((e) => e.pointer), ["/results/0/verdict"]);
});

test("layout: the hyphen patterns read a locale token at the start or end of the file name (TODO-087 D1, D2, D10)", () => {
  const m = (layout, rel) => results.mapPath(layout, rel, KNOWN);
  const at = (locale, screen, device = null) => ({ device, text_size: null, locale, screen });
  assert.deepEqual(m("{screen}-{locale}", "home-de.png"), at("de", "home"));
  // Two tokens win when they are a locale; one token is the fallback when they are not.
  assert.deepEqual(m("{screen}-{locale}", "home-pt-BR.png"), at("pt-BR", "home"));
  assert.deepEqual(m("{screen}-{locale}", "settings-panel-de.png"), at("de", "settings-panel"));
  assert.deepEqual(m("{locale}-{screen}", "ja-streak_1.png"), at("ja", "streak_1"));
  assert.deepEqual(m("{locale}-{screen}", "onboarding/zh-Hant-step-1.png"), at("zh-Hant", "onboarding/step-1"));
  assert.deepEqual(m("{device}/{screen}-{locale}", "ios/menu/home-fr.png"), at("fr", "menu/home", "ios"));
  // No known locale at that end, a name that is only a locale, a locale in the middle: unmapped.
  assert.equal(m("{screen}-{locale}", "home-xx.png"), null);
  assert.equal(m("{screen}-{locale}", "de.png"), null);
  assert.equal(m("{screen}-{locale}", "win-de-2.png"), null);
  assert.equal(m("{locale}-{screen}", "home-de.png"), null);
  assert.equal(results.needsLocales("{screen}-{locale}", ["home.png"]), false);
  assert.equal(results.needsLocales("{screen}-{locale}", ["home-de.png"]), true);
  // fillLayout round-trips each pattern into a missing cell's name.
  assert.equal(results.fillLayout("{screen}-{locale}", { locale: "de", screen: "home" }), "home-de");
  assert.equal(results.fillLayout("{device}/{locale}-{screen}", { device: "ios", locale: "de", screen: "home" }), "ios/de-home");
  // A nested screen keeps its folder in front, so the filled name maps back to the same cell.
  for (const [l, rel] of [["{locale}-{screen}", "onboarding/zh-Hant-step-1"], ["{screen}-{locale}", "auth/login-de"]]) {
    const cell = m(l, `${rel}.png`);
    assert.equal(results.fillLayout(l, cell), rel);
  }
  // A `$` pattern or a placeholder word in a screen name is written as is.
  assert.equal(results.fillLayout("{locale}/{screen}", { locale: "de", screen: "price$&x" }), "de/price$&x");
  assert.equal(results.fillLayout("{screen}/{locale}", { locale: "de", screen: "x{locale}" }), "x{locale}/de");
  // The layout-mismatch hint names the hyphen pattern that maps every unmapped input.
  assert.equal(results.suggestLayout("{locale}/{screen}", ["home-de.png", "menu-fr.png"], KNOWN), "{screen}-{locale}");
  assert.equal(results.suggestLayout("{locale}/{screen}", ["home-de.png", "x.png"], KNOWN), null);
  // A device folder stays a device; a layout with a device axis keeps it.
  assert.equal(results.suggestLayout("{locale}/{screen}", ["ios/home-de.png", "android/home-fr.png"], KNOWN), "{device}/{screen}-{locale}");
  assert.equal(results.suggestLayout("{device}/{locale}/{screen}", ["ios/home-de.png"], KNOWN), "{device}/{screen}-{locale}");
  assert.equal(results.suggestLayout("{device}/{text_size}/{locale}/{screen}", ["ios/large/home-de.png"], KNOWN), "{device}/{text_size}/{screen}-{locale}");
  // The CLI accepts both, with the axis prefixes, and a results file that uses one validates.
  for (const l of ["{locale}-{screen}", "{screen}-{locale}", "{device}/{text_size}/{screen}-{locale}"]) {
    assert.equal(args.parse(["check", "shots", "--layout", l, "--expect", "e.yaml"]).layout, l);
  }
  const cov = results.coverage([env("shots/home-de.png", "de", "home")], { locales: ["de"], screens: null }, "{device}/{screen}-{locale}", "check");
  const f = results.build({ results: [env("shots/home-de.png", "de", "home")], coverage: cov.coverage, argv: ["check", "shots"], build: null, host: HOST, ci: null,
    started: new Date("2026-12-01T10:00:00Z"), finished: new Date("2026-12-01T10:01:00Z") });
  assert.equal(f.coverage.layout, "{device}/{screen}-{locale}");
  assert.deepEqual(results.check(f), []);
});
