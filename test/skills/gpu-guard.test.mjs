// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// gpu-guard.mjs contract (TODO-050 guard contract, D1-D9). Fixtures are written to a temp dir per test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CPU_RENDERER } from '../../plugins/catscan/skills/test-speedup/scripts/gpu-guard.mjs';

const skill = fileURLToPath(new URL('../../plugins/catscan/skills/test-speedup/', import.meta.url));
const script = join(skill, 'scripts/gpu-guard.mjs');

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'gpu-guard-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const cli = (args, opts = {}) => spawnSync(process.execPath, [opts.script ?? script, ...args], { encoding: 'utf8', cwd: opts.cwd });
const scanJson = (root, ...args) => {
  const r = cli(['--root', root, '--json', ...args]);
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  return { ...JSON.parse(r.stdout), status: r.status, stderr: r.stderr };
};
const at = (out, kind) => out.findings.filter((f) => f.kind === kind).map((f) => `${f.path}:${f.line}`);
// A renderer smoke test, so trees with a browser site do not also report no-renderer-proof.
const PROOF = { 'e2e/gpu.spec.ts': "const r = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);\nexpect(r).not.toMatch(/SwiftShader/);\n" };

test('every launch form without the helper is reported on its own line; firefox contexts are no site', () => {
  const root = tree({ ...PROOF,
    'scripts/a.mjs': [
      "import { chromium, firefox, _electron } from 'playwright';",
      'await chromium.launch();',
      "await chromium.launchPersistentContext('', { headless: true });",
      'await chromium.launchServer();',
      "await _electron.launch({ args: ['main.js'] });",
      "await firefox.launchPersistentContext('');",
      'await puppeteer.launch();',
    ].join('\n'),
    'scripts/b.ts': "import { _electron as electron } from 'playwright';\nawait electron.launch({ args: ['.'] });\n",
  });
  const out = scanJson(root);
  assert.deepEqual(at(out, 'launch-without-helper'), ['scripts/a.mjs:2', 'scripts/a.mjs:3', 'scripts/a.mjs:4', 'scripts/a.mjs:5', 'scripts/a.mjs:7', 'scripts/b.ts:2']);
  assert.equal(out.status, 1);
  assert.match(out.findings[0].fix, /args: gpuLaunchArgs\(\)/);
});

test('a call that names the helper, or an identifier built from it, passes; a bare second launch does not', () => {
  const root = tree({ ...PROOF,
    'tools/bake.mjs': [
      "import { gpuLaunchArgs } from './gpu.mjs';",
      'await chromium.launch({ args: gpuLaunchArgs() });',
      'const args = gpuLaunchArgs();',
      'await chromium.launch({ headless: true, args });',
      'const opts = {',
      '  headless: true,',
      '  args: [...gpuLaunchArgs(), "--mute-audio"],',
      '};',
      'await chromium.launch(opts);',
      'await chromium.launch({ headless: true });',
    ].join('\n'),
    // Value: protects=an identifier built from another helper-derived one (two hops) counts as the helper;
    // fails_when=helperDerived stops after one pass; why_new=bake.mjs resolves in one hop; seam=none;
    // no_claim=none beyond protects (own file: no identifier named args, which would match the args: key)
    'tools/chain.mjs': "const gpu = gpuLaunchArgs();\nconst flags = [...gpu, '--mute-audio'];\nawait chromium.launch({ args: flags });\n",
    // An object key is no reference: `args:` must not match a derived identifier named `args` (ship Step 7 finding).
    'tools/keys.mjs': [
      'const args = gpuLaunchArgs();',
      "await chromium.launch({ args: ['--mute-audio'] });",
      "const opts = { args: ['--mute-audio'], 'headless': true };",
      'await chromium.launch(opts);',
      'await chromium.launch({ headless: true, args });',
      "await chromium.launch(process.env.CI ? args : { args: [] });",
    ].join('\n'),
  });
  const out = scanJson(root);
  assert.deepEqual(at(out, 'launch-without-helper'), ['tools/bake.mjs:10', 'tools/keys.mjs:2', 'tools/keys.mjs:4']);
  assert.equal(out.sites, 9);
});

test("a '**/*.spec.ts' string hides no launch, and lines stay true after a block comment", () => {
  const root = tree({ ...PROOF,
    'bench/run.ts': ["const testMatch = '**/*.spec.ts';", '/* one', '   two */', 'await chromium.launch(); // */'].join('\n'),
  });
  assert.deepEqual(at(scanJson(root), 'launch-without-helper'), ['bench/run.ts:4']);
});

