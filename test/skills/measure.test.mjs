// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// measure.sh contract (TODO-006 D3, D11, D17). Runs with the shell's default bash;
// before ship also run it with BASH_UNDER_TEST=/bin/bash on macOS to cover bash 3.2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = fileURLToPath(new URL('../../plugins/catscan/skills/test-speedup/scripts/measure.sh', import.meta.url));
const bash = process.env.BASH_UNDER_TEST ?? 'bash';
const run = (...args) => spawnSync(bash, [script, ...args], { encoding: 'utf8' });
const field = (out, arm, key) => Number(out.match(new RegExp(`^arm=${arm} .*\\b${key}=([0-9.]+)`, 'm'))?.[1]);

test('medians follow the slower arm, labels and status on every result line', () => {
  const r = run('-n', '3', 'before@abc123:warm', 'sleep 0.3', 'after@def456:cold', 'sleep 0.05');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(field(r.stdout, 'A', 'wall_median_s') > field(r.stdout, 'B', 'wall_median_s'));
  assert.match(r.stdout, /^arm=A label=before@abc123:warm runs=3 .* status=ok$/m);
  assert.match(r.stdout, /^arm=B label=after@def456:cold runs=3 .* status=ok$/m);
  assert.match(r.stdout, /daemons .* are excluded/);
});

test('CPU-bound arm reports CPU time, sleeping arm does not', () => {
  const r = run('-n', '1', 'idle@a:cold', 'sleep 0.3', 'busy@b:cold', 'i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(field(r.stdout, 'B', 'cpu_median_s') > field(r.stdout, 'A', 'cpu_median_s'));
});

test('one failed run in either arm invalidates the result with exit 3', () => {
  const r = run('-n', '2', 'a@x:cold', 'true', 'b@y:cold', 'exit 7');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /arm B \(b@y:cold\) run 1 exited 7; timings invalid/);
  assert.match(r.stdout, /status=invalid/);
});

test('a failed warmup run also invalidates', () => {
  const r = run('-n', '1', '--warmup', '1', 'a@x:warm', 'test -e /nonexistent-path-for-test');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /arm A \(a@x:warm\) warmup 1 exited 1/);
});

test('--allow-fail accepts a failing command', () => {
  const r = run('--allow-fail', '-n', '1', 'a@x:cold', 'exit 4');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /status=ok/);
});

// Value: protects=--allow-fail accepts only commands that ran and failed; fails_when=a missing command (127) or a signal death passes as a fast expected failure with status=ok; why_new=the allow-fail test uses exit 4 only; seam=none; no_claim=exit codes 1-125 beyond 4.
test('--allow-fail still invalidates a command that never ran or was killed', () => {
  for (const cmd of ['exit 127', 'kill -SEGV $$']) {
    const r = run('--allow-fail', '-n', '1', 'a@x:cold', cmd);
    assert.equal(r.status, 3, cmd);
    assert.match(r.stdout, /status=invalid/);
  }
});

// Value: protects=pairs alternate AB, BA so the first arm's warm-up effects do not always favor B; fails_when=the loop always runs A before B; why_new=no test read run order; seam=none; no_claim=that alternation removes thermal bias.
test('runs alternate the arm order in each pair', () => {
  const r = run('-n', '2', 'a@x:cold', 'true', 'b@y:cold', 'true');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([...r.stderr.matchAll(/^([AB]) run (\d)/gm)].map((m) => m[1] + m[2]), ['A1', 'B1', 'B2', 'A2']);
});

// Value: protects=timings keep their decimals under a comma-decimal locale; fails_when=LC_ALL=C is dropped and awk truncates 0,40 to 0; why_new=every other test runs in the C/en locale; seam=none; no_claim=locales missing on the host fall back to C and pass trivially.
test('a comma-decimal locale does not truncate timings', () => {
  const r = spawnSync(bash, [script, '-n', '1', 'a@x:cold', 'sleep 0.4'], { encoding: 'utf8', env: { ...process.env, LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(field(r.stdout, 'A', 'wall_median_s') >= 0.3, r.stdout);
});

// Value: protects=the measured command runs in the caller's locale, not measure.sh's C; fails_when=LC_ALL=C leaks into the command or an unset LC_ALL arrives set; why_new=round-3 fix-check found the export leaking into locale-sensitive suites; seam=none; no_claim=whether the locale is installed.
test('the measured command keeps the caller locale', () => {
  const set = spawnSync(bash, [script, '-n', '1', 'a@x:cold', '[ "$LC_ALL" = de_DE.UTF-8 ]'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'de_DE.UTF-8' } });
  assert.equal(set.status, 0, set.stderr);
  const { LC_ALL, ...unset } = process.env;
  const none = spawnSync(bash, [script, '-n', '1', 'a@x:cold', '[ -z "${LC_ALL+x}" ]'], { encoding: 'utf8', env: unset });
  assert.equal(none.status, 0, none.stderr);
});

// Value: protects=--log keeps every run's output so both arms' test counts can be quoted (TODO-006 T5a rerun friction); fails_when=output goes to /dev/null again or a run's file name drifts; why_new=the trial needed an extra run per arm to read the count; seam=none; no_claim=log contents beyond the command's own output.
test('--log keeps each run\'s output per arm and run', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'measure-log-'));
  const dir = join(tmp, 'logs');
  try {
    const r = run('-n', '2', '--log', dir, 'a@x:warm', 'echo Tests: 7 passed', 'b@y:cold', 'echo Tests: 7 passed >&2');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(dir).sort(), ['A-run-1.log', 'A-run-2.log', 'A-warmup-1.log', 'B-run-1.log', 'B-run-2.log']);
    // Value: protects=a log holds the command's stdout and stderr and nothing else; fails_when=stdout goes to /dev/null and only stderr reaches the log; why_new=the match above only read B's stderr; seam=none; no_claim=interleaving order of stdout and stderr.
    for (const f of ['A-run-1.log', 'B-run-1.log']) assert.equal(readFileSync(join(dir, f), 'utf8'), 'Tests: 7 passed\n', f);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// Value: protects=an unusable --log DIR stops before any timed run; fails_when=the mkdir guard is dropped and every run dies on the redirect (exit 3, wrong cause); why_new=the --log test only covers a writable dir; seam=none; no_claim=other mkdir errors.
test('--log under a regular file is a usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-log-'));
  try {
    const f = join(dir, 'f');
    writeFileSync(f, '');
    const r = run('-n', '1', '--log', join(f, 'sub'), 'a@x:cold', 'true');
    assert.equal(r.status, 2, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Value: protects=a --log file that cannot be created invalidates the run even under --allow-fail; fails_when=the redirect failure passes as the command's exit 1 and a never-run command gets a timing; why_new=the folder is new, so the failure is made mid-run by the warmup command; seam=none; no_claim=disk-full mid-run (same path, not simulated).
test('a --log file that cannot be created invalidates the run even with --allow-fail', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'measure-log-'));
  const dir = join(tmp, 'logs');
  try {
    const r = run('-n', '1', '--allow-fail', '--log', dir, 'a@x:warm', `chmod 555 '${dir}'`);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /run 1 exited 126/);
  } finally { chmodSync(dir, 0o755); rmSync(tmp, { recursive: true, force: true }); }
});

