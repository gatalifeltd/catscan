// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-038 T2: the comparison over literal text records, approval and validation. No binary needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const baseline = require("../src/baseline");
const results = require("../src/results");
const { UsageError } = require("../src/args");

const HOST = { chip: "Apple M5", arch: "arm64", host_class: "physical", macos: "27.2.1 (26B131)", vision_revision: 3 };
const rec = (words, extra = {}) => {
  const tokens = [...words].sort();
  return { algo: 1, tokens, lines: [words.join(" ")].filter(Boolean), digest: baseline.tokensDigest(tokens), ignore: null, ...extra };
};
const env = (p, locale, screen, words, extra = {}) => ({
  schema: 1, catscan: "0.24.0", command: "check", path: p, verdict: "pass", engine: "vision-accurate-rev3", locale,
  image: { width: 10, height: 20 }, screen, host: HOST, ms: 5, checks: [], findings: [], warnings: [],
  text: words === null ? null : rec(words), change: null, ...extra,
});
const file = (entries, extra = {}) => {
  const f = results.build({ results: entries, coverage: null, argv: ["check", "s"], started: new Date(0), finished: new Date(0), build: { id: "4511", version: null }, host: HOST, ci: null });
  return Object.assign(f, extra);
};
const approved = (entries) => { const f = file(entries); f.approved = { at: "2026-11-01T00:00:00Z", from: baseline.fileDigest(f) }; return f; };
const cmp = (cur, base, o = {}) => baseline.compare(cur, base, { file: "base.json", ...o });
const cell = (r, screen, locale) => r.block.cells.find((c) => c.screen === screen && (!locale || c.locale === locale));
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof UsageError && e.code === code && typeof e.hint === "string" && e.hint.length > 0);

test("compare: equal digests are unchanged and skippable; one replaced word is changed with its diff", () => {
  // Value: protects=D1 equality and the diff field; fails_when=a word edit reads unchanged or equal text needs review; why_new=new; seam=none; no_claim=Vision jitter (gate)
  const base = approved([env("s/de/home.png", "de", "home", ["start", "game"]), env("s/de/pay.png", "de", "pay", ["buy", "now"])]);
  const cur = file([env("s/de/home.png", "de", "home", ["game", "start"]), env("s/de/pay.png", "de", "pay", ["buy", "later"])]);
  const r = cmp(cur, base);
  assert.deepEqual([cell(r, "home").state, cell(r, "home").review, cell(r, "home").reason], ["unchanged", false, null]);
  assert.deepEqual([cell(r, "pay").state, cell(r, "pay").review, cell(r, "pay").reason], ["changed", true, "changed"]);
  assert.deepEqual(cell(r, "pay").diff, { added: ["buy later"], removed: ["buy now"], added_count: 1, removed_count: 1 });
  assert.deepEqual(cur.results.map((e) => e.change), ["unchanged", "changed"]);
  assert.deepEqual(r.block.review, { cells: 1, skip: 1, denominator: 2, excluded: { missing: 0, unmapped: 0 } });
  assert.equal(r.block.build, "4511");
  assert.match(baseline.summaryLine(r.block), /^baseline 4511: 1 of 2 cells text unchanged and passing \(50%\), 1 to review \(1 changed, 0 new, 0 failing or unread\); 0 gone$/);
  assert.deepEqual(results.check(cur), []);
});

test("compare: minor_diff on equal tokens, digest mode has no diff", () => {
  // Value: protects=D2 (minor_diff shown, still skippable) and digest mode; fails_when=a line-only difference needs review or a digest record crashes the diff; why_new=new; seam=none; no_claim=none
  const base = approved([env("s/de/a.png", "de", "a", null, { text: { ...rec(["x", "y"]), lines: ["x y!"] } })]);
  const cur = file([env("s/de/a.png", "de", "a", null, { text: { ...rec(["x", "y"]), lines: ["x", "y"] } })]);
  const r = cmp(cur, base);
  assert.deepEqual([cell(r, "a").state, cell(r, "a").review], ["unchanged", false]);
  assert.equal(cell(r, "a").minor_diff.added_count, 2);
  const d = (w) => ({ algo: 1, digest: rec(w).digest, ignore: null });
  const r2 = cmp(file([env("s/de/a.png", "de", "a", null, { text: d(["q"]) })]), approved([env("s/de/a.png", "de", "a", null, { text: d(["p"]) })]));
  assert.deepEqual([cell(r2, "a").state, cell(r2, "a").diff], ["changed", null]);
});

