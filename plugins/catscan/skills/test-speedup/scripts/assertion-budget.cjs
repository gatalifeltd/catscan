// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// assertion-budget v1 (catscan test-speedup skill). Self-contained, no dependencies: copy it into
// the project's tools. Fails a test that makes more `expect` calls than the budget (default 1000,
// ASSERTION_BUDGET overrides for the whole run), which is what a loop with an `expect` inside does: lint sees
// a literal loop bound, not a constant, a forEach or a helper. There is no per-test opt-out:
// a test that checks many cases collects its failures and asserts once. Jest: list this file in
// setupFilesAfterEnv. Vitest: list assertion-budget.vitest.mjs in setupFiles.
// Not counted: Jest test.concurrent (afterEach does not see those tests), the global expect inside a Vitest
// concurrent test (test.concurrent, describe.concurrent or sequence.concurrent; those tests share one global counter; their context expect is counted) and node:test.
// An expect inside a waitFor or retry callback counts on every retry: throw there and assert once after the wait.
'use strict';

const FIX = 'assert once: push each failure into an array and expect(failures).toEqual([]) after the loop; '
  + 'inside a waitFor or retry callback, throw instead of calling expect and assert once after the wait';

function readBudget(env) {
  const raw = env.ASSERTION_BUDGET;
  if (raw === undefined || raw === '') return 1000;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`assertion-budget: ASSERTION_BUDGET=${JSON.stringify(raw)} is not a positive integer. Fix: set it to one (1000 is the default) or unset it.`);
  }
  return n;
}

// Vitest gives each test a context expect with its own counter. Concurrent tests share the global counter, so
// for them only the context one is read. The global count is taken from the start of the test (beforeEach):
// Jest resets it only after a test ends, so expect calls in beforeAll would otherwise land on the next test.
function calls(expect, ctx, start) {
  const local = ctx && ctx.expect && ctx.expect !== expect ? ctx.expect.getState().assertionCalls : 0;
  if (ctx && ctx.task && ctx.task.concurrent) return local;
  return expect.getState().assertionCalls - start + local;
}

function install({ beforeEach, afterEach, expect }, env = process.env) {
  if (typeof beforeEach !== 'function' || typeof afterEach !== 'function' || typeof expect?.getState !== 'function') {
    throw new Error('assertion-budget: no beforeEach/afterEach/expect here. Jest: list assertion-budget.cjs in '
      + 'setupFilesAfterEnv. Vitest: list assertion-budget.vitest.mjs in setupFiles.');
  }
  const budget = readBudget(env);
  let start = 0;
  // No declared parameter: Jest reads a hook with one as callback style and waits for done() until its
  // timeout. Vitest passes the test context as the first argument anyway.
  beforeEach(function budgetStart() { start = expect.getState().assertionCalls; });
  afterEach(function budgetCheck() {
    const n = calls(expect, arguments[0], start);
    if (n > budget) throw new Error(`assertion-budget: ${n} expect calls in one test, budget ${budget}. Fix: ${FIX}.`);
  });
  return { budget };
}

module.exports = { install, readBudget, VERSION: 1 };

// Loaded as a setup file (Jest, or Vitest with globals) the hooks and expect are globals: install. The Vitest
// entry sets ENTRY first and installs with the imports from 'vitest'. A setup file that finds no globals
// fails the run instead of counting nothing.
const ENTRY = Symbol.for('test-speedup.assertion-budget.entry');
if (!globalThis[ENTRY]) {
  if (typeof globalThis.expect === 'function' && typeof globalThis.afterEach === 'function'
    && typeof globalThis.beforeEach === 'function') install(globalThis);
  else if (process.env.VITEST || process.env.JEST_WORKER_ID) install({});
  else if (require.main === module) {
    console.error('assertion-budget: a test setup file, not a command. See the header of this file.');
    process.exitCode = 2;
  }
}
