// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// catscan-adopt's find-points against the real, built catscan (TODO-065 T7). It lives here, not in
// test/skills/, because it needs `npm ci` and `npm run build`: the macOS job has both, while the docs job runs
// skills:check without either, where find-points would only note that it could not reach catscan.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT } = require("./helpers");

const FIND_POINTS = path.join(ROOT, "plugins/catscan/skills/catscan-adopt/scripts/find-points.mjs");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, env: gitEnv, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };

test("find-points with the real catscan: doctor names the reader and the override fix (TODO-065 T7)", (t) => {
  // Value: protects=the contract between find-points and the real doctor --expect-locales --json; fails_when=a row field or fallback.fix moves, or catscan cannot be reached (notes); why_new=T7; seam=CATSCAN_TESSERACT; no_claim=a real install
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-real-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  for (const f of ["android/res/values-hr/strings.xml", "android/res/values-de/strings.xml"]) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), "<resources/>");
  }
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const catscan = JSON.stringify([process.execPath, path.join(ROOT, "bin", "catscan.js")]);
  const r = spawnSync(process.execPath, [FIND_POINTS, repo, "--catscan", catscan], {
    encoding: "utf8",
    env: { ...process.env, CATSCAN_TESSERACT: "/nonexistent/tesseract", TESSDATA_PREFIX: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  // First: a find-points that could not run catscan or load its discovery says so here, so this never passes empty.
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.locales.map((l) => [l.locale, l.reader, l.reads_now, l.error?.code ?? null]), [["de", "vision", true, null], ["hr", "tesseract", false, "reader-missing"]]);
  assert.equal(out.setup.override, "CATSCAN_TESSERACT");
  assert.equal(out.setup.command, null);
  assert.match(out.setup.fix, /^CATSCAN_TESSERACT=\/nonexistent\/tesseract is not a working tesseract/);
});

const LIST_CHECKS = path.join(ROOT, "plugins/catscan/skills/catscan-adopt/scripts/list-checks.mjs");

test("list-checks with the real catscan: every check parses with catscan's own parser, also through a symlinked bin (TODO-086 D9)", (t) => {
  // Value: protects=each command line the skill proposes is valid for this catscan; fails_when=a BIND opt-in, need flag or value is wrong for its command, or the registry moves; why_new=D9; seam=none; no_claim=what each check finds
  const run = (cmd) => spawnSync(process.execPath, [LIST_CHECKS, "--catscan", JSON.stringify(cmd)], { encoding: "utf8" });
  const r = run([process.execPath, path.join(ROOT, "bin", "catscan.js")]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.unmapped, out.missing_in_catscan, out.notes], [[], [], []]);
  assert.equal(out.catscan, require("../packages/core-js/package.json").version);
  assert.equal(out.registry, require("../packages/core-js/src/scale").registryId());
  const { parse } = require("../packages/core-js/src/args");
  const lists = { "--reasons": require("../packages/core-js/src/fit").REASONS, "--rules": require("../packages/core-js/src/formats").RULES };
  const value = { "--expect": "e.yaml", "--catalog": "c.json", "--base": "b.json", "--languages": "de,fr", "--boxes": "shots", "--layout": "{locale}/{screen}",
    "--device-profile": "pixel-9", "--storefront": "DE", "--prices": "p.json", "--pseudo": null };
  for (const g of out.commands) {
    const needs = [...new Set(g.checks.flatMap((c) => c.needs).map((n) => n.split("|")[0]))];
    const flags = needs.map((n) => out.needs[n].flag).filter((f) => !g.opt_in.includes(f));
    const argv = [g.command, "shots", ...g.opt_in, ...flags.flatMap((f) => (value[f] === null ? [f] : [f, value[f]]))];
    assert.doesNotThrow(() => parse(argv), argv.join(" "));
    g.opt_in.forEach((a, i) => { if (lists[a]) for (const v of g.opt_in[i + 1].split(",")) assert.ok(lists[a].includes(v), `${g.command} ${a} ${v}`); });
  }
  // The local and global forms: find-catscan prints a symlinked bin path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(ROOT, "packages/cli/bin/catscan.js"), path.join(dir, "catscan"));
  const s = run([path.join(dir, "catscan")]);
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(JSON.parse(s.stdout).commands, out.commands);
});
