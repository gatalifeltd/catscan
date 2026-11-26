#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-074 measurement: `catscan fit --reasons wrapped,orphan` on the synthetic DOM set (bench/wrapping/generate.mjs,
// Playwright Chromium with --use-angle=metal, fixed seed). Even screens are the dev half, odd ones held out. Each half is
// run three times so each `wrapped` evidence is scored on its own:
// - base: the half's folder with its en twins (`--layout '{locale}/{screen}'`), so a target element pairs with its en element;
// - control: a copy without the en folder (no base element, so only `control` can fire);
// - declared: a copy without en whose target sidecars carry `max_lines: 1` on single-line-by-design elements.
// Truth is the DOM's (rows from Range client rects, last-row words from Intl.Segmenter), applied with the rule's
// definitions (TODO-074 "Rule"). `orphan` is scored on the base run, per script group.
// Usage:
//   node bench/wrapping.js [--out <dir>] [--reuse] > results/wrapping.json   (exit 1 below the held-out gate)
//   node bench/wrapping.js --dev [--out <dir>] [--reuse]                       (the dev half only, for tuning)
//   node bench/wrapping.js --rescore <out>/runs.json > results/wrapping.json   (re-score saved reads)
//   node bench/wrapping.js --manifest [--out <dir>] > bench/wrapping/manifest.json
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const { wilson } = require("./overlap/elements-lib");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const GENERATOR = path.join(__dirname, "wrapping/generate.mjs");
const EVIDENCE = ["base", "control", "declared"];
const GROUPS = { spaced: "spaced scripts", "ja-zh-yue": "ja, zh, yue", "th-unspaced": "th and other unspaced" };
const GATE = { wrapped: { precision: 0.95, recall: 0.90 }, orphan: { precision: 0.95, recall: 0.85 } };
const CJK = /^(ja|zh|yue)/;
const CLOSING = new Set([..."。、，．」』）】〕〉》！？：；)]"]);

const groupOf = (locale) => (CJK.test(locale) ? "ja-zh-yue" : /^(th|lo|km|my)/.test(locale) ? "th-unspaced" : "spaced");
const shortEn = (s) => s.trim().split(/\s+/).length <= 4 && [...s.trim()].length <= 32;

/** The rule's definitions applied to one element's DOM truth (TODO-074 "Rule"). */
function truthOf(el, locale) {
  const t = el.target, en = el.en;
  const wraps = t.rows >= 2;
  const last = t.row_texts[t.row_texts.length - 1] || "";
  const ink = [...last].filter((c) => !/\s/.test(c));
  const closing = CJK.test(locale) && ink.length > 0 && ink.every((c) => CLOSING.has(c));
  const narrow = t.row_widths[t.row_widths.length - 1] <= Math.max(...t.row_widths) / 3;
  const oneWord = t.last_words === 1 || (CJK.test(locale) && ink.length <= 2);
  const enAccepts = Boolean(en && en.rows >= 2 && en.last_words === 1);
  return {
    wrapped: {
      base: wraps && Boolean(en) && en.rows === 1 && shortEn(en.text),
      control: wraps && el.control_only,
      declared: wraps && el.single,
    },
    orphan: t.rows >= 2 && t.rows <= 3 && !enAccepts && (closing || (oneWord && narrow && /\p{L}/u.test(last))),
  };
}

/** One input's (set, locale, screen) from its envelope path. */
const keyOf = (p) => { const parts = p.split(/[\\/]/); return `${parts[parts.length - 2]}/${parts[parts.length - 1].replace(/\.[^.]+$/, "")}`; };

function stat(tp, fp, fn) {
  const p = tp + fp ? tp / (tp + fp) : null, r = tp + fn ? tp / (tp + fn) : null;
  return { positives: tp + fn, flagged: tp + fp, tp, fp, fn, precision: p === null ? null : Number(p.toFixed(4)), recall: r === null ? null : Number(r.toFixed(4)),
    precision_wilson95: wilson(tp, tp + fp), recall_wilson95: wilson(tp, tp + fn) };
}

