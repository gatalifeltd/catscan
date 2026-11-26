// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-055: approved known findings. A finding is keyed without its box (D2), counted per key (D3), and matched
// per (command, cell) group (D26). `catscan results known` writes the file; `--known` applies it.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const scale = require("./scale");
const { CatscanError } = require("./install");
const { version } = require("../package.json");

const KNOWN_SCHEMA = 1;
const KEY_ALGO = 1;
// D4: every finding kind but these is approvable. known.test.js fails when the schema gains a kind not decided here.
const NOT_APPROVABLE = new Set(["missing"]);
const READ = new Set(["pass", "fail"]);
// Flags that decide which findings exist (spec "The known file"); --boxes, --allow, --prices only by presence.
const SCOPE_VALUE = new Set(["--reasons", "--kinds", "--rules", "--min-overlap", "--level", "--scale", "--device-profile", "--orientation"]);
const SCOPE_PRESENCE = new Set(["--experimental", "--pseudo", "--uncatalogued", "--boxes", "--prices", "--allow"]);
// The commands a results file's argv can name; the first one in argv is the run's command (options may precede it).
const RUN_COMMANDS = new Set(["check", "read", "untranslated", "video", "truncated", "overlap", "formats", "contrast", "fit"]);
// TODO-076 D13: text_size is part of the cell; a row has it only when it is not `default` (D6), so files approved
// before the axis keep their bytes and match the default cells.
const ROW_FIELDS = ["command", "pseudo", "device", "text_size", "locale", "screen", "path", "kind", "rule", "text"];
const GROUP_FIELDS = ["command", "pseudo", "device", "text_size", "locale", "screen", "path"];

/** Code point order (not UTF-16 unit order), so a reader in another language sorts rows the same way. */
function byCodePoint(a, b) {
  if (a === b) return 0;
  const x = a[Symbol.iterator](), y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next(), q = y.next();
    if (p.done || q.done) return p.done && q.done ? 0 : p.done ? -1 : 1;
    const d = p.value.codePointAt(0) - q.value.codePointAt(0);
    if (d) return d < 0 ? -1 : 1;
  }
}
const isMissing = (env) => env.path === null && (env.findings || []).some((f) => f && f.kind === "missing");
/** An input that read its image: verdict pass or fail, and not a missing-screenshot entry. */
const wasRead = (env) => READ.has(env.verdict) && !isMissing(env);

/**
 * Identity text, `key_algo` 1: NFKC, case-folded, clock times and digit runs as `#`, punctuation dropped, Latin,
 * Greek and Cyrillic combining marks (U+0300-U+036F after NFD) removed, whitespace collapsed. Kana voicing, Thai
 * tone marks and Indic signs are other blocks, so they are kept. Not the Swift baseline token rule (D2).
 */
function normalize(s) {
  if (typeof s !== "string") return null;
  const MASK = "\u0000"; // never punctuation, so the masks survive the punctuation pass
  // Lower case plus ß -> ss: full case folding, without the round trip through upper case that merges Turkish ı and i.
  let t = s.normalize("NFKC").toLowerCase().replace(/ß/g, "ss");
  t = t.replace(/\p{Nd}{1,2}:\p{Nd}{2}(?::\p{Nd}{2})?/gu, MASK).replace(/\p{Nd}+/gu, MASK);
  t = t.replace(/\p{P}+/gu, " ").normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");
  return t.replace(/\s+/gu, " ").trim().replace(/\u0000/g, "#");
}

/** One overlap side: its element id, else its text, else "" (a graphic element with no id; D24). */
const sideText = (s) => (s && s.element && typeof s.element.id === "string" ? s.element.id : s && typeof s.text === "string" ? s.text : "");

/** The finding's identity text before normalization: line, token, key, product; overlap sides sorted (spec "Key"). */
function identity(f) {
  if (f.kind === "overlap" || f.kind === "occluded") {
    // "|" is a symbol, not punctuation, so normalize keeps it: drop it from a side so no two side pairs join alike.
    const sides = [f.a, f.b].filter((s) => s != null).map((s) => normalize(sideText(s)).replace(/\s*\|\s*/g, " ").trim());
    return sides.sort(byCodePoint).join(" | ");
  }
  // fit: a textless control has no line; its element id names it. Without an id, its place does (the box center on a
  // 5% grid: small drift usually keeps it, a center near a grid line can flip), so two id-less icons in one cell are
  // two identities. Known rows written by 0.54.0 keyed them as null and are re-approved once.
  if (f.kind === "fit" && f.line === null) {
    if (f.element && typeof f.element.id === "string") return normalize(f.element.id);
    const b = f.element?.box ?? f.box;
    return Array.isArray(b) ? `@${[b[0] + b[2] / 2, b[1] + b[3] / 2].map((v) => Math.round(v * 20) * 5).join(",")}` : null;
  }
  for (const k of ["line", "token", "key", "product"]) if (typeof f[k] === "string") return normalize(f[k]);
  return null;
}

