#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-024: installs @catscan/core-js, @catscan/cli, @catscan/mcp and @catscan/playwright the way a user does (npm pack, then npm install
// of the tarballs into an empty project) and runs the installed `catscan` and `catscan-mcp` bins with the Node and npm
// running this script, against the built catscan-core. CI runs it on every Node line engines.node promises.
// Spec 08: it also packs @catscan/cli-darwin-arm64 around that build and runs the bins without CATSCAN_CORE_BINARY,
// so the installed resolution path is the one exercised.
// Needs core/.build/release/catscan-core (npm run build) or $CATSCAN_CORE_BINARY, and the npm registry for the deps.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { ROOT, BIN, setup } = require("../test/helpers.js");
const { TEAM_ID } = require("../packages/core-js/src/install.js");
const PACKAGES = ["cli-darwin-arm64", "core-js", "cli", "mcp", "playwright"];
const SIZE_BUDGET = 10 * 1024 * 1024; // the binary package tarball (spec 08)
const started = Date.now();
let phase = "setup";

if (!fs.existsSync(BIN)) {
  console.error(`pack-smoke: no catscan-core at ${BIN} - try: npm run build`);
  process.exit(1);
}
// A tarball install has no lockfile, so the smoke pins every dependency to package-lock.json through overrides and
// runs no lifecycle script, with only the variables npm and the bins need (TODO-024 D9). The bins start with
// `#!/usr/bin/env node`: the Node under test goes first on PATH, as on a user's machine.
const OURS = new Set(PACKAGES.map((p) => `node_modules/@catscan/${p}`));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8")).packages;
const locked = new Set();
const overrides = {};
for (const [key, entry] of Object.entries(lock)) {
  if (key === "" || /^packages\/[^/]+$/.test(key) || OURS.has(key)) continue;
  // A dev-only entry (root devDependencies such as jest and vitest, TODO-052) never reaches a tarball install.
  if (entry.dev) continue;
  if (!key.startsWith("node_modules/") || entry.link || !entry.version) throw new Error(`pack-smoke: package-lock.json entry ${key} has no override; extend pack-smoke.mjs`);
  const [name, nested, ...deeper] = key.slice("node_modules/".length).split("/node_modules/");
  if (deeper.length) throw new Error(`pack-smoke: package-lock.json entry ${key} is nested two levels deep; extend pack-smoke.mjs`);
  locked.add(`${nested || name}@${entry.version}`);
  if (!nested) overrides[name] = typeof overrides[name] === "object" ? { ...overrides[name], ".": entry.version } : entry.version;
  else overrides[name] = { ".": typeof overrides[name] === "string" ? overrides[name] : overrides[name]?.["."], ...(typeof overrides[name] === "object" ? overrides[name] : {}), [nested]: entry.version };
}
const shots = setup();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pack-"));
const pick = (names) => Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]]));
// No CATSCAN_CORE_BINARY: @catscan/core-js must find the binary package on its own (spec 08).
const env = { ...pick(["HOME", "USER", "LANG", "TMPDIR"]), PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
// The bins run with --throw-deprecation: a Node deprecation on any supported line fails the smoke (npm itself does not).
// TODO-059 D25: the installed doctor never reaches the npm registry from a test.
const binEnv = { ...env, NODE_OPTIONS: "--throw-deprecation", CATSCAN_NO_UPDATE_CHECK: "1" };
const npm = (args, cwd) => execFileSync("npm", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 300_000 });
let app = null;
let failed = false;

// TODO-089: one core-js pack (prepack/postpack in the shared checkout) at a time, see scripts/pack-lock.cjs.
const { packLock } = require("./pack-lock.cjs");

