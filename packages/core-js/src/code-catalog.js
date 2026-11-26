// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-092: string catalogs kept in TypeScript or JavaScript files, read without running them (D1, D2).
// The file is tokenized once and only the object-literal subset is read: strings, substitution-free templates,
// numbers, nested objects and arrays. Every other value keeps its key with reason `catalog-value-dynamic` and is
// counted (D5, D6). The tokenizer is a single forward pass with a small lookahead buffer, so time and memory are
// linear in the file size; no regular expression runs over the file text.
const path = require("path");
const { UsageError } = require("./args");

// D8: the serialized catalog checks of a whole run, so a request stays under the 64 MB serve line (catalog.js uses it)
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const MAX_NESTING = 64; // same bound as JSON objects in catalog.js
const MAX_REF_HOPS = 4; // `const a = b; const b = {...}` chains
const DYNAMIC = "catalog-value-dynamic";

// Punctuators kept whole (D8): `=>` and the equality operators must never read as a lone `=`. `>` is always
// single, so `Record<string, Array<string>>` closes two type brackets.
const PUNCT = ["...", "===", "!==", "=>", "==", "!=", "<=", "?.", "??", "&&", "||", "++", "--"];
const STMT = new Set(["export", "import", "const", "let", "var", "module", "exports", "function", "class", "interface", "type", "enum", "declare", "namespace", "async"]);
// After these the next `/` starts a regular expression, not a division.
const BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
const OPEN = new Set(["{", "[", "(", "tpl{"]);
const OPWORDS = new Set(["delete", "typeof", "void", "new", "await", "yield", "in", "instanceof", "function", "class", "async"]);
const CLOSE = new Set(["}", "]", ")", "tpl}"]);

function invalid(file, text, at, message, hint) {
  let line = 1, col = 1;
  for (let i = 0; i < at && i < text.length; i++) {
    if (text[i] === "\n") { line++; col = 1; } else col++;
  }
  return new UsageError("invalid-catalog", `${file}:${line}:${col}: ${message}`, hint || "fix the catalog file; catscan reads it as text and never runs it");
}

const isDigit = (c) => c >= "0" && c <= "9";
const isHex = (c) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
function isSpace(c) {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f" || c === " " || c === "﻿"
    || c === " " || c === " " || (c > "က" && /\s/.test(c));
}
function isIdent(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || isDigit(c) || c === "_" || c === "$" || c === "\\" || (c > "\u007f" && !isSpace(c));
}

/** One token at a time, with lookahead. Token: { t, v, s, nl } (type, value, start offset, newline before it). */
class Lexer {
  constructor(text, file) {
    this.text = text;
    this.file = file;
    this.i = text.startsWith("#!") ? text.indexOf("\n") >>> 0 : 0; // a hashbang line
    if (this.i > text.length) this.i = text.length;
    this.buf = [];
    this.head = 0;
    this.last = null; // the last token produced, for the regex rule
    this.braces = 0; // open `{` (template substitutions included)
    this.tpl = []; // brace depth at each open `${`
    this.noRegexUntil = 0;
    // JSX can appear in .jsx/.tsx and plain .js files; in .ts `<T>x` is a type assertion, never JSX.
    this.jsx = /\.(jsx|tsx|js|mjs|cjs)$/i.test(file);
  }

  fail(at, message) { return invalid(this.file, this.text, at, message); }

  peek(k = 0) {
    while (this.buf.length - this.head <= k) this.buf.push(this.scan());
    return this.buf[this.head + k];
  }

  next() {
    const tok = this.peek(0);
    this.head++;
    if (this.head > 256 && this.head === this.buf.length) { this.buf = []; this.head = 0; }
    return tok;
  }

  regexAllowed() {
    const p = this.last;
    if (!p) return true;
    if (p.t === "num" || p.t === "str" || p.t === "tpl" || p.t === "regex") return false;
    if (p.t === "id") return BEFORE_REGEX.has(p.v);
    // `</b>` in JSX: a closing tag, not a regular expression.
    return !(p.v === ")" || p.v === "]" || p.v === "tpl}" || p.v === "<");
  }

  scan() {
    const tok = this.scanRaw();
    if (tok.t !== "eof") this.last = tok;
    return tok;
  }

  scanRaw() {
    // A template part between two substitutions produces no token (null); looping, not recursing, keeps 200k
    // `${}` in a row off the call stack (review finding).
    for (;;) {
      const tok = this.scanOne();
      if (tok) return tok;
    }
  }

