#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T5a gate (check 3, D13): precision and recall of the core's `missing-glyphs` rule on a synthetic set, with
// Wilson 95% intervals and the eligible share (D11). Gate: precision >= 0.95, recall >= 0.70.
// Usage: node bench/glyphs.js > results/glyphs.json   (exit 1 when the gate fails; BENCH_KEEP=1 keeps the images)
// 10 scripts x 40 screens (Latin with diacritics, Cyrillic, Greek, Arabic, Hebrew, Devanagari, Thai, CJK, Korean,
// currency signs) plus 40 wrong-recognition-language control screens, drawn by bench/glyphs/generate.swift. A seeded
// line draws the characters a font lacks as tofu in one of three styles (.notdef, Last Resort, hollow box); every
// other line is a clean control (pure script, mixed script, small, low contrast). Even screens send the expected
// text as element boxes, odd screens as catalog strings (every line text of that locale), so both sources are
// measured with one Vision read per screen. The core runs through `catscan-core serve` (command `glyphs`).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Server, versionInfo } = require("../packages/core-js/src/client");

const ROOT = path.resolve(__dirname, "..");
const SCREENS = Number(process.env.BENCH_SCREENS || 40);
const GATE = { precision: 0.95, recall: 0.70 };
const SEED = 36005;
const LATIN = ["Premium", "Pro", "Wi-Fi", "VIP", "iPhone", "Google Play", "Bluetooth", "Plus"];
// UI phrases per locale. Latin locales: phrases with letters a Latin-1-only or ASCII-only font lacks.
const POOL = {
  de: ["Größe ändern", "Schließen", "Über uns", "Geräte verwalten", "Müll leeren", "Später erinnern", "Grüße aus München", "Bestätigen"],
  pl: ["Zażółć gęślą jaźń", "Usuń zdjęcie", "Połącz z siecią", "Wróć później", "Łączność", "Wyślij wiadomość", "Zmień hasło", "Ustawienia główne"],
  vi: ["Cài đặt tài khoản", "Đăng nhập", "Tiếp tục", "Hủy bỏ", "Lưu thay đổi", "Thông báo mới", "Mở khóa", "Xóa ảnh"],
  tr: ["Ayarları güncelle", "Çıkış yap", "Şifreyi değiştir", "Hesabı sil", "Bildirimleri aç", "Öğren", "Değişiklikleri kaydet", "Ödeme yöntemi"],
  fr: ["Paramètres généraux", "Créer un compte", "Réessayer plus tard", "Où êtes-vous", "Déjà membre", "Accès refusé", "Français", "Hôtel réservé"],
  cs: ["Uložit změny", "Přihlásit se", "Účet uživatele", "Zrušit předplatné", "Nastavení soukromí", "Půjčit", "Ještě jednou", "Žádné zprávy"],
  ru: ["Настройки", "Цена", "Подписка", "Профиль", "Войти", "Сохранить изменения", "Отменить подписку", "Уведомления"],
  uk: ["Налаштування", "Ціна", "Підписка", "Профіль", "Зберегти зміни", "Увійти", "Сповіщення", "Скасувати підписку"],
  el: ["Ρυθμίσεις", "Τιμή", "Συνδρομή", "Προφίλ", "Αποθήκευση αλλαγών", "Ειδοποιήσεις", "Σύνδεση", "Ακύρωση συνδρομής"],
  ar: ["الإعدادات", "السعر", "الاشتراك", "الملف الشخصي", "حفظ التغييرات", "إلغاء الاشتراك", "تسجيل الدخول", "الإشعارات"],
  he: ["הגדרות", "מחיר", "מנוי", "פרופיל", "שמור שינויים", "ביטול מנוי", "התחברות", "התראות"],
  hi: ["सेटिंग्स", "कीमत", "सदस्यता", "प्रोफ़ाइल", "बदलाव सहेजें", "सदस्यता रद्द करें", "लॉग इन करें", "सूचनाएं"],
  th: ["การตั้งค่า", "ราคา", "สมาชิก", "โปรไฟล์", "บันทึก การเปลี่ยนแปลง", "ยกเลิก สมาชิก", "เข้าสู่ระบบ", "การแจ้งเตือน"],
  ja: ["設定", "価格", "サブスクリプション", "プロフィール", "変更を保存", "購読 キャンセル", "ログイン", "通知"],
  "zh-Hans": ["设置", "价格", "订阅", "个人资料", "保存更改", "取消 订阅", "登录", "通知"],
  ko: ["설정", "가격", "구독", "프로필", "변경 사항 저장", "구독 취소", "로그인", "알림"],
};
const CURRENCY = [["Total: ", "₹", "499"], ["Pay ", "₺", "79.99"], ["Price: ", "₽", "299"], ["Save ", "₩", "5,000"], ["Only ", "₫", "99,000"],
  ["", "₪", "39.90 per month"], ["Balance ", "₴", "120"], ["Fee ", "₦", "1,500"], ["From ", "₱", "249"], ["Tip ", "₸", "900"]];
