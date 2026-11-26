#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-074 synthetic DOM set: phone screens (390x844 CSS px, deviceScaleFactor 3) with buttons, tab bar items,
// segmented control segments, nav titles, chips (some with a subtitle line inside), subtitles and paragraphs, in 14
// locales, each screen also rendered in `en` with the same layout and the same element ids. Element widths come from the
// target text (fixed seed): fits one row, wraps, or leaves the last word alone; subtitles and paragraphs wrap by design.
// Truth per element comes from the DOM: rows from each grapheme's Range client rect grouped by top, row widths, and the
// last row's word count from Intl.Segmenter (ICU, independent of NLTokenizer).
// Output: <out>/<dev|held>/<locale>/<locale>-NN.png + .boxes.json (page script `collect` -> `catscan boxes playwright`),
// the en twin at <out>/<set>/en/<locale>-NN.png, and <out>/truth.json.
// Usage: node bench/wrapping/generate.mjs [<out>] [--locales de,ja] [--screens N]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const { collect } = require("../../packages/core-js/src/boxes/playwright-page");
const boxes = require("../../packages/core-js/src/boxes");
const { chromiumArgs } = require("../../packages/playwright/test/chromium-gpu.js");
const { rng } = require("../overlap/elements-lib");
const S = require("../untranslated/strings.json");

