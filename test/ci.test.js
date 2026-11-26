// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 15 through the CLI with Vision: --format github, --junit, --gitlab-codequality and --results from one run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Ajv = require("ajv");
const { setup, cli } = require("./helpers");

const synth = setup();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-ci-"));
const put = (rel, name) => { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.copyFileSync(path.join(synth, name), path.join(work, rel)); };
put("shots/de/home.png", "03-de-phone.png");
put("shots/fr/home.png", "04-fr-tablet.png");
const run = (argv, opts = {}) => cli(argv, { cwd: work, ...opts });
const validateCq = new Ajv({ strict: false }).compile(require("./fixtures/ci/codequality.schema.json"));
const XSD = path.join(__dirname, "fixtures/ci/junit.xsd");
const ARGS = ["check", "shots", "--present", "Weiter", "--expect-locales", "de,fr,ja"];

test("one run writes JUnit, Code Quality and the results file; the missing locale is in each", () => {
  const summary = path.join(work, "summary.md");
  fs.writeFileSync(summary, "previous step\n");
  const r = run([...ARGS, "--format", "github", "--junit", "catscan.xml", "--gitlab-codequality", "cq.json", "--results", "r.json"], { env: { GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.code, 1, r.stderr);
  // stdout: only catscan-built lines, the annotations then the totals.
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.slice(0, -1).every((l) => l.startsWith("::error file=")), r.stdout);
  assert.match(lines.at(-1), /^3 images: 1 pass, 2 fail \(\d+\.\d s\)$/);
  // TODO-077: inputs in rank order, so the missing screenshot (critical/high) comes before the failed check (critical/medium).
  assert.deepEqual(lines.slice(0, -1).map((l) => l.match(/file=([^,]+)/)[1]), ["ja/home", "shots/fr/home.png"]);
  assert.ok(!r.stderr.includes("github-summary-skipped"));
  const md = fs.readFileSync(summary, "utf8");
  assert.match(md, /^previous step\n## catscan check\n\n1 pass, 2 fail/);
  assert.match(md, /\| MISSING \| critical \| high \| <code>ja\/home<\/code> \|/);

  const x = spawnSync("xmllint", ["--noout", "--schema", XSD, path.join(work, "catscan.xml")], { encoding: "utf8" });
  assert.equal(x.status, 0, x.stderr);
  const xml = fs.readFileSync(path.join(work, "catscan.xml"), "utf8");
  assert.match(xml, /<testsuite name="shots\/de" tests="1" failures="0"/);
  assert.match(xml, /<testcase name="missing: ja\/home" classname="ja\/home"/);

  const q = JSON.parse(fs.readFileSync(path.join(work, "cq.json"), "utf8"));
  assert.ok(validateCq(q), JSON.stringify(validateCq.errors));
  assert.deepEqual(q.map((e) => [e.location.path, e.check_name]), [["shots/fr/home.png", "catscan/present"], ["ja/home", "catscan/missing"]]);
  assert.equal(run(["results", "validate", "r.json"]).code, 0);
  const res = JSON.parse(fs.readFileSync(path.join(work, "r.json"), "utf8"));
  assert.deepEqual(res.coverage.missing, [{ device: null, text_size: null, locale: "ja", screen: "home" }]);
  // The report paths are in the recorded argv.
  assert.ok(res.run.argv.includes("catscan.xml") && res.run.argv.includes("cq.json"));
  // A second run gives the same fingerprints (D8).
  run([...ARGS, "--gitlab-codequality", "cq2.json"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work, "cq2.json"), "utf8")).map((e) => e.fingerprint), q.map((e) => e.fingerprint));
});

test("--format github without GITHUB_STEP_SUMMARY: annotations, one skip note, exit by the verdicts (D7)", () => {
  const r = run([...ARGS, "--format", "github"], { env: { GITHUB_STEP_SUMMARY: "" } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr.match(/catscan: github-summary-skipped: /g).length, 1);
  assert.match(r.stdout, /^::error file=ja\/home,.*\n::error file=shots\/fr\/home.png,.*::critical\/medium {2}present "Weiter"/);
  const ok = run(["check", "shots/de", "--present", "Weiter", "--format", "github"], { env: { GITHUB_STEP_SUMMARY: "" } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^1 image: 1 pass \(\d+\.\d s\)\n$/);
});

test("--format github escapes line breaks in stderr diagnostics too (D6, review fix)", () => {
  put("nl/a\n::error::x.png", "03-de-phone.png");
  // An expect key that matches nothing: the input gets no check, and no-checks names its path on stderr.
  fs.writeFileSync(path.join(work, "none.json"), JSON.stringify({ shots: { "zzz.png": { present: ["x"] } } }));
  const r = run(["check", "nl", "--expect", "none.json", "--format", "github"], { env: { GITHUB_STEP_SUMMARY: "" } });
  for (const l of r.stderr.split("\n").filter(Boolean)) assert.ok(l.startsWith("catscan: "), JSON.stringify(l));
  assert.match(r.stderr, /a%0A::error::x\.png/);
  fs.rmSync(path.join(work, "nl"), { recursive: true });
  // A usage error under --format github is escaped as well.
  const u = run(["check", "shots", "--format", "github", "--present", "x", "--locale", "de\n::error::y"]);
  assert.equal(u.code, 2);
  for (const l of u.stderr.split("\n").filter(Boolean)) assert.ok(l.startsWith("catscan: "), JSON.stringify(l));
});

test("a report file that cannot be written is exit 4 (spec 00); the others are still written", () => {
  for (const flag of ["--junit", "--gitlab-codequality", "--results"]) {
    const r = run(["check", "shots/de", "--present", "Weiter", flag, "no/such/dir/out", ...(flag === "--junit" ? [] : ["--junit", "ok.xml"])]);
    assert.equal(r.code, 4, `${flag}: ${r.stderr}`);
    assert.match(r.stderr, flag === "--results" ? /catscan: results-write-failed: / : /catscan: report-write-failed: cannot write the (JUnit|Code Quality) file no\/such\/dir\/out/);
    if (flag !== "--junit") assert.ok(fs.existsSync(path.join(work, "ok.xml")));
    fs.rmSync(path.join(work, "ok.xml"), { force: true });
  }
  const s = run(["check", "shots/de", "--present", "Weiter", "--format", "github"], { env: { GITHUB_STEP_SUMMARY: path.join(work, "no/such/summary.md") } });
  assert.equal(s.code, 4);
  assert.match(s.stderr, /catscan: report-write-failed: cannot append the job summary/);
});
