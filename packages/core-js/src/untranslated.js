// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// `catscan untranslated` (spec 17): catalogs in, the core's `untranslated` request field out (D28).
// Matching and every rule run in the core (D1); this module only loads and pairs the strings.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { UsageError, LOCALE_RE } = require("./args");
const catalog = require("./catalog");
const pseudoField = require("./pseudo-field");
const tag = (l) => l.toLowerCase().replace(/_/g, "-");

const MAX_ALLOW_BYTES = 1024 * 1024;

/** One string per line, fine in any language; blank lines and `#` comments are dropped (D7, D26). */
function loadAllow(file) {
  let buf;
  try {
    if (fs.statSync(file).size > MAX_ALLOW_BYTES) throw new UsageError("allow-too-large", `the allow list ${file} is over 1 MB`, "keep brand names and product terms only");
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError("allow-not-found", `cannot read the allow list ${file}: ${e.code || e.message}`, "check the --allow path; it is read from the working directory");
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch {
    throw new UsageError("invalid-allow", `the allow list ${file} is not UTF-8`, "save it as UTF-8, one string per line");
  }
  return text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

const MAX_FIELD_BYTES = 32 * 1024 * 1024;
// TODO-012 D1: the same caps as `Untranslated.caps` in the core (a unit test compares them).
const CAPS = { pairs: 20000, targets: 20000, alternatives: 256, fragments: 256 };

/** Throws `catalog-too-many-strings` when the field asks for more matching work than the core accepts (TODO-012 D2). */
function checkCaps(field) {
  const tooMany = (what, limit) => new UsageError("catalog-too-many-strings", `${what}; the limit is ${limit}`, "pass only the catalogs the screens use");
  if (field.pairs.length > CAPS.pairs) throw tooMany(`the catalogs give ${field.pairs.length} key pairs to check`, CAPS.pairs);
  if (field.targets.length > CAPS.targets) throw tooMany(`the target catalogs give ${field.targets.length} string forms`, CAPS.targets);
  const alts = (where, list) => {
    const forms = list.filter((a) => a.length).length; // empty forms (placeholder-only) are not counted, as in the loader
    if (forms > CAPS.alternatives) throw tooMany(`${where} has ${forms} forms`, CAPS.alternatives);
    const total = list.reduce((n, a) => n + a.length, 0); // the loader's rule: 256 fragments over all forms (D5)
    if (total > CAPS.fragments) throw tooMany(`${where} has ${total} fragments`, CAPS.fragments);
  };
  for (const p of field.pairs) { alts(`the base string of ${p.key}`, p.base_alternatives); alts(`the target string of ${p.key}`, p.target_alternatives); }
  const perLocale = new Map(); // D32: one entry per file, the cap per locale
  for (const o of field.wrong_language?.others || []) perLocale.set(o.locale, (perLocale.get(o.locale) || 0) + o.pairs.length);
  for (const [l, n] of perLocale) if (n > CAPS.pairs) throw tooMany(`the ${l} catalogs give ${n} key pairs to check`, CAPS.pairs);
  for (const o of field.wrong_language?.others || []) {
    for (const p of o.pairs) alts(`the ${o.locale} string of ${p.key}`, p.base_alternatives);
  }
  const big = field.targets.find((a) => a.length > CAPS.fragments);
  if (big) throw tooMany(`a target string form has ${big.length} fragments`, CAPS.fragments);
}
const hasText = (e) => !e.reason && e.alternatives.some((a) => a.length > 0);

const SLOT_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const same = (a, b) => tag(a) === tag(b);
// TODO-036 D32: a parent or sibling regional locale is the run language (pt beside pt-BR, es beside es-MX): a key
// missing from the regional file falls back to it at runtime, so its strings are never wrong-language evidence.
// Sibling regions are kin on purpose (precision over recall: es-MX falls back to es-419). A different script stays
// apart (sr-Latn and sr-Cyrl; Traditional and Simplified Chinese, as `nl()` keeps them), and the core's aliases
// are one language (no/nb/nn, iw/he).
const ALIAS = { nb: "no", nn: "no", iw: "he", in: "id", ji: "yi" };
const primary = (l) => { const p = tag(l).split("-")[0]; return ALIAS[p] || p; };
const script = (l) => {
  const parts = tag(l).split("-");
  const s = parts.slice(1).find((x) => /^[a-z]{4}$/.test(x));
  if (s) return s;
  if (parts[0] === "yue" || (parts[0] === "zh" && parts.slice(1).some((x) => ["tw", "hk", "mo"].includes(x)))) return "hant";
  return parts[0] === "zh" ? "hans" : null;
};
const kin = (a, b) => primary(a) === primary(b) && script(a) === script(b);

/** The locales a `{locale}` template has files for on disk: the text in the `{locale}` slot of each match (D4). */
function localesOnDisk(spec) {
  const parts = path.resolve(spec.split("{locale}").join("\u0000")).split(path.sep);
  const at = parts.findIndex((p) => p.includes("\u0000"));
  if (at < 0) return [];
  const dir = parts.slice(0, at).join(path.sep) || path.sep;
  const [pre, post] = [parts[at].slice(0, parts[at].indexOf("\u0000")), parts[at].slice(parts[at].indexOf("\u0000") + 1)];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.startsWith(pre) || !n.endsWith(post) || n.length <= pre.length + post.length) continue;
    const l = n.slice(pre.length, n.length - post.length);
    if (!SLOT_RE.test(l)) continue;
    try { if (fs.statSync(spec.split("{locale}").join(l)).isFile()) out.push(l); } catch { /* the rest of the path is missing */ }
  }
  return out.sort();
}

