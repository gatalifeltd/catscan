// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-036 T5a: the synthetic set's plan and scoring, without drawing or Vision.
const test = require("node:test");
const assert = require("node:assert/strict");
const { plan, runsOf, score, tally } = require("../glyphs");

test("plan: deterministic, both sources, every seed draws tofu only on the seeded characters", () => {
  // Value: protects=the T5a set is reproducible and labeled by construction; fails_when=a seed's tofu runs differ from its chars, a group lacks seeds or a source, or two plans differ; why_new=new script; seam=none; no_claim=drawing and Vision reads
  const a = plan(), b = plan();
  assert.deepEqual(a, b);
  const groups = new Map();
  for (const s of a.screens) {
    const g = groups.get(s.group) || { seeds: 0, sources: new Set() };
    g.seeds += s.seeds.length;
    g.sources.add(s.source);
    groups.set(s.group, g);
    for (const sd of s.seeds) {
      const tofu = s.lines[sd.el].runs.filter((r) => r.mode !== "clean").map((r) => r.text).join("");
      assert.equal(tofu, sd.chars.join(""), `${s.name} e${sd.el}`);
    }
    if (s.group === "control") assert.equal(s.seeds.length, 0);
  }
  for (const [g, x] of groups) {
    assert.deepEqual([...x.sources].sort(), ["boxes", "catalog"], g);
    if (g !== "control") assert.ok(x.seeds >= 20, `${g}: ${x.seeds} seeds`);
  }
});

test("runsOf keeps spaces clean and merges neighbours", () => {
  // Value: protects=a space between tofu words is drawn as a space; fails_when=spaces become tofu or runs fragment; why_new=new script; seam=none; no_claim=rendering
  assert.deepEqual(runsOf("Pro Цена ок", (ch, i) => i >= 4, "box"), [
    { text: "Pro ", mode: "clean" }, { text: "Цена", mode: "box" }, { text: " ", mode: "clean" }, { text: "ок", mode: "box" },
  ]);
});

test("score: element hits, false flags, duplicates and eligibility", () => {
  // Value: protects=precision and recall count each seed once and false flags off seeds; fails_when=a duplicate counts as a hit or a false flag, or a seed with no read line counts as eligible; why_new=new script; seam=none; no_claim=core rule
  const elements = [{ box: [0, 0, 1, 0.1] }, { box: [0, 0.2, 1, 0.1] }, { box: [0, 0.4, 1, 0.1] }];
  const s = { name: "x.png", seeds: [{ el: 0, chars: ["Ц"] }, { el: 2, chars: ["ö"] }] };
  const env = {
    lines: [{ box: [0.1, 0.02, 0.2, 0.05], confidence: 0.9 }, { box: [0.1, 0.22, 0.2, 0.05], confidence: 0.9 }],
    findings: [
      { element: { id: "e0" }, chars: ["Ц"], box: [0.1, 0.02, 0.2, 0.05] },
      { box: [0.1, 0.02, 0.2, 0.05], chars: ["Ц"] }, // catalog finding on the same element: a duplicate
      { element: { id: "e1" }, chars: ["x"], box: [0.1, 0.22, 0.2, 0.05] },
    ],
  };
  const r = score(s, elements, env);
  assert.equal(r.duplicates, 1);
  assert.equal(r.falses.length, 1);
  assert.deepEqual(r.seeds.map((x) => [x.hit, x.eligible, x.charsExact]), [[true, true, true], [false, false, false]]);
  const t = tally(r.seeds);
  assert.equal(t.recall_eligible, 1);
  assert.equal(t.recall_all, 0.5);
});
