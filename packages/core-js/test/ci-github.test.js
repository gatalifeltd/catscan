// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 15 D6, D7: GitHub workflow commands and the job summary.
const test = require("node:test");
const assert = require("node:assert/strict");
const ci = require("../src/ci");
const F = require("./fixtures/ci-envelopes");

test("github: message escapes %, CR, LF; properties also escape : and ,", () => {
  assert.equal(ci.escData("50% a:b,c\r\nd"), "50%25 a:b,c%0D%0Ad");
  assert.equal(ci.escProp("50% a:b,c\r\nd"), "50%25 a%3Ab%2Cc%0D%0Ad");
  const line = ci.workflowError({ file: "shots/a:b,c%.png", title: "t: x, y", message: "m: 1, 2" });
  assert.equal(line, "::error file=shots/a%3Ab%2Cc%25.png,title=t%3A x%2C y::m: 1, 2");
});

test("github: OCR text never starts a stdout line", () => {
  const texts = ["::add-mask::x", "x\n::error::y", "::stop-commands::t", "a\r::warning::b"];
  const envs = texts.map((t, i) => F.base({ command: "check", path: `shots/${i}\n::error::p.png`, verdict: "fail", checks: [F.absent(t, "fail")] }));
  // A raw line break reaches the message through an error text, which is not JSON-quoted like screen text.
  envs.push(F.base({ command: "read", path: "shots/e.png", verdict: "error", error: { code: "unreadable-image", message: "bad\n::add-mask::secret" } }));
  const lines = ci.githubLines(envs);
  assert.equal(lines.length, texts.length + 1);
  for (const l of lines) {
    assert.ok(l.startsWith("::error file="), l);
    assert.ok(!/[\r\n]/.test(l), l);
  }
  // TODO-077 D11: an error input ranks before every finding.
  assert.match(lines[2], /^::error file=shots\/1%0A%3A%3Aerror%3A%3Ap\.png,/);
  assert.match(lines[0], /::unreadable-image: bad%0A::add-mask::secret$/);
});

test("github: at most 10 annotations, then one line counting the rest", () => {
  const envs = Array.from({ length: 13 }, (_, i) => F.base({ command: "check", path: `shots/${i}.png`, verdict: "fail", checks: [F.present("Weiter", "fail")] }));
  envs.splice(3, 0, F.passCheck);
  const lines = ci.githubLines(envs, { more: "the job summary and r.json" });
  assert.equal(lines.length, 11);
  assert.deepEqual(lines.slice(0, 10).map((l) => l.match(/file=([^,]+)/)[1]), Array.from({ length: 10 }, (_, i) => `shots/${i}.png`));
  // An 11th ::error would be dropped by GitHub, so the count is a ::warning (review fix).
  assert.equal(lines[10], "::warning title=catscan%3A more failures::3 more failures not annotated (GitHub shows 10 per step); see the job summary and r.json");
  const partial = ci.githubLines([F.passCheck], { partial: true });
  assert.deepEqual(partial, ["::warning title=catscan%3A run incomplete::the run ended before every input had a result; these annotations and the job summary are partial"]);
  assert.equal(ci.githubLines(envs.slice(0, 11)).length, 10);
});

test("github: missing entries, errors and findings are annotated by their path", () => {
  const lines = ci.githubLines([F.missing("ja/paywall"), F.errorInput, F.truncatedFail, F.skippedCheck]);
  assert.equal(lines[1], "::error file=ja/paywall,title=catscan%3A missing screenshot::missing: ja/paywall (an expected screenshot never arrived)");
  assert.equal(lines[0], "::error file=shots/fr/broken.png,title=catscan check%3A error::unreadable-image: not an image");
  assert.match(lines[2], /^::error file=shots\/de\/home.png,title=catscan truncated%3A fail::truncated \(ellipsis\) "Weiter..." at .*%0Atruncated/);
  assert.equal(lines.length, 3);
});