  scanOne() {
    const s = this.text;
    let nl = false;
    for (;;) {
      if (this.i >= s.length) return { t: "eof", v: "", s: s.length, nl: true };
      const c = s[this.i];
      if (isSpace(c)) {
        if (c === "\n" || c === "\r" || c === " " || c === " ") nl = true;
        this.i++;
      } else if (c === "/" && s[this.i + 1] === "/") {
        while (this.i < s.length && s[this.i] !== "\n" && s[this.i] !== "\r") this.i++;
      } else if (c === "/" && s[this.i + 1] === "*") {
        const end = s.indexOf("*/", this.i + 2);
        if (end < 0) throw this.fail(this.i, "unterminated /* comment");
        for (let j = this.i; j < end; j++) if (s[j] === "\n") { nl = true; break; }
        this.i = end + 2;
      } else break;
    }
    const start = this.i;
    const c = s[start];
    if (c === "'" || c === "\"") return { t: "str", v: this.string(c), s: start, nl };
    if (c === "`") return this.template(start, nl);
    if (c === "}" && this.tpl.length && this.tpl[this.tpl.length - 1] === this.braces) {
      this.tpl.pop();
      this.braces--;
      return this.template(start, nl, true);
    }
    if (isDigit(c) || (c === "." && isDigit(s[start + 1] || ""))) return { t: "num", v: this.number(), s: start, nl };
    if (isIdent(c) || c === "#") {
      this.i++;
      while (this.i < s.length && isIdent(s[this.i])) this.i++;
      const v = s.slice(start, this.i);
      // `\u0061` in a name is `a` (review finding); the slice is one identifier, so this stays linear.
      return { t: "id", v: v.includes("\\") ? v.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (m, a, b) => String.fromCodePoint(Math.min(parseInt(a || b, 16), 0x10ffff))) : v, s: start, nl };
    }
    // A `/` the heuristic takes for a regular expression that never closes is a division (`{} / 2`).
    if (c === "/" && this.regexAllowed() && this.regex()) return { t: "regex", v: "", s: start, nl };
    // `<T,>(x) => x` and `<T extends U>` are generics, not JSX; an element that never closes is a `<` after all.
    if (c === "<" && this.jsx && this.regexAllowed() && /[A-Za-z>]/.test(s[start + 1] || "")
      && !/^<[A-Za-z_$][\w$.]*\s*(?:,|extends\b)/.test(s.slice(start, start + 128)) && this.jsxElement()) {
      return { t: "jsx", v: "", s: start, nl };
    }
    for (const p of PUNCT) {
      if (s.startsWith(p, start)) { this.i += p.length; return { t: "punc", v: p, s: start, nl }; }
    }
    this.i++;
    if (c === "{") this.braces++;
    else if (c === "}") this.braces--;
    return { t: "punc", v: c, s: start, nl };
  }

  /** A quoted string, cooked. */
  string(q) {
    const s = this.text;
    const start = this.i++;
    let out = "";
    let from = this.i;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === q) { out += s.slice(from, this.i); this.i++; return out; }
      if (c === "\n" || c === "\r") break;
      if (c === "\\") {
        out += s.slice(from, this.i);
        out += this.escape(false);
        from = this.i;
      } else this.i++;
    }
    throw this.fail(start, "unterminated string");
  }

  /** `\` at this.i; returns the cooked text and moves past the escape. */
  escape(inTemplate) {
    const s = this.text;
    const at = this.i;
    const c = s[this.i + 1];
    this.i += 2;
    if (c === undefined) throw this.fail(at, "unterminated string");
    switch (c) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "\r": if (s[this.i] === "\n") this.i++; return "";
      case "\n": case " ": case " ": return "";
      case "x": {
        const h = s.slice(this.i, this.i + 2);
        if (h.length < 2 || !isHex(h[0]) || !isHex(h[1])) throw this.fail(at, "invalid \\x escape");
        this.i += 2;
        return String.fromCharCode(parseInt(h, 16));
      }
      case "u": {
        if (s[this.i] === "{") {
          const end = s.indexOf("}", this.i);
          const h = end < 0 ? "" : s.slice(this.i + 1, end);
          if (!h || h.length > 8 || ![...h].every(isHex) || parseInt(h, 16) > 0x10ffff) throw this.fail(at, "invalid \\u{} escape");
          this.i = end + 1;
          return String.fromCodePoint(parseInt(h, 16));
        }
        const h = s.slice(this.i, this.i + 4);
        if (h.length < 4 || ![...h].every(isHex)) throw this.fail(at, "invalid \\u escape");
        this.i += 4;
        return String.fromCharCode(parseInt(h, 16));
      }
      case "0": case "1": case "2": case "3": case "4": case "5": case "6": case "7": {
        if (c === "0" && !isDigit(s[this.i] || "")) return "\0";
        if (inTemplate) throw this.fail(at, "octal escape in a template");
        // Legacy octal: up to three digits, at most \377.
        let oct = c;
        while (oct.length < (c <= "3" ? 3 : 2) && s[this.i] >= "0" && s[this.i] <= "7") oct += s[this.i++];
        return String.fromCharCode(parseInt(oct, 8));
      }
      default: return c;
    }
  }

  /**
   * A template from its opening backtick, or (resume) from the `}` that closes a substitution. A template
   * with no substitution is one `tpl` token; otherwise `tpl{` opens it, the substitutions' own tokens follow,
   * and `tpl}` closes it, so skipping a value balances it like a bracket.
   */
  template(start, nl, resume = false) {
    const s = this.text;
    this.i++;
    let out = "";
    let from = this.i;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "`") {
        out += raw(s.slice(from, this.i));
        this.i++;
        return resume ? { t: "punc", v: "tpl}", s: start, nl } : { t: "tpl", v: out, s: start, nl };
      }
      if (c === "$" && s[this.i + 1] === "{") {
        this.i += 2;
        this.braces++;
        this.tpl.push(this.braces);
        // Resuming inside a template with several substitutions: the part between them produces no token.
        return resume ? null : { t: "punc", v: "tpl{", s: start, nl };
      }
      if (c === "\\") {
        out += raw(s.slice(from, this.i));
        out += this.escape(true);
        from = this.i;
      } else this.i++;
    }
    throw this.fail(start, "unterminated template");
  }

  number() {
    const s = this.text;
    const start = this.i;
    while (this.i < s.length) {
      const c = s[this.i];
      if (isIdent(c) || c === ".") this.i++;
      else if ((c === "+" || c === "-") && (s[this.i - 1] === "e" || s[this.i - 1] === "E") && !/^0[xX]/.test(s.slice(start, start + 2))) this.i++;
      else break;
    }
    const raw = s.slice(start, this.i).replace(/_/g, "");
    // BigInt conversion is superlinear; no UI string is a 64-digit number (review finding).
    if (raw.length > 64) return null;
    let n;
    if (/^\d+n$/.test(raw) || /^0[xob][\da-f]+n$/i.test(raw)) n = String(BigInt(raw.slice(0, -1)));
    else if (/^0\d+$/.test(raw)) n = String(/[89]/.test(raw) ? Number(raw) : parseInt(raw, 8)); // legacy octal
    else n = String(Number(raw));
    return n === "NaN" ? null : n;
  }

  /**
   * Steps over one JSX element as a unit: its text may hold quotes (`<p>Don't</p>`) that are no JS strings. Tags,
   * quoted attributes and `{...}` expressions are balanced; nothing inside is read (a JSX value is skipped).
   */
  jsxElement() {
    // `{<a>{<b>...}</a>}` recurses through braces(); bound it like object nesting (review finding, fix-check).
    if ((this.jsxNest = (this.jsxNest || 0) + 1) > MAX_NESTING) throw this.fail(this.i, `JSX nested deeper than ${MAX_NESTING} levels`);
    try { return this.jsxScan(); } finally { this.jsxNest--; }
  }

  jsxScan() {
    const s = this.text;
    const start = this.i;
    let depth = 0;
    const comment = () => { // `/* */` or `//` inside a JSX expression; quotes there are no strings
      if (s[this.i] !== "/" || (s[this.i + 1] !== "*" && s[this.i + 1] !== "/")) return false;
      const end = s[this.i + 1] === "*" ? s.indexOf("*/", this.i + 2) : s.indexOf("\n", this.i);
      this.i = end < 0 ? s.length : end + (s[this.i + 1] === "*" ? 2 : 0);
      return true;
    };
    const braces = () => { // `{ ... }`: nested braces, quoted strings, comments and nested JSX
      let d = 0;
      let prev = "{";
      while (this.i < s.length) {
        const c = s[this.i];
        if (comment()) continue;
        if (c === "'" || c === "\"" || c === "`") { const q = c; this.i++; while (this.i < s.length && s[this.i] !== q) this.i += s[this.i] === "\\" ? 2 : 1; this.i++; prev = q; continue; }
        if (c === "<" && "{(&|?:,=>[".includes(prev) && /[A-Za-z>]/.test(s[this.i + 1] || "")) {
          const at = this.i;
          if (this.jsxElement()) { prev = ">"; continue; }
          this.i = at + 1;
          continue;
        }
        if (c === "{") d++;
        else if (c === "}" && --d === 0) { this.i++; return; }
        if (!isSpace(c)) prev = c;
        this.i++;
      }
    };
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "{") { braces(); continue; }
      if (c !== "<") { this.i++; continue; }
      const closing = s[this.i + 1] === "/";
      let selfClosing = false;
      this.i++;
      while (this.i < s.length && s[this.i] !== ">") {
        const t = s[this.i];
        if (t === "\"" || t === "'") { const end = s.indexOf(t, this.i + 1); this.i = end < 0 ? s.length : end + 1; continue; }
        if (t === "{") { braces(); continue; }
        selfClosing = t === "/" && s[this.i + 1] === ">";
        this.i++;
      }
      this.i++;
      if (closing) depth--;
      else if (!selfClosing) depth++;
      if (depth <= 0) return true;
    }
    // Never closed: not JSX after all. A failed scan ran to the end of the file, so JSX detection stops for the
    // rest of it; retrying at every later `<` would be quadratic.
    this.i = start;
    this.jsx = false;
    return false;
  }

  regex() {
    const s = this.text;
    // A failed scan ran to the end of its line; any later `/` on that line is a division too (linear on one line).
    if (this.i < this.noRegexUntil) return false;
    const start = this.i++;
    let cls = false;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "\n" || c === "\r") break;
      if (c === "\\") this.i += 2;
      else {
        this.i++;
        if (c === "[") cls = true;
        else if (c === "]") cls = false;
        else if (c === "/" && !cls) {
          while (this.i < s.length && isIdent(s[this.i])) this.i++;
          return true;
        }
      }
    }
    this.noRegexUntil = this.i; // unterminated: a division
    this.i = start;
    return false;
  }
}

