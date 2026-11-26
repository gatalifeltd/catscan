#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 14 end-to-end test (scripts/e2e-maestro.sh is the entry). Builds both sample apps (clean and FAULTS=1),
// reuses the e2e simulator and emulator when they run, else boots them and shuts down only what it booted, runs
// examples/maestro/run-all.sh per platform for de and fr, asserts the spec 14 test plan and writes
// results/maestro-e2e/<host-key>.json with the tool versions and the wall time.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { avdDir, avdHome, emulatorArgs, gpuModeOf, withGpuHost } from "./e2e-maestro-emulator.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EX = path.join(ROOT, "examples/maestro");
const SDK = process.env.ANDROID_HOME || path.join(os.homedir(), "Library/Android/sdk");
const ADB = path.join(SDK, "platform-tools/adb");
// D8: the emulator image is pinned; the e2e devices have their own names so a run never drives another session's device.
const AVD = "catscan-maestro-e2e";
const AVD_IMAGE = "system-images;android-36.1;google_apis_playstore;arm64-v8a";
const AVD_DEVICE = "pixel_9";
const AVD_HOME = avdHome(process.env, os.homedir());
const AVD_DIR = () => {
  const descriptor = path.join(AVD_HOME, `${AVD}.ini`);
  return avdDir(AVD_HOME, AVD, fs.existsSync(descriptor) ? fs.readFileSync(descriptor, "utf8") : null);
};
const SIM = "catscan-maestro-e2e";
const SIM_TYPE = "iPhone 17";
const LOCALES = ["de", "fr"];
const LAYOUT = "{screen}.{locale}";
const SCREENS = ["onboarding", "settings", "game"];
// One localized string per locale and screen: proves the locale switch on both platforms (D7).
const SAMPLE = { de: "Willkommen", fr: "Bienvenue" };

const argv = process.argv.slice(2);
const only = argv.includes("--platform") ? argv[argv.indexOf("--platform") + 1] : null;
if (argv.includes("--platform") && !["ios", "android"].includes(only)) {
  console.error("usage: npm run e2e:maestro [-- --platform ios|android]");
  process.exit(2);
}
const PLATFORMS = only ? [only] : ["ios", "android"];
// One run at a time: the devices are shared by name, and a second run would drive (and shut down) the first's.
const LOCK = path.join(os.tmpdir(), "catscan-e2e-maestro.lock");
try { fs.mkdirSync(LOCK); } catch {
  console.error(`e2e-maestro: another run holds ${LOCK}; remove it if no run is active`);
  process.exit(2);
}
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-e2e-maestro-"));
const BIN = path.join(WORK, "bin");
const started = Date.now();
const booted = [];
const failures = [];
// The owner's Mac is shared: under heavy load Vision can exceed its default 60 s deadline on one image
// (vision-timeout, exit 4), which says nothing about the recipe. The run records the deadline and the load.
process.env.CATSCAN_VISION_TIMEOUT ||= "180";
const record = { spec: 14, script: "scripts/e2e-maestro.sh", started_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), platforms: {} };

const log = (m) => console.log(`[e2e-maestro ${((Date.now() - started) / 1000).toFixed(0)}s] ${m}`);
const out = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const tryOut = (cmd, args, opts) => { try { return out(cmd, args, opts); } catch { return null; } };
const check = (ok, what) => { (ok ? log : (m) => { failures.push(m); console.error(`[e2e-maestro] FAIL ${m}`); })(`${ok ? "ok" : ""} ${what}`.trim()); };
const env = (extra = {}) => ({ ...process.env, PATH: `${BIN}:${process.env.PATH}`, ...extra });
const sh = (args, extra) => spawnSync("/bin/sh", args, { cwd: EX, env: env(extra), stdio: ["ignore", "inherit", "inherit"] }).status;
const catscan = (args) => spawnSync(process.execPath, [path.join(ROOT, "bin/catscan.js"), ...args], { cwd: EX, encoding: "utf8" });
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// catscan on PATH is this checkout's.
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, "catscan"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "bin/catscan.js")}" "$@"\n`, { mode: 0o755 });