// TODO-092 D6: a capped string or a value a code catalog cannot read has no text to compare.
const unreadable = (t) => t && (t.reason === "catalog-string-capped" || t.reason === "catalog-value-dynamic");
// TODO-092 D11: one file that holds several locales: an .xcstrings, or a code catalog with locale-named exports.
const isXc = (c) => path.extname(c).toLowerCase() === ".xcstrings";
const fileLocales = (c) => (isXc(c) ? xcstringsLocales(c) : catalog.codeLocales(c));
const isMulti = (c) => c.includes("{locale}") || isXc(c) || Boolean(catalog.codeLocales(c));

/** The localizations of an .xcstrings catalog, its source language included (D25). */
function xcstringsLocales(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const set = new Set(typeof data.sourceLanguage === "string" ? [data.sourceLanguage] : []);
    for (const e of Object.values(data.strings || {})) for (const l of Object.keys((e && e.localizations) || {})) set.add(l);
    return [...set].filter((l) => SLOT_RE.test(l)).sort();
  } catch { return []; }
}

/**
 * TODO-036 T2: the `wrong_language` part of the field. Catalog evidence needs a `{locale}` template or an .xcstrings
 * file and the run locale's own strings (D25, D27); language ID needs any project language besides the run one.
 * Every envelope says so when either cannot run (D17).
 */
