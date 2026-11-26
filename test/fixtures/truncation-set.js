// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// The synthetic truncation set (spec 06 D11): fit, ellipsis and clip per string, labeled by construction and drawn
// by test/fixtures/generate.swift. Each case is drawn twice: in a phone-width screen with its element written to
// <name>.boxes.json (box mode), and cropped to the element, so the image is the container (the study's no-box set).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const S = require("../../bench/untranslated/strings.json");
const LOCALES = Object.keys(S.locales).filter((l) => l !== "en");
const CASES = ["fit", "ellipsis", "clip"];

// Strings shorter than this are skipped; CJK strings are short (2 characters is a word), so they keep more.
const MIN_CHARS = (l) => (["ja", "ko", "zh-Hans"].includes(l) ? 2 : 6);

/** `per` strings per locale (the longest of at least MIN_CHARS). Returns [{ name, locale, case, truncated }]. */
function shots(per) {
  const out = [];
  for (const locale of LOCALES) {
    const strings = longest(locale, per);
    strings.forEach((s, i) => {
      for (const c of CASES) {
        const g = [...s];
        const text = c === "ellipsis" ? g.slice(0, Math.max(1, Math.round(g.length * 0.6))).join("") + "…" : s;
        const line = { text, x: 120, y: 260, size: 44, cut: c === "clip" ? 0.6 : c === "ellipsis" ? 1.05 : 1.15, full: s };
        for (const mode of ["box", "crop"]) {
          out.push({
            name: `${mode}/${locale}/${String(i).padStart(2, "0")}-${c}.png`, locale, case: c, mode, truncated: c !== "fit",
            spec: { name: `${mode}/${locale}/${String(i).padStart(2, "0")}-${c}.png`, locale, width: 1179, height: 600, lines: [line], crop: mode === "crop" },
          });
        }
      }
    });
  }
  return out;
}

// TODO-036 check 1: text drawn whole past its element. Positives run 1.5-2.5 font sizes past (start-aligned with
// clips true and false, centered); negatives overhang 0.5 (spec 06 D68: valid iOS text overhangs native frames by
// 0.42-0.63 line heights). Right to left from RTL_STRINGS, since strings.json has no RTL locale.
const OVERFLOW_CASES = [
  { case: "over-clip", over: 2.5, clips: true, truncated: true },
  { case: "over-visible", over: 1.5, clips: false, truncated: true },
  { case: "over-center", over: 1.5, clips: false, align: "center", truncated: true },
  { case: "overhang", over: 0.5, clips: false, truncated: false },
  // TODO-044: one case per assignment path where a textless (or other-text) element can take the line from its label.
  // The text runs half its width past the label, so no element but the container holds 80% of it.
  { case: "over-card", over: 0, overFrac: 0.5, clips: true, container: true, truncated: true },
  { case: "over-card-text", over: 0, overFrac: 0.5, clips: true, container: true, containerText: true, truncated: true },
  { case: "over-icon", over: 0, overFrac: 0.5, clips: false, icon: "start", truncated: true },
  { case: "over-center-icon", over: 1.5, clips: false, align: "center", icon: "center", truncated: true },
  { case: "overhang-card", over: 0.5, clips: false, container: true, truncated: false },
];
// D22 / TODO-044: the cases scored as start-aligned and as centered.
const START_CASES = ["over-clip", "over-visible", "over-card", "over-card-text", "over-icon"];
const CENTER_CASES = ["over-center", "over-center-icon"];
const RTL_STRINGS = {
  ar: ["ابدأ التجربة المجانية الآن", "إعدادات الحساب والخصوصية", "استعادة عمليات الشراء السابقة", "تسجيل الدخول باستخدام البريد",
    "اشترك للحصول على جميع الميزات", "تم حفظ التغييرات بنجاح", "إدارة الإشعارات والتنبيهات", "تحميل المحتوى للاستخدام دون اتصال",
    "دعوة الأصدقاء والحصول على مكافأة", "متابعة إلى صفحة الدفع"],
};
// Spec 06 D68's real overhangs as negatives: its extremes (0.42, 0.63 line heights) applied in font sizes, as every
// `over` here is, so they approximate D68 rather than reproduce it.
const D68 = [["el", "+80 kcal", 0.42], ["el", "+80 kcal", 0.63], ["ja", "+80 kcal", 0.42], ["ja", "+80 kcal", 0.63]];

