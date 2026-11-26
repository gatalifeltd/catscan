// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-077: annotate() sets severity, certainty, precision and gate and the final verdict; thresholds; sort; text.
const test = require("node:test");
const assert = require("node:assert/strict");
const scale = require("../src/scale");
const render = require("../src/render");
const args = require("../src/args");
const REG = require("../src/findings-registry.json");

const VISION = "vision-accurate-rev3", TESS = "tesseract-5.5.4";
const TH = (s = "minor", c = "low") => ({ min_severity: s, min_certainty: c });

/** A finding of every registry key, with the field its rule is read from. */
function findingFor(kind, rule) {
  const f = { kind, box: [0.1, 0.1, 0.2, 0.05], line: "x" };
  if (kind === "truncated" || kind === "fit") f.reason = rule;
  else if (kind === "overlap" || kind === "occluded") f.signal = rule;
  else if (kind === "wrong-language" || kind === "hardcoded") f.evidence = rule;
  else if (kind === "format" || kind === "currency") f.rule = rule;
  else if (kind === "price") f.field = rule;
  return f;
}
const env = (findings, extra = {}) => ({ command: "truncated", path: "a.png", verdict: findings.length ? "fail" : "pass", engine: VISION, checks: [], findings, warnings: [], ...extra });

test("annotate: every kind and rule from Vision and Tesseract envelopes gets the registry's fields", () => {
  for (const [kind, rule] of REG.keys) {
    for (const engine of [VISION, TESS]) {
      if (kind === "check") {
        const e = env([], { command: "check", engine, verdict: "fail", checks: [{ kind: rule, text: "t", verdict: "fail", box: null, line: null, confidence: null, closest: null }] });
        scale.annotate(e);
        const c = e.checks[0];
        assert.equal(c.severity, "critical");
        assert.equal(c.gate, true);
        assert.equal(e.verdict, "fail");
        continue;
      }
      const e = env([findingFor(kind, rule)], { engine });
      scale.annotate(e);
      const f = e.findings[0];
      const row = scale.lookup(kind, rule, engine === TESS ? "tesseract" : "vision");
      assert.equal(f.severity, row.severity, `${kind} ${rule}`);
      assert.equal(f.certainty, row.certainty, `${kind} ${rule} ${engine}`);
      assert.equal(f.gate, true, "the defaults gate everything (D4)");
      assert.ok(f.precision === null || (f.precision >= 0 && f.precision <= 1));
      assert.equal(e.verdict, "fail");
    }
  }
});

test("annotate: Tesseract finding rows are low; the new kinds follow D24", () => {
  const e = env([findingFor("truncated", "ellipsis")], { engine: TESS });
  scale.annotate(e);
  assert.deepEqual([e.findings[0].certainty, e.findings[0].precision], ["low", null]);
  const sev = (k, r) => scale.lookup(k, r, "vision").severity;
  assert.equal(sev("price", "amount"), "critical");
  assert.equal(sev("currency", "mixed"), "critical");
  assert.equal(sev("format", "date"), "major");
  assert.equal(sev("uncatalogued", "-"), "major");
  const st = scale.lookup("overlap", "stacked", "vision");
  assert.deepEqual([st.certainty, st.experimental, st.synthetic.precision], ["medium", false, 1], "default-on stacked reader (TODO-067)");
  assert.deepEqual([scale.lookup("overlap", "boxes", "vision").certainty, scale.lookup("overlap", "boxes", "vision").experimental], ["low", true]);
  assert.equal(scale.lookup("missing", "-", "vision").certainty, "high");
});

test("thresholds: the 3 x 3 grid over a major/medium finding", () => {
  for (const s of scale.SEVERITIES) for (const c of scale.CERTAINTIES) {
    const e = scale.annotate(env([findingFor("truncated", "overflow")]), TH(s, c));
    const want = s !== "critical" && c !== "high";
    assert.equal(e.findings[0].gate, want, `${s} ${c}`);
    assert.equal(e.verdict, want ? "fail" : "pass", `${s} ${c}`);
  }
});