const approvable = (f) => Boolean(f) && typeof f.kind === "string" && !NOT_APPROVABLE.has(f.kind);

/** The cell of an envelope (D25): device, text size, then locale and screen when the layout mapped it, else the input path. */
function cellOf(env) {
  const mapped = env.screen !== null && env.screen !== undefined;
  return {
    command: env.command, pseudo: env.pseudo === true, device: env.device ?? null,
    text_size: env.text_size == null || env.text_size === "default" ? null : env.text_size,
    locale: typeof env.locale === "string" ? env.locale.toLowerCase() : null,
    screen: mapped ? env.screen : null, path: mapped ? null : env.path ?? null,
  };
}

/** The key row of a finding in an envelope (no count). */
function keyOf(env, f) {
  const rule = scale.ruleOf(f, false);
  return { ...cellOf(env), kind: f.kind, rule: rule === "-" ? null : rule, text: identity(f) };
}

const tuple = (row, fields) => JSON.stringify(fields.map((k) => row[k] ?? null));
const rowKey = (row) => tuple(row, ROW_FIELDS);
const groupKey = (row) => tuple(row, GROUP_FIELDS);

/** null < false < true < strings by code point, field by field: the file's one row order. */
function cmpRows(a, b) {
  const rank = (v) => (v === null || v === undefined ? "0" : typeof v === "boolean" ? (v ? "2" : "1") : `3${v}`);
  for (const k of [...ROW_FIELDS, "count"]) {
    const x = typeof a[k] === "number" ? `3${String(a[k]).padStart(12, "0")}` : rank(a[k]);
    const y = typeof b[k] === "number" ? `3${String(b[k]).padStart(12, "0")}` : rank(b[k]);
    const c = byCodePoint(x, y);
    if (c) return c;
  }
  return 0;
}

/** Counts per row key of one envelope's approvable findings: Map key -> { row, count }. */
function countEnvelope(env) {
  const out = new Map();
  for (const f of env.findings || []) {
    if (!approvable(f)) continue;
    const row = keyOf(env, f);
    const k = rowKey(row);
    const cur = out.get(k);
    if (cur) cur.count++;
    else out.set(k, { row, count: 1 });
  }
  return out;
}

const BARE = new Set(["--experimental", "--pseudo", "--uncatalogued"]);

/** argv with `--opt=value` split into two tokens, as the CLI parser reads it. */
const splitArgv = (argv) => (argv || []).flatMap((a) => (a.startsWith("--") && a.indexOf("=") > 2 ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a]));

/** The run's command: the first token of argv that names one. */
const commandOf = (argv) => (argv || []).find((a) => RUN_COMMANDS.has(a)) ?? null;

/** The scope flags of one run's argv: the filter flags as given, presence-only flags bare (spec "The known file"). */
function scopeFlags(argv) {
  const out = [], a = splitArgv(argv);
  for (let i = 0; i < a.length; i++) {
    if (SCOPE_VALUE.has(a[i])) { out.push(`${a[i]} ${a[i + 1] ?? ""}`.trim()); i++; }
    else if (SCOPE_PRESENCE.has(a[i])) { out.push(a[i]); if (!BARE.has(a[i])) i++; }
  }
  return out.sort(byCodePoint);
}

/** The run records of a results file: a merged file's shard records, else its own run. */
const runRecords = (obj) => (obj.run && Array.isArray(obj.run.shards) && obj.run.shards.length ? obj.run.shards : obj.run ? [obj.run] : []);

const macosMajor = (m) => (typeof m === "string" ? m.split(/[.\s]/)[0] : null);
const readerOfEnv = (env) => ({ engine: env.engine ?? null, vision_revision: env.host ? env.host.vision_revision ?? null : null, macos: env.host ? macosMajor(env.host.macos) : null });
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `catscan results known` (spec "catscan results known", D5, D17, D26): the known file `existing` (or null)
 * updated from parsed results files. Only the (command, cell) groups an input read are rewritten; per group a
 * key's approved count is the most any one input of the group has (D26: each input is matched alone). `prune` only
 * lowers counts and drops rows that reach 0. Returns { file, stats, warnings }.
 */
