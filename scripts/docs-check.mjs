#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Docs currency check (AGENTS.md -> Gate). No dependencies; runs on any OS.
//   node scripts/docs-check.mjs                          the lab: em dashes, links, docs index, TODOS, versions,
//                                                        behavior changes
//   node scripts/docs-check.mjs --public [--root DIR]    the product repo or a land export: em dashes and links only,
//                                                        since the index, TODOS and specs never land (spec 25 D20)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { behaviorProblems, versionProblems } from './release-lib.mjs';

const args = process.argv.slice(2);
const PUBLIC = args.includes('--public');
const rootArg = args.includes('--root') ? args[args.indexOf('--root') + 1] : null;
const root = rootArg ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
// A land export has no .git: walk it instead.
const walkMd = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = dir ? `${dir}/${e.name}` : e.name;
  if (e.isDirectory()) return e.name === 'node_modules' || e.name === '.git' ? [] : walkMd(rel);
  return e.name.endsWith('.md') ? [rel] : [];
});
const tracked = (existsSync(join(root, '.git'))
  ? execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n')
  : walkMd('')
).filter((f) => f && existsSync(join(root, f)));
const errors = [];
const read = (f) => readFileSync(join(root, f), 'utf8');

for (const file of tracked) {
  const text = read(file);
  text.split('\n').forEach((line, i) => {
    if (line.includes('—')) errors.push(`${file}:${i + 1}: em dash; use "-"`);
  });
  // Fenced code holds example entries, not real links.
  const prose = text.replace(/```[\s\S]*?```/g, '');
  for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
    const path = normalize(join(dirname(file), decodeURI(target.split('#')[0])));
    if (!existsSync(join(root, path))) errors.push(`${file}: broken link ${target}`);
  }
}

if (PUBLIC) finish();
const index = read('docs/INDEX.md');
for (const file of tracked.filter((f) => f.startsWith('docs/') && f !== 'docs/INDEX.md')) {
  const rel = relative('docs', file);
  if (rel.startsWith('todos/') && rel !== 'todos/TODO-TEMPLATE.md') continue;
  if (!index.includes(`(./${rel})`)) errors.push(`docs/INDEX.md: missing link to ./${rel}`);
}

const todos = read('TODOS.md');
const open = todos.split(/^## Completed/m)[0];
for (const [, id] of open.matchAll(/\*\*(TODO-\d{3})\b/g)) {
  const spec = `docs/todos/${id}.md`;
  if (!existsSync(join(root, spec))) errors.push(`TODOS.md: ${id} has no ${spec}`);
  else if (!open.includes(`(${spec})`)) errors.push(`TODOS.md: ${id} lacks a Details: link`);
}
for (const [, nn] of open.matchAll(/\*\*Spec (\d{2})\b/g)) {
  const spec = tracked.find((f) => f.startsWith(`docs/specs/${nn}-`));
  if (!spec) errors.push(`TODOS.md: Spec ${nn} has no docs/specs/${nn}-*.md`);
  else if (!open.includes(`(${spec})`)) errors.push(`TODOS.md: Spec ${nn} lacks a Details: link`);
  else if (!/^## Test plan \/ coverage/m.test(read(spec))) errors.push(`${spec}: missing "## Test plan / coverage"`);
}
for (const file of tracked.filter((f) => /^docs\/todos\/TODO-\d{3}\.md$/.test(f))) {
  if (!/^## Test plan \/ coverage/m.test(read(file))) errors.push(`${file}: missing "## Test plan / coverage"`);
}

const version = read('VERSION').trim();
const pkg = JSON.parse(read('package.json')).version;
if (version !== pkg) errors.push(`VERSION ${version} != package.json ${pkg}`);
if (!read('CHANGELOG.md').includes(`## [${version}]`)) errors.push(`CHANGELOG.md: no entry for ${version}`);
// TODO-059 D5: the behavior-change bullets follow one grammar, and packages/core-js/behavior-changes.json equals what
// CHANGELOG.md and the code give. Lab only: the land trims both to the public versions.
errors.push(...behaviorProblems(root));
// TODO-094 D3: every version carrier agrees with VERSION, so a missed one fails here, before push. Only in the lab
// (the landing allowlist exists); a fixture root without it has no carriers to check.
if (existsSync(join(root, 'scripts/public-paths.txt'))) errors.push(...versionProblems(root));

finish();

function finish() {
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`docs:check${PUBLIC ? ' --public' : ''} ok (${tracked.length} markdown files)`);
  process.exit(0);
}
