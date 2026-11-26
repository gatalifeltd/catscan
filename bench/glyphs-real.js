#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T5a real-screen leg (check 3): `missing-glyphs` over real screens with no known tofu, so every flag is a
// false-flag candidate; the published number is flags per 100 clean screens (target 0). Two sources, as the rule
// takes them: catalog strings (`catalog` sets: a folder of <locale>/ screen folders and a `{locale}` catalog of
// strings) and element boxes (`boxes` roots: <app>/<locale>/ folders with <stem>.boxes.json sidecars). The sets come
// from a config file kept outside git, because it names the apps' own files:
// {"catalog": [{"name", "screens", "catalog": "<.../x-{locale}.json>", "map"?: {"<folder>": "<locale>"}}], "boxes": [{"name", "root"}]}
// Prints counts and flag ids only; --detail <file> writes each flag (image, line, expected) there for judging by eye,
// outside git (spec 06 "Privacy").
// Usage: node bench/glyphs-real.js <config.json> [--detail <file>] > results/glyphs-real.json
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { Server, versionInfo } = require("../packages/core-js/src/client");

const args = process.argv.slice(2);
const at = args.indexOf("--detail");
const detail = at >= 0 ? args.splice(at, 2)[1] : null;
if (!args[0]) throw new Error("usage: node bench/glyphs-real.js <config.json> [--detail <file>]");
const config = JSON.parse(fs.readFileSync(args[0], "utf8"));
const IMG = /\.(png|jpe?g|heic)$/i;
const sub = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const images = (d) => fs.readdirSync(d).filter((f) => IMG.test(f)).sort().map((f) => path.join(d, f));
const id = (file, line) => crypto.createHash("sha256").update(`${path.basename(path.dirname(file))}/${path.basename(file)}\n${line}`).digest("hex").slice(0, 12);

/** Catalog strings: a JSON array of strings, or an object whose string values (nested) are the strings. */
function strings(file) {
  const o = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = new Set();
  const walk = (v) => { if (typeof v === "string") out.add(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(o);
  // Every string goes to the core, which applies its own length floors: a short label that is a catalog string
  // must stay one, or it reads as a fragment of a longer string (the first real run dropped 213 ja strings).
  return [...out].filter((s) => s.trim().length);
}

async function main() {
  const server = new Server({ jobs: Number(process.env.BENCH_JOBS || 2) });
  await server.ready;
  const out = { script: "bench/glyphs-real.js", sets: [], flag_ids: [] };
  const details = [];
  let retries = 0;
  const run = async (name, source, jobs) => {
    let screens = 0, flagged = 0, flags = 0;
    // The inputs as a hash, so a rerun can show it read the same screens and catalogs (outside git).
    const inputs = crypto.createHash("sha256");
    for (const j of [...jobs].sort((a, b) => a.file.localeCompare(b.file))) inputs.update(`${path.relative(path.dirname(path.dirname(j.file)), j.file)}\n${crypto.createHash("sha256").update(fs.readFileSync(j.file)).digest("hex")}\n${JSON.stringify(j.glyphs)}\n`);
    const results = await Promise.all(jobs.map(async ({ file, locale, glyphs }) => {
      let env = await server.request({ command: "glyphs", path: file, locale, glyphs });
      // One counted retry, as bench/glyphs.js: Vision fails now and then on a loaded host (docs/gotchas/vision.md).
      if (env.verdict === "error" && env.error?.code === "recognition-failed") { retries++; env = await server.request({ command: "glyphs", path: file, locale, glyphs }); }
      return { file, env };
    }));
    for (const { file, env } of results) {
      if (env.verdict === "error" || env.verdict === "unsupported") throw new Error(`${file}: ${env.error?.code} ${env.error?.message}`);
      screens++;
      if (env.findings.length) flagged++;
      for (const f of env.findings) {
        flags++;
        out.flag_ids.push(`${name}:${id(file, f.line)}`);
        details.push({ id: `${name}:${id(file, f.line)}`, image: file, line: f.line, expected: f.expected, chars: f.chars, key: f.key ?? null, element: f.element ?? null });
      }
    }
    out.sets.push({ name, source, inputs_sha256: inputs.digest("hex"), screens, flagged_screens: flagged, flags, flags_per_100: screens ? Number((100 * flags / screens).toFixed(2)) : null });
  };
  for (const set of config.catalog || []) {
    const jobs = [];
    for (const folder of sub(set.screens)) {
      const locale = (set.map || {})[folder] ?? folder;
      const cat = set.catalog.replace("{locale}", locale);
      if (!fs.existsSync(cat)) { process.stderr.write(`skip ${folder}: no ${cat}\n`); continue; }
      const expected = strings(cat).map((text) => ({ text }));
      for (const file of images(path.join(set.screens, folder))) jobs.push({ file, locale, glyphs: { expected } });
    }
    await run(set.name, "catalog", jobs);
  }
  for (const set of config.boxes || []) {
    const jobs = [];
    for (const app of sub(set.root)) {
      for (const locale of sub(path.join(set.root, app))) {
        for (const file of images(path.join(set.root, app, locale))) {
          const sc = file.replace(/\.[^.]+$/, ".boxes.json");
          if (!fs.existsSync(sc)) continue;
          jobs.push({ file, locale, glyphs: { boxes: JSON.parse(fs.readFileSync(sc, "utf8")) } });
        }
      }
    }
    await run(set.name, "boxes", jobs);
  }
  await server.close();
  const info = versionInfo();
  out.total = out.sets.reduce((a, s) => ({ screens: a.screens + s.screens, flags: a.flags + s.flags }), { screens: 0, flags: 0 });
  out.total.flags_per_100 = out.total.screens ? Number((100 * out.total.flags / out.total.screens).toFixed(2)) : null;
  out.vision_retries = retries;
  const sh = (c, a) => { try { return execFileSync(c, a, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } };
  out.tools = {
    catscan: info.catscan, commit: sh("git", ["rev-parse", "HEAD"]), macos: `${info.macos} (${info.macos_build})`, vision_revision: info.vision_revision,
    node: process.version, xcode: (sh("xcodebuild", ["-version"]) || "").split("\n")[0] || null,
    swift: (sh("swift", ["--version"]) || "").split("\n").find((l) => /Swift version/.test(l)) || null,
  };
  if (detail) fs.writeFileSync(detail, JSON.stringify(details, null, 1));
  process.stdout.write(JSON.stringify(out, null, 1) + "\n");
}

main().catch((e) => { console.error(e); process.exit(2); });
