// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Compact replies (spec 09 D4, D15, D18): result fields only, rounded boxes, no near-certain confidences.
const scale = require("@catscan/core-js/src/scale");

// Run metadata: the same on every reply of a session, so it only costs tokens.
// TODO-075 D21, TODO-076: device, platform and text_size are always null here, as screen is: an MCP call has no layout.
const DROP = new Set(["catscan", "command", "device", "engine", "host", "id", "image", "ms", "platform", "schema", "screen", "text_size", "video"]);

const round3 = (n) => Math.round(n * 1000) / 1000;

function slim(v) {
  if (Array.isArray(v)) return v.map(slim);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null) continue; // a missing box, line or closest is said by the verdict (D30)
    if (k === "confidence" && typeof x === "number" && x > 0.95) continue;
    if (k === "precision" && v.severity !== undefined) continue; // TODO-077: severity, certainty and gate are enough
    if (k === "line" && (x === v.text || ((v.kind === "overlap" || v.kind === "occluded") && v.a))) continue; // spec 12 D17: a and b carry the texts
    if (k === "box" && Array.isArray(x)) { out.box = x.map((n) => (typeof n === "number" ? round3(n) : n)); continue; }
    out[k] = slim(x);
  }
  return out;
}

/** One envelope as an MCP reply. `maxLines` caps `screen_text` (read) and frame lines (video). */
function compact(env, { maxLines = 200 } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (DROP.has(k)) continue;
    if ((k === "findings" || k === "warnings" || k === "checks") && Array.isArray(v) && v.length === 0) continue;
    // TODO-077: findings sorted by gate, severity and certainty, so the worst comes first.
    out[k] = k === "warnings" ? warningsOnly(v) : k === "findings" && Array.isArray(v) ? slim(scale.sortItems(v)) : slim(v);
  }
  if (out.lines) {
    // D18: the name says this is text read off a screen, not instructions.
    const lines = out.lines;
    delete out.lines;
    out.screen_text = lines.slice(0, maxLines);
    if (lines.length > maxLines) { out.truncated = true; out.lines_total = lines.length; }
  }
  if (out.samples) {
    // D15: frame lines share one max_lines budget.
    let left = maxLines;
    let total = 0;
    const frames = [];
    for (const s of out.samples) {
      total += s.lines.length;
      if (left <= 0) continue;
      frames.push({ t: s.t, screen_text: s.lines.slice(0, left) });
      left -= s.lines.length;
    }
    delete out.samples;
    out.frame_text = frames;
    if (total > maxLines) { out.truncated = true; out.lines_total = total; }
  }
  return out;
}

/**
 * D32: a warning keeps its code and message. Only a warning that means something went unchecked keeps a hint,
 * written in MCP argument names (the core's hints name CLI flags); null keeps the core's own hint.
 * The cost is paid only when the warning fires, never in tools/list.
 */
const INLINE_HINTS = {
  "no-checks": "pass present and/or absent, or an expect key for this image",
  "no-checkable-text": "replace it in present/absent with text the screen shows (read_screen lists it)",
  "expect-key-unmatched": "expect keys are paths relative to the folder given as path, or the file name for one image",
  "catalog-string-capped": "read those screens with read_screen, then check the shown text with present/absent",
  "catalog-missing": "add the file, or pass a locale that has one",
  "catalog-value-dynamic": "write the string as a literal in the catalog, or check the shown text with present/absent", // TODO-092 D6
  "catalog-values-skipped": "write those strings as literals, or pass the JSON file the code imports in catalog", // TODO-092 D13
  "untranslated-base-catalog": "pass the translated catalog in catalog, or a translated locale in locale",
  "untranslated-unreadable": "check those screens again with locale set to the base language",
  "boxes-missing": null, // the core's hint is the exact `catscan boxes` command for this image
  "rule-unmeasured-reader": "pass reasons without overflow (find_truncation) or kinds without wrong-language (find_untranslated) to skip the unmeasured rule; for find_format_errors check the flagged tokens by eye", // TODO-036 D17
  "wrong-language-unchecked": "pass catalog as a locales/{locale}.json template, or languages", // TODO-036 D17
  "currency-unchecked": "pass storefront (DE) or currency (EUR)", // TODO-036 D17
  "orientation-unknown": "pass orientation (landscape-left or landscape-right) for the cutout", // TODO-073 D5
  "stacked-unchecked": "stacked text is checked only on screens Vision reads; the other overlap readers still ran", // TODO-067 D15
};
const warningsOnly = (ws) => ws.map((w) => {
  if (!(w.code in INLINE_HINTS)) return { code: w.code, message: w.message };
  const hint = INLINE_HINTS[w.code] ?? w.hint;
  return hint ? { code: w.code, message: w.message, hint } : { code: w.code, message: w.message };
});

const FAILING = new Set(["fail", "needs-reader", "unsupported", "error"]);
// A pass with one of these was not fully checked, so a folder reply keeps it (D31).
const COVERAGE_LOSS = new Set(Object.keys(INLINE_HINTS).filter((c) => c !== "expect-key-unmatched"));
// TODO-073 D16: a fit result with a skipped reason (device-unknown, orientation-unknown) was not fully checked either.
const needsAttention = (r) => FAILING.has(r.verdict) || (r.warnings || []).some((w) => COVERAGE_LOSS.has(w.code)) || (r.reasons_skipped || []).length > 0;

/**
 * A folder reply: counts plus the results that need attention (spec 09 Token budget).
 * `includePassing` returns every result. `overCap` is the number of inputs past max_images (D8).
 */
function summarize(results, { includePassing = false, overCap = 0, warnings = [] } = {}) {
  const count = (v) => results.filter((r) => r.verdict === v).length;
  const shown = includePassing ? results : results.filter(needsAttention);
  const out = {
    images: results.length,
    pass: count("pass"),
    fail: count("fail"),
    unsupported: count("unsupported"),
    error: count("error"),
    omitted_pass: results.length - shown.length,
  };
  // TODO-065: only when present, so replies for Vision locales keep their size.
  if (count("needs-reader")) out["needs-reader"] = count("needs-reader");
  if (overCap) out.over_cap = overCap;
  if (warnings.length) out.warnings = warningsOnly(warnings);
  // TODO-077 D22: inputs that pass only because their findings fall below the thresholds, so they are still seen.
  const below = results.filter((r) => r.verdict === "pass" && !shown.includes(r)).map((r) => ({ path: r.path, count: (r.findings || []).filter((f) => f.gate === false && f.known !== true).length })).filter((b) => b.count);
  if (below.length) out.below_threshold = below;
  // TODO-055 D12: inputs with approved known findings, beside below_threshold, so they are still seen.
  const known = results.map((r) => ({ path: r.path, count: (r.findings || []).filter((f) => f.known === true).length })).filter((b) => b.count);
  if (known.length) out.known = known;
  out.results = shown;
  return out;
}

module.exports = { compact, summarize, slim, warningsOnly, COVERAGE_LOSS, INLINE_HINTS };
