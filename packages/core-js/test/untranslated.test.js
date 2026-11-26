// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 17: `untranslated` arguments, request building and rendering. Synthetic fixtures only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parse, UsageError } = require("../src/args");
const untranslated = require("../src/untranslated");
const catalog = require("../src/catalog");
const render = require("../src/render");
const { HELP, SHORT_USAGE } = require("../src/cli");

const U = path.join(__dirname, "../../../test/fixtures/untranslated");
const C = path.join(__dirname, "../../../test/fixtures/catalogs");
const usage = (argv, code, re) => assert.throws(() => parse(argv), (e) => e instanceof UsageError && e.code === code && (!re || re.test(e.message + e.hint)));
const tmp = (name, data) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-u-")), name); fs.writeFileSync(f, data); return f; };
const build = (argv) => untranslated.build(parse(["untranslated", "shot.png", ...argv]));

test("args: untranslated and its options (D16, D23, D26)", () => {
  const o = parse(["untranslated", "s", "--locale", "de", "--base", "en.json", "--catalog", "de.json", "--allow", "a.txt", "--base-locale", "en-GB"]);
  assert.deepEqual([o.command, o.base, o.catalogs, o.allow, o.baseLocale], ["untranslated", "en.json", ["de.json"], "a.txt", "en-GB"]);
  assert.equal(parse(["untranslated", "s"]).command, "untranslated"); // catalog-free: raw keys and placeholders
  assert.equal(parse(["untranslated", "s", "--catalog", "de.json"]).catalogs.length, 1);
  usage(["untranslated", "s", "--base", "en.json"], "missing-catalog", /--catalog locales\/de\.json/);
  usage(["untranslated", "s", "--base", "en.json", "--catalog", "l/{locale}.json"], "missing-locale", /--locale de/);
  usage(["untranslated", "s", "--base-locale", "en_GB"], "invalid-locale", /--base-locale en-GB/);
  usage(["untranslated", "s", "--present", "x"], "option-not-valid");
  usage(["untranslated", "s", "--all-keys"], "option-not-valid");
  usage(["check", "s", "--present", "x", "--base", "en.json"], "option-not-valid");
  usage(["untranslated", "s", "--base", "a", "--base", "b", "--catalog", "c"], "repeated-option");
  usage(["untranslated"], "missing-path");
  assert.match(HELP, /catscan untranslated <path\.\.\.>/);
  assert.match(HELP, /--base-locale/);
  assert.match(SHORT_USAGE, /untranslated, video, truncated, overlap, formats, fit, contrast, boxes, languages/);
});

test("allow list: trimmed, blank and # lines dropped, BOM stripped; errors are usage errors (D7, D26)", () => {
  assert.deepEqual(untranslated.loadAllow(tmp("a.txt", "﻿Catscan Pro \n\n# brands\n  Acme\r\n")), ["Catscan Pro", "Acme"]);
  assert.throws(() => untranslated.loadAllow("/nonexistent/allow.txt"), (e) => e.code === "allow-not-found");
  assert.throws(() => untranslated.loadAllow(tmp("big.txt", Buffer.alloc(untranslated.MAX_ALLOW_BYTES + 1, 65))), (e) => e.code === "allow-too-large");
  assert.throws(() => untranslated.loadAllow(tmp("bad.txt", Buffer.from([0xff, 0xfe, 0x41]))), (e) => e.code === "invalid-allow");
});

test("request: pairs, null expected, targets, keys and styles (D2, D6, D15, D28)", () => {
  const { field, runWarnings } = build(["--locale", "de", "--base", path.join(U, "en.json"), "--catalog", path.join(U, "de.json")]);
  assert.deepEqual(runWarnings, []);
  assert.equal(field.base_locale, "en");
  const byKey = Object.fromEntries(field.pairs.map((p) => [p.key, p]));
  const privacy = byKey["settings.privacy"];
  assert.deepEqual(Object.keys(privacy), ["key", "catalog", "base", "expected", "base_alternatives", "target_alternatives"]);
  assert.deepEqual([privacy.catalog, privacy.base, privacy.expected], [path.join(U, "de.json"), "Privacy", "Datenschutz"]);
  assert.deepEqual([privacy.base_alternatives, privacy.target_alternatives], [[["Privacy"]], [["Datenschutz"]]]);
  assert.equal(byKey.delete_account.expected, null); // not in de.json: the classic fallback
  assert.deepEqual(byKey.delete_account.target_alternatives, []);
  assert.ok(field.targets.some((a) => a[0] === "Download starten"));
  assert.ok(field.keys.includes("paywall.cta_title"));
  // TODO-031: every catalog string rides along for the core's collision guard, base and target alike.
  assert.ok(field.texts.includes("Privacy") && field.texts.includes("Datenschutz"));
  assert.deepEqual(field.texts, [...field.texts].sort());
  // Rendered fragments too: markup dropped (`<b>` in a catalog string is shown without it).
  const marked = tmp("en.json", JSON.stringify({ "game.over": "<b>game over</b>" }));
  assert.ok(build(["--base", marked, "--catalog", marked]).field.texts.includes("game over"));
  const okMarked = tmp("en.json", JSON.stringify({ OK: "<b>OK</b>", "menu.play": "Play" }));
  assert.deepEqual(build(["--base", okMarked, "--catalog", okMarked]).field.keys, ["menu.play"]);
  const frag = tmp("en.json", JSON.stringify({ coins: "Coins", reward: "Collect {count} coins" }));
  assert.ok(!build(["--base", frag, "--catalog", frag]).field.keys.includes("coins"));
  assert.deepEqual(field.styles, ["{{name}}"]);
});

