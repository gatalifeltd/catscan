#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-074 "Measurement", rendered positives (D14): native line breaking on an iOS simulator and an Android emulator.
// Captures, per platform, the spec 14 sample apps (examples/maestro/app-ios, app-android) built as shipped (en) and
// with the TODO-039 pseudo-locale (`catscan pseudo --expand 40`, en-XA), plus the probe apps' wrapping screen
// (bench/devices/probe-ios WrapController, probe-android WrapActivity) drawn with bench/wrapping/probe-strings.json
// and its pseudo catalog in the layouts of probe-screens.json. Each shot gets its element dump (XCUITest
// debugDescription through bench/wrapping/dumper-ios, UiAutomator on Android) converted by `catscan boxes`, so
// `control` is set. The hand labels are bench/wrapping/rendered-labels.json; scoring is `catscan fit` on the set:
//
//   node bench/wrapping/rendered.mjs [--platform ios|android] [--out datasets/wrapping-rendered] [--work <dir>]
//   catscan fit datasets/wrapping-rendered/ios --boxes datasets/wrapping-rendered/ios --layout '{locale}/{screen}' --base-locale en
//
// Layout: <out>/<platform>/<en|en-XA>/<screen>.png with <screen>.boxes.json and the raw dump next to it, and
// <out>/<platform>/versions.json (tool versions). One device at a time, created and deleted here (AGENTS.md device
// limit); the emulator runs on the host GPU (scripts/e2e-maestro-emulator.mjs flags). The sample apps are copied
// into the work dir, so the pseudo catalog never touches the checkout.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { emulatorArgs } from "../../scripts/e2e-maestro-emulator.mjs";

const exec = promisify(execFile);
const run = (cmd, args, opt = {}) => exec(cmd, args, { maxBuffer: 256 << 20, ...opt });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CLI = path.join(ROOT, "bin/catscan.js");
const SDK = process.env.ANDROID_HOME || path.join(os.homedir(), "Library/Android/sdk");
const tool = (p) => path.join(SDK, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCALES = ["en", "en-XA"];
const SCREENS = JSON.parse(fs.readFileSync(path.join(HERE, "probe-screens.json"), "utf8")).screens;
const IOS_DEVICE = "iPhone 18 Pro";
const ANDROID_DEF = "pixel_8", ANDROID_IMAGE = "system-images;android-36.1;google_apis_playstore;arm64-v8a", PORT = 5570; // adb finds emulators only on 5554-5585
// The sample flow (examples/maestro/flows): onboarding -> next -> settings -> play -> game.
const SAMPLE = [{ wait: "next" }, { shot: "sample-onboarding" }, { tap: "next" }, { wait: "play" }, { shot: "sample-settings" }, { tap: "play" }, { wait: "game" }, { shot: "sample-game" }];

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const cli = (...a) => run(process.execPath, [CLI, ...a]);

/** A probe screen's rows with the strings of one catalog, base64 JSON for the launch argument / intent extra. */
function rows(screen, catalog) {
  const r = (i) => ({ kind: i.kind || "item", id: i.id, ...(i.key ? { text: catalog[i.key] } : {}), ...(i.items ? { items: i.items.map(r) } : {}) });
  return Buffer.from(JSON.stringify(SCREENS[screen].map((row) => row.map(r)))).toString("base64");
}

async function catalogs(work) {
  const en = path.join(HERE, "probe-strings.json"), xa = path.join(work, "probe-en-XA.json");
  await cli("pseudo", en, "--out", xa, "--expand", "40", "--force");
  return { en: JSON.parse(fs.readFileSync(en, "utf8")), "en-XA": JSON.parse(fs.readFileSync(xa, "utf8")) };
}

async function convert(dir, kind, ext) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(ext))) {
    const base = path.join(dir, f.slice(0, -ext.length));
    const { stdout } = await cli("boxes", kind, base + ext, "--image", base + ".png");
    fs.writeFileSync(base + ".boxes.json", stdout);
  }
}

