// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 05 corpus: the string rules, the committed files and the seeded draw.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const corpus = require("../corpus/build");
const { rules, bounds } = require("../corpus/rules");

test("rules: grapheme bounds per script", () => {
  assert.deepEqual(bounds("de"), [4, 40]);
  assert.deepEqual(bounds("zh-Hans"), [2, 40]);
  assert.deepEqual(bounds("th"), [2, 40]);
  assert.equal(rules(["Uhr"], "de").length, 1); // 3 graphemes
  assert.equal(rules(["時間"], "ja").length, 0);
  assert.equal(rules(["時"], "ja").length, 1);
  assert.equal(rules(["x".repeat(41)], "en").length, 1);
  // A Devanagari conjunct counts as one grapheme cluster: "क्षत्र" is 3, so it is too short for hi.
  assert.equal(rules(["क्षत्र"], "hi").length, 1);
});

test("rules: duplicates after normalization and substring pairs", () => {
  assert.match(rules(["Settings", "SETTINGS"], "en").join(), /repeats/);
  assert.match(rules(["Open settings", "settings"], "en").join(), /is inside/);
  assert.match(rules(["Line\nbreak"], "en").join(), /line break/);
  assert.deepEqual(rules(["Sweden", "Finland"], "en"), []);
});

test("every committed corpus file passes the rules and names its source", () => {
  const sources = fs.readFileSync(path.join(__dirname, "../corpus/SOURCES.md"), "utf8");
  assert.equal(corpus.LOCALES.length, 61);
  for (const l of corpus.LOCALES) {
    const j = JSON.parse(fs.readFileSync(corpus.file(l), "utf8"));
    assert.equal(j.locale, l);
    assert.equal(j.strings.length, corpus.PER, l);
    assert.deepEqual(rules(j.strings.map((s) => s.text), l), [], l);
    for (const k of ["source", "license", "node", "icu", "cldr", "seed"]) assert.ok(j[k], `${l}: ${k}`);
    assert.equal(j.license, "Unicode License v3");
    assert.ok(sources.includes(`${l}.json`), `SOURCES.md names ${l}.json`);
  }
});

test("the draw is seeded: the same ICU draws the same strings", () => {
  for (const l of ["de", "ja", "ar", "hy"]) {
    assert.deepEqual(corpus.draw(l), corpus.draw(l));
    const j = JSON.parse(fs.readFileSync(corpus.file(l), "utf8"));
    // Another Node may ship another ICU, whose CLDR names differ; then only the committed file counts (D2).
    if (j.icu === process.versions.icu) assert.deepEqual(corpus.draw(l), j.strings, l);
  }
});
