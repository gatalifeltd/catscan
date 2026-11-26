// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Exit code and the text renderer (spec 00, "Exit codes" and "Output streams").

const scale = require("./scale");

const EXIT = { pass: 0, fail: 1, usage: 2, unsupported: 3, "needs-reader": 3, error: 4, internal: 5 };

/** An envelope that failed for catscan's own reasons, not the input's: exit 5 (TODO-003 D9). Shared by every serve consumer. */
function isInternal(env) {
  return env.error?.code === "vision-languages-failed";
}

/**
 * Precedence 5, 4, 3, 1, 0 over the final per-input verdicts.
 * `skipped`: --fail-on-skip saw a skipped check, which ranks as a failure (TODO-007 D2).
 */
function exitCode(verdicts, { internal = false, skipped = false } = {}) {
  if (internal) return EXIT.internal;
  if (verdicts.includes("error")) return EXIT.error;
  // TODO-065 D1: a locale catscan reads with a reader that is not installed shares exit 3 with a true unsupported.
  if (verdicts.includes("unsupported") || verdicts.includes("needs-reader")) return EXIT.unsupported;
  if (verdicts.includes("fail") || skipped) return EXIT.fail;
  return EXIT.pass;
}

function count(verdicts) {
  const c = { pass: 0, fail: 0, "needs-reader": 0, unsupported: 0, error: 0 };
  for (const v of verdicts) c[v] = (c[v] || 0) + 1;
  return c;
}

/** The active threshold flags, `--min-certainty high`, or "" at the defaults (TODO-077 D18). */
function thresholdFlags(th) {
  if (!th) return "";
  const out = [];
  if (th.min_severity !== scale.DEFAULTS.min_severity) out.push(`--min-severity ${th.min_severity}`);
  if (th.min_certainty !== scale.DEFAULTS.min_certainty) out.push(`--min-certainty ${th.min_certainty}`);
  return out.join(" ");
}

/**
 * `12 images: 10 pass, 1 fail, 1 error (0.8 s)`; video runs count videos (spec 07 D24). `below`: findings under the
 * thresholds, named with the flags that hid them, so a run that passes by filtering says so (TODO-077 D18).
 */
function totalsLine(verdicts, seconds, noun = "image", { below = 0, thresholds = null, known = null } = {}) {
  const c = count(verdicts);
  const parts = [`${c.pass} pass`];
  for (const k of ["fail", "needs-reader", "unsupported", "error"]) if (c[k]) parts.push(`${c[k]} ${k}`);
  if (below) parts.push(`${below} below threshold (${thresholdFlags(thresholds)})`);
  // TODO-055: the known block's counts, so a green run with legacy findings does not read as clean.
  if (known) parts.push(`${known.counts.known} known, ${known.counts.new} new, ${known.counts.gone} approved no longer found (${known.file})`);
  const n = verdicts.length;
  return `${n} ${noun}${n === 1 ? "" : "s"}: ${parts.join(", ")} (${seconds.toFixed(1)} s)`;
}

/** The per-verdict counts printed on stderr, so an exit 3 or 4 does not hide failures. */
function countsLine(verdicts) {
  const c = count(verdicts);
  return `catscan: counts: ${c.pass} pass, ${c.fail} fail, ${c["needs-reader"]} needs-reader, ${c.unsupported} unsupported, ${c.error} error`;
}

/** `catscan: <code>: <message> - try: <hint>` */
function diagnosticLine(d) {
  return `catscan: ${d.code}: ${d.message}${d.hint ? ` - try: ${d.hint}` : ""}`;
}

const q = (s) => JSON.stringify(s);

const sec = (t) => `${t} s`;