test("request: keys-as-text are not raw keys; capped and reference-less strings are left out (D6, D15)", () => {
  const strings = tmp("Localizable.strings", '"Cancel" = "Cancel";\n"home.title" = "Home";\n"Delete it" = "Delete it";\n');
  const de = tmp("de.json", JSON.stringify({ Cancel: "Abbrechen", "home.title": "Start", empty: "" }));
  const { field } = build(["--locale", "de", "--base", strings, "--catalog", de]);
  assert.ok(!field.keys.includes("Cancel"));
  assert.ok(!field.keys.includes("Delete it"));
  assert.ok(field.keys.includes("home.title"));
  const blow = path.join(C, "hostile/plural-blowup.json");
  const capped = build(["--locale", "de", "--base", blow, "--catalog", de]).field;
  assert.ok(capped.pairs.every((p) => p.base_alternatives.some((a) => a.length)));
  const en = tmp("en.json", JSON.stringify({ empty: "Empty state" }));
  const empty = build(["--locale", "de", "--base", en, "--catalog", de]).field.pairs;
  assert.deepEqual(empty.map((p) => [p.key, p.expected]), [["empty", null]], "an empty target string is no string (D2)");
});

test("request: a missing {locale} file and the base catalog itself switch the rule off loudly (D15, D16, D22, D27)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-u-"));
  fs.copyFileSync(path.join(U, "en.json"), path.join(dir, "en.json"));
  const m = build(["--locale", "fr", "--base", path.join(dir, "en.json"), "--catalog", path.join(dir, "{locale}.json")]);
  // TODO-036 D27: no fr strings, so wrong-language ran on language ID only and says so.
  assert.deepEqual(m.runWarnings.map((w) => w.code), ["wrong-language-unchecked", "catalog-missing"]);
  assert.match(m.runWarnings[1].message, /untranslated rule was skipped/);
  assert.equal(m.field.pairs.length, 0);
  const same = build(["--locale", "en", "--base", path.join(dir, "en.json"), "--catalog", path.join(dir, "{locale}.json")]);
  assert.deepEqual(same.runWarnings.map((w) => w.code), ["wrong-language-unchecked", "untranslated-base-catalog"]);
  assert.equal(same.field.pairs.length, 0);
  // One .xcstrings holds both locales: base read for its sourceLanguage, target for --locale (D22).
  const xc = path.join(C, "Localizable.xcstrings");
  const x = build(["--locale", "de", "--base", xc, "--catalog", xc]);
  assert.deepEqual(x.runWarnings, []);
  assert.equal(x.field.base_locale, "en");
  const t = x.field.pairs.find((p) => p.key === "settings.title");
  assert.equal(t.expected, "Kontoeinstellungen");
  assert.equal(x.field.pairs.find((p) => p.key === "photos.count").expected, null);
  assert.deepEqual(build(["--locale", "en", "--base", xc, "--catalog", xc]).runWarnings.map((w) => w.code), ["untranslated-base-catalog"]);
});

test("catalog regression: ${name} is one placeholder (D17)", () => {
  assert.deepEqual(catalog.fragments("Welcome ${name}!").alternatives, [["Welcome", "!"]]);
  assert.deepEqual(catalog.fragments("cost ${5").alternatives, [["cost ${5"]]);
});

