// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 12: `overlap` arguments, rendering, schema and CI outputs. Synthetic envelopes only; Vision runs in test/overlap.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const { parse, UsageError, RUN_COMMANDS } = require("../src/args");
const render = require("../src/render");
const ci = require("../src/ci");
const { HELP, SHORT_USAGE } = require("../src/cli");

const usage = (argv, code, re) => assert.throws(() => parse(argv), (e) => e instanceof UsageError && e.code === code && (!re || re.test(e.message + e.hint)));
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../../../core/schema/result.schema.json"));

const pair = {
  kind: "overlap", box: [0.12, 0.31, 0.57, 0.06], line: "Kontoeinstellungen / Benachrichtigungen",
  a: { text: "Kontoeinstellungen", box: [0.12, 0.31, 0.52, 0.04], confidence: 0.98 },
  b: { text: "Benachrichtigungen", box: [0.14, 0.33, 0.55, 0.04], confidence: 0.61 },
  overlap: 0.47, signal: "boxes",
};
const env = (findings) => ({
  schema: 1, catscan: "0.18.0", command: "overlap", path: "shots/de/home.png", verdict: findings.length ? "fail" : "pass", engine: "vision-accurate-rev3",
  locale: "de", image: { width: 1000, height: 2000 }, screen: null,
  host: { chip: "Apple M1", arch: "arm64", host_class: "physical", macos: "26.1 (25B78)", vision_revision: 3 }, ms: 60, checks: [], findings, warnings: [],
});

test("args: overlap and --min-overlap (D14)", () => {
  // Value: protects=D14 parsing and every usage error with its hint; fails_when=a bad share reaches the core or another command takes the flag; why_new=new command; seam=none; no_claim=none beyond protects
  const o = parse(["overlap", "shots", "--min-overlap", "0.35", "--locale", "de", "--experimental"]);
  assert.deepEqual([o.command, o.minOverlap, o.locale], ["overlap", 0.35, "de"]);
  assert.equal(parse(["overlap", "shots", "--experimental"]).minOverlap, null);
  assert.equal(parse(["overlap", "shots", "--experimental", "--min-overlap", "1"]).minOverlap, 1);
  assert.equal(parse(["overlap", "shots", "--experimental", "--min-overlap", ".5"]).minOverlap, 0.5);
  for (const bad of ["0", "1.5", "abc", "-0.2", "0x1", "1e-1"]) usage(["overlap", "s", "--experimental", "--min-overlap", bad], "invalid-min-overlap", /--min-overlap 0\.2/);
  usage(["truncated", "s", "--min-overlap", "0.2"], "option-not-valid");
  usage(["overlap", "s", "--min-overlap", "0.2"], "option-not-valid", /give --boxes or --experimental/); // TODO-067 D34: stacked alone reads no share
  assert.equal(parse(["overlap", "s", "--boxes", "b", "--min-overlap", "0.2"]).minOverlap, 0.2);
  usage(["--min-overlap", "0.2", "read", "s"], "option-not-valid", /only with overlap/); // before the command
  usage(["overlap", "s", "--experimental", "--min-overlap", "0.2", "--min-overlap", "0.3"], "repeated-option");
  // TODO-067 D17: without boxes overlap runs the default-on stacked reader; the OCR-only reader still needs --experimental.
  assert.equal(parse(["overlap", "s"]).experimental, false);
  usage(["read", "s", "--experimental"], "option-not-valid");
  assert.equal(parse(["overlap", "--help"]).help, true);
  for (const extra of [["--catalog", "de.json"], ["--present", "x"], ["--absent", "x"], ["--expect", "e.yaml"], ["--reasons", "edge"]]) usage(["overlap", "s", "--experimental", ...extra], "option-not-valid");
  // TODO-046: --boxes and --allow are valid, and --boxes runs without --experimental.
  const b = parse(["overlap", "s", "--boxes", "s", "--allow", "allow.txt"]);
  assert.deepEqual([b.boxes, b.allow, b.experimental], ["s", "allow.txt", false]);
  assert.equal(parse(["overlap", "s", "--boxes", "s", "--experimental"]).experimental, true);
  usage(["overlap", "--experimental"], "missing-path");
  assert.equal(parse(["overlap", "s", "--experimental", "--fallback", "none"]).fallback, "none");
  assert.ok(RUN_COMMANDS.includes("overlap"), "results, report and CI options apply (D15)");
  assert.equal(parse(["overlap", "s", "--experimental", "--results", "r.json", "--junit", "j.xml"]).junit, "j.xml");
  // TODO-046 D11: the boxes form first, the OCR-only form second.
  assert.match(HELP, /catscan overlap <path\.\.\.> --boxes <file\|dir> \[--allow <file>\] \[--min-overlap <share>\] \[--locale <code>\] \[--experimental\]\n  catscan overlap <path\.\.\.> --experimental \[--min-overlap <share>\]/);
  assert.match(HELP, /--min-overlap <share>/);
  assert.match(SHORT_USAGE, /catscan overlap shots\/de --locale de --boxes shots\/de/);
});

