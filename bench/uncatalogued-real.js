#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T4 real-screen leg (D55): `untranslated --uncatalogued` over real screens with the apps' own catalogs, as a
// project runs it. The sets come from a config file kept outside git, because it names the apps' catalog files:
// {"sets": [{"name", "screens": "<dir of <locale>/ folders>", "catalog": ["<.../{locale}.json>", ...], "base": "<en
// catalog>", "map": {"<folder>": "<locale>"}}]}.
// 1. Organic: every flag gets an id (sha256 of image path and line); --detail <file> writes the flags with their text
//    for judging by eye, outside the repo (spec 06 Privacy); verdicts go to results/uncatalogued-review.json by id.
// 2. Injected (D55): per set, up to 30 catalog strings Vision reads whole on a screen (unique text over every file,
//    2 words or 8 letters) are deleted from a copy of the catalogs; each is then a known uncatalogued line, so recall
//    on real screens is measured and precision has a denominator.
// 3. Status band: the lines in the top 4% band that the guard keeps out, and whether any injected line sits there.
// Usage: node bench/uncatalogued-real.js <config.json> [--detail <file>] [--review results/uncatalogued-review.json]
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const CLI = path.join(__dirname, "../bin/catscan.js");
const args = process.argv.slice(2);
const opt = (name) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : null; };
const detail = opt("--detail");
const reviewFile = opt("--review");
if (!args[0]) throw new Error("usage: node bench/uncatalogued-real.js <config.json> [--detail <file>] [--review <file>]");
const SETS = JSON.parse(fs.readFileSync(args[0], "utf8")).sets;
const INJECT = 30, BAND = 0.04;
const sub = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const id = (file, line) => crypto.createHash("sha256").update(`${file}\n${line}`).digest("hex").slice(0, 16);
const norm = (s) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const floor = (t) => t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= 2 || [...t].filter((c) => /\p{L}/u.test(c)).length >= 8;
// An injected line another catalog string explains under the rule (D48 exact, a cut of 60%, fuzzy 0.2 in any
// locale) is rightly not flagged; recall is published over all injections and over the unexplained ones.
const canon = (s) => s.normalize("NFKC").toLowerCase().replace(/^[\s.,!?:;'"·>›<‹»«]+|[\s.,!?:;'"·>›<‹»«]+$/gu, "");
function lev(a, b, max) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let lo = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); lo = Math.min(lo, cur[j]); }
    if (lo > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function explained(line, others) {
  const t = [...canon(line)];
  for (const o of others) {
    const w = [...o];
    if (w.join("") === t.join("")) return true;
    if (w.length > t.length && w.slice(0, t.length).join("") === t.join("") && t.length >= 0.6 * w.length) return true;
    if (w.length >= Math.floor(t.length * 0.8) && w.length <= Math.ceil(t.length * 1.2)) { const k = Math.floor(0.2 * Math.max(w.length, t.length)); if (lev(t, w, k) <= k) return true; }
  }
  return false;
}
const ratio = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Number(Math.max(0, c - h).toFixed(4)), Number(Math.min(1, c + h).toFixed(4))];
}
function rng(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function run(argv) {
  const r = spawnSync(process.execPath, [CLI, ...argv, "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CATSCAN_VISION_TIMEOUT: process.env.CATSCAN_VISION_TIMEOUT || "180" } });
  if (r.status !== 0 && r.status !== 1) throw new Error(`catscan ${argv.join(" ")}: exit ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((x) => JSON.parse(x));
}
/** Every file of the templates (and the base), flattened: [{file, template, locale, key, text}]. */
function strings(set) {
  const out = [];
  const files = [];
  for (const [ti, t] of set.catalog.entries()) {
    const dir = path.dirname(t), pat = path.basename(t);
    const [pre, post] = pat.split("{locale}");
    for (const f of fs.readdirSync(dir)) if (f.startsWith(pre) && f.endsWith(post)) files.push({ file: path.join(dir, f), ti, locale: f.slice(pre.length, f.length - post.length) });
  }
  if (set.base) files.push({ file: set.base, ti: -1, locale: "base" });
  for (const f of files) {
    let o;
    try { o = JSON.parse(fs.readFileSync(f.file, "utf8")); } catch { continue; }
    const walk = (v, k) => { if (typeof v === "string") out.push({ ...f, key: k, text: v }); else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, k ? `${k}.${kk}` : kk); };
    walk(o, "");
  }
  return out;
}
/** A copy of the set's catalogs without `keys` (in every locale), for the injected run. */
function without(set, keys, dir) {
  const copy = { ...set, catalog: set.catalog.map((t, ti) => path.join(dir, String(ti), path.basename(t))), base: set.base ? path.join(dir, "base", path.basename(set.base)) : null };
  const strip = (o, prefix) => { for (const k of Object.keys(o)) { const kk = prefix ? `${prefix}.${k}` : k; if (typeof o[k] === "string") { if (keys.has(kk)) delete o[k]; } else if (o[k] && typeof o[k] === "object") strip(o[k], kk); } return o; };
  for (const [ti, t] of set.catalog.entries()) {
    const src = path.dirname(t), dst = path.join(dir, String(ti));
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) if (f.endsWith(".json")) { try { fs.writeFileSync(path.join(dst, f), JSON.stringify(strip(JSON.parse(fs.readFileSync(path.join(src, f), "utf8")), ""))); } catch { /* not a catalog */ } }
  }
  if (set.base) { fs.mkdirSync(path.join(dir, "base"), { recursive: true }); fs.writeFileSync(copy.base, JSON.stringify(strip(JSON.parse(fs.readFileSync(set.base, "utf8")), ""))); }
  return copy;
}
const cmd = (set, dir, locale) => ["untranslated", dir, "--locale", locale, ...(set.base ? ["--base", set.base] : []), ...set.catalog.flatMap((c) => ["--catalog", c]), "--uncatalogued", "--experimental", "--kinds", "uncatalogued"];

const out = { script: "bench/uncatalogued-real.js", sets: {} };
const flags = [];
const missText = []; // injected misses with their text, for --detail only (outside the repo)
const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-uncatalogued-real-"));
const injected = { seeded: 0, found: 0, misses: [], unexplained: 0, unexplainedFound: 0 };
const band = { lines_in_band: 0, eligible_in_band: 0, injected_in_band: 0 };
for (const set of SETS) {
  let screens = 0, flagged = 0, n = 0;
  const all = strings(set);
  const textCount = new Map();
  for (const s of all) textCount.set(norm(s.text), (textCount.get(norm(s.text)) || 0) + 1);
  const picks = [];
  for (const folder of sub(set.screens)) {
    const locale = (set.map || {})[folder] ?? folder, dir = path.join(set.screens, folder);
    for (const env of run(cmd(set, dir, locale))) {
      if (env.verdict === "error" || env.verdict === "unsupported") throw new Error(`${env.path}: ${env.error?.code}`);
      screens++;
      const w = env.findings.filter((f) => f.kind === "uncatalogued");
      if (w.length) flagged++;
      for (const f of w) {
        n++;
        const rel = path.join(set.name, path.relative(set.screens, env.path));
        flags.push({ id: id(rel, f.line), set: set.name, locale, image: rel, line: f.line, nearest: f.nearest, language: f.language });
      }
    }
    // Injection candidates: whole catalog strings of this locale that Vision reads on a screen, unique everywhere.
    const own = new Map(all.filter((s) => s.locale === locale).map((s) => [norm(s.text), s]));
    for (const env of run(["read", dir, "--locale", locale])) {
      for (const l of env.lines || []) {
        const mid = l.box ? l.box[1] + l.box[3] / 2 : 1;
        if (mid < BAND) { band.lines_in_band++; if (floor(l.text) && !/^[\d\s:.%,/+-]+$/.test(l.text)) band.eligible_in_band++; }
        const s = own.get(norm(l.text));
        if (s && floor(l.text) && textCount.get(norm(s.text)) === 1) picks.push({ ...s, line: l.text, image: env.path, locale, folder, mid });
      }
    }
  }
  // Up to INJECT distinct keys, seeded; each key's lines on that locale's screens are the injected truth.
  const rand = rng(36004);
  const byKey = new Map();
  for (const p of picks) if (!byKey.has(p.key)) byKey.set(p.key, p);
  const chosen = [...byKey.values()].sort(() => rand() - 0.5).slice(0, INJECT);
  const keys = new Set(chosen.map((c) => c.key));
  const copy = without(set, keys, path.join(work, set.name));
  const truth = picks.filter((p) => keys.has(p.key));
  for (const t of truth) if (t.mid < BAND) band.injected_in_band++;
  const others = [...new Set(all.filter((s) => !keys.has(s.key)).map((s) => canon(s.text)))];
  for (const t of truth) t.explained = explained(t.line, others);
  const folders = [...new Set(truth.map((t) => t.folder))];
  let found = 0;
  for (const folder of folders) {
    const locale = (set.map || {})[folder] ?? folder;
    const envs = Object.fromEntries(run(cmd(copy, path.join(set.screens, folder), locale)).map((e) => [e.path, e]));
    for (const t of truth.filter((x) => x.folder === folder)) {
      const hit = (envs[t.image]?.findings || []).some((f) => f.kind === "uncatalogued" && norm(f.line).includes(norm(t.line)));
      if (!t.explained) { injected.unexplained++; if (hit) injected.unexplainedFound++; }
      if (hit) found++;
      else {
        const rel = path.join(set.name, path.relative(set.screens, t.image));
        injected.misses.push({ set: set.name, id: id(rel, t.line) });
        missText.push({ set: set.name, image: rel, key: t.key, line: t.line, explained: t.explained, flagged: (envs[t.image]?.findings || []).filter((f) => f.kind === "uncatalogued").map((f) => f.line) });
      }
    }
  }
  injected.seeded += truth.length;
  injected.found += found;
  out.sets[set.name] = { screens, flagged_screens: flagged, flags: n, flags_per_100_screens: Number((100 * n / Math.max(1, screens)).toFixed(2)), injected_keys: keys.size, injected_lines: truth.length, injected_found: found };
}
out.organic_flag_ids = flags.map(({ id: i, set, locale }) => ({ id: i, set, locale }));
out.injected = { lines: injected.seeded, found: injected.found, recall: ratio(injected.found, injected.seeded), recall_ci95: wilson(injected.found, injected.seeded),
  unexplained: { lines: injected.unexplained, found: injected.unexplainedFound, recall: ratio(injected.unexplainedFound, injected.unexplained), recall_ci95: wilson(injected.unexplainedFound, injected.unexplained),
    note: "injections no other catalog string explains under the rule (exact, a 60% cut, fuzzy 0.2, any locale)" },
  misses: injected.misses.slice(0, 20) };
out.status_band = { ...band, note: "lines centered in the top 4% of the screen (the guard keeps them out); eligible: 2 words or 8 letters and not only digits" };
if (detail) {
  fs.writeFileSync(detail, JSON.stringify(flags, null, 2));
  fs.writeFileSync(detail.replace(/\.json$/, "") + ".misses.json", JSON.stringify(missText, null, 2));
}
if (reviewFile) {
  const verdicts = Object.fromEntries(JSON.parse(fs.readFileSync(reviewFile, "utf8")).verdicts.map((v) => [v.id, v]));
  const judged = flags.filter((f) => verdicts[f.id]);
  const tp = judged.filter((f) => verdicts[f.id].verdict === "true").length;
  // D55: precision over organic and injected flags; injected flags are true by construction.
  const all = judged.length + injected.found, trueAll = tp + injected.found;
  out.review = { organic_flags: flags.length, judged: judged.length, unjudged: flags.length - judged.length, organic_true: tp, organic_false: judged.length - tp,
    precision: ratio(trueAll, all), precision_ci95: wilson(trueAll, all), false_flags_per_100_screens: Number((100 * (judged.length - tp) / Math.max(1, Object.values(out.sets).reduce((s, x) => s + x.screens, 0))).toFixed(2)),
    gate: { precision: 0.90 }, pass: all > 0 && trueAll / all >= 0.90 && judged.length === flags.length };
  // Categories: true flags split into hardcoded text, strings of an older build, and files the run did not load; the
  // strict precision counts only hardcoded text as true.
  const by = {};
  for (const f of judged) { const k = `${verdicts[f.id].verdict}:${verdicts[f.id].category || "none"}`; by[k] = (by[k] || 0) + 1; }
  const hard = judged.filter((f) => verdicts[f.id].verdict === "true" && verdicts[f.id].category === "hardcoded").length + injected.found;
  Object.assign(out.review, { by_category: by, precision_hardcoded_only: ratio(hard, all), precision_hardcoded_only_ci95: wilson(hard, all) });
}
const v = versionInfo();
out.tools = { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version };
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
