// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 05 string rules, shared by the corpus builder and its tests.
const UNSPACED = new Set(["ja", "ko", "zh", "yue", "th"]); // TextMatch.unspaced (spec 00 step 3)
const base = (locale) => locale.split("-")[0].toLowerCase();
const unspaced = (locale) => UNSPACED.has(base(locale));
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const graphemes = (s) => [...segmenter.segment(s)].length;

/** Spec 00 steps 1-4 (NFKC, lowercase, ellipsis, quotes and dashes, whitespace, `_`), for picking only: the scorer
 *  never matches text itself, it takes catscan's verdicts. */
function norm(s, locale) {
  const t = s.normalize("NFKC").toLowerCase().replace(/\.\.\./g, "").replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, "'").replace(/[‐‑‒–—―−]/g, "-").replace(/_/g, " ");
  return t.split(/\s+/).filter(Boolean).join(unspaced(locale) ? "" : " ");
}

/** Bounds: 4-40 graphemes, 2-40 where the script needs no spaces. */
const bounds = (locale) => [unspaced(locale) ? 2 : 4, 40];

/** Rule violations of a string list, as messages; empty when the list is valid. */
function rules(list, locale) {
  const out = [];
  const [lo, hi] = bounds(locale);
  const seen = new Map();
  list.forEach((s, i) => {
    const n = graphemes(s);
    if (n < lo || n > hi) out.push(`${i}: ${JSON.stringify(s)} has ${n} graphemes, outside ${lo}-${hi}`);
    if (/[\n\r\t]/.test(s)) out.push(`${i}: ${JSON.stringify(s)} has a line break or tab`);
    const k = norm(s, locale);
    if (seen.has(k)) out.push(`${i}: ${JSON.stringify(s)} repeats string ${seen.get(k)}`);
    seen.set(k, i);
  });
  const ns = list.map((s) => norm(s, locale));
  ns.forEach((a, i) => ns.forEach((b, j) => {
    if (i !== j && a !== b && a.includes(b)) out.push(`${j}: ${JSON.stringify(list[j])} is inside ${JSON.stringify(list[i])}`);
  }));
  return out;
}

module.exports = { rules, norm, graphemes, bounds, unspaced, base };
