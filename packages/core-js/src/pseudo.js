// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// `catscan pseudo` (TODO-039 T1): a base catalog -> a pseudo-locale catalog, expanded, accented and bracketed.
// `.strings`, `strings.xml` and i18next JSON are rewritten span by span, so every byte outside a translatable
// value stays as it was (D2); `.xcstrings` is parsed and written back in Xcode's layout. Keys, placeholders,
// markup, escapes and plural keywords are never changed (spec "Never transformed").
const fs = require("fs");
const path = require("path");
const catalog = require("./catalog");
const { UsageError } = require("./args");
const { writeAtomic } = require("./results");

const { PRINTF, SUBSTITUTION, ICU_COMPLEX, SELECTOR, ICU_SIMPLE, MARKUP } = catalog.grammar;
const TAG = new RegExp(MARKUP.source, "y");

const PLACEHOLDER_WEIGHT = 6; // a placeholder counts as 6 visible characters (spec T1)
const ALREADY_PSEUDO = 0.9;

// T0: the safe map reads back at 0.997 folded; accents on every letter at 0.25 (results/spike-pseudo-ocr.txt).
const SAFE = mapOf("aceinosuyzACEINOSUYZ", "áçéíñöšüýžÁÇÉÍÑÖŠÜÝŽ");
// T0: Vietnamese vowels for the tall variant (0.878 folded); stacked combining marks read at 0.144.
const TALL = mapOf("aeiouyAEIOUY", "ẩệỉộữỹẨỆỈỘỮỸ");
const FILLER = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const RLO = "\u202E", PDF = "\u202C";
const ACCENTED = new RegExp(`[${[...Object.values(SAFE), ...Object.values(TALL)].join("")}]`);

function mapOf(from, to) {
  const m = {};
  const t = [...to];
  [...from].forEach((c, i) => { m[c] = t[i]; });
  return m;
}

const usage = (code, message, hint) => new UsageError(code, message, hint);

// ---- tokens -----------------------------------------------------------------------------------------
// A token is { t: "text", s } (transformed), { t: "keep", s, ph?, w } (copied; ph: a placeholder; w: visible
// width) or { t: "icu", pieces: [string | token[]] } (selectors kept, branch texts transformed).

