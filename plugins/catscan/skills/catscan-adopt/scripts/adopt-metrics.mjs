#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Before/after numbers for catscan-adopt apply mode. No dependencies.
// count: one JSON line of coverage and findings from a run. record: one metrics row from count, measure.sh and its
// --log folder. table: the rows as markdown. Exit 0 ok, 2 usage, 4 input unreadable or empty, 5 internal error.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const USAGE = `usage: adopt-metrics.mjs count --stamp FILE [--shots DIR --results FILE...] [--pw-json FILE --asserted TITLE... [--locale L]...]
       adopt-metrics.mjs record --batch ID --layer NAME [--points 01,02] [--count FILE] [--added RUNS]
                         (--measure FILE --log DIR [--tests-before N --tests-after N] | --no-cost REASON)
                         [--real N --false N --edits N --proofs PASSED/TOTAL] [--before-note by-eye]
                         [--layer-wall SECONDS] [--local-na STEP]... [--file PATH]
       adopt-metrics.mjs table [--file PATH]
default --file: .test-speedup/adopt/metrics.jsonl`;
const FILE = '.test-speedup/adopt/metrics.jsonl';
const SCHEMA = 1;
const IMAGE = /\.(png|jpe?g|webp|heic|tiff?|bmp|gif)$/i;

class Exit extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const usage = (msg) => new Exit(2, `adopt-metrics: ${msg}\n${USAGE}`);
const unreadable = (path, why, next) => new Exit(4, `adopt-metrics: ${path}: ${why}. Next: ${next}`);

// Flags: --name value, repeatable ones collect into arrays; --no-cost and --before-note take a value too.
const REPEAT = new Set(['results', 'asserted', 'locale', 'local-na']);
function parse(argv, known) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)$/);
    if (!m || !known.includes(m[1])) throw usage(`unknown argument ${argv[i]}`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw usage(`--${m[1]} needs a value`);
    const v = argv[++i];
    if (REPEAT.has(m[1])) (o[m[1]] ??= []).push(v);
    else if (m[1] in o) throw usage(`--${m[1]} given twice`);
    else o[m[1]] = v;
  }
  return o;
}
const int = (o, k) => {
  if (o[k] === undefined) return undefined;
  if (!/^\d+$/.test(o[k])) throw usage(`--${k} needs a whole number, got '${o[k]}'`);
  return Number(o[k]);
};
function readJson(path, next) {
  let s;
  try { s = readFileSync(path, 'utf8'); } catch (e) { throw unreadable(path, `cannot read (${e.code ?? e.message})`, next); }
  try { return JSON.parse(s); } catch (e) { throw unreadable(path, `not JSON (${e.message})`, next); }
}

// ---------- count ----------

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? walk(p) : d.isFile() ? [p] : [];
  });
}

function count(o) {
  if (!o.shots && !o.results && !o['pw-json']) throw usage('count needs --shots with --results, or --pw-json');
  if (!!o.shots !== !!o.results) throw usage('--shots and --results go together: captured comes from the shot folder, checked from the results files');
  if (!o.stamp) throw usage('count needs --stamp, a file touched after the shot folder was emptied and before the run');
  if (!!o['pw-json'] !== !!o.asserted) throw usage('--pw-json and --asserted go together: --asserted names each test that carries an added catscan assertion');
  if (o.locale && !o['pw-json']) throw usage('--locale declares the matcher tests\' locales; it needs --pw-json');
  const out = { shots: null, tests: null, findings: 0 };
  let since;
  try { since = statSync(o.stamp).mtimeMs; } catch (e) { throw unreadable(o.stamp, `cannot read the stamp (${e.code})`, 'touch the stamp file after emptying the shot folder, then rerun the layer'); }
  // A results file or report left by an earlier run would pass its old coverage off as this run's.
  for (const f of [...(o.results ?? []), ...(o['pw-json'] ? [o['pw-json']] : [])]) {
    let t;
    try { t = statSync(f).mtimeMs; } catch { continue; } // readJson below names it
    if (t <= since) throw unreadable(f, 'older than the stamp, so an earlier run wrote it', 'run the layer once after touching the stamp, with the flags that write this file, then count');
  }

  if (o.shots) {
    let files;
    try { files = walk(o.shots); } catch (e) { throw unreadable(o.shots, `cannot list the shot folder (${e.code})`, 'run the layer so it writes its shots, then count again'); }
    // Only what this run wrote: the folder was emptied first, so dynamic names need no rule.
    const captured = files.filter((f) => IMAGE.test(f) && statSync(f).mtimeMs > since).length;
    if (!captured) throw unreadable(o.shots, 'no image newer than the stamp', 'empty the folder, touch the stamp, run the layer once, then count; check the layer writes its shots here');
    // checked = distinct shot paths a check read, across every file and command. Not coverage.received: it
    // counts a shot once per command and counts error envelopes too.
    const paths = new Set();
    const unread = new Set();
    const byLocale = {};
    for (const f of o.results) {
      const r = readJson(f, 'pass the --results file the catscan step of this run wrote');
      if (!Array.isArray(r.results) || !r.results.length) throw unreadable(f, 'no results entry', 'check the catscan step ran on this run\'s shots and passed --results');
      for (const e of r.results) {
        // error (image not readable), unsupported and needs-reader (language) checked nothing: neither checked nor a finding.
        if (e.verdict === 'error' || e.verdict === 'unsupported' || e.verdict === 'needs-reader') { if (e.path != null) unread.add(e.path); continue; }
        if (e.verdict !== 'pass') out.findings++; // a missing cell (path null) is a finding too
        if (e.path == null || paths.has(e.path)) continue;
        paths.add(e.path);
        if (e.locale) byLocale[e.locale] = (byLocale[e.locale] ?? 0) + 1;
      }
    }
    const unchecked = [...unread].filter((p) => !paths.has(p)).length;
    out.shots = { checked: paths.size, captured, unchecked, locales: Object.keys(byLocale).sort(), by_locale: sortKeys(byLocale) };
  }

  if (o['pw-json']) {
    const report = readJson(o['pw-json'], 'run the layer with the JSON reporter flag from references/measure.md');
    const tests = [];
    const visit = (suite, path) => {
      for (const s of suite.specs ?? []) for (const t of s.tests ?? []) tests.push({ file: s.file ?? suite.file, title: [...path, s.title].join(' > '), status: t.status, results: t.results ?? [] });
      for (const c of suite.suites ?? []) visit(c, c.title && c.title !== c.file ? [...path, c.title] : path);
    };
    for (const s of report.suites ?? []) visit(s, []);
    const want = new Set(o.asserted);
    // A named test may run in several projects; each run counts once.
    const hit = tests.filter((t) => want.has(t.title) || want.has(`${t.file} > ${t.title}`));
    const seen = new Set(hit.flatMap((t) => [t.title, `${t.file} > ${t.title}`]));
    const absent = o.asserted.filter((a) => !seen.has(a));
    if (absent.length) throw unreadable(o['pw-json'], `no test titled ${absent.map((a) => JSON.stringify(a)).join(', ')}`, 'pass each title as the report shows it ("<describe> > <test>", optionally "<file> > " first)');
    const passed = hit.filter((t) => t.status === 'expected' || t.status === 'flaky').length;
    // A skipped test ran no assertion: neither checked nor a finding.
    const failed = hit.filter((t) => t.status === 'unexpected').length;
    out.tests = { checked: passed, failed, skipped: hit.length - passed - failed, locales: [...new Set(o.locale ?? [])].sort(), locales_source: 'declared' };
    out.findings += failed;
  }
  return JSON.stringify(out);
}
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

// ---------- record ----------

// Test counts from one run log: Playwright (list/line/dot and JSON stats), Jest, Vitest, node:test (spec and TAP).
function testCounts(log) {
  // Every match adds: an arm may run one runner twice (two configs, workspaces) joined with &&.
  const n = (re) => [...log.matchAll(new RegExp(re.source, 'gm'))].reduce((a, m) => a + Number(m[1]), 0);
  const found = [];
  const json = [...log.matchAll(/"stats"\s*:\s*\{[^}]*"expected"\s*:\s*(\d+)[^}]*\}/g)];
  if (json.length) {
    for (const m of json) {
      const s = JSON.parse(`{${m[0]}}`).stats;
      found.push({ passed: s.expected + (s.flaky ?? 0), failed: s.unexpected ?? 0, skipped: s.skipped ?? 0 });
    }
  } else if (PW.test(log)) {
    // Playwright's closing lines: "  2 passed (3.1s)", "  1 failed", "  1 flaky", "  1 skipped".
    const pw = (k) => n(new RegExp(`^\\s*(\\d+) ${k}( \\(.*\\))?\\s*$`, 'm'));
    found.push({ passed: pw('passed') + pw('flaky'), failed: pw('failed'), skipped: pw('skipped') + pw('did not run') });
  }
  const part = (line, k) => Number(line.match(new RegExp(`(\\d+) ${k}`))?.[1] ?? 0);
  for (const [, line] of log.matchAll(/^Tests:\s+(.+ total)$/gm)) found.push({ passed: part(line, 'passed'), failed: part(line, 'failed'), skipped: part(line, 'skipped') + part(line, 'todo') });
  for (const [, line] of log.matchAll(/^\s*Tests\s+(.+\(\d+\))\s*$/gm)) found.push({ passed: part(line, 'passed'), failed: part(line, 'failed'), skipped: part(line, 'skipped') + part(line, 'todo') });
  const nt = /^(ℹ|#) tests \d+$/m.test(log);
  if (nt) {
    const t = (k) => n(new RegExp(`^(?:ℹ|#) ${k} (\\d+)$`, 'm'));
    found.push({ passed: t('pass'), failed: t('fail') + t('cancelled'), skipped: t('skipped') + t('todo') });
  }
  if (!found.length) return null;
  // An arm may chain two runners (tests && a catscan step that prints no summary): their counts add.
  const sum = found.reduce((a, c) => ({ passed: a.passed + c.passed, failed: a.failed + c.failed, skipped: a.skipped + c.skipped }));
  return { ...sum, total: sum.passed + sum.failed + sum.skipped };
}

