// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-077: severity and certainty for every finding and failed check, the `gate` under the run's thresholds, and
// the final verdict. annotate() is the only code that sets them (D8); every output reads its result.
const crypto = require("crypto");
const { CatscanError } = require("./install");

const SEVERITIES = ["critical", "major", "minor"];
const CERTAINTIES = ["high", "medium", "low"];
const DEFAULTS = Object.freeze({ min_severity: "minor", min_certainty: "low" });
// Kept as the core set them (D8, D26): none of them is a pass or a fail.
const KEPT = new Set(["error", "needs-reader", "unsupported"]);
const BUG_HINT = "this is a bug: report it at https://github.com/gatalifeltd/catscan/issues";

let registry = require("./findings-registry.json");
let index = null;

/** The registry rule of an item (TODO-077 "Finding registry", D25). */
function ruleOf(item, isCheck) {
  if (isCheck) return item.kind;
  if (item.kind === "truncated" || item.kind === "fit") return item.reason;
  if (item.kind === "overlap" || item.kind === "occluded") return item.signal;
  if (item.kind === "wrong-language" || item.kind === "hardcoded") return item.evidence;
  if (item.kind === "format" || item.kind === "currency") return item.rule;
  if (item.kind === "price") return item.field;
  return "-";
}

const readerOf = (env) => (typeof env.engine === "string" && env.engine.startsWith("tesseract-") ? "tesseract" : "vision");

/**
 * The certainty rule (TODO-077 "Certainty rule", D2, D14): the band and the precision it came from, unrounded.
 * Experimental and deterministic rows take their band from that status, so their precision is null.
 */
function certaintyOf(row) {
  if (row.deterministic) return { certainty: "high", precision: null };
  if (row.experimental) return { certainty: "low", precision: null };
  const real = row.real;
  if (real && typeof real.precision === "number" && real.flags >= 20 && !real.tuned_on) {
    const p = real.precision;
    return { certainty: p >= 0.95 ? "high" : p >= 0.8 ? "medium" : "low", precision: p };
  }
  const s = row.synthetic;
  if (s && typeof s.precision === "number") return { certainty: s.precision >= 0.9 ? "medium" : "low", precision: s.precision };
  return { certainty: "low", precision: null };
}

function rowsByKey() {
  if (index) return index;
  index = new Map();
  for (const r of registry.rows) index.set(`${r.kind}\0${r.rule}\0${r.reader}`, r);
  return index;
}

function lookup(kind, rule, reader) {
  const row = rowsByKey().get(`${kind}\0${rule}\0${reader}`);
  if (!row) throw new CatscanError("registry-invalid", `findings-registry.json has no row for kind ${kind}, rule ${rule}, reader ${reader}`, BUG_HINT);
  return row;
}

/** `run.registry`: the first 12 hex digits of the sha256 of the registry's canonical JSON. */
let id = null;
function registryId() {
  if (id) return id;
  const { canonical } = require("./results");
  id = crypto.createHash("sha256").update(canonical(registry)).digest("hex").slice(0, 12);
  return id;
}

const atLeast = (levels, value, min) => levels.indexOf(value) <= levels.indexOf(min);

/** Whether a finding gates (TODO-077 "Thresholds"); an item with no severity (a pre-scale file) always gates (D15). */
function gates(item, th) {
  if (item.severity === undefined) return true;
  return atLeast(SEVERITIES, item.severity, th.min_severity) && atLeast(CERTAINTIES, item.certainty, th.min_certainty);
}

const failedChecks = (env) => (env.checks || []).filter((c) => c.verdict === "fail");

/** The verdict from the gates: error, needs-reader and unsupported are kept; else fail iff a check failed or a finding gates. */
function verdictOf(env) {
  if (KEPT.has(env.verdict)) return env.verdict;
  return failedChecks(env).length || (env.findings || []).some((f) => f.gate !== false) ? "fail" : "pass";
}

/**
 * Sets severity, certainty, precision and gate on every finding and failed check, then the verdict. Mutates `env`.
 * `known` (TODO-055 D6): a Map finding -> { known, found, approved } from known.matchEnvelope, or null. A known
 * finding never gates; with `known`, every approvable finding carries `known`, and a new one its `known_counts`.
 */
function annotate(env, thresholds = DEFAULTS, known = null) {
  const reader = readerOf(env);
  const set = (item, kind, rule, gate) => {
    const row = lookup(kind, rule, reader);
    const c = certaintyOf(row);
    item.severity = row.severity;
    item.certainty = c.certainty;
    item.precision = c.precision === null ? null : Math.round(c.precision * 1000) / 1000;
    item.gate = gate ?? gates(item, thresholds);
  };
  // Failed checks always gate: a check is the user's own assertion (D4).
  for (const c of failedChecks(env)) set(c, "check", c.kind, true);
  for (const f of env.findings || []) set(f, f.kind, ruleOf(f, false));
  if (known) markKnown(env, known);
  env.verdict = verdictOf(env);
  return env;
}

/** TODO-055: `known` on each matched finding, `known_counts` on a new one, and gate false on a known one. */
function markKnown(env, known) {
  for (const f of env.findings || []) {
    const m = known.get(f);
    if (!m) continue;
    f.known = m.known;
    if (m.known) f.gate = false;
    else f.known_counts = { found: m.found, approved: m.approved };
  }
}

