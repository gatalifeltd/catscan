// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// `--catalog` and `@key` (spec 02): reads localization catalogs and turns each string into raw fragments.
// The core normalizes the fragments, drops the short ones and matches them (spec 02 D1).
const fs = require("fs");
const path = require("path");
const xml = require("./xml");
const code = require("./code-catalog");
const { UsageError, editDistance } = require("./args");

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = code.MAX_TOTAL_BYTES; // D8: serialized catalog checks, so a request stays under the 64 MB serve line
const MAX_FRAGMENTS = 256;
const MAX_DEPTH = 4;
const MAX_REF_HOPS = 4; // D16
const MAX_STRING = 64 * 1024; // one UI string; longer values are skipped as capped, bounding expansion memory
const MAX_NESTING = 64; // JSON objects, .xcstrings variations, XML elements: past this a catalog is not real
// A lone UTF-16 surrogate cannot cross to the Swift core as JSON (same trap as expect.js).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const SPLIT = 0; // a placeholder: the text on either side becomes separate fragments
// printf-style: %@ %d %s %1$s %.2f %lld ... (`%%` is a literal %, D3)
const PRINTF = /%(?:\d+\$)?[-+#0']*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|h|ll|l|L|q|j|z|t)?[@dDiuUxXoOfFeEgGcCsSpaA]/y;
const SUBSTITUTION = /%(?:\d+\$)?#@([^@\s]+)@/y; // .xcstrings substitution (D15)
const ICU_COMPLEX = /^\s*([^\s,{}]+)\s*,\s*(plural|selectordinal|select)\s*,([\s\S]*)$/;
const SELECTOR = /offset:\s*\d+|[^\s{}]+/y;
const ICU_SIMPLE = /^\s*[\w.$-]+\s*(?:,[^{}]*)?$/;
// A tag: a name, then only name="value" attributes, so prose such as "a <b and c> d" is kept.
const MARKUP = /<\/?([A-Za-z][\w:.-]*|\d+)(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/g;

class Capped extends Error {}

function err(code, message, hint) { return new UsageError(code, message, hint); }

function position(text, index) {
  const before = text.slice(0, index).split("\n");
  return `${before.length}:${before[before.length - 1].length + 1}`;
}

function invalid(file, where, message) {
  return err("invalid-catalog", `${file}:${where}: ${message}`, "fix the catalog file; it must be UTF-8, or UTF-16 with a BOM");
}

/** Bytes to text: a UTF-8 or UTF-16 BOM decides; `.strings` without a BOM may still be UTF-16. */
function decode(buf, file, allowBomlessUtf16) {
  let enc = "utf-8", start = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  else if (buf[0] === 0xff && buf[1] === 0xfe) { enc = "utf-16le"; start = 2; }
  else if (buf[0] === 0xfe && buf[1] === 0xff) { enc = "utf-16be"; start = 2; }
  else if (allowBomlessUtf16 && buf.length >= 2 && (buf[0] === 0) !== (buf[1] === 0)) enc = buf[1] === 0 ? "utf-16le" : "utf-16be";
  let body = buf.subarray(start);
  if (enc === "utf-16be") {
    body = Buffer.from(body);
    if (body.length % 2) throw invalid(file, "1:1", "odd number of bytes for UTF-16");
    body.swap16();
    enc = "utf-16le";
  }
  try {
    return new TextDecoder(enc, { fatal: true }).decode(body);
  } catch {
    throw invalid(file, "1:1", `not valid ${enc === "utf-8" ? "UTF-8" : "UTF-16"}`);
  }
}

// ---- formats -------------------------------------------------------------------------------------
// Each parser returns Map key -> { values: [raw string], formatted?, ref?, reason? }.

/** Where JSON.parse failed: newer V8 messages carry no position, so a small scanner finds it. */
function jsonErrorAt(text) {
  let i = 0;
  const ws = () => { while (/[ \t\r\n]/.test(text[i] ?? "")) i++; };
  const fail = () => { throw i; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === close) { i++; return; }
      for (;;) {
        if (c === "{") { ws(); if (text[i] !== "\"") fail(); str(); ws(); if (text[i] !== ":") fail(); i++; }
        value();
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === close) { i++; return; }
        fail();
      }
    }
    if (c === "\"") return str();
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 400));
    if (!m) fail();
    i += m[0].length;
  };
  const str = () => {
    i++;
    while (i < text.length && text[i] !== "\"") {
      if (text[i] === "\\") i++;
      else if (text.charCodeAt(i) < 0x20) fail();
      i++;
    }
    if (i >= text.length) fail();
    i++;
  };
  try { value(); ws(); if (i < text.length) fail(); } catch (at) {
    if (typeof at === "number") return at;
    if (at instanceof RangeError) return i; // nested past the stack: report where it stopped
    throw at;
  }
  return 0;
}

