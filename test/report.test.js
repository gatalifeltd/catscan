// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 18 through the CLI with the real binary: --report on every command, catscan report on shards, the serve
// thumbnail request on images and on a video frame. Images and videos are drawn at test time, none committed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { ROOT, BIN, setup, cli } = require("./helpers");
const { Server } = require("../packages/core-js/src/client");

const synth = setup();
const dataOf = (file) => JSON.parse(fs.readFileSync(file, "utf8").match(/<script type="application\/json" id="catscan-data">([^]*?)<\/script>/)[1]);

/** shots/<locale>/<screen>.png from the synthetic set, in a fresh folder. */
function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-report-it-"));
  for (const [l, s, f] of [["en", "home", "01-en-phone.png"], ["en", "raw", "14-en-raw-key.png"], ["de", "home", "03-de-phone.png"]]) {
    fs.mkdirSync(path.join(dir, "shots", l), { recursive: true });
    fs.copyFileSync(path.join(synth, f), path.join(dir, "shots", l, `${s}.png`));
  }
  return dir;
}

let videoDir = null;
function video() {
  if (videoDir) return videoDir;
  const gen = path.join(ROOT, ".build/video");
  const src = path.join(__dirname, "fixtures/video.swift");
  if (!fs.existsSync(gen) || fs.statSync(gen).mtimeMs < fs.statSync(src).mtimeMs) {
    fs.mkdirSync(path.dirname(gen), { recursive: true });
    execFileSync("swiftc", ["-O", src, "-o", gen]);
  }
  videoDir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-report-video-"));
  const spec = require("./fixtures/videos.json").filter((v) => v.name === "timed.mp4");
  fs.writeFileSync(path.join(videoDir, "videos.json"), JSON.stringify(spec));
  execFileSync(gen, [path.join(videoDir, "videos.json"), videoDir]);
  return videoDir;
}

test("check over {locale}/{screen} with --report and an absent expected locale: written, missing in the matrix, exit 1", () => {
  const dir = tree();
  const r = cli(["check", "shots", "--present", "Welcome back", "--expect-locales", "en,de,fr", "--report", "out/report.html", "-q"], { cwd: dir });
  assert.equal(r.code, 4, r.stderr);
  // The report folder must exist: the write fails like the results file, exit 4 (D10).
  assert.match(r.stderr, /catscan: report-write-failed: cannot write the HTML report out\/report\.html/);
  fs.mkdirSync(path.join(dir, "out"));
  const ok = cli(["check", "shots", "--present", "Welcome back", "--expect-locales", "en,de,fr", "--report", "out/report.html", "-q"], { cwd: dir });
  assert.equal(ok.code, 1, ok.stderr);
  assert.match(ok.stderr, /catscan: report: out\/report\.html \(\d+\.\d MB, 3 images\)/);
  const d = dataOf(path.join(dir, "out/report.html"));
  assert.deepEqual(d.matrix.missing.map((m) => `${m.locale}/${m.screen}`), ["de/raw", "fr/home", "fr/raw"]);
  assert.equal(d.matrix.cells.find((c) => c.locale === "fr" && c.screen === "home").state, "missing");
  assert.equal(d.blobs.length, 3);
  assert.ok(d.blobs.every((b) => b.startsWith("data:image/jpeg;base64,/9j/")), "JPEG data URIs");
  const it = d.items.find((x) => x.path === "shots/en/home.png").image;
  assert.equal(Math.max(it.width, it.height), 800, "scaled to the default long edge");
});

