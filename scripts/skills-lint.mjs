// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Skill package lint (TODO-006 D6). No dependencies; runs on any OS with Node.
// Usage: node scripts/skills-lint.mjs [repo-root]
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const root = process.argv[2] ?? process.cwd();
// TODO-061 D11: the one feedback line catscan-adopt ends every report with.
const FORM_LINE = 'Feedback (optional, anonymous, no sign-in):';
const FORM_URL = /^https:\/\/(docs\.google\.com\/forms\/d\/e\/[\w-]+\/viewform|forms\.gle\/\w+)$/;
const errors = [];
const read = (p) => readFileSync(p, 'utf8');
const lines = (s) => s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
const rel = (p) => relative(root, p);
// Finder and editors drop dotfiles (.DS_Store); they are not skills or references.
const visible = (dir) => readdirSync(dir).filter((f) => !f.startsWith('.'));
const walk = (dir) => visible(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
// Resolves symlinks, so a link that points out of the repo is outside too.
const inside = (p) => {
  const r = existsSync(p) ? relative(realpathSync(root), realpathSync(p)) : relative(root, p);
  return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r);
};

const marketPath = join(root, '.claude-plugin/marketplace.json');
if (!existsSync(marketPath)) errors.push('.claude-plugin/marketplace.json: missing');
else {
  let market;
  try { market = JSON.parse(read(marketPath)); } catch (e) { errors.push(`.claude-plugin/marketplace.json: invalid JSON (${e.message})`); }
  if (market) {
    if (!market.name || !market.owner?.name || !Array.isArray(market.plugins)) errors.push('.claude-plugin/marketplace.json: needs name, owner.name and plugins[]');
    for (const p of market.plugins ?? []) {
      // Only a relative path inside this repo can be linted; the github/url source forms point elsewhere.
      if (typeof p.source !== 'string' || !p.source.startsWith('./') || !inside(join(root, p.source))) { errors.push(`marketplace plugin ${p.name}: source ${JSON.stringify(p.source)} must be a ./ path inside the repo`); continue; }
      const dir = join(root, p.source);
      const manifest = join(dir, '.claude-plugin/plugin.json');
      if (!existsSync(manifest)) { errors.push(`marketplace plugin ${p.name}: source ${p.source} has no .claude-plugin/plugin.json`); continue; }
      let m;
      try { m = JSON.parse(read(manifest)); } catch (e) { errors.push(`${rel(manifest)}: invalid JSON (${e.message})`); continue; }
      if (m.name !== p.name) errors.push(`${rel(manifest)}: name ${m.name} differs from marketplace entry ${p.name}`);
      const skillsDir = join(dir, 'skills');
      if (existsSync(skillsDir)) { for (const name of visible(skillsDir)) checkSkill(join(skillsDir, name), name); checkSharedScripts(skillsDir); }
    }
  }
}

// TODO-061 D7: a skill that copies a shared script carries it byte-identical, so a copied skill folder works alone.
// find-catscan.mjs is shared by catscan-adopt and catscan-upgrade (TODO-059 T3).
function checkSharedScripts(skillsDir) {
  for (const shared of ['scripts/measure.sh', 'scripts/find-catscan.mjs']) {
    const copies = visible(skillsDir).map((n) => join(skillsDir, n, shared)).filter((p) => existsSync(p));
    for (const p of copies.slice(1)) if (read(p) !== read(copies[0])) errors.push(`${rel(p)}: differs from ${rel(copies[0])}; copy it again byte for byte`);
  }
}

// TODO-061 D11: catscan-adopt ends every report with exactly one feedback line holding one Google Forms URL.
function checkFormLine(skillPath, skill) {
  const found = skill.split('\n').filter((l) => l.includes(FORM_LINE));
  if (found.length !== 1) { errors.push(`${rel(skillPath)}: needs exactly one "${FORM_LINE}" line, found ${found.length}`); return; }
  const urls = found[0].match(/https?:\/\/\S+/g) ?? [];
  if (urls.length !== 1 || !FORM_URL.test(urls[0])) errors.push(`${rel(skillPath)}: the feedback line needs one Google Forms URL (docs.google.com/forms/d/e/.../viewform or forms.gle/...), found ${urls.join(' ') || 'none'}`);
}