function approve(existing, files, { prune = false } = {}) {
  const groups = new Map(); // group key -> Map row key -> { row, count }
  const scopes = new Map(); // command -> scope entry
  const warnings = [], said = new Set();
  const warn = (w) => { if (!said.has(w.message)) { said.add(w.message); warnings.push(w); } };
  const fmt = (sc) => `${sc.flags.join(" ") || "no filter flags"}${sc.allow ? `, --allow ${sc.allow.slice(7, 19)}` : ""}`;
  let unread = 0, reader, axis = false, sizeAxis = false;
  for (const { obj, name } of files) {
    const read = new Set();
    for (const env of obj.results || []) {
      if (isMissing(env)) continue; // a missing screenshot is no input
      if (!wasRead(env)) { unread++; continue; }
      if (env.device != null) axis = true;
      if (cellOf(env).text_size !== null) sizeAxis = true;
      const gk = groupKey(cellOf(env));
      if (!groups.has(gk)) groups.set(gk, new Map());
      const g = groups.get(gk);
      for (const [k, v] of countEnvelope(env)) {
        const cur = g.get(k);
        if (!cur || cur.count < v.count) g.set(k, v);
      }
      const r = readerOfEnv(env);
      reader = reader === undefined ? r : sameJSON(reader, r) ? reader : null;
      read.add(env.command);
    }
    // A merged file records each shard's run; its own argv is the merge command, which names no filter flags.
    // The --allow digest is the one the run took (D30): a results file never makes this command open a path.
    for (const run of runRecords(obj)) {
      const c = commandOf(run.argv);
      if (!read.has(c)) continue;
      const sc = { flags: scopeFlags(run.argv), allow: run.allow ?? null };
      const prev = scopes.get(c);
      if (!prev) scopes.set(c, sc);
      else if (!sameJSON(prev, sc)) warn({ code: "known-scope-differs", message: `${name}: the ${c} runs used different filters (${fmt(prev)} vs ${fmt(sc)}); the file records the first`, hint: "approve results of one set of flags, or approve each set into its own known file" });
    }
  }
  // D31: a re-approval under other filters rewrites the groups it read, so rows the old filters found are dropped.
  if (!prune && existing) for (const [c, sc] of scopes) {
    const old = existing.scope[c];
    if (old && !sameJSON(old, sc)) warn({ code: "known-scope-differs", message: `${c} was approved with ${fmt(old)}, these results with ${fmt(sc)}; rows only the old filters found are removed from the groups re-read`, hint: "re-approve with the same flags, or check the removed rows in the diff before committing" });
  }
  const old = new Map(); // row key -> row
  for (const row of existing ? existing.findings : []) old.set(rowKey(row), row);
  const next = new Map();
  for (const [k, row] of old) if (!groups.has(groupKey(row))) next.set(k, row); // groups no input read are kept
  for (const [gk, g] of groups) {
    if (prune) {
      for (const [k, row] of old) {
        if (groupKey(row) !== gk) continue;
        const n = Math.min(row.count, g.get(k)?.count ?? 0);
        if (n > 0) next.set(k, { ...row, count: n });
      }
    } else {
      for (const [k, { row, count }] of g) next.set(k, { ...row, count });
    }
  }
  let added = 0, removed = 0;
  for (const k of new Set([...old.keys(), ...next.keys()])) {
    const d = (next.get(k)?.count ?? 0) - (old.get(k)?.count ?? 0);
    if (d > 0) added += d; else removed -= d;
  }
  const rows = [...next.values()].map((r) => Object.fromEntries([...ROW_FIELDS, "count"].filter((f) => f !== "text_size" || r[f] != null).map((f) => [f, r[f] ?? null]))).sort(cmpRows);
  const scope = { ...(existing ? existing.scope : {}) };
  if (!prune) for (const [c, sc] of scopes) scope[c] = sc;
  const sortedScope = Object.fromEntries(Object.keys(scope).sort(byCodePoint).map((c) => [c, scope[c]]));
  // `reader` is null when the readers are mixed (spec "The known file"); prune adds no row, so it keeps the old one.
  // A file whose rows all came from this approval takes this approval's reader, so a mixed (null) reader can clear.
  const keptOld = [...next.values()].some((r) => !groups.has(groupKey(r)));
  let newReader;
  if (!existing) newReader = reader ?? null;
  else if (prune || reader === undefined) newReader = existing.reader;
  else if (!keptOld) newReader = reader;
  else newReader = sameJSON(existing.reader, reader) ? reader : null;
  const axes = [...(axis || rows.some((r) => r.device !== null) ? ["device"] : []), ...(sizeAxis || rows.some((r) => r.text_size != null) ? ["text_size"] : [])];
  const file = { known_schema: KNOWN_SCHEMA, key_algo: KEY_ALGO, catscan: version, axes, reader: newReader, scope: sortedScope, findings: rows };
  const total = rows.reduce((n, r) => n + r.count, 0);
  const groupCount = new Set(rows.map(groupKey)).size;
  return { file, stats: { findings: total, groups: groupCount, added, removed, unread }, warnings };
}

