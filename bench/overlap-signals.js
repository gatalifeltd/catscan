#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-035: two candidate signals for `catscan overlap` (spec 12), measured on the spec 12 sets before any core change.
// - catalog: two expected strings are not read, and one read line that matches no expected string holds most of the
//   letters of both, in order (a merged read such as `Kopenachstehtigungen`).
// - split: a line whose aspect (height per average character width) is over k x the screen's median is cropped into
//   an upper and a lower part; when both parts read as different text, the line is two lines.
// Thresholds are tuned on the synthetic dev half only (spec 12 D6) and reported on the held-out half, the game
// positives and the real negatives. Images stay in datasets/ (gitignored).
// Usage: node bench/overlap-signals.js --games datasets/overlap-games --study <dir>... [--synth datasets/overlap-synth]
//        > results/overlap-signals.json
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const O = require("./overlap");
const R = require("./overlap-real");
const { aspect } = require("./overlap/sweep");
const { versionInfo } = require("../packages/core-js/src/client");

const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Lowercase letters and digits as graphemes: punctuation and spaces do not count for or against a match. */
const norm = (s) => [...seg.segment(s.toLowerCase())].map((g) => g.segment).filter((g) => /[\p{L}\p{N}]/u.test(g));

function lcs(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

/** How much of `s` a read text holds, in order (0-1). */
const cover = (read, s) => { const r = norm(read), t = norm(s); return t.length ? lcs(r, t) / t.length : 0; };
/** Whether a read text is `s` (both ways, so a short read inside a long string is not a match). */
const same = (read, s) => { const r = norm(read), t = norm(s); return r.length && t.length ? lcs(r, t) / Math.max(r.length, t.length) : 0; };

/**
 * The best joint alignment of a read text with two strings: each read letter is credited to A or to B at most once,
 * in order in both. Returns {ma, mb, n} (letters credited to A, to B, read letters): a merged read of A over B
 * credits most of both, while a short string shares letters with any long read only through letters B also needs.
 */
function joint(read, A, B) {
  const r = norm(read), a = norm(A), b = norm(B);
  const J = a.length + 1, K = b.length + 1;
  let prevT = new Int32Array(J * K), prevA = new Int32Array(J * K);
  for (let i = 1; i <= r.length; i++) {
    const t = new Int32Array(J * K), ca = new Int32Array(J * K);
    for (let j = 0; j < J; j++) for (let k = 0; k < K; k++) {
      const at = j * K + k;
      let bt = prevT[at], ba = prevA[at];
      // Equal totals: keep the more even split, so the smaller share (the cover) is as high as this alignment allows.
      const bal = (tt, aa) => Math.min(aa / (a.length || 1), (tt - aa) / (b.length || 1));
      const up = (tt, aa) => { if (tt > bt || (tt === bt && bal(tt, aa) > bal(bt, ba))) { bt = tt; ba = aa; } };
      if (j) up(t[at - K], ca[at - K]);
      if (k) up(t[at - 1], ca[at - 1]);
      if (j && r[i - 1] === a[j - 1]) up(prevT[at - K] + 1, prevA[at - K] + 1);
      if (k && r[i - 1] === b[k - 1]) up(prevT[at - 1] + 1, prevA[at - 1]);
      t[at] = bt; ca[at] = ba;
    }
    prevT = t; prevA = ca;
  }
  const total = prevT[J * K - 1], ma = prevA[J * K - 1];
  return { ma, mb: total - ma, la: a.length, lb: b.length, n: r.length };
}

/**
 * Catalog candidates of one screen: [{line, a, b, cover, explained}] for the best pair per unexpected line. `cover` is
 * the smaller share of A and of B credited in the joint alignment, `explained` the share of the read it credits. `own`
 * is the similarity at which a read line counts as an expected string.
 */
function catalogCandidates(lines, expected, { own = 0.8, minChars = 4, minCover = 0.4 } = {}) {
  const uniq = [...new Set(expected.filter((s) => norm(s).length >= minChars))];
  const shown = new Set(uniq.filter((s) => lines.some((l) => same(l.text, s) >= own)));
  const missing = uniq.filter((s) => !shown.has(s));
  const out = [];
  for (const l of lines) {
    if (norm(l.text).length < minChars || uniq.some((s) => same(l.text, s) >= own)) continue;
    const pre = missing.filter((s) => cover(l.text, s) >= minCover); // the joint cover is never above the single one
    let best = null;
    for (let i = 0; i < pre.length; i++) for (let j = i + 1; j < pre.length; j++) {
      const m = joint(l.text, pre[i], pre[j]);
      const c = { line: l, a: pre[i], b: pre[j], cover: Math.min(m.ma / m.la, m.mb / m.lb), explained: (m.ma + m.mb) / m.n };
      if (!best || c.cover > best.cover || (c.cover === best.cover && c.explained > best.explained)) best = c;
    }
    if (best) out.push(best);
  }
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Split candidates of one screen: lines whose aspect is over `k` x the median of their script class (D20). */
function splitCandidates(env, { k = 1.5, minChars = 3, minLines = 3 } = {}) {
  const { width: w, height: h } = env.image;
  const all = (env.lines || []).map((l) => ({ l, ...aspect(l, w, h) })).filter((x) => x.n >= minChars);
  const out = [];
  for (const wide of [false, true]) {
    const g = all.filter((x) => x.wide === wide);
    if (g.length < minLines) continue;
    const m = median(g.map((x) => x.r));
    for (const x of g) if (x.r > k * m) out.push({ line: x.l, ratio: x.r / m });
  }
  return out;
}

/** The upper and lower crop of a line box (normalized) in px: padded by `pad` heights, each part reaching `margin` past the middle. */
function splitRects(box, w, h, { pad = 0.15, margin = 0.1 } = {}) {
  const [x, y, bw, bh] = [box[0] * w, box[1] * h, box[2] * w, box[3] * h];
  const p = pad * bh, clamp = (r) => {
    const x0 = Math.max(0, r[0]), y0 = Math.max(0, r[1]), x1 = Math.min(w, r[0] + r[2]), y1 = Math.min(h, r[1] + r[3]);
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  };
  return [clamp([x - p, y - p, bw + 2 * p, bh * (0.5 + margin) + p]), clamp([x - p, y + bh * (0.5 - margin), bw + 2 * p, bh * (0.5 + margin) + p])];
}

/** Whether the two re-read parts are two lines: each part has a line of `minChars` and the parts are different texts. */
function splitConfirms(top, bottom, { minChars = 3, maxSame = 0.6 } = {}) {
  const t = top.map((l) => l.text).join(" "), b = bottom.map((l) => l.text).join(" ");
  return norm(t).length >= minChars && norm(b).length >= minChars && same(t, b) < maxSame;
}

/** Crops every candidate of `rows` (synthetic or real) and reads the parts; returns a Map path#index -> [topLines, bottomLines]. */
function reread(cands, dir, crop) {
  fs.mkdirSync(dir, { recursive: true });
  const jobs = [], keys = [];
  cands.forEach((c, i) => {
    const [top, bottom] = splitRects(c.line.box, c.env.image.width, c.env.image.height);
    for (const [part, rect] of [["t", top], ["b", bottom]]) jobs.push({ src: c.env.path, out: path.join(dir, `${i}-${part}.png`), rect, locale: c.locale });
    keys.push(i);
  });
  fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify(jobs));
  const t0 = Date.now();
  const cropOut = JSON.parse(execFileSync(crop, [path.join(dir, "jobs.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  const byLocale = new Map();
  for (const j of jobs) { if (!byLocale.has(j.locale)) byLocale.set(j.locale, []); byLocale.get(j.locale).push(j.out); }
  const read = new Map();
  for (const [locale, files] of byLocale) for (const env of O.run("read", files.filter((f) => fs.existsSync(f)), locale || null)) read.set(env.path, env.lines || []);
  // D8: a crop that was not written or a part with no read result is counted, never taken as "no overlap". An error
  // read makes the CLI exit 3 or 4, and O.run aborts the whole run on it, so no error is ever read as empty.
  const missing = jobs.filter((j) => !read.has(j.out)).length;
  const parts = new Map(keys.map((i) => [i, [read.get(path.join(dir, `${i}-t.png`)) || [], read.get(path.join(dir, `${i}-b.png`)) || []]]));
  return { parts, crops: jobs.length, failed_crops: cropOut.failed, missing_reads: missing, ms: Date.now() - t0 };
}

const finding = (line, signal, extra = {}) => ({ kind: "overlap", signal, box: line.box, a: { text: line.text, box: line.box, confidence: line.confidence }, b: null, ...extra });

module.exports = { norm, lcs, cover, same, joint, catalogCandidates, splitCandidates, splitRects, splitConfirms, finding, reread };

if (require.main === module) require("./overlap/signals-run").main(process.argv.slice(2));