test("each command writes a report; --results and --report together match catscan report on the results file (D1)", () => {
  const dir = tree();
  for (const argv of [["check", "shots", "--present", "Weiter"], ["read", "shots"], ["truncated", "shots"], ["untranslated", "shots/en"]]) {
    const r = cli([...argv, "--report", `${argv[0]}.html`, "--results", `${argv[0]}.json`, "-q"], { cwd: dir });
    assert.ok([0, 1].includes(r.code), `${argv[0]}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`catscan: report: ${argv[0]}\\.html `));
    const again = cli(["report", `${argv[0]}.json`, "--out", `${argv[0]}-2.html`], { cwd: dir });
    assert.equal(again.code, r.code, again.stderr);
    assert.equal(fs.readFileSync(path.join(dir, `${argv[0]}-2.html`), "utf8"), fs.readFileSync(path.join(dir, `${argv[0]}.html`), "utf8"), argv[0]);
  }
  const raw = dataOf(path.join(dir, "untranslated.html")).items.find((x) => x.path === "shots/en/raw.png");
  assert.ok(raw.kinds.includes("raw-key"), "the finding kind reaches the filters");
});

test("video: --report writes a timeline with frame thumbnails at failed times (D5)", () => {
  const vd = video();
  const r = cli(["video", path.join(vd, "timed.mp4"), "--present", "GAME OVER", "--present", "Never shown", "--report", path.join(vd, "v.html")], { cwd: vd });
  assert.equal(r.code, 1, r.stderr);
  const d = dataOf(path.join(vd, "v.html"));
  const it = d.items.find((x) => x.video);
  assert.equal(it.timeline.duration, 4);
  assert.ok(it.timeline.marks.some((m) => m.type === "first_seen") && it.timeline.marks.some((m) => m.type === "closest"));
  assert.equal(it.timeline.frames.length, 1);
  assert.equal(typeof it.timeline.frames[0].image.blob, "number");
});

test("catscan report: two shard files render one matrix; a deleted image is a placeholder with the warning", () => {
  const dir = tree();
  // Two shards, each a {locale}/{screen} tree of its own.
  fs.mkdirSync(path.join(dir, "b"));
  fs.renameSync(path.join(dir, "shots/de"), path.join(dir, "b/de"));
  assert.equal(cli(["check", "shots", "--present", "Welcome back", "--results", "a.json", "-q"], { cwd: dir }).code, 1);
  assert.equal(cli(["check", "b", "--present", "Welcome back", "--results", "b.json", "-q"], { cwd: dir }).code, 1);
  fs.rmSync(path.join(dir, "b/de/home.png"));
  const r = cli(["report", "a.json", "b.json", "--expect-locales", "en,de", "--layout", "{locale}/{screen}"], { cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /catscan: report-image-missing: .*b\/de\/home\.png: not found; the report shows a placeholder/);
  assert.match(r.stderr, /catscan: report: catscan-report\.html \(\d+\.\d MB, 2 images\)/);
  const d = dataOf(path.join(dir, "catscan-report.html"));
  assert.equal(d.run.shards.length, 2);
  assert.deepEqual(d.matrix.locales, ["de", "en"]);
  assert.equal(d.items.find((x) => x.path === "b/de/home.png").image.blob, null);
});

test("serve thumbnail: an image and a video frame at t; missing and unreadable files are error envelopes (D6)", async (t) => {
  const vd = video();
  const s = new Server({ bin: BIN });
  t.after(() => { if (!s.exited) s.proc.kill(); }); // a failed assertion must not leave serve holding the test open
  await s.ready;
  const img = await s.request({ id: "a", command: "thumbnail", path: path.join(synth, "01-en-phone.png"), max_edge: 300, quality: 0.7 });
  assert.deepEqual([img.id, Math.max(img.width, img.height)], ["a", 300]);
  const frame = await s.request({ id: "b", command: "thumbnail", path: path.join(vd, "timed.mp4"), max_edge: 200, quality: 0.5, t: 2.5 });
  assert.equal(frame.height, 200);
  assert.ok(Math.abs(frame.width - 112.5) <= 1, `${frame.width}: the 720x1280 frame scaled to 200`);
  assert.ok(Buffer.from(frame.jpeg, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
  assert.equal((await s.request({ id: "c", command: "thumbnail", path: path.join(vd, "none.png"), max_edge: 200, quality: 0.5 })).error.code, "input-not-found");
  fs.writeFileSync(path.join(vd, "text.png"), "not an image");
  assert.equal((await s.request({ id: "d", command: "thumbnail", path: path.join(vd, "text.png"), max_edge: 200, quality: 0.5 })).error.code, "input-unreadable");
  assert.equal((await s.request({ id: "e", command: "thumbnail", path: "x.png", max_edge: 0, quality: 0.5 })).error.code, "invalid-request");
  await s.close();
});

test("--results and --report land together: a run killed while thumbnails are made keeps the previous results file (D10, outside-voice fix)", () => {
  const dir = tree();
  fs.writeFileSync(path.join(dir, "r.json"), "old");
  // A core that serves the run but never answers a thumbnail request; the run is then killed, as a CI timeout would.
  const fake = path.join(dir, "core.js");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const { spawn } = require("child_process");
const real = spawn(${JSON.stringify(BIN)}, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
real.stdout.pipe(process.stdout);
let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.includes('"thumbnail"')) continue; real.stdin.write(l + "\\n"); } });
`, { mode: 0o755 });
  const r = cli(["check", "shots", "--present", "Welcome back", "--results", "r.json", "--report", "r.html", "-q"], { cwd: dir, env: { CATSCAN_CORE_BINARY: fake }, timeout: 8000 });
  try { execFileSync("pkill", ["-f", fake]); } catch {} // the killed CLI leaves its core behind
  assert.equal(r.code, null, "killed by the timeout");
  assert.equal(fs.readFileSync(path.join(dir, "r.json"), "utf8"), "old");
  assert.ok(!fs.existsSync(path.join(dir, "r.html")));
});

test("a report that cannot be written fails the report alone: --results is still written, exit 4 (D10)", () => {
  const dir = tree();
  // --report under a path whose parent is a file.
  fs.writeFileSync(path.join(dir, "file"), "x");
  const r = cli(["check", "shots", "--present", "Welcome back", "--results", "r.json", "--report", "file/r.html", "-q"], { cwd: dir });
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /catscan: report-write-failed: /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "r.json"), "utf8")).results_schema, 1);
});
