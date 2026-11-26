#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// find-surfaces v1 (catscan-upgrade skill). Node built-ins and git only; reads, never writes.
// Lists every place a project holds catscan, from the committed tree at --rev (default HEAD):
//   S1 npm packages (every package.json and lockfile), S2 CI pins, S3 MCP config (project files; the user's
//   ~/.claude.json and ~/.codex/config.toml are reported only), S5 marked rule blocks, S6 baselines named by
//   --baseline; S4, the agent plugin, is this skill's own version (`skill`).
// Usage: node find-surfaces.mjs <repo> [--rev REV] [--to X.Y.Z]
// Prints one JSON document (schema 1) on stdout: rev, dirty, surfaces[], references[], invocations[], skew,
// skill and, with --to, edits[] and commands[]. Exit 0; 2 on a usage or input error, with
// `find-surfaces: <code>: <message> - try: <fix>` on stderr. Skew is data, not a failure.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ME = 'find-surfaces';
const die = (code, message, fix) => { console.error(`${ME}: ${code}: ${message} - try: ${fix}`); process.exit(2); };

export const PACKAGES = ['cli', 'core-js', 'cli-darwin-arm64', 'mcp', 'playwright'].map((p) => `@catscan/${p}`);
export const CI_FILES = [/^\.github\/workflows\/[^/]+\.ya?ml$/, /^\.gitlab-ci\.ya?ml$/, /^\.circleci\/config\.ya?ml$/,
  /^bitrise\.ya?ml$/, /^codemagic\.ya?ml$/, /^azure-pipelines\.ya?ml$/, /^\.buildkite\/[^/]+\.ya?ml$/, /^Jenkinsfile$/];