// TODO-046: the elements reader's finding: a text over an icon (graphic: text and confidence null).
const icon = {
  kind: "overlap", box: [0.12, 0.31, 0.57, 0.06], line: "Kontoeinstellungen / [bell-icon]",
  a: { text: "Kontoeinstellungen", box: [0.12, 0.31, 0.52, 0.04], confidence: 0.98, element: { id: "title", box: [0.1, 0.3, 0.56, 0.05] } },
  b: { text: null, box: [0.6, 0.31, 0.06, 0.03], confidence: null, element: { id: "bell-icon", box: [0.6, 0.31, 0.06, 0.03] } },
  overlap: 0.47, signal: "elements",
};

test("render: one line per finding (D13)", () => {
  // Value: protects=the D13 text line; fails_when=the texts, share or box are dropped; why_new=new kind; seam=none; no_claim=none beyond protects
  assert.equal(render.findingDetail(pair), '  overlap "Kontoeinstellungen" / "Benachrichtigungen" (47%) at [0.12, 0.31, 0.57, 0.06]');
  // TODO-046 "Output": a graphic by its id in brackets, [graphic] with no id.
  assert.equal(render.findingDetail(icon), '  overlap "Kontoeinstellungen" / [bell-icon] (47%) at [0.12, 0.31, 0.57, 0.06]');
  assert.equal(render.findingDetail({ ...icon, b: { ...icon.b, element: { id: null, box: icon.b.box } } }), '  overlap "Kontoeinstellungen" / [graphic] (47%) at [0.12, 0.31, 0.57, 0.06]');
});

test("schema: signal elements with a graphic side validates; a boxes finding with null text does not (TODO-046)", () => {
  // Value: protects=the TODO-046 schema change (elements signal, element field, null text and confidence only there); fails_when=null text leaks into the OCR reader's shape or the new finding is rejected; why_new=new signal; seam=none; no_claim=what the core emits (OverlapElementsTests)
  assert.ok(validate(env([icon])), JSON.stringify(validate.errors));
  assert.equal(validate(env([{ ...pair, b: { ...pair.b, text: null } }])), false);
  assert.equal(validate(env([{ ...pair, b: { ...pair.b, confidence: null } }])), false);
  assert.equal(validate(env([{ ...icon, a: { ...icon.a, element: { id: "title" } } }])), false, "element needs its box");
});

test("schema: an overlap envelope validates; each required field is required (D7)", () => {
  // Value: protects=the D7 per-kind schema contract; fails_when=a field becomes optional or command overlap is rejected; why_new=new kind; seam=none; no_claim=what the core emits (OverlapTests encoding)
  assert.ok(validate(env([pair])), JSON.stringify(validate.errors));
  for (const k of ["a", "b", "overlap", "signal", "line"]) {
    const f = { ...pair };
    delete f[k];
    assert.equal(validate(env([f])), false, `without ${k}`);
  }
  assert.equal(validate(env([{ ...pair, signal: "garbled" }])), false, "dropped (D21)");
  assert.equal(validate(env([{ ...pair, b: null }])), false);
  assert.equal(validate(env([{ ...pair, overlap: 1.5 }])), false);
});

test("CI outputs carry overlap findings (D15)", () => {
  // Value: protects=JUnit, GitHub and GitLab outputs for the new kind; fails_when=an overlap finding is dropped or crashes a reporter; why_new=new kind through generic code; seam=none; no_claim=file writing (ci.test.js)
  const e = env([pair]);
  assert.match(ci.junit([e]), /Kontoeinstellungen/);
  assert.match(ci.githubLines([e]).join("\n"), /::error .*overlap/);
  const cq = ci.codequality([e]);
  assert.equal(cq.length, 1);
  assert.match(cq[0].description, /overlap/);
  // TODO-046: an elements finding with a graphic side goes through the same reporters.
  const g = env([icon]);
  assert.match(ci.junit([g]), /bell-icon/);
  assert.match(ci.githubLines([g]).join("\n"), /::error .*overlap/);
  assert.equal(ci.codequality([g]).length, 1);
});

// TODO-049: text cut off by a panel, the elements finding shape with the panel as `b`.
const occluded = {
  kind: "occluded", box: [0.3, 0.42, 0.5, 0.03], line: "Benachrichtigungen aktivieren / [toast]",
  a: { text: "Benachrichtigungen aktivieren", box: [0.3, 0.425, 0.295, 0.02], confidence: null, element: { id: "notify", box: [0.3, 0.42, 0.5, 0.03] } },
  b: { text: null, box: [0.6, 0.4, 0.4, 0.1], confidence: null, element: { id: "toast", box: [0.6, 0.4, 0.4, 0.1] } },
  overlap: 0.4, signal: "elements",
};

