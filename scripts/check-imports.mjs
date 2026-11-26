#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Every relative import in a tree resolves to a file in that tree. land-public runs it on the export, so a landed
// file that imports a lab-only path stops the land instead of failing the product repo's CI with
// ERR_MODULE_NOT_FOUND (1.0.0 landed bench/devices/android-profiles.mjs without scripts/e2e-maestro-emulator.mjs).
// Usage: node scripts/check-imports.mjs [--root DIR] [--lab DIR]   (exit 1 and one line per unresolved import)
// --lab: an import that resolves in the lab but not here did not land. One missing from both trees is reported too,
// except in test files and fixtures, whose code samples import on purpose a file nobody has.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', '.build', 'dist', 'test-results', 'playwright-report']);
const SOURCE = /\.(?:m?js|cjs|mts|ts)$/;
// Static `import ... from '…'`, `export ... from '…'`, bare `import '…'`, `import('…')` and `require('…')` with a
// literal relative specifier. Not checked: computed or template-literal specifiers, `new URL('./x', import.meta.url)`
// and data files read by path.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'])(\.{1,2}\/[^"'\n]+)\2/gm;
// Test files and fixtures hold code samples whose imports point at files nobody has on purpose.
const SAMPLE = /(?:^|\/)(?:fixtures?|__fixtures__)\/|\.(?:test|spec)\.[cm]?[jt]s$/;

export function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(root, p, out);
    else if (SOURCE.test(name)) out.push(relative(root, p));
  }
  return out;
}

const isFile = (p) => existsSync(p) && statSync(p).isFile();

// Resolution as the importer's runtime does it, so the check never accepts an import Node cannot load: an ESM .js or
// .mjs file needs the exact file; CommonJS require() may drop the extension or name a directory; a TypeScript source
// imports its siblings as .js and is compiled, so .ts stands in for .js and an extensionless path is allowed there.
function resolves(target, importer, viaRequire) {
  if (isFile(target)) return true;
  if (/\.m?ts$/.test(importer)) {
    return [target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}.js`, join(target, 'index.ts'), join(target, 'index.js')].some(isFile);
  }
  if (viaRequire || /\.cjs$/.test(importer)) return [`${target}.js`, `${target}.cjs`, `${target}.json`, join(target, 'index.js')].some(isFile);
  return false;
}

export function unresolvedImports(root, lab) {
  const problems = [];
  for (const file of walk(root).sort()) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[3].replace(/[?#].*$/, '');
      const viaRequire = m[1].startsWith('require');
      if (resolves(join(root, dirname(file), spec), file, viaRequire)) continue;
      if (!lab) { problems.push(`${file}: imports ${m[3]}, which is not in this tree`); continue; }
      if (resolves(join(lab, dirname(file), spec), file, viaRequire)) {
        problems.push(`${file}: imports ${m[3]}, which is not in this tree (it exists in the lab: land it or stop landing the importer)`);
      } else if (!SAMPLE.test(file)) {
        problems.push(`${file}: imports ${m[3]}, which is in neither tree (a deleted or renamed dependency?)`);
      }
    }
  }
  return problems;
}

// Compared by real path: a gate that silently skipped its body under a symlinked or space-containing path would pass.
const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] ?? '' : undefined; };
  const root = arg('--root') ?? process.cwd();
  const lab = arg('--lab');
  if (!root || !existsSync(root) || lab === '' || (lab && !existsSync(lab))) {
    console.error('check-imports: usage: node scripts/check-imports.mjs [--root DIR] [--lab DIR]');
    process.exit(2);
  }
  const problems = unresolvedImports(root, lab);
  for (const p of problems) console.error(`check-imports: ${p}`);
  if (problems.length) process.exit(1);
  console.log(`check-imports: ok (${walk(root).length} source files)`);
}
