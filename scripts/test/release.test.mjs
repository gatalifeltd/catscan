// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 08 release step 1 and 2 checks (scripts/release-lib.mjs); the rest of scripts/release.sh needs the owner's
// signing identity and npm 2FA, so `scripts/release.sh --dry-run` covers steps 1-4 instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import Ajv from "ajv";
import { ROOT, PACKAGES, PUBLIC_REPO, SERVER_JSON, PLUGIN_JSON, MARKETPLACE_JSON, BEHAVIOR_FILE, JSON_CARRIERS, TEXT_CARRIERS, carrierFiles, planBump, parseBehaviorChanges, buildBehaviorChanges, behaviorProblems, publicBehaviorChanges, versionProblems, metadataProblems, minos, mainProblem, notarized, packProblems, selfTestProblem } from "../release-lib.mjs";

function fakeRepo(edit = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-release-"));
  fs.writeFileSync(path.join(root, "VERSION"), "1.2.3\n");
  const files = { "package.json": { version: "1.2.3" } };
  files["packages/cli-darwin-arm64/package.json"] = { version: "1.2.3" };
  files["packages/core-js/package.json"] = { version: "1.2.3", dependencies: { ajv: "8.20.0" }, optionalDependencies: { "@catscan/cli-darwin-arm64": "1.2.3" } };
  files["packages/cli/package.json"] = { version: "1.2.3", dependencies: { "@catscan/core-js": "1.2.3" } };
  files["packages/mcp/package.json"] = { version: "1.2.3", optionalDependencies: { "@catscan/cli": "1.2.3", "@catscan/core-js": "1.2.3" } };
  files["packages/playwright/package.json"] = { version: "1.2.3", dependencies: { "@catscan/core-js": "1.2.3" }, peerDependencies: { "@playwright/test": ">=1.50.0 <2" } };
  for (const f of Object.keys(files)) {
    const dir = path.dirname(f);
    Object.assign(files[f], {
      repository: { type: "git", url: `git+${PUBLIC_REPO}.git`, ...(dir === "." ? {} : { directory: dir }) },
      homepage: `${PUBLIC_REPO}#readme`, bugs: { url: `${PUBLIC_REPO}/issues` }, keywords: ["ocr"],
    });
  }
  files["packages/mcp/package.json"].name = "@catscan/mcp";
  files["packages/mcp/package.json"].mcpName = "io.github.o/x";
  files[SERVER_JSON] = {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json", name: "io.github.o/x", version: "1.2.3",
    websiteUrl: `${PUBLIC_REPO}#readme`,
    repository: { url: PUBLIC_REPO, source: "github", subfolder: "packages/mcp" },
    packages: [{ registryType: "npm", identifier: "@catscan/mcp", version: "1.2.3", transport: { type: "stdio" } }],
  };
  files[PLUGIN_JSON] = { name: "catscan", version: "1.2.3" };
  files[MARKETPLACE_JSON] = { name: "catscan", plugins: [{ name: "catscan", source: "./plugins/catscan" }] };
  edit(files);
  for (const [f, j] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), JSON.stringify(j));
  }
  return root;
}

test("release: the repo itself agrees on one version across every package", () => {
  assert.deepEqual(PACKAGES, ["cli-darwin-arm64", "core-js", "cli", "mcp", "playwright"]);
  assert.deepEqual(versionProblems(ROOT), []);
});

test("release: the repo's manifests and server.json carry the public repo fields (spec 25 D24, D25)", () => {
  assert.deepEqual(metadataProblems(ROOT), []);
  const mcp = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/mcp/package.json"), "utf8"));
  assert.equal(mcp.mcpName, "io.github.gatalifeltd/catscan");
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, SERVER_JSON), "utf8")).name, mcp.mcpName);
});

test("release: a missing or drifted repo field, mcpName or server.json entry is named", () => {
  assert.deepEqual(metadataProblems(fakeRepo()), []);
  const bad = fakeRepo((f) => {
    delete f["package.json"].keywords;
    f["packages/cli/package.json"].repository.directory = "packages/core-js";
    delete f["packages/core-js/package.json"].bugs;
    f["packages/playwright/package.json"].homepage = `${PUBLIC_REPO}/blob/main/docs/missing.md`;
    f["packages/cli-darwin-arm64/package.json"].homepage = "https://example.com";
    f["packages/mcp/package.json"].mcpName = "io.github.o/y";
    f[SERVER_JSON].$schema = "https://static.modelcontextprotocol.io/schemas/draft/server.schema.json";
    f[SERVER_JSON].packages[0].identifier = "@catscan/cli";
  });
  const got = metadataProblems(bad);
  for (const want of [
    "package.json keywords", "packages/cli/package.json repository", "packages/core-js/package.json bugs.url",
    "docs/missing.md, which does not exist", "packages/cli-darwin-arm64/package.json homepage https://example.com",
    "mcpName io.github.o/y must equal", "$schema https://static.modelcontextprotocol.io/schemas/draft/", "exactly one npm package",
  ]) assert.ok(got.some((p) => p.includes(want)), `no problem names "${want}" in ${JSON.stringify(got)}`);
  assert.equal(got.length, 8);
});

