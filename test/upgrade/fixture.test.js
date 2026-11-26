// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-059 T3: the catscan-upgrade fixture. The current packages and a 0.1.0 copy are packed and served from a local
// fake registry (no public registry, nothing published); the fixture installs 0.1.0, then the skill's scripted steps
// move every surface to the target. macOS + the built binary (npm run build).
// Value: protects=the skill's plan, once applied, leaves no catscan surface behind and a working install;
// fails_when=a surface stays at 0.1.0, doctor fails binary or version after the move, the rule installer is not
// idempotent, the baseline changes without a yes, a failing package-manager step keeps a change, or an unknown
// version is not refused; why_new=first end-to-end run of the upgrade path; seam=a local registry stands in for npm;
// no_claim=the agent follows SKILL.md, or the public registry serves these versions.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");
const { ROOT, BIN } = require("../helpers.js");
const { packLock } = require("../../scripts/pack-lock.cjs");

const FIXTURE = path.join(ROOT, "examples/upgrade-fixture/project");
const SCRIPTS = path.join(ROOT, "plugins/catscan/skills/catscan-upgrade/scripts");
const AGENT_RULES = path.join(ROOT, "plugins/catscan/skills/test-speedup/scripts/agent-rules.mjs");
const TARGET = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
const OLD = "0.1.0";
const OURS = ["cli-darwin-arm64", "core-js", "cli"];
const THIRD = ["ajv", "yaml", "fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string"];
const exec = promisify(execFile);
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, env: { ...process.env, ...gitEnv }, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const node = (file, args, opts = {}) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8", timeout: 240000, ...opts });
// The registry runs in this process, so anything that reaches it must not block the event loop.
const nodeAsync = (file, args, env) => exec(process.execPath, [file, ...args], { env, timeout: 240000 }).then((r) => ({ status: 0, ...r }), (e) => ({ status: e.code, stdout: e.stdout, stderr: e.stderr }));
const json = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

