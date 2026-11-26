#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T3 real-screen leg (D40): `catscan formats` over real screens (gitignored, datasets/MANIFEST.md):
//   paywalls: datasets/d1/en-store (12 paywalls, US storefront) with --storefront US, all seven rules and the app's
//             own .storekit (outside git; its path from CATSCAN_PRICES, its SHA-256 recorded);
//   clean:    every other datasets/d1 locale folder with the default rules and no storefront (no defect is known
//             there, so every flag is false until reviewed).
// Prints counts and flag ids only; with --detail <file> it also writes each flag (image, line, token) for judging by
// eye, which stays outside git (spec 06 "Privacy"). Verdicts go to results/formats-review.json by flag id
// ("true", "false" or "true-per-file"); --review scores them.
// Usage: CATSCAN_PRICES=<app.storekit> node bench/formats-real.js [--datasets <dir>] [--detail <file>] [--review results/formats-review.json]
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
const DATA = opt("--datasets") || path.join(__dirname, "../datasets");
const PRICES = process.env.CATSCAN_PRICES;
if (!PRICES) throw new Error("set CATSCAN_PRICES to the app's .storekit file (outside git)");
const ALL = ["number", "date", "time", "currency-placement", "currency", "mixed-currency", "price"];
const id = (file, f) => crypto.createHash("sha256").update(`${file}\n${f.kind}\n${f.rule ?? f.field}\n${f.token}\n${f.line}`).digest("hex").slice(0, 16);

const d1 = path.join(DATA, "d1");
const runs = [{ set: "paywalls", dir: path.join(d1, "en-store"), locale: "en", extra: ["--storefront", "US", "--prices", PRICES, "--rules", ALL.join(",")] }];
for (const l of fs.readdirSync(d1).filter((x) => x !== "en-store" && fs.statSync(path.join(d1, x)).isDirectory()).sort()) {
  runs.push({ set: "clean", dir: path.join(d1, l), locale: l, extra: [] });
}
const out = { script: "bench/formats-real.js", sets: {}, prices_sha256: crypto.createHash("sha256").update(fs.readFileSync(PRICES)).digest("hex") };
const flags = [];
for (const run of runs) {
  const r = spawnSync(process.execPath, [CLI, "formats", run.dir, "--locale", run.locale, ...run.extra, "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`${run.dir}: exit ${r.status}: ${r.stderr}`);
  const s = (out.sets[run.set] = out.sets[run.set] || { screens: 0, flagged_screens: 0, flags: 0, by_rule: {}, price_exempt: 0 });
  for (const env of r.stdout.split("\n").filter(Boolean).map((x) => JSON.parse(x))) {
    if (env.verdict === "error" || env.verdict === "unsupported") throw new Error(`${env.path}: ${env.error?.code}`);
    s.screens++;
    s.price_exempt += env.price_exempt || 0;
    if (env.findings.length) s.flagged_screens++;
    for (const f of env.findings) {
      const rule = f.kind === "price" ? `price/${f.field}` : f.kind === "currency" ? `currency/${f.rule}` : f.rule;
      s.flags++;
      s.by_rule[rule] = (s.by_rule[rule] || 0) + 1;
      const rel = path.relative(DATA, env.path);
      flags.push({ id: id(rel, f), set: run.set, locale: run.locale, rule, image: rel, line: f.line, token: f.token, expected: f.expected ?? null });
    }
  }
}
for (const s of Object.values(out.sets)) s.flags_per_100_screens = Number((100 * s.flags / s.screens).toFixed(2));
out.flag_ids = flags.map(({ id: i, set, locale, rule }) => ({ id: i, set, locale, rule }));
if (detail) fs.writeFileSync(detail, JSON.stringify(flags, null, 2));
if (reviewFile) {
  const verdicts = Object.fromEntries(JSON.parse(fs.readFileSync(reviewFile, "utf8")).verdicts.map((v) => [v.id, v]));
  const judged = flags.filter((f) => verdicts[f.id]);
  const isFalse = (f) => verdicts[f.id].verdict === "false";
  out.review = { flags: flags.length, judged: judged.length, unjudged: flags.length - judged.length,
    false_flags: judged.filter(isFalse).length, true_per_file: judged.filter((f) => verdicts[f.id].verdict === "true-per-file").length };
}
const v = versionInfo();
out.tools = { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version };
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
