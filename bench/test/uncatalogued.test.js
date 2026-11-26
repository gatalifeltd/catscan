// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-036 T4: the synthetic set's plan and scoring (D47, D54), without drawing or Vision.
const test = require("node:test");
const assert = require("node:assert/strict");
const { screens, score, summary, tally, floor, rng, LOCALES } = require("../uncatalogued");

test("plan: each seed on at most 2 screens, every dynamic row carries its guard, enough positives (D47, D54)", () => {
  // Value: protects=D47 unique seeds and D54 guards; fails_when=a seed repeats past 2 screens, a name/user row is not an element, or positives fall under 50 per locale; why_new=new script; seam=none; no_claim=drawing and Vision reads
  const rand = rng(36004);
  for (const l of LOCALES) {
    const { list, counts } = screens(l, rand);
    const seen = new Map();
    for (const s of list) for (const r of s.rows) {
      if (r.kind === "seed") seen.set(r.text, (seen.get(r.text) || 0) + 1);
      if (r.kind === "name" || r.kind === "user") assert.equal(r.element, true, `${l} ${r.text}`);
    }
    assert.ok([...seen.values()].every((n) => n <= 2), l);
    assert.ok(counts.seeds + counts.near >= 40, `${l}: ${counts.seeds + counts.near}`);
    assert.ok(counts.dynamic >= 100, `${l}: ${counts.dynamic} dynamic rows`);
  }
});

test("score: one finding per positive, by line; eligibility needs a read line and the floor (D47, D49)", () => {
  // Value: protects=the gate's arithmetic; fails_when=two findings claim one seed, a catalog line counts as a hit, or an unread seed counts as eligible; why_new=new script; seam=none; no_claim=none
  const s = { name: "x.png", rows: [{ text: "Tägliche Belohnung abholen", kind: "seed" }, { text: "Hallo, Anna", kind: "catalog" }, { text: "Neue Freunde finden heute", kind: "seed" }] };
  const t = tally();
  const env = { findings: [{ kind: "uncatalogued", line: "Tägliche Belohnung abholen" }, { kind: "uncatalogued", line: "Tagliche Belohnung abholen" }, { kind: "uncatalogued", line: "Hallo, Anna" }] };
  score(env, s, ["Tägliche Belohnung abholen", "Hallo, Anna"], t, "de");
  const r = summary(t, { precision: 0.95, recall: 0.8 });
  assert.deepEqual([r.tp, r.fp, r.eligible, r.recall, r.recall_all], [1, 2, 1, 1, 0.5]);
  assert.deepEqual(r.false_positives_by_kind, { seed: 1, catalog: 1 });
  assert.equal(floor("OK"), false);
  assert.equal(floor("Freunde finden"), true);
});