const ENTITY = /&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z]\w*);/y;
// Escapes and other opaque runs per format, matched before anything else (raw file text, not decoded).
const OPAQUE = {
  // HTML entities stay whole: i18next and NSAttributedString values may be rendered as HTML (review fix).
  strings: [/\\(?:[Uu][0-9a-fA-F]{4}|[0-7]{1,3}|[\s\S])/y, ENTITY],
  json: [/\\(?:u[0-9a-fA-F]{4}|[\s\S])/y, ENTITY],
  android: [
    /<!--[\s\S]*?-->/y,
    /<!\[CDATA\[|\]\]>/y,
    /\\(?:u[0-9a-fA-F]{4}|[\s\S])/y,
    /&lt;\/?[A-Za-z][\w:.-]*(?:\s[^<>]{0,512}?)?\/?&gt;/y, // markup written as entities, e.g. in a CDATA-less HTML string
    ENTITY,
    /"/y, // Android's quoting character
    /%(?:n|(?:\d+\$)?[tT][A-Za-z])/y, // Java's %n and %tY date conversions, which the shared PRINTF grammar lacks
  ],
  xcstrings: [],
};
// Swift automatic grammar and Markdown link targets: `^[%lld apple](inflect: true)` keeps its attribute block.
const ATTRIBUTES = /\]\([^()\n]*\)/y;
const XLIFF = /<xliff:g\b[^>]*>[\s\S]*?<\/xliff:g>|<xliff:g\b[^>]*\/>/y;
const TEMPLATE = /\$\{\s*[A-Za-z_][\w.]*\s*\}/y;
const NESTING = /\$t\((?:[^()]|\([^()]*\))*\)/y; // one level of nested parens: $t(key, { n: f() })
const XC_ARG = /%(?:\d+\$)?arg/y;
const URL = /(?:https?:\/\/|www\.)[^\s<>"'\\]+/y;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/y;

function sticky(re, s, i) {
  re.lastIndex = i;
  const m = re.exec(s);
  return m ? m[0] : null;
}

function closers(s) {
  const close = new Int32Array(s.length).fill(-1);
  const stack = [];
  for (let j = 0; j < s.length; j++) {
    if (s[j] === "{") stack.push(j);
    else if (s[j] === "}" && stack.length) close[stack.pop()] = j;
  }
  return close;
}

/** Tokens of one raw value. `fmt` picks the escape grammar; `formatted: false` keeps `%` literal (Android). */
function tokenize(s, fmt, formatted = true, inPlural = false, depth = 0) {
  const out = [];
  const close = closers(s);
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", s: text }); text = ""; } };
  const keep = (str, ph = false, w = ph ? PLACEHOLDER_WEIGHT : str.length) => { flush(); out.push({ t: "keep", s: str, ph, w }); };
  let i = 0;
  outer: while (i < s.length) {
    for (const re of OPAQUE[fmt]) {
      const m = sticky(re, s, i);
      if (m) { keep(m, false, /^(?:<|\]\]>|"$)/.test(m) || m.startsWith("&lt;") ? 0 : 1); i += m.length; continue outer; }
    }
    const c = s[i];
    if (c === "<") {
      const x = sticky(XLIFF, s, i);
      if (x) { keep(x, true); i += x.length; continue; }
      const tag = sticky(TAG, s, i);
      if (tag) { keep(tag, false, /^<br\b/i.test(tag) ? 1 : 0); i += tag.length; continue; }
    }
    if (c === "$") {
      const m = sticky(TEMPLATE, s, i) || sticky(NESTING, s, i);
      if (m) { keep(m, true); i += m.length; continue; }
    }
    if (c === "{") {
      if (s.startsWith("{{", i)) {
        const end = s.indexOf("}}", i + 2);
        if (end >= 0) { keep(s.slice(i, end + 2), true); i = end + 2; continue; }
      }
      const stop = close[i];
      if (stop >= 0) {
        const inner = s.slice(i + 1, stop);
        const m = ICU_COMPLEX.exec(inner);
        if (m) {
          const icu = icuToken(s, i, stop, m, fmt, formatted, depth);
          // A malformed plural or select is kept whole, so its keywords are never accented.
          if (!icu) { keep(s.slice(i, stop + 1), true); i = stop + 1; continue; }
          flush(); out.push(icu); i = stop + 1; continue;
        }
        if (ICU_SIMPLE.test(inner)) { keep(s.slice(i, stop + 1), true); i = stop + 1; continue; }
      }
    }
    if (c === "%" && formatted) {
      if (s[i + 1] === "%") { keep("%%", false, 1); i += 2; continue; }
      const m = sticky(SUBSTITUTION, s, i) || sticky(PRINTF, s, i) || sticky(XC_ARG, s, i);
      if (m) { keep(m, true); i += m.length; continue; }
    }
    if (c === "#" && inPlural) { keep("#", true); i++; continue; }
    if (c === "]" && s[i + 1] === "(") {
      const m = sticky(ATTRIBUTES, s, i);
      if (m) { keep(m, false, 1); i += m.length; continue; }
    }
    if (c === "'" && depth > 0 && s[i + 1] === "'") { keep("''", false, 1); i += 2; continue; }
    if (!/[\w.+-]/.test(s[i - 1] ?? "")) {
      const m = sticky(URL, s, i) || sticky(EMAIL, s, i);
      if (m) { keep(m, false); i += m.length; continue; }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** `{n, plural, one {...} other {...}}`: selectors and braces kept, each branch tokenized on its own. */
function icuToken(s, open, stop, m, fmt, formatted, depth) {
  const b = m[3];
  const bOff = stop - b.length;
  const pieces = [s.slice(open, bOff)];
  const close = closers(b); // once per message: per branch it was quadratic in the branch count (review fix)
  let k = 0;
  for (;;) {
    let ws = k;
    while (k < b.length && /\s/.test(b[k])) k++;
    if (k >= b.length) { pieces.push(b.slice(ws)); break; }
    SELECTOR.lastIndex = k;
    const sel = SELECTOR.exec(b);
    if (!sel) return null;
    k += sel[0].length;
    if (sel[0].startsWith("offset:")) { pieces.push(b.slice(ws, k)); continue; }
    while (k < b.length && /\s/.test(b[k])) k++;
    if (b[k] !== "{") return null;
    const end = close[k];
    if (end < 0) return null;
    pieces.push(b.slice(ws, k + 1));
    pieces.push(tokenize(b.slice(k + 1, end), fmt, formatted, m[2] !== "select", depth + 1));
    pieces.push("}");
    k = end + 1;
  }
  pieces.push("}");
  return { t: "icu", pieces };
}

function width(tokens) {
  let n = 0;
  for (const tk of tokens) {
    if (tk.t === "text") n += [...tk.s].length;
    else if (tk.t === "keep") n += tk.w;
    else n += Math.max(0, ...tk.pieces.filter(Array.isArray).map(width));
  }
  return n;
}

function count(tokens, pred) {
  let n = 0;
  for (const tk of tokens) {
    if (tk.t === "icu") for (const p of tk.pieces) { if (Array.isArray(p)) n += count(p, pred); }
    else if (pred(tk)) n++;
  }
  return n;
}

const hasLetters = (tokens) => count(tokens, (tk) => tk.t === "text" && /\p{L}/u.test(tk.s)) > 0;

function render(tokens, map) {
  let out = "";
  for (const tk of tokens) {
    if (tk.t === "text") out += accent(tk.s, map);
    else if (tk.t === "keep") out += tk.s;
    else for (const p of tk.pieces) out += typeof p === "string" ? p : render(p, map);
  }
  return out;
}

const accent = (s, map) => s.replace(/[A-Za-z]/g, (c) => map[c] ?? c);

/**
 * One raw value -> { value, placeholders } or { skip: reason }. `ctx` is { fmt, formatted, expand, variant }.
 * Order (spec T1): expansion with filler words, then the accent map, then `[` `]` around the whole string.
 */
function transform(raw, ctx) {
  if (!raw.trim()) return { skip: "empty" };
  const tokens = tokenize(raw, ctx.fmt, ctx.formatted !== false);
  const placeholders = count(tokens, (tk) => tk.t === "keep" && tk.ph);
  if (!hasLetters(tokens) && !placeholders) {
    return { skip: count(tokens, (tk) => tk.t === "keep" && /^(?:https?:|www\.)|@/.test(tk.s)) ? "url" : "no-letters" };
  }
  const map = ctx.variant === "tall" ? TALL : SAFE;
  const body = render(tokens, map);
  const lead = /^\s*/.exec(body)[0];
  const trail = /\s*$/.exec(body.slice(lead.length))[0];
  const core = body.slice(lead.length, body.length - trail.length);
  if (ctx.inner) return { value: body, placeholders };
  const target = Math.ceil(width(tokens) * (1 + ctx.expand / 100));
  let w = width(tokens), filler = "";
  for (let k = 0; w < target; k++) {
    const word = FILLER[k % FILLER.length];
    filler += " " + accent(word, map);
    w += 1 + word.length;
  }
  const inner = core + filler;
  const wrapped = ctx.variant === "rtl" ? `${RLO}${inner}${PDF}` : inner;
  return { value: `${lead}[${wrapped}]${trail}`, placeholders };
}

/** Bracketed and accented already (or RLO-wrapped): what a pseudo catalog's values look like. */
function looksPseudo(raw) {
  const t = raw.trim();
  return t.startsWith("[") && t.endsWith("]") && (ACCENTED.test(t) || t.includes(RLO));
}

// ---- formats ----------------------------------------------------------------------------------------

/** Translatable value spans of a `.strings` file: [start, end) inside the quotes. */
function stringsSpans(text, skipped) {
  const spans = [];
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith("//", i)) { const e = text.indexOf("\n", i); i = e < 0 ? text.length : e + 1; }
      else if (text.startsWith("/*", i)) i = text.indexOf("*/", i + 2) + 2;
      else return;
    }
  };
  const literal = () => {
    if (text[i] === "\"") {
      const start = ++i;
      while (text[i] !== "\"") i += text[i] === "\\" ? 2 : 1;
      return [start, i++];
    }
    const m = /^[A-Za-z0-9_$.:/-]+/.exec(text.slice(i, i + 4096));
    i += m[0].length;
    return null;
  };
  for (;;) {
    skip();
    if (i >= text.length) break;
    literal();
    skip();
    if (text[i] === "=") {
      i++;
      skip();
      const span = literal();
      if (span) spans.push(span); else bump(skipped, "unquoted");
      skip();
    } else bump(skipped, "key-only");
    i++; // the `;`, which the loader has checked
  }
  return spans;
}

/** String value spans of a JSON document (object keys are not values). */
function jsonSpans(text) {
  const spans = [];
  let i = 0;
  const ws = () => { while (/[ \t\r\n]/.test(text[i] ?? "")) i++; };
  const str = () => {
    const start = ++i;
    while (text[i] !== "\"") i += text[i] === "\\" ? 2 : 1;
    return [start, i++];
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      const closeCh = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === closeCh) { i++; return; }
      for (;;) {
        if (c === "{") { ws(); str(); ws(); i++; }
        value();
        ws();
        if (text[i++] === ",") continue;
        return;
      }
    }
    if (c === "\"") { spans.push(str()); return; }
    i += /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 400))[0].length;
  };
  value();
  return spans;
}