export const SEED = 74;
export const SCREENS = 24; // per locale; even numbers dev, odd held out
export const VIEW = { width: 390, height: 844 };
export const DPR = 3;
// th and ar are not in bench/untranslated/strings.json; written for this bench, same keys (placeholder keys omitted).
const EXTRA = {
  th: { "tab.home": "หน้าแรก", "tab.settings": "การตั้งค่า", "menu.settings": "ตัวเลือก", "settings.privacy": "ความเป็นส่วนตัว", "settings.notifications": "การแจ้งเตือน", "settings.language": "ภาษา", "account.sign_in": "เข้าสู่ระบบ", "account.sign_out": "ออกจากระบบ", "account.delete": "ลบบัญชี", "paywall.title": "ปลดล็อกฟีเจอร์ทั้งหมด", "paywall.restore": "กู้คืนการซื้อ", "paywall.premium": "พรีเมียม", "cart.title": "รถเข็นสินค้า", "cart.checkout": "ดำเนินการชำระเงินต่อ", "profile.edit": "แก้ไขโปรไฟล์", "search.hint": "ค้นหาสินค้า", "error.network": "ไม่มีการเชื่อมต่ออินเทอร์เน็ต", "common.cancel": "ยกเลิก", "common.save": "บันทึกการเปลี่ยนแปลง", "common.ok": "ตกลง", "common.online": "ออนไลน์", "wifi.title": "Wi-Fi", "download.button": "ดาวน์โหลด", "download.start": "เริ่มดาวน์โหลด", "help.center": "ศูนย์ช่วยเหลือ", "brand.name": "Catscan Pro" },
  ar: { "tab.home": "الرئيسية", "tab.settings": "الإعدادات", "menu.settings": "الخيارات", "settings.privacy": "الخصوصية", "settings.notifications": "الإشعارات", "settings.language": "اللغة", "account.sign_in": "تسجيل الدخول", "account.sign_out": "تسجيل الخروج", "account.delete": "حذف الحساب", "paywall.title": "افتح جميع الميزات", "paywall.restore": "استعادة المشتريات", "paywall.premium": "بريميوم", "cart.title": "سلة التسوق", "cart.checkout": "متابعة إلى الدفع", "profile.edit": "تعديل الملف الشخصي", "search.hint": "ابحث عن المنتجات", "error.network": "لا يوجد اتصال بالإنترنت", "common.cancel": "إلغاء", "common.save": "حفظ التغييرات", "common.ok": "موافق", "common.online": "متصل", "wifi.title": "Wi-Fi", "download.button": "تنزيل", "download.start": "بدء التنزيل", "help.center": "مركز المساعدة", "brand.name": "Catscan Pro" },
};
export const LOCALES = [...Object.keys(S.locales).filter((l) => l !== "en"), "th", "ar"];
const UNSPACED = new Set(["ja", "zh-Hans", "th"]);
const KEYS = S.keys.filter((k, i) => !/[{%]/.test(S.locales.en[i]));
const str = (locale, key) => (EXTRA[locale] ? EXTRA[locale][key] : S.locales[locale][S.keys.indexOf(key)]);
const joiner = (locale, kind) => (UNSPACED.has(locale) ? (kind === "sentence" ? (locale === "th" ? " " : "。") : (locale === "th" ? "" : "、")) : kind === "sentence" ? ". " : " ");
const oneWord = (locale, s) => [...new Intl.Segmenter(locale, { granularity: "word" }).segment(s)].filter((x) => x.isWordLike).length === 1;

/** The plan of one screen: elements with kind, keys, a width mode and a random fraction (no measurement yet). */
function screenPlan(rand, locale, n) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const label = (orphan) => {
    // Half the labels join two strings; an orphan attempt ends on a one-word string.
    // An orphan attempt starts on the longest of three strings, so its first row is wide.
    const a = orphan ? [pick(KEYS), pick(KEYS), pick(KEYS)].sort((x, y) => [...str(locale, y)].length - [...str(locale, x)].length)[0] : pick(KEYS);
    if (!orphan && rand() < 0.5) return [a];
    const ends = KEYS.filter((k) => k !== a && oneWord(locale, str(locale, k)) && oneWord("en", str("en", k)));
    return [a, pick(ends)];
  };
  const mode = () => { const r = rand(); return r < 0.3 ? "fit" : r < 0.65 ? "wrap" : "orphan"; };
  const els = [];
  const add = (o) => { const m = o.mode ?? mode(); els.push({ ...o, mode: m, keys: o.keys ?? label(m === "orphan"), r: rand(), slack: 1 + Math.floor(rand() * 4), tail: 1 + Math.floor(rand() * 2), enfit: rand() < 0.8 }); };
  add({ id: "nav-title", kind: "nav", size: rand() < 0.5 ? 17 : 28 });
  if (rand() < 0.7) for (let i = 0; i < 2 + Math.floor(rand() * 2); i++) add({ id: `seg-${i}`, kind: "segment" });
  for (let i = 0; i < 3; i++) add({ id: `btn-${i}`, kind: "button", size: pick([15, 16, 17]) });
  for (let i = 0; i < 3; i++) {
    if (rand() < 0.3) {
      add({ id: `chip-${i}`, kind: "chip-title", sub: `chip-${i}-sub` });
      els.push({ id: `chip-${i}-sub`, kind: "chip-sub", keys: [pick(KEYS)], mode: "free", r: rand() });
    } else add({ id: `chip-${i}`, kind: "chip" });
  }
  // Subtitles and paragraphs: long in en (5+ words), wrapping by design.
  const long = (min) => { const ks = []; while (ks.length < 2 || ks.map((k) => str("en", k)).join(" ").split(/\s+/).length < min) ks.push(pick(KEYS)); return ks; };
  add({ id: "subtitle", kind: "subtitle", keys: long(5), mode: "wrap" });
  add({ id: "paragraph", kind: "paragraph", keys: long(16), mode: "free" });
  const tabs = 3 + Math.floor(rand() * 3);
  const icons = rand() < 0.5;
  for (let i = 0; i < tabs; i++) els.push({ id: `tab-${i}`, kind: "tab", keys: label(false), mode: "bar", icons, r: rand() });
  return { name: `${locale}-${String(n).padStart(2, "0")}`, locale, dev: n % 2 === 0, set: n % 2 === 0 ? "dev" : "held", tabs, icons, els };
}

export function plan(locales = LOCALES, screens = SCREENS, seed = SEED) {
  const rand = rng(seed);
  const out = [];
  for (const locale of locales) for (let n = 0; n < screens; n++) out.push(screenPlan(rand, locale, n));
  return out;
}

const SINGLE = new Set(["nav", "segment", "button", "chip", "tab"]); // single-line by design
const CONTROL_ONLY = new Set(["segment", "button", "chip", "tab"]); // a control's only label

