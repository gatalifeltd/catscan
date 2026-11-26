// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-073 PR 2: bench/safe-area.js truth for the home indicator (Rule step 1: the box grown by its height, its own
// landscape box) and the Android part of the synthetic plan.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mask, plan } = require("../safe-area.js");

test("safe-area: the home indicator mask is the grown box, per orientation", () => {
  // Value: protects=the home-indicator truth (grown by its height; the landscape box in landscape pixels); fails_when=truth uses the bare bar or the portrait box in landscape, so every home positive is scored wrong; why_new=PR 2 measures home-indicator; seam=mask; no_claim=Vision's character boxes
  const p = { screen: { width: 100, height: 200 }, zones: [{ kind: "home-indicator", box: [35, 190, 30, 2] }], landscape: { "home-indicator": { box: [85, 90, 30, 2] } } };
  const count = ({ m }) => m.reduce((n, v) => n + v, 0);
  const port = mask(p, "portrait", ["home-indicator"]);
  assert.equal(count(port), 34 * 6, "x 33..67, y 188..194");
  assert.equal(port.m[188 * 100 + 33], 1);
  assert.equal(port.m[187 * 100 + 33], 0);
  const land = mask(p, "landscape-left", ["home-indicator"]);
  assert.deepEqual([land.W, land.H, land.m[88 * 200 + 83], land.m[87 * 200 + 83]], [200, 100, 1, 0]);
  assert.equal(count(mask(p, "portrait", ["cutout"])), 0, "only the kinds asked for");
});

test("safe-area: Android shots carry one home item each, alternating label and icon; iOS shots none", () => {
  // Value: protects=the PR 2 plan (home label or icon, never both on one row, both kinds in both halves); fails_when=a label and an icon share a row (Vision joins them) or a half lacks one kind; why_new=PR 2 plan; seam=plan; no_claim=the drawn pixels
  const shots = plan();
  const home = (s) => s.items.filter((i) => i.zone === "home-indicator").map((i) => i.id);
  assert.ok(shots.filter((s) => !s.profile.startsWith("pixel")).every((s) => home(s).length === 0));
  const android = shots.filter((s) => s.profile.startsWith("pixel"));
  assert.ok(android.length > 0 && android.every((s) => home(s).length === 1));
  for (const half of ["dev", "held_out"]) {
    const ids = new Set(android.filter((s) => s.half === half).map((s) => home(s)[0]));
    assert.deepEqual([...ids].sort(), ["home", "home-icon"], half);
  }
});
