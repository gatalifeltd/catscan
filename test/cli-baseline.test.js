// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-038 PR 1: changed-only review through the CLI, real Vision on the synthetic fixtures.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { ROOT, setup, cli } = require("./helpers");

const synth = setup();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-baseline-"));
const put = (rel, file) => { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.copyFileSync(file, path.join(work, rel)); };
for (const dir of ["v1", "v2"]) {
  put(`${dir}/de/home.png`, path.join(synth, "03-de-phone.png"));
  put(`${dir}/fr/home.png`, path.join(synth, "04-fr-tablet.png"));
  put(`${dir}/en/start.png`, path.join(synth, "02-en-small.png"));
}
// v2/de/home.png: the same screen with one line edited, drawn by the fixture generator.
const manifest = require("./fixtures/synthetic.json");
const de = manifest.find((m) => m.name === "03-de-phone.png");
const edited = { ...de, name: "edited.png", lines: de.lines.map((l, i) => (i === 0 ? { ...l, text: "Jetzt kaufen" } : l)) };
const editDir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-edit-"));
fs.writeFileSync(path.join(editDir, "m.json"), JSON.stringify([edited]));
execFileSync(path.join(ROOT, ".build/synth"), [path.join(editDir, "m.json"), editDir]);
put("v3/de/home.png", path.join(editDir, "edited.png"));
put("v3/fr/home.png", path.join(synth, "04-fr-tablet.png"));
put("v3/en/start.png", path.join(synth, "02-en-small.png"));

const run = (argv) => cli(argv, { cwd: work });
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(work, f), "utf8"));
const CHECK = ["--present", "Weiter", "--present", "Paramètres", "--present", "GAME"];

test("baseline: run, approve, rerun gives all unchanged; an edited line gives exactly that cell changed", () => {
  // Value: protects=the three-command flow (D16) on real Vision and the line diff; fails_when=identical reads differ or an edit is missed; why_new=new; seam=none; no_claim=the gate sets (spike/changed_only_jitter.py --rule product)
  const first = run(["check", "v1", ...CHECK, "--results", "r1.json", "--build", "100"]);
  assert.equal(first.code, 1, first.stderr); // each image lacks the other locales' strings: exit codes stay as they were
  const f1 = readJSON("r1.json");
  assert.ok(f1.results.every((e) => e.text && e.text.algo === 1 && e.change === null), "every envelope carries a text record and change null");
  assert.equal(f1.baseline, null);
  // Unapproved: compared, nothing skippable, a warning that survives --quiet.
  const unapp = run(["check", "v2", ...CHECK, "--baseline", "r1.json", "--quiet"]);
  assert.match(unapp.stderr, /baseline-unapproved: .* - try: approve it first: catscan results baseline/);
  // Approval refuses nothing here, and writes `approved`.
  const ap = run(["results", "baseline", "r1.json", "--out", "base.json"]);
  assert.equal(ap.code, 0, ap.stderr);
  assert.match(readJSON("base.json").approved.from, /^sha256:[0-9a-f]{64}$/);
  const same = run(["check", "v2", ...CHECK, "--results", "r2.json", "--baseline", "base.json"]);
  assert.equal(same.code, first.code, "the exit code does not change");
  const b2 = readJSON("r2.json").baseline;
  assert.deepEqual(b2.counts, { changed: 0, unchanged: 3, new: 0, gone: 0, ambiguous: 0 });
  assert.equal(b2.build, "100");
  assert.match(same.stdout, /baseline 100: 0 of 3 cells text unchanged and passing \(0%\), 3 to review \(0 changed, 0 new, 3 failing or unread\); 0 gone/);
  const edit = run(["check", "v3", ...CHECK, "--results", "r3.json", "--baseline", "base.json", "--json"]);
  assert.equal(edit.code, first.code);
  const b3 = readJSON("r3.json").baseline;
  assert.deepEqual(b3.cells.filter((c) => c.state === "changed").map((c) => `${c.locale}/${c.screen}`), ["de/home"]);
  const c = b3.cells.find((x) => x.state === "changed");
  assert.deepEqual([c.diff.added, c.diff.removed], [["jetzt kaufen"], ["jetzt testen"]]);
  // D19: --json stdout envelopes carry change, and not the text record.
  assert.deepEqual(edit.json.map((e) => [e.path, e.change]).sort(), [["v3/de/home.png", "changed"], ["v3/en/start.png", "unchanged"], ["v3/fr/home.png", "unchanged"]]);
  assert.ok(edit.json.every((e) => e.text === undefined));
  assert.equal(run(["results", "validate", "r3.json"]).code, 0);
});

