// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-077 "Finding registry" (D7, D13, D14): a row per schema kind and rule per reader, certainty recomputed from the
// rule, every results/ source resolving to its stored number, and the docs/cli.md band table generated from it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const scale = require("../src/scale");
const { canonical } = require("../src/results");

const ROOT = path.join(__dirname, "../../..");
const REG = require("../src/findings-registry.json");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "core/schema/result.schema.json"), "utf8"));
const READERS = ["vision", "tesseract"];

const keyOf = (k, r) => `${k}\0${r}`;
const keys = new Set(REG.keys.map(([k, r]) => keyOf(k, r)));

test("registry: one row per key per reader, and no other row", () => {
  assert.equal(keys.size, REG.keys.length, "duplicate keys");
  const rows = REG.rows.map((r) => `${r.kind}\0${r.rule}\0${r.reader}`);
  assert.equal(new Set(rows).size, rows.length, "duplicate rows");
  const want = REG.keys.flatMap(([k, r]) => READERS.map((rd) => `${k}\0${r}\0${rd}`));
  assert.deepEqual([...rows].sort(), [...want].sort());
  for (const r of REG.rows) {
    assert.ok(scale.SEVERITIES.includes(r.severity), `${r.kind} ${r.rule}: severity ${r.severity}`);
    // D3: severity does not depend on the reader.
    const other = REG.rows.find((x) => x.kind === r.kind && x.rule === r.rule && x.reader !== r.reader);
    assert.equal(other.severity, r.severity, `${r.kind} ${r.rule}: severity differs by reader`);
  }
});

test("registry: every schema kind, reason, signal, evidence, field and if/then rule is in a key (D13, D25)", () => {
  const f = schema.definitions.finding;
  const ruled = new Set(REG.keys.map(([, r]) => r));
  const kinds = new Set(REG.keys.map(([k]) => k));
  for (const k of f.properties.kind.enum) assert.ok(kinds.has(k), `kind ${k} has no key`);
  // TODO-074: fit wrapped's evidence (declared, control; null for orphan) is scored under the rule wrapped, not a key.
  const sub = new Set([null, "declared", "control"]);
  for (const p of ["reason", "signal", "evidence", "field"]) for (const v of f.properties[p].enum) assert.ok(ruled.has(v) || (p === "evidence" && sub.has(v)), `${p} ${v} has no key`);
  // `rule` is a free string: its values live in the kind's if/then block.
  for (const b of f.allOf) {
    const kind = b.if?.properties?.kind?.const;
    const rules = b.then?.properties?.rule?.enum;
    if (!kind || !rules) continue;
    for (const r of rules) assert.ok(keys.has(keyOf(kind, r)), `${kind} rule ${r} has no key`);
  }
  for (const k of schema.definitions.check.properties.kind.enum) assert.ok(keys.has(keyOf("check", k)), `check ${k} has no key`);
});

test("registry: each finding in the integration goldens matches a key", () => {
  const dir = path.join(ROOT, "test/golden");
  const found = [];
  const walk = (v, isCheck) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, isCheck));
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "findings" && Array.isArray(x)) for (const f of x) found.push(keyOf(f.kind, scale.ruleOf(f, false)));
      else if (k === "checks" && Array.isArray(x)) for (const c of x) found.push(keyOf("check", scale.ruleOf(c, true)));
      else walk(x);
    }
  };
  for (const host of fs.readdirSync(dir)) {
    const p = path.join(dir, host);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      const text = fs.readFileSync(path.join(p, f), "utf8");
      for (const line of f.endsWith(".jsonl") ? text.split("\n").filter(Boolean) : [text]) walk(JSON.parse(line));
    }
  }
  for (const k of found) assert.ok(keys.has(k), `golden finding ${k.replace("\0", " ")} has no key`);
});

test("registry: stored certainty is the rule's result for every row", () => {
  for (const r of REG.rows) assert.equal(r.certainty, scale.certaintyOf(r).certainty, `${r.kind} ${r.rule} ${r.reader}`);
});

test("registry: each results/ source pointer resolves to the stored number", () => {
  const read = (src) => {
    const [file, pointer] = src.split("#");
    const obj = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
    return pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((o, k) => o[k], obj);
  };
  let n = 0;
  for (const r of REG.rows) {
    for (const leg of [r.synthetic, r.real]) {
      if (!leg) continue;
      const [file, anchor] = leg.source.split("#");
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${r.kind} ${r.rule}: ${file} missing`);
      if (file.startsWith("results/")) {
        assert.equal(Math.round(read(leg.source) * 1000) / 1000, Math.round(leg.precision * 1000) / 1000, `${r.kind} ${r.rule}: ${leg.source}`);
        n++;
      } else if (anchor) {
        // A hand-reviewed count: the anchor must be a heading of that file.
        const heads = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").filter((l) => /^#+ /.test(l))
          .map((l) => l.replace(/^#+ /, "").toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-"));
        assert.ok(heads.includes(anchor), `${r.kind} ${r.rule}: ${file}#${anchor} is no heading`);
      }
    }
  }
  assert.ok(n > 20, "most rows come from a results file");
});

test("certainty rule: bands, the unrounded value, tuned and small real sets, experimental and unmeasured (D2, D14)", () => {
  const syn = (p) => ({ precision: p, flags: 100, source: "x" });
  const real = (p, flags, tuned = false) => ({ precision: p, flags, tuned_on: tuned, source: "x" });
  const c = (row) => scale.certaintyOf({ experimental: false, synthetic: null, real: null, ...row });
  assert.equal(c({ synthetic: syn(1) }).certainty, "medium", "synthetic alone never gives high");
  assert.equal(c({ synthetic: syn(0.9) }).certainty, "medium");
  assert.equal(c({ synthetic: syn(0.8999) }).certainty, "low");
  assert.equal(c({ real: real(0.9496, 50) }).certainty, "medium", "0.9496 prints 0.950 but is medium");
  assert.equal(c({ real: real(0.95, 50) }).certainty, "high");
  assert.equal(c({ real: real(0.8, 20) }).certainty, "medium");
  assert.equal(c({ real: real(0.79, 20) }).certainty, "low");
  assert.deepEqual(c({ synthetic: syn(0.998), real: real(0, 3) }), { certainty: "medium", precision: 0.998 }, "under 20 real flags: synthetic step");
  assert.deepEqual(c({ synthetic: syn(1), real: real(1, 42, true) }), { certainty: "medium", precision: 1 }, "tuned on: synthetic step");
  assert.deepEqual(c({ experimental: true, synthetic: syn(1) }), { certainty: "low", precision: null });
  assert.deepEqual(c({}), { certainty: "low", precision: null });
  assert.deepEqual(c({ deterministic: true }), { certainty: "high", precision: null });
});

test("registry id: 12 hex digits, stable across key order", () => {
  const id = scale.registryId();
  assert.match(id, /^[0-9a-f]{12}$/);
  const shuffled = JSON.parse(JSON.stringify(REG, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
  assert.equal(canonical(shuffled), canonical(REG));
});

test("docs/cli.md: the band table equals the one generated from the registry", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs/cli.md"), "utf8");
  const start = doc.indexOf("<!-- bands:start -->"), end = doc.indexOf("<!-- bands:end -->");
  assert.ok(start >= 0 && end > start, "docs/cli.md has no bands markers");
  assert.equal(doc.slice(start + "<!-- bands:start -->".length, end).trim(), scale.bandTable().join("\n"));
});