/** In the page: builds the screen; `widths` null measures the target text and returns the widths it chose. */
function build({ screen, locale, texts, enTexts, widths, rtl }) {
  document.documentElement.lang = locale;
  document.documentElement.dir = rtl ? "rtl" : "ltr";
  document.body.innerHTML = "";
  const FONT = { nav: 17, segment: 13, button: 16, chip: 14, "chip-title": 14, "chip-sub": 12, subtitle: 14, paragraph: 15, tab: 11 };
  const PAD = { nav: 0, segment: 8, button: 14, chip: 12, "chip-title": 12, "chip-sub": 0, subtitle: 0, paragraph: 0, tab: 2 };
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;white-space:nowrap;font-family:system-ui";
  document.body.appendChild(probe);
  const font = (e) => `${e.kind === "nav" && e.size === 28 ? 700 : e.kind === "nav" || e.kind === "button" ? 600 : 400} ${e.size ?? FONT[e.kind]}px system-ui`;
  const measure = (e, t, ws = "nowrap") => { probe.style.font = font(e); probe.style.whiteSpace = ws; probe.style.width = ws === "nowrap" ? "auto" : "min-content"; probe.textContent = t; return probe.getBoundingClientRect().width; };
  const chosen = {};
  if (!widths) {
    widths = {};
    for (const e of screen.els) {
      if (e.mode === "bar" || e.kind === "chip-sub") continue;
      const t = texts[e.id];
      const full = measure(e, t), enFull = measure(e, enTexts[e.id]), minc = Math.max(measure(e, t, "normal"), measure(e, enTexts[e.id], "normal"));
      let w;
      // Most labels are sized so en fits one row (the design's base); the rest wrap in en too (a design wrap).
      if (e.mode === "fit") w = Math.max(full, enFull) * (1.02 + 0.2 * e.r) + 2;
      else if (e.mode === "wrap") w = Math.max(full * (0.35 + 0.55 * e.r), e.enfit ? enFull + 2 : 0);
      else if (e.mode === "free") w = 200 + 158 * e.r;
      else {
        // orphan: the row holds all but the last word (or the last 1-2 characters in ja/zh).
        let cut;
        if (/^(ja|zh)/.test(locale)) cut = [...new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(t)].slice(-e.tail)[0].index;
        else cut = [...new Intl.Segmenter(locale, { granularity: "word" }).segment(t)].filter((s) => s.isWordLike).pop().index;
        w = measure(e, t.slice(0, cut).trimEnd()) + e.slack;
      }
      w = Math.min(Math.max(w, minc + 1), 358 - 2 * PAD[e.kind]);
      widths[e.id] = Math.round(w * 4) / 4 + 2 * PAD[e.kind];
    }
    Object.assign(chosen, widths);
  }
  probe.remove();
  const css = document.createElement("style");
  css.textContent = `*{box-sizing:border-box;margin:0}body{width:390px;height:844px;overflow:hidden;font-family:system-ui;background:#fff;color:#111;position:relative}
    .stack{position:absolute;top:54px;left:16px;right:16px;display:flex;flex-direction:column;gap:14px}
    .row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start}
    h1{font-weight:600}
    button{font-family:system-ui;border:0;text-align:center;color:inherit;background:none}
    .seg{display:flex;gap:2px;background:#e8e8ed;border-radius:9px;padding:2px;align-items:stretch;align-self:flex-start}
    .seg button{background:#fff;border-radius:7px;padding:5px 8px;font-size:13px}
    .btn{background:#1f6feb;color:#fff;border-radius:12px;padding:9px 14px;font-weight:600}
    .chip{background:#eef1f6;border-radius:16px;padding:6px 12px;font-size:14px}
    .chip span{display:block}.chip .sub{font-size:12px;color:#555;margin-top:2px}
    .subtitle{font-size:14px;color:#444}.paragraph{font-size:15px;line-height:1.35}
    .bar{position:absolute;left:0;right:0;bottom:0;display:flex;background:#f6f6f8;border-top:1px solid #ddd;padding:6px 0 22px}
    .bar button{flex:1 1 0;min-width:0;padding:0 2px;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:2px}
    .bar svg{width:22px;height:22px;flex:none}`;
  document.head.innerHTML = "";
  document.head.appendChild(css);
  const stack = document.createElement("div");
  stack.className = "stack";
  document.body.appendChild(stack);
  const mk = (tag, cls, id, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (id) n.id = id; if (text !== undefined) n.textContent = text; return n; };
  const W = (n, e) => { n.style.width = `${widths[e.id]}px`; n.style.font = font(e); };
  const by = (k) => screen.els.filter((e) => e.kind === k || (k === "chip" && e.kind === "chip-title"));
  const nav = by("nav")[0];
  const h = mk("h1", null, nav.id, texts[nav.id]);
  W(h, nav);
  if (nav.size === 17) h.style.alignSelf = "center", h.style.textAlign = "center";
  stack.appendChild(h);
  const segs = by("segment");
  if (segs.length) {
    const seg = mk("div", "seg");
    seg.setAttribute("role", "tablist");
    for (const e of segs) { const b = mk("button", null, e.id, texts[e.id]); b.setAttribute("role", "tab"); W(b, e); seg.appendChild(b); }
    stack.appendChild(seg);
  }
  const row1 = mk("div", "row");
  for (const e of by("button")) { const b = mk("button", "btn", e.id, texts[e.id]); W(b, e); row1.appendChild(b); }
  stack.appendChild(row1);
  const row2 = mk("div", "row");
  for (const e of by("chip")) {
    if (e.kind === "chip") { const b = mk("button", "chip", e.id, texts[e.id]); W(b, e); row2.appendChild(b); continue; }
    const b = mk("button", "chip", `${e.id}-btn`);
    const t = mk("span", null, e.id, texts[e.id]);
    b.style.width = `${widths[e.id]}px`;
    t.style.font = font(e);
    b.appendChild(t);
    b.appendChild(mk("span", "sub", e.sub, texts[e.sub]));
    row2.appendChild(b);
  }
  stack.appendChild(row2);
  for (const k of ["subtitle", "paragraph"]) {
    const e = by(k)[0];
    if (!e) continue;
    const p = mk("p", k, e.id, texts[e.id]);
    W(p, e);
    stack.appendChild(p);
  }
  const bar = mk("div", "bar");
  for (const e of by("tab")) {
    if (screen.icons) {
      const b = mk("button", null, `${e.id}-btn`);
      b.setAttribute("role", "tab");
      b.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#8a8a8e"/></svg>`;
      b.appendChild(mk("span", null, e.id, texts[e.id]));
      bar.appendChild(b);
    } else { const b = mk("button", null, e.id, texts[e.id]); b.setAttribute("role", "tab"); bar.appendChild(b); }
  }
  document.body.appendChild(bar);
  // Elements below the tab bar's top or past the screen edge are dropped from the plan (both renders).
  const barTop = bar.getBoundingClientRect().top;
  const out = [];
  for (const e of screen.els) {
    const n = document.getElementById(e.id);
    if (!n) continue;
    const r = n.getBoundingClientRect();
    const t = [...n.childNodes].find((c) => c.nodeType === 3);
    const range = document.createRange();
    if (t) range.selectNodeContents(t);
    const ink = t ? range.getBoundingClientRect() : r;
    if ((e.kind !== "tab" && ink.bottom > barTop - 4) || ink.left < 2 || ink.right > 388 || ink.bottom > 842) out.push(e.id);
  }
  return { widths: chosen, overflow: out };
}

