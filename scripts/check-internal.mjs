#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Public text guard (TODO-060): what catscan publishes carries no lab development history. Unlike
// check-private.mjs it prints the matched text, because an internal ref is useless to fix without it (D1).
// Run with --help for the modes, the surfaces and every rule (D16).
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { landPlan, readAllowlist, trackedFiles } from './public-paths.mjs';

// TODO-107 D4: the lab and product repo names live in a lab-only file that never lands; without it (the public tree)
// the other rules still run, and every land is checked by the lab copy, which has it.
const LAB_NAMES_FILE = new URL('./lab/internal-names.mjs', import.meta.url);
// A lab checkout (it has the land allowlist) without the file fails here instead of silently dropping the rule.
if (!existsSync(LAB_NAMES_FILE) && existsSync(new URL('./public-paths.txt', import.meta.url))) {
  throw new Error('check-internal: scripts/lab/internal-names.mjs is missing in a lab checkout; restore it');
}
const { LAB_NAMES } = existsSync(LAB_NAMES_FILE) ? await import(LAB_NAMES_FILE.href) : { LAB_NAMES: [] };

// D7: set in the release commit that lands first (docs/public-release.md). null: a real land refuses, and a dry run
// and this check use the checked tree's VERSION, so only the version being shipped counts as public (D19).
export const FIRST_PUBLIC_VERSION = '1.0.0';

// D2: every landed path (as it lands in the product repo) is reader-facing, runtime or source; first match wins.
// A path that matches none is a refusal, so a new public folder cannot slip past.
export const SURFACES = [
  ['reader-facing', ['README.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SECURITY.md',
    'TRADEMARKS.md', 'docs/**', 'examples/**', 'plugins/**', '.claude-plugin/**', '.github/**', 'core/schema/**',
    'bench/**/*.md', 'packages/core-js/src/report/page.js', 'packages/core-js/src/report/page.css',
    'packages/core-js/src/report/overlay.js', 'packages/playwright/index.d.ts', 'packages/*/package.json',
    'packages/*/README.md']],
  // The checker's own rule literals spell what they match; its messages are kept clean by hand.
  ['source', ['scripts/check-internal.mjs']],
  ['runtime', ['packages/*/src/**', 'packages/*/bin/**', 'bin/**', 'core/Sources/**', 'bench/languages/table.js',
    'scripts/*.mjs', 'scripts/*.sh']],
  ['source', ['LICENSE', 'NOTICE', 'VERSION', 'package.json', 'package-lock.json', 'playwright.config.js',
    '.gitignore', 'packages/**', 'core/**', 'bench/**', 'test/**', 'results/**', 'scripts/**']],
];