const GROUPS = {
  latin: ["de", "pl", "vi", "tr", "fr", "cs"], cyrillic: ["ru", "uk"], greek: ["el"], arabic: ["ar"], hebrew: ["he"],
  devanagari: ["hi"], thai: ["th"], cjk: ["ja", "zh-Hans"], korean: ["ko"], currency: ["en", "de", "fr", "tr"],
};
// Wrong recognition language (D13): the screen's locale cannot read the text's script, all text clean.
const CONTROL = [["en", "ru"], ["en", "el"], ["en", "ja"], ["en", "ar"], ["zh-Hans", "de"], ["ja", "ru"], ["ru", "el"], ["ko", "de"], ["en", "hi"], ["de", "th"]];
const FONT = { ja: "Hiragino Sans", "zh-Hans": "PingFang SC", ko: "Apple SD Gothic Neo", th: "Thonburi", he: "Arial Hebrew", ar: "Geeza Pro", hi: "Kohinoor Devanagari" };
const RTL = new Set(["ar", "he"]);
const STYLES = ["notdef", "lastresort", "box"];
const NOTDEF_FONTS = ["Helvetica", "Courier", "Zapfino"];

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ratio = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Number(Math.max(0, c - h).toFixed(4)), Number(Math.min(1, c + h).toFixed(4))];
}
const isAsciiOrSpace = (ch) => ch.codePointAt(0) < 0x80;

/** Splits text into runs: chars for which `tofu(ch, i)` is true become `mode` runs, the rest clean. */
function runsOf(text, tofu, mode, font) {
  const out = [];
  [...text].forEach((ch, i) => {
    const m = ch !== " " && tofu(ch, i) ? mode : "clean"; // a space stays a space
    const last = out[out.length - 1];
    if (last && last.mode === m) last.text += ch;
    else out.push({ text: ch, mode: m, ...(m === "notdef" ? { font } : {}) });
  });
  return out;
}

