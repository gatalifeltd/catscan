// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-054 integration (real Vision): images from bench/contrast/generate.swift --only (grey on white fails, near-black
// on white passes, text on a photo is busy-background), read by the CLI and through serve.
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
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-contrast-"));
const FAIL = "light-flat-plain-HelveticaNeue-Bold-11-2_5", PASS = "light-flat-plain-HelveticaNeue-Bold-11-15_0", BUSY = "light-photo-under-plain-HelveticaNeue-Bold-15-15_0";
const gen = path.join(DIR, "gen");
execFileSync("swiftc", ["-O", path.join(ROOT, "bench/contrast/generate.swift"), "-o", gen]);
execFileSync(gen, [path.join(DIR, "shots"), "--only", [FAIL, PASS, BUSY].join(",")]);
const shots = path.join(DIR, "shots", "en-s2");
const file = (cell) => path.join(shots, fs.readdirSync(shots).find((f) => f.includes(cell)));

// Value: protects=the command end to end on Vision: exit codes, finding fields with suggest, the envelope's lines with per-line contrast, the schema; fails_when=the core field, the envelope or the CLI wiring break; why_new=new command; seam=none; no_claim=precision and recall (bench/contrast.js)
test("contrast: grey on white fails with a fix, near-black passes, text on a photo is busy-background", () => {
  const r = cli(["contrast", file(FAIL), file(PASS), file(BUSY), "--scale", "2", "--experimental", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  for (const e of r.json) assert.ok(validate(e), JSON.stringify(validate.errors));
  const by = Object.fromEntries(r.json.map((e) => [[FAIL, PASS, BUSY].find((c) => e.path.includes(c)), e]));
  const f = by[FAIL].findings.find((x) => x.kind === "low-contrast");
  assert.ok(f, JSON.stringify(by[FAIL]));
  assert.ok(f.ratio < 2.7 && f.ratio > 2.3, String(f.ratio));
  assert.equal(f.threshold, 4.5);
  assert.equal(f.scale_source, "flag");
  assert.equal(f.suggest, "#767676");
  assert.equal(by[PASS].verdict, "pass");
  assert.ok(by[PASS].lines.length && by[PASS].lines.every((l) => l.contrast && (l.contrast.skipped || l.contrast.ratio > 10)), JSON.stringify(by[PASS].lines));
  assert.deepEqual(by[BUSY].findings.map((x) => x.kind), ["busy-background"]);
  // Text mode: the fix line, the summary line; exit 0 when only the passing image runs.
  const t = cli(["contrast", file(FAIL), "--scale", "2", "--experimental"]);
  assert.match(t.stdout, /low-contrast ".*" 2\.\d\d:1 < 4\.5:1 \(normal, ink #[0-9A-F]{6} on #FFFFFF\) at \[.*\]; fix: ink #767676 or darker/);
  assert.match(t.stdout, /^contrast: 1 low-contrast, 0 busy-background on 1 of 1 screen; worst 2\.\d\d:1/m);
  assert.equal(cli(["contrast", file(PASS), "--scale", "2", "--experimental"]).code, 0);
});

// Value: protects=D24 contrast-scale-unknown once per run and kept under --quiet, D28 the gate as a usage error; fails_when=the warning repeats, hides under --quiet, or an ungated kind runs without --experimental; why_new=new; seam=none; no_claim=the iOS size table (core-js unit)
test("contrast: unknown scale is warned once under --quiet; without --experimental the run stops with exit 2", () => {
  const q = cli(["contrast", file(FAIL), file(PASS), "--experimental", "--quiet"]);
  assert.equal(q.stderr.split("contrast-scale-unknown").length - 1, 1, q.stderr);
  assert.match(q.stderr, /adb shell wm density \/ 160/);
  const g = cli(["contrast", file(FAIL)]);
  assert.equal(g.code, 2);
  assert.match(g.stderr, /experimental-command: low-contrast without --boxes has not passed its gate/);
});

// Value: protects=the serve contract for contrast (protocol 21, the contrast field, invalid-request for each field); fails_when=the core and client drift; why_new=new field; seam=none; no_claim=none beyond protects
test("serve: a contrast request; a bad level or scale is invalid-request", async () => {
  const s = new Server();
  try {
    await s.ready;
    const ok = await s.request({ id: "c1", command: "contrast", path: file(FAIL), locale: "en", contrast: { level: "AAA", scale: 2, scale_source: "flag", kinds: ["low-contrast"] } });
    assert.deepEqual(ok.findings.map((f) => [f.kind, f.threshold]), [["low-contrast", 7]]);
    for (const [k, v, re] of [["level", "A", /contrast\.level/], ["scale", 9, /contrast\.scale/], ["kinds", ["x"], /contrast\.kinds/], ["kinds", [], /contrast\.kinds/], ["scale", true, /contrast\.scale/],
      ["scale_source", "x", /contrast\.scale_source/], ["allow", [1], /contrast\.allow/],
      ["boxes", { image: { width: 10, height: 10 }, elements: [{ box: [0, 0, 1, 1], enabled: "no" }] }, /enabled/]]) {
      const bad = await s.request({ id: "c2", command: "contrast", path: file(FAIL), contrast: { [k]: v } });
      assert.equal(bad.error.code, "invalid-request");
      assert.match(bad.error.message, re);
    }
  } finally { await s.close(); }
});
