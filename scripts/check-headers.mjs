#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// SPDX and copyright headers on every tracked source file (spec 25 Licensing, D8).
// Usage: node scripts/check-headers.mjs [--fix]   (--fix adds the two lines where they are missing)
// Every tracked extension is either a source type with a comment syntax (HEADER) or explicitly skipped (SKIP),
// so a new language fails here instead of being skipped silently.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOLDER = 'GATALIFE LTD';
export const HEADER = { js: '//', mjs: '//', cjs: '//', ts: '//', swift: '//', sh: '#', py: '#',
  kt: '//', kts: '//', java: '//', properties: '#' };
export const SKIP = new Set(['json', 'jsonl', 'md', 'mdc', 'csv', 'tsv', 'txt', 'log', 'yml', 'yaml', 'xml', 'xsd', 'strings',
  'xcstrings', 'snippet', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'html', 'css', 'gitkeep', 'gitignore',
  // Spec 14 sample apps: Xcode project files, and the Gradle wrapper as Gradle generates it.
  'pbxproj', 'xcscheme', 'plist', 'jar', 'bat']);
const SKIP_NAMES = new Set(['LICENSE', 'NOTICE', 'VERSION', 'CODEOWNERS', 'gradlew']);
// A first line that must stay first: a shebang, or Package.swift's tools version (SwiftPM reads only line 1).
const PRAGMA = /^(#!|\/\/ swift-tools-version)/;

export const extOf = (file) => {
  const b = basename(file);
  const i = b.lastIndexOf('.');
  return i < 0 ? null : b.slice(i + 1).toLowerCase();
};

export function headerLines(comment, year) {
  return [`${comment} SPDX-License-Identifier: Apache-2.0`, `${comment} Copyright ${year} ${HOLDER}`];
}

// Returns null when the file is fine or skipped, else a reason.
export function checkText(file, text) {
  const ext = extOf(file);
  if (SKIP_NAMES.has(basename(file)) || (ext && SKIP.has(ext))) return null;
  const c = ext && HEADER[ext];
  if (!c) return `unclassified extension; add it to HEADER or SKIP in scripts/check-headers.mjs`;
  const lines = text.split('\n');
  const start = PRAGMA.test(lines[0]) ? 1 : 0;
  if (lines.slice(1, 4).some((l) => PRAGMA.test(l))) return 'shebang or swift-tools-version must be the first line, before the header';
  if (lines[start] !== `${c} SPDX-License-Identifier: Apache-2.0`) return `line ${start + 1} must be "${c} SPDX-License-Identifier: Apache-2.0"`;
  const re = new RegExp(`^${c === '#' ? '#' : '//'} Copyright \\d{4}(-\\d{4})? ${HOLDER}$`);
  if (!re.test(lines[start + 1] ?? '')) return `line ${start + 2} must be "${c} Copyright <year> ${HOLDER}"`;
  return null;
}

export function addHeader(file, text, year) {
  const lines = text.split('\n');
  const at = PRAGMA.test(lines[0]) ? 1 : 0;
  lines.splice(at, 0, ...headerLines(HEADER[extOf(file)], year));
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const fix = process.argv.includes('--fix');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const errors = [];
  for (const f of files) {
    let text = readFileSync(join(root, f), 'utf8');
    let reason = checkText(f, text);
    if (reason && fix && HEADER[extOf(f)] && !/SPDX-License-Identifier/.test(text)) {
      text = addHeader(f, text, new Date().getFullYear());
      writeFileSync(join(root, f), text);
      reason = checkText(f, text);
    }
    if (reason) errors.push(`${f}: ${reason}`);
  }
  for (const e of errors) console.error(e);
  if (errors.length) {
    console.error(`check-headers: ${errors.length} file(s) fail${fix ? '' : '; run node scripts/check-headers.mjs --fix'}`);
    process.exit(1);
  }
  console.log(`check-headers: ok (${files.length} tracked files)`);
}