test("release: homepage links outside the landing set, empty or with .. fail; a missing server.json is named, not thrown", () => {
  const root = fakeRepo((f) => {
    f["packages/cli/package.json"].homepage = `${PUBLIC_REPO}/blob/main/docs/product/plan.md`;
    f["packages/core-js/package.json"].homepage = `${PUBLIC_REPO}/blob/main/`;
    f["packages/playwright/package.json"].homepage = `${PUBLIC_REPO}/blob/main/docs/../VERSION`;
    f[SERVER_JSON].websiteUrl = `${PUBLIC_REPO}/issues`;
  });
  fs.mkdirSync(path.join(root, "docs/product"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/product/plan.md"), "x\n");
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts/public-paths.txt"), "docs/recipes/\n");
  const got = metadataProblems(root);
  for (const want of [
    "packages/cli/package.json homepage names docs/product/plan.md, which never lands",
    `packages/core-js/package.json homepage ${PUBLIC_REPO}/blob/main/ is not`,
    `packages/playwright/package.json homepage ${PUBLIC_REPO}/blob/main/docs/../VERSION is not`, "websiteUrl",
  ]) assert.ok(got.some((p) => p.includes(want)), `no problem names "${want}" in ${JSON.stringify(got)}`);
  assert.equal(got.length, 4);
  fs.rmSync(path.join(root, SERVER_JSON));
  assert.deepEqual(metadataProblems(root).filter((p) => p.startsWith(SERVER_JSON)), [`${SERVER_JSON} cannot be read: missing`]);
  // The allowlist makes this a lab root, where the carriers this fixture lacks are named too (TODO-094 D6).
  assert.deepEqual(versionProblems(root).filter((p) => p.startsWith(SERVER_JSON)), [`${SERVER_JSON} cannot be read: missing`]);
});

test("release: server.json validates against the dated registry schema it names (spec 25 D25)", () => {
  const server = JSON.parse(fs.readFileSync(path.join(ROOT, SERVER_JSON), "utf8"));
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/test/fixtures/mcp/server.schema-2025-12-11.json"), "utf8"));
  // A new $schema date needs the matching schema fixture, fetched from that URL.
  assert.equal(schema.$id, server.$schema);
  const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
  assert.ok(validate(server), JSON.stringify(validate.errors));
  assert.ok(!validate({ ...server, description: "x".repeat(101) }), "the registry's 100-character description limit is enforced");
});

test("release: a version bump that skips server.json is caught (spec 25 D25)", () => {
  const stale = fakeRepo((f) => { f[SERVER_JSON].version = "1.2.2"; f[SERVER_JSON].packages[0].version = "1.2.2"; });
  assert.deepEqual(versionProblems(stale), [
    "packages/mcp/server.json version is 1.2.2, not 1.2.3",
    "packages/mcp/server.json packages @catscan/mcp version is 1.2.2, not 1.2.3",
  ]);
});

test("release: the CI examples pin VERSION (spec 15 D3); folders and quoted pins are fine", () => {
  const root = fakeRepo();
  fs.mkdirSync(path.join(root, "examples/ci/more"), { recursive: true });
  fs.writeFileSync(path.join(root, "examples/ci/a.yml"), "# `npx @catscan/cli@1.2.3`, (@catscan/cli@1.2.3)\n- run: npx @catscan/cli@1.2.3 doctor\n");
  assert.deepEqual(versionProblems(root), []);
  fs.writeFileSync(path.join(root, "examples/ci/b.yml"), "- run: npx @catscan/cli@1.2.2 doctor\n");
  assert.deepEqual(versionProblems(root), ["examples/ci/b.yml pins @catscan/cli@1.2.2, not 1.2.3"]);
  fs.writeFileSync(path.join(root, "examples/ci/b.yml"), "- run: npx @catscan/cli@1.2.3${TAG} doctor\n");
  assert.deepEqual(versionProblems(root), ["examples/ci/b.yml pins @catscan/cli@1.2.3${TAG}, not 1.2.3"]);
});

// Value: protects=the MCP recipe's server pin moves with every release; fails_when=a stale `@catscan/mcp@` pin in
// docs/recipes/mcp.md passes `versions`, or the `<version>` placeholder is flagged; why_new=new carrier (TODO-059 T4);
// seam=none; no_claim=that readers copy the pinned line.
test("release: docs/recipes/mcp.md pins @catscan/mcp at VERSION; the <version> placeholder is fine", () => {
  const root = fakeRepo();
  fs.mkdirSync(path.join(root, "docs/recipes"), { recursive: true });
  const recipe = path.join(root, "docs/recipes/mcp.md");
  fs.writeFileSync(recipe, "`npx -y @catscan/mcp@<version>`\n```\nclaude mcp add catscan -- npx -y @catscan/mcp@1.2.3\n```\n`[\"-y\", \"@catscan/mcp@1.2.3\"]`\n");
  assert.deepEqual(versionProblems(root), []);
  fs.writeFileSync(recipe, "`args = [\"-y\", \"@catscan/mcp@1.2.2\"]`\n");
  assert.deepEqual(versionProblems(root), ["docs/recipes/mcp.md pins @catscan/mcp@1.2.2, not 1.2.3"]);
});

test("release: versions, internal pins and the tag must all equal VERSION", () => {
  assert.deepEqual(versionProblems(fakeRepo()), []);
  assert.deepEqual(versionProblems(fakeRepo(), "v1.2.3"), []);
  assert.deepEqual(versionProblems(fakeRepo(), ""), ["HEAD is tagged nothing, not v1.2.3"]);
  assert.deepEqual(versionProblems(fakeRepo(), "v1.2.2"), ["HEAD is tagged v1.2.2, not v1.2.3"]);
  const drift = fakeRepo((f) => {
    f["packages/cli/package.json"].version = "1.2.2";
    f["packages/core-js/package.json"].optionalDependencies["@catscan/cli-darwin-arm64"] = "^1.2.3";
  });
  assert.deepEqual(versionProblems(drift), [
    "packages/core-js/package.json optionalDependencies.@catscan/cli-darwin-arm64 is ^1.2.3, not 1.2.3",
    "packages/cli/package.json version is 1.2.2, not 1.2.3",
  ]);
});

test("release: minos from recorded vtool -show-build output", () => {
  // Recorded from `vtool -show-build` on a local release build (macOS 26.2, Xcode 26).
  const out = "core/.build/release/catscan-core:\nLoad command 11\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform MACOS\n    minos 15.0\n      sdk 15.0\n   ntools 1\n     tool LD\n  version 27037.1\n";
  assert.equal(minos(out), "15.0");
  assert.equal(minos(""), null);
});

test("release: HEAD must be on origin/main (review)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-release-git-"));
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  git("commit", "-q", "--allow-empty", "-m", "one");
  assert.match(mainProblem(repo), /^cannot compare HEAD with origin\/main/);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(mainProblem(repo), null);
  git("commit", "-q", "--allow-empty", "-m", "unmerged");
  assert.equal(mainProblem(repo), "HEAD is not on origin/main");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("release: the notarization match reads all of spctl's output (review)", () => {
  const ok = "/x/catscan-core: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: GATALIFE LTD (JK3T6SMS5W)\n";
  assert.equal(notarized(ok), true);
  assert.equal(notarized("/x/catscan-core: rejected\nsource=Unnotarized Developer ID\n"), false);
  assert.equal(notarized(""), false);
  assert.equal(notarized("/x/catscan-core: rejected\nsource=Notarized Developer ID\n"), false);
  // `| grep -q` exits at the match and can SIGPIPE spctl under pipefail; the CLI drains stdin, so a long tail after
  // the match still exits 0 through a pipefail pipeline.
  const cli = path.join(ROOT, "scripts/release-lib.mjs");
  const r = spawnSync("bash", ["-c", `set -o pipefail; { printf '%s' "$1"; head -c 1000000 /dev/zero | tr '\\0' 'x'; echo; } | "$2" "$3" notarized`, "_", ok, process.execPath, cli], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("release: the binary tarball holds exactly package.json and bin/catscan-core (review)", () => {
  assert.deepEqual(packProblems("package/package.json\npackage/bin/catscan-core\n"), []);
  assert.deepEqual(packProblems("package/package.json\npackage/bin/catscan-core\npackage/bin/catscan-core.dSYM/x\n"), ["unexpected package/bin/catscan-core.dSYM/x"]);
  assert.deepEqual(packProblems("package/package.json\n"), ["missing package/bin/catscan-core"]);
});

test("release: the binary to ship must pass its own self-test before publishing (review)", () => {
  const ok = { self_test: { ms: 50, pass: true }, vision: { languages: { accurate: 30, fast: 6 } } };
  assert.equal(selfTestProblem(JSON.stringify(ok)), null);
  assert.match(selfTestProblem(JSON.stringify({ ...ok, self_test: { ms: 50, pass: false } })), /self-test did not pass/);
  assert.match(selfTestProblem(JSON.stringify({ ...ok, vision: { languages: { accurate: 0, fast: 0 } } })), /no recognition languages/);
  assert.match(selfTestProblem("Killed: 9"), /did not print JSON/);
});

// Value: protects=spec 25 D19, the real release stops before building when a landing file holds a listed name or the list is missing; fails_when=release.sh drops the check or runs it with --names=if-available on a real run; why_new=D19 is new; seam=a temp repo holds release.sh and the check scripts; no_claim=signing or publishing
test("release.sh stops on a private name in a landing file, and without the name list", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-release-d19-"));
  fs.mkdirSync(path.join(root, "scripts"));
  for (const f of ["release.sh", "check-private.mjs", "public-paths.mjs"]) fs.copyFileSync(path.join(ROOT, "scripts", f), path.join(root, "scripts", f));
  fs.writeFileSync(path.join(root, "scripts/public-paths.txt"), "VERSION\nREADME.md\n");
  fs.writeFileSync(path.join(root, "VERSION"), "1.2.3\n");
  fs.writeFileSync(path.join(root, "README.md"), "Built for Zorblax Quest.\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null" };
  delete env.CATSCAN_PRIVATE_NAMES;
  delete env.CATSCAN_PRIVATE_NAMES_FILE;
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "x"]]) execFileSync("git", args, { cwd: root, env });
  const run = (extra) => spawnSync("bash", ["scripts/release.sh"], { cwd: root, encoding: "utf8", env: { ...env, ...extra } });
  const named = run({ CATSCAN_PRIVATE_NAMES: "Zorblax Quest" });
  assert.equal(named.status, 1);
  assert.match(named.stdout + named.stderr, /private-name README\.md:1/);
  assert.match(named.stderr, /private-data check failed/);
  assert.doesNotMatch(named.stdout, /step 2/);
  const missing = run({});
  assert.equal(missing.status, 1);
  assert.match(missing.stdout + missing.stderr, /names-missing/);
  // The dry run on the runner: a notice without the list (D17), still a stop on a listed name.
  const dry = (extra) => spawnSync("bash", ["scripts/release.sh", "--dry-run"], { cwd: root, encoding: "utf8", env: { ...env, ...extra } });
  const notice = dry({});
  assert.match(notice.stdout, /notice: no private name list/);
  assert.doesNotMatch(notice.stderr, /private-data check failed/);
  const dryNamed = dry({ CATSCAN_PRIVATE_NAMES: "Zorblax Quest" });
  assert.equal(dryNamed.status, 1);
  assert.match(dryNamed.stderr, /private-data check failed/);
});

