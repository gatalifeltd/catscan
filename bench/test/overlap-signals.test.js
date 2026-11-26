// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-035 signal candidates on hand-made reads (bench/overlap-signals.js). No Vision.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../overlap-signals");
const { findings } = require("../overlap/signals-run");
const { matches } = require("../overlap");

const E = ["Kontoeinstellungen", "Benachrichtigungen", "Start", "Optionen", "Hilfe"];
const L = (text, box = [0.1, 0.1, 0.3, 0.02]) => ({ text, box, confidence: 1 });

test("catalog: a merged read names the two missing strings; a shown string, a misread of one and an unrelated word do not", () => {
  // Value: protects=T1 joint alignment and pair choice; fails_when=one letter counts for both strings, or a read of one string becomes a pair; why_new=new prototype; seam=none; no_claim=thresholds (picked on the dev half)
  const shown = [L("Start"), L("Optionen"), L("Hilfe")];
  const [c] = S.catalogCandidates([L("Kopenachstehtigungen"), ...shown], E);
  assert.deepEqual([c.a, c.b], ["Kontoeinstellungen", "Benachrichtigungen"]);
  assert.ok(c.cover >= 0.5 && c.explained >= 0.9, JSON.stringify(c));
  assert.deepEqual(S.catalogCandidates([L("Kontoeinstellungen"), L("Benachrichtigungen"), ...shown], E), [], "both shown");
  const one = S.catalogCandidates([L("Kontoeinstelungen"), ...shown], E);
  assert.ok(one.every((x) => x.cover < 0.4), "a misread of one string is not a pair");
  const other = S.catalogCandidates([L("Datenschutzerklärung"), ...shown], E);
  assert.ok(other.every((x) => x.cover < 0.5), JSON.stringify(other.map((x) => x.cover)));
  // Joint: a letter is credited once, so the cover of the two never exceeds what the read holds.
  const m = S.joint("abc", "abc", "abc");
  assert.equal(m.ma + m.mb, 3);
});

test("split: candidates by aspect against the script class median; crops clamp to the image; two different parts confirm", () => {
  // Value: protects=T2 candidate rule, crop geometry and confirmation; fails_when=a big title (same aspect) becomes a candidate, a crop leaves the image, or one line read twice confirms; why_new=new prototype; seam=none; no_claim=how Vision reads the crops
  const env = { image: { width: 1000, height: 1000 }, lines: [
    L("Eins", [0.1, 0.1, 0.08, 0.02]), L("Zwei", [0.1, 0.2, 0.08, 0.02]), L("Drei", [0.1, 0.3, 0.08, 0.02]),
    L("Großer Titel", [0.1, 0.4, 0.48, 0.04]), // twice the size, same aspect
    L("Kopenachst", [0.1, 0.5, 0.2, 0.04]) ] }; // as wide per letter as the others, twice as tall
  assert.deepEqual(S.splitCandidates(env, { k: 1.5 }).map((c) => c.line.text), ["Kopenachst"]);
  const [top, bottom] = S.splitRects([0.0, 0.98, 0.5, 0.04], 1000, 1000, { pad: 0.15, margin: 0.1 });
  assert.deepEqual(top.map(Math.round), [0, 974, 506, 26]);
  assert.ok(bottom[1] + bottom[3] <= 1000 && bottom[0] >= 0, JSON.stringify(bottom));
  assert.equal(S.splitConfirms([L("Einstellungen")], [L("Benachrichtigungen")]), true);
  assert.equal(S.splitConfirms([L("Einstellungen")], [L("Einstellungen")]), false, "one line read in both parts");
  assert.equal(S.splitConfirms([L("Ei")], [L("Benachrichtigungen")]), false, "too short");
});

test("scoring: a catalog or split finding on the merged line is a hit for the pair it covers (spec 12 D5)", () => {
  // Value: protects=T3 reuse of spec 12 matches for one-box findings and the threshold filter; fails_when=a one-box finding never scores or a below-threshold candidate fires; why_new=new prototype; seam=none; no_claim=none beyond protects
  const truth = { width: 1000, height: 1000, lines: [{ role: "a", box: [100, 500, 300, 30] }, { role: "b", box: [110, 520, 300, 30] }] };
  const line = L("Kopenachst", [0.1, 0.5, 0.31, 0.05]);
  const c = { catalog: [{ line, a: "A", b: "B", cover: 0.6, explained: 0.9 }], split: [] };
  const [f] = findings(c, new Map(), { cover: 0.5, explained: 0.8, k: null });
  assert.equal(f.signal, "catalog");
  assert.ok(matches(f, truth));
  assert.deepEqual(findings(c, new Map(), { cover: 0.7, explained: 0.8, k: null }), []);
});

