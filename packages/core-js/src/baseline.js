// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Changed-only review (TODO-038 T2): compares the text record of each locale x screen cell with an approved
// baseline results file, `results baseline` (approval), and the consistency rules `results validate` adds.
// One canonical `baseline.cells[]` drives every other field (D7).
const crypto = require("crypto");
const fs = require("fs");
const { UsageError } = require("./args");
// Lazy, as fillLayout below: results.js requires this module. TODO-076 D6: a missing text size is `default`.
const sizeOf = (t) => t ?? "default";
const byTextSize = (a, b) => require("./results").byTextSize(a, b);

const ALGO = 1;
// Engines whose gate passed (D4): only their cells may be skippable. Tesseract is not measured yet.
const GATED_ENGINES = new Set(["vision-accurate-rev3"]);
const EMPTY_DIGEST = `sha256:${crypto.createHash("sha256").update("").digest("hex")}`;
const DIFF_CAP = 50;
const STATES = ["changed", "unchanged", "new", "gone", "ambiguous"];
// Why a cell needs review, most specific first; `reason` is the first that applies (D4).
const REASONS = ["changed", "new", "ambiguous", "failing", "baseline-incomplete", "no-text", "engine-unmeasured", "reader-changed", "baseline-ignore-changed", "baseline-unapproved"];
const NO_TEXT_VERSION = "0.24.0"; // the first catscan that writes text records

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isMissing = (e) => e.path === null && Array.isArray(e.findings) && e.findings.some((f) => f && f.kind === "missing");
const hasText = (e) => e.text !== null && typeof e.text === "object";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function canonicalJSON(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort(byCodePoint).map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** The digest `approved.from` and `baseline.digest` name: the file without its `approved` field. */
function fileDigest(obj) {
  const { approved, ...rest } = obj; // eslint-disable-line no-unused-vars
  return `sha256:${sha(canonicalJSON(rest))}`;
}

/** Digest of a token list as the core builds it (TODO-038 T1). */
const tokensDigest = (tokens) => `sha256:${sha(tokens.join("\n"))}`;

/**
 * A locale -> canonical key function from the `languages --json` object: aliases map to their table locale,
 * case is folded (D8). Without the table, case only.
 */
function canonFrom(info) {
  const m = new Map();
  for (const l of (info && info.languages) || []) for (const c of [l.locale, ...(l.aliases || [])]) m.set(c.toLowerCase(), l.locale.toLowerCase());
  return (loc) => m.get(String(loc).toLowerCase()) ?? String(loc).toLowerCase();
}

// Number of path segments the layout gives a cell, so input identity is the layout-relative path (D7), never
// the `abs:` rewrite or the folder the run was started from.
function relPath(e, layout) {
  const p = String(e.path ?? "").replace(/^abs:/, "");
  if (typeof e.screen !== "string") return p;
  // TODO-075 D10: the layout module fills the pattern; a device from --device (or a size from --text-size) is not a path segment.
  const { fillLayout, parseLayout } = require("./results");
  const lay = parseLayout(layout);
  const filled = fillLayout(layout, { device: lay.device ? e.device ?? null : null, text_size: lay.textSize ? e.text_size ?? null : null, locale: e.locale, screen: e.screen });
  const n = filled.split("/").length;
  return p.split("/").slice(-n).join("/");
}

/**
 * Cells of one file: key -> { device, text_size, locale, screen, mapped, inputs: [{ env, id }] }; the key leads with the
 * device (TODO-075), then the text size, where null is `default` so a baseline from before the axis matches (TODO-076 D6).
 */
function cellsOf(file, canon) {
  const layout = (file.coverage && file.coverage.layout) || "{locale}/{screen}";
  const cells = new Map();
  for (const e of file.results) {
    if (isMissing(e)) continue;
    const mapped = typeof e.screen === "string";
    const rel = relPath(e, layout);
    const dev = e.device ?? null;
    const head = `${dev ?? ""}\0${sizeOf(e.text_size)}\0${canon(e.locale)}`;
    const key = mapped ? `${head}\0${e.screen}` : `${head}\0\0${rel}`;
    if (!cells.has(key)) cells.set(key, { key, device: dev, text_size: e.text_size ?? null, locale: e.locale, screen: mapped ? e.screen : null, mapped, inputs: [], spellings: new Set() });
    const c = cells.get(key);
    c.inputs.push({ env: e, id: `${rel}\0${e.command}` });
    c.spellings.add(e.locale.toLowerCase());
  }
  return cells;
}

/** Pairs a cell's inputs (D7): one on each side compare; else by identity, and any doubt is null (ambiguous). */
function pairInputs(cur, base) {
  if (cur.length === 1 && base.length === 1) return [[cur[0], base[0]]];
  const count = (xs) => xs.reduce((m, x) => m.set(x.id, (m.get(x.id) || 0) + 1), new Map());
  const a = count(cur), b = count(base);
  if ([...a.values(), ...b.values()].some((n) => n > 1) || a.size !== b.size || [...a.keys()].some((k) => !b.has(k))) return null;
  const byId = new Map(base.map((x) => [x.id, x]));
  return cur.map((x) => [x, byId.get(x.id)]);
}

/** Added and removed lines (multisets), capped (Interface `diff`); null without lines (`digest` mode). */
function lineDiff(cur, base) {
  if (!cur.every((t) => Array.isArray(t.lines)) || !base.every((t) => Array.isArray(t.lines))) return null;
  const left = new Map();
  for (const t of base) for (const l of t.lines) left.set(l, (left.get(l) || 0) + 1);
  const added = [];
  for (const t of cur) for (const l of t.lines) { if (left.get(l)) left.set(l, left.get(l) - 1); else added.push(l); }
  const removed = [...left].flatMap(([l, n]) => Array(n).fill(l));
  if (!added.length && !removed.length) return null;
  return { added: added.slice(0, DIFF_CAP), removed: removed.slice(0, DIFF_CAP), added_count: added.length, removed_count: removed.length };
}

const macMajor = (h) => (h && typeof h.macos === "string" ? h.macos.split(/[ .]/)[0] : null);
const readerOf = (e) => `${e.engine}, Vision revision ${e.host ? e.host.vision_revision : "?"}, macOS ${macMajor(e.host) ?? "?"}`;

/**
 * Checks a parsed, schema-valid baseline before any comparison. Throws UsageError for exit 2
 * (`baseline-no-text`, `baseline-incompatible`, `baseline-locale-collision`).
 */
function checkBaseline(base, canon, file) {
  const envs = base.results.filter((e) => !isMissing(e));
  if (envs.some((e) => e.text === undefined)) {
    throw new UsageError("baseline-no-text", `${file} was written without text records`, `the baseline was written without text (catscan < ${NO_TEXT_VERSION} or --text-record none); approve a run from this catscan as the new baseline`);
  }
  const algo = envs.map((e) => e.text && e.text.algo).find((a) => a !== null && a !== undefined && a !== ALGO);
  if (algo !== undefined) throw new UsageError("baseline-incompatible", `${file} has text records of algo ${algo}; this catscan compares algo ${ALGO}`, `text.algo ${algo} != ${ALGO}; approve a run from this catscan as the new baseline`);
  for (const c of cellsOf(base, canon).values()) {
    if (c.spellings.size > 1) {
      const [x, y] = [...c.spellings].sort(byCodePoint);
      throw new UsageError("baseline-locale-collision", `${file}: the locales ${x} and ${y} both become ${canon(x)}${c.screen !== null ? ` for screen ${c.screen}` : ""}`, `keep one of ${x} and ${y} in the baseline run, then approve it again`);
    }
  }
}

/**
 * Compares a results file with a baseline (TODO-038 T2). `base` null: the baseline file does not exist (D15).
 * Sets `cur.baseline` and `change` on every envelope of `cur`; returns { block, warnings }. Throws UsageError (exit 2) for
 * `baseline-no-overlap` and the `checkBaseline` cases.
 */
function compare(cur, base, { file, canon = canonFrom(null), ignoreDigest = null } = {}) {
  const warnings = [];
  if (base) checkBaseline(base, canon, file);
  else warnings.push({ code: "baseline-missing", message: `the baseline ${file} does not exist, so every cell is new and needs review`, hint: "approve a reviewed run: catscan results baseline <results.json> --out <file>" });
  const now = cellsOf(cur, canon);
  const then = base ? cellsOf(base, canon) : new Map();
  const mappedNow = [...now.values()].filter((c) => c.mapped), mappedThen = [...then.values()].filter((c) => c.mapped);
  // TODO-076 "Baseline": a run at text sizes the baseline never had (a --text-size large job against a baseline from
  // before the axis) has no overlap by design; its cells are new, not a wrong --layout. Its (device, locale, screen)
  // must still be in the baseline at some size, or the layout or the file is wrong after all.
  const sizesThen = new Set(mappedThen.map((c) => sizeOf(c.text_size)));
  const newSizesOnly = mappedNow.every((c) => !sizesThen.has(sizeOf(c.text_size)));
  const sizeless = (k) => k.split("\0").filter((_, i) => i !== 1).join("\0");
  const thenSizeless = newSizesOnly ? new Set(mappedThen.map((c) => sizeless(c.key))) : null;
  const overlaps = (c) => (newSizesOnly ? thenSizeless.has(sizeless(c.key)) : then.has(c.key));
  if (base && mappedNow.length && mappedThen.length && !mappedNow.some(overlaps)) {
    // TODO-075 D5: a baseline from before the device axis never matches a run with one; say so instead of guessing.
    const noAxis = mappedThen.every((c) => c.device === null) && mappedNow.some((c) => c.device !== null);
    throw new UsageError("baseline-no-overlap", `no ${noAxis ? "device x " : ""}locale x screen cell of this run is in the baseline ${file}`,
      noAxis ? "the baseline has no device axis; approve a baseline from a run with --device or a {device} layout" : "no cell matches; check --layout and that --baseline is this project's file");
  }
  // D23: approval binds the content a human reviewed; an edited or pasted-in `approved` does not count.
  const edited = base && base.approved && base.approved.from !== fileDigest(base);
  const unapproved = base && (!base.approved || edited);
  if (unapproved) warnings.push({ code: "baseline-unapproved", message: edited ? `the baseline ${file} changed after it was approved, so every cell needs review` : `the baseline ${file} was never approved, so every cell needs review`, hint: `approve it first: catscan results baseline ${file} --out ${file}` });
  const missingKeys = new Set(cur.results.filter(isMissing).map((e) => `${e.device ?? ""}\0${sizeOf(e.text_size)}\0${canon(e.locale)}\0${e.screen}`));
  let readerChanged = null, ignoreChanged = false;
  const cells = [];
  const stateOf = new Map(); // envelope -> state
  for (const c of [...now.values()].sort((a, b) => byCodePoint(a.device ?? "", b.device ?? "") || byTextSize(sizeOf(a.text_size), sizeOf(b.text_size)) || byCodePoint(a.locale, b.locale) || byCodePoint(a.screen ?? "", b.screen ?? "") || byCodePoint(a.key, b.key))) {
    const b = then.get(c.key);
    const reasons = new Set();
    let state, inputs, diff = null, minor = null;
    if (!b) {
      state = "new";
      inputs = c.inputs.map((x) => ({ path: x.env.path, baseline_path: null, command: x.env.command }));
    } else {
      const pairs = pairInputs(c.inputs, b.inputs);
      if (!pairs) {
        state = "ambiguous";
        reasons.add("ambiguous");
        inputs = [...c.inputs.map((x) => ({ path: x.env.path, baseline_path: null, command: x.env.command })),
          ...b.inputs.map((x) => ({ path: null, baseline_path: x.env.path, command: x.env.command }))];
      } else {
        inputs = pairs.map(([x, y]) => ({ path: x.env.path, baseline_path: y.env.path, command: x.env.command }));
        const texts = pairs.filter(([x, y]) => hasText(x.env) && hasText(y.env));
        if (texts.length < pairs.length) {
          state = "ambiguous"; // nothing to compare on one side: an empty or failed read is never skippable
          reasons.add("no-text");
        } else {
          const differ = texts.filter(([x, y]) => x.env.text.digest !== y.env.text.digest);
          state = differ.length ? "changed" : "unchanged";
          const d = lineDiff((differ.length ? differ : texts).map(([x]) => x.env.text), (differ.length ? differ : texts).map(([, y]) => y.env.text));
          if (differ.length) diff = d; else minor = d;
          if (texts.some(([x, y]) => x.env.text.digest === EMPTY_DIGEST || y.env.text.digest === EMPTY_DIGEST)) reasons.add("no-text");
        }
        for (const [x, y] of pairs) {
          const e = x.env, f = y.env;
          // An unknown host (a hand-edited file) is a doubt, never a match (D11).
          if (e.engine !== f.engine || !e.host || !f.host || e.host.vision_revision !== f.host.vision_revision || macMajor(e.host) !== macMajor(f.host)) {
            reasons.add("reader-changed");
            readerChanged ||= { from: readerOf(f), to: readerOf(e) };
          }
          if (!GATED_ENGINES.has(e.engine) || !GATED_ENGINES.has(f.engine)) reasons.add("engine-unmeasured");
          if (hasText(e) && hasText(f) && (e.text.ignore ?? null) !== (f.text.ignore ?? null)) { reasons.add("baseline-ignore-changed"); ignoreChanged = true; }
        }
      }
    }
    if (state === "new" || state === "changed") reasons.add(state);
    if (c.inputs.some((x) => x.env.verdict !== "pass")) reasons.add("failing");
    // D4, D6: a duplicate on either side is never skippable, even when its inputs pair by identity; a baseline input
    // approved incomplete (error, needs-reader, unsupported: such a check still has a text record) stays non-skippable.
    const dup = (x) => (x.env.warnings || []).some((w) => w && w.code === "duplicate-cell");
    if (c.inputs.some(dup) || (b && b.inputs.some(dup))) reasons.add("ambiguous");
    if (b && b.inputs.some((x) => ["error", "needs-reader", "unsupported"].includes(x.env.verdict))) reasons.add("baseline-incomplete");
    if (c.inputs.some((x) => !hasText(x.env) || x.env.text.digest === EMPTY_DIGEST)) reasons.add("no-text");
    if (c.inputs.some((x) => !GATED_ENGINES.has(x.env.engine))) reasons.add("engine-unmeasured");
    if (unapproved) reasons.add("baseline-unapproved");
    const uniq = REASONS.filter((x) => reasons.has(x));
    cells.push({ device: c.device, text_size: c.text_size, locale: c.locale, screen: c.screen, state, review: uniq.length > 0, reason: uniq[0] ?? null, inputs, diff, minor_diff: minor, renamed_from: null, _c: c });
    for (const x of c.inputs) stateOf.set(x.env, state);
  }
  for (const b of [...then.values()].sort((x, y) => byCodePoint(x.device ?? "", y.device ?? "") || byTextSize(sizeOf(x.text_size), sizeOf(y.text_size)) || byCodePoint(x.locale, y.locale) || byCodePoint(x.screen ?? "", y.screen ?? ""))) {
    if (now.has(b.key) || (b.mapped && missingKeys.has(b.key))) continue;
    cells.push({ device: b.device, text_size: b.text_size, locale: b.locale, screen: b.screen, state: "gone", review: false, reason: null, inputs: b.inputs.map((x) => ({ path: null, baseline_path: x.env.path, command: x.env.command })), diff: null, minor_diff: null, renamed_from: null, _c: b });
  }
  // Rename hints (D9): a new and a gone cell of one device, text size and locale with one equal, non-empty digest, unique on both sides.
  const digestOf = (c) => (c._c.inputs.length === 1 && hasText(c._c.inputs[0].env) && c._c.inputs[0].env.text.digest !== EMPTY_DIGEST ? c._c.inputs[0].env.text.digest : null);
  const groups = new Map();
  for (const c of cells) {
    if ((c.state !== "new" && c.state !== "gone") || !c._c.mapped || !base) continue;
    const d = digestOf(c);
    if (!d) continue;
    const k = `${c.device ?? ""}\0${sizeOf(c.text_size)}\0${canon(c.locale)}\0${d}`;
    if (!groups.has(k)) groups.set(k, { new: [], gone: [] });
    groups.get(k)[c.state].push(c);
  }
  for (const g of groups.values()) if (g.new.length === 1 && g.gone.length === 1) g.new[0].renamed_from = g.gone[0].screen;
  for (const c of cells) delete c._c;
  for (const e of cur.results) e.change = hasText(e) && stateOf.has(e) ? stateOf.get(e) : null;
  if (readerChanged) warnings.push({ code: "reader-changed", message: `the baseline was read by ${readerChanged.from}, this run by ${readerChanged.to}, so those cells need review`, hint: "approve a run on this reader as the new baseline" });
  if (ignoreChanged) warnings.push({ code: "baseline-ignore-changed", message: "this run used a different --baseline-ignore file than the baseline, so those cells need review", hint: "pass the baseline's ignore file, or approve a run with the new one" });
  const ignore = ignoreDigest ?? cur.results.find(hasText)?.text.ignore ?? null;
  cur.baseline = {
      file,
      digest: base ? fileDigest(base) : null,
      approved: base && base.approved ? base.approved.at : null,
      build: base && base.run.build ? base.run.build.id : null,
      started_at: base ? base.run.started_at : null,
      catscan: base ? base.run.catscan : null,
      ignore_digest: ignore,
      cells,
      counts: countsOf(cells),
      review: reviewOf(cells, cur),
  };
  return { block: cur.baseline, warnings };
}

function countsOf(cells) {
  const n = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const c of cells) n[c.state]++;
  return n;
}

