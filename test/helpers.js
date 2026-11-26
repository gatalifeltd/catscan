// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Shared setup for the integration tests: the binary, the synthetic images and a CLI runner.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BIN = process.env.CATSCAN_CORE_BINARY || path.join(ROOT, "core/.build/release/catscan-core");
const CLI = path.join(ROOT, "bin/catscan.js");
const MANIFEST = require("./fixtures/synthetic.json");

let synthDir = null;

/** Builds the binary when missing and draws the synthetic images once per process. */
function setup() {
  if (!fs.existsSync(BIN)) execFileSync("swift", ["build", "-c", "release", "--package-path", path.join(ROOT, "core")], { stdio: "inherit" });
  if (synthDir) return synthDir;
  const gen = path.join(ROOT, ".build/synth");
  const src = path.join(__dirname, "fixtures/generate.swift");
  if (!fs.existsSync(gen) || fs.statSync(gen).mtimeMs < fs.statSync(src).mtimeMs) {
    fs.mkdirSync(path.dirname(gen), { recursive: true });
    execFileSync("swiftc", ["-O", src, "-o", gen]);
  }
  synthDir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-synth-"));
  execFileSync(gen, [path.join(__dirname, "fixtures/synthetic.json"), synthDir]);
  return synthDir;
}

/** Runs the CLI. Returns { code, stdout, stderr, json } (json: parsed stdout lines). */
function cli(args, { cwd = synthDir, input, env = {}, timeout } = {}) {
  // TODO-089 D4: Vision under 3-4 concurrent heavy runs on one Mac can pass the 60 s per-image deadline for an image
  // it reads alone in 3 s. Tests check results, not speed, so they wait 180 s unless the test sets the deadline.
  const own = "CATSCAN_VISION_TIMEOUT" in env || "CATSCAN_VISION_TIMEOUT" in process.env;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, input, timeout, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    // TODO-059 D25: doctor never asks the npm registry from a test.
    env: { ...process.env, CATSCAN_CORE_BINARY: BIN, CATSCAN_NO_UPDATE_CHECK: "1", ...(own ? {} : { CATSCAN_VISION_TIMEOUT: "180" }), ...env },
  });
  if (!own && /vision-timeout/.test(r.stderr || "")) {
    const cores = (spawnSync("pgrep", ["-x", "catscan-core"], { encoding: "utf8" }).stdout || "").split("\n").filter(Boolean).length;
    process.stderr.write(`test helper: vision-timeout after 180 s with ${cores} catscan-core processes running, load average ` +
      `${os.loadavg().map((x) => x.toFixed(1)).join(" ")}: Vision under load, not this test's input (docs/gotchas/vision.md)\n`);
  }
  let json = null;
  try { json = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

let version = null;
function host() {
  version ||= JSON.parse(execFileSync(BIN, ["version", "--json"], { encoding: "utf8" }));
  return version;
}

function hostKey() {
  const v = host();
  return `${v.host.host_class}-macos-${v.macos_build}`;
}

/** Locales this Mac's Vision reads; older macOS rows lack some fixture locales (TODO-004). */
function hostLocales() {
  return new Set(host().locales);
}

/**
 * Compares `actual` with test/golden/<host key>/<name>. Goldens are per host class and macOS build (spec 01).
 * A missing golden is a named skip, or a failure under CATSCAN_REQUIRE_GOLDEN=1 (CI, TODO-004 D2); on a miss or a
 * mismatch the actual text goes to $CATSCAN_GOLDEN_OUT/<host key>/<name> for review.
 */
function golden(t, name, actual) {
  const key = hostKey();
  const file = path.join(ROOT, "test/golden", key, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, actual);
  }
  const want = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  let out = "";
  if (want !== actual && process.env.CATSCAN_GOLDEN_OUT) {
    const o = path.join(process.env.CATSCAN_GOLDEN_OUT, key, name);
    fs.mkdirSync(path.dirname(o), { recursive: true });
    fs.writeFileSync(o, actual);
    out = `; this run's output is in ${o}`;
  }
  if (want === null) {
    const msg = `no golden test/golden/${key}/${name}; run with UPDATE_GOLDEN=1 on this host class and macOS build${out}`;
    if (process.env.CATSCAN_REQUIRE_GOLDEN === "1") assert.fail(msg);
    t.skip(msg);
    return;
  }
  assert.equal(actual, want, `golden test/golden/${key}/${name}${out}`);
}

module.exports = { ROOT, BIN, CLI, MANIFEST, setup, cli, host, hostKey, hostLocales, golden };
