#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-074 "Measurement", real screens: every app folder of the lab sets (<set>/<app>/<locale>/<screen>.png, en among
// the locales) is run through `catscan fit --reasons wrapped,orphan --experimental --layout '{locale}/{screen}'`
// with sidecars reconverted from their dumps (so `control` is set). Every flag is listed for hand review (spec 06
// D43); `--reviewed <file>` marks each flag (by path hash, element hash, reason) as a real wrap or orphan, an OCR
// row error, or a design wrap, and gives false alarms per 100 screens per reason (gate: at most 2).
// Paths and texts can name a product, so the output names screens and elements by hash only (nothing proprietary in
// git); `--review-out <file>` writes the readable list for the reviewer outside the repo.
// Usage: node bench/wrapping-real.js --real <set>... [--reviewed <file>] [--review-out <file>] > results/wrapping-real.json
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const args = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const DUMPS = [[".xcui.txt", "xcuitest"], [".uia.xml", "uiautomator"], [".maestro.json", "maestro"]];
const REASONS = ["wrapped", "orphan"];

function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)].map((x) => Math.round(x * 10000) / 10000);
}

function pngs(dir) {
  const out = [];
  const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); if (e.isDirectory()) walk(f); else if (/\.png$/i.test(e.name)) out.push(f); } };
  walk(dir);
  return out.sort();
}

/** One app folder: sidecars reconverted into a mirror tree, then one fit run over all its locales. */
function runApp(set, app) {
  const dir = path.join(set, app);
  const side = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wrap-real-"));
  const shots = pngs(dir);
  let withSide = 0;
  for (const png of shots) {
    const base = png.replace(/\.png$/i, ""), rel = path.relative(dir, base);
    const src = DUMPS.find(([e]) => fs.existsSync(base + e));
    if (!src) continue;
    const r = spawnSync(process.execPath, [path.join(ROOT, "bin/catscan.js"), "boxes", src[1], base + src[0], ...(src[1] === "xcuitest" ? [] : ["--image", png])], { encoding: "utf8" });
    if (r.status !== 0) continue;
    fs.mkdirSync(path.dirname(path.join(side, rel)), { recursive: true });
    fs.writeFileSync(path.join(side, rel + ".boxes.json"), r.stdout);
    withSide++;
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin/catscan.js"), "fit", dir, "--json", "--experimental", "--reasons", "wrapped,orphan", "--boxes", side, "--layout", "{locale}/{screen}"],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const envs = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const diag = (code) => (r.stderr.match(new RegExp(`${code}: ([^\\n]*)`)) || [null, null])[1];
  return { dir, shots: shots.length, withSide, envs, noBase: diag("wrap-no-base"), ambiguous: diag("wrap-base-ambiguous") };
}

function main() {
  const sets = args("--real");
  if (!sets.length) { process.stderr.write("usage: node bench/wrapping-real.js --real <set>... [--reviewed <file>] [--review-out <file>]\n"); process.exit(2); }
  const reviewed = args("--reviewed")[0] ? JSON.parse(fs.readFileSync(args("--reviewed")[0], "utf8")) : null;
  const marks = new Map((reviewed?.flags || []).map((f) => [`${f.path}|${f.element}|${f.reason}`, f.mark]));
  const engines = new Set();
  const out = { todo: "TODO-074", script: "bench/wrapping-real.js", sets: [], screens: 0, judged_screens: 0, flags: [], review: [] };
  for (const set of sets) {
    const apps = fs.readdirSync(set, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(set, e.name, "en"))).map((e) => e.name).sort();
    const s = { set: path.basename(set), apps: apps.length, screens: 0, with_sidecars: 0, errors: 0, no_base: [], ambiguous: [] };
    for (const app of apps) {
      const a = runApp(set, app);
      s.screens += a.shots;
      s.with_sidecars += a.withSide;
      if (a.noBase) s.no_base.push(a.noBase);
      if (a.ambiguous) s.ambiguous.push(a.ambiguous);
      for (const e of a.envs) {
        if (e.verdict === "error") { s.errors++; continue; }
        engines.add(e.engine);
        if (e.reasons_run?.length) out.judged_screens++;
        const rel = path.relative(set, e.path);
        for (const f of e.findings || []) {
          const id = { path: hash(`${path.basename(set)}/${rel}`), element: hash(f.element?.id ?? f.line), reason: f.reason, evidence: f.evidence, rows: f.rows, locale: e.locale };
          id.mark = marks.get(`${id.path}|${id.element}|${id.reason}`) ?? null;
          out.flags.push(id);
          out.review.push({ ...id, file: e.path, line: f.line, element_id: f.element?.id ?? null, box: f.box, base_path: f.base_path ?? null, orphan: f.orphan ?? null });
        }
      }
    }
    out.screens += s.screens;
    out.sets.push(s);
  }
  // Gate (D8): false alarms per 100 screens per reason; an OCR row error or a design wrap counts as false.
  out.per_reason = {};
  for (const r of REASONS) {
    const fl = out.flags.filter((f) => f.reason === r);
    const unreviewed = fl.filter((f) => f.mark === null).length;
    const real = fl.filter((f) => f.mark === "real").length;
    const fa = fl.length - real - unreviewed;
    const per100 = out.judged_screens ? Math.round((fa / out.judged_screens) * 10000) / 100 : null;
    out.per_reason[r] = { flags: fl.length, real, false_alarms: fa, unreviewed, precision: fl.length && !unreviewed ? Math.round((real / fl.length) * 10000) / 10000 : null,
      precision_by_evidence: Object.fromEntries(["declared", "base", "control"].map((ev) => { const e = fl.filter((f) => f.evidence === ev); return [ev, e.length && !unreviewed ? Math.round((e.filter((f) => f.mark === "real").length / e.length) * 10000) / 10000 : null]; })), false_alarms_per_100: per100, wilson_per_100: wilson(fa, out.judged_screens).map((x) => Math.round(x * 10000) / 100), pass: unreviewed === 0 && per100 !== null && per100 <= 2,
      by_evidence: Object.fromEntries(["declared", "base", "control"].map((ev) => [ev, fl.filter((f) => f.evidence === ev).length])) };
  }
  const reviewOut = args("--review-out")[0];
  if (reviewOut) fs.writeFileSync(reviewOut, JSON.stringify(out.review, null, 2) + "\n");
  delete out.review;
  const v = (c) => { try { return execFileSync(c[0], c.slice(1), { encoding: "utf8" }).trim().split("\n")[0]; } catch { return null; } };
  out.tools = { macos: `${v(["sw_vers", "-productVersion"])} (${v(["sw_vers", "-buildVersion"])})`, swift: v(["swift", "--version"]), node: process.version, catscan: require(path.join(ROOT, "package.json")).version, engine: [...engines].sort() };
  out.date = new Date().toISOString().slice(0, 10);
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main();