test('aliased chromium launches are reported', () => {
  const root = tree({ ...PROOF,
    'a.mjs': "import { chromium as c } from '@playwright/test';\nawait c.launch();\n",
    'b.js': "const playwright = require('playwright');\nconst b = playwright.chromium;\nawait b.launchPersistentContext('');\n",
  });
  assert.deepEqual(at(scanJson(root), 'launch-without-helper'), ['a.mjs:2', 'b.js:3']);
});

test('a Playwright config needs the helper outside imports; an owner marker exempts only that kind', () => {
  const root = tree({ ...PROOF,
    'apps/a/playwright.config.ts': "import { gpuLaunchArgs } from '@x/build';\nexport default {};\n",
    'apps/b/playwright.e2e.config.ts': "import { gpuLaunchArgs } from '@x/build';\nexport default { use: { launchOptions: { args: gpuLaunchArgs() } } };\n",
    'apps/c/playwright.config.mjs': "// gpu-launch: WebKit only\nexport default {\n  projects: [{ use: { browserName: 'webkit', launchOptions: { args: ['--disable-gpu'] } } }],\n};\n",
  });
  const out = scanJson(root);
  assert.deepEqual(at(out, 'config-without-helper'), ['apps/a/playwright.config.ts:1']);
  assert.deepEqual(out.exempt.map((e) => `${e.path}:${e.kind}:${e.reason}`), ['apps/c/playwright.config.mjs:config-without-helper:WebKit only']);
  assert.deepEqual(at(out, 'cpu-renderer'), ['apps/c/playwright.config.mjs:3']);
});

test('an AVD boot needs -gpu host or a named flag constant, in shell and argument arrays', () => {
  const root = tree({
    'boot.sh': 'emulator -list-avds\n"$SDK/emulator/emulator" -avd Pixel -no-window\n',
    'ok.sh': 'emulator -avd Pixel -gpu host -no-window\n',
    'lib/a.js': "spawn(bin, ['-avd', name, '-no-window']);\n",
    'lib/b.js': "spawn(bin, ['-avd', name, '-gpu', 'host']);\n",
    'lib/c.js': "import { BOOT_FLAGS } from './flags.js';\nspawn(bin, ['-avd', name, ...BOOT_FLAGS]);\n",
  });
  assert.deepEqual(at(scanJson(root), 'emulator-without-gpu-host'), ['boot.sh:2', 'lib/a.js:1', 'lib/c.js:2']);
  const named = scanJson(root, '--helper', 'BOOT_FLAGS');
  assert.deepEqual(at(named, 'emulator-without-gpu-host'), ['boot.sh:2', 'lib/a.js:1']);
  assert.equal(at(named, 'no-renderer-proof').length, 0, 'emulator boots alone need no WebGL proof');
  // Value: protects=--helper is repeatable and every name counts; fails_when=a later --helper replaces earlier
  // ones; why_new=only single --helper runs above; seam=none; no_claim=none beyond protects
  assert.deepEqual(at(scanJson(root, '--helper', 'BOOT_FLAGS', '--helper', 'gpuLaunchArgs'), 'emulator-without-gpu-host'), ['boot.sh:2', 'lib/a.js:1']);
});

test('CPU renderer literals are reported; comments, the sandbox flag and an owner marker are not', () => {
  const root = tree({
    'a.mjs': [
      "const a = ['--use-angle=swiftshader', '--use-gl=swiftshader'];",
      "const b = '--enable-unsafe-swiftshader';",
      "const c = ['--disable-gpu'];",
      "app.commandLine.appendSwitch('disable-gpu');",
      'app.disableHardwareAcceleration();',
      "const d = ['--disable-gpu-sandbox'];",
      "// const e = ['--disable-gpu'];",
      "/* '--use-angle=swiftshader' */",
      "if (env.E2E_GPU === 'swiftshader') return ['--use-angle=swiftshader']; // gpu-launch: per-run env opt-out",
      '// gpu-launch:',
      "const f = ['--disable-gpu'];",
      // Value: protects=an owner marker on the line above exempts the next line (usage text contract);
      // fails_when=markerAt checks only the same line; why_new=a.mjs:9 has a same-line marker only; seam=none;
      // no_claim=none beyond protects
      '// gpu-launch: fixture holds CPU flags as data',
      "const g = ['--disable-gpu'];",
    ].join('\n'),
    'run.sh': 'emulator -avd P -gpu host\n# emulator -avd P -gpu swiftshader_indirect\nemulator -avd Q -gpu guest\necho hw.gpu.mode=auto\n',
    'ci.yml': 'steps:\n  - run: emu -avd P -gpu host -gpu lavapipe\n',
    'package.json': '{ "scripts": { "e2e": "chrome --disable-gpu" } }\n',
  });
  const out = scanJson(root);
  assert.deepEqual(at(out, 'cpu-renderer'), ['a.mjs:1', 'a.mjs:1', 'a.mjs:2', 'a.mjs:3', 'a.mjs:4', 'a.mjs:5', 'a.mjs:11', 'ci.yml:2', 'package.json:1', 'run.sh:3', 'run.sh:4']);
  assert.deepEqual(out.exempt.map((e) => `${e.path}:${e.line}:${e.reason}`), ['a.mjs:9:per-run env opt-out', 'a.mjs:13:fixture holds CPU flags as data']);
});

