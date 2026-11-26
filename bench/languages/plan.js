// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 05 image plan: which images a run draws, labeled by construction.
const fs = require("fs");
const corpus = require("../corpus/build");

const CASES = ["fit", "ellipsis", "clip"];
const SIZES = [12, 16, 24]; // CSS px, drawn at scale 3
const THEMES = ["light", "dark"];
const BACKGROUNDS = ["flat", "gradient"];
const QUICK = { strings: 10, size: 16, theme: "light", background: "flat" };
const RTL = new Set(["ar", "ars", "he", "fa", "ur"]); // TextMatch.rightToLeft
// Spec 05 Gate: en, the study's 12 D4 locales, and the three gated fallback locales; TODO-037 adds the Vision
// locales that already measured >= 98% and the new European locales that passed their first record (mt, sq did not: D4).
const GATED = ["en", "de", "fr", "es", "it", "pt-BR", "pl", "tr", "ru", "uk", "ja", "ko", "zh-Hans", "el", "he", "bg",
  "sv", "da", "no", "nb", "fi", "nl", "ar",
  "hr", "sk", "sl", "lt", "lv", "ga", "is", "mk", "bs", "be", "ca", "eu", "gl", "et", "cy", "lb", "fil"];

const isRtl = (locale) => RTL.has(locale.split("-")[0]);

/** Edit distance, for naming the closest locale in a usage error. */
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** The run's locales from `--lang` (comma list) or all; throws a usage error naming the closest for an unknown one. */
function locales(lang) {
  if (!lang) return [...corpus.LOCALES];
  const out = [];
  for (const raw of lang.split(",").map((s) => s.trim()).filter(Boolean)) {
    const hit = corpus.LOCALES.find((l) => l.toLowerCase() === raw.toLowerCase());
    if (!hit) {
      const near = [...corpus.LOCALES].sort((a, b) => lev(raw, a) - lev(raw, b))[0];
      throw Object.assign(new Error(`unknown locale "${raw}" in --lang; closest: ${near}`), { exit: 2 });
    }
    if (!out.includes(hit)) out.push(hit);
  }
  if (!out.length) throw Object.assign(new Error("--lang is empty"), { exit: 2 });
  return out;
}

const readCorpus = (locale) => JSON.parse(fs.readFileSync(corpus.file(locale), "utf8")).strings.map((s) => s.text);

/** Images for one locale: [{ name, locale, index, text, absent, case, size, theme, background, rtl }]. */
function plan(locale, { quick = false, strings = readCorpus(locale) } = {}) {
  const list = quick ? strings.slice(0, QUICK.strings) : strings;
  const variants = [];
  for (const size of quick ? [QUICK.size] : SIZES) for (const theme of quick ? [QUICK.theme] : THEMES) {
    for (const background of quick ? [QUICK.background] : BACKGROUNDS) variants.push({ size, theme, background });
  }
  const out = [];
  list.forEach((text, index) => {
    // The absent string is the next one of the same language; the corpus rules keep it out of `text` (spec 05).
    const absent = strings[(index + 1) % strings.length];
    for (const c of CASES) for (const v of variants) {
      const name = `${locale}/${String(index).padStart(2, "0")}-${c}-${v.size}-${v.theme}-${v.background}.png`;
      out.push({ name, locale, index, text, absent, case: c, ...v, rtl: isRtl(locale) });
    }
  });
  return out;
}

/** The images of the sequential timing pass: fit images of the quick variant (spec 05 D8). */
const timed = (items) => items.filter((i) => i.case === "fit" && i.size === QUICK.size && i.theme === QUICK.theme
  && i.background === QUICK.background && i.index < QUICK.strings);

module.exports = { CASES, SIZES, THEMES, BACKGROUNDS, QUICK, GATED, isRtl, locales, plan, timed, readCorpus };
