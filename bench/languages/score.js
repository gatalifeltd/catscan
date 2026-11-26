// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 05 scorer: per-language metrics from catscan's own responses (D3); never matches text itself.
const { norm, graphemes } = require("../corpus/rules");

const THRESHOLD = 98; // check accuracy, percent (spec 05 Gate)
const BUCKETS = 10; // confidence histogram, 0.1 wide

const ratio = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
const pct = (n, d) => (d ? Number(((n / d) * 100).toFixed(2)) : null);
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
const oneLine = (s) => String(s).replace(/[\r\n]+/g, " "); // the CSV reader splits on newlines
const failed = (env) => !env || env.verdict === "error" || Boolean(env.error);
/** A fallback locale must be read by Tesseract; a Vision answer for it is wrong, not a pass (as bench/fallback.js). */
const wrongEngine = (env, fallback) => fallback && !String(env.engine || "").startsWith("tesseract-");

/**
 * Scores one language. `items` come from plan.plan(); `res` maps an item name to { check, truncated, read } envelopes
 * (read only for fit and clip images); `ms` are the timing pass's response times. Returns { summary, rows }, where
 * rows are the images wrong in any metric.
 */
function scoreLanguage(locale, items, res, { ms = [], fallback = false, gated = false } = {}) {
  const s = { checks: 0, correct: 0, fit: 0, fit_read: 0, cer_edits: 0, cer_chars: 0, tp: 0, fp: 0, fn: 0, tn: 0, errors: 0 };
  const hist = { fit: Array(BUCKETS).fill(0), clip: Array(BUCKETS).fill(0) };
  const engines = new Set();
  const rows = [];
  for (const it of items) {
    const r = res[it.name] || {};
    const row = { image: it.name, case: it.case, present: "", absent: "", truncated: "", cer: "", read: "" };
    const nChecks = it.case === "fit" ? 2 : 1;
    const chars = graphemes(norm(it.text, locale));
    if (it.case === "fit") { s.fit++; s.cer_chars += chars; }
    if (failed(r.check) || failed(r.truncated) || (r.check && wrongEngine(r.check, fallback))) {
      // An errored image counts every one of its checks as wrong and its read as missed.
      s.checks += nChecks; s.errors++;
      // A fit image's whole string is unread; a cut image is a missed truncation.
      if (it.case === "fit") s.cer_edits += chars;
      else s.fn++;
      row.present = "error"; row.absent = "error";
      row.read = String(r.check?.error?.code || r.truncated?.error?.code || r.check?.engine || "missing");
      rows.push(row);
      continue;
    }
    engines.add(r.check.engine);
    let wrong = false;
    // A check the response left out counts as asked and wrong, so a dropped check never raises the accuracy.
    const got = (r.check.checks || []).length;
    if (got < nChecks) { s.checks += nChecks - got; wrong = true; }
    if (it.case === "fit" && !(r.check.checks || []).some((c) => c.kind === "present")) { s.cer_edits += chars; row.present = "missing"; wrong = true; }
    for (const c of r.check.checks || []) {
      s.checks++;
      if (c.verdict === "pass") s.correct++;
      else wrong = true;
      if (c.kind === "present") {
        row.present = c.verdict;
        if (c.verdict === "pass") s.fit_read++;
        const d = c.verdict === "pass" ? 0 : c.closest ? c.closest.distance : chars;
        s.cer_edits += d;
        row.cer = d;
        if (c.verdict !== "pass") row.read = c.closest ? oneLine(c.closest.line) : "";
      } else {
        row.absent = c.verdict;
        if (c.verdict !== "pass") row.read = oneLine(c.line || "");
      }
    }
    const hit = (r.truncated.findings || []).length > 0;
    const cut = it.case !== "fit";
    s[hit ? (cut ? "tp" : "fp") : (cut ? "fn" : "tn")]++;
    row.truncated = hit ? (r.truncated.findings[0].reason || "yes") : "no";
    if (hit !== cut) wrong = true;
    if (r.read && !failed(r.read) && (it.case === "fit" || it.case === "clip")) {
      for (const l of r.read.lines || []) hist[it.case][Math.min(BUCKETS - 1, Math.floor(l.confidence * BUCKETS))]++;
    }
    if (wrong) rows.push(row);
  }
  const summary = {
    locale,
    engine: [...engines].sort().join("+") || "none",
    gated,
    images: items.length,
    errors: s.errors,
    checks: s.checks,
    correct: s.correct,
    check_accuracy: pct(s.correct, s.checks),
    fit_images: s.fit,
    fit_read: s.fit_read,
    fit_recall: ratio(s.fit_read, s.fit),
    cer: ratio(s.cer_edits, s.cer_chars),
    trunc_tp: s.tp, trunc_fp: s.fp, trunc_fn: s.fn, trunc_tn: s.tn,
    trunc_precision: ratio(s.tp, s.tp + s.fp),
    trunc_recall: ratio(s.tp, s.tp + s.fn),
    median_ms: median(ms),
    conf_fit: hist.fit.join("|"),
    conf_clip: hist.clip.join("|"),
  };
  return { summary, rows };
}

/** The spec 05 gate on a full run: gated locales in the run below THRESHOLD fail; with `all`, a missing one fails. */
function gate(summaries, gatedList, { all = true } = {}) {
  const by = new Map(summaries.map((x) => [x.locale, x]));
  const fails = [];
  for (const g of gatedList) {
    const x = by.get(g);
    if (!x) { if (all) fails.push(`${g}: missing from the run`); continue; }
    if (x.check_accuracy === null || x.check_accuracy < THRESHOLD) fails.push(`${g}: check accuracy ${x.check_accuracy}% < ${THRESHOLD}%`);
  }
  return fails;
}

/**
 * The quick comparison (spec 05 D5, D13): a language fails when it lost more than one correct check, fit read or
 * found truncation, or gained more than one truncation false alarm, against the recorded quick summary, or has an errored image; with `all`, a recorded language missing
 * from the run fails. Returns messages; empty when the run matches.
 */
function compare(summaries, recorded, { all = true } = {}) {
  const fails = [];
  const now = new Map(summaries.map((x) => [x.locale, x]));
  for (const x of summaries) {
    const r = recorded.find((y) => y.locale === x.locale);
    if (!r) { fails.push(`${x.locale}: not in the recorded quick run`); continue; }
    if (x.errors > 0) fails.push(`${x.locale}: ${x.errors} image(s) errored`);
    if (x.correct < r.correct - 1) fails.push(`${x.locale}: check ${x.correct}/${x.checks}, recorded ${r.correct}/${r.checks}`);
    if (x.fit_read < r.fit_read - 1) fails.push(`${x.locale}: fit read ${x.fit_read}/${x.fit_images}, recorded ${r.fit_read}/${r.fit_images}`);
    // Truncation is its own command: a lost cut or a new false alarm is not visible in the check counts.
    if (x.trunc_tp < r.trunc_tp - 1) fails.push(`${x.locale}: truncation found ${x.trunc_tp}, recorded ${r.trunc_tp}`);
    if (x.trunc_fp > r.trunc_fp + 1) fails.push(`${x.locale}: truncation false alarms ${x.trunc_fp}, recorded ${r.trunc_fp}`);
  }
  if (all) for (const r of recorded) if (!now.has(r.locale)) fails.push(`${r.locale}: missing from the run`);
  return fails;
}

module.exports = { scoreLanguage, gate, compare, median, THRESHOLD, BUCKETS };
