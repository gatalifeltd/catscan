#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 08 release step 6: the published packages from the registry, in an empty project with an empty npm cache.
//   node scripts/release-smoke.mjs <version>
// Runs `npx @catscan/cli@<version> doctor --json` and `check` on a synthetic image with npm and with pnpm, starts
// `@catscan/mcp` and lists its tools, and, when Tesseract is installed, one --fallback tesseract read under the
// hardened runtime. Never publishes anything.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { ROOT, setup } = require("../test/helpers.js");
const { TEAM_ID } = require("../packages/core-js/src/install.js");
const PNPM = "pnpm@12.18.0"; // spec 08 step 6
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: release-smoke.mjs <X.Y.Z>");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-release-smoke-"));
const app = path.join(tmp, "app");
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "catscan-release-smoke", private: true }));
// An empty cache for npm and pnpm, and no CATSCAN_CORE_BINARY: only the registry packages can answer.
const env = { ...process.env, npm_config_cache: path.join(tmp, "npm-cache"), npm_config_store_dir: path.join(tmp, "pnpm-store"), npm_config_update_notifier: "false" };
delete env.CATSCAN_CORE_BINARY;
const shots = setup();
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: app, env, encoding: "utf8", timeout: 600_000, ...opts });
const json = (r, what) => {
  try { return JSON.parse(r.stdout.split("\n").find((l) => l.startsWith("{"))); } catch { throw new Error(`${what}: exit ${r.status}, no JSON on stdout: ${r.stdout}\n${r.stderr}`); }
};
let phase = "";

try {
  for (const [pm, runner] of [["npm", ["npx", "--yes", `@catscan/cli@${version}`]], ["pnpm", ["npx", "--yes", PNPM, "dlx", `@catscan/cli@${version}`]]]) {
    phase = `${pm}: doctor --json`;
    const d = run(runner[0], [...runner.slice(1), "doctor", "--json"]);
    const doc = json(d, phase);
    assert.equal(d.status, 0, `${phase}: ${JSON.stringify(doc.checks)}`);
    assert.equal(doc.ok, true);
    assert.equal(doc.catscan, version);
    assert.equal(doc.binary.source, "package");
    assert.equal(doc.binary.signature.team_id, TEAM_ID);
    assert.equal(doc.binary.signature.notarized, true, `${phase}: spctl did not report Notarized Developer ID`);
    assert.equal(doc.self_test.pass, true);

    phase = `${pm}: check`;
    const c = run(runner[0], [...runner.slice(1), "check", path.join(shots, "02-en-small.png"), "--present", "GAME OVER", "--json"]);
    assert.equal(c.status, 0, `${phase}: ${c.stdout}${c.stderr}`);
    assert.equal(json(c, phase).verdict, "pass");
    console.log(`release-smoke: ${pm} ok`);
  }

  phase = "@catscan/mcp lists its tools";
  execFileSync("npm", ["install", "--no-audit", "--no-fund", `@catscan/mcp@${version}`], { cwd: app, env, stdio: ["ignore", "ignore", "inherit"], timeout: 600_000 });
  const appRequire = createRequire(path.join(app, "package.json"));
  const { Client } = appRequire("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = appRequire("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "release-smoke", version: "1" });
  await client.connect(new StdioClientTransport({ command: path.join(app, "node_modules/.bin/catscan-mcp"), cwd: shots, env, stderr: "inherit" }));
  try {
    const tools = (await client.listTools({}, { timeout: 30_000 })).tools;
    assert.ok(tools.length > 0, "catscan-mcp lists no tools");
    console.log(`release-smoke: mcp ok (${tools.length} tools)`);
  } finally { await client.close().catch(() => {}); }

  phase = "Tesseract fallback under the hardened runtime";
  const tess = spawnSync("sh", ["-c", "command -v tesseract"], { encoding: "utf8" });
  if (tess.status === 0) {
    const fallbackDir = path.join(tmp, "fallback");
    fs.mkdirSync(fallbackDir);
    const shot = require("../bench/fallback/synthetic.json").filter((s) => s.name === "el-1.png");
    fs.writeFileSync(path.join(fallbackDir, "shots.json"), JSON.stringify(shot));
    execFileSync(path.join(ROOT, ".build/synth"), [path.join(fallbackDir, "shots.json"), fallbackDir]);
    const r = run(path.join(app, "node_modules/.bin/catscan"), ["read", path.join(fallbackDir, "el-1.png"), "--locale", "el", "--fallback", "tesseract", "--json"]);
    const env1 = json(r, phase);
    assert.equal(r.status, 0, `${phase}: ${r.stdout}${r.stderr}`);
    assert.match(env1.engine, /^tesseract-/);
    console.log(`release-smoke: tesseract ok (${env1.engine})`);
  } else {
    console.log("release-smoke: tesseract not installed, fallback smoke skipped");
  }
  console.log(`release-smoke: ok for ${version}`);
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error(`release-smoke: failed at ${phase}; project kept at ${tmp}`);
  throw e;
} finally {
  fs.rmSync(shots, { recursive: true, force: true });
}
