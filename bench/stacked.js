#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-067 synthetic leg (D8): sheets whose pages are drawn over each other, drawn by bench/stacked/generate.swift
// (13 locales x 4 backgrounds x 9 kinds), read by `catscan overlap --experimental` exactly as a user runs it, and
// scored on the `stacked` reader's findings. Even-numbered images are the dev half, odd ones held out (the rule's
// filters were fixed in T0 on the dev half and real calibration screens, results/spike-stacked.txt).
// A finding is a hit when it covers 30% of a stacked region (title, subtitle, counter); any other finding is a false
// alarm. Recall is per stacked region.
// Usage: node bench/stacked.js [--keep <dir>] > results/stacked.json   (exit 1 when held-out precision is under 0.95 or no
//   held-out finding was made)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { run } = require("./overlap");

// TODO-067 "Done when" and D24: precision gates; recall is published, not gated (the default-on gate is real screens).
const GATE = { precision: 0.95 };

function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Number(Math.max(0, c - h).toFixed(4)), Number(Math.min(1, c + h).toFixed(4))];
}
const area = (b) => Math.max(0, b[2]) * Math.max(0, b[3]);
function inter(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}
const hits = (box, region) => { const i = inter(box, region); return i > 0 && i >= 0.3 * Math.min(area(box), area(region)); };
const script = (l) => (["ja", "ko", "zh-Hans"].includes(l) ? "cjk" : ["ru", "uk"].includes(l) ? "cyrillic" : "latin");

/** Precision over stacked findings, recall per stacked region, by group. */
function score(rows) {
  let tp = 0, fp = 0, cleanImages = 0, cleanFlagged = 0;
  const groups = {};
  const add = (g, found) => { (groups[g] ||= { found: 0, regions: 0 }).regions++; if (found) groups[g].found++; };
  for (const r of rows) {
    const stacked = r.label.regions.filter((x) => x.stacked);
    const fs_ = r.findings.filter((f) => f.signal === "stacked");
    for (const f of fs_) (stacked.some((x) => hits(f.box, x.box)) ? tp++ : fp++);
    if (!stacked.length) { cleanImages++; if (fs_.length) cleanFlagged++; }
    for (const x of stacked) {
      const found = fs_.some((f) => hits(f.box, x.box));
      const key = `${r.label.kind}@${r.label.offset.toFixed(2)}`;
      for (const g of [key, `role=${x.role}`, `bg=${r.label.bg}`, `script=${script(r.label.locale)}`, `locale=${r.label.locale}`, "all"]) add(g, found);
      if (r.label.kind === "stack3" || (r.label.kind === "stack2" && r.label.offset <= 0.25)) add("gated", found);
    }
  }
  const out = {};
  for (const [g, v] of Object.entries(groups).sort()) out[g] = { ...v, recall: Number((v.found / v.regions).toFixed(4)), ci: wilson(v.found, v.regions) };
  const precision = tp + fp ? Number((tp / (tp + fp)).toFixed(4)) : null;
  return {
    findings: tp + fp, true_findings: tp, precision, precision_ci: wilson(tp, tp + fp), clean_images: cleanImages, clean_images_flagged: cleanFlagged,
    recall: out, precision_pass: precision !== null && precision >= GATE.precision, // no finding at all is a broken reader, not a pass
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep") ? argv[argv.indexOf("--keep") + 1] : null;
  const dir = keep || fs.mkdtempSync(path.join(os.tmpdir(), "catscan-stacked-"));
  if (!fs.existsSync(path.join(dir, "labels.json"))) {
    const gen = path.join(os.tmpdir(), `catscan-stacked-gen-${process.pid}`);
    execFileSync("swiftc", ["-O", path.join(__dirname, "stacked/generate.swift"), "-o", gen]);
    execFileSync(gen, [dir], { cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "ignore", "inherit"] });
    fs.rmSync(gen, { force: true });
  }
  const labels = JSON.parse(fs.readFileSync(path.join(dir, "labels.json"), "utf8"));
  const byFile = new Map(labels.map((l) => [l.file, l]));
  const rows = [];
  for (const locale of [...new Set(labels.map((l) => l.locale))]) {
    const files = labels.filter((l) => l.locale === locale).map((l) => path.join(dir, l.file));
    for (const env of run("overlap", files, locale, [], { stacked: true, experimental: false })) {
      const label = byFile.get(path.relative(dir, env.path));
      if (label) rows.push({ label, dev: Number(path.basename(label.file).slice(0, 4)) % 2 === 0, findings: env.findings || [], verdict: env.verdict });
    }
  }
  const v = versionInfo();
  const held = score(rows.filter((r) => !r.dev));
  const result = {
    todo: "067", script: "bench/stacked.js", generator: "bench/stacked/generate.swift", strings: "bench/untranslated/strings.json",
    images: rows.length, gate: GATE, held_out: held, dev: score(rows.filter((r) => r.dev)),
    catscan: v.catscan, chip: v.host.chip, macos: v.macos, macos_build: v.macos_build, vision_revision: v.vision_revision,
    node: process.version, date: new Date().toISOString().slice(0, 10),
    swiftc: execFileSync("swiftc", ["--version"], { encoding: "utf8" }).split("\n")[0],
  };
  process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(held.precision_pass ? 0 : 1);
}

module.exports = { score, hits, wilson };
