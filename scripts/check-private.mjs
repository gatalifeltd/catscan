#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Private-data check (spec 25 D3, D17). Prints only the rule ID, file:line and a fixed hint, never the matched
// text, because CI logs of the product repo are public.
// Usage:
//   node scripts/check-private.mjs [--root DIR]             every file under DIR (git ls-files in a repo)
//   node scripts/check-private.mjs --allowlist [--root DIR]  only the lab files public-paths.txt lands
//   node scripts/check-private.mjs --root DIR --list FILE   exactly the paths in FILE (the land plan, spec 25 D17)
//   --names=required (default) | --names=if-available       a missing name list fails, or prints a notice
// The name list (one name per line, "#" comments) is CATSCAN_PRIVATE_NAMES (a CI secret) merged with the file
// named by CATSCAN_PRIVATE_NAMES_FILE (outside any repo on the owner's Mac); it is never in git.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { landPlan, readAllowlist, trackedFiles } from './public-paths.mjs';

export const HINTS = {
  'private-name': 'remove or replace the private name (the list is in CATSCAN_PRIVATE_NAMES_FILE)',
  'private-name-path': 'rename the file or folder: its path holds a private name',
  'home-path': 'use ~ or a relative path, or a placeholder user such as /Users/me',
  'media-outside': 'move the image or video under docs/ or bench/, or delete it',
  'env-file': 'delete the .env file and keep secrets out of the repo',
  'image-metadata': 'strip EXIF and GPS metadata (for example: exiftool -all= <file>)',
  'em-dash': 'replace the em dash with "-"',
  'names-missing': 'set CATSCAN_PRIVATE_NAMES or CATSCAN_PRIVATE_NAMES_FILE; this run requires the name list',
};

// Screenshot and video formats: a file of these types outside bench/ and docs/ never lands (spec 25).
const MEDIA = /\.(png|jpe?g|heic|webp|gif|tiff?|avif|bmp|mp4|m4v|mov|webm|mkv|avi)$/i;
const IMAGE = /\.(png|jpe?g|heic|webp|avif|tiff?|gif)$/i;
const HUMAN_TEXT = /\.(md|mdc|txt|ya?ml|html)$/i;
const MEDIA_HOME = /^(bench|docs)\//;
// Placeholder users that docs and tests use on purpose; a real account name is caught here or by the name list.
const PLACEHOLDER_USERS = new Set(['me', 'you', 'user', 'username', 'runner', 'example', 'name', 'someone', 'shared']);
// Two forms: a user folder followed by more path at any depth (firmlinks, /Volumes, -I/Users/me/, file:///home/me/),
// and a bare user folder that starts a token (`cd /Users/me`, "/home/me"). `screens/home/title` and `de/home.png` are neither.
// Windows separators may be JSON-escaped (`C:\\Users\\me\\`), hence `\\+`.
const HOME_RES = [
  /(?:\/Users|\/home|[A-Za-z]:\\+Users)(?:\\+|\/)([A-Za-z0-9._-]+)(?:\\+|\/)/g,
  /(?:(?<=file:\/\/)|(?<![\w.\\/-]))(?:\/Users|\/home|[A-Za-z]:\\+Users)(?:\\+|\/)([A-Za-z0-9._-]+)(?![A-Za-z0-9._\\/-])/g,
];

// Both sources are read and merged, so a stale or blank secret never hides the maintained file.
export function loadNames(env = process.env) {
  let text = env.CATSCAN_PRIVATE_NAMES ?? '';
  if (env.CATSCAN_PRIVATE_NAMES_FILE && existsSync(env.CATSCAN_PRIVATE_NAMES_FILE)) {
    text += `\n${readFileSync(env.CATSCAN_PRIVATE_NAMES_FILE, 'utf8')}`;
  }
  const names = [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))];
  return names.length ? names : null;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The words of a name may be split by any run of spaces, a line break or a non-breaking space (literal or HTML entity).