/** The skip share (D10): distinct mapped received cells; missing and unmapped are excluded and published. */
function reviewOf(cells, file) {
  const live = cells.filter((c) => c.state !== "gone" && c.screen !== null);
  const review = live.filter((c) => c.review).length;
  return {
    cells: review, skip: live.length - review, denominator: live.length,
    excluded: { missing: file.results.filter(isMissing).length, unmapped: file.results.filter((e) => !isMissing(e) && typeof e.screen !== "string").length },
  };
}

/** The text summary line (Interface), printed before the totals line. */
function summaryLine(block) {
  const r = block.review, c = block.counts;
  const name = block.build ?? block.file;
  const pct = r.denominator ? Math.floor((100 * r.skip) / r.denominator) : 0;
  const live = block.cells.filter((x) => x.state !== "gone" && x.screen !== null && x.review);
  const changed = live.filter((x) => x.state === "changed").length, fresh = live.filter((x) => x.state === "new").length;
  const amb = live.filter((x) => x.reason === "ambiguous").length;
  const unread = live.filter((x) => x.reason === "failing" || x.reason === "no-text").length;
  const other = r.cells - changed - fresh - amb - unread;
  const parts = [`${changed} changed`, `${fresh} new`, ...(amb ? [`${amb} ambiguous`] : []), `${unread} failing or unread`, ...(other ? [`${other} on a changed reader or baseline`] : [])];
  return `baseline ${name}: ${r.skip} of ${r.denominator} cells text unchanged and passing (${pct}%), ${r.cells} to review (${parts.join(", ")}); ${c.gone} gone`;
}