function measureResult(path) {
  let s;
  try { s = readFileSync(path, 'utf8'); } catch (e) { throw unreadable(path, `cannot read (${e.code})`, 'save measure.sh stdout to this file (measure.sh ... > FILE)'); }
  const arms = {};
  for (const m of s.matchAll(/^arm=(A|B) label=(\S+) runs=(\d+) wall_median_s=([\d.]+) cpu_median_s=([\d.]+) load=(\S*) status=(\w+)$/gm)) {
    arms[m[1]] = { label: m[2], runs: Number(m[3]), wall: Number(m[4]), cpu: Number(m[5]), load: m[6], status: m[7] };
  }
  if (!arms.A || !arms.B) throw unreadable(path, 'no arm=A and arm=B lines', 'run measure.sh with both arms (before first, after second) and save its stdout here');
  // The deltas are B - A: swapped arms would flip every sign without a word.
  if (!arms.A.label.startsWith('before@') || !arms.B.label.startsWith('after@')) throw unreadable(path, `arm A is ${arms.A.label} and arm B is ${arms.B.label}`, 'run measure.sh with before@<rev> first and after@<rev> second');
  return arms;
}

function armCounts(dir, arm) {
  let logs;
  try { logs = readdirSync(dir).filter((f) => new RegExp(`^${arm}-run-\\d+\\.log$`).test(f)).sort(); } catch (e) { throw unreadable(dir, `cannot list the --log folder (${e.code})`, 'pass the folder given to measure.sh --log'); }
  if (!logs.length) throw unreadable(dir, `no ${arm}-run-*.log`, 'pass the folder given to measure.sh --log');
  const counts = logs.map((f) => {
    const c = testCounts(readFileSync(join(dir, f), 'utf8'));
    if (!c) throw unreadable(join(dir, f), 'no test summary this script can parse (Playwright, Jest, Vitest, node:test)', 'read the counts in that log and pass --tests-before N --tests-after N');
    return { log: f, ...c };
  });
  return counts;
}