/** Scores one half: `runs` maps run name -> envelopes; returns per-evidence and per-group numbers and every miss. */
function scoreHalf(truth, half, runs) {
  const screens = truth.screens.filter((s) => s.set === half);
  const found = {};
  const unmatched = [];
  const known = new Set();
  for (const s of screens) for (const e of s.elements) if (e.target) known.add(`${s.locale}/${s.name}#${e.id}`);
  for (const [run, envs] of Object.entries(runs)) {
    for (const env of envs) {
      const k = keyOf(env.path || "");
      if (k.startsWith("en/")) continue; // base inputs are checked too (D19); this bench scores the targets
      for (const f of env.findings || []) {
        if (f.kind !== "fit" || !["wrapped", "orphan"].includes(f.reason)) continue;
        const id = `${k}#${f.element?.id ?? null}`;
        found[`${run}|${f.reason}|${id}`] = f;
        if (!known.has(id)) unmatched.push({ run, reason: f.reason, evidence: f.evidence ?? null, path: env.path, id: f.element?.id ?? null, line: f.line });
      }
    }
  }
  const tally = {};
  const misses = [];
  const count = (bucket, truthYes, f, s, e, run, reason) => {
    const c = (tally[bucket] ||= { tp: 0, fp: 0, fn: 0, tn: 0 });
    const yes = Boolean(f);
    c[truthYes ? (yes ? "tp" : "fn") : yes ? "fp" : "tn"]++;
    if (truthYes !== yes) misses.push({ half, run, reason, bucket, type: yes ? "fp" : "fn", path: `${half}/${s.locale}/${s.name}.png`, id: e.id, kind: e.kind,
      truth_rows: e.target.rows, row_texts: e.target.row_texts, en_rows: e.en?.rows ?? null, en_text: e.en?.text ?? null,
      predicted: f ? { evidence: f.evidence ?? null, rows: f.rows ?? null, line: f.line, orphan: f.orphan ?? null } : null });
  };
  const other = [];
  for (const s of screens) {
    for (const e of s.elements) {
      if (!e.target) continue;
      const t = truthOf(e, s.locale);
      const id = `${s.locale}/${s.name}#${e.id}`;
      for (const ev of EVIDENCE) {
        if (!runs[ev]) continue;
        const f = found[`${ev}|wrapped|${id}`];
        if (f && f.evidence !== ev) { other.push({ run: ev, evidence: f.evidence, path: `${half}/${s.locale}/${s.name}.png`, id: e.id, line: f.line }); count(`wrapped:${ev}`, t.wrapped[ev], null, s, e, ev, "wrapped"); continue; }
        count(`wrapped:${ev}`, t.wrapped[ev], f, s, e, ev, "wrapped");
      }
      if (runs.base) count(`orphan:${groupOf(s.locale)}`, t.orphan, found[`base|orphan|${id}`], s, e, "base", "orphan");
    }
  }
  const out = { screens: screens.length, elements: screens.reduce((n, s) => n + s.elements.filter((e) => e.target).length, 0), wrapped: {}, orphan: {} };
  for (const ev of EVIDENCE) if (tally[`wrapped:${ev}`]) { const c = tally[`wrapped:${ev}`]; out.wrapped[ev] = { ...stat(c.tp, c.fp, c.fn), negatives: c.fp + c.tn }; }
  for (const g of Object.keys(GROUPS)) if (tally[`orphan:${g}`]) { const c = tally[`orphan:${g}`]; out.orphan[g] = { ...stat(c.tp, c.fp, c.fn), negatives: c.fp + c.tn }; }
  // Findings on ids the truth does not hold (a wrapper, a dropped element) count as false positives of their run.
  for (const u of unmatched) {
    const b = u.reason === "wrapped" ? out.wrapped[u.run] : out.orphan[groupOf(u.path.split(/[\\/]/).slice(-2)[0])];
    if (b && (u.reason === "wrapped" ? u.evidence === u.run : u.run === "base")) { b.fp++; b.flagged++; Object.assign(b, { precision: Number((b.tp / b.flagged).toFixed(4)), precision_wilson95: wilson(b.tp, b.flagged) }); }
  }
  return { ...out, unmatched, other_evidence: other, misses };
}

function gateOf(held) {
  const g = {};
  for (const ev of EVIDENCE) { const x = held.wrapped[ev]; if (x) g[`wrapped:${ev}`] = { precision: x.precision, recall: x.recall, pass: x.precision !== null && x.precision >= GATE.wrapped.precision && x.recall >= GATE.wrapped.recall }; }
  for (const k of Object.keys(GROUPS)) { const x = held.orphan[k]; if (x) g[`orphan:${k}`] = { precision: x.precision, recall: x.recall, pass: x.precision !== null && x.precision >= GATE.orphan.precision && x.recall >= GATE.orphan.recall }; }
  return g;
}