function checkDetail(c, env) {
  // A catalog check names its key, the string searched for and its file (spec 02 D20).
  let head = c.key !== undefined ? `  ${c.kind} @${c.key} ${q(c.text)}${c.catalog ? ` (${c.catalog})` : ""}` : `  ${c.kind} ${q(c.text)}`;
  if (c.range !== undefined) head += ` [${c.range}]`;
  if (c.verdict === "skipped") return `${head}: skipped (${c.reason})`;
  if (c.verdict === "unsupported") return `${head}: unsupported`;
  if (c.verdict === "needs-reader") return `${head}: needs a reader (${env.error?.hint || "catscan doctor"})`;
  if (env.command === "video") {
    // spec 07 D11
    if (c.kind === "present") {
      if (c.verdict === "pass") return `${head}: seen ${sec(c.first_seen)}-${sec(c.last_seen)} in ${q(c.line)}`;
      const n = `${env.frames} frame${env.frames === 1 ? "" : "s"}`;
      return c.closest
        ? `${head}: not found on ${n}; closest ${q(c.closest.line)} (distance ${c.closest.distance}) at ${sec(c.closest.t)}`
        : `${head}: not found on ${n}; no text recognized`;
    }
    if (c.verdict === "pass") return `${head}: not shown`;
    const span = c.first_seen === c.last_seen ? sec(c.first_seen) : `${sec(c.first_seen)}-${sec(c.last_seen)}`;
    return `${head}: shown ${span} in ${q(c.line)} at [${c.box.join(", ")}]`;
  }
  if (c.kind === "present") {
    if (c.verdict === "pass") return `${head}: found in ${q(c.line)}`;
    return c.closest
      ? `${head}: not found; closest ${q(c.closest.line)} (distance ${c.closest.distance}) at [${c.closest.box.join(", ")}]`
      : `${head}: not found; no text recognized`;
  }
  if (c.verdict === "pass") return `${head}: not shown`;
  return `${head}: shown in ${q(c.line)} at [${c.box.join(", ")}]`;
}