function parseJsonText(text, file) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const at = jsonErrorAt(text);
    throw invalid(file, position(text, at), `invalid JSON: unexpected ${at < text.length ? JSON.stringify(text[at]) : "end of file"}`);
  }
}

/** Flat or nested JSON; nested keys are joined with `.`, array items get `[i]`. */
function parseJson(text, file) {
  const data = parseJsonText(text, file);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw invalid(file, "1:1", "the top level must be an object");
  const out = new Map();
  const walk = (v, key, depth) => {
    if (depth > MAX_NESTING) throw invalid(file, "1:1", `nested deeper than ${MAX_NESTING} levels`);
    if (typeof v === "string") {
      // "a.b" and {"a": {"b"}} name the same key; which one wins would be silent (review finding).
      if (out.has(key)) throw invalid(file, "1:1", `the key ${key} is defined twice (flat and nested)`);
      out.set(key, { values: [v] });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`, depth + 1));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}.${k}` : k, depth + 1);
  };
  walk(data, "", 0);
  return out;
}

const STRINGS_ESCAPES = { n: "\n", t: "\t", r: "\r", "\"": "\"", "'": "'", "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" };

/** Apple `.strings`: `"key" = "value";` with `/* *\/` and `//` comments; a key alone means value = key. */
function parseStrings(text, file) {
  const out = new Map();
  let i = 0;
  const fail = (m, at = i) => invalid(file, position(text, at), m);
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith("//", i)) { const e = text.indexOf("\n", i); i = e < 0 ? text.length : e + 1; }
      else if (text.startsWith("/*", i)) {
        const e = text.indexOf("*/", i + 2);
        if (e < 0) throw fail("unterminated comment");
        i = e + 2;
      } else return;
    }
  };
  const literal = () => {
    if (text[i] === "\"") {
      const start = i++;
      let s = "";
      while (i < text.length && text[i] !== "\"") {
        if (text[i] === "\\") {
          const n = text[i + 1];
          if (n === undefined) break;
          if (n === "U" || n === "u") {
            const hex = /^[0-9a-fA-F]{4}/.exec(text.slice(i + 2, i + 6));
            if (!hex) throw fail("\\U needs four hex digits");
            s += String.fromCharCode(parseInt(hex[0], 16));
            i += 6;
          } else if (/[0-7]/.test(n)) {
            const oct = /^[0-7]{1,3}/.exec(text.slice(i + 1))[0];
            s += String.fromCharCode(parseInt(oct, 8));
            i += 1 + oct.length;
          } else {
            s += STRINGS_ESCAPES[n] ?? n;
            i += 2;
          }
        } else s += text[i++];
      }
      if (i >= text.length) throw fail("unterminated string", start);
      i++;
      return s;
    }
    const m = /^[A-Za-z0-9_$.:\/-]+/.exec(text.slice(i, i + 4096));
    if (!m) throw fail(`expected a quoted string, found ${JSON.stringify(text[i])}`);
    i += m[0].length;
    return m[0];
  };
  for (;;) {
    skip();
    if (i >= text.length) break;
    const key = literal();
    skip();
    let value = key;
    if (text[i] === "=") {
      i++;
      skip();
      value = literal();
      skip();
    }
    if (text[i] !== ";") throw fail("expected ; after the entry");
    i++;
    out.set(key, { values: [value] });
  }
  return out;
}

