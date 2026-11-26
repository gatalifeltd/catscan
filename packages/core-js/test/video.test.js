// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 07: the Node half of catscan video (args, --expect ranges, inputs, text output, schemas).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Ajv = require("ajv");
const { parse, UsageError } = require("../src/args");
const expect = require("../src/expect");
const inputs = require("../src/inputs");
const render = require("../src/render");

const fails = (fn, code, msg, hint) => assert.throws(fn, (e) => e instanceof UsageError && e.code === code
  && (msg === undefined || e.message === msg) && (hint === undefined || e.hint === hint));
const usage = (argv, code, msg, hint) => fails(() => parse(argv), code, msg, hint);

test("args: video options parse to numbers", () => {
  // Value: protects=--every/--from/--to/--frames reach the request as numbers and a flag (D6); fails_when=validateVideo stops converting or the options are dropped; why_new=new options; seam=none; no_claim=the core's checks against the video
  const o = parse(["video", "take.mp4", "--present", "GAME OVER", "--every", "0.25", "--from=1", "--to", "3.5", "--json", "--frames", "--catalog", "en.json"]);
  assert.equal(o.command, "video");
  assert.deepEqual([o.every, o.from, o.to, o.frames], [0.25, 1, 3.5, true]);
  assert.deepEqual(o.present, ["GAME OVER"]);
  const d = parse(["video", "take.mp4", "--absent", "x"]);
  assert.deepEqual([d.every, d.from, d.to, d.frames], [null, null, null, false]);
});

test("args: video usage errors carry the D20 message and hint", () => {
  // Value: protects=every video usage error exits 2 with its spec 07 Diagnostics line; fails_when=a guard is dropped or its copy changes; why_new=new command; seam=none; no_claim=none beyond protects
  usage(["video", "take.mp4"], "missing-check", "video needs --present, --absent or --expect", 'catscan video take.mp4 --present "GAME OVER"');
  usage(["video", "take.mp4", "--present", "x", "--frames"], "option-not-valid", "--frames needs --json", "catscan video take.mp4 --json --frames");
  for (const extra of [["--fallback", "none"], ["--catalog", "en.json", "--all-keys"]]) {
    usage(["video", "take.mp4", "--present", "x", ...extra], "option-not-valid", "--all-keys, --fallback and - (stdin) do not work with video");
  }
  usage(["video", "-", "--present", "x"], "option-not-valid");
  usage(["video", "take.mp4", "--present", "x", "--every", "0"], "invalid-value", "--every must be a number of seconds above 0, not 0", "--every 0.5");
  usage(["video", "take.mp4", "--present", "x", "--every", "1e3"], "invalid-value");
  usage(["video", "take.mp4", "--present", "x", "--from", "-1"], "invalid-value");
  usage(["video", "take.mp4", "--present", "x", "--from", "2", "--to", "2"], "invalid-value", "--to must be a number of seconds above --from (2), not 2", "--to 3");
  usage(["video", "take.mp4", "--present", "x", "--every", "1", "--every", "2"], "repeated-option");
  usage(["video"], "missing-path");
  // The video options belong to video only.
  usage(["check", "a.png", "--present", "x", "--every", "1"], "option-not-valid");
  usage(["read", "a.png", "--frames"], "option-not-valid");
  usage(["--every", "1", "check", "a.png", "--present", "x"], "option-not-valid"); // option before the command
  usage(["--frames", "read", "a.png"], "option-not-valid");
});

test("expect: a video file has time ranges", () => {
  // Value: protects=ranges parse to inclusive [start, end] with "4-" open-ended and bad keys rejected (D7); fails_when=RANGE_RE or the reversed check regresses; why_new=new file shape; seam=none; no_claim=matching frames to ranges (Swift VideoTests)
  const e = expect.parse('locale: de\nranges:\n  "0-2.5": {present: [Weiter]}\n  "4-": {absent: ["@k"]}\n  "1-1": {present: [x]}\n', "e.yml", "video");
  assert.equal(e.locale, "de");
  assert.deepEqual(e.ranges, [
    { key: "0-2.5", start: 0, end: 2.5, present: ["Weiter"], absent: [] },
    { key: "4-", start: 4, end: null, present: [], absent: ["@k"] },
    { key: "1-1", start: 1, end: 1, present: ["x"], absent: [] },
  ]);
  for (const bad of ['"a-b"', '"-2"', '"3-1"', '"1.5"']) {
    fails(() => expect.parse(`ranges:\n  ${bad}: {present: [x]}\n`, "e.yml", "video"), "invalid-expect-file");
  }
  fails(() => expect.parse('ranges:\n  "0-1": {visible: [x]}\n', "e.yml", "video"), "invalid-expect-file");
  // A bound too long for a double is a usage error, never an exit 5 (review finding).
  fails(() => expect.parse(`ranges:\n  "${"9".repeat(400)}-": {present: [x]}\n`, "e.yml", "video"), "invalid-expect-file");
});

