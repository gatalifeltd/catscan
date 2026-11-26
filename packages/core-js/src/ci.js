// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// CI report formats (spec 15): GitHub workflow commands and job summary, JUnit XML, GitLab Code Quality JSON.
// Every function takes private envelopes (spec 27 D9 paths) in output order, `missing` entries last.
const crypto = require("crypto");
const path = require("path");
const render = require("./render");
const baselineLib = require("./baseline");
const scale = require("./scale");

const MISSING = (env) => (env.path === null ? env.findings?.find((f) => f.kind === "missing") : null);

/** The path every format names: the input's, or `expected_path` for a missing entry (spec 15). */
function pathOf(env) {
  const m = MISSING(env);
  return m ? m.expected_path : env.path;
}

/** `present "Weiter"`, `absent @cta.ok "Weiter"`, with ` [0-2.5]` for a video range. */
function checkName(c) {
  const head = c.key !== undefined ? `${c.kind} @${c.key} ${JSON.stringify(c.text)}` : `${c.kind} ${JSON.stringify(c.text)}`;
  return c.range !== undefined ? `${head} [${c.range}]` : head;
}

// TODO-065 T1: a needs-reader input carries its install command into JUnit, Code Quality and annotations.
const errorText = (env) => (env.error
  ? `${env.error.code}: ${env.error.message}${env.verdict === "needs-reader" && env.error.hint ? ` - try: ${env.error.hint}` : ""}`
  : `${env.verdict}: no engine reads ${env.locale ?? "this locale"}`);

/** An item's message with its `<severity>/<certainty>` prefix (TODO-077 "Outputs"); none for a pre-scale item. */
const badged = (item, message) => (scale.badge(item) ? `${scale.badge(item)}  ${message}` : message);

/**
 * The test cases of one envelope: { name, status: pass|fail|skipped|error, message, kind, ident, item, findings, notes }.
 * `check` and `video` get one per check; the finding commands, `read` and inputs without checks get one per input.
 * `message` lists the gating items in sort order (TODO-077 D11); `findings` keeps output order, for stable Code Quality
 * fingerprints; `notes` are the findings below the thresholds, which never fail a case.
 */
function cases(env) {
  const m = MISSING(env);
  if (m) return [{ name: `missing: ${m.expected_path}`, status: "fail", message: badged(m, `missing: ${m.expected_path} (an expected screenshot never arrived)`), kind: "missing", ident: m.expected_path, item: m, findings: [], notes: [] }];
  if (env.verdict === "error" || env.verdict === "unsupported" || env.verdict === "needs-reader") {
    return [{ name: env.command, status: "error", message: errorText(env), kind: env.verdict, ident: env.error?.code ?? env.verdict, findings: [], notes: [] }];
  }
  if (["check", "video"].includes(env.command) && env.checks?.length) {
    return env.checks.map((c) => ({
      name: checkName(c),
      status: c.verdict === "unsupported" || c.verdict === "needs-reader" ? "error" : c.verdict,
      message: c.verdict === "pass" ? "" : c.verdict === "fail" ? badged(c, render.checkDetail(c, env).trim()) : render.checkDetail(c, env).trim(),
      kind: c.kind, ident: c.text, item: c, findings: [], notes: [],
    }));
  }
  const line = (f) => badged(f, `${f.known === true ? "known " : ""}${render.findingDetail(f).trim()}`);
  const findings = (env.findings || []).map((f) => ({ kind: f.kind, ident: f.line ?? f.token ?? "", message: line(f), item: f }));
  const sorted = scale.sortItems(env.findings || []);
  const gating = sorted.filter((f) => f.gate !== false).map(line);
  const notes = sorted.filter((f) => f.gate === false).map(line);
  const fail = env.verdict === "fail";
  const message = !fail ? "" : gating.length ? gating.join("\n") : `${env.command}: fail`;
  return [{ name: env.command, status: fail ? "fail" : "pass", message, kind: env.command, ident: "", item: null, findings, notes }];
}

// ---- GitHub Actions ---------------------------------------------------------------------------------------

const ANNOTATIONS = 10;
const SUMMARY_BYTES = 900 * 1024;

