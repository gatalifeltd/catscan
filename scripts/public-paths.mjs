#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// The one owner of the public-paths.txt allowlist semantics (spec 25 D1, D16): which lab files land in the
// product repo and where. check-private.mjs and land-public.sh both read the land plan from here.
// Usage: node scripts/public-paths.mjs [--root DIR] [--ref REF]   prints "<lab path>\t<product path>" lines
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OVERLAY = 'public/';
export const ALLOWLIST = 'scripts/public-paths.txt';
// Spec 25 D1: these never land, whatever the allowlist says.
const NEVER = [/^docs\/specs\//, /^ROADMAP\.md$/, /^TODOS\.md$/, /^docs\/todos\//, /^docs\/product\//,
  /^docs\/spike\//, /^AGENTS\.md$/, /^CLAUDE\.md$/, /^\.github\//, /^scripts\/public-paths\.txt$/, /^datasets\//];
// Lab-only tools inside a landing folder (a `lab/` folder anywhere under bench/): a directory entry skips them
// instead of failing the plan.
const LAB_ONLY = [/^bench\/(?:.+\/)?lab\//];

export function parseAllowlist(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((entry) => {
    if (entry.startsWith('/') || entry.split('/').includes('..')) throw new Error(`public-paths.txt: bad entry ${entry}`);
    const dir = entry.endsWith('/');
    const body = entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return { entry, re: new RegExp(dir ? `^${body}` : `^${body}$`) };
  });
}

// files: every tracked path at the ref. Returns [{ src, dest }] or throws on a refused or colliding path.
export function landPlan(allow, files) {
  const plan = [];
  const errors = [];
  for (const f of files) {
    if (f.startsWith(OVERLAY)) plan.push({ src: f, dest: f.slice(OVERLAY.length) });
    else if (LAB_ONLY.some((re) => re.test(f))) continue;
    else if (allow.some((a) => a.re.test(f))) plan.push({ src: f, dest: f });
  }
  const seen = new Map();
  for (const p of plan) {
    if (NEVER.some((re) => re.test(p.src)) && !p.src.startsWith(OVERLAY)) errors.push(`never-public: ${p.src} matches the allowlist but must never land`);
    if (p.src.startsWith(OVERLAY) && /^(AGENTS|CLAUDE)\.md$|^docs\/(specs|todos|product|spike)\//.test(p.dest)) errors.push(`never-public: ${p.src}`);
    if (seen.has(p.dest)) errors.push(`overlay-collision: ${p.src} and ${seen.get(p.dest)} both land at ${p.dest}`);
    seen.set(p.dest, p.src);
  }
  for (const a of allow) if (!files.some((f) => a.re.test(f))) errors.push(`stale-entry: public-paths.txt entry ${a.entry} matches no tracked file`);
  if (errors.length) throw new Error(errors.join('\n'));
  return plan.sort((a, b) => (a.dest < b.dest ? -1 : 1));
}

export function trackedFiles(root, ref) {
  const args = ref ? ['ls-tree', '-r', '--name-only', '-z', ref] : ['ls-files', '-z'];
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
}

export function readAllowlist(root, ref) {
  const text = ref
    ? execFileSync('git', ['show', `${ref}:${ALLOWLIST}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(join(root, ALLOWLIST), 'utf8');
  return parseAllowlist(text);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const root = arg('--root') ?? process.cwd();
  const ref = arg('--ref');
  try {
    for (const p of landPlan(readAllowlist(root, ref), trackedFiles(root, ref))) process.stdout.write(`${p.src}\t${p.dest}\n`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
