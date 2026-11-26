#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-067 D31: bench-only measure of a dictionary signal for stacked text that Vision reads confidently as non-words
// (`Notleißigladiagen` at 1.0), on calibration data only: the recaptured stacked sheets and the real calibration
// screens. Held-out sets are never read here (D12). Lines come from `catscan read` (the production corrected read);
// words go to bench/stacked/spell.swift (NSSpellChecker, run language plus en). Every variant is published; the rule
// marked `chosen` is frozen here and is the one core builds.
// A line is eligible when it is at least 0.8 of the screen's median line height (T0's filter). A token is its
// punctuation-stripped word; digits are dropped before the lookup (`45ppettues` -> `ppettues`) when a variant allows
// them; tokens under 3 letters and all-caps tokens of at most 4 letters are skipped (TODO-053).
// Usage: node bench/stacked-dictionary.js > results/stacked-dictionary.json   (exit 1 when the chosen rule misses
//   9 of 11 sheets together with the correction signal, or flags a calibration screen)
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { run } = require("./overlap");
const { wilson } = require("./stacked");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "datasets");
const CALIBRATION = ["truncation", "truncation-android", "truncation-extra", "truncation-android-extra"];
const SPELL = path.join(ROOT, ".build/stacked-spell");
const PUNCT = ".,:;!?()[]{}\"'«»“”„‚‘’-–/\\|*•·…%+=<>#@&_~^$€£¥";