/** Why an envelope cannot be part of an approved baseline (D6), or null. */
function incompleteReason(e) {
  if (isMissing(e)) return "missing: no screenshot";
  if (["error", "needs-reader", "unsupported"].includes(e.verdict)) return `${e.verdict}${e.error ? ` (${e.error.code})` : ""}`;
  if (e.change === "ambiguous" || (e.warnings || []).some((w) => w && w.code === "duplicate-cell")) return "ambiguous: several inputs map to this cell";
  if (typeof e.screen === "string" && !hasText(e)) return "no text record";
  return null;
}

/**
 * `results baseline` (D5, D6): the approved file, or { refusals } when incomplete cells block it.
 * Throws UsageError baseline-no-text when the file has no text records at all.
 */
function approve(obj, { allowIncomplete = false, file, now = new Date() } = {}) {
  if (obj.results.filter((e) => !isMissing(e)).some((e) => e.text === undefined)) {
    throw new UsageError("baseline-no-text", `${file} was written without text records, so it cannot be a baseline`, `the baseline was written without text (catscan < ${NO_TEXT_VERSION} or --text-record none); approve a run from this catscan as the new baseline`);
  }
  const refusals = [];
  for (const e of obj.results) {
    const why = incompleteReason(e);
    if (why) refusals.push({ code: "baseline-incomplete", message: `${e.locale}/${e.screen ?? "-"}${e.path ? ` (${e.path})` : ""}: ${why}`, hint: "review and fix them, or --allow-incomplete" });
  }
  if (refusals.length && !allowIncomplete) return { refusals };
  return { file: { ...obj, approved: { at: now.toISOString().replace(/\.\d{3}Z$/, "Z"), from: fileDigest(obj) } }, refusals };
}

