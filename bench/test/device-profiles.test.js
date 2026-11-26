// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-073 "Generator scripts": bench/devices/ios-profiles.mjs on drawn masked and unmasked frames (no simulator,
// no Apple asset): zones, runs, the landscape rotation check, and the PNG reader round trip.
const test = require("node:test");
const assert = require("node:assert/strict");

const W = 60, H = 120, R = 8;
function frame(w, h, hidden) {
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hidden(x, y)) data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  return { width: w, height: h, data };
}
// Portrait: four quarter-circle corners and a pill at x 22..38, y 4..10.
const corner = (x, y, w, h) => {
  const cx = x < R ? R : x >= w - R ? w - R : null, cy = y < R ? R : y >= h - R ? h - R : null;
  return cx !== null && cy !== null && (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > R * R;
};
const pill = (x, y) => x >= 22 && x < 38 && y >= 4 && y < 10;
const portrait = (x, y) => corner(x, y, W, H) || pill(x, y);
// The same device turned: landscape-left puts the portrait top on the left edge.
const left = (x, y) => portrait(W - 1 - y, x);
const right = (x, y) => portrait(y, H - 1 - x);

test("ios-profiles: zones and runs from a masked frame; landscape captures must match the rotation", async () => {
  // Value: protects=the D2 measurement (masked dark pixels -> corner and cutout runs) and its rotation check; fails_when=a corner is read as the cutout, runs drift, or a wrongly turned capture passes; why_new=new script; seam=profileFromShots; no_claim=what a real simulator returns (the script's own check covers that)
  const { profileFromShots } = await import("../devices/ios-profiles.mjs");
  const white = frame(W, H, () => false);
  const shots = { portrait: { black: frame(W, H, portrait), ignored: white }, "landscape-left": { black: frame(H, W, left) }, "landscape-right": { black: frame(H, W, right) } };
  const p = profileFromShots({ name: "Test Phone", family: "iphone", probe: { scale: 3 }, shots, tool: "Xcode 0", date: "2026-11-20" });
  assert.deepEqual([p.id, p.platform, p.screen], ["test-phone", "ios", { width: W, height: H, scale: 3 }]);
  assert.deepEqual(p.zones.map((z) => z.kind), ["cutout", "corner"]);
  assert.deepEqual(p.zones[0].runs, [4, 5, 6, 7, 8, 9].map((y) => [y, 22, 38]));
  const cornerPx = p.zones[1].runs.reduce((n, [, a, b]) => n + b - a, 0);
  let want = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (corner(x, y, W, H)) want++;
  assert.equal(cornerPx, want);
  // A capture turned the other way does not match.
  assert.throws(() => profileFromShots({ name: "T", family: "iphone", probe: { scale: 3 }, shots: { ...shots, "landscape-left": { black: frame(H, W, right) } }, tool: "x", date: "d" }), /landscape-left frame matches the rotated portrait zones only/);
  // A probe that is not on screen (dark unmasked frame) is refused.
  assert.throws(() => profileFromShots({ name: "T", family: "iphone", probe: { scale: 3 }, shots: { portrait: { black: frame(W, H, portrait), ignored: frame(W, H, () => true) } }, tool: "x", date: "d" }), /not on screen/);
  // iPad: a portrait-shaped landscape capture is skipped only when there is no cutout.
  const ipad = profileFromShots({ name: "iPad Test", family: "ipad", probe: { scale: 2 }, shots: { portrait: { black: frame(W, H, (x, y) => corner(x, y, W, H)), ignored: white }, "landscape-left": { black: frame(W, H, () => false) } }, tool: "x", date: "d" });
  assert.deepEqual([ipad.platform, ipad.zones.map((z) => z.kind)], ["ipados", ["corner"]]);
  assert.throws(() => profileFromShots({ name: "T", family: "iphone", probe: { scale: 3 }, shots: { ...shots, "landscape-left": { black: frame(W, H, () => false) } }, tool: "x", date: "d" }), /portrait-shaped/);
});

test("png: encode and decode round trip", async () => {
  // Value: protects=the PNG reader the scripts use on simctl and screencap output; fails_when=a filter or channel layout is decoded wrong; why_new=new helper; seam=png.mjs; no_claim=interlaced or 16-bit PNGs (refused)
  const { encode, decode } = await import("../devices/png.mjs");
  const f = frame(7, 5, (x, y) => (x + y) % 3 === 0);
  f.data[4 * 3 + 1] = 77;
  const d = decode(encode(f));
  assert.deepEqual([d.width, d.height], [7, 5]);
  assert.ok(d.data.equals(f.data));
});

test("android-profiles: the handle box and the profile from a probe report", async () => {
  // Value: protects=the Android measurement (handle found only as a centered bar in the gesture band; runs kept as the probe gives them); fails_when=a stray glyph or an off-center bar is read as the handle, or zones drift; why_new=new script; seam=handleBox, profileFrom; no_claim=what an emulator reports
  const { handleBox, profileFrom } = await import("../devices/android-profiles.mjs");
  const img = frame(100, 200, (x, y) => x >= 40 && x < 60 && y >= 190 && y < 193);
  assert.deepEqual(handleBox(img, 12), [40, 190, 20, 3]);
  assert.equal(handleBox(frame(100, 200, (x, y) => x >= 5 && x < 25 && y >= 190 && y < 193), 12), null, "off center");
  assert.equal(handleBox(frame(100, 200, () => false), 12), null);
  const p = profileFrom({ def: "pixel_9_pro_xl", name: "Pixel 9 Pro XL", portrait: { width: 100, height: 200, density: 2.625, cutout: [[4, 45, 55]], corner: [[0, 0, 3]] }, homePortrait: [40, 190, 20, 3], homeLandscape: [90, 90, 20, 3], tool: "Emulator 36", date: "d" });
  assert.deepEqual([p.id, p.platform, p.zones.map((z) => z.kind), p.landscape], ["pixel-9-pro-xl", "android", ["cutout", "corner", "home-indicator"], { "home-indicator": { box: [90, 90, 20, 3] } }]);
  assert.throws(() => profileFrom({ def: "x", name: "x", portrait: { width: 200, height: 100, density: 1, cutout: [], corner: [] }, tool: "t", date: "d" }), /landscape/);
  assert.throws(() => profileFrom({ def: "x", name: "x", portrait: { width: 100, height: 200, density: 1, cutout: [], corner: [] }, homePortrait: [40, 190, 20, 3], tool: "t", date: "d" }), /not in landscape/);
});

test("android-profiles: a screenshot that is not the white probe is refused", async () => {
  // Value: protects=the capture guard (a "System UI isn't responding" dialog over the probe was read as a full-width handle, 2026-11-22); fails_when=a dialog-covered frame passes the ink check; why_new=new guard; seam=inkShare; no_claim=what an emulator shows
  const { inkShare } = await import("../devices/android-profiles.mjs");
  const handleOnly = frame(100, 200, (x, y) => x >= 40 && x < 60 && y >= 190 && y < 193);
  assert.equal(inkShare(handleOnly, 12), 0, "the handle sits in the excluded bottom band");
  const dialog = frame(100, 200, (x, y) => x >= 10 && x < 90 && y >= 80 && y < 120);
  assert.ok(inkShare(dialog, 12) > 0.001);
});

test("android-profiles: probe reports split over logcat lines are joined; incomplete ones are dropped", async () => {
  // Value: protects=the probe log transport (logcat cuts a line at ~4 KB, and real reports are longer); fails_when=chunks join out of order, a cut report parses, or an older report wins; why_new=the first real run failed on a cut line; seam=joinReports; no_claim=logcat's exact cut length
  const { joinReports } = await import("../devices/android-profiles.mjs");
  const json = JSON.stringify({ width: 1080, height: 2424, cutout: [[45, 531, 548]] });
  const a = json.slice(0, 20), b = json.slice(20);
  assert.deepEqual(joinReports(`noise\n7 1 2 ${b}\n7 0 2 ${a}\n9 0 2 ${a}\n`), [JSON.parse(json)]);
  assert.deepEqual(joinReports("8 0 1 {\"width\":1}\n"), [{ width: 1 }]);
});
