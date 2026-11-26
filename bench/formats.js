#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T3 gate (D33, D34, D39): precision and recall of `catscan formats` per rule on a synthetic set, with
// Wilson 95% intervals and the eligible share (D11).
// Usage: node bench/formats.js > results/formats.json   (exit 1 when a gate fails)
// 12 run locales x 50 screens (stats screens and paywalls), drawn with test/fixtures/generate.swift from values that
// bench/formats/values.swift renders with Foundation. Each locale's screens are split by storefront: 20 in the
// locale's own storefront when it is one of the 8, 20 across the others, 10 with no storefront (where mixed
// currencies are seeded, D9). 0-3 seeds per screen by quota, each breaking exactly one rule; negatives on every screen.
// One `catscan formats --rules <all seven>` run per locale and storefront, with that storefront's price file.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const WORDS = require("./formats/words.json");
const LOCALES = ["en-US", "en-GB", "en-IN", "de", "fr", "es", "it", "pt-BR", "tr", "ja", "ko", "ru"]
  .filter((l) => !process.env.BENCH_LOCALES || process.env.BENCH_LOCALES.split(",").includes(l));
const SCREENS = Number(process.env.BENCH_SCREENS || 50);
const STOREFRONTS = { US: "USD", GB: "GBP", DE: "EUR", FR: "EUR", JP: "JPY", BR: "BRL", IN: "INR", TR: "TRY" };
const HOME = { "en-US": "US", "en-GB": "GB", "en-IN": "IN", de: "DE", fr: "FR", es: "DE", it: "FR", "pt-BR": "BR", tr: "TR", ja: "JP", ko: null, ru: null };
const HOME_CURRENCY = { "en-US": "USD", "en-GB": "GBP", "en-IN": "INR", de: "EUR", fr: "EUR", es: "EUR", it: "EUR", "pt-BR": "BRL", tr: "TRY", ja: "JPY", ko: "KRW", ru: "RUB" };
// Products per storefront currency: annual (with a trial), monthly, weekly.
const PRODUCTS = {
  USD: [["39.99", "P3D"], ["7.99"], ["3.99"]], GBP: [["34.99", "P1W"], ["6.99"], ["2.99"]], EUR: [["39.99", "P3D"], ["7.99"], ["3.49"]],
  JPY: [["4900", "P3D"], ["980"], ["480"]], BRL: [["199.90", "P1W"], ["39.90"], ["14.90"]], INR: [["3499", "P3D"], ["699"], ["299"]],
  TRY: [["999.99", "P3D"], ["199.99"], ["79.99"]],
};
const DIGITS = { USD: 2, GBP: 2, EUR: 2, JPY: 0, BRL: 2, INR: 2, TRY: 2, KRW: 0, RUB: 2 };
const RULES = ["number", "date", "time", "currency-placement", "currency", "mixed-currency", "price"];
const CATEGORIES = ["number", "date", "time", "currency-placement", "currency", "mixed-currency", "amount", "period", "trial"];
const QUOTA = 100;
const GATE = { precision: 0.97, recall: 0.85 };
const LABELS = {
  en: ["Total", "Renews on", "Starts at", "Go Premium", "Score", "Level", "Version", "Balance"],
  de: ["Gesamt", "Verlängert am", "Beginnt um", "Premium holen", "Punkte", "Level", "Version", "Guthaben"],
  fr: ["Total", "Renouvelé le", "Commence à", "Passer Premium", "Score", "Niveau", "Version", "Solde"],
  es: ["Total", "Se renueva el", "Empieza a las", "Hazte Premium", "Puntos", "Nivel", "Versión", "Saldo"],
  it: ["Totale", "Si rinnova il", "Inizia alle", "Passa a Premium", "Punti", "Livello", "Versione", "Saldo"],
  pt: ["Total", "Renova em", "Começa às", "Seja Premium", "Pontos", "Nível", "Versão", "Saldo"],
  tr: ["Toplam", "Yenileme", "Başlangıç", "Premium ol", "Puan", "Seviye", "Sürüm", "Bakiye"],
  ja: ["合計", "更新日", "開始", "プレミアム", "スコア", "レベル", "バージョン", "残高"],
  ko: ["합계", "갱신일", "시작", "프리미엄", "점수", "레벨", "버전", "잔액"],
  ru: ["Итого", "Продление", "Начало", "Премиум", "Очки", "Уровень", "Версия", "Баланс"],
};

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(36003);
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const lang = (l) => (l.startsWith("pt") ? "pt" : l.split("-")[0]);
// Whitespace is not compared (Vision keeps or drops the space next to a symbol); fullwidth signs fold as in the core.
const FW = { "\uFFE5": "\u00A5", "\uFF04": "$", "\uFFE1": "\u00A3", "\uFFE6": "\u20A9", "\uFF0E": ".", "\uFF0C": ",", "\uFF1A": ":", "\uFF0F": "/" };
const fold = (s) => s.normalize("NFC").replace(/[\uFF10-\uFF19]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
  .replace(/[\uFFE5\uFF04\uFFE1\uFFE6\uFF0E\uFF0C\uFF1A\uFF0F]/g, (c) => FW[c]).replace(/[\s\u00A0\u202F\u3000]+/g, "");
const ratio = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Number(Math.max(0, c - h).toFixed(4)), Number(Math.min(1, c + h).toFixed(4))];
}
const longest = (a) => a.reduce((x, y) => (y.length > x.length ? y : x), "");
const perUnit = (l, p) => longest(WORDS.perUnit[lang(l)][p]);
const withPer = (amount, l, p) => { const w = perUnit(l, p); return w.startsWith("/") ? `${amount}${w}` : `${amount} ${w}`; };
const dayWord = (l) => { const d = WORDS.units[lang(l)].day; return d[1] && !d[1].endsWith(".") ? d[1] : d[0]; };
const trialWord = (l) => WORDS.hand[lang(l)].trial[0];
const minor = (v, c) => Math.round(Number(v) * 10 ** DIGITS[c]);
const major = (m, c) => (m / 10 ** DIGITS[c]).toFixed(DIGITS[c]);

