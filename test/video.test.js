// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 07 through the CLI with real AVFoundation decode and Vision, on videos written by test/fixtures/video.swift.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");
const { Server } = require("../packages/core-js/src/client");

setup();
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(require("../core/schema/result.schema.json"));
const validateFrame = ajv.compile(require("../core/schema/video-frame.schema.json"));

const gen = path.join(ROOT, ".build/video");
const src = path.join(__dirname, "fixtures/video.swift");
if (!fs.existsSync(gen) || fs.statSync(gen).mtimeMs < fs.statSync(src).mtimeMs) {
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  execFileSync("swiftc", ["-O", src, "-o", gen]);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-video-"));
const log = execFileSync(gen, [path.join(__dirname, "fixtures/videos.json"), dir], { encoding: "utf8" });
const skipped = Object.fromEntries([...log.matchAll(/^skip (\S+): (.+)$/gm)].map((m) => [m[1], m[2]]));
const V = (n) => path.join(dir, n);

// Corrupt and audio-only inputs (D16): random bytes, and AAC in an MP4 container from a generated WAV.
fs.writeFileSync(V("corrupt.mp4"), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251)));
const wav = Buffer.alloc(44 + 16000 * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + 32000, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(32000, 40);
fs.writeFileSync(V("tone.wav"), wav);
execFileSync("afconvert", ["-f", "mp4f", "-d", "aac", V("tone.wav"), V("audio.mp4")]);

test("timed take: first and last seen within one interval, one-frame absent fails", () => {
  // Value: protects=spec 07 Tests "first and last seen" and "absent checks" on a real decode; fails_when=sampling, zero-tolerance seeks or aggregation drift by a frame; why_new=new command; seam=none; no_claim=codecs other than H.264 (next tests)
  const r = cli(["video", V("timed.mp4"), "--present", "GAME OVER", "--present", "Tap to start", "--absent", "KEY_RAW_LABEL", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  const env = r.json[0];
  assert.ok(validate(env), JSON.stringify(validate.errors));
  assert.equal(env.command, "video");
  assert.equal(env.image, null);
  assert.deepEqual(env.video, { width: 720, height: 1280, fps: 10, duration: 4 });
  assert.equal(env.frames, 8);
  const [over, tap, key] = env.checks;
  // Drawn 2.0-3.5 s, sampled every 0.5 s.
  assert.equal(over.verdict, "pass");
  assert.ok(over.first_seen >= 2 && over.first_seen <= 2.5, `${over.first_seen}`);
  assert.ok(over.last_seen >= 3 && over.last_seen <= 3.5, `${over.last_seen}`);
  assert.equal(tap.first_seen, 0);
  // Drawn 1.0-1.1 s: on the 1.0 s sample only.
  assert.equal(key.verdict, "fail");
  assert.deepEqual([key.first_seen, key.last_seen], [1, 1]);
  const text = cli(["video", V("timed.mp4"), "--absent", "KEY_RAW_LABEL"]);
  assert.match(text.stdout, /^FAIL {2}.+timed\.mp4 \(8 frames\)\n {2}critical\/medium {2}absent "KEY_RAW_LABEL": shown 1 s in "KEY_RAW_LABEL" at \[/);
  assert.match(text.stdout, /\n1 video: 0 pass, 1 fail \(/);
});

test("hevc MOV and a rotated phone recording", (t) => {
  // Value: protects=spec 07 Inputs (HEVC, MOV) and appliesPreferredTrackTransform (upright size and text); fails_when=the transform is dropped or a codec is refused; why_new=new; seam=none; no_claim=ProRes (not generated)
  const rot = cli(["video", V("rotated.mov"), "--present", "Portrait mode", "--json"]);
  assert.equal(rot.code, 0, rot.stderr);
  assert.deepEqual([rot.json[0].video.width, rot.json[0].video.height], [720, 1280]);
  if (skipped["hevc.mov"]) return t.skip(`host-skip: ${skipped["hevc.mov"]}`);
  const r = cli(["video", V("hevc.mov"), "--present", "Level complete", "--json", "--every", "0.25"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json[0].checks[0].first_seen >= 1 && r.json[0].checks[0].first_seen <= 1.25);
});

test("--expect ranges pass and fail per range; an empty range warns under --quiet", () => {
  // Value: protects=D7 ranges end to end and D21 (range-empty survives --quiet); fails_when=ranges are not sent or matched, or the warning is filtered; why_new=new; seam=none; no_claim=none beyond protects
  const e = path.join(dir, "e.yml");
  fs.writeFileSync(e, 'ranges:\n  "0-1": {present: ["Tap to start"], absent: ["GAME OVER"]}\n  "2-": {present: ["GAME OVER"]}\n  "0.1-0.2": {present: ["x"]}\n  "3-3.4": {absent: ["GAME OVER"]}\n');
  const r = cli(["video", V("timed.mp4"), "--expect", e, "--json", "--quiet"]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json[0].checks.map((c) => [c.range, c.verdict]), [["0-1", "pass"], ["0-1", "pass"], ["2-", "pass"], ["0.1-0.2", "skipped"], ["3-3.4", "fail"]]);
  assert.match(r.stderr, /^catscan: range-empty: the --expect range "0\.1-0\.2" has no sampled frame \(every 0\.5 s from 0 s to the end\) - try: a smaller --every, or widen the range$/m);
});

test("TODO-007 --fail-on-skip: an empty --expect range alone turns exit 0 into 1 (D7)", () => {
  // Value: protects=D7 (any skipped verdict counts, not a reason list); fails_when=detection lists catalog reasons only; why_new=only video produces range-empty; seam=none; no_claim=none beyond protects
  const e = path.join(dir, "e7.yml");
  fs.writeFileSync(e, 'ranges:\n  "0-1": {present: ["Tap to start"]}\n  "0.1-0.2": {present: ["x"]}\n');
  assert.equal(cli(["video", V("timed.mp4"), "--expect", e, "--quiet"]).code, 0);
  const r = cli(["video", V("timed.mp4"), "--expect", e, "--quiet", "--fail-on-skip"]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^catscan: checks-skipped: 1 check was skipped \(range-empty 1\)/m);
});

test("--json --frames: one frame line per sample before the envelope", () => {
  // Value: protects=D15/D23 frame lines, their order and schema, and plain --json without them; fails_when=samples leak into the envelope or lines are reordered; why_new=new; seam=none; no_claim=none beyond protects
  const r = cli(["video", V("timed.mp4"), "--present", "GAME OVER", "--json", "--frames", "--every", "1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.map((l) => l.command), ["video-frame", "video-frame", "video-frame", "video-frame", "video"]);
  for (const f of r.json.slice(0, 4)) assert.ok(validateFrame(f), JSON.stringify(validateFrame.errors));
  assert.deepEqual(r.json.slice(0, 4).map((f) => f.t), [0, 1, 2, 3]);
  assert.ok(r.json[2].lines.some((l) => l.text === "GAME OVER"));
  assert.equal(r.json[4].samples, undefined);
  assert.equal(cli(["video", V("timed.mp4"), "--present", "GAME OVER", "--json"]).json.length, 1);
});

test("bad input: corrupt, audio-only, wrong command, no frames, empty folder (exit 4)", () => {
  // Value: protects=D16/D20 input errors with their full stderr lines and exit 4; fails_when=an error turns into a crash, exit 5 or loses its hint; why_new=new; seam=none; no_claim=none beyond protects
  const err = (args, re) => {
    const r = cli(args);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, re);
  };
  const p = (n) => V(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  err(["video", V("corrupt.mp4"), "--present", "x"], new RegExp(`^catscan: input-unreadable: ${p("corrupt.mp4")}: Not a readable MP4 or MOV video\\. - try: catscan check ${p("corrupt.mp4")} when it is an image$`, "m"));
  err(["video", V("audio.mp4"), "--present", "x"], new RegExp(`^catscan: no-video-track: ${p("audio.mp4")}: The file has no video track\\. - try: catscan read or catscan check for images`, "m"));
  err(["check", V("timed.mp4"), "--present", "x"], new RegExp(`input-unreadable: .+ - try: catscan video ${p("timed.mp4")}$`, "m"));
  err(["video", V("timed.mp4"), "--present", "x", "--from", "9"], /no-frames: .+No frame between --from 9 s and --to 4 s; the video is 4 s long\. - try: --from 0$/m);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-novideo-"));
  err(["video", empty, "--present", "x"], /no-videos: .+: The folder has no \.mp4 or \.mov videos\. - try: check the path, or catscan check for images$/m);
  const clamp = cli(["video", V("timed.mp4"), "--present", "GAME OVER", "--every", "0.01", "--from", "2", "--to", "2.3", "--quiet"]);
  assert.equal(clamp.code, 0, clamp.stderr);
  assert.match(clamp.stderr, /^catscan: every-clamped: --every 0\.01 is shorter than one frame at 10 fps; sampling every frame \(0\.1 s\) - try: --every 0\.1$/m);
});

test("serve answers a video request", async () => {
  // Value: protects=D3 protocol 4 video requests through the shared client, and the image refusal; fails_when=serve keeps video as planned or accepts image; why_new=new; seam=none; no_claim=none beyond protects
  const s = new Server();
  await s.ready;
  const ok = await s.request({ id: "v", command: "video", path: V("timed.mp4"), present: ["GAME OVER"], every: 1, frames: true });
  assert.equal(ok.verdict, "pass");
  assert.equal(ok.samples.length, 4);
  const bad = await s.request({ id: "w", command: "video", image: "AAAA" });
  assert.equal(bad.error.code, "invalid-request");
  // Added by /ship coverage audit.
  // Value: protects=D3 a video request without path is refused; fails_when=the path guard is dropped and the engine gets a nil path; why_new=only the image refusal had a row; seam=none; no_claim=none beyond protects
  const noPath = await s.request({ id: "x", command: "video", present: ["x"] });
  assert.equal(noPath.error.code, "invalid-request");
  await s.close();
});

// Added by /ship coverage audit.
test("video does not fall back to Tesseract: a locale Vision cannot read is unsupported, ranges included (D8)", () => {
  // Value: protects=D8 unsupported-language for video and the range-aware check skeleton; fails_when=video falls back to Tesseract or the skeleton drops range checks or first_seen; why_new=no video test used an unreadable locale; seam=none; no_claim=locales other than el
  const e = path.join(dir, "d8.yml");
  fs.writeFileSync(e, 'ranges:\n  "0-1": {absent: ["x"]}\n');
  const r = cli(["video", V("timed.mp4"), "--present", "GAME OVER", "--expect", e, "--locale", "el", "--json"]);
  assert.equal(r.code, 3, r.stderr);
  const env = r.json[0];
  assert.ok(validate(env), JSON.stringify(validate.errors));
  assert.equal(env.verdict, "unsupported");
  assert.equal(env.error.code, "unsupported-language");
  // TODO-065: true for video only, so the message says screenshots of el are read.
  assert.equal(env.error.message, "catscan video does not read the locale el; screenshots of it are read with Tesseract.");
  assert.deepEqual(env.checks.map((c) => [c.range ?? null, c.verdict, c.first_seen]), [[null, "unsupported", null], ["0-1", "unsupported", null]]);
});

// Added by /ship coverage audit.
test("a range check in a script the locale cannot read warns and is unsupported", () => {
  // Value: protects=the engine's locale-script guard reads --expect range texts (spec 07 Engine change); fails_when=ranges are left out of the script scan and the warning or hint vanishes; why_new=only top-level checks were scanned in tests; seam=none; no_claim=automatic locale pick for a single-candidate script
  const e = path.join(dir, "cyr.yml");
  fs.writeFileSync(e, 'ranges:\n  "0-1": {absent: ["Продолжить"]}\n');
  const r = cli(["video", V("timed.mp4"), "--present", "GAME OVER", "--expect", e, "--locale", "en", "--json", "-q"]);
  assert.equal(r.code, 3, r.stderr);
  const env = r.json[0];
  assert.equal(env.verdict, "unsupported");
  assert.equal(env.error.code, "unsupported-script");
  assert.ok(env.warnings.some((w) => w.code === "locale-script-mismatch"), JSON.stringify(env.warnings));
  assert.deepEqual(env.checks.map((c) => c.verdict), ["pass", "unsupported"]);
  assert.match(r.stderr, /catscan: locale-script-mismatch: /);
});

// Added by /ship coverage audit.
test("--expect ranges take @key from --catalog, and an unknown key names its range", () => {
  // Value: protects=cli.js resolves @key inside ranges (expect.shots || expect.ranges) and sends catalog checks per range; fails_when=ranges skip catalog resolution and @key is matched literally; why_new=@key in --expect was tested for shots only; seam=none; no_claim=non-JSON catalog formats
  const cat = path.join(dir, "video-cat.json");
  fs.writeFileSync(cat, JSON.stringify({ over: "GAME OVER", tap: "Tap to start" }));
  const e = path.join(dir, "keys.yml");
  fs.writeFileSync(e, 'ranges:\n  "2-": {present: ["@over"]}\n  "0-1": {absent: ["@over"], present: ["@tap"]}\n');
  const r = cli(["video", V("timed.mp4"), "--catalog", cat, "--expect", e, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json[0].checks.map((c) => [c.range, c.kind, c.key, c.verdict]),
    [["2-", "present", "over", "pass"], ["0-1", "present", "tap", "pass"], ["0-1", "absent", "over", "pass"]]);
  fs.writeFileSync(e, 'ranges:\n  "2-": {present: ["@ovr"]}\n');
  const u = cli(["video", V("timed.mp4"), "--catalog", cat, "--expect", e]);
  assert.equal(u.code, 2);
  assert.match(u.stderr, /unknown-catalog-key: .*keys\.yml: ranges\.2-\.present: the catalogs define no key ovr/);
});

test("audio that runs past the last video frame does not end the take in an error", () => {
  // Value: protects=sampling stops at the video track's end, not the asset's (audio 3.5 s, video 2 s); fails_when=duration comes from the asset and a zero-tolerance seek past the last frame gives exit 4; why_new=review finding (red team); seam=none; no_claim=AAC audio (the fixture writes LPCM in a MOV)
  const r = cli(["video", V("audio-long.mov"), "--present", "Recording ends", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json[0].video.duration, 2);
  assert.equal(r.json[0].frames, 4);
});

test("a video run whose --expect file has no checks warns no-checks", () => {
  // Value: protects=an empty ranges: file never passes silently; fails_when=the video request skips the unchecked set; why_new=review finding (red team); seam=none; no_claim=none beyond protects
  const e = path.join(dir, "empty.yml");
  fs.writeFileSync(e, 'ranges:\n  "0-1": {}\n');
  const r = cli(["video", V("timed.mp4"), "--expect", e, "--quiet"]);
  assert.match(r.stderr, /^catscan: no-checks: no check applies to .+timed\.mp4 - try: add --present\/--absent or checks under an --expect range$/m);
});