/**
 * `results merge` and `report` with threshold flags (TODO-077 "Results file"): `gate` and the verdict from each item's
 * stored severity and certainty, never the registry, so old shards are not re-banded. Returns how many findings have
 * no severity (they still gate: `unscaled-items`).
 */
function regate(env, thresholds) {
  let unscaled = 0;
  for (const f of env.findings || []) {
    if (f.severity === undefined) { unscaled++; continue; }
    f.gate = f.known === true ? false : gates(f, thresholds); // TODO-055 D28: a known finding never gates
  }
  for (const c of failedChecks(env)) if (c.severity !== undefined) c.gate = true;
  env.verdict = verdictOf(env);
  return unscaled;
}

// ---- sort (TODO-077 "Sort order", D11) -------------------------------------------------------------------

/** [gate, severity, certainty]: lower ranks first; an item with no severity ranks after its gate group's scaled ones. */
function itemKey(item) {
  // TODO-055: known findings come after the below-threshold ones.
  const gate = item.gate === false ? (item.known === true ? 2 : 1) : 0;
  const s = item.severity === undefined ? SEVERITIES.length : SEVERITIES.indexOf(item.severity);
  const c = item.certainty === undefined ? CERTAINTIES.length : CERTAINTIES.indexOf(item.certainty);
  return [gate, s, c];
}

function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** A stable sort by gate, severity, certainty; ties keep their order. Returns a new array. */
function sortItems(items) {
  return items.map((it, i) => ({ it, i, k: itemKey(it) })).sort((a, b) => cmpKey(a.k, b.k) || a.i - b.i).map((x) => x.it);
}

/** The items an envelope is ranked by: its failed checks and its findings. */
const itemsOf = (env) => [...failedChecks(env), ...(env.findings || [])];

/** An input's rank key: error, needs-reader and unsupported first, then its first item's key; nothing to show last. */
function envKey(env) {
  if (KEPT.has(env.verdict)) return [-1, 0, 0];
  const items = itemsOf(env);
  if (!items.length) return [2, SEVERITIES.length + 1, CERTAINTIES.length + 1];
  return items.map(itemKey).sort(cmpKey)[0];
}

/** A stable sort of envelopes by rank. Returns a new array. */
function sortEnvelopes(envs) {
  return envs.map((e, i) => ({ e, i, k: envKey(e) })).sort((a, b) => cmpKey(a.k, b.k) || a.i - b.i).map((x) => x.e);
}

/** `major/medium`, or "" for an item with no severity (a pre-scale file shows no badge). */
const badge = (item) => (item.severity === undefined ? "" : `${item.severity}/${item.certainty}`);

// ---- thresholds ---------------------------------------------------------------------------------------

/** Validates one threshold value; throws UsageError invalid-threshold with the swap hint (D17). */
function parseLevel(flag, value, UsageError) {
  const own = flag === "--min-severity" ? SEVERITIES : CERTAINTIES;
  if (own.includes(value)) return value;
  const what = flag === "--min-severity" ? "severity" : "certainty";
  const other = flag === "--min-severity" ? "--min-certainty" : "--min-severity";
  const otherLevels = flag === "--min-severity" ? CERTAINTIES : SEVERITIES;
  const hint = otherLevels.includes(value) ? `${other} ${value}` : `${flag} ${own[1]}`;
  throw new UsageError("invalid-threshold", `${flag} ${JSON.stringify(value)} is not a ${what} (${own.join(", ")})`, hint);
}

/** True when the thresholds gate everything (the defaults). */
const isDefault = (th) => th.min_severity === DEFAULTS.min_severity && th.min_certainty === DEFAULTS.min_certainty;

/** The docs/cli.md band table, one row per key (the registry test checks the doc against it). */
function bandTable() {
  const fmt = (row) => {
    const c = certaintyOf(row);
    return c.precision === null ? c.certainty : `${c.certainty} (${(Math.round(c.precision * 1000) / 1000).toFixed(3)})`;
  };
  const out = ["| Kind | Rule | Severity | Vision certainty (precision) | Tesseract certainty |", "| --- | --- | --- | --- | --- |"];
  for (const [kind, rule] of registry.keys) {
    const v = lookup(kind, rule, "vision"), t = lookup(kind, rule, "tesseract");
    const why = v.experimental ? "low (experimental)" : v.deterministic ? "high (deterministic)" : fmt(v);
    out.push(`| \`${kind}\` | ${rule === "-" ? "-" : `\`${rule}\``} | ${v.severity} | ${why} | ${fmt(t)} |`);
  }
  return out;
}

/** Test hook: swap the registry (and drop the index). */
function _setRegistry(r) { registry = r; index = null; id = null; }

module.exports = {
  SEVERITIES, CERTAINTIES, DEFAULTS, KEPT, ruleOf, readerOf, certaintyOf, lookup, registryId, gates, verdictOf, annotate, markKnown, regate,
  itemKey, sortItems, envKey, sortEnvelopes, badge, parseLevel, isDefault, bandTable, _setRegistry,
  get registry() { return registry; },
};