// Value: protects=TODO-027 D4/D9, release.sh audits the lockfiles when the release is cut and stops before building on a high advisory; fails_when=release.sh drops or ignores the audit; why_new=D4 is new; seam=a temp repo with a fake npm first on PATH; no_claim=registry behaviour (a captured npm 11.20.0 report stands in)
test("release.sh stops before building on a high npm advisory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-release-audit-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, ".bin"));
  for (const f of ["release.sh", "check-private.mjs", "public-paths.mjs", "check-audit.mjs"]) fs.copyFileSync(path.join(ROOT, "scripts", f), path.join(root, "scripts", f));
  fs.writeFileSync(path.join(root, "scripts/public-paths.txt"), "VERSION\n");
  fs.writeFileSync(path.join(root, "VERSION"), "1.2.3\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  fs.copyFileSync(path.join(ROOT, "scripts/test/fixtures/audit/spike-high.json"), path.join(root, ".bin/report.json"));
  fs.writeFileSync(path.join(root, ".bin/npm"), `#!/bin/sh\n[ "$1" = --version ] && { echo 11.20.0; exit 0; }\ncat "${root}/.bin/report.json"; exit 1\n`, { mode: 0o755 });
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", CATSCAN_PRIVATE_NAMES: "Zorblax Quest", PATH: `${path.join(root, ".bin")}${path.delimiter}${process.env.PATH}` };
  delete env.CATSCAN_PRIVATE_NAMES_FILE;
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "x"]]) execFileSync("git", args, { cwd: root, env });
  for (const args of [[], ["--dry-run"]]) {
    const r = spawnSync("bash", ["scripts/release.sh", ...args], { cwd: root, encoding: "utf8", env });
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /audit-high package-lock\.json: 3 high/);
    assert.match(r.stderr, /fix it on main in its own PR, then cut a new release commit and tag/);
    assert.doesNotMatch(r.stdout, /step 2/);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// Value: protects=an installed plugin names the catscan it belongs to, from one carrier; fails_when=a bump skips plugin.json or marketplace.json grows a second version; why_new=the plugin had no version (TODO-059 D11); seam=none; no_claim=agent plugin update commands
test("release: the plugin manifest carries VERSION and the marketplace entry none (TODO-059 D11)", () => {
  const stale = fakeRepo((f) => { f[PLUGIN_JSON].version = "1.2.2"; f[MARKETPLACE_JSON].plugins[0].version = "1.2.3"; });
  assert.deepEqual(versionProblems(stale), [
    `${PLUGIN_JSON} version is 1.2.2, not 1.2.3`,
    `${MARKETPLACE_JSON} plugin catscan carries a version; only ${PLUGIN_JSON} does`,
  ]);
  // A missing carrier is named, never skipped as if it agreed.
  assert.deepEqual(versionProblems(fakeRepo((f) => { delete f[PLUGIN_JSON]; })), [`${PLUGIN_JSON} cannot be read: missing`]);
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, PLUGIN_JSON), "utf8"));
  assert.equal(real.version, fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim());
});