async function ios(out, work, strings) {
  const simctl = async (...a) => (await run("xcrun", ["simctl", ...a])).stdout;
  const types = JSON.parse(await simctl("list", "-j", "devicetypes", "runtimes"));
  const type = types.devicetypes.find((t) => t.name === IOS_DEVICE);
  const rt = types.runtimes.filter((r) => r.isAvailable && r.platform === "iOS" && r.supportedDeviceTypes.some((s) => s.identifier === type.identifier))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  const udid = (await simctl("create", "catscan-wrapping-iphone", type.identifier, rt.identifier)).trim();
  try {
    // Boot first: a boot started during an xcodebuild can hang (docs/recipes/pseudo.md).
    await simctl("boot", udid);
    await run("xcrun", ["simctl", "bootstatus", udid], { timeout: 300000 });
    const sample = path.join(work, "app-ios");
    fs.cpSync(path.join(ROOT, "examples/maestro/app-ios"), sample, { recursive: true });
    const build = async (dd) => {
      await run("xcodebuild", ["-project", path.join(sample, "CatscanSample.xcodeproj"), "-scheme", "CatscanSample", "-configuration", "Debug",
        "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", dd, "build"]);
      return path.join(dd, "Build/Products/Debug-iphonesimulator/CatscanSample.app");
    };
    const apps = { en: await build(path.join(work, "dd-en")) };
    await cli("pseudo", path.join(sample, "Localizable.xcstrings"), "--in-place", "--force", "--expand", "40");
    apps["en-XA"] = await build(path.join(work, "dd-xa"));
    const probe = path.join(work, "Probe.app");
    fs.mkdirSync(probe, { recursive: true });
    fs.copyFileSync(path.join(ROOT, "bench/devices/probe-ios/Info.plist"), path.join(probe, "Info.plist"));
    await run("xcrun", ["-sdk", "iphonesimulator", "swiftc", "-O", "-target", "arm64-apple-ios17.0-simulator", path.join(ROOT, "bench/devices/probe-ios/Probe.swift"), "-o", path.join(probe, "Probe")]);
    await run("codesign", ["-s", "-", probe]);
    await simctl("install", udid, probe);
    for (const loc of LOCALES) {
      await simctl("install", udid, apps[loc]);
      const dir = path.join(out, loc);
      fs.mkdirSync(dir, { recursive: true });
      const jobs = [
        { bundle: "org.catscan.sample", args: ["-AppleLanguages", `(${loc})`, "-AppleLocale", loc === "en" ? "en_US" : "en_XA"], out: dir, steps: SAMPLE },
        ...Object.keys(SCREENS).map((s) => ({ bundle: "dev.catscan.probe", args: ["-wrap", rows(s, strings[loc])], out: dir, steps: [{ wait: `${s}_title` }, { shot: `probe-${s}` }] })),
      ];
      const jf = path.join(work, `jobs-${loc}.json`);
      fs.writeFileSync(jf, JSON.stringify(jobs));
      await run("xcodebuild", ["test", "-project", path.join(HERE, "dumper-ios/WrapDump.xcodeproj"), "-scheme", "WrapDump", "-destination", `id=${udid}`,
        "-derivedDataPath", path.join(work, "dd-dump")], { env: { ...process.env, TEST_RUNNER_WRAP_JOBS: jf } });
      await convert(dir, "xcuitest", ".xcui.txt");
    }
    return {
      xcode: (await run("xcodebuild", ["-version"])).stdout.trim().split("\n").join(" "),
      simulator: { device_type: type.identifier, runtime: `${rt.name} (${rt.buildversion})` },
    };
  } finally {
    await simctl("shutdown", udid).catch(() => {});
    await simctl("delete", udid).catch(() => {});
  }
}

