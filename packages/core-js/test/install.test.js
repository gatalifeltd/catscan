// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 08: binary resolution, install diagnostics and the codesign/spctl parsers, on a fake node_modules tree.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const install = require("../src/install");
const { nodeTooOld, preflight } = require("../../cli/bin/preflight");

const V = "1.2.3";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-install-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** An installed tree: <root>/node_modules/@catscan/core-js/src plus, optionally, the binary package. */
function tree(name, { binVersion = V, withBin = true, withPackage = true } = {}) {
  const root = path.join(tmp, name);
  const dir = path.join(root, "node_modules/@catscan/core-js/src");
  fs.mkdirSync(dir, { recursive: true });
  if (withPackage) {
    const pkg = path.join(root, "node_modules/@catscan/cli-darwin-arm64");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@catscan/cli-darwin-arm64", version: binVersion }));
    if (withBin) fs.writeFileSync(path.join(pkg, "bin/catscan-core"), "", { mode: 0o755 });
  }
  return dir;
}

const mac = { platform: "darwin", arch: "arm64", release: "26.2.0", translated: () => 0, version: V, env: {} };
const resolve = (dir, extra = {}) => install.resolveBinary({ ...mac, dir, ...extra });
const throwsCode = (fn, code, hint) => assert.throws(fn, (e) => {
  assert.equal(e.code, code, e.message);
  if (hint) assert.match(e.hint, hint);
  return true;
});

test("binaryPath: the installed binary package at the same version is found as source package", () => {
  const dir = tree("found");
  const r = resolve(dir);
  assert.equal(r.source, "package");
  assert.equal(r.version, V);
  assert.equal(fs.realpathSync(r.path), fs.realpathSync(path.join(dir, "../../cli-darwin-arm64/bin/catscan-core")));
});

test("binaryPath: a different binary package version is refused with the exact install command", () => {
  throwsCode(() => resolve(tree("mismatch", { binVersion: "1.2.4" })), "binary-version-mismatch", /^npm install @catscan\/cli-darwin-arm64@1\.2\.3$/);
});

test("binaryPath: a missing binary package names the cause and never the swift build hint", () => {
  const dir = tree("missing", { withPackage: false });
  throwsCode(() => resolve(dir), "binary-not-found", /^npm install @catscan\/cli-darwin-arm64@1\.2\.3$/);
  // x64 Node under Rosetta: the package manager skipped the arm64 package.
  throwsCode(() => resolve(dir, { arch: "x64", translated: () => 1 }), "binary-not-found", /install an arm64 Node/);
  for (const extra of [{}, { arch: "x64", translated: () => 1 }]) {
    try { resolve(dir, extra); } catch (e) { assert.doesNotMatch(`${e.message} ${e.hint}`, /swift build/); }
  }
  // A binary package without its binary is a broken install too.
  throwsCode(() => resolve(tree("nobin", { withBin: false })), "binary-not-found", /^npm install /);
});

test("binaryPath: the install hint follows npm_config_user_agent", () => {
  const dir = tree("agents", { withPackage: false });
  const cases = [
    ["pnpm/10.0.0 npm/? node/v26.13.0 darwin arm64", "pnpm add"],
    ["yarn/4.9.0 npm/? node/v26.13.0 darwin arm64", "yarn add"],
    ["bun/1.3.0 npm/? node/v26.13.0 darwin arm64", "bun add"],
    ["npm/11.6.0 node/v26.13.0 darwin arm64 workspaces/false", "npm install"],
    [undefined, "npm install"],
  ];
  for (const [ua, cmd] of cases) {
    throwsCode(() => resolve(dir, { env: ua ? { npm_config_user_agent: ua } : {} }), "binary-not-found", new RegExp(`^${cmd} @catscan/cli-darwin-arm64@1\\.2\\.3$`));
  }
});

test("binaryPath: a global, npx or dlx install gets a command that reaches its own tree (review)", () => {
  const tree = (rel) => { const d = path.join(tmp, rel, "node_modules/@catscan/core-js/src"); fs.mkdirSync(d, { recursive: true }); return d; };
  const hint = (rel, env) => { try { resolve(tree(rel), env ? { env } : {}); } catch (e) { return e.hint; } return null; };
  // Never a printed rm: npm's own cache command with the 16-hex key.
  assert.equal(hint("npm-cache/_npx/0123456789abcdef"), "npm cache npx rm 0123456789abcdef (on npm 10: npx -y npm@11 cache npx rm 0123456789abcdef), then rerun your npx command with --include=optional");
  // A project folder that happens to be called _npx or global-tools is a project.
  assert.equal(hint("work/_npx/myapp"), "npm install @catscan/cli-darwin-arm64@1.2.3");
  assert.equal(hint("code/global-tools", { npm_config_user_agent: "pnpm/10.0.0" }), "pnpm add @catscan/cli-darwin-arm64@1.2.3");
  assert.equal(hint("prefix/lib/node_modules/@catscan/cli"), "npm install -g --include=optional @catscan/cli@1.2.3");
  assert.equal(hint("prefix/lib/node_modules/@catscan/mcp"), "npm install -g --include=optional @catscan/mcp@1.2.3");
  assert.equal(hint("prefix/lib/node_modules/some-tool"), "npm install -g --include=optional some-tool");
  // A project that is itself a folder named lib is a project, not a global prefix.
  tree("proj/lib");
  fs.writeFileSync(path.join(tmp, "proj/lib/package.json"), "{}");
  assert.equal(hint("proj/lib"), "npm install @catscan/cli-darwin-arm64@1.2.3");
  assert.equal(hint("Caches/pnpm/dlx/f00d", { npm_config_user_agent: "pnpm/10.0.0" }), "reinstall the catscan package that runs here with optional dependencies included; @catscan/cli-darwin-arm64@1.2.3 is missing from its install");
});