const EXIT = "## Exit codes\n\n| Code | Meaning |\n| --- | --- |\n| 0 | Every check passed |\n| 1 | A check failed |\n\nMore.\n";
/** A tree with the four state sources at protocol `p`, an optional exit table, and the CHANGELOG given. */
function behaviorRepo(changelog, { p = 5, exit = EXIT, committed = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-behavior-"));
  const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
  put("CHANGELOG.md", changelog);
  put("packages/core-js/src/client.js", `"use strict";\nconst PROTOCOL = ${p}; // history\n`);
  put("packages/core-js/src/results.js", "const RESULTS_SCHEMAS = [1, 2];\n");
  put("core/schema/doctor.schema.json", JSON.stringify({ $id: "https://catscan.dev/schema/doctor-1.json" }));
  put("docs/cli.md", `# CLI\n\n${exit}`);
  if (committed) put(BEHAVIOR_FILE, committed);
  return root;
}
const OLD = "## [0.36.0] - 2026-11-17\n\n### Added\n- x\n\n### Behavior changes\n- `exit-code` fail-on-skip: `--fail-on-skip` exits 1 on a skipped check. Opt out: leave out `--fail-on-skip`.\n\n## [0.35.0] - 2026-11-16\n\n### Added\n- y\n";
const top = (bullets = "") => `# Changelog\n\n## [0.37.0] - 2026-11-17\n\n### Added\n- z\n${bullets ? `\n### Behavior changes\n${bullets}\n` : ""}\n${OLD}`;
/** Commits a generated file whose older states come from a tree at protocol `p`, as a release before this one did. */
function released(changelog, p) {
  const before = behaviorRepo(OLD, { p });
  const first = buildBehaviorChanges(before);
  assert.deepEqual(first.problems, []);
  return first.text;
}

// Value: protects=the upgrade skill reads behavior changes as data, newest first, from 0.36.0 on, with the bullet text intact; fails_when=the parser drops, reorders or rewrites a bullet, or reads a pre-0.36.0 release; why_new=release notes as data (TODO-059 T1); seam=none; no_claim=CHANGELOG prose outside the section
test("behavior changes: CHANGELOG bullets parse newest first and round-trip the grammar (TODO-059 D5)", () => {
  const line = "- `default-on` wrong-language-default: `untranslated` reports `wrong-language` by default, so a run can turn red. Opt out: `--kinds untranslated,raw-key,placeholder`.";
  const { releases, problems } = parseBehaviorChanges(top(line));
  assert.deepEqual(problems, []);
  assert.deepEqual(releases.map((r) => r.version), ["0.37.0", "0.36.0"]);
  const c = releases[0].changes[0];
  assert.deepEqual(c, { kind: "default-on", id: "wrong-language-default", text: "`untranslated` reports `wrong-language` by default, so a run can turn red.", opt_out: "`--kinds untranslated,raw-key,placeholder`" });
  assert.equal(`- \`${c.kind}\` ${c.id}: ${c.text} Opt out: ${c.opt_out}.`, line);
  // The real CHANGELOG parses clean and its committed file is current (docs:check runs the same).
  assert.deepEqual(behaviorProblems(ROOT), []);
});

// Value: protects=a malformed bullet never reaches users as data the skill misreads; fails_when=a bad kind, a missing opt-out, a non-kebab or repeated id passes; why_new=the grammar is new; seam=none; no_claim=whether the sentence is true
test("behavior changes: a bad kind, a missing opt-out, a bad or repeated id fail with their line (TODO-059 D5)", () => {
  const bad = [
    "- `defaults` a-b: Text. Opt out: none.",
    "- `cli` no-opt-out: Text without an opt out.",
    "- `cli` Bad_Id: Text. Opt out: none.",
    "- `cli` fail-on-skip: Repeats an id. Opt out: none.",
  ].join("\n");
  const { problems } = parseBehaviorChanges(top(bad));
  assert.equal(problems.length, 4, problems.join("\n"));
  assert.match(problems[0], /^CHANGELOG\.md:\d+: unknown kind `defaults`; use one of default-on, exit-code/);
  assert.match(problems[1], /a behavior change must read "- `<kind>` <id>: .*Opt out: <flag, env or none>\." on one line/);
  assert.match(problems[2], /id "Bad_Id" is not kebab-case/);
  assert.match(problems[3], /id "fail-on-skip" is already used at CHANGELOG\.md:\d+/);
  // A section backfilled into an untracked release is flagged, not silently dropped from the data.
  const early = parseBehaviorChanges(top().replace("### Added\n- y\n", "### Behavior changes\n- `cli` early: Text. Opt out: none.\n"));
  assert.deepEqual(early.releases.map((r) => r.version), ["0.37.0", "0.36.0"]);
  assert.equal(early.problems.length, 1, early.problems.join("\n"));
  assert.match(early.problems[0], /^CHANGELOG\.md:\d+: ### Behavior changes outside a released version from 0\.36\.0 on, so it is not tracked$/);
});

// Value: protects=no protocol, schema or exit-code change ships without a bullet, and the committed JSON never drifts; fails_when=a state change passes with no matching bullet, a matching bullet still fails, or a stale JSON passes; why_new=state coverage is new (TODO-059 D5); seam=none; no_claim=changes the four state sources cannot see
test("behavior changes: a state change needs its bullet kind, and the committed file must match (TODO-059 D5)", () => {
  const committed = released(OLD, 5);
  // Same state: no bullet needed, and the file is stale until regenerated.
  let root = behaviorRepo(top(), { committed });
  assert.deepEqual(behaviorProblems(root), [`${BEHAVIOR_FILE} differs from CHANGELOG.md and the code; run node scripts/release-lib.mjs behavior-changes`]);
  fs.writeFileSync(path.join(root, BEHAVIOR_FILE), buildBehaviorChanges(root).text);
  assert.deepEqual(behaviorProblems(root), []);
  const json = JSON.parse(fs.readFileSync(path.join(root, BEHAVIOR_FILE), "utf8"));
  assert.deepEqual(json.releases.map((r) => [r.version, r.state.protocol, r.changes.length]), [["0.37.0", 5, 0], ["0.36.0", 5, 1]]);
  assert.deepEqual(json.releases[0].state.exit_codes, [0, 1]);
  // Each state field, changed with no bullet, names the kind it needs; the matching bullet clears it.
  const cases = [
    [{ p: 6 }, "protocol 5 -> 6", "protocol"],
    [{ exit: EXIT.replace("| 1 | A check failed |\n", "| 1 | A check failed |\n| 6 | A new reason |\n") }, "exit_codes", "exit-code"],
  ];
  for (const [opts, what, kind] of cases) {
    root = behaviorRepo(top(), { committed, ...opts });
    const { problems } = buildBehaviorChanges(root);
    assert.deepEqual(problems, [`CHANGELOG.md [0.37.0]: ${what} changed since 0.36.0; add a \`${kind}\` bullet under ### Behavior changes in the release that makes the change (bump VERSION and add its CHANGELOG entry first)`]);
    root = behaviorRepo(top(`- \`${kind}\` the-change: It changed. Opt out: none.`), { committed, ...opts });
    assert.deepEqual(buildBehaviorChanges(root).problems, []);
  }
  root = behaviorRepo(top(), { committed });
  fs.writeFileSync(path.join(root, "packages/core-js/src/results.js"), "const RESULTS_SCHEMAS = [2];\n");
  assert.match(buildBehaviorChanges(root).problems.join("\n"), /results_schema changed since 0\.36\.0; add a `schema` bullet/);
  fs.writeFileSync(path.join(root, "core/schema/doctor.schema.json"), JSON.stringify({ $id: "https://catscan.dev/schema/doctor-2.json" }));
  fs.writeFileSync(path.join(root, "packages/core-js/src/results.js"), "const RESULTS_SCHEMAS = [1, 2];\n");
  assert.match(buildBehaviorChanges(root).problems.join("\n"), /doctor_schema https:.*doctor-1\.json -> https:.*doctor-2\.json changed since 0\.36\.0; add a `schema` bullet/);
});

// Value: protects=an older release's state is never invented from today's code, and the land ships only public releases; fails_when=a release missing from the committed file is filled from the code, or the trim keeps a lab release; why_new=frozen states and the public trim are new; seam=none; no_claim=git history
test("behavior changes: an older release without a committed state fails; the land keeps public releases only", () => {
  const root = behaviorRepo(top());
  assert.match(buildBehaviorChanges(root).problems.join("\n"), /has no state for 0\.36\.0, an older release; take the file from origin\/main/);
  const text = released(OLD, 5);
  const json = JSON.parse(publicBehaviorChanges(buildBehaviorChanges(behaviorRepo(top(), { committed: text })).text, "0.37.0"));
  assert.deepEqual(json.releases.map((r) => r.version), ["0.37.0"]);
});

// Value: protects=docs:check (the gate every block runs) enforces the behavior-change grammar and the committed JSON; fails_when=docs-check stops calling behaviorProblems or ignores its problems; why_new=the unit tests above call release-lib directly, never the gate; seam=none (--root on a temp lab tree); no_claim=the other docs:check rules
test("docs:check fails a stale behavior-changes.json and a malformed bullet, and passes once regenerated (TODO-059 D5)", () => {
  const root = behaviorRepo(top(), { committed: released(OLD, 5) });
  for (const [f, t] of [["VERSION", "0.37.0\n"], ["package.json", '{ "version": "0.37.0" }\n'], ["TODOS.md", "# TODOs\n"], ["docs/INDEX.md", "# Index\n\n- [CLI](./cli.md)\n"]]) fs.writeFileSync(path.join(root, f), t);
  const check = () => spawnSync(process.execPath, [path.join(ROOT, "scripts/docs-check.mjs"), "--root", root], { encoding: "utf8" });
  let r = check();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /behavior-changes\.json differs from CHANGELOG\.md and the code; run node scripts\/release-lib\.mjs behavior-changes/);
  fs.writeFileSync(path.join(root, BEHAVIOR_FILE), buildBehaviorChanges(root).text);
  r = check();
  assert.equal(r.status, 0, r.stderr);
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), top("- `cli` no-opt-out: Text without an opt out."));
  r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^CHANGELOG\.md:\d+: a behavior change must read /m);
  fs.rmSync(root, { recursive: true, force: true });
});