/** Every stringUnit value under a localization, through plural and device variations. */
function unitValues(node, file) {
  const out = [];
  const walk = (n, depth = 0) => {
    if (!n || typeof n !== "object") return;
    if (depth > MAX_NESTING) throw invalid(file, "1:1", `variations nested deeper than ${MAX_NESTING} levels`);
    if (n.stringUnit && typeof n.stringUnit.value === "string") out.push(n.stringUnit.value);
    if (n.variations && typeof n.variations === "object") {
      for (const kind of Object.values(n.variations)) {
        if (kind && typeof kind === "object") for (const v of Object.values(kind)) walk(v, depth + 1);
      }
    }
  };
  walk(node);
  return out;
}

/** D15: `%#@name@` takes each plural form of `substitutions.name`, whose own `%arg` is a placeholder. */
function substitute(values, subs, file) {
  if (!subs || typeof subs !== "object") return values;
  let out = values;
  for (const [name, sub] of Object.entries(subs)) {
    const forms = unitValues(sub, file).map((f) => f.replace(/%(?:\d+\$)?arg/g, "%@"));
    if (!forms.length) continue;
    const re = new RegExp(`%(?:\\d+\\$)?#@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@`, "g");
    const next = [];
    for (const v of out) {
      if (!re.test(v)) { next.push(v); continue; }
      for (const f of forms) {
        next.push(v.replace(re, () => f));
        if (next.length > MAX_FRAGMENTS) throw new Capped();
      }
    }
    out = next;
  }
  return out;
}

/** D9: exact locale (any case), then its language; the source language falls back to the key itself. */
function parseXcstrings(text, file, locale) {
  const data = parseJsonText(text, file);
  if (!data || typeof data !== "object" || typeof data.strings !== "object" || data.strings === null) {
    throw invalid(file, "1:1", "an .xcstrings file needs a strings object");
  }
  const source = typeof data.sourceLanguage === "string" ? data.sourceLanguage : "en";
  const lower = locale.toLowerCase();
  const base = lower.split("-")[0];
  // en-GB reads an en source, but zh-Hant never reads a zh-Hans source (review finding).
  const src = source.toLowerCase();
  const isSource = src === lower || src === base || lower === src.split("-")[0];
  const out = new Map();
  for (const [key, entry] of Object.entries(data.strings)) {
    const locs = (entry && typeof entry.localizations === "object" && entry.localizations) || {};
    const names = Object.keys(locs);
    const pick = (want) => names.find((n) => n.toLowerCase() === want);
    const sourceLoc = locs[pick(source.toLowerCase())];
    let loc = entry && entry.shouldTranslate === false ? sourceLoc : locs[pick(lower) ?? pick(base)];
    let values;
    try {
      values = loc ? unitValues(loc, file) : [];
      if (values.some((v) => v.length > MAX_STRING)) throw new Capped(); // before substitution multiplies them
      values = loc ? substitute(values, loc.substitutions, file) : [];
    } catch (e) {
      if (!(e instanceof Capped)) throw e;
      out.set(key, { values: [], reason: "catalog-string-capped" });
      continue;
    }
    if (!values.length && (isSource || entry?.shouldTranslate === false)) values = [key];
    out.set(key, values.length ? { values } : { values: [], reason: "catalog-missing" });
  }
  return out;
}

const ANDROID_ESCAPES = { n: "\n", t: "\t", "'": "'", "\"": "\"", "@": "@", "?": "?", "\\": "\\" };

/** Android string rules: backslash escapes, `"..."` keeps whitespace, other whitespace runs collapse. */
function androidUnescape(s) {
  let out = "", quoted = false;
  let lead = true, tail = 0; // unquoted spaces at the ends are trimmed, quoted ones kept
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      const n = s[++i];
      if (n === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
        i += 4;
      } else out += ANDROID_ESCAPES[n] ?? n;
      lead = false; tail = 0;
    } else if (c === "\"") quoted = !quoted;
    else if (!quoted && /\s/.test(c)) {
      if (!lead && tail === 0) { out += " "; tail = 1; }
    } else {
      out += c;
      lead = false; tail = 0;
    }
  }
  return tail ? out.slice(0, -1) : out;
}