test("render: one line per finding kind (D24)", () => {
  const env = {
    verdict: "fail", path: "s.png", command: "untranslated", checks: [], findings: [
      { kind: "untranslated", key: "settings.privacy", catalog: "locales/de.json", base: "Privacy", expected: "Datenschutz", line: "Privacy", box: [0.1, 0.2, 0.3, 0.04] },
      { kind: "untranslated", key: "del", catalog: "locales/de.json", base: "Delete", expected: null, line: "Delete", box: [0, 0, 1, 1] },
      { kind: "raw-key", line: "paywall.cta_title", box: [0.2, 0.7, 0.6, 0.04] },
      { kind: "placeholder", line: "{count} Artikel", token: "{count}", box: [0.1, 0.3, 0.4, 0.03] },
    ],
  };
  assert.deepEqual(render.renderText(env), [
    "FAIL  s.png",
    '  untranslated @settings.privacy "Privacy" (locales/de.json: "Datenschutz") in "Privacy" at [0.1, 0.2, 0.3, 0.04]',
    '  untranslated @del "Delete" (locales/de.json: no string) in "Delete" at [0, 0, 1, 1]',
    '  raw-key "paywall.cta_title" at [0.2, 0.7, 0.6, 0.04]',
    '  placeholder "{count}" in "{count} Artikel" at [0.1, 0.3, 0.4, 0.03]',
  ]);
  // TODO-031: a misread line names its catalog key, or every candidate; a line that is the key does not repeat it.
  const raw = (f) => render.renderText({ ...env, findings: [{ kind: "raw-key", box: [0, 0, 1, 1], ...f }] })[1];
  assert.equal(raw({ line: "settings support", key: "settings.support" }), '  raw-key "settings support" (@settings.support) at [0, 0, 1, 1]');
  assert.equal(raw({ line: "menu foo bar", keys: ["menu.foo-bar", "menu.foo_bar"] }), '  raw-key "menu foo bar" (@menu.foo-bar, @menu.foo_bar) at [0, 0, 1, 1]');
  assert.equal(raw({ line: "home.title", key: "home.title" }), '  raw-key "home.title" at [0, 0, 1, 1]');
  assert.deepEqual(render.renderText({ ...env, verdict: "pass", findings: [] }), ["PASS  s.png"]);
});