/** The screen plan: lines with runs, seeds (element index, category) and the per-locale catalog. */
function plan() {
  const rand = rng(SEED);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const screens = [];
  const catalogs = {};
  const add = (loc, t) => { (catalogs[loc] ||= new Set()).add(t); };
  const clean = (text) => [{ text, mode: "clean" }];
  let n = 0;
  for (const [group, locales] of Object.entries(GROUPS)) {
    for (let k = 0; k < SCREENS; k++) {
      const locale = locales[k % locales.length];
      const textLoc = group === "currency" ? null : locale;
      const s = { name: `${String(n++).padStart(3, "0")}-${group}-${locale}.png`, group, locale, source: k % 2 ? "catalog" : "boxes", lines: [], seeds: [] };
      const nSeeds = [0, 1, 1, 2, 2][int(0, 4)];
      const seedAt = new Set();
      while (seedAt.size < nSeeds) seedAt.add(int(0, 7));
      for (let i = 0; i < 8; i++) {
        const style = pick(STYLES), nf = pick(NOTDEF_FONTS);
        let text, runs, seed = null;
        if (group === "currency") {
          const [pre, sign, amount] = pick(CURRENCY);
          text = pre + sign + amount;
          if (seedAt.has(i)) { runs = runsOf(text, (ch) => ch === sign, style, nf); seed = { extent: "sign", chars: [sign] }; }
          else runs = clean(text);
        } else if (group === "latin") {
          text = pick(POOL[textLoc]);
          const non = [...text].map((ch, j) => [ch, j]).filter(([ch]) => !isAsciiOrSpace(ch));
          if (seedAt.has(i) && non.length) {
            const extent = pick(["one", "word", "all"]);
            let set;
            if (extent === "one") set = new Set([pick(non)[1]]);
            else if (extent === "all") set = new Set(non.map(([, j]) => j));
            else {
              // Every non-ASCII letter of one word.
              const words = []; let start = 0;
              [...text].forEach((ch, j) => { if (ch === " ") { words.push([start, j]); start = j + 1; } });
              words.push([start, [...text].length]);
              const w = pick(words.filter(([a, b]) => non.some(([, j]) => j >= a && j < b)));
              set = new Set(non.filter(([, j]) => j >= w[0] && j < w[1]).map(([, j]) => j));
            }
            runs = runsOf(text, (ch, j) => set.has(j), style, nf);
            seed = { extent, chars: [...text].filter((ch, j) => set.has(j)) };
          } else runs = clean(text);
        } else {
          // Non-Latin: a seed draws every character of the script part as tofu (the font lacks the script).
          const extent = seedAt.has(i) ? pick(["word", "all", "whole"]) : pick(["mixed", "mixed", "pure"]);
          const phrase = extent === "all" ? pick(POOL[textLoc].filter((p) => p.includes(" "))) : pick(POOL[textLoc].filter((p) => !p.includes(" ")) .concat(extent === "pure" || extent === "mixed" ? POOL[textLoc] : []));
          const latin = pick(LATIN);
          const form = int(0, 2);
          text = extent === "whole" || extent === "pure" ? phrase : form === 0 ? `${latin}: ${phrase}` : form === 1 ? `${phrase} ${latin}` : `${latin} ${phrase}`;
          const lo = text.indexOf(phrase), hi = lo + [...phrase].length;
          if (seedAt.has(i)) {
            runs = runsOf(text, (ch, j) => j >= lo && j < hi, style, nf);
            seed = { extent, chars: [...phrase].filter((ch) => ch !== " ") };
          } else runs = clean(text);
        }
        if (!seed && i === 6) s.lines.push({ runs, size: 18, gray: 0.07, text });
        else if (!seed && i === 7) s.lines.push({ runs, size: 36, gray: 0.62, text });
        else s.lines.push({ runs, size: seed ? int(32, 48) : int(30, 46), gray: 0.07, text });
        if (seed) s.seeds.push({ el: i, style, ...(style === "notdef" ? { notdef_font: nf } : {}), ...seed });
        add(locale, text);
      }
      screens.push(s);
    }
  }
  for (let k = 0; k < SCREENS; k++) {
    const [locale, textLoc] = CONTROL[k % CONTROL.length];
    const s = { name: `${String(n++).padStart(3, "0")}-control-${locale}-${textLoc}.png`, group: "control", locale, source: k % 2 ? "catalog" : "boxes", font: FONT[textLoc], lines: [], seeds: [] };
    for (let i = 0; i < 8; i++) {
      const phrase = pick(POOL[textLoc]);
      const text = i % 2 ? `${pick(LATIN)} ${phrase}` : phrase;
      s.lines.push({ runs: clean(text), size: i === 6 ? 18 : int(30, 46), gray: i === 7 ? 0.62 : 0.07, text });
      add(locale, text);
    }
    screens.push(s);
  }
  return { screens, catalogs: Object.fromEntries(Object.entries(catalogs).map(([k, v]) => [k, [...v].sort()])) };
}

