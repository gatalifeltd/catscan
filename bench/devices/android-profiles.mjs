#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Measures the shipped Android profiles (TODO-073 D2, D28) with public tools on the maintainer's Mac: for each Pixel
// phone definition of the Android SDK it creates an emulator (host GPU), turns gesture navigation on, and runs the
// white probe app (bench/devices/probe-android, built here with javac, d8, aapt2 and apksigner). The probe logs the
// cutout path, the rounded corners and the gesture insets that Android gives every app, as hidden pixel runs; the
// gesture handle is the dark bar in the bottom band of a screencap of the white probe, in portrait and landscape.
//
//   node bench/devices/android-profiles.mjs [--only <regex>] [--out <file>] [--image <system image>]
//
// One emulator at a time, created and deleted here (AGENTS.md: at most 6 devices; -gpu host).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { decode } from "./png.mjs";
import { emulatorArgs } from "../../scripts/e2e-maestro-emulator.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const SDK = process.env.ANDROID_HOME || path.join(os.homedir(), "Library/Android/sdk");
const SCRIPT = "bench/devices/android-profiles.mjs";
const DEFS = ["pixel_4a", "pixel_5", "pixel_6", "pixel_6_pro", "pixel_6a", "pixel_7", "pixel_7_pro", "pixel_7a", "pixel_8", "pixel_8_pro", "pixel_8a", "pixel_9", "pixel_9_pro", "pixel_9_pro_xl", "pixel_9a"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = (p) => path.join(SDK, p);

/** The dark bar in the bottom `band` px of a white frame: [x, y, w, h], or null. */
export function handleBox(img, band) {
  const { width: W, height: H, data } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = Math.max(0, H - band); y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, l = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
    if (l < 160) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  // A handle is a short wide bar centered on the screen; anything else (no gesture navigation, a stray glyph) is none.
  if (x1 < 0 || x1 - x0 < W * 0.05 || y1 - y0 > band || Math.abs((x0 + x1) / 2 - W / 2) > W * 0.05) return null;
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/** The share of non-white pixels above the bottom `band` px: the white probe is 0; a system dialog is not. */
export function inkShare(img, band) {
  const { width: W, height: H, data } = img;
  let n = 0;
  for (let y = 0; y < H - band; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; if (data[o] + data[o + 1] + data[o + 2] < 3 * 235) n++; }
  return n / (W * Math.max(1, H - band));
}

/** The probe's reports from logcat: each is split into "<id> <part> <parts> <chunk>" lines (logcat cuts at ~4 KB). */
export function joinReports(log) {
  const parts = new Map();
  for (const l of log.split("\n")) {
    const m = /^(\d+) (\d+) (\d+) (.*)$/.exec(l.trimEnd());
    if (!m) continue;
    const r = parts.get(m[1]) || parts.set(m[1], { n: +m[3], chunks: [] }).get(m[1]);
    r.chunks[+m[2]] = m[4];
  }
  return [...parts.values()].filter((r) => r.chunks.filter((c) => c !== undefined).length === r.n).map((r) => JSON.parse(r.chunks.join("")));
}

/** One profile from the portrait probe report and the handle boxes (pure; the dry-run test feeds it). */
export function profileFrom({ def, name, portrait, homePortrait, homeLandscape, tool: t, date }) {
  if (portrait.width > portrait.height) throw new Error(`${def}: the portrait report is landscape`);
  // D40: a portrait handle needs its landscape box (a landscape image could neither check nor skip it).
  if (homePortrait && !homeLandscape) throw new Error(`${def}: the gesture handle was found in portrait but not in landscape`);
  const zones = [];
  if (portrait.cutout.length) zones.push({ kind: "cutout", runs: portrait.cutout });
  if (portrait.corner.length) zones.push({ kind: "corner", runs: portrait.corner });
  if (homePortrait) zones.push({ kind: "home-indicator", box: homePortrait });
  return {
    device_profile: 1, id: def.replace(/_/g, "-"), name, platform: "android",
    screen: { width: portrait.width, height: portrait.height, scale: portrait.density },
    measured: { tool: t, date, script: SCRIPT },
    zones,
    ...(homePortrait ? { landscape: { "home-indicator": { box: homeLandscape } } } : {}),
  };
}

async function buildApk(dir) {
  const bt = fs.readdirSync(tool("build-tools")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const B = (x) => tool(`build-tools/${bt}/${x}`);
  const plat = fs.readdirSync(tool("platforms")).filter((p) => /^android-\d+$/.test(p)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const jar = tool(`platforms/${plat}/android.jar`);
  const cls = path.join(dir, "classes"), dex = path.join(dir, "dex");
  fs.mkdirSync(cls, { recursive: true }); fs.mkdirSync(dex, { recursive: true });
  await run("javac", ["-source", "17", "-target", "17", "-cp", jar, "-d", cls, path.join(HERE, "probe-android/src/dev/catscan/probe/ProbeActivity.java")]);
  const classes = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else classes.push(f); } };
  walk(cls);
  await run(B("d8"), ["--lib", jar, "--min-api", "31", "--output", dex, ...classes]);
  const base = path.join(dir, "base.apk");
  await run(B("aapt2"), ["link", "-o", base, "-I", jar, "--manifest", path.join(HERE, "probe-android/AndroidManifest.xml")]);
  await run("zip", ["-q", base, "classes.dex"], { cwd: dex });
  await run(B("zipalign"), ["-f", "4", base, path.join(dir, "aligned.apk")]);
  // The SDK's public debug keystore (its password is the documented default).
  await run(B("apksigner"), ["sign", "--ks", path.join(os.homedir(), ".android/debug.keystore"), "--ks-pass", "pass:android", "--out", path.join(dir, "probe.apk"), path.join(dir, "aligned.apk")]);
  return path.join(dir, "probe.apk");
}

async function measure(def, apk, image, dir, emuVersion, date) {
  const avd = `catscan-profile-${def}`, port = 5584, serial = `emulator-${port}`;
  const adb = (...a) => run(tool("platform-tools/adb"), ["-s", serial, ...a], { maxBuffer: 64 << 20, encoding: a[0] === "exec-out" ? "buffer" : "utf8" });
  await run(tool("cmdline-tools/latest/bin/avdmanager"), ["create", "avd", "-n", avd, "-d", def, "-k", image, "--force"], { input: "no\n" });
  // The shared emulator flags (host GPU, AGENTS.md), so every script boots alike.
  const emu = spawn(tool("emulator/emulator"), emulatorArgs(avd, port), { stdio: "ignore" });
  try {
    await run(tool("platform-tools/adb"), ["-s", serial, "wait-for-device"], { timeout: 300000 });
    // adb answers "device offline" for a while after wait-for-device; keep polling through it.
    let booted = false;
    for (let i = 0; i < 180 && !booted; i++) { booted = (await adb("shell", "getprop", "sys.boot_completed").catch(() => ({ stdout: "" }))).stdout.trim() === "1"; if (!booted) await sleep(2000); }
    if (!booted) throw new Error("the emulator did not boot in 6 minutes");
    await adb("shell", "cmd", "overlay", "enable-exclusive", "--category", "com.android.internal.systemui.navbar.gestural").catch(() => {});
    await adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
    await adb("install", "-r", apk);
    await sleep(3000);
    const shots = {};
    for (const o of ["portrait", "landscape-left", "landscape-right"]) {
      await adb("logcat", "-c");
      await adb("shell", "am", "start", "-W", "-S", "-n", "dev.catscan.probe/.ProbeActivity", "--es", "orientation", o);
      let rep = null;
      for (let i = 0; i < 40 && !rep; i++) {
        await sleep(500);
        const reports = joinReports((await adb("logcat", "-d", "-s", "catscan-probe:I", "-v", "raw")).stdout);
        const last = reports.length ? reports[reports.length - 1] : null;
        if (last && (last.width > last.height) === (o !== "portrait")) rep = last;
      }
      if (!rep) throw new Error(`${def}: the probe did not report ${o}`);
      await sleep(2000); // the handle fades in after a rotation
      const png = (await adb("exec-out", "screencap", "-p")).stdout;
      fs.writeFileSync(path.join(dir, `${def}-${o}.png`), png);
      const img = decode(png);
      const band = Math.max(rep.gestures[3], rep.navigation[3], 1);
      // A system dialog ("System UI isn't responding") over the probe would be read as the handle (2026-11-22).
      if (inkShare(img, band) > 0.001) throw new Error(`the ${o} screenshot is not the white probe (a system dialog?)`);
      shots[o] = { rep, home: handleBox(img, band) };
    }
    const name = `Pixel ${def.split("_").slice(1).map((w) => ({ pro: "Pro", xl: "XL" })[w] || w).join(" ")}`;
    return profileFrom({ def, name, portrait: shots.portrait.rep, homePortrait: shots.portrait.home, homeLandscape: shots["landscape-left"].home, tool: `${emuVersion}, ${image}`, date });
  } finally {
    await adb("emu", "kill").catch(() => {});
    emu.kill();
    await sleep(3000);
    await run(tool("cmdline-tools/latest/bin/avdmanager"), ["delete", "avd", "-n", avd]).catch(() => {});
  }
}

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const only = arg("--only") ? new RegExp(arg("--only")) : null;
  const image = arg("--image", "system-images;android-36.1;google_apis_playstore;arm64-v8a");
  const out = path.resolve(ROOT, arg("--out", "packages/core-js/src/device-profiles.json"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-android-profiles-"));
  const apk = await buildApk(dir);
  const emuVersion = (await run(tool("emulator/emulator"), ["-version"])).stdout.split("\n")[0].trim();
  const date = new Date().toISOString().slice(0, 10);
  const profiles = [], failed = [];
  for (const def of DEFS.filter((d) => !only || only.test(d))) {
    // One retry: a cold emulator sometimes shows a system dialog or captures mid-rotation; the checks above refuse it.
    try {
      const p = await measure(def, apk, image, dir, emuVersion, date).catch((e) => { console.error(`retry ${def}: ${e.message}`); return measure(def, apk, image, dir, emuVersion, date); });
      // D2: only definitions with a cutout or rounded corners ship (pixel_4a's emulator definition reports neither,
      // so a profile of it would claim the phone hides nothing at the top).
      if (!p.zones.some((z) => z.kind === "cutout" || z.kind === "corner")) { console.error(`skip ${p.id}: no cutout or rounded corner in its emulator definition`); continue; }
      profiles.push(p); console.error(`ok ${p.id} ${p.screen.width}x${p.screen.height} ${p.zones.map((z) => z.kind).join(",") || "no zones"}`); }
    catch (e) { failed.push(`${def}: ${e.message}`); console.error(`FAIL ${def}: ${e.message}`); }
  }
  const table = JSON.parse(fs.readFileSync(out, "utf8"));
  const keep = table.profiles.filter((p) => p.platform !== "android" || (only && !profiles.some((q) => q.id === p.id) && !only.test(p.id.replace(/-/g, "_"))));
  table.version = date;
  table.profiles = [...keep, ...profiles].sort((a, b) => a.platform.localeCompare(b.platform) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  fs.writeFileSync(out, `{\n  "device_profiles": 1,\n  "version": ${JSON.stringify(table.version)},\n  "profiles": [\n${table.profiles.map((p) => `    ${JSON.stringify(p)}`).join(",\n")}\n  ]\n}\n`);
  console.error(`${profiles.length} Android profiles written to ${path.relative(ROOT, out)}`);
  if (failed.length) { console.error(`failed:\n  ${failed.join("\n  ")}`); process.exitCode = 1; }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
