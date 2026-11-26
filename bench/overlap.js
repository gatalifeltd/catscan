#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 12 measurement: the synthetic overlap set (D5, D6, D10). 12 locales x 4 layouts x 6 amounts x 3 sizes, drawn
// with Core Text by bench/overlap/generate.swift from bench/untranslated/strings.json with a fixed seed, so the truth
// is known by construction. Even-numbered images are the dev half (thresholds are tuned there), odd ones are held out.
// Usage:
//   node bench/overlap.js [--keep <dir>] > results/overlap.json   the gate on the held-out half (exit 1 below it)
//   node bench/overlap.js --sweep [--keep <dir>]                  threshold sweep on the dev half (stdout table)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const S = require("./untranslated/strings.json");
const LOCALES = Object.keys(S.locales).filter((l) => l !== "en");
const LAYOUTS = ["vv", "lh", "icon", "hh"]; // vv, lh, icon: vertical; hh: one row (horizontal)
const AMOUNTS = [-4, 0, 2, 4, 8, 16]; // CSS px; -4 is a 4 px gap, 0 touching
const SIZES = [13, 17, 24];
const GATE = { precision: 0.90, recall: 0.80, minAmount: 4 };

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The plan: one item per image, in a fixed order; `dev` is the even half. */
function plan(seed = 12) {
  const rand = rng(seed);
  const items = [];
  for (const locale of LOCALES) {
    const strings = S.locales[locale];
    const short = [...strings].sort((a, b) => [...a].length - [...b].length).slice(0, Math.ceil(strings.length / 2));
    for (const layout of LAYOUTS) for (const amount of AMOUNTS) for (const size of SIZES) {
      const pool = layout === "hh" ? short : strings;
      const pick = () => pool[Math.floor(rand() * pool.length)];
      let a = pick(), b = pick();
      while (b === a) b = pick();
      const distractors = [];
      while (distractors.length < 3) { const d = strings[Math.floor(rand() * strings.length)]; if (![a, b, ...distractors].includes(d)) distractors.push(d); }
      const i = items.length;
      items.push({ name: `${locale}/${String(i).padStart(4, "0")}-${layout}-${amount}-${size}.png`, locale, layout, amount, size,
        theme: i % 3 === 2 ? "dark" : "light", a, b, distractors, shift: Math.round(rand() * 20) / 100, dev: i % 2 === 0 });
    }
  }
  return items;
}

const area = (r) => Math.max(0, r[2]) * Math.max(0, r[3]);
const inter = (p, q) => area([Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.min(p[0] + p[2], q[0] + q[2]) - Math.max(p[0], q[0]), Math.min(p[1] + p[3], q[1] + q[3]) - Math.max(p[1], q[1])]);
const px = (box, w, h) => [box[0] * w, box[1] * h, box[2] * w, box[3] * h];

/**
 * Whether a finding names the labeled pair (D5): a boxes finding has one box on each line of the pair; a garbled
 * finding (two lines read as one) covers both.
 */
function matches(f, truth) {
  const pa = truth.lines.find((l) => l.role === "a").box, pb = truth.lines.find((l) => l.role === "b").box;
  const A = px(f.a.box, truth.width, truth.height);
  if (f.signal === "garbled" || !f.b) return inter(A, pa) > 0 && inter(A, pb) > 0;
  const B = px(f.b.box, truth.width, truth.height);
  return (inter(A, pa) > 0 && inter(B, pb) > 0) || (inter(A, pb) > 0 && inter(B, pa) > 0);
}

/**
 * Scores findings per image. `rows`: [{item, truth, findings}]. Images with a 2 px overlap are outside the gate
 * (D5): reported, never a hit or a false alarm. Precision counts findings; recall counts images.
 */
function score(rows) {
  const by = (key) => {
    const g = {};
    for (const r of rows) {
      const k = key(r.item);
      g[k] = g[k] || { images: 0, found: 0, findings: 0, false_alarms: 0 };
      const hit = r.findings.filter((f) => r.item.amount > 0 && matches(f, r.truth)).length;
      g[k].images += 1;
      g[k].found += hit > 0 ? 1 : 0;
      g[k].findings += r.findings.length;
      g[k].false_alarms += r.findings.length - hit;
    }
    for (const v of Object.values(g)) v.rate = Number((v.found / v.images).toFixed(4));
    return g;
  };
  const gated = rows.filter((r) => r.item.amount !== 2);
  let tp = 0, fp = 0;
  for (const r of gated) {
    for (const f of r.findings) (r.item.amount >= GATE.minAmount && matches(f, r.truth) ? tp++ : fp++);
  }
  const pos = rows.filter((r) => r.item.amount >= GATE.minAmount);
  const found = pos.filter((r) => r.findings.some((f) => matches(f, r.truth))).length;
  const neg = rows.filter((r) => r.item.amount <= 0);
  const precision = tp + fp ? Number((tp / (tp + fp)).toFixed(4)) : null;
  const recall = pos.length ? Number((found / pos.length).toFixed(4)) : null;
  return {
    images: rows.length, positives: pos.length, negatives: neg.length, tp, fp, precision, recall,
    negative_images_flagged: neg.filter((r) => r.findings.length).length,
    gate_pass: precision !== null && recall !== null && precision >= GATE.precision && recall >= GATE.recall,
    per_amount: by((i) => i.amount), per_layout_4px_up: by2(rows.filter((r) => r.item.amount >= GATE.minAmount), (i) => i.layout),
    per_size_4px_up: by2(rows.filter((r) => r.item.amount >= GATE.minAmount), (i) => i.size),
    per_signal: perSignal(rows),
  };
  function by2(sub, key) { const save = rows; rows = sub; const g = by(key); rows = save; return g; }
}

