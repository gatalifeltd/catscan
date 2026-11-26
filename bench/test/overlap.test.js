// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 12 scorers on hand-made responses: the synthetic set's plan and score (bench/overlap.js) and the game labels
// (bench/overlap-real.js). No Vision.
const test = require("node:test");
const assert = require("node:assert/strict");
const { plan, score, matches } = require("../overlap");
const { truth, names, wilson } = require("../overlap-real");
const { merged } = require("../overlap/sweep");

const W = 780, H = 1200;
const norm = (b) => [b[0] / W, b[1] / H, b[2] / W, b[3] / H];
const T = { width: W, height: H, lines: [{ role: "a", box: [40, 520, 280, 40] }, { role: "b", box: [60, 552, 290, 40] }, { role: "d", box: [40, 60, 70, 40] }] };
const pair = { kind: "overlap", signal: "boxes", a: { box: norm([40, 522, 275, 34]) }, b: { box: norm([62, 553, 285, 34]) } };
const merge = { kind: "overlap", signal: "garbled", a: { box: norm([40, 522, 300, 66]) }, b: null };
const distractor = { kind: "overlap", signal: "boxes", a: { box: norm([40, 60, 70, 40]) }, b: { box: norm([42, 70, 70, 40]) } };

test("plan: fixed seed, 12 locales x 4 layouts x 6 amounts x 3 sizes, dev is the even half", () => {
  // Value: protects=D6 split and reproducibility; fails_when=the plan or its seed changes silently; why_new=new script; seam=none; no_claim=drawing (generate.swift)
  const a = plan(), b = plan();
  assert.equal(a.length, 12 * 4 * 6 * 3);
  assert.deepEqual(a, b);
  assert.equal(a.filter((i) => i.dev).length, a.length / 2);
  assert.ok(a.every((i) => i.distractors.length === 3 && i.a !== i.b));
});

test("score: a hit names the pair; findings on gaps, touching and distractors are false alarms; 2 px is outside the gate (D5)", () => {
  // Value: protects=the gate arithmetic; fails_when=2 px counts, a distractor finding counts as a hit, or recall counts findings; why_new=new scorer; seam=none; no_claim=none beyond protects
  assert.ok(matches(pair, T));
  assert.ok(matches(merge, T));
  assert.ok(!matches(distractor, T));
  const row = (amount, findings) => ({ item: { amount, layout: "vv", size: 17 }, truth: T, findings });
  const s = score([row(8, [pair, distractor]), row(4, []), row(16, [merge]), row(0, [pair]), row(-4, []), row(2, [pair])]);
  assert.deepEqual([s.tp, s.fp], [2, 2]); // the distractor on the 8 px image and the pair on the touching one
  assert.equal(s.precision, 0.5);
  assert.equal(s.recall, 0.6667); // 2 of 3 images with 4 px and more
  assert.equal(s.negative_images_flagged, 1);
  assert.equal(s.per_amount["2"].found, 1, "reported, outside the gate");
  assert.equal(s.gate_pass, false);
  assert.deepEqual([s.per_signal.boxes.tp, s.per_signal.garbled.tp], [1, 1]);
});

test("game labels: forced pairs are positives, touching natural rects are excluded, clean screens are negatives (D11)", () => {
  // Value: protects=labels from rects only, with the 4 px floor; fails_when=a 1.5 px touch becomes a negative or a positive; why_new=new scorer; seam=none; no_claim=the game capture itself
  const texts = [{ index: 0, rect: { x: 100, y: 100, width: 300, height: 50 } }, { index: 1, rect: { x: 120, y: 140, width: 300, height: 50 } }];
  assert.equal(truth({ kind: "forced", texts_px: texts, forced: { moved: [1], onto: [0], k_game_px: 8, axis: "vertical" } }).kind, "positive");
  assert.equal(truth({ kind: "natural", texts_px: texts, pairs: [{ a: 0, b: 1, width: 280, height: 1.5 }] }).kind, "excluded");
  assert.equal(truth({ kind: "natural", texts_px: texts, pairs: [{ a: 0, b: 1, width: 280, height: 10 }] }).kind, "positive");
  assert.equal(truth({ kind: "natural", texts_px: texts, pairs: [] }).kind, "negative");
  const p = [[100, 100, 300, 50], [120, 140, 300, 50]];
  assert.ok(names({ a: { box: [100 / 1000, 102 / 2000, 0.3, 0.02] }, b: { box: [125 / 1000, 141 / 2000, 0.3, 0.02] } }, p, 1000, 2000));
  assert.ok(!names({ a: { box: [0.5, 0.5, 0.1, 0.01] }, b: { box: [0.52, 0.5, 0.1, 0.01] } }, p, 1000, 2000));
  assert.deepEqual(wilson(0, 0), null);
  assert.deepEqual(wilson(8, 10), [0.4902, 0.9433]);
});

test("sweep: the dropped merged-line candidate is computed as D20 describes", () => {
  // Value: protects=a rerun of the D21 decision measures the rule D20 describes; fails_when=the candidate formula drifts; why_new=new tool; seam=none; no_claim=the core (the signal is not in it)
  const env = { image: { width: 1000, height: 1000 }, lines: [
    { text: "Eins", box: [0.1, 0.1, 0.2, 0.02], confidence: 1 }, { text: "Zwei", box: [0.1, 0.2, 0.2, 0.02], confidence: 1 },
    { text: "Drei", box: [0.1, 0.3, 0.2, 0.02], confidence: 1 }, { text: "Kopenachst", box: [0.1, 0.5, 0.3, 0.04], confidence: 1 },
    { text: "Titel", box: [0.1, 0.6, 0.4, 0.04], confidence: 1 }] };
  assert.deepEqual(merged(env, { k: 1.6, minChars: 3 }).map((f) => f.a.text), ["Kopenachst"]);
});