test("request: catalog-only run, a missing {locale} file and --base-locale (D11, D15, D23)", () => {
  const only = build(["--locale", "de", "--catalog", path.join(U, "de.json")]);
  // TODO-036 D17: one plain catalog names no other language, so wrong-language could not run.
  assert.deepEqual([only.field.pairs, only.runWarnings.map((w) => w.code)], [[], ["wrong-language-unchecked"]]);
  assert.ok(only.field.targets.length && only.field.keys.length && only.field.texts.includes("Datenschutz"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-u-"));
  const gone = build(["--locale", "fr", "--catalog", path.join(dir, "{locale}.json")]);
  assert.deepEqual(gone.runWarnings.map((w) => w.code), ["wrong-language-unchecked", "catalog-missing"]);
  assert.match(gone.runWarnings[1].message, /not checked as raw keys/);
  const xc = path.join(C, "Localizable.xcstrings");
  assert.equal(build(["--locale", "de", "--base", xc, "--catalog", xc, "--base-locale", "en-GB"]).field.base_locale, "en-GB");
});

test("request: D22 compares the full locale tag and needs every target to be the base", () => {
  const unit = (v) => ({ stringUnit: { state: "translated", value: v } });
  const xc = tmp("L.xcstrings", JSON.stringify({ sourceLanguage: "zh-Hans", version: "1.0", strings: { ok: { localizations: { "zh-Hans": unit("设置"), "zh-Hant": unit("設定") } } } }));
  const t = build(["--locale", "zh-Hant", "--base", xc, "--catalog", xc]);
  assert.deepEqual([t.runWarnings, t.field.pairs.map((p) => p.expected)], [[], ["設定"]]);
  const en = path.join(U, "en.json");
  const mixed = build(["--locale", "de", "--base", en, "--catalog", en, "--catalog", path.join(U, "de.json")]);
  assert.ok(!mixed.runWarnings.some((w) => w.code === "untranslated-base-catalog"));
  const pairs = Object.fromEntries(mixed.field.pairs.map((p) => [p.key, p]));
  assert.equal(pairs["settings.privacy"].expected, "Datenschutz");
  assert.equal(pairs.delete_account.expected, null, "a string merged from the base is a missing translation");
  assert.equal(pairs.delete_account.catalog, path.join(U, "de.json"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-u-"));
  fs.symlinkSync(en, path.join(dir, "alias.json"));
  fs.linkSync(en, path.join(dir, "hard.json"));
  assert.deepEqual(build(["--locale", "de", "--base", en, "--catalog", path.join(dir, "hard.json")]).runWarnings.map((w) => w.code), ["untranslated-base-catalog"]);
  assert.deepEqual(build(["--locale", "de", "--base", en, "--catalog", path.join(dir, "alias.json")]).runWarnings.map((w) => w.code), ["untranslated-base-catalog"]);
});

test("request: an all-shared target warns; a field over the request cap is a usage error", () => {
  const src = path.join(C, "Localizable.xcstrings"); // sourceLanguage en, no en-GB strings
  const gb = build(["--locale", "en-GB", "--base", src, "--catalog", src]);
  assert.deepEqual([gb.runWarnings.map((w) => w.code), gb.field.pairs.length], [["untranslated-base-catalog"], 0]);
  const big = (word) => JSON.stringify(Object.fromEntries(Array.from({ length: 70000 }, (_, i) => [`k${i}`, `${word} ${i} `.padEnd(100, "x")])));
  const en = tmp("en.json", big("Item")), de = tmp("de.json", big("Eintrag"));
  assert.throws(() => build(["--locale", "de", "--base", en, "--catalog", de]), (e) => e instanceof UsageError && e.code === "catalog-too-large");
});

test("request: an .xcstrings sourceLanguage that is no locale falls back to en; an unreadable one is loadFile's error", () => {
  const xc = tmp("L.xcstrings", JSON.stringify({ sourceLanguage: "", version: "1.0", strings: { ok: { localizations: { en: { stringUnit: { state: "translated", value: "OK" } } } } } }));
  assert.equal(build(["--locale", "de", "--base", xc, "--catalog", path.join(U, "de.json")]).field.base_locale, "en");
  const locked = tmp("M.xcstrings", "{}");
  fs.chmodSync(locked, 0o000);
  try {
    assert.equal(catalog.xcstringsSource(locked), null);
    assert.throws(() => build(["--locale", "de", "--base", locked, "--catalog", path.join(U, "de.json")]), (e) => e instanceof UsageError);
  } finally { fs.chmodSync(locked, 0o600); }
});

test("request: the caps match the core and the loader, and each one is a usage error (TODO-012)", () => {
  const { checkCaps, CAPS } = require("../src/untranslated");
  const swift = fs.readFileSync(path.join(__dirname, "../../../core/Sources/CatscanCore/Untranslated.swift"), "utf8");
  const m = swift.match(/caps = \(pairs: ([\d_]+), targets: ([\d_]+), alternatives: (\d+), fragments: (\d+)\)/);
  assert.ok(m, "Untranslated.caps not found");
  assert.deepEqual(m.slice(1).map((x) => Number(x.replace(/_/g, ""))), [CAPS.pairs, CAPS.targets, CAPS.alternatives, CAPS.fragments]);
  // D5: the per-string caps equal the loader's expansion cap, so a loaded string never reaches them.
  const loader = fs.readFileSync(path.join(__dirname, "../src/catalog.js"), "utf8").match(/const MAX_FRAGMENTS = (\d+);/);
  assert.deepEqual([CAPS.alternatives, CAPS.fragments], [Number(loader[1]), Number(loader[1])]);
  const A = CAPS.alternatives, F = CAPS.fragments;
  const pair = (key, base = [["Hi"]], target = [["Hallo"]]) => ({ key, base_alternatives: base, target_alternatives: target });
  const field = (pairs, targets = []) => ({ pairs, targets });
  const forms = (n, len = 1) => Array.from({ length: n }, () => Array.from({ length: len }, () => "a"));
  const capped = (f, re) => assert.throws(() => checkCaps(f), (e) => e instanceof UsageError && e.code === "catalog-too-many-strings" && re.test(e.message) && /pass only the catalogs/.test(e.hint));
  checkCaps(field(Array.from({ length: CAPS.pairs }, (_, i) => pair(`k${i}`)), forms(CAPS.targets)));
  checkCaps(field([pair("k", [...forms(A, 1), [], []], forms(1, F))], forms(1, F))); // empty forms are not counted
  capped(field(Array.from({ length: CAPS.pairs + 1 }, (_, i) => pair(`k${i}`))), /^the catalogs give 20001 key pairs to check; the limit is 20000$/);
  capped(field([], forms(CAPS.targets + 1)), /target catalogs give 20001 string forms/);
  capped(field([pair("k", forms(A + 1))]), /^the base string of k has 257 forms; the limit is 256$/);
  capped(field([pair("k", [["Hi"]], forms(A + 1))]), /^the target string of k has 257 forms/);
  capped(field([pair("k", forms(1, F + 1))]), /^the base string of k has 257 fragments; the limit is 256$/);
  capped(field([pair("k", [["Hi"]], forms(2, F / 2 + 1))]), /^the target string of k has 258 fragments/); // over all forms
  capped(field([], forms(1, F + 1)), /^a target string form has 257 fragments/);
});

// TODO-036 T2: the wrong_language part of the request (D4, D17, D25-D27).
test("wrong-language: a {locale} template finds the other locales on disk; the base is left out with --base (D25, D26)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wl-"));
  const w = (n, o) => fs.writeFileSync(path.join(dir, n), JSON.stringify(o));
  w("en.json", { buy: "Buy now", cancel: "Cancel", ok: "OK" }); // es "OK" equals the base string: rule 1's (D26)
  w("es.json", { buy: "Comprar ahora", cancel: "Cancelar", only_es: "Solo aquí", ok: "OK" });
  w("pt-BR.json", { buy: "Comprar agora", cancel: "Cancelar" });
  fs.writeFileSync(path.join(dir, "notes.json"), "{}"); // no locale in the slot: "notes" is 5 letters
  const tpl = path.join(dir, "{locale}.json");
  const plain = build(["--locale", "pt-BR", "--catalog", tpl]);
  const wl = plain.field.wrong_language;
  assert.deepEqual(wl.languages, ["en", "es"]);
  assert.deepEqual(wl.others.map((o) => o.locale), ["en", "es"]);
  assert.equal(wl.preferred, "en", "without --base the base locale is named first");
  const es = wl.others.find((o) => o.locale === "es");
  assert.equal(es.catalog, path.join(dir, "es.json"));
  assert.deepEqual(es.pairs.map((p) => [p.key, p.base, p.expected, p.catalog]), [
    ["buy", "Comprar ahora", "Comprar agora", path.join(dir, "pt-BR.json")],
    ["cancel", "Cancelar", "Cancelar", path.join(dir, "pt-BR.json")],
    ["only_es", "Solo aquí", null, path.join(dir, "pt-BR.json")],
  ]);
  assert.deepEqual(plain.runWarnings, []);
  const withBase = build(["--locale", "pt-BR", "--base", path.join(dir, "en.json"), "--catalog", tpl]).field.wrong_language;
  assert.deepEqual(withBase.languages, ["en", "es"], "the base stays a language for language ID");
  assert.deepEqual(withBase.others.map((o) => o.locale), ["es"], "D26: rule 1 judges base strings");
  assert.equal(withBase.preferred, undefined);
  assert.equal(build(["--locale", "pt-BR", "--catalog", tpl, "--kinds", "raw-key"]).field.wrong_language, undefined, "--kinds without it");
});

// protects: D4 - a {locale} slot that is a directory (locales/{locale}/app.json) finds the locales that hold the file.
// fails_when: localesOnDisk reads the slot only from file names, keeps a non-locale directory, or keeps a locale
//   directory without the file.
// why_new: the T2 tests use only a flat locales/{locale}.json template.
// seam: none (localesOnDisk is exported and build() calls it).
// no_claim: .xcstrings discovery and the pairs built from the found catalogs.
test("wrong-language: a {locale} directory template finds the locale folders that hold the file (D4)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wl-"));
  for (const [d, file] of [["es", true], ["pt-BR", true], ["fr", false], ["assets", true]]) {
    fs.mkdirSync(path.join(dir, d));
    if (file) fs.writeFileSync(path.join(dir, d, "app.json"), JSON.stringify({ buy: d }));
  }
  const tpl = path.join(dir, "{locale}", "app.json");
  assert.deepEqual(untranslated.localesOnDisk(tpl), ["es", "pt-BR"]);
  assert.deepEqual(untranslated.localesOnDisk(path.join(dir, "missing", "{locale}.json")), []);
  assert.deepEqual(build(["--locale", "pt-BR", "--catalog", tpl]).field.wrong_language.others.map((o) => o.locale), ["es"]);
});

