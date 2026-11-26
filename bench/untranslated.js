#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 17 gates, until the spec 05 benchmark exists: precision and recall per finding kind on a synthetic set,
// and the time per image against `check` with a 5,000-key catalog pair (D18).
// Usage: node bench/untranslated.js > results/untranslated.json   (exit 1 when a gate fails)
// The set is built from bench/untranslated/strings.json with a fixed seed and drawn with
// test/fixtures/generate.swift, so it is labeled by construction: 12 locales x 50 screens, 8-12 strings each,
// 0-2 swapped for the base string, the raw key or the unfilled placeholder, and >= 10% of screens carrying
// adversarial negatives (D20). Hand-written `cases` (TODO-010, 013, 014, 015 D6) add screens with their own keys and
// truth after the seeded ones, so the seeded screens stay identical; they are scored with them and listed per case.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { editDistance } = require("../packages/core-js/src/args");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const S = require("./untranslated/strings.json");
const LOCALES = Object.keys(S.locales).filter((l) => l !== "en");
const SCREENS = 50;
const KINDS = ["untranslated", "raw-key", "placeholder"];
const GATE = { precision: 0.95, recall: 0.90 };
const PERF_KEYS = 5000, PERF_COPIES = 20, PERF_BUDGET_MS = 50, WORST_BUDGET_MS = 250;
// Lines that look like defects and are not: domains, versions, percentages, file names.
const DECOYS = ["acme.ai", "Version 2.4.1", "100% fertig", "photo.jpg", "50 %", "support.example.com"];

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const fill = (s) => s.replace("{count}", "3").replace("{name}", "Anna").replace("%d", "5");
const hasPlaceholder = (s) => /\{\w+\}|%d/.test(s);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const bare = (s) => s.replace(/[^%\w]/g, "").toLowerCase();
const ratio = (n, d) => (d ? Number((n / d).toFixed(4)) : null);

const CASES = S.cases || [];

function catalogs(dir, locale) {
  const extra = (j) => Object.fromEntries(CASES.filter((c) => c.locale === locale).flatMap((c) => Object.entries(c.keys).map(([k, v]) => [k, v[j]])));
  const obj = (l, j) => ({ ...Object.fromEntries(S.keys.map((k, i) => [k, S.locales[l][i]])), ...extra(j) });
  fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify(obj("en", 0)));
  fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(obj(locale, 1)));
}

/** One locale's screens and their truth: [{kind, base | line}]. */
function screens(locale, rand) {
  const en = S.locales.en, tr = S.locales[locale];
  const idx = S.keys.map((_, i) => i);
  const shared = (i) => en[i].toLowerCase() === tr[i].toLowerCase();
  const out = [];
  for (let n = 0; n < SCREENS; n++) {
    const pick = [...idx].sort(() => rand() - 0.5).slice(0, 8 + Math.floor(rand() * 5));
    const swaps = Math.floor(rand() * 3);
    const lines = pick.map((i) => fill(tr[i]));
    const truth = [];
    const used = new Set();
    for (let s = 0; s < swaps; s++) {
      const kind = KINDS[Math.floor(rand() * 3)];
      const cands = pick.map((i, at) => [i, at]).filter(([i, at]) => !used.has(at) && !shared(i)
        && (kind !== "placeholder" || hasPlaceholder(tr[i])) && (kind !== "untranslated" || fill(en[i]).replace(/\W/g, "").length >= 4));
      if (!cands.length) continue;
      const [i, at] = cands[Math.floor(rand() * cands.length)];
      used.add(at);
      if (kind === "untranslated") { lines[at] = fill(en[i]); truth.push({ kind, base: en[i] }); }
      if (kind === "raw-key") { lines[at] = S.keys[i]; truth.push({ kind, line: S.keys[i] }); }
      if (kind === "placeholder") { lines[at] = tr[i]; truth.push({ kind, line: tr[i] }); }
    }
    // Adversarial negatives on every 6th screen: a decoy line, and the same key shown once correct and once
    // untranslated when a swap made one (D10 locality).
    if (n % 6 === 0) {
      lines.push(DECOYS[n % DECOYS.length]);
      const u = truth.find((t) => t.kind === "untranslated");
      if (u) lines.push(fill(tr[en.indexOf(u.base)]));
    }
    // Duplicates of one base text are one finding (D13): a second swap of "Settings" is the same truth.
    const seen = new Set();
    out.push({
      name: `${locale}-${String(n).padStart(2, "0")}.png`, lines,
      truth: truth.filter((t) => { const id = `${t.kind}:${t.base ?? t.line}`; return !seen.has(id) && seen.add(id); }),
    });
  }
  return out;
}

