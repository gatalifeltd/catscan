// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 11: the README table written by bench:table (D1-D5, D12, D13). Node only, no binary.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const T = require("../languages/table");
const F = require("./table-fixture");

const rowsOf = (readme) => readme.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Metric") && !l.startsWith("| ---"));

test("README rows: per-engine aggregates from the referenced summary, with source, machine and timing mode (D3, D5)", () => {
  const root = F.fixture();
  const r = F.main([], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /README\.md: rewrote the generated block/);
  const rows = rowsOf(F.read(root, "README.md"));
  const v = rows.filter((l) => l.includes("Vision (3 locales)"));
  assert.equal(v.length, 5);
  // median of 99, 97, 98 = 98; lowest 97 (de); lowest fit 0.9 (ja); median CER 0.02; pooled 30/(30+2), 30/(30+10)
  assert.match(v[0], /\| Check accuracy, median \/ lowest \| Vision \(3 locales\) \| 98\.00% \/ 97\.00% \(de\) \| reproducible \| Apple M5, macOS 27\.2 \(26B123\), 2026-11-09 \|/);
  assert.match(v[1], /\| 0\.900 \(ja\) \|/);
  assert.match(v[2], /\| 0\.020 \|/);
  assert.match(v[3], /\| 0\.938 \/ 0\.750 \|/);
  assert.match(v[4], /\| Median ms per image \| .* \| 20 \(under load\) \|/);
  const t = rows.filter((l) => l.includes("Tesseract fallback (1 locale)"));
  assert.equal(t.length, 5);
  assert.match(t[0], /90\.00% \/ 90\.00% \(el\)/);
  assert.match(F.read(root, "README.md"), /Rerun \(full, about 1\.5 h on an M5\)/);
  assert.match(F.read(root, "README.md"), /docs\/BENCHMARKS\.md#languages\)/);
});

test("an idle record shows idle in the speed cell (D5)", () => {
  const root = F.fixture();
  F.writeRun(root, "27.2", F.SUMMARIES, "no simulator or emulator running; sequential check");
  F.main([], root);
  assert.match(F.read(root, "README.md"), /\| 20 \(idle\) \|/);
});

test("reference: rows come from the named folder, not the newest one (D2)", () => {
  const root = F.fixture();
  F.writeRun(root, "28.0", [F.sum("en", F.V, { check_accuracy: 50 })]);
  F.main([], root);
  const readme = F.read(root, "README.md");
  assert.match(readme, /bench\/results\/27\.2\//);
  assert.doesNotMatch(readme, /50\.00%/);
  // The Languages section still lists every recorded folder (spec 05 D9).
  assert.match(F.read(root, "docs/BENCHMARKS.md"), /### macOS 27\.2[\s\S]*### macOS 28\.0/);
});

test("reference: a missing folder exits 2 naming the file and the fix (D2, D12)", () => {
  const root = F.fixture({ reference: { languages: "26.9", power: null, llm: null } });
  const before = F.read(root, "README.md");
  const r = F.main([], root);
  assert.equal(r.code, 2);
  assert.match(r.err, /bench\/reference\.json names "26\.9".*npm run bench -- --record/);
  assert.equal(F.read(root, "README.md"), before);
});

test("study rows: Source study with link and date; a null part keeps its study row, a set one drops it (D4)", () => {
  const root = F.fixture();
  F.main([], root);
  const rows = rowsOf(F.read(root, "README.md"));
  assert.ok(rows.includes("| Energy per screenshot | Vision | 0.3 J | [study](docs/BENCHMARKS.md#energy) | Apple M5, study, 2026-10-30 |"), rows.join("\n"));
  assert.ok(rows.includes("| Real-screen recall | Vision | 98.5% | [study](docs/BENCHMARKS.md#real-screenshots) | Apple M5, study, 2026-10-29 |"));
  const lang = F.fixture({ reference: { languages: null, power: null, llm: null } });
  F.main([], lang);
  assert.equal(rowsOf(F.read(lang, "README.md")).filter((l) => l.includes("reproducible")).length, 0);
});

test("a part whose rows are not generated yet exits 2 instead of dropping its study row silently", () => {
  const root = F.fixture({ reference: { languages: "27.2", power: "27.2", llm: null } });
  const r = F.main([], root);
  assert.equal(r.code, 2);
  assert.match(r.err, /sets "power".*set it to null/);
});

test("study: an anchor that is not a heading in docs/BENCHMARKS.md exits 2 (D4, D12)", () => {
  const study = { measured_on: "x", rows: [{ metric: "M", engine: "E", value: "1", unit: "", date: "d", anchor: "nowhere" }] };
  const r = F.main(["--check"], F.fixture({ study }));
  assert.equal(r.code, 2);
  assert.match(r.err, /links to #nowhere, which is not a heading in docs\/BENCHMARKS\.md/);
});

test("rewrite: only the text between the README markers changes; a missing marker exits 2 naming the file", () => {
  const root = F.fixture();
  F.main([], root);
  const readme = F.read(root, "README.md");
  assert.ok(readme.startsWith(`# x\n\nintro\n\n${T.R_START}\n`));
  assert.ok(readme.endsWith(`${T.R_END}\n\n## After\n`));
  const again = F.main([], root);
  assert.match(again.out, /README\.md: unchanged/);
  assert.match(again.out, /docs\/BENCHMARKS\.md: unchanged/);
  const r = F.main([], F.fixture({ readme: "# no markers\n" }));
  assert.equal(r.code, 2);
  assert.match(r.err, /README\.md has no <!-- bench:start --> \.\.\. <!-- bench:end --> markers/);
  const d = F.main([], F.fixture({ doc: "# B\n\n## Study\n\n### Energy\n\n### Real screenshots\n" }));
  assert.equal(d.code, 2);
  assert.match(d.err, /docs\/BENCHMARKS\.md has no <!-- bench:languages:start -->/);
});

test("anchors follow GitHub: punctuation dropped, spaces to hyphens, repeats numbered", () => {
  const a = T.anchors("## Languages (spec 05)\n```\n## not a heading\n```\n### Beside an e2e suite\n## Energy\n## Energy\n");
  assert.deepEqual([...a], ["languages-spec-05", "beside-an-e2e-suite", "energy", "energy-1"]);
  assert.equal(T.median([3, 1, 2, null]), 2);
  assert.equal(T.median([1, 2, 3, 4]), 2.5);
});

test("the committed README and docs/BENCHMARKS.md match the committed results", () => {
  const r = F.main(["--check"], path.resolve(__dirname, "../.."));
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.resolve(__dirname, "../reference.json")));
});

// Value: protects=setup errors exit 2 naming the file and the fix (D12) for every input file; fails_when=a missing or
// corrupt reference.json/study.json or a missing README/BENCHMARKS.md crashes (exit 5) or writes; why_new=only the
// missing results folder and missing markers were covered; seam=none; no_claim=message wording beyond file and fix.
test("a missing or invalid input file exits 2 naming the file and the fix, and writes nothing (D12)", () => {
  for (const [rel, content, re] of [
    ["bench/reference.json", null, /bench\/reference\.json is missing; restore it from git/],
    ["bench/study.json", null, /bench\/study\.json is missing; restore it from git/],
    ["bench/reference.json", "{", /bench\/reference\.json is not valid JSON/],
    ["bench/study.json", "nope", /bench\/study\.json is not valid JSON/],
    ["README.md", null, /README\.md is missing; restore it from git/],
    ["docs/BENCHMARKS.md", null, /docs\/BENCHMARKS\.md is missing; restore it from git/],
  ]) {
    const root = F.fixture();
    const f = path.join(root, rel);
    if (content === null) fs.rmSync(f); else fs.writeFileSync(f, content);
    const others = ["README.md", "docs/BENCHMARKS.md"].filter((x) => x !== rel).map((x) => [x, F.read(root, x)]);
    for (const argv of [[], ["--check"]]) {
      const r = F.main(argv, root);
      assert.equal(r.code, 2, `${rel} ${argv}: ${r.err}`);
      assert.match(r.err, re);
      assert.match(r.err, argv.length ? /^bench:check: / : /^bench:table: /);
    }
    for (const [x, before] of others) assert.equal(F.read(root, x), before);
  }
});

// Value: protects=a study row whose part is reproducible is replaced by the referenced run (D4); fails_when=the
// `s.part && ref[s.part]` skip is dropped or inverted, so a stale study number sits next to the reproducible one;
// why_new=the existing D4 test only reaches the skip through "power", which exits 2 first; seam=none; no_claim=other parts.
test("study: a row of the languages part is dropped while languages is referenced and kept when it is null (D4)", () => {
  const study = { measured_on: "M", rows: [{ metric: "Study accuracy", engine: "Vision", value: "97", unit: "%", date: "d", anchor: "energy", part: "languages" }] };
  const on = F.fixture({ study });
  assert.equal(F.main([], on).code, 0);
  assert.doesNotMatch(F.read(on, "README.md"), /Study accuracy/);
  const off = F.fixture({ study, reference: { languages: null, power: null, llm: null } });
  assert.equal(F.main([], off).code, 0);
  assert.match(F.read(off, "README.md"), /\| Study accuracy \| Vision \| 97% \| \[study\]\(docs\/BENCHMARKS\.md#energy\) \| M, d \|/);
});

// Value: protects=an unexpected failure (not a user-fixable setup error) exits 5 with the command name and writes
// nothing; fails_when=main lets the exception escape or maps it to 0/1/2; why_new=no test reaches the `e.exit || 5`
// fallback; seam=none; no_claim=a friendly message for a corrupt meta.json.
test("a corrupt meta.json in the referenced folder exits 5 and writes nothing", () => {
  const root = F.fixture();
  fs.writeFileSync(path.join(root, "bench/results/27.2/meta.json"), "{");
  const before = F.read(root, "README.md");
  const r = F.main([], root);
  assert.equal(r.code, 5);
  assert.match(r.err, /^bench:table: /);
  assert.equal(F.read(root, "README.md"), before);
});

// Value: protects=bench:table rejects inputs that would publish wrong or empty rows (review fixes); fails_when=a schema,
// stamp, column or heading check is removed; why_new=earlier tests only cover missing files; seam=none; no_claim=none beyond protects
test("inputs that would publish wrong or empty rows exit 2 naming the fix", () => {
  const cases = [
    [{ reference: { languages: "27.2", power: null } }, /must name languages, power, llm/],
    [{ reference: { languages: 27.2, power: null, llm: null } }, /must name languages, power, llm/],
    [{ study: { measured_on: "x" } }, /needs a measured_on string and a rows array/],
    [{ study: { measured_on: "x", rows: [{ metric: "M", engine: "E", value: "1", date: "d" }] } }, /row "M" lacks anchor/],
    [{ study: { measured_on: "x", rows: [{ metric: "M", engine: "E", value: "1", date: "d", anchor: "energy", part: "powr" }] } }, /part "powr"/],
  ];
  for (const [x, re] of cases) {
    const r = F.main([], F.fixture(x));
    assert.equal(r.code, 2, JSON.stringify(x));
    assert.match(r.err, re);
  }
  const stale = F.fixture();
  const d = path.join(stale, "bench/results/27.2");
  fs.writeFileSync(path.join(d, "summary.csv"), T.summaryCsv({ ...F.tools, macos_build: "26A1" }, F.SUMMARIES));
  assert.match(F.main([], stale).err, /are from different runs; record the folder again/);
  const cols = F.fixture();
  const f = path.join(cols, "bench/results/27.2/summary.csv");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^locale,engine,/m, "engine,locale,"));
  assert.match(F.main([], cols).err, /has other columns than this catscan writes/);
});

// Value: protects=an unknown timing note is not published as idle, and an engine with no numeric value shows "-"; fails_when=
// timingMode defaults to idle again or readmeBlock dereferences a null lowest; why_new=no test had either input; seam=none; no_claim=none beyond protects
test("unknown timing is not called idle, and an engine without values shows - instead of crashing", () => {
  const root = F.fixture();
  F.writeRun(root, "27.2", F.SUMMARIES.map((s) => (s.engine === F.TS ? { ...s, fit_recall: null, check_accuracy: null } : s)), "");
  const r = F.main([], root);
  assert.equal(r.code, 0, r.err);
  const readme = F.read(root, "README.md");
  assert.match(readme, /\| 20 \(timing unknown\) \|/);
  assert.match(readme, /\| Fit recall, lowest \| Tesseract fallback \(1 locale\) \| - \|/);
  assert.match(readme, /\| Check accuracy, median \/ lowest \| Tesseract fallback \(1 locale\) \| - \/ - \|/);
  assert.equal(T.timingMode("no simulator or emulator running; x"), "idle");
});

test("corpus provenance: a folder drawn by two ICUs names each group; older records keep one line (TODO-037)", () => {
  assert.equal(T.corpusLine({ icu: "78.3", cldr: "48.0", seed: 5 }), "ICU 78.3, CLDR 48.0, seed 5");
  assert.equal(T.corpusLine({ seed: 5, groups: [{ icu: "79.1", cldr: "49.0", locales: ["hr"] }] }), "ICU 79.1, CLDR 49.0, seed 5");
  assert.equal(T.corpusLine({ seed: 5, groups: [{ icu: "78.3", cldr: "48.0", locales: ["sv", "da"] }, { icu: "79.1", cldr: "49.0", locales: ["hr"] }] }),
    "ICU 78.3, CLDR 48.0 (sv, da); ICU 79.1, CLDR 49.0 (hr); seed 5");
});

// TODO-042: a list reference merges folders per locale (D5), the coverage line (D2, D6), timing over runs (D4) and the
// corpus completeness check (D3).
const setDate = (root, folder, x) => {
  const f = path.join(root, "bench/results", folder, "meta.json");
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), ...x }));
};
const twoFolders = () => {
  const root = F.fixture({ reference: { languages: ["27.2", "27.2.1"], power: null, llm: null } });
  // de is recorded again (now 99%), hr is new on Tesseract below the gate.
  F.writeRun(root, "27.2.1", [F.sum("de", F.V, { check_accuracy: 99 }), F.sum("hr", F.TS, { check_accuracy: 97.5, median_ms: 90 })],
    "no simulator or emulator running; x");
  setDate(root, "27.2.1", { date: "2026-11-11" });
  return root;
};