test("compare: zero tokens, a failed read or a non-pass verdict always needs review", () => {
  // Value: protects=D4 doubtful cells; fails_when=an empty read, text null or a failing verdict is skippable; why_new=new; seam=none; no_claim=none
  const base = approved([env("s/de/a.png", "de", "a", []), env("s/de/b.png", "de", "b", ["x"]), env("s/de/c.png", "de", "c", ["y"])]);
  const cur = file([env("s/de/a.png", "de", "a", []), env("s/de/b.png", "de", "b", null, { verdict: "error", error: { code: "x", message: "x" } }), env("s/de/c.png", "de", "c", ["y"], { verdict: "fail" })]);
  const r = cmp(cur, base);
  assert.deepEqual([cell(r, "a").state, cell(r, "a").reason], ["unchanged", "no-text"]);
  assert.deepEqual([cell(r, "b").state, cell(r, "b").reason], ["ambiguous", "failing"]);
  assert.deepEqual([cell(r, "c").state, cell(r, "c").reason], ["unchanged", "failing"]);
  assert.equal(r.block.review.skip, 0);
  assert.deepEqual(cur.results.map((e) => e.change), ["unchanged", null, "unchanged"]);
  assert.match(baseline.summaryLine(r.block), /3 failing or unread/);
  // D6 (review fix): an unsupported check still has a text record; approved with --allow-incomplete it stays in review.
  const uns = approved([env("s/de/u.png", "de", "u", ["x"], { verdict: "unsupported", error: { code: "check-script-unsupported", message: "x" } })]);
  const u = cmp(file([env("s/de/u.png", "de", "u", ["x"])]), uns);
  assert.deepEqual([cell(u, "u").state, cell(u, "u").review, cell(u, "u").reason], ["unchanged", true, "baseline-incomplete"]);
});

test("compare: duplicate cells pair by layout-relative identity; unpaired is ambiguous", () => {
  // Value: protects=D7 pairing (never the abs: rewrite); fails_when=two inputs pair by order or abs: paths break identity; why_new=new; seam=none; no_claim=none
  const base = approved([env("abs:shots/de/home.png", "de", "home", ["a"]), env("abs:shots/de/home.jpg", "de", "home", ["b"])]);
  const cur = file([env("run2/de/home.jpg", "de", "home", ["b"]), env("run2/de/home.png", "de", "home", ["a"])]);
  assert.deepEqual([cell(cmp(cur, base), "home").state, cell(cmp(cur, base), "home").review], ["unchanged", false]);
  // D4, D6 (review fix): a duplicate-cell warning on either side keeps the paired cell in review.
  const w = { warnings: [{ code: "duplicate-cell", message: "2 inputs" }] };
  const dupCur = file([env("run2/de/home.jpg", "de", "home", ["b"], w), env("run2/de/home.png", "de", "home", ["a"], w)]);
  assert.deepEqual([cell(cmp(dupCur, base), "home").state, cell(cmp(dupCur, base), "home").reason], ["unchanged", "ambiguous"]);
  const lone = file([env("run2/de/home.png", "de", "home", ["a"]), env("run2/de/home.webp", "de", "home", ["b"])]);
  const r = cmp(lone, base);
  assert.deepEqual([cell(r, "home").state, cell(r, "home").reason], ["ambiguous", "ambiguous"]);
  assert.equal(cell(r, "home").inputs.length, 4);
  // One input on each side compares them whatever their names.
  assert.equal(cell(cmp(file([env("x/de/home.jpg", "de", "home", ["a"])]), approved([env("y/de/home.png", "de", "home", ["a"])])), "home").state, "unchanged");
});

