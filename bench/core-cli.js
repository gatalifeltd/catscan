#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 01 performance targets. Usage: node bench/core-cli.js <datasets dir> > results/core-cli-perf.json
// 1. check on full-resolution 1290x2796 phone screenshots: median per-image ms (decode + recognition + rules).
// 2. serve round trip for one 1290x2796 PNG, by path and by base64, sequential requests.
// 3. Batch: D1 + D2 (509 screenshots) through one CLI run, wall time.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const { Server, versionInfo, binaryPath } = require("../packages/core-js/src/client");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const datasets = path.resolve(process.argv[2] || path.join(ROOT, "datasets"));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const now = () => Number(process.hrtime.bigint()) / 1e6;

function images(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...images(p));
    else if (/\.(png|jpe?g)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function size(p) {
  const o = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", p], { encoding: "utf8" });
  return [+o.match(/pixelWidth: (\d+)/)[1], +o.match(/pixelHeight: (\d+)/)[1]];
}

(async () => {
  const batch = [path.join(datasets, "d1"), path.join(datasets, "d2")];
  const all = batch.flatMap(images);
  const phones = all.filter((p) => { const [w, h] = size(p); return w === 1290 && h === 2796; });

  // 1. check on phone screenshots, 6 passes over the set; the first (warm-up) request is excluded.
  // Sequential (--jobs 1): `ms` is the per-image time. Pool of 2 (the CLI default): per-image `ms`
  // includes waiting for the shared Neural Engine, so the amortized wall time per image is reported too.
  const phoneRun = (jobs) => {
    const reqs = [];
    for (let k = 0; k < 6; k++) for (const p of phones) reqs.push(JSON.stringify({ id: "x", command: "check", path: p, present: ["Continue"] }));
    const t0 = now();
    const r = spawnSync(binaryPath(), ["serve", "--jobs", String(jobs)], { input: reqs.join("\n") + "\n", encoding: "utf8" });
    const wall = now() - t0;
    const ms = r.stdout.trim().split("\n").slice(1).map((l) => JSON.parse(l).ms);
    return { ms: ms.slice(1), wallPerImage: wall / ms.length };
  };
  const seq = phoneRun(1);
  const pool = phoneRun(2);
  const runs = seq.ms;

  // 2. serve round trip.
  const s = new Server();
  await s.ready;
  const img = phones[0];
  const b64 = fs.readFileSync(img).toString("base64");
  await s.request({ id: "warm", command: "check", path: img, present: ["Continue"] });
  const rt = { path: [], base64: [] };
  for (let i = 0; i < 30; i++) {
    for (const mode of ["path", "base64"]) {
      const req = { id: String(i), command: "check", present: ["Continue"] };
      if (mode === "path") req.path = img; else req.image = b64;
      const t0 = now();
      await s.request(req);
      rt[mode].push(now() - t0);
    }
  }
  await s.close();

  // 3. Batch.
  const t0 = now();
  const b = spawnSync(process.execPath, [CLI, "read", ...batch, "--json"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const batchS = (now() - t0) / 1000;
  const batchN = b.stdout.trim().split("\n").length;

  const v = versionInfo();
  const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
  process.stdout.write(JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    git: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    clean_tree: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() === "",
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    catscan: v.catscan, engine: v.engine, macos: v.macos, macos_build: v.macos_build, chip: v.host.chip,
    host_class: v.host.host_class, node: process.version,
    swift: execFileSync("swift", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0].replace(/^.*?(Apple Swift version [^ ]+).*$/, "$1"),
    loadavg_1m_at_start: round(os.loadavg()[0], 2),
    phone_check: {
      images: phones.length, samples: runs.length, sequential_median_ms: median(runs), sequential_max_ms: Math.max(...runs),
      pool2_median_ms: median(pool.ms), pool2_wall_ms_per_image: round(pool.wallPerImage), target_ms: 100,
    },
    serve_round_trip: { samples: 30, path_median_ms: round(median(rt.path)), base64_median_ms: round(median(rt.base64)), target_ms: 100 },
    batch: { images: batchN, wall_s: round(batchS, 2), target_s: 45, exit: b.status },
  }, null, 2) + "\n");
})();
