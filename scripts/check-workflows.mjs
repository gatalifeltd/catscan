#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Workflow hardening (spec 25 Workflow hardening, D4, D14, D16). No YAML dependency: the rules need only
// top-level keys, job blocks and step lines, so a line scanner is enough for the repo's own workflows.
// Usage: node scripts/check-workflows.mjs [--product] DIR...
//   lab mode: .github/workflows (self-hosted runners allowed)
//   --product: public/.github/workflows in the lab, .github/workflows in the product repo (self-hosted refused)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLOSE_OUTSIDE = 'close-outside-prs.yml';
const indentOf = (l) => l.length - l.trimStart().length;
const strip = (l) => l.replace(/\s+#.*$/, '');

// Allowlist, not denylist: an expression, a runner group or a custom label can reach a self-hosted runner too.
// Product mode refuses such a job; lab mode treats it as reaching the owner's Mac (TODO-066 D5).
function hostedOnly(block) {
  const labels = block.replace(/^\s*runs-on:/, '').split(/[\s,[\]'"]+/).filter((t) => t && t !== '-');
  const hosted = (l) => /^(ubuntu|macos|windows)-[\w.-]+$/.test(l) && !/self|hosted/i.test(l);
  return !/\$\{\{|group:|labels:/.test(block) && labels.length > 0 && labels.every(hosted);
}

// The product test matrix spans the promised macOS lines: `runs-on: ${{ matrix.<key> }}` resolves to the job's own
// one-line literal list strategy.matrix.<key>: [...]. Fail closed: an `include:` (it can add any label), a computed or
// one-line matrix or any other expression keeps the block unresolved, so hostedOnly refuses it. YAML allows a quoted
// key and space before the colon (`include :`), so the strategy and matrix lookups accept both (outside-voice review).
const keyLine = (k) => new RegExp(`^\\s*(["']?)${k}\\1\\s*:(\\s|$)`);
function resolveMatrix(block, body, keyIndent) {
  const m = block.match(/^\s*runs-on:\s*\$\{\{\s*matrix\.([\w-]+)\s*\}\}\s*$/);
  if (!m) return block;
  const sub = (from, ind, k) => {
    for (let i = from; i < body.length; i++) {
      if (!body[i].trim()) continue;
      if (indentOf(body[i]) < ind) return -1;
      if (indentOf(body[i]) === ind && keyLine(k).test(body[i])) return i;
    }
    return -1;
  };
  const opens = (i) => /:\s*$/.test(body[i]) && body[i + 1] !== undefined && indentOf(body[i + 1]) > indentOf(body[i]);
  const st = sub(0, keyIndent, 'strategy');
  if (st < 0 || !opens(st)) return block;
  const mx = sub(st + 1, indentOf(body[st + 1]), 'matrix');
  if (mx < 0 || !opens(mx)) return block;
  const ind = indentOf(body[mx + 1]);
  const end = body.findIndex((l, i) => i > mx && l.trim() && indentOf(l) < ind);
  const matrix = body.slice(mx + 1, end < 0 ? body.length : end).filter((l) => l.trim());
  // Allowlist, not denylist: YAML has escaped, quoted and anchored spellings of `include`, so every matrix key must be
  // a plain name holding a one-line literal list, and only `exclude:` (it can only remove cells) may nest (Codex pass 2).
  let current = null;
  const lists = {};
  for (const l of matrix) {
    if (indentOf(l) > ind) { if (current !== 'exclude') return block; continue; }
    const kv = l.match(/^\s*([A-Za-z_][\w-]*):(?:\s+(\[[^\]$&*!|>]*\]))?\s*$/);
    if (!kv || kv[1] === 'include' || (kv[1] === 'exclude') === Boolean(kv[2])) return block;
    current = kv[1];
    if (kv[2]) lists[kv[1]] = kv[2];
  }
  return lists[m[1]] ? `runs-on: ${lists[m[1]]}` : block;
}

// TODO-066: no dependency code runs on the owner's Mac before the npm audit gate (D3). Fail closed: every whole-word
// npm or npx token in a run line is a command (an absolute path before it too), whatever precedes it, and every npm
// subcommand outside SAFE counts as one that installs (npm 11 aliases included).
const NPM = /(?<![\w.@/-])(?:[\w.@-]*\/)*(npx|npm)(?=$|[\s;&|)\x60"'])/g;
// Other package managers resolve and run what package-lock.json and its audit never cover.
const OTHER_PM = /(?<![\w.@/-])(?:[\w.@-]*\/)*(pnpm|pnpx|yarn|bun|bunx|corepack)(?=$|[\s;&|)\x60"'])/g;
// The command ends at the next shell separator; 2>&1 and >&2 are redirections, not separators.
const SEGMENT_END = /&&|\|\||;|\|(?!\|)|(?<![>&<])&(?![&>])|\)|\x60/;
// Subcommands that neither install, resolve nor run a dependency's code.
const SAFE = new Set(['run', 'run-script', 'rum', 'urn', 'test', 'tst', 't', 'start', 'stop', 'restart', 'pack', 'ls',
  'list', 'll', 'la', 'view', 'v', 'info', 'show', 'config', 'c', 'get', 'set', 'version', 'help', 'prefix', 'root',
  'whoami', 'ping', 'doctor', 'outdated', 'explain', 'why', 'query', 'fund', 'search', 's', 'find', 'docs', 'home',
  'repo', 'bugs', 'publish', 'dist-tag', 'pkg', 'sbom']);
// Installs exactly what the lockfile holds (rebuild re-runs what is already installed): no new package is resolved.
const LOCKFILE_EXACT = new Set(['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'cit', 'clean-install-test',
  'sit', 'install-ci-test', 'rebuild', 'rb']);
// npm options that take the next token as their value.
const VALUED = new Set(['-w', '--workspace', '--prefix', '-C', '--userconfig', '--registry', '--cache', '--loglevel',
  '--package', '-p', '-c', '--call']);
const AUDIT = 'node scripts/check-audit.mjs';
const unquote = (v) => v.replace(/^(["'])(.*)\1$/, '$2');

// Splits npm/npx argument tokens into options before the first positional and the positionals after it.
function parseArgs(tokens) {
  const opts = [];
  let i = 0;
  for (; i < tokens.length && tokens[i] !== '--' && /^-/.test(tokens[i]); i++) {
    opts.push(tokens[i]);
    if (VALUED.has(tokens[i]) && i + 1 < tokens.length) opts.push(tokens[++i]);
  }
  if (tokens[i] === '--') i++;
  return { opts, rest: tokens.slice(i) };
}

// npm takes the last --ignore-scripts it is given; a separate true/false token is its value.
function ignoresScripts(tokens) {
  let on = false;
  tokens.forEach((t, i) => {
    const m = t.match(/^--ignore-scripts(?:=(.*))?$/);
    if (!m) return;
    const v = m[1] ?? (/^(true|false)$/.test(tokens[i + 1] ?? '') ? tokens[i + 1] : 'true');
    on = v === 'true';
  });
  return on;
}

// Each npm/npx command in a line: { shown, kind: 'safe' | 'exec' | 'install', fetches, scripts }.
function npmCommands(text) {
  const out = [];
  for (const m of text.matchAll(NPM)) {
    const tail = text.slice(m.index + m[0].length);
    const tokens = tail.split(SEGMENT_END)[0].trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ''))
      .filter((t) => !/^\d*[<>]&?\S*$/.test(t));
    if (m[1] === 'npx') {
      const { opts } = parseArgs(tokens);
      out.push({ shown: 'npx', kind: 'exec', fetches: !opts.some((o) => /^(--no|--no-install|--yes=false)$/.test(o)) });
      continue;
    }
    const { opts, rest } = parseArgs(tokens);
    const sub = rest[0];
    const shown = sub ? `npm ${sub}` : 'npm';
    if (!sub || (SAFE.has(sub)) || (sub === 'audit' && rest[1] !== 'fix') || (/^(init|create|innit)$/.test(sub) && !rest.slice(1).some((t) => !/^-/.test(t)))) {
      out.push({ shown, kind: 'safe' });
    } else if (/^(exec|x)$/.test(sub)) {
      const after = parseArgs(rest.slice(1)).opts;
      out.push({ shown, kind: 'exec', fetches: ![...opts, ...after].some((o) => /^(--no|--no-install|--yes=false)$/.test(o)) });
    } else if (/^(init|create|innit)$/.test(sub)) {
      out.push({ shown, kind: 'exec', fetches: true });
    } else {
      out.push({ shown, kind: 'install', fetches: !LOCKFILE_EXACT.has(sub), scripts: !ignoresScripts(tokens) });
    }
  }
  return out;
}

// Splits a job body into steps: { at (body index of the step's first line), keys: { name: { at, value } },
// run: [{ at, text }] }. Block scalars (run: |, if: >-) are read, folded and plain multi-line scalars joined, quotes
// around a one-line value dropped. A shape this parser cannot read is reported (fail closed).
function stepsOf(body, report) {
  const s = body.findIndex((l) => /^\s*steps:/.test(l));
  if (s < 0) return [];
  if (!/^\s*steps:\s*$/.test(body[s])) {
    report(s, 'install-scripts: steps written inline cannot be checked; fix: write each step in block style, one key per line');
    return [];
  }
  const steps = [];
  let dash = null;
  let cur = null;
  let last = null;
  for (let i = s + 1; i < body.length; i++) {
    const l = body[i];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const ind = indentOf(l);
    if (dash === null) dash = ind;
    if (ind < dash) break;
    const first = ind === dash && /^\s*-(\s|$)/.test(l);
    // The first line's "- " stands in for indentation; the step's keys sit where its first key starts.
    const line = first ? l.replace('-', ' ') : l;
    if (first) {
      if (/^\s*\{/.test(line)) {
        report(i, 'install-scripts: a flow-style step ({ ... }) cannot be checked; fix: write the step in block style, one key per line');
        cur = null;
        continue;
      }
      steps.push((cur = { at: i, keys: {}, run: [], keyIndent: indentOf(line) }));
      last = null;
    }
    if (!cur) continue;
    const m = indentOf(line) === cur.keyIndent && line.match(/^\s*([\w-]+):\s*(.*)$/);
    if (m) {
      const block = /^[|>][-+0-9]*$/.test(m[2]);
      last = cur.keys[m[1]] = { at: i, value: block ? '' : unquote(m[2]), name: m[1], literal: m[2].startsWith('|') };
      if (m[1] === 'run' && m[2] && !block) cur.run.push({ at: i, text: last.value });
    } else if (last && indentOf(line) > cur.keyIndent) {
      last.value = `${last.value} ${line.trim()}`.trim();
      if (last.name !== 'run') continue;
      // Only a literal block keeps its lines; a folded or plain scalar is one line to the shell.
      if (last.literal || !cur.run.length) cur.run.push({ at: i, text: line.trim() });
      else cur.run.at(-1).text += ` ${line.trim()}`;
    } else {
      report(i, 'install-scripts: this step line cannot be checked; fix: write each step key at the same indent as the first');
    }
  }
  return steps;
}

// Run lines with backslash continuations joined, each reported at its first line.
function runLines(step) {
  const out = [];
  for (const r of step.run) {
    const prev = out.at(-1);
    if (prev && /\\$/.test(prev.text)) prev.text = `${prev.text.slice(0, -1)} ${r.text}`;
    else out.push({ ...r });
  }
  return out;
}

function checkInstalls(body, report, reachable) {
  let audited = false;
  for (const step of stepsOf(body, report)) {
    const run = step.run.map((r) => r.text).join('\n').trim();
    const cond = step.keys.if?.value ?? '';
    const swallowed = step.keys['continue-on-error'] && !/^false$/.test(unquote(step.keys['continue-on-error'].value));
    if (run === AUDIT && !step.keys.if && !swallowed) audited = true;
    else if (reachable && run.includes('scripts/check-audit.mjs')) {
      report(step.at, `audit-before-install: this audit step does not stop the job when the audit fails; fix: make it exactly "- run: ${AUDIT}" with no if: and no continue-on-error`);
    }
    for (const { at, text } of runLines(step)) {
      if (reachable) {
        for (const [, pm] of text.matchAll(OTHER_PM)) {
          report(at, `lockfile-install: ${pm} is not covered by the npm lockfile audit, in a job that can reach the self-hosted runner; fix: install with npm ci --ignore-scripts after the audit step`);
        }
      }
      for (const c of npmCommands(text)) {
        if (c.kind === 'safe') continue;
        if (c.kind === 'install' && c.scripts) {
          report(at, `install-scripts: ${c.shown} runs dependency install scripts; fix: add --ignore-scripts to this ${c.shown}`);
        }
        if (!reachable) continue;
        if (c.fetches) {
          report(at, `lockfile-install: ${c.shown} can resolve packages the lockfile audit never saw, in a job that can reach the self-hosted runner; fix: use npm ci --ignore-scripts (npx --no for a locked bin) and change dependencies in package.json and package-lock.json`);
        } else if (c.kind === 'install' && !audited) {
          report(at, `audit-before-install: ${c.shown} runs before the npm audit in a job that can reach the self-hosted runner; fix: add the step "- run: ${AUDIT}" (no if:, no continue-on-error) before this step`);
        }
        if (c.kind === 'install' && /\b(always|failure|cancelled)\(\)/.test(cond)) {
          report(step.keys.if.at, `audit-before-install: if: ${cond} runs this install after a failed audit; fix: remove the if: condition from this step`);
        }
      }
    }
  }
}

export function checkWorkflow(name, text, { product = false } = {}) {
  const errors = [];
  const err = (line, msg) => errors.push(`${name}:${line}: ${msg}`);
  const lines = text.split('\n').map(strip);
  const live = (i) => lines[i].trim() && !lines[i].trim().startsWith('#');
  const topLevel = (key) => lines.findIndex((l) => new RegExp(`^${key}:`).test(l));

  lines.forEach((l, i) => {
    const m = l.match(/^\s*(?:-\s+)?uses:\s*['"]?([^'"\s]+)/);
    if (!m) return;
    const ref = m[1];
    if (ref.startsWith('./')) return;
    if (ref.startsWith('docker://')) {
      if (!/@sha256:[0-9a-f]{64}$/.test(ref)) err(i + 1, `${ref} is not pinned by digest`);
      return;
    }
    if (!/@[0-9a-f]{40}$/.test(ref)) err(i + 1, `${ref} is not pinned by a full commit SHA`);
    if (/^actions\/cache(\/|@)/.test(ref) && /^release/.test(name)) err(i + 1, 'the release workflow must not use actions/cache');
  });

  // Strict on purpose: any live mention outside close-outside-prs.yml fails, trigger or not.
  const prt = lines.findIndex((l) => /\bpull_request_target\b/.test(l));
  if (prt >= 0 && name !== CLOSE_OUTSIDE) err(prt + 1, `pull_request_target is allowed only in ${CLOSE_OUTSIDE}`);

  const workflowPerms = topLevel('permissions') >= 0;
  lines.forEach((l, i) => { if (/^\s*permissions:\s*["']?write-all\b/.test(l)) err(i + 1, 'permissions: write-all is never minimal; name each scope'); });
  const jobsAt = topLevel('jobs');
  if (jobsAt < 0) err(1, 'no jobs');
  else {
    let jobIndent = null;
    const jobs = [];
    for (let i = jobsAt + 1; i < lines.length; i++) {
      if (!live(i)) continue;
      const ind = indentOf(lines[i]);
      if (ind === 0) break;
      if (jobIndent === null) jobIndent = ind;
      if (ind === jobIndent) jobs.push({ name: lines[i].trim().replace(/:$/, ''), at: i, end: lines.length });
    }
    jobs.forEach((j, k) => { j.end = k + 1 < jobs.length ? jobs[k + 1].at : (() => {
      for (let i = j.at + 1; i < lines.length; i++) if (live(i) && indentOf(lines[i]) === 0) return i;
      return lines.length;
    })(); });
    for (const j of jobs) {
      const body = lines.slice(j.at + 1, j.end);
      const keyIndent = body.find((l) => l.trim()) ? indentOf(body.find((l) => l.trim())) : jobIndent + 2;
      const key = (k) => body.findIndex((l) => indentOf(l) === keyIndent && new RegExp(`^\\s*${k}:`).test(l));
      if (!workflowPerms && key('permissions') < 0) err(j.at + 1, `job ${j.name} declares no permissions`);
      const ro = key('runs-on');
      let block = ro >= 0 ? body[ro] : '';
      if (ro >= 0) for (let i = ro + 1; i < body.length && (indentOf(body[i]) > keyIndent || !body[i].trim()); i++) block += `\n${body[i]}`;
      const reachable = ro < 0 || !hostedOnly(resolveMatrix(block, body, keyIndent));
      if (product && ro >= 0 && reachable) {
        err(j.at + ro + 2, `job ${j.name} may run on a self-hosted runner: runs-on must name GitHub-hosted labels only (ubuntu-*, macos-*, windows-*)`);
      }
      if (!product) checkInstalls(body, (i, msg) => err(j.at + i + 2, msg), reachable);
      if (name === CLOSE_OUTSIDE) {
        body.forEach((l, i) => {
          if (/^\s*(?:-\s+)?run:/.test(l)) err(j.at + i + 2, `${CLOSE_OUTSIDE} must have no run: step`);
          if (/uses:\s*['"]?actions\/checkout@/.test(l)) err(j.at + i + 2, `${CLOSE_OUTSIDE} must not check out code`);
        });
      }
    }
  }
  return errors;
}

export function checkDir(dir, opts) {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  return { files, errors: files.flatMap((f) => checkWorkflow(f, readFileSync(join(dir, f), 'utf8'), opts)) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const product = args.includes('--product');
  const dirs = args.filter((a) => !a.startsWith('--'));
  if (!dirs.length) {
    console.error('usage: node scripts/check-workflows.mjs [--product] DIR...');
    process.exit(2);
  }
  let n = 0;
  const errors = [];
  for (const d of dirs) {
    const r = checkDir(d, { product });
    n += r.files.length;
    errors.push(...r.errors.map((e) => `${d}/${e}`));
  }
  for (const e of errors) console.error(e);
  if (errors.length) process.exit(1);
  console.log(`check-workflows: ok (${n} workflows, ${product ? 'product' : 'lab'} mode)`);
}
