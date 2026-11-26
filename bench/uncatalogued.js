#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T4 gate (D46, D47, D53, D54): precision and recall of `uncatalogued` on a synthetic set, with Wilson 95%
// intervals, and the time per image against `check` with 13 catalogs of 1,100 strings.
// Usage: node bench/uncatalogued.js > results/uncatalogued.json   (exit 1 when a gate fails)
// Catalogs are T2's bench/wrong-language/strings.json (13 locales x 39 keys), passed as a project would:
// --base en.json --catalog '{locale}.json'. 12 run locales x 50 screens of 8-12 catalog strings drawn with
// test/fixtures/generate.swift. Positives come from bench/uncatalogued/strings.json: 0-2 run-language sentences no
// catalog holds per screen (each sentence on at most 2 screens, D47) and near-catalog prose (0.25-0.40 from a
// catalog string). Negatives: every catalog string as Vision reads it, another locale's string for a key (D50), and
// dynamic lines with the guard a project sets (D54): names and user lines in `dynamic: true` elements, server titles
// and handles under --dynamic regexes, values (isFormatted), a status-bar line and allowed brand decoys.
// Two runs over the same screens: configured (the gate) and out of the box (no --dynamic, no boxes; published).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { editDistance } = require("../packages/core-js/src/args");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const S = require("./wrong-language/strings.json");
const U = require("./uncatalogued/strings.json");
const ALL = Object.keys(S.locales);
const BASE = "en";
const LOCALES = Object.keys(U.seeds).filter((l) => !process.env.BENCH_LOCALES || process.env.BENCH_LOCALES.split(",").includes(l));
const SCREENS = 50, WIDTH = 1100, SIZE = 34, STEP = 64, TOP = 70;
const GATE = { precision: 0.95, recall: 0.80 };
const PERF_KEYS = 1100, PERF_COPIES = 20, PERF_BUDGET_MS = 50;
const VALUES = ["12:30", "1 250", "3 / 10", "45%", "x2", "Lv 12", "250 pts", "4.8", "+15"];

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const fill = (s) => s.replace("{count}", "3").replace("{name}", "Anna").replace("%d", "5");
const norm = (s) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const ratio = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const dist = (a, b) => { const x = norm(a), y = norm(b); return editDistance(x, y) / Math.max(1, x.length, y.length); };

/** Wilson score interval, 95%. */
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Number(Math.max(0, c - h).toFixed(4)), Number(Math.min(1, c + h).toFixed(4))];
}
/** DynamicText.eligible: 2 words or 8 letters (a word is a run with a letter). */
const floor = (t) => t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= 2 || [...t].filter((c) => /\p{L}/u.test(c)).length >= 8;

function catalogs(dir) {
  for (const l of ALL) fs.writeFileSync(path.join(dir, `${l}.json`), JSON.stringify(Object.fromEntries(S.keys.map((k, i) => [k, S.locales[l][i]]))));
}

/** The guards a project sets (D54): server titles and handles by pattern, brand decoys by --allow. */
function guards(dir) {
  const dyn = ["# TODO-036 T4 bench: server titles per locale and user handles", "^@[\\w.]+$", ...new Set(Object.values(U.dynamic.server).map((s) => s.pattern))];
  fs.writeFileSync(path.join(dir, "dynamic.txt"), dyn.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "allow.txt"), ["# brands and contact strings", ...S.decoys.filter((d) => /\p{L}{2,}/u.test(d))].join("\n") + "\n");
}

