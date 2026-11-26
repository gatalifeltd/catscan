#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-054 synthetic leg (T3, "Measurement", D9): one line per image drawn by bench/contrast/generate.swift at a known
// colour pair, read by `catscan contrast --experimental --scale <n>` exactly as a user runs it, scored per image.
// low-contrast: positive when the drawn ratio is below the WCAG AA threshold for the drawn size by more than 2% (D2);
// a flag is correct when the drawn ratio is below the threshold at all. Mixed-colour and outlined lines are uncertain by
// design (D17): they count against precision when flagged wrongly and are left out of recall.
// busy-background: positive on the busy, photo and photo-under backgrounds; the icon beside a button is a negative.
// Even-numbered images are the dev half (thresholds were set there), odd ones held out (D21).
// Usage: node bench/contrast.js [--keep <dir>] [--timing <dir>] > results/contrast.json
//   (exit 1 when the held-out half misses a gate or nothing was read)
//   --timing <dir>: median ms of `contrast` over `read` on the screenshots in <dir> (spec "Constraints", +15 ms).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { run } = require("./overlap");
const { wilson } = require("./stacked");

const ROOT = path.resolve(__dirname, "..");
const GATE = { "low-contrast": { precision: 0.95, recall: 0.9 }, "busy-background": { precision: 0.9, recall: 0.9 } };
const AA = { normal: 4.5, large: 3 };
const MARGIN = 1.02;
const BUSY_BG = new Set(["busy", "photo", "photo-under"]);
const UNCERTAIN = new Set(["mixed-colour", "outlined"]);

function generate(dir) {
  const bin = path.join(os.tmpdir(), "catscan-contrast-generate");
  execFileSync("swiftc", ["-O", path.join(__dirname, "contrast", "generate.swift"), "-o", bin], { stdio: ["ignore", "ignore", "inherit"] });
  execFileSync(bin, [dir], { stdio: ["ignore", "ignore", "inherit"] });
}