// Value: protects=the README counts every locale of every listed folder once, the later record winning; fails_when=the merge
// keeps the first record, double-counts a locale or reads one folder; why_new=only string references were tested; seam=none; no_claim=none beyond protects
test("list reference: union per locale, later folder wins, both setups named (TODO-042 D5)", () => {
  const root = twoFolders();
  const r = F.main([], root);
  assert.equal(r.code, 0, r.err);
  const readme = F.read(root, "README.md");
  const v = rowsOf(readme).filter((l) => l.includes("Vision (3 locales)"));
  assert.equal(v.length, 5);
  // en 99, de 99 (re-record), ja 98: median 99, lowest 98 (ja); the old de 97 is gone.
  assert.match(v[0], /\| 99\.00% \/ 98\.00% \(ja\) \| reproducible \| Apple M5, macOS 27\.2 \(26B123\), 2026-11-09; Apple M5, macOS 27\.2 \(26B123\), 2026-11-11 \|/);
  assert.equal(rowsOf(readme).filter((l) => l.includes("Tesseract fallback (2 locales)")).length, 5);
  assert.match(readme, /`bench\/results\/27\.2\/` and `bench\/results\/27\.2\.1\/` \(the later folder's record per locale\)/);
  assert.match(readme, /\*\*Recorded twice, the later record counts:\*\* de \(`27\.2\.1` over `27\.2`\)\./);
});

// Value: protects=counts and partials quoted in README and BENCHMARKS come from the records; fails_when=the line drops a partial,
// misorders it, loses the engine, or the two blocks differ; why_new=no generated coverage line existed; seam=none; no_claim=none beyond protects
test("coverage line: codes by engine, partials ascending with engine and verdict, same text in both blocks (TODO-042 D2, D6)", () => {
  const root = twoFolders();
  F.main([], root);
  const readme = F.read(root, "README.md"), doc = F.read(root, "docs/BENCHMARKS.md");
  const cov = readme.split("\n").filter((l) => l.startsWith("**Coverage**") || l.startsWith("**Under the") || l.startsWith("**Recorded twice"));
  assert.equal(cov.length, 3);
  assert.equal(cov[0], "**Coverage** (generated): 5 locales recorded, every number measured on synthetic images drawn by Core Text, not on device screenshots. Vision (3): de, en, ja. Tesseract fallback (2): el, hr.");
  assert.equal(cov[1], "**Under the 98% gate:** el 90.00% (Tesseract, fail), hr 97.50% (Tesseract, fail). Every other locale measures at or above 98% check accuracy.");
  for (const l of cov) assert.ok(doc.includes(l), l);
  const none = F.fixture();
  F.writeRun(none, "27.2", F.SUMMARIES.map((s) => ({ ...s, check_accuracy: 99 })));
  F.main([], none);
  assert.match(F.read(none, "README.md"), /\*\*Under the 98% gate:\*\* none\./);
  assert.doesNotMatch(F.read(none, "README.md"), /Recorded twice/);
});

// Value: protects=a folder assembled from a loaded and an idle run is not published as idle; fails_when=timing reads only
// meta.timing (the last run's); why_new=27.2.1 had exactly this shape and the README called it idle; seam=none; no_claim=none beyond protects
test("timing: idle only when every run of every folder was idle (TODO-042 D4)", () => {
  const idle = "no simulator or emulator running; x", load = "under load: 0 simulator(s) booted, 1 emulator(s) running; x";
  assert.equal(T.foldTiming([{ timing: idle, runs: [{ timing: load }, { timing: idle }] }]), "under load");
  assert.equal(T.foldTiming([{ timing: idle, runs: [{ timing: idle }, {}] }]), "timing unknown");
  assert.equal(T.foldTiming([{ timing: idle, runs: [{ timing: idle }, { timing: idle }] }]), "idle");
  assert.equal(T.foldTiming([{ timing: idle }, { timing: "" }]), "timing unknown");
  const root = F.fixture();
  F.writeRun(root, "27.2", F.SUMMARIES, idle);
  setDate(root, "27.2", { runs: [{ locales: ["en"], timing: load }, { locales: ["de"], timing: idle }] });
  assert.equal(F.main([], root).code, 0);
  assert.match(F.read(root, "README.md"), /\| 20 \(under load\) \|/);
  assert.match(F.read(root, "docs/BENCHMARKS.md"), /- Timing: run 1, under load: .*; run 2, no simulator/);
});

// Value: protects=a corpus locale without a record fails the check instead of shrinking the table; fails_when=the completeness
// check is removed or reads the wrong list; why_new=19 locales were missing from the README with no failure; seam=main locales option; no_claim=none beyond protects
test("completeness: a corpus locale with no record in the reference folders exits 2 naming it and writes nothing (TODO-042 D3)", () => {
  const root = F.fixture();
  const before = F.read(root, "README.md");
  const r = F.main(["--check"], root, ["en", "de", "ja", "el", "hr", "mt"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /bench\/reference\.json "languages" \(27\.2\) has no record for hr, mt; record them with `npm run bench -- --record --lang hr,mt`/);
  assert.equal(F.main([], root, ["en", "hr"]).code, 2);
  assert.equal(F.read(root, "README.md"), before);
  // The real corpus list is the default.
  assert.deepEqual(T.main(["--check"], { root, log() {}, err() {} }), 2);
});

test("list reference: empty, non-string, repeated or missing folders exit 2 (TODO-042 D5)", () => {
  for (const languages of [[], [27.2], ["27.2", "27.2"]]) {
    const r = F.main([], F.fixture({ reference: { languages, power: null, llm: null } }));
    assert.equal(r.code, 2, JSON.stringify(languages));
    assert.match(r.err, /languages may be a list of distinct folder names/);
  }
  const r = F.main([], F.fixture({ reference: { languages: ["27.2", "28.0"], power: null, llm: null } }));
  assert.equal(r.code, 2);
  assert.match(r.err, /bench\/reference\.json names "28\.0" for languages/);
});

// Value: protects=each engine's measured-on cell and timing name only the folders its locales came from; fails_when=the `used`
// filter is dropped or foldTiming gets every folder; why_new=twoFolders spans both engines in both folders; seam=none; no_claim=none beyond protects
test("list reference: an engine names only its own folders and their timing (TODO-042 D4, D5)", () => {
  const root = F.fixture({ reference: { languages: ["27.2", "27.2.1"], power: null, llm: null } });
  F.writeRun(root, "27.2", F.SUMMARIES.filter((s) => s.engine === F.V));
  F.writeRun(root, "27.2.1", [F.sum("el", F.TS, { check_accuracy: 99 }), F.sum("hr", F.TS, { check_accuracy: 99 })], "no simulator or emulator running; x");
  setDate(root, "27.2.1", { date: "2026-11-11" });
  assert.equal(F.main([], root).code, 0);
  const rows = rowsOf(F.read(root, "README.md"));
  const v = rows.filter((l) => l.includes("Vision (3 locales)")), t = rows.filter((l) => l.includes("Tesseract fallback (2 locales)"));
  assert.ok(v.every((l) => /2026-11-09 \|$/.test(l) && !l.includes("2026-11-11")), v.join("\n"));
  assert.ok(t.every((l) => /2026-11-11 \|$/.test(l) && !l.includes("2026-11-09")), t.join("\n"));
  assert.match(v[4], /\(under load\)/);
  assert.match(t[4], /\(idle\)/);
});

// Value: protects=a partial is attributed to its engine, a locale without a value is listed first, and no records means no
// coverage claim; fails_when=ENGINE_SHORT inverts, the filter drops a null accuracy, or coverage(null) emits lines; why_new=only Tesseract
// partials with values were asserted; seam=none; no_claim=none beyond protects
test("coverage line: Vision partials, a missing value listed first, none without records (TODO-042 D2)", () => {
  const root = F.fixture();
  F.main([], root);
  assert.match(F.read(root, "README.md"), /\*\*Under the 98% gate:\*\* el 90\.00% \(Tesseract, fail\), de 97\.00% \(Vision, fail\)\./);
  const blank = F.fixture();
  F.writeRun(blank, "27.2", F.SUMMARIES.map((s) => (s.locale === "ja" ? { ...s, check_accuracy: null } : s)));
  F.main([], blank);
  assert.match(F.read(blank, "README.md"), /\*\*Under the 98% gate:\*\* ja - \(Vision, fail\), el 90\.00%/);
  const none = F.fixture({ reference: { languages: null, power: null, llm: null } });
  assert.equal(F.main([], none).code, 0);
  for (const f of ["README.md", "docs/BENCHMARKS.md"]) assert.doesNotMatch(F.read(none, f), /\*\*Coverage\*\*/);
});