/** One line per spec 17 finding (D24). */
function findingDetail(f) {
  const at = f.box ? ` at [${f.box.join(", ")}]` : "";
  if (f.kind === "untranslated") {
    const exp = f.expected === null ? "no string" : q(f.expected);
    return `  untranslated @${f.key} ${q(f.base)} (${f.catalog ? `${f.catalog}: ` : ""}${exp}) in ${q(f.line)}${at}`;
  }
  if (f.kind === "uncatalogued") { // TODO-036 T4: what it knows is that no catalog string matches (D10)
    const n = f.nearest ? `; nearest @${f.nearest.key} ${q(f.nearest.text)}, distance ${f.nearest.distance}` : "";
    return `  uncatalogued ${q(f.line)}${at} (no catalog string${f.language ? `; ${f.language}` : ""}${n})`;
  }
  if (f.kind === "wrong-language") { // TODO-036 T2
    if (f.evidence === "catalog") {
      const exp = f.expected === null ? "no string" : q(f.expected);
      return `  wrong-language ${f.language} @${f.key} (${f.catalog ? `${f.catalog}: ` : ""}${exp}; matched ${f.evidence_catalog}) in ${q(f.line)}${at}`;
    }
    return `  wrong-language ${f.language} (language ID ${f.confidence}; ${f.expected_language} expected) in ${q(f.line)}${at}`;
  }
  if (f.kind === "format") { // TODO-036 T3: the token and the locale's CLDR rendering of the value
    return `  format (${f.rule}) ${q(f.token)} in ${q(f.line)}${at}${f.expected !== null ? `, expected ${q(f.expected)}` : ""}`;
  }
  if (f.kind === "currency") { // D20
    const exp = f.expected_currency ? `, storefront ${f.expected_currency}` : `, ${f.currencies.join(" and ")} on one screen`;
    return `  currency (${f.rule}) ${q(f.token)} (${f.currencies.join(", ")}) in ${q(f.line)}${at}${exp}`;
  }
  if (f.kind === "price") { // D8: against the supplied price file, never "charged"
    const prod = f.product ? ` ${f.product}` : "";
    return `  price (${f.field})${prod} ${q(f.token)} in ${q(f.line)}${at}${f.expected !== null ? `, price file: ${q(f.expected)}` : ""}`;
  }
  if (f.kind === "truncated") {
    // spec 06 D34: the reason, the element id for a box finding, and the full string when known.
    const el = f.element ? ` in ${f.element.id ?? "element"} [${f.element.box.join(", ")}]` : "";
    // TODO-039 D14: what was lost and the base string the cut line belongs to.
    if (f.reason === "pseudo-cut") {
      return `  truncated (pseudo-cut, ${f.lost} lost${f.side === "start" ? ", at the start" : ""}) ${q(f.line)}${at} @${f.key} (${f.catalog ? `${f.catalog}: ` : ""}${q(f.expected)})`;
    }
    // TODO-036: overflow names how far past its element the line runs.
    if (f.reason === "overflow" && f.element) {
      return `  truncated (overflow) ${q(f.line)}${at} past ${f.element.id ?? "element"} [${f.element.box.join(", ")}] by ${f.overflow} line heights`;
    }
    return `  truncated (${f.reason}) ${q(f.line)}${at}${el}${f.expected !== null ? `, expected ${q(f.expected)}` : ""}`;
  }
  if (f.kind === "low-contrast" || f.kind === "busy-background") return require("./contrast").detail(f, at); // TODO-054
  if (f.kind === "fit" && (f.reason === "wrapped" || f.reason === "orphan")) {
    // TODO-074 "Rule": the rows joined by " / ", the element, and the evidence that the element meant one row.
    const el = ` in [${f.element?.id ?? "element"}]`;
    if (f.reason === "orphan") return `  fit (orphan) ${q(f.orphan)} ends [${f.element?.id ?? "element"}]${at} (row ${f.rows} of ${f.rows})`;
    const why = f.evidence === "base" ? `1 in the base locale (${f.base_path ?? "base"})${f.key ? ` @${f.key}` : ""}`
      : f.evidence === "declared" ? "max_lines 1" : "a one-line control";
    return `  fit (wrapped) ${q(f.line)}${el}${at}: ${f.rows} rows, ${why}`;
  }
  if (f.kind === "fit") {
    // TODO-073 "Output": what is hidden, under which zone of which profile; a textless control by id and share.
    const zone = f.reason === "home-indicator" ? "home indicator" : f.reason;
    if (f.line === null) return `  fit (${f.reason}) [${f.element?.id ?? "control"}] ${Math.round(f.covered * 100)}% under the ${zone} of ${f.profile}${at}`;
    return `  fit (${f.reason}) ${q(f.line)}${at}: ${q(f.hidden)} under the ${zone} of ${f.profile}`;
  }
  if (f.kind === "overlap" && f.signal === "stacked") {
    // TODO-067 D14: one read, no second line and no share; the production read when it kept the line; the fix last.
    // D31: dictionary evidence alone means Vision read the ink confidently, as words no dictionary of the run knows.
    const ev = f.stacked_evidence || [];
    const why = ev.some((e) => e.startsWith("correction")) ? "Vision reads it only without language correction" : "Vision reads it confidently as words no dictionary of the run language knows";
    const kept = f.corrected !== null && f.corrected !== undefined && f.corrected !== f.a.text ? `; read as ${q(f.corrected)} with correction` : "";
    return `  overlap (stacked) ${q(f.a.text)}${at}: text drawn over text; ${why}${kept}; if drawn on purpose, add the line to --allow`;
  }
  if (f.kind === "overlap") {
    // spec 12 D13: both texts and the share; TODO-046: a graphic element by its id in brackets.
    const side = (s) => (s.text === null ? `[${s.element?.id ?? "graphic"}]` : q(s.text));
    // TODO-072 D9: what a sheets finding means and the fix, worded for every surface (CLI --allow, matcher and MCP allow).
    if (f.signal === "sheets") return `  overlap (sheets) ${side(f.a)} / ${side(f.b)} (${Math.round(f.overlap * 100)}%)${at}: two sheets drawn over each other; if one is hidden on purpose, leave it out of the boxes or allow it by its id or text`;
    return `  overlap ${side(f.a)} / ${side(f.b)} (${Math.round(f.overlap * 100)}%)${at}`;
  }
  if (f.kind === "occluded") {
    // TODO-049 D16: what hides the label and how much of the label's box lies under it.
    return `  occluded ${q(f.a.text)} under [${f.b.element?.id ?? "panel"}] (${Math.round(f.overlap * 100)}% of its box under the panel)${at}`;
  }
  if (f.kind === "hardcoded") {
    return f.evidence === "base"
      ? `  hardcoded ${q(f.line)}${at} (equals @${f.key}${f.catalog ? ` in ${f.catalog}` : ""}; not from the pseudo catalog; look it up by key)`
      : `  hardcoded ${q(f.line)}${at} (in no catalog; not from the pseudo catalog)`;
  }
  if (f.kind === "pseudo-not-applied") {
    return `  pseudo-not-applied: ${Math.round(f.traits * 100)}% of ${f.lines} lines show pseudo text; this screen did not load the pseudo locale (launch the app in en-XA)`;
  }
  if (f.kind === "placeholder") return `  placeholder ${q(f.token)} in ${q(f.line)}${at}`;
  // TODO-031: the catalog key a misread line was matched to, when it differs from the line.
  if (f.kind === "raw-key" && (f.keys || (f.key && f.key !== f.line))) {
    return `  raw-key ${q(f.line)} (${(f.keys || [f.key]).map((k) => `@${k}`).join(", ")})${at}`;
  }
  return `  ${f.kind} ${q(f.line)}${at}`;
}