function shotsOf(screens) {
  return screens.map((s) => ({
    name: s.name, font: s.font || FONT[s.locale] || "Helvetica", width: 1000, height: 120 + s.lines.length * 100,
    lines: s.lines.map((l, i) => ({ runs: l.runs, x: 60, y: 60 + i * 100, size: l.size, gray: l.gray, rtl: RTL.has(s.locale) && s.group !== "control" })),
  }));
}

const center = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];
const inside = (p, b) => p[0] >= b[0] && p[0] <= b[0] + b[2] && p[1] >= b[1] && p[1] <= b[1] + b[3];

/** One screen's findings against its seeds: element index of each finding (boxes: its element; catalog: the element
 * holding the finding's center), hits, false flags and duplicates. Eligible: Vision read a line (>= 0.3) there. */
function score(s, elements, env) {
  const lines = (env.lines || []).filter((l) => l.confidence >= 0.3);
  const seeds = s.seeds.map((sd) => ({ ...sd, eligible: lines.some((l) => inside(center(l.box), elements[sd.el].box)), hit: false, charsExact: false }));
  const out = { seeds, falses: [], duplicates: 0 };
  for (const f of env.findings || []) {
    const el = f.element?.id ? Number(f.element.id.slice(1)) : elements.findIndex((e) => inside(center(f.box), e.box));
    const sd = seeds.find((x) => x.el === el);
    if (!sd) { out.falses.push({ screen: s.name, element: el, line: f.line, expected: f.expected, chars: f.chars }); continue; }
    if (sd.hit) { out.duplicates++; continue; }
    sd.hit = true;
    sd.charsExact = (f.chars || []).join("") === sd.chars.join("");
  }
  return out;
}

function tally(rows) {
  const t = { seeds: 0, eligible: 0, found: 0, foundEligible: 0, charsExact: 0 };
  for (const r of rows) {
    t.seeds++;
    if (r.eligible) t.eligible++;
    if (r.hit) { t.found++; if (r.eligible) t.foundEligible++; if (r.charsExact) t.charsExact++; }
  }
  return {
    seeds: t.seeds, eligible: t.eligible, eligible_share: ratio(t.eligible, t.seeds), found: t.found,
    recall_eligible: ratio(t.foundEligible, t.eligible), recall_eligible_ci: wilson(t.foundEligible, t.eligible),
    recall_all: ratio(t.found, t.seeds), chars_exact: ratio(t.charsExact, t.found),
  };
}

function by(rows, f) {
  const g = {};
  for (const r of rows) (g[f(r)] ||= []).push(r);
  return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, tally(v)]));
}

