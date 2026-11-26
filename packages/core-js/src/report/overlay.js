// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// The one place that knows how a check or finding is drawn over an image: color, line style and
// label per kind, as SVG over the image, so no layer needs an image library. The report inlines this file into its
// page script, so it stays dependency-free and runs unchanged in Node and in a browser.

// Color is always paired with a dash style and a text label, so the report never relies on color alone.
const STYLES = {
  "present-pass": { color: "#1a7f37", dash: false, label: "present" },
  "present-fail": { color: "#cf222e", dash: true, label: "present: not found (closest line)" },
  "absent-fail": { color: "#cf222e", dash: false, label: "absent: found" },
  truncated: { color: "#d4700a", dash: false, label: "truncated" },
  // Text drawn past its element, not cut; dashed to set it apart from a cut-off line.
  "truncated-overflow": { color: "#d4700a", dash: true, label: "truncated (overflow)" },
  // Pseudo-localization kinds: colored as their parent kinds.
  "truncated-pseudo-cut": { color: "#d4700a", dash: true, label: "cut (pseudo)" },
  hardcoded: { color: "#0969da", dash: true, label: "hardcoded" },
  "pseudo-not-applied": { color: "#0969da", dash: true, label: "pseudo not loaded" },
  overlap: { color: "#8250df", dash: false, label: "overlap" },
  occluded: { color: "#8250df", dash: true, label: "occluded" },
  untranslated: { color: "#0969da", dash: false, label: "untranslated" },
  "raw-key": { color: "#0969da", dash: false, label: "raw key" },
  placeholder: { color: "#0969da", dash: false, label: "placeholder" },
  "wrong-language": { color: "#0969da", dash: false, label: "wrong language" },
  uncatalogued: { color: "#0969da", dash: true, label: "not in catalog" },
  // Format, currency and price findings: yellow, solid.
  format: { color: "#9a6700", dash: false, label: "format" },
  currency: { color: "#9a6700", dash: false, label: "currency" },
  price: { color: "#9a6700", dash: false, label: "price" },
  missing: { color: "#6e7781", dash: true, label: "missing" },
  // fit: the zone and the hidden part, dashed (nothing in the pixels is wrong; the hardware hides it).
  fit: { color: "#bf3989", dash: true, label: "under a cutout, corner or home indicator" },
  // Contrast, orange; busy dashed (the background, not the ink, is the problem).
  "low-contrast": { color: "#bc4c00", dash: false, label: "low contrast" },
  "busy-background": { color: "#bc4c00", dash: true, label: "busy background" },
  // fit wrapped and orphan: a label on more rows than it was made for; the rows' union, solid (the pixels show it).
  "fit-wrap": { color: "#bf3989", dash: false, label: "wraps, or ends in one word" },
};

const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === "number" && Number.isFinite(n));

const SEV = ["critical", "major", "minor"], CERT = ["high", "medium", "low"];
/** `major/medium`, or null for an item with no severity (an older results file shows no badge). */
const scaleOf = (o) => (o.severity ? `${o.severity}/${o.certainty}` : null);
const rankOf = (o) => [o.gate === false ? (o.known === true ? 2 : 1) : 0, o.severity ? SEV.indexOf(o.severity) : 3, o.certainty ? CERT.indexOf(o.certainty) : 3];

function describe(o) {
  const closest = o.closest && typeof o.closest.line === "string" ? `closest: ${o.closest.line}` : null;
  return [o.text, o.line, closest, o.key, o.token, o.reason, o.expected_path].filter((x) => typeof x === "string" && x !== "").join(" | ");
}

/**
 * Every check and finding of an envelope as a drawable entry: { ref, style, label, text, boxes, llm, t }.
 * Entries with no box (a passed absent check, a missing cell) are listed with boxes: [] so the list stays complete.
 * `t` (video) is the frame time the box belongs to, or null.
 */
function shapes(env) {
  const out = [];
  const llm = (o) => Boolean(o && (o.escalated || o.llm));
  (env.checks || []).forEach((c, i) => {
    let key = null, box = null, t = null;
    if (c.kind === "present" && c.verdict === "pass") { key = "present-pass"; box = c.box; t = c.first_seen ?? null; }
    else if (c.kind === "present" && c.verdict === "fail") { key = "present-fail"; box = c.closest ? c.closest.box : null; t = c.closest ? c.closest.t ?? null : null; }
    else if (c.kind === "absent" && c.verdict === "fail") { key = "absent-fail"; box = c.box; t = c.first_seen ?? null; }
    const label = key ? STYLES[key].label : `${c.kind}: ${c.verdict}`;
    out.push({ ref: `c${i}`, style: key, label, verdict: c.verdict, text: describe(c), boxes: key && isBox(box) ? [box] : [], llm: llm(c), t, sev: scaleOf(c) });
  });
  const found = [];
  (env.findings || []).forEach((f, i) => {
    const wrap = f.kind === "fit" && (f.reason === "wrapped" || f.reason === "orphan");
    const key = f.kind === "truncated" && (f.reason === "overflow" || f.reason === "pseudo-cut") ? `truncated-${f.reason}` : wrap ? "fit-wrap" : STYLES[f.kind] ? f.kind : null;
    // An overlap draws both line boxes, not their union; a stacked finding has one read and draws its region.
    const boxes = ((f.kind === "overlap" || f.kind === "occluded") && f.a && f.signal !== "stacked" ? [f.a.box, f.b?.box]
      : f.kind === "fit" && !wrap ? [f.zone_box, f.hidden_box] : [f.box]).filter(isBox); // fit draws its zone from the finding, so no profile is needed
    found.push({ ref: `f${i}`, style: key, label: key ? STYLES[key].label : String(f.kind), verdict: f.known === true ? "known" : f.gate === false ? "note" : "fail", text: describe(f), boxes, llm: llm(f), t: f.t ?? null, sev: scaleOf(f), k: rankOf(f), i });
  });
  // Findings by gate, severity and certainty, ties in output order; this file is inlined in the page, so no require.
  found.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.i - b.i);
  return out.concat(found.map(({ k, i, ...s }) => s));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n = (v) => Math.round(v * 10000) / 10;

/** SVG markup to lay over the image (viewBox 0..1000 both ways, stretched to the image), also used for test failure attachments. */
function svg(env) {
  const parts = [];
  for (const s of shapes(env)) {
    if (!s.style) continue;
    const st = STYLES[s.style];
    for (const b of s.boxes) {
      parts.push(`<rect data-ref="${s.ref}" x="${n(b[0])}" y="${n(b[1])}" width="${n(b[2])}" height="${n(b[3])}" fill="none" stroke="${st.color}" stroke-width="3"${st.dash ? ' stroke-dasharray="8 5"' : ""} vector-effect="non-scaling-stroke"><title>${esc(s.label + (s.llm ? " (LLM)" : "") + (s.text ? `: ${s.text}` : ""))}</title></rect>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">${parts.join("")}</svg>`;
}

if (typeof module !== "undefined") module.exports = { STYLES, shapes, svg };