/** A template's raw line breaks read as `\n` (CRLF and CR included); escaped ones are cooked elsewhere. */
function raw(text) { return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text; }

// ---- reading ------------------------------------------------------------------------------------------
// Nodes: { k: "obj", props: [{ key, value } | { spread: true }] }, { k: "arr", items }, { k: "str", v },
// { k: "ref", name, s }, { k: "skip", kind, s, callee? }.

class Reader {
  constructor(text, file) {
    this.lx = new Lexer(text, file);
    this.text = text;
    this.file = file;
    this.allowed = new Set(); // offsets of identifiers read as part of a literal, a declaration or an export (D27)
  }

  is(tok, v) { return tok.t !== "str" && tok.t !== "tpl" && tok.v === v; }

  /** `NAME` or `NAME.a?.b` at lookahead k: { head: NAME's offset, end: the lookahead after it }, else null (D27). */
  chain(k) {
    const h = this.lx.peek(k);
    if (h.t !== "id" || OPWORDS.has(h.v)) return null;
    let j = k + 1;
    while ((this.is(this.lx.peek(j), ".") || this.is(this.lx.peek(j), "?.")) && this.lx.peek(j + 1).t === "id") j += 2;
    return { head: h.s, end: j };
  }

  /** Moves past one expression: stops before `,` `;` or a closer at depth 0 (top: also before a new statement). */
  skipExpr(top = false) {
    const lx = this.lx;
    let depth = 0;
    let first = true;
    for (;;) {
      const t = lx.peek();
      if (t.t === "eof") return;
      if (t.t === "punc") {
        if (depth === 0 && (t.v === "," || t.v === ";" || CLOSE.has(t.v))) return;
        if (OPEN.has(t.v)) depth++;
        else if (CLOSE.has(t.v)) depth--;
      } else if (top && depth === 0 && !first && t.nl && t.t === "id" && STMT.has(t.v)) return;
      lx.next();
      first = false;
    }
  }

  /** Moves past the closer of a bracket already opened (its opener consumed). */
  skipClose() {
    const lx = this.lx;
    let depth = 1;
    for (;;) {
      const t = lx.next();
      if (t.t === "eof") return;
      if (t.t !== "punc") continue;
      if (OPEN.has(t.v)) depth++;
      else if (CLOSE.has(t.v) && --depth === 0) return;
    }
  }

