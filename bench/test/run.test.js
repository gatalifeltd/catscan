// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 05 runner end to end with the generator and `serve` stubbed: where a run writes, the gate and quick exits,
// the record rules, the meta merge and progress (D11-D14). No Vision.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../languages/run");
const T = require("../languages/table");

const VERSION = { catscan: "0.0.0", macos: "99.1", macos_build: "99A1", vision_revision: 3, host: { chip: "Test chip", host_class: "physical" } };

/** A stub host; `answer(req)` gives the serve response. */
function host(answer, x = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-root-"));
  return {
    root,
    client: {
      binaryPath: () => "/stub/catscan-core",
      doctorInfo: () => ({ fallback: { path: null } }),
      versionInfo: () => ({ ...VERSION, ...(x.version || {}) }),
      Server: class { constructor() { this.ready = Promise.resolve(); } async request(req) { return { id: req.id, ...answer(req) }; } async close() {} },
    },
    swiftc: () => "swift", buildGen: () => {}, gen: (planFile) => ({ fonts: { [JSON.parse(fs.readFileSync(planFile, "utf8"))[0].locale]: ["Stub-Regular 1.0"] } }),
    load: () => ({ sims: 0, emus: 0 }), git: () => "abc123", machine: () => "Mac0,0", swift: () => "Swift 0", tesseract: () => [],
  };
}
/** Reads every string correctly; flags every cut image. */
const good = (req) => {
  if (req.command === "check") {
    return { verdict: "pass", engine: "vision-stub", ms: 5, checks: [
      ...(req.present || []).map((t) => ({ kind: "present", text: t, verdict: "pass" })),
      ...(req.absent || []).map((t) => ({ kind: "absent", text: t, verdict: "pass" }))] };
  }
  if (req.command === "truncated") return { verdict: "pass", findings: /-fit-/.test(req.path) ? [] : [{ reason: "screen-edge" }] };
  return { verdict: "pass", lines: [{ text: "x", confidence: 0.9 }] };
};
/** Misses every `present` check. */
const blind = (req) => {
  const r = good(req);
  if (req.command === "check") r.checks = r.checks.map((c) => (c.kind === "present" ? { ...c, verdict: "fail", closest: null } : c));
  return r;
};

/** Runs main with stderr and stdout captured. */
async function run(argv, h) {
  const err = [], out = [];
  const [w, e, l] = [process.stderr.write, console.error, console.log];
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  console.error = (...a) => err.push(a.join(" "));
  console.log = (...a) => out.push(a.join(" "));
  try { return { code: await R.main(argv, h), err: err.join("\n"), out: out.join("\n") }; } finally { [process.stderr.write, console.error, console.log] = [w, e, l]; }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bench-out-"));

test("a full run without --record writes to --out only, with progress and the meta of the run", async () => {
  const h = host(good), out = tmp();
  const r = await run(["--lang", "de", "--out", out], h);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /gate passed/);
  assert.match(r.err, /de: 500\/2160 images/);
  assert.match(r.err, /\[1\/1\] de: 2160 images, check accuracy 100%/);
  assert.ok(!fs.existsSync(path.join(h.root, "bench/results")), "nothing under bench/results without --record");
  const s = T.readSummaryCsv(path.join(out, "summary.csv")).summaries;
  assert.deepEqual([s[0].locale, s[0].check_accuracy, s[0].trunc_recall, s[0].median_ms], ["de", 100, 1, 5]);
  const meta = JSON.parse(fs.readFileSync(path.join(out, "meta.json"), "utf8"));
  assert.equal(meta.commit, "abc123");
  assert.deepEqual(meta.fonts, { de: ["Stub-Regular 1.0"] });
  assert.equal(meta.runs.length, 1);
  assert.match(meta.timing, /^no simulator/);
});

test("the full-run gate fails with exit 1 and names the language; timing under load is marked", async () => {
  const h = host(blind);
  h.load = () => ({ sims: 1, emus: 0 });
  const out = tmp();
  const r = await run(["--lang", "de", "--out", out], h);
  assert.equal(r.code, 1);
  assert.match(r.err, /gate failed .*\n {2}de: check accuracy 75% < 98%/);
  assert.match(JSON.parse(fs.readFileSync(path.join(out, "meta.json"), "utf8")).timing, /^under load: 1 simulator/);
});

test("--quick --record writes the record; a later quick run matches it, a regression names --record", async () => {
  const h = host(good);
  assert.equal((await run(["--quick", "--record", "--lang", "de"], h)).code, 0);
  const rec = path.join(h.root, "bench/results/99.1");
  assert.ok(fs.existsSync(path.join(rec, "quick-summary.csv")) && fs.existsSync(path.join(rec, "quick/de.csv")));
  const same = await run(["--quick", "--lang", "de", "--out", tmp()], h);
  assert.equal(same.code, 0, same.err);
  assert.match(same.out, /matches the recorded one/);
  const worse = await run(["--quick", "--lang", "de", "--out", tmp()], { ...h, client: host(blind).client });
  assert.equal(worse.code, 1);
  assert.match(worse.err, /de: check 30\/40, recorded 40\/40/);
  assert.match(worse.err, /de\/00-fit-16-light-flat\.png: present fail/);
  assert.match(worse.err, /rerun with --record and commit bench\/results\/99\.1\/quick-summary\.csv/);
});

