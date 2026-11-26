#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-031 audit: how font rendering and OCR quirks break raw-key and untranslated detection.
// Usage: node bench/rawkey-audit.js > results/rawkey-audit.json
// Every case draws raw catalog keys (and, where the case needs them, translated lines, placeholders or decoys) with
// bench/rawkey-audit/render.swift, then reads each screen twice: `catscan read` for what Vision recognized and
// `catscan untranslated --base en.json --catalog <locale>.json` for the verdicts. Labeled by construction: every drawn
// line has a role (key, text, decoy, placeholder), and findings are assigned to drawn lines by box overlap.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { editDistance } = require("../packages/core-js/src/args");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");

// Catalog: [en, de, ja, ar]. Dot keys of a game menu (the owner's `settings.support`), then other key shapes.
const CAT = {
  "tab.settings": ["Settings", "Einstellungen", "設定", "الإعدادات"],
  "tab.home": ["Home", "Start", "ホーム", "الرئيسية"],
  "settings.support": ["Support", "Hilfe", "サポート", "الدعم"],
  "menu.play": ["Play", "Spielen", "プレイ", "العب"],
  "shop.buy": ["Buy", "Kaufen", "購入", "شراء"],
  "level.complete": ["Level complete", "Level geschafft", "レベルクリア", "اكتمل المستوى"],
  "reward.claim": ["Claim reward", "Belohnung abholen", "報酬を受け取る", "استلم المكافأة"],
  "daily.bonus": ["Daily bonus", "Tagesbonus", "デイリーボーナス", "مكافأة يومية"],
  "settings.notifications": ["Notifications", "Mitteilungen", "通知", "الإشعارات"],
  "profile.edit": ["Edit profile", "Profil bearbeiten", "プロフィール編集", "تعديل الملف"],
  "btn_play_now": ["Play now", "Jetzt spielen", "今すぐプレイ", "العب الآن"],
  "menu-settings-title": ["Game settings", "Spieleinstellungen", "ゲーム設定", "إعدادات اللعبة"],
  "screens/home/title": ["Welcome back", "Willkommen zurück", "おかえりなさい", "مرحبا بعودتك"],
  "ui:shop:title": ["Item shop", "Artikelladen", "アイテムショップ", "متجر العناصر"],
  "settingsSupportTitle": ["Support center", "Hilfecenter", "サポートセンター", "مركز الدعم"],
  "level_2.title": ["Level two", "Stufe zwei", "レベル2", "المستوى الثاني"],
  "world3.stage12.name": ["Stage twelve", "Etappe zwölf", "ステージ12", "المرحلة الثانية عشرة"],
  "onboarding.permissions.notifications.description_long": ["Allow notifications to get daily rewards", "Erlaube Mitteilungen für tägliche Belohnungen", "通知を許可して毎日の報酬を受け取る", "اسمح بالإشعارات للحصول على مكافآت يومية"],
  "game.over": ["Game over", "Spiel vorbei", "ゲームオーバー", "انتهت اللعبة"],
  "chat.welcome": ["Hi {player_name}, welcome", "Hallo {player_name}, willkommen", "{player_name}さん、ようこそ", "مرحبا {player_name}"],
  "contact.support.label": ["Contact support", "Support kontaktieren", "サポートに連絡", "اتصل بالدعم"],
  "contact.email": ["contact.support@example.com", "contact.support@example.com", "contact.support@example.com", "contact.support@example.com"],
  "match.won": ["%1$s won %2$d coins", "%1$s hat %2$d Münzen gewonnen", "%1$sが%2$dコインを獲得", "%1$s ربح %2$d عملة"],
};
const LOC = { en: 0, de: 1, ja: 2, ar: 3 };
const DOT = ["settings.support", "menu.play", "shop.buy", "level.complete", "reward.claim", "daily.bonus", "settings.notifications", "profile.edit"];
const SHAPES = {
  underscore: ["btn_play_now"], hyphen: ["menu-settings-title"], slash: ["screens/home/title"], colon: ["ui:shop:title"],
  camelCase: ["settingsSupportTitle"], numeric: ["level_2.title", "world3.stage12.name"],
  long: ["onboarding.permissions.notifications.description_long"],
};
const WHITE = [1, 1, 1], DARK = [0.07, 0.07, 0.09];
// Style cases: the dot keys at two sizes, two fonts per case.
const STYLES = {
  regular: { fonts: ["HelveticaNeue", "AvenirNext-Regular"] },
  semibold: { fonts: ["HelveticaNeue-Medium", "AvenirNext-DemiBold"] },
  bold: { fonts: ["HelveticaNeue-Bold", "AvenirNext-Bold"] },
  black: { fonts: ["Arial-Black", "AvenirNext-Heavy"] },
  italic: { fonts: ["HelveticaNeue-Italic", "AvenirNext-BoldItalic"] },
  condensed: { fonts: ["HelveticaNeue-CondensedBold", "Futura-CondensedExtraBold"] },
  stroke: { fonts: ["AvenirNext-Heavy", "Arial-Black"], line: { color: WHITE, stroke: 9, strokeColor: [0.12, 0.1, 0.35] }, bg: [0.35, 0.55, 0.85] },
  shadow: { fonts: ["AvenirNext-Heavy", "HelveticaNeue-Bold"], line: { color: WHITE, shadow: 5, effectColor: [0, 0, 0] }, bg: [0.3, 0.6, 0.4] },
  glow: { fonts: ["AvenirNext-Heavy", "Futura-Bold"], line: { color: WHITE, glow: 8 }, bg: [0.25, 0.15, 0.4] },
  gradient: { fonts: ["AvenirNext-Heavy", "Arial-Black"], line: { gradient: [1, 0.93, 0.35, 0.92, 0.38, 0.05], stroke: 5, strokeColor: [0.3, 0.12, 0] }, bg: [0.15, 0.2, 0.45] },
  small: { fonts: ["HelveticaNeue-Bold", "AvenirNext-Regular"], sizes: [11, 13] },
  display: { fonts: ["AvenirNext-Heavy", "HelveticaNeue"], sizes: [64, 88], width: 1800 },
  "letter-spacing": { fonts: ["HelveticaNeue-Bold", "AvenirNext-Regular"], line: { kern: 6 } },
  "all-caps": { fonts: ["HelveticaNeue-Bold", "Futura-Bold"], caps: true },
  "low-contrast": { fonts: ["HelveticaNeue-Bold", "AvenirNext-Regular"], line: { color: [0.55, 0.55, 0.58] }, bg: [0.7, 0.7, 0.72] },
  texture: { fonts: ["AvenirNext-Heavy", "HelveticaNeue-Bold"], line: { color: WHITE, stroke: 6, strokeColor: DARK }, bg: [0.25, 0.35, 0.55], background: "texture" },
  "texture-plain": { fonts: ["AvenirNext-Bold", "HelveticaNeue"], line: { color: DARK }, bg: [0.85, 0.8, 0.7], background: "texture" },
  "locale-ja": { fonts: ["HelveticaNeue-Bold", "HiraginoSans-W6"], locale: "ja" },
  "locale-ar": { fonts: ["HelveticaNeue-Bold", "GeezaPro-Bold"], locale: "ar" },
};
const SIZES = [22, 34];

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`catscan ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Screens per case. A line: { text, role, key?, ...style }. Every screen opens with one translated line. */
function plan() {
  const screens = [];
  const add = (c, locale, lines, opts = {}) => screens.push({ name: `${c}-${screens.length}.png`, case: c, locale, lines, ...opts });
  const head = (locale) => ({ text: CAT["tab.home"][LOC[locale]], role: "text", font: "HelveticaNeue", size: 26 });
  for (const [c, st] of Object.entries(STYLES)) {
    const locale = st.locale || "de";
    for (const size of st.sizes || SIZES) for (const [fi, font] of st.fonts.entries()) {
      const keys = DOT.filter((_, i) => i % 2 === fi);
      add(c, locale, [head(locale), ...keys.map((k) => ({ text: st.caps ? k.toUpperCase() : k, role: "key", key: k, font, size, ...st.line }))],
        { bg: st.bg, background: st.background, width: st.width });
    }
  }
  for (const [c, keys] of Object.entries(SHAPES)) for (const font of ["HelveticaNeue", "HelveticaNeue-Bold", "AvenirNext-Heavy"]) {
    for (const size of SIZES) add(`shape-${c}`, "de", [head("de"), ...keys.map((k) => ({ text: k, role: "key", key: k, font, size: c === "long" ? size * 0.75 : size }))]);
  }
  for (const font of ["HelveticaNeue", "HelveticaNeue-Bold", "AvenirNext-Heavy"]) {
    // Mixed lines: a key inside ordinary text.
    add("mixed-line", "de", [head("de"),
      { text: "Einstellungen: settings.support", role: "key", key: "settings.support", font, size: 28 },
      { text: "Tippe auf menu.play zum Starten", role: "key", key: "menu.play", font, size: 28 },
      { text: "daily.bonus - 50 Münzen", role: "key", key: "daily.bonus", font, size: 28 }]);
    // A key wrapped over two lines, at a separator and inside a segment.
    add("wrap", "de", [head("de"),
      { text: "onboarding.permissions.", role: "key", key: "onboarding.permissions.notifications.description_long", part: 0, font, size: 28 },
      { text: "notifications.description_long", role: "key", key: "onboarding.permissions.notifications.description_long", part: 1, font, size: 28 },
      { text: "settings.notifi", role: "key", key: "settings.notifications", part: 0, font, size: 28 },
      { text: "cations", role: "key", key: "settings.notifications", part: 1, font, size: 28 }]);
    // Truncated with an ellipsis by the layout.
    add("ellipsis", "de", [head("de"),
      { text: "onboarding.permissions.notifications.description_long", role: "key", key: "onboarding.permissions.notifications.description_long", font, size: 28, ellipsisWidth: 360 },
      { text: "settings.notifications", role: "key", key: "settings.notifications", font, size: 28, ellipsisWidth: 210 }]);
    // One key drawn as two runs with a wide gap: Vision may return two observations.
    add("split", "de", [head("de"),
      { text: "settings.", role: "key", key: "settings.support", part: 0, font, size: 30, row: 0 },
      { text: "support", role: "key", key: "settings.support", part: 1, font, size: 30, row: 0, dx: 260 },
      { text: "level.", role: "key", key: "level.complete", part: 0, font, size: 30, row: 1 },
      { text: "complete", role: "key", key: "level.complete", part: 1, font, size: 30, row: 1, dx: 200 }]);
    // Unfilled placeholders that look like keys: placeholder findings, never raw keys.
    add("placeholders", "de", [head("de"),
      { text: "Hallo {player_name}, willkommen", role: "placeholder", font, size: 28 },
      { text: "%1$s hat %2$d Münzen gewonnen", role: "placeholder", font, size: 28 },
      { text: "{player_name}", role: "placeholder", font, size: 28 }]);
    // Decoys against the TODO-031 rules: two separate labels on one row must not join into `menu.play`, and a
    // catalog string cut by an ellipsis must not read as the start of `contact.support.label`.
    add("decoy-neighbors", "de", [head("de"),
      { text: "menu", role: "decoy", font, size: 30, row: 0 }, { text: "play", role: "decoy", font, size: 30, row: 0, dx: 640 },
      { text: "contact.support@example.com", role: "decoy", font, size: 28, ellipsisWidth: 300 }]);
    // Decoys: ordinary UI text near key shapes. No raw key may be reported on them.
    for (const caps of [false, true]) {
      const d = ["Daily Bonus", "Settings Support", "Level Complete", "Menu Play", "Game over", "acme.ai", "v2.4.1", "12:30", "1/2 Leben", "z.B. Münzen", "Shop - Kaufen", "Play / Pause"];
      for (let i = 0; i < d.length; i += 4) add(`decoy${caps ? "-caps" : ""}`, "de", [head("de"), ...d.slice(i, i + 4).map((t) => ({ text: caps ? t.toUpperCase() : t, role: "decoy", font, size: 30 }))]);
    }
  }
  return screens;
}

function layout(s) {
  let y = 30, prev = null;
  const lines = s.lines.map((l) => {
    // Lines with the same `row` share a baseline; `dx` places the later part to the right of the first.
    if (l.row !== undefined && prev && prev.row === l.row) return (prev = { ...l, x: 40 + l.dx, y: prev.y });
    const out = { ...l, x: 40, y };
    y += Math.round(l.size * (l.part === 0 && s.case === "wrap" ? 1.25 : 2.2)); // a wrapped line sits close
    return (prev = out);
  });
  return { name: s.name, width: s.width || 1000, height: y + 30, background: s.background || "flat", bg: s.bg || [1, 1, 1], lines };
}

// The TODO-031 guard, as the core applies it: a key whose words equal a catalog string's (`daily.bonus`, base
// `Daily bonus`) is that string when read with spaces only, so such a line is not eligible for recovery.
const lenient = (t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(".");
const strip = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const overlap = (box, l, H, W) => {
  const top = box[1] * H, bot = (box[1] + box[3]) * H;
  return Math.min(bot, l.y + l.size * 1.3) - Math.max(top, l.y - l.size * 0.1) > l.size * 0.3;
};

(() => {
  const gen = path.join(ROOT, ".build/rawkey-render");
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  execFileSync("swiftc", ["-O", path.join(ROOT, "bench/rawkey-audit/render.swift"), "-o", gen], { stdio: ["ignore", "ignore", "inherit"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-rawkey-audit-"));
  for (const [l, i] of Object.entries(LOC)) fs.writeFileSync(path.join(dir, `${l}.json`), JSON.stringify(Object.fromEntries(Object.entries(CAT).map(([k, v]) => [k, v[i]]))));
  const screens = plan();
  const byLocale = {};
  for (const s of screens) (byLocale[s.locale] ??= []).push(s);
  const cases = {};
  const blank = () => ({ keys: 0, found: 0, eligible: 0, found_eligible: 0, guarded: 0, duplicates: 0, any_raw_key: 0, separator_lost: 0, confusion: 0, untranslated_on_key: 0, truncated_on_key: 0, placeholder_found: 0, placeholders: 0, raw_key_on_placeholder: 0, decoys: 0, raw_key_on_decoy: 0, samples: [] });
  const conf = { "separator-space": 0, "separator-missing": 0, "separator-other": 0, "l/I/1": 0, "O/0": 0, "rn/m": 0, case: 0, other: 0 };
  for (const [locale, list] of Object.entries(byLocale)) {
    const texts = new Set(Object.values(CAT).flatMap((v) => [v[0], v[LOC[locale]]]).map(lenient));
    const shots = path.join(dir, `shots-${locale}`);
    fs.mkdirSync(shots);
    const laid = list.map(layout);
    fs.writeFileSync(path.join(dir, "shots.json"), JSON.stringify(laid));
    execFileSync(gen, [path.join(dir, "shots.json"), shots], { stdio: "ignore" });
    const env = (e) => Object.fromEntries(e.map((x) => [path.basename(x.path), x]));
    const read = env(run(["read", shots, "--locale", locale]));
    const untr = env(run(["untranslated", shots, "--locale", locale, "--base", path.join(dir, "en.json"), "--catalog", path.join(dir, `${locale}.json`)]));
    // Verdict interplay: `truncated` on the same screens (no boxes: the ellipsis rule), for keys cut by the layout.
    const trunc = env(run(["truncated", shots, "--locale", locale]));
    for (const [si, s] of list.entries()) {
      const L = laid[si];
      const c = (cases[s.case] ??= blank());
      const rl = read[s.name]?.lines || [];
      const fs_ = untr[s.name]?.findings || [];
      const on = (l) => fs_.filter((f) => f.box && overlap(f.box, l, L.height, L.width));
      const seen = new Set();
      for (const l of L.lines) {
        if (l.role === "key") {
          if (seen.has(l.key)) continue; // a key drawn in parts counts once
          seen.add(l.key);
          const parts = L.lines.filter((m) => m.key === l.key);
          c.keys++;
          const hits = parts.flatMap(on);
          const raw = [...new Set(hits.filter((f) => f.kind === "raw-key"))];
          if (raw.length) c.any_raw_key++;
          // Found: a raw-key finding that names this key, or (the D30 pattern, no key) whose line is the key.
          const mine = raw.filter((f) => f.key === l.key || f.keys?.includes(l.key) || (!f.key && !f.keys && strip(f.line) === strip(l.key)));
          if (mine.length) c.found++;
          if (mine.length > 1) c.duplicates++;
          // Eligible: Vision read every letter and digit of the key (an ellipsis-cut key: its visible part).
          // Parts on one row share their observations: each recognized line counts once.
          const read = [...new Set(parts.flatMap((p) => rl.filter((x) => overlap(x.box, p, L.height, L.width))))].map((x) => x.text).join("");
          const guarded = texts.has(lenient(l.key)) && !/[._\-/:]/.test(read);
          const ok = !guarded && (l.ellipsisWidth ? read.length > 0 && strip(l.key).startsWith(strip(read))
            : s.case === "mixed-line" ? strip(read).includes(strip(l.key)) : strip(read) === strip(l.key));
          if (guarded) c.guarded++;
          if (ok) { c.eligible++; if (mine.length) c.found_eligible++; }
          if (!mine.length && (c.misses ??= []).length < 6) c.misses.push({ entry: l.key, read, found: hits.map((f) => ({ kind: f.kind, entry: f.key || f.base || null, line: f.line })) });
          if (hits.some((f) => f.kind === "untranslated")) c.untranslated_on_key++;
          if (parts.some((p) => (trunc[s.name]?.findings || []).some((f) => f.box && overlap(f.box, p, L.height, L.width)))) c.truncated_on_key++;
          // What Vision read on the key's row(s), for the separator and confusion tallies (whole-key lines only).
          if (parts.length === 1 && !l.ellipsisWidth && s.case !== "mixed-line") {
            const r = rl.filter((x) => overlap(x.box, l, L.height, L.width)).map((x) => x.text).join(" ");
            const want = l.text;
            if (r && r !== want) {
              c.confusion++;
              const sep = /[._\-/:]/g;
              if (r.replace(/[\s.,·_\-/:]+/g, "") === want.replace(sep, "") && r.toLowerCase() !== want.toLowerCase()) {
                c.separator_lost++;
                conf[/\s/.test(r) ? "separator-space" : r.replace(sep, "") === r && r === want.replace(sep, "") ? "separator-missing" : "separator-other"]++;
              } else if (r.toLowerCase() === want.toLowerCase()) conf.case++;
              else if (r.replace(/[lI1|]/g, "l") === want.replace(/[lI1|]/g, "l")) conf["l/I/1"]++;
              else if (r.replace(/[O0o]/g, "o") === want.replace(/[O0o]/g, "o")) conf["O/0"]++;
              else if (r.replace(/rn/g, "m") === want.replace(/rn/g, "m")) conf["rn/m"]++;
              else conf.other++;
              if (c.samples.length < 6) c.samples.push({ drawn: want, read: r, font: l.font, size: l.size });
            }
          }
        } else if (l.role === "placeholder") {
          c.placeholders++;
          const h = on(l);
          if (h.some((f) => f.kind === "placeholder")) c.placeholder_found++;
          else c.samples.push({ placeholder: l.text, read: rl.filter((x) => overlap(x.box, l, L.height, L.width)).map((x) => x.text).join(" ") });
          if (h.some((f) => f.kind === "raw-key")) c.raw_key_on_placeholder++;
        } else if (l.role === "decoy") {
          c.decoys++;
          if (on(l).some((f) => f.kind === "raw-key")) { c.raw_key_on_decoy++; c.samples.push({ decoy: l.text, font: l.font }); }
        }
      }
    }
  }
  for (const c of Object.values(cases)) if (c.keys) {
    c.recall = Number((c.found / c.keys).toFixed(3));
    c.recall_eligible = c.eligible ? Number((c.found_eligible / c.eligible).toFixed(3)) : null;
  }
  const v = versionInfo();
  process.stdout.write(JSON.stringify({
    screens: screens.length, cases, confusions: conf,
    tools: { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version, renderer: "bench/rawkey-audit/render.swift" },
  }, null, 2) + "\n");
  fs.rmSync(dir, { recursive: true, force: true });
})();