test("wrong-language: .xcstrings localizations, and an absent run localization is unchecked (D25, D27)", () => {
  const xc = path.join(C, "Localizable.xcstrings");
  const x = build(["--locale", "de", "--catalog", xc]);
  assert.ok(x.field.wrong_language.languages.includes("en"));
  assert.ok(x.field.wrong_language.others.length >= 1);
  assert.ok(!x.field.wrong_language.others.some((o) => o.locale === "de"));
  const none = build(["--locale", "ko", "--catalog", xc]);
  assert.deepEqual(none.field.wrong_language.others, []);
  assert.ok(none.runWarnings.some((w) => w.code === "wrong-language-unchecked" && /no ko strings/.test(w.message)));
});

test("wrong-language: --languages alone is language ID; usage errors name the flag", () => {
  const f = build(["--locale", "de", "--catalog", path.join(U, "de.json"), "--languages", "es,pt-BR,de,es"]).field.wrong_language;
  assert.deepEqual(f, { languages: ["es", "pt-BR"], others: [] }, "the run locale and duplicates are dropped");
  assert.throws(() => build(["--locale", "de", "--languages", "es,123"]), (e) => e.code === "invalid-locale" && /--languages/.test(e.message));
  assert.throws(() => build(["--locale", "de", "--languages", " , "]), (e) => e.code === "invalid-locale");
  assert.throws(() => build(["--locale", "de", "--pseudo", "--catalog", path.join(U, "de.json"), "--languages", "es"]), (e) => e.code === "option-not-valid");
  assert.throws(() => build(["--locale", "de", "--kinds", "wrong-langauge"]), (e) => e.code === "unknown-kind" && /wrong-language/.test(e.message));
});

test("wrong-language: text rendering for catalog and language-ID evidence", () => {
  const env = { path: "s.png", verdict: "fail", checks: [], warnings: [], findings: [] };
  const one = (f) => render.renderText({ ...env, findings: [{ kind: "wrong-language", box: [0, 0, 1, 1], expected_language: "pt-BR", ...f }] })[1];
  assert.equal(one({ line: "Comprar ahora", language: "es", evidence: "catalog", confidence: 1, key: "shop.buy", catalog: "locales/pt-BR.json", expected: "Comprar agora", evidence_catalog: "locales/es.json" }),
    '  wrong-language es @shop.buy (locales/pt-BR.json: "Comprar agora"; matched locales/es.json) in "Comprar ahora" at [0, 0, 1, 1]');
  assert.equal(one({ line: "Guarda todos los cambios", language: "es", evidence: "langid", confidence: 0.99 }),
    '  wrong-language es (language ID 0.99; pt-BR expected) in "Guarda todos los cambios" at [0, 0, 1, 1]');
});