/** `per` strings per locale, OVERFLOW_CASES each, box mode only (no boxes: no container, no rule). */
function overflowShots(per) {
  const out = [];
  const add = (locale, i, c, text, over, opt = {}) => {
    const name = `overflow/${locale}/${String(i).padStart(2, "0")}-${c}.png`;
    // y 260 and 44 pt as the spec 06 set; x leaves room for a centered element, a container and RTL leading pad.
    const line = { text, x: 160, y: 260, size: 44, over, ...(opt.align ? { align: opt.align } : {}), ...(opt.clips !== undefined ? { clips: opt.clips } : {}),
      ...(opt.overFrac ? { overFrac: opt.overFrac } : {}), ...(opt.container ? { container: true } : {}), ...(opt.icon ? { icon: opt.icon } : {}),
      ...(opt.containerText ? { containerText: opt.other } : {}) };
    out.push({ name, locale, case: c, mode: "overflow", truncated: !!opt.truncated, spec: { name, locale, width: 1179, height: 600, lines: [line] } });
  };
  // An element 2.5 font sizes short of its text's end needs that much text: 4 full-width characters, else 8.
  const wide = (s) => [...s].some((ch) => ch.codePointAt(0) >= 0x2e80);
  const roomy = (s, n) => [...s].length >= (wide(s) ? n / 2 : n);
  const sets = { ...Object.fromEntries(LOCALES.map((l) => [l, longest(l, 1000).filter((s) => roomy(s, 8)).slice(0, per)])), ...Object.fromEntries(Object.entries(RTL_STRINGS).map(([l, a]) => [l, a.slice(0, per)])) };
  for (const [locale, strings] of Object.entries(sets)) {
    strings.forEach((s, i) => {
      for (const c of OVERFLOW_CASES) {
        // A centered element 1.5 font sizes short at both ends needs room: 5 full-width characters, else 10.
        if (c.align === "center" && !roomy(s, 10)) continue;
        // A container's other text: the next string of the locale, never a piece of this one.
        add(locale, i, c.case, s, c.over, { ...c, other: strings[(i + 1) % strings.length] });
      }
    });
  }
  D68.forEach(([locale, text, over], i) => add(locale, 90 + i, "d68", text, over, { clips: false }));
  return out;
}

// Longest first (stable), so a small slice still has strings long enough to read once cut.
function longest(locale, per) {
  return Object.values(S.locales[locale]).filter((s) => [...s].length >= MIN_CHARS(locale))
    .map((s, i) => [s, i]).sort((a, b) => [...b[0]].length - [...a[0]].length || a[1] - b[1]).map(([s]) => s).slice(0, per);
}

/** Draws the set into `dir`; returns the shots. `overflow` (strings per locale) adds the TODO-036 overflow cases. */
function draw(per, dir, overflow = 0) {
  const list = [...shots(per), ...(overflow ? overflowShots(overflow) : [])];
  for (const sub of new Set(list.map((s) => path.dirname(s.name)))) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const manifest = path.join(dir, "set.json");
  fs.writeFileSync(manifest, JSON.stringify(list.map((s) => s.spec)));
  execFileSync(path.join(ROOT, ".build/synth"), [manifest, dir]);
  return list;
}

/** Precision and recall of "any finding" against the labels, overall and per reason (spec 06 D13 shape). */
function score(list, envelopes) {
  const byPath = new Map(envelopes.map((e) => [e.path, e]));
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const reasons = {};
  for (const s of list) {
    const env = byPath.get(s.path);
    const f = env ? env.findings : [];
    const hit = f.length > 0;
    c[hit ? (s.truncated ? "tp" : "fp") : (s.truncated ? "fn" : "tn")]++;
    for (const x of f) {
      const r = (reasons[x.reason] ||= { findings: 0, tp: 0 });
      r.findings++;
      if (s.truncated) r.tp++;
    }
  }
  const ratio = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
  for (const r of Object.values(reasons)) r.precision = ratio(r.tp, r.findings);
  return { images: list.length, ...c, precision: ratio(c.tp, c.tp + c.fp), recall: ratio(c.tp, c.tp + c.fn), reasons };
}

module.exports = { shots, overflowShots, draw, score, LOCALES, CASES, OVERFLOW_CASES, START_CASES, CENTER_CASES, RTL_STRINGS };