test("compare: new, gone and rename hints; renamed cells still need review", () => {
  // Value: protects=new/gone and D9; fails_when=a rename becomes skippable or a non-unique digest gets a hint; why_new=new; seam=none; no_claim=none
  const base = approved([env("s/de/a.png", "de", "a", ["keep"]), env("s/de/old.png", "de", "old", ["moved", "text"]), env("s/de/x.png", "de", "x", ["dup"]), env("s/de/y.png", "de", "y", ["dup"])]);
  const cur = file([env("s/de/a.png", "de", "a", ["keep"]), env("s/de/new.png", "de", "new", ["moved", "text"]), env("s/de/z.png", "de", "z", ["dup"])]);
  const r = cmp(cur, base);
  assert.deepEqual([cell(r, "new").state, cell(r, "new").review, cell(r, "new").renamed_from], ["new", true, "old"]);
  assert.equal(cell(r, "z").renamed_from, null, "the digest is not unique among gone cells");
  assert.deepEqual(r.block.counts, { changed: 0, unchanged: 1, new: 2, gone: 3, ambiguous: 0 });
  assert.deepEqual([cell(r, "old").state, cell(r, "old").review], ["gone", false]);
  assert.deepEqual(r.block.review, { cells: 2, skip: 1, denominator: 3, excluded: { missing: 0, unmapped: 0 } });
});

test("compare: locale aliases and case collapse to one key; a canonical collision is exit 2", () => {
  // Value: protects=D8; fails_when=zh-TW and zh-Hant cells do not match, or two baseline spellings silently merge; why_new=new; seam=canonFrom over a literal languages table; no_claim=the real table
  const canon = baseline.canonFrom({ languages: [{ locale: "zh-Hant", aliases: ["zh-TW"] }, { locale: "de", aliases: [] }] });
  const r = cmp(file([env("s/zh-TW/a.png", "zh-TW", "a", ["x"]), env("s/DE/b.png", "DE", "b", ["y"])]), approved([env("s/zh-Hant/a.png", "zh-Hant", "a", ["x"]), env("s/de/b.png", "de", "b", ["y"])]), { canon });
  assert.deepEqual(r.block.counts.unchanged, 2);
  throwsCode(() => cmp(file([env("s/de/a.png", "de", "a", ["x"])]), approved([env("s/zh-Hant/a.png", "zh-Hant", "a", ["x"]), env("s/zh-TW/a.png", "zh-TW", "a", ["x"])]), { canon }), "baseline-locale-collision");
});

test("compare: no overlap, no text, algo mismatch are exit 2; a missing file warns and makes every cell new", () => {
  // Value: protects=the Interface usage errors and D15; fails_when=a wrong or old baseline is compared silently; why_new=new; seam=none; no_claim=none
  throwsCode(() => cmp(file([env("s/de/a.png", "de", "a", ["x"])]), approved([env("s/fr/b.png", "fr", "b", ["x"])])), "baseline-no-overlap");
  const old = approved([env("s/de/a.png", "de", "a", ["x"])]);
  delete old.results[0].text;
  throwsCode(() => cmp(file([env("s/de/a.png", "de", "a", ["x"])]), old), "baseline-no-text");
  throwsCode(() => cmp(file([env("s/de/a.png", "de", "a", ["x"])]), approved([env("s/de/a.png", "de", "a", null, { text: { ...rec(["x"]), algo: 2 } })])), "baseline-incompatible");
  const cur = file([env("s/de/a.png", "de", "a", ["x"])]);
  const r = cmp(cur, null);
  assert.deepEqual(r.warnings.map((w) => w.code), ["baseline-missing"]);
  assert.match(r.warnings[0].hint, /catscan results baseline/);
  assert.deepEqual([cell(r, "a").state, cell(r, "a").review, r.block.digest, r.block.review.skip], ["new", true, null, 0]);
  assert.deepEqual(results.check(cur), []);
});