// protects: D32 - review fixes: a regional sibling is the run language, evidence_catalog names its own file, a sibling
//   that cannot be read or is outside the MCP roots is named, and catalog evidence over the caps falls back to language ID.
// fails_when: es is an other locale on an es-MX run; one other entry spans two files; a broken or outside sibling is
//   dropped silently; an oversized other catalog throws catalog-too-many-strings.
// seam: build() over files in a temp dir; allowFile is the hook MCP passes.
test("wrong-language: regional siblings, one entry per file, skipped siblings and the size fallback (D32)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wl-"));
  const w = (rel, o) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), typeof o === "string" ? o : JSON.stringify(o)); };
  w("a/es.json", { a: "Guardar cambios ahora" });
  w("a/es-MX.json", { b: "Cancelar" });
  w("a/pt-BR.json", { a: "Salvar alterações agora" });
  w("b/es.json", { c: "Comprar ahora" });
  w("b/pt-BR.json", { c: "Comprar agora" });
  const tpl = [path.join(dir, "a/{locale}.json"), path.join(dir, "b/{locale}.json")];
  const cats = tpl.flatMap((t) => ["--catalog", t]);
  const mx = build(["--locale", "es-MX", ...cats]).field.wrong_language;
  assert.deepEqual(mx.others.map((o) => o.locale), ["pt-BR", "pt-BR"], "es falls back under es-MX: not an other locale");
  assert.ok(!mx.languages.includes("es"));
  const k = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wl-"));
  for (const l of ["sr-Latn", "sr-Cyrl", "no", "nb", "zh-Hans", "zh-TW", "zh-Hant"]) fs.writeFileSync(path.join(k, `${l}.json`), JSON.stringify({ x: `Tekst ${l} ovde` }));
  const others = (l) => build(["--locale", l, "--catalog", path.join(k, "{locale}.json")]).field.wrong_language.others.map((o) => o.locale);
  assert.deepEqual(others("sr-Cyrl"), ["nb", "no", "sr-Latn", "zh-Hans", "zh-Hant", "zh-TW"], "another script is another language");
  assert.deepEqual(others("nb"), ["sr-Cyrl", "sr-Latn", "zh-Hans", "zh-Hant", "zh-TW"], "no and nb are one language");
  assert.deepEqual(others("zh-TW"), ["nb", "no", "sr-Cyrl", "sr-Latn", "zh-Hans"], "zh-Hant is the zh-TW script; Simplified is another");
  const br = build(["--locale", "pt-BR", ...cats]).field.wrong_language;
  assert.deepEqual(br.others.filter((o) => o.locale === "es").map((o) => [o.catalog, o.pairs.map((p) => p.key)]),
    [[path.join(dir, "a/es.json"), ["a"]], [path.join(dir, "b/es.json"), ["c"]]]);
  const out = untranslated.build({ ...parse(["untranslated", "shot.png", "--locale", "pt-BR", ...cats]), allowFile: (p) => !p.includes("es-MX") });
  assert.ok(out.runWarnings.some((x) => x.code === "wrong-language-unchecked" && /es-MX catalog is outside the allowed roots/.test(x.message)));
  assert.ok(!out.field.wrong_language.others.some((o) => o.locale === "es-MX"));
  w("a/fr.json", "{ not json");
  const broken = build(["--locale", "pt-BR", "--catalog", tpl[0]]);
  assert.ok(broken.runWarnings.some((x) => x.code === "wrong-language-unchecked" && /fr catalog could not be read/.test(x.message)));
  w("a/de.json", Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [`k${i}`, `Wort ${i}`])));
  const big = build(["--locale", "pt-BR", "--catalog", tpl[0]]);
  assert.deepEqual(big.field.wrong_language.others, [], "over the caps: language ID only");
  assert.ok(big.field.wrong_language.languages.includes("de"));
  assert.ok(big.runWarnings.some((x) => /too large, so wrong-language matched no catalog/.test(x.message)));
  // The cap counts per locale, over every file of it: two de files under the cap that are over it together.
  const half = (o) => Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [`${o}${i}`, `Wort ${o} ${i}`]));
  fs.unlinkSync(path.join(dir, "a/de.json"));
  w("a/de.json", half("a"));
  w("b/de.json", half("b"));
  const two = build(["--locale", "pt-BR", ...cats]);
  assert.deepEqual(two.field.wrong_language.others, [], "two de files over the cap together: language ID only");
  const entry = (o) => ({ locale: "de", pairs: Object.keys(half(o)).map((key) => ({ key, base_alternatives: [] })) });
  assert.throws(() => untranslated.checkCaps({ pairs: [], targets: [], wrong_language: { others: [entry("a"), entry("b")] } }), /the de catalogs give 20002 key pairs/);
});

