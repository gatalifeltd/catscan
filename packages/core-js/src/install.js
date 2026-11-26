// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Where catscan-core comes from and whether this machine can run it (spec 08). Every input is injectable, so the
// unit tests drive each diagnostic without a second machine.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const BINARY_PACKAGE = "@catscan/cli-darwin-arm64";
const TEAM_ID = "JK3T6SMS5W"; // Developer ID Application: GATALIFE LTD (spec 08 D7)
const MIN_NODE = 22; // engines.node (spec 08 D14)
const MIN_DARWIN = 24; // macOS 15, the spec 00 minimum
const OWN_VERSION = require("../package.json").version;

class CatscanError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** 1 when this process runs under Rosetta, 0 when native, null when unknown. */
function rosetta() {
  try { return Number(execFileSync("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch { return null; }
}

function defaults(o = {}) {
  return {
    env: o.env || process.env,
    platform: o.platform || process.platform,
    arch: o.arch || process.arch,
    release: o.release || os.release(),
    translated: o.translated || rosetta,
    nodeVersion: o.nodeVersion || process.versions.node,
    dir: o.dir || __dirname,
    version: o.version || OWN_VERSION,
    resolve: o.resolve || ((id, from) => require.resolve(id, { paths: [from] })),
    exists: o.exists || fs.existsSync,
    readJSON: o.readJSON || ((f) => JSON.parse(fs.readFileSync(f, "utf8"))),
  };
}

/** True when this @catscan/core-js is an installed package, not the repo checkout (spec 08 D5). */
function installed(dir) {
  return path.resolve(dir).split(path.sep).includes("node_modules");
}

/**
 * The command that adds the binary package to the tree catscan runs from (D14). A project gets the add command of
 * the package manager in npm_config_user_agent (npm when unknown). An npx cache or a global install cannot resolve a
 * package added to the working directory, so those get a command that repairs their own tree (review).
 */
function installCommand(env, spec, dir = null, exists = fs.existsSync) {
  const version = spec.slice(spec.lastIndexOf("@") + 1);
  const where = dir ? path.resolve(dir).split(path.sep).join("/") : "";
  // npm's own cache command, never a printed rm: the key is the 16-hex folder name npm gives each npx install.
  const npx = /\/_npx\/([0-9a-f]{16})\/node_modules\//.exec(where);
  // `npm cache npx` arrived in npm 11; Node 22 ships npm 10, which runs it through npx (review).
  if (npx) return `npm cache npx rm ${npx[1]} (on npm 10: npx -y npm@11 cache npx rm ${npx[1]}), then rerun your npx command with --include=optional`;
  // A global prefix's lib folder holds no package.json; a project folder that is itself named lib does (review).
  const global = /^(.*\/lib)\/node_modules\/((?:@[^/]+\/)?[^/@][^/]*)\//.exec(where);
  if (global && !exists(`${global[1]}/package.json`)) return `npm install -g --include=optional ${global[2]}${global[2].startsWith("@catscan/") ? `@${version}` : ""}`;
  if (/\/pnpm\/(dlx|global)\/|\/bunx-/.test(where)) return `reinstall the catscan package that runs here with optional dependencies included; ${spec} is missing from its install`;
  const pm = String(env.npm_config_user_agent || "").split("/")[0];
  if (pm === "pnpm" || pm === "yarn" || pm === "bun") return `${pm} add ${spec}`;
  return `npm install ${spec}`;
}

/** The `unsupported-node` message for a Node older than MIN_NODE, else null (D14). */
function nodeProblem(nodeVersion) {
  const major = Number(String(nodeVersion).split(".")[0]);
  if (major >= MIN_NODE) return null;
  return new CatscanError("unsupported-node", `Node ${nodeVersion} is too old; catscan needs Node ${MIN_NODE} or newer`, `install Node ${MIN_NODE} or newer from https://nodejs.org`);
}

/** `unsupported-platform` or `unsupported-os` before the binary starts, else null (D15). */
function platformProblem(o) {
  const { platform, arch, release } = defaults(o);
  if (platform !== "darwin") {
    return new CatscanError("unsupported-platform", `catscan needs macOS on Apple silicon (Vision exists only there); this is ${platform} ${arch}`, "run catscan on a Mac with Apple silicon");
  }
  // x64 Node on Apple silicon runs under Rosetta: the Mac is fine, the Node is not (resolveBinary() says so).
  if (arch !== "arm64" && (o.translated || rosetta)() !== 1) {
    return new CatscanError("unsupported-platform", `catscan needs macOS on Apple silicon (Vision exists only there); this Mac is ${arch}`, "run catscan on a Mac with Apple silicon");
  }
  const darwin = Number(String(release).split(".")[0]);
  if (!(darwin >= MIN_DARWIN)) {
    return new CatscanError("unsupported-os", `catscan needs macOS 15 or newer; this is Darwin ${release} (macOS ${darwin - 9})`, "update macOS to 15 or newer");
  }
  return null;
}

/**
 * The catscan-core binary as { path, source, version }: source `env` ($CATSCAN_CORE_BINARY), `package`
 * (@catscan/cli-darwin-arm64 at this exact version) or `build` (core/.build/release, repo checkout only).
 * Never PATH or the working directory (spec 08).
 */
function resolveBinary(opts = {}) {
  const o = defaults(opts);
  const bad = platformProblem(o);
  if (bad) throw bad;
  const override = o.env.CATSCAN_CORE_BINARY;
  if (override) {
    if (!o.exists(override)) throw new CatscanError("binary-not-found", `CATSCAN_CORE_BINARY points to a missing file: ${override}`, "fix or unset CATSCAN_CORE_BINARY");
    return { path: override, source: "env", version: null };
  }
  // A repo checkout always runs its own build: the linked workspace package may hold a stale release binary that
  // scripts/release.sh copied in (review of spec 08).
  if (!installed(o.dir)) {
    const build = path.resolve(o.dir, "../../../core/.build/release/catscan-core");
    if (o.exists(build)) return { path: build, source: "build", version: null };
    throw new CatscanError("binary-not-found", "the catscan-core binary was not found", "swift build -c release --package-path core, or set CATSCAN_CORE_BINARY");
  }
  const spec = `${BINARY_PACKAGE}@${o.version}`;
  const hint = installCommand(o.env, spec, o.dir, o.exists);
  let manifest = null;
  try { manifest = o.resolve(`${BINARY_PACKAGE}/package.json`, o.dir); } catch {}
  if (manifest) {
    const bin = path.join(path.dirname(manifest), "bin", "catscan-core");
    const v = o.readJSON(manifest).version;
    if (v !== o.version) throw new CatscanError("binary-version-mismatch", `${BINARY_PACKAGE} is ${v}, but @catscan/core-js is ${o.version}`, hint);
    if (!o.exists(bin)) throw new CatscanError("binary-not-found", `${BINARY_PACKAGE}@${v} has no bin/catscan-core`, hint);
    return { path: bin, source: "package", version: v };
  }
  if (o.arch !== "arm64") {
    return fail(`${BINARY_PACKAGE} is not installed: Node ${o.nodeVersion} runs as ${o.arch} under Rosetta, so the package manager skipped the arm64 binary`, "install an arm64 Node (https://nodejs.org), then reinstall catscan");
  }
  return fail(`${BINARY_PACKAGE} is not installed: the install skipped optional dependencies (--omit=optional) or the lockfile was made on another OS`, hint);

  function fail(message, hint) { throw new CatscanError("binary-not-found", message, hint); }
}

/** `codesign --verify --strict` plus the Team ID from `codesign -dv` (spec 08 D7). */
function parseCodesign(verifyStatus, details) {
  const team = /^TeamIdentifier=(.+)$/m.exec(details || "");
  const teamId = team && team[1].trim() !== "not set" ? team[1].trim() : null;
  return { valid: verifyStatus === 0, team_id: teamId };
}

/**
 * `spctl --assess -vv --type open --context context:primary-signature`: true for `source=Notarized Developer ID`,
 * false for any other `source=` or a bare `rejected` (an ad-hoc build), null when spctl gave no assessment
 * (could not run, offline lookup) (spec 08 D7).
 */
function parseSpctl(output) {
  const source = /^source=(.+)$/m.exec(output || "");
  // A rejected verdict is never notarized, whatever source it names (review; same rule as scripts/release-lib.mjs).
  if (source) return source[1].trim() === "Notarized Developer ID" && !/: rejected/m.test(output);
  return /: rejected$/m.test(output || "") ? false : null;
}

module.exports = {
  BINARY_PACKAGE, TEAM_ID, MIN_NODE, MIN_DARWIN, CatscanError,
  resolveBinary, platformProblem, nodeProblem, installCommand, installed, rosetta, parseCodesign, parseSpctl,
};
