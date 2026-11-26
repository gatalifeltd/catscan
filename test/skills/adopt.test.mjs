// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// catscan-adopt scripts (TODO-006 T3, D20-D27): find-points, find-catscan and check-diffs. Install-free.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../../plugins/catscan/skills/catscan-adopt/scripts/', import.meta.url));
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, env: gitEnv, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const put = (root, files) => { for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); } };
const node = (script, args, opts = {}) => spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: 'utf8', ...opts });

function repoWith(files) {
  const root = tmp('adopt-repo-');
  git(root, 'init', '-q');
  put(root, files);
  git(root, 'add', '-A', '-f');
  git(root, 'commit', '-qm', 'base');
  return root;
}

// ---------- find-points ----------

const POINTS = {
  'e2e/menu.spec.ts': "await page.screenshot({ path: 'shots/menu.png' });\nawait expect(page).toHaveScreenshot('menu.png');\n",
  'flows/home.yaml': '- takeScreenshot: shots/${PLATFORM}/home.${LOCALE}\n- takeScreenshot: shots/ios/about\n',
  'src/game.js': "ctx.fillText('Play', 10, 10);\nthis.add.text(0, 0, 'Score');\n",
  'AGENTS.md': 'After the run, open the screenshot and check the title.\n',
  'scripts/shots.sh': 'xcrun simctl io booted screenshot out.png\nadb exec-out screencap -p > a.png\n',
  'node_modules/lib/draw.js': "ctx.fillText('x', 0, 0);\n",
  'dist/bundle.js': "ctx.fillText('x', 0, 0);\n",
  'docs/notes.md': 'We call page.screenshot( here.\n',
  'store/de/home.png': 'png', 'store/fr/home.png': 'png', 'art/logo.png': 'png',
  'app/index.html': "<script>\nctx.fillText(s.play, 400, 300);\n</script>\n",
  'e2e/img.spec.ts': "expect(await page.screenshot()).toMatchSnapshot('menu.png');\nexpect(data).toMatchSnapshot();\n",
  'e2e/detox.js': "await device.takeScreenshot('home');\n",
  'e2e/test_menu.py': "page.screenshot(path='shots/menu.png')\n",
  'ios/UITests.swift': 'let shot = XCUIScreen.main.screenshot()\n',
  'fastlane/Fastfile': 'lane :shots do\n  capture_ios_screenshots\n  snapshot\nend\n',
  'lib/cache.rb': 'def snapshot(x) = x\n',
  'scripts/notes.js': '// the word screencap alone is not a capture\n',
  'shots/main-menu-de.png': 'png', 'shots/main-menu-fr.png': 'png',
  'one/de/a.png': 'png', 'assets/id/x.png': 'png', 'assets/fr/x.png': 'png',
  'test-results/de/a.png': 'png', 'test-results/fr/a.png': 'png',
  'src/ü/a:1:b.js': "ctx.strokeText('Weiter', 0, 0);\n",
};
// A user's display settings must not change what find-points parses (TODO-006 review).
const NOISY_CONFIG = [['color.ui', 'always'], ['grep.column', 'true'], ['grep.fullName', 'true'], ['core.quotePath', 'true']];

const flat = (out) => out.groups.flatMap((g) => g.examples.map((e) => `${g.kind} ${g.producer} ${e.file}:${e.line}`)).sort();

test('find-points lists each candidate kind with file and line from the committed tree', () => {
  const repo = repoWith(POINTS);
  for (const [k, v] of NOISY_CONFIG) git(repo, 'config', k, v);
  const r = node('find-points.mjs', [repo, '--all']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.head, git(repo, 'rev-parse', 'HEAD'));
  assert.equal(out.dirty, false);
  assert.deepEqual(flat(out), [
    'canvas-text canvas-fillText app/index.html:2',
    'canvas-text canvas-fillText src/game.js:1',
    'canvas-text canvas-fillText src/ü/a:1:b.js:1',
    'canvas-text engine-text-object src/game.js:2',
    'locale-folder committed-locale-shots shots:0',
    'locale-folder committed-locale-shots store:0',
    'locale-folder maestro-takeScreenshot flows/home.yaml:1',
    'pixel-text agent-reads-image AGENTS.md:1',
    'pixel-text pixel-snapshot e2e/img.spec.ts:1',
    'pixel-text pixel-snapshot e2e/menu.spec.ts:2',
    'unchecked-shot adb-screencap scripts/shots.sh:2',
    'unchecked-shot detox-takeScreenshot e2e/detox.js:1',
    'unchecked-shot fastlane-screenshots fastlane/Fastfile:2',
    'unchecked-shot fastlane-screenshots fastlane/Fastfile:3',
    'unchecked-shot maestro-takeScreenshot flows/home.yaml:2',
    'unchecked-shot playwright-screenshot e2e/img.spec.ts:1',
    'unchecked-shot playwright-screenshot e2e/menu.spec.ts:1',
    'unchecked-shot playwright-screenshot e2e/test_menu.py:1',
    'unchecked-shot simctl-screenshot scripts/shots.sh:1',
    'unchecked-shot xcuitest-screenshot ios/UITests.swift:1',
  ]);
  assert.deepEqual(out.counts, { 'canvas-text': 4, 'locale-folder': 3, 'pixel-text': 3, 'unchecked-shot': 10 });
});

test('find-points ignores uncommitted edits and reports the tree dirty', () => {
  const repo = repoWith(POINTS);
  const before = JSON.parse(node('find-points.mjs', [repo, '--all']).stdout);
  writeFileSync(join(repo, 'untracked.txt'), 'x\n');
  assert.equal(JSON.parse(node('find-points.mjs', [repo]).stdout).dirty, true, 'an untracked file makes the tree dirty');
  writeFileSync(join(repo, 'src/game.js'), 'nothing drawn here\n');
  writeFileSync(join(repo, 'src/new.js'), "ctx.strokeText('New', 0, 0);\n");
  const r = node('find-points.mjs', [repo, '--all']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dirty, true);
  assert.deepEqual(flat(out), flat(before));
});

test('find-points writes nothing in the repo, even with fsmonitor on and a stat-dirty tree', () => {
  const repo = repoWith(POINTS);
  git(repo, 'config', 'core.fsmonitor', 'true');
  git(repo, 'config', 'core.untrackedCache', 'true');
  const t = new Date(Date.now() - 60000);
  utimesSync(join(repo, 'src/game.js'), t, t); // same content, new stat: a plain git status would refresh the index
  const before = snapshot(repo);
  assert.equal(node('find-points.mjs', [repo]).status, 0);
  assert.deepEqual(snapshot(repo), before);
});

test('find-points drops a candidate in a file over 1 MB', () => {
  const big = `ctx.fillText('x', 0, 0);\n${'// pad\n'.repeat(160000)}`;
  const out = JSON.parse(node('find-points.mjs', [repoWith({ 'gen/big.js': big, 'src/a.js': "ctx.fillText('y', 0, 0);\n" }), '--all']).stdout);
  assert.deepEqual(flat(out), ['canvas-text canvas-fillText src/a.js:1']);
});

test('find-points finds the adopt fixture points the fixture test then edits', () => {
  const fixture = fileURLToPath(new URL('../../examples/adopt-fixture/', import.meta.url));
  const repo = tmp('adopt-fixture-copy-');
  cpSync(fixture, repo, { recursive: true, filter: (p) => !/[/\\]\.run-/.test(p) });
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture');
  const out = JSON.parse(node('find-points.mjs', [repo, '--all']).stdout);
  const got = flat(out);
  assert.ok(got.includes('canvas-text canvas-fillText app/index.html:19'), got.join('\n'));
  assert.ok(got.some((l) => l.startsWith('locale-folder playwright-screenshot tests/menu.pw.ts:')), got.join('\n'));
});

test('find-points groups a folder and caps examples at 3 without --all', () => {
  const lines = Array.from({ length: 5 }, (_, i) => `- takeScreenshot: shots/s${i}`).join('\n');
  const out = JSON.parse(node('find-points.mjs', [repoWith({ 'flows/a.yaml': lines })]).stdout);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].lines, 5);
  assert.equal(out.groups[0].examples.length, 3);
});

test('find-points keeps every line of a video group, so each recording in one suite file is seen (TODO-102)', () => {
  // Value: protects=adopt sees each recording scenario of a device suite; fails_when=a fourth screenrecord in one file is cut to the 3-example cap.
  const rec = Array.from({ length: 5 }, (_, i) => `device.adb(['shell', 'screenrecord', '/sdcard/r${i}.mp4']);`).join('\n');
  const out = JSON.parse(node('find-points.mjs', [repoWith({ 'e2e-device/suite.mjs': rec })]).stdout);
  const v = out.groups.filter((g) => g.kind === 'video');
  assert.equal(v.length, 1);
  assert.equal(v[0].lines, 5);
  assert.deepEqual(v[0].examples.map((e) => e.line), [1, 2, 3, 4, 5]);
});

test('find-points puts a screenshot attached to the report in its own group, apart from saved shots (TODO-102)', () => {
  // Value: protects=adopt lists an attached-only shot as a dropped line; fails_when=it hides in the saved-shot group past the example cap.
  const spec = [
    "await page.screenshot({ path: test.info().outputPath('a.png') });",
    "await page.screenshot({ path: test.info().outputPath('b.png') });",
    "await page.screenshot({ path: test.info().outputPath('c.png') });",
    "await info.attach('home', { body: await page.screenshot(), contentType: 'image/png' });",
    "await testInfo.attach('pic', {",
    "  body: await page.screenshot(),",
    '});',
    "await info.attach('kept', { body: await page.screenshot({ path: 'kept.png' }) });",
    "await info.attach(`home-${locale}.png`, { body: await page.screenshot() });",
    "await testInfo.attach('split', {",
    '  body:',
    '    await page.screenshot(),',
    '});',
    'await page.screenshot()',
    "await fs.writeFile('d.png',",
    '  await page.screenshot(),',
    ');',
    "await testInfo.attach('paren', {",
    '  body: (',
    '    await page.screenshot()',
    '  ),',
    '});',
    'const body: Buffer = await page.screenshot({ fullPage: true });',
    'let body: Uint8Array | Buffer = await page.screenshot();',
    '  body: Promise<Buffer> = page.screenshot();',
    '  body: Map<string, Buffer>= page.screenshot();',
    "await info.attach('wrap', { body: Buffer.from(await page.screenshot()) });",
    "await testInfo.attach('hero', {",
    "  body: await page.locator('#hero').screenshot(),",
    '});',
    "await testInfo.attach('hero2', {",
    '  body:',
    "    await page.getByRole('main').screenshot(),",
    '});',
    "await testInfo.attach('full', {",
    '  body:',
    '    await page.screenshot({ fullPage: true }),',
    '});',
    "await info.attach('memo', { body: cached ??= await page.screenshot() });",
    "await info.attach('multi', { body: await page.screenshot({",
    "  fullPage: true, path: 'multi.png',",
    '}) });',
    "path = 'x'; await info.attach('np', { body: await page.screenshot() });",
    "await info.attach('cmp', { body: n >= 0 ? await page.screenshot() : buf });",
    "await info.attach('loc', { body: await page.locator('text=:)').screenshot({",
    "  path: 'loc.png' }) });",
  ].join('\n');
  const out = JSON.parse(node('find-points.mjs', [repoWith({ 'e2e/a.spec.ts': spec })]).stdout);
  const att = out.groups.find((g) => g.producer === 'report-attachment');
  assert.ok(att, JSON.stringify(out.groups.map((g) => g.producer)));
  assert.deepEqual(att.examples.map((e) => e.line), [4, 6, 9, 12, 20, 27, 29, 33, 37, 39, 43, 44]);
  assert.ok(out.groups.every((g) => g.kind !== 'locale-folder'), 'an attachment named per locale is still no file');
  // A screenshot with a path saves a file, attached or not; a bare call outside a `body:` field stays a saved shot.
  // A typed `body:` declaration (variable or class property, union type or not) is no attachment field.
  assert.equal(out.groups.find((g) => g.producer === 'playwright-screenshot').lines, 12);
  // Python passes the path as a keyword: an attached call that saves a file stays a saved shot.
  const py = JSON.parse(node('find-points.mjs', [repoWith({ 'tests/test_a.py': 'allure.attach(page.screenshot(path=f"shots/{lang}/home.png"), name="home")\nallure.attach(page.screenshot(), name="x")\n' })]).stdout);
  assert.deepEqual(py.groups.find((g) => g.producer === 'report-attachment').examples.map((e) => e.line), [2]);
  // <repo> as a subfolder: the line above is still read, so the split `body:` stays an attachment.
  const sub = JSON.parse(node('find-points.mjs', [join(repoWith({ 'app/e2e/a.spec.ts': spec }), 'app')]).stdout);
  assert.deepEqual(sub.groups.find((g) => g.producer === 'report-attachment').examples.map((e) => e.line), [4, 6, 9, 12, 20, 27, 29, 33, 37, 39, 43, 44]);
});

