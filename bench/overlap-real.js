#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 12 D11: `catscan overlap` on real screens. Game captures (from a capture script that is not published) carry every drawn
// text's rect, so their labels come from the rects: a natural screen whose text rects do not touch is a negative, a
// screen where one real text was moved onto another is a positive for that pair. Study screenshots (no rects) are
// negatives whose every flag is reviewed by hand: `--review <file>` lists the flags, and `--reviewed <file>` (JSON
// {"<path>": "real" | "false-alarm"}) records the verdicts. Images and labels stay in datasets/ (gitignored).
// Usage: node bench/overlap-real.js --games datasets/overlap-games [--study <dir>]... [--reviewed <file>] [--review <file>]
//        > results/overlap-real.json
//        node bench/overlap-real.js --sweep 0.01,0.1,0.2,0.3 --games ... --study <dir>... > results/overlap-real-sweep.json
//        (D21: flags per 100 real negative screens per threshold; one run at the lowest, filtered by each finding's overlap)
"use strict";
const fs = require("fs");
const path = require("path");
const { versionInfo } = require("../packages/core-js/src/client");

const ROOT = path.resolve(__dirname, "..");
const MIN_PX = 4; // a positive pair's rects intersect by at least this many screenshot px both ways (D11)

const area = (r) => Math.max(0, r[2]) * Math.max(0, r[3]);
const inter = (p, q) => area([Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.min(p[0] + p[2], q[0] + q[2]) - Math.max(p[0], q[0]), Math.min(p[1] + p[3], q[1] + q[3]) - Math.max(p[1], q[1])]);
const rect = (r) => [r.x, r.y, r.width, r.height];
const px = (box, w, h) => [box[0] * w, box[1] * h, box[2] * w, box[3] * h];

/** 95% Wilson interval for k of n. */
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Number(Math.max(0, c - h).toFixed(4)), Number(Math.min(1, c + h).toFixed(4))];
}

/** The labeled pairs of one capture: [[rectA, rectB]] in screenshot px, and whether the screen is gated at all. */
function truth(side) {
  const t = new Map(side.texts_px.map((x) => [x.index, rect(x.rect)]));
  if (side.kind === "forced") {
    const pairs = [];
    for (const m of side.forced.moved) for (const o of side.forced.onto) pairs.push([t.get(m), t.get(o)]);
    return { kind: "positive", pairs, k: side.forced.k_game_px, axis: side.forced.axis };
  }
  const real = (side.pairs || []).filter((p) => Math.min(p.width ?? p.w ?? 0, p.height ?? p.h ?? 0) >= MIN_PX);
  if (real.length) return { kind: "positive", pairs: real.map((p) => [t.get(p.a), t.get(p.b)]), k: null, axis: "natural" };
  // Rects that touch by less than MIN_PX are neither a hit nor a false alarm (as 2 px in the synthetic set, D5).
  return { kind: (side.pairs || []).length ? "excluded" : "negative", pairs: [] };
}

function names(f, pair, w, h) {
  const [pa, pb] = pair;
  const A = px(f.a.box, w, h);
  if (!f.b) return inter(A, pa) > 0 && inter(A, pb) > 0;
  const B = px(f.b.box, w, h);
  return (inter(A, pa) > 0 && inter(B, pb) > 0) || (inter(A, pb) > 0 && inter(B, pa) > 0);
}

/** Every image under `dir`, through bench/overlap.js's batched runner (a hung Vision request is retried, TODO-032). */
function run(dir, locale, extra = []) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else if (/\.(png|jpe?g|heic)$/i.test(e.name)) files.push(f);
  } };
  walk(dir);
  return require("./overlap").run("overlap", files, locale, extra);
}

function games(root) {
  const out = { negatives: 0, negative_flags: 0, negative_images_flagged: [], positives: 0, found: 0, by_k: {}, by_axis: {}, excluded: 0, other_flags_on_positives: 0, apps: {} };
  for (const app of fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "manifest.json")))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, app, "manifest.json"), "utf8"));
    out.apps[app] = { game_commit: manifest.game_commit ?? null, dist_built: manifest.dist_built ?? null, tools: manifest.tools ?? manifest.versions ?? null };
    for (const locale of fs.readdirSync(path.join(root, app)).filter((d) => fs.statSync(path.join(root, app, d)).isDirectory())) {
      for (const env of run(path.join(root, app, locale), locale)) {
        const side = JSON.parse(fs.readFileSync(env.path.replace(/\.png$/, ".json"), "utf8"));
        const t = truth(side);
        const { width: w, height: h } = env.image;
        const fs_ = env.findings || [];
        if (t.kind === "excluded") { out.excluded++; continue; }
        if (t.kind === "negative") {
          out.negatives++;
          out.negative_flags += fs_.length;
          if (fs_.length) out.negative_images_flagged.push({ path: path.relative(ROOT, env.path), findings: fs_.map((f) => f.line) });
          continue;
        }
        out.positives++;
        const hit = fs_.some((f) => t.pairs.some((p) => names(f, p, w, h)));
        out.found += hit ? 1 : 0;
        out.other_flags_on_positives += fs_.filter((f) => !t.pairs.some((p) => names(f, p, w, h))).length;
        for (const [key, g] of [[String(t.k), out.by_k], [t.axis, out.by_axis]]) {
          g[key] = g[key] || { images: 0, found: 0 };
          g[key].images++;
          g[key].found += hit ? 1 : 0;
        }
      }
    }
  }
  for (const g of [out.by_k, out.by_axis]) for (const v of Object.values(g)) { v.recall = Number((v.found / v.images).toFixed(4)); v.wilson95 = wilson(v.found, v.images); }
  out.recall = out.positives ? Number((out.found / out.positives).toFixed(4)) : null;
  out.recall_wilson95 = wilson(out.found, out.positives);
  out.false_alarms_per_100 = out.negatives ? Number((100 * out.negative_flags / out.negatives).toFixed(2)) : null;
  return out;
}

