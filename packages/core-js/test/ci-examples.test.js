// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 15 D2, D3, D4, D13: the ready-to-copy CI examples stay pinned and parse.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const ROOT = path.join(__dirname, "../../..");
const DIR = path.join(ROOT, "examples/ci");
const VERSION = require("../../cli/package.json").version;
// D4: the action pins of spec 15, re-checked against the latest releases when touched.
const ACTIONS = {
  "actions/checkout": ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"],
  "actions/setup-node": ["949feb2413d6458794dcd2491c4babbbce0c15c1", "v7.1.0"],
  "actions/upload-artifact": ["cf430e030ddbb5b0abf93d22962f4752f3646cd9", "v7.0.2"],
  "actions/download-artifact": ["9000827ccba6bdab643e8b6fd33ac0654aef8333", "v8.0.2"],
};
// The lab pins Node in macos.yml; the published repo, which gets no lab workflow, in its ci.yml.
const WF = [".github/workflows/macos.yml", ".github/workflows/ci.yml"].map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f));
const NODE = fs.readFileSync(WF, "utf8").match(/node-version: (26\.\d+\.\d+)/)[1];
const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

test("examples: one file per service, each parses as YAML", () => {
  assert.deepEqual(files, ["azure-pipelines.yml", "bitrise.yml", "circleci.yml", "codemagic.yaml", "github-actions-baseline.yml", "github-actions-sharded.yml", "github-actions.yml", "gitlab-ci-baseline.yml", "gitlab-ci.yml"]);
  for (const f of files) {
    const doc = YAML.parseDocument(fs.readFileSync(path.join(DIR, f), "utf8"));
    assert.deepEqual(doc.errors, [], f);
  }
});