// ---------- find-points: shipped locales and setup point 00 (TODO-065 T7) ----------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// A fake catscan: catscan's real catalog discovery (a symlinked core-js), canned languages and doctor replies, so
// the reader and setup logic is tested without Tesseract on or off this Mac.
function fakeCatscan({ oldCore = false } = {}) {
  const d = tmp('adopt-fake-catscan-');
  mkdirSync(join(d, 'node_modules', '@catscan'), { recursive: true });
  if (oldCore) put(d, { 'node_modules/@catscan/core-js/src/results.js': 'module.exports = {};\n' });
  else spawnSync('ln', ['-s', join(REPO_ROOT, 'packages', 'core-js'), join(d, 'node_modules', '@catscan', 'core-js')]);
  put(d, { 'bin/catscan.js': `
const a = process.argv.slice(2);
const TESS = ['el', 'he', 'hr', 'is'];
if (a[0] === 'languages') console.log(JSON.stringify({ languages: ['de', 'en', 'fr', 'ja', 'it', 'id'].map((locale) => ({ locale })), fallback_locales: [...TESS, 'sr-Latn'] }));
else if (a[0] === 'doctor') {
  const list = a[a.indexOf('--expect-locales') + 1].split(',');
  // As the real binary does with no Tesseract at all: the brew fix, even when TESSDATA_PREFIX is set.
  const fix = 'brew install tesseract tesseract-lang (about 650 MB), then rerun the same command';
  const requested = list.map((locale) => TESS.includes(locale.split('-')[0])
    ? { locale, reader: 'tesseract', fallback_locale: locale, ok: false, error: { code: 'reader-missing', message: 'catscan reads the locale ' + locale + ' with Tesseract, which is not installed on this Mac.', hint: fix } }
    : { locale, reader: 'vision', ok: true });
  console.log(JSON.stringify({ ok: !requested.some((r) => !r.ok), fallback: { fix }, requested }));
  process.exitCode = requested.some((r) => !r.ok) ? 1 : 0;
}
` });
  return JSON.stringify([process.execPath, join(d, 'bin', 'catscan.js')]);
}
const LOCALE_FILES = {
  'ios/Localizable.xcstrings': JSON.stringify({ sourceLanguage: 'en', strings: { play: { localizations: { de: { stringUnit: { state: 'translated', value: 'Spielen' } }, el: { stringUnit: { state: 'translated', value: 'Παίξε' } } } } } }),
  'android/res/values-hr/strings.xml': '<resources/>',
  'lib/l10n/app_ja.arb': '{"@@locale": "ja"}',
  'po/ja.po': 'msgid ""\nmsgstr ""\n"Language: ja\\n"\n',
  'playwright.config.ts': "export default { use: { locale: 'fr-FR' } };\n",
  'fastlane/Snapfile': 'languages([\n  "en-US",\n  "it"\n])\n',
  'flows/home.yaml': 'appId: x\nenv:\n  LOCALE: he\n---\n- launchApp\n',
  'shots/is/home.png': 'png', 'shots/de/home.png': 'png',
  'package.json': '{"name": "app"}',
};
const pointsOf = (repo, catscan, env = {}) => {
  const r = node('find-points.mjs', [repo, '--catscan', catscan], { env: { ...process.env, CATSCAN_TESSERACT: '', TESSDATA_PREFIX: '', ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('find-points lists each shipped locale with its sources and reader, and setup point 00 with the brew command', () => {
  // Value: protects=adopt finds every locale a project ships and proposes the exact install for the Tesseract ones; fails_when=a catalog, config or folder source is missed, a Vision locale gets point 00, or the command differs from the fix; why_new=T7; seam=a fake catscan (real core-js discovery); no_claim=real doctor rows (next test)
  const repo = repoWith(LOCALE_FILES);
  const before = git(repo, 'status', '--porcelain', '--ignored');
  const catscan = fakeCatscan();
  const out = pointsOf(repo, catscan);
  const src = Object.fromEntries(out.locales.map((l) => [l.locale, l.sources.map((x) => `${x.kind} ${x.file}`)]));
  assert.deepEqual(src, {
    de: ['catalog ios/Localizable.xcstrings', 'screenshots shots'], el: ['catalog ios/Localizable.xcstrings'], en: ['catalog ios/Localizable.xcstrings'],
    'en-US': ['fastlane-languages fastlane/Snapfile'], 'fr-FR': ['playwright-locale playwright.config.ts'], he: ['maestro-env flows/home.yaml'],
    hr: ['catalog android/res/values-hr/strings.xml'], is: ['screenshots shots'], it: ['fastlane-languages fastlane/Snapfile'], ja: ['catalog lib/l10n/app_ja.arb', 'catalog po/ja.po'],
  });
  assert.deepEqual(out.locales.filter((l) => l.reader === 'tesseract').map((l) => [l.locale, l.reads_now]), [['el', false], ['he', false], ['hr', false], ['is', false]]);
  assert.deepEqual(out.setup, { point: '00', locales: ['el', 'he', 'hr', 'is'], fix: 'brew install tesseract tesseract-lang (about 650 MB), then rerun the same command',
    command: 'brew install tesseract tesseract-lang', override: null, check: `${JSON.parse(catscan).join(' ')} doctor --expect-locales el,he,hr,is` });
  assert.equal(git(repo, 'status', '--porcelain', '--ignored'), before, 'a dry run writes nothing in the repo');
});

test('find-points: an uncommitted catalog adds no locale, a Vision-only repo has no point 00, an override never gets brew', () => {
  // Value: protects=adopt reads the committed tree and never proposes brew where it would not help; fails_when=a dirty el catalog adds el, point 00 appears for Vision locales, or TESSDATA_PREFIX still yields a brew command; why_new=T7, D6; seam=fake catscan; no_claim=none
  const catscan = fakeCatscan();
  const vision = repoWith({ 'web/de.json': '{}', 'web/fr.json': '{}', 'lib/l10n/app.arb': '{}',
    'ios/Localizable.xcstrings': JSON.stringify({ sourceLanguage: 'de', strings: { a: { localizations: { 'de x': { stringUnit: { state: 'translated', value: 'A' } } } } } }) });
  put(vision, { 'web/el.json': '{}' });
  const v = pointsOf(vision, catscan);
  assert.equal(v.dirty, true);
  // An odd catalog key is listed with no reader and never breaks the doctor call for the others.
  assert.deepEqual(v.locales.map((l) => [l.locale, l.reader]), [['de', 'vision'], ['de x', null], ['fr', 'vision']]);
  assert.equal(v.setup, null);
  assert.deepEqual(v.catalog_warnings, [
    'ios/Localizable.xcstrings: its locale "de x" is not a language this catscan knows. Fix: name the file or folder after the locale it ships, or leave it out of --catalog; check it is a catalog at all.',
    'cannot read the locale of the catalog lib/l10n/app.arb']);
  // The override guard: the binary still says brew (no Tesseract at all), but brew cannot fill TESSDATA_PREFIX.
  const tess = repoWith({ 'web/de.json': '{}', 'web/el.json': '{}' });
  const o = pointsOf(tess, catscan, { TESSDATA_PREFIX: '/data/tess' });
  assert.deepEqual([o.setup.command, o.setup.override], [null, 'TESSDATA_PREFIX']);
  assert.match(o.setup.fix, /^brew install tesseract tesseract-lang/);
  assert.equal(pointsOf(tess, catscan).setup.command, 'brew install tesseract tesseract-lang', 'without the override the same fix is the command');
  // A catscan without the shared discovery: folders and configs still count, the catalogs are named as not read.
  const old = pointsOf(repoWith({ ...LOCALE_FILES }), fakeCatscan({ oldCore: true }));
  assert.deepEqual(old.locales.map((l) => l.locale), ['de', 'en-US', 'fr-FR', 'he', 'is', 'it']);
  assert.match(old.notes.join('\n'), /no shared catalog discovery.*catalogs were not read/);
});

// find-points against the real, built catscan is in test/adopt.test.js: it needs npm ci and npm run build,
// which the macOS job has and the docs job (skills:check) does not.

test('find-points exits 2 on a --catscan value that is not a command array', () => {
  const repo = repoWith({ 'a.txt': 'a\n' });
  for (const bad of ['nope', '[]', '[1]', '{"a":1}']) {
    const r = node('find-points.mjs', [repo, '--catscan', bad]);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /--catscan needs the command array/);
  }
});

test('find-points exits 2 on a non-repo path, a bad rev and an unknown flag', () => {
  const repo = repoWith({ 'a.js': 'x\n' });
  for (const args of [[tmp('not-repo-')], [repo, '--rev', 'nope'], [repo, '--bogus'], []]) {
    const r = node('find-points.mjs', args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /usage: node find-points\.mjs/);
  }
});

// ---------- find-catscan ----------

const doctor = (ok, version) => JSON.stringify({ ok, binary: { version }, checks: ok ? [] : [{ name: 'binary', ok: false, value: 'not found', advice: 'build it' }] });
function shim(dir, name, ok, version) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n[ "$1 $2" = "doctor --json" ] || exit 9\necho '${doctor(ok, version)}'\n${ok ? '' : 'exit 1\n'}`);
  chmodSync(p, 0o755);
  return p;
}
function checkoutDir(ok, version) {
  const d = tmp('adopt-checkout-');
  put(d, { 'bin/catscan.js': `if (process.argv.slice(2).join(' ') !== 'doctor --json') process.exit(9);\nconsole.log(${JSON.stringify(doctor(ok, version))});\n` });
  return d;
}
function world({ local, global }) {
  const project = tmp('adopt-project-');
  const bin = tmp('adopt-path-');
  if (local) shim(join(project, 'node_modules/.bin'), 'catscan', local === 'ok', 'local');
  if (global) shim(bin, 'catscan', global === 'ok', 'global');
  return { project, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CATSCAN_CHECKOUT: '' } };
}
// A copy outside any checkout, so the lab checkout this file sits in is never the plugin candidate (TODO-087 T7).
const loose = join(tmp('adopt-loose-'), 'find-catscan.mjs');
cpSync(join(scripts, 'find-catscan.mjs'), loose);
const runFind = (script, args, env) => { const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env }); return { ...r, out: r.stdout ? JSON.parse(r.stdout) : null }; };
const find = (args, env) => runFind(loose, args, env);

test('find-catscan: an explicit --checkout wins over local and global', () => {
  const w = world({ local: 'ok', global: 'ok' });
  const r = find(['--checkout', checkoutDir(true, 'co'), '--project', w.project], w.env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.form, 'checkout');
  assert.equal(r.out.version, 'co');
  assert.equal(r.out.command[0], process.execPath);
});

test('find-catscan: local beats global; a failing doctor is skipped with its reason', () => {
  let w = world({ local: 'ok', global: 'ok' });
  let r = find(['--project', w.project], w.env);
  assert.deepEqual([r.status, r.out.form, r.out.version], [0, 'local', 'local']);
  w = world({ local: 'bad', global: 'ok' });
  r = find(['--project', w.project], w.env);
  assert.deepEqual([r.status, r.out.form, r.out.version], [0, 'global', 'global']);
  assert.equal(r.out.skipped.length, 1);
  assert.match(r.out.skipped[0].reason, /doctor binary: not found - try: build it/);
});

test('find-catscan: CATSCAN_CHECKOUT is tried last', () => {
  const w = world({ local: 'bad' });
  const r = find(['--project', w.project], { ...w.env, CATSCAN_CHECKOUT: checkoutDir(true, 'env') });
  assert.deepEqual([r.status, r.out.form, r.out.version], [0, 'checkout', 'env']);
});

test('find-catscan: none usable exits 1 and lists every candidate', () => {
  const w = world({ local: 'bad', global: 'bad' });
  const r = find(['--checkout', tmp('empty-'), '--project', w.project], w.env);
  assert.equal(r.status, 1);
  assert.equal(r.out.form, null);
  assert.deepEqual(r.out.skipped.map((s) => s.form), ['checkout', 'local', 'global']);
  assert.match(r.out.skipped[0].reason, /no bin\/catscan\.js/);
  assert.match(r.stderr, /no usable catscan \(3 tried\)/);
});

test('find-catscan runs a project binary only with --project; a non-JSON doctor is skipped', () => {
  const w = world({ local: 'ok', global: 'ok' });
  let r = find([], w.env);
  assert.deepEqual([r.status, r.out.form], [0, 'global'], 'no --project: the repo binary is not run');
  const garbage = join(w.project, 'node_modules/.bin/catscan');
  writeFileSync(garbage, '#!/bin/sh\necho "not json"\n');
  r = find(['--project', w.project], w.env);
  assert.deepEqual([r.status, r.out.form], [0, 'global']);
  assert.match(r.out.skipped[0].reason, /doctor --json printed no JSON \(exit 0\)/);
  const co = checkoutDir(false, 'co');
  r = find(['--checkout', co], { ...w.env, PATH: '/usr/bin:/bin', CATSCAN_CHECKOUT: co });
  assert.equal(r.out.skipped.length, 1, 'the same checkout from flag and env is probed once');
});

test('find-catscan exits 2 on a bad flag', () => {
  for (const args of [['--checkout'], ['--nope'], ['--project', '--checkout']]) {
    const r = node('find-catscan.mjs', args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: node find-catscan\.mjs/);
  }
});

// ---------- check-diffs ----------

const BASE = { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n', '.gitignore': 'shots/\n', 'shots/x.png': 'png' };
function diffOf(repo, file, content) {
  const before = readFileSync(join(repo, file), 'utf8');
  writeFileSync(join(repo, file), content);
  const d = spawnSync('git', ['diff', '--', file], { cwd: repo, encoding: 'utf8', env: gitEnv }).stdout;
  writeFileSync(join(repo, file), before);
  return d;
}
function plan(diffs) {
  const p = tmp('adopt-plan-');
  mkdirSync(join(p, 'diffs'));
  diffs.forEach((d, i) => writeFileSync(join(p, 'diffs', `0${i + 1}-point.diff`), d));
  return p;
}
function snapshot(repo) {
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); const s = statSync(p); return s.isDirectory() ? walk(p) : [`${p} ${s.mtimeMs} ${s.size}`]; });
  return {
    status: spawnSync('git', ['status', '--porcelain', '--ignored'], { cwd: repo, encoding: 'utf8', env: { ...gitEnv, GIT_OPTIONAL_LOCKS: '0' } }).stdout,
    index: createHash('sha256').update(readFileSync(join(repo, '.git/index'))).digest('hex'),
    files: walk(repo).sort(),
  };
}
const checkDiffs = (...args) => spawnSync('bash', [join(scripts, 'check-diffs.sh'), ...args], { encoding: 'utf8' });

test('check-diffs passes diffs that apply in order and leaves the repo untouched', () => {
  const repo = repoWith(BASE);
  git(repo, 'rm', '-q', '--cached', 'shots/x.png');
  git(repo, 'commit', '-qm', 'untrack shots');
  const d1 = diffOf(repo, 'a.txt', 'one\nTWO\nthree\n');
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n');
  git(repo, 'add', 'a.txt'); // the second point is made on top of the first
  const d2 = diffOf(repo, 'a.txt', 'one\nTWO\nthree\nfour\n');
  git(repo, 'reset', '-q', 'a.txt');
  writeFileSync(join(repo, 'a.txt'), 'local edit\n'); // dirty tree: the diffs are checked against the commit
  const p = plan([d1, d2]);
  const before = snapshot(repo);
  const r = checkDiffs(repo, p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok 01-point\.diff \+1 -1 sha256=[0-9a-f]{64}$/m);
  assert.match(r.stdout, /^ok 02-point\.diff \+1 -0 sha256=/m);
  assert.match(r.stdout, /2 diffs apply together at [0-9a-f]{40}/);
  assert.deepEqual(snapshot(repo), before);
});

test('check-diffs fails a diff that does not apply and two diffs that conflict only together', () => {
  const repo = repoWith(BASE);
  const bad = diffOf(repo, 'b.txt', 'B\n').replace('-b', '-not-b');
  let r = checkDiffs(repo, plan([bad]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAIL 01-point\.diff/);
  const d1 = diffOf(repo, 'a.txt', 'one\nTWO\nthree\n');
  const d2 = diffOf(repo, 'a.txt', 'one\n2\nthree\n');
  for (const d of [d1, d2]) assert.equal(checkDiffs(repo, plan([d])).status, 0);
  r = checkDiffs(repo, plan([d1, d2]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAIL 02-point\.diff: does not apply/);
  assert.match(r.stderr, /a\.txt/);
});

test('check-diffs ignores export-ignore and an inherited GIT_DIR/GIT_INDEX_FILE, and leaves the repo untouched', () => {
  const repo = repoWith({ ...BASE, 'tests/x.txt': 'x\n', '.gitattributes': '/tests export-ignore\n*.txt filter=nope\n' });
  const p = plan([diffOf(repo, 'tests/x.txt', 'y\n')]);
  const before = snapshot(repo);
  const r = spawnSync('bash', [join(scripts, 'check-diffs.sh'), repo, p], { encoding: 'utf8',
    env: { ...process.env, GIT_DIR: join(repo, '.git'), GIT_INDEX_FILE: join(repo, '.git/index'), GIT_WORK_TREE: repo } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 diffs apply together/);
  assert.deepEqual(snapshot(repo), before);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1');
  // A sha256 default in the user's git config must not break a sha1 target (the scratch repo takes the target's format).
  const cfg = join(tmp('gitcfg-'), 'config');
  writeFileSync(cfg, '[init]\n\tdefaultObjectFormat = sha256\n');
  const r2 = spawnSync('bash', [join(scripts, 'check-diffs.sh'), repo, p], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: cfg } });
  assert.equal(r2.status, 0, r2.stderr);
  // ...and a sha256 target works under a sha1 default.
  const r256 = tmp('adopt-sha256-');
  git(r256, 'init', '-q', '--object-format=sha256');
  put(r256, BASE); git(r256, 'add', '-A'); git(r256, 'commit', '-qm', 'base');
  const r3 = checkDiffs(r256, plan([diffOf(r256, 'b.txt', 'B\n')]));
  assert.equal(r3.status, 0, r3.stderr);
  assert.match(r3.stdout, /apply together at [0-9a-f]{64}/);
});

test('check-diffs reads the commit from <plan>/commit and exits 2 on usage errors', () => {
  const repo = repoWith(BASE);
  const first = git(repo, 'rev-parse', 'HEAD');
  const d = diffOf(repo, 'b.txt', 'B\n');
  writeFileSync(join(repo, 'b.txt'), 'changed\n');
  git(repo, 'commit', '-qam', 'move on');
  const p = plan([d]);
  assert.equal(checkDiffs(repo, p).status, 1, 'HEAD moved past the diff');
  writeFileSync(join(p, 'commit'), `${first}\r\n`); // a plan written on Windows
  assert.equal(checkDiffs(repo, p).status, 0);
  const empty = tmp('emptydiffs-');
  mkdirSync(join(empty, 'diffs'));
  for (const args of [[repo], [tmp('nr-'), p], [repo, tmp('nodiffs-')], [repo, empty], [repo, p, 'nope']]) {
    const r = checkDiffs(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: check-diffs\.sh/);
  }
});

test('check-diffs: an experimental diff numbered after the default ones applies last; named after its point it would apply first (TODO-086 D13)', () => {
  // Value: protects=the experimental diff naming in checks.md applies after the diff it builds on; fails_when=the naming or check-diffs' name order changes; why_new=D13; seam=none; no_claim=a real plan
  const repo = repoWith(BASE);
  const d1 = diffOf(repo, 'a.txt', 'one\nTWO\nthree\n');
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n');
  git(repo, 'add', 'a.txt');
  const exp = diffOf(repo, 'a.txt', 'one\nTWO\nthree\nexperimental\n');
  git(repo, 'reset', '-q', '--hard');
  const p = tmp('adopt-plan-');
  mkdirSync(join(p, 'diffs'));
  writeFileSync(join(p, 'diffs', '01-home.diff'), d1);
  writeFileSync(join(p, 'diffs', '02-experimental-home-fit.diff'), exp);
  const r = checkDiffs(repo, p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok 01-home\.diff[\s\S]*^ok 02-experimental-home-fit\.diff/m);
  rmSync(join(p, 'diffs', '02-experimental-home-fit.diff'));
  writeFileSync(join(p, 'diffs', '01-home-experimental-fit.diff'), exp); // '-' sorts before '.': applies before 01-home
  assert.equal(checkDiffs(repo, p).status, 1);
});

// ---------- list-checks (TODO-086) ----------

const CORE = fileURLToPath(new URL('../../packages/core-js/src/', import.meta.url));
const listChecks = (...a) => node('list-checks.mjs', a);
const REG = JSON.parse(readFileSync(join(CORE, 'findings-registry.json'), 'utf8'));

test('list-checks on this repo places every registry key once, with no unmapped or missing entry (TODO-086 D15)', () => {
  // Value: protects=a registry kind the skill cannot propose fails in the docs job; fails_when=the registry gains a kind or BIND names a flag args.js lacks; why_new=TODO-086; seam=--core; no_claim=the real CLI (test/adopt.test.js)
  const r = listChecks('--core', CORE);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.unmapped, out.missing_in_catscan, out.notes], [[], [], []]);
  assert.equal(out.schema, 1);
  const placed = [...out.commands.flatMap((g) => g.checks.map((c) => `${c.kind} ${c.rule}`)), ...out.not_proposable.map((c) => `${c.kind} ${c.rule}`)];
  assert.deepEqual([...placed].sort(), REG.keys.map(([k, r2]) => `${k} ${r2}`).sort());
  assert.deepEqual(out.not_proposable.map((c) => c.kind).sort(), ['missing', 'missing-glyphs']);
  // Experimental is opt-in (D5): a group with an experimental check always has an opt-in argv.
  for (const g of out.commands) if (g.checks.some((c) => c.experimental)) assert.ok(g.opt_in.length, `${g.command} has an experimental check and no opt_in`);
  // Every need token a check uses has its flag, and checks.md explains each token and names each command.
  const md = readFileSync(join(scripts, '../references/checks.md'), 'utf8');
  for (const g of out.commands) {
    assert.ok(md.includes(`\`${g.command}\``), `checks.md does not name ${g.command}`);
    for (const n of g.checks.flatMap((c) => c.needs).flatMap((x) => x.split('|'))) {
      assert.ok(out.needs[n]?.flag, `need ${n} has no flag`);
      assert.ok(md.includes(`| \`${n}\` |`), `checks.md does not explain ${n}`);
    }
  }
});