test("baseline: --format github adds the summary line and the cells to review to the job summary (T3)", () => {
  // Value: protects=TODO-038 T3 CLI wiring of the job summary; fails_when=a run with --baseline writes no review table or annotates a change; why_new=new surface; seam=GITHUB_STEP_SUMMARY; no_claim=GitHub's renderer
  const summary = path.join(work, "summary.md");
  fs.writeFileSync(summary, "");
  const r = cli(["check", "v3", ...CHECK, "--baseline", "base.json", "--format", "github"], { cwd: work, env: { GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.code, 1, r.stderr);
  const s = fs.readFileSync(summary, "utf8");
  assert.match(s, /\nbaseline 100&#58; 0 of 3 cells text unchanged and passing \(0%\), 3 to review \(1 changed, 0 new, 2 failing or unread\); 0 gone\n/);
  assert.match(s, /\| <code>de<\/code> \| <code>home<\/code> \| changed \| changed \| <code>\+ jetzt kaufen<\/code><br><code>- jetzt testen<\/code> \|/);
  // Annotations stay failures only: no line names a change.
  assert.doesNotMatch(r.stdout, /changed/);
});

test("baseline: a shard merge with --baseline equals the single run's comparison", () => {
  // Value: protects=T2 merge path; fails_when=merge drops change or recomputes cells differently; why_new=new; seam=none; no_claim=none
  run(["check", "v1", ...CHECK, "--results", "s1.json", "--build", "100"]);
  run(["results", "baseline", "s1.json", "--out", "sbase.json"]);
  const whole = run(["check", "v3", ...CHECK, "--results", "whole.json", "--baseline", "sbase.json", "--build", "101"]);
  // Two shards, each a folder of locale folders: identity is the layout-relative path, not the shard folder (D7).
  put("shA/de/home.png", path.join(work, "v3/de/home.png"));
  put("shB/fr/home.png", path.join(work, "v3/fr/home.png"));
  put("shB/en/start.png", path.join(work, "v3/en/start.png"));
  run(["check", "shA", ...CHECK, "--results", "sh-a.json", "--build", "101"]);
  run(["check", "shB", ...CHECK, "--results", "sh-b.json", "--build", "101"]);
  const m = run(["results", "merge", "sh-a.json", "sh-b.json", "--baseline", "sbase.json", "--out", "merged.json"]);
  assert.equal(m.code, whole.code, m.stderr);
  assert.match(m.stderr, /baseline 100: /);
  const strip = (b) => ({ ...b, file: null, cells: b.cells.map((c) => ({ ...c, inputs: c.inputs.map((i) => ({ ...i, path: i.path && i.path.replace(/^(v3|shA|shB)\//, "") })) })) });
  assert.deepEqual(strip(readJSON("merged.json").baseline), strip(readJSON("whole.json").baseline));
  assert.equal(run(["results", "validate", "merged.json"]).code, 0);
});

test("baseline: missing, older-format and wrong files; every diagnostic carries its hint", () => {
  // Value: protects=D15, D20, D24 and the Interface diagnostics through the CLI; fails_when=a wrong baseline is compared silently or a hint is missing; why_new=new; seam=none; no_claim=reader-changed on a real macOS upgrade
  const missing = run(["check", "v1", ...CHECK, "--results", "m.json", "--baseline", "nope.json", "--quiet"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /baseline-missing: .* - try: approve a reviewed run: catscan results baseline/);
  assert.deepEqual(readJSON("m.json").baseline.counts.new, 3);
  const old = readJSON("r1.json");
  for (const e of old.results) delete e.text;
  fs.writeFileSync(path.join(work, "old.json"), JSON.stringify(old));
  const o = run(["check", "v1", ...CHECK, "--baseline", "old.json"]);
  assert.equal(o.code, 2);
  assert.match(o.stderr, /baseline-no-text: .* - try: the baseline was written without text \(catscan < 0\.24\.0 or --text-record none\)/);
  assert.equal(run(["results", "baseline", "old.json", "--out", "x.json"]).code, 2);
  // Another project's file: no cell overlaps; the run's files are still written, without a baseline block.
  put("other/ja/x.png", path.join(synth, "10-ja-phone.png"));
  run(["check", "other", "--present", "x", "--results", "other.json"]);
  run(["results", "baseline", "other.json", "--out", "obase.json"]);
  const no = run(["check", "v1", ...CHECK, "--results", "no.json", "--baseline", "obase.json"]);
  assert.equal(no.code, 2);
  assert.match(no.stderr, /baseline-no-overlap: .* - try: no cell matches; check --layout/);
  assert.equal(readJSON("no.json").baseline, null);
  // An invalid file is exit 4, as merge treats inputs.
  fs.writeFileSync(path.join(work, "bad.json"), "{}");
  assert.equal(run(["check", "v1", ...CHECK, "--baseline", "bad.json"]).code, 4);
  // Approval refuses an incomplete run, one line per cell, unless --allow-incomplete.
  run(["check", "v1", ...CHECK, "--results", "inc.json", "--expect-locales", "de,fr,en,ja"]);
  const refuse = run(["results", "baseline", "inc.json", "--out", "ibase.json"]);
  assert.equal(refuse.code, 1);
  assert.match(refuse.stderr, /baseline-incomplete: ja\/home: missing: no screenshot - try: review and fix them, or --allow-incomplete/);
  assert.equal(run(["results", "baseline", "inc.json", "--out", "ibase.json", "--allow-incomplete"]).code, 0);
  // --text-record digest keeps no text; none omits the record and cannot be a baseline.
  run(["check", "v1", ...CHECK, "--results", "dig.json", "--text-record", "digest"]);
  assert.ok(readJSON("dig.json").results.every((e) => e.text.tokens === undefined && e.text.lines === undefined && /^sha256:/.test(e.text.digest)));
  run(["check", "v1", ...CHECK, "--results", "none.json", "--text-record", "none"]);
  assert.ok(readJSON("none.json").results.every((e) => e.text === undefined));
});