/** The text of an element: CDATA as written, child markup dropped with its text kept, `<br/>` a line break. */
function innerText(el, depth = 0) {
  if (depth > MAX_NESTING) throw new xml.XmlError(`elements nested deeper than ${MAX_NESTING} levels`, 1, 1);
  let s = "";
  for (const c of el.children) {
    if (typeof c === "string") s += c;
    else if (c.cdata !== undefined) s += c.cdata;
    else if (c.name === "br") s += "\\n";
    else s += innerText(c, depth + 1);
  }
  return s;
}

function parseAndroid(text, file) {
  try {
    return androidEntries(xml.parse(text), file);
  } catch (e) {
    if (e instanceof xml.XmlError) throw invalid(file, `${e.line}:${e.column}`, `invalid XML: ${e.message}`);
    throw e;
  }
}

function androidEntries(root, file) {
  if (root.name !== "resources") throw invalid(file, "1:1", `the root element must be <resources>, not <${root.name}>`);
  const out = new Map();
  for (const el of root.children) {
    if (typeof el !== "object" || !el.name || el.attrs.translatable === "false") continue;
    const name = el.attrs.name;
    if (!name) continue;
    const formatted = el.attrs.formatted !== "false";
    const items = el.children.filter((c) => typeof c === "object" && c.name === "item");
    if (el.name === "string") {
      const v = androidUnescape(innerText(el));
      const ref = /^@string\/([\w.]+)$/.exec(v);
      out.set(name, ref ? { values: [], ref: ref[1], formatted } : { values: [v], formatted });
    } else if (el.name === "plurals") {
      out.set(name, { values: items.map((it) => androidUnescape(innerText(it))), formatted });
    } else if (el.name === "string-array") {
      items.forEach((it, i) => {
        const v = androidUnescape(innerText(it));
        const ref = /^@string\/([\w.]+)$/.exec(v);
        out.set(`${name}[${i}]`, ref ? { values: [], ref: ref[1], formatted } : { values: [v], formatted });
      });
    }
  }
  return out;
}

/** By extension, then by content. */
function detect(file, text) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".xcstrings") return "xcstrings";
  if (ext === ".json") return "json";
  if (ext === ".strings") return "strings";
  if (ext === ".xml") return "android";
  const t = text.trimStart();
  // TODO-092 D19: a JS-family file holding a bare JSON object was read as JSON by content; it still is.
  if (code.EXTENSIONS.includes(ext)) return t.startsWith("{") ? "json" : "code";
  if (t.startsWith("<")) return "android";
  if (t.startsWith("{")) return /"sourceLanguage"\s*:/.test(t) && /"strings"\s*:/.test(t) ? "xcstrings" : "json";
  return "strings";
}

// ---- fragments ------------------------------------------------------------------------------------

/** The matching `}` of every `{` (-1: none) in one pass, so a string full of braces stays linear (review finding). */
function closers(s) {
  const close = new Int32Array(s.length).fill(-1);
  const stack = [];
  for (let j = 0; j < s.length; j++) {
    if (s[j] === "{") stack.push(j);
    else if (s[j] === "}" && stack.length) close[stack.pop()] = j;
  }
  return close;
}

/** For every index, the next `}}` at or after it (-1: none). */
function nextDoubleClose(s) {
  const next = new Int32Array(s.length + 1).fill(-1);
  for (let j = s.length - 2; j >= 0; j--) next[j] = s[j] === "}" && s[j + 1] === "}" ? j : next[j + 1];
  return next;
}

