#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// gpu-guard v1 (catscan test-speedup skill). Self-contained: Node built-ins only, so a project
// can copy it into its own tools and run it from its check command. Lists every launch site that starts
// Chromium or Electron without the shared GPU-args helper, every AVD boot without -gpu host, every CPU
// renderer literal, and a missing runtime renderer check.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = 1;
// The renderer string a CPU fallback reports; the smoke spec in
// references/web-e2e.md quotes this regex and a test keeps the two equal.
export const CPU_RENDERER = /SwiftShader|llvmpipe|softpipe|Software Rasterizer|Microsoft Basic Render/i;
const CPU_FLAG = /--use-(?:angle|gl)=swiftshader\b|--enable-unsafe-swiftshader\b|--disable-gpu(?![\w-])|['"]disable-gpu['"]|\bdisableHardwareAcceleration\s*\(|-gpu['"`]?\s*,?\s*['"`]?(?:swiftshader\w*|guest|lavapipe|auto)\b|hw\.gpu\.mode\s*=\s*(?:swiftshader\w*|guest|auto)\b/g;
const OPT_OUT_SET = /\bE2E_GPU\s*[:=]\s*['"]?swiftshader\b/g;
const AVD = /(?:^|[\s'"`[,])-avd(?=['"`\s,\]]|$)/m;
const GPU_HOST = /-gpu['"`]?\s*,?\s*['"`]?host\b/;
const MAX_BYTES = 1024 * 1024;
const JS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']);
const HASH = new Set(['sh', 'bash', 'zsh', 'yml', 'yaml']);
const CONFIG = /^playwright(\.[\w-]+)?\.config\.(ts|js|mjs|cjs|mts|cts)$/;
const TEST_FILE = /(^|\/)(tests?|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const MARKER = /gpu-launch:[ \t]*([^\s*][^*]*?)[ \t]*(?:\*\/)?[ \t]*$/;
const RECEIVERS = ['chromium', '_electron', 'electron', 'puppeteer'];
const SELF = fileURLToPath(import.meta.url);

const USAGE = `usage: node gpu-guard.mjs [--root DIR] [--helper NAME]... [--ignore PATH]... [--json]
  Lists launch sites that bypass the GPU-args helper, AVD boots without -gpu host, CPU renderer
  literals and a missing renderer smoke test. Exit 0 clean, 1 findings, 2 usage error.
  --root DIR      tree to scan (default: current directory); git-tracked and untracked, not ignored
  --helper NAME   helper or flag constant that carries the GPU args (repeatable; default gpuLaunchArgs)
  --ignore PATH   skip files under this path, relative to the root (repeatable; fixtures holding
                  CPU flags as data)
  --json          print {findings, exempt, skipped, sites} as JSON
  Exempt one line only with the owner's "gpu-launch: <why>" comment on it or the line above.
  gpu-guard v${VERSION}, catscan test-speedup skill (references/guards.md).`;

const kindOf = (path) => {
  const name = basename(path);
  if (name === 'package.json') return 'json';
  if (/^(GNU)?[Mm]akefile$/.test(name)) return 'hash';
  if (!name.includes('.')) return 'shebang'; // decided by the #! line once read (ship review, red team)
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return JS.has(ext) ? 'js' : HASH.has(ext) ? 'hash' : null;
};

// Blank JS comments to spaces, keeping newlines and string, template and regex contents, so a glob such as
// '**/*.spec.ts' or a regex such as /^\/*/ does not open a comment and line numbers stay true.
const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};+\-*%<>~^])\s*$|\b(?:return|typeof|case|do|else|in|of|void|delete|throw|new|yield|await)\s*$/;
export function blankJsComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && n === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? src.length : end + 2;
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else if (c === '/' && REGEX_BEFORE.test(out.slice(-40))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      if (src[j] !== '/') { out += c; i++; continue; } // not a regex after all: a division
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Shell and YAML: '#' at line start or after whitespace, outside quotes, starts a comment.
export function blankHashComments(src) {
  return src.split('\n').map((line) => {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) { if (c === '\\' && quote === '"') i++; else if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i) + ' '.repeat(line.length - i);
    }
    return line;
  }).join('\n');
}

// Import and require statements blanked: a helper named only there is no launch flag.
const blankImports = (code) => code
  .replace(/\bimport\s+(?:type\s+)?[^;'"`]*?\bfrom\s*(['"])[^'"]*\1/g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\s*\([^)]*\)/g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^.*\brequire\s*\(.*$/gm, (m) => ' '.repeat(m.length));

// The text between the bracket at `open` and its partner, skipping string contents.
function balanced(code, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [pairs[code[open]]];
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) { if (code[j] === '\\') j++; j++; }
      i = j;
    } else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return code.slice(open + 1, i); }
  }
  return code.slice(open + 1);
}

