// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// `check --expect <file>`: per-image checks from YAML or JSON (spec 01).
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { UsageError, LOCALE_RE } = require("./args");
// A lone UTF-16 surrogate survives JSON.parse but cannot cross to the Swift core as JSON.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const MAX_BYTES = 1024 * 1024;
const MAX_ALIAS_NODES = 1000;
// The YAML 1.2 core schema tags. Anything else, including YAML 1.1 extras such as !!binary, is rejected.
const CORE_TAGS = new Set(["str", "int", "float", "bool", "null", "map", "seq"].map((t) => `tag:yaml.org,2002:${t}`));

function fail(file, message) {
  return new UsageError("invalid-expect-file", `${file}: ${message}`);
}

/**
 * Reads and validates an expect file. Returns { locale, shots: [{ key, glob, present, absent }] } for check, or
 * { locale, ranges: [{ key, start, end, present, absent }] } for video (spec 07 D7).
 */
function load(file, command = "check") {
  let st;
  try { st = fs.statSync(file); } catch { throw new UsageError("expect-file-not-found", `no such expect file: ${file}`); }
  if (!st.isFile()) throw fail(file, "not a file");
  if (st.size > MAX_BYTES) throw fail(file, "the file is over the 1 MB limit");
  const text = fs.readFileSync(file, "utf8");
  return parse(text, file, command);
}

function parse(text, file = "expect file", command = "check") {
  if (Buffer.byteLength(text) > MAX_BYTES) throw fail(file, "the file is over the 1 MB limit");
  let data;
  if (file.toLowerCase().endsWith(".json")) {
    try { data = JSON.parse(text); } catch (e) { throw fail(file, `invalid JSON: ${e.message}`); }
  } else {
    const doc = YAML.parseDocument(text, { version: "1.2", schema: "core", customTags: [], uniqueKeys: true, prettyErrors: false });
    if (doc.errors.length) throw fail(file, `invalid YAML: ${doc.errors[0].message}`);
    let tagged = false;
    YAML.visit(doc, { Node(_, node) { if (node.tag && !CORE_TAGS.has(node.tag)) tagged = true; } });
    const tagWarning = doc.warnings.find((w) => w.code === "TAG_RESOLVE_FAILED");
    if (tagged || tagWarning) throw fail(file, "custom tags are not allowed");
    try {
      data = doc.toJS({ maxAliasCount: MAX_ALIAS_NODES });
    } catch (e) {
      throw fail(file, `alias expansion is over the limit of ${MAX_ALIAS_NODES} nodes`);
    }
  }
  return validate(data, file, command);
}

function stringList(v, where, file) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw fail(file, `${where} must be a list of strings`);
  for (const s of v) if (LONE_SURROGATE.test(s)) throw fail(file, `${where} has a string that is not valid Unicode`);
  return v;
}

const RANGE_RE = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)?$/;