const ANDROID_TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;

function attrsOf(s) {
  const a = {};
  for (const m of s.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[m[1]] = m[2] ?? m[3];
  return a;
}

/** Text spans of `<string>` and of `<item>` in `<plurals>` / `<string-array>`, each with its `formatted`. */
function androidSpans(text, skipped) {
  const spans = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "<") { const n = text.indexOf("<", i); i = n < 0 ? text.length : n; continue; }
    const skipTo = (open, closeStr) => (text.startsWith(open, i) ? text.indexOf(closeStr, i) + closeStr.length : -1);
    const past = [skipTo("<!--", "-->"), skipTo("<![CDATA[", "]]>"), skipTo("<?", "?>")].find((x) => x > 0);
    if (past) { i = past; continue; }
    if (text.startsWith("<!", i)) { i = text.indexOf(">", i) + 1; continue; }
    ANDROID_TAG.lastIndex = i;
    const m = ANDROID_TAG.exec(text);
    if (!m) { i++; continue; }
    const [whole, closing, name, attrText, selfClose] = m;
    if (closing) {
      const f = stack.pop();
      if (f && f.target) spans.push({ start: f.contentStart, end: i, formatted: f.formatted });
    } else if (!selfClose) {
      const attrs = attrsOf(attrText);
      const parent = stack[stack.length - 1];
      const depth = stack.length;
      const off = attrs.translatable === "false";
      let target = false, container = false;
      const formatted = (parent?.container ? parent.formatted : attrs.formatted !== "false");
      if (depth === 1 && name === "string") target = true;
      else if (depth === 1 && (name === "plurals" || name === "string-array")) container = true;
      else if (depth === 2 && name === "item" && parent.container) target = !parent.off;
      if ((target || container) && off) { bump(skipped, "translatable-false"); target = false; }
      stack.push({ name, target, container, off: off || parent?.off, formatted, contentStart: i + whole.length });
    }
    i += whole.length;
  }
  return spans.sort((a, b) => a.start - b.start);
}