// Object keys are no references: `{ args: [...] }` must not match an identifier named `args`.
// A key follows `{`, `,` or the start of a balanced object body; a ternary's `a ? b : c` does not, so `b` survives.
const dropKeys = (text) => text.replace(/((?:^|[{,])\s*)(?:[A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:(?!:)/g, '$1:');

const words = (names) => new RegExp(`\\b(?:${names.map((n) => n.replace(/[$]/g, '\\$')).join('|')})\\b`);

// Identifiers whose value is built from a helper: `const args = gpuLaunchArgs()`, `const opts = { args: ... }`.
function helperDerived(use, helpers) {
  const names = new Set(helpers);
  for (let pass = 0; pass < 3; pass++) {
    const re = words([...names]);
    for (const m of use.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*/g)) {
      const at = m.index + m[0].length;
      const value = '([{'.includes(use[at]) ? balanced(use, at) : use.slice(at, use.indexOf('\n', at) < 0 ? undefined : use.indexOf('\n', at));
      if (re.test(dropKeys(value))) names.add(m[1]);
    }
  }
  return [...names];
}

function receivers(code) {
  const out = new Set(RECEIVERS);
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"](?:playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core)['"]/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().match(/^(chromium|_electron)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (alias) out.add(alias[2]);
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\.)?(chromium|_electron)\b(?!\s*[.(])/g)) out.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*['"](?:playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core)['"]\s*\)/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().match(/^(chromium|_electron)\s*:\s*([A-Za-z_$][\w$]*)$/);
      if (alias) out.add(alias[2]);
    }
  }
  return [...out];
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

function markerAt(raw, line) {
  for (const l of [line, line - 1]) {
    const m = l >= 1 ? raw[l - 1]?.match(MARKER) : null;
    if (m) return m[1].trim();
  }
  return null;
}

function listFiles(root, notes) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status === 0) return r.stdout.split('\0').filter(Boolean);
  notes.push(`gpu-guard: no git file list (${(r.stderr || r.error?.message || 'git failed').split('\n')[0].trim()}); walking the tree`);
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk('');
  return out;
}

const FIX = {
  'launch-without-helper': (h) => `pass the helper's args, e.g. { args: ${h}() } (references/web-e2e.md lever 1); if the owner keeps a CPU renderer here, ask the owner for a "gpu-launch: <why>" comment`,
  'config-without-helper': (h) => `set launchOptions: { args: ${h}() } in use or in every Chromium project; a WebKit- or Firefox-only config gets an owner's "// gpu-launch: <why>" comment`,
  'emulator-without-gpu-host': () => 'add -gpu host to the emulator arguments (references/devices.md)',
  'cpu-renderer': () => 'remove it; a CPU run is only a per-run env opt-out inside the helper, on a line with the owner\'s "gpu-launch: <why>" comment',
  'no-renderer-proof': () => 'add the renderer smoke spec from references/web-e2e.md to the e2e suite',
  unreadable: () => 'fix the file permissions, or pass --ignore <path> if it is not source',
};

