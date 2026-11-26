// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 05 renderer (bench/generate.swift): determinism, the cut at the trailing image edge (D4), right to left,
// the gradient background and the font report. Pixels are read with a minimal PNG decoder, so no dependency.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { ROOT } = require("./helpers");

const GEN = path.join(ROOT, ".build/bench-gen-test");
fs.mkdirSync(path.dirname(GEN), { recursive: true });
execFileSync("swiftc", ["-O", path.join(ROOT, "bench/generate.swift"), "-o", GEN]);

const it = (name, locale, text, c, x = {}) => ({ name, locale, text, case: c, size: 16, theme: "light", background: "flat", rtl: false, ...x });
const PLAN = [
  it("de-fit.png", "de", "Einstellungen", "fit"),
  it("de-ellipsis.png", "de", "Einstellungen", "ellipsis"),
  it("de-clip.png", "de", "Einstellungen", "clip"),
  it("ar-fit.png", "ar", "الإمارات العربية", "fit", { rtl: true }),
  it("ar-ellipsis.png", "ar", "الإمارات العربية", "ellipsis", { rtl: true }),
  it("ar-clip.png", "ar", "الإمارات العربية", "clip", { rtl: true }),
  it("ja-grad.png", "ja", "設定を開く", "fit", { theme: "dark", background: "gradient" }),
  it("ja-flat.png", "ja", "設定を開く", "fit", { theme: "dark" }),
];

function render(plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-gen-"));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const report = JSON.parse(execFileSync(GEN, [path.join(dir, "plan.json"), dir], { encoding: "utf8" }));
  return { dir, report };
}
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** Decodes an 8-bit RGB or RGBA, non-interlaced PNG into { width, height, px(x, y) -> [r, g, b] }. */
function png(file) {
  const b = fs.readFileSync(file);
  let o = 8, width, height, type, idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), kind = b.toString("latin1", o + 4, o + 8), data = b.subarray(o + 8, o + 8 + len);
    if (kind === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); type = data[9]; assert.equal(data[12], 0); }
    if (kind === "IDAT") idat.push(data);
    o += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = width * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x], a = x >= bpp ? out[y * stride + x - bpp] : 0, up = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      out[y * stride + x] = (v + [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f]) & 255;
    }
  }
  return { width, height, px: (x, y) => [0, 1, 2].map((k) => out[y * stride + x * bpp + k]) };
}
/** First and last pixel columns with ink (far from the corner's color). */
function ink(file) {
  const p = png(file), bg = p.px(0, 0)[0];
  let lo = p.width, hi = -1;
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    if (Math.abs(p.px(x, y)[0] - bg) > 80) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  }
  return { lo, hi, width: p.width, p };
}
/** Vertical extent of the ink in columns [x0, x1): the dots of an ellipsis are short, letters are tall. */
function inkHeight({ p }, x0, x1) {
  const bg = p.px(0, 0)[0];
  let top = p.height, bottom = -1;
  for (let x = x0; x < x1; x++) for (let y = 0; y < p.height; y++) {
    if (Math.abs(p.px(x, y)[0] - bg) > 80) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  return bottom - top + 1;
}

const A = render(PLAN);
const B = render(PLAN);
const f = (name) => path.join(A.dir, name);

test("the same plan renders the same bytes twice", () => {
  for (const p of PLAN) assert.equal(sha(path.join(A.dir, p.name)), sha(path.join(B.dir, p.name)), p.name);
});

test("left to right: the clip cuts at the right edge; fit and ellipsis keep both edges clear", () => {
  const fit = ink(f("de-fit.png")), el = ink(f("de-ellipsis.png")), clip = ink(f("de-clip.png"));
  assert.ok(fit.lo > 5 && fit.hi < fit.width - 6, JSON.stringify(fit));
  assert.ok(clip.lo > 5 && clip.hi >= clip.width - 3, `clip ink ${clip.lo}-${clip.hi} of ${clip.width}`);
  assert.ok(el.lo > 5 && el.hi < el.width - 1);
  assert.ok(inkHeight(el, el.hi - 5, el.hi + 1) < el.p.height * 0.15, "the rightmost ink is the ellipsis");
  assert.ok(fit.width > clip.width && clip.width === el.width);
});

test("right to left: the clip cuts at the left edge and the ellipsis sits on the left", () => {
  const fit = ink(f("ar-fit.png")), el = ink(f("ar-ellipsis.png")), clip = ink(f("ar-clip.png"));
  assert.ok(fit.lo > 5 && fit.hi < fit.width - 6);
  assert.ok(clip.lo <= 2 && clip.hi < clip.width - 6, `clip ink ${clip.lo}-${clip.hi} of ${clip.width}`);
  // The line keeps the right padding (its leading edge) and its leftmost ink is the ellipsis's short dots.
  assert.ok(el.width - el.hi < 30 && el.lo > 5, `ellipsis ink ${el.lo}-${el.hi} of ${el.width}`);
  assert.ok(inkHeight(el, el.lo, el.lo + 6) < el.p.height * 0.15, "the leftmost ink is the ellipsis");
  assert.ok(inkHeight(el, el.hi - 5, el.hi + 1) > el.p.height * 0.25, "the rightmost ink is a letter");
});

test("the gradient background with noise differs from the flat one and varies across the box", () => {
  const g = png(f("ja-grad.png")), fl = png(f("ja-flat.png"));
  assert.deepEqual(fl.px(0, 0), fl.px(fl.width - 1, 0));
  assert.notDeepEqual(g.px(0, 0), g.px(1, 0)); // noise
  assert.ok(g.px(g.width - 1, 0)[0] > g.px(0, 0)[0] + 10); // dark theme lightens toward the right
});

test("the font report names the fonts Core Text used per language", () => {
  assert.equal(A.report.images, PLAN.length);
  for (const l of ["de", "ar", "ja"]) assert.ok(A.report.fonts[l].length > 0, l);
  assert.ok(A.report.fonts.ja.some((x) => /Hira|PingFang/i.test(x)), A.report.fonts.ja.join());
});