/** Variants of `s`: arrays of text pieces and SPLIT markers. ICU branches multiply the variants. */
function expand(s, depth, inPlural, opts, styles) {
  let variants = [[]];
  const push = (x) => { for (const v of variants) v.push(x); };
  const close = closers(s);
  const dd = nextDoubleClose(s);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // `${name}` is one placeholder; without this the `$` stays in the fragment (spec 17 D17).
    if (c === "$" && s[i + 1] === "{" && close[i + 1] >= 0 && /^\s*[A-Za-z_][\w.]*\s*$/.test(s.slice(i + 2, close[i + 1]))) {
      push(SPLIT);
      styles.add("{name}");
      i = close[i + 1] + 1;
      continue;
    }
    if (c === "{") {
      if (s.startsWith("{{", i)) {
        const end = dd[i + 2];
        if (end >= 0) { push(SPLIT); styles.add("{{name}}"); i = end + 2; continue; }
      }
      const stop = close[i];
      if (stop < 0) { push(c); i++; continue; }
      const inner = s.slice(i + 1, stop);
      const m = ICU_COMPLEX.exec(inner);
      if (m) {
        if (depth + 1 > MAX_DEPTH) throw new Capped();
        styles.add("icu");
        const branches = [];
        const b = m[3];
        const bOff = stop - b.length; // b ends where inner ends, at `stop`
        let k = 0;
        for (;;) {
          while (k < b.length && /\s/.test(b[k])) k++;
          if (k >= b.length) break;
          SELECTOR.lastIndex = k;
          const sel = SELECTOR.exec(b);
          if (!sel) break;
          k += sel[0].length;
          if (sel[0].startsWith("offset:")) continue;
          while (k < b.length && /\s/.test(b[k])) k++;
          if (b[k] !== "{") break;
          const end = close[bOff + k] < 0 ? -1 : close[bOff + k] - bOff;
          if (end < 0) break;
          branches.push(...expand(b.slice(k + 1, end), depth + 1, m[2] !== "select", opts, styles));
          k = end + 1;
        }
        const next = [];
        for (const v of variants) {
          for (const br of branches) {
            next.push(v.concat(br));
            if (next.length > MAX_FRAGMENTS) throw new Capped();
          }
        }
        if (next.length) variants = next;
        i = stop + 1;
        continue;
      }
      if (ICU_SIMPLE.test(inner)) {
        push(SPLIT);
        styles.add(/^\s*\d+\s*(,|$)/.test(inner) ? "{0}" : "{name}");
        i = stop + 1;
        continue;
      }
      push(c);
      i++;
    } else if (c === "%" && opts.formatted) {
      if (s[i + 1] === "%") { push("%"); i += 2; continue; }
      SUBSTITUTION.lastIndex = i;
      PRINTF.lastIndex = i;
      const sub = SUBSTITUTION.exec(s);
      const pf = sub ? null : PRINTF.exec(s);
      const hit = sub || pf;
      if (hit) { push(SPLIT); styles.add("printf"); i += hit[0].length; continue; }
      push(c);
      i++;
    } else if (c === "#" && inPlural) {
      push(SPLIT); // the plural count is a placeholder (spec 02 Rule, step 3)
      i++;
    } else if (c === "'" && depth > 0 && s[i + 1] === "'") {
      push("'"); // ICU: '' is one apostrophe
      i += 2;
    } else {
      push(c);
      i++;
    }
  }
  return variants;
}

function piecesToFragments(variant) {
  const out = [];
  let cur = "";
  for (const p of variant) {
    if (p === SPLIT) { out.push(cur); cur = ""; } else cur += p;
  }
  out.push(cur);
  return out.map((f) => f.trim()).filter(Boolean);
}

/**
 * Raw fragments of one catalog string: markup dropped (text kept, `<br>` a line break), then split on
 * placeholders. Returns { alternatives: [[fragment]], capped, styles }.
 */
function fragments(value, opts = {}) {
  const o = { formatted: opts.formatted !== false };
  const styles = new Set();
  const text = value.replace(MARKUP, (m, name) => (/^br$/i.test(name) ? "\n" : ""));
  let variants;
  try {
    variants = expand(text, 0, false, o, styles);
  } catch (e) {
    if (e instanceof Capped) return { alternatives: [], capped: true, styles };
    throw e;
  }
  const seen = new Set();
  const alternatives = [];
  const edges = []; // TODO-039 T2: whether a placeholder starts (lead) or ends (trail) each alternative
  let count = 0;
  for (const v of variants) {
    const f = piecesToFragments(v);
    const id = JSON.stringify(f);
    if (seen.has(id)) continue;
    seen.add(id);
    alternatives.push(f);
    const blank = (p) => p !== SPLIT && !p.trim();
    const inner = v.filter((p) => !blank(p));
    edges.push({ lead: inner[0] === SPLIT, trail: inner[inner.length - 1] === SPLIT });
    count += f.length;
    if (count > MAX_FRAGMENTS) return { alternatives: [], capped: true, styles };
  }
  return { alternatives, edges, capped: false, styles };
}

// ---- loading --------------------------------------------------------------------------------------