// Foundation renderings, batched: plan() queues a request and returns a slot; render() fills them.
let queue = [];
const slot = (req) => { const s = { req, value: null }; queue.push(s); return s; };
function render(bin) {
  const out = JSON.parse(execFileSync(bin, { input: JSON.stringify(queue.map((s) => s.req)), maxBuffer: 1 << 28 }).toString());
  queue.forEach((s, i) => { s.value = out[i]; });
  queue = [];
}
const v = (x) => (typeof x === "string" ? x : x.value);

// MARK: Plan the screens

const ORDER = {}; // date field order per locale, filled after the first render
function plan() {
  const screens = [];
  const count = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const loc of LOCALES) {
    const home = HOME[loc];
    const others = Object.keys(STOREFRONTS).filter((s) => s !== home);
    for (let i = 0; i < SCREENS; i++) {
      const sf = i < SCREENS * 0.2 ? null : home && i < SCREENS * 0.6 ? home : pick(others);
      const paywall = sf !== null && rand() < 0.6;
      screens.push({ name: `${String(i).padStart(3, "0")}.png`, locale: loc, storefront: sf, paywall, lines: [], seeds: [], wants: [] });
    }
  }
  // Seeds by quota: each screen takes up to 3 categories that apply to it, the least-filled first.
  const applies = (s, c) => {
    if (c === "time") return !["en-US", "en-IN", "ko"].includes(s.locale);
    if (c === "mixed-currency") return s.storefront === null;
    if (c === "currency") return s.storefront !== null;
    if (["amount", "period", "trial"].includes(c)) return s.paywall;
    return true;
  };
  for (const s of screens) {
    const k = rand() < 0.1 ? 0 : int(1, 3);
    const cand = CATEGORIES.filter((c) => applies(s, c)).sort((a, b) => count[a] - count[b] || (rand() - 0.5));
    // Amount, period and trial share the annual price's line on a paywall: at most one of them per screen.
    for (const c of cand) {
      if (s.wants.length >= k) break;
      if (["amount", "period", "trial"].includes(c) && s.wants.some((w) => ["amount", "period", "trial"].includes(w))) continue;
      s.wants.push(c);
      count[c]++;
    }
  }
  return screens;
}