export const MCP_FILES = ['.mcp.json', '.codex/config.toml', '.cursor/mcp.json'];
export const RULE_FILES = /(^|\/)(AGENTS\.md|CLAUDE\.md|docs\/testing\.md)$/;
export const MARKERS = [
  { block: 'test-speedup:testing-rules', re: /<!-- test-speedup:testing-rules start\b/ },
  { block: 'test-speedup:gpu-rule', re: /<!-- test-speedup:gpu-rule start\b/ },
];
const LOCKS = { 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' };
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const EXACT = /^\d+\.\d+\.\d+$/;
// Every CLI command (a test keeps this in step with the CLI's own list); the verdict commands are the ones Step 2
// replays, so a generator such as `catscan pseudo` is never run into the repo.
export const VERDICT = ['check', 'read', 'untranslated', 'video', 'truncated', 'overlap', 'formats', 'fit', 'contrast'];
export const COMMANDS = [...VERDICT, 'boxes', 'languages', 'doctor', 'serve', 'results', 'report', 'pseudo'];

/** The shape of one `@catscan/<pkg>[@<version>]` reference pinned, range, variable or unpinned. */
export function shapeOf(version) {
  if (version === null) return 'unpinned';
  if (SEMVER.test(version)) return 'pinned';
  if (/[$<{%]/.test(version)) return 'variable';
  return 'range';
}

/** Every @catscan/ reference in one text: { package, version, shape, line, column }, plus checkout paths. */
export function scanReferences(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/@catscan\/([a-z0-9-]+)(?:@([^\s"'`),\]}]+))?/g)) {
      out.push({ package: `@catscan/${m[1]}`, version: m[2] ?? null, shape: shapeOf(m[2] ?? null), line: i + 1 });
    }
    // A checkout path runs a local build: nothing to move, listed for the user.
    for (const m of l.matchAll(/([^\s"'`]*\/(?:packages\/mcp\/bin\/catscan-mcp|bin\/catscan)\.js)/g)) {
      out.push({ package: null, version: null, shape: 'checkout', path: m[1], line: i + 1 });
    }
  });
  return out;
}

/** catscan command lines in one text (CI step or package script): { line, argv, command, role }. */
export function scanInvocations(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    // Each command of a chain (`a && b`, `a; b`, `a | b`) is its own invocation.
    // A quoted YAML or JSON value (`run: "a && b"`) holds its own shell line: unwrap it before splitting.
    for (const l of chain(line.replace(/^(\s*(?:-\s+)?(?:"?[\w.:-]+"?:\s*)?)(["'])(.*)\2,?\s*$/, '$1$3'))) {
      // npx (-y, --yes, -p), pnpm dlx, yarn dlx and bunx run the published CLI; a bare `catscan` runs the installed one.
      const m = l.match(/(?:^|[\s"'`;&|(])((?:(?:npx|pnpm\s+dlx|yarn\s+dlx|bunx)\s+(?:(?:-y|--yes|-p|--package)\s+)*@catscan\/cli(?:@(?:\S*\$\{\{[^}]*\}\}\S*|\S+))?(?:\s+catscan)?|(?:\.\/node_modules\/\.bin\/)?catscan)\s+(.*))$/);
      if (!m) continue;
      // A YAML or JSON string's closing quote or comma is not part of the command; a balanced quoted argument keeps its own.
      let cmd = m[1].replace(/,?\s*$/, '');
      while (/["']$/.test(cmd) && (cmd.split(cmd.at(-1)).length - 1) % 2 === 1) cmd = cmd.slice(0, -1).replace(/,?\s*$/, '');
      // The command is the first token after the runner that is exactly a CLI command, so options may come first.
      const command = split(cmd.slice(m[1].length - m[2].length)).find((t) => COMMANDS.includes(t.replace(/["',]+$/, '')))?.replace(/["',]+$/, '');
      if (!command) continue;
      out.push({ line: i + 1, argv: split(cmd), command, role: VERDICT.includes(command) ? 'verdict' : 'other' });
    }
  });
  return out;
}

/** The commands of one shell line: split on `&&`, `||`, `;` and `|` outside quotes. */
export function chain(line) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\' && quote === '"') { cur += c + (line[++i] ?? ''); continue; } if (c === quote) quote = null; cur += c; continue; }
    if (c === '\\') { cur += c + (line[++i] ?? ''); continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ';' || c === '|' || (c === '&' && line[i + 1] === '&')) {
      out.push(cur);
      cur = '';
      if ((c === '|' && line[i + 1] === '|') || c === '&') i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function split(cmd) {
  const argv = [];
  // A CI expression (`${{ env.X }}`) holds spaces but is one argument.
  for (const m of cmd.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S*\$\{\{[^}]*\}\}\S*|\S+)/g)) argv.push(m[1] ?? m[2] ?? m[3]);
  return argv;
}

/** Exact versions per @catscan package in one lockfile text. */
export function lockVersions(manager, file, text) {
  const out = [];
  const add = (pkg, version, line) => { if (PACKAGES.includes(pkg)) out.push({ package: pkg, current: version, line }); };
  if (manager === 'npm') {
    let lock;
    try { lock = JSON.parse(text); } catch { return null; }
    for (const [k, v] of Object.entries(lock.packages || {})) {
      const pkg = k.match(/(?:^|\/)node_modules\/(@catscan\/[a-z0-9-]+)$/)?.[1];
      if (pkg && v?.version) add(pkg, v.version, null);
    }
    // lockfileVersion 1 has no `packages`, only a nested `dependencies` tree.
    const walk = (deps) => {
      for (const [name, v] of Object.entries(deps || {})) {
        if (v?.version) add(name, v.version, null);
        walk(v?.dependencies);
      }
    };
    if (!lock.packages) walk(lock.dependencies);
  } else if (manager === 'yarn') {
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      const pkg = l.match(/^"?(@catscan\/[a-z0-9-]+)@/)?.[1];
      const ver = pkg && lines.slice(i + 1, i + 6).join('\n').match(/^\s+version:?\s+"?([^"\s]+)"?/m)?.[1];
      if (ver) add(pkg, ver, i + 1);
    });
  } else {
    // pnpm 9 and text bun.lock name the resolved package `@catscan/<pkg>@<version>`; pnpm 5-8 keys are
    // `/@catscan/<pkg>/<version>:` or `/@catscan/<pkg>@<version>:`.
    text.split('\n').forEach((l, i) => {
      for (const m of l.matchAll(/(@catscan\/[a-z0-9-]+)[@/](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)) add(m[1], m[2], i + 1);
    });
  }
  return out;
}

/** The skill's own version from <skill-dir>/../../.claude-plugin/plugin.json; "unknown" for a copied folder. */
export function skillVersion(scriptDir = dirname(fileURLToPath(import.meta.url))) {
  const manifest = join(scriptDir, '..', '..', '..', '.claude-plugin', 'plugin.json');
  try {
    const v = JSON.parse(readFileSync(manifest, 'utf8')).version;
    return typeof v === 'string' && SEMVER.test(v) ? v : 'unknown';
  } catch { return 'unknown'; }
}

/** Semver order with prereleases: 1.0.0-rc.1 < 1.0.0; prerelease ids compare numerically when both are numbers. */
export function cmpSemver(a, b) {
  const core = cmpVersion(a, b);
  if (core !== 0) return core;
  const pa = a.split('-').slice(1).join('-'), pb = b.split('-').slice(1).join('-');
  if (!pa || !pb) return (pa ? -1 : 0) - (pb ? -1 : 0);
  const x = pa.split('.'), y = pb.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]);
    if (nx && ny && Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
    if (nx !== ny) return nx ? -1 : 1;
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

export function cmpVersion(a, b) {
  const x = a.split(/[.-]/).slice(0, 3).map(Number);
  const y = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || '').trim());
  return r.stdout;
}

/** The whole report for a repo at a revision; `read(path)` and `home` are injectable for tests. */
export function findSurfaces(repo, { rev = 'HEAD', to = null, home = homedir(), allowDowngrade = false } = {}) {
  const sha = git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]).trim();
  const files = git(repo, ['ls-tree', '-r', '--name-only', '-z', sha]).split('\0').filter(Boolean);
  const read = (f) => git(repo, ['show', `${sha}:${f}`]);
  const dirty = git(repo, ['status', '--porcelain']).trim() !== '';
  const surfaces = [];
  const references = [];
  const invocations = [];
  const scanned = new Set();
  const workspaceRoots = new Map(); // root folder -> its workspace globs
  const addRefs = (file, text, surface, scope = 'project') => {
    for (const r of scanReferences(text)) {
      references.push({ file, scope, ...r });
      if (surface && r.shape === 'pinned') surfaces.push({ surface, file, line: r.line, package: r.package, current: r.version, scope });
    }
  };

  // A baseline is rewritten only on the user's yes, and only at a plain path inside the repo: a variable or a path
  // outside it is listed for the user.
  const baseline = (path, referencedIn, line) => {
    const plain = !/[$`{]/.test(path) && !isAbsolute(path) && !path.split('/').includes('..');
    if (plain) surfaces.push({ surface: 'S6', file: path, referenced_in: referencedIn, line, exists: files.includes(path), scope: 'project' });
    else references.push({ file: referencedIn, scope: 'project', package: null, version: null, shape: 'baseline-not-moved', path, line });
  };

  // S1: manifests, then lockfiles.
  for (const f of files.filter((p) => /(^|\/)package\.json$/.test(p) && !p.includes('node_modules/'))) {
    const text = read(f);
    let pkg;
    try { pkg = JSON.parse(text); } catch { continue; }
    const lines = text.split('\n');
    // The line of `"<name>"` inside the object that follows the `"<key>":` line, so a package listed in two
    // fields gets each field's own line.
    const lineIn = (key, name) => {
      const from = lines.findIndex((l) => l.includes(`"${key}"`));
      const at = from === -1 ? -1 : lines.findIndex((l, i) => i > from && l.includes(`"${name}"`));
      return at === -1 ? null : at + 1;
    };
    // Overrides force a version whatever the dependency says; a package manager command does not move them.
    const fields = [['dependencies', pkg.dependencies], ['devDependencies', pkg.devDependencies], ['optionalDependencies', pkg.optionalDependencies],
      ['peerDependencies', pkg.peerDependencies], ['overrides', pkg.overrides], ['resolutions', pkg.resolutions], ['pnpm.overrides', pkg.pnpm?.overrides]];
    for (const [field, deps] of fields) {
      for (const [name, spec] of Object.entries(deps || {})) {
        if (!name.startsWith('@catscan/') || typeof spec !== 'string') continue;
        const line = lineIn(field.split('.').pop(), name);
        surfaces.push({ surface: 'S1', file: f, line, package: name, current: spec, field, workspace: dirname(f), scope: 'project' });
        references.push({ file: f, scope: 'project', package: name, version: spec, shape: shapeOf(spec), line });
      }
    }
    for (const [name, script] of Object.entries(pkg.scripts || {})) {
      const line = lineIn('scripts', name);
      for (const inv of scanInvocations(script)) invocations.push({ file: f, line, script: name, argv: inv.argv, command: inv.command, role: inv.role });
      // A pinned `npx @catscan/cli@X` in a script runs in CI like a workflow pin: it moves the same way.
      for (const r of scanReferences(script)) {
        references.push({ file: f, scope: 'project', ...r, line });
        if (r.shape === 'pinned') surfaces.push({ surface: 'S2', file: f, line, package: r.package, current: r.version, script: name, scope: 'project' });
      }
    }
    const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (Array.isArray(globs)) workspaceRoots.set(dirname(f), globs);
  }
  for (const f of files.filter((p) => p.endsWith('pnpm-workspace.yaml'))) {
    const globs = [...read(f).matchAll(/^\s*-\s*['"]?([^'"\s#]+)['"]?/gm)].map((m) => m[1]);
    workspaceRoots.set(dirname(f), globs);
  }
  for (const f of files) {
    const manager = LOCKS[f.split('/').pop()];
    if (!manager) continue;
    if (f.endsWith('.lockb')) { surfaces.push({ surface: 'S1', file: f, kind: 'lockfile', manager, package: null, current: null, note: 'binary bun.lockb: run `bun install` to read it', scope: 'project' }); continue; }
    const found = lockVersions(manager, f, read(f));
    for (const l of found || []) surfaces.push({ surface: 'S1', file: f, kind: 'lockfile', manager, ...l, scope: 'project' });
    // A lockfile that resolves no @catscan package (or that cannot be parsed) still decides the package manager.
    if (!found?.length) surfaces.push({ surface: 'S1', file: f, kind: 'lockfile', manager, package: null, current: null, ...(found ? {} : { note: 'unreadable lockfile' }), scope: 'project' });
  }

  // S2: CI files and the shell scripts they call.
  const ci = files.filter((f) => CI_FILES.some((re) => re.test(f)));
  const queue = [...ci];
  while (queue.length) {
    const f = queue.shift();
    if (scanned.has(f)) continue;
    scanned.add(f);
    const text = read(f);
    addRefs(f, text, 'S2');
    for (const inv of scanInvocations(text)) invocations.push({ file: f, ...inv });
    for (const m of text.matchAll(/(?:^|[\s"'])(?:bash |sh |\.\/)?([\w./-]+\.(?:sh|mjs|js))\b/gm)) {
      if (files.includes(m[1]) && !scanned.has(m[1])) queue.push(m[1]);
    }
    text.split('\n').forEach((l, i) => {
      const b = l.match(/--baseline[=\s]+["']?([^\s"']+)/);
      if (b) baseline(b[1], f, i + 1);
    });
  }
  for (const inv of invocations.filter((v) => v.script)) {
    const b = inv.argv.indexOf('--baseline');
    if (b !== -1 && inv.argv[b + 1]) baseline(inv.argv[b + 1], inv.file, inv.line);
  }

  // S3: project MCP files are moved; the user's are reported with a command.
  for (const f of MCP_FILES.filter((p) => files.includes(p))) addRefs(f, read(f), 'S3');
  // ~/.claude.json holds every project's servers: read only the user-scope ones and this project's, and record
  // which scope each came from, so the printed `claude mcp add -s <scope>` puts it back where it was.
  const claude = join(home, '.claude.json');
  if (existsSync(claude)) {
    let doc = null;
    try { doc = JSON.parse(readFileSync(claude, 'utf8')); } catch { /* unreadable: nothing to report */ }
    // Claude keys local servers by the folder it was started in: the repo root or a folder inside it.
    const local = Object.entries(doc?.projects || {}).filter(([k]) => k === repo || k.startsWith(`${repo}/`)).map(([, v]) => v?.mcpServers);
    for (const [mcpScope, servers] of [['user', doc?.mcpServers], ...local.map((s) => ['local', s])]) {
      if (!servers) continue;
      const before = surfaces.length;
      addRefs(claude, JSON.stringify(servers), 'S3', 'user');
      for (const s of surfaces.slice(before)) { s.mcp_scope = mcpScope; s.line = null; }
    }
  }
  const codex = join(home, '.codex', 'config.toml');
  if (existsSync(codex)) {
    try { addRefs(codex, readFileSync(codex, 'utf8'), 'S3', 'user'); } catch { /* unreadable: nothing to report */ }
  }

  // S5: marked rule blocks; the new skill version's installer refreshes them.
  // agent-rules.mjs --doc <path> puts the testing rules elsewhere; the line it writes in AGENTS.md names that path.
  const ruleFiles = new Set(files.filter((p) => RULE_FILES.test(p)));
  for (const f of [...ruleFiles]) {
    for (const m of read(f).matchAll(/`([^`]+\.md)`[^\n]*<!-- test-speedup:testing-rules -->/g)) if (files.includes(m[1])) ruleFiles.add(m[1]);
  }
  for (const f of ruleFiles) {
    const lines = read(f).split('\n');
    for (const { block, re } of MARKERS) {
      const at = lines.findIndex((l) => re.test(l));
      if (at !== -1) surfaces.push({ surface: 'S5', file: f, line: at + 1, block, current: null, scope: 'project' });
    }
  }

  const pinned = surfaces.filter((s) => s.scope === 'project' && s.current && SEMVER.test(s.current));
  const byVersion = {};
  for (const s of pinned) (byVersion[s.current] ||= []).push(`${s.file}${s.line ? `:${s.line}` : ''}`);
  const skew = Object.keys(byVersion).length > 1 ? { versions: byVersion } : null;
  const version = skillVersion();
  const report = { schema: 1, rev: sha, dirty, surfaces, references, invocations, skew,
    skill: { version, target: to, update_first: to === null ? null : version === 'unknown' || cmpSemver(version, to) < 0 } };
  if (to) {
    // Only the project's exact pins decide the direction (the skew set); the skill's own version and
    // user-scope MCP pins would block real upgrades. npm latest can sit below them, so an unnamed downgrade plans nothing.
    const newest = Object.keys(byVersion).sort(cmpSemver).at(-1) ?? null;
    const vs = Object.keys(byVersion);
    report.direction = newest === null ? null
      : vs.some((v) => cmpSemver(v, to) > 0) ? 'downgrade' : vs.some((v) => cmpSemver(v, to) < 0) ? 'upgrade' : 'none';
    report.direction_from = newest;
    Object.assign(report, plan(surfaces, to, workspaceRoots));
    if (report.direction === 'downgrade' && !allowDowngrade) {
      Object.assign(report, { edits: [], commands: [], stop: `${to} is older than ${newest}, the newest version this project pins: no change planned` });
    }
  }
  return report;
}

/** --to: the literal pin rewrites (S2, project S3, manifests) and the package-manager commands. Each manifest is
 * moved from its own folder by the manager of its nearest lockfile (a workspace member updates the root lockfile);
 * its manifest edits are then written by that command (`via: "command"`). A manifest with no lockfile gets edits only. */
const globRe = (g) => new RegExp(`^${g.replace(/^\.\//, '').replace(/\/$/, '').split('/').map((p) => (p === '**' ? '.*' : p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))).join('/')}$`);

export function plan(surfaces, to, workspaceRoots = new Map()) {
  const locks = surfaces.filter((s) => s.kind === 'lockfile');
  const lockDirs = [...new Map(locks.map((s) => [dirname(s.file), s])).values()];
  // A manifest moves with the lockfile in its own folder, or with an ancestor's only when that ancestor declares
  // workspaces: npm or pnpm run in a non-member folder would write a second lockfile there.
  const lockFor = (dir) => lockDirs
    .filter((l) => {
      const d = dirname(l.file);
      if (dir === d) return true;
      const rel = d === '.' ? dir : dir.startsWith(`${d}/`) ? dir.slice(d.length + 1) : null;
      return rel !== null && (workspaceRoots.get(d) || []).some((g) => !g.startsWith('!') && globRe(g).test(rel));
    })
    .sort((a, b) => dirname(b.file).length - dirname(a.file).length)[0] ?? null;
  const moved = (s) => s.field && !['peerDependencies', 'overrides', 'resolutions', 'pnpm.overrides'].includes(s.field) && SEMVER.test(s.current) && lockFor(s.workspace);
  const edits = surfaces
    .filter((s) => ['S1', 'S2', 'S3'].includes(s.surface) && s.scope === 'project' && s.kind !== 'lockfile' && s.current && SEMVER.test(s.current) && s.current !== to)
    .map((s) => ({ surface: s.surface, file: s.file, line: s.line, from: `${s.package}${s.surface === 'S1' ? `": "${s.current}` : `@${s.current}`}`, to: `${s.package}${s.surface === 'S1' ? `": "${to}` : `@${to}`}`,
      ...(s.surface === 'S1' ? { via: moved(s) ? 'command' : 'edit', field: s.field } : {}) }));
  const commands = [];
  // Only exact pins: a range, `workspace:`, `file:` or tag stays as written (listed in references for the user).
  const manifests = surfaces.filter((s) => s.surface === 'S1' && !s.kind && moved(s));
  for (const dir of [...new Set(manifests.map((s) => s.workspace))]) {
    const lock = lockFor(dir);
    if (!lock) continue;
    const add = { npm: 'npm install --save-exact', pnpm: 'pnpm add --save-exact', yarn: 'yarn add --exact', bun: 'bun add --exact' }[lock.manager];
    const deps = manifests.filter((s) => s.workspace === dir);
    for (const dev of [false, true]) {
      const pkgs = [...new Set(deps.filter((s) => (s.field === 'devDependencies') === dev).map((s) => `${s.package}@${to}`))];
      if (pkgs.length) commands.push({ lockfile: lock.file, manager: lock.manager, cwd: dir, command: `${add}${dev ? (lock.manager === 'npm' ? ' --save-dev' : ' -D') : ''} ${pkgs.join(' ')}` });
    }
  }
  // An edited override changes what the lockfile resolves: its folder reinstalls when no command already runs there.
  const overrideDirs = new Set(edits.filter((e) => ['overrides', 'resolutions', 'pnpm.overrides'].includes(e.field)).map((e) => dirname(e.file)));
  for (const dir of overrideDirs) {
    const lock = lockFor(dir);
    if (lock && !commands.some((c) => c.cwd === dir)) commands.push({ lockfile: lock.file, manager: lock.manager, cwd: dir, command: `${lock.manager} install` });
  }
  return { edits, commands };
}

function main(argv) {
  let repo = null;
  let rev = 'HEAD';
  let to = null;
  let allowDowngrade = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-downgrade') allowDowngrade = true;
    else if (a === '--rev' || a === '--to') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) die('usage', `${a} needs a value`, `node find-surfaces.mjs <repo> ${a} ${a === '--to' ? '1.2.0' : 'HEAD'}`);
      if (a === '--rev') rev = v; else to = v;
    } else if (a.startsWith('--')) die('usage', `unknown option ${a}`, 'node find-surfaces.mjs <repo> [--rev REV] [--to X.Y.Z [--allow-downgrade]]');
    else if (repo === null) repo = resolve(a);
    else die('usage', `a second repo ${a}`, 'pass one repository path');
  }
  if (repo === null) die('usage', 'no repository given', 'node find-surfaces.mjs <repo>');
  if (allowDowngrade && to === null) die('usage', '--allow-downgrade needs --to', 'node find-surfaces.mjs <repo> --to 1.2.0 --allow-downgrade');
  if (to !== null && !EXACT.test(to)) die('bad-version', `--to ${to} is not X.Y.Z`, 'name an exact release version, such as --to 1.2.0');
  let top;
  try { top = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { top = null; }
  if (!top) die('not-a-repo', `${repo} is not a git repository`, 'run it on the project root, or git init and commit first');
  let report;
  try { report = findSurfaces(top, { rev, to, allowDowngrade }); } catch (e) { die('git', e.message.split('\n')[0] || `cannot read ${rev}`, 'pass a revision that exists (--rev HEAD)'); }
  console.log(JSON.stringify(report, null, 2));
}

// realpath: on macOS a temp or copied folder under /var is /private/var to import.meta.url, and a plain
// resolve() would make the script exit 0 with no output.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