  /** Moves past a type: stops before `stop` tokens at depth 0, `<`/`>` counted as brackets. */
  skipType(stops, top = false) {
    const lx = this.lx;
    let depth = 0;
    let first = true;
    for (;;) {
      const t = lx.peek();
      if (t.t === "eof") return;
      if (t.t === "punc") {
        if (depth === 0 && (stops.has(t.v) || CLOSE.has(t.v))) return;
        if (OPEN.has(t.v) || t.v === "<") depth++;
        else if (CLOSE.has(t.v) || t.v === ">") depth = Math.max(0, depth - 1);
      } else if (depth === 0 && t.t === "id" && (t.v === "as" || t.v === "satisfies") && !first) return;
      else if (top && depth === 0 && !first && t.nl && t.t === "id" && STMT.has(t.v)) return;
      lx.next();
      first = false;
    }
  }

  /** `as T`, `satisfies T` and `!` after a value. */
  postfix(top) {
    const lx = this.lx;
    for (;;) {
      const t = lx.peek();
      if (t.t === "id" && (t.v === "as" || t.v === "satisfies")) { lx.next(); this.skipType(VALUE_STOPS, top); }
      else if (t.t === "punc" && t.v === "!" && !this.is(lx.peek(1), "=")) lx.next();
      else return;
    }
  }

  /** True when the next token ends the value (so nothing like `+ 'b'` or `(...)` follows). */
  ends(top) {
    const t = this.lx.peek();
    if (t.t === "eof") return true;
    if (t.t === "punc" && (t.v === "," || t.v === ";" || CLOSE.has(t.v))) return true;
    // At the top a new line ends a complete value unless the next token continues it (automatic semicolon insertion,
    // as in files written without semicolons; review finding).
    if (top && t.nl) return !(t.t === "tpl" || (t.t === "punc" && CONTINUES.has(t.v)) || (t.t === "id" && (t.v === "as" || t.v === "satisfies")));
    return false;
  }

  value(depth, top = false) {
    if (depth > MAX_NESTING) throw invalid(this.file, this.text, this.lx.peek().s, `nested deeper than ${MAX_NESTING} levels`);
    const lx = this.lx;
    const t = lx.peek();
    let node;
    if (t.t === "punc" && t.v === "(") {
      // `({...})` or an arrow function `(a) => ...`
      lx.next();
      const inner = this.value(depth + 1);
      if (this.is(lx.peek(), ")") && !this.is(lx.peek(1), "=>")) { lx.next(); node = inner; }
      else {
        this.skipClose();
        const arrow = this.is(lx.peek(), "=>") || this.is(lx.peek(), ":");
        this.skipExpr(top);
        return { k: "skip", kind: arrow ? "function" : "expression", s: t.s };
      }
    } else if (t.t === "punc" && t.v === "{") node = this.object(depth);
    else if (t.t === "punc" && t.v === "[") node = this.array(depth);
    else if (t.t === "str" || t.t === "tpl") { lx.next(); node = { k: "str", v: t.v }; }
    else if (t.t === "num") { lx.next(); node = t.v === null ? { k: "skip", kind: "expression", s: t.s } : { k: "str", v: t.v }; }
    else if (t.t === "punc" && t.v === "-" && lx.peek(1).t === "num" && lx.peek(1).v !== null) { lx.next(); node = { k: "str", v: String(-Number(lx.next().v)) }; }
    else if (t.t === "punc" && t.v === "tpl{") {
      // `${NAME}` and `${obj.key}` only read a name (D27); any other substitution may run code, so it stays a use.
      // Each substitution must be exactly `NAME` or `NAME.key...`; the lexer emits no token between two of them, so
      // the text between two chains must hold the next `${`.
      const heads = [];
      for (let k = 1; k < 256;) {
        const c = this.chain(k);
        if (!c) break;
        heads.push(c.head);
        const u = lx.peek(c.end);
        if (u.t === "punc" && u.v === "tpl}") { heads.forEach((h) => this.allowed.add(h)); break; }
        if (u.t !== "id" || !this.text.slice(lx.peek(c.end - 1).s, u.s).includes("${")) break;
        k = c.end;
      }
      this.skipExpr(top);
      return { k: "skip", kind: "template", s: t.s };
    }
    else if (t.t === "jsx") { lx.next(); node = { k: "skip", kind: "expression", s: t.s }; }
    else if (t.t === "id") {
      if (["function", "async", "class"].includes(t.v)) { this.skipExpr(top); return { k: "skip", kind: "function", s: t.s }; }
      if (["true", "false", "null", "undefined"].includes(t.v) && !this.is(lx.peek(1), ".")) { lx.next(); node = { k: "skip", kind: "literal", s: t.s }; }
      else {
        lx.next();
        let name = t.v, simple = true;
        while (this.is(lx.peek(), ".") || this.is(lx.peek(), "?.")) {
          lx.next();
          const p = lx.next();
          name += `.${p.v}`;
          simple = false;
        }
        const after = lx.peek();
        if (this.is(after, "(") || (after.t === "punc" && after.v === "<" && t.v !== "new")) { this.skipExpr(top); return { k: "skip", kind: "call", callee: name, s: t.s }; }
        if (this.is(after, "=>")) { this.skipExpr(top); return { k: "skip", kind: "function", s: t.s }; }
        if (t.v === "new") { this.skipExpr(top); return { k: "skip", kind: "call", callee: "new", s: t.s }; }
        node = simple ? { k: "ref", name, s: t.s } : { k: "skip", kind: "reference", s: t.s };
      }
    } else { this.skipExpr(top); return { k: "skip", kind: "expression", s: t.s }; }
    this.postfix(top);
    if (!this.ends(top)) {
      const kind = this.is(lx.peek(), "(") ? "call" : "expression";
      this.skipExpr(top);
      return { k: "skip", kind, s: t.s };
    }
    if (node.k === "ref" || (node.k === "skip" && node.kind === "reference")) this.allowed.add(node.s);
    return node;
  }

