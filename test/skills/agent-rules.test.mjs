// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// agent-rules.mjs contract (TODO-052 D3, D12, D17): one line in the agent files, the section in the testing
// doc, idempotence, replacement in place, --check, exit codes. Fixtures are written to a temp dir per test.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { END, GPU_END, GPU_START, LINE_MARK, START, applyLine, block, gpuBlock, gpuText, line } from '../../plugins/catscan/skills/test-speedup/scripts/agent-rules.mjs';

const script = fileURLToPath(new URL('../../plugins/catscan/skills/test-speedup/scripts/agent-rules.mjs', import.meta.url));
const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const tree = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-rules-'));
  roots.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
};
const run = (root, ...args) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
const read = (root, f) => readFileSync(join(root, f), 'utf8');

test('the always-loaded text is one line; the section holds the rules with the budget and the pgrep rule, no em dash', () => {
  const l = line('docs/testing.md');
  assert.equal(l.split('\n').length, 2, 'one line plus its newline');
  assert.match(l, /docs\/testing\.md.*1000 `expect` calls.*`pgrep`/);
  const text = block();
  assert.ok(text.split('\n').filter((x) => x.startsWith('- ')).length <= 15);
  assert.match(text, /1000 `expect` calls; there is no per-test opt-out/);
  assert.match(text, /select(s)? nothing/);
  assert.ok(!(l + text).includes('—'));
});

test('AGENTS.md gets the line, docs/testing.md is created with the section; a second run changes no byte', () => {
  const root = tree({ 'AGENTS.md': '# Project\n\nRules.\n' });
  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /docs\/testing\.md: testing rules section added/);
  assert.match(first.stdout, /AGENTS\.md: testing rules line added/);
  assert.equal(read(root, 'AGENTS.md'), '# Project\n\nRules.\n\n' + line('docs/testing.md'));
  assert.equal(read(root, 'docs/testing.md'), '# Testing\n\n' + block());
  const second = run(root);
  assert.equal(second.status, 0);
  assert.doesNotMatch(second.stdout, /added|updated/);
  assert.equal(read(root, 'AGENTS.md'), '# Project\n\nRules.\n\n' + line('docs/testing.md'));
});

test('an existing testing doc keeps its text and gets the section appended; --doc names another file', () => {
  const root = tree({ 'AGENTS.md': '# A\n', 'TESTING.md': '# Our tests\n\nkeep\n' });
  assert.equal(run(root, '--doc', 'TESTING.md').status, 0);
  assert.equal(read(root, 'TESTING.md'), '# Our tests\n\nkeep\n\n' + block());
  assert.match(read(root, 'AGENTS.md'), /rules in `TESTING\.md`/);
  assert.ok(!existsSync(join(root, 'docs/testing.md')));
});

test('CLAUDE.md gets its own line unless it imports @AGENTS.md', () => {
  const both = tree({ 'AGENTS.md': '# A\n', 'CLAUDE.md': '# C\n' });
  assert.equal(run(both).status, 0);
  assert.ok(read(both, 'AGENTS.md').includes(LINE_MARK) && read(both, 'CLAUDE.md').includes(LINE_MARK));
  const imports = tree({ 'AGENTS.md': '# A\n', 'CLAUDE.md': '# C\n\n@AGENTS.md\n' });
  const r = run(imports);
  assert.equal(r.status, 0);
  assert.equal(read(imports, 'CLAUDE.md'), '# C\n\n@AGENTS.md\n');
  assert.doesNotMatch(r.stdout, /CLAUDE\.md/);
  const claudeOnly = tree({ 'CLAUDE.md': '# C\n' });
  assert.equal(run(claudeOnly).status, 0);
  assert.ok(read(claudeOnly, 'CLAUDE.md').includes(LINE_MARK));
});

test('with no instructions file it exits 2, writes nothing and says to ask the owner', () => {
  const root = tree({ 'README.md': '# R\n' });
  const r = run(root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no AGENTS\.md or CLAUDE\.md .* Ask the owner/);
  assert.ok(!existsSync(join(root, 'docs/testing.md')));
  const dangling = tree({ 'CLAUDE.md': '@AGENTS.md\n' });
  const d = run(dangling);
  assert.equal(d.status, 2);
  assert.match(d.stderr, /CLAUDE\.md imports @AGENTS\.md, which does not exist/);
  assert.equal(read(dangling, 'CLAUDE.md'), '@AGENTS.md\n');
});

