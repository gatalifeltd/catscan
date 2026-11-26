#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-027: fail on any high or critical npm advisory in the shipped (non-dev) dependencies of any git-tracked
// package-lock.json (D1, D10), and on a critical one in dev dependencies (D11); a dev-only high one prints a warning.
// Every lockfile is audited even after a failure (D7); a registry error, a timeout or a report without metadata fails
// closed as audit-unavailable (D5, D8).
// Usage: node scripts/check-audit.mjs   (no arguments; CATSCAN_AUDIT_TIMEOUT_MS overrides the 120 s npm deadline)
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const USAGE = 'usage: node scripts/check-audit.mjs   (no arguments; audits every tracked package-lock.json)';
const BLOCKING = new Set(['high', 'critical']);

if (process.argv.length > 2) {
  console.error(`check-audit: usage: unexpected argument ${process.argv[2]}\n${USAGE}`);
  process.exit(2);
}

const rawTimeout = process.env.CATSCAN_AUDIT_TIMEOUT_MS;
const timeout = rawTimeout ? Number(rawTimeout) : 120_000;
if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2 ** 31 - 1) {
  console.error(`check-audit: usage: CATSCAN_AUDIT_TIMEOUT_MS must be a positive integer of milliseconds, got ${rawTimeout}\n${USAGE}`);
  process.exit(2);
}
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const dirs = execFileSync('git', ['ls-files', '-z', '--', '*package-lock.json'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter((f) => f === 'package-lock.json' || f.endsWith('/package-lock.json')).map(dirname).sort();
if (dirs.length === 0) {
  console.error('check-audit: audit-unavailable no tracked package-lock.json in this repo\n  fix: run the check from the catscan checkout');
  process.exit(1);
}

let npmVersion;
const npmVer = () => (npmVersion ??= spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 10_000 }).stdout?.trim() || 'unknown');
// TODO-066 D9, D10: the retry is the same command that was interrupted; offline, an install without the audit is only
// safe for a lockfile CI already passed.
const UNAVAILABLE_FIX = '  fix: rerun once the npm registry answers (locally `npm run setup`, in CI rerun the job); nothing was changed. ' +
  'Offline, `npm ci --ignore-scripts` installs without the audit, only for a lockfile already green in CI';
const lockOf = (dir) => (dir === '.' ? 'package-lock.json' : `${dir}/package-lock.json`);

// D10: the gate audits what ships (--omit=dev); a second pass with dev deps only warns. Explicit flags and a cleared
// npm_config_include/omit (and the legacy also/dev/only/production aliases npm still honors): an inherited npm setting
// must not widen or narrow either pass.
const SCOPES = {
  shipped: ['--omit=dev', '--include=optional', '--include=peer'],
  all: ['--include=dev', '--include=optional', '--include=peer'],
};
const npmEnv = { ...process.env };
for (const k of Object.keys(npmEnv)) if (/^npm_config_(include|omit|production|also|dev|only)$/i.test(k)) delete npmEnv[k];

function audit(dir, scope) {
  const r = spawnSync('npm', ['audit', '--json', '--audit-level=high', ...SCOPES[scope]], {
    cwd: join(root, dir), encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: npmEnv,
  });
  if (r.error) {
    const why = r.error.code === 'ETIMEDOUT' ? `npm audit did not finish within ${timeout / 1000} s` : `cannot run npm: ${r.error.message}`;
    return { unavailable: why };
  }
  let report;
  try { report = JSON.parse(r.stdout); } catch { report = null; }
  const counts = report?.metadata?.vulnerabilities;
  if (!counts) {
    const lastLine = (s) => s.trim().split('\n').filter(Boolean).pop();
    const msg = report?.message || lastLine(r.stderr) || lastLine(r.stdout)?.slice(0, 300) || `npm exited ${r.status} with no report`;
    return { unavailable: msg };
  }
  const blocking = Object.values(report.vulnerabilities ?? {}).filter((v) => BLOCKING.has(v.severity));
  const n = (counts.high ?? 0) + (counts.critical ?? 0);
  if (n > 0 || blocking.length > 0) return { counts, blocking };
  if (r.status !== 0) return { unavailable: `npm exited ${r.status} without a high or critical advisory` };
  return { counts, total: report.metadata.dependencies?.total, dev: report.metadata.dependencies?.dev };
}