function checkSkill(dir, name) {
  const skillPath = join(dir, 'SKILL.md');
  if (!existsSync(skillPath)) { errors.push(`${rel(dir)}: missing SKILL.md`); return; }
  const skill = read(skillPath);
  const fm = skill.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) errors.push(`${rel(skillPath)}: missing frontmatter`);
  else {
    const field = (k) => fm[1].match(new RegExp(`^${k}: (.+)$`, 'm'))?.[1];
    if (field('name') !== name) errors.push(`${rel(skillPath)}: name ${field('name')} differs from directory ${name}`);
    const desc = field('description');
    if (!desc) errors.push(`${rel(skillPath)}: missing description`);
    // A YAML block scalar (`>` or `|`) would hide the real text from the byte cap below.
    else if (/^[|>]/.test(desc)) errors.push(`${rel(skillPath)}: description must be one line, not a YAML block scalar`);
    else if (Buffer.byteLength(desc) > 250) errors.push(`${rel(skillPath)}: description is ${Buffer.byteLength(desc)} bytes, cap 250`);
  }
  if (name === 'catscan-adopt') checkFormLine(skillPath, skill);
  if (lines(skill) > 120) errors.push(`${rel(skillPath)}: ${lines(skill)} lines, cap 120`);
  const named = new Set([...skill.matchAll(/references\/([\w.-]+\.md)/g)].map((m) => m[1]));
  const refDir = join(dir, 'references');
  const present = existsSync(refDir) ? visible(refDir) : [];
  for (const f of named) if (!present.includes(f)) errors.push(`${rel(skillPath)}: names references/${f}, which does not exist`);
  for (const f of present) {
    if (!named.has(f)) errors.push(`${rel(join(refDir, f))}: not named in SKILL.md, so the agent never reads it`);
    const n = lines(read(join(refDir, f)));
    if (n > 150) errors.push(`${rel(join(refDir, f))}: ${n} lines, cap 150`);
  }
  for (const f of walk(dir)) {
    lintText(f);
    if (f.endsWith('.sh') && !(statSync(f).mode & 0o111)) errors.push(`${rel(f)}: not executable (chmod +x)`);
  }
}

function lintText(f) {
  read(f).split('\n').forEach((line, i) => {
    if (line.includes('\u2014')) errors.push(`${rel(f)}:${i + 1}: em dash; use "-"`);
    // Skills must run on every major agent (owner rule, TODO-006 D18): no agent-specific variables.
    const v = line.match(/\b(CLAUDE|CODEX|CURSOR|GEMINI)_[A-Z_]+/);
    if (v) errors.push(`${rel(f)}:${i + 1}: agent-specific variable ${v[0]}; use a neutral placeholder such as <skill-dir>`);
  });
}

// Spec 10: the agent instruction files share one core text byte for byte (D6) and stay short, since an agent
// pays for them as context. Checked when the root has examples/agents/ or any of the three files (the repo; lint
// fixtures without them opt out), so deleting some of them fails here and deleting all fails the tool-name test.
const AGENT_FILES = ['plugins/catscan/skills/screen-check/SKILL.md', 'examples/agents/cursor/catscan.mdc', 'examples/agents/AGENTS.md.snippet'];
if (existsSync(join(root, 'examples/agents')) || AGENT_FILES.some((f) => existsSync(join(root, f)))) {
  const cores = [];
  for (const f of AGENT_FILES) {
    const p = join(root, f);
    if (!existsSync(p)) { errors.push(`${f}: missing`); continue; }
    const s = read(p);
    if (lines(s) >= 60) errors.push(`${f}: ${lines(s)} lines, cap 59 (under 60)`);
    if (f.endsWith('.mdc')) {
      const fm = s.match(/^---\n([\s\S]*?)\n---\n/);
      if (!fm || !/^description: \S/m.test(fm[1])) errors.push(`${f}: frontmatter needs a description`);
      if (!fm || !/^alwaysApply: false$/m.test(fm[1])) errors.push(`${f}: frontmatter needs alwaysApply: false`);
    }
    const starts = s.split('<!-- catscan-core:start -->').length - 1;
    const ends = s.split('<!-- catscan-core:end -->').length - 1;
    const core = s.match(/<!-- catscan-core:start -->\n([\s\S]*?)<!-- catscan-core:end -->/);
    if (starts !== 1 || ends !== 1 || !core) errors.push(`${f}: needs one catscan-core start and end marker`);
    else cores.push([f, core[1]]);
  }
  for (const [f, c] of cores.slice(1)) if (c !== cores[0][1]) errors.push(`${f}: catscan-core block differs from ${cores[0][0]}`);
  if (existsSync(join(root, 'examples/agents'))) for (const f of walk(join(root, 'examples/agents'))) lintText(f);
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`skills:check failed (${errors.length} problems)`);
  process.exit(1);
}
console.log('skills:check ok');