test("binaryPath: CATSCAN_CORE_BINARY wins and is reported as env", () => {
  const dir = tree("env");
  const stub = path.join(tmp, "stub-core");
  fs.writeFileSync(stub, "");
  assert.deepEqual(resolve(dir, { env: { CATSCAN_CORE_BINARY: stub } }), { path: stub, source: "env", version: null });
  throwsCode(() => resolve(dir, { env: { CATSCAN_CORE_BINARY: path.join(tmp, "nope") } }), "binary-not-found", /CATSCAN_CORE_BINARY/);
});

test("binaryPath: the repo build is used only outside node_modules", () => {
  // Repo layout: <repo>/packages/core-js/src and <repo>/core/.build/release/catscan-core.
  const repo = path.join(tmp, "repo");
  const dir = path.join(repo, "packages/core-js/src");
  fs.mkdirSync(dir, { recursive: true });
  const build = path.join(repo, "core/.build/release/catscan-core");
  const noPackage = () => { throw new Error("not found"); };
  throwsCode(() => resolve(dir, { resolve: noPackage }), "binary-not-found", /swift build/);
  fs.mkdirSync(path.dirname(build), { recursive: true });
  fs.writeFileSync(build, "");
  assert.deepEqual(resolve(dir, { resolve: noPackage }), { path: build, source: "build", version: null });
  // Review fix: a stale release binary left in the linked workspace package never shadows the checkout's build.
  const ws = path.join(repo, "packages/cli-darwin-arm64");
  fs.mkdirSync(path.join(ws, "bin"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ version: V }));
  fs.writeFileSync(path.join(ws, "bin/catscan-core"), "");
  assert.deepEqual(resolve(dir, { resolve: () => path.join(ws, "package.json") }), { path: build, source: "build", version: null });
  fs.rmSync(build);
  throwsCode(() => resolve(dir, { resolve: () => path.join(ws, "package.json") }), "binary-not-found", /swift build/);
  // Under node_modules the same build path is never looked at.
  const inst = tree("nofallback", { withPackage: false });
  const instBuild = path.resolve(inst, "../../../core/.build/release/catscan-core");
  fs.mkdirSync(path.dirname(instBuild), { recursive: true });
  fs.writeFileSync(instBuild, "");
  throwsCode(() => resolve(inst), "binary-not-found", /^npm install/);
});

test("binaryPath: a catscan-core on PATH or in the working directory is ignored", () => {
  const dir = tree("pathcwd", { withPackage: false });
  const elsewhere = fs.mkdtempSync(path.join(tmp, "cwd-"));
  fs.writeFileSync(path.join(elsewhere, "catscan-core"), "", { mode: 0o755 });
  const r = spawnSync(process.execPath, ["-e", `
    const i = require(${JSON.stringify(path.resolve(__dirname, "../src/install.js"))});
    try { i.resolveBinary({ platform: "darwin", arch: "arm64", release: "26.2.0", translated: () => 0, version: "1.2.3", env: {}, dir: ${JSON.stringify(dir)} }); console.log("found"); }
    catch (e) { console.log(e.code); }`], { cwd: elsewhere, encoding: "utf8", env: { ...process.env, PATH: `${elsewhere}${path.delimiter}${process.env.PATH}` } });
  assert.equal(r.stdout.trim(), "binary-not-found", r.stderr);
});

test("binaryPath: unsupported-platform and unsupported-os before any lookup", () => {
  const dir = tree("platform");
  throwsCode(() => resolve(dir, { platform: "linux", arch: "x64" }), "unsupported-platform");
  assert.throws(() => resolve(dir, { platform: "linux", arch: "x64" }), /this is linux x64/);
  // An Intel Mac: x64 and not translated.
  throwsCode(() => resolve(dir, { arch: "x64", translated: () => 0 }), "unsupported-platform");
  throwsCode(() => resolve(dir, { release: "23.6.0" }), "unsupported-os");
  assert.throws(() => resolve(dir, { release: "23.6.0" }), /macOS 15 or newer; this is Darwin 23\.6\.0 \(macOS 14\)/);
  assert.equal(resolve(dir, { release: "24.0.0" }).source, "package");
});