function versions() {
  const gw = fs.readFileSync(path.join(EX, "app-android/gradle/wrapper/gradle-wrapper.properties"), "utf8");
  const gk = fs.readFileSync(path.join(EX, "app-android/build.gradle.kts"), "utf8");
  const pick = (re) => (re.exec(gk) || [])[1] || null;
  return {
    catscan: json(path.join(ROOT, "packages/cli/package.json")).version,
    maestro: tryOut("maestro", ["--version"])?.split("\n").pop() || null,
    xcode: tryOut("xcodebuild", ["-version"])?.replace(/\n/g, " ") || null,
    macos: `${out("sw_vers", ["-productVersion"])} (${out("sw_vers", ["-buildVersion"])})`,
    gradle: (/gradle-([0-9.]+)-bin\.zip/.exec(gw) || [])[1] || null,
    agp: pick(/com\.android\.application"\) version "([^"]+)"/),
    kotlin: pick(/kotlin\.plugin\.compose"\) version "([^"]+)"/),
    compose_bom: pick(/compose-bom:([^"]+)"/),
    compile_sdk: pick(/compileSdk = (\d+)/),
    java: spawnSync("java", ["-version"], { encoding: "utf8" }).stderr?.split("\n")[0] || null,
    tesseract: tryOut("tesseract", ["--version"])?.split("\n")[0] || null,
  };
}

function hostKey() {
  const vm = tryOut("sysctl", ["-n", "kern.hv_vmm_present"]) === "1";
  const chip = out("sysctl", ["-n", "machdep.cpu.brand_string"]);
  return `${vm ? "vm" : "physical"}-${chip.replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "").toLowerCase()}-macos-${out("sw_vers", ["-buildVersion"])}`;
}

// --- builds ---------------------------------------------------------------------------------------------------

function buildIos(faults) {
  const dd = path.join(WORK, `ios-dd${faults ? "-faults" : ""}`);
  execFileSync("xcodebuild", ["-project", "app-ios/CatscanSample.xcodeproj", "-scheme", "CatscanSample", "-configuration", "Debug",
    "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", dd, "build", "-quiet",
    ...(faults ? ["FAULTS=1"] : [])], { cwd: EX, stdio: ["ignore", "ignore", "inherit"] });
  return path.join(dd, "Build/Products/Debug-iphonesimulator/CatscanSample.app");
}

function buildAndroid(faults) {
  execFileSync("./gradlew", ["--quiet", "assembleDebug", ...(faults ? ["-PFAULTS=1"] : [])],
    { cwd: path.join(EX, "app-android"), stdio: ["ignore", "ignore", "inherit"] });
  const apk = path.join(WORK, `sample${faults ? "-faults" : ""}.apk`);
  fs.copyFileSync(path.join(EX, "app-android/build/outputs/apk/debug/catscan-sample-debug.apk"), apk);
  return apk;
}

// --- devices --------------------------------------------------------------------------------------------------

function iosDevice() {
  const list = JSON.parse(out("xcrun", ["simctl", "list", "-j", "devices", "runtimes"]));
  let dev = Object.entries(list.devices).flatMap(([rt, ds]) => ds.map((d) => ({ ...d, rt }))).find((d) => d.name === SIM && d.isAvailable);
  if (!dev) {
    const rt = list.runtimes.filter((r) => r.platform === "iOS" && r.isAvailable && /iOS-[0-9-]+$/.test(r.identifier)
      && (r.supportedDeviceTypes || []).some((d) => d.name === SIM_TYPE)).sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).pop();
    if (!rt) throw new Error(`no available iOS runtime supports ${SIM_TYPE}; install one in Xcode > Settings > Components`);
    const udid = out("xcrun", ["simctl", "create", SIM, SIM_TYPE, rt.identifier]);
    log(`created simulator ${SIM} (${SIM_TYPE}, iOS ${rt.version})`);
    dev = { udid, state: "Shutdown", rt: rt.identifier };
  }
  if (dev.state !== "Booted") {
    out("xcrun", ["simctl", "boot", dev.udid]);
    booted.push(["ios", dev.udid]);
    log(`booted simulator ${dev.udid}`);
  } else log(`reusing booted simulator ${dev.udid}`);
  out("xcrun", ["simctl", "bootstatus", dev.udid, "-b"]);
  const rt = JSON.parse(out("xcrun", ["simctl", "list", "-j", "runtimes"])).runtimes.find((r) => r.identifier === dev.rt);
  return { udid: dev.udid, runtime: rt ? `iOS ${rt.version} (${rt.buildversion})` : dev.rt, device_type: SIM_TYPE };
}

// Every emulator adb lists, in any state: a booting one ("offline") still holds its port.
function emulatorSerials(ready = false) {
  return out(ADB, ["devices"]).split("\n").slice(1).map((l) => l.split("\t"))
    .filter(([s, st]) => s.startsWith("emulator-") && (!ready || st === "device")).map(([s]) => s);
}

async function androidDevice() {
  for (const s of emulatorSerials(true)) {
    if ((tryOut(ADB, ["-s", s, "emu", "avd", "name"]) || "").split("\n")[0].trim() === AVD) {
      log(`reusing running emulator ${s}`);
      return finishAndroid(s);
    }
  }
  const avds = out(path.join(SDK, "emulator/emulator"), ["-list-avds"]).split("\n");
  if (!avds.includes(AVD)) {
    execFileSync(path.join(SDK, "cmdline-tools/latest/bin/avdmanager"), ["create", "avd", "-n", AVD, "-k", AVD_IMAGE, "-d", AVD_DEVICE],
      { input: "no\n", stdio: ["pipe", "ignore", "inherit"] });
    log(`created AVD ${AVD} from ${AVD_IMAGE}`);
  }
  // The e2e's own AVD asks for the host GPU too (AGENTS.md "GPU in every test"), also when it predates this key.
  // Temp file + rename: a crash mid-write never leaves a truncated config.ini.
  const ini = path.join(AVD_DIR(), "config.ini");
  if (fs.existsSync(ini)) {
    fs.writeFileSync(`${ini}.tmp`, withGpuHost(fs.readFileSync(ini, "utf8")));
    fs.renameSync(`${ini}.tmp`, ini);
  } else log(`warning: ${ini} not found; the boot relies on -gpu host alone`);
  const used = new Set(emulatorSerials().map((s) => Number(s.split("-")[1])));
  let port = 5600;
  while (used.has(port)) port += 2;
  const child = spawn(path.join(SDK, "emulator/emulator"), emulatorArgs(AVD, port),
    { detached: true, stdio: "ignore" });
  child.unref();
  const serial = `emulator-${port}`;
  booted.push(["android", serial, child.pid]);
  log(`booting emulator ${serial}`);
  let exited = false;
  child.on("exit", () => { exited = true; });
  for (let i = 0; i < 180; i++) {
    if (exited) throw new Error(`emulator ${AVD} exited while booting (is the AVD in use?)`);
    if (tryOut(ADB, ["-s", serial, "shell", "getprop", "sys.boot_completed"]) === "1"
      && (tryOut(ADB, ["-s", serial, "emu", "avd", "name"]) || "").split("\n")[0].trim() === AVD) return finishAndroid(serial);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`emulator ${serial} did not boot in 6 minutes`);
}

function finishAndroid(serial) {
  const api = Number(out(ADB, ["-s", serial, "shell", "getprop", "ro.build.version.sdk"]));
  if (api < 33) throw new Error(`emulator ${serial} is API ${api}; set-app-locales needs API 33+`);
  // A reused emulator may have been booted on a CPU renderer, and a fresh boot may have fallen back to one:
  // hardware-qemu.ini holds the mode the running emulator booted with (AGENTS.md "GPU in every test").
  // The emulator console names its own AVD directory, so a same-named AVD from another AVD home is read correctly.
  const dir = (tryOut(ADB, ["-s", serial, "emu", "avd", "path"]) || "").split("\n")[0].trim();
  const hw = path.isAbsolute(dir) ? path.join(dir, "hardware-qemu.ini") : `(console: ${dir || "no answer"})`;
  const mode = fs.existsSync(hw) ? gpuModeOf(fs.readFileSync(hw, "utf8")) : null;
  if (mode !== "host") throw new Error(`emulator ${serial} runs hw.gpu.mode=${mode} (${hw}); the e2e needs the host GPU. Shut it down and rerun`);
  // A loaded host makes a fresh emulator show "System UI isn't responding" over the app, and every flow fails.
  // This is the e2e's own AVD, so its error dialogs are turned off.
  tryOut(ADB, ["-s", serial, "shell", "settings", "put", "global", "hide_error_dialogs", "1"]);
  return { udid: serial, api, image: AVD_IMAGE, avd: AVD };
}

function install(platform, dev, app) {
  if (platform === "android") tryOut(ADB, ["-s", dev.udid, "shell", "am", "broadcast", "-a", "android.intent.action.CLOSE_SYSTEM_DIALOGS"]);
  if (platform === "ios") {
    tryOut("xcrun", ["simctl", "uninstall", dev.udid, "org.catscan.sample"]);
    out("xcrun", ["simctl", "install", dev.udid, app]);
  } else {
    tryOut(ADB, ["-s", dev.udid, "uninstall", "org.catscan.sample"]);
    out(ADB, ["-s", dev.udid, "install", "-r", app]);
  }
}

// --- assertions -----------------------------------------------------------------------------------------------

function merged(platform, locales, tag) {
  const file = path.join(WORK, `${platform}-${tag}-merged.json`);
  // The default size only: a large-text run's files stay in out/ for the combined report (TODO-076).
  const files = fs.readdirSync(path.join(EX, "out")).filter((f) => f.startsWith(`${platform}-default-`) && f.endsWith(".json")).map((f) => `out/${f}`);
  catscan(["results", "merge", ...files, "--out", file, "--layout", LAYOUT, "--expect-locales", locales.join(","), "--expect-screens", "screens.txt"]);
  return json(file);
}

const failing = (platform, cmd, locale, size = "default") => {
  const f = path.join(EX, "out", `${platform}-${size}-${cmd}-${locale}.json`);   // run-all.sh: out/<platform>-<size>-<command>-<locale>.json
  if (!fs.existsSync(f)) return null;
  return json(f).results.filter((r) => r.verdict !== "pass").map((r) => r.screen).sort();
};

function snapshot(platform, tag) {
  const dest = path.join(WORK, `${platform}-${tag}`);
  fs.cpSync(path.join(EX, "out"), path.join(dest, "out"), { recursive: true });
  fs.cpSync(path.join(EX, "shots", platform), path.join(dest, "shots"), { recursive: true });
}

/**
 * TODO-075 D15: the recipe's "4. One release report" command, run verbatim from examples/maestro/ over both
 * platforms' clean results and screenshots (the fault runs overwrote them, so the clean snapshots come back first).
 */
function combined() {
  const md = fs.readFileSync(path.join(ROOT, "docs/recipes/maestro.md"), "utf8");
  const sec = md.split(/^## /m).find((s) => s.startsWith("4. One release report"));
  const block = sec && (sec.match(/```sh\n([^]*?)```/) || [])[1];
  const line = block && block.split("\n").find((l) => l.startsWith("catscan report "));
  check(Boolean(line), "combined: the recipe's 4. One release report section has a catscan report line");
  if (!line) return;
  const out = path.join(EX, "out");
  for (const f of fs.readdirSync(out).filter((f) => f.endsWith(".json"))) fs.rmSync(path.join(out, f));
  for (const p of PLATFORMS) {
    const snap = path.join(WORK, `${p}-clean`);
    for (const f of fs.readdirSync(path.join(snap, "out")).filter((f) => f.startsWith(`${p}-`) && f.endsWith(".json"))) fs.copyFileSync(path.join(snap, "out", f), path.join(out, f));
    fs.rmSync(path.join(EX, "shots", p), { recursive: true, force: true });
    fs.cpSync(path.join(snap, "shots"), path.join(EX, "shots", p), { recursive: true });
  }
  const rc = sh(["-c", line]);
  // A cell that fails at large text fails the merged run (exit 1); the demo had one false fail (TODO-058).
  check(rc === 0 || rc === 1, `combined: the recipe's report exits 0 or 1 (got ${rc})`);
  const html = fs.readFileSync(path.join(out, "all.html"), "utf8");
  const m = JSON.parse(html.match(/<script type="application\/json" id="catscan-data">([^]*?)<\/script>/)[1]).matrix;
  const devices = (m.devices || []).map((d) => d.device).join(",");
  check(devices === "android,ios", `combined: two devices, android and ios (got ${devices})`);
  const sizes = (m.textSizes || []).join(",");
  check(sizes === "default,large", `combined: two text sizes, default and large (got ${sizes})`);
  check(m.coverageLine === "received 24 of 24 expected cells (3 screens x 2 locales x 2 devices x 2 text sizes), 0 missing, 0 duplicate", `combined: ${m.coverageLine}`);
  const badged = m.cells.filter((c) => c.badges.includes("large text")).map((c) => `${c.device}/${c.text_size}/${c.locale}/${c.screen}`);
  record.combined = { command: line, exit: rc, coverage: m.coverageLine, large_text_badges: badged };
}

async function runPlatform(platform) {
  const rec = { wall_s: {} };
  const t0 = Date.now();
  log(`${platform}: building clean and FAULTS=1`);
  const clean = platform === "ios" ? buildIos(false) : buildAndroid(false);
  const faulty = platform === "ios" ? buildIos(true) : buildAndroid(true);
  rec.wall_s.build = Math.round((Date.now() - t0) / 1000);
  const dev = platform === "ios" ? iosDevice() : await androidDevice();
  rec.device = dev;
  const E = { MAESTRO_UDID: dev.udid };
  // TODO-076 D5: a run killed before run-all.sh restored the size leaves the device at large text (the AVD keeps it),
  // and the clean run would then run at large text. Start from the default size and record what was found.
  rec.text_size_at_start = platform === "ios" ? tryOut("xcrun", ["simctl", "ui", dev.udid, "content_size"]) : tryOut(ADB, ["-s", dev.udid, "shell", "settings", "get", "system", "font_scale"]);
  if (platform === "android" && !["1.0", "1", "null"].includes(rec.text_size_at_start)) out(ADB, ["-s", dev.udid, "shell", "settings", "put", "system", "font_scale", "1.0"]);
  if (platform === "ios" && rec.text_size_at_start !== "large") {
    out("xcrun", ["simctl", "ui", dev.udid, "content_size", "large"]);
    out("xcrun", ["simctl", "shutdown", dev.udid]);
    out("xcrun", ["simctl", "boot", dev.udid]);
    out("xcrun", ["simctl", "bootstatus", dev.udid, "-b"]);
  }

  // 1. Clean build: every command exits 0; the report has 2 locales x 3 screens, nothing missing or duplicate.
  let t = Date.now();
  install(platform, dev, clean);
  const rc = sh(["./run-all.sh", platform, ...LOCALES], E);
  rec.wall_s.clean_run = Math.round((Date.now() - t) / 1000);
  check(rc === 0, `${platform} clean: run-all.sh exits 0 (got ${rc})`);
  for (const L of LOCALES) for (const cmd of ["check", "untranslated", "truncated"]) {
    const f = failing(platform, cmd, L);
    check(f && f.length === 0, `${platform} clean: ${cmd} ${L} passes every screen (failing: ${f})`);
  }
  // Screenshots land under the working directory (Maestro 2.6.0, no --test-output-dir).
  for (const L of LOCALES) for (const s of SCREENS) check(fs.existsSync(path.join(EX, `shots/${platform}/${s}.${L}.png`)), `${platform}: shots/${platform}/${s}.${L}.png written`);
  const m = merged(platform, LOCALES, "clean");
  check(m.coverage.missing.length === 0 && m.coverage.expected_locales.length === 2 && m.coverage.expected_screens.length === 3,
    `${platform} clean: report covers 2 locales x 3 screens, none missing (missing ${JSON.stringify(m.coverage.missing)})`);
  check(!m.results.some((r) => (r.warnings || []).some((w) => w.code === "duplicate-cell")), `${platform} clean: no duplicate-cell`);
  check(fs.existsSync(path.join(EX, `out/${platform}.html`)), `${platform} clean: out/${platform}.html written`);
  for (const L of LOCALES) {
    const r = catscan(["check", `shots/${platform}/onboarding.${L}.png`, "--present", SAMPLE[L], "--locale", L]);
    check(r.status === 0, `${platform}: onboarding.${L}.png shows "${SAMPLE[L]}" (locale switch)`);
    const df = path.join(EX, `shots/${platform}/settings.${L}.maestro.json`);
    const dump = fs.existsSync(df) ? fs.readFileSync(df, "utf8") : "";
    const label = { de: "Benachrichtigungseinstellungen", fr: "Réglages des alertes" }[L];
    check(dump.includes(label), `${platform}: settings.${L} dump holds "${label}" (taken on settings)`);
  }
  // TODO-076: the same clean build at the largest system text size; run-all.sh sets it, reboots iOS, and restores it.
  t = Date.now();
  const rcL = sh(["./run-all.sh", platform, ...LOCALES], { ...E, TEXT_SIZE: "large" });
  rec.wall_s.large_run = Math.round((Date.now() - t) / 1000);
  check(rcL === 0 || rcL === 1, `${platform} large: run-all.sh exits 0 or 1 (got ${rcL})`);
  for (const L of LOCALES) for (const s of SCREENS) check(fs.existsSync(path.join(EX, `shots/${platform}/large/${s}.${L}.png`)), `${platform} large: shots/${platform}/large/${s}.${L}.png written`);
  rec.large = { exit: rcL, failing: {} };
  for (const L of LOCALES) for (const cmd of ["check", "untranslated", "truncated"]) {
    const f = failing(platform, cmd, L, "large");
    check(f !== null, `${platform} large: out/${platform}-large-${cmd}-${L}.json written`);
    rec.large.failing[`${cmd}-${L}`] = f;
  }
  const now = platform === "ios" ? tryOut("xcrun", ["simctl", "ui", dev.udid, "content_size"]) : tryOut(ADB, ["-s", dev.udid, "shell", "settings", "get", "system", "font_scale"]);
  check(platform === "ios" ? now === "large" : ["1.0", "1"].includes(now), `${platform} large: the text size is restored to the default (now ${now})`);
  check(fs.existsSync(path.join(EX, `out/${platform}.html`)), `${platform} large: out/${platform}.html covers both sizes`);
  snapshot(platform, "clean");

  // 2. One screen dropped from the flows: one missing cell, exit 1.
  t = Date.now();
  const flows = path.join(WORK, `${platform}-flows-drop`);
  fs.cpSync(path.join(EX, "flows"), flows, { recursive: true });
  fs.rmSync(path.join(flows, "game.yaml"));
  if (platform === "android") tryOut(ADB, ["-s", dev.udid, "shell", "am", "broadcast", "-a", "android.intent.action.CLOSE_SYSTEM_DIALOGS"]);
  const rcDrop = sh(["./run-all.sh", platform, "de"], { ...E, FLOWS: flows });
  rec.wall_s.drop_run = Math.round((Date.now() - t) / 1000);
  const md = merged(platform, ["de"], "drop");
  // Exit 1 is also what a Maestro failure gives: the screens the flows kept must all be there.
  check(["onboarding", "settings"].every((s) => fs.existsSync(path.join(EX, `shots/${platform}/${s}.de.png`))),
    `${platform} dropped screen: onboarding and settings screenshots written`);
  check(rcDrop === 1 && md.coverage.missing.length === 1 && md.coverage.missing[0].screen === "game",
    `${platform} dropped screen: exit 1 and one missing cell (exit ${rcDrop}, missing ${JSON.stringify(md.coverage.missing)})`);

  // 3. Fault build: a raw key on onboarding, a cut-off label on settings; untranslated and truncated fail on exactly those.
  t = Date.now();
  install(platform, dev, faulty);
  const rcF = sh(["./run-all.sh", platform, ...LOCALES], E);
  rec.wall_s.fault_run = Math.round((Date.now() - t) / 1000);
  for (const L of LOCALES) for (const s of SCREENS) check(fs.existsSync(path.join(EX, `shots/${platform}/${s}.${L}.png`)), `${platform} faults: shots/${platform}/${s}.${L}.png written`);
  check(rcF === 1, `${platform} faults: run-all.sh exits 1 (got ${rcF})`);
  for (const L of LOCALES) {
    check(JSON.stringify(failing(platform, "untranslated", L)) === '["onboarding"]', `${platform} faults: untranslated ${L} fails onboarding only (${failing(platform, "untranslated", L)})`);
  }
  // The German label is the planted cut; the French one may be cut by the same narrow frame, never another screen.
  check(JSON.stringify(failing(platform, "truncated", "de")) === '["settings"]', `${platform} faults: truncated de fails settings only (${failing(platform, "truncated", "de")})`);
  const trFr = failing(platform, "truncated", "fr");
  check(trFr !== null && trFr.every((s) => s === "settings"), `${platform} faults: truncated fr fails no screen but settings (${trFr})`);
  // 4. The recipe's step 0 on the fault build's screenshots reports the raw key.
  const de = SCREENS.map((s) => `shots/${platform}/${s}.de.png`);
  const s0 = catscan(["untranslated", ...de, "--locale", "de"]);
  check(s0.status === 1 && /raw-key "onboarding\.body"/.test(s0.stdout), `${platform} step 0: untranslated --locale de reports raw-key "onboarding.body"`);
  snapshot(platform, "faults");
  install(platform, dev, clean);
  rec.wall_s.total = Math.round((Date.now() - t0) / 1000);
  record.platforms[platform] = rec;
}

function shutdown() {
  for (const [p, id, pid] of booted.splice(0)) {
    log(`shutting down ${p} ${id}`);
    if (p === "ios") tryOut("xcrun", ["simctl", "shutdown", id]);
    else if (tryOut(ADB, ["-s", id, "emu", "kill"]) === null) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  }
}
const unlock = () => { try { fs.rmdirSync(LOCK); } catch { /* gone */ } };
process.on("SIGINT", () => { shutdown(); unlock(); process.exit(130); });
process.on("SIGTERM", () => { shutdown(); unlock(); process.exit(143); });

try {
  record.versions = versions();
  record.vision_timeout_s = Number(process.env.CATSCAN_VISION_TIMEOUT);
  record.load_average_start = os.loadavg().map((n) => Math.round(n));
  for (const p of PLATFORMS) {
    try { await runPlatform(p); } catch (e) { failures.push(`${p}: ${e.message}`); console.error(e); }
  }
  if (!only) {
    try { combined(); } catch (e) { failures.push(`combined: ${e.message}`); console.error(e); }
  }
} finally {
  shutdown();
  unlock();
}
record.wall_s = Math.round((Date.now() - started) / 1000);
record.load_average_end = os.loadavg().map((n) => Math.round(n));
record.failures = failures;
record.pass = failures.length === 0;
record.work_dir = "(temporary)";
const dest = path.join(ROOT, "results/maestro-e2e", `${hostKey()}${only ? `-${only}` : ""}.json`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(record, null, 2) + "\n");
log(`${failures.length ? `FAIL (${failures.length})` : "PASS"}; wrote ${path.relative(ROOT, dest)}; screenshots and results kept in ${WORK}`);
process.exit(failures.length ? 1 : 0);