try {
  phase = "npm pack + npm install of the tarballs";
  // The binary package is staged outside the repo with the local build, so a release binary in packages/ is untouched.
  const binPkg = path.join(tmp, "cli-darwin-arm64");
  fs.mkdirSync(path.join(binPkg, "bin"), { recursive: true });
  for (const f of ["package.json", "README.md"]) fs.copyFileSync(path.join(ROOT, "packages/cli-darwin-arm64", f), path.join(binPkg, f));
  fs.copyFileSync(BIN, path.join(binPkg, "bin/catscan-core"));
  fs.chmodSync(path.join(binPkg, "bin/catscan-core"), 0o755);
  const unlock = packLock(ROOT);
  let packed;
  try {
    packed = [
      ...JSON.parse(npm(["pack", "--json", "--pack-destination", tmp, binPkg], ROOT)),
      ...JSON.parse(npm(["pack", "--json", "--pack-destination", tmp, ...PACKAGES.slice(1).flatMap((p) => ["--workspace", `packages/${p}`])], ROOT)),
    ];
    assert.ok(!fs.existsSync(path.join(ROOT, "packages/core-js/schema")), "postpack removed the schema copy");
  } finally { unlock(); }
  const binTarball = packed.find((p) => p.name === "@catscan/cli-darwin-arm64");
  assert.ok(binTarball.size < SIZE_BUDGET, `@catscan/cli-darwin-arm64 tarball is ${binTarball.size} bytes, over the 10 MB budget`);
  assert.deepEqual(binTarball.files.map((f) => f.path).sort(), ["README.md", "bin/catscan-core", "package.json"]);
  app = path.join(tmp, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "catscan-pack-smoke", private: true, overrides }));
  npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline", ...packed.map((p) => path.join(tmp, p.filename))], app);
  const resolved = JSON.parse(fs.readFileSync(path.join(app, "package-lock.json"), "utf8")).packages;
  const unlocked = Object.entries(resolved)
    .filter(([key]) => key.startsWith("node_modules/") && !OURS.has(key))
    .map(([key, entry]) => `${key.split("node_modules/").pop()}@${entry.version}`)
    .filter((id) => !locked.has(id));
  assert.deepEqual(unlocked, [], "every installed dependency is a version package-lock.json holds");
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  for (const p of PACKAGES) {
    const installed = JSON.parse(fs.readFileSync(path.join(app, "node_modules/@catscan", p, "package.json"), "utf8"));
    assert.equal(installed.version, version, `@catscan/${p} is the packed ${version}`);
    assert.ok(!fs.existsSync(path.join(app, "node_modules/@catscan", p, "node_modules/@catscan")), `@catscan/${p} resolved a nested @catscan copy`);
  }
  // All the tarballs sit at the top level, so a dropped inter-package dependency would still resolve here: the
  // packed manifests must declare each one (a user installs only @catscan/cli or @catscan/mcp).
  const manifest = (p) => JSON.parse(fs.readFileSync(path.join(app, "node_modules/@catscan", p, "package.json"), "utf8"));
  assert.equal(manifest("cli").dependencies?.["@catscan/core-js"], version, "@catscan/cli declares @catscan/core-js");
  for (const dep of ["@catscan/cli", "@catscan/core-js"]) {
    assert.equal(manifest("mcp").optionalDependencies?.[dep], version, `@catscan/mcp declares ${dep}`);
  }
  // Spec 08 D2, D6: only the binary package carries os and cpu; core-js holds it as an exact optional dependency.
  assert.equal(manifest("core-js").optionalDependencies?.["@catscan/cli-darwin-arm64"], version, "@catscan/core-js declares the binary package");
  // Spec 13 D11, D12: the matchers pin core-js exactly and take the user's own Playwright as a peer.
  assert.equal(manifest("playwright").dependencies?.["@catscan/core-js"], version, "@catscan/playwright declares @catscan/core-js");
  assert.equal(manifest("playwright").peerDependencies?.["@playwright/test"], ">=1.50.0 <2", "@catscan/playwright peer range");
  assert.ok(fs.existsSync(path.join(app, "node_modules/@catscan/playwright/index.d.ts")), "@catscan/playwright ships its types");
  for (const p of ["cli", "core-js", "mcp", "playwright"]) assert.ok(!manifest(p).os && !manifest(p).cpu, `@catscan/${p} has no os or cpu`);
  assert.deepEqual([manifest("cli-darwin-arm64").os, manifest("cli-darwin-arm64").cpu], [["darwin"], ["arm64"]]);

  phase = "installed catscan check";
  const bin = (name) => path.join(app, "node_modules/.bin", name);
  // A bounded run: a hung binary must not hold the one self-hosted runner until the job timeout.
  const check = (text, status, verdict) => {
    const r = spawnSync(bin("catscan"), ["check", "02-en-small.png", "--present", text, "--json"], { cwd: shots, env: binEnv, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, status, `catscan check --present "${text}": exit ${r.status}${r.error ? ` (${r.error.message})` : ""}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout.split("\n")[0]).checks[0].verdict, verdict, `catscan check --present "${text}" stdout: ${r.stdout.slice(0, 500)}`);
  };
  check("GAME OVER", 0, "pass");
  check("NOT ON SCREEN", 1, "fail");

  phase = "installed catscan doctor";
  // The local build is ad-hoc signed, so the signature check is the one expected failure (exit 1) and doctor does not
  // start it; the check and MCP phases run the installed binary. A Developer ID build must pass every check.
  const d = spawnSync(bin("catscan"), ["doctor", "--json"], { cwd: shots, env: binEnv, encoding: "utf8", timeout: 120_000 });
  const doc = JSON.parse(d.stdout);
  assert.equal(doc.binary?.source, "package", `doctor --json: ${d.stdout.slice(0, 1000)}`);
  assert.equal(fs.realpathSync(doc.binary.path), fs.realpathSync(path.join(app, "node_modules/@catscan/cli-darwin-arm64/bin/catscan-core")));
  const failing = doc.checks.filter((c) => !c.ok).map((c) => c.name);
  const signed = doc.binary.signature?.team_id === TEAM_ID;
  assert.deepEqual(failing, signed ? [] : ["signature"], `doctor checks: ${JSON.stringify(doc.checks)}`);
  assert.equal(d.status, signed ? 0 : 1);

  phase = "installed behavior-changes.json";
  // TODO-059 D5: every installed core-js carries the behavior-change history the upgrade skill reads offline.
  const changes = JSON.parse(fs.readFileSync(path.join(app, "node_modules/@catscan/core-js/behavior-changes.json"), "utf8"));
  assert.equal(changes.schema, 1, "behavior-changes.json schema");
  assert.equal(changes.releases[0]?.version, version, "behavior-changes.json starts at the packed version");

  phase = "installed catscan results validate";
  // The schemas reach the tarball only through the core-js prepack copy (spec 27 D24).
  const resultsFile = path.join(tmp, "catscan-results.json");
  const w = spawnSync(bin("catscan"), ["check", "02-en-small.png", "--present", "GAME OVER", "--results", resultsFile], { cwd: shots, env: binEnv, encoding: "utf8", timeout: 120_000 });
  assert.equal(w.status, 0, `catscan check --results: exit ${w.status}: ${w.stderr}`);
  const v = spawnSync(bin("catscan"), ["results", "validate", resultsFile], { cwd: shots, env: binEnv, encoding: "utf8", timeout: 60_000 });
  assert.equal(v.status, 0, `catscan results validate: exit ${v.status}: ${v.stderr}`);

  phase = "installed @catscan/playwright loads";
  // The user's Playwright resolves as the peer; the pre-extended expect carries the three matchers (spec 13 D17).
  const pw = spawnSync(process.execPath, ["--throw-deprecation", "-e", "const { expect } = require('@catscan/playwright'); const m = expect({}); for (const k of ['toShowText', 'toHaveNoTruncation', 'toHaveNoUntranslated', 'toHaveText']) if (typeof m[k] !== 'function') throw new Error(k);"], { cwd: app, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(pw.status, 0, `require('@catscan/playwright'): ${pw.stderr}`);

  phase = "installed catscan-mcp over stdio";
  // The client comes from the installed @catscan/mcp's own SDK copy: what the user's install resolved.
  const appRequire = createRequire(path.join(app, "package.json"));
  const { Client } = appRequire("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = appRequire("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "pack-smoke", version: "1" });
  await client.connect(new StdioClientTransport({ command: bin("catscan-mcp"), cwd: shots, env: binEnv, stderr: "inherit" }));
  try {
    assert.equal((await client.listTools({}, { timeout: 30_000 })).tools.length, 9);
    const r = await client.callTool({ name: "check_text", arguments: { path: "02-en-small.png", present: ["GAME OVER"] } }, undefined, { timeout: 120_000 });
    assert.equal(JSON.parse(r.content[0].text).verdict, "pass", `check_text reply: ${r.content[0].text.slice(0, 500)}`);
  } finally { await client.close().catch(() => {}); }

  console.log(`pack-smoke: ok on node ${process.version}, npm ${npm(["--version"], tmp).trim()} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
} catch (e) {
  failed = true;
  let npmVersion = "unknown";
  try { npmVersion = npm(["--version"], ROOT).trim(); } catch {}
  // The resolved tree names the dependency versions behind a failure; the install stays on disk for a look.
  if (app) try { console.error(npm(["ls", "--all"], app)); } catch (ls) { console.error(ls.stdout || ""); }
  console.error(`pack-smoke: failed at ${phase} on node ${process.version}, npm ${npmVersion}; install kept at ${tmp} - rerun: npm run test:packages with this Node first on PATH (docs/gotchas/ci.md)`);
  throw e;
} finally {
  if (!failed) fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(shots, { recursive: true, force: true });
}