test("uncatalogued: args, kinds sugar and usage errors (TODO-036 T4, D52, D18)", () => {
  // Value: protects=D52 and D18 surface; fails_when=--uncatalogued is not added to the kinds, combines with --pseudo, runs without a catalog, or --dynamic/--boxes stay pseudo-only; why_new=new flag; seam=none; no_claim=the rule (UncataloguedTests)
  const o = parse(["untranslated", "s", "--catalog", "de.json", "--uncatalogued", "--experimental"]);
  assert.deepEqual(o.kinds, ["untranslated", "raw-key", "placeholder", "wrong-language", "uncatalogued"]);
  assert.deepEqual(parse(["untranslated", "s", "--catalog", "de.json", "--uncatalogued", "--experimental", "--kinds", "raw-key"]).kinds, ["raw-key", "uncatalogued"]);
  const k = parse(["untranslated", "s", "--catalog", "de.json", "--kinds", "uncatalogued", "--experimental", "--dynamic", "d.txt", "--boxes", "b"]);
  assert.deepEqual([k.uncatalogued, k.kinds, k.dynamic, k.boxes], [true, ["uncatalogued"], "d.txt", "b"]);
  usage(["untranslated", "s", "--catalog", "en.json", "--uncatalogued", "--experimental", "--pseudo"], "conflicting-options", /hardcoded/);
  usage(["untranslated", "s", "--uncatalogued", "--experimental"], "missing-catalog", /--catalog/);
  // D55: it missed the real-screen gate, so it runs only with --experimental (also as --kinds uncatalogued).
  usage(["untranslated", "s", "--catalog", "de.json", "--uncatalogued"], "experimental-command", /--experimental/);
  usage(["untranslated", "s", "--catalog", "de.json", "--kinds", "uncatalogued"], "experimental-command", /--experimental/);
  usage(["untranslated", "s", "--catalog", "de.json", "--experimental"], "option-not-valid", /--uncatalogued/);
  usage(["untranslated", "s", "--catalog", "de.json", "--dynamic", "d.txt"], "option-not-valid", /--uncatalogued/);
  usage(["untranslated", "s", "--catalog", "de.json", "--boxes", "b"], "option-not-valid", /--uncatalogued/);
  usage(["check", "s", "--uncatalogued", "--experimental"], "option-not-valid");
});

test("uncatalogued: every locale's forms, siblings included, with wrong-language off; missing run strings and the cap stop the run (D50)", () => {
  // Value: protects=D50; fails_when=a sibling, base or .xcstrings locale is left out, the field depends on wrong-language, or a partial catalog set is judged; why_new=outside voice finding; seam=none; no_claim=core matching (UncataloguedTests)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-unc-"));
  const w = (rel, o) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), typeof o === "string" ? o : JSON.stringify(o)); };
  w("l/es.json", { a: "Guardar cambios", b: "Hola {name}" });
  w("l/es-MX.json", { a: "Guardar los cambios" });
  w("l/pt-BR.json", { a: "Salvar alterações" });
  w("en.json", { a: "Save changes" });
  const tpl = path.join(dir, "l/{locale}.json");
  const out = build(["--locale", "es", "--base", path.join(dir, "en.json"), "--catalog", tpl, "--uncatalogued", "--experimental", "--kinds", "uncatalogued"]);
  assert.equal(out.field.wrong_language, undefined, "wrong-language is off");
  const f = out.uncatalogued.field;
  assert.deepEqual(f.languages, ["en", "es", "es-MX", "pt-BR"]);
  assert.deepEqual(f.entries.map((e) => `${e.locale}:${e.key}`).sort(), ["en:a", "es-MX:a", "es:a", "es:b", "pt-BR:a"]);
  assert.deepEqual(f.entries.find((e) => e.key === "b").forms, [{ fragments: ["Hola"], lead: false, trail: true }]);
  assert.match(out.uncatalogued.digest, /^[0-9a-f]{32}$/);
  const dyn = tmp("dyn.txt", "# names\n^Hi, .+$\n");
  assert.deepEqual(build(["--locale", "es", "--catalog", tpl, "--uncatalogued", "--experimental", "--dynamic", dyn]).uncatalogued.field.dynamic, ["^Hi, .+$"]);
  assert.throws(() => build(["--locale", "fr", "--catalog", tpl, "--uncatalogued", "--experimental"]), (e) => e.code === "missing-catalog");
  // Real leg: the base file and the template's own base-locale file are both loaded, whatever the run locale.
  w("m/en.json", { c: "Fewer flashes" });
  w("m/es.json", { c: "Menos destellos" });
  const tplM = path.join(dir, "m/{locale}.json");
  for (const l of ["en", "es"]) {
    const keys = build(["--locale", l, "--base", path.join(dir, "en.json"), "--catalog", tplM, "--uncatalogued", "--experimental"]).uncatalogued.field.entries.map((e) => `${e.locale}:${e.key}`).sort();
    assert.deepEqual(keys, ["en:a", "en:c", "es:c"], l);
  }
  // Two files that share a key keep both strings.
  w("n/pl.json", { title: "USTAWIENIA" });
  w("o/pl.json", { title: "OPCJE" });
  const shared = build(["--locale", "pl", "--catalog", path.join(dir, "n/{locale}.json"), "--catalog", path.join(dir, "o/{locale}.json"), "--uncatalogued", "--experimental"]).uncatalogued.field.entries;
  assert.deepEqual(shared.map((e) => e.text).sort(), ["OPCJE", "USTAWIENIA"]);
  // MCP roots: a sibling outside them stops the run instead of judging against part of the catalogs.
  assert.throws(() => untranslated.build({ ...parse(["untranslated", "shot.png", "--locale", "es", "--catalog", tpl, "--uncatalogued", "--experimental"]), allowFile: (p) => !p.includes("pt-BR") }), (e) => e.code === "path-outside-root");
  w("l/de.json", Object.fromEntries(Array.from({ length: 40001 }, (_, i) => [`k${i}`, `Wort ${i}`])));
  assert.throws(() => build(["--locale", "es", "--catalog", tpl, "--uncatalogued", "--experimental"]), (e) => e.code === "catalog-too-large" || e.code === "catalog-too-many-strings");
  // Added by /ship coverage audit.
  // Value: protects=the uncatalogued entry cap itself (40000, Serve.uncataloguedEntries); fails_when=the cap check is dropped, so the core refuses every request instead of a usage error; why_new=the line above passes on the wrong-language cap; seam=none; no_claim=the core's cap (UncataloguedTests)
  assert.throws(() => build(["--locale", "es", "--catalog", tpl, "--uncatalogued", "--experimental", "--kinds", "uncatalogued"]), (e) => e.code === "catalog-too-large" && /strings for uncatalogued; the limit is 40000/.test(e.message));
});