// Between a name's words: nothing (CamelCase), whitespace and line breaks, a comment or quote prefix after a wrap,
// slug and path separators, Markdown emphasis and the encoded space forms (spec 25 D22, review pass 2).
const GAP = '(?:[\\s\\p{Pd}_.+*~`/#>;|"\'\\\\\\u00a0]|&nbsp;|&#160;|&#x[aA]0;|%20)*';
// Compatibility forms (fullwidth letters, ligatures) fold to plain letters; soft hyphens and zero-width marks vanish.
// Newlines are kept, so line numbers on the folded text match the file.
// Two folds, both matched: deleting format characters rejoins a split word, turning them into spaces keeps a
// neighbouring letter from gluing onto the name (fix-check, spec 25 D22).
export const fold = (s, mark = '') => s.normalize('NFKC').replace(/[\p{Cf}\u034f\ufe00-\ufe0f]/gu, mark);
const folds = (s) => [fold(s), fold(s, ' ')];
export function nameMatcher(names, flags = 'iu', wholeWord = true) {
  // Whole-word, case-insensitive, Unicode-aware: a name inside a longer word is not a hit. Media bytes drop the
  // word boundary, since container fields sit flush against their tags (`\u00a9nam` then the title).
  // wholeWord 'long': no boundary for names of 6 or more letters (container fields sit flush against their tags), a
  // boundary for shorter ones, which random compressed bytes would otherwise hit.
  const alt = (n) => fold(n).split(/\s+/).map(escape).join(GAP);
  const bounded = (ns) => `(?<![\\p{L}\\p{N}])(?:${ns.map(alt).join('|')})(?![\\p{L}\\p{N}])`;
  if (wholeWord === 'long') {
    const long = names.filter((n) => fold(n).replace(/\s+/g, '').length >= 6);
    const short = names.filter((n) => !long.includes(n));
    return new RegExp([long.length ? `(?:${long.map(alt).join('|')})` : null, short.length ? bounded(short) : null].filter(Boolean).join('|'), flags);
  }
  return new RegExp(wholeWord ? bounded(names) : `(?:${names.map(alt).join('|')})`, flags);
}

function hasImageMetadata(buf, file) {
  const head = buf.subarray(0, Math.min(buf.length, 1 << 20));
  if (/\.jpe?g$/i.test(file)) {
    for (let i = 2; i + 10 < head.length && head[i] === 0xff;) {
      const marker = head[i + 1];
      const len = head.readUInt16BE(i + 2);
      if (marker === 0xe1 && head.subarray(i + 4, i + 10).toString('latin1') === 'Exif\0\0') return true;
      if (marker === 0xda) break;
      i += 2 + len;
    }
  }
  if (/\.png$/i.test(file)) {
    for (let i = 8; i + 8 <= buf.length;) {
      const len = buf.readUInt32BE(i);
      const type = buf.subarray(i + 4, i + 8).toString('latin1');
      if (type === 'eXIf') return true;
      if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
        const data = buf.subarray(i + 8, i + 8 + len);
        const k = data.indexOf(0);
        const keyword = data.subarray(0, k).toString('latin1');
        // ImageMagick and exiftool store EXIF as a "Raw profile type exif" text chunk, often deflated.
        if (/^Raw profile type (exif|app1)/i.test(keyword) || /exif:|GPS/.test(keyword)) return true;
        let text = data.subarray(k + 1);
        try {
          if (type === 'zTXt') text = inflateSync(text.subarray(1), { maxOutputLength: 1 << 24 });
          else if (type === 'iTXt' && text[0] === 1) text = inflateSync(text.subarray(text.indexOf(0, text.indexOf(0, 2) + 1) + 1), { maxOutputLength: 1 << 24 });
        } catch { return true; } // unreadable compressed metadata: flag it rather than pass it
        if (/exif:|GPS/.test(text.toString('latin1'))) return true;
      }
      if (type === 'IEND') break;
      i += 12 + len;
    }
  }
  // Extended WebP keeps EXIF and XMP chunks after the image data: walk every RIFF chunk.
  if (/\.webp$/i.test(file)) {
    for (let i = 12; i + 8 <= buf.length; i += 8 + buf.readUInt32LE(i + 4) + (buf.readUInt32LE(i + 4) & 1)) {
      if (/^(EXIF|XMP )$/.test(buf.subarray(i, i + 4).toString('latin1'))) return true;
    }
  }
  if (/\.tiff?$/i.test(file) && tiffHasExif(buf)) return true;
  const latin = buf.toString('latin1');
  if (/\.(heic|avif)$/i.test(file) && latin.includes('Exif\0\0')) return true;
  return /<x:xmpmeta[\s\S]*?(exif:GPS|GPSLatitude)/.test(latin);
}

