// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 05 scorer on hand-made responses with known metrics.
const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreLanguage, gate, compare, median } = require("../languages/score");

const item = (index, c, text = `Word${index}x`, absent = "Other") => ({ name: `de/${index}-${c}.png`, index, case: c, text, absent });
const env = (checks, extra = {}) => ({ verdict: "pass", engine: "vision-accurate-rev3", checks, findings: [], ...extra });
const pass = (kind, text) => ({ kind, text, verdict: "pass" });
const trunc = (hit) => ({ verdict: hit ? "fail" : "pass", findings: hit ? [{ reason: "ellipsis" }] : [] });
const read = (...conf) => ({ verdict: "pass", lines: conf.map((c) => ({ text: "x", confidence: c })) });

test("recall, check accuracy, CER, truncation and histogram on a known set", () => {
  const items = [item(0, "fit", "Abcde"), item(1, "fit", "Fghij"), item(0, "ellipsis"), item(0, "clip"), item(1, "clip")];
  const res = {
    [items[0].name]: { check: env([pass("present", "Abcde"), pass("absent", "Other")]), truncated: trunc(false), read: read(0.95) },
    // Misread: closest line 2 edits away; absent passes; a false truncation alarm.
    [items[1].name]: { check: env([{ kind: "present", text: "Fghij", verdict: "fail", closest: { line: "Fgh1", distance: 2 } }, pass("absent", "Other")]), truncated: trunc(true), read: read(0.42) },
    [items[2].name]: { check: env([pass("absent", "Other")]), truncated: trunc(true) },
    // The absent string was "found": a false hit. Truncation missed.
    [items[3].name]: { check: env([{ kind: "absent", text: "Other", verdict: "fail", line: "Other" }]), truncated: trunc(false), read: read(0.3, 1) },
    [items[4].name]: { check: env([pass("absent", "Other")]), truncated: trunc(true), read: read(0.55) },
  };
  const { summary: s, rows } = scoreLanguage("de", items, res, { ms: [10, 30, 20], gated: true });
  assert.equal(s.checks, 7);
  assert.equal(s.correct, 5);
  assert.equal(s.check_accuracy, 71.43);
  assert.equal(s.fit_recall, 0.5);
  assert.equal(s.cer, 0.2); // 2 edits over 10 characters
  assert.deepEqual([s.trunc_tp, s.trunc_fp, s.trunc_fn, s.trunc_tn], [2, 1, 1, 1]);
  assert.equal(s.trunc_precision, 0.6667);
  assert.equal(s.trunc_recall, 0.6667);
  assert.equal(s.median_ms, 20);
  assert.equal(s.conf_fit, "0|0|0|0|1|0|0|0|0|1");
  assert.equal(s.conf_clip, "0|0|0|1|0|1|0|0|0|1"); // 1.0 lands in the last bucket
  assert.equal(s.engine, "vision-accurate-rev3");
  assert.deepEqual(rows.map((r) => r.image), [items[1].name, items[3].name]);
  assert.equal(rows[0].read, "Fgh1");
  assert.equal(rows[0].cer, 2);
  assert.equal(rows[1].read, "Other");
});

test("an errored image counts all its checks wrong, its string unread and its cut missed", () => {
  const items = [item(0, "fit", "Abcde"), item(0, "clip")];
  const res = {
    [items[0].name]: { check: { verdict: "error", error: { code: "decode-failed" } }, truncated: trunc(false) },
    [items[1].name]: { check: env([pass("absent", "Other")]), truncated: { verdict: "error", error: { code: "x" } } },
  };
  const { summary: s, rows } = scoreLanguage("de", items, res);
  assert.equal(s.errors, 2);
  assert.equal(s.checks, 3);
  assert.equal(s.correct, 0);
  assert.equal(s.cer, 1);
  assert.equal(s.trunc_fn, 1);
  assert.equal(rows[0].read, "decode-failed");
});

test("a missing response is an error, and a fallback locale answered by Vision is wrong", () => {
  const items = [item(0, "fit", "Abcde")];
  assert.equal(scoreLanguage("de", items, {}).summary.errors, 1);
  const res = { [items[0].name]: { check: env([pass("present", "Abcde"), pass("absent", "Other")]), truncated: trunc(false) } };
  assert.equal(scoreLanguage("el", items, res, { fallback: true }).summary.errors, 1);
  const tess = { [items[0].name]: { check: env([pass("present", "Abcde"), pass("absent", "Other")], { engine: "tesseract-5.5.3" }), truncated: trunc(false) } };
  assert.equal(scoreLanguage("el", items, tess, { fallback: true }).summary.check_accuracy, 100);
});