/** The `sourceLanguage` of an `.xcstrings` file, else null (spec 17 D11). */
function xcstringsSource(file) {
  if (path.extname(file).toLowerCase() !== ".xcstrings") return null;
  let st;
  try { st = fs.statSync(file); } catch { return null; } // loadFile reports a missing file
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  let data;
  try { data = parseJsonText(decode(fs.readFileSync(file), file, false), file); } catch { return null; } // loadFile reports it
  return data && typeof data.sourceLanguage === "string" ? data.sourceLanguage : "en";
}

/** One catalog file. Returns { file, format, entries: Map key -> raw entry }. */
function tooLarge(file) {
  return err("catalog-too-large", `the catalog ${file} is over the 20 MB limit`, "split the catalog or pass only the files the screens use");
}

function loadFile(file, locale) {
  let st, buf;
  try { st = fs.statSync(file); } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw err("catalog-not-found", `cannot read the catalog ${file}: ${e.code || e.message}`, "check the file's permissions");
  }
  if (!st.isFile()) throw err("catalog-not-found", `the catalog ${file} is not a file`);
  if (st.size > MAX_FILE_BYTES) throw tooLarge(file);
  try { buf = fs.readFileSync(file); } catch (e) {
    throw err("catalog-not-found", `cannot read the catalog ${file}: ${e.code || e.message}`, "check the file's permissions");
  }
  if (buf.length > MAX_FILE_BYTES) throw tooLarge(file); // it grew after the stat
  const ext = path.extname(file).toLowerCase();
  const text = decode(buf, file, ext === ".strings" || ext === "");
  const format = detect(file, text);
  if (format === "code") {
    const r = code.parse(text, file, locale);
    return { file, format, entries: r.entries, skipped: r.skipped, open: r.open, missingLocale: r.missingLocale, unread: r.unread };
  }
  const entries = format === "json" ? parseJson(text, file)
    : format === "strings" ? parseStrings(text, file)
      : format === "xcstrings" ? parseXcstrings(text, file, locale)
        : parseAndroid(text, file);
  return { file, format, entries };
}

/**
 * Loads every `--catalog` (a `{locale}` template takes the run locale, D21) and merges them: the last
 * file wins. Returns { keys: Map key -> entry, missing: [file], styles, warnings, open } where an entry is
 * { key, catalog, text, alternatives, reason? } and `open` lists the key prefixes a code catalog cannot read
 * (TODO-092 D18).
 */