  /** Moves to the next `,` or the closing `}` of the current object; a stray `)` or `]` is stepped over. */
  skipProp() {
    for (;;) {
      this.skipExpr();
      const t = this.lx.peek();
      if (t.t === "eof" || this.is(t, ",") || this.is(t, "}") || t.v === "tpl}") return;
      this.lx.next();
    }
  }

  object(depth) {
    const lx = this.lx;
    const open = lx.next();
    const props = [];
    for (;;) {
      const t = lx.peek();
      if (t.t === "eof") throw invalid(this.file, this.text, open.s, "unclosed {");
      if (this.is(t, "}")) { lx.next(); break; }
      if (this.is(t, ",")) { lx.next(); continue; }
      if (this.is(t, "...")) {
        lx.next();
        const c = this.chain(0); // `...common` reads a name (D10, D27)
        if (c && (this.is(lx.peek(c.end), ",") || this.is(lx.peek(c.end), "}"))) this.allowed.add(c.head);
        this.skipProp();
        props.push({ spread: true, s: t.s });
        continue;
      }
      let key = null;
      if (t.t === "id" || t.t === "str" || t.t === "tpl") key = t.v;
      else if (t.t === "num" && t.v !== null) key = t.v;
      else if (this.is(t, "[")) {
        lx.next();
        const k = lx.peek();
        if ((k.t === "str" || k.t === "tpl") && this.is(lx.peek(1), "]")) { lx.next(); lx.next(); key = k.v; this.computed = true; }
        else {
          // A computed key that is not a string: its value is unknown under an unknown key. `[KEY]` and `[KEYS.title]`
          // only read a name (D27); anything else in the key, and all of its value, stays a use.
          const c = this.chain(0);
          if (c && this.is(lx.peek(c.end), "]")) this.allowed.add(c.head);
          this.skipProp();
          props.push({ key: null, value: { k: "skip", kind: "computed key", s: t.s } });
          continue;
        }
      }
      if (key === null) { this.skipProp(); props.push({ key: null, value: { k: "skip", kind: "expression", s: t.s } }); continue; }
      if (!this.computed) lx.next();
      this.computed = false;
      if (t.t === "id") this.allowed.add(t.s);
      const after = lx.peek();
      if (this.is(after, ":")) {
        lx.next();
        props.push({ key, value: this.value(depth + 1) });
      } else if (this.is(after, ",") || this.is(after, "}")) {
        props.push({ key, value: t.t === "id" ? { k: "ref", name: key, s: t.s } : { k: "skip", kind: "reference", s: t.s } }); // shorthand `{ title }`
      } else {
        // A method, accessor or anything else: `get title() {...}`, `title() {...}`, `async *gen() {...}`.
        const accessor = t.t === "id" && ["get", "set", "async", "static"].includes(t.v) && (after.t === "id" || after.t === "str" || this.is(after, "[") || this.is(after, "*"));
        const name = accessor && (after.t === "id" || after.t === "str") ? after.v : key;
        this.skipProp();
        props.push({ key: name, value: { k: "skip", kind: "function", s: t.s } });
        continue;
      }
      const end = lx.peek();
      if (!this.is(end, ",") && !this.is(end, "}")) {
        this.skipProp();
        props[props.length - 1].value = { k: "skip", kind: "expression", s: t.s };
      }
    }
    return { k: "obj", props, s: open.s };
  }

  array(depth) {
    const lx = this.lx;
    const open = lx.next();
    const items = [];
    let pending = true; // an element slot is open (holes count as skipped)
    for (;;) {
      const t = lx.peek();
      if (t.t === "eof") throw invalid(this.file, this.text, open.s, "unclosed [");
      if (this.is(t, "]")) { lx.next(); break; }
      if (this.is(t, ",")) {
        lx.next();
        if (pending) items.push({ k: "skip", kind: "expression", s: t.s });
        pending = true;
        continue;
      }
      if (this.is(t, "...")) {
        lx.next();
        const c = this.chain(0);
        if (c && (this.is(lx.peek(c.end), ",") || this.is(lx.peek(c.end), "]"))) this.allowed.add(c.head);
        this.skipExpr(); items.push({ k: "skip", kind: "spread", s: t.s, spread: true }); pending = false; continue; }
      items.push(this.value(depth + 1));
      pending = false;
      const end = lx.peek();
      if (!this.is(end, ",") && !this.is(end, "]")) {
        for (;;) {
          this.skipExpr();
          const u = lx.peek();
          if (u.t === "eof" || this.is(u, ",") || this.is(u, "]")) break;
          lx.next();
        }
        items[items.length - 1] = { k: "skip", kind: "expression", s: t.s };
      }
    }
    return { k: "arr", items, s: open.s };
  }