// Value: protects=land-public ships only public releases in the packed behavior-changes.json, and a bad call stops the land; fails_when=the CLI misreads --public/--first-public, does not rewrite the file, or exits 0 on bad arguments; why_new=publicBehaviorChanges is tested as a function, not the command land-public.sh runs; seam=none; no_claim=the rest of land-public.sh
test("release-lib behavior-changes --public trims the file in place; bad arguments exit 2 and leave it alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-bc-public-"));
  const file = path.join(dir, "behavior-changes.json");
  const text = buildBehaviorChanges(behaviorRepo(top(), { committed: released(OLD, 5) })).text;
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, "scripts/release-lib.mjs"), "behavior-changes", ...a], { encoding: "utf8" });
  fs.writeFileSync(file, text);
  for (const bad of [["--public", file], ["--public", file, "--first-public", "0.37"], ["--public"]]) {
    const r = cli(...bad);
    assert.equal(r.status, 2, `${bad.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /usage: release-lib\.mjs behavior-changes --public <file> --first-public X\.Y\.Z/);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
  const r = cli("--public", file, "--first-public", "0.37.0");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).releases.map((x) => x.version), ["0.37.0"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Value: protects=a docs-only rewording of the exit table never demands a bullet in a released version, and bullets under a non-version heading never attach to the release above; fails_when=exit state keys on wording again, or `cur` survives a `## [Unreleased]` heading; why_new=ship review (D26); seam=none; no_claim=whether a reworded meaning is a real behavior change
test("behavior changes: rewording an exit meaning needs no bullet; an [Unreleased] heading owns no bullets (TODO-059 D26)", () => {
  const committed = released(OLD, 5);
  const root = behaviorRepo(top(), { committed, exit: EXIT.replace("A check failed", "A check did not pass") });
  assert.deepEqual(buildBehaviorChanges(root).problems, []);
  const unreleased = `# Changelog\n\n## [Unreleased]\n\n### Behavior changes\n- \`cli\` pending-thing: Not out yet. Opt out: none.\n\n${OLD}`;
  const { releases, problems } = parseBehaviorChanges(unreleased);
  assert.deepEqual(releases.map((r) => [r.version, r.changes.length]), [["0.36.0", 1]]);
  assert.match(problems.join("\n"), /outside a released version/);
});

// Value: protects=the regeneration never writes through a symlink or erases frozen older states; fails_when=the CLI follows a link, or writes null states when the committed file is unreadable; why_new=ship review (D27); seam=none; no_claim=the real repo file (copied into a temp tree)
test("release-lib behavior-changes refuses a symlinked target and leaves an unreadable committed file alone (TODO-059 D27)", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-bc-cli-"))); // realpath: the CLI guard compares argv[1] with its own resolved path
  fs.mkdirSync(path.join(root, "scripts"));
  for (const f of ["release-lib.mjs", "public-paths.mjs"]) fs.copyFileSync(path.join(ROOT, "scripts", f), path.join(root, "scripts", f));
  const tree = behaviorRepo(top());
  for (const f of ["CHANGELOG.md", "packages/core-js/src/client.js", "packages/core-js/src/results.js", "core/schema/doctor.schema.json", "docs/cli.md"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(tree, f), path.join(root, f));
  }
  const run = () => spawnSync(process.execPath, [path.join(root, "scripts/release-lib.mjs"), "behavior-changes"], { encoding: "utf8" });
  const target = path.join(root, BEHAVIOR_FILE);
  fs.writeFileSync(target, "<<<<<<< ours\n");
  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /left unchanged/);
  assert.equal(fs.readFileSync(target, "utf8"), "<<<<<<< ours\n");
  const victim = path.join(root, "victim.txt");
  fs.writeFileSync(victim, "keep\n");
  fs.rmSync(target);
  fs.symlinkSync(victim, target);
  r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not a regular file/);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep\n");
});