/** One locale's screens: lines (with an optional own y), the rows that are dynamic elements, and the positives. */
function screens(locale, rand) {
  const own = S.locales[locale];
  const others = ALL.filter((l) => l !== locale);
  const idx = S.keys.map((_, i) => i).filter((i) => S.keys[i] !== "brand.name");
  const uses = new Map(U.seeds[locale].map((s) => [s, 0]));
  const out = [];
  const counts = { seeds: 0, near: 0, dynamic: 0, other_locale: 0, status: 0, decoys: 0 };
  for (let n = 0; n < SCREENS; n++) {
    const pick = [...idx].sort(() => rand() - 0.5).slice(0, 8 + Math.floor(rand() * 5));
    const rows = pick.map((i) => ({ text: fill(own[i]), kind: "catalog" }));
    const put = (row) => rows.splice(Math.floor(rand() * (rows.length + 1)), 0, row);
    const k = Math.floor(rand() * 3);
    for (let s = 0; s < k; s++) {
      const free = [...uses].filter(([, c]) => c < 2).map(([t]) => t);
      if (!free.length) break;
      const t = free[Math.floor(rand() * free.length)];
      uses.set(t, uses.get(t) + 1);
      put({ text: t, kind: "seed" });
      counts.seeds++;
    }
    if (rand() < 0.15 && U.near[locale]?.length) { put({ text: U.near[locale][Math.floor(rand() * U.near[locale].length)].text, kind: "near" }); counts.near++; }
    if (rand() < 0.3) { // another locale's string for a key: in a loaded catalog, so never uncatalogued (D50)
      const m = others[Math.floor(rand() * others.length)], i = idx[Math.floor(rand() * idx.length)];
      put({ text: fill(S.locales[m][i]), kind: "other-locale" });
      counts.other_locale++;
    }
    // About 20% dynamic lines, each with its project guard (D54).
    const dynamic = Math.max(1, Math.round(rows.length * 0.25));
    for (let d = 0; d < dynamic; d++) {
      const r = rand();
      const row = r < 0.25 ? { text: U.dynamic.names[Math.floor(rand() * U.dynamic.names.length)], kind: "name", element: true }
        : r < 0.45 ? { text: U.dynamic.user[locale][Math.floor(rand() * U.dynamic.user[locale].length)], kind: "user", element: true }
        : r < 0.65 ? { text: U.dynamic.server[locale].titles[Math.floor(rand() * U.dynamic.server[locale].titles.length)], kind: "server" }
        : r < 0.8 ? { text: U.dynamic.handles[Math.floor(rand() * U.dynamic.handles.length)], kind: "handle" }
        : { text: VALUES[Math.floor(rand() * VALUES.length)], kind: "value" };
      put(row);
      counts.dynamic++;
    }
    if (n % 6 === 0) { rows.push({ text: S.decoys[n % S.decoys.length], kind: "decoy" }); counts.decoys++; }
    if (n % 10 === 0) { rows.unshift({ text: "Carrier signal strong now", kind: "status", y: 6, size: 16 }); counts.status++; }
    out.push({ name: `${locale}-${String(n).padStart(2, "0")}.png`, rows });
  }
  return { list: out, counts };
}

function layout(s) {
  let y = TOP;
  const lines = s.rows.map((r) => {
    if (r.y !== undefined) return { text: r.text, x: 40, y: r.y, size: r.size };
    const l = { text: r.text, x: 40, y, size: SIZE };
    y += STEP;
    return l;
  });
  return { lines, height: y + 30 };
}

function draw(gen, dir, list, locale) {
  const manifest = list.map((s) => { const { lines, height } = layout(s); return { name: s.name, locale, width: WIDTH, height, lines }; });
  const f = path.join(dir, "screens.json");
  fs.writeFileSync(f, JSON.stringify(manifest));
  execFileSync(gen, [f, dir], { stdio: "ignore" });
  fs.rmSync(f);
  // D54: a project's boxes mark name and user-text cells `dynamic: true`; the generator's rows are full-width cells.
  const boxes = path.join(dir, "boxes");
  fs.mkdirSync(boxes);
  for (const s of list) {
    const { lines, height } = layout(s);
    const elements = s.rows.map((r, i) => ({ r, l: lines[i] })).filter(({ r }) => r.element).map(({ r, l }, i) => ({
      id: `d${i}`, box: [0, (l.y - l.size * 0.35) / height, 1, (l.size * 1.7) / height], text: r.text, dynamic: true,
    }));
    fs.writeFileSync(path.join(boxes, s.name.replace(/\.png$/, ".boxes.json")), JSON.stringify({ image: { width: WIDTH, height }, elements }));
  }
  return boxes;
}

