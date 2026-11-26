#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-073 "Measurement", rendered positives (D26): the probe app draws UIKit labels and SF Symbol buttons into
// the zones of three simulators (Dynamic Island, notch, iPad), portrait and both landscapes. The probe reports each
// label's TextKit glyph rects; a label is positive when half of one letter's rect lies in a zone, a button when a
// quarter of its frame does (the synthetic truth). Screenshots are `--mask=ignored`, as an app's capture shows them.
//
//   node bench/safe-area/rendered.mjs [--keep <dir>] > results/safe-area-rendered.json
// One simulator at a time, created and deleted here (AGENTS.md device limit).
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const { mask, share, diagonal } = require("../safe-area.js");
const { wilson } = require("../overlap/elements-lib.js");
const TABLE = require("../../packages/core-js/src/device-profiles.json");
const S = require("../untranslated/strings.json");
const BUNDLE = "dev.catscan.probe";
const DEVICES = [["iphone-17-pro", "iPhone 17 Pro"], ["iphone-14", "iPhone 14"], ["ipad-pro-13-inch-m5", "iPad Pro 13-inch (M5)"]];
const ORIENTATIONS = ["portrait", "landscape-left", "landscape-right"];
const LAUNCHES = 6;
const REASONS = ["cutout", "corner", "home-indicator"];

const simctl = async (...a) => (await run("xcrun", ["simctl", ...a], { maxBuffer: 64 << 20 })).stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const letter = (ch) => /[\p{L}\p{N}]/u.test(ch);
const strings = Object.values(S.locales).flat().filter((t) => t && !/[{}%]/.test(t) && t.length <= 14);

function bbox({ m, W, H }) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Items for one launch, in points: a label ending inside the cutout, labels in the bottom corners, buttons in the top ones. */
function items(p, o, k) {
  const sc = p.screen.scale, cut = bbox(mask(p, o, ["cutout"])), cor = mask(p, o, ["corner"]);
  const W = cor.W / sc, H = cor.H / sc, out = [];
  const t = (i) => strings[(k * 7 + i * 13) % strings.length];
  const size = 15 + (k % 4) * 2;
  if (cut) {
    const depth = [10, 14, 18, 22][k % 4]; // points past the cutout's inner edge
    const cy = (cut.y0 + cut.y1) / 2 / sc;
    if (o === "landscape-left") out.push({ id: "cutout", text: t(0), size, left: cut.x1 / sc - depth, centerY: cy });
    else out.push({ id: "cutout", text: t(0), size, right: cut.x0 / sc + depth, centerY: cy });
  }
  const d = [4, 7, 10][k % 3];
  for (const c of ["bl", "br"]) {
    const e = diagonal(cor, c) / sc - d;
    const it = { id: `corner-${c}`, text: t(c === "bl" ? 1 : 2), size, bottom: H - e };
    if (c === "bl") it.left = e; else it.right = W - e;
    out.push(it);
  }
  for (const c of ["tl", "tr"]) {
    // A 22 pt symbol's button is about 30 pt square: it needs 10 pt or more past the curve to be a quarter covered.
    const e = diagonal(cor, c) / sc - [8, 12, 16][k % 3];
    // In portrait the top corners are beside the cutout's row; the buttons stay in the corners.
    const it = { id: `icon-${c}`, text: null, size: 22, top: e };
    if (c === "tl") it.left = e; else it.right = W - e;
    out.push(it);
  }
  return out;
}

