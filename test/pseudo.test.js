// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-039 T2 integration through the CLI and real Vision: three screens drawn by bench/pseudo/generate.swift from
// generator output (one cut, one hardcoded, one clean) and one base fallback screen.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");
const pseudo = require("../packages/core-js/src/pseudo");

const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));
const STRINGS = { settings: { title: "Settings", privacy: "Privacy policy" }, bonus: { daily: "Daily reward" }, shop: { offer: "Special offer", restore: "Restore purchases" } };
const ps = (s) => pseudo.transform(s, { fmt: "json", expand: 40, variant: "accent" }).value;
const item = (id, text, y, extra = {}) => ({ id, text, x: 20, y, w: 350, size: 17, align: "left", wrap: false, keep: null, drop: null, ellipsis: false, contrast: 1, panel: false, ...extra });
const screen = (name, items) => ({ name, width: 390, height: 844, scale: 2, theme: "light", font: "SF", items });

let dir;
test.before(() => {
  setup();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pseudo-"));
  const gen = path.join(ROOT, ".build/pseudo-gen");
  const src = path.join(ROOT, "bench/pseudo/generate.swift");
  if (!fs.existsSync(gen) || fs.statSync(gen).mtimeMs < fs.statSync(src).mtimeMs) execFileSync("swiftc", ["-O", src, "-o", gen]);
  fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify(STRINGS));
  const clean = [item("a", ps("Settings"), 80), item("b", ps("Privacy policy"), 120), item("c", ps("Special offer"), 160)];
  const plan = [
    screen("cut", [...clean, item("d", ps("Restore purchases"), 200, { keep: 9 })]),
    screen("hardcoded", [...clean, item("d", "Daily reward", 200), item("e", "Limited time offer", 240)]),
    screen("clean", [...clean, item("d", ps("Daily reward"), 200), item("e", "$4.99", 240)]),
    screen("fallback", [item("a", "Settings", 80), item("b", "Privacy policy", 120), item("c", "Daily reward", 160), item("d", "Special offer", 200)]),
  ];
  fs.mkdirSync(path.join(dir, "shots"));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  execFileSync(gen, [path.join(dir, "plan.json"), path.join(dir, "shots")]);
});

const by = (r, name) => r.json.find((e) => path.basename(e.path) === `${name}.png`);

test("untranslated --pseudo: hardcoded with evidence, pseudo-not-applied on a base build, clean screens pass", () => {
  // Value: protects=TODO-039 D4, D5, D11, D14; fails_when=a base copy or a literal is missed, a pseudo string is flagged, or a fallback build passes; why_new=new rule; seam=CLI + Vision; no_claim=gate numbers (bench/pseudo.js)
  const r = cli(["untranslated", path.join(dir, "shots"), "--pseudo", "--catalog", path.join(dir, "en.json"), "--locale", "en-XA", "--layout", "none", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  for (const e of r.json) assert.ok(validate(e), JSON.stringify(validate.errors));
  for (const e of r.json) { assert.equal(e.pseudo, true); assert.equal(e.locale, "en", "en-XA reads as en (D12)"); }
  const h = by(r, "hardcoded").findings;
  assert.deepEqual(h.map((f) => [f.kind, f.evidence, f.key ?? null]), [["hardcoded", "base", "bonus.daily"], ["hardcoded", "none", null]]);
  assert.deepEqual(by(r, "clean").findings, []);
  assert.deepEqual(by(r, "cut").findings, []);
  assert.deepEqual(by(r, "fallback").findings.map((f) => f.kind), ["pseudo-not-applied"]);
  assert.ok(!r.stderr.includes("untranslated-base-catalog"));
  // D15: --kinds filters; pseudo-not-applied is not filterable.
  const k = cli(["untranslated", path.join(dir, "shots"), "--pseudo", "--catalog", path.join(dir, "en.json"), "--layout", "none", "--json", "--kinds", "raw-key"]);
  assert.deepEqual(k.json.flatMap((e) => e.findings.map((f) => f.kind)), ["pseudo-not-applied"]);
});

test("truncated --pseudo: a clipped pseudo string is pseudo-cut with what was lost", () => {
  // Value: protects=TODO-039 D13, D14; fails_when=a cut without boxes is missed or its lost part is wrong; why_new=new rule; seam=CLI + Vision; no_claim=gate numbers
  const r = cli(["truncated", path.join(dir, "shots"), "--pseudo", "--catalog", path.join(dir, "en.json"), "--layout", "none", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  const f = by(r, "cut").findings;
  assert.deepEqual(f.map((x) => [x.reason, x.side, x.lost, x.key, x.expected]), [["pseudo-cut", "end", "text", "shop.restore", "Restore purchases"]]);
  assert.deepEqual(by(r, "clean").findings, []);
  const t = cli(["truncated", path.join(dir, "shots/cut.png"), "--pseudo", "--catalog", path.join(dir, "en.json"), "--layout", "none"]);
  assert.match(t.stdout, /truncated \(pseudo-cut, text lost\) ".*" at \[.*\] @shop\.restore \(.*en\.json: "Restore purchases"\)/);
});

test("check --pseudo: @keys and base texts resolve on a pseudo screen (D8)", () => {
  // Value: protects=TODO-039 D8; fails_when=--expect keys stop matching on a pseudo build; why_new=new flag; seam=CLI + Vision; no_claim=none
  const shot = path.join(dir, "shots/clean.png");
  const r = cli(["check", shot, "--pseudo", "--catalog", path.join(dir, "en.json"), "--present", "@bonus.daily", "--present", "Privacy policy", "--layout", "none", "--json"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.json[0].checks.every((c) => c.verdict === "pass" && /\[/.test(c.line)), "the line is reported as recognized");
  const plain = cli(["check", shot, "--catalog", path.join(dir, "en.json"), "--present", "@bonus.daily", "--layout", "none", "--json"]);
  assert.equal(plain.code, 1, "without --pseudo the accented read does not match");
});
