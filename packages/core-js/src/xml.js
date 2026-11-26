// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// A minimal XML reader for Android `strings.xml` (spec 02). Catalogs come from the repo under test,
// so it never processes a DTD: any <!DOCTYPE> is rejected, and only the five predefined entities and
// numeric references are expanded (no XXE, no billion laughs; spec 02 D4).

class XmlError extends Error {
  constructor(message, line, column) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
const NAME = /[A-Za-z_:][\w:.-]*/y;

/** Parses `text` into { name, attrs, children } where children are strings or elements. */
function parse(text) {
  let i = 0;
  const err = (message, at = i) => {
    const before = text.slice(0, at).split("\n");
    return new XmlError(message, before.length, before[before.length - 1].length + 1);
  };
  const decode = (s, at) => s.replace(/&([^;&\s]*);?/g, (m, name, off) => {
    if (!m.endsWith(";")) throw err("an & must start an entity such as &amp;", at + off);
    if (ENTITIES[name] !== undefined) return ENTITIES[name];
    const num = /^#x([0-9a-fA-F]+)$/.exec(name) || /^#([0-9]+)$/.exec(name);
    if (num) {
      const cp = parseInt(num[1], num[0].startsWith("#x") ? 16 : 10);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0) throw err(`invalid character reference &${name};`, at + off);
      return String.fromCodePoint(cp);
    }
    throw err(`unknown entity &${name}; (only &lt; &gt; &amp; &quot; &apos; and numeric references are allowed)`, at + off);
  });
  const name = () => {
    NAME.lastIndex = i;
    const m = NAME.exec(text);
    if (!m) throw err("expected a name");
    i += m[0].length;
    return m[0];
  };
  const skipSpace = () => { while (i < text.length && /\s/.test(text[i])) i++; };

  const root = { name: null, attrs: {}, children: [] };
  const stack = [root];
  while (i < text.length) {
    const top = stack[stack.length - 1];
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) throw err("unterminated comment");
      i = end + 3;
    } else if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9);
      if (end < 0) throw err("unterminated CDATA section");
      top.children.push({ cdata: text.slice(i + 9, end) });
      i = end + 3;
    } else if (text.startsWith("<!", i)) {
      throw err(text.startsWith("<!DOCTYPE", i) ? "a DOCTYPE is not allowed in a catalog (DTDs and entities are disabled)" : "unexpected <!");
    } else if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) throw err("unterminated processing instruction");
      i = end + 2;
    } else if (text.startsWith("</", i)) {
      const at = i;
      i += 2;
      const n = name();
      skipSpace();
      if (text[i] !== ">") throw err("expected >");
      i++;
      if (stack.length === 1 || top.name !== n) throw err(`unexpected closing tag </${n}>`, at);
      stack.pop();
    } else if (text[i] === "<") {
      i++;
      const el = { name: name(), attrs: {}, children: [] };
      for (;;) {
        skipSpace();
        if (text.startsWith("/>", i)) { i += 2; top.children.push(el); break; }
        if (text[i] === ">") { i++; top.children.push(el); stack.push(el); break; }
        if (i >= text.length) throw err(`unterminated tag <${el.name}>`);
        const a = name();
        skipSpace();
        if (text[i] !== "=") throw err(`expected = after the attribute ${a}`);
        i++;
        skipSpace();
        const q = text[i];
        if (q !== "\"" && q !== "'") throw err(`the value of ${a} must be quoted`);
        const end = text.indexOf(q, i + 1);
        if (end < 0) throw err(`unterminated value of ${a}`);
        if (text.slice(i + 1, end).includes("<")) throw err(`< is not allowed in the value of ${a}`, i + 1);
        el.attrs[a] = decode(text.slice(i + 1, end), i + 1);
        i = end + 1;
      }
    } else {
      const end = text.indexOf("<", i);
      const raw = text.slice(i, end < 0 ? text.length : end);
      const at = i;
      i = end < 0 ? text.length : end;
      if (stack.length === 1) {
        if (raw.trim()) throw err("text outside the root element", at);
      } else top.children.push(decode(raw, at));
    }
  }
  if (stack.length > 1) throw err(`unclosed element <${stack[stack.length - 1].name}>`);
  const elements = root.children.filter((c) => typeof c === "object" && c.name);
  if (elements.length !== 1) throw err(elements.length ? "more than one root element" : "no root element");
  return elements[0];
}

module.exports = { parse, XmlError };
