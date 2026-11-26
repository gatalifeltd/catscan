#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// list-checks v1 (catscan-adopt skill). Lists every check the found catscan can run, from catscan's own finding
// registry (one row per finding kind and rule, with its experimental flag and measured precision) and its own option
// table (which flags each command takes). BIND below is the only hand-kept table: it says which command reports a
// kind, which inputs it needs and which argv turns it on. The list of checks and their numbers always come from catscan.
// Usage: node list-checks.mjs --catscan '<find-catscan command as JSON>' | --core <dir with findings-registry.json and args.js>
// Prints one JSON document; exit 0, or 2 on a usage error. Loads the found catscan's own registry and option modules
// (the same code `catscan doctor` already ran); runs no catscan command; writes nothing.
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const USAGE = "usage: node list-checks.mjs --catscan '<command JSON>' | --core <dir>";
const fail = (msg) => { console.error(`list-checks: ${msg}\n${USAGE}`); process.exit(2); };

// The inputs a check can need, and the flag that passes each one (`null`: no flag, the agent finds it in the project).
const NEEDS = {
  expect: { flag: '--expect', what: 'expected strings per screenshot (an expect file)' },
  catalog: { flag: '--catalog', what: 'the locale catalog (strings file) the screens show' },
  'base-catalog': { flag: '--base', what: 'the base-locale catalog' },
  languages: { flag: '--languages', what: 'the languages the project ships' },
  boxes: { flag: '--boxes', what: 'element sidecars from a UI dump (catscan boxes)' },
  'base-screens': { flag: '--layout', what: 'the base-locale screenshots of the same screens in the same run' },
  device: { flag: '--device-profile', what: 'phone screenshots of a known device (iOS: matched by pixel size; Android: a named profile)' },
  storefront: { flag: '--storefront', what: 'the store region whose currency the screens should show' },
  prices: { flag: '--prices', what: 'the product price file (.storekit, JSON or YAML)' },
  'pseudo-build': { flag: '--pseudo', what: 'screenshots of a pseudo-localized build' },
};

// kind \0 rule -> where it is proposed. `needs`: every item is required; "a|b" means either. `opt_in`: the argv that
// turns it on beyond the command's default run. `command: null` with `reason`: catscan reports it, but no check can
// be wired for it on a screenshot point.
const B = (command, needs = [], opt_in = []) => ({ command, needs, opt_in });
const BIND = {
  'check\0present': B('check', ['expect']),
  'check\0absent': B('check', ['expect']),
  'missing\0-': { command: null, reason: 'a coverage finding: a screen the --layout expectations name has no screenshot (results merge, report); propose it with the report step, not as a check' },
  'raw-key\0-': B('untranslated'),
  'placeholder\0-': B('untranslated'),
  'missing-glyphs\0-': { command: null, reason: 'no catscan command or test matcher reports it yet' },
  'wrong-language\0catalog': B('untranslated', ['catalog']),
  'wrong-language\0langid': B('untranslated', ['languages']),
  'occluded\0elements': B('overlap', ['boxes'], ['--experimental']),
  'currency\0unexpected': B('formats', ['storefront']),
  'currency\0mixed': B('formats'),
  'price\0amount': B('formats', ['prices']),
  'price\0period': B('formats', ['prices']),
  'price\0trial': B('formats', ['prices']),
  'truncated\0ellipsis': B('truncated'),
  'truncated\0prefix': B('truncated', ['catalog|boxes']),
  'truncated\0edge': B('truncated', ['boxes']),
  'truncated\0screen-edge': B('truncated'),
  'truncated\0overflow': B('truncated', ['boxes']),
  'truncated\0pseudo-cut': B('truncated', ['pseudo-build', 'catalog'], ['--pseudo']),
  'overlap\0elements': B('overlap', ['boxes']),
  'overlap\0boxes': B('overlap', [], ['--experimental']),
  'overlap\0stacked': B('overlap'), // on by default: stacked text is not experimental
  'overlap\0sheets': B('overlap', ['boxes']),
  'untranslated\0-': B('untranslated', ['base-catalog', 'catalog']),
  'hardcoded\0base': B('untranslated', ['pseudo-build', 'catalog'], ['--pseudo']),
  'hardcoded\0none': B('untranslated', ['pseudo-build', 'catalog'], ['--pseudo']),
  'uncatalogued\0-': B('untranslated', ['catalog'], ['--uncatalogued', '--experimental']),
  'pseudo-not-applied\0-': B('untranslated', ['pseudo-build', 'catalog'], ['--pseudo']),
  'format\0number': B('formats'),
  'format\0date': B('formats'),
  'format\0time': B('formats', [], ['--rules', 'time']),
  'format\0currency-placement': B('formats', [], ['--rules', 'currency-placement']),
  'fit\0cutout': B('fit', ['device'], ['--experimental']),
  'fit\0corner': B('fit', ['device'], ['--experimental']),
  'fit\0home-indicator': B('fit', ['device'], ['--experimental']),
  'fit\0wrapped': B('fit', ['boxes'], ['--experimental']),
  'fit\0orphan': B('fit', ['boxes'], ['--reasons', 'orphan', '--experimental']),
  'low-contrast\0-': B('contrast', [], ['--experimental']),
  'busy-background\0-': B('contrast', [], ['--experimental']),
};

