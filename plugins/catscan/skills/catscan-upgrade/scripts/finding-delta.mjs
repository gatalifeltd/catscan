#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// finding-delta v1 (catscan-upgrade skill). Node built-ins only; reads, never writes.
// Compares the findings of two runs of the same commands on the same screenshots (before and after an upgrade).
// A finding is matched by its results-file cell (device, text size, locale, screen; the path when no screen),
// check (the command), kind (with its reason) and normalized text. Within one cell, check and kind, equal texts
// are unchanged; one left on each side is `changed`; anything else is gone plus new.
// Usage: node finding-delta.mjs <before> <after> [--changes <behavior-changes.json> --from X.Y.Z --to X.Y.Z]
// <before> and <after> are results files or folders of them (catscan --results). With --changes, each new kind
// is tied to the behavior-change bullet in (from, to] that names it; a new finding with no bullet is unexplained.
// Prints one JSON document (schema 1): counts, new[], gone[], changed[], unexplained[]. Exit 0; 2 on a usage or
// input error (unreadable file, results_schema mismatch naming both values), with
// `finding-delta: <code>: <message> - try: <fix>` on stderr.
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ME = 'finding-delta';
class InputError extends Error { constructor(code, message, fix) { super(message); this.code = code; this.fix = fix; } }

/** Every results file under a path: the file itself, or the *.json files of a folder that carry results_schema. */
export function load(path) {
  if (!existsSync(path)) throw new InputError('missing', `${path} does not exist`, 'pass the --results file or the folder of the run');
  const files = statSync(path).isDirectory()
    ? readdirSync(path).filter((f) => f.endsWith('.json')).sort().map((f) => join(path, f))
    : [path];
  const docs = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new InputError('unreadable', `${f}: ${e.message}`, 'rerun the command with --results into an empty folder'); }
    if (doc && typeof doc === 'object' && 'results_schema' in doc) docs.push({ file: f, doc });
  }
  if (!docs.length) throw new InputError('no-results', `${path} holds no results file`, 'run the check commands with --results <folder>/<name>.json');
  const schemas = [...new Set(docs.map((d) => d.doc.results_schema))];
  return { docs, schemas };
}

const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** One record per finding and per failed check: { cell, check, kind, text }. */
export function findings(docs) {
  const out = [];
  for (const { doc } of docs) {
    for (const r of doc.results || []) {
      const cell = [r.device ?? '', r.text_size ?? '', r.locale ?? '', r.screen ?? r.path ?? ''].join('|');
      for (const f of r.findings || []) {
        const kind = f.reason ? `${f.kind}:${f.reason}` : String(f.kind);
        out.push({ cell, check: r.command, kind, text: norm(f.line ?? f.text ?? f.expected ?? f.expected_path ?? '') });
      }
      for (const c of r.checks || []) {
        if (c.verdict === 'fail') out.push({ cell, check: r.command, kind: `check:${c.kind}`, text: norm(c.text) });
      }
    }
  }
  return out;
}