function validate(data, file, command = "check") {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw fail(file, "the top level must be a mapping");
  const listKey = command === "video" ? "ranges" : "shots";
  for (const k of Object.keys(data)) {
    if (k === "shots" || k === "ranges") {
      if (k !== listKey) {
        throw new UsageError("invalid-expect-file", `${file}: a ${command} --expect file uses ${listKey}:, not ${k}:`,
          command === "video" ? 'ranges: {"0-2.5": {present: [...]}}' : 'shots: {"login.png": {present: [...]}}');
      }
    } else if (k !== "locale") throw fail(file, `unknown key ${k}; expected locale or ${listKey}`);
  }
  if (data.locale !== undefined && (typeof data.locale !== "string" || !LOCALE_RE.test(data.locale))) {
    throw fail(file, "locale must be a BCP 47 code such as de, pt-BR or zh-Hant");
  }
  if (command === "video") return validateRanges(data, file);
  const shots = data.shots;
  if (shots === null || typeof shots !== "object" || Array.isArray(shots)) throw fail(file, "shots must be a mapping of image names to checks");
  const out = [];
  for (const [rawKey, v] of Object.entries(shots)) {
    // APFS keeps names as written (often NFD); keys and paths are both compared in NFC.
    const key = rawKey.normalize("NFC");
    if (key === "" || key.startsWith("/") || /^[A-Za-z]:/.test(key) || key.split(/[\\/]/).includes("..")) {
      throw fail(file, `key ${JSON.stringify(key)} must be a relative path without ..`);
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw fail(file, `shots.${key} must be a mapping with present and absent`);
    for (const k of Object.keys(v)) if (!["present", "absent"].includes(k)) throw fail(file, `shots.${key}: unknown key ${k}`);
    out.push({
      key,
      glob: /[*?[]/.test(key) ? globFor(key, file) : null,
      present: stringList(v.present, `shots.${key}.present`, file),
      absent: stringList(v.absent, `shots.${key}.absent`, file),
    });
  }
  return { locale: data.locale ?? null, shots: out };
}

/** `"0-2.5"`, `"4-"` (to the end): seconds, bounds inclusive (spec 07 D7). */
function validateRanges(data, file) {
  const ranges = data.ranges;
  if (ranges === null || typeof ranges !== "object" || Array.isArray(ranges)) throw fail(file, "ranges must be a mapping of time ranges to checks");
  const out = [];
  for (const [key, v] of Object.entries(ranges)) {
    const m = RANGE_RE.exec(key);
    if (!m) throw fail(file, `range ${JSON.stringify(key)} must be "<start>-<end>" or "<start>-" in seconds, such as "0-2.5" or "4-"`);
    const start = Number(m[1]), end = m[2] === undefined ? null : Number(m[2]);
    if (!Number.isFinite(start) || (end !== null && !Number.isFinite(end))) throw fail(file, `range ${JSON.stringify(key)} is out of range`);
    if (end !== null && end < start) throw fail(file, `range ${JSON.stringify(key)} ends before it starts`);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw fail(file, `ranges.${key} must be a mapping with present and absent`);
    for (const k of Object.keys(v)) if (!["present", "absent"].includes(k)) throw fail(file, `ranges.${key}: unknown key ${k}`);
    out.push({
      key, start, end,
      present: stringList(v.present, `ranges.${key}.present`, file),
      absent: stringList(v.absent, `ranges.${key}.absent`, file),
    });
  }
  return { locale: data.locale ?? null, ranges: out };
}

function globFor(key, file) {
  try { return globToRegExp(key); } catch { throw fail(file, `key ${JSON.stringify(key)} is not a valid glob`); }
}

/** `*` and `?` stay within one path segment; `**` crosses segments; `[...]` is a class (`[!...]` negates). */
function globToRegExp(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = g.indexOf("]", i + 2);
      if (end < 0) { re += "\\["; continue; }
      let body = g.slice(i + 1, end);
      if (body.startsWith("!")) body = "^" + body.slice(1);
      re += "[" + body.replace(/\\/g, "\\\\") + "]";
      i = end;
    } else re += c.replace(/[.+^${}()|\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "u");
}

/**
 * Checks for one image from its path relative to the input argument. Returns { present, absent, keys }.
 * Every matching key contributes.
 */
function checksFor(expect, rel) {
  const present = [], absent = [], keys = [];
  for (const s of expect.shots) {
    if (s.glob ? s.glob.test(rel) : s.key === rel) {
      keys.push(s.key);
      present.push(...s.present);
      absent.push(...s.absent);
    }
  }
  return { present, absent, keys };
}

/** The relative path an expect key is matched against: inside a folder argument, else the file name. */
function relativeTo(arg, file, argIsDir) {
  return (argIsDir ? path.relative(arg, file) : path.basename(file)).split(path.sep).join("/").normalize("NFC");
}

module.exports = { load, parse, checksFor, relativeTo, globToRegExp, MAX_BYTES };