const PW = /^\s*\d+ (passed|failed|flaky|skipped|did not run)( \(.*\))?\s*$/m;
const same = (a, b) => a.passed === b.passed && a.failed === b.failed && a.skipped === b.skipped;

function record(o) {
  for (const k of ['batch', 'layer']) if (!o[k]) throw usage(`record needs --${k}`);
  const added = int(o, 'added') ?? 0;
  const tb = int(o, 'tests-before');
  const ta = int(o, 'tests-after');
  if ((tb === undefined) !== (ta === undefined)) throw usage('--tests-before and --tests-after go together');
  if (o['no-cost'] && (o.measure || o.log || tb !== undefined)) throw usage('--no-cost records coverage and value only; drop --measure, --log and --tests-*');
  if (!o['no-cost'] && !o.measure) throw usage('record needs --measure FILE (measure.sh stdout), or --no-cost REASON');
  if (o.measure && !o.log && tb === undefined) throw usage('--measure needs --log DIR to read test counts, or --tests-before N --tests-after N quoted from the logs');
  if (o['before-note'] && o['before-note'] !== 'by-eye') throw usage(`--before-note takes by-eye, got '${o['before-note']}'`);
  const proofs = o.proofs?.match(/^(\d+)\/(\d+)$/);
  if (o.proofs && !proofs) throw usage(`--proofs takes PASSED/TOTAL, got '${o.proofs}'`);
  const wall = o['layer-wall'];
  if (wall !== undefined && !/^\d+(\.\d+)?$/.test(wall)) throw usage(`--layer-wall takes seconds, got '${wall}'`);

  let coverage = { shots: null, tests: null, findings: null };
  if (o.count) {
    let line;
    try { line = readFileSync(o.count, 'utf8').trim(); } catch (e) { throw unreadable(o.count, `cannot read (${e.code})`, 'save the stdout of adopt-metrics.mjs count to this file'); }
    try { coverage = JSON.parse(line); } catch { coverage = null; }
    if (!coverage || typeof coverage !== 'object' || !('shots' in coverage) || !('tests' in coverage)) throw unreadable(o.count, 'not the JSON line count prints', 'save the stdout of adopt-metrics.mjs count to this file');
  }

  const row = {
    schema: SCHEMA, batch: o.batch, layer: o.layer, points: o.points ? o.points.split(',') : [], recorded: new Date().toISOString(),
    coverage: { before: 0, before_note: o['before-note'] ?? null, shots: coverage.shots, tests: coverage.tests, findings: coverage.findings },
    value: { real: int(o, 'real') ?? null, false: int(o, 'false') ?? null, edits: int(o, 'edits') ?? null, proofs: proofs ? { passed: Number(proofs[1]), total: Number(proofs[2]) } : null },
    tests: null, cost: null, local_na: o['local-na'] ?? [], status: 'ok', reason: null,
  };
  if (o['no-cost']) {
    row.status = 'skipped';
    row.reason = `cost not measured: ${o['no-cost']}. Next: run measure.sh on the two worktrees and record again`;
    return row;
  }

  const arms = measureResult(o.measure);
  const cost = { runs: arms.B.runs, before: arms.A, after: arms.B, delta_wall: round(arms.B.wall - arms.A.wall), delta_cpu: round(arms.B.cpu - arms.A.cpu), layer_wall: wall === undefined ? null : Number(wall), share: null };
  if (cost.layer_wall) cost.share = round(cost.delta_wall / cost.layer_wall, 4);
  row.cost = cost;
  if (arms.A.status !== 'ok' || arms.B.status !== 'ok') {
    row.status = 'void';
    row.reason = 'a measured run failed (measure.sh exit 3), so the timing is void. Next: make both arms green, then measure again without --allow-fail';
    return row;
  }

  let before, after, source;
  if (tb !== undefined) {
    source = 'quoted';
    before = { total: tb };
    after = { total: ta };
  } else {
    source = 'log';
    const a = armCounts(o.log, 'A');
    const b = armCounts(o.log, 'B');
    for (const [arm, list] of [['before', a], ['after', b]]) {
      const odd = list.find((c) => !same(c, list[0]));
      if (odd) {
        row.tests = { before: a[0], after: b[0], added, source };
        row.status = 'void';
        row.reason = `${arm} runs disagree: ${list[0].log} has ${list[0].total} tests, ${odd.log} has ${odd.total}. Next: see the --log files; a flaky suite needs a fix before timing`;
        return row;
      }
    }
    before = strip(a[0]);
    after = strip(b[0]);
  }
  row.tests = { before, after, added, source };
  // After = before + the tests the batch adds, and every before test keeps its result.
  const expected = before.total + added;
  if (after.total !== expected) {
    row.status = 'void';
    row.reason = `after ran ${after.total} tests, expected ${expected} (${before.total} + ${added} added). Next: see the --log files`;
  } else if (source === 'log' && (after.failed !== before.failed || after.skipped !== before.skipped || after.passed !== before.passed + added)) {
    row.status = 'void';
    row.reason = `a before test changed result: before ${fmt(before)}, after ${fmt(after)} with ${added} added. Next: see the --log files`;
  } else if (cost.runs < 3) {
    row.status = 'indicative';
    row.reason = `${cost.runs} measured run per arm (quick mode), so the timing is indicative. Next: measure.sh -n 3 for a full row`;
  }
  return row;
}
const strip = ({ log, ...c }) => c;
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const fmt = (c) => `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped`;