test('a stale line and a stale section are replaced in place and the text around them is kept', () => {
  const root = tree({
    'AGENTS.md': `# A\n- Testing: old wording ${LINE_MARK}\n## Later\nkeep\n`,
    'docs/testing.md': `# T\n\n${START}\n- old rule\n${END}\n\n## Later section\nkeep\n`,
  });
  const r = run(root);
  assert.match(r.stdout, /AGENTS\.md: testing rules line updated/);
  assert.match(r.stdout, /docs\/testing\.md: testing rules section updated/);
  assert.equal(read(root, 'AGENTS.md'), `# A\n${line('docs/testing.md')}## Later\nkeep\n`);
  assert.equal(read(root, 'docs/testing.md'), `# T\n\n${block()}\n## Later section\nkeep\n`);
});

test('a lone section marker or a repeated line fails with the file, the line and the fix, and writes nothing', () => {
  const doc = `# T\n\nx\n${START}\n- half a section\n`;
  const agents = `# A\n- one ${LINE_MARK}\n- two ${LINE_MARK}\n`;
  const root = tree({ 'AGENTS.md': agents, 'docs/testing.md': doc });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/testing\.md: line 4 holds a test-speedup marker without its pair\. Fix: delete that line, then rerun\./);
  assert.match(r.stderr, /AGENTS\.md: line 3 repeats the test-speedup line\. Fix: delete that line, then rerun\./);
  assert.equal(read(root, 'docs/testing.md'), doc);
  assert.equal(read(root, 'AGENTS.md'), agents);
});

test('a repeated section marker fails with its line; a file without a final newline keeps the line separate', () => {
  const doc = `# T\n\n${block()}${END}\n`;
  const root = tree({ 'AGENTS.md': '# A\n', 'docs/testing.md': doc });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/testing\.md: line \d+ repeats a test-speedup marker\. Fix: delete that line, then rerun\./);
  assert.equal(read(root, 'docs/testing.md'), doc);
  const l = line('docs/testing.md');
  assert.equal(applyLine('# A\nRules.', l), '# A\nRules.\n\n' + l);
  assert.equal(applyLine(`# A\n- x ${LINE_MARK}`, l), '# A\n' + l);
});

test('--check writes nothing: exit 1 with the fix when missing or stale, 0 when current', () => {
  const root = tree({ 'AGENTS.md': '# A\n' });
  const missing = run(root, '--check');
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /AGENTS\.md: testing rules line missing\. Fix: node \S*agent-rules\.mjs --root /);
  assert.match(missing.stdout, /docs\/testing\.md: testing rules section missing/);
  assert.equal(read(root, 'AGENTS.md'), '# A\n');
  assert.ok(!existsSync(join(root, 'docs/testing.md')));
  run(root);
  assert.equal(run(root, '--check').status, 0);
  writeFileSync(join(root, 'docs/testing.md'), read(root, 'docs/testing.md').replace('Long specs', 'Short specs'));
  const stale = run(root, '--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /docs\/testing\.md: testing rules section stale/);
});

test('usage errors exit 2 with the usage text; --help exits 0', () => {
  for (const args of [['--bogus'], ['--doc']]) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /Usage: node agent-rules\.mjs/);
  }
  const h = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--check writes nothing/);
});