function bump(o, k, n = 1) { o[k] = (o[k] || 0) + n; }

/** Applies `transform` to every span, from the end so earlier offsets hold. */
function rewrite(text, spans, ctx, stats) {
  let out = text;
  for (const sp of [...spans].reverse()) {
    const raw = text.slice(sp.start, sp.end);
    if (ctx.fmt === "android" && /^\s*"?\s*[@?]/.test(raw)) { bump(stats.skipped, "reference"); continue; }
    const r = transform(raw, { ...ctx, formatted: sp.formatted ?? true });
    if (r.skip) { bump(stats.skipped, r.skip); continue; }
    out = out.slice(0, sp.start) + r.value + out.slice(sp.end);
    stats.transformed++;
    stats.placeholders += r.placeholders;
  }
  return out;
}

/** Every `stringUnit.value` of a localization, through variations and substitutions, in a stable order. */
/** `inSub` marks a substitution form, which is spliced into its string rather than shown alone. */
function units(loc, visit, depth = 0, inSub = false) {
  if (!loc || typeof loc !== "object" || depth > 64) return;
  if (loc.stringUnit && typeof loc.stringUnit.value === "string") visit(loc.stringUnit, inSub);
  if (loc.variations && typeof loc.variations === "object") {
    for (const kind of Object.values(loc.variations)) if (kind && typeof kind === "object") for (const v of Object.values(kind)) units(v, visit, depth + 1, inSub);
  }
  if (loc.substitutions && typeof loc.substitutions === "object") for (const sub of Object.values(loc.substitutions)) units(sub, visit, depth + 1, true);
}

/** Xcode's own `.xcstrings` layout: 2-space indent, `" : "`, empty objects as `{\n\n}`. */
function xcodeJson(v, ind = "") {
  const next = ind + "  ";
  if (Array.isArray(v)) {
    if (!v.length) return `[\n\n${ind}]`;
    return `[\n${v.map((x) => next + xcodeJson(x, next)).join(",\n")}\n${ind}]`;
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return `{\n\n${ind}}`;
    return `{\n${keys.map((k) => `${next}${JSON.stringify(k)} : ${xcodeJson(v[k], next)}`).join(",\n")}\n${ind}}`;
  }
  return JSON.stringify(v);
}

function xcstrings(text, ctx, stats) {
  const data = JSON.parse(text);
  const source = typeof data.sourceLanguage === "string" ? data.sourceLanguage : "en";
  for (const [key, entry] of Object.entries(data.strings)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.shouldTranslate === false) { bump(stats.skipped, "should-translate-false"); continue; }
    const locs = entry.localizations && typeof entry.localizations === "object" ? entry.localizations : {};
    const srcName = Object.keys(locs).find((n) => n.toLowerCase() === source.toLowerCase());
    const loc = srcName ? structuredClone(locs[srcName]) : { stringUnit: { state: "translated", value: key } };
    let changed = 0;
    units(loc, (u, inSub) => {
      // A substitution form lands inside its string's markers, so it is only accented: `[[%arg ...]]` would nest.
      const r = transform(u.value, inSub ? { ...ctx, inner: true } : ctx);
      if (r.skip) { bump(stats.skipped, r.skip); return; }
      u.value = r.value;
      u.state = "translated";
      changed++;
      stats.transformed++;
      stats.placeholders += r.placeholders;
    });
    if (!changed) continue;
    // Replace the pseudo locale under its existing spelling, so `--locale en-xa` never adds a twin of `en-XA`.
    const locKey = Object.keys(locs).find((n) => n.toLowerCase() === ctx.locale.toLowerCase()) ?? ctx.locale;
    const merged = { ...locs, [locKey]: loc };
    entry.localizations = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  }
  return xcodeJson(data) + (text.endsWith("\n") ? "\n" : "");
}