/** In the page: the DOM truth of one element's own text: rows (graphemes grouped by top), widths, last row. */
function truth({ ids, locale }) {
  const seg = new Intl.Segmenter(locale, { granularity: "grapheme" });
  const words = new Intl.Segmenter(locale, { granularity: "word" });
  const res = {};
  for (const id of ids) {
    const n = document.getElementById(id);
    const t = n && [...n.childNodes].find((c) => c.nodeType === 3);
    if (!t) continue;
    const s = t.textContent;
    const g = [];
    for (const x of seg.segment(s)) {
      if (!x.segment.trim()) continue;
      const r = document.createRange();
      r.setStart(t, x.index);
      r.setEnd(t, x.index + x.segment.length);
      const rect = [...r.getClientRects()].find((q) => q.width > 0 || q.height > 0);
      if (rect) g.push({ i: x.index, end: x.index + x.segment.length, top: rect.top, h: rect.height, left: rect.left, right: rect.right });
    }
    const rows = [];
    for (const q of [...g].sort((a, b) => a.top - b.top)) {
      const row = rows.find((w) => Math.abs(w.top - q.top) < Math.min(w.h, q.h) / 2);
      if (row) { row.items.push(q); row.left = Math.min(row.left, q.left); row.right = Math.max(row.right, q.right); }
      else rows.push({ top: q.top, h: q.h, left: q.left, right: q.right, items: [q] });
    }
    rows.sort((a, b) => a.top - b.top);
    const text = (w) => s.slice(Math.min(...w.items.map((q) => q.i)), Math.max(...w.items.map((q) => q.end))).trim();
    const last = rows[rows.length - 1];
    const lastText = last ? text(last) : "";
    res[id] = {
      text: s, rows: rows.length, row_texts: rows.map(text), row_widths: rows.map((w) => Math.round((w.right - w.left) * 100) / 100),
      last_words: [...words.segment(lastText)].filter((x) => x.isWordLike).length,
    };
  }
  return res;
}

