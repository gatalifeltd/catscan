#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 06 synthetic benchmark (D11, D23): the 720-image set (12 locales x 20 strings x fit, ellipsis, clip),
// drawn by test/fixtures/generate.swift and labeled by construction, scored with boxes and without (the image is
// the container, as in the study). Per mode: precision, recall and precision per reason. TODO-036 adds the overflow
// mode (12 locales x 40 screens plus ar and spec 06 D68 negatives, with boxes) and its gate: precision >= 0.95 and
// recall >= 0.90, eligible coverage beside them (D11).
// Usage: node bench/truncation.js > results/truncation.json.new
// Exit 1 when precision or recall of a mode is more than 0.02 below results/truncation.json (the recorded run),
// or when that baseline or one of its modes is missing; --record writes the first baseline without the comparison.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const set = require("../test/fixtures/truncation-set");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const PER = 20;
const OVERFLOW_PER = 10; // x 4 cases = 40 screens per locale
const TOLERANCE = 0.02;
const OVERFLOW_GATE = { precision: 0.95, recall: 0.9 };

(() => {
  const gen = path.join(ROOT, ".build/synth");
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  execFileSync("swiftc", ["-O", path.join(ROOT, "test/fixtures/generate.swift"), "-o", gen]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-truncation-bench-"));
  const list = set.draw(PER, dir, OVERFLOW_PER).map((s) => ({ ...s, path: path.join(dir, s.name) }));
  const modes = {};
  const drops = [];
  const NAMES = { box: "with_boxes", crop: "without_boxes", overflow: "overflow" };
  for (const mode of ["box", "crop", "overflow"]) {
    const envs = [];
    for (const l of [...new Set(list.filter((s) => s.mode === mode).map((s) => s.locale))]) {
      const d = path.join(dir, mode, l);
      const r = spawnSync(process.execPath, [CLI, "truncated", d, "--locale", l, "--json", ...(mode !== "crop" ? ["--boxes", d] : [])], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (![0, 1].includes(r.status)) throw new Error(`${mode}/${l}: exit ${r.status}: ${r.stderr}`);
      envs.push(...r.stdout.split("\n").filter(Boolean).map((x) => JSON.parse(x)));
    }
    const sub = list.filter((s) => s.mode === mode);
    const misses = sub.filter((s) => (envs.find((e) => e.path === s.path)?.findings.length > 0) !== s.truncated).map((s) => s.name);
    modes[NAMES[mode]] = { ...set.score(sub, envs), wrong: misses };
    if (mode === "overflow") {
      // D11: every seeded line has its element in the boxes file, so every screen is eligible by construction.
      modes.overflow.eligible = 1;
      // D22: start-aligned and centered cases scored apart, each against every negative.
      const neg = sub.filter((s) => !s.truncated);
      modes.overflow.start_aligned = set.score([...sub.filter((s) => set.START_CASES.includes(s.case)), ...neg], envs);
      modes.overflow.centered = set.score([...sub.filter((s) => set.CENTER_CASES.includes(s.case)), ...neg], envs);
      // TODO-044: screens with a finding per case, so a path the average hides stays visible.
      modes.overflow.found_by_case = Object.fromEntries([...set.OVERFLOW_CASES.map((c) => c.case), "d68"].map((c) => {
        const of = sub.filter((s) => s.case === c);
        // Overflow findings only: another reason firing on the screen proves nothing about the line's assignment.
        return [c, { screens: of.length, flagged: of.filter((s) => envs.find((e) => e.path === s.path)?.findings.some((f) => f.reason === "overflow")).length }];
      }));
      modes.overflow.overflow_by_case = Object.fromEntries(set.OVERFLOW_CASES.map((c) => [c.case,
        sub.filter((s) => s.case === c.case).map((s) => envs.find((e) => e.path === s.path)?.findings.find((f) => f.reason === "overflow")?.overflow ?? null)]));
    }
  }
  const o = modes.overflow;
  for (const k of ["precision", "recall"]) if (!(o[k] >= OVERFLOW_GATE[k])) drops.push(`overflow ${k} ${o[k]} < gate ${OVERFLOW_GATE[k]} (TODO-036)`);
  const recorded = path.join(ROOT, "results/truncation.json");
  const prev = fs.existsSync(recorded) ? JSON.parse(fs.readFileSync(recorded, "utf8")) : null;
  if (!process.argv.includes("--record")) {
    // A missing baseline fails closed: the gate must compare against something (D23).
    if (!prev) drops.push("no baseline at results/truncation.json; rerun with --record to write one");
    else {
      for (const [m, s] of Object.entries(modes)) {
        if (!prev.modes?.[m]) { drops.push(`${m}: not in the baseline`); continue; }
        for (const k of ["precision", "recall"]) {
          if (s[k] < prev.modes[m][k] - TOLERANCE) drops.push(`${m} ${k} ${s[k]} < ${prev.modes[m][k]} - ${TOLERANCE}`);
        }
      }
    }
  }
  const v = versionInfo();
  const result = {
    spec: "06", script: "bench/truncation.js", strings: "bench/untranslated/strings.json", per_locale: PER, overflow_per_locale: OVERFLOW_PER, overflow_gate: OVERFLOW_GATE, locales: set.LOCALES,
    cases: set.CASES, edge_distance: 0.15, tolerance: TOLERANCE, modes, drops,
    tools: { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version, generator: "test/fixtures/generate.swift" },
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = drops.length ? 1 : 0;
})();