  /** Top-level statements: exports, declarations and imports. Everything else is stepped over. */
  program() {
    const lx = this.lx;
    const out = { defaults: [], named: new Map(), decls: new Map(), imports: new Map(), cjs: false };
    let depth = 0;
    for (;;) {
      const t = lx.peek();
      if (t.t === "eof") return out;
      if (t.t === "punc") {
        if (OPEN.has(t.v)) depth++;
        else if (CLOSE.has(t.v)) depth = Math.max(0, depth - 1);
        lx.next();
        continue;
      }
      if (depth > 0 || t.t !== "id") { lx.next(); continue; }
      const t1 = lx.peek(1);
      if (t.v === "export" && this.is(t1, "default")) {
        lx.next(); lx.next();
        out.defaults.push({ node: this.value(0, true), s: t.s });
      } else if (t.v === "export" && t1.t === "id" && ["const", "let", "var"].includes(t1.v)) {
        lx.next(); lx.next();
        this.declarations((name, node) => { out.named.set(name, node); out.decls.set(name, node); });
      } else if (["const", "let", "var"].includes(t.v) && lx.peek(1).t === "id" && !this.is(lx.peek(2), "(")) {
        lx.next();
        this.declarations((name, node) => out.decls.set(name, node));
      } else if (t.v === "export" && this.is(t1, "{")) {
        lx.next(); lx.next();
        const list = [];
        while (!this.is(lx.peek(), "}") && lx.peek().t !== "eof") {
          const a = lx.next();
          if (a.t !== "id") continue;
          this.allowed.add(a.s);
          let b = a.v;
          if (this.is(lx.peek(), "as")) { lx.next(); const e = lx.next(); this.allowed.add(e.s); b = e.v; }
          list.push([a.v, b, a.s]);
        }
        lx.next();
        if (this.is(lx.peek(), "from")) continue; // a re-export from another file is not read (D2)
        for (const [local, exported, s] of list) {
          const node = { k: "ref", name: local, s };
          if (exported === "default") out.defaults.push({ node, s });
          else out.named.set(exported, node);
        }
      } else if (t.v === "module" && this.is(t1, ".") && lx.peek(2).v === "exports" && this.is(lx.peek(3), "=")) {
        lx.next(); lx.next(); lx.next(); lx.next();
        this.allowed.add(t.s);
        out.cjs = true;
        out.defaults.push({ node: this.value(0, true), s: t.s });
      } else if (t.v === "import" && !this.is(t1, "(") && !this.is(t1, ".")) {
        lx.next();
        this.importDecl(out.imports);
      } else lx.next();
    }
  }

  /** `NAME [: Type] = value [, NAME = value]...`; destructuring patterns are stepped over. */
  declarations(add) {
    const lx = this.lx;
    for (;;) {
      const name = lx.peek();
      if (name.t !== "id") { this.skipExpr(true); return; }
      lx.next();
      if (this.is(lx.peek(), "!")) lx.next();
      if (this.is(lx.peek(), ":")) { lx.next(); this.skipType(new Set(["=", ",", ";"]), true); }
      if (!this.is(lx.peek(), "=")) { if (!this.is(lx.peek(), ",")) return; lx.next(); continue; }
      lx.next();
      this.allowed.add(name.s);
      const node = this.value(0, true);
      if (node.k === "ref" || (node.k === "skip" && node.kind === "reference")) this.allowed.delete(node.s); // an alias is a use
      add(name.v, node);
      if (!this.is(lx.peek(), ",")) return;
      lx.next();
    }
  }

  /** `import a, { b as c }, * as d from 'src'`: records each local name's source. */
  importDecl(imports) {
    const lx = this.lx;
    const names = [];
    for (;;) {
      const t = lx.peek();
      if (t.t === "eof" || this.is(t, ";")) return;
      if (t.t === "str") { lx.next(); for (const n of names) imports.set(n, t.v); return; }
      lx.next();
      if (t.t === "id" && !["type", "from", "as", "typeof"].includes(t.v)) {
        if (this.is(lx.peek(), "as")) { lx.next(); names.push(lx.next().v); } else names.push(t.v);
      }
      if (t.nl && t.t === "id" && STMT.has(t.v) && t.v !== "type") return;
    }
  }
}

const VALUE_STOPS = new Set([",", ";"]);
// Tokens that continue a value on the next line, so a new line before them is no statement end.
const CONTINUES = new Set(["(", "[", ".", "?.", "+", "-", "*", "/", "%", "&&", "||", "??", "==", "===", "!=", "!==", "<", ">", "<=", "=", "?", ":", "=>", "tpl{"]);

// ---- locales ------------------------------------------------------------------------------------------

const LANGS = (() => { try { return new Intl.DisplayNames(["en"], { type: "language", fallback: "code" }); } catch { return null; } })();

/** An export name as a BCP 47 tag (`de`, `pt_BR`, `ptBR`, `zhHans` -> `zh-Hans`), else null. */
function localeTag(name) {
  const m = /^([a-z]{2,3})(?:[_-]?([A-Z][a-z]{3}|[A-Z]{2}|\d{3})|[_-]([a-z]{2}|[a-z]{4}))?$/.exec(name);
  if (!m) return null;
  const lang = m[1];
  if (!LANGS || LANGS.of(lang) === lang) return null; // not a language code (`app`, `ui`)
  let sub = m[2] || m[3] || "";
  if (sub.length === 2) sub = sub.toUpperCase();
  else if (sub.length === 4) sub = sub[0].toUpperCase() + sub.slice(1).toLowerCase();
  try { return new Intl.Locale(sub ? `${lang}-${sub}` : lang).toString(); } catch { return null; }
}

/** D3: several named exports that are all locale codes. */
function localeExports(prog) {
  if (prog.defaults.length || prog.named.size < 2) return null;
  const tags = new Map();
  for (const name of prog.named.keys()) {
    const tag = localeTag(name);
    if (!tag) return null;
    tags.set(name, tag);
  }
  return tags;
}

/** The export for the run locale: the exact tag, then its language. */
function pickLocale(tags, locale) {
  const want = String(locale).replace(/_/g, "-").toLowerCase();
  for (const [name, tag] of tags) if (tag.toLowerCase() === want) return name;
  const lang = want.split("-")[0];
  for (const [name, tag] of tags) if (tag.toLowerCase() === lang) return name;
  return null;
}

// ---- flattening ---------------------------------------------------------------------------------------

function describe(node, prog) {
  if (node.k === "skip" && node.kind === "call") return `a call (${node.callee}(...))`;
  if (node.k === "skip" && node.kind === "function") return "a function";
  if (node.k === "ref" && prog.imports.has(node.name)) return `an imported value (${node.name} from '${prog.imports.get(node.name)}')`;
  if (node.k === "ref") return `the name ${node.name}, which this file does not define as an object literal`;
  if (node.k === "str") return "a string, not an object";
  if (node.k === "arr") return "an array, not an object";
  return "not an object literal";
}