const textsOf = (screen, locale) => {
  const out = {};
  for (const e of screen.els) {
    const parts = e.keys.map((k) => str(locale, k));
    out[e.id] = e.kind === "paragraph" ? parts.join(joiner(locale, "sentence")) + (UNSPACED.has(locale) && locale !== "th" ? "。" : locale === "th" ? "" : ".")
      : e.kind === "subtitle" ? parts.join(UNSPACED.has(locale) ? joiner(locale, "list") : ", ") : parts.join(joiner(locale, "label"));
  }
  return out;
};

async function webglRenderer(page) {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const x = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return gl ? (x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null;
  });
}

export async function generate(out, screens) {
  const browser = await chromium.launch({ args: chromiumArgs() });
  const tools = { playwright: require("@playwright/test/package.json").version, chromium: browser.version(), chromium_args: chromiumArgs(), device_scale_factor: DPR, viewport: VIEW };
  const truthOut = [];
  try {
    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR });
    const page = await ctx.newPage();
    await page.setContent("<html><body></body></html>");
    tools.webgl_renderer = await webglRenderer(page);
    for (const sc of screens) {
      const tt = textsOf(sc, sc.locale), et = textsOf(sc, "en");
      const rtl = sc.locale === "ar";
      let screen = sc, widths, dropped = [];
      for (let k = 0; k < 4; k++) {
        const a = await page.evaluate(build, { screen, locale: sc.locale, texts: tt, enTexts: et, widths: null, rtl });
        widths = a.widths;
        const b = await page.evaluate(build, { screen, locale: "en", texts: et, enTexts: et, widths, rtl: false });
        const over = new Set([...a.overflow, ...b.overflow]);
        if (!over.size) break;
        dropped.push(...over);
        screen = { ...screen, els: screen.els.filter((e) => !over.has(e.id) && !(e.sub && over.has(e.sub)) && !screen.els.some((p) => p.sub === e.id && over.has(p.id))) };
      }
      const ids = screen.els.map((e) => e.id);
      const shots = {};
      for (const [loc, texts, r] of [[sc.locale, tt, rtl], ["en", et, false]]) {
        const o = await page.evaluate(build, { screen, locale: loc, texts, enTexts: et, widths, rtl: r });
        if (o.overflow.length) throw new Error(`${sc.name} ${loc}: still overflows ${o.overflow}`);
        const png = path.join(out, sc.set, loc, `${sc.name}.png`);
        fs.mkdirSync(path.dirname(png), { recursive: true });
        await page.screenshot({ path: png });
        const dump = await page.evaluate(collect);
        const pw = png.replace(/\.png$/, ".pw.json");
        fs.writeFileSync(pw, JSON.stringify(dump));
        const { boxes: bx } = boxes.convert("playwright", pw, png);
        fs.rmSync(pw);
        fs.writeFileSync(png.replace(/\.png$/, ".boxes.json"), JSON.stringify(bx));
        shots[loc] = await page.evaluate(truth, { ids, locale: loc });
      }
      truthOut.push({
        name: sc.name, set: sc.set, dev: sc.dev, locale: sc.locale, dropped,
        elements: screen.els.map((e) => ({
          id: e.id, kind: e.kind, mode: e.mode, single: SINGLE.has(e.kind), control_only: CONTROL_ONLY.has(e.kind), width: widths[e.id] ?? null,
          target: shots[sc.locale][e.id] ?? null, en: shots.en[e.id] ?? null,
        })),
      });
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
  return { seed: SEED, tools, locales: [...new Set(screens.map((s) => s.locale))], screens: truthOut };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const out = path.resolve(argv[0] && !argv[0].startsWith("--") ? argv[0] : path.join(path.dirname(fileURLToPath(import.meta.url)), "out"));
  const locales = opt("--locales") ? opt("--locales").split(",") : LOCALES;
  const all = plan(LOCALES, SCREENS);
  const n = opt("--screens") ? Number(opt("--screens")) : SCREENS;
  // A subset keeps the full plan's random stream, so its screens equal the full run's.
  const screens = all.filter((s) => locales.includes(s.locale) && Number(s.name.slice(-2)) < n);
  for (const set of ["dev", "held"]) fs.rmSync(path.join(out, set), { recursive: true, force: true });
  const t = await generate(out, screens);
  fs.writeFileSync(path.join(out, "truth.json"), JSON.stringify(t));
  process.stderr.write(`generate: ${t.screens.length} screens x 2 renders in ${out}\n`);
}