/** One file on disk: macOS volumes are case-insensitive, so `EN.json` is `en.json` (review fix). */
function sameFile(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const x = fs.statSync(a), y = fs.statSync(b);
    return x.ino === y.ino && x.dev === y.dev;
  } catch { return false; } // the output does not exist yet
}

/** `.xcstrings`: refuses a locale that is the source language or already holds non-pseudo strings. */
function realLocale(text, file, locale) {
  const data = JSON.parse(text);
  const source = typeof data.sourceLanguage === "string" ? data.sourceLanguage : "en";
  const want = locale.toLowerCase();
  if (source.toLowerCase() === want) {
    throw usage("locale-is-source", `--locale ${locale} is the source language of ${file}; its strings would be replaced`, `catscan pseudo ${file} --in-place --locale en-XA`);
  }
  for (const entry of Object.values(data.strings)) {
    const locs = entry?.localizations ?? {};
    const name = Object.keys(locs).find((n) => n.toLowerCase() === want);
    if (!name) continue;
    let real = false;
    // Substitution forms are only accented, never bracketed, so only top-level values tell pseudo from real.
    // "[%lld]" (only placeholders) counts as pseudo, "[Entwurf]" (letters, no accent) as real.
    units(locs[name], (u, inSub) => {
      const v = u.value.trim();
      if (inSub || !/\p{L}/u.test(v) || looksPseudo(v)) return;
      const bare = v.startsWith("[") && v.endsWith("]") && !hasLetters(tokenize(v.slice(1, -1), "xcstrings"));
      if (!bare) real = true;
    });
    if (real) throw usage("locale-exists", `${file} already has real ${name} strings; a pseudo locale would replace them`, `catscan pseudo ${file} --in-place --locale en-XA`);
  }
}