// Value: protects=--log never writes into an existing path, so a planted symlink, FIFO or stale log is never written through (round-4 review: rm-then-write failed open in a read-only or shared folder); fails_when=an existing folder or a symlink at the --log path is accepted and runs start; why_new=replaces the round-3 rm test, which a 555 folder defeated; seam=none; no_claim=a link planted inside the new folder between mkdir and the first write.
test('an existing --log folder or symlink is a usage error and runs nothing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'measure-log-'));
  try {
    const target = join(tmp, 'target');
    mkdirSync(target);
    symlinkSync(target, join(tmp, 'link'));
    for (const p of [target, join(tmp, 'link')]) {
      const r = run('-n', '1', '--log', p, 'a@x:cold', `touch '${join(tmp, 'ran')}'`);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /already exists/);
    }
    assert.deepEqual(readdirSync(target), []);
    assert.ok(!existsSync(join(tmp, 'ran')));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('warm arms run the requested warmups, cold arms none', () => {
  const r = run('-n', '1', '--warmup', '2', 'a@x:warm', 'true', 'b@y:cold', 'true');
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stderr.match(/^A warmup/gm) ?? []).length, 2);
  assert.equal((r.stderr.match(/^B warmup/gm) ?? []).length, 0);
});

// Value: protects=measure.sh argument parsing rejects malformed invocations; fails_when=no arms, a bad label, a hot mode, a non-numeric -n, a dangling label or an unknown option (--bogus) no longer exits 2 with a usage line; why_new=covers the parser's error branches incl. the unknown-option case; seam=none; no_claim=-n 0 bounds.
// Value: protects=--log with no DIR or an empty DIR is a usage error (round-5 review: '' skipped the new-folder check and ran without logs); fails_when=the arg-count guard is dropped and set -u aborts on $2 with exit 1 and no usage line; why_new=the --log tests always pass a DIR; seam=none; no_claim=a DIR that looks like a label.
test('usage errors exit 2 with a usage line', () => {
  for (const args of [[], ['badlabel', 'true'], ['a@x:hot', 'true'], ['-n', 'x', 'a@x:cold', 'true'], ['a@x:cold', 'true', 'b@y:cold'], ['--bogus', 'a@x:cold', 'true'], ['--log'], ['--log', '', 'a@x:cold', 'true']]) {
    const r = run(...args);
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}`);
    assert.match(r.stderr, /^usage: measure\.sh/m);
    // Without the -* branch, --bogus falls through to the arg-count check, which also exits 2.
    if (args[0] === '--bogus') assert.match(r.stderr, /unknown option --bogus/);
  }
});

// Value: protects=median of an even run count averages the two middle values; fails_when=median picks one middle value or misindexes under bash 3.2/awk; why_new=existing tests use odd -n or only compare arms; seam=none; no_claim=exact timing precision.
test('even run count reports the mean of the two middle runs', () => {
  // The second run sleeps longer, so picking either middle value alone misses the mean.
  const dir = mkdtempSync(join(tmpdir(), 'measure-'));
  const r = run('-n', '2', 'a@x:cold', `if [ -e ${dir}/ran ]; then sleep 0.5; else touch ${dir}/ran; sleep 0.1; fi`);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const walls = [...r.stderr.matchAll(/^A run \d \(wall cpu load exit\): ([0-9.]+)/gm)].map((m) => Number(m[1]));
  assert.equal(walls.length, 2);
  assert.ok(Math.abs(walls[0] - walls[1]) >= 0.1, `runs too close: ${walls}`);
  assert.ok(Math.abs(field(r.stdout, 'A', 'wall_median_s') - (walls[0] + walls[1]) / 2) <= 0.006);
});

// Value: protects=-n 0 rejected instead of reporting an empty median; fails_when=the >=1 guard is dropped; why_new=usage table covers non-numeric -n only; seam=none; no_claim=other option validation.
test('-n 0 is a usage error', () => {
  const r = run('-n', '0', 'a@x:cold', 'true');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /-n must be at least 1/);
});