function loadAll(specs, locale) {
  const merged = new Map();
  const dups = new Map(); // key -> winning file
  const missing = [];
  const warnings = [];
  const open = new Set();
  for (const spec of specs) {
    const file = spec.split("{locale}").join(locale);
    const loaded = loadFile(file, locale);
    if (!loaded) {
      if (spec.includes("{locale}")) { missing.push(file); continue; }
      throw err("catalog-not-found", `no such catalog: ${file}`, "check the --catalog path; it is read from the working directory");
    }
    // TODO-092 D12: a code file with locale-named exports and none for this locale is a missing catalog.
    if (loaded.missingLocale) { missing.push(file); continue; }
    if (loaded.open && loaded.open.length) {
      // This file's spreads and dynamic values may replace keys an earlier file defined, and the last file wins,
      // so those earlier strings cannot be trusted either (review finding).
      const here = { open: loaded.open };
      for (const [k, v] of merged) if (!loaded.entries.has(k) && !v.reason && isOpen(here, k)) merged.set(k, { values: [], reason: code.DYNAMIC, catalog: file });
      loaded.open.forEach((p) => open.add(p));
    }
    if (loaded.skipped && loaded.skipped.count) warnings.push(skippedWarning(file, loaded.skipped));
    if (loaded.unread) {
      const { name, line, col } = loaded.unread;
      warnings.push({
        code: "catalog-values-skipped",
        message: `${file}:${line}:${col}: code uses ${name} beyond declaring and exporting it, so its strings are only known at runtime; no key in ${file} was read and their checks are skipped`,
        hint: "keep catalog files as plain literals: declare each object, export it, and touch it nowhere else in the file",
      });
    }
    for (const [k, v] of loaded.entries) {
      if (LONE_SURROGATE.test(k) || v.values.some((x) => LONE_SURROGATE.test(x))) {
        throw invalid(file, "1:1", `the key or string ${JSON.stringify(k)} is not valid Unicode (a lone surrogate escape)`);
      }
      if (merged.has(k)) dups.set(k, file);
      merged.set(k, { ...v, catalog: file });
    }
  }
  if (missing.length) {
    warnings.push({ code: "catalog-missing", message: `no catalog for the locale ${locale}: ${missing.join(", ")}; its @key checks are skipped`, hint: "add the file, or pass --locale for a locale that has one" });
  }
  if (dups.size) {
    const sample = [...dups.keys()].slice(0, 3).map((k) => `${k} from ${dups.get(k)}`);
    warnings.push({ code: "catalog-duplicate-key", message: `${dups.size} key${dups.size === 1 ? " is" : "s are"} defined in more than one catalog; the last one wins (${sample.join(", ")}${dups.size > 3 ? ", ..." : ""})`, hint: "the last --catalog wins; reorder them to change the winner" });
  }
  const keys = new Map();
  const styles = new Set();
  let total = 0, rawChars = 0, capped = 0;
  for (const [k, raw] of merged) {
    let r = raw;
    for (let hop = 0; r.ref !== undefined && hop < MAX_REF_HOPS; hop++) {
      const t = merged.get(r.ref);
      r = t ? { ...t, catalog: raw.catalog } : { values: [], catalog: raw.catalog };
    }
    if (r.ref !== undefined) r = { values: [], catalog: raw.catalog }; // a cycle or too many hops: no text (D16)
    // Counted before the join, so a few huge forms cannot allocate past the budget (review finding).
    rawChars += r.values.reduce((n, v) => n + v.length, 0);
    if (rawChars > MAX_TOTAL_BYTES) throw err("catalog-too-large", "the catalogs expand to over 32 MB of text", "pass only the catalogs the screens use");
    const entry = { key: k, catalog: raw.catalog, text: raw.ref !== undefined ? `@string/${raw.ref}` : r.values.join(" | "), alternatives: [] };
    if (r.reason) entry.reason = r.reason;
    else {
      const alts = [];
      const edges = [];
      for (const v of r.values) {
        if (v.length > MAX_STRING) { entry.reason = "catalog-string-capped"; break; }
        const f = fragments(v, { formatted: r.formatted });
        f.styles.forEach((s) => styles.add(s));
        if (f.capped) { entry.reason = "catalog-string-capped"; break; }
        alts.push(...f.alternatives);
        edges.push(...f.edges);
        if (alts.reduce((n, a) => n + a.length, 0) > MAX_FRAGMENTS) { entry.reason = "catalog-string-capped"; break; }
      }
      if (entry.reason) entry.alternatives = [];
      else entry.alternatives = alts.length ? alts : [[]];
      // Not enumerable: entries are serialized into requests and sized as they are (TODO-039 T2 reads it).
      if (!entry.reason) Object.defineProperty(entry, "edges", { value: alts.length ? edges : [{ lead: false, trail: false }] });
    }
    if (entry.reason === "catalog-string-capped") capped++;
    // The serialized check, as one request carries it (UTF-8 bytes, text and fragments).
    total += Buffer.byteLength(JSON.stringify(entry));
    if (total > MAX_TOTAL_BYTES) throw err("catalog-too-large", "the catalogs expand to over 32 MB of text", "pass only the catalogs the screens use");
    keys.set(k, entry);
  }
  if (capped) {
    warnings.push({ code: "catalog-string-capped", message: `${capped} catalog string${capped === 1 ? " expands" : "s expand"} past ${MAX_FRAGMENTS} fragments or ${MAX_DEPTH} nested plurals; ${capped === 1 ? "its checks are" : "their checks are"} skipped`, hint: "check those screens with --present and the shown text" });
  }
  return { keys, missing, styles, warnings, open: [...open] };
}