// TODO-094: a temp lab root holding copies of the real carrier files, so every pattern runs on the real text.
const CURRENT = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
function carrierRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-bump-"));
  const files = ["VERSION", "CHANGELOG.md", "scripts/public-paths.txt", MARKETPLACE_JSON, ...JSON_CARRIERS.map((c) => c.file),
    ...TEXT_CARRIERS.flatMap((c) => carrierFiles(ROOT, c.files))];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  }
  return root;
}
const apply = (root, writes) => { for (const [f, t] of Object.entries(writes)) fs.writeFileSync(path.join(root, f), t); };
const readIn = (root, f) => fs.readFileSync(path.join(root, f), "utf8");

// Value: protects=one bump moves every real carrier and versions agrees after it; fails_when=a carrier pattern stops
// matching the real text, a carrier drops out of the list, or a second run rewrites anything; why_new=no writer existed
// (TODO-094); seam=none; no_claim=gstack /ship Step 12 accepting the pre-bumped VERSION
test("bump: every real carrier moves to the new version, versions agrees, and a second run changes nothing (TODO-094)", () => {
  const root = carrierRepo();
  const lock = JSON.parse(readIn(root, "package-lock.json"));
  lock.packages["node_modules/not-ours"] = { version: CURRENT };
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  assert.deepEqual(versionProblems(root), []);
  const { writes, problems } = planBump(root, "9.9.9", { date: "2030-01-02" });
  assert.deepEqual(problems, []);
  const carriers = ["VERSION", "CHANGELOG.md", ...JSON_CARRIERS.map((c) => c.file), ...TEXT_CARRIERS.flatMap((c) => carrierFiles(root, c.files))];
  assert.deepEqual(Object.keys(writes).sort(), [...new Set(carriers)].sort());
  apply(root, writes);
  assert.deepEqual(versionProblems(root), []);
  assert.equal(JSON.parse(readIn(root, "package-lock.json")).packages["node_modules/not-ours"].version, CURRENT);
  assert.match(readIn(root, "docs/public-release.md"), new RegExp(`^\\| Lab version \\| 9\\.9\\.9 \\(see CHANGELOG\\.md; 2030-01-02\\); ${CURRENT.replace(/\./g, "\\.")} \\(`, "m"));
  const log = readIn(root, "CHANGELOG.md");
  assert.equal(log.split("## [9.9.9] - 2030-01-02").length, 2);
  assert.ok(log.indexOf("## [9.9.9]") < log.indexOf(`## [${CURRENT}]`));
  assert.deepEqual(planBump(root, "9.9.9"), { writes: {}, problems: [] });
  fs.rmSync(root, { recursive: true, force: true });
});

// Value: protects=a bump writes nothing and names the file when a carrier is stale or has nothing to replace;
// fails_when=bump half-writes or skips an unmatched carrier silently; why_new=new command (TODO-094); seam=none;
// no_claim=none beyond protects
test("bump: a stale carrier or one with no version to replace is named and nothing is written (TODO-094)", () => {
  const root = carrierRepo();
  const swift = "core/Sources/CatscanCore/Model.swift";
  fs.writeFileSync(path.join(root, swift), readIn(root, swift).replace(`catscanVersion = "${CURRENT}"`, 'catscanVersion = "0.0.1"'));
  let r = planBump(root, "9.9.9");
  assert.deepEqual(r.writes, {});
  assert.deepEqual(r.problems, [`${swift} catscanVersion is 0.0.1, not ${CURRENT} or 9.9.9; if VERSION already moved, name the old version with --from`]);
  fs.copyFileSync(path.join(ROOT, swift), path.join(root, swift));
  fs.writeFileSync(path.join(root, "docs/recipes/maestro.md"), "# Maestro\n");
  r = planBump(root, "9.9.9");
  assert.deepEqual(r, { writes: {}, problems: ["docs/recipes/maestro.md: no says Tested with catscan found to replace"] });
  fs.rmSync(path.join(root, "docs/recipes/maestro.md"));
  assert.deepEqual(planBump(root, "9.9.9").problems, ["docs/recipes/maestro.md: no such carrier file"]);
  fs.copyFileSync(path.join(ROOT, "docs/recipes/maestro.md"), path.join(root, "docs/recipes/maestro.md"));
  assert.deepEqual(planBump(root, "1.2").problems, ['the new version "1.2" is not X.Y.Z']);
  assert.deepEqual(planBump(root, "9.9.9", { note: "a | b" }).problems, ["--note must be one line without |"]);
  // Value (extension): protects=a hand-formatted manifest is edited only at its carrier keys (D4) and a bad --from or a
  // missing JSON carrier is refused; fails_when=the parse-equality guard is dropped so a nested non-carrier "version"
  // moves too, --from is not validated, or a missing manifest is skipped; why_new=only the clean text-edit path was
  // covered; seam=none; no_claim=none beyond protects
  const cli = "packages/cli/package.json";
  const cliText = readIn(root, cli);
  assert.notEqual(JSON.stringify(JSON.parse(cliText), null, 2) + "\n", cliText, "fixture must be hand-formatted");
  fs.writeFileSync(path.join(root, cli), cliText.replace(/\n}\s*$/, `,\n  "x": { "version": "${CURRENT}" }\n}\n`));
  assert.deepEqual(planBump(root, "9.9.9"), { writes: {}, problems: [`${cli}: cannot move its versions without reformatting it`] });
  fs.copyFileSync(path.join(ROOT, cli), path.join(root, cli));
  assert.deepEqual(planBump(root, "9.9.9", { from: "1.2" }).problems, ['--from "1.2" is not X.Y.Z']);
  fs.rmSync(path.join(root, SERVER_JSON));
  assert.deepEqual(planBump(root, "9.9.9"), { writes: {}, problems: [`${SERVER_JSON}: no such carrier file`] });
  fs.rmSync(root, { recursive: true, force: true });
});