test('list-checks reports a newer, an older and a non-proposable kind without stopping (TODO-086 D4, D11)', () => {
  // Value: protects=version skew between the skill and catscan is reported with a fix; fails_when=a skew line moves or exits non-zero; why_new=TODO-086; seam=--core; no_claim=the real registry
  const core = tmp('adopt-core-');
  const row = (kind, rule, experimental = false) => ({ kind, rule, severity: 'major', experimental, synthetic: { precision: 0.9, flags: 10, source: 's' }, real: null, reader: 'vision', certainty: 'low' });
  const keys = [['check', 'present'], ['missing', '-'], ['fit', 'cutout'], ['overlap', 'boxes'], ['brand-new', '-']];
  const rows = keys.map(([k, r]) => row(k, r, k === 'fit' || k === 'overlap'));
  rows[0].real = { precision: 0.8, flags: 5, source: 'r' };
  writeFileSync(join(core, 'findings-registry.json'), JSON.stringify({ registry: 1, keys, rows }));
  writeFileSync(join(core, 'args.js'), "module.exports = { COMMANDS: ['check', 'overlap'], OPTIONS: { '--expect': { commands: ['check'] }, '--experimental': { commands: ['fit'] } } };\n");
  const r = listChecks('--core', core);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.commands, [{ command: 'check', opt_in: [], experimental: false, checks: [{ kind: 'check', rule: 'present', experimental: false, needs: ['expect'],
    precision: { synthetic: { precision: 0.9, flags: 10, source: 's' }, real: { precision: 0.8, flags: 5, source: 'r' } } }] }]);
  assert.deepEqual([out.catscan, out.registry], [null, null]); // no package.json or scale.js beside this core
  assert.deepEqual(out.unmapped.map((u) => u.kind), ['brand-new']);
  assert.match(out.unmapped[0].fix, /update the catscan plugin/);
  assert.deepEqual(out.not_proposable.map((u) => u.kind), ['missing']);
  const miss = Object.fromEntries(out.missing_in_catscan.map((m) => [`${m.kind} ${m.rule}`, m]));
  assert.deepEqual(miss['fit cutout'].missing, ['command fit', 'fit --device-profile']);
  assert.deepEqual(miss['overlap boxes'].missing, ['overlap --experimental']);
  assert.match(miss['overlap boxes'].fix, /^upgrade catscan to propose overlap/);
  assert.deepEqual(miss['truncated ellipsis'].missing, ['registry key']); // bound by the skill, absent from this catscan
});

