// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 11: bench:check compares both generated blocks with the committed files (D9, D12). Node only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const T = require("../languages/table");
const F = require("./table-fixture");

test("a committed pair that matches exits 0 and writes nothing", () => {
  const root = F.fixture();
  F.main([], root);
  const before = [F.read(root, "README.md"), F.read(root, "docs/BENCHMARKS.md")];
  const r = F.main(["--check"], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /match the committed results/);
  assert.deepEqual([F.read(root, "README.md"), F.read(root, "docs/BENCHMARKS.md")], before);
});

test("a changed README cell exits 1 with the block diff and the bench:table hint, and writes nothing", () => {
  const root = F.fixture();
  F.main([], root);
  const f = path.join(root, "README.md");
  const edited = F.read(root, "README.md").replace("98.00% / 97.00% (de)", "99.90% / 97.00% (de)");
  fs.writeFileSync(f, edited);
  const r = F.main(["--check"], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /README\.md differs from the committed results/);
  assert.match(r.err, /^- .*99\.90% \/ 97\.00% \(de\)/m);
  assert.match(r.err, /^\+ .*98\.00% \/ 97\.00% \(de\)/m);
  assert.match(r.err, /run npm run bench:table and commit the result/);
  assert.doesNotMatch(r.err, /BENCHMARKS\.md differs/);
  assert.equal(F.read(root, "README.md"), edited);
});

test("a changed Languages section is caught too (both blocks are checked)", () => {
  const root = F.fixture();
  F.main([], root);
  // A new record changes the Languages section (every folder) but not the README (reference unchanged).
  F.writeRun(root, "28.0");
  const r = F.main(["--check"], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /docs\/BENCHMARKS\.md differs/);
  assert.match(r.err, /^\+ ### macOS 28\.0/m);
  assert.doesNotMatch(r.err, /README\.md differs/);
});

test("a changed results file with an unchanged README is caught", () => {
  const root = F.fixture();
  F.main([], root);
  F.writeRun(root, "27.2", F.SUMMARIES.map((s) => (s.locale === "en" ? { ...s, median_ms: 999 } : s)));
  const r = F.main(["--check"], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /README\.md differs/);
});

test("diff is a line diff of the blocks", () => {
  assert.deepEqual(T.diff(["a", "b", "c"], ["a", "x", "c"]), ["- b", "+ x"]);
  assert.deepEqual(T.diff([], ["a"]), ["+ a"]);
});
