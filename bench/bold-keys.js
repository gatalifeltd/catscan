#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-031: how often Vision loses the dot of a raw key set in bold, and what `catscan untranslated` reports then.
// Usage: node bench/bold-keys.js > results/bold-keys.json
// Every key of bench/untranslated/strings.json and a game menu is drawn raw (four keys per screen, nothing else on it) with
// test/fixtures/generate.swift in 14 font families x regular and bold x 3 sizes, then read twice: `catscan read`
// for the recognized line (was the separator kept?) and `catscan untranslated --locale de` for the findings.
// Labeled by construction: every line is a raw key, so any `untranslated` finding is a misreport.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const S = require("./untranslated/strings.json");
// [regular, bold] PostScript names, all shipped with macOS.
const FAMILIES = [
  ["Helvetica", "Helvetica-Bold"], ["HelveticaNeue", "HelveticaNeue-Bold"], ["ArialMT", "Arial-BoldMT"],
  ["Verdana", "Verdana-Bold"], ["Avenir-Book", "Avenir-Black"], ["Futura-Medium", "Futura-Bold"],
  ["GillSans", "GillSans-Bold"], ["Georgia", "Georgia-Bold"],
  // Game-screen faces: heavy and condensed weights.
  ["AvenirNext-Regular", "AvenirNext-Heavy"], ["HelveticaNeue", "HelveticaNeue-CondensedBlack"],
  ["ArialMT", "Arial-Black"], ["Futura-Medium", "Futura-CondensedExtraBold"], ["ChalkboardSE-Regular", "ChalkboardSE-Bold"],
  ["MarkerFelt-Thin", "MarkerFelt-Wide"],
];
const SIZES = [16, 24, 36];
// Keys of a game menu, as in the owner's report (`settings.support` read as `settings support`), with en and de text.
const GAME = {
  "settings.support": ["Support", "Hilfe"], "settings.sound": ["Sound", "Ton"], "settings.music": ["Music", "Musik"],
  "menu.play": ["Play", "Spielen"], "menu.shop": ["Shop", "Laden"], "shop.buy": ["Buy", "Kaufen"],
  "level.complete": ["Level complete", "Level geschafft"], "level.start": ["Start level", "Level starten"],
  "reward.claim": ["Claim reward", "Belohnung abholen"], "game.over": ["Game over", "Spiel vorbei"],
  "daily.bonus": ["Daily bonus", "Tagesbonus"], "lives.refill": ["Refill lives", "Leben auffüllen"],
};
const PER_SCREEN = 4;
const KEYS = [...S.keys.filter((k) => k.includes(".")), ...Object.keys(GAME)];

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`catscan ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

(() => {
  const gen = path.join(ROOT, ".build/synth");
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  execFileSync("swiftc", ["-O", path.join(ROOT, "test/fixtures/generate.swift"), "-o", gen]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-bold-keys-"));
  const cat = (l) => ({ ...Object.fromEntries(S.keys.map((k, i) => [k, S.locales[l][i]])),
    ...Object.fromEntries(Object.entries(GAME).map(([k, v]) => [k, v[l === "en" ? 0 : 1]])) });
  fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify(cat("en")));
  fs.writeFileSync(path.join(dir, "de.json"), JSON.stringify(cat("de")));
  const screens = [];
  for (const [fi, fam] of FAMILIES.entries()) for (const [wi, font] of fam.entries()) for (const size of SIZES) {
    for (let c = 0; c * PER_SCREEN < KEYS.length; c++) {
      const keys = KEYS.slice(c * PER_SCREEN, (c + 1) * PER_SCREEN);
      screens.push({ name: `f${fi}-${wi ? "bold" : "regular"}-${size}-${c}.png`, family: fam[0], weight: wi ? "bold" : "regular", size, font, keys });
    }
  }
  const shots = path.join(dir, "shots");
  fs.mkdirSync(shots);
  const manifest = screens.map((s) => ({
    name: s.name, locale: "de", width: 900, height: Math.round(60 + s.keys.length * s.size * 2.4),
    lines: s.keys.map((t, i) => ({ text: t, x: 40, y: 30 + i * s.size * 2.4, size: s.size, font: s.font })),
  }));
  fs.writeFileSync(path.join(dir, "screens.json"), JSON.stringify(manifest));
  execFileSync(gen, [path.join(dir, "screens.json"), shots], { stdio: "ignore" });

  const byName = (envs) => Object.fromEntries(envs.map((e) => [path.basename(e.path), e]));
  const read = byName(run(["read", shots, "--locale", "de"]));
  const untr = byName(run(["untranslated", shots, "--locale", "de", "--base", path.join(dir, "en.json"), "--catalog", path.join(dir, "de.json")]));
  const blank = () => ({ keys: 0, read: 0, separator_lost: 0, eligible: 0, found: 0, found_eligible: 0, missed: 0, untranslated_fp: 0, raw_key_fp: 0 });
  const total = { regular: blank(), bold: blank() };
  const perFamily = {};
  const lostSamples = [];
  const strip = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  // The TODO-031 guard: a key whose words equal a catalog string's or a piece beside its placeholder (`game.over`,
  // base `Game over`; `days.left`, base `%d days left`) read with spaces only is that string, so the line is not
  // eligible for recovery.
  const lenient = (x) => x.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(".");
  const pieces = (v) => [v, ...v.split(/%(?:\d+\$)?[@dsfi]|\{[^}]*\}/)];
  const texts = new Set(["en", "de"].flatMap((l) => Object.values(cat(l))).flatMap(pieces).map(lenient));
  for (const s of screens) {
    const t = total[s.weight];
    const f = (perFamily[`${s.font} ${s.weight}`] ??= blank());
    const lines = (read[s.name]?.lines || []).map((l) => l.text);
    const findings = untr[s.name]?.findings || [];
    const raw = findings.filter((x) => x.kind === "raw-key");
    for (const k of s.keys) {
      for (const o of [t, f]) o.keys++;
      // Read intact: a recognized line with every letter and digit of the key.
      const line = lines.find((l) => strip(l) === strip(k));
      const eligible = line !== undefined && !(texts.has(lenient(k)) && !/[._\-/:]/.test(line));
      if (line !== undefined) {
        for (const o of [t, f]) o.read++;
        if (!line.includes(".")) {
          for (const o of [t, f]) o.separator_lost++;
          if (lostSamples.length < 30) lostSamples.push({ entry: k, line, font: s.font, size: s.size });
        }
      }
      if (eligible) for (const o of [t, f]) o.eligible++;
      // Found: a raw-key finding that names the key, or (the D30 pattern, no key) whose line is the key.
      const at = raw.findIndex((x) => x.key === k || x.keys?.includes(k) || (!x.key && !x.keys && strip(x.line) === strip(k)));
      if (at >= 0) {
        raw.splice(at, 1);
        for (const o of [t, f]) { o.found++; if (eligible) o.found_eligible++; }
      } else for (const o of [t, f]) o.missed++;
    }
    for (const o of [t, f]) {
      o.raw_key_fp += raw.length;
      o.untranslated_fp += findings.filter((x) => x.kind === "untranslated").length;
    }
  }
  const pct = (a, b) => (b ? Number((a / b).toFixed(3)) : null);
  for (const o of [...Object.values(total), ...Object.values(perFamily)]) {
    o.separator_lost_rate = pct(o.separator_lost, o.read);
    o.recall = pct(o.found, o.keys);
    o.recall_eligible = pct(o.found_eligible, o.eligible);
  }
  const v = versionInfo();
  process.stdout.write(JSON.stringify({
    screens: screens.length, keys_per_weight: total.regular.keys, families: FAMILIES, sizes: SIZES, total, per_family: perFamily,
    separator_lost_samples: lostSamples,
    tools: { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version, generator: "test/fixtures/generate.swift" },
  }, null, 2) + "\n");
  fs.rmSync(dir, { recursive: true, force: true });
})();
