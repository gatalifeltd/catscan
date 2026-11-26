#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-054 real-screen leg (T3, D9, D16, D21): `catscan contrast --experimental` as a user runs it on the lab screens.
// With boxes: datasets/truncation and truncation-android with their sidecars (--boxes); without: datasets/d1 and d2.
// Screens split into dev and held-out halves by screen identity (one screen in every locale stays in one half, D21).
// Every flag gets an id (<path>#<kind>#<box>); datasets/contrast-review.json (gitignored), written by a reviewer
// from the contact sheets, labels flags `real | exempt | false-alarm` and the lines a suppression rule removed
// `finding | not-finding`. A false alarm is `false-alarm`, and `exempt` too without boxes (D9).
// Verdict per kind and mode on the held-out half: under 2 false alarms per 100 screens. With every flag labelled the
// rate is counted; with a random labelled sample it is estimated (flags x sample false-alarm share, Wilson 95%), and
// the kind fails only when the interval's low end is at or over the bar (D32); a pass needs every flag labelled.
// Usage: node bench/contrast-real.js [--review datasets/contrast-review.json] [--sheets <dir>] [--sample <n>]
//          > results/contrast-real.json
//   --sheets <dir>: contact sheets of a seeded random sample of <n> held-out flags per kind and mode (default 60), of
//   the lines each suppression rule removed, and of 300 measured unflagged lines (the miss audit, D16).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { run } = require("./overlap");
const { wilson } = require("./stacked");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "datasets");
const SETS = { boxes: ["truncation", "truncation-android"], "no-boxes": ["d1", "d2"] };
const BAR = 2; // false alarms per 100 held-out screens (spec 12, D9)
const KINDS = ["low-contrast", "busy-background"];

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

/** D21: the screen across locales: the set, the folders above the locale, the name without its number and locale. */
function identity(rel) {
  const parts = rel.split(path.sep);
  const locale = parts[parts.length - 2];
  const name = parts[parts.length - 1].replace(/\.\w+$/, "").replace(/^\d+-/, "").replace(new RegExp(`(^|-)${locale.replace(/[-]/g, "\\-")}(-|$)`), "$1");
  return [...parts.slice(0, -2), name].join("/");
}
const half = (rel) => (crypto.createHash("sha256").update(identity(rel)).digest()[0] % 2 === 0 ? "dev" : "held_out");

function read(mode) {
  const out = [];
  for (const set of SETS[mode]) {
    const files = images(path.join(DATA, set));
    const byDir = new Map();
    for (const f of files) {
      const d = path.dirname(f);
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(f);
    }
    for (const [dir, fs_] of byDir) {
      const locale = path.basename(dir);
      const extra = ["--experimental", ...(mode === "boxes" ? ["--boxes", dir] : [])];
      for (const env of run("contrast", fs_, /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(locale) ? locale : null, extra)) {
        const rel = path.relative(DATA, env.path);
        out.push({ path: rel, half: half(rel), verdict: env.verdict, scale: env.findings?.[0]?.scale_source ?? null, findings: (env.findings || []).filter((f) => KINDS.includes(f.kind)), lines: env.lines || [], warnings: (env.warnings || []).map((w) => w.code) });
      }
    }
  }
  return out;
}

const idOf = (r, f) => `${r.path}#${f.kind}#${f.box.join(",")}`;
const lineId = (r, l) => `${r.path}#line#${l.box.join(",")}`;

function seeded(list, n, seed) {
  return list.map((x) => [crypto.createHash("sha256").update(seed + JSON.stringify(x.id)).digest("hex"), x]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, n).map((p) => p[1]);
}

function sheet(dir, name, items) {
  if (!items.length) return null;
  const bin = path.join(os.tmpdir(), "catscan-contrast-sheet");
  if (!fs.existsSync(bin)) execFileSync("swiftc", ["-O", path.join(__dirname, "contrast", "sheet.swift"), "-o", bin], { stdio: ["ignore", "ignore", "inherit"] });
  const files = [];
  for (let i = 0; i < items.length; i += 25) {
    const tsv = path.join(dir, `${name}-${i / 25}.tsv`);
    fs.writeFileSync(tsv, items.slice(i, i + 25).map((x, k) => [i + k, path.join(DATA, x.path), ...x.box].join("\t")).join("\n"));
    const png = tsv.replace(/\.tsv$/, ".png");
    execFileSync(bin, [tsv, png]);
    files.push(png);
  }
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(items.map((x, k) => ({ n: k, id: x.id, text: x.text, ratio: x.ratio ?? null })), null, 1));
  return files;
}