/** Copies of a half for the control and declared runs: no en folder; images hard-linked. */
function prepare(out, half, truth) {
  const src = path.join(out, half);
  const single = new Map(truth.screens.filter((s) => s.set === half).map((s) => [`${s.locale}/${s.name}`, new Set(s.elements.filter((e) => e.single).map((e) => e.id))]));
  for (const run of ["control", "declared"]) {
    const dst = path.join(out, `${half}-${run}`);
    fs.rmSync(dst, { recursive: true, force: true });
    for (const loc of fs.readdirSync(src)) {
      if (loc === "en") continue;
      fs.mkdirSync(path.join(dst, loc), { recursive: true });
      for (const f of fs.readdirSync(path.join(src, loc))) {
        const from = path.join(src, loc, f), to = path.join(dst, loc, f);
        if (f.endsWith(".png")) { fs.linkSync(from, to); continue; }
        const b = JSON.parse(fs.readFileSync(from, "utf8"));
        if (run === "declared") { const ids = single.get(`${loc}/${f.replace(/\.boxes\.json$/, "")}`) || new Set(); for (const e of b.elements) if (ids.has(e.id)) e.max_lines = 1; }
        fs.writeFileSync(to, JSON.stringify(b));
      }
    }
  }
}

/** One `catscan fit` run over a folder; returns trimmed envelopes and the warning codes. */
function fit(dir) {
  const args = [CLI, "fit", dir, "--boxes", dir, "--layout", "{locale}/{screen}", "--reasons", "wrapped,orphan", "--experimental", "--json"];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 30, timeout: 3600000, killSignal: "SIGKILL" });
  if (![0, 1].includes(r.status)) throw new Error(`catscan fit ${dir}: exit ${r.status ?? r.signal}: ${(r.stderr || "").slice(0, 2000)}`);
  const envs = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((e) => ({
    path: e.path, engine: e.engine, verdict: e.verdict, error: e.error ?? null, warnings: (e.warnings || []).map((w) => w.code ?? w),
    findings: (e.findings || []).filter((f) => f.kind === "fit" && ["wrapped", "orphan"].includes(f.reason)),
  }));
  const stderrCodes = [...new Set([...(r.stderr || "").matchAll(/\b(wrap-[a-z-]+|fit-experimental|boxes-missing)\b/g)].map((m) => m[1]))];
  return { envelopes: envs, stderr_codes: stderrCodes, command: `node bin/catscan.js fit <${path.relative(ROOT, dir)}> --boxes <same> --layout '{locale}/{screen}' --reasons wrapped,orphan --experimental --json` };
}

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const listSha = (files) => crypto.createHash("sha256").update(files.map(sha).join("\n")).digest("hex");

function tools(truth, runs) {
  const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); return (r.stdout || r.stderr || "").split("\n")[0].trim() || null; };
  const engines = new Set();
  for (const h of Object.values(runs)) for (const r of Object.values(h)) for (const e of r.envelopes) if (e.engine) engines.add(e.engine);
  const macos = sh("sw_vers", ["-productVersion"]), build = sh("sw_vers", ["-buildVersion"]);
  return {
    ...truth.tools, macos, macos_build: build, xcode: sh("xcodebuild", ["-version"]), swift: sh("swift", ["--version"]), node: process.version,
    vision_engine: [...engines], nltokenizer: `NaturalLanguage NLTokenizer (OS framework), macOS ${macos} (${build})`,
    intl_segmenter: `ICU in Chromium ${truth.tools.chromium}`, chip: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
  };
}