function build(screens, valuesBin) {
  // Round 1: the renderings every screen needs.
  const loc12 = [...new Set(screens.map((s) => s.locale))];
  for (const l of loc12) ORDER[l] = slot({ t: "date", l, y: 2026, m: 11, d: 25, tpl: "yyyyMMdd" });
  for (const s of screens) {
    const L = s.locale, cur = s.storefront ? STOREFRONTS[s.storefront] : HOME_CURRENCY[L];
    s.cur = cur;
    s.r = {
      num: slot({ t: "num", l: L, v: `${int(1000, 99999)}.${String(int(1, 99)).padStart(2, "0")}`, f: 2 }),
      date: slot({ t: "date", l: L, y: 2026, m: int(1, 12), d: int(1, 28) }),
      time: slot({ t: "time", l: L, h: int(13, 22), mi: int(0, 59) }),
      balance: slot({ t: "cur", l: L, c: cur, v: major(int(100, 99999) * 10 ** DIGITS[cur] / 100 | 0, cur) }),
      ambiguous: slot({ t: "num", l: L, v: String(int(1001, 9999)), f: 0 }),
    };
    if (s.storefront) {
      const P = PRODUCTS[cur];
      s.r.prices = P.map((p) => slot({ t: "cur", l: L, c: cur, v: p[0] }));
      s.r.storeShape = slot({ t: "cur", l: `${lang(L)}-${s.storefront}`, c: cur, v: P[1][0] });
      s.r.higher = slot({ t: "cur", l: L, c: cur, v: major(minor(P[0][0], cur) * 2, cur) });
    }
  }
  render(valuesBin);
  for (const l of loc12) {
    const t = ORDER[l].value;
    ORDER[l] = t.indexOf("2026") < t.indexOf("25") ? (t.indexOf("11") < t.indexOf("25") ? "yMd" : "ydM") : t.indexOf("11") < t.indexOf("25") ? "Mdy" : "dMy";
  }
  // Round 2: seed values, which depend on the screen's correct renderings.
  for (const s of screens) {
    const L = s.locale;
    s.seedReq = {};
    for (const c of s.wants) {
      if (c === "number") {
        const dec = v(s.r.num).match(/[.,](\d{2})$/)?.[0][0];
        const src = dec === "," ? "en-US" : "de";
        s.seedReq.number = slot({ t: "num", l: src, v: `${int(1000, 99999)}.${String(int(1, 99)).padStart(2, "0")}`, f: 2 });
      } else if (c === "date") {
        const src = { dMy: pick(["en-US", "ja"]), Mdy: pick(["de", "ja"]), yMd: pick(["de", "en-US"]), ydM: "de" }[ORDER[L]];
        s.seedReq.date = slot({ t: "date", l: src, y: 2026, m: int(1, 12), d: int(13, 28), tpl: "yyyyMMdd" });
      } else if (c === "time") {
        s.seedReq.time = slot({ t: "time", l: "en-US", h: int(13, 22), mi: int(0, 59), tpl: "hmma" });
      } else if (c === "currency" || c === "mixed-currency") {
        const other = pick(["USD", "EUR", "GBP", "JPY", "INR", "TRY", "BRL"].filter((x) => x !== s.cur));
        s.seedReq[c] = slot({ t: "cur", l: L, c: other, v: other === "JPY" ? String(int(100, 9000)) : `${int(1, 99)}.${String(int(0, 99)).padStart(2, "0")}` });
        s.seedReq[c].currency = other;
      } else if (c === "amount") {
        const P = PRODUCTS[s.cur];
        const bad = minor(P[1][0], s.cur) + 10 ** DIGITS[s.cur] * int(1, 3);
        s.seedReq.amount = slot({ t: "cur", l: L, c: s.cur, v: major(bad, s.cur) });
      }
    }
  }
  render(valuesBin);
  // Compose the lines.
  for (const s of screens) {
    const L = s.locale, lab = LABELS[lang(L)];
    const add = (text, seed) => { s.lines.push(text); if (seed) s.seeds.push({ ...seed, line: text }); };
    add(lab[3]);
    const amountLines = [];
    if (s.paywall) {
      const [annual, monthly, weekly] = s.r.prices.map(v);
      const P = PRODUCTS[s.cur];
      const tw = trialWord(L), dw = dayWord(L);
      const trialN = (P[0][1] || "P3D") === "P1W" ? 7 : 3;
      if (s.wants.includes("period")) add(withPer(annual, L, "month"), { cat: "period", token: annual, word: perUnit(L, "month") });
      else if (s.wants.includes("trial")) {
        const wrong = trialN === 3 ? 7 : 3;
        add(`${wrong} ${dw} ${tw}, ${withPer(annual, L, "year")}`, { cat: "trial", token: `P${wrong}D`, amount: annual, n: wrong, dw, tw });
      } else add(withPer(annual, L, "year"));
      if (s.wants.includes("amount")) { const a = v(s.seedReq.amount); add(withPer(a, L, "month"), { cat: "amount", token: a }); }
      else add(withPer(monthly, L, "month"));
      if (s.wants.includes("currency-placement")) {
        const seeded = flip(weekly, s);
        if (seeded) add(withPer(seeded, L, "week"), { cat: "currency-placement", token: seeded });
        else { add(withPer(weekly, L, "week")); s.wants = s.wants.filter((w) => w !== "currency-placement"); }
      } else add(withPer(weekly, L, "week"));
      if (!s.wants.includes("trial")) add(`${trialN} ${dw} ${tw}, ${withPer(annual, L, "year")}`);
      if (rand() < 0.4) add(`${v(s.r.higher)} ${withPer(annual, L, "year")}`); // a crossed-out "was" price
    } else {
      add(`${lab[0]} ${v(s.r.num)}`);
      const bal = v(s.r.balance);
      amountLines.push(bal);
      if (s.wants.includes("currency-placement")) {
        const seeded = flip(bal, s);
        if (seeded) add(`${lab[7]} ${seeded}`, { cat: "currency-placement", token: seeded });
        else { add(`${lab[7]} ${bal}`); s.wants = s.wants.filter((w) => w !== "currency-placement"); }
      } else add(`${lab[7]} ${bal}`);
    }
    if (s.wants.includes("number")) { const t = v(s.seedReq.number); add(`${lab[4]} ${t}`, { cat: "number", token: t }); }
    if (s.wants.includes("date")) { const t = v(s.seedReq.date); add(`${lab[1]} ${t}`, { cat: "date", token: t }); }
    else add(`${lab[1]} ${v(s.r.date)}`);
    if (s.wants.includes("time")) { const t = v(s.seedReq.time); add(`${lab[2]} ${t}`, { cat: "time", token: t }); }
    else add(`${lab[2]} ${v(s.r.time)}`);
    for (const c of ["currency", "mixed-currency"]) {
      // A mixed screen needs its home-currency amount read too (D34): the seed carries it.
      if (s.wants.includes(c)) { const t = v(s.seedReq[c]); add(`${lab[0]} ${t}`, { cat: c, token: t, home: c === "mixed-currency" ? amountLines[0] : null }); }
    }
    // Negatives: versions, ranges, percentages, scores, ambiguous groups, phone-like groups, `$` outside a price.
    const neg = [`${lab[6]} 2.${int(10, 30)}.${int(1, 9)}`, `${lab[5]} ${int(1, 5)}-${int(6, 9)}`, `${int(10, 90)} %`,
      `${lab[4]} ${int(10, 23)}:${String(int(10, 59))}`, `${lab[4]} ${v(s.r.ambiguous)}`, `+1 555 ${int(100, 999)} ${int(1000, 9999)}`, "$$$ VIP"];
    for (let n = int(2, 3); n > 0; n--) add(neg.splice(int(0, neg.length - 1), 1)[0]);
  }
}