/** Workflow-command message escaping, as GitHub documents it (D6). */
const escData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
/** Property escaping: also `:` and `,`, which end a property. */
const escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** One `::error` (or `::warning`) line. Every byte of untrusted text is inside an escaped property or message (D6). */
function workflowError({ file, title, message }, level = "error") {
  const props = [file !== undefined ? `file=${escProp(file)}` : null, `title=${escProp(title)}`].filter(Boolean).join(",");
  return `::${level} ${props}::${escData(message)}`;
}

/** The annotation of a non-passing envelope, or null for a pass. */
function annotation(env) {
  if (env.verdict === "pass") return null;
  const m = MISSING(env);
  const lines = cases(env).filter((c) => c.status !== "pass" && c.status !== "skipped").map((c) => c.message);
  const title = m ? "catscan: missing screenshot" : `catscan ${env.command}: ${env.verdict}`;
  return { file: pathOf(env) ?? "-", title, message: lines.join("\n") || `${env.command}: ${env.verdict}` };
}

/**
 * The stdout lines under `--format github`: at most 10 `::error` lines in rank order (TODO-077 D12: the slots go to the
 * inputs with the likeliest worst defects), then one line counting the rest. GitHub shows 10 error annotations per step and would drop an 11th error, so the count is a `::warning`,
 * which has its own allowance. `more` names where the rest is; `partial` says the run stopped early.
 */
function githubLines(envs, { more = "the job summary", partial = false } = {}) {
  const all = scale.sortEnvelopes(envs).map(annotation).filter(Boolean);
  const out = all.slice(0, ANNOTATIONS).map((a) => workflowError(a));
  if (all.length > ANNOTATIONS) {
    const n = all.length - ANNOTATIONS;
    out.push(workflowError({ title: "catscan: more failures", message: `${n} more failure${n === 1 ? "" : "s"} not annotated (GitHub shows ${ANNOTATIONS} per step); see ${more}` }, "warning"));
  }
  if (partial) out.push(workflowError({ title: "catscan: run incomplete", message: "the run ended before every input had a result; these annotations and the job summary are partial" }, "warning"));
  return out;
}

/**
 * Markdown-safe cell text for use inside <code> (spec 15 "Escaping"): `& < > | [ ] \`` and line breaks, plus
 * `* _ ~ : . @` so screen text renders neither emphasis nor an autolink (`https://`, `www.`, e-mail) (GFM parses Markdown inside <code>).
 */
