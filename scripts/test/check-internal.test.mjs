// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-060 T1: scripts/check-internal.mjs rules, surfaces, CHANGELOG filter, modes and refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RULES, SURFACES, checkFiles, findInLine, help, publicChangelog, splitComment, surfaceOf,
} from '../check-internal.mjs';
import { landPlan, readAllowlist, trackedFiles } from '../public-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SCRIPT = path.join(HERE, '..', 'check-internal.mjs');
const rules = (line, first = null) => findInLine(line, first).map((h) => h.rule);

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-internal-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}
const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });
const check = (files, first = null) => {
  const root = tree(files);
  return checkFiles(Object.keys(files).map((p) => ({ path: p, abs: path.join(root, p) })), first);
};

test('each rule fires on a fixture line', () => {
  const cases = {
    'internal-ref': ['see TODO-006', 'results/todo-044-assignment.json', 'planned (spec 16)', 'specs 12 and 13', 'spec D14: absent', 'as decided (D1)', 'ROADMAP item 7'],
    'internal-history': ['named `test-speed` before 0.12.10', 'catscan 0.12.4 wrote it', 'released as v0.35.4',
      'The skill was named `test-speed`.', 'renamed from scan', 'formerly the scan command'],
    'internal-narration': ['an owner decision', "the owner's game A build", "the owner's self-hosted runner",
      'after the eng review', 'one more review pass', 'the outside voice said', 'in this session'],
    'internal-lab-path': ['docs/todos/TODO-050.md', 'docs/specs/06-truncation.md', 'see docs/STATUS.md', 'ROADMAP.md',
      'TODOS.md', '.claude/plans/x.md', '../todos/TODO-051.md', '../specs/x.md'],
    'internal-commit': ['clean checkout of commit 4757789'],
    'internal-tool': ['run gstack', '/plan-eng-review', 'use /ship to land', 'Bugbot said', 'on Capy'],
  };
  for (const [rule, lines] of Object.entries(cases)) for (const l of lines) assert.ok(rules(l).includes(rule), `${rule}: ${l}`);
  const { findings } = check({ 'docs/a.md': 'x\nsee TODO-006 here\n' });
  assert.deepEqual(findings, [{ path: 'docs/a.md', line: 2, rule: 'internal-ref', match: 'TODO-006' }]);
});

test('words users need do not fire', () => {
  for (const l of ['ask the owner of the project', 'the project owner', 'Codex and Cursor', 'Tesseract 5.5.3', 'Node v26.13.0',
    'GitLab CI', 'color: lab(50% 40 59)', 'color: #D00;', 'a 3D scene', 'https://example.com/ship', 'a matcher was called in a way',
    'exclude `.claude/worktrees/`', '~/.claude/skills/catscan', '.claude/settings.json', 'the spec file']) {
    assert.deepEqual(rules(l), [], l);
  }
});

test('internal-history versions: older than the first public version, every version while it is unset', () => {
  for (const l of ['before 0.12.10', 'catscan 0.12.4', 'released as 0.35.4']) {
    assert.deepEqual(rules(l), ['internal-history'], `${l} unset`);
    assert.deepEqual(rules(l, '0.40.0'), ['internal-history'], `${l} 0.40.0`);
    assert.deepEqual(rules(l, '0.10.0'), [], `${l} 0.10.0`);
  }
  assert.deepEqual(rules('since catscan 0.40.0', '0.40.0'), []);
});

