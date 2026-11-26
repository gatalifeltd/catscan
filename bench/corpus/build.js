#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 05 corpus: 60 UI-like strings per language, drawn from Unicode CLDR through the ICU that ships in Node
// (Intl), with a fixed seed. Nothing is downloaded. The output is committed; the benchmark reads only the committed
// files, so a different Node (another ICU) never changes the corpus.
// Usage: node bench/corpus/build.js [--check]   (--check: exit 1 when a committed file differs from a fresh draw)
"use strict";
const fs = require("fs");
const path = require("path");
const { rules } = require("./rules");

const SEED = 5;
const PER = 60;
const DIR = __dirname;
// The 38 Vision locales of `catscan languages` (33 Vision lists, 5 read with one of them, TODO-037) and the 23
// Tesseract fallback locales (spec 03, TODO-037), in table order.
const VISION = ["en", "fr", "it", "de", "es", "pt-BR", "zh-Hans", "zh-Hant", "yue-Hans", "yue-Hant", "ko", "ja", "ru", "uk",
  "th", "vi", "ar", "ars", "tr", "id", "cs", "da", "nl", "no", "nn", "nb", "ms", "pl", "ro", "sv", "fi", "hi", "mr",
  "ca", "eu", "gl", "lb", "fil"];
const FALLBACK = ["el", "he", "bg", "sr", "sr-Latn", "hu", "fa", "ka", "hy",
  "hr", "sk", "sl", "lt", "lv", "mt", "ga", "is", "mk", "bs", "be", "et", "cy", "sq"];
const LOCALES = [...VISION, ...FALLBACK];

// Fixed code lists, so the pool does not depend on what an ICU build enumerates.
const REGIONS = ["DE", "FR", "IT", "ES", "PT", "BR", "US", "GB", "CA", "MX", "AR", "CL", "CO", "PE", "JP", "CN", "TW", "HK",
  "KR", "IN", "TH", "VN", "ID", "MY", "PH", "SG", "AU", "NZ", "ZA", "EG", "MA", "SA", "AE", "TR", "GR", "IL", "RU", "UA",
  "PL", "CZ", "SK", "HU", "RO", "BG", "RS", "HR", "SI", "AT", "CH", "BE", "NL", "LU", "IE", "IS", "NO", "SE", "FI", "DK",
  "EE", "LV", "LT", "GE", "AM", "IR", "PK", "NG", "KE", "ET"];
const LANGUAGES = ["de", "fr", "it", "es", "pt", "en", "ja", "zh", "ko", "ru", "uk", "pl", "tr", "ar", "he", "el", "nl",
  "sv", "fi", "da", "no", "cs", "hu", "ro", "bg", "sr", "hr", "th", "vi", "id", "ms", "hi", "mr", "fa", "ka", "hy"];
const CURRENCIES = ["EUR", "USD", "GBP", "JPY", "CNY", "KRW", "INR", "RUB", "BRL", "CHF", "SEK", "NOK", "DKK", "PLN",
  "CZK", "HUF", "TRY", "ILS", "THB", "VND", "IDR", "AUD", "CAD", "MXN"];
const FIELDS = ["era", "year", "quarter", "month", "weekOfYear", "weekday", "day", "dayPeriod", "hour", "minute", "second",
  "timeZoneName"];
const REL_UNITS = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"];
const UNITS = ["minute", "hour", "day", "week", "month", "kilometer", "meter", "kilogram", "liter", "percent", "megabyte",
  "gigabyte", "kilometer-per-hour", "celsius"];
// Quotas per kind (sum 60); a kind that runs short is filled from the rest of the pool.
const QUOTA = { region: 12, language: 10, currency: 6, month: 4, weekday: 3, field: 5, relative: 10, unit: 8, date: 2 };

