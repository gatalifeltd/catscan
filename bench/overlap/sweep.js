// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 12 D6: the threshold sweep on the dev half. Boxes findings come from the core at min_overlap 0.001 and are
// filtered by their `overlap`; the merged-line (garbled) candidates are computed here from `read` lines (D20). That
// signal was measured and dropped (D21): it added no hit on the dev half and flagged icons and thin-lettered text on
// real screens; the sweep keeps it so the decision can be rerun. Held-out numbers come from the core
// (bench/overlap.js without --sweep).
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Height per average character width: about the same for every line of one script whatever its size. */
function aspect(line, w, h) {
  const chars = [...seg.segment(line.text)].map((s) => s.segment).filter((c) => c.trim());
  const wide = chars.filter((c) => WIDE.test(c)).length * 2 > chars.length;
  return { n: chars.length, wide, r: chars.length ? (line.box[3] * h * chars.length) / (line.box[2] * w) : 0 };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Lines whose aspect is over `k` x the median of the screen's lines of the same script class (>= `minChars` each). */
function merged(env, { k, minChars, minLines = 3, maxConf = 1.01 }) {
  const { width: w, height: h } = env.image;
  const lines = (env.lines || []).map((l) => ({ l, ...aspect(l, w, h) })).filter((x) => x.n >= minChars);
  const out = [];
  for (const wide of [false, true]) {
    const group = lines.filter((x) => x.wide === wide);
    if (group.length < minLines) continue;
    const m = median(group.map((x) => x.r));
    for (const x of group) {
      if (x.r > k * m && x.l.confidence < maxConf) out.push({ kind: "overlap", signal: "garbled", box: x.l.box, a: { text: x.l.text, box: x.l.box, confidence: x.l.confidence }, b: null, overlap: null });
    }
  }
  return out;
}

function table(rows, reads, score) {
  const readBy = new Map(reads.map((r) => [r.item.name, r.env]));
  const lines = [];
  const fmt = (s) => `P ${s.precision} R ${s.recall} tp ${s.tp} fp ${s.fp} | ${Object.entries(s.per_amount).map(([a, v]) => `${a}:${v.rate}`).join(" ")} | ${Object.entries(s.per_layout_4px_up).map(([a, v]) => `${a}:${v.rate}`).join(" ")}`;
  for (const t of [0.001, 0.01, 0.02, 0.05, 0.1, 0.2]) {
    const boxes = (r) => r.findings.filter((f) => f.signal === "boxes" && f.overlap >= t);
    lines.push(`boxes t=${t}: ${fmt(score(rows.map((r) => ({ ...r, findings: boxes(r) }))))}`);
    for (const k of [1.4, 1.5, 1.6, 1.8]) for (const minChars of [3, 5]) {
      const s = score(rows.map((r) => {
        const b = boxes(r);
        const g = merged(readBy.get(r.item.name), { k, minChars }).filter((f) => !b.some((x) => inter(x.box, f.box)));
        return { ...r, findings: [...b, ...g] };
      }));
      lines.push(`  + merged k=${k} minChars=${minChars}: ${fmt(s)}`);
    }
  }
  return lines.join("\n") + "\n";
}

const inter = (p, q) => Math.min(p[0] + p[2], q[0] + q[2]) > Math.max(p[0], q[0]) && Math.min(p[1] + p[3], q[1] + q[3]) > Math.max(p[1], q[1]);

module.exports = { aspect, merged, table };