function hintFor(node, prog, file) {
  const src = node.k === "ref" ? prog.imports.get(node.name) : null;
  if (src && src.startsWith(".")) {
    const rel = path.join(path.dirname(file), src);
    return /\.json$/i.test(src) ? `pass ${rel} with --catalog` : `pass the file it imports (${rel}) with --catalog`;
  }
  return "export the object literal itself (export default { ... }), or pass the JSON file the code imports with --catalog";
}

/**
 * Reads a code catalog. Returns { entries, skipped: { count, kinds, samples }, open, missingLocale }: entries
 * as the other parsers give them (Map key -> { values, reason? }), and `open` the key prefixes under which a
 * spread or a dynamic value may define keys nobody can read (D18). `locale` picks among locale-named exports.
 */
function parse(text, file, locale) {
  const reader = new Reader(text, file);
  const prog = reader.program();
  const use = otherUse(text, file, prog, reader.allowed);
  if (use) return { entries: new Map(), skipped: { count: 0, kinds: {}, samples: [] }, open: [""], missingLocale: false, unread: use };
  const deref = (node) => {
    for (let hop = 0; node && node.k === "ref" && hop < MAX_REF_HOPS; hop++) {
      const d = prog.decls.get(node.name);
      if (!d) break;
      node = d;
    }
    return node;
  };

  let roots; // [[prefix, node]]
  const tags = localeExports(prog);
  if (prog.defaults.length) {
    const d = prog.defaults[prog.defaults.length - 1]; // the last assignment wins, as at runtime
    const node = deref(d.node);
    if (node.k !== "obj") throw invalid(file, text, d.s, `the default export is ${describe(node, prog)}; catscan reads only object literals and never runs the file`, hintFor(node, prog, file));
    roots = [["", node]];
  } else if (tags) {
    const name = pickLocale(tags, locale);
    if (!name) return { entries: new Map(), skipped: { count: 0, kinds: {}, samples: [] }, open: [], missingLocale: true, locales: [...tags.values()] };
    const node = deref(prog.named.get(name));
    if (node.k !== "obj") throw invalid(file, text, node.s ?? 0, `the export ${name} is ${describe(node, prog)}; catscan reads only object literals and never runs the file`, hintFor(node, prog, file));
    roots = [["", node]];
  } else {
    const objects = [...prog.named].map(([n, node]) => [n, deref(node)]).filter(([, node]) => node.k === "obj");
    if (!objects.length) {
      const [n, node] = [...prog.named][0] || [];
      if (node) throw invalid(file, text, node.s ?? 0, `the export ${n} is ${describe(deref(node), prog)}; catscan reads only object literals and never runs the file`, hintFor(deref(node), prog, file));
      throw invalid(file, text, 0, "no exported object literal", "export the strings as export default { ... }, export const name = { ... } or module.exports = { ... }");
    }
    roots = objects.length === 1 ? [["", objects[0][1]]] : objects.map(([n, node]) => [n, node]);
  }

  // D17: an index whose every value is an import is not a catalog; name the files instead.
  if (roots.length === 1) {
    const props = roots[0][1].props;
    const imported = props.filter((p) => p.value && p.value.k === "ref" && prog.imports.has(p.value.name));
    if (props.length && imported.length && props.every((p) => p.value && p.value.k !== "str" && p.value.k !== "obj" && p.value.k !== "arr" && deref(p.value).k !== "obj")) {
      const files = [...new Set(imported.map((p) => prog.imports.get(p.value.name)))];
      throw invalid(file, text, roots[0][1].s, `${path.basename(file)} re-exports other files (${files.join(", ")}); catscan does not follow imports`,
        `pass those files with --catalog, e.g. --catalog '${path.join(path.dirname(file), "{locale}")}${path.extname(file)}'`);
    }
  }

  const entries = new Map();
  const open = new Set();
  const kinds = {};
  const samples = [];
  let count = 0;
  const log = []; // every key written, in order, so a spread can mark what came before it in linear time
  // A const reached from several places is walked once per reference, so `const a1 = { l: a0, r: a0 }` chains
  // double per line and one long key reused 20k times is a gigabyte (review findings). Two budgets keep time and
  // memory linear: walk steps (a file without reuse takes at most one per character, plus room for ordinary reuse)
  // and the bytes of the keys and strings made, the 32 MB that loadAll allows for the whole run.
  let steps = text.length + 1000000;
  let bytes = MAX_TOTAL_BYTES;
  const charge = (key, value) => {
    bytes -= key.length + value.length + 8;
    if (bytes < 0) throw new UsageError("catalog-too-large", `the catalog ${file} expands to over 32 MB of keys and strings`, "write each object once instead of reusing it many times, or split the catalog");
  };
  const dynamic = (key, kind, override = false) => {
    // "a.b": "x" next to { a: { b: f() } }: which one wins would be silent (as in JSON).
    if (!override && entries.has(key)) throw invalid(file, text, 0, `the key ${key} is defined twice (flat and nested)`);
    charge(key, "");
    log.push(key);
    entries.set(key, { values: [], reason: DYNAMIC });
    open.add(key);
    kinds[kind] = (kinds[kind] || 0) + 1;
    count++;
    if (samples.length < 3) samples.push(key);
  };
  const set = (key, value, at) => {
    // "a.b" and { a: { b } } name the same key; which one wins would be silent (as in JSON).
    if (entries.has(key)) throw invalid(file, text, at, `the key ${key} is defined twice (flat and nested)`);
    charge(key, value);
    log.push(key);
    entries.set(key, { values: [value] });
  };
  const walk = (node, key, depth, seen) => {
    if (depth > MAX_NESTING) throw invalid(file, text, node.s ?? 0, `nested deeper than ${MAX_NESTING} levels`);
    if (--steps < 0) {
      throw invalid(file, text, node.s ?? 0, "objects reused by reference expand past a million entries", "write each object once instead of reusing it many times");
    }
    if (node.k === "ref") {
      const d = deref(node);
      if (d.k === "ref" || seen.has(d)) return dynamic(key, "reference");
      return walk(d, key, depth, new Set(seen).add(d));
    }
    if (node.k === "str") return set(key, node.v, node.s ?? 0);
    if (node.k === "skip") return dynamic(key, node.kind);
    if (node.k === "arr") {
      // After a spread the length is unknown, so no later item has a known index (the D10 risk for arrays).
      const at = node.items.findIndex((x) => x.spread);
      if (at >= 0) { open.add(key); dynamic(`${key}[${at}]`, "spread"); }
      node.items.forEach((x, i) => { if (at < 0 || i < at) walk(x, `${key}[${i}]`, depth + 1, seen); });
      return;
    }
    // Duplicate literal keys: the last wins, at the position of the last (JS semantics).
    const props = new Map();
    let spreadAt = -1; // the last spread or unreadable computed key: either may replace any key written before it
    node.props.forEach((p, i) => {
      if (p.spread) { spreadAt = i; return; }
      const k = p.key === null ? null : p.key;
      if (k === null) {
        // A computed key nobody can read: any key of this object may be it, so earlier keys are not trusted.
        spreadAt = i;
        kinds[p.value.kind] = (kinds[p.value.kind] || 0) + 1;
        count++;
        open.add(key);
        if (samples.length < 3) samples.push(key ? `${key}[...]` : "[...]");
        return;
      }
      props.delete(k);
      props.set(k, { value: p.value, i });
    });
    if (node.props.some((p) => p.spread)) { open.add(key); kinds.spread = (kinds.spread || 0) + 1; count++; }
    for (const [k, { value, i }] of props) {
      const full = key ? `${key}.${k}` : k;
      if (i < spreadAt) {
        // D10: a later spread may override this key, so its literal cannot be trusted.
        const before = log.length;
        walk(value, full, depth + 1, seen);
        const end = log.length;
        for (let j = before; j < end; j++) if (!entries.get(log[j]).reason) dynamic(log[j], "spread", true);
        open.add(full);
      } else walk(value, full, depth + 1, seen);
    }
  };
  for (const [prefix, node] of roots) walk(node, prefix, 0, new Set([node]));
  return { entries, skipped: { count, kinds, samples }, open: [...open], missingLocale: false };
}

