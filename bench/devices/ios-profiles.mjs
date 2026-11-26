#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Measures the shipped iOS and iPadOS device profiles (TODO-073 D2, D24) with public tools on the maintainer's Mac:
// for every iPhone and iPad simulator device type of the installed Xcode it boots one simulator (on the newest
// runtime that supports it), runs the white probe app, and compares `xcrun simctl io screenshot --mask=black` with
// `--mask=ignored`. Dark pixels of the masked frame are hidden: regions reaching two screen edges are `corner`, the
// rest the `cutout`. Both landscapes are captured to check the rotation the engine applies. The home indicator is
// left out of every simulator capture, so iOS profiles carry no `home-indicator` zone (D24).
//
//   node bench/devices/ios-profiles.mjs [--only <regex>] [--jobs <n>] [--out <file>] [--keep-shots <dir>]
//
// Writes the `ios` and `ipados` profiles of the table (default packages/core-js/src/device-profiles.json), keeping
// the other platforms. Simulators are created per device type and deleted after use (AGENTS.md: at most 6 devices).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { decode } from "./png.mjs";
import { hiddenMask, zonesOf, rotateRuns, agreement, slug } from "./profile-lib.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const BUNDLE = "dev.catscan.probe";
const SCRIPT = "bench/devices/ios-profiles.mjs";
const ORIENTATIONS = ["landscape-left", "landscape-right"];

/**
 * One profile from the probe's report and the captured frames (pure; the dry-run test feeds drawn PNGs).
 * `shots.portrait = { black, ignored }`, `shots[landscape] = { black }` (decoded RGBA).
 */
export function profileFromShots({ name, family, probe, shots, tool, date }) {
  const { black, ignored } = shots.portrait;
  if (black.width > black.height) throw new Error(`${name}: the portrait frame is landscape`);
  const zones = zonesOf(hiddenMask(black, ignored), black.width, black.height);
  const check = {};
  for (const o of ORIENTATIONS) {
    if (!shots[o]) continue;
    // iPad simulators return landscape captures in the portrait framebuffer; with no cutout (four alike corners) the
    // rotation cannot change a finding, so the check is skipped there and must pass everywhere else.
    if (shots[o].black.width < shots[o].black.height) {
      if (zones.some((z) => z.kind === "cutout")) throw new Error(`${name}: the ${o} capture is portrait-shaped`);
      check[o] = null;
      continue;
    }
    const m = hiddenMask(shots[o].black, null), all = new Set();
    for (const z of zones) for (const p of rotateRuns(z.runs, black.width, black.height, o)) all.add(p);
    const a = agreement(all, m);
    check[o] = Math.min(a.recall, a.precision);
    if (check[o] < 0.99) throw new Error(`${name}: ${o} frame matches the rotated portrait zones only ${check[o].toFixed(3)}`);
  }
  return {
    device_profile: 1,
    id: slug(name),
    name,
    platform: family === "ipad" ? "ipados" : "ios",
    screen: { width: black.width, height: black.height, scale: probe.scale },
    measured: { tool, date, script: SCRIPT },
    zones,
  };
}

async function simctl(...args) { return (await run("xcrun", ["simctl", ...args], { maxBuffer: 64 << 20 })).stdout; }

async function buildProbe(dir) {
  const app = path.join(dir, "Probe.app");
  fs.mkdirSync(app, { recursive: true });
  fs.copyFileSync(path.join(HERE, "probe-ios/Info.plist"), path.join(app, "Info.plist"));
  await run("xcrun", ["-sdk", "iphonesimulator", "swiftc", "-O", "-target", "arm64-apple-ios17.0-simulator",
    path.join(HERE, "probe-ios/Probe.swift"), "-o", path.join(app, "Probe")]);
  await run("codesign", ["-s", "-", app]);
  return app;
}

/** Every iPhone and iPad device type with the newest available runtime that supports it. */
async function plan(only) {
  const j = JSON.parse(await simctl("list", "-j", "devicetypes", "runtimes"));
  const runtimes = j.runtimes.filter((r) => r.isAvailable && r.platform === "iOS").sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const out = [], unsupported = [];
  for (const t of j.devicetypes) {
    if (!/^(iPhone|iPad)/.test(t.name) || (only && !only.test(t.name))) continue;
    const rt = runtimes.find((r) => r.supportedDeviceTypes.some((s) => s.identifier === t.identifier));
    if (rt) out.push({ type: t, runtime: rt }); else unsupported.push(t.name);
  }
  return { out, unsupported };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitProbe(udid, orientation, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const dir = (await simctl("get_app_container", udid, BUNDLE, "data")).trim();
      const p = JSON.parse(fs.readFileSync(path.join(dir, "Documents/probe.json"), "utf8"));
      const land = p.width > p.height;
      if (land === (orientation !== "portrait")) return p;
    } catch { /* not written yet */ }
    await sleep(500);
  }
  throw new Error(`probe did not report ${orientation}`);
}

