// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 13 fixture suite, last step: examples/playwright runs green, and red on exactly the raw key with FAULTS=1.
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "../../../examples/playwright");

function run(faults) {
  const r = spawnSync("npx", ["playwright", "test", "--reporter=json"], {
    cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FAULTS: faults ? "1" : "", PORT: String(4173 + (faults ? 1 : 0)) },
  });
  let report;
  try { report = JSON.parse(r.stdout); } catch { throw new Error(`examples/playwright gave no JSON report (exit ${r.status}):\n${r.stderr}`); }
  const tests = [];
  const walk = (s) => { for (const c of s.suites || []) walk(c); for (const sp of s.specs || []) for (const t of sp.tests) tests.push({ title: sp.title, project: t.projectName, status: t.results.at(-1)?.status, error: t.results.at(-1)?.error?.message || "" }); };
  for (const s of report.suites) walk(s);
  return { status: r.status, tests };
}

for (const d of ["shots", "out"]) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
const green = run(false);
assert.equal(green.status, 0, `examples/playwright is red: ${JSON.stringify(green.tests.filter((t) => t.status !== "passed"))}`);
// 4 tests in en, 5 in de (with the TODO-076 screen), 3 in pseudo (TODO-039 T3), 1 in de-large (TODO-076)
assert.equal(green.tests.length, 13);
assert.ok(green.tests.every((t) => t.status === "passed"), "every example test ran and passed, none skipped");
assert.ok(green.tests.some((t) => t.project === "de-large"), "the de-large project ran");

// TODO-076: one truncated run over shots/default/ and shots/large/, then one report with both sizes. A cut found at
// 200% zoom is the example's point (the 900 px canvas past the 640 px viewport), so exit 1 is expected there.
const catscan = (args) => spawnSync(process.execPath, [path.join(__dirname, "../../cli/bin/catscan.js"), ...args], { cwd: dir, encoding: "utf8" });
const layout = "{text_size}/{screen}.{locale}";
fs.mkdirSync(path.join(dir, "out"));
const t = catscan(["truncated", "shots", "--layout", layout, "--results", "out/truncated.json"]);
assert.ok([0, 1].includes(t.status), `catscan truncated exit ${t.status}: ${t.stderr}`);
const sizes = new Set();
const walk = (v) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "text_size" && typeof x === "string") sizes.add(x); walk(x); } };
walk(JSON.parse(fs.readFileSync(path.join(dir, "out/truncated.json"), "utf8")));
assert.deepEqual([...sizes].sort(), ["default", "large"], "the results hold both sizes");
const rep = catscan(["report", "out/truncated.json", "--layout", layout, "--expect-text-sizes", "default,large", "--expect-locales", "de", "--out", "out/report.html"]);
assert.ok([0, 1].includes(rep.status) && fs.existsSync(path.join(dir, "out/report.html")), `catscan report exit ${rep.status}: ${rep.stderr}`);

const red = run(true);
const failed = red.tests.filter((t) => t.status !== "passed");
assert.deepEqual(failed.map((t) => `${t.project}: ${t.title}`).sort(), ["de: no raw key or unfilled placeholder is shown", "en: no raw key or unfilled placeholder is shown", "pseudo: every string comes from the pseudo catalog (no hardcoded text, raw key or placeholder)"]);
for (const t of failed) assert.match(t.error, /"menu\.quit" is a raw key/);
console.log("examples/playwright: 13 passed, one report over default and large; FAULTS=1: only the raw-key test fails, in en, de and pseudo");