test("a quick run with no record exits 1 naming --record; another build warns", async () => {
  const h = host(good);
  const none = await run(["--quick", "--lang", "de", "--out", tmp()], h);
  assert.equal(none.code, 1);
  assert.match(none.err, /no recorded quick run for macOS 99\.1 .*--quick --record/);
  await run(["--quick", "--record", "--lang", "de"], h);
  const other = await run(["--quick", "--lang", "de", "--out", tmp()], { ...h, client: host(good, { version: { macos_build: "99A2" } }).client });
  assert.equal(other.code, 0);
  assert.match(other.err, /the record was made with .*macos_build=99A1 .*; this run is .*macos_build=99A2/);
});

test("--record refuses a run with errored images", async () => {
  const h = host((req) => (req.command === "check" ? { verdict: "error", error: { code: "decode-failed" } } : good(req)));
  const r = await run(["--quick", "--record", "--lang", "de"], h);
  assert.equal(r.code, 1);
  assert.match(r.err, /not a usable record, images errored: de \(30\)/);
  assert.ok(!fs.existsSync(path.join(h.root, "bench/results/99.1/quick-summary.csv")), "a refused record writes nothing");
  assert.deepEqual(fs.readdirSync(path.join(h.root, "bench/results/99.1/quick")), []);
});

test("a --lang re-record keeps the other languages' rows, fonts and runs (D12)", async () => {
  const h = host(good);
  await run(["--quick", "--record", "--lang", "de"], h);
  await run(["--quick", "--record", "--lang", "en"], h);
  const rec = path.join(h.root, "bench/results/99.1");
  assert.deepEqual(T.readSummaryCsv(path.join(rec, "quick-summary.csv")).summaries.map((s) => s.locale), ["en", "de"]);
  const meta = JSON.parse(fs.readFileSync(path.join(rec, "quick-meta.json"), "utf8"));
  assert.deepEqual(meta.locales, ["en", "de"]);
  assert.deepEqual(Object.keys(meta.fonts).sort(), ["de", "en"]);
  assert.deepEqual(meta.runs.map((x) => x.locales), [["de"], ["en"]]);
  await run(["--quick", "--record", "--lang", "de"], h); // replaces the first run
  const again = JSON.parse(fs.readFileSync(path.join(rec, "quick-meta.json"), "utf8"));
  assert.deepEqual(again.runs.map((x) => x.locales), [["en"], ["de"]]);
});

test("a missing prerequisite exits 2 before anything is written", async () => {
  const h = host(good);
  h.swiftc = () => null;
  const out = tmp();
  const r = await run(["--lang", "de", "--out", out], h);
  assert.equal(r.code, 2);
  assert.match(r.err, /swiftc not found/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test("a full run prints the user's numbers next to the committed run of the same macOS version (spec 11 D15)", async () => {
  const h = host(good);
  let r = await run(["--lang", "de", "--out", tmp()], h);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /no committed run for macOS 99\.1 \(bench\/results\/99\.1\/summary\.csv\)/);
  const d = path.join(h.root, "bench/results/99.1");
  fs.mkdirSync(d, { recursive: true });
  const row = (locale, x) => ({ locale, engine: "vision-accurate-rev3", check_accuracy: 97.5, fit_recall: 0.9, cer: 0.01, trunc_tp: 1, trunc_fp: 0, trunc_fn: 0, median_ms: 42, ...x });
  fs.writeFileSync(path.join(d, "summary.csv"), T.summaryCsv(VERSION, [row("de"), row("en", { check_accuracy: 10 })]));
  r = await run(["--lang", "de", "--out", tmp()], h);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /your run next to bench\/results\/99\.1\//);
  // Only the languages of this run are compared: en (10%) is not the reference's lowest.
  assert.match(r.out, /Vision \(1 languages\): check accuracy median 100\.00% \[97\.50%\], lowest 100\.00% de \[97\.50% de\], median ms 5 \[42\]/);
  const q = await run(["--quick", "--lang", "de", "--out", tmp()], h);
  assert.doesNotMatch(q.out, /your run next to/);
  // A run that fails the gate still prints the comparison.
  const f = await run(["--lang", "de", "--out", tmp()], { ...host(blind), root: h.root });
  assert.equal(f.code, 1);
  assert.match(f.out, /your run next to bench\/results\/99\.1\//);
});