function draw(gen, dir, list, locale, { width = 1100, size = 34, step = 64 } = {}) {
  const manifest = list.map((s) => ({
    name: s.name, locale, width, height: 80 + s.lines.length * step,
    lines: s.lines.map((t, i) => ({ text: t, x: 40, y: 40 + i * step, size })),
  }));
  const f = path.join(dir, "screens.json");
  fs.writeFileSync(f, JSON.stringify(manifest));
  execFileSync(gen, [f, dir], { stdio: "ignore" });
}

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`catscan ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Matches findings to truth by kind: untranslated by base text, raw keys and placeholders by line. */
function score(found, truth, tally) {
  for (const kind of KINDS) {
    const want = truth.filter((t) => t.kind === kind);
    const got = found.filter((f) => f.kind === kind);
    let tp = 0;
    const left = [...got];
    for (const t of want) {
      const at = left.findIndex((f) => (kind === "untranslated" ? f.base === t.base
        : kind === "raw-key" ? editDistance(f.line, t.line) <= 2 // a key read with a letter or two wrong is still found
          : editDistance(bare(f.line), bare(t.line)) <= 2)); // Vision may misread braces: compare the words of the line
      if (at >= 0) { tp++; left.splice(at, 1); }
    }
    tally[kind].tp += tp;
    tally[kind].fp += got.length - tp;
    tally[kind].fn += want.length - tp;
    for (const f of left) tally[kind].fps.push({ line: f.line, base: f.base, catalog_entry: f.key });
  }
}

// TODO-012 D3 worst case: every base string is four words of a 12-word vocabulary, all on the screen, so the D18
// prefilter keeps all 5,000 keys, and every one of the 30 lines is an untranslated base string.
const VOCAB = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
const worstBase = (i) => [0, 1, 2, 3].map((d) => VOCAB[Math.floor(i / 12 ** d) % 12]).join(" ");

function perf(gen, dir, worst = false) {
  const base = {}, target = {};
  for (let i = 0; i < PERF_KEYS; i++) {
    base[`screen.k${i}`] = worst ? worstBase(i) : `Lorem item number ${i}`;
    target[`screen.k${i}`] = `Eintrag Nummer ${i} hier`;
  }
  fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify(base));
  fs.writeFileSync(path.join(dir, "de.json"), JSON.stringify(target));
  const lines = Array.from({ length: 30 }, (_, i) => (worst ? base[`screen.k${i * 163}`]
    : i % 10 === 3 ? base[`screen.k${i * 7}`] : target[`screen.k${i * 7}`]));
  const shots = path.join(dir, "shots");
  fs.mkdirSync(shots);
  draw(gen, shots, Array.from({ length: PERF_COPIES }, (_, i) => ({ name: `p${String(i).padStart(2, "0")}.png`, lines })), "de",
    { width: 1290, size: 44, step: 90 });
  fs.rmSync(path.join(shots, "screens.json"));
  const time = (args) => {
    const t = [];
    for (let k = 0; k < 3; k++) {
      const t0 = process.hrtime.bigint();
      run(args);
      t.push(Number(process.hrtime.bigint() - t0) / 1e6 / PERF_COPIES);
    }
    return Number(median(t).toFixed(1));
  };
  const check = time(["check", shots, "--locale", "de", "--present", "Eintrag Nummer"]);
  const untr = time(["untranslated", shots, "--locale", "de", "--base", path.join(dir, "en.json"), "--catalog", path.join(dir, "de.json")]);
  const budget = worst ? WORST_BUDGET_MS : PERF_BUDGET_MS;
  return { keys: PERF_KEYS, image: "1290x2790, 30 lines", copies: PERF_COPIES, check_ms_per_image: check, untranslated_ms_per_image: untr, budget_ms: budget, pass: untr <= check + budget };
}

(() => {
  const gen = path.join(ROOT, ".build/synth");
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  execFileSync("swiftc", ["-O", path.join(ROOT, "test/fixtures/generate.swift"), "-o", gen]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-untranslated-bench-"));
  const tally = Object.fromEntries(KINDS.map((k) => [k, { tp: 0, fp: 0, fn: 0, fps: [] }]));
  const perLocale = {};
  const caseResults = [];
  let screensTotal = 0, adversarial = 0;
  const rand = rng(17);
  for (const locale of LOCALES) {
    const dir = path.join(work, locale);
    fs.mkdirSync(dir);
    catalogs(dir, locale);
    const seeded = screens(locale, rand);
    const cased = CASES.filter((c) => c.locale === locale).map((c) => ({ name: `case-${c.name}.png`, lines: c.lines, truth: c.truth, case: c }));
    const list = [...seeded, ...cased];
    const shots = path.join(dir, "shots");
    fs.mkdirSync(shots);
    draw(gen, shots, list, locale);
    fs.rmSync(path.join(shots, "screens.json"));
    const envs = run(["untranslated", shots, "--locale", locale, "--base", path.join(dir, "en.json"), "--catalog", path.join(dir, `${locale}.json`)]);
    const local = Object.fromEntries(KINDS.map((k) => [k, { tp: 0, fp: 0, fn: 0, fps: [] }]));
    // A screen with no envelope is a miss for each of its defects, never a silent drop from recall.
    const seenNames = new Set(envs.map((e) => path.basename(e.path)));
    for (const s of list) if (!seenNames.has(s.name)) { score([], s.truth, tally); score([], s.truth, local); }
    for (const env of envs) {
      const s = list.find((x) => x.name === path.basename(env.path));
      if (env.verdict === "error" || env.verdict === "unsupported") throw new Error(`${env.path}: ${env.error?.code}`);
      score(env.findings, s.truth, tally);
      score(env.findings, s.truth, local);
      if (s.case) {
        const one = Object.fromEntries(KINDS.map((k) => [k, { tp: 0, fp: 0, fn: 0, fps: [] }]));
        score(env.findings, s.truth, one);
        const sum = (f) => KINDS.reduce((n, k) => n + one[k][f], 0);
        caseResults.push({ name: s.case.name, todo: s.case.todo, locale, tp: sum("tp"), fp: sum("fp"), fn: sum("fn"),
          pass: sum("fp") === 0 && sum("fn") === 0 });
      }
    }
    perLocale[locale] = Object.fromEntries(KINDS.map((k) => [k, { tp: local[k].tp, fp: local[k].fp, fn: local[k].fn }]));
    screensTotal += list.length;
    adversarial += seeded.filter((_, n) => n % 6 === 0).length;
  }
  const kinds = Object.fromEntries(KINDS.map((k) => {
    const t = tally[k];
    const precision = ratio(t.tp, t.tp + t.fp), recall = ratio(t.tp, t.tp + t.fn);
    return [k, { tp: t.tp, fp: t.fp, fn: t.fn, precision, recall, pass: precision >= GATE.precision && recall >= GATE.recall, false_positives: t.fps.slice(0, 20) }];
  }));
  fs.mkdirSync(path.join(work, "perf"));
  const p = perf(gen, path.join(work, "perf"));
  fs.mkdirSync(path.join(work, "perf-worst"));
  const pw = perf(gen, path.join(work, "perf-worst"), true);
  const v = versionInfo();
  const result = {
    spec: "17", script: "bench/untranslated.js", strings: "bench/untranslated/strings.json", seed: 17,
    screens: screensTotal, adversarial_screens: adversarial, locales: LOCALES, gate: GATE, kinds, per_locale: perLocale, cases: caseResults, perf: p, perf_worst: { ...pw, case: "every base string live, all 30 lines untranslated (TODO-012 D3)" },
    tools: { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version, generator: "test/fixtures/generate.swift" },
    pass: Object.values(kinds).every((k) => k.pass) && p.pass && pw.pass,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.pass ? 0 : 1;
})();
