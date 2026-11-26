// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// assertion-budget core contract (TODO-052 D1, D12, D16) with a stub hook, so it runs install-free in
// skills:check. The real-runner proof is test/skills/runners/assertion-budget.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../plugins/catscan/skills/test-speedup/scripts/assertion-budget.cjs', import.meta.url));
const { install, readBudget } = createRequire(import.meta.url)(path);

// A stub runner: hooks are stored; a "test" starts at `before` calls (left over from beforeAll, as Jest does),
// runs beforeEach, reaches `calls` on the global counter, then runs afterEach with the test context.
function runner(env = {}) {
  const before = [];
  const after = [];
  const state = { assertionCalls: 0 };
  install({ beforeEach: (f) => before.push(f), afterEach: (f) => after.push(f), expect: { getState: () => state } }, env);
  // Jest waits for done() on a hook that declares a parameter, so the hooks must declare none.
  assert.deepEqual([...before, ...after].map((f) => f.length), [0, 0]);
  return (calls, ctx, { leftover = 0 } = {}) => {
    state.assertionCalls = leftover;
    before.forEach((f) => f());
    state.assertionCalls = leftover + calls;
    after.forEach((f) => f(ctx));
  };
}

test('the default budget is 1000: 1000 calls pass, 1001 fail with the count, the budget and the rewrite', () => {
  const run = runner();
  run(1000);
  assert.throws(() => run(1001), /1001 expect calls in one test, budget 1000\. Fix: assert once: .*expect\(failures\)\.toEqual\(\[\]\).*inside a waitFor or retry callback, throw/);
});

test('ASSERTION_BUDGET sets the budget; a value that is not a positive integer stops the run with the fix', () => {
  const run = runner({ ASSERTION_BUDGET: '50' });
  run(50);
  assert.throws(() => run(51), /budget 50\./);
  assert.equal(readBudget({}), 1000);
  assert.equal(readBudget({ ASSERTION_BUDGET: '' }), 1000);
  for (const bad of ['0', '-1', 'abc', '1e3', '2.5', ' ']) {
    assert.throws(() => readBudget({ ASSERTION_BUDGET: bad }), /not a positive integer\. Fix: set it to one/, bad);
  }
});

test('the global count and a different context expect (Vitest test.concurrent) are summed', () => {
  const run = runner();
  const local = { getState: () => ({ assertionCalls: 600 }) };
  assert.throws(() => run(401, { expect: local }), /1001 expect calls/);
  run(400, { expect: local });
});

test('expect calls made before the test starts (Jest beforeAll) do not count against it', () => {
  const run = runner();
  run(1000, undefined, { leftover: 600 });
  assert.throws(() => run(1001, undefined, { leftover: 600 }), /1001 expect calls/);
});

test('a Vitest concurrent test counts only its context expect, not the shared global counter', () => {
  const run = runner();
  const local = (n) => ({ getState: () => ({ assertionCalls: n }) });
  run(5000, { expect: local(10), task: { concurrent: true } });
  assert.throws(() => run(0, { expect: local(1001), task: { concurrent: true } }), /1001 expect calls/);
});

test('no per-test opt-out exists (D16): the setup defines no global', () => {
  delete globalThis.allowAssertions;
  runner();
  assert.equal(globalThis.allowAssertions, undefined);
});

test('a setup file with no hooks fails with the config line to use; run as a command it exits 2', () => {
  assert.throws(() => install({}), /no beforeEach\/afterEach\/expect here\. Jest: list assertion-budget\.cjs in setupFilesAfterEnv\. Vitest: list assertion-budget\.vitest\.mjs/);
  for (const marker of [{ VITEST: 'true' }, { JEST_WORKER_ID: '1' }]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path)})`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...marker } });
    assert.notEqual(r.status, 0, JSON.stringify(marker));
    assert.match(r.stderr, /no beforeEach\/afterEach\/expect here/);
  }
  const cmd = spawnSync(process.execPath, [path], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(cmd.status, 2);
  assert.match(cmd.stderr, /a test setup file, not a command/);
});
