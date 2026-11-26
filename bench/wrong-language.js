#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T2 gate (D24, D28): precision and recall of `wrong-language` on a synthetic set, with Wilson 95%
// intervals, and the time per image against `check` with 12 catalogs of 1,100 strings.
// Usage: node bench/wrong-language.js > results/wrong-language.json   (exit 1 when a gate fails)
// The set is built from bench/wrong-language/strings.json with a fixed seed and drawn with
// test/fixtures/generate.swift: 12 run locales x 50 screens, 8-12 catalog strings each, 0-2 swapped for another
// project locale's string for the same key, and on about 30% of screens a foreign sentence no catalog holds
// (language-ID truth) and on about 30% a sentence in the run language no catalog holds (negative). Every 6th
// screen adds a decoy (brand, price, time). Two runs over the same screens:
//   combined:   --base en.json --catalog '{locale}.json'  (catalog evidence first, language ID on the rest)
//   standalone: --catalog <run>.json --languages <all others>  (language ID alone, D24)
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
const ALL = Object.keys(S.locales);
const BASE = "en";
const LOCALES = ALL.filter((l) => l !== BASE && (!process.env.BENCH_LOCALES || process.env.BENCH_LOCALES.split(",").includes(l)));
const SCREENS = 50;
const GATE = { catalog: { precision: 0.97, recall: 0.90 }, langid: { precision: 0.95 } };
const PERF_KEYS = 1100, PERF_COPIES = 20, PERF_BUDGET_MS = 50;

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const fill = (s) => s.replace("{count}", "3").replace("{name}", "Anna").replace("%d", "5");
// Scoring compares lines as read: Vision drops accents on screens of another script (`Anderungen`).
const norm = (s) => s.normalize("NFKC").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const ratio = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Wilson score interval, 95%. */
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Number(Math.max(0, c - h).toFixed(4)), Number(Math.min(1, c + h).toFixed(4))];
}

// The core's eligibility rules (WrongLanguage.swift), mirrored to report the share language ID could judge (D11).
const CLOSED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const NATIVE = { ru: ["Cyrillic"], uk: ["Cyrillic"], ja: ["Han", "Hiragana", "Katakana"], ko: ["Hangul", "Han"], "zh-Hans": ["Han"] };
// Scripts Vision reads for a run locale (Scripts.readable): a line in another script cannot be read on that screen.
const READS = { ru: ["Cyrillic"], uk: ["Cyrillic"], ja: ["Han", "Hiragana", "Katakana"], ko: ["Hangul", "Han"], "zh-Hans": ["Han"] };
const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Han", "Hiragana", "Katakana", "Hangul", "Thai"];
function readable(line, locale) {
  const ok = new Set(["Latin", ...(READS[locale] || [])]);
  return [...line].filter((c) => /\p{L}/u.test(c)).every((c) => ok.has(SCRIPTS.find((x) => new RegExp(`\\p{Script=${x}}`, "u").test(c))));
}
/** Spec 17's length rule for a matched string: 4 characters (2 for ja, ko, zh) once placeholders are filled. */
function checkable(str, m) {
  const n = norm(fill(str)).replace(/ /g, "");
  return [...n].length >= (["ja", "ko", "zh-Hans"].includes(m) ? 2 : 4) || norm(fill(str)).split(" ").length >= 2;
}
function eligible(line, locale) {
  const letters = [...line].filter((c) => /\p{L}/u.test(c));
  const closed = letters.filter((c) => CLOSED.test(c)).length;
  const words = line.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  const scripts = new Set(letters.map((c) => ["Latin", "Cyrillic", "Greek", "Han", "Hiragana", "Katakana", "Hangul", "Thai"].find((s) => new RegExp(`\\p{Script=${s}}`, "u").test(c)) || "Other"));
  const native = new Set(NATIVE[locale] || []);
  const one = [...scripts].filter((s) => s !== "Hiragana" && s !== "Katakana" && s !== "Han").length === 0 || scripts.size === 1;
  const foreign = letters.length >= 4 && one && !scripts.has("Latin") && ![...scripts].every((s) => native.has(s));
  if (foreign) return true;
  return closed * 2 > letters.length ? letters.length >= 8 : words >= 3 && letters.length >= 15;
}

function catalogs(dir) {
  for (const l of ALL) fs.writeFileSync(path.join(dir, `${l}.json`), JSON.stringify(Object.fromEntries(S.keys.map((k, i) => [k, S.locales[l][i]]))));
}