function study(dirs, reviewed) {
  const flags = [];
  let images = 0;
  for (const dir of dirs) {
    for (const env of run(dir, null)) {
      images++;
      for (const f of env.findings || []) flags.push({ path: env.path, line: f.line, signal: f.signal, box: f.box, verdict: reviewed[env.path]?.[f.line] ?? reviewed[env.path] ?? "unreviewed" });
    }
  }
  const fa = flags.filter((f) => f.verdict !== "real");
  return { images, flags: flags.length, unreviewed: flags.filter((f) => f.verdict === "unreviewed").length, real_overlaps: flags.length - fa.length,
    false_alarms: fa.length, false_alarms_per_100: images ? Number((100 * fa.length / images).toFixed(2)) : null, list: flags };
}

/** D21: how often each threshold flags real negative screens (game screens with no touching rects, each study dir). */
function sweep(ts, gamesRoot, studyDirs) {
  const extra = ["--min-overlap", String(Math.min(...ts))];
  const sets = {};
  const add = (name, env) => { (sets[name] = sets[name] || []).push((env.findings || []).map((f) => f.overlap)); };
  if (gamesRoot) for (const app of fs.readdirSync(gamesRoot).filter((d) => fs.existsSync(path.join(gamesRoot, d, "manifest.json")))) {
    for (const locale of fs.readdirSync(path.join(gamesRoot, app)).filter((d) => fs.statSync(path.join(gamesRoot, app, d)).isDirectory())) {
      for (const env of run(path.join(gamesRoot, app, locale), locale, extra)) {
        if (truth(JSON.parse(fs.readFileSync(env.path.replace(/\.png$/, ".json"), "utf8"))).kind === "negative") add(`${app} natural`, env);
      }
    }
  }
  for (const dir of studyDirs) for (const env of run(dir, null, extra)) add(path.basename(dir), env);
  const out = {};
  for (const t of ts) {
    out[t] = {};
    for (const [name, screens] of Object.entries(sets)) {
      const flags = screens.reduce((n, o) => n + o.filter((x) => x >= t).length, 0);
      out[t][name] = { screens: screens.length, flags, per_100: Number((100 * flags / screens.length).toFixed(2)) };
    }
  }
  return out;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
  const one = (k) => all(k)[0] ?? null;
  if (one("--sweep")) {
    const ts = one("--sweep").split(",").map(Number);
    const v = versionInfo();
    process.stdout.write(JSON.stringify({ spec: "12", script: "bench/overlap-real.js --sweep", min_px: MIN_PX, thresholds: sweep(ts, one("--games"), all("--study")),
      catscan: v.catscan, macos: v.macos, vision_revision: v.vision_revision, node: process.version }, null, 1) + "\n");
    process.exit(0);
  }
  const reviewed = one("--reviewed") ? JSON.parse(fs.readFileSync(one("--reviewed"), "utf8")) : {};
  const g = one("--games") ? games(one("--games")) : null;
  const s = all("--study").length ? study(all("--study"), reviewed) : null;
  if (one("--review") && s) fs.writeFileSync(one("--review"), JSON.stringify(s.list, null, 1));
  const v = versionInfo();
  const negatives = (g ? g.negatives : 0) + (s ? s.images : 0);
  const fa = (g ? g.negative_flags : 0) + (s ? s.false_alarms : 0);
  const result = {
    spec: "12", script: "bench/overlap-real.js", capture: "game capture (not published)", min_px: MIN_PX,
    games: g, study: s ? { ...s, list: undefined } : null,
    real_negative_screens: negatives, false_alarms: fa, false_alarms_per_100: negatives ? Number((100 * fa / negatives).toFixed(2)) : null,
    catscan: v.catscan, macos: v.macos, vision_revision: v.vision_revision, node: process.version,
  };
  process.stdout.write(JSON.stringify(result, null, 1) + "\n");
}

module.exports = { truth, names, wilson, sweep, MIN_PX };