/** TODO-092 D5, D15: one warning per code catalog with values that are not plain literals. */
function skippedWarning(file, { count, kinds, samples }) {
  const LABEL = { call: "call", function: "function", template: "template with ${}", reference: "reference", spread: "spread", literal: "true/false/null", "computed key": "computed key", expression: "expression" };
  const parts = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${LABEL[k] || k}${n === 1 ? "" : "s"}`);
  return {
    code: "catalog-values-skipped",
    message: `${count} value${count === 1 ? " in " + file + " is not a plain string" : "s in " + file + " are not plain strings"} (${parts.join(", ")}) and ${count === 1 ? "was" : "were"} skipped (${samples.join(", ")}${count > samples.length ? ", ..." : ""}); those keys get no @key, untranslated, truncated or formats checks`,
    hint: "write those strings as literals, or pass the JSON file the code imports with --catalog",
  };
}

/** True when a code catalog may define `key` where nobody can read it: under a spread or a dynamic value (D18). */
const openSets = new WeakMap(); // open array -> Set: a lookup per key prefix keeps loadAll and untranslated linear
function isOpen(cat, key) {
  const open = cat.open;
  if (!open || !open.length) return false;
  let set = openSets.get(open);
  if (!set) openSets.set(open, (set = new Set(open)));
  if (set.has("") || set.has(key)) return true;
  for (let i = 0; i < key.length; i++) if ((key[i] === "." || key[i] === "[") && set.has(key.slice(0, i))) return true;
  return false;
}

const localesCache = new Map(); // file -> { mtimeMs, size, value }: untranslated asks several times per run
/** The locales of a code catalog with several locale-named exports (TODO-092 D11), else null. */
function codeLocales(file) {
  if (!code.EXTENSIONS.includes(path.extname(file).toLowerCase())) return null;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_BYTES) return null;
    const hit = localesCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = code.locales(decode(fs.readFileSync(file), file, false), file);
    localesCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch { return null; }
}

/** The closest keys to `key`, best first. */
function closestKeys(key, keys, n = 3) {
  return [...keys].map((k) => [editDistance(key, k), k]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)).slice(0, n).map((x) => x[1]);
}

/**
 * A check string as sent to the core: `@@x` is the literal `@x`, `@key` a catalog check, anything else
 * itself. `cat` is the loadAll() result, or null when no --catalog was given.
 */
function resolve(s, cat, where) {
  if (s.startsWith("@@")) return s.slice(1);
  if (!s.startsWith("@")) return s;
  const key = s.slice(1);
  if (!cat) throw err("missing-catalog", `${where}: ${s} is a catalog key, but no --catalog was given`, `--catalog <file> (or @${s} for the literal text)`);
  // D12: a {locale} template with no file for this locale skips every @key, whatever else loaded.
  if (cat.missing.length) return { key, catalog: null, text: s, alternatives: [], reason: "catalog-missing" };
  const e = cat.keys.get(key);
  // TODO-092 D18: below a dynamic value or a spread the key may exist; nobody can read it, so it is skipped.
  if (!e && isOpen(cat, key)) {
    return { key, catalog: null, text: s, alternatives: [], reason: code.DYNAMIC };
  }
  if (!e) {
    const near = closestKeys(key, cat.keys.keys());
    throw err("unknown-catalog-key", `${where}: the catalogs define no key ${key} (${cat.keys.size} keys)${near.length ? `; closest: ${near.join(", ")}` : ""}`,
      near.length ? `@${near[0]}` : "check the key in the catalog file");
  }
  const out = { key, catalog: e.catalog, text: e.text, alternatives: e.alternatives };
  if (e.reason) out.reason = e.reason;
  return out;
}

/** Every entry, as `--all-keys` sends it. */
function inventory(cat) {
  return [...cat.keys.values()].map((e) => {
    const o = { key: e.key, catalog: e.catalog, text: e.text, alternatives: e.alternatives };
    if (e.reason) o.reason = e.reason;
    return o;
  });
}

module.exports = {
  loadAll, loadFile, resolve, codeLocales, isOpen, inventory, fragments, xcstringsSource, androidUnescape, parseStrings, parseJson, parseXcstrings,
  parseAndroid, decode, MAX_FILE_BYTES, MAX_FRAGMENTS, MAX_TOTAL_BYTES,
  // The placeholder grammar, shared with the pseudo generator (TODO-039 D9).
  grammar: { PRINTF, SUBSTITUTION, ICU_COMPLEX, SELECTOR, ICU_SIMPLE, MARKUP },
};