test('no-renderer-proof needs a test file with both tokens; a script holding them does not count', () => {
  const site = { 'scripts/shot.mjs': 'await chromium.launch({ args: gpuLaunchArgs() });\n' };
  const tool = { 'tools/probe.mjs': 'UNMASKED_RENDERER_WEBGL; /SwiftShader/;\n' };
  assert.deepEqual(at(scanJson(tree({ ...site, ...tool })), 'no-renderer-proof'), ['scripts/shot.mjs:1']);
  assert.deepEqual(scanJson(tree({ ...site, ...PROOF })).findings, []);
  assert.deepEqual(at(scanJson(tree({ ...site, 'test/gpu.test.js': '// UNMASKED_RENDERER_WEBGL SwiftShader\n' })), 'no-renderer-proof'), ['scripts/shot.mjs:1'], 'tokens in comments are no test');
  const empty = scanJson(tree({ 'a.md': '# none\n' }));
  assert.equal(empty.status, 0);
  assert.equal(empty.sites, 0);
});

// Ship review pass 1 (TODO-050): each row is a false negative the reviewers reproduced.
test('regex literals, CJS aliases, shell scripts without an extension, Makefiles and a committed opt-out', () => {
  const root = tree({ ...PROOF,
    'a.mjs': [
      "const rel = p.replace(/^\\/*/, '');",
      'await chromium.launch();',
      "const f = ['--disable-gpu'];",
      'if (/^https?:\\/\\//.test(u)) await chromium.launch();',
      'const half = total / 2; const third = x / 3;',
      'await chromium.launch();',
    ].join('\n'),
    'b.cjs': "const { chromium: c } = require('playwright');\nawait c.launch();\n",
    'bin/boot-emu': '#!/usr/bin/env bash\nemulator -avd Pixel -gpu swiftshader_indirect\n',
    'bin/shot': "#!/usr/bin/env node\nawait chromium.launch();\n",
    'bin/data': 'not a script --disable-gpu\n',
    'Makefile': 'e2e:\n\temulator -avd Pixel -no-window\n',
    'package.json': '{ "scripts": { "e2e": "E2E_GPU=swiftshader playwright test" } }\n',
    '.github/workflows/e2e.yml': 'env:\n  E2E_GPU: swiftshader # gpu-launch: GPU-less runner, owner 2026-11-16\n',
    'gpu.mjs': "if (env.E2E_GPU === 'swiftshader') return [];\n",
  });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0, 'git lists .github; the walk skips dot dirs');
  const out = scanJson(root);
  assert.deepEqual(at(out, 'launch-without-helper'), ['a.mjs:2', 'a.mjs:4', 'a.mjs:6', 'b.cjs:2', 'bin/shot:2']);
  assert.deepEqual(at(out, 'cpu-renderer'), ['a.mjs:3', 'bin/boot-emu:2', 'package.json:1']);
  assert.deepEqual(at(out, 'emulator-without-gpu-host'), ['Makefile:2', 'bin/boot-emu:2']);
  assert.deepEqual(out.exempt.map((e) => `${e.path}:${e.line}:${e.kind}`), ['.github/workflows/e2e.yml:2:cpu-renderer']);
});

test('text output: each finding carries its fix, then exemptions, skipped files and the summary', () => {
  const root = tree({
    'a.mjs': "await chromium.launch(); // gpu-launch: owner keeps SwiftShader for pixel-identical bakes\n\nawait puppeteer.launch();\n",
    'big.js': `// ${'x'.repeat(1024 * 1024)}\n`,
  });
  const r = cli(['--root', root]);
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^a\.mjs:3: launch-without-helper: puppeteer\.launch\(\) starts without GPU args from gpuLaunchArgs; fix: pass the helper's args/);
  assert.match(r.stdout, /^a\.mjs:3: no-renderer-proof: .*; fix: add the renderer smoke spec/m);
  assert.match(r.stdout, /^exempt: a\.mjs:1: launch-without-helper: owner keeps SwiftShader for pixel-identical bakes$/m);
  assert.match(r.stdout, /^skipped: big\.js \(\d+ bytes\)$/m);
  assert.match(r.stdout, /^gpu-guard: 2 findings, 2 launch sites, 1 exempt, 1 skipped$/m);
  assert.match(r.stderr, /no git file list .*walking the tree/);
});