/** The false-alarm rate per 100 held-out screens for one kind and mode, counted or estimated from labels. */
function verdict(flags, screens, labels, mode) {
  const bad = (v) => v === "false-alarm" || (mode === "no-boxes" && v === "exempt");
  const labelled = flags.filter((f) => labels[f.id]);
  const fa = labelled.filter((f) => bad(labels[f.id])).length;
  const per100 = (k) => Number(((100 * k) / screens).toFixed(2));
  if (!flags.length) return { screens, flags: 0, labelled: 0, false_alarms: 0, per_100: 0, passed: true, method: "counted" };
  if (labelled.length === flags.length) return { screens, flags: flags.length, labelled: labelled.length, false_alarms: fa, per_100: per100(fa), passed: per100(fa) < BAR, method: "counted" };
  if (!labelled.length) return { screens, flags: flags.length, labelled: 0, per_100: null, passed: false, method: "unreviewed" };
  const ci = wilson(fa, labelled.length);
  const est = (p) => Number(((100 * p * flags.length) / screens).toFixed(2));
  const low = est(ci[0]);
  return { screens, flags: flags.length, labelled: labelled.length, sample_false_alarms: fa, per_100: est(fa / labelled.length), per_100_ci: [low, est(ci[1])], passed: false, failed_by_sample: low >= BAR, method: "sampled" };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const reviewFile = opt("--review");
  const sheets = opt("--sheets");
  const sampleN = Number(opt("--sample", "60"));
  const review = reviewFile && fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, "utf8")) : { flags: {}, removed: {}, audit: {} };
  const out = { todo: "054", script: "bench/contrast-real.js", review: reviewFile, bar_per_100: BAR, tools: { ...versionInfo(), node: process.version }, modes: {} };
  for (const mode of Object.keys(SETS)) {
    const rows = read(mode);
    const m = { sets: SETS[mode], screens: { dev: 0, held_out: 0 }, scale_source_flagged: {}, kinds: {}, skipped: {}, uncertain_lines: 0, measured_lines: 0 };
    for (const r of rows) {
      m.screens[r.half]++;
      // The scale source is on findings only, so this tallies flagged screens (red-team review, TODO-054 PR 1).
      if (r.scale) m.scale_source_flagged[r.scale] = (m.scale_source_flagged[r.scale] || 0) + 1;
      for (const l of r.lines) {
        if (l.contrast?.skipped) m.skipped[l.contrast.skipped] = (m.skipped[l.contrast.skipped] || 0) + 1;
        else if (l.contrast) { m.measured_lines++; if (l.contrast.uncertain) m.uncertain_lines++; }
      }
    }
    for (const kind of KINDS) {
      const flags = (h) => rows.filter((r) => r.half === h).flatMap((r) => r.findings.filter((f) => f.kind === kind).map((f) => ({ id: idOf(r, f), path: r.path, box: f.box, text: f.line, ratio: f.ratio })));
      const held = flags("held_out"), dev = flags("dev");
      m.kinds[kind] = { dev_flags: dev.length, dev_screens_flagged: new Set(dev.map((f) => f.path)).size, held_out: verdict(held, m.screens.held_out, review.flags || {}, mode) };
      if (sheets) m.kinds[kind].sheets = sheet(sheets, `${mode}-${kind}`, seeded(held, sampleN, `${mode}${kind}`));
    }
    // D16: what each suppression rule removed (held-out), and the miss audit over measured unflagged lines.
    const removed = {};
    for (const reason of ["not-text", "covered", "disabled"]) {
      const lines = rows.filter((r) => r.half === "held_out").flatMap((r) => r.lines.filter((l) => l.contrast?.skipped === reason).map((l) => ({ id: lineId(r, l), path: r.path, box: l.box, text: l.text })));
      const lab = lines.filter((l) => review.removed?.[l.id]);
      const notFinding = lab.filter((l) => review.removed[l.id] === "not-finding").length;
      removed[reason] = { removed: lines.length, labelled: lab.length, not_finding: notFinding, share: lab.length ? Number((notFinding / lab.length).toFixed(3)) : null, kept: lab.length ? notFinding / lab.length >= 0.9 : null };
      if (sheets) removed[reason].sheets = sheet(sheets, `${mode}-removed-${reason}`, seeded(lines, 50, `${mode}${reason}`));
    }
    m.removed = removed;
    const flagged = new Set(rows.flatMap((r) => r.findings.map((f) => `${r.path}#line#${f.box.join(",")}`)));
    const unflagged = rows.filter((r) => r.half === "held_out").flatMap((r) => r.lines.filter((l) => l.contrast && !l.contrast.skipped && !flagged.has(lineId(r, l))).map((l) => ({ id: lineId(r, l), path: r.path, box: l.box, text: l.text, ratio: l.contrast.ratio })));
    const audit = seeded(unflagged, mode === "no-boxes" ? 300 : 0, `${mode}audit`);
    const al = audit.filter((l) => review.audit?.[l.id]);
    m.miss_audit = { lines: audit.length, labelled: al.length, real_failures: al.filter((l) => review.audit[l.id] === "real").length };
    if (sheets && audit.length) m.miss_audit.sheets = sheet(sheets, `${mode}-audit`, audit);
    out.modes[mode] = m;
  }
  out.verdict = Object.fromEntries(KINDS.map((k) => [k, Object.fromEntries(Object.keys(SETS).map((mode) => [mode, out.modes[mode].kinds[k].held_out.passed]))]));
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

module.exports = { identity, half, verdict };
