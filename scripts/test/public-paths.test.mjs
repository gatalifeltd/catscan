// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 25 D1, D16: the allowlist and the public/ overlay decide what lands; never-public paths are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { landPlan, parseAllowlist } from "../public-paths.mjs";

const FILES = ["README.md", "core/a.swift", "core/b/c.swift", "scripts/check-a.mjs", "scripts/check-a/x.mjs", "scripts/premerge.sh",
  "docs/specs/25-x.md", "ROADMAP.md", "AGENTS.md", ".github/workflows/docs.yml", "public/CONTRIBUTING.md", "public/.github/workflows/ci.yml"];

test("files, directories and one-segment patterns land; overlay files land at the root", () => {
  const plan = landPlan(parseAllowlist("# comment\nREADME.md\ncore/\nscripts/check-*.mjs\n"), FILES);
  assert.deepEqual(plan.map((p) => `${p.src}>${p.dest}`), [
    "public/.github/workflows/ci.yml>.github/workflows/ci.yml", "public/CONTRIBUTING.md>CONTRIBUTING.md", "README.md>README.md",
    "core/a.swift>core/a.swift", "core/b/c.swift>core/b/c.swift", "scripts/check-a.mjs>scripts/check-a.mjs",
  ]);
});

test("a never-public path on the allowlist is refused", () => {
  for (const entry of ["docs/", "ROADMAP.md", "AGENTS.md", ".github/"]) {
    assert.throws(() => landPlan(parseAllowlist(entry), FILES), /never-public/, entry);
  }
});

test("an overlay file that collides with an allowlisted path stops the plan", () => {
  assert.throws(() => landPlan(parseAllowlist("README.md\n"), ["README.md", "public/README.md"]), /overlay-collision: .*README\.md/);
});

test("an overlay file may not land at a never-public path", () => {
  assert.throws(() => landPlan(parseAllowlist("README.md\n"), ["README.md", "public/AGENTS.md"]), /never-public: public\/AGENTS\.md/);
});

test("an entry that matches nothing is stale; absolute and parent paths are refused", () => {
  assert.throws(() => landPlan(parseAllowlist("README.md\ngone/\n"), FILES), /stale-entry: .*gone\//);
  assert.throws(() => parseAllowlist("/etc/passwd"), /bad entry/);
  assert.throws(() => parseAllowlist("core/../AGENTS.md"), /bad entry/);
});

// Value: protects=the land plan the CLI prints for land-public.sh from a git ref (allowlist and file list both read at the ref, "<src>\t<dest>" lines, exit 1 on a refused plan); fails_when=--ref is ignored and the index leaks in, the output format changes, or an error exits 0; why_new=tests call landPlan with in-memory lists and never readAllowlist/trackedFiles or the CLI; seam=none; no_claim=land-public.sh itself
test("the CLI prints the plan at a git ref and exits 1 on a refused plan", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const cli = new URL("../public-paths.mjs", import.meta.url).pathname;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-paths-"));
  const write = (f, body) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), body); };
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: root });
  write("scripts/public-paths.txt", "README.md\n");
  write("README.md", "x\n");
  write("public/SECURITY.md", "x\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "c");
  write("scripts/public-paths.txt", "README.md\nROADMAP.md\n");
  write("ROADMAP.md", "x\n");
  git("add", ".");
  const atRef = spawnSync(process.execPath, [cli, "--root", root, "--ref", "HEAD"], { encoding: "utf8" });
  assert.equal(atRef.status, 0, atRef.stderr);
  assert.equal(atRef.stdout, "README.md\tREADME.md\npublic/SECURITY.md\tSECURITY.md\n");
  const index = spawnSync(process.execPath, [cli, "--root", root], { encoding: "utf8" });
  assert.equal(index.status, 1);
  assert.match(index.stderr, /never-public: ROADMAP\.md/);
  assert.equal(index.stdout, "");
});

// Value: protects=lab-only tools under a landing folder never land (bench/overlap/lab/, spec 25 D21); fails_when=bench/ copies a lab/ folder or the skip fails the whole plan; why_new=the capture script for the owner's games moved there; seam=none; no_claim=none
test("a lab/ folder under bench/ never lands, even though bench/ does", () => {
  const plan = landPlan(parseAllowlist("bench/\n"), ["bench/a.js", "bench/overlap/lab/capture.mjs", "bench/lab/x.js", "bench/overlap/lab.js"]);
  assert.deepEqual(plan.map((p) => p.dest), ["bench/a.js", "bench/overlap/lab.js"]);
});