function result(saved) {
  const { truth, runs } = saved;
  const halves = {};
  for (const half of Object.keys(runs)) halves[half] = scoreHalf(truth, half, Object.fromEntries(Object.entries(runs[half]).map(([k, v]) => [k, v.envelopes])));
  const held = halves.held;
  const gate = held ? gateOf(held) : null;
  const strip = (h) => h && { screens: h.screens, elements: h.elements, wrapped: h.wrapped, orphan: h.orphan };
  return {
    todo: "074", script: "bench/wrapping.js", generator: "bench/wrapping/generate.mjs", manifest: "bench/wrapping/manifest.json", strings: "bench/untranslated/strings.json (+ th, ar in the generator)",
    seed: truth.seed, locales: truth.locales, base_locale: "en", gate_bars: GATE, groups: GROUPS,
    counts: Object.fromEntries(Object.entries(halves).map(([k, h]) => [k, { screens: h.screens, en_screens: h.screens, target_elements: h.elements }])),
    held_out: strip(held), dev: strip(halves.dev),
    gate, pass: gate ? Object.values(gate).every((x) => x.pass) : null,
    warnings: Object.fromEntries(Object.entries(runs).map(([h, r]) => [h, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.stderr_codes]))])),
    commands: Object.fromEntries(Object.entries(runs).map(([h, r]) => [h, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.command]))])),
    misses: Object.values(halves).flatMap((h) => h.misses), unmatched_findings: Object.values(halves).flatMap((h) => h.unmatched), other_evidence: Object.values(halves).flatMap((h) => h.other_evidence),
    tools: saved.tools, date: saved.date,
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (opt("--rescore")) {
    const r = result(JSON.parse(fs.readFileSync(opt("--rescore"), "utf8")));
    process.stdout.write(JSON.stringify(r, null, 1) + "\n");
    process.exitCode = r.pass === false ? 1 : 0; // not process.exit: a piped stdout would be cut off
    return;
  }
  const out = path.resolve(opt("--out") || path.join(__dirname, "wrapping/out"));
  const truthFile = path.join(out, "truth.json");
  if (!(argv.includes("--reuse") && fs.existsSync(truthFile))) execFileSync(process.execPath, [GENERATOR, out], { stdio: ["ignore", "ignore", "inherit"] });
  const truth = JSON.parse(fs.readFileSync(truthFile, "utf8"));
  if (argv.includes("--manifest")) {
    const pngs = (d) => fs.readdirSync(path.join(out, d), { recursive: true }).map(String).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(out, d, f));
    const half = (h) => { const p = pngs(h); return { screens: truth.screens.filter((s) => s.set === h).length, images: p.length, images_sha256: listSha(p), boxes_sha256: listSha(p.map((f) => f.replace(/\.png$/, ".boxes.json"))) }; };
    process.stdout.write(JSON.stringify({
      todo: "074",
      note: "Images and sidecars are regenerated into bench/wrapping/out (gitignored) by bench/wrapping.js; the hashes cover the sorted per-file sha256 lists of each half (en twins included). th and ar strings are written in the generator; the other 12 locales come from bench/untranslated/strings.json.",
      synthetic: { generator: "bench/wrapping/generate.mjs", script: "bench/wrapping.js", seed: truth.seed, locales: truth.locales, base_locale: "en",
        plan: "per locale 24 screens (even dev, odd held out): nav title, 0-3 segments, 3 buttons, 3 chips (30% with a subtitle), a subtitle, a paragraph, 3-5 tab bar items; widths fit, wrap or leave the last word alone",
        viewport: truth.tools.viewport, device_scale_factor: truth.tools.device_scale_factor, dev: half("dev"), held: half("held"), tools: truth.tools },
      rendered: "pending (spec 14 sample apps with catscan pseudo --expand 40, hand-labeled)",
      real: "pending (datasets/truncation*, hand review on the label review page)",
    }, null, 1) + "\n");
    return;
  }
  const halves = argv.includes("--dev") ? ["dev"] : ["dev", "held"];
  const runs = {};
  // Serial: one Vision run at a time (one GPU shared with other work).
  for (const h of halves) {
    prepare(out, h, truth);
    runs[h] = { base: fit(path.join(out, h)), control: fit(path.join(out, `${h}-control`)), declared: fit(path.join(out, `${h}-declared`)) };
    process.stderr.write(`wrapping: ${h} read\n`);
  }
  const saved = { truth, runs, tools: null, date: new Date().toISOString().slice(0, 10) };
  saved.tools = tools(truth, runs);
  fs.writeFileSync(path.join(out, "runs.json"), JSON.stringify(saved));
  const r = result(saved);
  process.stdout.write(JSON.stringify(r, null, 1) + "\n");
  process.exitCode = r.pass === false ? 1 : 0;
}

module.exports = { truthOf, scoreHalf, gateOf, prepare, result, tools, GATE, GROUPS };