test('list-checks: an unloadable registry is a no-registry note with a fix and exit 0; bad flags exit 2', () => {
  // Value: protects=an older catscan still gets a plan; fails_when=the note shape or exit code changes; why_new=TODO-086 D11, D12; seam=--core; no_claim=none beyond protects
  const r = listChecks('--core', tmp('adopt-core-'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.notes.map((n) => n.code), ['no-registry']);
  assert.match(out.notes[0].fix, /check, untranslated and truncated only/);
  assert.deepEqual(out.commands, []);
  for (const a of [[], ['--catscan', '[1]'], ['--catscan', 'notjson'], ['--core'], ['--core', CORE, '--catscan', '["x"]'], ['--bogus']]) assert.equal(listChecks(...a).status, 2, a.join(' '));
  // A registry of another shape, or a bin that no longer exists, degrades the same way instead of crashing.
  const odd = tmp('adopt-core-');
  writeFileSync(join(odd, 'findings-registry.json'), '{}');
  writeFileSync(join(odd, 'args.js'), "module.exports = { COMMANDS: ['check'], OPTIONS: {} };\n");
  for (const a of [['--core', odd], ['--catscan', '["/nonexistent/catscan"]']]) {
    const x = listChecks(...a);
    assert.equal(x.status, 0, x.stderr);
    assert.deepEqual(JSON.parse(x.stdout).notes.map((n) => n.code), ['no-registry'], a.join(' '));
  }
});

test('list-checks: a kind no check can be wired for is never an upgrade line; an odd key degrades; --experimental marks its group (TODO-086 D4, D5, D16)', () => {
  // Value: protects=skew advice, the one-JSON-document contract and the never-default-on rule; fails_when=the null-command skip, the inner try or the argv check goes; why_new=pre-landing review; seam=--core; no_claim=real registry
  const core = tmp('adopt-core-');
  writeFileSync(join(core, 'findings-registry.json'), JSON.stringify({ registry: 1, keys: [['check', 'present'], ['overlap', 'boxes']],
    rows: [{ kind: 'check', rule: 'present', reader: 'vision', experimental: false }, { kind: 'overlap', rule: 'boxes', reader: 'vision', experimental: false }] }));
  writeFileSync(join(core, 'args.js'), "module.exports = { COMMANDS: ['check', 'overlap'], OPTIONS: { '--expect': { commands: ['check'] }, '--experimental': { commands: ['overlap'] } } };\n");
  const out = JSON.parse(listChecks('--core', core).stdout);
  assert.deepEqual(out.missing_in_catscan.filter((m) => m.command === null), []);
  assert.ok(out.missing_in_catscan.some((m) => m.kind === 'truncated' && m.fix === 'upgrade catscan to propose truncated truncated ellipsis'));
  // A registry that calls overlap boxes stable still keeps a group behind --experimental out of the default batch.
  assert.deepEqual(out.commands.map((g) => [g.command, g.experimental]), [['check', false], ['overlap', true]]);
  writeFileSync(join(core, 'findings-registry.json'), JSON.stringify({ registry: 1, keys: [null], rows: [] }));
  const odd = listChecks('--core', core);
  assert.equal(odd.status, 0, odd.stderr);
  assert.deepEqual(JSON.parse(odd.stdout).notes.map((n) => n.code), ['no-registry']);
});

test('the experimental step never gates: no kind of a command with an experimental group is certainty high (TODO-086 D16)', () => {
  // Value: protects=the --min-certainty high promise in checks.md; fails_when=the registry makes a kind of overlap, fit, contrast, untranslated or formats high; why_new=D16; seam=--core; no_claim=what each run finds
  const out = JSON.parse(listChecks('--core', CORE).stdout);
  const kinds = (cmd) => out.commands.filter((g) => g.command === cmd).flatMap((g) => g.checks.map((c) => `${c.kind}\0${c.rule}`));
  for (const g of out.commands.filter((x) => x.experimental)) {
    for (const k of kinds(g.command)) for (const r of REG.rows.filter((x) => `${x.kind}\0${x.rule}` === k)) assert.notEqual(r.certainty, 'high', `${g.command}: ${k.replace('\0', ' ')} ${r.reader}`);
  }
  assert.match(readFileSync(join(scripts, '../references/checks.md'), 'utf8'), /`--min-certainty high`/);
});

test('list-checks groups per command and opt-in in a fixed order, and marks a group with an experimental check (TODO-086 D5, D12)', () => {
  // Value: protects=a deterministic plan order and the experimental marker the opt-in rule keys on; fails_when=the sort or the group flag changes; why_new=coverage audit gap; seam=--core; no_claim=the real registry
  const core = tmp('adopt-core-');
  const keys = [['overlap', 'boxes'], ['overlap', 'elements'], ['check', 'absent']];
  writeFileSync(join(core, 'findings-registry.json'), JSON.stringify({ registry: 1, keys,
    rows: keys.map(([kind, rule]) => ({ kind, rule, reader: 'vision', experimental: rule === 'boxes', synthetic: null, real: null })) }));
  writeFileSync(join(core, 'args.js'), "module.exports = { COMMANDS: ['check', 'overlap'], OPTIONS: { '--expect': { commands: ['check'] }, '--boxes': { commands: ['overlap'] }, '--experimental': { commands: ['overlap'] } } };\n");
  const out = JSON.parse(listChecks('--core', core).stdout);
  assert.deepEqual(out.commands.map((g) => [g.command, g.opt_in.join(' '), g.experimental]), [['check', '', false], ['overlap', '', false], ['overlap', '--experimental', true]]);
});

test('list-checks proposes stacked text with plain overlap, no opt-in (TODO-067 D31)', () => {
  // Value: protects=adopt offers the default-on stacked reader as a plain overlap run; fails_when=its map entry regains --experimental; why_new=TODO-067 default-on; seam=--core; no_claim=the real registry
  const core = tmp('adopt-core-');
  const keys = [['overlap', 'stacked']];
  writeFileSync(join(core, 'findings-registry.json'), JSON.stringify({ registry: 1, keys,
    rows: keys.map(([kind, rule]) => ({ kind, rule, reader: 'vision', experimental: false, synthetic: null, real: null })) }));
  writeFileSync(join(core, 'args.js'), "module.exports = { COMMANDS: ['overlap'], OPTIONS: { '--experimental': { commands: ['overlap'] } } };\n");
  const out = JSON.parse(listChecks('--core', core).stdout);
  assert.deepEqual(out.commands.map((g) => [g.command, g.opt_in.join(' '), g.experimental, g.checks.map((c) => c.rule)]), [['overlap', '', false, ['stacked']]]);
});

test('the skill runs list-checks and its point format has Checks and Opt-in lines (TODO-086 D10)', () => {
  // Value: protects=the agent is told to read checks.json and to write checks per point; fails_when=SKILL.md or points.md drops them; why_new=D10; seam=none; no_claim=what an agent writes
  const skill = readFileSync(join(scripts, '../SKILL.md'), 'utf8');
  assert.match(skill, /scripts\/list-checks\.mjs --catscan '<command>' > <plan>\/checks\.json/);
  const points = readFileSync(join(scripts, '../references/points.md'), 'utf8');
  assert.match(points, /^ {3}Checks: /m);
  assert.match(points, /^ {3}Opt-in: /m);
});

// ---------- adopt-metrics (TODO-061 D3, D4, D8, D16, D18, D20) ----------
// Value: protects=the before/after row a developer reads to keep or drop catscan; fails_when=count takes stale or
// non-image files, double-counts a path across results files, counts a failed or unnamed matcher test as checked,
// prints a 0/0 row instead of exit 4, record misreads a runner summary or accepts a changed test count, or table
// mixes tests with shots or drops a reason line; why_new=new script; seam=temp folders and fixture JSON/logs, no
// runner; no_claim=real Playwright output and timings (test/adopt/fixture.test.js).

const metrics = (args, opts) => node('adopt-metrics.mjs', args, opts);
const json = (o) => JSON.stringify(o);
const stale = new Date(Date.now() - 3600e3);

function shotRun() {
  const d = tmp('adopt-count-');
  put(d, { 'shots/de/run-1731/menu.png': 'p', 'shots/en/x/y/menu.jpg': 'p', 'shots/en/notes.txt': 't', 'shots/old.png': 'p' });
  utimesSync(join(d, 'shots/old.png'), stale, stale);
  writeFileSync(join(d, 'stamp'), '');
  utimesSync(join(d, 'stamp'), new Date(Date.now() - 60e3), new Date(Date.now() - 60e3));
  put(d, {
    'r1.json': json({ coverage: null, results: [{ path: 'shots/de/run-1731/menu.png', locale: 'de', verdict: 'pass' }, { path: 'shots/en/x/y/menu.jpg', locale: 'en', verdict: 'fail' }, { path: 'shots/old.png', locale: 'fr', verdict: 'error' }, { path: 'shots/ja.png', locale: 'ja', verdict: 'unsupported' }, { path: 'shots/el.png', locale: 'el', verdict: 'needs-reader' }] }),
    'r2.json': json({ coverage: null, results: [{ path: 'shots/en/x/y/menu.jpg', locale: 'en', verdict: 'pass' }] }),
    'cov.json': json({ coverage: { received: 5 }, results: [{ path: 'a.png', locale: 'fr', verdict: 'pass' }, { path: null, locale: 'ja', verdict: 'fail' }] }),
    'empty.json': json({ coverage: null, results: [] }),
    'dup.json': json({ coverage: null, results: [{ path: 'a.png', locale: 'fr', verdict: 'pass' }, { path: 'a.png', locale: 'fr', verdict: 'error' }] }),
  });
  return d;
}

test('adopt-metrics count: images newer than the stamp, distinct result paths across files, locales merged; error, unsupported and needs-reader checked nothing', () => {
  const d = shotRun();
  let r = metrics(['count', '--shots', 'shots', '--stamp', 'stamp', '--results', 'r1.json', '--results', 'r2.json'], { cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { shots: { checked: 2, captured: 2, unchecked: 3, locales: ['de', 'en'], by_locale: { de: 1, en: 1 } }, tests: null, findings: 1 });
  // coverage.received (5) counts a shot once per command and counts error results: checked is the distinct paths read,
  // with or without expectations, and the missing cell (path null) is a finding.
  r = metrics(['count', '--shots', 'shots', '--stamp', 'stamp', '--results', 'cov.json', '--results', 'r2.json', '--results', 'dup.json'], { cwd: d });
  assert.deepEqual(JSON.parse(r.stdout), { shots: { checked: 2, captured: 2, unchecked: 0, locales: ['en', 'fr'], by_locale: { en: 1, fr: 1 } }, tests: null, findings: 1 });
});

test('adopt-metrics count: the matcher counts passed tests named as asserted; failed ones are findings', () => {
  const d = tmp('adopt-pw-');
  const spec = (title, ...statuses) => ({ title, file: 'menu.pw.ts', tests: statuses.map((status) => ({ status, results: [] })) });
  put(d, { 'pw.json': json({ suites: [{ title: 'menu.pw.ts', file: 'menu.pw.ts', specs: [spec('menu en', 'expected'), spec('other', 'expected')], suites: [{ title: 'shop', file: 'menu.pw.ts', specs: [spec('cart de', 'expected', 'flaky'), spec('cart fr', 'unexpected'), spec('cart ja', 'skipped')] }] }] }) });
  writeFileSync(join(d, 'stamp'), '');
  utimesSync(join(d, 'stamp'), stale, stale);
  const base = ['count', '--stamp', 'stamp', '--pw-json', 'pw.json', '--asserted', 'menu en', '--asserted', 'menu.pw.ts > shop > cart de', '--asserted', 'shop > cart fr', '--asserted', 'shop > cart ja'];
  let r = metrics([...base, '--locale', 'en', '--locale', 'de', '--locale', 'en'], { cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { shots: null, tests: { checked: 3, failed: 1, skipped: 1, locales: ['de', 'en'], locales_source: 'declared' }, findings: 1 });
  r = metrics([...base, '--asserted', 'menu ja'], { cwd: d });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /pw\.json: no test titled "menu ja"\. Next: /);
});

test('adopt-metrics count: empty or unreadable input exits 4 naming the path, a bad flag exits 2 with the usage line', () => {
  const d = shotRun();
  put(d, { 'notjson.txt': 'x', 'old.json': json({ coverage: null, results: [{ path: 'a.png', verdict: 'pass' }] }) });
  utimesSync(join(d, 'old.json'), stale, stale);
  rmSync(join(d, 'shots/de'), { recursive: true });
  rmSync(join(d, 'shots/en'), { recursive: true });
  const cases = [
    [['--shots', 'shots', '--stamp', 'stamp', '--results', 'r1.json'], 4, /shots: no image newer than the stamp\. Next: /],
    [['--shots', 'nope', '--stamp', 'stamp', '--results', 'r1.json'], 4, /nope: cannot list the shot folder/],
    [['--stamp', 'stamp', '--pw-json', 'missing.json', '--asserted', 'a'], 4, /missing\.json: cannot read \(ENOENT\)\. Next: /],
    [['--shots', 'shots', '--results', 'r1.json'], 2, /count needs --stamp/],
    [['--shots', 'shots', '--stamp', 'nostamp', '--results', 'r1.json'], 4, /nostamp: cannot read the stamp \(ENOENT\)\. Next: /],
    [['--stamp', 'stamp', '--pw-json', 'notjson.txt', '--asserted', 'a'], 4, /notjson\.txt: not JSON .*\. Next: /],
    [['--stamp', 'stamp', '--pw-json', 'r1.json'], 2, /--pw-json and --asserted go together/],
    [['--shots', 'shots', '--stamp', 'stamp', '--results', 'old.json'], 4, /old\.json: older than the stamp, so an earlier run wrote it\. Next: /],
    [['--stamp', 'stamp', '--pw-json', 'old.json', '--asserted', 'a'], 4, /old\.json: older than the stamp/],
    [['--bogus', 'x'], 2, /unknown argument --bogus\nusage: adopt-metrics\.mjs count/],
  ];
  for (const [args, code, re] of cases) {
    const r = metrics(['count', ...args], { cwd: d });
    assert.equal(r.status, code, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re);
  }
  put(d, { 'shots/new.png': 'p' });
  const r = metrics(['count', '--shots', 'shots', '--stamp', 'stamp', '--results', 'empty.json'], { cwd: d });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /empty\.json: no results entry\. Next: /);
});

const SUMMARIES = {
  playwright: (p, f = 0, s = 0) => `Running ${p + f} tests\n${f ? `  ${f} failed\n    [chromium] › a.pw.ts:3:5 › x\n` : ''}${s ? `  ${s} skipped\n` : ''}  ${p} passed (3.1s)\n`,
  jest: (p, f = 0, s = 0) => `PASS a.test.js\nTests:       ${f ? `${f} failed, ` : ''}${s ? `${s} skipped, ` : ''}${p} passed, ${p + f + s} total\nTime: 1 s\n`,
  vitest: (p, f = 0, s = 0) => ` Test Files  1 passed (1)\n      Tests  ${f ? `${f} failed | ` : ''}${p} passed${s ? ` | ${s} skipped` : ''} (${p + f + s})\n`,
  'node:test': (p, f = 0, s = 0) => `✔ a (1ms)\nℹ tests ${p + f + s}\nℹ suites 0\nℹ pass ${p}\nℹ fail ${f}\nℹ cancelled 0\nℹ skipped ${s}\nℹ todo 0\n`,
  'node:test TAP': (p, f = 0, s = 0) => `TAP version 13\nok 1 - a\n1..${p + f + s}\n# tests ${p + f + s}\n# pass ${p}\n# fail ${f}\n# skipped ${s}\n`,
  'Playwright JSON stats': (p, f = 0, s = 0) => `{"config":{},"suites":[],"stats":{"startTime":"2026-11-17T00:00:00.000Z","duration":12.3,"expected":${p - 1},"skipped":${s},"unexpected":${f},"flaky":1}}\n`,
  'Playwright flaky and did not run': (p, f = 0, s = 0) => `  1 flaky\n    [chromium] › a.pw.ts:3:5 › x\n${s ? `  ${s} did not run\n` : ''}  ${p - 1} passed (3.1s)\n`,
  'Playwright twice, counts add': (p, f = 0, s = 0) => `${s ? `  ${s} skipped\n` : ''}  ${p - 2} passed (2.0s)\n...\n  2 passed (1.0s)\n`,
  'Jest then Playwright, counts add': (p, f = 0, s = 0) => `Tests:       ${s ? `${s} skipped, ` : ''}${p - 2} passed, ${p - 2 + s} total\n...\n  2 passed (1.0s)\n`,
};
function measured({ before, after, runs = 1, status = 'ok', extraAfter }) {
  const d = tmp('adopt-rec-');
  const logs = join(d, 'logs');
  mkdirSync(logs);
  for (let i = 1; i <= runs; i++) {
    writeFileSync(join(logs, `A-run-${i}.log`), before);
    writeFileSync(join(logs, `B-run-${i}.log`), i === runs && extraAfter ? extraAfter : after);
  }
  writeFileSync(join(logs, 'B-warmup-1.log'), 'garbage');
  writeFileSync(join(d, 'measure.txt'), `arm=A label=before@a1:warm runs=${runs} wall_median_s=10.00 cpu_median_s=8.00 load=1.2 status=${status}\narm=B label=after@b2:warm runs=${runs} wall_median_s=12.50 cpu_median_s=9.00 load=1.3 status=${status}\nnote: CPU ...\n`);
  return d;
}
const rec = (d, ...args) => metrics(['record', '--batch', '1', '--layer', 'e2e', '--measure', 'measure.txt', '--log', 'logs', '--file', 'm.jsonl', ...args], { cwd: d });
const rows = (d) => readFileSync(join(d, 'm.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('adopt-metrics record: reads each runner summary and applies after = before + added', () => {
  for (const [runner, sum] of Object.entries(SUMMARIES)) {
    const d = measured({ before: sum(40, 0, 1), after: 'catscan: ok\n' + sum(42, 0, 1), runs: 3 });
    const r = rec(d, '--added', '2', '--layer-wall', '100');
    assert.equal(r.status, 0, `${runner}: ${r.stderr}`);
    const [row] = rows(d);
    assert.deepEqual({ status: row.status, tests: row.tests, delta: row.cost.delta_wall, share: row.cost.share }, {
      status: 'ok', delta: 2.5, share: 0.025,
      tests: { before: { passed: 40, failed: 0, skipped: 1, total: 41 }, after: { passed: 42, failed: 0, skipped: 1, total: 43 }, added: 2, source: 'log' },
    }, runner);
  }
});

test('adopt-metrics record: a wrong count, a changed result, disagreeing runs or a failed run void the row', () => {
  const pw = SUMMARIES.playwright;
  const cases = [
    [{ before: pw(40), after: pw(41) }, ['--added', '2'], /^after ran 41 tests, expected 42 \(40 \+ 2 added\)\. Next: see the --log files$/],
    [{ before: pw(40, 0, 1), after: pw(41, 0, 0) }, ['--added', '0'], /^a before test changed result: before 40 passed, 0 failed, 1 skipped, after 41 passed/],
    [{ before: pw(40), after: pw(40), runs: 2, extraAfter: pw(39) }, [], /^after runs disagree: B-run-1\.log has 40 tests, B-run-2\.log has 39/],
    [{ before: pw(40), after: pw(40), status: 'invalid' }, [], /measure\.sh exit 3/],
  ];
  for (const [m, args, re] of cases) {
    const d = measured(m);
    const r = rec(d, ...args);
    assert.equal(r.status, 0, r.stderr);
    const [row] = rows(d);
    assert.equal(row.status, 'void');
    assert.match(row.reason, re);
  }
});

test('adopt-metrics record: an unparsable log exits 4 naming it; quoted counts then pass, a single run is indicative', () => {
  const d = measured({ before: 'ok 40 things\n', after: 'ok 41 things\n' });
  let r = rec(d, '--added', '1');
  assert.equal(r.status, 4);
  assert.match(r.stderr, /logs\/A-run-1\.log: no test summary .* pass --tests-before N --tests-after N/);
  r = rec(d, '--added', '1', '--tests-before', '40', '--tests-after', '41');
  assert.equal(r.status, 0, r.stderr);
  const [row] = rows(d);
  assert.deepEqual([row.status, row.tests.source, row.reason], ['indicative', 'quoted', '1 measured run per arm (quick mode), so the timing is indicative. Next: measure.sh -n 3 for a full row']);
  r = rec(d, '--tests-before', '40');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--tests-before and --tests-after go together\nusage:/);
});

