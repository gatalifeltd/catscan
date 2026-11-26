// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-077 "Outputs": GitHub rank order and 10-slot cut, Code Quality severities and unchanged fingerprints, JUnit
// prefixes and <system-out> for findings below the thresholds.
const test = require("node:test");
const assert = require("node:assert/strict");
const ci = require("../src/ci");
const scale = require("../src/scale");
const F = require("./fixtures/ci-envelopes");

const clone = (x) => JSON.parse(JSON.stringify(x));
const TH = (s, c) => ({ min_severity: s, min_certainty: c });
const trunc = (line, reason = "ellipsis") => ({ kind: "truncated", box: null, line, reason, element: null, expected: null, confidence: 1 });
const placeholder = (line) => ({ kind: "placeholder", box: null, line, token: "{name}" });
// The OCR-only overlap reader (boxes) is still experimental/low, so it stays below a medium certainty threshold.
const boxes = (text) => ({ kind: "overlap", signal: "boxes", box: null, line: `${text} / Fuss`, a: { text, box: [0.1, 0.1, 0.5, 0.05], confidence: 1 }, b: { text: "Fuss", box: [0.1, 0.12, 0.5, 0.05], confidence: 1 }, overlap: 0.4 });
const input = (p, findings, th = scale.DEFAULTS) => scale.annotate(F.base({ command: "untranslated", path: p, verdict: findings.length ? "fail" : "pass", findings }), th);

test("github: inputs in rank order, items sorted and prefixed; the 10 slots go to the highest ranked", () => {
  const envs = [
    ...Array.from({ length: 10 }, (_, i) => input(`shots/t${i}.png`, [trunc(`T${i}`)])),
    input("shots/p.png", [trunc("Weiter"), placeholder("Hi {name}")]),
    scale.annotate(clone(F.errorInput)),
  ];
  const lines = ci.githubLines(envs);
  assert.equal(lines.length, 11);
  assert.match(lines[0], /^::error file=shots\/fr\/broken\.png,/);
  assert.match(lines[1], /^::error file=shots\/p\.png,.*::critical\/medium {2}placeholder "\{name\}" in "Hi \{name\}"%0Amajor\/medium {2}truncated \(ellipsis\) "Weiter"/);
  assert.match(lines[10], /^::warning .*2 more failures not annotated/);
  assert.ok(!lines.some((l) => /t9\.png|t8\.png/.test(l)), "the lowest ranked inputs lose their slots");
});