test('surfaces: runtime comments are counted, strings and template lines fail, report assets and plugins fail on comments', () => {
  const r = check({
    'packages/x/src/a.js': '// TODO-001 why\nconst s = "spec 12";\nconst u = "https://x" // TODO-002\nconst t = `\n  TODO-003 inside\n`;\n',
    'packages/core-js/src/report/page.js': '// TODO-049 D1\n',
    'plugins/catscan/skills/s/scripts/a.mjs': '// spec 25\n',
    'scripts/x.mjs': '// TODO-004 and docs/specs/x.md\n',
    'test/x.js': '// see docs/todos/TODO-001.md\n',
    'packages/x/test/a.test.js': 'read("docs/specs/00-conventions.md");\n',
  });
  const where = r.findings.map((f) => `${f.path}:${f.line} ${f.match}`);
  assert.deepEqual(where, [
    'packages/x/src/a.js:2 spec 12',
    'packages/x/src/a.js:5 TODO-003',
    'packages/core-js/src/report/page.js:1 TODO-049',
    'packages/core-js/src/report/page.js:1 D1',
    'plugins/catscan/skills/s/scripts/a.mjs:1 spec 25',
    'test/x.js:1 docs/todos/',
  ]);
  assert.equal(r.counts['internal-ref'], 4); // a.js lines 1 and 3, scripts/x.mjs, test/x.js
  assert.equal(r.counts['internal-lab-path'], 2); // scripts/ and package tests name lab paths as data (D17)
  assert.deepEqual(splitComment('const u = "https://x" // c'), { code: 'const u = "https://x"', comment: ' // c' });
  assert.deepEqual(splitComment('  * JSDoc line'), { code: '', comment: '  * JSDoc line' });
});