test('adopt-metrics table: one row per batch and layer, totals, tests apart from shots, a reason line per row that needs one', () => {
  const d = tmp('adopt-table-');
  const count = (o) => { const f = join(d, `c${Math.random()}.json`); writeFileSync(f, json(o)); return f; };
  const shots = count({ shots: { checked: 2, captured: 2, unchecked: 0, locales: ['de', 'en'], by_locale: { de: 1, en: 1 } }, tests: null, findings: 0 });
  const tests = count({ shots: null, tests: { checked: 2, failed: 0, locales: ['de', 'en'], locales_source: 'declared' }, findings: 0 });
  const m = measured({ before: SUMMARIES.playwright(2), after: SUMMARIES.playwright(2), runs: 3 });
  const file = join(d, 'm.jsonl');
  const add = (...a) => { const r = metrics(['record', '--file', file, ...a], { cwd: m }); assert.equal(r.status, 0, r.stderr); };
  add('--batch', '1', '--layer', 'e2e', '--count', tests, '--measure', 'measure.txt', '--log', 'logs', '--real', '1', '--false', '0', '--edits', '2', '--proofs', '1/1', '--layer-wall', '50');
  add('--batch', '1', '--layer', 'ci', '--count', shots, '--no-cost', 'the developer chose skip', '--before-note', 'by-eye', '--local-na', 'catscan step in deploy.yml', '--proofs', '1/1');
  add('--batch', '2', '--layer', 'e2e', '--count', shots, '--measure', 'measure.txt', '--log', 'logs', '--added', '0');
  // Recorded again (the void reason says to): the row is replaced in place, never added twice or moved after a
  // later batch.
  add('--batch', '2', '--layer', 'e2e', '--count', shots, '--measure', 'measure.txt', '--log', 'logs', '--added', '1');
  add('--batch', '1', '--layer', 'e2e', '--count', tests, '--measure', 'measure.txt', '--log', 'logs', '--real', '1', '--false', '0', '--edits', '2', '--proofs', '1/1', '--layer-wall', '50');
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((l) => `${JSON.parse(l).batch} ${JSON.parse(l).layer}`), ['1 e2e', '1 ci', '2 e2e']);
  const r = metrics(['table', '--file', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    '| Batch | Layer | Checked before | Checked after | Findings (real/false) | Edits | Proofs | Tests (before -> after) | Cost (after - before) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | e2e | 0 | 2 tests (de, en, declared) | 1/0 | 2 | 1/1 | 2 -> 2 (+0) | +2.50 s wall (5.0% of the layer), +1.00 s CPU |',
    '| 1 | ci | 0 (by-eye) | 2/2 shots (de, en) | -/- | - | 1/1 | - | skipped |',
    '| 2 | e2e | 0 | 2/2 shots (de, en) | -/- | - | - | 2 -> 2 (+1) | void |',
    '| **Total** | | 0 | 4/4 shots; 2 tests | 1/0 | 2 | 2/2 | | +2.50 s wall, +1.00 s CPU (1 timed row) |',
    '',
    '- batch 1 ci: skipped: cost not measured: the developer chose skip. Next: run measure.sh on the two worktrees and record again',
    '- batch 1 ci: local: n/a: catscan step in deploy.yml runs only in CI, so its time is not in the row',
    '- batch 2 e2e: void: after ran 2 tests, expected 3 (2 + 1 added). Next: see the --log files',
    '',
  ].join('\n'));
  appendFileSync(file, json({ schema: 2 }) + '\n');
  for (const args of [['table', '--file', file], ['record', '--file', file, '--batch', '3', '--layer', 'x', '--no-cost', 'n']]) {
    const u = metrics(args, { cwd: m });
    assert.equal(u.status, 2);
    assert.match(u.stderr, /unknown schema 2 .*rebuild the file: delete it and record each batch again/);
  }
});

test('adopt-metrics record: bad flags and unreadable inputs write no row', () => {
  const pw = SUMMARIES.playwright;
  const cases = [
    [[], 2, /record needs --batch/, ['--layer', 'e2e', '--measure', 'measure.txt', '--log', 'logs']],
    [['--no-cost', 'n'], 2, /--no-cost records coverage and value only/],
    [['--proofs', '2-2'], 2, /--proofs takes PASSED\/TOTAL, got '2-2'/],
    [['--layer-wall', '1s'], 2, /--layer-wall takes seconds, got '1s'/],
    [['--before-note', 'x'], 2, /--before-note takes by-eye, got 'x'/],
    [['--added', '-1'], 2, /--added needs a whole number, got '-1'/],
    [['--added', 'x'], 2, /--added needs a whole number, got 'x'/],
    [['--count', 'nope.json'], 4, /nope\.json: cannot read \(ENOENT\)\. Next: /],
    [['--count', 'null.json'], 4, /null\.json: not the JSON line count prints\. Next: /],
    [['--measure', 'arm-a.txt'], 4, /arm-a\.txt: no arm=A and arm=B lines\. Next: /, ['--batch', '1', '--layer', 'e2e', '--log', 'logs']],
    [['--measure', 'swapped.txt'], 4, /swapped\.txt: arm A is after@b:warm and arm B is before@a:warm\. Next: /, ['--batch', '1', '--layer', 'e2e', '--log', 'logs']],
    [['--log', 'empty'], 4, /empty: no A-run-\*\.log\. Next: /, ['--batch', '1', '--layer', 'e2e', '--measure', 'measure.txt']],
    [[], 2, /--measure needs --log DIR/, ['--batch', '1', '--layer', 'e2e', '--measure', 'measure.txt']],
  ];
  for (const [args, code, re, head] of cases) {
    const d = measured({ before: pw(2), after: pw(2) });
    put(d, { 'swapped.txt': 'arm=A label=after@b:warm runs=1 wall_median_s=1.00 cpu_median_s=1.00 load=1 status=ok\narm=B label=before@a:warm runs=1 wall_median_s=1.00 cpu_median_s=1.00 load=1 status=ok\n', 'null.json': 'null\n', 'arm-a.txt': 'arm=A label=before@a:warm runs=1 wall_median_s=1.00 cpu_median_s=1.00 load=1 status=ok\n' });
    mkdirSync(join(d, 'empty'));
    const r = head ? metrics(['record', '--file', 'm.jsonl', ...head, ...args], { cwd: d }) : rec(d, ...args);
    assert.equal(r.status, code, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re);
    assert.equal(statSync(join(d, 'm.jsonl'), { throwIfNoEntry: false }), undefined, `${args.join(' ')} wrote a row`);
  }
});

test('adopt-metrics table: an indicative row has its reason line; a missing, empty or broken file exits 4', () => {
  const m = measured({ before: SUMMARIES.playwright(2), after: SUMMARIES.playwright(2) });
  assert.equal(rec(m).status, 0);
  let r = metrics(['table', '--file', 'm.jsonl'], { cwd: m });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\| 1 \| e2e \| 0 \| - \| -\/- \| - \| - \| 2 -> 2 \(\+0\) \| \+2\.50 s wall, \+1\.00 s CPU, indicative \|$/m);
  assert.match(r.stdout, /^- batch 1 e2e: indicative: 1 measured run per arm \(quick mode\), so the timing is indicative\. Next: measure\.sh -n 3 for a full row$/m);
  put(m, { 'empty.jsonl': '\n', 'bad.jsonl': '{"schema":1\n' });
  for (const [f, re] of [['none.jsonl', /none\.jsonl: cannot read \(ENOENT\)/], ['empty.jsonl', /empty\.jsonl: no rows\. Next: /], ['bad.jsonl', /bad\.jsonl:1: not a JSON line\. Next: /]]) {
    r = metrics(['table', '--file', f], { cwd: m });
    assert.equal(r.status, 4, f);
    assert.match(r.stderr, re);
  }
});

// ---------- TODO-087: gaps from the T5c dry-run rerun ----------

test('find-points: code catalogs, folder-word siblings, any-depth locale folders and one-locale folders (TODO-087 T1-T3, D4-D6)', () => {
  const repo = repoWith({
    // T1: TypeScript catalogs under i18n/; index.ts and a .d.ts are no locale; a locale-named .ts outside i18n is not a catalog.
    'app/src/i18n/de.ts': 'export default {};\n', 'app/src/i18n/fr.ts': 'export default {};\n', 'app/src/i18n/ja.ts': 'export default {};\n',
    'app/src/i18n/index.ts': 'export {};\n', 'app/src/i18n/ko.d.ts': 'export {};\n', 'app/src/lang/pl/index.js': 'export default {};\n',
    'app/src/util/el.ts': 'export {};\n',
    // A library's own locale files under static/ are not the app's; pt_BR in code and in JSON is not code-only.
    'web/static/select2/i18n/hr.js': 'x;\n', 'web/static/select2/i18n/sv.js': 'x;\n',
    'app/src/i18n/pt_BR.ts': 'export default {};\n', 'app/public/locales/pt_BR.json': '{"a":"b"}\n',
    // A readable catalog for de: de has a code catalog and a JSON one, so it is not code-only.
    'app/public/locales/de.json': '{"a":"b"}\n',
    // T2: it.json next to two unambiguous locales counts; a lone it/ folder of shots does not.
    'game/i18n/it.json': '{"a":"b"}\n', 'game/i18n/es.json': '{"a":"b"}\n', 'game/i18n/tr.json': '{"a":"b"}\n',
    'lone/it/x.png': 'png', 'lone/de/x.png': 'png',
    // T3: the locale folder above a platform folder; D4: a one-locale research folder adds no source.
    'kit/uk/ios/1.png': 'png', 'kit/ru/ios/1.png': 'png', 'kit/it/ios/1.png': 'png',
    'research/bn/ref.png': 'png',
  });
  const out = JSON.parse(node('find-points.mjs', [repo]).stdout);
  const loc = Object.fromEntries(out.locales.map((l) => [l.locale, l.sources.map((s) => `${s.kind} ${s.file}`)]));
  assert.deepEqual(out.code_catalogs, [
    { locale: 'fr', files: ['app/src/i18n/fr.ts'] }, { locale: 'ja', files: ['app/src/i18n/ja.ts'] }, { locale: 'pl', files: ['app/src/lang/pl/index.js'] },
  ]);
  assert.ok(loc.de.includes('code-catalog app/src/i18n/de.ts'), 'de keeps its code catalog as a source');
  assert.equal(loc.ko, undefined, 'a .d.ts is no catalog');
  assert.equal(loc.el, undefined, 'a locale-named file outside an i18n folder is no catalog');
  assert.equal(loc.hr, undefined, 'a vendored library locale file is no catalog');
  assert.ok(loc['pt-BR'], 'pt_BR is read as pt-BR');
  const warn = out.catalog_warnings.find((w) => w.startsWith('fr, ja, pl:'));
  assert.ok(warn && /Fix: use catscan 0\.66 or later, or export each to <locale>\.json/.test(warn) && /--languages fr,ja,pl/.test(warn), warn);
  // T3 + D6: kit/<locale>/ios is one locale folder under kit, it included next to uk and ru.
  const kit = out.groups.find((g) => g.producer === 'committed-locale-shots' && g.dir === 'kit');
  assert.match(kit?.examples[0].evidence ?? '', /3 images in 3 locales: it, ru, uk/);
  assert.ok(loc.it.includes('screenshots kit'), 'it is a locale next to two unambiguous siblings');
  // lone/: it is a folder word with one locale sibling, so lone has one locale (de): no source, no candidate.
  assert.ok(!out.groups.some((g) => g.dir === 'lone'));
  assert.equal(loc.bn, undefined, 'a one-locale folder adds no locale source');
});

test('find-points: a test that hashes rendered PNGs against a golden is a pixel-hash candidate (TODO-087 T8)', () => {
  const repo = repoWith({
    'pkg/test/golden.test.js': "import { createHash } from 'node:crypto';\nconst out = render('slide.png');\n// byte-strict golden manifest\nassert.deepEqual(hashes(out), manifest.files);\n",
    'pkg/src/hash.js': "// golden\nconst h = createHash('sha256').update(read('a.png'));\n",
    'pkg/test/text.test.js': "// baseline text only, no images\nassert.equal(hash(a), hash(b));\n",
    // Common words are no hash: location.hash, a CSS baseline and an imported logo.png.
    'pkg/test/nav.test.js': "// align baseline\nexpect(location.hash).toBe('#a');\nimport logo from './logo.png';\n",
    // Swift and Android test folders count (Tests/, <App>Tests/, androidTest/).
    'App/Tests/AppTests/GoldenTests.swift': "// golden images\nlet d = SHA256.hash(data: data)\nlet url = dir.appendingPathComponent(\"home.png\")\n",
  });
  const out = JSON.parse(node('find-points.mjs', [repo, '--all']).stdout);
  const hits = out.groups.filter((g) => g.producer === 'pixel-hash').flatMap((g) => g.examples.map((e) => `${g.kind} ${e.file}:${e.line}`));
  assert.deepEqual(hits.sort(), ['pixel-text App/Tests/AppTests/GoldenTests.swift:1', 'pixel-text pkg/test/golden.test.js:3']);
});

