#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-044 real-screen leg: `truncated --reasons overflow` with boxes over every <app>/<locale> folder of the given
// roots (datasets/truncation*, gitignored). Prints counts only; with --detail <file> it also writes each flag (image,
// line, element, overflow) there for judging by eye, which stays outside git (spec 06 "Privacy").
// Usage: CATSCAN_CORE_BINARY=<build> node bench/overflow-real.js <root>... [--detail <file>]
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");

const CLI = path.join(__dirname, "../bin/catscan.js");
const args = process.argv.slice(2);
const at = args.indexOf("--detail");
const detail = at >= 0 ? args.splice(at, 2)[1] : null;
if (at >= 0 && !detail) throw new Error("--detail needs a file outside the repo (it holds recognized text from the dataset)");
const out = { script: "bench/overflow-real.js", roots: {}, flags: [] };
for (const root of args) {
  let screens = 0, flagged = 0, flags = 0;
  for (const app of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const loc of fs.readdirSync(path.join(root, app.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const dir = path.join(root, app.name, loc.name);
      const r = spawnSync(process.execPath, [CLI, "truncated", dir, "--boxes", dir, "--reasons", "overflow", "--locale", loc.name, "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (![0, 1].includes(r.status)) throw new Error(`${dir}: exit ${r.status}: ${r.stderr}`);
      for (const env of r.stdout.split("\n").filter(Boolean).map((x) => JSON.parse(x))) {
        if (env.verdict === "error") throw new Error(`${env.path}: ${env.error?.code}`);
        screens++;
        const f = env.findings.filter((x) => x.reason === "overflow");
        if (f.length) flagged++;
        flags += f.length;
        for (const x of f) out.flags.push({ image: path.relative(root, env.path), root: path.basename(root), line: x.line, box: x.box, element: x.element, overflow: x.overflow });
      }
    }
  }
  out.roots[path.basename(root)] = { screens, flagged_screens: flagged, flags };
}
if (detail) fs.writeFileSync(detail, JSON.stringify(out.flags, null, 2));
const v = versionInfo();
process.stdout.write(JSON.stringify({ script: out.script, roots: out.roots, tools: { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version } }, null, 2) + "\n");