test("compare: unapproved baseline, reader change, unmeasured engine and ignore change need review", () => {
  // Value: protects=D11, D23, D4 (engines) and the ignore digest; fails_when=any of these cells is skippable or its warning is missing; why_new=new; seam=none; no_claim=a real macOS upgrade
  const unapp = cmp(file([env("s/de/a.png", "de", "a", ["x"])]), file([env("s/de/a.png", "de", "a", ["x"])]));
  // D23 (review fix): a baseline edited after approval is unapproved, and validate says so.
  const signed = baseline.approve(file([env("s/de/a.png", "de", "a", ["x"])]), { file: "b.json" }).file;
  assert.equal(cell(cmp(file([env("s/de/a.png", "de", "a", ["x"])]), signed), "a").review, false);
  signed.results[0].ms = 99;
  const ed = cmp(file([env("s/de/a.png", "de", "a", ["x"])]), signed);
  assert.deepEqual([cell(ed, "a").reason, ed.warnings[0].message.includes("changed after it was approved")], ["baseline-unapproved", true]);
  assert.deepEqual(results.check(signed).map((e) => e.pointer), ["/approved/from"]);
  assert.deepEqual([cell(unapp, "a").reason, unapp.warnings.map((w) => w.code)], ["baseline-unapproved", ["baseline-unapproved"]]);
  const rev = cmp(file([env("s/de/a.png", "de", "a", ["x"], { host: { ...HOST, vision_revision: 4 } })]), approved([env("s/de/a.png", "de", "a", ["x"])]));
  assert.deepEqual([cell(rev, "a").reason, rev.warnings.map((w) => w.code)], ["reader-changed", ["reader-changed"]]);
  assert.match(rev.warnings[0].message, /Vision revision 3.*Vision revision 4/);
  const mac = cmp(file([env("s/de/a.png", "de", "a", ["x"], { host: { ...HOST, macos: "28.0 (27A1)" } })]), approved([env("s/de/a.png", "de", "a", ["x"])]));
  assert.equal(cell(mac, "a").reason, "reader-changed");
  const nohost = cmp(file([env("s/de/a.png", "de", "a", ["x"])]), approved([env("s/de/a.png", "de", "a", ["x"], { host: null })]));
  assert.equal(cell(nohost, "a").reason, "reader-changed", "a baseline without host never matches the reader");
  const tess = { engine: "tesseract-5.5.1" };
  const t = cmp(file([env("s/el/a.png", "el", "a", ["x"], tess)]), approved([env("s/el/a.png", "el", "a", ["x"], tess)]));
  assert.deepEqual([cell(t, "a").state, cell(t, "a").reason, t.warnings.length], ["unchanged", "engine-unmeasured", 0]);
  const ig = cmp(file([env("s/de/a.png", "de", "a", null, { text: rec(["x"], { ignore: "sha256:b" }) })]), approved([env("s/de/a.png", "de", "a", ["x"])]));
  assert.deepEqual([cell(ig, "a").reason, ig.warnings.map((w) => w.code), ig.block.ignore_digest], ["baseline-ignore-changed", ["baseline-ignore-changed"], "sha256:b"]);
});

test("compare: counts, review and excluded invariants with missing and unmapped entries", () => {
  // Value: protects=D10 skip-share denominator; fails_when=missing or unmapped inputs enter the denominator; why_new=new; seam=none; no_claim=none
  const cur = file([env("s/de/a.png", "de", "a", ["x"]), env("s/loose.png", "en", null, ["q"]), env("s/de/b.png", "de", "b", ["y"])]);
  cur.results.push({ ...results.coverage([], { locales: ["de"], screens: ["c"] }, "{locale}/{screen}", "check").missing[0], change: null });
  const base = approved([env("s/de/a.png", "de", "a", ["x"]), env("s/de/c.png", "de", "c", ["z"]), env("s/loose.png", "en", null, ["q"])]);
  const r = cmp(cur, base);
  assert.deepEqual(r.block.review, { cells: 1, skip: 1, denominator: 2, excluded: { missing: 1, unmapped: 1 } });
  assert.equal(r.block.counts.gone, 0, "a cell that is missing now is reported as missing, not gone");
  assert.equal(r.block.cells.find((c) => c.screen === null).state, "unchanged");
  assert.equal(cur.results.at(-1).change, null);
});

