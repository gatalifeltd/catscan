// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 05 image plan.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../languages/plan");

const S = Array.from({ length: 60 }, (_, i) => `string ${i}`);

test("full plan: 36 variants per string, every case and variant once", () => {
  const items = P.plan("de", { strings: S });
  assert.equal(items.length, 60 * 36);
  assert.equal(new Set(items.map((i) => i.name)).size, items.length);
  const one = items.filter((i) => i.index === 0);
  assert.equal(one.length, 36);
  for (const c of P.CASES) assert.equal(one.filter((i) => i.case === c).length, 12);
  assert.deepEqual([...new Set(one.map((i) => i.size))], P.SIZES);
});

test("quick plan: 10 strings x 3 cases in the 16 px light flat variant", () => {
  const items = P.plan("de", { quick: true, strings: S });
  assert.equal(items.length, 30);
  assert.ok(items.every((i) => i.size === 16 && i.theme === "light" && i.background === "flat"));
  assert.equal(P.timed(items).length, 10);
  assert.ok(P.timed(items).every((i) => i.case === "fit"));
  assert.equal(P.timed(P.plan("de", { strings: S })).length, 10); // the full run times the same 10 images
});

test("the absent string is the next string of the same language", () => {
  const items = P.plan("de", { strings: S });
  assert.ok(items.every((i) => i.absent !== i.text && S.includes(i.absent)));
  assert.equal(items.find((i) => i.index === 59).absent, S[0]);
});

test("right to left: ar, ars, he and fa", () => {
  for (const l of ["ar", "ars", "he", "fa"]) assert.ok(P.plan(l, { quick: true, strings: S })[0].rtl, l);
  for (const l of ["de", "ja", "el"]) assert.ok(!P.plan(l, { quick: true, strings: S })[0].rtl, l);
});

test("--lang filters, matches case-insensitively and names the closest for an unknown locale", () => {
  assert.equal(P.locales(null).length, 61);
  assert.deepEqual(P.locales("de, JA,de"), ["de", "ja"]);
  assert.throws(() => P.locales("deu"), (e) => e.exit === 2 && /closest: de/.test(e.message));
  assert.throws(() => P.locales("pt-br,zh-hanz"), (e) => e.exit === 2 && /zh-Hans/.test(e.message));
  assert.throws(() => P.locales(","), (e) => e.exit === 2);
});

test("the gated set is en, the 12 study locales, el, he, bg and the TODO-037 locales", () => {
  assert.equal(P.GATED.length, 40);
  for (const l of P.GATED) assert.ok(require("../corpus/build").LOCALES.includes(l), `${l} has a corpus`);
  for (const l of ["en", "zh-Hans", "pt-BR", "el", "he", "bg"]) assert.ok(P.GATED.includes(l));
});
