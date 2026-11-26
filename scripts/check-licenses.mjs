#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Licenses of shipped npm dependencies (spec 25 Third-party licenses). No dependency of its own.
// Usage: node scripts/check-licenses.mjs [--tree FILE]   (FILE: saved `npm ls --omit=dev --all --json --long`)
// Strict on SPDX expressions: every license ID in the expression must be allowed, OR included.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unicode-3.0']);

export function licenseOf(node) {
  let lic = node.license ?? node.licenses;
  if (!lic && node.path && existsSync(join(node.path, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(node.path, 'package.json'), 'utf8'));
    lic = pkg.license ?? pkg.licenses;
  }
  if (Array.isArray(lic)) lic = lic.map((l) => (typeof l === 'string' ? l : l?.type)).join(' AND ');
  if (lic && typeof lic === 'object') lic = lic.type;
  return typeof lic === 'string' && lic.trim() ? lic.trim() : null;
}

export function isAllowed(expr) {
  if (!expr) return false;
  const ids = expr.replace(/[()]/g, ' ').split(/\s+/).filter((t) => t && !/^(AND|OR|WITH)$/i.test(t));
  return ids.length > 0 && ids.every((id) => ALLOWED.has(id));
}

// tree: `npm ls --json --long` output. Returns [{ name, version, license }] that fail.
export function check(tree) {
  const bad = [];
  const seen = new Set();
  const visit = (deps) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      // An optional peer that is not installed shows up as an empty node: nothing ships.
      if (node.dev || node.extraneous || node.missing || !node.version) continue;
      // npm ls prints a package's children once, often under a later occurrence than the first (a deduped stub
      // has none), so the license is checked once per name@version but every node's children are walked.
      const key = `${name}@${node.version}`;
      if (!seen.has(key)) {
        seen.add(key);
        const license = licenseOf(node);
        if (!isAllowed(license)) bad.push({ name, version: node.version, license: license ?? 'missing' });
      }
      visit(node.dependencies);
    }
  };
  visit(tree.dependencies);
  return { bad, count: seen.size };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--tree');
  const json = i > 0
    ? readFileSync(process.argv[i + 1], 'utf8')
    : execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const { bad, count } = check(JSON.parse(json));
  for (const b of bad) console.error(`${b.name}@${b.version}: license ${b.license} is not allowed in shipped packages`);
  if (bad.length) process.exit(1);
  console.log(`check-licenses: ok (${count} shipped packages, workspaces included)`);
}