test("github: the summary escapes Markdown, wraps text in <code>, lists only failures", () => {
  const env = F.base({ command: "check", path: "shots/a|b.png", verdict: "fail", checks: [F.absent("x", "fail", "[link](u) `c` <img> | & ")] });
  const s = ci.githubSummary([F.passCheck, env, F.missing("ja/home")], { command: "check" });
  assert.match(s, /^## catscan check\n\n1 pass, 2 fail, 0 needs-reader, 0 unsupported, 0 error\n/);
  assert.match(s, /\| FAIL \| - \| - \| <code>shots\/a&#124;b&#46;png<\/code> \| <code>absent "x"&#58; shown in "&#91;link&#93;\(u\) &#96;c&#96; &lt;img&gt; &#124; &amp; " at &#91;0&#46;1, 0&#46;2, 0&#46;3, 0&#46;4&#93;<\/code> \|/);
  // Emphasis and bare-URL autolinks in screen text do not render.
  assert.equal(ci.mdCell("*a* _b_ ~c~ https://x.test www.y.test a@b.test"), "&#42;a&#42; &#95;b&#95; &#126;c&#126; https&#58;//x&#46;test www&#46;y&#46;test a&#64;b&#46;test");
  assert.match(ci.githubSummary([F.passCheck], { command: "check", partial: true }), /\*\*The run ended before every input had a result: these counts are partial\.\*\*/);
  // An envelope with no path is named "-", never "null".
  assert.match(ci.githubLines([{ ...F.errorInput, path: null }])[0], /^::error file=-,/);
  assert.match(s, /\| MISSING \| - \| - \| <code>ja\/home<\/code> \|/);
  assert.ok(!s.includes("home.png"), "passing inputs get no row");
  assert.equal(ci.githubSummary([F.passCheck], { command: "read" }), "## catscan read\n\n1 pass, 0 fail, 0 needs-reader, 0 unsupported, 0 error\n\n");
});

test("github: the summary is cut at the limit with a closing note", () => {
  const envs = Array.from({ length: 50 }, (_, i) => F.base({ command: "check", path: `shots/${i}.png`, verdict: "fail", checks: [F.absent("y".repeat(1000), "fail")] }));
  const s = ci.githubSummary(envs, { command: "check", more: "r.json", limit: 20_000 });
  assert.ok(Buffer.byteLength(s) < 20_000 + 200);
  const rows = s.split("\n").filter((l) => l.startsWith("| FAIL"));
  assert.ok(rows.length > 0 && rows.length < 50);
  assert.match(s, new RegExp(`\\n${50 - rows.length} more failures not shown \\(the job summary is cut at 900 KB\\); see r\\.json\\.\\n$`));
  assert.equal(ci.SUMMARY_BYTES, 900 * 1024);
  // The default limit keeps a 1 MiB budget: 2000 rows of 1 KB are cut below it.
  const big = Array.from({ length: 2000 }, (_, i) => F.base({ command: "check", path: `s/${i}.png`, verdict: "fail", checks: [F.absent("z".repeat(600), "fail")] }));
  const sb = ci.githubSummary(big, { command: "check" });
  assert.ok(Buffer.byteLength(sb) <= ci.SUMMARY_BYTES + 200);
  assert.match(sb, /more failures not shown/);
});

// TODO-038 T3: the job summary with a baseline block (read from `baseline.cells[]`, D7).
const blk = (cells) => ({
  file: "base.json", digest: "sha256:x", approved: "2026-11-01T00:00:00Z", build: "4511", started_at: null, catscan: "0.25.0", ignore_digest: null,
  cells, counts: { changed: cells.filter((c) => c.state === "changed").length, unchanged: cells.filter((c) => c.state === "unchanged").length, new: cells.filter((c) => c.state === "new").length, gone: 0, ambiguous: 0 },
  review: { cells: cells.filter((c) => c.review).length, skip: cells.filter((c) => !c.review).length, denominator: cells.length, excluded: { missing: 0, unmapped: 0 } },
});
const bcell = (screen, state, review, reason, diff = null) => ({ locale: "de", screen, state, review, reason, inputs: [], diff, minor_diff: null, renamed_from: null });

test("github: with a baseline the summary adds the summary line and the cells to review, escaped", () => {
  // Value: protects=TODO-038 T3 job summary; fails_when=the summary line or review table is missing, a skippable cell gets a row, or diff text renders as Markdown; why_new=new surface; seam=none; no_claim=GitHub's renderer
  const lines = Array.from({ length: 7 }, (_, i) => `l${i}`);
  const b = blk([bcell("home", "unchanged", false, null), bcell("pay|*x*", "changed", true, "changed", { added: ["[Kaufen](https://x.io)", ...lines], removed: ["Buy"], added_count: 8, removed_count: 1 }), bcell("new", "new", true, "new")]);
  const s = ci.githubSummary([F.passCheck], { command: "check", baseline: b });
  assert.match(s, /^## catscan check\n\n1 pass, 0 fail, 0 needs-reader, 0 unsupported, 0 error\n\nbaseline 4511&#58; 1 of 3 cells text unchanged and passing \(33%\), 2 to review/);
  assert.match(s, /### Cells to review\n\n\| Locale \| Screen \| State \| Why \| Lines \|\n/);
  const rows = s.split("\n").filter((l) => l.startsWith("| <code>de"));
  assert.equal(rows.length, 2, "skippable cells get no row");
  assert.match(rows[0], /^\| <code>de<\/code> \| <code>pay&#124;&#42;x&#42;<\/code> \| changed \| changed \| <code>\+ &#91;Kaufen&#93;\(https&#58;\/\/x&#46;io\)<\/code><br>/);
  assert.match(rows[0], /<code>\+ l3<\/code><br>3 more<br><code>- Buy<\/code> \|$/);
  assert.match(rows[1], /\| new \| new \|  \|$/);
  // Nothing to review: the summary line alone. No baseline: the summary as before.
  const clean = ci.githubSummary([F.passCheck], { command: "check", baseline: blk([bcell("home", "unchanged", false, null)]) });
  assert.doesNotMatch(clean, /Cells to review/);
  assert.match(clean, /1 of 1 cells text unchanged/);
  assert.equal(ci.githubSummary([F.passCheck], { command: "read", baseline: null }), "## catscan read\n\n1 pass, 0 fail, 0 needs-reader, 0 unsupported, 0 error\n\n");
});

test("github: the cells-to-review table is cut at the limit with a closing note", () => {
  // Value: protects=TODO-038 T3 cap (like the failure table); fails_when=a large run overflows GitHub's 1 MiB summary; why_new=new surface; seam=limit option; no_claim=none
  const cells = Array.from({ length: 60 }, (_, i) => bcell(`s${i}`, "changed", true, "changed", { added: ["y".repeat(400)], removed: [], added_count: 1, removed_count: 0 }));
  const s = ci.githubSummary([F.passCheck], { command: "check", more: "r.json", limit: 10_000, baseline: blk(cells) });
  assert.ok(Buffer.byteLength(s) < 10_000 + 200);
  const rows = s.split("\n").filter((l) => l.startsWith("| <code>de"));
  assert.ok(rows.length > 0 && rows.length < 60);
  assert.match(s, new RegExp(`\\n${60 - rows.length} more cells to review not shown \\(the job summary is cut at 900 KB\\); see r\\.json\\.\\n$`));
  // Value: protects=TODO-038 T3 shared 900 KB budget; fails_when=the review table is capped on its own budget or comes before the failures; why_new=only each table alone was capped; seam=limit option; no_claim=GitHub's renderer
  const fails = Array.from({ length: 50 }, (_, i) => F.base({ command: "check", path: `shots/${i}.png`, verdict: "fail", checks: [F.absent("y".repeat(1000), "fail")] }));
  const both = ci.githubSummary(fails.slice(0, 2), { command: "check", more: "r.json", limit: 10_000, baseline: blk(cells) });
  assert.ok(Buffer.byteLength(both) < 10_000 + 400);
  assert.ok(both.indexOf("| FAIL") > 0 && both.indexOf("| FAIL") < both.indexOf("### Cells to review"), "failures first");
  assert.ok(both.split("\n").filter((l) => l.startsWith("| <code>de")).length < rows.length, "the failures take budget from the review table");
  // Failures that fill the budget (less than one ~1 KB failure row left) leave only a note, never a heading with no table or a 2 KB review row past the limit.
  const wide = Array.from({ length: 60 }, (_, i) => bcell(`s${i}`, "changed", true, "changed", { added: ["w".repeat(2000)], removed: [], added_count: 1, removed_count: 0 }));
  const full = ci.githubSummary(fails, { command: "check", more: "r.json", limit: 10_000, baseline: blk(wide) });
  assert.ok(Buffer.byteLength(full) < 10_000 + 400);
  assert.match(full, /more failures not shown[^\n]*\n\n60 more cells to review not shown/);
});

test("needs-reader: JUnit, Code Quality, annotations and the summary fail it and carry the install hint (TODO-065 T1)", () => {
  // Value: protects=T1 CI output names the fix for a locale without its reader; fails_when=cases() stops mapping needs-reader to error or errorText drops the hint; why_new=new verdict; seam=none; no_claim=GitLab UI rendering
  const hint = "brew install tesseract tesseract-lang (about 650 MB), then rerun the same command";
  const nr = F.base({ command: "check", path: "shots/el/home.png", verdict: "needs-reader", locale: "el", engine: null, checks: [F.present("Συνέχεια", "needs-reader")],
    error: { code: "reader-missing", message: "catscan reads the locale el with Tesseract, which is not installed on this Mac.", hint } });
  const [c] = ci.cases(nr);
  assert.deepEqual([c.status, c.kind, c.ident], ["error", "needs-reader", "reader-missing"]);
  assert.ok(c.message.endsWith(` - try: ${hint}`), c.message);
  assert.match(ci.junit([F.passCheck, nr]), /<error type="needs-reader" message="reader-missing: catscan reads the locale el with Tesseract[^"]* - try: brew install tesseract tesseract-lang/);
  const cq = ci.codequality([nr]);
  assert.deepEqual(cq.map((e) => [e.check_name, e.severity]), [["catscan/needs-reader", "critical"]]);
  assert.match(cq[0].description, / - try: brew install/);
  assert.ok(ci.githubLines([nr]).some((l) => l.startsWith("::error file=shots/el/home.png") && l.includes("try: brew install")));
  assert.match(ci.githubSummary([F.passCheck, nr], { command: "check" }), /^## catscan check\n\n1 pass, 0 fail, 1 needs-reader, 0 unsupported, 0 error\n/);
  // Other errors keep their text: the hint is only added where it is the fix for the verdict.
  assert.equal(ci.cases(F.errorInput)[0].message, "unreadable-image: not an image");
});
