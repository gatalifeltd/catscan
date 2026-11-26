#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T2 real-screen leg (D24): `untranslated --kinds wrong-language` over real screens (datasets/d1 with the
// ai app's catalogs, datasets/d2 with the games' catalogs; all gitignored) with the base catalog and the `{locale}`
// template, as a project runs it. The sets come from a config file kept outside git, because it names the apps'
// own catalog files: {"sets": [{"name", "screens": "<dir of <locale>/ folders>", "catalog": "<.../{locale}.json>",
// "base": "<en catalog>", "map": {"<folder>": "<locale>"}}]}. Prints counts and flag ids only; with --detail <file>
// it also writes each flag (image, line, language, evidence) there for judging by eye, which stays outside git
// (spec 06 "Privacy"). Verdicts go to results/wrong-language-review.json by flag id; --review scores them.
// Usage: node bench/wrong-language-real.js <config.json> [--detail <file>] [--review results/wrong-language-review.json]
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");

const CLI = path.join(__dirname, "../bin/catscan.js");
const args = process.argv.slice(2);
const opt = (name) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : null; };
const detail = opt("--detail");
const reviewFile = opt("--review");
if (!args[0]) throw new Error("usage: node bench/wrong-language-real.js <config.json> [--detail <file>] [--review <file>]");
const SETS = JSON.parse(fs.readFileSync(args[0], "utf8")).sets;
function sub(d) { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
const id = (file, line) => crypto.createHash("sha256").update(`${file}\n${line}`).digest("hex").slice(0, 16);

const out = { script: "bench/wrong-language-real.js", sets: {}, flags: [] };
const flags = [];
for (const set of SETS) {
  let screens = 0, flagged = 0, n = 0;
  const byEvidence = { catalog: 0, langid: 0 };
  for (const folder of sub(set.screens)) {
    const locale = (set.map || {})[folder] ?? folder, dir = path.join(set.screens, folder);
    const r = spawnSync(process.execPath, [CLI, "untranslated", dir, "--locale", locale, "--base", set.base,
      "--catalog", set.catalog, "--kinds", "wrong-language", "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0 && r.status !== 1) throw new Error(`${dir}: exit ${r.status}: ${r.stderr}`);
    for (const env of r.stdout.split("\n").filter(Boolean).map((x) => JSON.parse(x))) {
      if (env.verdict === "error" || env.verdict === "unsupported") throw new Error(`${env.path}: ${env.error?.code}`);
      screens++;
      const w = env.findings.filter((f) => f.kind === "wrong-language");
      if (w.length) flagged++;
      for (const f of w) {
        n++;
        byEvidence[f.evidence]++;
        const rel = path.join(set.name, path.relative(set.screens, env.path));
        flags.push({ id: id(rel, f.line), set: set.name, locale, evidence: f.evidence, language: f.language, image: rel, line: f.line, key: f.key ?? null, confidence: f.confidence });
      }
      for (const wn of env.warnings || []) if (wn.code === "wrong-language-unchecked") throw new Error(`${env.path}: ${wn.message}`);
    }
  }
  out.sets[set.name] = { screens, flagged_screens: flagged, flags: n, by_evidence: byEvidence, flags_per_100_screens: Number((100 * n / screens).toFixed(2)) };
}
out.flag_ids = flags.map(({ id: i, set, locale, evidence, language }) => ({ id: i, set, locale, evidence, language }));
if (detail) fs.writeFileSync(detail, JSON.stringify(flags, null, 2));
if (reviewFile) {
  const verdicts = Object.fromEntries(JSON.parse(fs.readFileSync(reviewFile, "utf8")).verdicts.map((v) => [v.id, v]));
  const judged = flags.filter((f) => verdicts[f.id]);
  const tp = judged.filter((f) => verdicts[f.id].verdict === "true").length;
  out.review = { flags: flags.length, judged: judged.length, unjudged: flags.length - judged.length, true_flags: tp, false_flags: judged.length - tp,
    precision: judged.length ? Number((tp / judged.length).toFixed(4)) : null, measured: judged.length >= 20 };
}
const v = versionInfo();
delete out.flags;
out.tools = { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version };
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