test("approve: refuses each incomplete state, accepts with --allow-incomplete, and writes approved", () => {
  // Value: protects=D5, D6 and the baseline-incomplete refusal; fails_when=an error, unsupported, missing, ambiguous or unread cell is approved silently; why_new=new; seam=none; no_claim=none
  const miss = { ...results.coverage([], { locales: ["de"], screens: ["m"] }, "{locale}/{screen}", "check").missing[0], change: null };
  const f = file([
    env("s/de/a.png", "de", "a", ["x"]),
    env("s/de/b.png", "de", "b", null, { verdict: "error", error: { code: "image-unreadable", message: "x" } }),
    env("s/de/c.png", "de", "c", null, { verdict: "unsupported", error: { code: "language-unsupported", message: "x" } }),
    env("s/de/d.png", "de", "d", ["y"], { warnings: [{ code: "duplicate-cell", message: "2 inputs" }] }),
    env("s/de/e.png", "de", "e", null),
    miss,
  ]);
  const out = baseline.approve(f, { file: "r.json" });
  assert.equal(out.file, undefined);
  assert.deepEqual(out.refusals.map((d) => d.message.split(": ")[1].split(" ")[0]), ["error", "unsupported", "ambiguous", "no", "missing"]);
  assert.ok(out.refusals.every((d) => d.code === "baseline-incomplete" && /--allow-incomplete/.test(d.hint)));
  const ok = baseline.approve(f, { file: "r.json", allowIncomplete: true, now: new Date("2026-11-12T10:00:00.123Z") });
  assert.deepEqual(ok.file.approved, { at: "2026-11-12T10:00:00Z", from: baseline.fileDigest(f) });
  assert.equal(baseline.fileDigest(ok.file), baseline.fileDigest(f), "approved is outside the digest");
  const old = file([env("s/de/a.png", "de", "a", ["x"])]);
  delete old.results[0].text;
  throwsCode(() => baseline.approve(old, { file: "r.json" }), "baseline-no-text");
  // The approved file is a valid results file (D5) and compares as approved.
  assert.deepEqual(results.check(baseline.approve(file([env("s/de/a.png", "de", "a", ["x"])]), { file: "r.json" }).file), []);
});

test("approve and compare: a needs-reader cell is incomplete like unsupported (TODO-065 T1)", () => {
  // Value: protects=D6 no approved baseline hides a cell nobody read; fails_when=needs-reader leaves the incomplete lists and becomes skippable; why_new=new verdict; seam=none; no_claim=CLI exit codes
  const nr = env("s/el/n.png", "el", "n", null, { verdict: "needs-reader", error: { code: "reader-missing", message: "x", hint: "brew install tesseract tesseract-lang" } });
  const out = baseline.approve(file([env("s/de/a.png", "de", "a", ["x"]), nr]), { file: "r.json" });
  assert.deepEqual(out.refusals.map((d) => [d.code, d.message.split(": ")[1].split(" ")[0]]), [["baseline-incomplete", "needs-reader"]]);
  const withText = env("s/el/n.png", "el", "n", ["x"], { verdict: "needs-reader", error: { code: "reader-missing", message: "x" } });
  const r = cmp(file([env("s/el/n.png", "el", "n", ["x"])]), approved([withText]));
  assert.deepEqual([cell(r, "n").review, cell(r, "n").reason], [true, "baseline-incomplete"]);
});

test("validate: inconsistent counts, review, change and a tampered digest are errors", () => {
  // Value: protects=results validate over the TODO-038 fields; fails_when=a hand-edited block or record validates; why_new=new; seam=results.check; no_claim=none
  const base = approved([env("s/de/a.png", "de", "a", ["x"]), env("s/de/b.png", "de", "b", ["y"])]);
  const cur = file([env("s/de/a.png", "de", "a", ["x"]), env("s/de/b.png", "de", "b", ["z"])]);
  cur.baseline = cmp(cur, base).block;
  assert.deepEqual(results.check(cur), []);
  const bad = JSON.parse(JSON.stringify(cur));
  bad.baseline.counts.changed = 0;
  bad.baseline.review.skip = 5;
  bad.results[0].change = "changed";
  bad.results[1].text.tokens = ["w"];
  bad.baseline.cells[1].review = false;
  const ptrs = results.check(bad).map((e) => e.pointer);
  for (const p of ["/baseline/counts/changed", "/baseline/review/skip", "/results/0/change", "/results/1/text/digest", "/baseline/cells/1"]) assert.ok(ptrs.includes(p), p);
  // Review fix: a skippable changed cell, or a skippable cell over a failing input, does not validate.
  const lie = JSON.parse(JSON.stringify(cur));
  Object.assign(lie.baseline.cells[1], { review: false, reason: null });
  lie.baseline.review = { ...lie.baseline.review, cells: 0, skip: 2 };
  assert.ok(results.check(lie).some((e) => e.pointer === "/baseline/cells/1" && /changed but skippable/.test(e.message)));
  const failing = JSON.parse(JSON.stringify(cur));
  failing.results[0].verdict = "fail";
  failing.totals = { ...failing.totals, pass: 1, fail: 1 };
  assert.ok(results.check(failing).some((e) => e.pointer === "/baseline/cells/0" && /not a passing/.test(e.message)));
  const stray = JSON.parse(JSON.stringify(file([env("s/de/a.png", "de", "a", ["x"])])));
  stray.results[0].change = "unchanged";
  assert.deepEqual(results.check(stray).map((e) => e.pointer), ["/results/0/change"]);
});

