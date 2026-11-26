// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// assertion-budget on the real runners (TODO-052 D1, D2, D7): Vitest and Jest from the root devDependencies run
// fixture suites in a temp dir. Lives outside test/skills/*.test.mjs because skills:check runs before npm ci.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scripts = join(repo, 'plugins/catscan/skills/test-speedup/scripts');
const env = { ...process.env, ASSERTION_BUDGET: '', CI: '1' };
delete env.VITEST;
delete env.JEST_WORKER_ID;

const BODY = (expectFrom) => `
test('t1000', (${expectFrom}) => { for (let i = 0; i < 1000; i++) expect(i).toBe(i); });
test('t1001', (${expectFrom}) => { for (let i = 0; i < 1001; i++) expect(i).toBe(i); });
test('next-1000', (${expectFrom}) => { for (let i = 0; i < 1000; i++) expect(i).toBe(i); });
test('assert-once', (${expectFrom}) => { const failures = []; for (let i = 0; i < 5000; i++) if (i !== i) failures.push(i); expect(failures).toEqual([]); });
`;
const WANT = { t1000: 'passed', t1001: 'failed', 'next-1000': 'passed', 'assert-once': 'passed' };

const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'assertion-budget-'));
  roots.push(root);
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  for (const [p, text] of Object.entries(files)) writeFileSync(join(root, p), text);
  return root;
}
const byName = (results) => Object.fromEntries(results.map((r) => [r.title, r.status]));
const failure = (results, title) => results.find((r) => r.title === title).failureMessages.join('\n');

test('Jest: 1000 calls pass, 1001 fail, the count restarts per test, assert-once passes; a file beforeEach counts', () => {
  const root = fixture({
    'a.test.js': BODY('') + "describe('after a beforeAll', () => { beforeAll(() => { for (let i = 0; i < 600; i++) expect(i).toBe(i); }); test('t600-after-beforeAll', () => { for (let i = 0; i < 600; i++) expect(i).toBe(i); }); });\n" + "describe('file beforeEach', () => { beforeEach(() => { for (let i = 0; i < 600; i++) expect(i).toBe(i); }); test('t401-after-beforeEach-600', () => { for (let i = 0; i < 401; i++) expect(i).toBe(i); }); });\n",
    'jest.config.cjs': `module.exports = { rootDir: __dirname, setupFilesAfterEnv: [${JSON.stringify(join(scripts, 'assertion-budget.cjs'))}], cacheDirectory: __dirname + '/.cache' };`,
  });
  const out = join(root, 'out.json');
  spawnSync(process.execPath, [join(repo, 'node_modules/jest/bin/jest.js'), '-c', join(root, 'jest.config.cjs'), '--watchman=false', '--json', '--outputFile', out], { cwd: root, env, encoding: 'utf8' });
  const results = JSON.parse(readFileSync(out, 'utf8')).testResults[0].assertionResults;
  assert.deepEqual(byName(results), { ...WANT, 't600-after-beforeAll': 'passed', 't401-after-beforeEach-600': 'failed' });
  assert.match(failure(results, 't1001'), /1001 expect calls in one test, budget 1000\. Fix: assert once/);
});

function vitest(root, ...args) {
  const out = join(root, 'out.json');
  const r = spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--root', root, '--reporter=json', '--outputFile', out, ...args], { cwd: root, env, encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(readFileSync(out, 'utf8')); } catch {}
  return { r, report };
}

test('Vitest: same contract through the .mjs entry, a file beforeEach counts, and a test.concurrent test is counted through its context expect', () => {
  const root = fixture({
    'a.test.js': `import { test, expect } from 'vitest';\n${BODY('')}`,
    'c.test.js': `import { test } from 'vitest';
test.concurrent('concurrent-over', async ({ expect }) => { for (let i = 0; i < 1001; i++) expect(i).toBe(i); });
test.concurrent('concurrent-under', async ({ expect }) => { for (let i = 0; i < 10; i++) expect(i).toBe(i); });
`,
    'g.test.js': `import { test, expect } from 'vitest';
const tick = () => new Promise((r) => setTimeout(r, 1));
test.concurrent('global-600-a', async () => { for (let i = 0; i < 600; i++) { expect(i).toBe(i); if (i % 50 === 0) await tick(); } });
test.concurrent('global-600-b', async () => { for (let i = 0; i < 600; i++) { expect(i).toBe(i); if (i % 50 === 0) await tick(); } });
`,
    'h.test.js': `import { beforeEach, describe, expect, test } from 'vitest';
describe('file beforeEach', () => { beforeEach(() => { for (let i = 0; i < 600; i++) expect(i).toBe(i); }); test('t401-after-beforeEach-600', () => { for (let i = 0; i < 401; i++) expect(i).toBe(i); }); });
`,
    'vitest.config.mjs': `export default { test: { include: ['*.test.js'], setupFiles: [${JSON.stringify(join(scripts, 'assertion-budget.vitest.mjs'))}] } };`,
  });
  const { r, report } = vitest(root);
  assert.ok(report, r.stderr);
  const results = report.testResults.flatMap((f) => f.assertionResults);
  assert.deepEqual(byName(results), { ...WANT, 'concurrent-over': 'failed', 'concurrent-under': 'passed', 'global-600-a': 'passed', 'global-600-b': 'passed', 't401-after-beforeEach-600': 'failed' });
  assert.match(failure(results, 't1001'), /1001 expect calls in one test, budget 1000/);
  assert.match(failure(results, 'concurrent-over'), /1001 expect calls in one test/);
});

test('Vitest without globals given the .cjs fails the run instead of counting nothing', () => {
  const root = fixture({
    'a.test.js': "import { test, expect } from 'vitest';\ntest('t1001', () => { for (let i = 0; i < 1001; i++) expect(i).toBe(i); });\n",
    'vitest.config.mjs': `export default { test: { include: ['*.test.js'], setupFiles: [${JSON.stringify(join(scripts, 'assertion-budget.cjs'))}] } };`,
  });
  const { r, report } = vitest(root);
  assert.notEqual(r.status, 0);
  assert.match(JSON.stringify(report) + r.stdout + r.stderr, /no beforeEach\/afterEach\/expect here/);
});