test("CER without any recognized line counts the whole string; no fit images gives null", () => {
  const items = [item(0, "fit", "Abcd")];
  const res = { [items[0].name]: { check: env([{ kind: "present", text: "Abcd", verdict: "fail", closest: null }, pass("absent", "Other")]), truncated: trunc(false) } };
  assert.equal(scoreLanguage("de", items, res).summary.cer, 1);
  assert.equal(scoreLanguage("de", [], {}).summary.cer, null);
});

test("a check the response left out counts as asked and wrong; a misread with a line break stays on one CSV line", () => {
  const items = [item(0, "fit", "Abcde")];
  const res = { [items[0].name]: { check: env([{ kind: "present", text: "Abcde", verdict: "fail", closest: { line: "Ab\ncde", distance: 1 } }]), truncated: trunc(false) } };
  const { summary: s, rows } = scoreLanguage("de", items, res);
  assert.equal(s.checks, 2);
  assert.equal(s.correct, 0);
  assert.equal(rows[0].read, "Ab cde");
  // The present check itself missing: the string counts as unread.
  const gone = { [items[0].name]: { check: env([pass("absent", "Other")]), truncated: trunc(false) } };
  const g = scoreLanguage("de", items, gone);
  assert.equal(g.summary.cer, 1);
  assert.equal(g.summary.correct, 1);
  assert.equal(g.summary.checks, 2);
  assert.equal(g.rows[0].present, "missing");
});

test("median", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("gate: 98% on the gated locales; a missing one fails only for a full locale set", () => {
  const s = [{ locale: "en", check_accuracy: 98 }, { locale: "de", check_accuracy: 97.99 }, { locale: "vi", check_accuracy: 50 }];
  assert.deepEqual(gate(s, ["en", "de"]), ["de: check accuracy 97.99% < 98%"]);
  assert.deepEqual(gate(s, ["en", "el"]), ["el: missing from the run"]);
  assert.deepEqual(gate(s, ["en", "el"], { all: false }), []);
});

test("quick comparison: truncation found and false alarms are compared too", () => {
  const rec = [{ locale: "de", correct: 40, checks: 40, fit_read: 10, fit_images: 10, trunc_tp: 18, trunc_fp: 0 }];
  const now = (x) => [{ locale: "de", errors: 0, correct: 40, checks: 40, fit_read: 10, fit_images: 10, ...x }];
  assert.deepEqual(compare(now({ trunc_tp: 17, trunc_fp: 1 }), rec), []);
  assert.deepEqual(compare(now({ trunc_tp: 16, trunc_fp: 0 }), rec), ["de: truncation found 16, recorded 18"]);
  assert.deepEqual(compare(now({ trunc_tp: 18, trunc_fp: 2 }), rec), ["de: truncation false alarms 2, recorded 0"]);
});

test("quick comparison: one lost check or read is noise, two is a regression", () => {
  const rec = [{ locale: "de", correct: 40, checks: 40, fit_read: 10, fit_images: 10 }, { locale: "ja", correct: 39, checks: 40, fit_read: 9, fit_images: 10 }];
  const now = (d, j) => [{ locale: "de", errors: 0, ...d }, { locale: "ja", errors: 0, correct: 39, checks: 40, fit_read: 9, fit_images: 10, ...j }];
  assert.deepEqual(compare(now({ correct: 39, checks: 40, fit_read: 9, fit_images: 10 }), rec), []);
  assert.deepEqual(compare(now({ correct: 38, checks: 40, fit_read: 10, fit_images: 10 }), rec), ["de: check 38/40, recorded 40/40"]);
  assert.deepEqual(compare(now({ correct: 40, checks: 40, fit_read: 8, fit_images: 10 }), rec), ["de: fit read 8/10, recorded 10/10"]);
  assert.deepEqual(compare(now({ correct: 40, checks: 40, fit_read: 10, fit_images: 10, errors: 1 }), rec), ["de: 1 image(s) errored"]);
  assert.deepEqual(compare([{ locale: "vi", errors: 0, correct: 1, checks: 1, fit_read: 1 }], rec, { all: false }), ["vi: not in the recorded quick run"]);
  assert.deepEqual(compare(now({ correct: 40, checks: 40, fit_read: 10 }).slice(0, 1), rec), ["ja: missing from the run"]);
  assert.deepEqual(compare(now({ correct: 40, checks: 40, fit_read: 10 }).slice(0, 1), rec, { all: false }), []);
});