function wrongLanguage(opts, { locale, baseLocale, base, target, field, runWarnings }) {
  if (opts.kinds && !opts.kinds.includes("wrong-language")) return;
  const multi = opts.catalogs.filter(isMulti);
  const found = new Set();
  for (const c of multi) for (const l of (c.includes("{locale}") ? localesOnDisk(c) : fileLocales(c))) found.add(l);
  const languages = new Set([...found, ...(opts.languages || [])]);
  if (base) languages.add(baseLocale);
  for (const l of [...languages]) if (kin(l, locale)) languages.delete(l);
  const hint = "--catalog 'locales/{locale}.json' or --languages es,pt-BR";
  if (!languages.size) {
    runWarnings.push({ code: "wrong-language-unchecked", message: `no other project language is known, so lines in another language than ${locale} were not checked`, hint });
    return;
  }
  const wl = { languages: [...languages].sort(), others: [] };
  field.wrong_language = wl;
  if (!multi.length) return; // language ID only (--languages)
  // D27: the run locale has a catalog only when one of its keys has text in it.
  // An .xcstrings must list the run localization itself (exact tag or its language, as the loader picks it):
  // `shouldTranslate: false` keys give every locale the source text.
  const listed = (c) => fileLocales(c).some((l) => same(l, locale) || same(l, locale.split(/[-_]/)[0]));
  const runHasText = target && [...target.keys.values()].some(hasText) && multi.filter((c) => !c.includes("{locale}")).every(listed);
  if (!runHasText) {
    const file = multi[0].split("{locale}").join(locale);
    runWarnings.push({ code: "wrong-language-unchecked", message: `no ${locale} strings in ${file}, so wrong-language matched no catalog and used language ID only`, hint: "add the run locale's catalog, or pass --locale for a locale that has one" });
    return;
  }
  const runFile = opts.catalogs[opts.catalogs.length - 1].split("{locale}").join(locale);
  // A string equal to the base string for its key is a base string: rule 1 judges it (D26), with spec 17's length
  // rule, so `OK` shared by en and ja never names ja on a ko screen.
  // D32: under MCP every sibling file passes the roots check the run locale's file passed (opts.allowFile).
  const inside = (l) => !opts.allowFile || multi.every((c) => !c.includes("{locale}") || opts.allowFile(c.split("{locale}").join(l)));
  const skipped = (l, why) => runWarnings.push({ code: "wrong-language-unchecked", message: `the ${l} catalog ${why}, so its strings were not matched`, hint: "fix the file, or pass --kinds untranslated,raw-key,placeholder" });
  let baseKeys = base ? base.keys : null;
  if (!baseKeys && inside(baseLocale) && [...found].some((l) => same(l, baseLocale))) { try { baseKeys = catalog.loadAll(multi, baseLocale).keys; } catch { /* no base to compare */ } }
  const plain = (t) => t.trim().toLowerCase();
  for (const l of [...found].sort()) {
    if (kin(l, locale) || (base && same(l, baseLocale))) continue; // D32; D26: rule 1 already judges base strings
    if (!inside(l)) { skipped(l, "is outside the allowed roots"); continue; }
    let other;
    try { other = catalog.loadAll(multi, l); } catch (e) { skipped(l, `could not be read (${e.message})`); continue; }
    // D32: one entry per file, so evidence_catalog names the file that holds the matched string.
    const byFile = new Map();
    for (const e of other.keys.values()) {
      if (!hasText(e)) continue;
      const b = !same(l, baseLocale) && baseKeys?.get(e.key);
      if (b && hasText(b) && plain(b.text) === plain(e.text)) continue;
      const t = target.keys.get(e.key);
      if (unreadable(t) || (!t && catalog.isOpen(target, e.key))) continue;
      if (!byFile.has(e.catalog)) byFile.set(e.catalog, []);
      const has = t && t.text.trim() && hasText(t);
      byFile.get(e.catalog).push({ key: e.key, catalog: t?.catalog ?? runFile, base: e.text, expected: has ? t.text : null, base_alternatives: e.alternatives, target_alternatives: has ? t.alternatives : [] });
    }
    for (const [file, pairs] of byFile) wl.others.push({ locale: l, catalog: file, pairs });
  }
  if (!base && wl.others.some((o) => same(o.locale, baseLocale))) wl.preferred = wl.others.find((o) => same(o.locale, baseLocale)).locale;
}

/**
 * Returns { field, warnings, runWarnings }: `field` is the request's `untranslated` object, `warnings` the
 * loaders' own (printed once), `runWarnings` the ones every envelope carries (D27).
 */
// TODO-036 T4 (D50): the core's cap on uncatalogued entries (Serve.uncataloguedEntries), 13 catalogs of 1,100 fit.
const UNCATALOGUED_ENTRIES = 40000;