test("expect: shots and ranges name the command they belong to", () => {
  // Value: protects=the cross-command expect error and its example hint (D20 invalid-expect-file); fails_when=validate accepts the other key or drops the hint; why_new=new error; seam=none; no_claim=none beyond protects
  fails(() => expect.parse('shots:\n  a.png: {present: [x]}\n', "e.yml", "video"), "invalid-expect-file",
    "e.yml: a video --expect file uses ranges:, not shots:", 'ranges: {"0-2.5": {present: [...]}}');
  fails(() => expect.parse('ranges:\n  "0-1": {present: [x]}\n', "e.yml", "check"), "invalid-expect-file",
    "e.yml: a check --expect file uses shots:, not ranges:");
  assert.equal(expect.parse('shots:\n  a.png: {present: [x]}\n', "e.yml").shots.length, 1);
});

test("inputs: a folder gives videos for video and images for the rest", () => {
  // Value: protects=D4 extension sets per command; fails_when=collect ignores its exts argument; why_new=new argument; seam=none; no_claim=none beyond protects
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-inputs-"));
  for (const f of ["a.mp4", "b.MOV", "c.png", "d.m4v"]) fs.writeFileSync(path.join(d, f), "");
  assert.deepEqual(inputs.collect([d], inputs.VIDEO_EXT).map((i) => path.basename(i.path)), ["a.mp4", "b.MOV"]);
  assert.deepEqual(inputs.collect([d]).map((i) => path.basename(i.path)), ["c.png"]);
});

const env = (checks, extra = {}) => ({ command: "video", path: "t.mp4", verdict: "fail", frames: 8, video: { width: 1, height: 1, fps: 10, duration: 4 }, checks, ...extra });

test("render: video lines (D11)", () => {
  // Value: protects=the spec 07 D11 text lines and the videos totals line (D24); fails_when=checkDetail loses its video branch or times; why_new=new output; seam=none; no_claim=none beyond protects
  const out = render.renderText(env([
    { kind: "present", text: "GAME OVER", verdict: "fail", closest: { line: "GAME 0VER", distance: 1, t: 2.5, box: [0, 0, 1, 1] }, first_seen: null, last_seen: null },
    { kind: "absent", text: "KEY_", verdict: "fail", line: "KEY_X", box: [0.1, 0.2, 0.3, 0.04], first_seen: 4.5, last_seen: 5.5 },
    { kind: "absent", text: "KEY_", verdict: "fail", line: "KEY_X", box: [0.1, 0.2, 0.3, 0.04], first_seen: 1, last_seen: 1, range: "0-2" },
    { kind: "present", text: "x", verdict: "skipped", reason: "range-empty", range: "9-" },
    { kind: "present", text: "y", verdict: "fail", closest: null, first_seen: null, last_seen: null },
    { kind: "present", text: "ok", verdict: "pass", line: "ok", first_seen: 0, last_seen: 1 },
  ]));
  assert.deepEqual(out, [
    "FAIL  t.mp4 (8 frames)",
    '  present "GAME OVER": not found on 8 frames; closest "GAME 0VER" (distance 1) at 2.5 s',
    '  absent "KEY_": shown 4.5 s-5.5 s in "KEY_X" at [0.1, 0.2, 0.3, 0.04]',
    '  absent "KEY_" [0-2]: shown 1 s in "KEY_X" at [0.1, 0.2, 0.3, 0.04]',
    '  present "x" [9-]: skipped (range-empty)',
    '  present "y": not found on 8 frames; no text recognized',
  ]);
  assert.deepEqual(render.renderText(env([], { verdict: "error", frames: 0, error: { code: "no-frames", message: "m" } })), ["ERROR t.mp4", "  no-frames: m"]);
  assert.equal(render.totalsLine(["pass", "fail"], 1.04, "video"), "2 videos: 1 pass, 1 fail (1.0 s)");
});