test("thresholds: failed checks gate under every threshold; error, needs-reader and unsupported are kept (D26)", () => {
  const checks = [{ kind: "present", text: "t", verdict: "fail", box: null, line: null, confidence: null, closest: null }];
  const e = scale.annotate(env([], { command: "check", verdict: "fail", checks }), TH("critical", "high"));
  assert.equal(e.checks[0].gate, true);
  assert.equal(e.verdict, "fail");
  for (const v of ["error", "needs-reader", "unsupported"]) {
    const k = scale.annotate(env([findingFor("truncated", "edge")], { verdict: v }), TH("critical", "high"));
    assert.equal(k.verdict, v);
  }
});

test("thresholds: an input whose findings are all below threshold passes and keeps them with gate false", () => {
  const e = scale.annotate(env([findingFor("truncated", "ellipsis"), findingFor("overlap", "boxes")]), TH("minor", "high"));
  assert.equal(e.verdict, "pass");
  assert.deepEqual(e.findings.map((f) => f.gate), [false, false]);
  assert.equal(e.findings.length, 2);
});

test("exit codes: mixed gating and below-threshold inputs, with and without --fail-on-skip", () => {
  const below = scale.annotate(env([findingFor("overlap", "boxes")]), TH("minor", "medium"));
  const gating = scale.annotate(env([findingFor("truncated", "edge")]), TH("minor", "medium"));
  assert.equal(render.exitCode([below.verdict]), 0);
  assert.equal(render.exitCode([below.verdict, gating.verdict]), 1);
  assert.equal(render.exitCode([below.verdict], { skipped: true }), 1);
  assert.equal(render.exitCode([below.verdict, "needs-reader"], { skipped: true }), 3);
});

test("defaults reproduce the core's verdicts on fixture envelopes", () => {
  const fx = require("./fixtures/ci-envelopes");
  const all = [fx.passCheck, fx.failCheck, fx.skippedCheck, fx.errorInput, fx.unsupportedInput, fx.truncatedFail, fx.missing("fr/home")];
  for (const e of all.map((x) => JSON.parse(JSON.stringify(x)))) {
    const before = e.verdict;
    scale.annotate(e);
    assert.equal(e.verdict, before, e.path);
  }
});

test("registry-invalid: a finding with no row is exit 5's code", () => {
  assert.throws(() => scale.annotate(env([{ kind: "truncated", reason: "sideways", box: null, line: "x" }])), (e) => e.code === "registry-invalid" && /truncated, rule sideways, reader vision/.test(e.message));
});

test("args: invalid levels with the swap hint; the flags on read, video and the others are option-not-valid (D10, D27)", () => {
  const parse = (a) => { try { return args.parse(a); } catch (e) { return e; } };
  let e = parse(["truncated", "a.png", "--min-severity", "high"]);
  assert.deepEqual([e.code, e.hint], ["invalid-threshold", "--min-certainty high"]);
  assert.match(e.message, /--min-severity "high" is not a severity \(critical, major, minor\)/);
  e = parse(["truncated", "a.png", "--min-certainty", "critical"]);
  assert.deepEqual([e.code, e.hint], ["invalid-threshold", "--min-severity critical"]);
  e = parse(["truncated", "a.png", "--min-certainty", "sure"]);
  assert.deepEqual([e.code, e.hint], ["invalid-threshold", "--min-certainty medium"]);
  for (const cmd of [["read", "a.png"], ["video", "a.mp4"], ["doctor"], ["languages"], ["serve"], ["pseudo", "en.json"], ["boxes", "xcuitest", "d.json"]]) {
    e = parse([...cmd, "--min-severity", "major"]);
    assert.equal(e.code, "option-not-valid", cmd[0]);
  }
  e = parse(["--min-certainty", "high", "read", "a.png"]);
  assert.equal(e.code, "option-not-valid", "also before the command");
  e = parse(["results", "validate", "a.json", "--min-severity", "major"]);
  assert.equal(e.code, "option-not-valid");
  for (const cmd of ["truncated", "overlap", "formats"]) {
    const o = parse([cmd, "a.png", "--min-severity", "major", ...(cmd === "overlap" ? ["--experimental"] : [])]);
    assert.deepEqual(o.thresholds, TH("major", "low"), cmd);
    assert.equal(o.thresholdsGiven, true);
  }
  const o = parse(["results", "merge", "a.json", "--out", "m.json", "--min-certainty", "medium"]);
  assert.deepEqual(o.thresholds, TH("minor", "medium"));
  assert.equal(parse(["truncated", "a.png"]).thresholdsGiven, false);
});

