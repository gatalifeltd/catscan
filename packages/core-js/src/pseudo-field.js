// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-039 T2: the core's `pseudo` request field for `untranslated`, `truncated` and `check` with --pseudo.
// Matching runs in the core (Pseudo.swift); this module sends the base catalog, the generator's filler words
// (pseudo.js, so the two never drift) and the shared dynamic-text guards (TODO-036 check 4, D10).
const crypto = require("crypto");
const fs = require("fs");
const { UsageError } = require("./args");
const { FILLER } = require("./pseudo");

const MAX_DYNAMIC_BYTES = 1024 * 1024;

/** `--dynamic <file>`: one regex per line, matched against the whole line; `#` comments (TODO-036 D18). */
function loadDynamic(file) {
  let text;
  try {
    if (fs.statSync(file).size > MAX_DYNAMIC_BYTES) throw new UsageError("dynamic-invalid", `the dynamic list ${file} is over 1 MB`, "keep one pattern per kind of dynamic text");
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    if (e instanceof TypeError) throw new UsageError("dynamic-invalid", `the dynamic list ${file} is not UTF-8`, "save it as UTF-8, one regex per line");
    throw new UsageError("dynamic-not-found", `cannot read the dynamic list ${file}: ${e.code || e.message}`, "check the --dynamic path; it is read from the working directory");
  }
  const out = [];
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith("#")) return;
    // The core runs the pattern with ICU (NSRegularExpression); this check is JavaScript's, so cli.md asks for
    // the common subset (no lookbehind, no inline flags).
    try { new RegExp(l, "u"); } catch (e) {
      throw new UsageError("dynamic-invalid", `${file}:${i + 1}: not a valid regex: ${e.message}`, "one regex per line, matched against the whole line, e.g. Hi, \\w+!");
    }
    out.push(l);
  });
  return out;
}

/** `--locale en-XA` or `ar-XB` (the CLDR pseudo regions) recognizes as en: pseudo text is Latin (D12). */
function ocrLocale(l) {
  return l && /[-_](XA|XB)$/i.test(l) ? "en" : l;
}

/** Whether a placeholder starts (lead) or ends (trail) alternative `i`, as the catalog parser saw it. */
function edges(entry, i) {
  const e = entry.edges?.[i];
  return { lead: e ? e.lead : false, trail: e ? e.trail : false };
}

// The core's caps on the field (Serve.pseudoJob), checked first so a big catalog is a usage error (exit 2).
const CAPS = { entries: 20000, forms: 256, fragments: 256 };
const MAX_FIELD_BYTES = 32 * 1024 * 1024;

/**
 * The request field from a loaded catalog (`catalog.loadAll`) and the run options. Returns { field, digest, bytes }.
 * `cat` may be null (check --pseudo needs no entries).
 */
function build(cat, opts, allow = []) {
  const entries = [];
  if (cat) {
    for (const e of cat.keys.values()) {
      if (e.reason) continue;
      const forms = e.alternatives.map((a, i) => ({ fragments: a, ...edges(e, i) })).filter((f) => f.fragments.length);
      const tooMany = (what, limit) => new UsageError("catalog-too-many-strings", `${what}; the limit is ${limit}`, "pass only the catalogs the screens use");
      if (forms.length > CAPS.forms) throw tooMany(`the base string of ${e.key} has ${forms.length} forms`, CAPS.forms);
      const n = forms.reduce((k, f) => k + f.fragments.length, 0);
      if (n > CAPS.fragments) throw tooMany(`the base string of ${e.key} has ${n} fragments`, CAPS.fragments);
      if (forms.length) entries.push({ key: e.key, catalog: e.catalog ?? null, text: e.text, forms });
    }
  }
  const field = { entries, fillers: FILLER, dynamic: opts.dynamic ? loadDynamic(opts.dynamic) : [], allow };
  if (entries.length > CAPS.entries) throw new UsageError("catalog-too-many-strings", `the catalog gives ${entries.length} strings to check; the limit is ${CAPS.entries}`, "pass only the catalogs the screens use");
  const json = JSON.stringify(field);
  if (Buffer.byteLength(json) > MAX_FIELD_BYTES) throw new UsageError("catalog-too-large", `the catalog makes a pseudo request of over ${MAX_FIELD_BYTES / 1024 / 1024} MB`, "pass only the catalogs the screens use");
  return { field, bytes: Buffer.byteLength(json), digest: crypto.createHash("sha256").update(json).digest("hex").slice(0, 32) };
}

module.exports = { build, loadDynamic, ocrLocale, edges, CAPS };