/**
 * TODO-036 T4 (D50, D51): the `uncatalogued` request field: every catalog form of every loaded locale (the run
 * locale, the base, every `{locale}` file including regional siblings, every .xcstrings localization), whether or
 * not wrong-language runs, with the `--dynamic` patterns and `--allow`. A run that cannot carry all of them stops
 * (exit 2) rather than judging lines against part of the catalogs. Returns { field, bytes, digest }.
 */
function uncataloguedField(opts, { locale, baseLocale, base, target, allow }) {
  const runHasText = target && !target.missing.length && [...target.keys.values()].some(hasText);
  if (!runHasText) {
    throw new UsageError("missing-catalog", `--uncatalogued needs ${locale} strings, and ${opts.catalogs.join(", ")} has none for ${locale}`, "pass the run locale's catalog with --catalog, or --locale for a locale that has one");
  }
  // Every file is loaded on its own, so two files that share a key keep both strings (real leg: `settings.title`
  // in two apps), and the base file sits beside the run locale's own files, never over them.
  const multi = opts.catalogs.filter(isMulti);
  const load = (files, l) => {
    try { return catalog.loadAll(files, l); } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new UsageError("catalog-unreadable", `the ${l} catalog could not be read (${e.message}), so uncatalogued cannot see its strings`, "fix the file, or drop --uncatalogued");
    }
  };
  const loaded = new Map([[tag(locale), opts.catalogs.map((c) => ({ locale, cat: load([c], locale) }))]]);
  if (base) loaded.set(tag(baseLocale), [...(loaded.get(tag(baseLocale)) || []), { locale: baseLocale, cat: base }]);
  const found = new Set();
  for (const c of multi) for (const l of (c.includes("{locale}") ? localesOnDisk(c) : fileLocales(c))) found.add(l);
  for (const l of [...found].sort()) {
    if (tag(l) === tag(locale)) continue; // the run locale's files are loaded above
    for (const c of multi) {
      if (!c.includes("{locale}") || !opts.allowFile) continue;
      const f = c.split("{locale}").join(l);
      if (!opts.allowFile(f)) throw new UsageError("path-outside-root", `the ${l} catalog ${f} is outside the allowed roots, so uncatalogued cannot see its strings`, "keep every locale's catalog under one root");
    }
    loaded.set(tag(l), [...(loaded.get(tag(l)) || []), ...multi.map((c) => ({ locale: l, cat: load([c], l) }))]);
  }
  const entries = [];
  for (const { locale: l, cat } of [...loaded.values()].flat()) {
    for (const e of cat.keys.values()) {
      if (e.reason) continue;
      const forms = e.alternatives.map((a, i) => ({ fragments: a, ...pseudoField.edges(e, i) })).filter((f) => f.fragments.length);
      if (forms.length) entries.push({ key: e.key, locale: l, text: e.text, forms });
    }
  }
  if (entries.length > UNCATALOGUED_ENTRIES) {
    throw new UsageError("catalog-too-large", `the catalogs give ${entries.length} strings for uncatalogued; the limit is ${UNCATALOGUED_ENTRIES}`, "pass only the catalogs the screens use");
  }
  const field = {
    entries, languages: [...loaded.values()].map((v) => v[0].locale).sort(),
    dynamic: opts.dynamic ? pseudoField.loadDynamic(opts.dynamic) : [], allow,
  };
  const json = JSON.stringify(field);
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_FIELD_BYTES) throw new UsageError("catalog-too-large", `the catalogs make an uncatalogued request of over ${MAX_FIELD_BYTES / 1024 / 1024} MB`, "pass only the catalogs the screens use");
  return { field, bytes, digest: crypto.createHash("sha256").update(json).digest("hex").slice(0, 32) };
}