/** `major/medium  truncated (overflow) ...`: an item's detail line with its badge (TODO-077 "Outputs"). */
function badged(item, detail, note = false, knownFile = null) {
  const b = scale.badge(item);
  const body = detail.replace(/^ {2}/, "");
  // TODO-055: a known finding is labeled `known`; a new one says how often its key was found and approved.
  const label = note ? (item.known === true ? "known " : "note ") : "";
  const kc = item.known_counts;
  const tail = !kc ? "" : kc.approved ? ` (new: ${kc.found} found, ${kc.approved} approved in ${knownFile ?? "the known file"})` : ` (new, not in ${knownFile ?? "the known file"})`;
  return `  ${label}${b ? `${b}  ` : ""}${body}${tail}`;
}

/**
 * Human lines for one result on stdout. Failures get details; `read` lists the recognized lines. Findings are
 * sorted (TODO-077 D11); those under the thresholds follow as `note` lines, which --quiet hides.
 */
function renderText(env, { quiet = false, knownFile = null } = {}) {
  // An expected screenshot that never arrived (spec 27 D14).
  const missing = env.path === null && env.findings?.find((f) => f.kind === "missing");
  if (missing) return [`FAIL  missing: ${missing.expected_path}`];
  const label = env.verdict.toUpperCase();
  // An input Tesseract read says so on its own line (spec 03 D7); Vision lines are unchanged.
  const out = [`${label.padEnd(5)} ${env.path}${env.engine?.startsWith("tesseract-") ? ` (${env.engine})` : ""}`];
  if (env.command === "video" && env.verdict !== "error") out[0] += ` (${env.frames} frame${env.frames === 1 ? "" : "s"})`;
  if (env.error) out.push(`  ${env.error.code}: ${env.error.message}`);
  if (env.command === "read" && env.lines) {
    out[0] += ` (${env.lines.length} line${env.lines.length === 1 ? "" : "s"})`;
    for (const l of env.lines) out.push(`  ${l.text}`);
  } else {
    const findings = scale.sortItems(env.findings || []);
    if (env.verdict !== "pass") {
      for (const c of env.checks) if (c.verdict !== "pass") out.push(c.verdict === "fail" ? badged(c, checkDetail(c, env)) : checkDetail(c, env));
      for (const f of findings) if (f.gate !== false) out.push(badged(f, findingDetail(f), false, knownFile));
    }
    // Below-threshold notes, then known findings (TODO-055); --quiet hides both. sortItems already orders them so.
    if (!quiet) for (const f of findings) if (f.gate === false) out.push(badged(f, findingDetail(f), true, knownFile));
  }
  if (env.inventory) {
    const inv = env.inventory;
    const n = inv.found.length + inv.not_found.length + inv.skipped.length;
    out.push(`  inventory: ${inv.found.length} of ${n} keys found${inv.skipped.length ? `, ${inv.skipped.length} skipped` : ""}`);
    if (inv.found.length) out.push(`  found: ${inv.found.map((f) => f.key).join(", ")}`);
  }
  return out;
}

/** `catscan languages`: one row per language, then the per-OS table comparison (spec 04). */
function renderLanguages(info) {
  const head = ["Locale", "Vision", "Script", "Direction", "No spaces", "Supported", "Aliases"];
  const rows = info.languages.map((l) => [
    l.locale, l.vision, l.script, l.direction ?? "?", l.no_spaces === null ? "?" : l.no_spaces ? "yes" : "-",
    l.supported ? "yes" : "no", l.aliases.join(", ") || "-",
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ");
  const out = [fmt(head), ...rows.map(fmt)];
  const t = info.os_table;
  const n = info.languages.filter((l) => l.supported).length;
  const where = `${n} languages on macOS ${info.host.macos}, Vision revision ${info.host.vision_revision}`;
  if (!t.known) out.push(`${where}; catscan has no language table for macOS ${t.macos} yet.`);
  else if (t.matches) out.push(`${where}; matches the macOS ${t.macos} table.`);
  else out.push(`${where}; differs from the macOS ${t.macos} table: added ${t.added.join(", ") || "none"}, removed ${t.removed.join(", ") || "none"}.`);
  // TODO-037 D10: name the fallback locales; an older core without the field keeps the generic line.
  const fb = info.fallback_locales || [];
  out.push(fb.length
    ? `Read with Tesseract (install: brew install tesseract tesseract-lang; check: catscan doctor): ${fb.join(", ")}. Other locales are unsupported (exit 3).`
    : "Other locales are read with Tesseract when it is installed (catscan doctor), else unsupported (exit 3).");
  return out;
}

module.exports = { EXIT, exitCode, isInternal, totalsLine, thresholdFlags, countsLine, diagnosticLine, renderText, renderLanguages, count, checkDetail, findingDetail };
