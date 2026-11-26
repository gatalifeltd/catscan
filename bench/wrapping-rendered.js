#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-074 "Measurement", rendered positives: the spec 14 sample apps and the probe wrapping screen, built in en and
// with the pseudo-locale (`catscan pseudo --expand 40`), captured on an iOS simulator and an Android emulator with
// sidecars (bench/wrapping/rendered.mjs). Every element was labeled by hand (bench/wrapping/rendered-labels.json).
// This runs `catscan fit --reasons wrapped,orphan --experimental --layout '{locale}/{screen}' --base-locale en` per
// platform and scores recall per reason (gate: >= 0.80) and precision on the labeled negatives, with Wilson intervals.
// A finding is matched to a label through its element: the sidecar element with the finding's element box gives
// the id and text the label names.
// Usage: node bench/wrapping-rendered.js [--set datasets/wrapping-rendered] > results/wrapping-rendered.json
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const SET = path.resolve(argv[argv.indexOf("--set") + 1] && argv.includes("--set") ? argv[argv.indexOf("--set") + 1] : path.join(ROOT, "datasets/wrapping-rendered"));
const LABELS = require("./wrapping/rendered-labels.json");

function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)].map((x) => Math.round(x * 10000) / 10000);
}
const r4 = (x) => Math.round(x * 10000) / 10000;
const same = (a, b) => a.length === 4 && b.length === 4 && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);

const versions = {};
// paired: the pseudo folder is mapped as fr, so each screen pairs with its en screen (base evidence) and Vision reads
// it as French. read-as-en: the folder is left unmapped (no reader knows en-XA), so it is read as en, as catscan reads a
// pseudo build, and only control evidence applies.
function score(paired) {
const flagged = []; // { path, id, text, box, reason, evidence, rows, holders }
const sidecars = new Map();

for (const platform of ["ios", "android"]) {
  const dir = path.join(SET, platform);
  if (!fs.existsSync(dir)) continue;
  try { versions[platform] = JSON.parse(fs.readFileSync(path.join(dir, "versions.json"), "utf8")); } catch { versions[platform] = null; }
  // --layout maps only locales a reader knows, and a pseudo folder (en-XA) is none: run on a mirror whose pseudo
  // folder is named fr (a known Latin-script locale; pseudo text is accented Latin), with every file linked, then map the paths back.
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wrap-rendered-"));
  for (const loc of fs.readdirSync(dir).filter((x) => fs.statSync(path.join(dir, x)).isDirectory())) {
    const to = path.join(mirror, paired && loc === "en-XA" ? "fr" : loc);
    fs.mkdirSync(to);
    for (const f of fs.readdirSync(path.join(dir, loc))) fs.symlinkSync(path.join(dir, loc, f), path.join(to, f));
  }
  const back = (p) => path.join(dir, path.relative(mirror, p).replace(paired ? /^fr(?=\/)/ : /^$/, "en-XA"));
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin/catscan.js"), "fit", mirror, "--json", "--experimental", "--reasons", "wrapped,orphan", "--boxes", mirror, "--layout", "{locale}/{screen}", "--base-locale", "en"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const e = JSON.parse(line);
    e.path = back(e.path);
    const rel = path.relative(SET, e.path).split(path.sep).join("/");
    const side = e.path.replace(/\.png$/i, ".boxes.json");
    const els = fs.existsSync(side) ? JSON.parse(fs.readFileSync(side, "utf8")).elements : [];
    for (const f of e.findings || []) {
      const el = els.find((x) => f.element && same(x.box, f.element.box));
      flagged.push({ path: rel, id: el?.id ?? null, text: el?.text ?? null, box: f.element?.box ?? null, reason: f.reason, evidence: f.evidence, rows: f.rows });
    }
    sidecars.set(rel, els);
  }
}

