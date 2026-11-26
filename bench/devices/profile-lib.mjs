// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Shared geometry for the device-profile scripts (TODO-073 D2): hidden pixels from a masked screenshot of the white
// probe, split into `corner` and `cutout` zones as row runs [y, x0, x1) in portrait pixels.

const luma = (d, o) => (d[o] * 299 + d[o + 1] * 587 + d[o + 2] * 114) / 1000;

/**
 * Pixels the display hides: dark in the `--mask=black` screenshot of a white full-screen probe. `ignored` (the same
 * frame with `--mask=ignored`) must be white there, or the probe was not on screen.
 * Returns a Uint8Array mask (1 = hidden).
 */
export function hiddenMask(masked, ignored) {
  const { width, height } = masked;
  if (ignored && (ignored.width !== width || ignored.height !== height)) throw new Error("masked and ignored screenshots differ in size");
  const m = new Uint8Array(width * height);
  let notWhite = 0;
  for (let p = 0; p < width * height; p++) {
    const dark = luma(masked.data, p * 4) < 64;
    if (ignored && luma(ignored.data, p * 4) < 192) notWhite++;
    m[p] = dark ? 1 : 0;
  }
  // A few dark pixels in the unmasked frame are tolerated (a 4x4 corner artifact on Xcode 27); a probe that is not on
  // screen (home screen, a launch error) gives thousands.
  if (ignored && notWhite > 256) throw new Error(`${notWhite} pixels are dark in the unmasked screenshot: the probe app is not on screen`);
  return m;
}

/** Connected regions (4-neighbour) of a mask: [{ pixels: [p...], x0, y0, x1, y1 }] (x1, y1 exclusive). */
export function regions(mask, width, height) {
  const seen = new Uint8Array(mask.length), out = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const stack = [s], px = [];
    seen[s] = 1;
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    while (stack.length) {
      const p = stack.pop(), x = p % width, y = (p - x) / width;
      px.push(p);
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x + 1 > x1) x1 = x + 1; if (y + 1 > y1) y1 = y + 1;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1])
        if (q >= 0 && mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    out.push({ pixels: px, x0, y0, x1, y1 });
  }
  return out;
}

/** Row runs [y, x0, x1) of a pixel list, sorted by y then x. */
export function runsOf(pixels, width) {
  const rows = new Map();
  for (const p of pixels) { const x = p % width, y = (p - x) / width; (rows.get(y) || rows.set(y, []).get(y)).push(x); }
  const runs = [];
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const xs = rows.get(y).sort((a, b) => a - b);
    let a = xs[0], b = xs[0] + 1;
    for (const x of xs.slice(1)) { if (x === b) b++; else { runs.push([y, a, b]); a = x; b = x + 1; } }
    runs.push([y, a, b]);
  }
  return runs;
}

/**
 * Zones of a portrait masked frame: a region that reaches two adjacent screen edges is a `corner`, any other region
 * of at least `minPixels` is the `cutout`. Corner runs are merged into one zone, as are cutout runs (a notch and a
 * pill camera are one zone each; a device with a pill and a dot gives both in one `cutout`).
 */
export function zonesOf(mask, width, height, { minPixels = 16 } = {}) {
  const corner = [], cutout = [];
  for (const r of regions(mask, width, height)) {
    const touchX = r.x0 === 0 || r.x1 === width, touchY = r.y0 === 0 || r.y1 === height;
    if (touchX && touchY) corner.push(...r.pixels);
    else if (r.pixels.length >= minPixels) cutout.push(...r.pixels);
  }
  const zones = [];
  if (cutout.length) zones.push({ kind: "cutout", runs: runsOf(cutout, width) });
  if (corner.length) zones.push({ kind: "corner", runs: runsOf(corner, width) });
  return zones;
}

/**
 * Portrait runs -> landscape pixel set. `landscape-left`: the portrait top edge is the image's left edge (the device
 * turned counterclockwise); `landscape-right`: it is the right edge. Mirrors core-js device-profiles.js.
 */
export function rotateRuns(runs, width, height, orientation) {
  const px = [];
  for (const [y, x0, x1] of runs) for (let x = x0; x < x1; x++) {
    if (orientation === "landscape-left") px.push([y, width - 1 - x]);
    else px.push([height - 1 - y, x]);
  }
  const W = height, out = new Set();
  for (const [x, y] of px) out.add(y * W + x);
  return out;
}

/** Share of `a` pixels (a Set) that are hidden in the mask `m`, and of mask pixels covered by `a`. */
export function agreement(a, m) {
  let both = 0, total = 0;
  for (let p = 0; p < m.length; p++) if (m[p]) { total++; if (a.has(p)) both++; }
  return { recall: total ? both / total : 1, precision: a.size ? both / a.size : 1 };
}

/** "iPhone 17 Pro" -> "iphone-17-pro"; "iPad Pro 13-inch (M5)" -> "ipad-pro-13-inch-m5". */
export const slug = (name) => name.replace(/ʀ/g, "r").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