function build(opts) {
  const out = fields(opts);
  // TODO-039 T2: the pseudo field rides on the same first serve line.
  const size = () => Buffer.byteLength(JSON.stringify(out.field)) + (out.pseudo ? out.pseudo.bytes : 0) + (out.uncatalogued ? out.uncatalogued.bytes : 0);
  out.bytes = size();
  // TODO-036 D32: catalog evidence never fails a run that fits without it; wrong-language falls back to language ID.
  const wl = out.field.wrong_language;
  const fits = () => { try { checkCaps({ pairs: [], targets: [], wrong_language: wl }); return true; } catch (e) { if (e instanceof UsageError) return false; throw e; } };
  if (wl?.others.length && (out.bytes > MAX_FIELD_BYTES || !fits())) {
    wl.others = [];
    delete wl.preferred;
    out.runWarnings.push({ code: "wrong-language-unchecked", message: "the other locales' catalogs make the request too large, so wrong-language matched no catalog and used language ID only", hint: "pass only the catalogs the screens use, or --kinds untranslated,raw-key,placeholder" });
    out.bytes = size();
  }
  const json = JSON.stringify(out.field);
  // The field rides on the first serve line (64 MB limit); base and target load against separate caps.
  if (out.bytes > MAX_FIELD_BYTES) throw new UsageError("catalog-too-large", `the catalogs make an untranslated request of over ${MAX_FIELD_BYTES / 1024 / 1024} MB`, "pass only the catalogs the screens use");
  checkCaps(out.field);
  out.digest = crypto.createHash("sha256").update(json).digest("hex").slice(0, 32);
  return out;
}