async function probeApk(work) {
  const bt = fs.readdirSync(tool("build-tools")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const B = (x) => tool(`build-tools/${bt}/${x}`);
  const plat = fs.readdirSync(tool("platforms")).filter((p) => /^android-\d+$/.test(p)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const jar = tool(`platforms/${plat}/android.jar`);
  const dir = path.join(work, "probe-android"), cls = path.join(dir, "classes"), dex = path.join(dir, "dex"), res = path.join(dir, "res/values");
  for (const d of [cls, dex, res]) fs.mkdirSync(d, { recursive: true });
  // The element ids of every screen as resources, so UiAutomator dumps name them (resource-id).
  const ids = new Set();
  const walk = (i) => { ids.add(i.id); (i.items || []).forEach(walk); };
  Object.values(SCREENS).flat(2).forEach(walk);
  fs.writeFileSync(path.join(res, "ids.xml"), `<resources>\n${[...ids].map((i) => `  <item type="id" name="${i}"/>`).join("\n")}\n</resources>\n`);
  const src = path.join(ROOT, "bench/devices/probe-android/src/dev/catscan/probe");
  await run("javac", ["-source", "17", "-target", "17", "-cp", jar, "-d", cls, path.join(src, "ProbeActivity.java"), path.join(src, "WrapActivity.java")]);
  const classes = [];
  const files = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) files(f); else classes.push(f); } };
  files(cls);
  await run(B("d8"), ["--lib", jar, "--min-api", "31", "--output", dex, ...classes]);
  await run(B("aapt2"), ["compile", "--dir", path.join(dir, "res"), "-o", path.join(dir, "res.zip")]);
  const base = path.join(dir, "base.apk");
  await run(B("aapt2"), ["link", "-o", base, "-I", jar, "--manifest", path.join(ROOT, "bench/devices/probe-android/AndroidManifest.xml"), "-R", path.join(dir, "res.zip"), "--auto-add-overlay"]);
  await run("zip", ["-q", base, "classes.dex"], { cwd: dex });
  await run(B("zipalign"), ["-f", "4", base, path.join(dir, "aligned.apk")]);
  // The SDK's public debug keystore (its password is the documented default).
  await run(B("apksigner"), ["sign", "--ks", path.join(os.homedir(), ".android/debug.keystore"), "--ks-pass", "pass:android", "--out", path.join(dir, "probe.apk"), path.join(dir, "aligned.apk")]);
  return { apk: path.join(dir, "probe.apk"), build_tools: bt, platform: plat };
}