test("sort: a gating major/medium finding ranks before a below-threshold critical/low one; ties keep their order", () => {
  const e = scale.annotate(env([findingFor("occluded", "elements"), findingFor("truncated", "edge"), findingFor("truncated", "ellipsis"), findingFor("placeholder", "-")]), TH("minor", "medium"));
  const sorted = scale.sortItems(e.findings);
  assert.deepEqual(sorted.map((f) => f.kind + (f.reason ? `/${f.reason}` : "")), ["placeholder", "truncated/edge", "truncated/ellipsis", "occluded"]);
  assert.equal(sorted[3].gate, false);
  // Items with no severity (a pre-scale file) rank after the scaled ones of their gate group.
  assert.deepEqual(scale.sortItems([{ kind: "old" }, { kind: "new", severity: "minor", certainty: "low", gate: true }]).map((x) => x.kind), ["new", "old"]);
});

test("sort: inputs by rank; error, needs-reader and unsupported first; passes with nothing last", () => {
  const a = scale.annotate(env([findingFor("truncated", "edge")], { path: "a" }));
  const b = scale.annotate(env([findingFor("placeholder", "-")], { path: "b" }));
  const c = scale.annotate(env([], { path: "c" }));
  const d = scale.annotate(env([], { path: "d", verdict: "needs-reader" }));
  const m = scale.annotate({ command: "check", path: null, verdict: "fail", engine: null, checks: [], findings: [{ kind: "missing", box: null, expected_path: "fr/x" }], warnings: [] });
  assert.deepEqual(scale.sortEnvelopes([c, a, b, m, d]).map((e) => e.path ?? "missing"), ["d", "missing", "b", "a", "c"]);
});

test("text: badges, gating findings sorted, note lines after them, hidden by --quiet; totals name the thresholds (D18)", () => {
  const e = scale.annotate(env([{ kind: "truncated", reason: "ellipsis", box: null, line: "Weiter zur Kas", element: null, expected: null, confidence: 1 }, { kind: "placeholder", box: null, line: "Hi {name}", token: "{name}" }, { kind: "overlap", signal: "boxes", box: null, line: "a b", a: { text: "a" }, b: { text: "b" }, overlap: 0.5 }]), TH("minor", "medium"));
  const lines = render.renderText(e);
  assert.deepEqual(lines.slice(1), [
    '  critical/medium  placeholder "{name}" in "Hi {name}"',
    '  major/medium  truncated (ellipsis) "Weiter zur Kas"',
    '  note major/low  overlap "a" / "b" (50%)',
  ]);
  assert.equal(render.renderText(e, { quiet: true }).length, 3);
  const p = scale.annotate(env([{ kind: "overlap", signal: "boxes", box: null, line: "a b", a: { text: "a" }, b: { text: "b" }, overlap: 0.5 }]), TH("minor", "medium"));
  assert.deepEqual(render.renderText(p), ["PASS  a.png", '  note major/low  overlap "a" / "b" (50%)']);
  assert.deepEqual(render.renderText(p, { quiet: true }), ["PASS  a.png"]);
  assert.equal(render.totalsLine(["pass", "fail"], 1, "image", { below: 3, thresholds: TH("minor", "high") }), "2 images: 1 pass, 1 fail, 3 below threshold (--min-certainty high) (1.0 s)");
  assert.equal(render.totalsLine(["pass"], 1), "1 image: 1 pass (1.0 s)");
});

test("regate: stored severity, never the registry; old items gate and are counted", () => {
  const e = { command: "truncated", verdict: "fail", checks: [], findings: [{ kind: "truncated", reason: "edge", severity: "major", certainty: "medium", precision: 1, gate: true }, { kind: "overlap", signal: "boxes" }] };
  assert.equal(scale.regate(e, TH("critical", "low")), 1);
  assert.equal(e.findings[0].gate, false);
  assert.equal(e.verdict, "fail", "the unscaled finding still gates");
  e.findings.pop();
  scale.regate(e, TH("critical", "low"));
  assert.equal(e.verdict, "pass");
});
