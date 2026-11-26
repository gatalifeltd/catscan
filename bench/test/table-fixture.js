// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 11 fixture: a repo root with README.md, docs/BENCHMARKS.md, bench/reference.json, bench/study.json and
// results folders, for the table and check tests. No binary.
const fs = require("fs");
const os = require("os");
const path = require("path");
const T = require("../languages/table");

const tools = { catscan: "0.0.1", macos: "27.2", macos_build: "26B123", vision_revision: 3 };
const sum = (locale, engine, x = {}) => ({ locale, engine, gated: true, images: 30, errors: 0, checks: 40, correct: 40,
  check_accuracy: 100, fit_images: 10, fit_read: 10, fit_recall: 1, cer: 0, trunc_tp: 10, trunc_fp: 0, trunc_fn: 0, trunc_tn: 10,
  trunc_precision: 1, trunc_recall: 1, median_ms: 20, conf_fit: "", conf_clip: "", ...x });
const V = "vision-accurate-rev3", TS = "tesseract-5.5.4";
const SUMMARIES = [
  sum("en", V, { check_accuracy: 99, fit_recall: 0.99, cer: 0.01, trunc_tp: 8, trunc_fp: 2, trunc_fn: 2, median_ms: 20 }),
  sum("de", V, { check_accuracy: 97, fit_recall: 0.95, cer: 0.03, trunc_tp: 10, trunc_fp: 0, trunc_fn: 6, median_ms: 30 }),
  sum("ja", V, { check_accuracy: 98, fit_recall: 0.9, cer: 0.02, trunc_tp: 12, trunc_fp: 0, trunc_fn: 2, median_ms: 10 }),
  sum("el", TS, { check_accuracy: 90, fit_recall: 0.5, cer: 0.1, trunc_tp: 5, trunc_fp: 5, trunc_fn: 0, median_ms: 100 }),
];
const meta = (timing) => ({ date: "2026-11-09", machine: "Mac17,2", timing, commit: "abc", tools: { ...tools, chip: "Apple M5", node: "v26", swift: "6.4", tesseract: "t", leptonica: "l" },
  corpus: { icu: "78", cldr: "48", seed: 5 } });
const STUDY = { measured_on: "Apple M5, study", rows: [
  { metric: "Energy per screenshot", engine: "Vision", value: "0.3", unit: "J", date: "2026-10-30", anchor: "energy", part: "power" },
  { metric: "Real-screen recall", engine: "Vision", value: "98.5", unit: "%", date: "2026-10-29", anchor: "real-screenshots" }] };

function writeRun(root, folder, summaries = SUMMARIES, timing = "under load: 0 simulator(s) booted, 2 emulator(s) running; x") {
  const d = path.join(root, "bench/results", folder);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "summary.csv"), T.summaryCsv(tools, summaries));
  fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify(meta(timing)));
}

/** A fixture root; `x` overrides reference, study, readme and doc. Returns the root path. */
function fixture(x = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-table-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  writeRun(root, "27.2");
  fs.writeFileSync(path.join(root, "bench/reference.json"), JSON.stringify(x.reference || { languages: "27.2", power: null, llm: null }));
  fs.writeFileSync(path.join(root, "bench/study.json"), JSON.stringify(x.study || STUDY));
  fs.writeFileSync(path.join(root, "README.md"), x.readme ?? `# x\n\nintro\n\n${T.R_START}\nold\n${T.R_END}\n\n## After\n`);
  fs.writeFileSync(path.join(root, "docs/BENCHMARKS.md"), x.doc ?? `# B\n\n${T.START}\nold\n${T.END}\n\n## Study\n\n### Real screenshots\n\n### Energy\n`);
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

/** The locales the fixture's reference folders hold, so tests not about the corpus check (TODO-042 D3) pass it. */
function recorded(root) {
  try { const { lang } = T.reference(root); return lang ? lang.merged.map((x) => x.s.locale) : []; } catch { return []; }
}

/** Runs T.main with output captured; `locales` stands in for the corpus list (default: what is recorded). */
function main(argv, root, locales = recorded(root)) {
  const out = [], err = [];
  const code = T.main(argv, { root, log: (s) => out.push(s), err: (s) => err.push(s), locales });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

module.exports = { fixture, writeRun, read, main, sum, SUMMARIES, STUDY, tools, V, TS };