/** currency-placement seed: the same amount with the symbol on the other side, unless the storefront writes it so (D41). */
function flip(correct, s) {
  const m = correct.match(/^(\D*?)\s?([\d.,' ]*\d)\s?(\D*)$/);
  if (!m) return null;
  const [, pre, num, post] = m;
  const sym = (pre || post).trim();
  if (!sym || /\d/.test(sym)) return null;
  const seeded = pre.trim() ? `${num} ${sym}` : `${sym}${num}`;
  if (s.r.storeShape) {
    const st = v(s.r.storeShape);
    const stBefore = st.trim().indexOf(sym) === 0, seedBefore = seeded.indexOf(sym) === 0;
    const stSpaced = stBefore ? st.slice(sym.length).startsWith(" ") : / \D+$/.test(st);
    const seedSpaced = seedBefore ? seeded.slice(sym.length).startsWith(" ") : / \D+$/.test(seeded);
    if (stBefore === seedBefore && stSpaced === seedSpaced) return null;
  }
  return seeded;
}

// MARK: Run and score

function findingCategory(f) {
  if (f.kind === "format") return f.rule;
  if (f.kind === "currency") return f.rule === "mixed" ? "mixed-currency" : "currency";
  if (f.kind === "price") return f.field;
  return null;
}
const ruleOf = (c) => (["amount", "period", "trial"].includes(c) ? "price" : c);

function eligible(seed, lines) {
  const ls = lines.map((l) => fold(l).toLowerCase());
  const t = fold(seed.token).toLowerCase();
  if (seed.cat === "trial") {
    return ls.some((l) => l.includes(fold(seed.amount).toLowerCase()) && l.includes(String(seed.n)) && l.includes(seed.dw) && l.includes(seed.tw.split(" ")[0]));
  }
  if (seed.cat === "period") return ls.some((l) => l.includes(t) && l.includes(fold(seed.word).toLowerCase()));
  if (seed.cat === "mixed-currency") return ls.some((l) => l.includes(t)) && ls.some((l) => l.includes(fold(seed.home).toLowerCase()));
  return ls.some((l) => l.includes(t));
}

/** One CLI run; an image Vision timed out on (a loaded shared host) is read again alone, up to twice. */
function runCli(a) {
  const env = { ...process.env, CATSCAN_VISION_TIMEOUT: process.env.CATSCAN_VISION_TIMEOUT || "180" };
  const r = spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", maxBuffer: 1 << 30, env });
  if (r.status !== 0 && r.status !== 1 && r.status !== 4) throw new Error(`catscan ${a.slice(0, 2).join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((x) => JSON.parse(x)).map((e) => {
    for (let tries = 0; e.verdict === "error" && tries < 2; tries++) {
      const one = spawnSync(process.execPath, [CLI, a[0], e.path, ...a.slice(2)], { encoding: "utf8", maxBuffer: 1 << 30, env });
      e = JSON.parse(one.stdout.split("\n").filter(Boolean)[0]);
    }
    if (e.verdict === "error") throw new Error(`${e.path}: ${e.error?.code}`);
    return e;
  });
}

/**
 * D34: findings matched one-to-one to a screen's seeds by category and token. Returns the seeds with `eligible` and
 * `hit`, and the findings no seed explains (false flags).
 */
function matchScreen(seeds, findings, lines) {
  const open = seeds.map((sd) => ({ ...sd, eligible: eligible(sd, lines), hit: false }));
  const unmatched = [];
  const digits = (x) => fold(x).replace(/[^0-9.,]/g, "");
  for (const f of findings) {
    const c = findingCategory(f);
    if (!c) continue;
    const tok = fold(f.token || "").toLowerCase();
    // A currency finding whose symbol Vision misread (`₺` as `₽`) still matches its seed by the amount on the
    // seeded line, since the screen does show a wrong currency there.
    const m = open.find((sd) => !sd.hit && sd.cat === c && (fold(sd.token).toLowerCase() === tok || (c !== "trial" && tok.includes(fold(sd.token).toLowerCase()))))
      || (c === "currency" || c === "mixed-currency" ? open.find((sd) => !sd.hit && sd.cat === c && digits(f.token) && digits(sd.token) === digits(f.token)) : null);
    if (m) m.hit = true;
    else unmatched.push({ c, f });
  }
  return { open, unmatched };
}

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-formats-bench-"));
  const valuesBin = path.join(work, "values"), gen = path.join(work, "synth");
  execFileSync("swiftc", ["-O", path.join(__dirname, "formats/values.swift"), "-o", valuesBin]);
  execFileSync("swiftc", ["-O", path.join(ROOT, "test/fixtures/generate.swift"), "-o", gen]);
  const screens = plan();
  build(screens, valuesBin);
  // Draw and run per locale and storefront.
  const groups = new Map();
  for (const s of screens) {
    const g = `${s.locale}/${s.storefront || "none"}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const shots = [];
  for (const [g, list] of groups) {
    fs.mkdirSync(path.join(work, "shots", g), { recursive: true });
    for (const s of list) {
      shots.push({ name: `${g}/${s.name}`, locale: s.locale, width: 1000, height: 140 + s.lines.length * 110, lines: s.lines.map((t, i) => ({ text: t, x: 60, y: 60 + i * 110, size: 44 })) });
    }
  }
  fs.writeFileSync(path.join(work, "shots.json"), JSON.stringify(shots));
  execFileSync(gen, [path.join(work, "shots.json"), path.join(work, "shots")], { stdio: "ignore" });
  for (const [sf, cur] of Object.entries(STOREFRONTS)) {
    fs.writeFileSync(path.join(work, `prices-${sf}.json`), JSON.stringify(PRODUCTS[cur].map((p, i) => ({
      product: ["annual", "monthly", "weekly"][i], price: p[0], currency: cur, period: ["P1Y", "P1M", "P1W"][i], trial: p[1] || null }))));
  }
  const byPath = new Map();
  const t0 = Date.now();
  for (const [g] of groups) {
    const [loc, sf] = g.split("/");
    const a = ["formats", path.join(work, "shots", g), "--locale", loc, "--rules", RULES.join(","), "--json"];
    if (sf !== "none") a.push("--storefront", sf, "--prices", path.join(work, `prices-${sf}.json`));
    for (const e of runCli(a)) byPath.set(path.relative(path.join(work, "shots"), e.path), e);
  }
  const ms = Date.now() - t0;
  // Read lines for eligibility.
  const reads = new Map();
  for (const [g] of groups) {
    for (const e of runCli(["read", path.join(work, "shots", g), "--locale", g.split("/")[0], "--json"])) reads.set(path.relative(path.join(work, "shots"), e.path), (e.lines || []).map((l) => l.text));
  }
  const stat = Object.fromEntries(CATEGORIES.map((c) => [c, { seeds: 0, eligible: 0, found: 0, foundEligible: 0, flags: 0, falseFlags: 0 }]));
  const falses = [], misses = [];
  for (const s of screens) {
    const key = `${s.locale}/${s.storefront || "none"}/${s.name}`;
    const env = byPath.get(key);
    if (!env || env.verdict === "error") throw new Error(`no result for ${key}`);
    const lines = reads.get(key) || [];
    const { open, unmatched } = matchScreen(s.seeds, env.findings, lines);
    for (const sd of open) {
      stat[sd.cat].seeds++;
      if (sd.eligible) stat[sd.cat].eligible++;
      if (sd.hit) { stat[sd.cat].found++; if (sd.eligible) stat[sd.cat].foundEligible++; }
    }
    for (const f of env.findings) { const c = findingCategory(f); if (c) stat[c].flags++; }
    for (const { c, f } of unmatched) { stat[c].falseFlags++; falses.push({ screen: key, category: c, token: f.token, line: f.line, expected: f.expected ?? null }); }
    for (const sd of open) if (!sd.hit && sd.eligible) misses.push({ screen: key, category: sd.cat, token: sd.token, line: sd.line, read: lines.find((l) => fold(l).toLowerCase().includes(fold(sd.token).toLowerCase().slice(0, 4))) ?? null });
  }
  const per = {};
  let pass = true;
  const rules = {};
  for (const c of CATEGORIES) {
    const x = stat[c], tp = x.flags - x.falseFlags;
    per[c] = {
      seeds: x.seeds, eligible: x.eligible, eligible_share: ratio(x.eligible, x.seeds), flags: x.flags, false_flags: x.falseFlags,
      precision: ratio(tp, x.flags), precision_ci: wilson(tp, x.flags),
      recall_eligible: ratio(x.foundEligible, x.eligible), recall_eligible_ci: wilson(x.foundEligible, x.eligible),
      recall_all: ratio(x.found, x.seeds),
    };
    const r = ruleOf(c);
    rules[r] = rules[r] || { seeds: 0, eligible: 0, flags: 0, falseFlags: 0, foundEligible: 0, found: 0 };
    for (const k of ["seeds", "eligible", "flags", "falseFlags", "foundEligible", "found"]) rules[r][k] += x[k];
  }
  const gate = {};
  for (const [r, x] of Object.entries(rules)) {
    const tp = x.flags - x.falseFlags;
    const p = ratio(tp, x.flags), rc = ratio(x.foundEligible, x.eligible);
    const ok = x.eligible >= QUOTA * 0.5 && (p === null || p >= GATE.precision) && rc !== null && rc >= GATE.recall;
    if (!ok) pass = false;
    gate[r] = { precision: p, precision_ci: wilson(tp, x.flags), recall_eligible: rc, recall_eligible_ci: wilson(x.foundEligible, x.eligible), recall_all: ratio(x.found, x.seeds), eligible: x.eligible, seeds: x.seeds, flags: x.flags, false_flags: x.falseFlags, pass: ok };
  }
  const info = versionInfo();
  const fp = execFileSync(valuesBin, { input: JSON.stringify([{ t: "fingerprint", l: LOCALES }]) }).toString();
  const result = {
    check: "formats", todo: "TODO-036 T3", gate: { precision: GATE.precision, recall: GATE.recall, per: "rule (price = amount + period + trial)" }, pass,
    set: { locales: LOCALES, screens: screens.length, per_locale: SCREENS, storefronts: Object.keys(STOREFRONTS), seed: 36003, generator: "test/fixtures/generate.swift", values: "bench/formats/values.swift" },
    rules: gate, categories: per,
    ms_per_image: Math.round(ms / screens.length),
    false_flags: falses.slice(0, 40), misses: misses.slice(0, 40),
    tools: {
      catscan: info.catscan, macos: `${info.macos} (${info.macos_build})`, vision_revision: info.vision_revision, node: process.version,
      icu: process.versions.icu, node_cldr: process.versions.cldr, tables_cldr_json: WORDS.cldr,
      foundation_fingerprint: crypto.createHash("sha256").update(JSON.parse(fp)[0]).digest("hex"),
    },
  };
  process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  if (!process.env.BENCH_KEEP) fs.rmSync(work, { recursive: true, force: true });
  else process.stderr.write(`kept ${work}\n`);
  process.exitCode = pass ? 0 : 1;
}

if (require.main === module) main();
module.exports = { plan, flip, eligible, matchScreen, findingCategory, fold, CATEGORIES, QUOTA, SCREENS, LOCALES };
