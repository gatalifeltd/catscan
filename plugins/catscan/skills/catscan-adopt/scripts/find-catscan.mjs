#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// find-catscan v1 (catscan-adopt skill). Finds a usable catscan command line. Order: the
// checkout named by --checkout, the project's node_modules/.bin (only with --project: running a repo's own binary
// is opt-in, so a dry run on a repo you do not trust leaves it out), PATH, the checkout in CATSCAN_CHECKOUT, then the
// catscan checkout this skill itself sits in (a plugin installed from a checkout).
// Each candidate must pass `doctor --json` (ok: true); `--version` is no probe, it answers without a binary.
// Never installs or builds anything.
// Usage: node find-catscan.mjs [--checkout DIR] [--project DIR]
// Exit 0: one JSON line {schema, form, from, command, version, skipped}; from is flag, project, path, env or plugin. Exit 1: none usable (same JSON, form null).
// Exit 2: usage error.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node find-catscan.mjs [--checkout DIR] [--project DIR]';
const SETUP = 'https://github.com/gatalifeltd/catscan/blob/main/docs/recipes/catscan-adopt.md';
const fail = (msg) => { console.error(`find-catscan: ${msg}\n${USAGE}`); process.exit(2); };

const args = process.argv.slice(2);
let checkout = null;
let project = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--checkout' || a === '--project') {
    const v = args[++i];
    if (!v || v.startsWith('--')) fail(`${a} needs a directory`);
    if (a === '--checkout') checkout = resolve(v); else project = resolve(v);
  } else fail(`unknown argument ${a}`);
}

const executable = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
const fromCheckout = (dir, form, from) => {
  const bin = join(dir, 'bin/catscan.js');
  return existsSync(bin) ? { form, from, command: [process.execPath, bin] } : { form, from, command: [bin], missing: `no bin/catscan.js in ${dir}` };
};
// The checkout five folders above this script (plugins/catscan/skills/catscan-adopt/scripts), when it is one: an
// installed plugin has no bin/catscan.js there and is left out silently.
const pluginCheckout = () => {
  try {
    const root = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '../../../../..');
    const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
    return name === 'catscan' && existsSync(join(root, 'bin/catscan.js')) ? root : null;
  } catch { return null; }
};
const onPath = () => {
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (d && executable(join(d, 'catscan'))) return join(d, 'catscan');
  }
  return null;
};

const candidates = [];
if (checkout) candidates.push(fromCheckout(checkout, 'checkout', 'flag'));
const local = project && join(project, 'node_modules/.bin/catscan');
if (local && executable(local)) candidates.push({ form: 'local', from: 'project', command: [local] });
const global = onPath();
if (global) candidates.push({ form: 'global', from: 'path', command: [global] });
const env = process.env.CATSCAN_CHECKOUT ? resolve(process.env.CATSCAN_CHECKOUT) : null;
if (env && env !== checkout) candidates.push(fromCheckout(env, 'checkout', 'env'));
const own = pluginCheckout();
if (own && own !== checkout && own !== env) candidates.push(fromCheckout(own, 'checkout', 'plugin'));

const skipped = [];
for (const c of candidates) {
  if (c.missing) { skipped.push({ form: c.form, command: c.command, reason: c.missing }); continue; }
  const r = spawnSync(c.command[0], [...c.command.slice(1), 'doctor', '--json'], { encoding: 'utf8', timeout: 120000 });
  let doc = null;
  try { doc = JSON.parse(r.stdout); } catch { /* reported below */ }
  if (!doc) {
    const why = r.error ? r.error.message : `exit ${r.status}`;
    skipped.push({ form: c.form, command: c.command, reason: `doctor --json printed no JSON (${why})` });
    continue;
  }
  if (doc === null || typeof doc !== 'object' || doc.ok !== true) {
    const bad = Array.isArray(doc?.checks) ? doc.checks.find((k) => k && k.ok === false) : null;
    skipped.push({ form: c.form, command: c.command, reason: bad ? `doctor ${bad.name}: ${bad.value ?? ''}${bad.advice ? ` - try: ${bad.advice}` : ''}` : 'doctor ok: false' });
    continue;
  }
  console.log(JSON.stringify({ schema: 1, form: c.form, from: c.from, command: c.command, version: doc.binary?.version ?? null, skipped }));
  process.exit(0);
}
console.log(JSON.stringify({ schema: 1, form: null, from: null, command: null, version: null, skipped, setup: SETUP }));
console.error(`find-catscan: no usable catscan (${candidates.length ? `${candidates.length} tried` : 'none found'}). Setup: ${SETUP}`);
process.exit(1);