// Every text chunk of a PNG, inflated when compressed: the name rule reads them like any other text.
function pngTexts(buf) {
  const out = [];
  for (let i = 8; i + 8 <= buf.length;) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      const data = buf.subarray(i + 8, i + 8 + len);
      const k = data.indexOf(0);
      let text = data.subarray(k + 1);
      try {
        if (type === 'zTXt') text = inflateSync(text.subarray(1), { maxOutputLength: 1 << 24 });
        else if (type === 'iTXt' && text[0] === 1) text = inflateSync(text.subarray(text.indexOf(0, text.indexOf(0, 2) + 1) + 1), { maxOutputLength: 1 << 24 });
      } catch { /* hasImageMetadata already flags unreadable compressed text */ }
      out.push(data.subarray(0, k).toString('utf8'), text.toString('utf8'));
    }
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return out.join('\n');
}

// A TIFF is itself an EXIF container; IFD0 pointing at an Exif (0x8769) or GPS (0x8825) IFD is metadata.
function tiffHasExif(buf) {
  if (buf.length < 8) return false;
  const le = buf.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const ifd = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  if (ifd + 2 > buf.length) return false;
  for (let n = u16(ifd), e = ifd + 2; n > 0 && e + 2 <= buf.length; n--, e += 12) {
    if (u16(e) === 0x8769 || u16(e) === 0x8825) return true;
  }
  return false;
}

// UTF-16 text (BOM, or every other byte NUL) is decoded; any other binary is scanned as latin1 for names and home paths,
// so no file type passes the text rules unread (the land ships UTF-16 .strings fixtures).
function textOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), binary: false };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), binary: false };
  const head = buf.subarray(0, 8000);
  if (!head.includes(0)) return { text: buf.toString('utf8'), binary: false };
  let odd = 0, even = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) (i % 2 ? odd++ : even++);
  // A guessed byte order can be wrong (text starting at an odd offset): `guess` also sends the file through every view.
  if (odd > head.length / 4 && even * 8 < odd) return { text: new TextDecoder('utf-16le').decode(buf), binary: false, guess: true };
  if (even > head.length / 4 && odd * 8 < even) return { text: new TextDecoder('utf-16be').decode(buf), binary: false, guess: true };
  return { text: buf.toString('latin1'), binary: true };
}

// Every text decoding of a binary, read in overlapping windows so a large video never builds one giant string.
const WINDOW = 1 << 22;
const OVERLAP = 4096;
function scanViews(buf, test) {
  for (let off = 0; off < buf.length || off === 0; off += WINDOW) {
    const part = buf.subarray(off, Math.min(buf.length, off + WINDOW + OVERLAP));
    const odd = part.subarray(1); // UTF-16 text can start at an odd byte offset inside a container
    const views = [part.toString('latin1'), part.toString('utf8'), ...[part, odd].flatMap((b) => [new TextDecoder('utf-16le').decode(b), new TextDecoder('utf-16be').decode(b)])];
    if (folds(views.join('\n')).some(test)) return true;
    if (off + WINDOW >= buf.length) break;
  }
  return false;
}
const homeHit = (text) => HOME_RES.some((re) => [...text.matchAll(re)].some((m) => !PLACEHOLDER_USERS.has(m[1].toLowerCase())));

