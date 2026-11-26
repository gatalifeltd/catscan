// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 15 D8: GitLab Code Quality entries, validated against the vendored schema of GitLab's documented fields.
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const ci = require("../src/ci");
const F = require("./fixtures/ci-envelopes");

const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../../../test/fixtures/ci/codequality.schema.json"));

test("codequality: one major entry per failed check or finding, critical per error or unsupported input", () => {
  const cq = ci.codequality([F.passCheck, F.failCheck, F.skippedCheck, F.errorInput, F.unsupportedInput, F.truncatedFail, F.missing("ja/paywall")]);
  assert.ok(validate(cq), JSON.stringify(validate.errors));
  assert.deepEqual(cq.map((e) => [e.location.path, e.check_name, e.severity]), [
    ["shots/de/paywall.png", "catscan/present", "major"],
    ["shots/de/paywall.png", "catscan/absent", "major"],
    ["shots/fr/broken.png", "catscan/error", "critical"],
    ["shots/el/home.png", "catscan/unsupported", "critical"],
    ["shots/de/home.png", "catscan/truncated", "major"],
    ["shots/de/home.png", "catscan/truncated", "major"],
    ["ja/paywall", "catscan/missing", "major"],
  ]);
  for (const e of cq) {
    assert.equal(e.location.lines.begin, 1);
    assert.match(e.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(e.description.startsWith(`${e.location.path}: `));
  }
  assert.equal(cq[2].description, "shots/fr/broken.png: unreadable-image: not an image");
});

test("codequality: fingerprints are stable, distinct for equal findings, and ignore OCR drift on a check", () => {
  const a = ci.codequality([F.failCheck, F.truncatedFail]);
  const b = ci.codequality([F.failCheck, F.truncatedFail]);
  assert.deepEqual(a.map((e) => e.fingerprint), b.map((e) => e.fingerprint));
  // Two equal findings on one screen keep two entries.
  assert.notEqual(a[2].fingerprint, a[3].fingerprint);
  assert.equal(new Set(a.map((e) => e.fingerprint)).size, a.length);
  // A check keyed by its expected text: a different closest or shown line keeps the fingerprint.
  const drift = structuredClone(F.failCheck);
  drift.checks[1].line = "KEY_sell";
  drift.checks[0].closest = { line: "Weitr", distance: 1, box: [0, 0, 1, 1] };
  const c = ci.codequality([drift]);
  assert.deepEqual(c.map((e) => e.fingerprint), a.slice(0, 2).map((e) => e.fingerprint));
  assert.notEqual(c[1].description, a[1].description);
  // Another path is another entry.
  const moved = ci.codequality([{ ...F.failCheck, path: "shots/de/other.png" }]);
  assert.notEqual(moved[0].fingerprint, a[0].fingerprint);
});

test("codequality: an abs: path from spec 27 D9 is kept as the location", () => {
  const cq = ci.codequality([{ ...F.errorInput, path: "abs:shots/x.png" }]);
  assert.equal(cq[0].location.path, "abs:shots/x.png");
  assert.ok(validate(cq));
  assert.deepEqual(ci.codequality([F.passCheck]), []);
});