test('usage: --help exits 0; bad options and roots exit 2 on stderr before any scan', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: node gpu-guard\.mjs/);
  for (const [args, why] of [[['--bogus'], /unknown option --bogus/], [['--root'], /--root needs a value/], [['--helper', '--json'], /--helper needs a value/],
    [['--helper', 'a-b'], /not an identifier/], [['--root', '/nonexistent/x'], /is not a directory/]]) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, why);
    assert.match(r.stderr, /usage:/);
    assert.equal(r.stdout, '');
  }
});

test('--ignore, node_modules, dot dirs, lockfiles and an unreadable file', () => {
  const root = tree({
    'fixtures/cpu.js': "const flags = ['--disable-gpu'];\n",
    'node_modules/x/index.js': 'chromium.launch();\n',
    '.cache/y.js': 'chromium.launch();\n',
    'package-lock.json': '{ "x": "--disable-gpu" }\n',
    'locked.js': 'chromium.launch();\n',
  });
  chmodSync(join(root, 'locked.js'), 0o000);
  const out = scanJson(root, '--ignore', 'fixtures/');
  assert.deepEqual(out.findings.map((f) => `${f.path}:${f.kind}`), ['locked.js:unreadable']);
  assert.match(out.findings[0].fix, /--ignore/);
});

test('in a git tree, ignored files are skipped and untracked ones scanned', () => {
  const root = tree({ '.gitignore': 'out/\n', 'out/gen.js': "x('--disable-gpu');\n", 'new.js': "x('--disable-gpu');\n", 'gone.js': "x('--disable-gpu');\n" });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  // Value: protects=a tracked file deleted in the work tree is neither read nor reported unreadable;
  // fails_when=the ENOENT skip is dropped and git ls-files -c lists the deleted path; why_new=no test deletes a
  // tracked file; seam=none; no_claim=none beyond protects
  assert.equal(spawnSync('git', ['add', 'gone.js'], { cwd: root }).status, 0);
  unlinkSync(join(root, 'gone.js'));
  const out = scanJson(root);
  assert.deepEqual(out.findings.map((f) => `${f.path}:${f.kind}`), ['new.js:cpu-renderer']);
  assert.equal(out.stderr, '');
});

test('a tracked symlink to a directory is skipped, not reported unreadable', () => {
  // Value: protects=git ls-files lists a symlinked dir (or gitlink) with no dot in its name, which the shebang
  // probe would open and fail on with EISDIR; fails_when=the isFile check before the read is dropped;
  // why_new=no test tracks a non-regular path; seam=none; no_claim=submodule checkouts are covered only by the same check
  const root = tree({ 'lib/a.js': 'ok();\n', 'new.js': "x('--disable-gpu');\n" });
  symlinkSync('lib', join(root, 'vendor'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root }).status, 0);
  const out = scanJson(root);
  assert.deepEqual(out.findings.map((f) => `${f.path}:${f.kind}`), ['new.js:cpu-renderer']);
});

test('a vendored copy skips itself and runs from the project root by default', () => {
  const root = tree({ ...PROOF, 'tests/e2e.spec.ts': 'await chromium.launch({ args: gpuLaunchArgs() });\n' });
  copyFileSync(script, join(root, 'gpu-guard.mjs'));
  mkdirSync(join(root, 'tools'));
  copyFileSync(script, join(root, 'tools/gpu-guard.mjs'));
  const r = cli([], { cwd: root, script: join(root, 'tools/gpu-guard.mjs') });
  assert.equal(r.status, 1, 'the other copy holds CPU flags as data');
  assert.ok(r.stdout.split('\n').every((l) => !l.startsWith('tools/gpu-guard.mjs')), r.stdout);
  assert.equal(cli(['--ignore', 'gpu-guard.mjs'], { cwd: root, script: join(root, 'tools/gpu-guard.mjs') }).status, 0);
});

test('the renderer regex quoted in web-e2e.md is the one the guard exports', () => {
  const doc = readFileSync(join(skill, 'references/web-e2e.md'), 'utf8');
  const quoted = doc.match(/const CPU_RENDERER = \/(.+)\/i;/);
  assert.ok(quoted, 'web-e2e.md quotes CPU_RENDERER');
  assert.equal(quoted[1], CPU_RENDERER.source);
  for (const s of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)']) assert.match(s, CPU_RENDERER);
  assert.doesNotMatch('ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)', CPU_RENDERER);
});