test('find-catscan: the checkout the skill sits in is found with no flags, last; from names each source (TODO-087 T7, D12)', () => {
  const w = world({});
  // A fake catscan checkout holding this skill: package.json named catscan, bin/catscan.js, the script five folders down.
  const co = checkoutDir(true, 'plugin');
  put(co, { 'package.json': JSON.stringify({ name: 'catscan' }) });
  const script = join(co, 'plugins/catscan/skills/catscan-adopt/scripts/find-catscan.mjs');
  mkdirSync(dirname(script), { recursive: true });
  cpSync(join(scripts, 'find-catscan.mjs'), script);
  let r = runFind(script, [], w.env);
  assert.deepEqual([r.status, r.out.form, r.out.from, r.out.version], [0, 'checkout', 'plugin', 'plugin']);
  // An explicit --checkout still wins, and says so; CATSCAN_CHECKOUT comes before the plugin's own checkout.
  r = runFind(script, ['--checkout', checkoutDir(true, 'co')], w.env);
  assert.deepEqual([r.out.from, r.out.version], ['flag', 'co']);
  r = runFind(script, [], { ...w.env, CATSCAN_CHECKOUT: checkoutDir(true, 'env') });
  assert.deepEqual([r.out.from, r.out.version], ['env', 'env']);
  // A folder shaped like a checkout with another package name is no candidate.
  put(co, { 'package.json': JSON.stringify({ name: 'other' }) });
  r = runFind(script, [], w.env);
  assert.deepEqual([r.status, r.out.form, r.out.from], [1, null, null]);
});

test('check-diffs: each experimental diff must apply on the default diffs alone, not on another experimental one (TODO-087 T5, D7)', () => {
  const repo = repoWith(BASE);
  const d1 = diffOf(repo, 'a.txt', 'one\nTWO\nthree\n');
  const fit = diffOf(repo, 'b.txt', 'b\nfit\n');
  // The contrast diff is made on top of the default diff, as the skill makes it; the overlap one on top of fit.
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n');
  git(repo, 'add', 'a.txt');
  const contrast = diffOf(repo, 'a.txt', 'one\nTWO\nthree\ncontrast\n');
  writeFileSync(join(repo, 'b.txt'), 'b\nfit\n');
  git(repo, 'add', 'b.txt');
  const stacked = diffOf(repo, 'b.txt', 'b\nfit\noverlap\n');
  git(repo, 'reset', '-q', '--hard');
  const p = tmp('adopt-plan-');
  mkdirSync(join(p, 'diffs'));
  writeFileSync(join(p, 'diffs', '01-home.diff'), d1);
  writeFileSync(join(p, 'diffs', '02-experimental-home-fit.diff'), fit);
  writeFileSync(join(p, 'diffs', '03-experimental-home-contrast.diff'), contrast);
  let r = checkDiffs(repo, p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 diffs apply together at [0-9a-f]+; each of 2 experimental diffs applies on the default diffs alone; batches not proved alone: no .+\/batches /m);
  writeFileSync(join(p, 'diffs', '04-experimental-home-overlap.diff'), stacked);
  const before = snapshot(repo);
  r = checkDiffs(repo, p);
  assert.equal(r.status, 1);
  // TODO-090 T3: two experimental diffs on one path fail before anything applies, with the fix.
  assert.match(r.stderr, /^FAIL 02-experimental-home-fit\.diff and 04-experimental-home-overlap\.diff both touch b\.txt; fix: an experimental diff adds only its own files/m);
  assert.deepEqual(snapshot(repo), before, 'the target repo is untouched');
  // A default diff numbered after an experimental one fails with a named line, not as a usage error.
  rmSync(join(p, 'diffs', '04-experimental-home-overlap.diff'));
  writeFileSync(join(p, 'diffs', '05-home-overlap.diff'), stacked);
  r = checkDiffs(repo, p);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^FAIL 05-home-overlap\.diff: a default diff sorts after 03-experimental-home-contrast\.diff/m);
  // No experimental diff: the summary line is unchanged.
  r = checkDiffs(repo, plan([d1]));
  assert.match(r.stdout, /^check-diffs: 1 diffs apply together at [0-9a-f]+; batches not proved alone: no /m);
});

test('list-checks: a --rules opt-in carries the default rules, since --rules replaces them (TODO-087 D3)', () => {
  const out = JSON.parse(listChecks('--core', CORE).stdout);
  // The expected list is written out: requiring formats.js here would need catscan's npm dependencies, which a
  // checkout before `npm ci` (the docs-check job) does not have.
  const DEFAULT_RULES = ['number', 'date', 'currency', 'mixed-currency', 'price'];
  assert.match(readFileSync(join(CORE, 'formats.js'), 'utf8'), /^const DEFAULT_RULES = \["number", "date", "currency", "mixed-currency", "price"\];/m);
  const time = out.commands.find((g) => g.command === 'formats' && g.checks.some((c) => c.kind === 'format' && c.rule === 'time'));
  assert.deepEqual(time.opt_in, ['--rules', [...DEFAULT_RULES, 'time'].join(',')]);
  assert.ok(!out.notes.some((n) => n.code === 'rules-not-merged'), JSON.stringify(out.notes));
  // A formats.js whose dependencies are not installed still gives its default rules from the source line.
  const nodeps = tmp('adopt-core-');
  writeFileSync(join(nodeps, 'findings-registry.json'), JSON.stringify({ registry: 1, keys: [['format', 'time']],
    rows: [{ kind: 'format', rule: 'time', reader: 'vision', experimental: false, synthetic: null, real: null }] }));
  writeFileSync(join(nodeps, 'args.js'), "module.exports = { COMMANDS: ['formats'], OPTIONS: { '--rules': { commands: ['formats'] } } };\n");
  writeFileSync(join(nodeps, 'formats.js'), 'const YAML = require("not-installed-dependency");\nconst DEFAULT_RULES = ["number", "date"]; // defaults\nmodule.exports = { DEFAULT_RULES };\n');
  const fallback = JSON.parse(listChecks('--core', nodeps).stdout);
  assert.deepEqual(fallback.commands[0].opt_in, ['--rules', 'number,date,time']);
  assert.deepEqual(fallback.notes, []);
  // A catscan without formats.js prints the opt-in alone, with a note that says how to merge it.
  const core = tmp('adopt-core-');
  writeFileSync(join(core, 'findings-registry.json'), JSON.stringify({ registry: 1, keys: [['format', 'time']],
    rows: [{ kind: 'format', rule: 'time', reader: 'vision', experimental: false, synthetic: null, real: null }] }));
  writeFileSync(join(core, 'args.js'), "module.exports = { COMMANDS: ['formats'], OPTIONS: { '--rules': { commands: ['formats'] } } };\n");
  const old = JSON.parse(listChecks('--core', core).stdout);
  assert.deepEqual(old.commands[0].opt_in, ['--rules', 'time']);
  assert.deepEqual(old.notes.map((n) => n.code), ['rules-not-merged']);
  assert.match(old.notes[0].fix, /--rules replaces the default list/);
});

test('the skill text carries the TODO-087 rules: reasons per command, code-catalog notes, the experimental cap and independence, opt-in groups', () => {
  // Value: protects=the rules the T5c rerun showed missing stay in the skill; fails_when=one is edited away; why_new=TODO-087 T5, T6, T9, D11-D15; seam=none; no_claim=agents follow them (the T5c rerun measures that)
  const read = (p) => readFileSync(join(scripts, '..', p), 'utf8').replace(/\s+/g, ' ');
  const skill = read('SKILL.md');
  assert.match(skill, /a row per `commands` entry in checks\.json, its `command` and `opt_in`, and one for `video`; each row with 0 points gives its reason/);
  assert.match(skill, /with the reason for each command no point uses/);
  assert.match(skill, /`code_catalogs`.*A dry run asks nothing/);
  assert.match(skill, /`from: plugin`\)\. Pass `--checkout <catscan checkout>`.*only when it finds none/);
  const checks = read('references/checks.md');
  assert.match(checks, /offers each experimental group \(`command` and `opt_in`\) at most once, on the point that feeds the most of its checks, each `kind` and `rule` pair counted once \(the higher-ranked point on a tie\)/);
  assert.match(checks, /measured real precision of 0 \(`real\.flags` above 0\); a kind with `real: null` is offered, labelled "no real-data measurement"/);
  assert.match(checks, /Each experimental diff applies on the default diffs alone and adds only its own new files/);
  assert.match(checks, /check-diffs fails two that share a path\): the one hook that runs every experimental step present/);
  assert.match(checks, /never by dropping its whole group/);
  assert.match(checks, /Copy each group's `opt_in` from `checks\.json` as is\. A group with `experimental: false` and an `opt_in`/);
  assert.match(read('references/surfaces.md'), /fits `--layout '\{locale\}-\{screen\}'` or `'\{screen\}-\{locale\}'`/);
  assert.match(read('references/points.md'), /\(`pixel-hash`\)/);
});

test('surfaces.md proposes Maestro boxes and the Playwright save-folder step', () => {
  // Value: protects=a Maestro point gets boxes for overlap, fit and truncated, a Playwright point gets formats, fit and contrast; fails_when=either step is edited away or loses its flags; why_new=TODO-087 T10, T11 (D18, D19); seam=none; no_claim=agents follow them (the T5c rerun measures that)
  const surfaces = readFileSync(join(scripts, '..', 'references/surfaces.md'), 'utf8');
  const maestro = surfaces.slice(surfaces.indexOf('## Maestro recipe'), surfaces.indexOf('## CI step'));
  assert.match(maestro, /propose the step whenever a point is a Maestro flow/);
  assert.match(maestro, /--exclude-tags boxes/);
  assert.match(maestro, /maestro --udid "\$MAESTRO_UDID" hierarchy > "shots\/ios\/<screen>\.\$L\.maestro\.json"/);
  assert.match(maestro, /boxes maestro "shots\/ios\/<screen>\.\$L\.maestro\.json" > "shots\/ios\/<screen>\.\$L\.boxes\.json"/);
  assert.match(maestro, /`--boxes shots\/ios`/);
  const pw = surfaces.slice(surfaces.indexOf('## Playwright matcher'), surfaces.indexOf('## Maestro recipe'));
  assert.match(pw, /has the `saveDir` option/);
  assert.match(pw, /CATSCAN_SAVE_DIR=test-results\/catscan/);
  assert.match(pw, /formats test-results\/catscan\n/);
  assert.match(pw, /fit test-results\/catscan --boxes test-results\/catscan --reasons wrapped\n/);
  assert.match(pw, /contrast test-results\/catscan --boxes test-results\/catscan --experimental\n/);
});

test('find-points: video producers are kind e, with the test lines that run them; an ffmpeg probe is none (TODO-090 T1, D3, D16)', () => {
  // Value: protects=video gets a point when a test runs the producer; fails_when=a producer shape is missed, a probe counts, or run_by misses the spec past the example cap; why_new=no video rule existed; seam=none; no_claim=a real ffmpeg run
  const repo = repoWith({
    'packages/build/package.json': '{}', 'app/build/out.js': "spawn('ffmpeg', ['-i', 'x']);\n",
    'packages/build/bin/takes.mjs': "const part = join(OUT, `${id}.part.mp4`);\nspawn('ffmpeg', ['-y', '-f', 'image2pipe', '-i', '-', part]);\n",
    'apps/game/e2e-device/suite.mjs': "await device.adb(['shell', 'screenrecord', '--time-limit', '8', remote]);\n",
    'apps/a/scripts/timelapse.mjs': "spawnSync('ffmpeg', encodeArgs(frames, fps, part), { stdio: 'inherit' });\n",
    'apps/a/scripts/capture.mjs': "const ok = spawnSync('ffmpeg', ['-version']).status === 0;\n",
    'apps/a/e2e/scripts.spec.ts': "test('timelapse', () => {\n  script('timelapse.mjs', [FIXTURE]);\n});\n",
    'apps/a/e2e/one.spec.ts': "x('timelapse.mjs');\n", 'apps/a/e2e/zz.spec.ts': "x('old-timelapse.mjs'); y('timelapse.mjsx');\n",
    'scripts/mix.sh': 'ffmpeg -version && ffmpeg -i a.png out.mp4\n', 'apps/a/e2e/two.spec.ts': "x('timelapse.mjs');\n", 'apps/a/e2e/three.spec.ts': "x('timelapse.mjs');\n",
    'apps/a/scripts/b.mjs': "spawn('ffmpeg', ['-i', 'a.png', 'b.mp4']);\n", 'apps/a/scripts/c.mjs': "spawn('ffmpeg', ['-i', 'a.png', 'c.mp4']);\n",
    'apps/a/scripts/d.mjs': "spawn('ffmpeg', ['-i', 'a.png', 'd.mp4']);\n",
    'e2e/record.spec.ts': "spawn('ffmpeg', ['-i', 'f.png', 'out.mp4']);\n", 'e2e/other.spec.ts': "x('record.spec.ts');\n",
    'flows/rec.yaml': '- startRecording: run\n', 'playwright.config.ts': "export default { use: { video: 'on' } };\n",
    'scripts/rec.sh': 'xcrun simctl io booted recordVideo out.mov\n',
  });
  const out = JSON.parse(node('find-points.mjs', [repo, '--all']).stdout);
  const video = out.groups.filter((g) => g.kind === 'video');
  assert.deepEqual(video.flatMap((g) => g.examples.map((e) => `${g.producer} ${e.file}:${e.line}`)).sort(), [
    'adb-screenrecord apps/game/e2e-device/suite.mjs:1', 'ffmpeg apps/a/scripts/b.mjs:1', 'ffmpeg apps/a/scripts/c.mjs:1', 'ffmpeg apps/a/scripts/d.mjs:1',
    'ffmpeg apps/a/scripts/timelapse.mjs:1', 'ffmpeg e2e/record.spec.ts:1', 'ffmpeg packages/build/bin/takes.mjs:2', 'ffmpeg scripts/mix.sh:1',
    'maestro-recording flows/rec.yaml:1', 'playwright-video playwright.config.ts:1', 'simctl-recordVideo scripts/rec.sh:1',
  ]);
  assert.deepEqual(video.find((g) => g.dir === 'e2e').run_by, [], 'a producer that is itself a test lists no run_by');
  // Without --all a video group still shows every line (TODO-102: each recording is a point), and run_by covers the timelapse file with 3 lines.
  const capped = JSON.parse(node('find-points.mjs', [repo]).stdout).groups.find((g) => g.producer === 'ffmpeg' && g.dir === 'apps/a/scripts');
  assert.equal(capped.examples.length, 4);
  assert.deepEqual(capped.run_by.map((r) => r.file), ['apps/a/e2e/one.spec.ts', 'apps/a/e2e/scripts.spec.ts', 'apps/a/e2e/three.spec.ts']);
  assert.ok(capped.run_by.every((r) => r.line > 0 && /timelapse\.mjs/.test(r.evidence)));
  assert.ok(!capped.run_by.some((r) => r.file.endsWith('zz.spec.ts')), 'a longer name containing the base name is no hit');
  assert.deepEqual(video.find((g) => g.dir === 'packages/build/bin').run_by, [], 'a producer no test names has an empty run_by');
});