const advisoriesOf = (v) => (v.via ?? []).filter((x) => typeof x === 'object' && BLOCKING.has(x.severity)).map((x) => x.url ?? x.title ?? `advisory ${x.source}`);
const findingLine = (v) => {
  const advisories = advisoriesOf(v);
  const via = (v.via ?? []).filter((x) => typeof x === 'string');
  return `  ${v.name} (${v.severity}, ${v.range}): ${advisories.length ? advisories.join(' ') : `via ${via.join(', ')}`}`;
};

const failed = [];
for (const dir of dirs) {
  const lock = lockOf(dir);
  const r = audit(dir, 'shipped');
  if (r.unavailable) {
    failed.push(lock);
    console.error(`check-audit: audit-unavailable ${lock}: ${r.unavailable} (npm ${npmVer()})`);
    console.error(UNAVAILABLE_FIX);
  } else if (r.blocking) {
    failed.push(lock);
    console.error(`check-audit: audit-high ${lock}: ${r.counts.high ?? 0} high, ${r.counts.critical ?? 0} critical`);
    const roots = [];
    for (const v of r.blocking) {
      if (advisoriesOf(v).length) roots.push(v.name);
      console.error(findingLine(v));
    }
    const pkgs = roots.length ? roots : r.blocking.map((v) => v.name);
    const where = dir === '.' ? 'the repo root' : dir;
    // TODO-066 D10: lockfile-only commands, so the fix runs no install script and needs no node_modules before the re-audit.
    console.error(`  fix: in ${where}, run \`npm ls --package-lock-only ${pkgs.join(' ')}\` to find the owner, raise it to its latest stable version ` +
      `(or add an "overrides" entry for ${pkgs.join(', ')} in ${dir === '.' ? '' : `${dir}/`}package.json), run \`npm install --package-lock-only --ignore-scripts\` there, ` +
      `commit package.json and package-lock.json, then rerun \`node scripts/check-audit.mjs\``);
  }
  if (r.unavailable) continue;
  // D11: the dev pass runs (and prints) even when the gate already failed this lockfile, which is then listed once;
  // the ok line waits for it, so a lockfile the dev pass fails is never reported ok.
  if (!devPass(dir, lock, r.blocking?.map((v) => v.name) ?? [])) {
    if (!failed.includes(lock)) failed.push(lock);
  } else if (!r.blocking) {
    console.log(`check-audit: ${lock} ok (${r.total ?? '?'} dependencies, ${r.dev ?? '?'} of them dev-only, gated on critical only, 0 high, 0 critical)`);
  }
}

// D10, D11: dev-only advisories (test runners, build tools) reach no user, so a high one only warns. A critical one
// (malware advisories are critical) fails: dev code runs on the owner's Mac and the runner. Because the dev pass can
// fail the check, an unavailable dev pass fails closed like the gate (D5). Returns false when the lockfile fails.
function devPass(dir, lock, shippedNames) {
  const d = audit(dir, 'all');
  if (d.unavailable) {
    console.error(`check-audit: audit-unavailable ${lock} (dev dependencies): ${d.unavailable} (npm ${npmVer()})`);
    console.error(UNAVAILABLE_FIX);
    return false;
  }
  const devOnly = (d.blocking ?? []).filter((v) => !shippedNames.includes(v.name));
  if (!devOnly.length) return true;
  const where = dir === '.' ? 'the repo root' : dir;
  // Only the packages that carry an advisory; the ones that merely depend on them would bury it (37 lines for picomatch).
  const list = (vs) => { const roots = vs.filter((v) => advisoriesOf(v).length); for (const v of roots.length ? roots : vs) console.error(findingLine(v)); };
  const critical = devOnly.filter((v) => v.severity === 'critical');
  if (critical.length) {
    console.error(`check-audit: audit-critical-dev ${lock}: ${critical.length} dev package(s) affected by a critical advisory (malware included); dev code runs on this machine`);
    list(critical);
    console.error(`  fix: in ${where}, remove or replace the dev dependency that pulls it (\`npm ls --package-lock-only <pkg>\`), or raise it to a patched version (\`npm install --package-lock-only --ignore-scripts\`), then rerun \`node scripts/check-audit.mjs\``);
  }
  const high = devOnly.filter((v) => v.severity !== 'critical');
  if (high.length) {
    console.error(`check-audit: warning dev-only ${lock}: ${high.length} dev package(s) affected by a high advisory; ships to no user, does not fail the check`);
    list(high);
    console.error(`  fix (when a patched version exists): raise the owning dev dependency in ${where}`);
  }
  return critical.length === 0;
}
if (failed.length) {
  console.error(`check-audit: FAILED ${failed.length} of ${dirs.length} lockfiles: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`check-audit: ok (${dirs.length} lockfiles)`);