/** One locale's screens: lines and truth [{source: "catalog"|"langid", line, key?, language}]. */
function screens(locale, rand) {
  const own = S.locales[locale];
  const ownSet = new Set(own.map((s) => norm(fill(s))));
  const others = LOCALES.filter((l) => l !== locale);
  const idx = S.keys.map((_, i) => i).filter((i) => S.keys[i] !== "brand.name");
  const out = [];
  let ownSentences = 0;
  for (let n = 0; n < SCREENS; n++) {
    const pick = [...idx].sort(() => rand() - 0.5).slice(0, 8 + Math.floor(rand() * 5));
    const lines = pick.map((i) => fill(own[i]));
    const truth = [];
    const swaps = Math.floor(rand() * 3);
    const used = new Set();
    for (let s = 0; s < swaps; s++) {
      const m = others[Math.floor(rand() * others.length)];
      // A swap is a defect only when the other string differs from every run-locale string (shared strings, D35).
      // A string equal to the base (en) string is spec 17's untranslated finding, not this one's (D26).
      const cands = pick.map((i, at) => [i, at]).filter(([i, at]) => !used.has(at) && !ownSet.has(norm(fill(S.locales[m][i])))
        && norm(S.locales[m][i]) !== norm(S.locales[BASE][i]));
      if (!cands.length) continue;
      const [i, at] = cands[Math.floor(rand() * cands.length)];
      used.add(at);
      lines[at] = fill(S.locales[m][i]);
      const r = readable(lines[at], locale);
      truth.push({ source: "catalog", line: lines[at], key: S.keys[i], language: m, readable: r, run: locale,
        eligible: { catalog: r && checkable(S.locales[m][i], m), langid: r && eligible(lines[at], locale) } });
    }
    if (rand() < 0.3) { // a foreign sentence no catalog holds: language-ID truth (D28)
      const m = others[Math.floor(rand() * others.length)];
      const t = S.uncatalogued[m][Math.floor(rand() * S.uncatalogued[m].length)];
      lines.splice(Math.floor(rand() * (lines.length + 1)), 0, t);
      const r = readable(t, locale);
      truth.push({ source: "langid", line: t, language: m, readable: r, run: locale, eligible: { catalog: false, langid: r && eligible(t, locale) } });
    }
    if (rand() < 0.3) { // the run language, in no catalog (server content): a negative
      lines.splice(Math.floor(rand() * (lines.length + 1)), 0, S.uncatalogued[locale][Math.floor(rand() * S.uncatalogued[locale].length)]);
      ownSentences++;
    }
    if (n % 6 === 0) lines.push(S.decoys[n % S.decoys.length], fill(own[S.keys.indexOf("brand.name")]));
    out.push({ name: `${locale}-${String(n).padStart(2, "0")}.png`, lines, truth });
  }
  return { list: out, ownSentences };
}

function draw(gen, dir, list, locale, { width = 1100, size = 34, step = 64 } = {}) {
  const manifest = list.map((s) => ({
    name: s.name, locale, width, height: 80 + s.lines.length * step,
    lines: s.lines.map((t, i) => ({ text: t, x: 40, y: 40 + i * step, size })),
  }));
  const f = path.join(dir, "screens.json");
  fs.writeFileSync(f, JSON.stringify(manifest));
  execFileSync(gen, [f, dir], { stdio: "ignore" });
  fs.rmSync(f);
}