test("readIgnore: patterns, comments, digest and invalid patterns", () => {
  // Value: protects=--baseline-ignore parsing; fails_when=comments become patterns or a bad pattern reaches the core; why_new=new; seam=none; no_claim=ICU-only syntax
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-ignore-"));
  fs.writeFileSync(path.join(d, "i.txt"), "# install ids\nid [0-9a-f]+\n\n  # score\nscore \\d+\n");
  const r = baseline.readIgnore(path.join(d, "i.txt"));
  assert.deepEqual(r.patterns, ["id [0-9a-f]+", "score \\d+"]);
  assert.match(r.digest, /^sha256:[0-9a-f]{64}$/);
  fs.writeFileSync(path.join(d, "bad.txt"), "(\n");
  throwsCode(() => baseline.readIgnore(path.join(d, "bad.txt")), "baseline-ignore-invalid");
  throwsCode(() => baseline.readIgnore(path.join(d, "nope.txt")), "baseline-ignore-unreadable");
});

test("args: baseline flags and results baseline", () => {
  // Value: protects=the TODO-038 CLI grammar; fails_when=a flag reaches the wrong command or a bad value passes; why_new=new; seam=none; no_claim=none
  const args = require("../src/args");
  const p = (a) => args.parse(a);
  const code = (a) => { try { p(a); return null; } catch (e) { return e.code; } };
  assert.equal(p(["check", "s", "--present", "x", "--baseline", "b.json", "--text-record", "digest"]).textRecord, "digest");
  assert.equal(p(["results", "baseline", "r.json", "--out", "b.json", "--allow-incomplete"]).subcommand, "baseline");
  assert.equal(code(["check", "s", "--text-record", "some"]), "invalid-value");
  assert.equal(code(["check", "s", "--text-record", "none", "--baseline-ignore", "i.txt"]), "conflicting-options");
  assert.equal(code(["results", "baseline", "r.json"]), "missing-value");
  // TODO-065 D10: doctor takes the locale flags of check, nothing else of the expectation set.
  assert.equal(p(["doctor", "--expect-locales", "de,el"]).expectLocales, "de,el");
  assert.equal(code(["doctor", "--expect-locales-from", "locales"]), null);
  assert.ok(["option-not-valid", "unknown-option"].includes(code(["doctor", "--expect-screens", "s.txt"])));
  assert.equal(code(["doctor", "--expect-locales", "de", "--layout", "{locale}/{screen}"]), "option-not-valid");
  assert.equal(code(["results", "baseline", "r.json", "--out", "r.json"]), "conflicting-options");
  assert.equal(code(["results", "merge", "a.json", "--out", "m.json", "--allow-incomplete"]), "option-not-valid");
  assert.equal(code(["results", "validate", "a.json", "--baseline", "b.json"]), "option-not-valid");
  assert.equal(code(["report", "r.json", "--baseline-ignore", "i.txt"]), "option-not-valid");
  assert.equal(code(["check", "-", "--present", "x", "--baseline", "b.json"]), "option-not-valid");
  assert.equal(code(["check", "s", "--present", "x", "--baseline", "b.json", "--results", "B.json"]), "conflicting-options");
  assert.equal(code(["results", "merge", "a.json", "--baseline", "m.json", "--out", "m.json"]), "conflicting-options");
});

