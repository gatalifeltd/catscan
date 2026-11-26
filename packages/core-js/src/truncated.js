// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// `catscan truncated` (spec 06): options, boxes and catalogs in, the core's `truncated` request field out (D2).
// Every rule runs in the core; this module only loads files and picks each image's boxes.
const { UsageError, closest } = require("./args");
const catalog = require("./catalog");
const boxes = require("./boxes");
const { loadAllow } = require("./untranslated");
const pseudoField = require("./pseudo-field");

// The core's Truncation.reasons; TruncationTests sends each, so the lists cannot drift.
const REASONS = ["ellipsis", "prefix", "edge", "overflow", "screen-edge", "pseudo-cut"];

function parseReasons(v) {
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new UsageError("unknown-reason", "--reasons needs at least one reason", `--reasons ${REASONS.join(",")}`);
  for (const r of list) {
    if (!REASONS.includes(r)) {
      const s = closest(r, REASONS);
      throw new UsageError("unknown-reason", `--reasons: unknown reason ${r}${s ? `; did you mean ${s}?` : ""}`, `--reasons ${REASONS.join(",")}`);
    }
  }
  return [...new Set(list)];
}

/**
 * Loads everything the run needs before any image is read, so a bad file is a usage error (exit 2).
 * Returns { base, warnings, forInput(inp) -> { field, warnings }, pseudo }. `boxesOnly` loads only the boxes
 * (`untranslated --pseudo --boxes` reads their `dynamic: true` elements).
 */
function build(opts, list, { boxesOnly = false } = {}) {
  const base = {};
  const warnings = [];
  let pseudo = null;
  if (opts.reasons !== null) base.reasons = parseReasons(opts.reasons);
  if (base.reasons?.includes("pseudo-cut") && !opts.pseudo) {
    throw new UsageError("option-not-valid", "--reasons pseudo-cut needs --pseudo (a pseudo-localized build)", "catscan truncated shots/ --pseudo --catalog locales/en.json --reasons pseudo-cut");
  }
  if (opts.allow && !boxesOnly) base.allow = loadAllow(opts.allow);
  if (opts.catalogs.length && !boxesOnly) {
    const cat = catalog.loadAll(opts.catalogs, opts.locale ?? "en");
    warnings.push(...cat.warnings);
    // D24: spec 02's fragments; a capped or empty entry has no text to be a prefix of.
    base.prefixes = [...cat.keys.values()].filter((e) => !e.reason && e.alternatives.some((a) => a.length))
      .map((e) => ({ text: e.text, alternatives: e.alternatives.filter((a) => a.length) }));
    // TODO-039 T2: pseudo-cut matches against the same base catalog; overflow folds pseudo text.
    if (opts.pseudo) { pseudo = pseudoField.build(cat, opts, base.allow || []); base.pseudo = true; }
  }
  const perInput = boxes.forRun(opts.boxes, list);
  const forInput = (inp) => {
    const field = { ...base };
    const w = [];
    const { boxes: b, looked } = perInput(inp);
    if (b) field.boxes = b;
    else if (looked === "-") {
      w.push({ code: "boxes-missing", message: "no boxes for - (stdin has no path to find a sidecar by); checked without boxes", hint: "pass the image as a file, or --boxes <file> for it" });
    } else if (looked) {
      w.push({ code: "boxes-missing", message: `no boxes for ${inp.path} (looked for ${looked}); checked without boxes`, hint: `catscan boxes <source> <dump> --image ${inp.path} > ${looked}` });
    }
    return { field, warnings: w };
  };
  return { warnings, forInput, pseudo };
}

module.exports = { build, parseReasons, REASONS };
