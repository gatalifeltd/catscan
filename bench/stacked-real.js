#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-067 real-screen leg: plain `catscan overlap` as a user runs it (stacked default-on, D34), scored on the `stacked` reader.
// Negatives: calibration (datasets/truncation, truncation-android and their -extra sets; T0 fitted the rule there) and
// held-out (datasets/d1, datasets/d2; never tuned on). The screens are expected to hold no stacked text, so every flag
// is a false alarm unless results/stacked-review.json, written by hand after looking at the screen, says "real".
// Positives: bench/stacked/positives.json (the owner's screen, scored per labeled region) and the recapture of that
// sheet in every locale (D7) in datasets/stacked-text/<locale>/: `*-stacked.png` (the sheet with its pages drawn over each
// other, scored per screen: found when it has a stacked finding) and `*-clean.png` (the same screens fixed, held-out
// negatives with game art like the positives).
// Images stay in datasets/ (gitignored); the folder above an image names its locale. Manifests: datasets/MANIFEST.md.
// Usage: node bench/stacked-real.js [--review results/stacked-review.json] > results/stacked-real.json
//   (exit 1 when held-out false alarms reach 2 per 100 screens: nothing ships, TODO-067 "Done when"; or when a
//   negatives folder is missing or no screen was checked: unmeasured)
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { run } = require("./overlap");
const { hits, wilson } = require("./stacked");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "datasets");
const SETS = {
  calibration: ["truncation", "truncation-android", "truncation-extra", "truncation-android-extra"],
  held_out: ["d1", "d2"],
  held_out_game: ["stacked-text"], // only the *-clean.png captures (D7)
};
const BARS = { default_on: 1, experimental: 2 }; // false alarms per 100 held-out screens (TODO-067 D20, spec 12)

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

/** Runs the CLI per locale folder; returns one row per image. */
function read(files) {
  const byLocale = new Map();
  for (const f of files) {
    const l = path.basename(path.dirname(f));
    if (!byLocale.has(l)) byLocale.set(l, []);
    byLocale.get(l).push(f);
  }
  const rows = [];
  for (const [locale, fs_] of byLocale) {
    // TODO-067 D34: plain `overlap`, the configuration that ships (stacked only, no OCR-geometry merge).
    for (const env of run("overlap", fs_, locale, [], { stacked: true, experimental: false })) {
      const stacked = (env.findings || []).filter((f) => f.signal === "stacked");
      const unchecked = env.verdict === "unsupported" || (env.warnings || []).some((w) => w.code === "stacked-unchecked");
      rows.push({ path: path.relative(DATA, env.path), locale, verdict: env.verdict, unchecked, stacked });
    }
  }
  return rows;
}

const per100 = (k, n) => (n ? Number(((100 * k) / n).toFixed(2)) : null);