test("uncatalogued: text rendering names the nearest string and the language", () => {
  // Value: protects=Check 4 text output; fails_when=nearest or language is dropped from the line; why_new=new kind; seam=none; no_claim=none
  const env = { path: "s.png", verdict: "fail", checks: [], warnings: [], findings: [] };
  const one = (f) => render.renderText({ ...env, findings: [{ kind: "uncatalogued", box: [0.1, 0.2, 0.3, 0.04], ...f }] })[1];
  assert.equal(one({ line: "Daily bonus!", language: null, nearest: { key: "bonus.daily", text: "Daily reward!", distance: 0.31 } }),
    '  uncatalogued "Daily bonus!" at [0.1, 0.2, 0.3, 0.04] (no catalog string; nearest @bonus.daily "Daily reward!", distance 0.31)');
  assert.equal(one({ line: "Tschüss Welt", language: "de", nearest: null }), '  uncatalogued "Tschüss Welt" at [0.1, 0.2, 0.3, 0.04] (no catalog string; de)');
});

test("client: a replaced core gets the cached uncatalogued field again, with this image's dynamic rects (D50, spec 17 D32)", () => {
  // Value: protects=D50 digest resend; fails_when=a core restarted after a vision-timeout gets only the uncatalogued digest and refuses every pending request (seen on the T4 synthetic rerun); why_new=bench failure; seam=Serve
  const { Server } = require("../src/client");
  const sent = [];
  const s = Object.assign(Object.create(Server.prototype), { digests: new Map(), proc: { stdin: { write: (l) => sent.push(JSON.parse(l)) } } });
  const full = { entries: [{ key: "a", locale: "en", text: "Settings", forms: [{ fragments: ["Settings"], lead: false, trail: false }] }], languages: ["en"], dynamic: [], allow: [], digest: "c1", dynamic_rects: [[0, 0, 1, 0.1]], dynamic_size: [390, 844] };
  s.send({ id: "0", command: "untranslated", uncatalogued: full });
  s.send({ id: "1", command: "untranslated", uncatalogued: { digest: "c1", dynamic_rects: [[0, 0.5, 1, 0.1]], dynamic_size: [390, 844] } }, true);
  s.send({ id: "2", command: "untranslated", uncatalogued: { digest: "c1" } });
  const { dynamic_rects: _r, dynamic_size: _s, ...catalogPart } = full;
  assert.deepEqual(sent[1].uncatalogued, { ...catalogPart, dynamic_rects: [[0, 0.5, 1, 0.1]], dynamic_size: [390, 844] });
  assert.deepEqual(sent[2].uncatalogued, { digest: "c1" }, "no resend: the live process has the digest");
});