// Value: protects=the queue rebump (VERSION already moved by gstack) and a renumber of an unreleased version;
// fails_when=--from is ignored, or --renumber prepends a second Lab entry or a second CHANGELOG heading;
// why_new=new options (TODO-094 D1, D2); seam=none; no_claim=gstack's queue pick itself
test("bump: --from moves carriers after VERSION moved; --renumber renames the unreleased entry and heading (TODO-094)", () => {
  const root = carrierRepo();
  apply(root, planBump(root, "9.9.9", { date: "2030-01-02" }).writes);
  for (const f of ["VERSION", "package.json"]) fs.writeFileSync(path.join(root, f), readIn(root, f).replace("9.9.9", "9.9.10"));
  assert.match(planBump(root, "9.9.10").problems[0], /is 9\.9\.9, not 9\.9\.10 or 9\.9\.10; if VERSION already moved, name the old version with --from$/);
  const { writes, problems } = planBump(root, "9.9.10", { from: "9.9.9", renumber: true, date: "2030-01-03", released: false });
  assert.deepEqual(problems, []);
  apply(root, writes);
  assert.deepEqual(planBump(root, "9.9.10", { from: "9.9.9", renumber: true, released: false }), { writes: {}, problems: [] });
  assert.deepEqual(versionProblems(root), []);
  assert.match(readIn(root, "docs/public-release.md"), new RegExp(`^\\| Lab version \\| 9\\.9\\.10 \\(see CHANGELOG\\.md; 2030-01-02\\); ${CURRENT.replace(/\./g, "\\.")} \\(`, "m"));
  const log = readIn(root, "CHANGELOG.md");
  assert.ok(log.includes("## [9.9.10] - 2030-01-02") && !log.includes("9.9.9"));
  fs.rmSync(root, { recursive: true, force: true });
});

// Value: protects=a missed carrier fails versions/docs:check in the lab and is skipped outside it; fails_when=a new
// carrier is unchecked, a lab carrier can vanish silently, or docs:check stops running the check; why_new=new carriers
// and wiring (TODO-094 T2, D6); seam=none; no_claim=CI's docs-check job (runs the same script)
test("versions: stale lockfile, Swift, golden, recipe, results and Lab row carriers are named; absent ones only in the lab (TODO-094)", () => {
  const root = carrierRepo();
  const edits = {
    "package-lock.json": (t) => t.replace(`"@catscan/core-js": "${CURRENT}"`, '"@catscan/core-js": "0.0.1"'),
    "core/Sources/CatscanCore/Model.swift": (t) => t.replace(`"${CURRENT}"`, '"0.0.1"'),
    "docs/recipes/maestro.md": (t) => t.replace(`catscan ${CURRENT}`, "catscan 0.0.1"),
    "docs/results.md": (t) => t.replace(`"catscan": "${CURRENT}"`, '"catscan": "0.0.1"'),
    "docs/public-release.md": (t) => t.replace(`| Lab version | ${CURRENT}`, "| Lab version | 0.0.1"),
  };
  for (const [f, edit] of Object.entries(edits)) fs.writeFileSync(path.join(root, f), edit(readIn(root, f)));
  const golden = carrierFiles(root, "test/golden/*/read.jsonl")[0];
  fs.writeFileSync(path.join(root, golden), readIn(root, golden).replaceAll(`"catscan":"${CURRENT}"`, '"catscan":"0.0.1"'));
  const got = versionProblems(root);
  assert.equal(got.length, 6, JSON.stringify(got));
  for (const want of ["package-lock.json packages[\"packages/cli\"].dependencies.@catscan/core-js is 0.0.1", "Model.swift catscanVersion is 0.0.1",
    `${golden} stamps catscan 0.0.1`, "maestro.md says Tested with catscan 0.0.1", "results.md baseline example catscan is 0.0.1", "Lab version row starts with 0.0.1"]) {
    assert.ok(got.some((p) => p.includes(want)), `no problem names "${want}" in ${JSON.stringify(got)}`);
  }
  for (const f of [...Object.keys(edits), golden]) fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  fs.rmSync(path.join(root, "core"), { recursive: true });
  assert.deepEqual(versionProblems(root), ["core/Sources/CatscanCore/Model.swift: no such carrier file"]);
  fs.rmSync(path.join(root, "scripts/public-paths.txt"));
  assert.deepEqual(versionProblems(root), []);
  const docsRoot = behaviorRepo(top(), { committed: released(OLD, 5) });
  for (const [f, t] of [["VERSION", "0.37.0\n"], ["package.json", '{ "version": "0.37.0" }\n'], ["TODOS.md", "# TODOs\n"], ["docs/INDEX.md", "# Index\n\n- [CLI](./cli.md)\n"]]) fs.writeFileSync(path.join(docsRoot, f), t);
  fs.writeFileSync(path.join(docsRoot, BEHAVIOR_FILE), buildBehaviorChanges(docsRoot).text);
  fs.mkdirSync(path.join(docsRoot, "scripts"));
  fs.writeFileSync(path.join(docsRoot, "scripts/public-paths.txt"), "docs/\n");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/docs-check.mjs"), "--root", docsRoot], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^core\/Sources\/CatscanCore\/Model\.swift: no such carrier file$/m);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(docsRoot, { recursive: true, force: true });
});

// Value: protects=the bump command a session runs writes the planned carriers and exits 0, refuses a stale carrier
// with exit 1 and no write, and a rerun reports nothing to do; fails_when=the CLI write loop skips or half-writes files,
// writes despite problems, or maps a stale carrier to exit 0/2; why_new=planBump tests stop before the CLI writes;
// seam=none (the script and its one local import are copied into a temp lab root, so ROOT is that root);
// no_claim=behavior-changes.json refresh (no BEHAVIOR_FILE in the fixture)
test("release-lib bump CLI: writes every carrier, exits 1 with no write on a stale one, rerun is a no-op (TODO-094)", () => {
  // Not realpath'd on purpose: os.tmpdir() is a symlink on macOS, so this also proves the CLI guard runs through one.
  const root = carrierRepo();
  for (const f of ["scripts/release-lib.mjs", "scripts/public-paths.mjs"]) fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  const run = (...args) => spawnSync(process.execPath, [path.join(root, "scripts/release-lib.mjs"), "bump", ...args], { encoding: "utf8" });
  const swift = "core/Sources/CatscanCore/Model.swift";
  const goodSwift = readIn(root, swift);
  fs.writeFileSync(path.join(root, swift), goodSwift.replace(`catscanVersion = "${CURRENT}"`, 'catscanVersion = "0.0.1"'));
  let r = run("9.9.9");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /release: nothing written/);
  assert.equal(readIn(root, "VERSION").trim(), CURRENT);
  fs.writeFileSync(path.join(root, swift), goodSwift);
  r = run("9.9.9", "--note", "test note");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^bump: 9\.9\.9 in \d+ files: /m);
  assert.match(r.stdout, /bump: next: npm run build/);
  assert.equal(readIn(root, "VERSION"), "9.9.9\n");
  assert.match(readIn(root, "docs/public-release.md"), /^\| Lab version \| 9\.9\.9 \(test note; \d{4}-\d\d-\d\d\); /m);
  assert.deepEqual(versionProblems(root), []);
  r = run("9.9.9");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^bump: every carrier already at 9\.9\.9$/m);
  fs.rmSync(root, { recursive: true, force: true });
});

