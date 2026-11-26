// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 05 end to end with real Vision: a quick run of three locales into a temp folder writes the CSV files and
// meta.json with every tool version, never touches bench/results/ (D14), and is compared with the recorded quick run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, setup } = require("./helpers");
const T = require("../bench/languages/table");

setup();
const listing = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).sort().map((f) => {
  const p = path.join(d, f);
  return `${f}:${fs.statSync(p).isFile() ? fs.statSync(p).mtimeMs : "dir"}`;
}) : []);

test("npm run bench -- --quick --lang en,de,ar --out <tmp>", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bench-quick-"));
  const results = path.join(ROOT, "bench/results");
  const before = listing(results);
  const r = spawnSync(process.execPath, [path.join(ROOT, "bench/languages/run.js"), "--quick", "--lang", "en,de,ar", "--out", out], { encoding: "utf8", timeout: 300000 });
  assert.deepEqual(listing(results), before, "a run without --record writes nothing under bench/results/");
  assert.match(r.stderr, /\[1\/3\] en: 30 images, check accuracy [\d.]+%/);
  const { summaries, stamp } = T.readSummaryCsv(path.join(out, "quick-summary.csv"));
  assert.deepEqual(summaries.map((s) => s.locale), ["en", "de", "ar"]);
  assert.match(stamp, /^# catscan=\S+ macos=\S+ macos_build=\S+ vision_revision=\d+$/);
  for (const s of summaries) {
    assert.equal(s.images, 30);
    assert.equal(s.errors, 0);
    assert.equal(s.checks, 40);
    assert.ok(s.median_ms > 0);
    assert.ok(s.engine.startsWith("vision-"));
  }
  for (const l of ["en", "de", "ar"]) assert.ok(fs.existsSync(path.join(out, "quick", `${l}.csv`)));
  const meta = JSON.parse(fs.readFileSync(path.join(out, "quick-meta.json"), "utf8"));
  for (const k of ["catscan", "macos", "macos_build", "vision_revision", "chip", "node", "swift"]) assert.ok(meta.tools[k], k);
  assert.ok(meta.fonts.ar.length && meta.commit && meta.timing);
  // TODO-037 D9: corpus provenance is grouped by ICU, CLDR and Node; every run locale sits in one group.
  assert.deepEqual(meta.corpus.groups.flatMap((g) => g.locales).sort(), ["ar", "de", "en"]);
  for (const g of meta.corpus.groups) assert.ok(g.cldr && g.icu && g.node, JSON.stringify(g));
  // Compared with the record for this macOS when there is one (the CI Mac has it); otherwise exit 1 naming --record.
  const macos = stamp.match(/macos=(\S+)/)[1];
  if (fs.existsSync(path.join(results, macos, "quick-summary.csv"))) {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /quick run matches the recorded one/);
  } else {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no recorded quick run for macOS .* rerun with --quick --record/);
  }
});

test("usage errors and an unknown locale exit 2 before anything runs", () => {
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "bench/languages/run.js"), ...a], { encoding: "utf8" });
  const r = run("--lang", "deu");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown locale "deu" in --lang; closest: de/);
  assert.equal(run("--bogus").status, 2);
  const h = run("--help");
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--quick/);
});
