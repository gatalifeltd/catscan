// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Value: protects=land-public stops when a landed file imports a lab path that does not land; fails_when=the check
// misses a static, dynamic or require import of a missing file, or flags a fixture import nobody has under --lab;
// why_new=1.0.0 landed bench/devices/android-profiles.mjs without its import and the product CI failed; seam=none;
// no_claim=computed specifiers (template strings, variables) are not checked
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "check-imports.mjs");
const tree = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-imports-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
};
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("a landed file importing a lab-only path fails; a fixture import nobody has passes under --lab", () => {
  const importer = [
    'import { a } from "../../scripts/helper.mjs";',
    'const b = await import("./dyn.mjs");',
    'const c = require("../lock.cjs");',
    'import "./side.js";',
    'export { d } from "./kept.js";',
    'import fs from "node:fs";',
  ].join("\n");
  const lab = tree({
    "bench/x/use.mjs": importer, "scripts/helper.mjs": "", "bench/x/dyn.mjs": "", "bench/lock.cjs": "",
    "bench/x/side.js": "", "bench/x/kept.js": "",
  });
  // A fixture's code sample may import a file nobody has.
  const sample = { "test/fixtures/code/en.ts": 'import { e } from "./fixture-missing.js";' };
  const out = tree({ "bench/x/use.mjs": importer, "bench/x/kept.js": "", "src/a.ts": 'import { t } from "./b.js";', "src/b.ts": "", ...sample });
  let r = run("--root", out, "--lab", lab);
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stderr.trim().split("\n");
  assert.deepEqual(lines.map((l) => l.match(/imports (\S+),/)[1]), ["../../scripts/helper.mjs", "./dyn.mjs", "../lock.cjs", "./side.js"]);
  assert.match(lines[0], /^check-imports: bench\/x\/use\.mjs: imports .*it exists in the lab/);
  // Without --lab every unresolved import is reported, the fixture import too.
  r = run("--root", out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fixture-missing\.js/);
  // Everything landed: clean, and a .ts file importing its sibling as .js resolves.
  for (const f of ["scripts/helper.mjs", "bench/x/dyn.mjs", "bench/lock.cjs", "bench/x/side.js", "test/fixtures/code/fixture-missing.js"]) {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.writeFileSync(path.join(out, f), "");
  }
  r = run("--root", out, "--lab", lab);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^check-imports: ok \(\d+ source files\)/);
  assert.equal(run("--root", out, "--lab").status, 2);
  fs.rmSync(lab, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test("the CLI checks from a path with a space and through a symlink, never a silent exit 0", () => {
  const bad = tree({ "a.mjs": 'import "./gone.mjs";' });
  const lab = tree({ "a.mjs": "", "gone.mjs": "" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan imports "));
  const spaced = path.join(dir, "check-imports.mjs");
  fs.copyFileSync(CLI, spaced);
  const linked = path.join(dir, "linked.mjs");
  fs.symlinkSync(CLI, linked);
  for (const script of [spaced, linked]) {
    const r = spawnSync(process.execPath, [script, "--root", bad, "--lab", lab], { encoding: "utf8" });
    assert.equal(r.status, 1, `${script}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /a\.mjs: imports \.\/gone\.mjs/);
  }
  for (const d of [bad, lab, dir]) fs.rmSync(d, { recursive: true, force: true });
});

// Value: protects=the guard resolves an import the way Node does for that importer; fails_when=a .js importer passes on
// a sibling .ts or an extensionless ESM path, which Node cannot load; why_new=outside review of the 1.0.1 guard;
// seam=none; no_claim=TypeScript path aliases and package exports maps are not resolved
test("a .js or .mjs importer needs the exact file; .ts and require() keep their own resolution", () => {
  const files = {
    "a.mjs": 'import { x } from "./helper.js";\nimport { y } from "./bare";',
    "helper.ts": "", "bare.js": "",
    "t.ts": 'import { x } from "./helper.js";\nimport { y } from "./bare";',
    "c.cjs": 'const z = require("./bare");',
  };
  const root = tree(files);
  const r = run("--root", root, "--lab", root);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.stderr.trim().split("\n").map((l) => l.replace(/, which.*/, "")),
    ["check-imports: a.mjs: imports ./helper.js", "check-imports: a.mjs: imports ./bare"]);
  fs.rmSync(root, { recursive: true, force: true });
});

// Value: protects=under --lab a dependency deleted or renamed in both trees still stops the land; fails_when=--lab skips
// every import missing from both trees; why_new=outside review of the 1.0.1 guard; seam=none; no_claim=a test file's
// own missing import is left to the test run
test("under --lab an import missing from both trees fails unless the importer is a fixture or a test file", () => {
  const files = {
    "scripts/tool.mjs": 'import { gone } from "./renamed.mjs";',
    "test/fixtures/sample.ts": 'import { gone } from "./types";',
    "scripts/test/tool.test.mjs": 'const sample = `import { gone } from "./nowhere.js";`;',
  };
  const out = tree(files);
  const lab = tree(files);
  const r = run("--root", out, "--lab", lab);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr.trim(), "check-imports: scripts/tool.mjs: imports ./renamed.mjs, which is in neither tree (a deleted or renamed dependency?)");
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(lab, { recursive: true, force: true });
});