/** Consistency errors of the TODO-038 fields for `results validate` ([{ pointer, message }]). */
function checkFile(obj) {
  const errors = [];
  if (obj.approved && obj.approved.from !== fileDigest(obj)) errors.push({ pointer: "/approved/from", message: "is not the digest of this file: it changed after approval" });
  obj.results.forEach((e, i) => {
    if (hasText(e) && Array.isArray(e.text.tokens) && tokensDigest(e.text.tokens) !== e.text.digest) errors.push({ pointer: `/results/${i}/text/digest`, message: "is not the sha256 of text.tokens" });
  });
  const b = obj.baseline;
  if (b === null || b === undefined) {
    obj.results.forEach((e, i) => { if (e.change !== null && e.change !== undefined) errors.push({ pointer: `/results/${i}/change`, message: "is set, but the file has no baseline block" }); });
    return errors;
  }
  const n = countsOf(b.cells);
  for (const s of STATES) if (n[s] !== b.counts[s]) errors.push({ pointer: `/baseline/counts/${s}`, message: `is ${b.counts[s]}, but cells[] has ${n[s]}` });
  const r = reviewOf(b.cells, obj);
  for (const k of ["cells", "skip", "denominator"]) if (r[k] !== b.review[k]) errors.push({ pointer: `/baseline/review/${k}`, message: `is ${b.review[k]}, but cells[] gives ${r[k]}` });
  for (const k of ["missing", "unmapped"]) if (r.excluded[k] !== b.review.excluded[k]) errors.push({ pointer: `/baseline/review/excluded/${k}`, message: `is ${b.review.excluded[k]}, but results[] has ${r.excluded[k]}` });
  b.cells.forEach((c, i) => {
    if (c.review !== (c.reason !== null)) errors.push({ pointer: `/baseline/cells/${i}`, message: "review and reason disagree" });
    else if (!c.review && c.state !== "unchanged" && c.state !== "gone") errors.push({ pointer: `/baseline/cells/${i}`, message: `is ${c.state} but skippable` });
  });
  // A skippable cell's inputs must be passing, read and gated (D4), whatever the block says. Inputs are keyed by the
  // cell's device and text size too: one-job-per-device (or per-size) shards share relative paths (TODO-075, review fix).
  const key = (c, p, command) => `${c.device ?? ""}\0${sizeOf(c.text_size)}\0${p}\0${command}`;
  const env = new Map(obj.results.filter((e) => e.path).map((e) => [key(e, e.path, e.command), e]));
  b.cells.forEach((c, i) => {
    if (c.state === "gone") return;
    const lost = c.inputs.find((x) => x.path !== null && !env.has(key(c, x.path, x.command)));
    if (lost) errors.push({ pointer: `/baseline/cells/${i}/device`, message: `is ${c.device ?? null}${c.text_size != null ? ` at text size ${c.text_size}` : ""}, but results[] holds no input ${lost.path} (${lost.command}) on that device` });
  });
  b.cells.forEach((c, i) => {
    if (c.review || c.state === "gone") return;
    for (const x of c.inputs) {
      const e = x.path !== null ? env.get(key(c, x.path, x.command)) : null;
      if (!e || e.verdict !== "pass" || !hasText(e) || e.text.digest === EMPTY_DIGEST || !GATED_ENGINES.has(e.engine)) {
        errors.push({ pointer: `/baseline/cells/${i}`, message: "is skippable, but an input is not a passing, read, gated result" });
        break;
      }
    }
  });
  const state = new Map();
  for (const c of b.cells) for (const x of c.inputs) if (x.path !== null) state.set(key(c, x.path, x.command), c.state);
  obj.results.forEach((e, i) => {
    const k = key(e, e.path, e.command);
    const want = hasText(e) && state.has(k) ? state.get(k) : null;
    if ((e.change ?? null) !== want) errors.push({ pointer: `/results/${i}/change`, message: `is ${e.change ?? null}, but baseline.cells[] gives ${want}` });
  });
  return errors;
}

/** `--baseline-ignore <file>`: the patterns and the file's digest. Throws UsageError for exit 2. */
function readIgnore(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    throw new UsageError("baseline-ignore-unreadable", `cannot read --baseline-ignore ${file}: ${e.code || e.message}`, "pass a text file with one regular expression per line");
  }
  const patterns = [];
  for (const line of buf.toString("utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    try { new RegExp(line, "u"); } catch (e) {
      throw new UsageError("baseline-ignore-invalid", `--baseline-ignore ${file}: ${line} is not a valid regular expression: ${e.message}`, "escape the pattern, for example id [0-9a-f]+");
    }
    patterns.push(line);
  }
  return { patterns, digest: `sha256:${sha(buf)}` };
}

module.exports = { ALGO, GATED_ENGINES, compare, approve, checkFile, checkBaseline, canonFrom, summaryLine, readIgnore, fileDigest, tokensDigest, EMPTY_DIGEST, NO_TEXT_VERSION };