// files: [{ path: shown in findings, abs: file to read }]
export function checkFiles(files, names) {
  const findings = [];
  const add = (rule, path, line = 1) => findings.push({ rule, path, line });
  const nameRe = names ? nameMatcher(names) : null;
  for (const { path, abs } of files) {
    const base = path.split('/').pop();
    if (nameRe && folds(path).some((f) => nameRe.test(f))) add('private-name-path', path);
    if (/^\.env/.test(base) && base !== '.env.example') add('env-file', path);
    if (MEDIA.test(path) && !MEDIA_HOME.test(path)) add('media-outside', path);
    // A symlink lands as its link text, so that text is what gets checked.
    const link = lstatSync(abs).isSymbolicLink();
    const buf = link ? Buffer.from(readlinkSync(abs)) : readFileSync(abs);
    if (!link && MEDIA.test(path)) {
      if (IMAGE.test(path) && MEDIA_HOME.test(path) && hasImageMetadata(buf, path)) add('image-metadata', path);
      // Titles, comments and XMP inside an image or video land with it: read its bytes in every text encoding.
      const pngText = /\.png$/i.test(path) ? folds(pngTexts(buf)).join('\n') : '';
      if (names && (nameMatcher(names, 'iu', false).test(pngText) || scanViews(buf, (s) => nameMatcher(names, 'iu', 'long').test(s)))) add('private-name', path);
      if (homeHit(pngText) || scanViews(buf, homeHit)) add('home-path', path);
      continue;
    }
    const { text: raw, binary, guess } = textOf(buf);
    if (guess && names && scanViews(buf, (s) => nameMatcher(names, 'iu', 'long').test(s))) add('private-name', path);
    // A binary with no BOM may still hold UTF-16 or UTF-8 text: every decoding is read, as for media.
    if (binary) {
      if (names && scanViews(buf, (s) => nameMatcher(names, 'iu', 'long').test(s))) add('private-name', path);
      if (scanViews(buf, homeHit)) add('home-path', path);
      continue;
    }
    const body = fold(raw);
    const human = HUMAN_TEXT.test(path);
    // Names are matched over the whole text, since a name's words may wrap onto the next line. Both folds keep every
    // newline, so a match offset maps to the file's own line number.
    if (names) {
      const lines = new Set();
      for (const text of folds(raw)) {
        const starts = [0];
        for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
        const lineOf = (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
        for (const m of text.matchAll(nameMatcher(names, 'giu'))) lines.add(lineOf(m.index));
      }
      for (const line of [...lines].sort((a, b) => a - b)) add('private-name', path, line);
    }
    body.split('\n').forEach((text, i) => {
      if (HOME_RES.some((re) => [...text.matchAll(re)].some((m) => !PLACEHOLDER_USERS.has(m[1].toLowerCase())))) add('home-path', path, i + 1);
      if (human && text.includes('\u2014')) add('em-dash', path, i + 1);
    });
  }
  return findings;
}

function walk(dir, root = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // Only .git is skipped: a land export is checked whole, node_modules included if it is part of the export.
    if (e.name === '.git') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, root, out);
    else if (e.isFile() || e.isSymbolicLink()) out.push(relative(root, abs).split('\\').join('/'));
  }
  return out;
}

export function listFiles(root, useAllowlist, listFile) {
  if (listFile) return readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
  if (useAllowlist) return landPlan(readAllowlist(root), trackedFiles(root)).map((p) => p.src);
  if (existsSync(join(root, '.git'))) return trackedFiles(root);
  return walk(root);
}

export function main(argv, env = process.env, log = console) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const root = arg('--root') ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const namesMode = (argv.find((a) => a.startsWith('--names=')) ?? '--names=required').slice(8);
  if (!['required', 'if-available'].includes(namesMode)) throw new Error(`unknown --names=${namesMode}`);
  const names = loadNames(env);
  const findings = [];
  if (!names) {
    if (namesMode === 'required') findings.push({ rule: 'names-missing', path: '-', line: 0 });
    else log.log('check-private: notice: no private name list on this machine; the name rule did not run');
  }
  // A path can itself hold a private name, so every printed path and error is redacted with the same matcher.
  // A path that matches only in a folded form is printed whole as <private>.
  const redact = names ? (p) => {
    const plain = p.replace(new RegExp(nameMatcher(names).source, 'giu'), '<private>');
    return plain === p && folds(p).some((f) => nameMatcher(names).test(f)) ? '<private>' : plain;
  } : (p) => p;
  let listed;
  try {
    listed = listFiles(root, argv.includes('--allowlist'), arg('--list'));
  } catch (e) {
    log.error(`check-private: ${redact(e.message)}`);
    return 2;
  }
  const kind = (p) => { try { const st = lstatSync(join(root, p)); return st.isFile() || st.isSymbolicLink(); } catch { return false; } };
  // --list is the land plan: every listed path must be checked, so a missing one or an empty list is an error.
  if (arg('--list') && (!listed.length || !listed.every(kind))) {
    log.error(`check-private: --list ${listed.length ? `names ${listed.filter((p) => !kind(p)).length} path(s) that are not files under the root` : 'is empty'}`);
    return 2;
  }
  const files = listed.filter(kind).map((p) => ({ path: p, abs: join(root, p) }));
  try {
    findings.push(...checkFiles(files, names));
  } catch (e) {
    log.error(`check-private: ${redact(e.message)}`);
    return 2;
  }
  for (const f of findings) log.error(`${f.rule} ${redact(f.path)}:${f.line} - ${HINTS[f.rule]}`);
  if (findings.length) {
    log.error(`check-private: ${findings.length} finding(s) in ${files.length} files`);
    return 1;
  }
  log.log(`check-private: ok (${files.length} files${names ? `, ${names.length} private names` : ''})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`check-private: ${e.message}`);
    process.exitCode = 2;
  }
}