/** Consistency errors of a parsed known file beyond its schema: [{ pointer, message }]. */
function consistency(obj) {
  const errors = [];
  const seen = new Set();
  obj.findings.forEach((r, i) => {
    const k = rowKey(r);
    if (seen.has(k)) errors.push({ pointer: `/findings/${i}`, message: "repeats the key of an earlier row; one row per key" });
    seen.add(k);
    if (i > 0 && cmpRows(obj.findings[i - 1], r) > 0) errors.push({ pointer: `/findings/${i}`, message: "is out of order; rows are sorted by every field (rewrite the file with catscan results known)" });
    if (r.kind !== undefined && NOT_APPROVABLE.has(r.kind)) errors.push({ pointer: `/findings/${i}/kind`, message: `is ${r.kind}, which cannot be approved` });
  });
  const usesDevice = obj.findings.some((r) => r.device !== null);
  if (usesDevice && !obj.axes.includes("device")) errors.push({ pointer: "/axes", message: "does not list device, but a row has one" });
  if (obj.findings.some((r) => r.text_size != null) && !obj.axes.includes("text_size")) errors.push({ pointer: "/axes", message: "does not list text_size, but a row has one" });
  return errors;
}

let validator = null;
function schemaValidator() {
  if (validator) return validator;
  const Ajv = require("ajv");
  const dir = [path.join(__dirname, "../schema"), path.join(__dirname, "../../../core/schema")].find((d) => fs.existsSync(path.join(d, "known.schema.json")));
  if (!dir) throw new CatscanError("binary-failed", "the known-file JSON Schema is missing from this install", "reinstall @catscan/cli");
  validator = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(fs.readFileSync(path.join(dir, "known.schema.json"), "utf8")));
  return validator;
}

/** A newer `known_schema` or `key_algo` than this version reads (D7: exit 2 `known-algo-unsupported`), or null. */
function unsupported(obj) {
  if (!obj || typeof obj !== "object") return null;
  const bad = [["known_schema", KNOWN_SCHEMA], ["key_algo", KEY_ALGO]].filter(([k, n]) => typeof obj[k] === "number" && obj[k] > n);
  if (!bad.length) return null;
  return {
    code: "known-algo-unsupported",
    message: `the known file has ${bad.map(([k]) => `${k} ${obj[k]}`).join(" and ")}, but this catscan reads ${bad.map(([k, n]) => `${k} ${n}`).join(" and ")}`,
    hint: `upgrade catscan to ${typeof obj.catscan === "string" ? obj.catscan : "the version that wrote it"} or later, or re-approve with this one: catscan results known <results.json> --out <file>`,
  };
}

/** Schema and consistency errors of a parsed known file. */
function check(obj) {
  const v = schemaValidator();
  if (!v(obj)) return v.errors.map((e) => ({ pointer: e.instancePath || "/", message: e.message + (e.params && e.params.allowedValues ? ` (${e.params.allowedValues.join(", ")})` : "") }));
  return consistency(obj);
}

const isKnownFile = (obj) => Boolean(obj) && typeof obj === "object" && !Array.isArray(obj) && "known_schema" in obj;

/** The file's text: rows one per line so a re-approval diff shows exactly the changed rows (spec "The known file"). */
function serialize(file) {
  const { findings, ...head } = file;
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const rows = findings.map((r) => `    ${JSON.stringify(r)}`).join(",\n");
  return `${top},\n  "findings": [${rows ? `\n${rows}\n  ` : ""}]\n}\n`;
}