const VER = String.raw`v?(\d+\.\d+\.\d+)`;
// Each pattern is global; `ver` marks a pattern whose group 1 is a catscan version, history only when older
// than the first public version.
export const RULES = {
  'internal-ref': {
    hint: 'say the behavior; the decision stays in the lab spec',
    res: [/TODO-\d{3}/gi, /\b[Ss]pecs? \d{2}\b/g, /\b[Ss]pec D\d+/g, /(?<![#\w])D\d{1,3}\b/g, /ROADMAP (?:item|row) \d+/g],
  },
  'internal-history': {
    hint: 'drop it, or state the compatibility fact without versions from before the first public release',
    res: [{ re: new RegExp(String.raw`\bcatscan ${VER}\b`, 'g'), ver: true },
      { re: new RegExp(String.raw`\breleased as ${VER}\b`, 'g'), ver: true },
      { re: new RegExp(String.raw`\b(?:before|since|until|as of|from|in) ${VER}\b`, 'g'), ver: true },
      /\bwas (?:named|called) [`"']/g, /\brenamed from\b/g, /\bformerly\b/g],
  },
  'internal-narration': {
    hint: 'rewrite for the user',
    res: [/\bowner decision/gi, /\bthe owner's (?:self-hosted )?(?:game|games|Mac|machine|runner|guide|build)\b/g,
      /\b(?:eng|devex|DX) review\b/gi, /\breview pass\b/g, /\boutside voice\b/gi, /\bthis session\b/g],
  },
  'internal-lab-path': {
    hint: 'point to a landed file or drop it',
    res: [/docs\/(?:todos|specs|spike|product)\//g, /docs\/(?:STATUS|INDEX)\.md/g, /\bROADMAP\.md\b/g, /\bTODOS\.md\b/g,
      /(?<![~\w])\.claude\/(?!skills\/|settings|commands\/|agents\/|worktrees\/)/g, /\.\.\/todos\//g, /\.\.\/specs\//g,
      ...LAB_NAMES],
  },
  'internal-commit': {
    hint: 'name the script and results file instead',
    res: [/\bcommit [0-9a-f]{7,40}\b/g],
  },
  'internal-tool': {
    hint: 'drop it',
    res: [/\bgstack\b/g, /\/plan-(?:eng|devex|ceo)-review/g, /(?<![\w/.:-])\/ship\b/g, /\bBugbot\b/g, /\bCapy\b/g],
  },
};
// Blocking on every surface, comments included (D3), except in the land tooling under scripts/ and the package
// tests, whose code names the lab paths it refuses, checks or reads in the lab only, as data (D17).
const EVERYWHERE = 'internal-lab-path';
const LAB_PATH_DATA = /^(?:scripts\/|packages\/[^/]+\/test\/)/;

const glob = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000')
  .replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*')}$`);
const SURFACE_RES = SURFACES.map(([name, globs]) => [name, globs.map(glob)]);
export function surfaceOf(path) {
  for (const [name, res] of SURFACE_RES) if (res.some((re) => re.test(path))) return name;
  return null;
}

const cmpVer = (a, b) => {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// first: the first public version, or null (every version is lab history).
export function findInLine(text, first) {
  const out = [];
  for (const [rule, { res }] of Object.entries(RULES)) {
    for (const r of res) {
      const re = r.re ?? r;
      for (const m of text.matchAll(re)) {
        if (r.ver && first && cmpVer(m[1], first) >= 0) continue;
        out.push({ rule, match: m[0] });
      }
    }
  }
  return out;
}

// D12: line-based comment detection for JS and Swift; a trailing comment starts at " //" (so https:// is code).
// Shell (`shell`): a line starting with "#", or a " #" outside quotes. A heredoc line that starts with "#" counts
// as a comment: a known limit of the line-based split.
export function splitComment(line, shell = false) {
  const t = line.trimStart();
  if (shell ? t.startsWith('#') : /^(?:\/\/|\*|\/\*)/.test(t)) return { code: '', comment: line };
  if (shell) {
    let quote = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      // A backslash escapes the next character outside quotes and inside double quotes; single quotes have no escapes.
      if (quote === '"') { if (c === '\\') i++; else if (c === '"') quote = ''; }
      else if (quote) { if (c === quote) quote = ''; }
      else if (c === "\\") i++;
      else if (c === '"' || c === "'") quote = c;
      else if (c === "#" && i > 0 && /\s/.test(line[i - 1])) return { code: line.slice(0, i - 1), comment: line.slice(i - 1) };
    }
    return { code: line, comment: '' };
  }
  const m = line.match(/\s\/\/(?:\s|$)/);
  return m ? { code: line.slice(0, m.index), comment: line.slice(m.index) } : { code: line, comment: '' };
}

const SECTION = /^## \[(\d+\.\d+\.\d+)\]/;
// D6: the line indices of CHANGELOG.md that land: the sections at or above `first` (only the top one when unset).
export function changelogLines(lines, first) {
  const keep = new Set();
  let on = false;
  let top = true;
  lines.forEach((l, i) => {
    const m = l.match(SECTION);
    if (m) { on = first ? cmpVer(m[1], first) >= 0 : top; top = false; }
    else if (/^## /.test(l)) on = false;
    if (on) keep.add(i);
  });
  return keep;
}

export const CHANGELOG_NOTE = 'All notable changes to catscan, newest first. catscan was developed privately before'
  + ' its first public version; earlier versions are not listed.';
// D6: the product CHANGELOG.md: a title, one note, then only the sections at or above the first public version.
export function publicChangelog(text, first) {
  const lines = text.split('\n');
  const keep = changelogLines(lines, first);
  const body = lines.filter((_, i) => keep.has(i)).join('\n').replace(/\n+$/, '');
  return `# Changelog\n\n${CHANGELOG_NOTE}\n\n${body}\n`;
}

// files: [{ path (as it lands), abs }]. Returns { findings, counts, unclassified }.
export function checkFiles(files, first) {
  const findings = [];
  const counts = {};
  const unclassified = [];
  for (const f of files) {
    const surface = surfaceOf(f.path);
    if (!surface) { unclassified.push(f.path); continue; }
    // A landed file name is reader-facing too (a results file named after a task, say).
    for (const hit of findInLine(f.path, first)) findings.push({ path: f.path, line: 0, ...hit });
    // A symlink lands as a link: its target path is what a reader sees.
    if (lstatSync(f.abs).isSymbolicLink()) {
      for (const hit of findInLine(readlinkSync(f.abs), first)) findings.push({ path: f.path, line: 0, ...hit });
      continue;
    }
    const buf = readFileSync(f.abs);
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf8').split('\n');
    const keep = f.path === 'CHANGELOG.md' ? changelogLines(lines, first) : null;
    lines.forEach((line, i) => {
      if (keep && !keep.has(i)) return;
      const parts = surface === 'reader-facing' ? [[line, true]]
        : surface === 'runtime' ? (({ code, comment }) => [[code, true], [comment, false]])(splitComment(line, f.path.endsWith('.sh')))
          : [[line, false]];
      for (const [text, blocking] of parts) {
        if (!text) continue;
        for (const hit of findInLine(text, first)) {
          const data = hit.rule === EVERYWHERE && LAB_PATH_DATA.test(f.path);
          if (!data && (blocking || hit.rule === EVERYWHERE)) findings.push({ path: f.path, line: i + 1, ...hit });
          else counts[hit.rule] = (counts[hit.rule] ?? 0) + 1;
        }
      }
    });
  }
  return { findings, counts, unclassified };
}

export function help() {
  const lines = [
    'check-internal: reader-facing text carries no internal development history.',
    '',
    'Usage:',
    '  node scripts/check-internal.mjs [--root DIR]               every tracked file under DIR (the published repo)',
    '  node scripts/check-internal.mjs --allowlist [--root DIR]   the lab files public-paths.txt lands (docs:check)',
    '  node scripts/check-internal.mjs --root DIR --list FILE    exactly the paths in FILE (the land plan)',
    '  --first-public X.Y.Z   the first public version (default: FIRST_PUBLIC_VERSION in this file, else VERSION)',
    '  --public-changelog FILE   rewrite FILE to the sections that land (the land runs this)',
    'Exit: 0 clean, 1 findings, 2 usage or unreadable input. Findings and refusals go to stderr.',
    '',
    'Surfaces (by landed path, first match wins):',
    ...SURFACES.map(([name, globs]) => `  ${name}: ${globs.join(' ')}`),
    '  reader-facing: every line and the file name block. runtime: code blocks, comments are counted only.',
    `  source: counted only. ${EVERYWHERE} blocks on every surface but scripts/ and packages/*/test/.`,
    '  CHANGELOG.md: only the sections that land are checked.',
    '',
    'Rules:',
    ...Object.entries(RULES).flatMap(([id, { hint, res }]) => [`  ${id} - ${hint}`,
      ...res.map((r) => `      ${(r.re ?? r).source}${r.ver ? '   (version older than the first public one)' : ''}`)]),
  ];
  return `${lines.join('\n')}\n`;
}

function usage(msg) {
  const e = new Error(msg);
  e.usage = true;
  return e;
}

export function main(argv, log = console) {
  if (argv.includes('--help') || argv.includes('-h')) { log.log(help().trimEnd()); return 0; }
  const known = new Set(['--root', '--list', '--first-public', '--public-changelog']);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  for (let i = 0; i < argv.length; i++) {
    if (known.has(argv[i])) { if (argv[i + 1] === undefined) { log.error(`check-internal: ${argv[i]} needs a value; see --help`); return 2; } i++; }
    else if (argv[i] !== '--allowlist') { log.error(`check-internal: unknown argument ${argv[i]}; see --help`); return 2; }
  }
  let first = arg('--first-public') ?? FIRST_PUBLIC_VERSION;
  if (first && !/^\d+\.\d+\.\d+$/.test(first)) { log.error(`check-internal: --first-public ${first} is not X.Y.Z`); return 2; }
  if (arg('--public-changelog')) {
    if (!first) { log.error('check-internal: --public-changelog needs --first-public X.Y.Z'); return 2; }
    const file = arg('--public-changelog');
    // Never write through a link: a CHANGELOG.md symlink would overwrite its target.
    try { if (lstatSync(file).isSymbolicLink()) { log.error(`check-internal: ${file} is a symlink; CHANGELOG.md must be a regular file`); return 2; } } catch { /* the rewrite reports it */ }
    try { writeFileSync(file, publicChangelog(readFileSync(file, 'utf8'), first)); } catch (e) {
      log.error(`check-internal: cannot rewrite ${file} (${e.code ?? e.message}); fix the file or its permissions and rerun`);
      return 2;
    }
    return 0;
  }
  let root;
  let files;
  try {
    root = arg('--root') ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    if (arg('--list')) {
      const paths = readFileSync(arg('--list'), 'utf8').split('\n').filter(Boolean);
      if (!paths.length) { log.error(`check-internal: --list ${arg('--list')} is empty`); return 2; }
      files = paths.map((p) => ({ path: p, abs: join(root, p) }));
    } else if (argv.includes('--allowlist')) {
      files = landPlan(readAllowlist(root), trackedFiles(root)).map((p) => ({ path: p.dest, abs: join(root, p.src) }));
    } else if (existsSync(join(root, '.git'))) {
      files = trackedFiles(root).map((p) => ({ path: p, abs: join(root, p) }));
    } else throw usage(`${root} is not a git checkout; pass --list FILE or --allowlist`);
    if (!first && existsSync(join(root, 'VERSION'))) first = /^\d+\.\d+\.\d+$/.exec(readFileSync(join(root, 'VERSION'), 'utf8').trim())?.[0] ?? null;
  } catch (e) {
    log.error(`check-internal: ${e.usage ? e.message : `cannot list files (${e.message.split('\n')[0]})`}`);
    return 2;
  }
  // A missing file is a refusal; a symlink is checked by its name and target (checkFiles).
  for (const f of files) {
    try { lstatSync(f.abs); } catch (e) {
      log.error(`check-internal: cannot read ${f.path} (${e.code}); fix the file or its permissions and rerun`);
      return 2;
    }
  }
  let result;
  try {
    result = checkFiles(files, first);
  } catch (e) {
    const p = e.path ? files.find((f) => f.abs === e.path)?.path ?? e.path : '?';
    log.error(`check-internal: cannot read ${p} (${e.code ?? e.message}); fix the file or its permissions and rerun`);
    return 2;
  }
  const { findings, counts, unclassified } = result;
  if (unclassified.length) {
    for (const p of unclassified) {
      log.error(`check-internal: ${p} has no surface; add it to SURFACES in scripts/check-internal.mjs (reader-facing, runtime or source)`);
    }
    return 2;
  }
  for (const f of findings) log.error(`check-internal: ${f.path}:${f.line} ${f.rule} "${f.match}" - ${RULES[f.rule].hint}`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const tally = total ? `${total} refs, report-only: ${Object.entries(counts).map(([r, n]) => `${r} ${n}`).join(', ')}` : 'none';
  if (findings.length) {
    log.error(`check-internal: ${findings.length} finding${findings.length === 1 ? '' : 's'} in reader-facing files (source comments: ${tally})`);
    log.error('fix in the lab, then rerun: npm run docs:check (a false positive: narrow the rule in scripts/check-internal.mjs with a test)');
    return 1;
  }
  log.log(`check-internal: ok (${files.length} files; source comments: ${tally})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