function mdCell(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;")
    .replace(/\[/g, "&#91;").replace(/\]/g, "&#93;").replace(/`/g, "&#96;").replace(/\*/g, "&#42;").replace(/_/g, "&#95;")
    .replace(/~/g, "&#126;").replace(/:/g, "&#58;").replace(/\./g, "&#46;").replace(/@/g, "&#64;").replace(/\r?\n|\r/g, " ");
}
const code = (s) => `<code>${mdCell(s)}</code>`;

/**
 * The job summary in Markdown: the counts, then one row per non-passing envelope, cut at 900 KB (GitHub takes 1 MiB)
 * with a closing note. Screen text and paths are in <code> spans, escaped.
 */
function githubSummary(envs, { command, more = "the results file", limit = SUMMARY_BYTES, partial = false, baseline = null, known = null } = {}) {
  const c = render.count(envs.map((e) => e.verdict));
  // TODO-055 D23: the counts line says how many findings are known and new, so a green job does not read as clean.
  const kc = known ? `, ${known.counts.known} known, ${known.counts.new} new${known.counts.gone ? `, ${known.counts.gone} approved no longer found` : ""}` : "";
  const counts = `${c.pass} pass, ${c.fail} fail, ${c["needs-reader"]} needs-reader, ${c.unsupported} unsupported, ${c.error} error${kc}`;
  const head = [`## catscan ${command}`, "", ...(partial ? ["**The run ended before every input had a result: these counts are partial.**", ""] : []), counts, ""];
  // TODO-038 T3: the summary line goes under the counts; the cells to review follow the failure table (D7: read from
  // `baseline.cells[]`, never recomputed).
  if (baseline) head.push(mdCell(baselineLib.summaryLine(baseline)), "");
  const ranked = scale.sortEnvelopes(envs);
  const bad = ranked.map((e) => [e, annotation(e)]).filter(([, a]) => a);
  let text = head.join("\n") + "\n";
  // TODO-077: the input's worst gating item gives its severity and certainty; error inputs and pre-scale items show "-".
  const worst = (e) => scale.sortItems([...(e.checks || []).filter((c) => c.verdict === "fail"), ...(e.findings || [])].filter((x) => x.gate !== false))[0];
  const rows = bad.map(([e, a]) => {
    const w = worst(e);
    return `| ${MISSING(e) ? "MISSING" : e.verdict.toUpperCase()} | ${w?.severity ?? "-"} | ${w?.certainty ?? "-"} | ${code(a.file)} | ${a.message.split("\n").map(code).join("<br>")} |\n`;
  });
  const fail = capped(text, rows, "| Verdict | Severity | Certainty | Path | Details |\n| --- | --- | --- | --- | --- |\n", limit);
  text = fail.text;
  if (fail.shown < rows.length) {
    const n = rows.length - fail.shown;
    text += `\n${n} more failure${n === 1 ? "" : "s"} not shown (the job summary is cut at 900 KB); see ${more}.\n`;
  }
  // Below-threshold findings never fail the job; they are listed, collapsed, so nothing is silently hidden.
  const noted = ranked.map((e) => [e, cases(e).flatMap((c) => c.notes)]).filter(([, n]) => n.length);
  if (noted.length) {
    const total = noted.reduce((k, [, n]) => k + n.length, 0);
    const nrows = noted.map(([e, n]) => `| ${code(pathOf(e) ?? "-")} | ${n.map(code).join("<br>")} |\n`);
    const head2 = `\n<details><summary>${total} finding${total === 1 ? "" : "s"} below threshold${known ? " or known" : ""}</summary>\n\n| Path | Findings |\n| --- | --- |\n`;
    // Room is kept for the closing tag and the "not shown" line (review fix: never cut silently).
    const below = capped(text, nrows, head2, limit - 200);
    const cut = nrows.length - below.shown;
    if (below.shown) text = below.text + (cut ? `\n${cut} more input${cut === 1 ? "" : "s"} with findings below threshold not shown; see ${more}.\n` : "") + "\n</details>\n";
    else {
      const line = `\n${total} finding${total === 1 ? "" : "s"} below threshold not shown; see ${more}.\n`;
      if (Buffer.byteLength(text + line) <= limit) text += line;
    }
  }
  if (!baseline) return text;
  const review = baseline.cells.filter((x) => x.review);
  if (!review.length) return text;
  const rrows = review.map((x) => `| ${code(x.locale ?? "-")} | ${code(x.screen ?? "(unmapped)")} | ${x.state} | ${x.reason ?? ""} | ${diffCell(x.diff)} |\n`);
  const rev = capped(text, rrows, "\n### Cells to review\n\n| Locale | Screen | State | Why | Lines |\n| --- | --- | --- | --- | --- |\n", limit);
  text = rev.text;
  if (rev.shown < rrows.length) {
    const n = rrows.length - rev.shown;
    text += `\n${n} more cell${n === 1 ? "" : "s"} to review not shown (the job summary is cut at 900 KB); see ${more}.\n`;
  }
  return text;
}

/** Appends `header` and as many `rows` as fit in `limit` bytes; a table with no row that fits is left out. */
function capped(text, rows, header, limit) {
  if (!rows.length) return { text, shown: 0 };
  let out = text + header;
  let size = Buffer.byteLength(out);
  let shown = 0;
  for (const row of rows) {
    const n = Buffer.byteLength(row);
    if (size + n > limit) break;
    out += row;
    size += n;
    shown++;
  }
  return { text: shown ? out : text, shown };
}

const DIFF_LINES = 5;
/** The added and removed lines of a `changed` cell, at most 5 each with a count of the rest (empty in digest mode). */
function diffCell(d) {
  if (!d) return "";
  const side = (sign, lines, n) => [...lines.slice(0, DIFF_LINES).map((l) => code(`${sign} ${l}`)), ...(n > DIFF_LINES ? [`${n - DIFF_LINES} more`] : [])];
  return [...side("+", d.added, d.added_count), ...side("-", d.removed, d.removed_count)].join("<br>");
}

// ---- JUnit XML ----------------------------------------------------------------------------------------------

// XML 1.0 forbids most control characters even as references: they become U+FFFD.
const xmlText = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "�")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlAttr = (s) => xmlText(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#9;");
const seconds = (ms) => (Math.max(0, ms || 0) / 1000).toFixed(3);

/** The folder a test suite is named after: the input's folder, or the missing entry's (`ja` for `ja/paywall`). */
const suiteOf = (env) => {
  const d = path.posix.dirname(pathOf(env) ?? "-");
  return d === "." ? "." : d;
};

/** JUnit XML: one <testsuite> per input folder, one <testcase> per check or per finding-command input (spec 15). */
function junit(envs) {
  const suites = new Map();
  for (const env of envs) {
    if (!suites.has(suiteOf(env))) suites.set(suiteOf(env), []);
    const cs = cases(env);
    const each = (env.ms || 0) / cs.length;
    for (const c of cs) suites.get(suiteOf(env)).push({ ...c, classname: pathOf(env) ?? "-", ms: each });
  }
  const tally = (list) => ({
    tests: list.length,
    failures: list.filter((c) => c.status === "fail").length,
    errors: list.filter((c) => c.status === "error").length,
    skipped: list.filter((c) => c.status === "skipped").length,
    ms: list.reduce((n, c) => n + c.ms, 0),
  });
  const all = tally([...suites.values()].flat());
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    // The Jenkins XSD allows no skipped count on <testsuites>; each <testsuite> carries it.
    `<testsuites name="catscan" tests="${all.tests}" failures="${all.failures}" errors="${all.errors}" time="${seconds(all.ms)}">`];
  for (const [name, list] of suites) {
    const t = tally(list);
    out.push(`  <testsuite name="${xmlAttr(name)}" tests="${t.tests}" failures="${t.failures}" errors="${t.errors}" skipped="${t.skipped}" time="${seconds(t.ms)}">`);
    for (const c of list) {
      const open = `    <testcase name="${xmlAttr(c.name)}" classname="${xmlAttr(c.classname)}" time="${seconds(c.ms)}"`;
      const first = c.message.split("\n")[0];
      // TODO-077: findings below the thresholds go to <system-out>, so they never fail the case.
      const notes = c.notes && c.notes.length ? [`      <system-out>${xmlText(c.notes.join("\n"))}</system-out>`] : [];
      if (c.status === "pass") out.push(...(notes.length ? [`${open}>`, ...notes, "    </testcase>"] : [`${open}/>`]));
      else if (c.status === "skipped") out.push(`${open}>`, `      <skipped message="${xmlAttr(c.message)}"/>`, "    </testcase>");
      else {
        const tag = c.status === "error" ? "error" : "failure";
        out.push(`${open}>`, `      <${tag} type="${xmlAttr(c.kind)}" message="${xmlAttr(first)}">${xmlText(c.message)}</${tag}>`, ...notes, "    </testcase>");
      }
    }
    out.push("  </testsuite>");
  }
  out.push("</testsuites>");
  return out.join("\n") + "\n";
}