test('find-points: store art and per-locale image paths are candidates, one per line (TODO-090 T2, D4)', () => {
  // Value: protects=feature graphics and store-shots kits become points; fails_when=a template or join path with a locale var is missed, an English-only feature graphic is missed, or a screenshot line is listed twice; why_new=both producers were missed in two trial repos; seam=none; no_claim=whether the art carries text (the agent opens it)
  const repo = repoWith({
    'apps/x/scripts/make-store-assets.mjs': "await shoot(featureGraphic(locale, css), 1024, 500, `${OUT}/feature-graphic-${locale}.png`);\n",
    'apps/y/scripts/make-store-assets.mjs': "files.set('store/feature-graphic-en.png', png);\n",
    'packages/store-shots/src/kit.js': "  state: (localeId, platform, stateId) => posix.join(KIT_DIR, localeId, platform, `${stateId}.png`),\n",
    'apps/z/scripts/art.mjs': "for (const lang of LANGS) write(`store/hero-${lang}.png`, buf);\n",
    'e2e/shots.spec.ts': "await page.screenshot({ path: `shots/${locale}/home.png` });\n",
    'src/game.js': "const label = `${lang}`;\n",
    // A build folder that is a workspace package counts for shot folders too; build output does not.
    'packages/build/package.json': '{}', 'packages/build/shots/de/a.png': 'png', 'packages/build/shots/fr/a.png': 'png',
    'web/build/de/a.png': 'png', 'web/build/fr/a.png': 'png',
  });
  const out = JSON.parse(node('find-points.mjs', [repo, '--all']).stdout);
  assert.deepEqual(flat(out).filter((x) => !x.startsWith('canvas') && !x.includes('committed-locale-shots')), [
    'locale-folder locale-image-path apps/z/scripts/art.mjs:1',
    'locale-folder locale-image-path packages/store-shots/src/kit.js:1',
    'locale-folder playwright-screenshot e2e/shots.spec.ts:1',
    'locale-folder store-art apps/x/scripts/make-store-assets.mjs:1',
    'locale-folder store-art apps/y/scripts/make-store-assets.mjs:1',
  ]);
  const folders = out.groups.filter((g) => g.producer === 'committed-locale-shots').map((g) => g.dir);
  assert.deepEqual(folders, ['packages/build/shots']);
});

test('find-points: code catalogs catscan reads feed the catalog checks with a {locale} template; a rejected one stays in code_catalogs with its reason (TODO-090 T11)', () => {
  // Value: protects=TS and JS catalogs feed --catalog once catscan reads them; fails_when=a readable code catalog still warns, the template is wrong, or a rejected file is silently dropped; why_new=catscan 0.66 reads code catalogs; seam=a fake catscan (real core-js code-catalog reader); no_claim=catalogs with several locales in one file
  const repo = repoWith({
    'app/src/i18n/de.ts': "export default { play: 'Spielen' };\n", 'app/src/i18n/fr.ts': "export default { play: 'Jouer' };\n",
    'app/src/i18n/ja.ts': 'export default makeStrings();\n', 'app/src/lang/pl/index.js': "module.exports = { play: 'Graj' };\n",
    // pt_BR keeps its spelling, since catscan puts --locale into {locale} as is; ko's strings are mutated at runtime;
    // it.ts holds en and fr exports only, a missing catalog for it.
    'app/src/i18n/pt_BR.ts': "export default { play: 'Jogar' };\n",
    // A JS-family file holding a bare JSON object is read as JSON by catscan.
    'app/src/i18n/es.ts': '\uFEFF{ "play": "Jugar" }\n',
    // Starts with { but is no JSON, so catscan's JSON reader rejects it.
    'app/src/i18n/nl.ts': "{ play: 'Spelen' }\n",
    'app/src/i18n/ko.ts': "const s = { play: '재생' };\ns.extra = 'x';\nexport default s;\n",
    'app/src/i18n/it.ts': "export const en = { play: 'Play' };\nexport const fr = { play: 'Jouer' };\n",
  });
  // A Latin-1 file is no UTF-8, which catscan's decoder refuses (never a lossy read).
  writeFileSync(join(repo, 'app/src/i18n/sv.ts'), Buffer.from("export default { play: 'Caf\xe9' };\n", 'latin1'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'latin1');
  const out = pointsOf(repo, fakeCatscan());
  const loc = Object.fromEntries(out.locales.map((l) => [l.locale, l.sources.map((s) => `${s.kind} ${s.file}`)]));
  assert.deepEqual(loc.de, ['catalog app/src/i18n/de.ts']);
  assert.deepEqual(loc.pl, ['catalog app/src/lang/pl/index.js']);
  assert.deepEqual(out.code_catalog_templates, [
    { template: 'app/src/i18n/{locale}.ts', locales: ['de', 'es', 'fr', 'pt_BR'] }, { template: 'app/src/lang/{locale}/index.js', locales: ['pl'] },
  ]);
  const why = Object.fromEntries(out.code_catalogs.map((c) => [c.locale, c.unread[0].reason]));
  assert.deepEqual(Object.keys(why), ['it', 'ja', 'ko', 'nl', 'sv']);
  assert.match(why.nl, /JSON/);
  assert.match(why.sv, /UTF-8/);
  assert.ok(!Object.values(why).some((w) => w.includes(tmpdir())), 'no temp path in a reason');
  assert.match(why.ja, /default export is .*never runs the file/);
  assert.match(why.ko, /^code uses s at 2:\d+ beyond declaring and exporting it/);
  assert.match(why.it, /locale-named exports \(en, fr\) hold none for it/);
  const warn = out.catalog_warnings.find((w) => w.startsWith('it, ja, ko, nl, sv:'));
  assert.match(warn ?? '', /reader rejects .* Fix: export the strings as a plain object literal/);
  assert.ok(!out.catalog_warnings.some((w) => /^(de|fr|pl)[:,]/.test(w)), out.catalog_warnings.join('\n'));
  // A catscan with catalog discovery but no code-catalog reader (before 0.66): code catalogs stay unread, with a note.
  const old = tmp('adopt-old-catscan-');
  mkdirSync(join(old, 'node_modules', '@catscan', 'core-js', 'src'), { recursive: true });
  put(old, { 'node_modules/@catscan/core-js/package.json': '{"name":"@catscan/core-js"}' });
  spawnSync('ln', ['-s', join(REPO_ROOT, 'packages', 'core-js', 'src', 'results.js'), join(old, 'node_modules', '@catscan', 'core-js', 'src', 'results.js')]);
  cpSync(join(JSON.parse(fakeCatscan())[1], '..'), join(old, 'bin'), { recursive: true });
  const o = pointsOf(repo, JSON.stringify([process.execPath, join(old, 'bin', 'catscan.js')]));
  assert.match(o.notes.join('\n'), /reads no JavaScript or TypeScript catalogs \(older than 0\.66\)/);
  assert.deepEqual(o.code_catalog_templates, []);
  assert.ok(o.catalog_warnings.some((w) => /Fix: use catscan 0\.66 or later/.test(w)), o.catalog_warnings.join('\n'));
});

test('find-points: a <locale>/ui.json catalog is filed under the folder locale; an unknown locale is warned (TODO-090 T4, D5; TODO-091)', () => {
  // Value: protects=the main UI catalog counts for its real locale; fails_when=a non-locale stem becomes a locale silently; why_new=catscan discovery reads the stem; seam=a fake catscan (real core-js discovery); no_claim=catscan's own --expect-locales-from (TODO-091)
  const repo = repoWith({
    'app/data/text/en/ui.json': '{"play":"Play"}', 'app/data/text/ru/ui.json': '{"play":"Играть"}',
    'app/data/text/en/cities.json': '{"a":"b"}', 'app/data/text/ru/cities.json': '{"a":"b"}',
    'po/xx.po': 'msgid ""\nmsgstr ""\n"Language: qq\\n"\n',
  });
  const out = pointsOf(repo, fakeCatscan());
  const loc = Object.fromEntries(out.locales.map((l) => [l.locale, l.sources.map((s) => s.file)]));
  assert.deepEqual(loc.en, ['app/data/text/en/cities.json', 'app/data/text/en/ui.json']);
  assert.deepEqual(loc.ru, ['app/data/text/ru/cities.json', 'app/data/text/ru/ui.json']);
  assert.equal(loc.ui, undefined, 'no false locale ui');
  // catscan's own discovery now reads the folder locale for a stem that names no language (TODO-091), so the
  // find-points refile and its warning only fire with an older catscan.
  assert.equal(out.catalog_warnings.filter((w) => /ui\.json/.test(w)).length, 0, out.catalog_warnings.join('\n'));
  assert.ok(out.catalog_warnings.some((w) => /^po\/xx\.po: its locale "qq" is not a language this catscan knows\. Fix: /.test(w)));
});

test('check-diffs: every combination of batches applies with only the batches it names; a malformed batches file fails with its fix (TODO-090 T5, D2, D7, D10)', () => {
  // Value: protects=a developer can take any approved batches; fails_when=a batch needs an unnamed one, two independent batches conflict, or a bad file passes; why_new=check-diffs proved only the full order; seam=none; no_claim=a real trial plan (the dry-run rerun)
  const repo = repoWith({ ...BASE, 'c.txt': 'c\n', 'pkg.json': '{\n  "scripts": {\n    "test": "x"\n  }\n}\n' });
  // 01 wires a hook (a.txt); 02 needs it; 03 is independent.
  const d1 = diffOf(repo, 'a.txt', 'one\ntwo\nthree\nhook\n');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nhook\n'); git(repo, 'add', 'a.txt');
  const d2 = diffOf(repo, 'a.txt', 'one\ntwo\nthree\nhook\nuses-hook\n');
  git(repo, 'reset', '-q', '--hard');
  const d3 = diffOf(repo, 'c.txt', 'c\nstore\n');
  const p = tmp('adopt-plan-');
  mkdirSync(join(p, 'diffs'));
  writeFileSync(join(p, 'diffs', '01-wiring.diff'), d1);
  writeFileSync(join(p, 'diffs', '02-e2e.diff'), d2);
  writeFileSync(join(p, 'diffs', '03-store.diff'), d3);
  const batches = (s) => writeFileSync(join(p, 'batches'), s);
  batches('# batch diffs [after batch...]\nwiring 01-wiring\ne2e 02-e2e.diff after wiring\nstore 03-store\n');
  let r = checkDiffs(repo, p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /; 3 batches apply alone and in every combination with the batches they name after \(2 groups that edit no file in common\)$/m);
  batches('wiring 01-wiring\ne2e 02-e2e\nstore 03-store\n');
  r = checkDiffs(repo, p);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^FAIL batches e2e: 02-e2e\.diff does not apply with only the batches e2e taken; fix: name the batch it needs after `after`/m);
  // A combination the full run and every closure miss: b undoes a's edit, c's context needs the original line.
  // a alone, b with a, c alone and a+b+c all apply; a+c does not.
  const t = repoWith({ 'f.txt': 'x\nk\n' });
  const q = tmp('adopt-plan-');
  mkdirSync(join(q, 'diffs'));
  writeFileSync(join(q, 'diffs', '01-a.diff'), diffOf(t, 'f.txt', 'y\nk\n'));
  writeFileSync(join(t, 'f.txt'), 'y\nk\n'); git(t, 'add', 'f.txt');
  writeFileSync(join(q, 'diffs', '02-b.diff'), diffOf(t, 'f.txt', 'x\nk\n'));
  git(t, 'reset', '-q', '--hard');
  writeFileSync(join(q, 'diffs', '03-c.diff'), diffOf(t, 'f.txt', 'x\nz\n'));
  writeFileSync(join(q, 'batches'), 'a 01-a\nb 02-b after a\nc 03-c\n');
  r = checkDiffs(t, q);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /^FAIL batches a\+c: 03-c\.diff does not apply with only the batches a c taken; fix: /m);
  // Malformed files.
  const bad = [
    ['wiring 01-wiring\ne2e 02-e2e after wiring\n', /03-store\.diff is in 0 batches; fix: put every default diff in exactly one batch/],
    ['wiring 01-wiring 02-e2e\ne2e 02-e2e\nstore 03-store\n', /02-e2e\.diff is in 2 batches/],
    ['wiring 01-wiring\ne2e 02-e2e 09-none after wiring\nstore 03-store\n', /batch e2e names 09-none, which is not in .+; fix: use a diff file name/],
    ['wiring 01-wiring after store\ne2e 02-e2e after wiring\nstore 03-store after e2e\n', /needs itself through its after list; fix: break the cycle/],
    ['wiring 01-wiring\ne2e 02-e2e after nope\nstore 03-store\n', /batch e2e is after nope, which is no batch/],
    ['wiring 01-wiring\nwiring 02-e2e\nstore 03-store\n', /batch wiring is defined twice; fix: one line per batch/],
    ['wiring 01-wiring\ne2e after wiring\nstore 02-e2e 03-store\n', /batch e2e has no diff; fix: /],
    ['# only a comment\n', /no batch; fix: one line per batch/],
    ['wiring 01-wiring 01-wiring.diff\ne2e 02-e2e after wiring\nstore 03-store\n', /batch wiring lists 01-wiring\.diff twice; fix: name each diff once/],
    ['wiring ../01-wiring\ne2e 02-e2e after wiring\nstore 03-store\n', /batch wiring names \.\.\/01-wiring; fix: name a file in .+, with no folder/],
    ['wiring 0*\ne2e 02-e2e after wiring\nstore 03-store\n', /batch wiring names 0\*, which is not in /],
  ];
  for (const [text, re] of bad) {
    batches(text);
    r = checkDiffs(repo, p);
    assert.equal(r.status, 1, text);
    assert.match(r.stderr, re, text);
  }
  writeFileSync(join(p, 'diffs', '04-experimental-e2e-fit.diff'), diffOf(repo, 'b.txt', 'b\nfit\n'));
  batches('wiring 01-wiring\ne2e 02-e2e after wiring\nstore 03-store 04-experimental-e2e-fit\n');
  r = checkDiffs(repo, p);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lists the experimental diff 04-experimental-e2e-fit\.diff; fix: list default diffs only/);
});

