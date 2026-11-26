#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 07 gate (D13), until the spec 05 benchmark exists: a generated 6 s 1080x1920 30 fps H.264 take with 12 timed
// labels, sampled every 0.5 s. Gates: <= 100 ms per sampled frame (decode included, median of 5 runs) and 100%
// label recall (each label found, first seen within one interval of the time it appears).
// Usage: node bench/video.js > results/video.json   (exit 1 when a gate fails)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const RUNS = 5, EVERY = 0.5, GATE = { ms_per_frame: 100, recall: 1 };
const WORDS = ["GAME OVER", "Level complete", "New high score", "Tap to continue", "Bonus round", "Daily reward",
  "Shop is open", "Quest updated", "Try again", "Victory", "Out of moves", "Treasure found"];

// Label i shows from 0.5 * i s to 0.5 * i + 1.2 s, at its own height, so every sample sees one to three labels.
const take = {
  name: "take.mp4", codec: "h264", width: 1080, height: 1920, fps: 30, duration: 6,
  labels: WORDS.map((text, i) => ({ text, from: 0.5 * i, to: 0.5 * i + 1.2, x: 90, y: 120 + i * 145, size: 72 })),
};

const gen = path.join(ROOT, ".build/video");
fs.mkdirSync(path.dirname(gen), { recursive: true });
execFileSync("swiftc", ["-O", path.join(ROOT, "test/fixtures/video.swift"), "-o", gen]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-bench-video-"));
fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify([take]));
execFileSync(gen, [path.join(dir, "take.json"), dir]);

const args = ["video", path.join(dir, "take.mp4"), "--every", String(EVERY), "--json", ...WORDS.flatMap((w) => ["--present", w])];
const runs = [];
let env;
for (let i = 0; i < RUNS; i++) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  env = JSON.parse(r.stdout.trim().split("\n").pop());
  runs.push(env.ms / env.frames);
}
runs.sort((a, b) => a - b);
const median = runs[Math.floor(RUNS / 2)];
const found = env.checks.filter((c, i) => c.verdict === "pass" && c.first_seen >= take.labels[i].from && c.first_seen <= take.labels[i].from + EVERY);
const recall = found.length / WORDS.length;
const v = versionInfo();
const out = {
  spec: "07",
  script: "bench/video.js",
  take: { width: take.width, height: take.height, fps: take.fps, duration: take.duration, codec: "h264", labels: WORDS.length, every: EVERY },
  gate: GATE,
  frames: env.frames,
  ms_per_frame: { median: Math.round(median * 10) / 10, runs: runs.map((x) => Math.round(x * 10) / 10) },
  recall,
  missed: env.checks.filter((c) => !found.includes(c)).map((c) => ({ text: c.text, verdict: c.verdict, first_seen: c.first_seen })),
  pass: median <= GATE.ms_per_frame && recall >= GATE.recall,
  tools: {
    catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, chip: v.host.chip,
    host_class: v.host.host_class, node: process.version, generator: "test/fixtures/video.swift",
  },
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
process.exit(out.pass ? 0 : 1);