/** mulberry32: a small seeded PRNG, so the draw is the same on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const hash = (s) => [...s].reduce((h, c) => Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0, 2166136261);

/** Every candidate string for `locale`, by kind, in a fixed order. */
function pool(locale) {
  const dn = (type) => new Intl.DisplayNames([locale], { type, fallback: "none" });
  const of = (d, code) => { try { return d.of(code); } catch { return undefined; } };
  const utc = (y, m, d) => new Date(Date.UTC(y, m, d, 12));
  const out = { region: [], language: [], currency: [], month: [], weekday: [], field: [], relative: [], unit: [], date: [] };
  const r = dn("region"), l = dn("language"), c = dn("currency"), f = dn("dateTimeField");
  for (const x of REGIONS) out.region.push(of(r, x));
  for (const x of LANGUAGES) out.language.push(of(l, x));
  for (const x of CURRENCIES) out.currency.push(of(c, x));
  for (const x of FIELDS) out.field.push(of(f, x));
  const month = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  for (let m = 0; m < 12; m++) out.month.push(month.format(utc(2025, m, 15)));
  const day = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
  for (let d = 0; d < 7; d++) out.weekday.push(day.format(utc(2025, 2, 3 + d)));
  const rel = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const u of REL_UNITS) for (const v of [-1, 1, 3, -5]) out.relative.push(rel.format(v, u));
  for (const u of UNITS) for (const v of [2, 5]) {
    out.unit.push(new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "long" }).format(v));
  }
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" });
  for (const [y, m, d] of [[2025, 2, 3], [2026, 10, 6], [2024, 6, 19]]) out.date.push(date.format(utc(y, m, d)));
  for (const k of Object.keys(out)) out[k] = out[k].filter((s) => typeof s === "string").map((s) => s.normalize("NFC"));
  return out;
}

/** Draws PER strings for `locale` with the seed; returns [{ text, kind }] in draw order. */
function draw(locale) {
  const rand = rng(SEED ^ hash(locale));
  const cands = pool(locale);
  const picked = [];
  const accept = (text, kind) => {
    const next = [...picked, { text, kind }];
    if (rules(next.map((p) => p.text), locale).length === 0) picked.push({ text, kind });
  };
  const rest = [];
  for (const [kind, n] of Object.entries(QUOTA)) {
    const list = shuffle([...new Set(cands[kind])], rand);
    let taken = 0;
    for (const t of list) {
      if (taken < n) { const before = picked.length; accept(t, kind); if (picked.length > before) taken++; }
      else rest.push([t, kind]);
    }
  }
  for (const [t, kind] of shuffle(rest, rand)) { if (picked.length >= PER) break; accept(t, kind); }
  if (picked.length < PER) throw new Error(`${locale}: only ${picked.length} strings pass the rules`);
  return picked;
}

function build() {
  const out = {};
  for (const locale of LOCALES) {
    out[locale] = {
      locale,
      icu_locale: new Intl.DisplayNames([locale], { type: "region" }).resolvedOptions().locale,
      source: "Unicode CLDR via Node Intl (DisplayNames, DateTimeFormat, RelativeTimeFormat, NumberFormat)",
      license: "Unicode License v3",
      seed: SEED,
      node: process.version, icu: process.versions.icu, cldr: process.versions.cldr, unicode: process.versions.unicode,
      strings: draw(locale),
    };
  }
  return out;
}

const file = (locale) => path.join(DIR, `${locale}.json`);
module.exports = { LOCALES, VISION, FALLBACK, PER, SEED, draw, rng, file };

if (require.main === module) {
  const all = build();
  if (process.argv.includes("--check")) {
    const diff = LOCALES.filter((l) => !fs.existsSync(file(l))
      || JSON.stringify(JSON.parse(fs.readFileSync(file(l), "utf8")).strings) !== JSON.stringify(all[l].strings));
    if (diff.length) { console.error(`corpus differs from a fresh draw (ICU ${process.versions.icu}): ${diff.join(", ")}`); process.exit(1); }
    console.log(`corpus matches a fresh draw (${LOCALES.length} locales)`);
  } else {
    for (const l of LOCALES) fs.writeFileSync(file(l), JSON.stringify(all[l], null, 2) + "\n");
    console.log(`wrote ${LOCALES.length} corpus files (ICU ${process.versions.icu}, CLDR ${process.versions.cldr})`);
  }
}