// ---- GitLab Code Quality -------------------------------------------------------------------------------------

/**
 * GitLab Code Quality entries: one per failed check or finding, one per error, needs-reader or unsupported input
 * (critical). TODO-077: an item's severity is its own (critical, major, minor), `info` below the thresholds; a pre-scale
 * item stays major. Findings keep output order, so the fingerprint (path, kind, identity text and the index among equal
 * entries, D8) is unchanged.
 */
function codequality(envs) {
  const raw = [];
  for (const env of envs) {
    const p = pathOf(env) ?? "-";
    for (const c of cases(env)) {
      const sev = (item) => (item?.gate === false ? "info" : item?.severity ?? "major");
      if (c.status === "error") raw.push({ p, kind: c.kind, ident: c.ident, message: c.message, severity: "critical" });
      else if (c.findings.length) for (const f of c.findings) raw.push({ p, kind: f.kind, ident: f.ident, message: f.message, severity: sev(f.item) });
      else if (c.status === "fail") raw.push({ p, kind: c.kind, ident: c.ident, message: c.message, severity: sev(c.item) });
    }
  }
  const seen = new Map();
  return raw.map((r) => {
    const k = JSON.stringify([r.p, r.kind, r.ident]);
    const index = seen.get(k) || 0;
    seen.set(k, index + 1);
    return {
      description: `${r.p}: ${r.message}`,
      check_name: `catscan/${r.kind}`,
      fingerprint: crypto.createHash("sha256").update(JSON.stringify([r.p, r.kind, r.ident, index])).digest("hex"),
      severity: r.severity,
      location: { path: r.p, lines: { begin: 1 } },
    };
  });
}

module.exports = { cases, githubLines, githubSummary, workflowError, escData, escProp, mdCell, junit, codequality, ANNOTATIONS, SUMMARY_BYTES };