function images(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() || (e.isSymbolicLink() && fs.statSync(p).isDirectory())) walk(p);
      else if (/\.(png|jpe?g)$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function byLocale(files) {
  const m = new Map();
  for (const f of files) { const l = path.basename(path.dirname(f)); if (!m.has(l)) m.set(l, []); m.get(l).push(f); }
  return m;
}

/** Production reads, one row per image; Tesseract reads are unchecked (the reader runs on Vision only). */
function reads(files) {
  const rows = [];
  for (const [locale, fs_] of byLocale(files)) {
    for (const env of run("read", fs_, locale)) {
      rows.push({ path: path.relative(DATA, env.path), locale, vision: /^vision/.test(env.engine || ""), lines: env.lines || [] });
    }
  }
  return rows;
}

const letters = (t) => [...t].filter((c) => /\p{Alphabetic}/u.test(c)).length; // as core (isAlphabetic)
const strip = (w) => { let a = 0, b = w.length; while (a < b && PUNCT.includes(w[a])) a++; while (b > a && PUNCT.includes(w[b - 1])) b--; return w.slice(a, b); };
const tokens = (text) => text.split(/\s+/).map(strip).filter(Boolean);
const key = (w) => w.replace(/\p{Nd}/gu, "");

const VARIANTS = {
  "two-unknown": { digits: false, near: false, two: true, long: Infinity }, // TODO-053 as specced
  "two-unknown+digits": { digits: true, near: false, two: true, long: Infinity },
  "two-unknown+digits+near": { digits: true, near: true, two: true, long: Infinity }, // chosen
  "long-unknown>=10": { digits: true, near: true, two: false, long: 10 },
  "long-unknown>=12": { digits: true, near: true, two: false, long: 12 },
  "long-unknown>=14": { digits: true, near: true, two: false, long: 14 },
  "two-unknown+digits+near|long>=14": { digits: true, near: true, two: true, long: 14 },
};
const CHOSEN = "two-unknown+digits+near";

function fires(v, spell, locale, text) {
  let unknown = 0, checkable = 0;
  const longs = [], unk = [];
  for (const w of tokens(text)) {
    if (/\p{Nd}/u.test(w) && !v.digits) continue;
    const k = key(w), n = letters(k);
    if (n < 3 || (n <= 4 && k === k.toUpperCase())) continue;
    const s = spell.get(`${locale}\t${k}`);
    if (!s || s.v === "-") continue;
    checkable++;
    if (s.v === "1" && !(v.near && s.near)) { unknown++; unk.push(k); if (n >= v.long) longs.push(k); }
  }
  if (v.two && unknown >= 2 && unknown * 2 >= checkable) return unk;
  return longs.length ? longs : null;
}

function flags(v, spell, row) {
  const hs = row.lines.map((l) => l.box[3]).sort((a, b) => a - b);
  const med = hs.length ? hs[Math.floor(hs.length / 2)] : 1;
  const out = [];
  for (const l of row.lines) {
    if (l.box[3] < 0.8 * med) continue;
    const unk = fires(v, spell, row.locale, l.text);
    if (unk) out.push({ line: l.text, confidence: l.confidence, box: l.box, unknown: unk });
  }
  return out;
}

if (require.main === module) {
  execFileSync("swiftc", ["-O", path.join(__dirname, "stacked/spell.swift"), "-o", SPELL], { stdio: "inherit" });
  const missing = CALIBRATION.filter((d) => !fs.existsSync(path.join(DATA, d)));
  const sheets = fs.existsSync(path.join(DATA, "stacked-text")) ? images(path.join(DATA, "stacked-text")).filter((f) => f.endsWith("-stacked.png")) : [];
  if (missing.length || !sheets.length) { process.stderr.write(`missing datasets: ${[...missing, ...(sheets.length ? [] : ["stacked-text"])].join(", ")}\n`); process.exit(1); }
  const calib = reads(CALIBRATION.flatMap((d) => images(path.join(DATA, d))));
  const rec = reads(sheets);
  const all = [...calib, ...rec].filter((r) => r.vision);
  const words = [...new Set(all.flatMap((r) => r.lines.flatMap((l) => tokens(l.text).map(key).filter((k) => letters(k) >= 3).map((k) => `${r.locale}\t${k}`))))].sort();
  const spell = new Map();
  for (const line of execFileSync(SPELL, { input: words.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean)) {
    const [l, w, v, near] = line.split("\t");
    spell.set(`${l}\t${w}`, { v, near: near === "1" });
  }
  // The correction evidence's finds on the same sheets, run as plain `overlap` ships (D35). Findings that carry only
  // the shipped dictionary evidence are left out, so each variant below is joined with correction alone.
  const corr = new Set();
  for (const [locale, fs_] of byLocale(sheets)) {
    for (const env of run("overlap", fs_, locale, [], { stacked: true, experimental: false })) {
      if ((env.findings || []).some((f) => f.signal === "stacked" && (f.stacked_evidence || []).some((e) => e.startsWith("correction")))) corr.add(path.relative(DATA, env.path));
    }
  }
  const nCal = calib.filter((r) => r.vision).length;
  const out = {
    todo: "067", decision: "D31", script: "bench/stacked-dictionary.js", helper: "bench/stacked/spell.swift", chosen: CHOSEN,
    note: "calibration data only; held-out sets untouched. A recapture sheet counts when the variant flags any line on it; a calibration flag is a false alarm (no calibration screen holds stacked text).",
    calibration: { folders: CALIBRATION, screens: calib.length, checked: nCal, unchecked: calib.length - nCal },
    recapture: { screens: rec.length, checked: rec.filter((r) => r.vision).length, correction_found: [...corr].sort(), manifest: "bench/stacked/manifest.json" },
    variants: {},
  };
  for (const [name, v] of Object.entries(VARIANTS)) {
    const recFlags = rec.filter((r) => r.vision).map((r) => ({ path: r.path, flags: flags(v, spell, r) }));
    const found = new Set(recFlags.filter((r) => r.flags.length).map((r) => r.path));
    const union = new Set([...found, ...corr]);
    const calFlags = calib.filter((r) => r.vision).map((r) => ({ path: r.path, flags: flags(v, spell, r) })).filter((r) => r.flags.length);
    out.variants[name] = {
      rule: v.long === Infinity ? v : { ...v, long: v.long },
      sheets_found: found.size, with_correction: union.size, of: rec.length, recall_with_correction: Number((union.size / rec.length).toFixed(4)), ci: wilson(union.size, rec.length),
      by_locale: Object.fromEntries(rec.map((r) => [r.locale, found.has(r.path) ? "dictionary" : corr.has(r.path) ? "correction" : r.vision ? "missed" : "unchecked"])),
      calibration_flagged_screens: calFlags.length, calibration_per_100: Number(((100 * calFlags.length) / nCal).toFixed(2)), calibration_ci_per_100: (wilson(calFlags.length, nCal) || []).map((x) => Number((100 * x).toFixed(2))),
      calibration_flags: calFlags.slice(0, 25).flatMap((r) => r.flags.map((f) => ({ path: r.path, line: f.line, unknown: f.unknown }))),
      sheet_flags: recFlags.filter((r) => r.flags.length).flatMap((r) => r.flags.map((f) => ({ path: r.path, line: f.line, confidence: f.confidence, unknown: f.unknown }))),
    };
  }
  const v = versionInfo();
  Object.assign(out, {
    catscan: v.catscan, chip: v.host.chip, macos: v.macos, macos_build: v.macos_build, vision_revision: v.vision_revision,
    node: process.version, date: new Date().toISOString().slice(0, 10),
    swiftc: execFileSync("swiftc", ["--version"], { encoding: "utf8" }).split("\n")[0],
  });
  process.stdout.write(JSON.stringify(out, null, 1) + "\n");
  const c = out.variants[CHOSEN];
  process.exit(c.with_correction >= 9 && c.calibration_flagged_screens === 0 ? 0 : 1);
}

module.exports = { tokens, key, letters, VARIANTS, CHOSEN };