test("compare: the device is part of the cell key; relPath per prefixed layout; renames stay within a device (TODO-075)", () => {
  // Value: protects=TODO-075 D2, D5, D20 baseline key; fails_when=an iOS and an Android shot share a cell, or a no-device baseline silently matches; why_new=new; seam=none; no_claim=report
  const dev = (d, p, locale, screen, words, extra = {}) => env(p, locale, screen, words, { device: d, platform: results.platformOf(d), ...extra });
  const withLayout = (f, layout) => Object.assign(f, { coverage: { layout, expected_locales: [], expected_screens: [], expected_devices: null, received: 0, missing: [] } });
  const base = approved([dev("ios", "s/ios/de/home.png", "de", "home", ["start"]), dev("android", "s/android/de/home.png", "de", "home", ["start"])]);
  const cur = file([dev("ios", "s/ios/de/home.png", "de", "home", ["start"]), dev("android", "s/android/de/home.png", "de", "home", ["begin"])]);
  const r = cmp(cur, base);
  assert.deepEqual(r.block.cells.map((c) => [c.device, c.locale, c.screen, c.state]), [["android", "de", "home", "changed"], ["ios", "de", "home", "unchanged"]]);
  assert.deepEqual(results.check(cur), []);
  // A cell's device must be its inputs' device.
  const t = structuredClone(cur);
  t.baseline.cells[0].device = "ios";
  assert.ok(results.check(t).some((e) => e.pointer === "/baseline/cells/0/device"));
  // Duplicates inside one device cell pair by layout-relative path under a {device}/ layout.
  const two = (root, w) => withLayout(file([dev("ios", `${root}/ios/de/home.png`, "de", "home", w), dev("ios", `${root}/ios/de/home.png`, "de", "home", w, { command: "read" })]), "{device}/{locale}/{screen}");
  const b2 = two("a", ["x"]); b2.approved = { at: "2026-11-01T00:00:00Z", from: baseline.fileDigest(b2) };
  const p = cmp(two("other/root", ["x"]), b2);
  assert.deepEqual(p.block.cells.map((c) => [c.state, c.inputs.map((x) => x.baseline_path)]), [["unchanged", ["a/ios/de/home.png", "a/ios/de/home.png"]]]);
  // Rename hints stay inside one device and locale.
  const keep = () => dev("ios", "s/ios/de/home.png", "de", "home", ["other"]);
  const rb = approved([dev("ios", "s/ios/de/old.png", "de", "old", ["same"]), keep()]);
  const rc = cmp(file([dev("android", "s/android/de/new.png", "de", "new", ["same"]), keep()]), rb);
  assert.ok(rc.block.cells.every((c) => c.renamed_from === null));
  const rd = cmp(file([dev("ios", "s/ios/de/new.png", "de", "new", ["same"]), keep()]), rb);
  assert.equal(rd.block.cells.find((c) => c.state === "new").renamed_from, "old");
  // One job per device: the same relative path on two devices is two cells, in validate and in the report (review fix).
  const same = (d, words) => dev(d, "shots/de/home.png", "de", "home", words);
  const sc = cmp(file([same("ios", ["start"]), same("android", ["begin"])]), approved([same("ios", ["start"]), same("android", ["start"])]));
  const sf = file([same("ios", ["start"]), same("android", ["begin"])]);
  Object.assign(sf, { baseline: sc.block });
  sf.results = sf.results.map((e) => ({ ...e, change: sc.block.cells.find((c) => c.device === e.device).state }));
  assert.deepEqual(baseline.checkFile(sf), []);
  const html = require("../src/report").html(sf);
  const data = JSON.parse(html.match(/<script type="application\/json" id="catscan-data">([\s\S]*?)<\/script>/)[1]);
  const changeOf = (d) => sc.block.cells[data.items.find((x) => x.device === d).change].state;
  assert.deepEqual([changeOf("ios"), changeOf("android")], ["unchanged", "changed"]);
  // D5: a baseline without the axis against a run with it names the cause.
  assert.throws(() => cmp(file([dev("ios", "s/ios/de/home.png", "de", "home", ["x"])]), approved([env("s/de/home.png", "de", "home", ["x"])])),
    (e) => e.code === "baseline-no-overlap" && e.hint === "the baseline has no device axis; approve a baseline from a run with --device or a {device} layout");
});
