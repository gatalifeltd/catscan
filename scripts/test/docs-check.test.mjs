// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 25 D20: `docs-check --public` checks only em dashes and links, on a land export with no .git, no docs index,
// no TODOS.md and no specs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs-check.mjs");
const DASH = String.fromCharCode(0x2014);
const exportDir = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-docs-public-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
};
const run = (root) => spawnSync(process.execPath, [CLI, "--public", "--root", root], { encoding: "utf8" });

// Value: protects=product docs keep working links and no em dash without the lab-only index, TODOS and specs; fails_when=--public still requires docs/INDEX.md or TODOS.md, misses a link into a path that never lands, or misses an em dash; why_new=--public is new; seam=none; no_claim=links to the web
test("--public passes a clean export and flags a link that did not land and an em dash", () => {
  const ok = exportDir({ "README.md": "See [the CLI](docs/cli.md) and [site](https://example.com).\n", "docs/cli.md": "# CLI\n" });
  const r = run(ok);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /docs:check --public ok \(2 markdown files\)/);
  const bad = exportDir({ "README.md": `See [the spec](docs/specs/25-x.md) ${DASH} soon.\n` });
  const b = run(bad);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /README\.md: broken link docs\/specs\/25-x\.md/);
  assert.match(b.stderr, /README\.md:1: em dash/);
});
