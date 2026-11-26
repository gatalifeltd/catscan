// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// skills-lint catches each rule it enforces (TODO-006 D6).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lint = fileURLToPath(new URL('../../scripts/skills-lint.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../..', import.meta.url));
const check = (root) => spawnSync(process.execPath, [lint, root], { encoding: 'utf8' });

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function fixture({ name = 'demo', desc = 'Short description.', body = 'See references/a.md.\n', refs = { 'a.md': 'ok\n' }, execBit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skills-lint-'));
  roots.push(root);
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins: [{ name: 'p', source: './plugins/p' }] }));
  const skill = join(root, 'plugins/p/skills/demo');
  mkdirSync(join(root, 'plugins/p/.claude-plugin'), { recursive: true });
  writeFileSync(join(root, 'plugins/p/.claude-plugin/plugin.json'), JSON.stringify({ name: 'p' }));
  mkdirSync(join(skill, 'references'), { recursive: true });
  mkdirSync(join(skill, 'scripts'));
  writeFileSync(join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`);
  for (const [f, s] of Object.entries(refs)) writeFileSync(join(skill, 'references', f), s);
  writeFileSync(join(skill, 'scripts/run.sh'), '#!/bin/sh\n');
  chmodSync(join(skill, 'scripts/run.sh'), execBit ? 0o755 : 0o644);
  return root;
}

test('the repo plugin passes', () => {
  const r = check(repo);
  assert.equal(r.status, 0, r.stderr);
});

test('a valid fixture passes', () => {
  assert.equal(check(fixture()).status, 0);
});

const cases = [
  ['name differs from directory', { name: 'other' }, /name other differs from directory demo/],
  ['description over 250 bytes', { desc: 'x'.repeat(251) }, /description is 251 bytes/],
  ['folded description', { desc: '>\n  ' + 'x'.repeat(300) }, /description must be one line/],
  ['SKILL.md over 120 lines', { body: 'See references/a.md.\n' + 'l\n'.repeat(120) }, /lines, cap 120/],
  ['named reference missing', { body: 'See references/a.md and references/b.md.\n' }, /names references\/b\.md, which does not exist/],
  ['reference not named', { refs: { 'a.md': 'ok\n', 'c.md': 'x\n' } }, /references\/c\.md: not named in SKILL\.md/],
  ['reference over 150 lines', { refs: { 'a.md': 'l\n'.repeat(151) } }, /lines, cap 150/],
  ['em dash', { body: 'See references/a.md — now.\n' }, /em dash/],
  ['script not executable', { execBit: false }, /run\.sh: not executable/],
  ['agent-specific variable', { body: 'See references/a.md. Run ${CLAUDE_SKILL_DIR}/scripts/run.sh.\n' }, /agent-specific variable CLAUDE_SKILL_DIR/],
];
for (const [label, opts, re] of cases) {
  test(`fails on ${label}`, () => {
    const r = check(fixture(opts));
    assert.equal(r.status, 1);
    assert.match(r.stderr, re);
  });
}

// Value: protects=marketplace/manifest/frontmatter checks that gate every skill; fails_when=lint passes a missing, unparsable or shapeless marketplace.json, an unparsable plugin.json, a skill dir without SKILL.md, a plugin.json name mismatch, or a SKILL.md with no frontmatter; why_new=the table above only mutates SKILL.md body/refs, never the manifests; seam=none; no_claim=plugin source path shape or a missing description field.
const broken = [
  ['marketplace.json invalid JSON', (root) => writeFileSync(join(root, '.claude-plugin/marketplace.json'), '{'), /marketplace\.json: invalid JSON/],
  ['plugin.json name differs', (root) => writeFileSync(join(root, 'plugins/p/.claude-plugin/plugin.json'), JSON.stringify({ name: 'q' })), /name q differs from marketplace entry p/],
  ['marketplace.json missing', (root) => rmSync(join(root, '.claude-plugin/marketplace.json')), /marketplace\.json: missing/],
  ['marketplace.json without owner.name', (root) => writeFileSync(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'm', plugins: [] })), /needs name, owner\.name and plugins\[\]/],
  ['plugin.json invalid JSON', (root) => writeFileSync(join(root, 'plugins/p/.claude-plugin/plugin.json'), '{'), /plugin\.json: invalid JSON/],
  ['skill dir without SKILL.md', (root) => rmSync(join(root, 'plugins/p/skills/demo/SKILL.md')), /missing SKILL\.md/],
  ['SKILL.md without frontmatter', (root) => writeFileSync(join(root, 'plugins/p/skills/demo/SKILL.md'), 'See references/a.md.\n'), /SKILL\.md: missing frontmatter/],
  ['plugin source as an object', (root) => writeFileSync(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins: [{ name: 'p', source: { source: 'github', repo: 'o/r' } }] })), /must be a \.\/ path inside the repo/],
  ['plugin source is a symlink out of the repo', (root) => { const out = mkdtempSync(join(tmpdir(), 'lint-out-')); cpSync(join(root, 'plugins/p'), out, { recursive: true }); symlinkSync(out, join(root, 'plugins/link')); writeFileSync(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins: [{ name: 'p', source: './plugins/link' }] })); }, /must be a \.\/ path inside the repo/],
  ['plugin source outside the repo', (root) => writeFileSync(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins: [{ name: 'p', source: './../elsewhere' }] })), /must be a \.\/ path inside the repo/],
];

// Value: protects=Finder/editor dotfiles never fail the lint; fails_when=a .DS_Store in skills/ or references/ is linted as a skill or an unnamed reference; why_new=no fixture had dotfiles; seam=none; no_claim=non-dot stray files.
test('dotfiles in skills/ and references/ are ignored', () => {
  const root = fixture();
  writeFileSync(join(root, 'plugins/p/skills/.DS_Store'), 'x');
  writeFileSync(join(root, 'plugins/p/skills/demo/references/.DS_Store'), 'x');
  writeFileSync(join(root, 'plugins/p/skills/demo/.scratch.sh'), 'x \u2014', { mode: 0o644 });
  const r = check(root);
  assert.equal(r.status, 0, r.stderr);
});
for (const [label, mutate, re] of broken) {
  test(`fails on ${label}`, () => {
    const root = fixture();
    mutate(root);
    const r = check(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, re);
  });
}

// Spec 10 agent files: a repo-shaped fixture with the three files copied from this repo, then one mutation each.
// Value: protects=spec 10 D6/D7 (one core text, short files, Cursor frontmatter); fails_when=the lint passes a long
// file, a bad .mdc frontmatter, a missing or edited core block, or an em dash/agent variable in examples/agents;
// why_new=new rules; seam=none; no_claim=tool names (packages/mcp/test/agent-files.test.js).
const AGENT_FILES = ['plugins/catscan/skills/screen-check/SKILL.md', 'examples/agents/cursor/catscan.mdc', 'examples/agents/AGENTS.md.snippet'];
function agentsFixture() {
  const root = mkdtempSync(join(tmpdir(), 'skills-lint-agents-'));
  roots.push(root);
  cpSync(join(repo, '.claude-plugin'), join(root, '.claude-plugin'), { recursive: true });
  cpSync(join(repo, 'plugins'), join(root, 'plugins'), { recursive: true });
  cpSync(join(repo, 'examples/agents'), join(root, 'examples/agents'), { recursive: true });
  return root;
}
const edit = (root, f, fn) => writeFileSync(join(root, f), fn(readFileSync(join(root, f), 'utf8')));

test('the agent files fixture passes', () => {
  const r = check(agentsFixture());
  assert.equal(r.status, 0, r.stderr);
});

const agentCases = [
  ['an agent file at 60 lines', (s) => s + 'l\n'.repeat(60), AGENT_FILES[2], /AGENTS\.md\.snippet: \d+ lines, cap 59/],
  ['a .mdc without description', (s) => s.replace(/^description: .*\n/m, ''), AGENT_FILES[1], /needs a description/],
  ['a .mdc with alwaysApply: true', (s) => s.replace('alwaysApply: false', 'alwaysApply: true'), AGENT_FILES[1], /needs alwaysApply: false/],
  ['a missing core marker', (s) => s.replace('<!-- catscan-core:end -->', ''), AGENT_FILES[0], /SKILL\.md: needs one catscan-core start and end marker/],
  ['a core block one byte off', (s) => s.replace('catscan first.', 'catscan first!'), AGENT_FILES[1], /catscan\.mdc: catscan-core block differs/],
  ['an em dash in examples/agents', (s) => s + 'x — y\n', AGENT_FILES[2], /em dash/],
  ['an agent variable in examples/agents', (s) => s + 'Run $CURSOR_DIR/x.\n', AGENT_FILES[1], /agent-specific variable CURSOR_DIR/],
];
for (const [label, fn, f, re] of agentCases) {
  test(`fails on ${label}`, () => {
    const root = agentsFixture();
    edit(root, f, fn);
    const r = check(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, re);
  });
}

test('fails on a missing agent file', () => {
  const root = agentsFixture();
  rmSync(join(root, AGENT_FILES[2]));
  const r = check(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AGENTS\.md\.snippet: missing/);
});

test('fails on examples/agents removed while the skill stays', () => {
  // Value: protects=a deleted examples/agents is a lint error, not a crash; fails_when=walk() throws ENOENT;
  // why_new=pass 2 review finding; seam=none; no_claim=none.
  const root = agentsFixture();
  rmSync(join(root, 'examples/agents'), { recursive: true });
  const r = check(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /catscan\.mdc: missing/);
});

test('the agent files send the user to the Tesseract recipe on needs-reader (TODO-034 D1, TODO-065)', () => {
  for (const f of ['plugins/catscan/skills/screen-check/SKILL.md', 'examples/agents/cursor/catscan.mdc', 'examples/agents/AGENTS.md.snippet']) {
    const s = readFileSync(join(repo, f), 'utf8');
    const core = s.match(/<!-- catscan-core:start -->\n([\s\S]*?)<!-- catscan-core:end -->/)[1];
    // TODO-065: a Tesseract locale without Tesseract is needs-reader, never "unsupported".
    assert.match(core, /When a reply's verdict is `needs-reader`, catscan reads that language once the reader in its hint is installed: first tell the user that command once \(https:\/\/github\.com\/gatalifeltd\/catscan\/blob\/main\/docs\/recipes\/tesseract\.md\), then open the image\./, f);
    assert.match(s, /^- 3 `needs-reader` \(tell the user its install hint once\) or `unsupported` \(no reader for the language\), open the image;$/m, f);
  }
  assert.ok(readFileSync(join(repo, 'docs/recipes/tesseract.md'), 'utf8').startsWith('# Recipe: Tesseract'), 'the linked recipe exists');
});

// TODO-061 D7, D11: catscan-adopt's measure.sh copy and its feedback line, on a copy of this repo's plugins.
// Value: protects=a copied catscan-adopt folder times batches with the same measure.sh, and every report ends with one real form link;
// fails_when=the lint passes a drifted measure.sh copy, a SKILL.md without the feedback line, with two, or with a non-Google-Forms URL;
// why_new=new rules; seam=none; no_claim=the form's questions or that the agent prints the line.
const ADOPT = 'plugins/catscan/skills/catscan-adopt';
const adoptCases = [
  ['measure.sh copies differ', (root) => edit(root, `${ADOPT}/scripts/measure.sh`, (s) => s + '# drift\n'), /test-speedup\/scripts\/measure\.sh: differs from plugins\/catscan\/skills\/catscan-adopt\/scripts\/measure\.sh/],
  ['find-catscan.mjs copies differ', (root) => edit(root, 'plugins/catscan/skills/catscan-upgrade/scripts/find-catscan.mjs', (s) => s + '// drift\n'), /catscan-upgrade\/scripts\/find-catscan\.mjs: differs from plugins\/catscan\/skills\/catscan-adopt\/scripts\/find-catscan\.mjs/],
  ['no feedback line', (root) => edit(root, `${ADOPT}/SKILL.md`, (s) => s.replace(/^.*Feedback \(optional.*\n/m, '')), /needs exactly one "Feedback \(optional, anonymous, no sign-in\):" line, found 0/],
  ['two feedback lines', (root) => edit(root, `${ADOPT}/SKILL.md`, (s) => s + s.match(/^.*Feedback \(optional.*\n/m)[0]), /found 2/],
  ['a feedback URL that is not Google Forms', (root) => edit(root, `${ADOPT}/SKILL.md`, (s) => s.replace(/https:\/\/docs\.google\.com\/forms\/\S+/, 'https://example.com/form')), /needs one Google Forms URL .* found https:\/\/example\.com\/form/],
];
for (const [label, mutate, re] of adoptCases) {
  test(`catscan-adopt: fails on ${label}`, () => {
    const root = agentsFixture();
    mutate(root);
    const r = check(root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, re);
  });
}
