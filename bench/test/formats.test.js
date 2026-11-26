// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-036 T3 bench (D33, D34): the synthetic plan's quotas and the one-to-one scoring, on hand-made findings. No Vision.
const test = require("node:test");
const assert = require("node:assert/strict");
const { plan, flip, matchScreen, CATEGORIES, QUOTA } = require("../formats");

test("plan: fixed seed, 600 screens, every category reaches its quota where it applies (D33)", () => {
  // Value: protects=D33 quotas and seeding scope; fails_when=a category starves, mixed lands on a storefront run or price on a stats screen; why_new=new script; seam=none; no_claim=drawing and Vision reads
  const screens = plan();
  assert.equal(screens.length, 600);
  const count = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const s of screens) {
    assert.ok(s.wants.length <= 3);
    assert.equal(new Set(s.wants).size, s.wants.length);
    for (const c of s.wants) count[c]++;
    if (s.wants.includes("mixed-currency")) assert.equal(s.storefront, null);
    if (s.wants.includes("currency")) assert.notEqual(s.storefront, null);
    if (s.wants.some((c) => ["amount", "period", "trial"].includes(c))) assert.ok(s.paywall);
    if (s.wants.includes("time")) assert.ok(!["en-US", "en-IN", "ko"].includes(s.locale), "12-hour locales get no time seed");
    assert.ok(s.wants.filter((c) => ["amount", "period", "trial"].includes(c)).length <= 1, "one price field per paywall");
  }
  for (const c of CATEGORIES) assert.ok(count[c] >= QUOTA * 0.85, `${c}: ${count[c]}`);
});

test("flip: the sign moves to the other side unless the storefront writes it there (D41)", () => {
  // Value: protects=placement seeds break exactly one rule; fails_when=a seed equals the storefront's own format; why_new=new script; seam=none; no_claim=none
  assert.equal(flip("9,99 €", { r: {} }), "€9,99");
  assert.equal(flip("$7.99", { r: {} }), "7.99 $");
  assert.equal(flip("$7.99", { r: { storeShape: "7,99 $" } }), null);
  assert.equal(flip("¥480", { r: { storeShape: "¥480" } }), "480 ¥");
});

test("matchScreen: one finding per seed by token; a misread currency sign matches by amount (D34)", () => {
  // Value: protects=D34 one-to-one scoring; fails_when=one finding satisfies two seeds, a finding on a correct token counts as found, or eligibility ignores the read; why_new=new script; seam=none; no_claim=none
  const seeds = [
    { cat: "number", token: "1,234.56", line: "Punkte 1,234.56" },
    { cat: "number", token: "9,876.54", line: "Gesamt 9,876.54" },
    { cat: "currency", token: "52,88 ₺", line: "Total 52,88 ₺" },
  ];
  const lines = ["Punkte 1,234.56", "Gesamt 9.876,54", "Total 52,88 ₽"];
  const { open, unmatched } = matchScreen(seeds, [
    { kind: "format", rule: "number", token: "1,234.56" },
    { kind: "format", rule: "number", token: "1,234.56" },
    { kind: "currency", rule: "unexpected", token: "52,88 ₽" },
  ], lines);
  assert.deepEqual(open.map((s) => [s.hit, s.eligible]), [[true, true], [false, false], [true, false]]);
  assert.deepEqual(unmatched.map((u) => u.f.token), ["1,234.56"], "the second identical finding is a false flag");
});