// TODO-059 D10: the GPU rule as its own marked block, so an upgrade finds and refreshes it.
// Value: protects=an upgrade rewrites the GPU rule in place without duplicating it or clobbering a hand-edited rule;
// fails_when=a second run changes bytes, an unmarked wrapped copy of the published text survives beside the block,
// other wording is overwritten, or --gpu runs without a helper and guard;
// why_new=the GPU block is new; seam=none; no_claim=that agents follow the rule.
const GPU = ['--gpu', '--gpu-helper', 'e2e/launch.ts', '--gpu-guard', 'npm run gpu:guard'];
test('--gpu writes one marked block; a second run changes no byte; --check passes then', () => {
  const root = tree({ 'AGENTS.md': '# Project\n' });
  assert.equal(run(root, ...GPU).status, 0);
  const once = read(root, 'AGENTS.md');
  assert.ok(once.includes(gpuBlock('e2e/launch.ts', 'npm run gpu:guard')));
  assert.equal(once.split(GPU_START).length, 2);
  assert.equal(run(root, ...GPU).status, 0);
  assert.equal(read(root, 'AGENTS.md'), once);
  assert.equal(run(root, ...GPU, '--check').status, 0);
});

test('an unmarked, re-wrapped copy of the published GPU text is replaced by the block', () => {
  const words = gpuText('e2e/launch.ts', 'npm run gpu:guard').split(' ');
  const wrapped = `- ${words.slice(0, 20).join(' ')}\n  ${words.slice(20).join(' ')}\n`;
  const root = tree({ 'AGENTS.md': `# Project\n\n${wrapped}\nTail.\n` });
  const r = run(root, ...GPU);
  assert.equal(r.status, 0, r.stderr);
  const text = read(root, 'AGENTS.md');
  assert.equal(text.match(/GPU in every test/g).length, 1, 'the old copy is gone');
  assert.ok(text.includes(GPU_START) && text.includes(GPU_END) && text.includes('Tail.'));
});

test('a GPU rule in other words stops with its line and the fix, and writes nothing', () => {
  const before = '# Project\n\n- GPU in every test: our own wording.\n';
  const root = tree({ 'AGENTS.md': before });
  const r = run(root, ...GPU);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /line 3 holds a GPU rule in other words.*--print-gpu.*nothing written/s);
  assert.equal(read(root, 'AGENTS.md'), before);
  assert.ok(!existsSync(join(root, 'docs/testing.md')), 'no testing doc either');
});

test('a stale GPU block (another helper) is replaced in place; --gpu without helper and guard is a usage error', () => {
  const root = tree({ 'AGENTS.md': `# Project\n\n${gpuBlock('old.ts', 'old guard')}\nTail.\n` });
  assert.equal(run(root, ...GPU, '--check').status, 1);
  assert.equal(run(root, ...GPU).status, 0);
  const text = read(root, 'AGENTS.md');
  assert.ok(text.includes('`e2e/launch.ts`') && !text.includes('old.ts') && text.includes(`${GPU_END}\n\nTail.\n`));
  // The stale check names the exact fix: rerunning its quoted command makes --check pass.
  const stale = tree({ 'AGENTS.md': `# Project\n\n${gpuBlock('old.ts', 'old guard')}` });
  const check = run(stale, ...GPU, '--check');
  const fix = check.stdout.match(/Fix: (node .*)$/m)[1];
  assert.match(fix, /--gpu --gpu-helper 'e2e\/launch\.ts' --gpu-guard 'npm run gpu:guard'/);
  assert.equal(spawnSync('sh', ['-c', fix.replace(/^node /, `"${process.execPath}" `)], { encoding: 'utf8' }).status, 0, 'the printed fix runs from the cwd it was printed for');
  assert.equal(run(stale, ...GPU, '--check').status, 0);
  // --print-gpu prints the block for a hand merge and writes nothing.
  const printed = run(stale, '--print-gpu', '--gpu-helper', 'h', '--gpu-guard', 'g');
  assert.equal(printed.stdout, gpuBlock('h', 'g'));
  assert.ok(read(stale, 'AGENTS.md').includes('`e2e/launch.ts`'));
  // From a copy under the macOS /var symlink the script still answers (realpath main guard).
  const copy = join(mkdtempSync(join(tmpdir(), 'agent-rules-copy-')), 'agent-rules.mjs');
  roots.push(dirname(copy));
  writeFileSync(copy, readFileSync(script));
  assert.match(spawnSync(process.execPath, [copy, '--help'], { encoding: 'utf8' }).stdout, /^Usage: node agent-rules\.mjs/);
  const bad = run(root, '--gpu');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--gpu needs --gpu-helper NAME and --gpu-guard CMD/);
});