test('the no-commit scratch recipe makes chained diffs check-diffs passes, with a gitignored tracked file and no commit (TODO-090 T3, D9)', () => {
  // Value: protects=the SKILL.md recipe works as written in a dry run; fails_when=git add without -f drops a tracked ignored file's edit, or the recipe commits; why_new=the old step committed; seam=none; no_claim=other git versions
  const repo = repoWith({ ...BASE, 'shots/keep.txt': 'tracked under an ignored folder\n' });
  const p = tmp('adopt-plan-');
  const scratch = join(p, 'scratch');
  mkdirSync(join(p, 'diffs')); mkdirSync(scratch);
  const sh = (cmd) => { const r = spawnSync('bash', ['-c', cmd], { cwd: scratch, env: gitEnv, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  sh(`git -C ${JSON.stringify(repo)} archive HEAD | tar -x && git init -q && git add -A -f`);
  writeFileSync(join(scratch, 'shots', 'keep.txt'), 'edited\n');
  writeFileSync(join(scratch, 'new.txt'), 'new\n');
  sh(`git add -N -f . && git diff > ${JSON.stringify(join(p, 'diffs', '01-a.diff'))} && git add -A -f`);
  writeFileSync(join(scratch, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  sh(`git add -N -f . && git diff > ${JSON.stringify(join(p, 'diffs', '02-b.diff'))} && git add -A -f`);
  const d1 = readFileSync(join(p, 'diffs', '01-a.diff'), 'utf8');
  assert.match(d1, /shots\/keep\.txt/); assert.match(d1, /new file mode .*\n[\s\S]*new\.txt|new\.txt[\s\S]*new file mode/);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: scratch, env: gitEnv }).status, 1, 'no commit in the scratch copy');
  const r = checkDiffs(repo, p);
  assert.equal(r.status, 0, r.stderr);
});

test('a kind with real precision 0 is below certainty high, so the opt-in step never gates on it; checks.md says how to offer it (TODO-090 T6, D1, D6)', () => {
  // Value: protects=a zero-precision default check never fails a run from the opt-in step; fails_when=a registry row at real precision 0 becomes certainty high, or the rule is edited away; why_new=overlap stacked was wired gating; seam=none; no_claim=the measured precision itself
  const reg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'core-js', 'src', 'findings-registry.json'), 'utf8'));
  const zero = reg.rows.filter((r) => r.real && r.real.precision === 0 && r.real.flags > 0);
  assert.ok(zero.length > 0, 'the registry has a zero-precision row to guard');
  for (const r of zero) assert.notEqual(r.certainty, 'high', `${r.kind}/${r.rule} (${r.reader})`);
  const checks = readFileSync(join(scripts, '..', 'references', 'checks.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(checks, /offer that group as an experimental group .* labelled "default in catscan, real precision 0"/);
  assert.match(checks, /the group stays in the default step and gates on all its kinds: .* `--allow` file, never a looser check/);
});

test('a per-locale wrapper skips a missing locale but fails an empty run, and a proof never depends on other points (TODO-090 T7, D8)', () => {
  // Value: protects=single-point mutation proofs reach their check; fails_when=the skip or the empty-run exit is edited away; why_new=a shared wrapper exited 4 in a narrowed run; seam=none; no_claim=agents follow it (the dry-run rerun)
  const read = (p) => readFileSync(join(scripts, '..', p), 'utf8').replace(/\s+/g, ' ');
  assert.match(read('references/surfaces.md'), /skips a locale with no shots with a warning line naming it and goes on, and exits 4 when no locale has shots/);
  assert.match(read('references/proof.md'), /must not depend on other points' outputs: a narrowed run that exits 4 for another point's missing shots is no proof/);
});

test('the skill text carries the TODO-090 rules: kind e, batches, the no-commit scratch, help, union, report step, flat base locale, step 4, recipe (TODO-090 T1, T3, T5, T8, D11-D13, D15, D17)', () => {
  // Value: protects=the dry-run gaps stay fixed in the text agents read; fails_when=one rule is edited away; why_new=three trial runs found them; seam=none; no_claim=agents follow them (the dry-run rerun)
  const read = (p) => readFileSync(join(scripts, '..', p), 'utf8').replace(/\s+/g, ' ');
  const skill = read('SKILL.md');
  assert.match(skill, /`locale-folder`, `video`\), `producer`/);
  assert.match(skill, /as `references\/diffs\.md` says/);
  assert.doesNotMatch(skill, /git init` and commit/);
  assert.match(skill, /A batch whose `after` batch was declined is not applied/);
  assert.match(skill, /read `catscan <command> --help`\s+\(that command's usage, options and exit codes\)/);
  assert.match(skill, /\*\*Do not invent\.\*\* .* write "could not determine, check by hand" and what to check, never a guessed reason/);
  assert.match(skill, /in a monorepo, add `--path <app dir>`/);
  assert.match(skill, /last, "Not examined": each producer-like file you could not resolve/);
  assert.match(read('references/points.md'), /## Not examined .* do not guess \("hand-run, no test"\)/);
  const diffs = read('references/diffs.md');
  assert.match(diffs, /wiring 01-shots-wrapper e2e 02-e2e-shots 03-e2e-canvas after wiring store 04-store-kit/);
  assert.match(diffs, /commit nothing, in the scratch copy or anywhere else/);
  assert.match(diffs, /git init -q && git add -A -f # an index only/);
  assert.match(diffs, /git add -N -f \. && git diff > <plan>\/diffs\/NN-<point>\.diff && git add -A -f/);
  assert.match(diffs, /A run whose last line says the batches are not proved is not done/);
  assert.match(read('references/points.md'), /Kind order a > b > c > d > e/);
  assert.match(read('references/checks.md'), /join into one `--rules` list: the union of both/);
  const surfaces = read('references/surfaces.md');
  assert.match(surfaces, /`catscan report <merged\.json> --out <report\.html>` for one report \(`results merge` writes no report\)/);
  assert.match(surfaces, /An untagged base locale in a flat folder, only when the same screen also exists with a locale tag there .* `--layout none --locale <base>`/);
  assert.match(read('references/measure.md'), /each batch's estimate \(step 4\)/);
  const recipe = readFileSync(join(REPO_ROOT, 'docs', 'recipes', 'catscan-adopt.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(recipe, /Every default batch applies with only the batches it names as needed, in any combination/);
  assert.match(recipe, /Video a test or script renders or records, and store art with a title or tagline rendered per locale, are points too/);
  assert.match(recipe, /measured real-data precision is 0, where it is the only check a screenshot set can feed, is offered the same way/);
});

test('check-diffs: batches that share no file are proved group by group, fast; a wiring batch with many dependents stays fast; a group over 8 batches that edit one file fails with its fix (TODO-090 T5, D7)', () => {
  // Value: protects=check-diffs finishes in agent time at a dozen batches; fails_when=combinations run across independent batches (minutes) or the group cap is dropped; why_new=12 independent batches took over 6 minutes; seam=none; no_claim=timing on a large tree
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, `x${i}\n`]));
  const repo = repoWith(files);
  const p = tmp('adopt-plan-');
  mkdirSync(join(p, 'diffs'));
  for (let i = 0; i < 12; i++) writeFileSync(join(p, 'diffs', `${String(i + 1).padStart(2, '0')}-p${i}.diff`), diffOf(repo, `f${i}.txt`, `x${i}\ny\n`));
  writeFileSync(join(p, 'batches'), Array.from({ length: 12 }, (_, i) => `b${i} ${String(i + 1).padStart(2, '0')}-p${i}`).join('\n') + '\n');
  const t0 = Date.now();
  let r = checkDiffs(repo, p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /12 batches apply alone .* \(12 groups that edit no file in common\)$/m);
  assert.ok(Date.now() - t0 < 30000, `took ${Date.now() - t0} ms`);
  // A wiring batch with 11 dependents on their own files: after links alone group nothing.
  writeFileSync(join(p, 'batches'), Array.from({ length: 12 }, (_, i) => `b${i} ${String(i + 1).padStart(2, '0')}-p${i}${i > 0 ? ' after b0' : ''}`).join('\n') + '\n');
  r = checkDiffs(repo, p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /12 batches apply alone .* \(12 groups that edit no file in common\)$/m);
  // Nine batches that edit one shared file are one group: over the cap of 8.
  const lines = Array.from({ length: 60 }, (_, i) => `l${i}`);
  const repo2 = repoWith({ 's.txt': `${lines.join('\n')}\n` });
  const p2 = tmp('adopt-plan-');
  mkdirSync(join(p2, 'diffs'));
  for (let i = 0; i < 9; i++) {
    const edited = lines.map((l, k) => (k === 3 + i * 6 ? `${l}-b${i}` : l));
    writeFileSync(join(p2, 'diffs', `${String(i + 1).padStart(2, '0')}-s${i}.diff`), diffOf(repo2, 's.txt', `${edited.join('\n')}\n`));
  }
  writeFileSync(join(p2, 'batches'), Array.from({ length: 9 }, (_, i) => `b${i} ${String(i + 1).padStart(2, '0')}-s${i}`).join('\n') + '\n');
  r = checkDiffs(repo2, p2);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /9 batches edit shared files \(b0 b1 b2 b3 b4 b5 b6 b7 b8\), and every combination of them is applied; fix: at most 8 per group/);
});

test('check-diffs: a batch that adds a file and one that adds a folder of that name are one group (TODO-090 D7)', () => {
  // Value: protects=batches that each pass alone but clash as file and folder; fails_when=grouping compares exact paths only; why_new=outside-voice finding on path-only grouping; seam=none; no_claim=symlinks
  const repo = repoWith({ x: 'x\n' });
  const step = (fn) => { fn(); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 's'); return spawnSync('git', ['diff', 'HEAD~1', 'HEAD'], { cwd: repo, encoding: 'utf8', env: gitEnv }).stdout; };
  const a = step(() => rmSync(join(repo, 'x')));
  const b = step(() => { mkdirSync(join(repo, 'x')); writeFileSync(join(repo, 'x', 'y'), 'y\n'); });
  const d = step(() => rmSync(join(repo, 'x'), { recursive: true }));
  const c = step(() => writeFileSync(join(repo, 'x'), 'new\n'));
  git(repo, 'reset', '-q', '--hard', 'HEAD~4');
  const p = tmp('adopt-plan-');
  mkdirSync(join(p, 'diffs'));
  writeFileSync(join(p, 'diffs', '01-a.diff'), a); writeFileSync(join(p, 'diffs', '02-b.diff'), b);
  writeFileSync(join(p, 'diffs', '03-d.diff'), d); writeFileSync(join(p, 'diffs', '04-c.diff'), c);
  writeFileSync(join(p, 'batches'), 'a 01-a\nb 02-b after a\nd 03-d after b\nc 04-c after a\n');
  const r = checkDiffs(repo, p);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /^FAIL batches b\+c: /m);
});

test('find-points: a locale token in a shot name, a data-URL PNG writer, and --path scope (TODO-090 gaps 3-5)', () => {
  // Value: protects=per-locale shot names, canvas data-URL PNG writers and one app of a monorepo; fails_when=the token, the producer or the scope filter is dropped; why_new=missed on the PC game trial; seam=none; no_claim=locale variables derived from a locale (post-1.0)
  const repo = repoWith({
    'apps/a/e2e/sheet.spec.ts': "await page.screenshot({ path: 'out/nuclear-sheet-ru.png' });\nawait page.screenshot({ path: 'out/nuclear-sheet.png' });\nawait page.screenshot({ path: 'out/map-id.png' });\nawait page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css', timeout: 30000, omitBackground: false, path: 'out/very/long/folder/name/for/the/sheet-ru.png' });\n",
    'apps/a/scripts/rec.mjs': "spawn('ffmpeg', ['-i', 'a.png', 'rec.mp4']);\n", 'e2e/root.spec.ts': "x('rec.mjs');\n",
    'apps/a/scripts/atlas.mjs': "const png = (name, url) => writeFileSync(join(OUT, `${name}.png`), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));\n",
    'apps/a/data/text/de/a.json': '{}', 'apps/a/data/text/fr/a.json': '{}',
    'apps/b/e2e/home.spec.ts': "await page.screenshot({ path: 'b.png' });\n",
    'apps/b/shots/de/x.png': 'png', 'apps/b/shots/ja/x.png': 'png',
  });
  const out = JSON.parse(node('find-points.mjs', [repo, '--all']).stdout);
  assert.deepEqual(flat(out).filter((x) => x.includes('apps/a/')), [
    'locale-folder playwright-screenshot apps/a/e2e/sheet.spec.ts:1',
    'locale-folder playwright-screenshot apps/a/e2e/sheet.spec.ts:4',
    'unchecked-shot data-url-png apps/a/scripts/atlas.mjs:1',
    'unchecked-shot playwright-screenshot apps/a/e2e/sheet.spec.ts:2',
    'unchecked-shot playwright-screenshot apps/a/e2e/sheet.spec.ts:3',
    'video ffmpeg apps/a/scripts/rec.mjs:1',
  ], 'id is a folder word, never a token; a token past the 160-character evidence still counts');
  const a = JSON.parse(node('find-points.mjs', [repo, '--path', 'apps/a/', '--all']).stdout);
  assert.equal(a.path, 'apps/a');
  assert.ok(flat(a).every((x) => x.includes(' apps/a/')), flat(a).join('\n'));
  assert.ok(!a.locales.some((l) => l.locale === 'ja'), 'apps/b locales stay out');
  assert.deepEqual(a.groups.find((g) => g.kind === 'video').run_by.map((r) => r.file), ['e2e/root.spec.ts'], 'a test outside --path still runs the producer');
  const whole = JSON.parse(node('find-points.mjs', [repo, '--path', '.', '--all']).stdout);
  assert.equal(whole.path, null, '--path . is the whole repo');
  assert.deepEqual(flat(whole), flat(out));
  for (const bad of ['/abs', '/', '../x', 'apps/none']) {
    const r = node('find-points.mjs', [repo, '--path', bad]);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /--path/);
  }
});