// Repack a tarball under another version: package.json version and its @catscan pins.
function restamp(tgz, version, dir) {
  const work = fs.mkdtempSync(path.join(dir, "restamp-"));
  assert.equal(spawnSync("tar", ["-xzf", tgz, "-C", work]).status, 0);
  const file = path.join(work, "package/package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = version;
  for (const field of ["dependencies", "optionalDependencies"]) for (const k of Object.keys(pkg[field] || {})) if (k.startsWith("@catscan/")) pkg[field][k] = version;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  const out = path.join(dir, `${pkg.name.replace("@", "").replace("/", "-")}-${version}.tgz`);
  assert.equal(spawnSync("tar", ["-czf", out, "-C", work, "package"]).status, 0);
  return out;
}

async function registry(dir) {
  const npmEnv = { ...process.env, npm_config_cache: path.join(dir, "cache"), npm_config_update_notifier: "false" };
  const pack = (args, cwd) => JSON.parse(spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir, ...args], { cwd, env: npmEnv, encoding: "utf8" }).stdout);
  const tarballs = {}; // name -> { version -> file }
  const add = (name, version, file) => { (tarballs[name] ||= {})[version] = file; };
  // The binary package around the local build, as the packages lane packs it.
  const binPkg = path.join(dir, "bin-pkg");
  fs.mkdirSync(path.join(binPkg, "bin"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "packages/cli-darwin-arm64/package.json"), path.join(binPkg, "package.json"));
  fs.copyFileSync(BIN, path.join(binPkg, "bin/catscan-core"));
  fs.chmodSync(path.join(binPkg, "bin/catscan-core"), 0o755);
  // TODO-089: core-js packs with its prepack/postpack in the shared checkout, so under the lane's pack lock.
  const unlock = packLock(ROOT);
  let packed;
  try {
    packed = [...pack([binPkg], ROOT),
      ...JSON.parse(spawnSync("npm", ["pack", "--json", "--pack-destination", dir, "--workspace", "packages/core-js", "--workspace", "packages/cli"], { cwd: ROOT, env: npmEnv, encoding: "utf8" }).stdout)];
  } finally { unlock(); }
  for (const p of packed) {
    const file = path.join(dir, p.filename);
    add(p.name, p.version, file);
    add(p.name, OLD, restamp(file, OLD, dir));
  }
  for (const name of THIRD) {
    const [p] = pack([path.join(ROOT, "node_modules", name)], ROOT);
    add(p.name, p.version, path.join(dir, p.filename));
  }
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    const base = `http://127.0.0.1:${server.address().port}`;
    const tgz = url.match(/^\/(.+)\/-\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/);
    if (tgz && tarballs[tgz[1]]?.[tgz[2]]) { res.writeHead(200); res.end(fs.readFileSync(tarballs[tgz[1]][tgz[2]])); return; }
    const name = url.slice(1);
    if (!tarballs[name]) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not found"}'); return; }
    const versions = {};
    for (const [version, file] of Object.entries(tarballs[name])) {
      const bytes = fs.readFileSync(file);
      const manifest = JSON.parse(spawnSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }).stdout);
      versions[version] = { ...manifest, dist: { tarball: `${base}/${name}/-/${name.split("/").pop()}-${version}.tgz`,
        shasum: crypto.createHash("sha1").update(bytes).digest("hex"), integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` } };
    }
    const latest = Object.keys(versions).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).pop();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name, "dist-tags": { latest }, versions }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

test("catscan-upgrade fixture: the plan, applied, moves every surface and leaves a working install", { timeout: 600000, skip: !fs.existsSync(BIN) && "no catscan-core build" }, async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-fixture-")));
  const { server, url } = await registry(dir);
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const userconfig = path.join(dir, "npmrc");
  fs.writeFileSync(userconfig, `registry=${url}\n`);
  const env = { ...process.env, ...gitEnv, npm_config_userconfig: userconfig, npm_config_registry: url, npm_config_cache: path.join(dir, "cache"),
    npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false", CATSCAN_NO_UPDATE_CHECK: "1" };
  const sh = (cmd, cwd) => exec("sh", ["-c", cmd], { cwd, env, timeout: 240000 });

  // The project at 0.1.0: installed from the fake registry and committed.
  const app = path.join(dir, "app");
  fs.cpSync(FIXTURE, app, { recursive: true });
  fs.writeFileSync(path.join(app, ".gitignore"), "node_modules/\n");
  await sh("npm install", app);
  git(app, "init", "-q", "-b", "main");
  git(app, "add", "-A");
  git(app, "commit", "-qm", "fixture at 0.1.0");
  const baseline = fs.readFileSync(path.join(app, "ci/baseline.json"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);

  // Step 1: the plan.
  const plan = json(node(path.join(SCRIPTS, "find-surfaces.mjs"), [app, "--to", TARGET], { env: { ...env, HOME: home } }));
  assert.equal(plan.dirty, false);
  assert.deepEqual([...new Set(plan.surfaces.map((s) => s.surface))].sort(), ["S1", "S2", "S3", "S5", "S6"]);
  assert.ok(plan.surfaces.filter((s) => s.current).every((s) => s.current === OLD), "every pinned surface starts at 0.1.0");
  assert.deepEqual(plan.commands.map((c) => [c.cwd, c.command]), [[".", `npm install --save-exact --save-dev @catscan/cli@${TARGET}`]]);
  assert.deepEqual(plan.invocations.map((i) => i.file).sort(), [".github/workflows/ui.yml", "package.json"]);
  const range = json(await nodeAsync(path.join(SCRIPTS, "behavior-range.mjs"), ["--from", OLD, "--to", TARGET, "--registry", url], env));
  assert.equal(range.read_from, TARGET);
  assert.ok(range.changes.length > 0 && range.changes.every((c) => c.version !== OLD), "the packed target's behavior changes after 0.1.0");

  // An unknown version stops with nothing changed.
  const unknown = await nodeAsync(path.join(SCRIPTS, "behavior-range.mjs"), ["--from", OLD, "--to", "9.9.9", "--registry", url], env);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^behavior-range: pack-failed: /);
  // A failing package-manager step: the restore line leaves the tree as committed.
  await assert.rejects(sh("npm install --save-exact --save-dev @catscan/cli@9.9.9", app));
  git(app, "restore", "--source=HEAD", "--", "package.json", "package-lock.json");
  assert.equal(git(app, "status", "--porcelain"), "");

  // Step 3: apply in the fixed order S1, S2, S3, S5, then commit.
  for (const c of plan.commands) await sh(c.command, path.join(app, c.cwd));
  for (const e of plan.edits.filter((x) => x.via !== "command")) {
    const f = path.join(app, e.file);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\n").map((l, i) => (i + 1 === e.line ? l.replace(e.from, e.to) : l)).join("\n"));
  }
  const rules = () => node(AGENT_RULES, ["--root", app], { env });
  const first = rules();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /docs\/testing\.md: testing rules section updated/);
  // A local build is ad-hoc signed: doctor exits 1 on `signature` alone; the upgrade's done check is binary and version.
  const d = spawnSync(path.join(app, "node_modules/.bin/catscan"), ["doctor", "--json"], { cwd: app, env, encoding: "utf8", timeout: 120000 });
  const doctor = JSON.parse(d.stdout);
  const failing = doctor.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(!failing.includes("binary") && !failing.includes("version"), `doctor checks: ${JSON.stringify(doctor.checks)}`);
  assert.equal(doctor.catscan, TARGET);
  git(app, "add", "-A");
  git(app, "commit", "-qm", `chore: move catscan to ${TARGET}`);

  // Done check: every project surface at the target, no skew; the rule block written once; the baseline untouched.
  const after = json(node(path.join(SCRIPTS, "find-surfaces.mjs"), [app, "--to", TARGET], { env: { ...env, HOME: home } }));
  assert.equal(after.skew, null);
  assert.deepEqual(after.edits, []);
  assert.ok(after.surfaces.filter((s) => s.current).every((s) => s.current === TARGET), JSON.stringify(after.surfaces));
  assert.doesNotMatch(fs.readFileSync(path.join(app, "docs/testing.md"), "utf8"), /old rule text/);
  const again = rules();
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /added|updated/);
  assert.equal(git(app, "status", "--porcelain"), "");
  assert.deepEqual(fs.readFileSync(path.join(app, "ci/baseline.json")), baseline);
});