// A label names an element by id or text; on iOS the id is often on the Button and the line's element is the
// StaticText inside it, so an element 90% inside the labeled one matches too.
const inside = (a, b) => {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return x1 > x0 && y1 > y0 && (x1 - x0) * (y1 - y0) >= 0.9 * a[2] * a[3];
};
const matches = (l, k) => {
  if (k.path !== l.path) return false;
  if (l.id && k.id === l.id) return true;
  if (l.text && k.text === l.text) return true;
  const holder = l.id && (sidecars.get(l.path) || []).find((e) => e.id === l.id);
  return Boolean(holder && k.box && inside(k.box, holder.box));
};
const found = { has: (key) => Boolean(find(key)), get: (key) => find(key) };
const LMAP = new Map();
function find(key) { const [l, reason] = LMAP.get(key) || []; return l ? flagged.find((k) => k.reason === reason && matches(l, k)) : null; }

const out = { todo: "TODO-074", script: "bench/wrapping-rendered.js", labels: "bench/wrapping/rendered-labels.json", per_reason: {}, misses: [], false_positives: [], unlabeled_flags: [] };
const labelKey = (l, reason) => { const k = `${l.path}|${l.id ?? l.text}|${reason}`; LMAP.set(k, [l, reason]); return k; };
const used = new Set();
for (const reason of ["wrapped", "orphan"]) {
  for (const platform of ["ios", "android", "all"]) {
    const ls = LABELS.labels.filter((l) => platform === "all" || l.platform === platform);
    const pos = ls.filter((l) => l[reason]), neg = ls.filter((l) => !l[reason]);
    const tp = pos.filter((l) => found.has(labelKey(l, reason)));
    const fp = neg.filter((l) => found.has(labelKey(l, reason)));
    for (const l of [...pos, ...neg]) used.add(labelKey(l, reason));
    const inSide = pos.filter((l) => l.in_sidecar !== false);
    out.per_reason[`${reason}:${platform}`] = {
      positives: pos.length, found: tp.length, recall: pos.length ? r4(tp.length / pos.length) : null, recall_wilson95: wilson(tp.length, pos.length),
      positives_in_sidecar: inSide.length, recall_in_sidecar: inSide.length ? r4(tp.length / inSide.length) : null,
      negatives: neg.length, false_positives: fp.length, precision: tp.length + fp.length ? r4(tp.length / (tp.length + fp.length)) : null,
      by_evidence: reason === "wrapped" ? Object.fromEntries(["declared", "base", "control"].map((ev) => [ev, tp.filter((l) => found.get(labelKey(l, reason)).evidence === ev).length])) : undefined,
      pass: platform !== "all" || (pos.length > 0 && tp.length / pos.length >= 0.8),
    };
    if (platform === "all") {
      out.misses.push(...pos.filter((l) => !found.has(labelKey(l, reason))).map((l) => ({ reason, path: l.path, id: l.id, kind: l.kind, rows: l.rows, in_sidecar: l.in_sidecar !== false })));
      out.false_positives.push(...fp.map((l) => ({ reason, path: l.path, id: l.id, kind: l.kind, evidence: found.get(labelKey(l, reason)).evidence })));
    }
  }
}
out.unlabeled_flags = flagged.filter((k) => !LABELS.labels.some((l) => matches(l, k))).map(({ path: p, id, text, reason, evidence }) => ({ path: p, id, text, reason, evidence }));
out.gate = { wrapped: out.per_reason["wrapped:all"].pass, orphan: out.per_reason["orphan:all"].pass };
  return out;
}
const out = { todo: "TODO-074", script: "bench/wrapping-rendered.js", labels: "bench/wrapping/rendered-labels.json", paired: score(true), read_as_en: score(false) };
out.gate = { wrapped: out.paired.gate.wrapped && out.read_as_en.gate.wrapped, orphan: out.paired.gate.orphan && out.read_as_en.gate.orphan };
out.versions = versions;
out.date = new Date().toISOString().slice(0, 10);
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
process.exitCode = out.gate.wrapped && out.gate.orphan ? 0 : 1; // a reason passes only in both modes
