// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-073 integration (real Vision): a Core Text screen at 1206 x 2622 with a title ending inside the Dynamic Island
// and an icon button in the top-left corner, plus its sidecar: two findings; the same screen moved below the safe
// area: none. Also the serve field and the run diagnostics on a real run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");
const { mask, edge, cornerRows } = require("../bench/safe-area");
const TABLE = require("../packages/core-js/src/device-profiles.json");

setup();
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-fit-"));
const P = TABLE.profiles.find((p) => p.id === "iphone-17-pro");
const cut = (() => {
  const { m, W, H } = mask(P, "portrait", ["cutout"]);
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
  return { x0, y0, x1, y1 };
})();
// The icon met along a row a third of the corner's height down, 32 px past the curve (as the bench places them).
const cor = mask(P, "portrait", ["corner"]), iconRow = Math.round(cornerRows(cor, true) * 0.35);
const iconLeft = edge(cor, iconRow, false, 0, 603) - 32;
const body = { id: "body", text: "Benachrichtigungen", size: 51, centerX: 603, centerY: 1311 };
const PLAN = [
  { name: "under", locale: "de", width: 1206, height: 2622, background: "plain", seed: 1, items: [
    { id: "title", text: "Einstellungen", size: 51, right: cut.x0 + 60, centerY: (cut.y0 + cut.y1) / 2 },
    { id: "close", text: null, size: 90, left: iconLeft, centerY: iconRow + 22 }, body] },
  { name: "below", locale: "de", width: 1206, height: 2622, background: "plain", seed: 2, items: [
    { id: "title", text: "Einstellungen", size: 51, right: cut.x0 + 60, top: 300 },
    { id: "close", text: null, size: 90, left: 60, top: 300 }, body] },
];
const gen = path.join(DIR, "gen");
execFileSync("swiftc", ["-O", path.join(ROOT, "bench/safe-area/generate.swift"), "-o", gen]);
fs.writeFileSync(path.join(DIR, "plan.json"), JSON.stringify(PLAN));
fs.mkdirSync(path.join(DIR, "shots"));
execFileSync(gen, [path.join(DIR, "plan.json"), path.join(DIR, "shots")]);
for (const f of fs.readdirSync(path.join(DIR, "shots"))) if (f.endsWith(".truth.json")) fs.rmSync(path.join(DIR, "shots", f));

test("fit: a title under the island and an icon in the corner; none below the safe area", () => {
  // Value: protects=the whole path (sidecar control, Vision character boxes, profile by size, rule, envelope); fails_when=either finding is missed, a safe screen is flagged, or the envelope breaks the schema; why_new=new command; seam=none (real binary); no_claim=the gate (bench/safe-area.js)
  const r = cli(["fit", path.join(DIR, "shots"), "--json", "--experimental", "--boxes", path.join(DIR, "shots"), "--device-profile", "iphone-17-pro"]);
  assert.equal(r.code, 1, r.stderr);
  const by = Object.fromEntries(r.json.map((e) => [path.basename(e.path), e]));
  for (const e of r.json) assert.ok(validate(e), JSON.stringify(validate.errors));
  const u = by["under.png"];
  assert.deepEqual(u.findings.map((f) => [f.reason, f.element.id, f.line === null]).sort(), [["corner", "close", true], ["cutout", "title", false]]);
  const title = u.findings.find((f) => f.reason === "cutout");
  assert.match(title.hidden, /n$/, "the last letters are under the island");
  assert.ok(!title.hidden.startsWith("Ein"), title.hidden);
  assert.deepEqual(u.device_profile, { id: "iphone-17-pro", ids: ["iphone-17-pro"], orientation: "portrait", matched_by: "flag", version: TABLE.version });
  assert.deepEqual(by["below.png"].findings, []);
  assert.equal(by["below.png"].verdict, "pass");
});

test("fit: matched by size without a flag; Android size and landscape without a side are said, never silent", () => {
  // Value: protects=D3/D4/D5/D16 on a real run (size match, device-unknown per size, orientation-unknown, --fail-on-skip); fails_when=a skip is silent or the exit code ignores --fail-on-skip; why_new=new diagnostics; seam=none; no_claim=Android findings (bench/safe-area.js measures those)
  const r = cli(["fit", path.join(DIR, "shots", "under.png"), "--json", "--experimental"]);
  assert.equal(r.code, 1);
  assert.equal(r.json[0].device_profile.matched_by, "size");
  assert.match(r.stderr, /fit-controls-need-boxes/);
  // A 1080 x 2400 image: no iOS profile has that size and Android never matches by size.
  const d = path.join(DIR, "android");
  fs.mkdirSync(d);
  execFileSync("sips", ["-z", "2400", "1080", path.join(DIR, "shots", "below.png"), "--out", path.join(d, "home.png")], { stdio: "ignore" });
  const a = cli(["fit", d, "--json", "--quiet", "--fail-on-skip", "--experimental"]);
  assert.equal(a.code, 1);
  assert.equal(a.json[0].device_profile, null);
  assert.deepEqual(a.json[0].reasons_skipped.map((s) => s.cause), ["device-unknown", "device-unknown"].concat(a.json[0].reasons_skipped.length === 3 ? ["device-unknown"] : []));
  assert.match(a.stderr, /device-unknown: 1 image of 1080x2400 \(first: .*home\.png\) has no device profile/);
  assert.match(a.stderr, /checks-skipped: fit: 1 image skipped/);
  // PR 2: the shipped Pixel profiles of that size are named, and the first is the hint; with it, all three reasons run.
  assert.match(a.stderr, /profiles of this size: pixel-6, .*pixel-7.*\) - try: catscan fit .*home\.png --device-profile pixel-6/);
  const p7 = cli(["fit", d, "--json", "--experimental", "--device-profile", "pixel-7"]);
  assert.deepEqual([p7.json[0].device_profile.id, p7.json[0].reasons_run], ["pixel-7", ["cutout", "corner", "home-indicator"]]);
  // Landscape without a side: the cutout is skipped, the corners still run.
  const l = path.join(DIR, "land");
  fs.mkdirSync(l);
  execFileSync("sips", ["-r", "90", path.join(DIR, "shots", "below.png"), "--out", path.join(l, "game.png")], { stdio: "ignore" });
  const g = cli(["fit", l, "--json", "--experimental", "--device-profile", "iphone-17-pro"]);
  assert.deepEqual(g.json[0].reasons_skipped, [{ reason: "cutout", cause: "orientation-unknown" }]);
  assert.equal(g.json[0].device_profile.orientation, "landscape");
  assert.match(g.stderr, /orientation-unknown: .*game\.png is landscape and its side is unknown; cutout skipped - try: --orientation landscape-left/);
});

test("fit --list-devices and a bad profile", () => {
  // Value: protects=--list-devices on the real CLI and the usage errors' exit code; fails_when=the list is empty or a typo exits 0; why_new=new surface; seam=none; no_claim=none
  const r = cli(["fit", "--list-devices", "--json"]);
  assert.equal(r.code, 0);
  assert.ok(r.json[0].some((x) => x.id === "iphone-17-pro"));
  const b = cli(["fit", path.join(DIR, "shots"), "--experimental", "--device-profile", "iphone-17-pr"]);
  const x = cli(["fit", path.join(DIR, "shots")]);
  assert.equal(x.code, 2);
  assert.match(x.stderr, /experimental-command: fit is experimental/);
  assert.equal(b.code, 2);
  assert.match(b.stderr, /unknown-device-profile: --device-profile iphone-17-pr: no such profile; did you mean iphone-17-pro\?/);
});