const args = process.argv.slice(2);
let catscan = null;
let core = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--catscan') {
    try { catscan = JSON.parse(args[++i] ?? ''); } catch { catscan = null; }
    if (!Array.isArray(catscan) || !catscan.length || !catscan.every((x) => typeof x === 'string')) fail('--catscan needs the command array find-catscan printed, as JSON');
  } else if (args[i] === '--core') { core = args[++i]; if (!core) fail('--core needs a directory'); }
  else fail(`unknown argument ${args[i]}`);
}
if (!catscan === !core) fail('give exactly one of --catscan and --core');

const notes = [];
let registry = null;
let cli = null;
let version = null;
let registryId = null;
let defaultRules = null;
const noRegistry = (why) => notes.push({ code: 'no-registry', message: `this catscan's finding registry or option table could not be loaded (${why})`,
  fix: 'propose check, untranslated and truncated only, and tell the developer that a newer catscan lists more checks (fit, overlap, contrast, formats)' });
try {
  // The found catscan's own core-js, resolved from its bin the way find-points loads catalog discovery.
  const req = core ? createRequire(join(resolve(core), 'x.js')) : createRequire(realpathSync(catscan.at(-1)));
  const at = (f) => (core ? join(resolve(core), f) : req.resolve(`@catscan/core-js/src/${f}`));
  registry = JSON.parse(readFileSync(at('findings-registry.json'), 'utf8'));
  cli = req(at('args.js'));
  if (!Array.isArray(registry?.keys) || !Array.isArray(registry?.rows) || !cli?.OPTIONS || !Array.isArray(cli?.COMMANDS)) throw Object.assign(new Error('registry or option table has an unknown shape'), { code: 'shape' });
  try { version = JSON.parse(readFileSync(at('../package.json'), 'utf8')).version ?? null; } catch { version = null; }
  // The id results files carry as run.registry, so a plan can be matched to the catscan that made it.
  try { registryId = req(at('scale.js')).registryId(); } catch { registryId = null; }
  // `--rules` replaces the default rule list, so a --rules opt-in is written as the defaults plus it.
  // formats.js needs catscan's npm dependencies (yaml); a checkout before `npm ci` has none, so the list is read from
  // the source line when the module does not load.
  try { defaultRules = req(at('formats.js')).DEFAULT_RULES ?? null; } catch {
    try {
      const m = readFileSync(at('formats.js'), 'utf8').match(/^const DEFAULT_RULES = \[([^\]]*)\]/m);
      const list = m ? [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]) : [];
      defaultRules = list.length ? list : null;
    } catch { defaultRules = null; }
  }
} catch (e) {
  registry = null;
  noRegistry(e.code ?? e.message);
}