function run(args, tries = 3) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", maxBuffer: 1 << 30, env: { ...process.env, CATSCAN_VISION_TIMEOUT: process.env.CATSCAN_VISION_TIMEOUT || "180" } });
  if (r.status === 4 && /vision-timeout/.test(r.stderr) && tries > 1) return run(args, tries - 1);
  if (r.status !== 0 && r.status !== 1) throw new Error(`catscan ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const tally = () => ({ tp: 0, fp: 0, eligible: 0, eligible_found: 0, seeded: 0, found: 0, fps: [], fns: [], near: { seeded: 0, found: 0 }, bySentence: new Map() });

/** One screen: findings matched one-to-one to positives by line (D49: OCR lines, not joined text). */
function score(env, s, read, t, locale) {
  const got = env.findings.filter((f) => f.kind === "uncatalogued");
  const want = s.rows.filter((r) => r.kind === "seed" || r.kind === "near");
  const left = [...want];
  for (const f of got) {
    const at = left.findIndex((r) => dist(f.line, r.text) <= 0.25 || norm(r.text).includes(norm(f.line)) && norm(f.line).length >= 8);
    if (at < 0) {
      const what = s.rows.find((r) => dist(f.line, r.text) <= 0.25) || { kind: "unknown" };
      t.fp++;
      t.fps.push({ locale, screen: s.name, line: f.line, kind: what.kind });
      continue;
    }
    left.splice(at, 1);
    t.tp++;
  }
  for (const r of want) {
    const found = !left.includes(r);
    const readable = read.some((l) => dist(l, r.text) <= 0.2);
    const eligible = readable && floor(r.text);
    if (r.kind === "near") { t.near.seeded++; if (found) t.near.found++; }
    t.seeded++;
    if (found) t.found++;
    if (eligible) {
      t.eligible++;
      if (found) t.eligible_found++;
      else t.fns.push({ locale, screen: s.name, line: r.text });
      const k = `${locale}\0${r.text}`;
      const b = t.bySentence.get(k) || { n: 0, found: 0 };
      b.n++;
      if (found) b.found++;
      t.bySentence.set(k, b);
    }
  }
}

function summary(t, gate) {
  const precision = ratio(t.tp, t.tp + t.fp), recall = ratio(t.eligible_found, t.eligible);
  const sentences = [...t.bySentence.values()];
  const whole = sentences.filter((b) => b.found === b.n).length;
  const o = {
    tp: t.tp, fp: t.fp, precision, precision_ci95: wilson(t.tp, t.tp + t.fp),
    recall, recall_ci95: wilson(t.eligible_found, t.eligible), eligible: t.eligible, eligible_share: ratio(t.eligible, t.seeded),
    recall_all: ratio(t.found, t.seeded), recall_all_ci95: wilson(t.found, t.seeded),
    // D47: per unique sentence, so one sentence repeated is not counted as many independent finds.
    recall_by_sentence: ratio(whole, sentences.length), recall_by_sentence_ci95: wilson(whole, sentences.length), sentences: sentences.length,
    near_catalog: { seeded: t.near.seeded, found: t.near.found, recall: ratio(t.near.found, t.near.seeded) },
    false_positives_by_kind: t.fps.reduce((m, f) => ({ ...m, [f.kind]: (m[f.kind] || 0) + 1 }), {}),
  };
  if (gate) o.pass = (precision ?? 1) >= gate.precision && (recall ?? 0) >= gate.recall;
  o.false_positives = t.fps.slice(0, 30);
  o.misses = process.env.BENCH_ALL_MISSES ? t.fns : t.fns.slice(0, 20);
  return o;
}

function perf(gen, dir) {
  const words = (l) => [...new Set(S.locales[l].flatMap((s) => s.split(/\s+/)).filter((w) => /\p{L}{3,}/u.test(w)))];
  const rand = rng(29);
  for (const l of ALL) {
    const w = words(l);
    fs.writeFileSync(path.join(dir, `${l}.json`), JSON.stringify(Object.fromEntries(Array.from({ length: PERF_KEYS }, (_, i) => [`screen.k${i}`, `${w[Math.floor(rand() * w.length)]} ${w[Math.floor(rand() * w.length)]} ${w[Math.floor(rand() * w.length)]} ${i}`]))));
  }
  // All-miss lines (D53's worst case): sentences no catalog holds, so every line goes through the fuzzy search.
  const lines = Array.from({ length: 20 }, (_, i) => U.seeds.de[i % U.seeds.de.length]);
  const shots = path.join(dir, "shots");
  fs.mkdirSync(shots);
  const manifest = Array.from({ length: PERF_COPIES }, (_, i) => ({ name: `p${String(i).padStart(2, "0")}.png`, locale: "de", width: 1290, height: 2790, lines: lines.map((t, k) => ({ text: t, x: 40, y: 120 + k * 120, size: 44 })) }));
  fs.writeFileSync(path.join(shots, "screens.json"), JSON.stringify(manifest));
  execFileSync(gen, [path.join(shots, "screens.json"), shots], { stdio: "ignore" });
  fs.rmSync(path.join(shots, "screens.json"));
  const time = (args) => {
    const wall = [], cpu = [];
    for (let k = 0; k < 3; k++) {
      const r = spawnSync("/usr/bin/time", ["-p", process.execPath, CLI, ...args, "--json"], { encoding: "utf8", maxBuffer: 1 << 30 });
      if (r.status !== 0 && r.status !== 1) throw new Error(`catscan ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
      const v = (name) => Number((r.stderr.match(new RegExp(`^${name} ([0-9.]+)$`, "m")) || [])[1]);
      wall.push(v("real") * 1000 / PERF_COPIES);
      cpu.push((v("user") + v("sys")) * 1000 / PERF_COPIES);
    }
    return { wall: Number(median(wall).toFixed(1)), cpu: Number(median(cpu).toFixed(1)) };
  };
  const load = Number(os.loadavg()[0].toFixed(1));
  const cat = ["--base", path.join(dir, "en.json"), "--catalog", path.join(dir, "{locale}.json")];
  const check = time(["check", shots, "--locale", "de", "--present", lines[0]]);
  const without = time(["untranslated", shots, "--locale", "de", ...cat, "--kinds", "untranslated,raw-key,placeholder"]);
  const unc = time(["untranslated", shots, "--locale", "de", ...cat, "--kinds", "untranslated,raw-key,placeholder,uncatalogued", "--experimental"]);
  // D53 microbenchmark: the rule alone, built with the core sources into one module (bench/uncatalogued/micro.swift).
  const micro = path.join(dir, "micro");
  fs.mkdirSync(micro);
  fs.copyFileSync(path.join(__dirname, "uncatalogued/micro.swift"), path.join(micro, "main.swift"));
  const core = path.join(ROOT, "core/Sources/CatscanCore");
  execFileSync("swiftc", ["-O", "-module-name", "CatscanMicro", path.join(micro, "main.swift"), ...fs.readdirSync(core).filter((f) => f.endsWith(".swift")).map((f) => path.join(core, f)), "-o", path.join(micro, "micro")], { stdio: "ignore" });
  const m = JSON.parse(execFileSync(path.join(micro, "micro"), [path.join(__dirname, "wrong-language/strings.json")], { encoding: "utf8" }));
  return { microbenchmark: { ...m, load_average_1m: Number(os.loadavg()[0].toFixed(1)) },
    catalogs: ALL.length, keys_per_catalog: PERF_KEYS, image: "1290x2790, 20 all-miss lines", copies: PERF_COPIES,
    check_ms_per_image: check.wall, untranslated_ms_per_image: without.wall, uncatalogued_ms_per_image: unc.wall,
    cpu_ms_per_image: { check: check.cpu, untranslated: without.cpu, uncatalogued: unc.cpu },
    load_average_1m: { start: load, end: Number(os.loadavg()[0].toFixed(1)) }, cores: os.cpus().length,
    budget_ms: PERF_BUDGET_MS, pass: unc.wall <= check.wall + PERF_BUDGET_MS && m.pass };
}