test("preflight: unsupported-node below Node 22", () => {
  assert.equal(nodeTooOld("22.0.0"), null);
  assert.equal(nodeTooOld("26.13.0"), null);
  assert.equal(nodeTooOld("20.19.1"), "catscan: unsupported-node: Node 20.19.1 is too old; catscan needs Node 22 or newer - try: install Node 22 or newer from https://nodejs.org");
  assert.equal(install.nodeProblem("18.0.0").code, "unsupported-node");
  assert.equal(preflight(["check", "a.png"], "22.0.0", "arm64", V), null);
  assert.deepEqual(preflight(["check", "a.png"], "20.19.1", "arm64", V), { code: 5, stdout: "", stderr: `${nodeTooOld("20.19.1")}\n` });
  // Review fix: doctor keeps its 0-or-1 contract and one JSON object on an old Node (D13).
  const text = preflight(["doctor"], "20.19.1", "arm64", V);
  assert.deepEqual([text.code, text.stdout], [1, "FAIL node: Node 20.19.1 is too old; catscan needs Node 22 or newer - try: install Node 22 or newer from https://nodejs.org\n"]);
  assert.equal(preflight(["--format", "json", "check", "a.png"], "20.19.1", "arm64", V).code, 5);
  assert.deepEqual(require("../../cli/bin/preflight").COMMANDS, require("../src/args").COMMANDS);
  const { OPTIONS } = require("../src/args");
  assert.deepEqual([...require("../../cli/bin/preflight").VALUE_OPTIONS].sort(), Object.keys(OPTIONS).filter((k) => OPTIONS[k].value).sort());
  assert.equal(preflight(["--present", "doctor", "check", "a.png"], "20.19.1", "arm64", V).code, 5);
  // The parser's grammar: last --format wins, nothing after -- is an option, a value option may precede the command.
  assert.match(preflight(["doctor", "--", "--json"], "20.19.1", "arm64", V).stdout, /^FAIL node: /);
  assert.match(preflight(["doctor", "--format", "json", "--format", "text"], "20.19.1", "arm64", V).stdout, /^FAIL node: /);
  for (const argv of [["doctor", "--json"], ["doctor", "--format", "json"], ["doctor", "--format=json"], ["--json", "doctor"], ["--format", "json", "doctor"], ["--locale", "el", "doctor", "--json"], ["doctor", "--format", "text", "--format", "json"]]) {
    const j = preflight(argv, "20.19.1", "arm64", V);
    assert.equal(j.code, 1);
    const o = JSON.parse(j.stdout);
    const validate = new (require("ajv"))({ strict: false }).compile(require("../../../core/schema/doctor.schema.json"));
    assert.ok(validate(o), JSON.stringify(validate.errors));
    assert.deepEqual([o.ok, o.catscan, o.checks.map((c) => [c.name, c.ok])], [false, V, [["node", false]]]);
  }
  assert.equal(install.nodeProblem("22.1.0"), null);
});

test("codesign and spctl parsers on recorded outputs", () => {
  // codesign -dv --verbose=2 writes to stderr. The ad-hoc output and the bare spctl `rejected` are recorded from a
  // local `swift build` on macOS 26.2; the Developer ID lines follow the spec 08 D7 check of 2026-11-09.
  const signed = "Executable=/x/catscan-core\nIdentifier=catscan-core\nFormat=Mach-O thin (arm64)\nAuthority=Developer ID Application: GATALIFE LTD (JK3T6SMS5W)\nTimestamp=9 Nov 2026\nTeamIdentifier=JK3T6SMS5W\nRuntime Version=26.0.0\n";
  const adhoc = "Executable=/x/catscan-core\nIdentifier=catscan-core\nFormat=Mach-O thin (arm64)\nCodeDirectory v=20400 size=9701 flags=0x20002(adhoc,linker-signed) hashes=300+0 location=embedded\nSignature=adhoc\nInfo.plist=not bound\nTeamIdentifier=not set\nSealed Resources=none\nInternal requirements=none\n";
  assert.deepEqual(install.parseCodesign(0, signed), { valid: true, team_id: "JK3T6SMS5W" });
  assert.deepEqual(install.parseCodesign(0, adhoc), { valid: true, team_id: null });
  assert.deepEqual(install.parseCodesign(1, ""), { valid: false, team_id: null });
  assert.equal(install.parseSpctl("/x/catscan-core: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: GATALIFE LTD (JK3T6SMS5W)\n"), true);
  assert.equal(install.parseSpctl("/x/catscan-core: rejected\nsource=Unnotarized Developer ID\norigin=Developer ID Application: GATALIFE LTD (JK3T6SMS5W)\n"), false);
  assert.equal(install.parseSpctl("/x/catscan-core: rejected\nsource=no usable signature\n"), false);
  assert.equal(install.parseSpctl("core/.build/release/catscan-core: rejected\n"), false);
  assert.equal(install.parseSpctl("/x/catscan-core: rejected\nsource=Notarized Developer ID\n"), false);
  assert.equal(install.parseSpctl(""), null);
  assert.equal(install.parseSpctl("spctl: an error occurred\n"), null);
});