async function main() {
  const { screens, catalogs } = plan();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-glyphs-"));
  const gen = path.join(ROOT, ".build/glyphs-gen");
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  execFileSync("swiftc", ["-O", path.join(__dirname, "glyphs/generate.swift"), "-o", gen], { stdio: "inherit" });
  fs.writeFileSync(path.join(work, "plan.json"), JSON.stringify(shotsOf(screens)));
  const genOut = JSON.parse(execFileSync(gen, [path.join(work, "plan.json"), path.join(work, "shots")]).toString());
  const server = new Server({ jobs: Number(process.env.BENCH_JOBS || 2) });
  await server.ready;
  const t0 = Date.now();
  const rows = [], falses = [], misses = [];
  let duplicates = 0, retries = 0;
  const flags = { boxes: 0, catalog: 0 }, falseBy = { boxes: 0, catalog: 0 };
  const jobs = screens.map(async (s) => {
    const file = path.join(work, "shots", s.name);
    const sidecar = JSON.parse(fs.readFileSync(file.replace(/\.png$/, ".boxes.json"), "utf8"));
    const glyphs = s.source === "boxes" ? { boxes: sidecar, lines: true } : { expected: catalogs[s.locale].map((text) => ({ text })), lines: true };
    let env = await server.request({ command: "glyphs", path: file, locale: s.locale, glyphs });
    // Vision fails now and then on a loaded host (CRImageReaderError, docs/gotchas/vision.md); one retry, counted.
    if (env.verdict === "error" && env.error?.code === "recognition-failed") { retries++; env = await server.request({ command: "glyphs", path: file, locale: s.locale, glyphs }); }
    if (env.verdict === "error" || env.verdict === "unsupported") throw new Error(`${s.name}: ${env.error?.code} ${env.error?.message}`);
    return { s, sidecar, env };
  });
  for (const { s, sidecar, env } of await Promise.all(jobs)) {
    const r = score(s, sidecar.elements, env);
    duplicates += r.duplicates;
    flags[s.source] += r.seeds.filter((x) => x.hit).length + r.falses.length;
    falseBy[s.source] += r.falses.length;
    falses.push(...r.falses);
    for (const sd of r.seeds) {
      rows.push({ ...sd, group: s.group, locale: s.locale, source: s.source });
      if (sd.eligible && !sd.hit) {
        const l = (env.lines || []).filter((x) => inside(center(x.box), sidecar.elements[sd.el].box)).map((x) => x.text);
        misses.push({ screen: s.name, source: s.source, extent: sd.extent, style: sd.style, expected: sidecar.elements[sd.el].text, read: l });
      }
    }
  }
  const ms = Date.now() - t0;
  await server.close();
  const nFlags = flags.boxes + flags.catalog, nFalse = falseBy.boxes + falseBy.catalog;
  const all = tally(rows);
  const precision = ratio(nFlags - nFalse, nFlags);
  const pass = precision !== null && precision >= GATE.precision && all.recall_eligible !== null && all.recall_eligible >= GATE.recall;
  const info = versionInfo();
  const xcode = (() => { try { return execFileSync("xcodebuild", ["-version"]).toString().split("\n")[0]; } catch { return null; } })();
  const swift = execFileSync("swift", ["--version"], { stdio: ["ignore", "pipe", "pipe"] }).toString().split("\n").find((l) => /Swift version/.test(l)) || null;
  const result = {
    check: "missing-glyphs", todo: "TODO-036 T5a", gate: { ...GATE, recall_on: "eligible seeds (Vision read a line of confidence >= 0.3 in the seeded element, D11)" }, pass,
    set: {
      seed: SEED, screens: screens.length, per_group: SCREENS, groups: Object.keys(GROUPS).concat("control"), locales: Object.fromEntries(Object.entries(GROUPS)),
      control: CONTROL.map(([a, b]) => `${a} screen, ${b} text`), styles: STYLES, notdef_fonts: NOTDEF_FONTS,
      generator: "bench/glyphs/generate.swift", sources: "even screens boxes, odd screens catalog (every line text of the locale)",
    },
    precision, precision_ci: wilson(nFlags - nFalse, nFlags), flags: nFlags, false_flags: nFalse, duplicates, vision_retries: retries,
    recall: all,
    by_source: Object.fromEntries(["boxes", "catalog"].map((k) => [k, {
      precision: ratio(flags[k] - falseBy[k], flags[k]), flags: flags[k], false_flags: falseBy[k], ...tally(rows.filter((r) => r.source === k)),
    }])),
    by_group: by(rows, (r) => r.group), by_extent: by(rows, (r) => r.extent), by_style: by(rows, (r) => r.style),
    clean_lines: screens.reduce((a, s) => a + s.lines.length - s.seeds.length, 0),
    ms_per_image: Math.round(ms / screens.length),
    false_flag_list: falses.slice(0, 40), misses: misses.slice(0, 60),
    tools: {
      catscan: info.catscan, macos: `${info.macos} (${info.macos_build})`, vision_revision: info.vision_revision, node: process.version,
      xcode, swift: swift && swift.trim(), fonts: genOut.fonts,
    },
  };
  process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  if (!process.env.BENCH_KEEP) fs.rmSync(work, { recursive: true, force: true });
  else process.stderr.write(`kept ${work}\n`);
  process.exitCode = pass ? 0 : 1;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
module.exports = { plan, runsOf, score, tally };