test("examples: catscan pinned to the release, --report where spec 18 adds it, the D13 header", () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(DIR, f), "utf8");
    const pins = [...text.matchAll(/@catscan\/cli@([^\s"']+)/g)].map((m) => m[1]);
    assert.ok(pins.length >= 2, f);
    for (const p of pins) assert.equal(p, VERSION, `${f} pins @catscan/cli@${p}`);
    // Spec 18 adds the HTML report to the GitHub upload path and the GitLab artifacts (spec 15 D2).
    if (["github-actions.yml", "gitlab-ci.yml"].includes(f)) assert.match(text, / check .*--report catscan\.html\n/, f);
    const head = text.split("\n").filter((l) => l.startsWith("#")).join("\n");
    for (const w of ["screenshots", "shots", "checks.yaml", "locales", "First green run"]) assert.ok(head.includes(w), `${f} header names ${w}`);
    assert.match(head, /\((tested|community-tested: no recorded run yet)[;)]/, `${f} states its test status`);
    if (!f.startsWith("github")) assert.match(text, /--junit /, f);
    if (!text.includes("results merge")) assert.match(text, /\bdoctor\b/, f);
  }
});

test("examples: GitHub actions pinned by SHA with the D4 version comment; Node and runner pinned", () => {
  for (const f of files.filter((x) => x.startsWith("github"))) {
    const text = fs.readFileSync(path.join(DIR, f), "utf8");
    const uses = [...text.matchAll(/uses: ([^@\s]+)@(\S+) # (\S+)/g)];
    assert.equal(uses.length, (text.match(/uses:/g) || []).length, `${f}: every uses: has a SHA and a comment`);
    for (const [, name, sha, tag] of uses) {
      assert.match(sha, /^[0-9a-f]{40}$/);
      assert.deepEqual([sha, tag], ACTIONS[name], `${f}: ${name}`);
    }
    for (const m of text.matchAll(/node-version: (\S+)/g)) assert.equal(m[1], NODE, f);
    for (const m of text.matchAll(/runs-on: (\S+)/g)) assert.match(m[1], /^macos-\d+$/, `${f}: pin the runner label, not macos-latest`);
    const doc = YAML.parse(text);
    assert.deepEqual(doc.permissions, { contents: "read" });
    for (const job of Object.values(doc.jobs)) {
      assert.ok(job["timeout-minutes"] > 0, f);
      const co = job.steps.find((s) => s.uses?.startsWith("actions/checkout"));
      assert.equal(co.with["persist-credentials"], false, f);
    }
  }
  const plain = YAML.parse(fs.readFileSync(path.join(DIR, "github-actions.yml"), "utf8"));
  assert.deepEqual([plain.name, plain.on], ["catscan", ["pull_request"]]);
});

test("examples: the sharded workflow follows D10", () => {
  const doc = YAML.parse(fs.readFileSync(path.join(DIR, "github-actions-sharded.yml"), "utf8"));
  assert.equal(doc.jobs.shards.strategy["fail-fast"], false);
  const up = doc.jobs.shards.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
  assert.equal(up.with.name, "shard-${{ matrix.group }}-${{ matrix.device }}");
  const check = doc.jobs.shards.steps.find((s) => s.run?.includes(" check "));
  assert.ok(!/--expect-locales|--expect-screens|--expect-devices/.test(check.run), "expectations go only to the merge");
  // TODO-075: a device dimension in the matrix tags each shard and names every device at the merge.
  const devices = doc.jobs.shards.strategy.matrix.device;
  if (devices) {
    assert.match(check.run, /--device "\$\{\{ matrix\.device \}\}"/);
    assert.ok(doc.jobs.merge.steps.find((s) => s.run?.includes("results merge")).run.includes(`--expect-devices ${devices.join(",")}`), "the merge step carries --expect-devices");
  }
  assert.equal(doc.jobs.merge.needs, "shards");
  assert.equal(doc.jobs.merge.if, "${{ !cancelled() }}");
  const down = doc.jobs.merge.steps.find((s) => s.uses?.startsWith("actions/download-artifact"));
  assert.deepEqual(down.with, { pattern: "shard-*", "merge-multiple": true });
  assert.match(doc.jobs.merge.steps.find((s) => s.run?.includes("results merge")).run, /results merge shard-\*\.json --expect-devices ios,android --expect-locales-from locales --out catscan-results.json/);
});

test("examples: GitLab keeps both reports as artifacts and as reports (D14, D15)", () => {
  const doc = YAML.parse(fs.readFileSync(path.join(DIR, "gitlab-ci.yml"), "utf8"));
  const job = doc.catscan;
  assert.equal(job.script[0], "node --version");
  assert.deepEqual(job.artifacts.reports, { junit: "catscan.xml", codequality: "catscan-cq.json" });
  for (const f of ["catscan.xml", "catscan-cq.json", "catscan-results.json", "catscan.html"]) assert.ok(job.artifacts.paths.includes(f), f);
  assert.equal(job.artifacts.when, "always");
  assert.equal(job.artifacts.expire_in, "7 days");
});

test("examples: an optional, commented Tesseract install for the fallback locales (TODO-034 D2)", () => {
  for (const f of files) {
    const lines = fs.readFileSync(path.join(DIR, f), "utf8").split("\n");
    const brew = lines.filter((l) => l.includes("brew install"));
    assert.equal(brew.length, 1, `${f}: one install line`);
    assert.match(brew[0], /^\s*# (- ((run|script): )?)?brew install tesseract tesseract-lang$/, `${f}: commented, so a project without those locales skips it`);
    const why = lines[lines.indexOf(brew[0]) - 1];
    assert.match(why, /^\s*# Only if you ship a locale catscan reads with Tesseract, such as el, he, hr or et .*docs\/recipes\/tesseract\.md\):$/, `${f}: names the locales and the recipe`);
  }
});

test("examples: a doctor preflight with the check's locales runs before every check (TODO-065 T5, D7, D10)", () => {
  // Value: protects=TODO-065 T5; fails_when=an example checks screenshots without a doctor line naming its locales, or a shard preflights the whole catalog; why_new=new contract; seam=none; no_claim=a recorded CI run
  for (const f of files) {
    const lines = fs.readFileSync(path.join(DIR, f), "utf8").split("\n");
    const checks = lines.map((l, i) => [l, i]).filter(([l]) => !/^\s*#/.test(l) && /@catscan\/cli@\S+ check /.test(l));
    for (const [l, i] of checks) {
      const doctor = lines.slice(0, i).reverse().find((x) => /@catscan\/cli@\S+ doctor/.test(x));
      assert.ok(doctor, `${f}:${i + 1}: a doctor line before check`);
      if (l.includes("--expect-locales-from locales")) assert.match(doctor, /doctor --expect-locales-from locales$/, `${f}: same locale source as check`);
      else assert.match(doctor, /doctor --expect-locales "\$\{\{ matrix\.locales \}\}"$/, `${f}: a shard preflights its own locales`);
    }
  }
});

test("examples: the changed-only recipes approve on a release tag and fetch the latest approved baseline (TODO-038 D17)", () => {
  // Value: protects=TODO-038 D14, D17; fails_when=a recipe compares without --baseline, approves outside a tag job, gives merge-request jobs write access, or omits the store's retention; why_new=new recipes; seam=YAML; no_claim=a recorded run on either service
  const gh = YAML.parse(fs.readFileSync(path.join(DIR, "github-actions-baseline.yml"), "utf8"));
  const ghText = fs.readFileSync(path.join(DIR, "github-actions-baseline.yml"), "utf8");
  assert.deepEqual(gh.on, { pull_request: null, push: { tags: ["v*"] } });
  const steps = (job) => job.steps.map((s) => s.run || "").join("\n");
  assert.match(gh.jobs.review.if, /pull_request/);
  assert.equal(gh.jobs.review.permissions, undefined, "the review job keeps the read-only top-level token");
  assert.match(steps(gh.jobs.review), /gh release download .*--pattern catscan-baseline\.json/);
  assert.match(steps(gh.jobs.review), / check .*--baseline catscan-baseline\.json/);
  assert.match(gh.jobs.approve.if, /refs\/tags\//);
  assert.deepEqual(gh.jobs.approve.permissions, { contents: "write" });
  assert.match(steps(gh.jobs.approve), /results baseline catscan-results\.json --out catscan-baseline\.json/);
  assert.match(steps(gh.jobs.approve), /gh release upload .*catscan-baseline\.json/);
  const gl = YAML.parse(fs.readFileSync(path.join(DIR, "gitlab-ci-baseline.yml"), "utf8"));
  const glText = fs.readFileSync(path.join(DIR, "gitlab-ci-baseline.yml"), "utf8");
  assert.deepEqual(gl["catscan-review"].rules, [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
  assert.match(gl["catscan-review"].script.join("\n"), /curl .*--output catscan-baseline\.json "\$BASELINE_URL"[\s\S]* check .*--baseline catscan-baseline\.json/);
  assert.deepEqual(gl["catscan-approve"].rules, [{ if: "$CI_COMMIT_TAG" }]);
  assert.match(gl["catscan-approve"].script.join("\n"), /results baseline catscan-results\.json --out catscan-baseline\.json\n.*--upload-file catscan-baseline\.json "\$BASELINE_URL"/);
  // D14, D17: each names its store's retention and keeps the screen text private; D26: the jq stop-on-change step.
  for (const [f, text] of [["github", ghText], ["gitlab", glText]]) {
    const head = text.split("\n").filter((l) => l.startsWith("#")).join("\n");
    assert.match(head, /Retention: .*(never expires|stay until deleted)/, f);
    assert.match(head, /expire/, f);
    assert.match(head, /private/, f);
    assert.match(text, /jq -e '\.baseline\.review\.cells == 0' catscan-results\.json/, f);
  }
});