async function sampleApks(work) {
  const app = path.join(work, "app-android");
  fs.cpSync(path.join(ROOT, "examples/maestro/app-android"), app, { recursive: true, filter: (s) => !/[/\\](build|\.gradle)$/.test(s) });
  const gradle = async (name) => {
    await run(path.join(app, "gradlew"), ["-q", "assembleDebug"], { cwd: app });
    const dir = path.join(app, "build/outputs/apk/debug");
    const f = path.join(work, name);
    fs.copyFileSync(path.join(dir, fs.readdirSync(dir).find((x) => x.endsWith(".apk"))), f);
    return f;
  };
  const apks = { en: await gradle("sample-en.apk") };
  await cli("pseudo", path.join(app, "src/main/res/values/strings.xml"), "--expand", "40", "--force");
  // docs/recipes/pseudo.md: a build with localeFilters must name en-rXA, or Gradle strips the pseudo strings.
  const g = path.join(app, "build.gradle.kts");
  fs.writeFileSync(g, fs.readFileSync(g, "utf8").replace(/localeFilters \+= setOf\(([^)]*)\)/, 'localeFilters += setOf($1, "en-rXA")'));
  apks["en-XA"] = await gradle("sample-en-XA.apk");
  const agp = /com\.android\.application"\) version "([^"]+)"/.exec(fs.readFileSync(g, "utf8"))?.[1];
  const wrapper = /distributionUrl=.*gradle-([\d.]+)-/.exec(fs.readFileSync(path.join(app, "gradle/wrapper/gradle-wrapper.properties"), "utf8"))?.[1];
  return { apks, agp, gradle: wrapper };
}

async function android(out, work, strings) {
  const avd = "catscan-wrapping-pixel", serial = `emulator-${PORT}`;
  const adb = (...a) => run(tool("platform-tools/adb"), ["-s", serial, ...a], { encoding: a[0] === "exec-out" ? "buffer" : "utf8" });
  await run(tool("cmdline-tools/latest/bin/avdmanager"), ["create", "avd", "-n", avd, "-d", ANDROID_DEF, "-k", ANDROID_IMAGE, "--force"], { input: "no\n" });
  const log = fs.openSync(path.join(work, "emulator.log"), "w");
  const emu = spawn(tool("emulator/emulator"), emulatorArgs(avd, PORT), { stdio: ["ignore", log, log] });
  try {
    // Build while the emulator boots.
    const [probe, sample] = await Promise.all([probeApk(work), sampleApks(work)]);
    await run(tool("platform-tools/adb"), ["-s", serial, "wait-for-device"], { timeout: 300000 });
    for (let i = 0; i < 180; i++) { if ((await adb("shell", "getprop", "sys.boot_completed").catch(() => ({ stdout: "" }))).stdout.trim() === "1") break; await sleep(2000); }
    await adb("shell", "cmd", "overlay", "enable-exclusive", "--category", "com.android.internal.systemui.navbar.gestural").catch(() => {});
    await adb("install", "-r", probe.apk);
    const dump = async () => { await adb("shell", "uiautomator", "dump", "/sdcard/wrap.uia.xml"); return (await adb("shell", "cat", "/sdcard/wrap.uia.xml")).stdout; };
    const shot = async (dir, name) => {
      await sleep(1500);
      fs.writeFileSync(path.join(dir, `${name}.png`), (await adb("exec-out", "screencap", "-p")).stdout);
      fs.writeFileSync(path.join(dir, `${name}.uia.xml`), await dump());
    };
    const find = async (id) => {
      for (let i = 0; i < 30; i++) {
        const m = new RegExp(`resource-id="${id}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(await dump());
        if (m) return [(+m[1] + +m[3]) >> 1, (+m[2] + +m[4]) >> 1];
        await sleep(1000);
      }
      throw new Error(`no ${id} on screen`);
    };
    for (const loc of LOCALES) {
      const dir = path.join(out, loc);
      fs.mkdirSync(dir, { recursive: true });
      await adb("install", "-r", sample.apks[loc]);
      await adb("shell", "cmd", "locale", "set-app-locales", "org.catscan.sample", "--locales", loc);
      await adb("shell", "am", "start", "-W", "-S", "-n", "org.catscan.sample/.MainActivity");
      for (const s of SAMPLE) {
        if (s.wait) await find(s.wait);
        if (s.tap) { const [x, y] = await find(s.tap); await adb("shell", "input", "tap", String(x), String(y)); }
        if (s.shot) await shot(dir, s.shot);
      }
      for (const s of Object.keys(SCREENS)) {
        await adb("shell", "am", "start", "-W", "-S", "-n", "dev.catscan.probe/.WrapActivity", "--es", "wrap", rows(s, strings[loc]));
        await find(`dev.catscan.probe:id/${s}_title`);
        await shot(dir, `probe-${s}`);
      }
      await convert(dir, "uiautomator", ".uia.xml");
    }
    return {
      emulator: (await run(tool("emulator/emulator"), ["-version"])).stdout.split("\n")[0].trim(),
      system_image: ANDROID_IMAGE, device: ANDROID_DEF, api_level: (await adb("shell", "getprop", "ro.build.version.sdk")).stdout.trim(),
      build_tools: probe.build_tools, probe_platform: probe.platform, agp: sample.agp, gradle: sample.gradle,
      javac: (await run("javac", ["-version"])).stdout.trim() || (await run("javac", ["-version"])).stderr.trim(),
    };
  } finally {
    await adb("emu", "kill").catch(() => {});
    emu.kill();
    await sleep(3000);
    await run(tool("cmdline-tools/latest/bin/avdmanager"), ["delete", "avd", "-n", avd]).catch(() => {});
  }
}

async function main() {
  const only = arg("--platform");
  const out = path.resolve(ROOT, arg("--out", "datasets/wrapping-rendered"));
  const work = arg("--work") ? path.resolve(arg("--work")) : fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wrapping-"));
  fs.mkdirSync(work, { recursive: true });
  const strings = await catalogs(work);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const report = {};
  for (const [p, fn] of [["ios", ios], ["android", android]]) {
    if (only && only !== p) continue;
    const dir = path.join(out, p);
    fs.rmSync(dir, { recursive: true, force: true });
    const versions = { script: "bench/wrapping/rendered.mjs", catscan: pkg.version, node: process.version, date: new Date().toISOString().slice(0, 10), ...(await fn(dir, work, strings)) };
    fs.writeFileSync(path.join(dir, "versions.json"), JSON.stringify(versions, null, 2) + "\n");
    report[p] = { ...versions, screens: Object.fromEntries(LOCALES.map((l) => [l, fs.readdirSync(path.join(dir, l)).filter((f) => f.endsWith(".png")).length])) };
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => { console.error(e.stderr?.toString?.().slice(-4000) || "", e.message); process.exit(1); });