test("combined: one finding per merged line, boxes first (D6); the candidate bar needs 3x and separated Wilson intervals (D7)", () => {
  // Value: protects=D6 dedupe and the D7 verdict; fails_when=a split and a catalog finding on one line count twice, or 3x alone passes; why_new=new prototype; seam=none; no_claim=none beyond protects
  const { candidateVerdict } = require("../overlap/signals-run");
  const line = L("Kopenachst", [0.1, 0.5, 0.31, 0.05]);
  const c = { catalog: [{ line, a: "A", b: "B", cover: 0.6, explained: 0.9 }], split: [] };
  const boxes = [{ kind: "overlap", signal: "boxes", box: [0.1, 0.48, 0.3, 0.06] }];
  assert.deepEqual(findings(c, new Map(), { cover: 0.5, explained: 0.8, k: null }, boxes).map((f) => f.signal), ["boxes"]);
  assert.deepEqual(findings(c, new Map(), { cover: 0.5, explained: 0.8, k: null }, [{ ...boxes[0], box: [0.6, 0.1, 0.1, 0.02] }]).map((f) => f.signal), ["boxes", "catalog"]);
  const base = { recall: 0.025, found: 6, positives: 240, precision: 1 };
  assert.equal(candidateVerdict({ recall: 0.075, found: 18, positives: 240, precision: 1 }, base).candidate, false, "3x, overlapping intervals");
  assert.equal(candidateVerdict({ recall: 0.15, found: 36, positives: 240, precision: 0.95 }, base).candidate, true);
  assert.equal(candidateVerdict({ recall: 0.15, found: 36, positives: 240, precision: 0.8 }, base).candidate, false, "precision under the gate");
});

test("split path: a candidate above k with two different re-read parts is a split finding; at or below k, or one line read twice, it is not", () => {
  // Value: protects=T2 findings() split branch (ratio > k, parts lookup, splitConfirms with maxSame); fails_when=split candidates never fire, fire at ratio <= k, or a line read in both parts fires; why_new=other tests pass split: []; seam=none; no_claim=how Vision reads the crops
  const line = L("Kopenachst", [0.1, 0.5, 0.31, 0.05]);
  const x = { line, ratio: 2 };
  const set = { k: 1.5, maxSame: 0.6, cover: null };
  const parts = new Map([[x, [[L("Einstellungen")], [L("Benachrichtigungen")]]]]);
  const [f] = findings({ catalog: [], split: [x] }, parts, set);
  assert.equal(f.signal, "split");
  assert.deepEqual(f.box, line.box);
  const atK = { line, ratio: 1.5 };
  assert.deepEqual(findings({ catalog: [], split: [atK] }, new Map([[atK, parts.get(x)]]), set), [], "ratio at k, parts that would confirm");
  assert.deepEqual(findings({ catalog: [], split: [x] }, new Map([[x, [[L("Einstellungen")], [L("Einstellungen")]]]]), set), [], "one line twice");
  assert.deepEqual(findings({ catalog: [], split: [x] }, new Map(), set), [], "no re-read parts: no finding");
});

test("candidates: each catalog arm runs only with its list; split candidates carry their screen", () => {
  // Value: protects=D2 arm separation in candidates(); fails_when=the app-wide arm runs on the screen strings or without a list; why_new=no test calls candidates(); seam=none; no_claim=catalog time (timed)
  const { candidates } = require("../overlap/signals-run");
  const env = { image: { width: 1000, height: 1000 }, lines: [L("Kopenachstehtigungen"), L("Start"), L("Optionen"), L("Hilfe")] };
  const none = candidates(env, null, "de", null);
  assert.deepEqual([none.catalog, none.catalogApp], [[], []]);
  const screen = candidates(env, E, "de", null);
  assert.ok(screen.catalog.length > 0 && screen.catalogApp.length === 0);
  const app = candidates(env, null, "de", E);
  assert.ok(app.catalog.length === 0 && app.catalogApp.length > 0);
  for (const c of app.split) assert.equal(c.env, env);
});

test("split candidates: lines under minChars are ignored and a script class under minLines has none", () => {
  // Value: protects=D5 floors in splitCandidates; fails_when=a two-line screen or a 2-letter tall line becomes a candidate; why_new=the aspect test has 5 lines and long words only; seam=none; no_claim=none beyond protects
  const img = { width: 1000, height: 1000 };
  const two = { image: img, lines: [L("Eins", [0.1, 0.1, 0.08, 0.02]), L("Kopenachst", [0.1, 0.5, 0.2, 0.04])] };
  assert.deepEqual(S.splitCandidates(two, { k: 1.5 }), [], "under minLines");
  const short = { image: img, lines: [L("Eins", [0.1, 0.1, 0.08, 0.02]), L("Zwei", [0.1, 0.2, 0.08, 0.02]), L("Drei", [0.1, 0.3, 0.08, 0.02]), L("Ab", [0.1, 0.5, 0.04, 0.06])] };
  assert.deepEqual(S.splitCandidates(short, { k: 1.5 }), [], "under minChars");
});

test("perSignal: 2 px overlaps are left out; hits and misses count by signal", () => {
  // Value: protects=D6 per-signal tallies in results; fails_when=a 2 px row counts or a miss counts as a hit; why_new=no test covers the tally behind results/overlap-signals.json; seam=none; no_claim=the D8 cost tallies (not exported)
  const { perSignal } = require("../overlap/signals-run");
  const truth = { width: 1000, height: 1000, lines: [{ role: "a", box: [100, 500, 300, 30] }, { role: "b", box: [110, 520, 300, 30] }] };
  const hit = S.finding(L("Kopenachst", [0.1, 0.5, 0.31, 0.05]), "split"), miss = S.finding(L("Weiter", [0.6, 0.1, 0.1, 0.02]), "split");
  const rows = [{ item: { amount: 8 }, truth, findings: [hit, miss] }, { item: { amount: 2 }, truth, findings: [hit] }];
  assert.deepEqual(perSignal(rows), { split: { tp: 1, fp: 1 } });
});
