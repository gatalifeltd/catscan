#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// behavior-range v1 (catscan-upgrade skill). Node built-ins, npm and tar; writes only to a temp folder outside
// the project (and to --save). Packs @catscan/core-js at the version that holds the range (`npm pack` runs from
// the current folder, so run it from the project to use its npm registry config), reads its behavior-changes.json
// and lists every behavior change between two versions: an upgrade lists (from, to]; a downgrade lists (to, from]
// as `undone`, read from the newer version's file.
// Usage: node behavior-range.mjs --from X.Y.Z --to X.Y.Z [--surfaces <find-surfaces.json>] [--registry URL] [--save FILE]
// With --surfaces, each change names the project's catscan commands its text mentions and whether every one of
// those invocations already opts out (`opted_out`: true, false or "partial"; null when it cannot tell), with the
// invocations it still hits. --save writes the packed behavior-changes.json for finding-delta --changes.
// Prints one JSON document (schema 1). Exit 0; 2 on a usage or input error (pack failed, unknown version),
// with `behavior-range: <code>: <message> - try: <fix>` on stderr.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ME = 'behavior-range';
const SEMVER = /^\d+\.\d+\.\d+$/;
class InputError extends Error { constructor(code, message, fix) { super(message); this.code = code; this.fix = fix; } }

export const cmp = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** behavior-changes.json of @catscan/core-js@version, packed into a temp folder that is removed afterwards. */
export function packChanges(version, { registry = null, run = spawnSync } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'catscan-upgrade-'));
  try {
    const args = ['pack', `@catscan/core-js@${version}`, '--pack-destination', dir, '--json', ...(registry ? ['--registry', registry] : [])];
    // From the current folder, so the project's .npmrc (registry, scope mapping) applies; the tarball goes to dir.
    const p = run('npm', args, { cwd: process.cwd(), encoding: 'utf8', timeout: 120000 });
    if (p.status !== 0) {
      const why = (p.stderr || p.error?.message || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
      throw new InputError('pack-failed', `npm pack @catscan/core-js@${version} failed: ${why || `exit ${p.status}`}`,
        'check the version exists (npm view @catscan/cli versions), name another with --to, or retry online; nothing was changed');
    }
    let file;
    try { file = JSON.parse(p.stdout)[0].filename; } catch { file = null; }
    const tgz = file && join(dir, file);
    if (!tgz || !existsSync(tgz)) throw new InputError('pack-failed', `npm pack printed no tarball for @catscan/core-js@${version}`, 'retry, or name another version with --to');
    const x = run('tar', ['-xzf', tgz, '-C', dir, 'package/behavior-changes.json'], { encoding: 'utf8' });
    const json = join(dir, 'package', 'behavior-changes.json');
    if (x.status !== 0 || !existsSync(json)) throw new InputError('no-changes-file', `@catscan/core-js@${version} carries no behavior-changes.json`, 'upgrade to a version that ships it, or read its CHANGELOG by hand');
    return JSON.parse(readFileSync(json, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The changes in the range, oldest release first, each with its version. */
export function range(changes, from, to) {
  const [lo, hi] = cmp(from, to) <= 0 ? [from, to] : [to, from];
  return (changes.releases || [])
    .filter((r) => cmp(r.version, lo) > 0 && cmp(r.version, hi) <= 0)
    .sort((a, b) => cmp(a.version, b.version))
    .flatMap((r) => r.changes.map((c) => ({ version: r.version, ...c })));
}

// A flag the opt-out says to leave out ("leave out `--known`", "do not pass `--gpu`", "run without `--text-size`")
// is taken by NOT passing it; any other backticked flag ("list its id in `--allow`") is one to add. Decided per flag
// from the words right before it, since one opt-out can hold both kinds.
const OMIT_BEFORE = /(leave out|do not pass|don't pass|without)\s*$/i;
const RUN_VERBS = /^(check|read|untranslated|video|truncated|overlap|formats|fit|contrast|report|results|doctor|pseudo)$/;

/** Which project commands a change names, and whether each of those invocations already takes its opt-out. */
export function annotate(list, surfaces) {
  const invs = surfaces?.invocations || [];
  // The subcommand, past any runner words (`pnpm dlx`, `npx -p @catscan/cli catscan`).
  const verb = (inv) => inv.argv.find((a, i) => i > 0 && RUN_VERBS.test(a)) ?? null;
  return list.map((c) => {
    const named = [...new Set(invs.map(verb).filter((v) => v && new RegExp(`\\b${v}\\b`).test(c.text)))];
    const hitInvs = invs.filter((inv) => named.includes(verb(inv)));
    const flags = [...c.opt_out.matchAll(/`([^`]+)`/g)]
      .map((m) => ({ flag: m[1].split(/\s+/)[0], omit: OMIT_BEFORE.test(c.opt_out.slice(0, m.index)) }))
      .filter((f) => f.flag.startsWith('-'));
    let optedOut = null;
    let hits = [];
    if (hitInvs.length && c.opt_out.trim() === 'none') { optedOut = false; hits = hitInvs; }
    else if (hitInvs.length && flags.length) {
      // An invocation takes the opt-out when it follows any one of the ways the opt-out offers.
      const takes = (inv) => flags.some(({ flag, omit }) => {
        const uses = inv.argv.some((a) => a === flag || a.startsWith(`${flag}=`));
        return omit ? !uses : uses;
      });
      hits = hitInvs.filter((inv) => !takes(inv));
      optedOut = hits.length === 0 ? true : hits.length === hitInvs.length ? false : 'partial';
    }
    return { ...c, commands_named: named, opted_out: optedOut, hits: hits.map((inv) => ({ file: inv.file ?? null, line: inv.line ?? null })) };
  });
}

export function main(argv, deps = {}) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!['--from', '--to', '--surfaces', '--registry', '--save'].includes(a)) throw new InputError('usage', `unknown argument ${a}`, 'node behavior-range.mjs --from X.Y.Z --to X.Y.Z');
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new InputError('usage', `${a} needs a value`, 'node behavior-range.mjs --from X.Y.Z --to X.Y.Z');
    opt[a.slice(2)] = argv[++i];
  }
  for (const k of ['from', 'to']) {
    if (!opt[k]) throw new InputError('usage', `--${k} is required`, 'node behavior-range.mjs --from <current> --to <target>');
    if (!SEMVER.test(opt[k])) throw new InputError('bad-version', `--${k} ${opt[k]} is not X.Y.Z`, 'name an exact version');
  }
  let surfaces = null;
  if (opt.surfaces) {
    try { surfaces = JSON.parse(readFileSync(opt.surfaces, 'utf8')); } catch (e) { throw new InputError('unreadable', `${opt.surfaces}: ${e.message}`, 'save the find-surfaces output to a file first'); }
  }
  const down = cmp(opt.to, opt.from) < 0;
  const holder = down ? opt.from : opt.to;
  const changes = (deps.pack || packChanges)(holder, { registry: opt.registry ?? null });
  if (opt.save) writeFileSync(opt.save, `${JSON.stringify(changes, null, 2)}\n`);
  const list = annotate(range(changes, opt.from, opt.to), surfaces);
  const byKind = {};
  for (const c of list) (byKind[c.kind] ||= []).push(c.id);
  return { schema: 1, from: opt.from, to: opt.to, direction: down ? 'downgrade' : 'upgrade', read_from: holder, changes: list, by_kind: byKind, ...(down ? { undone: true } : {}) };
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