function fields(opts) {
  const locale = opts.locale ?? "en";
  const warnings = [];
  const runWarnings = [];
  const allow = opts.allow ? loadAllow(opts.allow) : [];
  // An .xcstrings sourceLanguage is file content: one that is not a locale tag falls back to en.
  const source = opts.base ? catalog.xcstringsSource(opts.base) : null;
  const baseLocale = opts.baseLocale ?? (source && LOCALE_RE.test(source) ? source : null) ?? "en";
  const target = opts.catalogs.length ? catalog.loadAll(opts.catalogs, locale) : null;
  const base = opts.base ? catalog.loadAll([opts.base], baseLocale) : null;
  for (const c of [base, target]) if (c) warnings.push(...c.warnings.filter((w) => w.code !== "catalog-missing"));

  const field = { base_locale: baseLocale, pairs: [], targets: [], keys: [], texts: [], styles: [], allow };
  if (opts.kinds) field.kinds = opts.kinds;
  const loaded = [base, target].filter(Boolean);
  const texts = new Set();
  for (const c of loaded) for (const e of c.keys.values()) for (const t of e.text.split(" | ")) texts.add(t.trim());
  // TODO-031: every catalog string, so the core never reads a shown string as a key with a misread separator. The
  // rendered fragments ride along too: `<b>game over</b>` is shown as `game over`.
  const shown = new Set(texts);
  for (const c of loaded) for (const e of c.keys.values()) for (const a of e.alternatives) for (const f of a) shown.add(f.trim());
  // An exact key counts as a raw key only when it cannot be shown text itself (iOS keys-as-text, D6): markup dropped
  // (`"OK" = "<b>OK</b>"`), and a fragment counts, since Vision reads `250` and `coins` of `{count} coins` apart.
  const keys = new Set();
  for (const c of loaded) for (const k of c.keys.keys()) if (!/\s/.test(k) && !shown.has(k)) keys.add(k);
  field.keys = [...keys].sort();
  field.texts = [...shown].filter(Boolean).sort();
  field.styles = [...new Set(loaded.flatMap((c) => [...c.styles]))].sort();
  if (target) for (const e of target.keys.values()) if (hasText(e)) field.targets.push(...e.alternatives.filter((a) => a.length));
  if (!opts.pseudo) wrongLanguage(opts, { locale, baseLocale, base, target, field, runWarnings });
  const unc = opts.uncatalogued && !opts.pseudo ? uncataloguedField(opts, { locale, baseLocale, base, target, allow }) : null;
  const done = (r) => (unc ? { ...r, uncatalogued: unc } : r);
  // TODO-039 T2 (D12): the one --catalog is the base; its strings are the hardcoding signal, so the base-string
  // rule is off (no pairs) and untranslated-base-catalog is never emitted.
  if (opts.pseudo) {
    if (target?.missing.length) runWarnings.push({ code: "catalog-missing", message: `no catalog for the locale ${locale}: ${target.missing.join(", ")}; pseudo checks have no strings`, hint: "pass the base catalog file itself with --catalog" });
    return { field, warnings, runWarnings, pseudo: pseudoField.build(target, opts, allow) };
  }
  if (!base) {
    if (target?.missing.length) runWarnings.push({ code: "catalog-missing", message: `no catalog for the locale ${locale}: ${target.missing.join(", ")}; its keys are not checked as raw keys`, hint: "add the file, or pass --locale for a locale that has one" });
    return done({ field, warnings, runWarnings });
  }

  // File identity, not spelling: a symlink, hard link or case alias of the base is the base.
  const resolved = (spec, l) => { const f = path.resolve(spec.split("{locale}").join(l)); try { const st = fs.statSync(f); return `${st.dev}:${st.ino}`; } catch { return f; } };
  const missing = [...base.missing, ...target.missing];
  if (missing.length) {
    runWarnings.push({ code: "catalog-missing", message: `no catalog for the locale ${locale}: ${missing.join(", ")}; the untranslated rule was skipped`, hint: "add the file, or pass --locale for a locale that has one" });
    return done({ field, warnings, runWarnings });
  }
  // D22: the same file read for the same locale compares a catalog with itself.
  const xc = isXc(opts.base) || Boolean(catalog.codeLocales(opts.base));
  // The base file read for the same locale is no target (zh-Hant against a zh-Hans source is). With several
  // --catalog files a string merged from the base is a missing translation, so its pair gets expected: null.
  const self = (c) => resolved(c, locale) === resolved(opts.base, baseLocale) && (!xc || tag(locale) === tag(baseLocale));
  if (opts.catalogs.every(self)) {
    runWarnings.push({ code: "untranslated-base-catalog", message: `the target catalog is the base catalog ${opts.base} for the locale ${locale}; the untranslated rule is off`, hint: "pass the translated catalog with --catalog, or --locale for a translated locale" });
    return done({ field, warnings, runWarnings });
  }
  for (const e of base.keys.values()) {
    if (!hasText(e)) continue; // capped, a reference with no text, or no checkable string (D15)
    const t = target.keys.get(e.key);
    // TODO-092 D18: a key the target may define under a spread or a dynamic value is unknown, not missing.
    if (!t && catalog.isOpen(target, e.key)) continue;
    const own = t && !self(t.catalog) ? t.catalog : null;
    const pair = { key: e.key, catalog: own ?? opts.catalogs[opts.catalogs.length - 1].split("{locale}").join(locale), base: e.text, expected: null, base_alternatives: e.alternatives, target_alternatives: [] };
    if (unreadable(t)) continue;
    if (t && t.reason !== "catalog-missing" && !self(t.catalog)) {
      // An empty target ("" in a .strings or TMS export, an xcstrings "new" unit) is no string: the classic
      // fallback, flagged with expected: null (D2). A target with only placeholders is a real translation.
      if (!t.text.trim()) { field.pairs.push(pair); continue; }
      if (!hasText(t)) continue;
      pair.expected = t.text;
      pair.target_alternatives = t.alternatives;
    }
    field.pairs.push(pair);
  }
  // en-GB read from an .xcstrings with no en-GB strings falls back to the source: nothing would be checked.
  if (field.pairs.length && field.pairs.every((p) => p.expected === p.base)) {
    runWarnings.push({ code: "untranslated-base-catalog", message: `every ${locale} string in ${opts.catalogs.join(", ")} equals its base string; the untranslated rule checks nothing`, hint: "pass the translated catalog with --catalog, or --locale for a translated locale" });
    field.pairs = [];
  }
  return done({ field, warnings, runWarnings });
}

module.exports = { build, loadAllow, checkCaps, localesOnDisk, xcstringsLocales, CAPS, MAX_ALLOW_BYTES, MAX_FIELD_BYTES };