// Value: protects=--renumber never renames a released version, and a malformed carrier or a missing CHANGELOG is a
// named problem with nothing written; fails_when=--renumber on a new release renames the released heading and Lab
// entry, or a bad file throws a stack; why_new=devex review D9, D11; seam=none; no_claim=none beyond protects
test("bump: --renumber is refused unless the newest release is the old version; a bad file is a named problem (TODO-094 D9, D11)", () => {
  const root = carrierRepo();
  // The fixture's newest heading is VERSION, as on main: released there, unreleased on a branch past main.
  let r = planBump(root, "9.9.9", { renumber: true, released: true });
  assert.deepEqual(r, { writes: {}, problems: [`--renumber renames only an unreleased ${CURRENT}, but origin/main's CHANGELOG already has its heading, so it is released; drop --renumber for a new release`] });
  assert.match(planBump(root, "9.9.9", { renumber: true, released: null }).problems[0], /git cannot read origin\/main/);
  assert.deepEqual(planBump(root, "9.9.9", { renumber: true, released: false, from: "0.0.2" }).problems,
    [`--renumber renames only an unreleased 0.0.2, but the newest CHANGELOG release is ${CURRENT}; drop --renumber for a new release`]);
  assert.ok(planBump(root, "9.9.9", { renumber: true, released: false }).writes["CHANGELOG.md"].includes("## [9.9.9]"));
  // gstack's rebump may already have moved the heading: the Lab entry is still renamed, not prepended.
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), readIn(root, "CHANGELOG.md").replace(`## [${CURRENT}]`, "## [9.9.9]"));
  r = planBump(root, "9.9.9", { renumber: true, released: false });
  assert.deepEqual(r.problems, []);
  assert.match(r.writes["docs/public-release.md"], /^\| Lab version \| 9\.9\.9 \(/m);
  assert.ok(!r.writes["docs/public-release.md"].includes("9.9.9 (see CHANGELOG.md"));
  fs.writeFileSync(path.join(root, PLUGIN_JSON), "{ not json");
  r = planBump(root, "9.9.9");
  assert.deepEqual(r.writes, {});
  assert.match(r.problems.join("\n"), new RegExp(`^${PLUGIN_JSON.replace(/\./g, "\\.")}: not valid JSON \\(.+\\); fix it, then rerun$`, "m"));
  fs.rmSync(path.join(root, "CHANGELOG.md"));
  assert.deepEqual(planBump(root, "9.9.9"), { writes: {}, problems: ["CHANGELOG.md cannot be read (ENOENT); restore it, then rerun"] });
  fs.rmSync(root, { recursive: true, force: true });
});

// Value: protects=bump never moves carriers back, and --renumber renames only a version origin/main's CHANGELOG
// lacks, even when the branch added its heading in a merge; fails_when=a lower target is accepted, a version main
// released is renamed, or a heading added by a merge resolution reads as released; why_new=final review (Codex) and
// its fix-check; seam=none; no_claim=a stale origin/main ref (the message says to fetch)
test("bump: an older target is refused; --renumber renames only a version origin/main has not released (TODO-094)", () => {
  const root = carrierRepo();
  assert.deepEqual(planBump(root, "0.0.1"), { writes: {}, problems: [`0.0.1 is older than ${CURRENT}; bump never moves carriers back`] });
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "main");
  assert.match(planBump(root, "9.9.9", { renumber: true }).problems[0], /git cannot read origin\/main/);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.match(planBump(root, "9.9.9", { renumber: true }).problems[0], /origin\/main's CHANGELOG already has its heading/);
  // main moves on; the branch takes the next version while resolving the merge, as after merging origin/main.
  git("checkout", "-qb", "side"); fs.writeFileSync(path.join(root, "side.txt"), "x\n"); git("add", "side.txt"); git("commit", "-qm", "side");
  git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-q", "-");
  git("merge", "-q", "--no-ff", "--no-commit", "origin/main");
  apply(root, planBump(root, "9.9.8").writes);
  git("commit", "-qam", "merge main; bump");
  const r = planBump(root, "9.9.9", { renumber: true });
  assert.deepEqual(r.problems, []);
  assert.ok(r.writes["CHANGELOG.md"].includes("## [9.9.9]") && !r.writes["CHANGELOG.md"].includes("## [9.9.8]"));
  fs.rmSync(root, { recursive: true, force: true });
});

// Value: protects=a usage error exits 2 before any write; fails_when=a bad version, a missing value or a flag as the
// value of --from/--note reaches planBump or writes; why_new=review: the earlier version ran on the real checkout;
// seam=none; no_claim=none beyond protects
test("release-lib bump: a bad or missing version or flag value exits 2 and writes nothing (TODO-094)", () => {
  const root = carrierRepo();
  for (const f of ["scripts/release-lib.mjs", "scripts/public-paths.mjs"]) fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  for (const args of [["bump"], ["bump", "1.2"], ["bump", "--from", "1.2.3"], ["bump", "9.9.9", "--note"], ["bump", "9.9.9", "--note", "--renumber"], ["bump", "9.9.9", "--from"]]) {
    const r = spawnSync(process.execPath, [path.join(root, "scripts/release-lib.mjs"), ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
  }
  assert.equal(readIn(root, "VERSION").trim(), CURRENT);
  const r = spawnSync(process.execPath, [path.join(root, "scripts/release-lib.mjs"), "bump", "9.9.9", "--note", "--json now prints X"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readIn(root, "docs/public-release.md"), /^\| Lab version \| 9\.9\.9 \(--json now prints X; /m);
  // --preserve-symlinks-main keeps the module URL unresolved; the guard must still run the CLI (review).
  const p = spawnSync(process.execPath, ["--preserve-symlinks-main", path.join(root, "scripts/release-lib.mjs"), "bump"], { encoding: "utf8" });
  assert.equal(p.status, 2, p.stderr);
  fs.rmSync(root, { recursive: true, force: true });
});