test('CHANGELOG: only the sections that land are checked; the public file starts at the first public version', () => {
  const text = '# Changelog\n\nLab intro (TODO-001).\n\n## [0.41.0] - x\n\n- New.\n\n## [0.40.0] - x\n\n- Mid (TODO-002).\n\n## [0.39.0] - x\n\n- Old (TODO-003).\n';
  assert.deepEqual(check({ 'CHANGELOG.md': text }).findings, []);
  assert.deepEqual(check({ 'CHANGELOG.md': text }, '0.40.0').findings.map((f) => f.match), ['TODO-002']);
  const pub = publicChangelog(text, '0.40.0');
  assert.match(pub, /^# Changelog\n\n.*developed privately.*\n\n## \[0\.41\.0\]/);
  assert.ok(pub.includes('## [0.40.0]') && !pub.includes('0.39.0') && !pub.includes('Lab intro'));
  assert.equal(publicChangelog(pub, '0.40.0'), pub);
  assert.deepEqual(rules(pub.split('\n')[2]), []);
});

test('every path in the real land plan has a surface; an unclassified path is reported', { skip: !fs.existsSync(path.join(ROOT, 'scripts/public-paths.txt')) && 'product repo: no allowlist' }, () => {
  const plan = landPlan(readAllowlist(ROOT), trackedFiles(ROOT));
  assert.deepEqual(plan.filter((p) => !surfaceOf(p.dest)).map((p) => p.dest), []);
  assert.equal(surfaceOf('newdir/a.js'), null);
  assert.deepEqual(check({ 'newdir/a.js': 'x\n' }).unclassified, ['newdir/a.js']);
});

test('the product CI and the lab CI run the check', () => {
  const product = ['public/.github/workflows/ci.yml', '.github/workflows/ci.yml'].map((p) => path.join(ROOT, p)).find(fs.existsSync);
  assert.match(fs.readFileSync(product, 'utf8'), /run: node scripts\/check-internal\.mjs\n/);
  const lab = path.join(ROOT, '.github/workflows/macos.yml');
  if (fs.existsSync(lab)) assert.match(fs.readFileSync(lab, 'utf8'), /scripts\/land-public\.sh "\$\(cat VERSION\)" --dry-run --ref HEAD/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (fs.existsSync(path.join(ROOT, 'scripts/public-paths.txt'))) assert.match(pkg.scripts['docs:check'], /check-internal\.mjs --allowlist/);
});

test('CLI: --list checks exactly the listed files, exit 0/1/2, findings on stderr', () => {
  const root = tree({ 'docs/a.md': 'clean\n', 'docs/b.md': 'see TODO-006\n' });
  const list = path.join(root, '.list');
  fs.writeFileSync(list, 'docs/a.md\n');
  let r = run(['--root', root, '--list', list]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok \(1 files/);
  fs.writeFileSync(list, 'docs/a.md\ndocs/b.md\n');
  r = run(['--root', root, '--list', list]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^check-internal: docs\/b\.md:1 internal-ref "TODO-006" - say the behavior/m);
  assert.match(r.stderr, /1 finding in reader-facing files/);
  assert.match(r.stderr, /^fix in the lab, then rerun: npm run docs:check/m);
  assert.equal(run(['--bogus']).status, 2);
});

test('CLI refusals name their fix: an unclassified path, an unreadable file', () => {
  const root = tree({ 'newdir/a.js': 'x\n', 'docs/a.md': 'x\n' });
  const list = path.join(root, '.list');
  fs.writeFileSync(list, 'newdir/a.js\n');
  let r = run(['--root', root, '--list', list]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /newdir\/a\.js has no surface; add it to SURFACES in scripts\/check-internal\.mjs/);
  fs.writeFileSync(list, 'docs/missing.md\n');
  r = run(['--root', root, '--list', list]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read docs\/missing\.md \(ENOENT\); fix the file or its permissions and rerun/);
  if (process.getuid?.() !== 0) {
    fs.chmodSync(path.join(root, 'docs/a.md'), 0);
    fs.writeFileSync(list, 'docs/a.md\n');
    r = run(['--root', root, '--list', list]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read docs\/a\.md \(EACCES\)/);
  }
});

test('--help lists every rule and surface the code defines', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, help());
  for (const id of Object.keys(RULES)) assert.ok(r.stdout.includes(id), id);
  for (const [name, globs] of SURFACES) assert.ok(r.stdout.includes(`${name}: ${globs.join(' ')}`), name);
});

test('CLI: with FIRST_PUBLIC_VERSION unset, the tree\'s VERSION is the first public one (D19)', () => {
  const root = tree({ VERSION: '1.0.0\n', 'docs/a.md': 'Tested with catscan 1.0.0.\n', 'docs/b.md': 'Since catscan 0.9.0.\n' });
  const list = path.join(root, '.list');
  fs.writeFileSync(list, 'docs/a.md\n');
  assert.equal(run(['--root', root, '--list', list]).status, 0);
  fs.writeFileSync(list, 'docs/b.md\n');
  assert.match(run(['--root', root, '--list', list]).stderr, /internal-history "catscan 0\.9\.0"/);
});

// Value: protects=the product CI mode (no flags) checks exactly the tracked files of a git checkout and refuses a non-git root with exit 2;
// fails_when=the default mode lists untracked files, skips tracked ones, or runs on a plain folder; why_new=other CLI tests pass --list;
// seam=none; no_claim=the real product repo (a throwaway git index stands in for it)
test('CLI default mode: every tracked file of the checkout, nothing untracked; a non-git root exits 2', () => {
  const root = tree({ 'docs/a.md': 'clean\n', 'docs/b.md': 'see TODO-006\n', 'docs/u.md': 'untracked TODO-007\n' });
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('add', 'docs/a.md', 'docs/b.md').status, 0);
  const r = run(['--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/b\.md:1 internal-ref "TODO-006"/);
  assert.doesNotMatch(r.stderr, /TODO-007/);
  assert.equal(git('rm', '-q', '--cached', 'docs/b.md').status, 0);
  assert.match(run(['--root', root]).stdout, /ok \(1 files/);
  const plain = tree({ 'docs/a.md': 'x\n' });
  const p = run(['--root', plain]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /is not a git checkout; pass --list FILE or --allowlist/);
});

// Value: protects=bad arguments exit 2 with a message instead of checking with a wrong first public version or none;
// fails_when=a value or X.Y.Z guard is dropped, so a bad version makes every version history or empties the public CHANGELOG;
// why_new=only an unknown flag was tested; seam=none; no_claim=none beyond protects
test('CLI usage refusals: a flag without a value, a bad version, --public-changelog without a version, an empty or missing input', () => {
  const root = tree({ 'CHANGELOG.md': '# Changelog\n\n## [1.0.0] - x\n', '.empty': '' });
  const cl = path.join(root, 'CHANGELOG.md');
  const cases = [
    [['--root'], /--root needs a value/],
    [['--root', root, '--list', path.join(root, '.empty')], /--list .* is empty/],
    [['--first-public', '1.2', '--root', root, '--list', cl], /--first-public 1\.2 is not X\.Y\.Z/],
    [['--public-changelog', path.join(root, 'nope.md'), '--first-public', '1.0.0'], /cannot rewrite .*nope\.md \(ENOENT\)/],
  ];
  // With FIRST_PUBLIC_VERSION unset in the checker, --public-changelog must name the version itself.
  if (fs.readFileSync(SCRIPT, 'utf8').includes('FIRST_PUBLIC_VERSION = null;')) cases.push([['--public-changelog', cl], /--public-changelog needs --first-public X\.Y\.Z/]);
  for (const [args, msg] of cases) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, msg, args.join(' '));
  }
  assert.equal(fs.readFileSync(cl, 'utf8'), '# Changelog\n\n## [1.0.0] - x\n');
});

// Value: protects=a landed file name, a shell script message and an npm description are checked, comments stay report-only; fails_when=checkFiles reads contents only, shell "#" lines count as code, or packages/*/package.json is report-only; why_new=outside review found these holes; seam=none; no_claim=binary file contents
test('file names, shell scripts and npm package.json are checked', () => {
  const r = check({
    'results/todo-061-x.json': '{}\n',
    'scripts/a.sh': '# Spec 25 D14: why\necho "see D7" # TODO-001\n',
    'scripts/b.mjs': 'const lab = "docs/specs/x.md"; // the lab tree, as data\n',
    'packages/x/package.json': '{ "description": "per TODO-002" }\n',
  });
  assert.deepEqual(r.findings.map((f) => `${f.path}:${f.line} ${f.match}`), [
    'results/todo-061-x.json:0 todo-061',
    'scripts/a.sh:2 D7',
    'packages/x/package.json:1 TODO-002',
  ]);
  assert.deepEqual(splitComment('echo "$#" # note', true), { code: 'echo "$#"', comment: ' # note' });
  assert.equal(surfaceOf('scripts/check-internal.mjs'), 'source');
});

// Value: protects=the land never writes through a CHANGELOG.md symlink; fails_when=--public-changelog follows the link and overwrites its target; why_new=outside review; seam=none; no_claim=none beyond protects
test('--public-changelog refuses a symlink and leaves its target alone', () => {
  const root = tree({ 'target.md': 'keep me\n' });
  fs.symlinkSync(path.join(root, 'target.md'), path.join(root, 'CHANGELOG.md'));
  const r = run(['--public-changelog', path.join(root, 'CHANGELOG.md'), '--first-public', '1.0.0']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is a symlink; CHANGELOG\.md must be a regular file/);
  assert.equal(fs.readFileSync(path.join(root, 'target.md'), 'utf8'), 'keep me\n');
});

// Value: protects=a quoted "#" in a shell message stays code, and a landed symlink is checked by name and target; fails_when=the shell split ignores quotes or symlinks are filtered out before checkFiles; why_new=outside review pass 2; seam=none; no_claim=heredoc bodies (documented limit)
test('shell quotes keep "#" in code; symlinks are checked by name and target', () => {
  assert.deepEqual(splitComment('echo "public # TODO-123"', true), { code: 'echo "public # TODO-123"', comment: '' });
  assert.deepEqual(splitComment("x='a # b' # note", true), { code: "x='a # b'", comment: ' # note' });
  const root = tree({ 'docs/a.md': 'ok\n' });
  fs.symlinkSync('../docs/specs/01-plan.md', path.join(root, 'docs/link.md'));
  fs.symlinkSync('a.md', path.join(root, 'docs/todo-099.md'));
  const r = checkFiles(['docs/a.md', 'docs/link.md', 'docs/todo-099.md'].map((p) => ({ path: p, abs: path.join(root, p) })), null);
  assert.deepEqual(r.findings.map((f) => `${f.path} ${f.match}`).sort(), ['docs/link.md docs/specs/', 'docs/todo-099.md todo-099']);
  assert.deepEqual(splitComment("x='a\\' # TODO-003", true), { code: "x='a\\'", comment: ' # TODO-003' });
  assert.deepEqual(splitComment('echo "a \\" # b" # c', true), { code: 'echo "a \\" # b"', comment: ' # c' });
  assert.deepEqual(splitComment('echo \\" # TODO-003', true), { code: 'echo \\"', comment: ' # TODO-003' });
  const list = path.join(root, '.list');
  fs.writeFileSync(list, 'docs/a.md\ndocs/link.md\n');
  const cli = run(['--root', root, '--list', list]);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /docs\/link\.md:0 internal-lab-path "docs\/specs\/"/);
});
