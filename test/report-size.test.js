// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 18 D16: 500 phone-size screenshots at the default settings stay under 50 MB. Opt-in (CATSCAN_SIZE_TEST=1):
// it takes minutes. The images are drawn at test time; none is committed. If it fails, the default
// --report-max-edge goes down; the limit does not go up.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { ROOT, setup, cli, host } = require("./helpers");

const N = 500;
const WORDS = ["Continue", "Settings", "Weiter", "Einstellungen", "Continuer", "Paramètres", "Account", "Privacy", "Level 12", "Score 4096", "Shop", "Inventory"];

test(`size: ${N} phone screenshots at the default settings stay under 50 MB`, { skip: process.env.CATSCAN_SIZE_TEST !== "1" && "opt-in: CATSCAN_SIZE_TEST=1" }, () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-report-size-"));
  const shots = Array.from({ length: N }, (_, i) => ({
    name: `shot-${String(i).padStart(3, "0")}.png`, locale: "en", width: 1179, height: 2556,
    lines: Array.from({ length: 14 }, (_, j) => ({ text: `${WORDS[(i + j) % WORDS.length]} ${i}-${j}`, x: 80 + ((i * 37 + j * 53) % 300), y: 120 + j * 170, size: 40 + ((i + j) % 5) * 12 })),
  }));
  fs.writeFileSync(path.join(dir, "shots.json"), JSON.stringify(shots));
  execFileSync(path.join(ROOT, ".build/synth"), [path.join(dir, "shots.json"), path.join(dir, "shots")]);
  const t0 = Date.now();
  const r = cli(["read", "shots", "--report", "size.html", "-q"], { cwd: dir, timeout: 20 * 60 * 1000 });
  const seconds = (Date.now() - t0) / 1000;
  assert.equal(r.code, 0, r.stderr);
  const bytes = fs.statSync(path.join(dir, "size.html")).size;
  const v = host();
  console.log(`report-size: ${N} images, ${(bytes / 1048576).toFixed(1)} MB in ${seconds.toFixed(0)} s; macOS ${v.macos} (${v.macos_build}), catscan ${v.catscan}`);
  assert.ok(bytes < 50 * 1024 * 1024, `${(bytes / 1048576).toFixed(1)} MB`);
  assert.doesNotMatch(r.stderr, /report-large/);
  fs.rmSync(dir, { recursive: true, force: true });
});