if (require.main === module) {
  const argv = process.argv.slice(2);
  const reviewFile = argv.includes("--review") ? argv[argv.indexOf("--review") + 1] : null;
  const verdicts = reviewFile && fs.existsSync(reviewFile) ? Object.fromEntries(JSON.parse(fs.readFileSync(reviewFile, "utf8")).flags.map((f) => [f.id, f.verdict])) : {};
  const out = { todo: "067", script: "bench/stacked-real.js", review: reviewFile, bars_per_100: BARS, sets: {}, flags: [] };
  for (const [name, dirs] of Object.entries(SETS)) {
    const keep = name === "held_out_game" ? (f) => f.endsWith("-clean.png") : () => true;
    // A missing negatives folder makes the run unmeasured (exit 1), never a smaller pass; the game captures arrive later.
    const missing = name === "held_out_game" ? [] : dirs.filter((d) => !fs.existsSync(path.join(DATA, d)));
    const rows = read(dirs.flatMap((d) => (fs.existsSync(path.join(DATA, d)) ? images(path.join(DATA, d)) : [])).filter(keep));
    const checked = rows.filter((r) => !r.unchecked);
    let falseScreens = 0, realScreens = 0, unreviewed = 0;
    for (const r of checked.filter((x) => x.stacked.length)) {
      const ids = r.stacked.map((f) => `${r.path}#${f.box.join(",")}`);
      for (const [i, f] of r.stacked.entries()) out.flags.push({ id: ids[i], set: name, line: f.a.text, corrected: f.corrected, evidence: f.stacked_evidence, box: f.box, verdict: verdicts[ids[i]] ?? "unreviewed" });
      const vs = ids.map((id) => verdicts[id] ?? "unreviewed");
      if (vs.includes("false-alarm")) falseScreens++;
      else if (vs.includes("unreviewed")) unreviewed++;
      else realScreens++;
    }
    const fa = falseScreens + unreviewed; // unreviewed counts against the reader until a person looks
    out.sets[name] = {
      folders: dirs, missing, screens: rows.length, checked: checked.length, unchecked: rows.length - checked.length,
      flagged_screens: falseScreens + realScreens + unreviewed, false_alarm_screens: falseScreens, real_screens: realScreens, unreviewed_screens: unreviewed,
      false_alarms_per_100: per100(fa, checked.length), false_alarms_ci_per_100: (wilson(fa, checked.length) || []).map((x) => Number((100 * x).toFixed(2))),
    };
  }
  const pos = JSON.parse(fs.readFileSync(path.join(__dirname, "stacked/positives.json"), "utf8"));
  const positives = (Array.isArray(pos) ? pos : [pos]).filter((p) => fs.existsSync(path.join(DATA, p.file)));
  const prow = read(positives.map((p) => path.join(DATA, p.file)));
  let regions = 0, found = 0, titles = 0, titlesFound = 0, core = 0, coreFound = 0;
  for (const p of positives) {
    const r = prow.find((x) => x.path === p.file);
    for (const reg of p.regions) {
      const f = (r?.stacked || []).some((x) => hits(x.box, reg.box));
      regions++; if (f) found++;
      if (reg.role === "title") { titles++; if (f) titlesFound++; }
      if (reg.role === "title" || reg.role === "subtitle") { core++; if (f) coreFound++; }
    }
  }
  const caps = fs.existsSync(path.join(DATA, "stacked-text")) ? images(path.join(DATA, "stacked-text")).filter((f) => f.endsWith("-stacked.png")) : [];
  const crow = read(caps);
  // An unchecked stacked screen (Tesseract read, or a failed second read) is a miss, so a partial timeout cannot lift recall.
  const cfound = crow.filter((r) => !r.unchecked && r.stacked.length).length, cn = crow.filter((r) => !r.unchecked).length, all = crow.length;
  out.recapture = {
    screens: all, checked: cn, unchecked: all - cn, found: cfound, recall: all ? Number((cfound / all).toFixed(4)) : null, ci: wilson(cfound, all),
    by_locale: Object.fromEntries([...new Set(crow.map((r) => r.locale))].sort().map((l) => {
      const rs = crow.filter((r) => r.locale === l);
      return [l, `${rs.filter((r) => !r.unchecked && r.stacked.length).length}/${rs.length}`];
    })),
  };
  out.positives = {
    screens: positives.length, regions, regions_found: found, region_recall: regions ? Number((found / regions).toFixed(4)) : null,
    title_and_subtitle_found: `${coreFound}/${core}`, sheets_with_title_found: titlesFound, sheets: titles, sheet_recall: titles ? Number((titlesFound / titles).toFixed(4)) : null, sheet_recall_ci: wilson(titlesFound, titles),
    note: "the owner's screen, scored per region; the recapture is scored per screen under recapture",
  };
  // The held-out false-alarm rate counts the study screens and the fixed game captures together.
  const h = ["held_out", "held_out_game"].map((k) => out.sets[k]);
  const checked = h.reduce((n, x) => n + x.checked, 0), fa = h.reduce((n, x) => n + x.false_alarm_screens + x.unreviewed_screens, 0);
  out.held_out_total = { checked, false_alarm_screens: fa, per_100: per100(fa, checked), ci_per_100: (wilson(fa, checked) || []).map((x) => Number((100 * x).toFixed(2))) };
  const rate = out.held_out_total.per_100;
  // D24: default-on needs both the false-alarm bar and recall >= 0.80 on the recaptured stacked screens; "Done when"
  // also needs the owner's title found here and bench/stacked.js held-out precision >= 0.95 (its own exit code).
  const rec = out.recapture.recall;
  const missing = Object.values(out.sets).flatMap((s) => s.missing);
  const why = rate > BARS.default_on ? "false alarms over 1 per 100" : rec === null ? "recapture not measured"
    : rec < 0.8 ? `recapture recall ${rec} under 0.80` : !core || coreFound < core ? "owner's title or subtitle not found" : null;
  out.tier = rate === null || missing.length ? "unmeasured" : rate >= BARS.experimental ? "none" : why ? `experimental (${why})` : "default-on";
  const v = versionInfo();
  Object.assign(out, {
    catscan: v.catscan, chip: v.host.chip, macos: v.macos, macos_build: v.macos_build, vision_revision: v.vision_revision,
    node: process.version, date: new Date().toISOString().slice(0, 10),
    swiftc: execFileSync("swiftc", ["--version"], { encoding: "utf8" }).split("\n")[0],
  });
  process.stdout.write(JSON.stringify(out, null, 1) + "\n");
  process.exit(out.tier === "none" || out.tier === "unmeasured" ? 1 : 0);
}
