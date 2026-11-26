#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 03 gate: check accuracy of the Tesseract fallback per locale, until the spec 05 benchmark exists.
// Usage: node bench/fallback.js > results/fallback-tesseract.json
// Draws bench/fallback/synthetic.json with test/fixtures/generate.swift (labeled by construction). Each screen
// checks its own 5 labels `present` and the 5 labels of the next screen of the same locale `absent`.
// Gate: >= 98% for el, he and bg; the other locales are informational.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Server, versionInfo, doctorInfo } = require("../packages/core-js/src/client");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = require("./fallback/synthetic.json");
const GATED = ["el", "he", "bg"];
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const first = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n")[0];

(async () => {
  const gen = path.join(ROOT, ".build/synth");
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  execFileSync("swiftc", ["-O", path.join(ROOT, "test/fixtures/generate.swift"), "-o", gen]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-fallback-"));
  execFileSync(gen, [path.join(__dirname, "fallback/synthetic.json"), dir]);

  const doctor = doctorInfo();
  if (!doctor.fallback.path) throw new Error("Tesseract is not installed; brew install tesseract tesseract-lang");
  const tessVersion = execFileSync(doctor.fallback.path, ["--version"], { encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean);

  const byLocale = {};
  for (const s of MANIFEST) (byLocale[s.locale] ||= []).push(s);
  const requests = [];
  for (const shots of Object.values(byLocale)) {
    shots.forEach((s, i) => requests.push({
      shot: s,
      present: s.lines.map((l) => l.text),
      absent: shots[(i + 1) % shots.length].lines.map((l) => l.text),
    }));
  }

  // An absent label inside a present one is a labeling error, not a reading error.
  for (const r of requests) {
    for (const a of r.absent) {
      const hit = r.present.find((p) => p.toLowerCase().includes(a.toLowerCase()));
      if (hit) throw new Error(`${r.shot.name}: absent ${JSON.stringify(a)} is inside present ${JSON.stringify(hit)}`);
    }
  }

  async function run(fallback) {
    const server = new Server();
    await server.ready;
    // Sequential, so `ms` is the per-image time with one Tesseract process at a time.
    const out = [];
    for (const [i, r] of requests.entries()) {
      out.push(await server.request({
        id: String(i), command: "check", path: path.join(dir, r.shot.name), locale: r.shot.locale,
        present: r.present, absent: r.absent, fallback,
      }));
    }
    await server.close();
    return out;
  }

  const withFallback = await run("tesseract");
  const without = await run("none");

  const locales = {};
  for (const [i, r] of requests.entries()) {
    const loc = r.shot.locale;
    const e = withFallback[i];
    const l = (locales[loc] ||= { checks: 0, correct: 0, misses: [], false_hits: [], ms: [], engine: e.engine, gated: GATED.includes(loc), fail_without_fallback: 0 });
    // An errored image (fallback-failed) counts every one of its checks as wrong, never as absent from the set.
    if (e.verdict === "error" || !String(e.engine).startsWith("tesseract-")) {
      l.checks += r.present.length + r.absent.length;
      l.errors = (l.errors || 0) + 1;
      continue;
    }
    for (const c of e.checks) {
      l.checks++;
      if (c.verdict === "pass") l.correct++;
      else if (c.kind === "present") l.misses.push({ image: r.shot.name, text: c.text, closest: c.closest?.line ?? null });
      else l.false_hits.push({ image: r.shot.name, text: c.text, line: c.line });
    }
    l.ms.push(e.ms);
    l.fail_without_fallback += without[i].checks.filter((c) => c.verdict === "fail").length;
  }
  for (const l of Object.values(locales)) {
    l.accuracy = Math.round((l.correct / l.checks) * 10000) / 100;
    l.median_ms = median(l.ms);
    delete l.ms;
  }
  const gate = GATED.every((g) => locales[g].accuracy >= 98);
  const v = versionInfo();
  const result = {
    spec: "03-unsupported-fallback",
    script: "node bench/fallback.js",
    dataset: { manifest: "bench/fallback/synthetic.json", images: MANIFEST.length, generator: "test/fixtures/generate.swift" },
    tools: {
      catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, chip: v.host.chip, host_class: v.host.host_class,
      vision_revision: v.vision_revision, node: process.version, swift: first("swift", ["--version"]),
      tesseract: tessVersion[0], leptonica: tessVersion[1], tesseract_path: doctor.fallback.path,
    },
    gate: { threshold: 98, locales: GATED, pass: gate },
    no_false_fail_without_fallback: Object.values(locales).every((l) => l.fail_without_fallback === 0),
    locales,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = gate ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(5); });
