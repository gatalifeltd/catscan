// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-006 T3: the catscan-adopt fixture. The documented edits (examples/adopt-fixture/adopt.mjs), turned into a
// plan of diffs and checked by check-diffs.sh, give passing checks; changing the rendered text and re-capturing
// with stale screenshots removed turns each check red, and restoring it turns them green (D16). macOS + binary.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "../..");
const FIXTURE = path.join(ROOT, "examples/adopt-fixture");
const SCRIPTS = path.join(ROOT, "plugins/catscan/skills/catscan-adopt/scripts");
const VERSION = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", CI: "" };
const run = (cmd, args, cwd, extra = {}) => spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 240000 });
const git = (cwd, ...a) => { const r = run("git", a, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout; };

test("catscan-adopt fixture: documented edits pass, a text mutation through capture fails, restore passes", { timeout: 600000 }, (t) => {
  // Inside the repo, so @playwright/test and @catscan/playwright resolve from the root node_modules.
  const work = fs.mkdtempSync(path.join(FIXTURE, ".run-"));
  const plan = fs.mkdtempSync(path.join(require("os").tmpdir(), "adopt-plan-"));
  t.after(() => { fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(plan, { recursive: true, force: true }); });
  for (const f of ["app", "tests", "playwright.config.ts"]) fs.cpSync(path.join(FIXTURE, f), path.join(work, f), { recursive: true });
  fs.writeFileSync(path.join(work, ".gitignore"), "shots/\ntest-results/\nout/\n");
  git(work, "init", "-q");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "fixture");

  const pw = () => run(process.execPath, [path.join(ROOT, "node_modules/@playwright/test/cli.js"), "test", "-c", "playwright.config.ts"], work);
  const screens = () => run("sh", ["screens.sh"], work, { CATSCAN: `${process.execPath} ${path.join(ROOT, "bin/catscan.js")}` });
  const clearShots = () => fs.rmSync(path.join(work, "shots"), { recursive: true, force: true });

  let r = pw();
  assert.equal(r.status, 0, `fixture is red before adoption:\n${r.stdout}${r.stderr}`);
  assert.ok(fs.existsSync(path.join(work, "shots/de/menu.png")));

  // Phase 3 of the skill: one diff per point against the commit, proven to apply together by check-diffs.
  r = run(process.execPath, [path.join(FIXTURE, "adopt.mjs"), work, VERSION], ROOT);
  assert.equal(r.status, 0, r.stderr);
  git(work, "add", "-A");
  fs.mkdirSync(path.join(plan, "diffs"));
  fs.writeFileSync(path.join(plan, "diffs/01-playwright-matcher.diff"), git(work, "diff", "--cached", "--", "tests"));
  fs.writeFileSync(path.join(plan, "diffs/02-cli-step.diff"), git(work, "diff", "--cached", "--", "checks", "screens.sh"));
  fs.writeFileSync(path.join(plan, "commit"), git(work, "rev-parse", "HEAD"));
  git(work, "reset", "-q", "--hard");
  git(work, "clean", "-qfd", "-e", "shots");
  r = run("bash", [path.join(SCRIPTS, "check-diffs.sh"), work, plan], ROOT);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 diffs apply together/);
  for (const d of ["01-playwright-matcher.diff", "02-cli-step.diff"]) git(work, "apply", "--index", path.join(plan, "diffs", d));
  assert.match(fs.readFileSync(path.join(work, "screens.sh"), "utf8"), new RegExp(`@catscan/cli@${VERSION.replace(/\./g, "\\.")}`));

  const green = (when) => {
    clearShots();
    const a = pw();
    assert.equal(a.status, 0, `${when}: Playwright matcher red:\n${a.stdout}${a.stderr}`);
    const b = screens();
    assert.equal(b.status, 0, `${when}: CLI step red:\n${b.stdout}${b.stderr}`);
  };
  green("after adoption");

  // D16: change the rendered text in the app (not the expected text), remove stale shots, run the normal commands.
  const strings = path.join(work, "app/strings.js");
  fs.writeFileSync(strings, fs.readFileSync(strings, "utf8").replace('play: "Play"', 'play: "Plai"'));
  clearShots();
  r = pw();
  assert.notEqual(r.status, 0, "Playwright matcher stayed green on mutated text");
  assert.match(r.stdout + r.stderr, /Play/);
  assert.match(r.stdout, /1 failed/);
  r = screens();
  assert.equal(r.status, 1, `CLI step: want exit 1 on mutated text, got ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /Play/);

  git(work, "checkout", "--", "app/strings.js");
  green("after restore");

  // TODO-061: the batch measured before and after in two detached worktrees, counted, recorded and tabled.
  // Asserts the quoted test counts, the exact coverage and the row shape, never the timings.
  git(work, "commit", "-qm", "batch 1");
  const [base, batch] = ["HEAD~1", "HEAD"].map((r) => git(work, "rev-parse", "--short", r).trim());
  const wt = (arm) => `${work}-adopt1-${arm}`;
  t.after(() => { for (const a of ["before", "after"]) fs.rmSync(wt(a), { recursive: true, force: true }); });
  git(work, "worktree", "add", "-q", "--detach", wt("before"), base);
  git(work, "worktree", "add", "-q", "--detach", wt("after"), batch);
  const q = JSON.stringify;
  const layer = (arm) => `cd ${q(wt(arm))} && PLAYWRIGHT_JSON_OUTPUT_FILE=${q(path.join(plan, `pw-${arm}.json`))} ${q(process.execPath)} ${q(path.join(ROOT, "node_modules/@playwright/test/cli.js"))} test -c playwright.config.ts --reporter=list,json tests/menu.pw.ts`;
  const cmd = { before: layer("before"), after: `${layer("after")} && CATSCAN=${q(`${process.execPath} ${path.join(ROOT, "bin/catscan.js")}`)} sh screens.sh` };
  const metrics = (...a) => run(process.execPath, [path.join(SCRIPTS, "adopt-metrics.mjs"), ...a], wt("after"));

  const stamp = path.join(plan, "stamp-1");
  fs.writeFileSync(stamp, "");
  const past = new Date(Date.now() - 2000);
  fs.utimesSync(stamp, past, past);
  r = run("bash", ["-c", cmd.after], ROOT);
  assert.equal(r.status, 0, `coverage run red:\n${r.stdout}${r.stderr}`);
  r = metrics("count", "--shots", "shots", "--stamp", stamp, "--results", "out/en.json", "--results", "out/de.json",
    "--pw-json", path.join(plan, "pw-after.json"), "--asserted", "menu en", "--asserted", "menu de", "--locale", "en", "--locale", "de");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    shots: { checked: 2, captured: 2, unchecked: 0, locales: ["de", "en"], by_locale: { de: 1, en: 1 } },
    tests: { checked: 2, failed: 0, skipped: 0, locales: ["de", "en"], locales_source: "declared" }, findings: 0,
  });
  fs.writeFileSync(path.join(plan, "count.json"), r.stdout);

  r = run("bash", [path.join(SCRIPTS, "measure.sh"), "-n", "1", "--warmup", "0", "--log", path.join(plan, "logs"), `before@${base}:warm`, cmd.before, `after@${batch}:warm`, cmd.after], ROOT);
  assert.equal(r.status, 0, `measure.sh:\n${r.stdout}${r.stderr}`);
  fs.writeFileSync(path.join(plan, "measure.txt"), r.stdout);
  const file = path.join(plan, "metrics.jsonl");
  r = metrics("record", "--batch", "1", "--layer", "e2e", "--points", "01,02", "--count", path.join(plan, "count.json"), "--measure", path.join(plan, "measure.txt"),
    "--log", path.join(plan, "logs"), "--added", "0", "--real", "0", "--false", "0", "--edits", "0", "--proofs", "2/2", "--file", file);
  assert.equal(r.status, 0, r.stderr);
  const row = JSON.parse(fs.readFileSync(file, "utf8"));
  const two = { passed: 2, failed: 0, skipped: 0, total: 2 };
  assert.deepEqual([row.status, row.tests], ["indicative", { before: two, after: two, added: 0, source: "log" }]);
  r = metrics("table", "--file", file);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\| 1 \| e2e \| 0 \| 2\/2 shots \(de, en\); 2 tests \(de, en, declared\) \| 0\/0 \| 0 \| 2\/2 \| 2 -> 2 \(\+0\) \| [+-]\d+\.\d\d s wall, [+-]\d+\.\d\d s CPU, indicative \|$/m);
});