const commands = [];
const unmapped = [];
const notProposable = [];
const missingInCatscan = [];
if (registry) try {
  const keys = new Set(registry.keys.map(([k, r]) => `${k}\0${r}`));
  const row = (k, r, reader) => registry.rows.find((x) => x.kind === k && x.rule === r && x.reader === reader);
  const takes = (cmd, flag) => { const o = cli.OPTIONS[flag]; return Boolean(o) && (o.commands === null || o.commands.includes(cmd)); };
  const groups = new Map();
  for (const [kind, rule] of registry.keys) {
    const key = `${kind}\0${rule}`;
    const b = BIND[key];
    if (!b) { unmapped.push({ kind, rule, fix: 'this catscan has a check this skill version cannot place: update the catscan plugin, then rerun' }); continue; }
    if (b.command === null) { notProposable.push({ kind, rule, reason: b.reason }); continue; }
    const flags = [...b.opt_in.filter((a) => a.startsWith('--')), ...b.needs.flatMap((n) => n.split('|')).map((n) => NEEDS[n].flag)];
    const bad = [!cli.COMMANDS.includes(b.command) && `command ${b.command}`, ...flags.filter((f) => !takes(b.command, f)).map((f) => `${b.command} ${f}`)].filter(Boolean);
    if (bad.length) { missingInCatscan.push({ kind, rule, command: b.command, missing: bad, fix: `upgrade catscan to propose ${b.command} ${kind}${rule === '-' ? '' : ` ${rule}`}` }); continue; }
    const v = row(kind, rule, 'vision');
    const num = (m) => (m ? { precision: m.precision ?? null, flags: m.flags ?? null, source: m.source ?? null } : null);
    let optIn = b.opt_in;
    if (optIn[0] === '--rules') {
      if (Array.isArray(defaultRules)) optIn = ['--rules', [...new Set([...defaultRules, ...optIn[1].split(',')])].join(','), ...optIn.slice(2)];
      else if (!notes.some((n) => n.code === 'rules-not-merged')) notes.push({ code: 'rules-not-merged', message: 'this catscan does not list its default formats rules, so a --rules opt-in is printed alone', fix: '--rules replaces the default list: write the default rules (catscan formats --help) plus the opt-in rule' });
    }
    const gk = `${b.command}\0${optIn.join(' ')}`;
    const g = groups.get(gk) ?? { command: b.command, opt_in: optIn, experimental: false, checks: [] };
    // A key with no Vision row, or an opt-in that names --experimental, counts as experimental: never default-on.
    const exp = !v || Boolean(v.experimental) || optIn.includes('--experimental');
    g.checks.push({ kind, rule, experimental: exp, needs: b.needs, precision: { synthetic: num(v?.synthetic), real: num(v?.real) } });
    g.experimental = g.experimental || exp;
    groups.set(gk, g);
  }
  for (const k of Object.keys(BIND)) {
    // A kind no check can be wired for is never worth an upgrade.
    if (keys.has(k) || BIND[k].command === null) continue;
    const [kind, rule] = k.split('\0');
    missingInCatscan.push({ kind, rule, command: BIND[k].command, missing: ['registry key'], fix: `upgrade catscan to propose ${BIND[k].command} ${kind}${rule === '-' ? '' : ` ${rule}`}` });
  }
  commands.push(...[...groups.values()].sort((a, b) => a.command.localeCompare(b.command) || a.opt_in.length - b.opt_in.length || a.opt_in.join(' ').localeCompare(b.opt_in.join(' '))));
} catch (e) {
  // A registry entry of an unexpected shape degrades like a missing registry: one JSON document, never a stack trace.
  commands.length = 0; unmapped.length = 0; notProposable.length = 0; missingInCatscan.length = 0;
  noRegistry(e.message);
}

console.log(JSON.stringify({ schema: 1, catscan: version, registry: registryId, needs: NEEDS, commands,
  unmapped, not_proposable: notProposable, missing_in_catscan: missingInCatscan, notes }));