async function device(id, name, app, dir) {
  const p = TABLE.profiles.find((x) => x.id === id);
  if (!p) throw new Error(`no profile ${id}`);
  const types = JSON.parse(await simctl("list", "-j", "devicetypes", "runtimes"));
  const type = types.devicetypes.find((t) => t.name === name);
  const rt = types.runtimes.filter((r) => r.isAvailable && r.platform === "iOS" && r.supportedDeviceTypes.some((s) => s.identifier === type.identifier))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  const udid = (await simctl("create", `catscan-rendered-${id}`, type.identifier, rt.identifier)).trim();
  const shots = [];
  try {
    await simctl("boot", udid);
    await simctl("bootstatus", udid);
    await simctl("install", udid, app);
    for (const o of ORIENTATIONS) {
      for (let k = 0; k < LAUNCHES; k++) {
        const its = items(p, o, k);
        await simctl("terminate", udid, BUNDLE).catch(() => {});
        const data = (await simctl("get_app_container", udid, BUNDLE, "data")).trim();
        fs.rmSync(path.join(data, "Documents/probe.json"), { force: true });
        await simctl("launch", udid, BUNDLE, "-orientation", o, "-items", Buffer.from(JSON.stringify(its)).toString("base64"));
        let rep = null;
        for (let i = 0; i < 40 && !rep; i++) {
          await sleep(500);
          try { const r = JSON.parse(fs.readFileSync(path.join(data, "Documents/probe.json"), "utf8")); if ((r.width > r.height) === (o !== "portrait") && r.items?.length === its.length) rep = r; } catch {}
        }
        if (!rep) throw new Error(`${id} ${o}: the probe did not report`);
        await sleep(1500);
        const name2 = `${id}-${o}-${k}`, png = path.join(dir, `${name2}.png`);
        await simctl("io", udid, "screenshot", "--mask=ignored", png);
        const sc = rep.scale, Wp = rep.width * sc, Hp = rep.height * sc;
        const els = rep.items.map((it) => ({ id: it.id, box: [it.frame[0] * sc / Wp, it.frame[1] * sc / Hp, it.frame[2] * sc / Wp, it.frame[3] * sc / Hp].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000), ...(its.find((x) => x.id === it.id).text ? { text: its.find((x) => x.id === it.id).text } : { control: true }) }));
        fs.writeFileSync(path.join(dir, `${name2}.boxes.json`), JSON.stringify({ image: { width: Wp, height: Hp }, orientation: o, elements: els }));
        shots.push({ name: name2, profile: id, orientation: o, items: rep.items.map((it) => ({ ...it, text: its.find((x) => x.id === it.id).text, frame: it.frame.map((v) => v * sc), glyphs: it.glyphs.map((g) => ({ ch: g.ch, rect: g.rect.map((v) => v * sc) })) })) });
      }
    }
  } finally {
    await simctl("shutdown", udid).catch(() => {});
    await simctl("delete", udid).catch(() => {});
  }
  return shots;
}

async function main() {
  const i = process.argv.indexOf("--keep");
  const dir = i > 0 ? process.argv[i + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "catscan-rendered-"));
  fs.mkdirSync(dir, { recursive: true });
  const app = path.join(dir, "Probe.app");
  fs.mkdirSync(app, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "bench/devices/probe-ios/Info.plist"), path.join(app, "Info.plist"));
  await run("xcrun", ["-sdk", "iphonesimulator", "swiftc", "-O", "-target", "arm64-apple-ios17.0-simulator", path.join(ROOT, "bench/devices/probe-ios/Probe.swift"), "-o", path.join(app, "Probe")]);
  await run("codesign", ["-s", "-", app]);
  const shots = [];
  for (const [id, name] of DEVICES) shots.push(...(await device(id, name, app, dir)));
  const score = {};
  for (const [id] of DEVICES) for (const o of ORIENTATIONS) {
    const list = shots.filter((s) => s.profile === id && s.orientation === o);
    const r = spawnSync(process.execPath, [path.join(ROOT, "bin/catscan.js"), "fit", ...list.map((s) => path.join(dir, `${s.name}.png`)), "--json", "--experimental", "--boxes", dir, "--orientation", o], { encoding: "utf8", maxBuffer: 256 << 20 });
    const envs = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const p = TABLE.profiles.find((x) => x.id === id);
    for (const s of list) {
      const env = envs.find((e) => path.basename(e.path, ".png") === s.name);
      for (const it of s.items) {
        let want = null;
        for (const k of REASONS) {
          const z = mask(p, o, [k]);
          if (it.text ? it.glyphs.some((g) => letter(g.ch) && share(g.rect, z) >= 0.5) : share(it.frame, z) >= 0.25) { want = k; break; }
        }
        if (!want) continue; // rendered measures recall on positives only
        const key = `${want}/${it.text ? "text" : "controls"}`;
        const c = (score[key] ||= { n: 0, tp: 0, misses: [] });
        c.n++;
        if ((env?.findings || []).some((f) => f.element?.id === it.id)) c.tp++;
        else if (c.misses.length < 10) c.misses.push(`${s.name}/${it.id}`);
      }
    }
  }
  for (const c of Object.values(score)) { c.recall = c.n ? Math.round((c.tp / c.n) * 10000) / 10000 : null; c.recall_ci = c.n ? wilson(c.tp, c.n).map((x) => Math.round(x * 1000) / 1000) : null; }
  const xc = (await run("xcodebuild", ["-version"])).stdout.trim().split("\n").join(" ");
  process.stdout.write(JSON.stringify({ script: "bench/safe-area/rendered.mjs", xcode: xc, profile_table: TABLE.version, devices: DEVICES.map((d) => d[0]), screens: shots.length, ...score }, null, 2) + "\n");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