function rows(dir, labels) {
  const out = [];
  const groups = new Map();
  for (const l of labels) {
    const k = `${l.locale}|${l.scale}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  for (const [k, ls] of groups) {
    const [locale, scale] = k.split("|");
    const by = new Map(ls.map((l) => [path.join(dir, l.name), l]));
    for (const env of run("contrast", [...by.keys()], locale, ["--experimental", "--scale", scale])) {
      const l = by.get(env.path);
      if (!l) continue;
      const fs_ = env.findings || [];
      out.push({ label: l, verdict: env.verdict, read: (env.lines || []).length > 0, lc: fs_.filter((f) => f.kind === "low-contrast"), bb: fs_.filter((f) => f.kind === "busy-background"), lines: env.lines || [] });
    }
  }
  return out;
}

const truthFails = (l, margin = 1) => l.truth < AA[l.size] / margin;

function score(rs) {
  const read = rs.filter((r) => r.read);
  const lc = { tp: 0, fp: 0, fn: 0, positives: 0, false_alarms: [] };
  const bb = { tp: 0, fp: 0, fn: 0, positives: 0, false_alarms: [] };
  for (const r of read) {
    const l = r.label;
    const flagged = r.lc.length > 0;
    if (flagged) {
      if (truthFails(l)) lc.tp++;
      else { lc.fp++; if (lc.false_alarms.length < 25) lc.false_alarms.push({ name: l.name, truth: l.truth, size: l.size, found: r.lc.map((f) => [f.ratio, f.threshold, f.size, f.ink, f.background]) }); }
    }
    if (!UNCERTAIN.has(l.variant) && truthFails(l, MARGIN)) {
      lc.positives++;
      if (!flagged) lc.fn++;
    }
    const busy = r.bb.length > 0;
    if (busy && l.busy) bb.tp++;
    else if (busy) { bb.fp++; if (bb.false_alarms.length < 25) bb.false_alarms.push({ name: l.name, edges: r.bb.map((f) => f.edges) }); }
    if (l.busy) { bb.positives++; if (!busy) bb.fn++; }
  }
  const fin = (s) => {
    const flags = s.tp + s.fp;
    return { precision: flags ? Number((s.tp / flags).toFixed(4)) : null, precision_ci: wilson(s.tp, flags), recall: s.positives ? Number(((s.positives - s.fn) / s.positives).toFixed(4)) : null,
      recall_ci: wilson(s.positives - s.fn, s.positives), flags, positives: s.positives, missed: s.fn, false_alarms: s.false_alarms };
  };
  return { images: rs.length, read: read.length, unread: rs.length - read.length, "low-contrast": fin(lc), "busy-background": fin(bb) };
}

/** Recall and precision per background, variant, font and size, so a weak cell is visible (held-out only). */
function cells(rs, key) {
  const out = {};
  for (const r of rs.filter((x) => x.read)) {
    const k = key(r.label);
    out[k] ??= { n: 0, lc_flags: 0, lc_wrong: 0, lc_pos: 0, lc_found: 0, bb_flags: 0, busy: 0 };
    const c = out[k];
    c.n++;
    if (r.lc.length) { c.lc_flags++; if (!truthFails(r.label)) c.lc_wrong++; }
    if (!UNCERTAIN.has(r.label.variant) && truthFails(r.label, MARGIN)) { c.lc_pos++; if (r.lc.length) c.lc_found++; }
    if (r.bb.length) c.bb_flags++;
    if (r.label.busy) c.busy++;
  }
  return out;
}

/** Median `contrast` minus `read` time per screenshot (env.ms, the core's own clock) on real screens. */
function timing(dir) {
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(png|jpe?g)$/i.test(f)).slice(0, 40).map((f) => path.join(dir, f));
  const ms = (cmd, extra) => run(cmd, files, null, extra).map((e) => e.ms);
  ms("read", []); // warm the Vision models
  const read = ms("read", []), con = ms("contrast", ["--experimental", "--scale", "3"]);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const size = require("../packages/core-js/src/boxes").imageSize(files[0]);
  return { screens: files.length, first_size: `${size.width}x${size.height}`, read_ms: med(read), contrast_ms: med(con), added_ms: med(con.map((c, i) => c - read[i])), budget_ms: 15 };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep") ? argv[argv.indexOf("--keep") + 1] : null;
  const timingDir = argv.includes("--timing") ? argv[argv.indexOf("--timing") + 1] : null;
  const dir = keep || fs.mkdtempSync(path.join(os.tmpdir(), "catscan-contrast-"));
  if (!fs.existsSync(path.join(dir, "labels.json"))) generate(dir);
  const labels = JSON.parse(fs.readFileSync(path.join(dir, "labels.json"), "utf8")).images;
  // --keep also caches the envelopes' lines, for offline analysis of the dev half (rows.json).
  const all = rows(dir, labels);
  if (keep) fs.writeFileSync(path.join(dir, "rows.json"), JSON.stringify(all.map((r) => ({ name: r.label.name, lines: r.lines.map((l) => ({ text: l.text, box: l.box, confidence: l.confidence, ...l.contrast })), lc: r.lc.length, bb: r.bb.length }))));
  const half = (h) => all.filter((r) => r.label.half === h);
  const held = half("held_out");
  const out = {
    todo: "054", script: "bench/contrast.js", generator: "bench/contrast/generate.swift", manifest: "bench/contrast/manifest.json",
    tools: { ...versionInfo(), node: process.version, swift: execFileSync("swift", ["--version"], { encoding: "utf8" }).split("\n")[0], xcode: execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }).split("\n").join(" ").trim() },
    gate: GATE, margin: MARGIN, level: "AA",
    dev: score(half("dev")), held_out: score(held),
    held_out_cells: { background: cells(held, (l) => l.bg), variant: cells(held, (l) => l.variant), font: cells(held, (l) => l.font), size: cells(held, (l) => `${l.size}-${l.pt}pt`), locale: cells(held, (l) => l.locale), mode: cells(held, (l) => l.mode) },
  };
  if (timingDir) out.timing = timing(timingDir);
  out.verdict = Object.fromEntries(Object.entries(GATE).map(([k, g]) => {
    const s = out.held_out[k];
    return [k, { passed: s.precision !== null && s.recall !== null && s.precision >= g.precision && s.recall >= g.recall, precision: s.precision, recall: s.recall }];
  }));
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = out.held_out.read && Object.values(out.verdict).every((v) => v.passed) ? 0 : 1;
}

module.exports = { score, truthFails, AA, MARGIN, GATE };