/** The delta between two finding lists. */
export function delta(before, after) {
  const group = (list) => {
    const m = new Map();
    for (const f of list) {
      const k = `${f.cell}\u0000${f.check}\u0000${f.kind}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(f);
    }
    return m;
  };
  const b = group(before);
  const a = group(after);
  const out = { new: [], gone: [], changed: [], unchanged: 0 };
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const left = [...(b.get(k) || [])];
    const right = [];
    for (const f of a.get(k) || []) {
      const i = left.findIndex((x) => x.text === f.text);
      if (i === -1) right.push(f); else { left.splice(i, 1); out.unchanged++; }
    }
    if (left.length === 1 && right.length === 1) out.changed.push({ ...right[0], from: left[0].text, to: right[0].text });
    else { out.gone.push(...left); out.new.push(...right); }
  }
  return out;
}

const cmp = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The bullet between the two versions that names a finding kind, or null. A `kind:reason` finding matches a bullet
 * whose id holds the reason as a whole dash-separated word, or whose text names it in backticks; a bare kind needs
 * the id to be exactly the kind, or the text to name it in backticks (never a substring, so "overlap" is not explained
 * by "overlap-sheets"). A failed check (`check:<kind>`) is explained only by an exit-code bullet naming the check kind
 * in backticks. A downgrade reads the same range from the other end. */
export function explain(kind, changes, from, to) {
  const [lo, hi] = cmp(from, to) <= 0 ? [from, to] : [to, from];
  const [base, reason] = kind.split(':');
  const tick = (w) => (c) => c.text.includes(`\`${w}\``);
  const named = base === 'check'
    ? (c) => c.kind === 'exit-code' && tick(reason)(c)
    : reason
      ? (c) => new RegExp(`(^|-)${escape(reason)}(-|$)`).test(c.id) || tick(reason)(c)
      : (c) => c.id === base || tick(base)(c);
  for (const rel of changes.releases || []) {
    if (cmp(rel.version, lo) <= 0 || cmp(rel.version, hi) > 0) continue;
    for (const c of rel.changes || []) {
      if (['default-on', 'output', 'reader', 'exit-code'].includes(c.kind) && named(c)) return { version: rel.version, id: c.id, kind: c.kind };
    }
  }
  return null;
}

export function main(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--changes', '--from', '--to'].includes(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new InputError('usage', `${a} needs a value`, 'node finding-delta.mjs <before> <after> --changes <file> --from X.Y.Z --to X.Y.Z');
      opt[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new InputError('usage', `unknown option ${a}`, 'node finding-delta.mjs <before> <after>');
    else pos.push(a);
  }
  if (pos.length !== 2) throw new InputError('usage', 'needs a before and an after path', 'node finding-delta.mjs <before> <after>');
  if (opt.changes && !(opt.from && opt.to)) throw new InputError('usage', '--changes needs --from and --to', 'add --from <current> --to <target>');
  for (const k of ['from', 'to']) {
    if (opt[k] && !/^\d+\.\d+\.\d+$/.test(opt[k])) throw new InputError('bad-version', `--${k} ${opt[k]} is not X.Y.Z`, 'name the exact versions of the two runs');
  }
  const before = load(resolve(pos[0]));
  const after = load(resolve(pos[1]));
  const all = [...new Set([...before.schemas, ...after.schemas])];
  if (all.length > 1) {
    throw new InputError('results-schema-mismatch', `before has results_schema ${before.schemas.join(',')}, after has ${after.schemas.join(',')}`,
      'rerun the before commands with the current catscan and the after commands with the target, each into its own folder');
  }
  let changes = null;
  if (opt.changes) {
    try { changes = JSON.parse(readFileSync(opt.changes, 'utf8')); } catch (e) { throw new InputError('unreadable', `${opt.changes}: ${e.message}`, 'pass the behavior-changes.json of the target package'); }
  }
  const d = delta(findings(before.docs), findings(after.docs));
  const tie = (f) => (changes ? { ...f, explained_by: explain(f.kind, changes, opt.from, opt.to) } : f);
  const fresh = d.new.map(tie);
  const changed = d.changed.map(tie);
  const unexplained = changes ? [...fresh, ...changed].filter((f) => !f.explained_by) : [];
  return {
    schema: 1, results_schema: all[0],
    counts: { new: fresh.length, gone: d.gone.length, changed: changed.length, unchanged: d.unchanged, unexplained: unexplained.length },
    new: fresh, gone: d.gone, changed, unexplained,
  };
}

// realpath: on macOS a temp or copied folder under /var is /private/var to import.meta.url, and a plain
// resolve() would make the script exit 0 with no output.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    console.error(`${ME}: ${e.code}: ${e.message} - try: ${e.fix}`);
    process.exit(2);
  }
}