/** Scans `root`; returns { findings, exempt, skipped, sites, notes }. */
export function scan({ root = '.', helpers = ['gpuLaunchArgs'], ignore = [] } = {}) {
  const abs = resolve(root);
  let self = SELF;
  try { self = realpathSync(SELF); } catch {}
  const notes = [];
  const findings = [];
  const exempt = [];
  const skipped = [];
  const browserSites = [];
  let sites = 0;
  let proof = false;
  const prefixes = ignore.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
  const helperRe = words(helpers);
  const h = helpers[0];

  for (const path of listFiles(abs, notes).sort()) {
    let kind = kindOf(path);
    if (!kind || prefixes.some((p) => path === p || path.startsWith(`${p}/`))) continue;
    const full = join(abs, path);
    let raw;
    try {
      if (realpathSync(full) === self) continue;
      // git ls-files lists gitlinks and symlinks to directories too; only regular files are scanned.
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (kind === 'shebang') {
        const head = Buffer.alloc(128);
        const fd = openSync(full, 'r');
        let n;
        try { n = readSync(fd, head, 0, 128, 0); } finally { closeSync(fd); }
        const first = head.subarray(0, n).toString('utf8').split('\n')[0];
        kind = /^#!.*\b(?:node|bun|deno)\b/.test(first) ? 'js' : /^#!.*\b(?:ba|z|da|k)?sh\b/.test(first) ? 'hash' : null;
        if (!kind) continue;
      }
      const size = st.size;
      if (size > MAX_BYTES) { skipped.push({ path, bytes: size }); continue; }
      raw = readFileSync(full, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue; // tracked but deleted in the work tree
      findings.push({ path, line: 1, kind: 'unreadable', message: `cannot read (${e.code || e.message})`, fix: FIX.unreadable() });
      continue;
    }
    const lines = raw.split('\n');
    const code = kind === 'js' ? blankJsComments(raw) : kind === 'hash' ? blankHashComments(raw) : raw;
    const report = (line, k, message, anywhere = false) => {
      const reason = anywhere ? lines.map((l) => l.match(MARKER)?.[1]).find(Boolean)?.trim() : markerAt(lines, line);
      if (reason) exempt.push({ path, line, kind: k, reason });
      else findings.push({ path, line, kind: k, message, fix: FIX[k](h) });
      return !reason;
    };

    if (kind === 'js') {
      const use = blankImports(code);
      const ok = words(helperDerived(use, helpers));
      const recv = receivers(code);
      const launch = new RegExp(`\\b(${recv.map((r) => r.replace(/\$/g, '\\$')).join('|')})\\s*\\.\\s*(launch|launchPersistentContext|launchServer)\\s*\\(`, 'g');
      const aliases = recv.slice(RECEIVERS.length);
      for (const m of code.matchAll(launch)) {
        const [, r, method] = m;
        // launchPersistentContext and launchServer matter only on Chromium; puppeteer and Electron start with launch().
        if (method !== 'launch' && r !== 'chromium' && !aliases.includes(r)) continue;
        sites++;
        const line = lineAt(code, m.index);
        if (ok.test(dropKeys(balanced(code, m.index + m[0].length - 1)))) { browserSites.push({ path, line }); continue; }
        if (report(line, 'launch-without-helper', `${r}.${method}() starts without GPU args from ${helpers.join(' or ')}`)) browserSites.push({ path, line });
      }
      if (CONFIG.test(basename(path))) {
        sites++;
        if (helperRe.test(use)) browserSites.push({ path, line: 1 });
        else if (report(1, 'config-without-helper', `Playwright config never uses ${helpers.join(' or ')} outside imports`, true)) browserSites.push({ path, line: 1 });
      }
      if (TEST_FILE.test(path) && code.includes('UNMASKED_RENDERER_WEBGL') && /swiftshader/i.test(code)) proof = true;
    }
    if (kind !== 'json') {
      const avd = code.match(AVD);
      if (avd) {
        sites++;
        if (!GPU_HOST.test(code) && !helperRe.test(kind === 'js' ? blankImports(code) : code)) report(lineAt(code, avd.index + (avd[0].startsWith('-') ? 0 : 1)), 'emulator-without-gpu-host', 'boots an AVD without -gpu host');
      }
    }
    for (const m of code.matchAll(CPU_FLAG)) report(lineAt(code, m.index), 'cpu-renderer', `"${m[0]}" selects a CPU renderer`);
    // The env opt-out committed into a script or CI file is a CPU default (ship review, red team).
    if (kind !== 'js') for (const m of code.matchAll(OPT_OUT_SET)) report(lineAt(code, m.index), 'cpu-renderer', `"${m[0]}" commits the per-run CPU opt-out`);
  }

  if (browserSites.length && !proof) {
    const first = browserSites[0];
    findings.push({ path: first.path, line: first.line, kind: 'no-renderer-proof', message: 'no test file reads UNMASKED_RENDERER_WEBGL and rejects SwiftShader', fix: FIX['no-renderer-proof']() });
  }
  return { findings, exempt, skipped, sites, notes };
}

function parseArgs(argv) {
  const opts = { root: '.', helpers: [], ignore: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--root' || a === '--helper' || a === '--ignore') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--root') opts.root = v;
      else if (a === '--helper') {
        if (!/^[A-Za-z_$][\w$]*$/.test(v)) throw new Error(`--helper ${v} is not an identifier`);
        opts.helpers.push(v);
      } else opts.ignore.push(v);
    } else throw new Error(`unknown option ${a}`);
  }
  if (!opts.helpers.length) opts.helpers = ['gpuLaunchArgs'];
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (!opts.help) {
      let isDir = false;
      try { isDir = statSync(opts.root).isDirectory(); } catch {}
      if (!isDir) throw new Error(`--root ${opts.root} is not a directory`);
    }
  } catch (e) {
    process.stderr.write(`gpu-guard: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const r = scan(opts);
  for (const n of r.notes) process.stderr.write(`${n}\n`);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ findings: r.findings, exempt: r.exempt, skipped: r.skipped, sites: r.sites }, null, 2)}\n`);
  } else {
    const out = [];
    for (const f of r.findings) out.push(`${f.path}:${f.line}: ${f.kind}: ${f.message}; fix: ${f.fix}`);
    for (const e of r.exempt) out.push(`exempt: ${e.path}:${e.line}: ${e.kind}: ${e.reason}`);
    for (const s of r.skipped) out.push(`skipped: ${s.path} (${s.bytes} bytes)`);
    out.push(`gpu-guard: ${r.findings.length} findings, ${r.sites} launch sites, ${r.exempt.length} exempt, ${r.skipped.length} skipped`);
    if (r.findings.length) out.push('gpu-guard: each finding names its fix; exemptions are the owner\'s call (test-speedup references/guards.md)');
    process.stdout.write(`${out.join('\n')}\n`);
  }
  return r.findings.length ? 1 : 0;
}

// Entry point check on real paths: Node resolves the main module through symlinks (macOS /var -> /private/var).
const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(SELF); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main();