/**
 * D27: a catalog object is trusted only when every use of its name is its declaration, an export, a `typeof`
 * type, or a value or key inside a literal catscan read. Any other use (an assignment, `delete`, an alias, a call
 * argument, code in a function) may change it at runtime, and tracking that is flow analysis catscan does not do,
 * so the whole file is unread. Returns { name, line, col } of the first such use, else null. One linear pass.
 */
/**
 * After `typeof NAME`: true when the chain ends without a call, an index, a tagged template or `++`/`--`, so it only
 * reads (`typeof m.a++` runs; `typeof m.a = x` is a syntax error, so `=` is the type annotation's).
 */
function typeOnly(lx) {
  // An index is a type position or a read (`typeof resources['en']`, `typeof locales[number]`): step over it.
  let j = 0;
  for (let steps = 0; steps < 64; steps++) {
    const u = lx.peek(j);
    if (u.t === "punc" && (u.v === "." || u.v === "?.") && lx.peek(j + 1).t === "id") { j += 2; continue; }
    if (u.t === "punc" && u.v === "[") {
      let depth = 0;
      do {
        const w = lx.peek(j++);
        if (w.t === "eof") return false;
        if (w.t === "punc" && OPEN.has(w.v)) depth++;
        else if (w.t === "punc" && CLOSE.has(w.v)) depth--;
      } while (depth > 0 && j < 4096);
      continue;
    }
    break;
  }
  const u = lx.peek(j);
  return !(u.t === "tpl" || (u.t === "punc" && ["(", "++", "--", "tpl{"].includes(u.v)));
}

/** `{ resources: X }` or `resources?: X` in a type or object: a key that names no binding (i18next `CustomTypeOptions`). */
function propertyKey(t, prev, lx) {
  const at = !prev || t.nl || (prev.t === "punc" && ["{", ",", ";"].includes(prev.v));
  const n = lx.peek(0);
  return at && n.t === "punc" && (n.v === ":" || (n.v === "?" && lx.peek(1).t === "punc" && lx.peek(1).v === ":"));
}

function otherUse(text, file, prog, allowed) {
  const names = new Set(prog.decls.keys());
  if (prog.cjs) { names.add("module"); names.add("exports"); }
  if (!names.size) return null;
  const lx = new Lexer(text, file);
  let prev = null;
  for (;;) {
    const t = lx.next();
    if (t.t === "eof") return null;
    if (t.t === "id" && names.has(t.v) && !allowed.has(t.s) && !(prev && prev.t === "punc" && (prev.v === "." || prev.v === "?.")) && !(prev && prev.t === "id" && prev.v === "typeof" && typeOnly(lx)) && !propertyKey(t, prev, lx)) {
      let line = 1, col = 1;
      for (let i = 0; i < t.s; i++) { if (text[i] === "\n") { line++; col = 1; } else col++; }
      return { name: t.v, line, col };
    }
    prev = t;
  }
}

/** The locales of a file with several locale-named exports (D11), else null. Never throws. */
function locales(text, file) {
  try {
    const tags = localeExports(new Reader(text, file).program());
    return tags ? [...tags.values()].sort() : null;
  } catch { return null; }
}

module.exports = { parse, locales, localeTag, DYNAMIC, MAX_TOTAL_BYTES, EXTENSIONS: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] };