function main() {
  const gen = path.join(ROOT, ".build/synth");
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  execFileSync("swiftc", ["-O", path.join(ROOT, "test/fixtures/generate.swift"), "-o", gen]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-uncatalogued-bench-"));
  const cdir = path.join(work, "catalogs");
  fs.mkdirSync(cdir);
  catalogs(cdir);
  guards(cdir);
  const T = { configured: tally(), out_of_box: tally() };
  const totals = { screens: 0, seeds: 0, near: 0, dynamic: 0, other_locale: 0, status: 0, decoys: 0 };
  const perLocale = {};
  const rand = rng(36004);
  for (const locale of LOCALES) {
    const { list, counts } = screens(locale, rand);
    for (const [k, v] of Object.entries(counts)) totals[k] += v;
    totals.screens += list.length;
    const shots = path.join(work, locale);
    fs.mkdirSync(shots);
    const boxes = draw(gen, shots, list, locale);
    const common = ["untranslated", shots, "--locale", locale, "--base", path.join(cdir, `${BASE}.json`), "--catalog", path.join(cdir, "{locale}.json"), "--uncatalogued", "--experimental", "--allow", path.join(cdir, "allow.txt")];
    const configured = run([...common, "--dynamic", path.join(cdir, "dynamic.txt"), "--boxes", boxes]);
    const plain = run(common);
    const read = run(["read", shots, "--locale", locale]);
    const byName = (envs) => Object.fromEntries(envs.map((e) => [path.basename(e.path), e]));
    const [a, b, r] = [byName(configured), byName(plain), byName(read)];
    const local = tally();
    for (const s of list) {
      for (const env of [a[s.name], b[s.name], r[s.name]]) if (!env || env.verdict === "error" || env.verdict === "unsupported") throw new Error(`${s.name}: ${env?.error?.code ?? "no envelope"}`);
      const lines = (r[s.name].lines || []).map((l) => l.text);
      // Joined neighbors may hold a seed Vision split in two (eligibility only).
      const readLines = [...lines, ...lines.slice(1).map((l, i) => `${lines[i]} ${l}`)];
      score(a[s.name], s, readLines, T.configured, locale);
      score(a[s.name], s, readLines, local, locale);
      score(b[s.name], s, readLines, T.out_of_box, locale);
    }
    perLocale[locale] = { tp: local.tp, fp: local.fp, eligible: local.eligible, found: local.eligible_found };
  }
  fs.mkdirSync(path.join(work, "perf"));
  const p = process.env.BENCH_NO_PERF ? { pass: true, skipped: true } : perf(gen, path.join(work, "perf"));
  const v = versionInfo();
  const result = {
    todo: "036 T4", script: "bench/uncatalogued.js", strings: ["bench/wrong-language/strings.json", "bench/uncatalogued/strings.json"], seed: 36004,
    locales: LOCALES, counts: totals, gate: GATE,
    configured: { ...summary(T.configured, GATE), note: "the gate (D54): --dynamic patterns, dynamic: true boxes and --allow, as a project sets them" },
    out_of_box: { ...summary(T.out_of_box, null), note: "published, not gated (D54): the same screens with --allow only, no --dynamic and no boxes" },
    per_locale: perLocale, perf: p,
    tools: { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version, icu: process.versions.icu, unicode: process.versions.unicode, generator: "test/fixtures/generate.swift", recognizer: "NaturalLanguage NLLanguageRecognizer (macOS system framework)" },
  };
  result.pass = result.configured.pass && p.pass;
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.pass ? 0 : 1;
}

module.exports = { screens, score, summary, tally, floor, layout, rng, LOCALES, SCREENS };
if (require.main === module) main();