test("schema: video envelopes and frame lines", () => {
  // Value: protects=the D12/D15 schema contract (video, frames, first_seen, closest.t; video-frame lines); fails_when=a field is renamed or dropped from a schema; why_new=new schema; seam=none; no_claim=that the core emits it (test/video.test.js validates real output)
  const ajv = new Ajv({ allErrors: true, strict: false });
  const result = ajv.compile(require("../../../core/schema/result.schema.json"));
  const frame = ajv.compile(require("../../../core/schema/video-frame.schema.json"));
  const host = { chip: "c", arch: "arm64", host_class: "physical", macos: "27.2 (26B123)", vision_revision: 3 };
  const e = {
    schema: 1, catscan: "0.8.0", command: "video", path: "t.mp4", verdict: "fail", engine: "vision-accurate-rev3", locale: "en",
    image: null, screen: null, host, ms: 1, findings: [], warnings: [], frames: 2, video: { width: 720, height: 1280, fps: 10, duration: 4 },
    checks: [{ kind: "present", text: "x", verdict: "fail", box: null, line: null, confidence: null, first_seen: null, last_seen: null, closest: { line: "y", box: [0, 0, 1, 1], distance: 1, t: 0.5 } }],
  };
  assert.ok(result(e), JSON.stringify(result.errors));
  const { video, ...noVideo } = e;
  assert.equal(result(noVideo), false);
  assert.ok(frame({ schema: 1, catscan: "0.8.0", command: "video-frame", path: "t.mp4", t: 0.5, lines: [{ text: "a", box: [0, 0, 1, 1], confidence: 1 }] }));
  assert.equal(frame({ schema: 1, catscan: "0.8.0", command: "video-frame", path: "t.mp4", lines: [] }), false);
});

test("cli: a video request carries the sampling options and the resolved --expect ranges", () => {
  // Value: protects=cli.js builds the D3 request (every, from, to, frames, ranges with @key resolved) and prints frame lines before the envelope; fails_when=an option or the range resolution is dropped from the request; why_new=the request was only exercised through real Vision; seam=none (the documented CATSCAN_CORE_BINARY); no_claim=the core's handling (a fake core echoes the request)
  const { spawnSync } = require("child_process");
  const { PROTOCOL } = require("../src/client");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-videoreq-"));
  const take = path.join(tmp, "take.mp4");
  fs.writeFileSync(take, "");
  const cat = path.join(tmp, "en.json");
  fs.writeFileSync(cat, JSON.stringify({ over: "GAME OVER" }));
  const e = path.join(tmp, "e.yml");
  fs.writeFileSync(e, 'ranges:\n  "2-": {present: ["@over"], absent: ["KEY_"]}\n');
  const fake = path.join(tmp, "core");
  // Answers with the request it got as the envelope's `request`, plus one sample.
  fs.writeFileSync(fake, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ id: null, type: "ready", catscan: "0.0.1", protocol: ${PROTOCOL} }) + "\\n");
let b = ""; process.stdin.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\\n")) >= 0) { const r = JSON.parse(b.slice(0, i)); b = b.slice(i + 1);
process.stdout.write(JSON.stringify({ id: r.id, catscan: "0.0.1", command: "video", path: r.path, verdict: "pass", checks: [], warnings: [], request: r, samples: [{ t: 0.5, lines: [] }] }) + "\\n"); } });
`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.resolve(__dirname, "../../../bin/catscan.js"), "video", take, "--present", "x", "--every", "0.25", "--from", "1", "--to", "3",
    "--catalog", cat, "--expect", e, "--json", "--frames"], { encoding: "utf8", env: { ...process.env, CATSCAN_CORE_BINARY: fake } });
  assert.equal(r.status, 0, r.stderr);
  const [frame, env] = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(frame, { catscan: "0.0.1", command: "video-frame", lines: [], path: take, schema: 1, t: 0.5 });
  assert.equal(env.samples, undefined);
  const q = env.request;
  assert.deepEqual([q.command, q.path, q.every, q.from, q.to, q.frames, q.present], ["video", take, 0.25, 1, 3, true, ["x"]]);
  assert.equal(q.ranges.length, 1);
  assert.deepEqual([q.ranges[0].key, q.ranges[0].start, q.ranges[0].end, q.ranges[0].absent], ["2-", 2, null, ["KEY_"]]);
  assert.equal(q.ranges[0].present[0].key, "over"); // @over resolved to a catalog check
});