async function shot(udid, mask, file) {
  await simctl("io", udid, "screenshot", `--mask=${mask}`, file);
  return decode(fs.readFileSync(file));
}

async function measure({ type, runtime }, app, tmp, keep, tool, date) {
  const udid = (await simctl("create", `catscan-profile-${slug(type.name)}`, type.identifier, runtime.identifier)).trim();
  try {
    await simctl("boot", udid);
    await simctl("bootstatus", udid);
    await simctl("install", udid, app);
    const shots = {};
    let probe = null;
    for (const o of ["portrait", ...ORIENTATIONS]) {
      await simctl("terminate", udid, BUNDLE).catch(() => {});
      const dir = (await simctl("get_app_container", udid, BUNDLE, "data")).trim();
      fs.rmSync(path.join(dir, "Documents/probe.json"), { force: true });
      await simctl("launch", udid, BUNDLE, "-orientation", o);
      const p = await waitProbe(udid, o);
      if (o === "portrait") probe = p;
      await sleep(1500); // rotation and launch animations
      const base = path.join(keep || tmp, `${slug(type.name)}-${o}`);
      shots[o] = { black: await shot(udid, "black", `${base}-black.png`) };
      if (o === "portrait") shots[o].ignored = await shot(udid, "ignored", `${base}-ignored.png`);
    }
    const family = type.productFamily === "iPad" ? "ipad" : "iphone";
    return profileFromShots({ name: type.name, family, probe, shots, tool: `${tool}, ${runtime.name} simulator`, date });
  } finally {
    await simctl("shutdown", udid).catch(() => {});
    await simctl("delete", udid).catch(() => {});
  }
}

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const only = arg("--only") ? new RegExp(arg("--only")) : null;
  const jobs = Number(arg("--jobs", "1"));
  if (!(jobs >= 1 && jobs <= 3)) throw new Error("--jobs is 1 to 3 (AGENTS.md: at most 6 devices on the machine)");
  const out = path.resolve(ROOT, arg("--out", "packages/core-js/src/device-profiles.json"));
  const keep = arg("--keep-shots");
  if (keep) fs.mkdirSync(keep, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-ios-profiles-"));
  const xc = (await run("xcodebuild", ["-version"])).stdout.trim().split("\n");
  const tool = `${xc[0]} (${xc[1].replace("Build version ", "")})`;
  const date = new Date().toISOString().slice(0, 10);
  const app = await buildProbe(tmp);
  const { out: todo, unsupported } = await plan(only);
  const profiles = [], failed = [];
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < todo.length) {
      const t = todo[next++];
      try { const p = await measure(t, app, tmp, keep, tool, date); profiles.push(p); console.error(`ok ${p.id} ${p.screen.width}x${p.screen.height} ${p.zones.map((z) => z.kind).join(",") || "no zones"}`); }
      catch (e) { failed.push(`${t.type.name}: ${e.message}`); console.error(`FAIL ${t.type.name}: ${e.message}`); }
    }
  }));
  // Device types that share a name keep the first id; later ones get a number.
  const seen = new Set();
  for (const p of profiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    for (let n = 2; seen.has(p.id); n++) p.id = `${slug(p.name)}-${n}`;
    seen.add(p.id);
  }
  const table = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { device_profiles: 1, version: date, profiles: [] };
  const keepOther = table.profiles.filter((p) => !["ios", "ipados"].includes(p.platform) || (only && !profiles.some((q) => q.id === p.id) && !only.test(p.name)));
  table.version = date;
  table.profiles = [...keepOther, ...profiles].sort((a, b) => a.platform.localeCompare(b.platform) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  fs.writeFileSync(out, `{\n  "device_profiles": 1,\n  "version": ${JSON.stringify(table.version)},\n  "profiles": [\n${table.profiles.map((p) => `    ${JSON.stringify(p)}`).join(",\n")}\n  ]\n}\n`);
  console.error(`${profiles.length} profiles written to ${path.relative(ROOT, out)}; no supported runtime: ${unsupported.join(", ") || "none"}`);
  if (failed.length) { console.error(`failed:\n  ${failed.join("\n  ")}`); process.exitCode = 1; }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