test("github: an input with only below-threshold findings passes and gets no annotation; the summary lists it collapsed", () => {
  const below = input("shots/s.png", [boxes("Seitenleiste")], TH("minor", "medium"));
  const gating = input("shots/g.png", [trunc("Weiter"), boxes("Kopf")], TH("minor", "medium"));
  assert.equal(below.verdict, "pass");
  const lines = ci.githubLines([below, gating]);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("Kopf"), "below-threshold items are not in the message");
  const s = ci.githubSummary([below, gating], { command: "overlap" });
  assert.match(s, /\| FAIL \| major \| medium \| <code>shots\/g&#46;png<\/code> \|/);
  assert.match(s, /<details><summary>2 findings below threshold<\/summary>/);
  assert.match(s, /\| <code>shots\/s&#46;png<\/code> \| <code>major\/low {2}overlap "Seitenleiste"/);
});

test("codequality: severities per item, info below threshold, critical for errors, fingerprints unchanged", () => {
  const raw = [F.passCheck, F.failCheck, F.errorInput, F.unsupportedInput, F.truncatedFail, F.missing("ja/paywall")].map(clone);
  const before = ci.codequality(raw);
  const scaled = raw.map((e) => scale.annotate(clone(e)));
  const after = ci.codequality(scaled);
  assert.deepEqual(after.map((e) => e.fingerprint), before.map((e) => e.fingerprint), "GitLab keeps tracking each entry");
  assert.deepEqual(after.map((e) => [e.check_name, e.severity]), [
    ["catscan/present", "critical"], ["catscan/absent", "critical"], ["catscan/error", "critical"], ["catscan/unsupported", "critical"],
    ["catscan/truncated", "major"], ["catscan/truncated", "major"], ["catscan/missing", "critical"],
  ]);
  const mixed = input("shots/m.png", [boxes("Kopf"), trunc("Weiter")], TH("minor", "medium"));
  assert.deepEqual(ci.codequality([mixed]).map((e) => [e.check_name, e.severity]), [["catscan/overlap", "info"], ["catscan/truncated", "major"]]);
  assert.deepEqual(ci.codequality([input("shots/b.png", [boxes("Kopf")], TH("minor", "medium"))]).map((e) => e.severity), ["info"]);
});

test("junit: gating items are <failure> lines with the prefix, sorted; below-threshold findings go to <system-out>", () => {
  const mixed = input("shots/m.png", [trunc("Weiter"), boxes("Kopf"), placeholder("Hi {name}")], TH("minor", "medium"));
  const x = ci.junit([mixed]);
  assert.match(x, /<failure type="untranslated" message="critical\/medium {2}placeholder &quot;\{name\}&quot; in &quot;Hi \{name\}&quot;">critical\/medium {2}placeholder "\{name\}" in "Hi \{name\}"\nmajor\/medium {2}truncated \(ellipsis\) "Weiter"<\/failure>\n {6}<system-out>major\/low {2}overlap "Kopf" \/ "Fuss"/);
  const pass = ci.junit([input("shots/b.png", [boxes("Kopf")], TH("minor", "medium"))]);
  assert.match(pass, /failures="0"/);
  assert.match(pass, /<testcase name="untranslated" classname="shots\/b\.png" time="0\.100">\n {6}<system-out>major\/low/);
  const failed = ci.junit([scale.annotate(clone(F.failCheck))]);
  assert.match(failed, /<failure type="present" message="critical\/medium {2}present &quot;Weiter&quot;: not found/);
});

test("github summary: an error input adds no below-threshold section (review fix)", () => {
  const s = ci.githubSummary([scale.annotate(clone(F.errorInput))], { command: "check" });
  assert.doesNotMatch(s, /below threshold|undefined/);
});

test("github summary: a cut below-threshold block says how many inputs it left out (review fix)", () => {
  const envs = Array.from({ length: 60 }, (_, i) => input(`shots/de/s${String(i).padStart(2, "0")}.png`, [boxes("x".repeat(200))], TH("minor", "medium")));
  const s = ci.githubSummary(envs, { command: "overlap", more: "r.json", limit: 4_000 });
  assert.match(s, /<summary>60 findings below threshold<\/summary>/);
  assert.match(s, /\n\d+ more inputs with findings below threshold not shown; see r\.json\.\n\n<\/details>\n$/);
  assert.ok(Buffer.byteLength(s) <= 4_000);
});

test("github summary: with no room for the block, one line still says the below-threshold findings were left out (review fix)", () => {
  const fails = Array.from({ length: 40 }, (_, i) => input(`shots/de/f${String(i).padStart(2, "0")}.png`, [trunc("y".repeat(120))]));
  const below = input("shots/de/zz.png", [boxes("x")], TH("minor", "medium"));
  const full = ci.githubSummary(fails, { command: "overlap", more: "r.json", limit: 1_000_000 });
  const limit = Buffer.byteLength(full) + 150; // room for the line, not for the block
  const s = ci.githubSummary([...fails, below], { command: "overlap", more: "r.json", limit });
  assert.doesNotMatch(s, /<details>/);
  assert.match(s, /\n1 finding below threshold not shown; see r\.json\.\n$/);
});

test("known (TODO-055): a known finding gets no annotation, is a labeled note in JUnit and the summary, info in Code Quality with its fingerprint kept", () => {
  // Value: protects=TODO-055 D6/D23 in CI outputs: an approved finding never fails a case, is labeled known, keeps its GitLab fingerprint; fails_when=ci.js annotates or fails a known finding, drops the known label, or keys the fingerprint on the message; why_new=known.test.js checks only githubSummary counts; seam=none; no_claim=the known match itself (Map stands in for known.match; core-js known.test.js)
  const old = trunc("Weiter"), fresh = trunc("Neu");
  const plain = input("shots/k.png", [trunc("Weiter")]);
  const e = scale.annotate(F.base({ command: "untranslated", path: "shots/k.png", verdict: "fail", findings: [old, fresh] }), scale.DEFAULTS,
    new Map([[old, { known: true, found: 1, approved: 1 }], [fresh, { known: false, found: 1, approved: 0 }]]));
  assert.equal(e.verdict, "fail");
  const lines = ci.githubLines([e]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Neu/);
  assert.ok(!lines[0].includes("Weiter"), "a known finding is not in the annotation");
  const solo = trunc("Weiter");
  const onlyKnown = scale.annotate(F.base({ command: "untranslated", path: "shots/o.png", verdict: "fail", findings: [solo] }), scale.DEFAULTS, new Map([[solo, { known: true }]]));
  assert.deepEqual([onlyKnown.verdict, ci.githubLines([onlyKnown]).length], ["pass", 0]);
  const x = ci.junit([e]);
  assert.match(x, /<failure type="untranslated" message="major\/medium {2}truncated \(ellipsis\) &quot;Neu&quot;">/);
  assert.match(x, /<system-out>major\/medium {2}known truncated \(ellipsis\) "Weiter"/);
  const counts = { known: 1, new: 1, gone: 0 };
  const s = ci.githubSummary([onlyKnown, e], { command: "truncated", known: { counts } });
  assert.match(s, /<details><summary>2 findings below threshold or known<\/summary>/);
  assert.match(s, /<code>major\/medium {2}known truncated \(ellipsis\)/);
  const cq = ci.codequality([e]);
  assert.deepEqual(cq.map((r) => [r.description.includes("known "), r.severity]), [[true, "info"], [false, "major"]]);
  assert.equal(cq[0].fingerprint, ci.codequality([plain])[0].fingerprint, "approving a finding keeps its GitLab fingerprint");
});