function run(args, tries = 3) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", maxBuffer: 1 << 30 });
  // A shared, loaded host sometimes stalls Vision past its timeout; the run is repeated whole, never patched.
  if (r.status === 4 && /vision-timeout/.test(r.stderr) && tries > 1) return run(args, tries - 1);
  if (r.status !== 0 && r.status !== 1) throw new Error(`catscan ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const same = (a, b) => { const x = norm(a), y = norm(b); return editDistance(x, y) <= Math.max(2, Math.floor(0.15 * Math.max(x.length, y.length))); };
const tally = () => ({ tp: 0, fp: 0, fn: 0, lang_ok: 0, fps: [], fns: [] });

/** Scores one screen. `truthFor(evidence)` picks the truth lines a finding of that evidence may claim. */
function score(found, truth, t, { evidence, want, claim, gate = evidence }) {
  const got = found.filter((f) => f.kind === "wrong-language" && f.evidence === evidence);
  const left = [...want];
  for (const f of got) {
    const at = claim.findIndex((x) => (x.key && f.key === x.key) || same(f.line, x.line));
    if (at < 0) { t.fp++; t.fps.push({ line: f.line, language: f.language }); continue; }
    const x = claim[at];
    const w = left.indexOf(x);
    if (w >= 0) { left.splice(w, 1); t.tp++; if (f.language === x.language) t.lang_ok++; }
    // A finding on a seeded line outside its own truth set (language ID catching a swap catalog evidence missed)
    // is a true flag, never a false one, and not counted toward this evidence's recall.
  }
  t.fn += left.length;
  for (const x of left) t.fns.push({ line: x.line, language: x.language, run: x.run, readable: x.readable });
  for (const x of want) {
    for (const r of [x.readable ? "readable" : "cross_script", ...(x.eligible[gate] ? ["eligible"] : [])]) {
      t[r] = t[r] || { seeded: 0, missed: 0 };
      t[r].seeded++;
      if (left.includes(x)) t[r].missed++;
    }
  }
}

function summary(t, gate) {
  // D11 / D29: recall is gated on the eligible lines (readable by Vision on that screen, long enough for the rule);
  // recall over every seeded line and the eligible share are published beside it.
  const e = t.eligible || { seeded: 0, missed: 0 };
  const precision = ratio(t.tp, t.tp + t.fp), recall = ratio(e.seeded - e.missed, e.seeded);
  const o = { tp: t.tp, fp: t.fp, fn: t.fn, precision, precision_ci95: wilson(t.tp, t.tp + t.fp), recall, recall_ci95: wilson(e.seeded - e.missed, e.seeded),
    eligible: e.seeded, eligible_share: ratio(e.seeded, t.tp + t.fn), recall_all: ratio(t.tp, t.tp + t.fn), recall_all_ci95: wilson(t.tp, t.tp + t.fn), language_correct: ratio(t.lang_ok, t.tp) };
  if (gate) o.pass = (gate.precision === undefined || (precision ?? 1) >= gate.precision) && (gate.recall === undefined || (recall ?? 0) >= gate.recall);
  o.false_positives = t.fps.slice(0, 20);
  for (const r of ["readable", "cross_script"]) if (t[r]) o[`recall_${r}`] = { seeded: t[r].seeded, found: t[r].seeded - t[r].missed, recall: ratio(t[r].seeded - t[r].missed, t[r].seeded), ci95: wilson(t[r].seeded - t[r].missed, t[r].seeded) };
  o.misses = process.env.BENCH_ALL_MISSES ? t.fns : t.fns.slice(0, 20);
  return o;
}

function perf(gen, dir) {
  const words = (l) => [...new Set(S.locales[l].concat(S.uncatalogued[l]).flatMap((s) => s.split(/\s+/)).filter((w) => /\p{L}{3,}/u.test(w)))];
  const rand = rng(29);
  const cat = {};
  for (const l of ALL) {
    const w = words(l);
    cat[l] = Object.fromEntries(Array.from({ length: PERF_KEYS }, (_, i) => [`screen.k${i}`, `${w[Math.floor(rand() * w.length)]} ${w[Math.floor(rand() * w.length)]} ${i}`]));
    fs.writeFileSync(path.join(dir, `${l}.json`), JSON.stringify(cat[l]));
  }
  const lines = Array.from({ length: 30 }, (_, i) => (i % 10 === 3 ? cat.es : cat.de)[`screen.k${i * 31}`]);
  const shots = path.join(dir, "shots");
  fs.mkdirSync(shots);
  draw(gen, shots, Array.from({ length: PERF_COPIES }, (_, i) => ({ name: `p${String(i).padStart(2, "0")}.png`, lines })), "de", { width: 1290, size: 44, step: 90 });
  // Wall time per image (the gate), and CPU time (user + sys of catscan and its core, from /usr/bin/time), which a
  // loaded host inflates far less; the 1-minute load average is recorded with each.
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
  const check = time(["check", shots, "--locale", "de", "--present", lines[0]]);
  const base = time(["untranslated", shots, "--locale", "de", "--base", path.join(dir, "en.json"), "--catalog", path.join(dir, "{locale}.json"), "--kinds", "untranslated,raw-key,placeholder"]);
  const wl = time(["untranslated", shots, "--locale", "de", "--base", path.join(dir, "en.json"), "--catalog", path.join(dir, "{locale}.json")]);
  return { catalogs: ALL.length, keys_per_catalog: PERF_KEYS, image: "1290x2790, 30 lines", copies: PERF_COPIES,
    check_ms_per_image: check.wall, untranslated_without_wrong_language_ms_per_image: base.wall, untranslated_ms_per_image: wl.wall,
    cpu_ms_per_image: { check: check.cpu, untranslated_without_wrong_language: base.cpu, untranslated: wl.cpu },
    load_average_1m: { start: load, end: Number(os.loadavg()[0].toFixed(1)) }, cores: os.cpus().length,
    budget_ms: PERF_BUDGET_MS, pass: wl.wall <= check.wall + PERF_BUDGET_MS };
}

(() => {
  const gen = path.join(ROOT, ".build/synth");
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  execFileSync("swiftc", ["-O", path.join(ROOT, "test/fixtures/generate.swift"), "-o", gen]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wrong-language-bench-"));
  const cdir = path.join(work, "catalogs");
  fs.mkdirSync(cdir);
  catalogs(cdir);
  const T = { catalog: tally(), langid: tally(), standalone: tally() };
  let screensTotal = 0, seededCatalog = 0, seededLangid = 0, ownSentences = 0, decoyScreens = 0;
  const perLocale = {};
  const rand = rng(36);
  for (const locale of LOCALES) {
    const { list, ownSentences: own } = screens(locale, rand);
    ownSentences += own;
    const shots = path.join(work, locale);
    fs.mkdirSync(shots);
    draw(gen, shots, list, locale);
    const combined = run(["untranslated", shots, "--locale", locale, "--base", path.join(cdir, `${BASE}.json`), "--catalog", path.join(cdir, "{locale}.json")]);
    const standalone = run(["untranslated", shots, "--locale", locale, "--catalog", path.join(cdir, `${locale}.json`), "--languages", ALL.filter((l) => l !== locale).join(",")]);
    const local = { catalog: tally(), langid: tally(), standalone: tally() };
    const byName = (envs) => Object.fromEntries(envs.map((e) => [path.basename(e.path), e]));
    const [a, b] = [byName(combined), byName(standalone)];
    for (const s of list) {
      for (const env of [a[s.name], b[s.name]]) if (!env || env.verdict === "error" || env.verdict === "unsupported") throw new Error(`${s.name}: ${env?.error?.code ?? "no envelope"}`);
      const cat = s.truth.filter((x) => x.source === "catalog"), lid = s.truth.filter((x) => x.source === "langid");
      for (const t of [T, local]) {
        score(a[s.name].findings, s.truth, t.catalog, { evidence: "catalog", want: cat, claim: s.truth });
        score(a[s.name].findings, s.truth, t.langid, { evidence: "langid", want: lid, claim: s.truth });
        score(b[s.name].findings, s.truth, t.standalone, { evidence: "langid", want: s.truth, claim: s.truth });
        // Every seeded line counts toward recall_all; recall_all over all seeded lines is the coverage claim (D11).
      }
      seededCatalog += cat.length;
      seededLangid += lid.length;
    }
    perLocale[locale] = Object.fromEntries(Object.entries(local).map(([k, t]) => [k, { tp: t.tp, fp: t.fp, fn: t.fn }]));
    screensTotal += list.length;
    decoyScreens += list.filter((_, n) => n % 6 === 0).length;
  }
  fs.mkdirSync(path.join(work, "perf"));
  const p = process.env.BENCH_NO_PERF ? { pass: true, skipped: true } : perf(gen, path.join(work, "perf"));
  const v = versionInfo();
  const result = {
    todo: "036 T2", script: "bench/wrong-language.js", strings: "bench/wrong-language/strings.json", seed: 36,
    screens: screensTotal, locales: LOCALES, decoy_screens: decoyScreens, own_language_sentences: ownSentences,
    seeded: { catalog_swaps: seededCatalog, uncatalogued_foreign: seededLangid },
    gate: GATE,
    catalog: summary(T.catalog, GATE.catalog),
    langid_combined: { ...summary(T.langid, GATE.langid), note: "language ID after catalog evidence; recall over the uncatalogued foreign sentences" },
    langid_standalone: { ...summary(T.standalone, GATE.langid), note: "--languages alone over every seeded foreign line, catalog swaps included" },
    per_locale: perLocale, perf: p,
    tools: { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version, icu: process.versions.icu, unicode: process.versions.unicode, generator: "test/fixtures/generate.swift", recognizer: "NaturalLanguage NLLanguageRecognizer (macOS system framework)" },
  };
  result.pass = result.catalog.pass && result.langid_combined.pass && result.langid_standalone.pass && p.pass;
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.pass ? 0 : 1;
})();