// ---- matching (used by --known) -------------------------------------------------------------------------

/** An index of a known file: row key -> approved count, and group key -> its rows. */
function index(file) {
  const counts = new Map(), groups = new Map();
  for (const r of file.findings) {
    counts.set(rowKey(r), r.count);
    const g = groupKey(r);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  return { counts, groups };
}

/**
 * Matches one envelope's findings (spec "Key and matching", D3): per key, found <= approved makes every finding of
 * the key known; more makes every one new. Returns Map finding -> { known, found, approved }; unapprovable
 * findings are absent. Envelopes that read nothing (error, needs-reader, unsupported, missing) match nothing.
 */
function matchEnvelope(idx, env) {
  const out = new Map();
  if (!wasRead(env)) return out;
  const counts = countEnvelope(env);
  for (const f of env.findings || []) {
    if (!approvable(f)) continue;
    const k = rowKey(keyOf(env, f));
    const found = counts.get(k).count, approved = idx.counts.get(k) ?? 0;
    out.set(f, { known: found <= approved, found, approved });
  }
  return out;
}

/**
 * Approved rows no longer found (D9, D26): for every group an envelope read, approved minus the most any one input
 * of the group found. Returns rows with `count` the gone count, in file order.
 */
function goneRows(idx, envs) {
  const most = new Map(), read = new Set();
  for (const env of envs) {
    if (!wasRead(env)) continue;
    read.add(groupKey(cellOf(env)));
    for (const [k, v] of countEnvelope(env)) most.set(k, Math.max(most.get(k) ?? 0, v.count));
  }
  const out = [];
  for (const g of read) for (const r of idx.groups.get(g) || []) {
    const n = r.count - (most.get(rowKey(r)) ?? 0);
    if (n > 0) out.push({ ...r, count: n });
  }
  return out.sort(cmpRows);
}

/** `known-drift` (spec "Errors and warnings"): a new and a gone row in one cell, kind and rule. */
function drift(newRows, gone) {
  const k = (r) => tuple(r, [...GROUP_FIELDS, "kind", "rule"]);
  const g = new Set(gone.map(k));
  return newRows.filter((r) => g.has(k(r)));
}

// ---- applying a known file (--known) -----------------------------------------------------------------------

/**
 * The run-time context of a parsed known file (or null for a missing one: every finding new, D7 fail closed).
 * `file` is the name outputs print; `digest` is `sha256:<hex>` of the file's bytes.
 */
function context(obj, file, text) {
  return { obj, file, digest: obj ? `sha256:${crypto.createHash("sha256").update(text).digest("hex")}` : null, idx: index(obj || { findings: [] }) };
}

/** Matches an envelope whose `path` is already the private (results-file) path; null without a context. */
const match = (ctx, env) => (ctx ? matchEnvelope(ctx.idx, env) : null);

/**
 * Warnings that the run differs from what the file approved (D15, D20, D25): one `known-scope-differs` per command
 * whose filter flags or --allow digest differ, one per axis (device, text_size) that differs (TODO-084 D4); one
 * `known-reader-changed`. `run`: { command, argv (private), allow, axes, reader, results } with reader { engine,
 * vision_revision, macos } or null and results the run's --results path or null (TODO-084 D7).
 */
function runWarnings(ctx, run) {
  if (!ctx || !ctx.obj) return [];
  const out = [], f = ctx.obj;
  const fmt = (sc) => `${sc.flags.join(" ") || "no filter flags"}${sc.allow ? `, --allow ${sc.allow.slice(7, 19)}` : ""}`;
  const sc = { flags: scopeFlags(run.argv), allow: run.allow ?? null };
  const old = f.scope[run.command];
  // TODO-084 D7: the printed command runs as is, so paths are shell-quoted (the rule fit.js and cli.js use).
  const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
  const reapprove = `catscan results known ${run.results != null ? q(run.results) : "<results.json>"} --out ${q(ctx.file)}`;
  if (old && !sameJSON(old, sc)) out.push({ code: "known-scope-differs", message: `${ctx.file} approved ${run.command} with ${fmt(old)}, this run uses ${fmt(sc)}; findings outside the approved scope show as new, approved ones the flags now drop show as gone`, hint: `run with the approved flags, or re-approve: ${reapprove}` });
  if (f.findings.some((r) => r.command === run.command)) {
    const has = (a, axis) => (a || []).includes(axis);
    const on = (a, axis) => (has(a, axis) ? "with" : "without");
    if (has(f.axes, "device") !== has(run.axes, "device")) {
      out.push({ code: "known-scope-differs", message: `${ctx.file} was approved ${on(f.axes, "device")} the device axis, this run is ${on(run.axes, "device")} it; no cell matches across the two`, hint: `approve from a run with the same --device or layout: ${reapprove}` });
    }
    // TODO-084: a cell without a size is `default` on both sides, so only the default-size cells still match.
    if (has(f.axes, "text_size") !== has(run.axes, "text_size")) {
      out.push({ code: "known-scope-differs", message: `${ctx.file} was approved ${on(f.axes, "text_size")} the text size axis, this run is ${on(run.axes, "text_size")} it; only default-size cells match across the two`, hint: `approve from a run with the same --text-size or layout: ${reapprove}` });
    }
  }
  const r = f.reader, now = run.reader;
  if (r && now && (r.engine !== now.engine || r.vision_revision !== now.vision_revision || r.macos !== now.macos)) {
    const name = (x) => `${x.engine}, Vision revision ${x.vision_revision}, macOS ${x.macos}`;
    out.push({ code: "known-reader-changed", message: `${ctx.file} was approved on ${name(r)}; this run reads with ${name(now)}, so read text may differ`, hint: "expect known-drift notes; re-approve after review on this reader" });
  }
  return out;
}

/**
 * The axes of a run for runWarnings (TODO-084 D1): `device` when an entry has one (missing entries too), `text_size`
 * when an entry that was read has a cell size other than `default`, as the approve side writes `axes`.
 */
function runAxes(envs) {
  // Size from read entries only, as approve counts it: a size whose shots are all missing or unreadable is no axis.
  return [...(envs.some((e) => e.device != null) ? ["device"] : []), ...(envs.some((e) => wasRead(e) && cellOf(e).text_size !== null) ? ["text_size"] : [])];
}

/** The reader of a run for runWarnings, from its first envelope that read an image (null if none). */
function runReader(envs) {
  const e = envs.find((x) => wasRead(x) && x.host);
  return e ? readerOfEnv(e) : null;
}

/**
 * The results file's top-level `known` block (spec "Results file") for envelopes already matched and annotated:
 * { file, digest, key_algo, counts: { known, new, gone }, gone: [rows] }, plus `drift` rows (not written).
 */
function block(ctx, envs) {
  let k = 0, n = 0;
  const fresh = [];
  for (const e of envs) for (const f of e.findings || []) {
    if (f.known === true) k++;
    else if (f.known === false) { n++; fresh.push(keyOf(e, f)); }
  }
  const gone = goneRows(ctx.idx, envs);
  const seen = new Set();
  const uniqFresh = fresh.filter((r) => { const x = rowKey(r); return seen.has(x) ? false : (seen.add(x), true); });
  return {
    known: { file: ctx.file, digest: ctx.digest, key_algo: KEY_ALGO, counts: { known: k, new: n, gone: gone.reduce((a, r) => a + r.count, 0) }, gone },
    drift: drift(uniqFresh, gone),
  };
}

/**
 * `results merge` and `report` with --known (D10, D28): re-matches a stored envelope in place. A finding that turns
 * known stops gating; one that was known and is not any more gates again under `th` (its file's thresholds); every
 * other gate is kept, so mixed-threshold shards are not re-banded. Sets the verdict. Missing entries are untouched.
 */
function reapply(ctx, env, th) {
  if (!wasRead(env)) return env;
  const was = new Map((env.findings || []).map((f) => [f, f.known === true]));
  for (const f of env.findings || []) { delete f.known; delete f.known_counts; }
  scale.markKnown(env, matchEnvelope(ctx.idx, env));
  for (const f of env.findings || []) {
    if (f.known !== true && was.get(f) && f.severity !== undefined) f.gate = scale.gates(f, th);
  }
  env.verdict = scale.verdictOf(env);
  return env;
}

module.exports = {
  context, match, reapply, runWarnings, runAxes, runReader, block,
  KNOWN_SCHEMA, KEY_ALGO, NOT_APPROVABLE, normalize, identity, approvable, cellOf, keyOf, rowKey, groupKey, cmpRows,
  scopeFlags, commandOf, byCodePoint, approve, check, unsupported, isKnownFile, serialize, index, matchEnvelope, goneRows, drift,
};