/** Raw source values of the input, for the already-pseudo check. */
function sourceValues(format, text) {
  if (format === "xcstrings") {
    const data = JSON.parse(text);
    const source = (typeof data.sourceLanguage === "string" ? data.sourceLanguage : "en").toLowerCase();
    const out = [];
    for (const entry of Object.values(data.strings)) {
      const locs = entry?.localizations ?? {};
      const name = Object.keys(locs).find((n) => n.toLowerCase() === source);
      if (name) units(locs[name], (u, inSub) => { if (!inSub) out.push(u.value); });
    }
    return out;
  }
  return spans(format, text).map((sp) => text.slice(sp.start, sp.end));
}

/** Value spans of a `.strings`, i18next JSON or `strings.xml` text (tests check the bytes between them). */
function spans(format, text) {
  if (format === "json") return jsonSpans(text).map(([start, end]) => ({ start, end }));
  if (format === "strings") return stringsSpans(text, {}).map(([start, end]) => ({ start, end }));
  return androidSpans(text, {});
}

// ---- files ------------------------------------------------------------------------------------------

const LOCALE_NAME = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

/** `en-XA` -> `en-rXA`; anything else -> `b+` form (Android resource qualifiers). */
function androidQualifier(locale) {
  const p = locale.split("-");
  if (p.length === 1) return p[0];
  if (p.length === 2 && /^(?:[A-Za-z]{2}|\d{3})$/.test(p[1])) return `${p[0]}-r${p[1].toUpperCase()}`;
  return `b+${p.join("+")}`;
}

/** The default output path for each layout in the spec, or null. */
function defaultOutput(file, format, locale) {
  const dir = path.dirname(file), base = path.basename(file), parent = path.basename(dir);
  if (format === "json") {
    if (LOCALE_NAME.test(path.basename(base, path.extname(base)))) return path.join(dir, locale + path.extname(base));
    if (LOCALE_NAME.test(parent)) return path.join(path.dirname(dir), locale, base);
    return null;
  }
  if (format === "strings") return /\.lproj$/i.test(parent) ? path.join(path.dirname(dir), `${locale}.lproj`, base) : null;
  if (format === "android") {
    const m = /^(.*?)(?:^|[\\/])src[\\/][^\\/]+[\\/]res[\\/]values[\\/]([^\\/]+\.xml)$/.exec(file);
    if (!m) return null;
    return path.join(m[1] || ".", "src", "debug", "res", `values-${androidQualifier(locale)}`, m[2]);
  }
  return file; // xcstrings: in place
}

function encodingOf(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { bom: buf.subarray(0, 3), enc: "utf8" };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { bom: buf.subarray(0, 2), enc: "utf16le" };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { bom: buf.subarray(0, 2), enc: "utf16be" };
  if (buf.length >= 2 && (buf[0] === 0) !== (buf[1] === 0)) return { bom: Buffer.alloc(0), enc: buf[1] === 0 ? "utf16le" : "utf16be" };
  return { bom: Buffer.alloc(0), enc: "utf8" };
}