// ---------- table ----------

function readRows(file) {
  let s;
  try { s = readFileSync(file, 'utf8'); } catch (e) { throw unreadable(file, `cannot read (${e.code})`, 'run adopt-metrics.mjs record for each measured batch first'); }
  const rows = s.split('\n').filter((l) => l.trim()).map((l, i) => {
    let r;
    try { r = JSON.parse(l); } catch { throw unreadable(`${file}:${i + 1}`, 'not a JSON line', 'delete the line, or rebuild the file by recording each batch again'); }
    if (r.schema !== SCHEMA) throw usage(`${file}:${i + 1}: unknown schema ${JSON.stringify(r.schema)} (this script reads ${SCHEMA}); rebuild the file: delete it and record each batch again`);
    return r;
  });
  if (!rows.length) throw unreadable(file, 'no rows', 'run adopt-metrics.mjs record for each measured batch first');
  return rows;
}

const sec = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)} s`;
function coverageCell(c) {
  const parts = [];
  if (c.shots) parts.push(`${c.shots.checked}/${c.shots.captured} shots${c.shots.locales.length ? ` (${c.shots.locales.join(', ')})` : ''}`);
  if (c.tests) parts.push(`${c.tests.checked} tests${c.tests.locales.length ? ` (${c.tests.locales.join(', ')}, declared)` : ''}`);
  return parts.join('; ') || '-';
}
function costCell(r) {
  if (!r.cost) return 'skipped';
  if (r.status === 'void') return 'void';
  const share = r.cost.share === null ? '' : ` (${(r.cost.share * 100).toFixed(1)}% of the layer)`;
  return `${sec(r.cost.delta_wall)} wall${share}, ${sec(r.cost.delta_cpu)} CPU${r.status === 'indicative' ? ', indicative' : ''}`;
}
const v = (x) => (x === null || x === undefined ? '-' : String(x));

function table(file) {
  const rows = readRows(file);
  const out = [
    '| Batch | Layer | Checked before | Checked after | Findings (real/false) | Edits | Proofs | Tests (before -> after) | Cost (after - before) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const tot = { shots: 0, captured: 0, tests: 0, real: 0, false: 0, edits: 0, pp: 0, pt: 0, wall: 0, cpu: 0, timed: 0 };
  // Each row is its own batch: the commands are narrowed to that batch's test files, so rows do not stack and
  // the totals are sums of rows (measure.md says so next to the table).
  for (const r of rows) {
    const c = r.coverage;
    const before = `${c.before}${c.before_note ? ` (${c.before_note})` : ''}`;
    tot.shots += c.shots?.checked ?? 0; tot.captured += c.shots?.captured ?? 0; tot.tests += c.tests?.checked ?? 0;
    const t = r.tests ? `${r.tests.before.total} -> ${r.tests.after.total} (+${r.tests.added})` : '-';
    const p = r.value.proofs ? `${r.value.proofs.passed}/${r.value.proofs.total}` : '-';
    out.push(`| ${r.batch} | ${r.layer} | ${before} | ${coverageCell(c)} | ${v(r.value.real)}/${v(r.value.false)} | ${v(r.value.edits)} | ${p} | ${t} | ${costCell(r)} |`);
    tot.real += r.value.real ?? 0; tot.false += r.value.false ?? 0; tot.edits += r.value.edits ?? 0;
    tot.pp += r.value.proofs?.passed ?? 0; tot.pt += r.value.proofs?.total ?? 0;
    if (r.cost && r.status !== 'void') { tot.wall += r.cost.delta_wall; tot.cpu += r.cost.delta_cpu; tot.timed++; }
  }
  const covered = [tot.captured ? `${tot.shots}/${tot.captured} shots` : '', tot.tests ? `${tot.tests} tests` : ''].filter(Boolean).join('; ') || '-';
  const cost = tot.timed ? `${sec(round(tot.wall))} wall, ${sec(round(tot.cpu))} CPU (${tot.timed} timed row${tot.timed === 1 ? '' : 's'})` : '-';
  out.push(`| **Total** | | 0 | ${covered} | ${tot.real}/${tot.false} | ${tot.edits} | ${tot.pp}/${tot.pt} | | ${cost} |`);
  // One line per void, skipped or indicative row, plus every CI-only step that did not run locally.
  const notes = [];
  for (const r of rows) {
    if (r.reason) notes.push(`- batch ${r.batch} ${r.layer}: ${r.status}: ${r.reason}`);
    for (const s of r.local_na ?? []) notes.push(`- batch ${r.batch} ${r.layer}: local: n/a: ${s} runs only in CI, so its time is not in the row`);
  }
  return out.join('\n') + (notes.length ? `\n\n${notes.join('\n')}` : '');
}

// ---------- main ----------

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'count') return count(parse(rest, ['shots', 'stamp', 'results', 'pw-json', 'asserted', 'locale']));
  if (cmd === 'record') {
    const o = parse(rest, ['batch', 'layer', 'points', 'count', 'added', 'measure', 'log', 'tests-before', 'tests-after', 'no-cost', 'real', 'false', 'edits', 'proofs', 'before-note', 'layer-wall', 'local-na', 'file']);
    const row = record(o);
    const file = o.file ?? FILE;
    // An old schema must be rebuilt before a new row joins it; a batch and layer recorded again replaces its row.
    const rows = existsSync(file) && readFileSync(file, 'utf8').trim() ? readRows(file) : [];
    // In place, so the file keeps batch order.
    const at = rows.findIndex((r) => r.batch === row.batch && r.layer === row.layer);
    if (at < 0) rows.push(row); else rows[at] = row;
    mkdirSync(dirname(file), { recursive: true });
    // Through a temp file and rename, so a crash mid-write never truncates the rows already recorded.
    writeFileSync(`${file}.tmp`, rows.map((r) => JSON.stringify(r) + '\n').join(''));
    renameSync(`${file}.tmp`, file);
    return `recorded batch ${row.batch} ${row.layer}: ${row.status}${row.reason ? ` (${row.reason})` : ''} -> ${file}`;
  }
  if (cmd === 'table') return table(parse(rest, ['file']).file ?? FILE);
  throw usage(cmd ? `unknown command ${cmd}` : 'missing command');
}

try {
  console.log(main(process.argv.slice(2)));
} catch (e) {
  if (e instanceof Exit) { console.error(e.message); process.exit(e.code); }
  console.error(`adopt-metrics: internal error. Next: report this stack with the command you ran\n${e.stack}`);
  process.exit(5);
}
