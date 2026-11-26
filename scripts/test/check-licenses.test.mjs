// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 25 third-party licenses: allowed SPDX IDs pass, copyleft, source-available and unknown licenses fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check, isAllowed } from "../check-licenses.mjs";

const node = (license, deps) => ({ version: "1.0.0", license, ...(deps ? { dependencies: deps } : {}) });

test("a tree with each allowed license passes, nested and deduplicated", () => {
  const ids = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "Unicode-3.0"];
  const deps = Object.fromEntries(ids.map((id, i) => [`p${i}`, node(id)]));
  deps.p0.dependencies = { p1: node("ISC"), nested: node("(MIT OR Apache-2.0)") };
  const r = check({ dependencies: deps });
  assert.deepEqual(r.bad, []);
  assert.equal(r.count, ids.length + 1);
});

test("GPL, LGPL, AGPL, SSPL, BUSL, a missing field and a disallowed part of an expression fail", () => {
  const deps = { a: node("GPL-3.0-only"), b: node("LGPL-2.1"), c: node("AGPL-3.0"), d: node("SSPL-1.0"), e: node("BUSL-1.1"),
    f: { version: "1.0.0" }, g: node("MIT AND GPL-2.0"), h: node({ type: "MIT" }), i: { version: "1.0.0", licenses: [{ type: "MIT" }, { type: "GPL-2.0" }] } };
  const bad = check({ dependencies: deps }).bad.map((b) => `${b.name}:${b.license}`);
  assert.deepEqual(bad, ["a:GPL-3.0-only", "b:LGPL-2.1", "c:AGPL-3.0", "d:SSPL-1.0", "e:BUSL-1.1", "f:missing", "g:MIT AND GPL-2.0", "i:MIT AND GPL-2.0"]);
});

test("dev-only, extraneous and uninstalled optional peers are ignored", () => {
  const r = check({ dependencies: { a: { ...node("GPL-3.0"), dev: true }, b: { ...node("GPL-3.0"), extraneous: true }, c: {} } });
  assert.deepEqual(r.bad, []);
  assert.equal(isAllowed(""), false);
  assert.equal(isAllowed("Apache-2.0 WITH LLVM-exception"), false);
});

// Value: protects=the CI contract of check-licenses (exit 1 naming the package, 0 when clean) and the package.json fallback when npm ls omits the license; fails_when=the CLI prints a bad license but exits 0, --tree is ignored, or a node without a license field reads as missing although its package.json has one; why_new=tests call check() only and every fixture carries the license inline; seam=none; no_claim=real npm ls output shape
test("the CLI exits 1 on a disallowed license and falls back to the package's package.json", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const cli = new URL("../check-licenses.mjs", import.meta.url).pathname;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-lic-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ license: "MIT" }));
  const save = (name, tree) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(tree)); return f; };
  const ok = spawnSync(process.execPath, [cli, "--tree", save("ok.json", { dependencies: { a: { version: "1.0.0", path: dir } } })], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /check-licenses: ok \(1 shipped packages/);
  const bad = spawnSync(process.execPath, [cli, "--tree", save("bad.json", { dependencies: { g: node("GPL-3.0-only") } })], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /g@1\.0\.0: license GPL-3\.0-only is not allowed/);
});

// Value: protects=every shipped package is license-checked; fails_when=a deduped stub seen first hides the full node's children; why_new=no fixture had a stub before its full node (review finding, 37 of 97 checked); seam=none; no_claim=none beyond protects
test("a deduped stub before the full node does not hide its children", () => {
  const r = check({ dependencies: { a: node("MIT", { x: node("MIT") }), x: node("MIT", { gpl: node("GPL-3.0-only") }) } });
  assert.deepEqual(r.bad.map((b) => b.name), ["gpl"]);
  assert.equal(r.count, 3);
});