function encode(text, { bom, enc }) {
  if (enc === "utf16be") return Buffer.concat([bom, Buffer.from(text, "utf16le").swap16()]);
  return Buffer.concat([bom, Buffer.from(text, enc)]);
}

// TODO-039 T2 (D6, D12): the check step passes the one base catalog.
const CHECK = (file) => ({ step: "capture the screens, then check them", command: `catscan untranslated shots/ --pseudo --catalog ${/\s/.test(file) ? JSON.stringify(file) : file}` });

const SETUP = {
  strings: (locale) => ({ step: `launch the app in ${locale} (Xcode: scheme > Run > Arguments)`, command: `xcrun simctl launch booted <bundle-id> -AppleLanguages "(${locale})"` }),
  xcstrings: (locale) => SETUP.strings(locale),
  android: (locale) => ({ step: `build the debug variant, then switch the app to ${locale} (Android 13+)`, command: `adb shell cmd locale set-app-locales <package> --locales ${locale}` }),
  json: (locale) => ({ step: `open the app in ${locale} (i18next language detector)`, command: `<app-url>?lng=${locale}` }),
};

/**
 * Builds the pseudo catalog. `o` is { file, out, locale, expand, variant, inPlace, force }. Returns
 * { input, output, format, locale, variant, expand, transformed, skipped, placeholders, warnings, next, bytes }
 * without writing; `write()` writes it. Usage errors are thrown as UsageError (exit 2, D7).
 */