function perSignal(rows) {
  const out = {};
  for (const sig of ["boxes", "garbled"]) {
    let tp = 0, fp = 0;
    for (const r of rows.filter((x) => x.item.amount !== 2)) {
      for (const f of r.findings.filter((x) => x.signal === sig)) (r.item.amount >= GATE.minAmount && matches(f, r.truth) ? tp++ : fp++);
    }
    out[sig] = { tp, fp, precision: tp + fp ? Number((tp / (tp + fp)).toFixed(4)) : null };
  }
  return out;
}

function draw(items, dir) {
  const gen = path.join(os.tmpdir(), `catscan-overlap-gen-${process.pid}`);
  execFileSync("swiftc", ["-O", path.join(__dirname, "overlap/generate.swift"), "-o", gen]);
  const planFile = path.join(dir, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(items));
  const out = JSON.parse(execFileSync(gen, [planFile, dir], { encoding: "utf8", maxBuffer: 1 << 30 }));
  fs.rmSync(gen, { force: true });
  return out;
}

/**
 * Runs catscan on batches of 12 images. A Vision request can hang for good with the core idle (TODO-032), so a
 * batch that takes over 2 minutes is killed and run once more; a second hang fails the run.
 * `--experimental` also runs TODO-067's stacked reader; its findings are kept only for the stacked benches
 * (`{ stacked: true }`), so spec 12's and TODO-049's rows stay what they measured.
 */
function run(command, files, locale, extra = [], { stacked = false, experimental = true } = {}) {
  const out = [];
  for (let i = 0; i < files.length; i += 12) {
    const batch = files.slice(i, i + 12);
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync(process.execPath, [CLI, command, ...batch, ...(locale ? ["--locale", locale] : []), "--json", ...(command === "overlap" && experimental ? ["--experimental"] : []), ...extra], { encoding: "utf8", maxBuffer: 1 << 30, timeout: 120000, killSignal: "SIGKILL" });
      // 3: unsupported or needs-reader envelopes still print their JSON; only the stacked benches score them (TODO-067 D35).
      if ([0, 1, ...(stacked ? [3] : [])].includes(r.status)) { out.push(...r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((e) => (stacked ? e : withoutStacked(e)))); break; }
      // The killed CLI leaves its hung core behind; stop this checkout's cores only.
      spawnSync("pkill", ["-f", path.join(ROOT, "core/.build")]);
      if (attempt === 2) throw new Error(`catscan ${command} ${locale}: exit ${r.status ?? r.signal}: ${r.stderr}`);
      process.stderr.write(`catscan ${command} ${locale}: batch ${i / 12} ${r.signal ? "timed out" : `exit ${r.status}`}, retrying\n`);
    }
  }
  return out;
}

/** The envelope without stacked findings, its verdict recomputed from what is left (TODO-067). */
function withoutStacked(env) {
  if (!env.findings) return env;
  const findings = env.findings.filter((f) => f.signal !== "stacked");
  return findings.length === env.findings.length ? env : { ...env, findings, verdict: env.verdict === "fail" && !findings.length ? "pass" : env.verdict };
}

function rowsFor(items, report, dir, command, extra) {
  const truthBy = new Map(report.images.map((t) => [t.name, t]));
  const rows = [];
  for (const locale of LOCALES) {
    const files = items.filter((i) => i.locale === locale && !truthBy.get(i.name).skipped).map((i) => path.join(dir, i.name));
    if (!files.length) continue;
    for (const env of run(command, files, locale, extra)) {
      const name = path.relative(dir, env.path);
      const item = items.find((i) => i.name === name);
      const truth = truthBy.get(name);
      if (!item || truth.skipped) continue;
      rows.push({ item, truth, env, findings: env.findings || [] });
    }
  }
  return rows;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep") ? argv[argv.indexOf("--keep") + 1] : null;
  const dir = keep || fs.mkdtempSync(path.join(os.tmpdir(), "catscan-overlap-"));
  fs.mkdirSync(dir, { recursive: true });
  const items = plan();
  const report = draw(items, dir);
  const skipped = report.images.filter((t) => t.skipped).length;
  if (argv.includes("--sweep")) {
    const sweep = require("./overlap/sweep");
    const dev = items.filter((i) => i.dev);
    const rows = rowsFor(dev, report, dir, "overlap", ["--min-overlap", "0.001"]);
    const reads = rowsFor(dev, report, dir, "read", []);
    process.stdout.write(sweep.table(rows, reads, score));
  } else {
    const all = rowsFor(items, report, dir, "overlap", []);
    const v = versionInfo();
    const result = {
      spec: "12", script: "bench/overlap.js", generator: "bench/overlap/generate.swift", strings: "bench/untranslated/strings.json",
      seed: 12, locales: LOCALES, layouts: LAYOUTS, amounts_css_px: AMOUNTS, sizes_css_px: SIZES, drawn: items.length, skipped_layout: skipped,
      gate: GATE, held_out: score(all.filter((r) => !r.item.dev)), dev: score(all.filter((r) => r.item.dev)),
      fonts: report.fonts, catscan: v.catscan, chip: v.host.chip, macos: v.macos, macos_build: v.macos_build, vision_revision: v.vision_revision,
      node: process.version, date: new Date().toISOString().slice(0, 10),
      swiftc: execFileSync("swiftc", ["--version"], { encoding: "utf8" }).split("\n")[0],
    };
    process.stdout.write(JSON.stringify(result, null, 1) + "\n");
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(result.held_out.gate_pass ? 0 : 1);
  }
}

module.exports = { plan, score, matches, run, draw, rowsFor, withoutStacked, GATE, LOCALES };