test("occluded: text line, schema and CI outputs (TODO-049 D1, D16)", () => {
  // Value: protects=D16 line (panel by id, share of the box, at) and the D1 schema and reporters for the new kind; fails_when=the kind is rejected, renders generically or drops the panel; why_new=new kind; seam=none; no_claim=what the core emits (OcclusionTests)
  assert.equal(render.findingDetail(occluded), '  occluded "Benachrichtigungen aktivieren" under [toast] (40% of its box under the panel) at [0.3, 0.42, 0.5, 0.03]');
  assert.equal(render.findingDetail({ ...occluded, b: { ...occluded.b, element: { id: null, box: occluded.b.box } } }).includes("under [panel]"), true);
  assert.ok(validate(env([occluded])), JSON.stringify(validate.errors));
  for (const k of ["a", "b", "overlap", "signal", "line"]) {
    const f = { ...occluded };
    delete f[k];
    assert.equal(validate(env([f])), false, `without ${k}`);
  }
  assert.equal(validate(env([{ ...occluded, signal: "boxes" }])), false, "only the elements reader");
  assert.equal(validate(env([{ ...occluded, b: { ...occluded.b, text: "Toast" } }])), false, "a panel has no text");
  const e = env([occluded]);
  assert.match(ci.junit([e]), /toast/);
  assert.match(ci.githubLines([e]).join("\n"), /::error .*occluded/);
  assert.equal(ci.codequality([e]).length, 1);
});

// TODO-067: text drawn over text, found by reading without language correction; one read, no second line.
const stacked = {
  kind: "overlap", box: [0.2645, 0.7689, 0.4871, 0.0233], line: "Entn2:AhAckunck",
  a: { text: "Entn2:AhAckunck", box: [0.2645, 0.7689, 0.4871, 0.0233], confidence: 0.3 }, b: null, overlap: null,
  signal: "stacked", stacked_evidence: ["correction-dropped"], corrected: null,
};

test("stacked: text line, schema and CI outputs (TODO-067 D9, D13, D14, D18)", () => {
  // Value: protects=the stacked line (both reads, fix last), its schema branch (null b and overlap, stacked_evidence) and the reporters that read b; fails_when=render reads b.text or overlap, the schema rejects or loosens the branch, a reporter crashes; why_new=new signal shape; seam=none; no_claim=what the core emits (StackedTests)
  assert.equal(render.findingDetail(stacked), '  overlap (stacked) "Entn2:AhAckunck" at [0.2645, 0.7689, 0.4871, 0.0233]: text drawn over text; Vision reads it only without language correction; if drawn on purpose, add the line to --allow');
  const changed = { ...stacked, stacked_evidence: ["correction-changed"], corrected: "EiD Bild asteS Bilder" };
  assert.match(render.findingDetail(changed), /; read as "EiD Bild asteS Bilder" with correction; if drawn on purpose/);
  // D31: a confident non-word read says why it fired, and repeats no identical production read.
  const dict = { ...stacked, line: "45ppettues sriorahd dy", a: { ...stacked.a, text: "45ppettues sriorahd dy", confidence: 1 }, stacked_evidence: ["dictionary"], corrected: "45ppettues sriorahd dy" };
  assert.equal(render.findingDetail(dict), '  overlap (stacked) "45ppettues sriorahd dy" at [0.2645, 0.7689, 0.4871, 0.0233]: text drawn over text; Vision reads it confidently as words no dictionary of the run language knows; if drawn on purpose, add the line to --allow');
  assert.match(render.findingDetail({ ...dict, stacked_evidence: ["correction-changed", "dictionary"], a: { ...dict.a, text: "45ppéttuessrfiorahddy" } }), /without language correction; read as "45ppettues sriorahd dy" with correction/);
  assert.ok(validate(env([stacked, changed, dict])), JSON.stringify(validate.errors));
  for (const k of ["stacked_evidence", "corrected", "b", "overlap"]) {
    const f = { ...stacked };
    delete f[k];
    assert.equal(validate(env([f])), false, `without ${k}`);
  }
  assert.equal(validate(env([{ ...stacked, stacked_evidence: [] }])), false, "at least one branch");
  assert.equal(validate(env([{ ...stacked, overlap: 0.3 }])), false, "no share for one read");
  assert.equal(validate(env([{ ...pair, overlap: null }])), false, "the pair readers keep their share");
  assert.equal(validate(env([{ ...pair, b: null }])), false, "the pair readers keep their second line");
  const e = env([stacked]);
  assert.match(ci.junit([e]), /Entn2:AhAckunck/);
  assert.match(ci.githubLines([e]).join("\n"), /::error .*overlap \(stacked\)/);
  assert.equal(ci.codequality([e]).length, 1);
});

test("args: overlap without boxes parses with and without --experimental (TODO-067 D17)", () => {
  // Value: protects=plain overlap is no longer a usage error once stacked is default-on; fails_when=the experimental-command guard comes back or --experimental stops parsing; why_new=D17 replaced the D1 guard; seam=none; no_claim=the request fields (test/overlap.test.js sends them end to end)
  assert.equal(parse(["overlap", "s", "--experimental"]).experimental, true);
  assert.equal(parse(["overlap", "s"]).command, "overlap");
});