function generate(o) {
  const variant = o.variant ?? "accent";
  const locale = o.locale ?? (variant === "rtl" ? "ar-XB" : "en-XA");
  const expand = o.expand ?? 40; // German and Finnish run 30-40% longer than English (spec T1)
  const file = o.file;
  // The loader's own errors (missing file, unknown format, invalid file with line) are reused unchanged.
  const loaded = catalog.loadFile(file, "en");
  if (!loaded) throw usage("catalog-not-found", `no such catalog: ${file}`, "check the catalog path; it is read from the working directory");
  const { format } = loaded;
  // TODO-092 D7: a code catalog is read, never rewritten.
  if (format === "code") throw usage("format-not-supported", `${file} is a code catalog; pseudo writes JSON, .strings, .xcstrings and strings.xml catalogs only`, "pass a JSON base catalog (export the strings to locales/en.json), then load the pseudo file the same way");
  const buf = fs.readFileSync(file);
  const encoding = format === "xcstrings" || format === "json" ? { bom: Buffer.alloc(0), enc: "utf8" } : encodingOf(buf);
  const text = catalog.decode(buf, file, format === "strings");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) encoding.bom = buf.subarray(0, 3);

  let output = o.out ?? defaultOutput(file, format, locale);
  if (output === null) {
    const want = { json: "locales/en.json or locales/en/<namespace>.json", strings: "<lang>.lproj/<name>.strings", android: "src/<source-set>/res/values/<name>.xml" }[format];
    throw usage("output-path-unknown", `${file} is not in a layout catscan knows (${want}); say where the ${locale} catalog goes`, `catscan pseudo ${file} --out <path>`);
  }
  if (o.inPlace && format !== "xcstrings") {
    throw usage("option-not-valid", `--in-place works only with .xcstrings; ${file} is ${format === "android" ? "strings.xml" : format === "json" ? "i18next JSON" : ".strings"} and gets its own pseudo file`, `catscan pseudo ${file}`);
  }
  const same = sameFile(output, file);
  if (format === "xcstrings" && same && !o.inPlace) {
    throw usage("in-place-required", `${file} holds every locale, so the ${locale} localization is written into it; pass --in-place to change it (or --out <copy.xcstrings>)`, `catscan pseudo ${file} --in-place`);
  }
  if (o.inPlace && !same) {
    throw usage("conflicting-options", `--in-place writes ${file} itself; --out ${output} names another file`, `catscan pseudo ${file} --in-place (or --out ${output} alone)`);
  }
  // The pseudo catalog must never replace real strings: not the input file, not the source or a translated locale.
  if (format !== "xcstrings" && same) {
    throw usage("output-is-input", `the pseudo catalog would overwrite its input ${file}`, `catscan pseudo ${file} --locale en-XA (or --out <path>)`);
  }
  if (format === "xcstrings") realLocale(text, file, locale);
  if (!(format === "xcstrings" && same) && fs.existsSync(output) && !o.force) {
    throw usage("output-exists", `${output} already exists`, `catscan pseudo ${file} --force (or --out <path>)`);
  }

  const ctx = { fmt: format, expand, variant, locale };
  // Only strings the generator would transform count: URLs and digits never carry markers.
  const values = sourceValues(format, text).filter((v) => !transform(v, ctx).skip);
  const pseudoCount = values.filter(looksPseudo).length;
  if (values.length && pseudoCount / values.length >= ALREADY_PSEUDO) {
    throw usage("already-pseudo", `${pseudoCount} of ${values.length} strings in ${file} are already bracketed and accented; this looks like a pseudo catalog`, "pass the base catalog, such as locales/en.json");
  }

  const stats = { transformed: 0, skipped: {}, placeholders: 0 };
  let result;
  if (format === "xcstrings") result = xcstrings(text, ctx, stats);
  else if (format === "json") result = rewrite(text, jsonSpans(text).map(([start, end]) => ({ start, end })), ctx, stats);
  else if (format === "strings") result = rewrite(text, stringsSpans(text, stats.skipped).map(([start, end]) => ({ start, end })), ctx, stats);
  else result = rewrite(text, androidSpans(text, stats.skipped), ctx, stats);

  const warnings = [];
  let siblings = [];
  try { siblings = fs.readdirSync(path.dirname(file)); } catch { /* the catalog was readable; a listing is best effort */ }
  const dicts = siblings.filter((f) => f.toLowerCase().endsWith(".stringsdict"));
  if (dicts.length) {
    warnings.push({ code: "stringsdict-skipped", message: `${dicts.join(", ")} next to ${path.basename(file)} ${dicts.length === 1 ? "is" : "are"} not transformed; catscan does not read .stringsdict, so ${dicts.length === 1 ? "its" : "their"} plural strings stay in the base language`, hint: "move the plurals into a String Catalog (.xcstrings)" });
  }
  return {
    input: file, output, format, locale, variant, expand,
    transformed: stats.transformed, skipped: stats.skipped, placeholders: stats.placeholders,
    warnings, next: [SETUP[format](locale), CHECK(file)],
    bytes: encode(result, encoding),
  };
}

/** Atomic, so a failed write never truncates the catalog an `--in-place` run rewrites. */
function write(r) {
  fs.mkdirSync(path.dirname(r.output), { recursive: true });
  // Only the `--in-place` catalog follows a symlink to its target; any other output keeps writeAtomic's guard
  // against a planted symlink.
  const target = sameFile(r.output, r.input) ? fs.realpathSync(r.output) : r.output;
  writeAtomic(target, r.bytes, "output-write-failed", "the pseudo catalog", "check that the folder is writable, or pass --out <path>");
}

/** The one-line summary (D6). */
function summary(r) {
  const skippedTotal = Object.values(r.skipped).reduce((a, b) => a + b, 0);
  const why = Object.entries(r.skipped).sort().map(([k, n]) => `${n} ${k}`).join(", ");
  return `catscan pseudo: ${r.transformed} string${r.transformed === 1 ? "" : "s"} transformed, ${skippedTotal} skipped${why ? ` (${why})` : ""}, ${r.placeholders} placeholder${r.placeholders === 1 ? "" : "s"} kept -> ${r.output}`;
}

function json(r) {
  const { bytes, ...rest } = r;
  return { command: "pseudo", ...rest };
}

module.exports = { generate, write, summary, json, transform, tokenize, spans, defaultOutput, androidQualifier, looksPseudo, SAFE, TALL, FILLER };
