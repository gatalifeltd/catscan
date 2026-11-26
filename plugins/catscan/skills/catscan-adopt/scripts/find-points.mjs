#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// find-points v1 (catscan-adopt skill). Lists adoption-point candidates: lines that take
// screenshots, write video, write store art or a per-locale image path, compare pixels or image hashes, draw text
// into a canvas or tell an agent to open an image, plus
// tracked per-locale screenshot folders (a locale folder at any depth, or a locale suffix in the file name). Reads only the committed tree at --rev through git, so a dirty working
// tree changes nothing and the plan's diffs are made against the same tree. Writes nothing in the repo; with
// --catscan it runs `catscan languages` and `catscan doctor --expect-locales`, which read temp files only.
// Usage: node find-points.mjs <repo> [--rev REV] [--path DIR] [--all] [--catscan '<find-catscan command as JSON>']
// --path DIR keeps only files under DIR (one app of a monorepo); locales, catalogs and candidates all come from it.
// Prints one JSON document: candidates grouped by kind, producer and folder with up to 3 examples each (all of
// them with --all, and always for a video or report-attachment group; a video group also lists run_by, the test lines that name its producer files), the locales the project ships with their sources (code_catalog_templates: the --catalog
// template of each JavaScript or TypeScript catalog catscan reads; code_catalogs: the locales only rejected or unread
// code catalogs name) and, with --catscan, the reader that reads
// each one on this Mac and the setup point 00 when Tesseract or a pack is missing. Exit 0, or 2 on a usage error.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';

const USAGE = "usage: node find-points.mjs <repo> [--rev REV] [--path DIR] [--all] [--catscan '<command JSON>']";
const fail = (msg) => { console.error(`find-points: ${msg}\n${USAGE}`); process.exit(2); };

const args = process.argv.slice(2);
let repo = null;
let rev = 'HEAD';
let all = false;
let catscan = null;
let scope = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') all = true;
  else if (args[i] === '--catscan') {
    try { catscan = JSON.parse(args[++i] ?? ''); } catch { catscan = null; }
    if (!Array.isArray(catscan) || !catscan.length || !catscan.every((x) => typeof x === 'string')) fail('--catscan needs the command array find-catscan printed, as JSON');
  }
  else if (args[i] === '--rev') { rev = args[++i]; if (!rev) fail('--rev needs a value'); }
  else if (args[i] === '--path') { const raw = args[++i] ?? ''; scope = raw.replace(/^(\.\/+)+/, '').replace(/\/+$/, ''); if (raw && !raw.startsWith('/') && (scope === '.' || scope === '')) { scope = null; continue; } if (!scope || scope.startsWith('/') || scope.split('/').includes('..')) fail('--path needs a folder inside the repo, relative to its root'); }
  else if (args[i].startsWith('-')) fail(`unknown option ${args[i]}`);
  else if (repo === null) repo = args[i];
  else fail(`unexpected argument ${args[i]}`);
}
if (!repo) fail('missing <repo>');
repo = resolve(repo);

// Read-only against the target: no index refresh (GIT_OPTIONAL_LOCKS), no lazy fetch into a partial clone,
// no fsmonitor daemon or untracked cache, and no inherited GIT_DIR/GIT_INDEX_FILE pointing elsewhere. The user's
// color, quoting and grep display settings are pinned so the output parses the same everywhere.
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']) delete env[k];
const PIN = ['-c', 'color.ui=never', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'grep.column=false', '-c', 'grep.fullName=false', '-c', 'grep.lineNumber=false', '-c', 'grep.patternType=default'];
const git = (...a) => {
  const r = spawnSync('git', ['-C', repo, ...PIN, ...a], { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) fail(`git ${a[0]} failed: ${r.error.message}`);
  return r;
};

const top = git('rev-parse', '--show-toplevel');
if (top.status !== 0) fail(`${repo} is not a git repository`);
const head = git('rev-parse', '--verify', '--quiet', `${rev}^{commit}`);
if (head.status !== 0) fail(`${rev} is not a commit in ${repo}`);
const sha = head.stdout.trim();
// Untracked files count, as in test-speedup's inventory header: any change makes the tree dirty.
const dirty = git('status', '--porcelain').stdout.trim() !== '';

// Source files only: docs and specs talk about screenshots without taking any.
const CODE = ['*.html', '*.htm', '*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.mts', '*.cts', '*.tsx', '*.vue', '*.svelte',
  '*.yaml', '*.yml', '*.sh', '*.bash', '*.zsh', '*.swift', '*.kt', '*.kts', '*.java', '*.py', '*.rb', '*.dart',
  '*Fastfile', '*Snapfile', '*Screengrabfile'];
// Playwright's languages only for page.screenshot(): XCUIScreen.main.screenshot() (Swift) is the XCUITest rule.
const WEB = ['*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.mts', '*.cts', '*.tsx', '*.py', '*.java', '*.cs'];
const AGENT = ['*AGENTS.md', '*CLAUDE.md', '*GEMINI.md', '*.mdc', '*copilot-instructions.md'];
// Build output and vendored code: a match there is not where the developer writes tests.
const SKIP_DIRS = ['node_modules', 'dist', 'dist-*', 'build', 'out', '.next', '.expo', 'coverage', 'vendor', 'Pods',
  'DerivedData', '.gradle', 'test-results', 'playwright-report'];
// `build` is filtered after the grep: a build folder that holds a package.json is a workspace package, not output.
const SKIP = SKIP_DIRS.filter((d) => d !== 'build').map((d) => `:(exclude,glob)**/${d}/**`)
  .concat([':(exclude,glob)**/*.min.js', ':(exclude,glob)**/*.bundle.js', ':(exclude,glob)**/*.map']);

// kind: unchecked-shot (a), pixel-text (b), canvas-text (c), locale-folder (d), video (e).
const RULES = [
  { kind: 'unchecked-shot', producer: 'playwright-screenshot', re: String.raw`\.screenshot\(`, specs: WEB },
  { kind: 'unchecked-shot', producer: 'maestro-takeScreenshot', re: String.raw`takeScreenshot:` },
  { kind: 'unchecked-shot', producer: 'detox-takeScreenshot', re: String.raw`device\.takeScreenshot\(` },
  { kind: 'unchecked-shot', producer: 'simctl-screenshot', re: String.raw`simctl[[:space:]]+io[[:space:]].*screenshot` },
  { kind: 'unchecked-shot', producer: 'adb-screencap', re: String.raw`adb.*screencap|screencap[[:space:]]+-p` },
  { kind: 'unchecked-shot', producer: 'xcuitest-screenshot', re: String.raw`XCUIScreen\.main\.screenshot\(|XCTAttachment\(screenshot` },
  { kind: 'unchecked-shot', producer: 'fastlane-screenshots', re: String.raw`capture_(ios_|android_)?screenshots`, specs: ['*Fastfile', '*.rb'] },
  { kind: 'unchecked-shot', producer: 'fastlane-screenshots', re: String.raw`(^|[^a-z_])(snapshot|screengrab)([[:space:](]|$)`, specs: ['*Fastfile', '*Snapfile', '*Screengrabfile'] },
  { kind: 'pixel-text', producer: 'pixel-snapshot', re: String.raw`toHaveScreenshot\(|toMatchImageSnapshot\(|toMatchScreenshot\(|compareScreenshot\(|toMatchSnapshot\([^)]*\.(png|jpe?g)|screenshot\([^)]*\)\)\.toMatchSnapshot\(` },
  { kind: 'canvas-text', producer: 'canvas-fillText', re: String.raw`\.(fill|stroke)Text\(` },
  { kind: 'canvas-text', producer: 'engine-text-object', re: String.raw`\.add\.(text|bitmapText)\(|new[[:space:]]+(Phaser\.GameObjects\.|PIXI\.|Konva\.)?(Text|BitmapText|HTMLText)\(` },
  // Video next to stills: a frame renderer or timelapse piping PNGs to ffmpeg, a device recording, a recorded e2e run.
  { kind: 'video', producer: 'ffmpeg', re: String.raw`['"\`]ffmpeg['"\`]|(^|[[:space:];&|(])ffmpeg[[:space:]]+-` },
  { kind: 'video', producer: 'adb-screenrecord', re: String.raw`screenrecord` },
  { kind: 'video', producer: 'simctl-recordVideo', re: String.raw`simctl[[:space:]]+io[[:space:]].*recordVideo` },
  { kind: 'video', producer: 'playwright-video', re: String.raw`recordVideo[[:space:]]*:|(^|[^A-Za-z_])video[[:space:]]*:[[:space:]]*['"](on|retain-on-failure|on-first-retry)['"]` },
  { kind: 'video', producer: 'maestro-recording', re: String.raw`startRecording:` },
  // Store art with a title or tagline (feature graphics), then any image path built from a locale variable: a
  // store-shots kit or a localized art script writes per-locale images without a screenshot call.
  { kind: 'unchecked-shot', producer: 'store-art', re: String.raw`(feature[-_]?graphic|store[-_]art|promo[-_]graphic)[^'"\`]*\.(png|jpe?g|webp)`, flags: ['-i'] },
  // A canvas read back as a data URL and written to a PNG by a script (toDataURL, then base64 to a .png file).
  { kind: 'unchecked-shot', producer: 'data-url-png', re: String.raw`\.png[^;]*base64|base64[^;]*\.png` },
  { kind: 'locale-folder', producer: 'locale-image-path', re: String.raw`\$\{[[:space:]]*(locale|lang|language|lng)[A-Za-z_]*[^}]*\}[^'"\`]*\.(png|jpe?g|webp)|join\([^)]*[^A-Za-z_](locale|lang|language|lng)[A-Za-z_]*[^)]*\.(png|jpe?g|webp)` },
];
const AGENT_RULE = { kind: 'pixel-text', producer: 'agent-reads-image', re: String.raw`(open|read|look at|view|inspect)[[:space:]]+(the[[:space:]]+)?(screenshot|image|png)` };
// A screenshot path built from a locale variable is a per-locale folder (d), however it is produced.
const LOCALE_VAR = /\$\{?\(?\s*(locale|lang|language|lng|LOCALE|LANG|LANGUAGE|LNG)\b|\{(locale|lang)\}|%\(?locale\)?s/;

const tree = git('ls-tree', '-r', '--name-only', '-z', sha);
if (tree.status !== 0) fail(`git ls-tree failed: ${tree.stderr.trim()}`);
const treeSet = new Set(tree.stdout.split('\0').filter(Boolean));
const inScope = (f) => !scope || f.startsWith(`${scope}/`);
const treePaths = [...treeSet].filter(inScope);
if (scope && !treePaths.length) fail(`--path ${scope} holds no committed file at ${rev}`);
const generated = (f) => { const p = f.split('/'); return p.slice(0, -1).some((d, i) => d === 'build' && !treeSet.has(`${p.slice(0, i + 1).join('/')}/package.json`)); };
function grep(rule, specs, flags = [], anyScope = false) {
  const r = git('grep', '--no-color', '-z', '-n', '-I', '-E', ...flags, '-e', rule.re, sha, '--', ...specs, ...SKIP);
  if (r.status !== 0 && r.status !== 1) fail(`git grep failed: ${r.stderr.trim()}`);
  // -z: <sha>:<path>\0<line>\0<text>, so a ":" or non-ASCII letter in a path survives.
  return r.stdout.split('\n').filter(Boolean).flatMap((l) => {
    const [head, line, ...text] = l.split('\0');
    if (!head?.startsWith(`${sha}:`) || !/^\d+$/.test(line ?? '')) return [];
    const file = head.slice(sha.length + 1);
    return generated(file) || (!anyScope && !inScope(file)) ? [] : [{ file, line: Number(line), text: text.join('\0') }];
  });
}

const candidates = [];
const blobLines = new Map();
const lineAt = (file, n) => {
  // `./`: paths are relative to <repo>, which may be a subfolder. A read that fails (or a blob past the buffer)
  // gives no line above, so the bare call stays a saved shot instead of aborting the scan.
  if (!blobLines.has(file)) {
    const r = spawnSync('git', ['-C', repo, ...PIN, 'show', `${sha}:./${file}`], { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
    blobLines.set(file, !r.error && r.status === 0 ? r.stdout.split('\n') : []);
  }
  return blobLines.get(file)[n - 1] ?? '';
};
const callHasPath = (h) => {
  const at = h.text.indexOf('.screenshot(');
  // Only the call's own text counts (an unrelated `path = ...` before it does not); parentheses inside strings
  // do not close it.
  let t = at < 0 ? h.text : h.text.slice(at);
  const open = (x) => { const y = x.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""'); return (y.match(/\(/g) ?? []).length - (y.match(/\)/g) ?? []).length; };
  for (let k = 1; open(t) > 0 && k <= 20; k++) t += `\n${lineAt(h.file, h.line + k)}`;
  return /\bpath\s*[:=]/.test(t);
};
const fullText = new WeakMap(); // evidence is cut at 160 chars; the locale token can sit past it
// One line, one candidate: a store-art or locale-image-path hit on a line an earlier rule took is dropped.
const seen = new Set();
const LATE = new Set(['store-art', 'data-url-png', 'locale-image-path']);
for (const rule of RULES) {
  for (const h of grep(rule, rule.specs ?? CODE, rule.flags)) {
    // A probe (`ffmpeg -version`) writes nothing; a line that also has an input does.
    if (rule.producer === 'ffmpeg' && /['"\s]-version['"\s,\]]/.test(h.text) && !/['"\s]-i['"\s,]/.test(h.text)) continue;
    const at = `${h.file}\0${h.line}`;
    if (LATE.has(rule.producer) && seen.has(at)) continue;
    seen.add(at);
    const shot = rule.kind === 'unchecked-shot';
    // A screenshot attached to the report with no path saves no file: its own group, listed as a dropped line.
    // A path (`path:`, Python `path=`) in the call keeps it a saved shot, attached or not; options split over
    // later lines are read up to the call's closing parenthesis.
    // `body:` may end the line above: a bare `await page.screenshot(),` is then the field's value (and only then:
    // a bare call in a `writeFile(` argument list saves a file). `body: T =` (a variable or class property) is a declaration, no field.
    const attached = rule.producer === 'playwright-screenshot'
      && (/\.attach\(|(?<!\b(?:const|let|var)\s+)\bbody\s*:(?!\s*[\w$.<>[\]|&,\s]+(?<![|&<!]|\s>)=(?![=>]))/.test(h.text)
        || (/^\s*\(?\s*(await\s+)?[\w$]+(\([^)]*\))?(\.[\w$]+(\([^)]*\))?)*\.screenshot\(\s*(\{[^}]*\})?\s*\)\s*\)?\s*,?\s*$/.test(h.text)
          && /\bbody\s*:\s*\(?\s*$/.test(lineAt(h.file, h.line - 1))))
      && !callHasPath(h);
    const c = { file: h.file, line: h.line, kind: shot && !attached && LOCALE_VAR.test(h.text) ? 'locale-folder' : rule.kind,
      producer: attached ? 'report-attachment' : rule.producer, evidence: h.text.trim().slice(0, 160) };
    candidates.push(c); fullText.set(c, h.text);
  }
}
for (const h of grep(AGENT_RULE, AGENT, ['-i'])) {
  candidates.push({ file: h.file, line: h.line, kind: AGENT_RULE.kind, producer: AGENT_RULE.producer, evidence: h.text.trim().slice(0, 160) });
}
// a test that hashes rendered images against a golden or baseline guards their text by pixels too.
const TESTS = ['*.test.*', '*.spec.*', '**/test/**', '**/tests/**', '**/Tests/**', '**/*Tests/**', '**/androidTest/**', '**/__tests__/**'].map((g) => `:(glob)${g.startsWith('*.') ? `**/${g}` : g}`);
const inTests = (re) => new Set(grep({ re }, TESTS, ['-i']).filter((h) => /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|py|swift|kt|java|rb|dart)$/.test(h.file)).map((h) => h.file));
// A hash function, not `location.hash`; a PNG path, not the word: common words alone make no candidate.
const hashing = inTests(String.raw`createHash|sha-?(1|256|512)|md5|digest`);
const png = inTests(String.raw`\.png`);
const firstGolden = new Map();
for (const h of grep({ re: String.raw`golden|baseline` }, TESTS, ['-i'])) {
  if (hashing.has(h.file) && png.has(h.file) && !firstGolden.has(h.file)) firstGolden.set(h.file, h);
}
for (const h of firstGolden.values()) candidates.push({ file: h.file, line: h.line, kind: 'pixel-text', producer: 'pixel-hash', evidence: h.text.trim().slice(0, 160) });

// catscan itself, when find-catscan found one: its language list, its catalog discovery and its readers.
const run = (a, timeout = 120000) => spawnSync(catscan[0], [...catscan.slice(1), ...a], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
const notes = [];

// Committed screenshot folders split by locale: <dir>/<locale>/x.png or <dir>/x.<locale>.png.
const LOCALE = /^([a-z]{2,3})([-_]([A-Z]{2}|[A-Z][a-z]{3}|r[A-Z]{2}))?$/;
// Codes that are also common folder words (id, no, it, my) are left out: a folder named "id" is rarely Indonesian.
const WORDS = new Set(['id', 'no', 'is', 'it', 'my']);
const LANGS = new Set('ar bg bn ca cs cy da de el en es et eu fa fi fil fr ga gl he hi hr hu hy ja ka kk km ko lt lv mk ml mn ms mt nb ne nl pa pl pt ro ru si sk sl sq sr sv sw ta te th tl tr uk ur uz vi zh'.split(' '));
// Language codes for explicit locale lists (configs), where a folder word cannot be confused for one.
const KNOWN = new Set([...LANGS, ...WORDS]);
if (catscan) {
  // `catscan languages --json`: every locale this catscan reads, the Tesseract ones (is, be, bs) included, so a new
  // locale needs no change here. Only the Tesseract ones may also be folder words: they are why this list exists.
  const l = json(run(['languages', '--json']));
  if (l && Array.isArray(l.languages)) {
    for (const x of l.languages) { const b = String(x.locale).split('-')[0]; KNOWN.add(b); if (!WORDS.has(b)) LANGS.add(b); }
    for (const x of l.fallback_locales ?? []) { LANGS.add(String(x).split('-')[0]); KNOWN.add(String(x).split('-')[0]); }
  } else notes.push('catscan languages --json printed no JSON: the built-in locale list was used');
}
const isLocale = (s) => { const m = s.match(LOCALE); return Boolean(m && LANGS.has(m[1])); };
// A screenshot path literal that ends in a locale token (`sheet-ru.png`, `home.de.png`) is per-locale too.
const SHOT_TOKEN = /[._-]([a-z]{2,3}(?:[-_](?:[A-Z]{2}|[A-Z][a-z]{3}))?)\.(?:png|jpe?g|webp)['"`]/;
for (const c of candidates) {
  const m = c.kind === 'unchecked-shot' && c.producer !== 'report-attachment' && (fullText.get(c) ?? c.evidence).match(SHOT_TOKEN);
  if (m && isLocale(m[1])) c.kind = 'locale-folder';
}
const isWordLocale = (s) => { const m = s.match(LOCALE); return Boolean(m && KNOWN.has(m[1])); };
const skippedDir = (d) => d !== 'build' && SKIP_DIRS.some((s) => (s.endsWith('*') ? d.startsWith(s.slice(0, -1)) : d === s));
// Output folders, or a build folder that is no workspace package (no package.json), never count.
const skippedPath = (p) => p.split('/').slice(0, -1).some(skippedDir) || generated(p);
// a code that is also a folder word (it, id, no) is a locale when at least two siblings are unambiguous
// locales: files with the same extension in the same folder, or folders in the same parent.
const stemsIn = new Map();
const dirsIn = new Map();
for (const p of treePaths) {
  const parts = p.split('/');
  const name = parts.pop();
  const dot = name.lastIndexOf('.');
  const key = `${parts.join('/')}\0${dot > 0 ? name.slice(dot) : ''}`;
  (stemsIn.get(key) ?? stemsIn.set(key, new Set()).get(key)).add(dot > 0 ? name.slice(0, dot) : name);
  for (let i = 0; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    (dirsIn.get(parent) ?? dirsIn.set(parent, new Set()).get(parent)).add(parts[i]);
  }
}
const siblingsAreLocales = (names, self) => [...names].filter((n) => n !== self && isLocale(n)).length >= 2;
// The locale a file stem names (de.json), or null.
const stemLocale = (p) => {
  const parts = p.split('/');
  const name = parts.pop();
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (isLocale(stem)) return stem;
  return isWordLocale(stem) && siblingsAreLocales(stemsIn.get(`${parts.join('/')}\0${dot > 0 ? name.slice(dot) : ''}`) ?? [], stem) ? stem : null;
};
// Whether folder `name` under `parent` names a locale.
const dirLocale = (parent, name) => isLocale(name) || (isWordLocale(name) && siblingsAreLocales(dirsIn.get(parent) ?? [], name));
// Locales the project ships, each with where it was seen.
const shipped = new Map();
const addSource = (loc, kind, file) => {
  const l = loc.replace(/_/g, '-');
  const e = shipped.get(l) ?? new Map();
  e.set(`${kind}\0${file}`, { kind, file }); shipped.set(l, e);
};
const folders = new Map();
for (const p of treePaths) {
  if (!/\.(png|jpe?g|webp|heic)$/i.test(p) || skippedPath(p)) continue;
  const parts = p.split('/');
  const name = parts.pop();
  let dir = null; let loc = null;
  // the nearest folder that names a locale, at any depth (kit/de/ios/1.png is de under kit).
  for (let i = parts.length - 1; i >= 0 && !loc; i--) {
    if (dirLocale(parts.slice(0, i).join('/'), parts[i])) { dir = parts.slice(0, i).join('/') || '.'; loc = parts[i]; }
  }
  if (!loc) {
    // The last segment only: main-menu-de.png is "de", btn_close_en.png is "en".
    const m = name.match(/[._-]([a-z]{2,3}(?:[-_](?:[A-Z]{2}|[A-Z][a-z]{3}|r[A-Z]{2}))?)\.(png|jpe?g|webp|heic)$/);
    if (m && isLocale(m[1])) { dir = parts.join('/') || '.'; loc = m[1]; }
  }
  if (!dir) continue;
  const f = folders.get(dir) ?? { locales: new Set(), images: 0 };
  f.locales.add(loc); f.images++; folders.set(dir, f);
}
for (const [dir, f] of folders) {
  // a folder with one locale (a research or design folder) is no locale source and no candidate.
  if (f.locales.size < 2) continue;
  for (const loc of f.locales) addSource(loc, 'screenshots', dir);
  candidates.push({ file: dir, line: 0, kind: 'locale-folder', producer: 'committed-locale-shots',
    evidence: `${f.images} images in ${f.locales.size} locales: ${[...f.locales].sort().join(', ')}` });
}

// Catalogs, through catscan's own discovery (core-js results.js, the one --expect-locales-from uses), fed the
// committed tree: a dirty or ignored file never adds a locale.
const paths = treePaths.filter((p) => !skippedPath(p));
const show = (f) => { const r = git('show', `${sha}:./${f}`); if (r.status !== 0) throw new Error(r.stderr.trim()); return r.stdout; };
const catalog = (p) => /\.(xcstrings|arb|po)$/i.test(p)
  || (/\.(strings|stringsdict)$/i.test(p) && /\.lproj\/[^/]+$/.test(p))
  || (/\.xml$/i.test(p) && /(^|\/)values-[^/]+\/[^/]+\.xml$/.test(p))
  || (/\.json$/i.test(p) && (stemLocale(p) !== null || dirLocale(dirname(dirname(p)).replace(/^\.$/, ''), basename(dirname(p)))));
let discovery = null;
if (catscan) {
  try {
    const req = createRequire(realpathSync(catscan.at(-1)));
    discovery = req(req.resolve('@catscan/core-js/src/results.js'));
    if (typeof discovery.localesFromFiles !== 'function') { discovery = null; notes.push('this catscan has no shared catalog discovery (older than 0.47): catalogs were not read'); }
  } catch (e) { notes.push(`catscan's catalog discovery could not be loaded (${e.code ?? e.message}): catalogs were not read`); }
}
const catalogWarnings = [];
if (discovery) {
  const r = discovery.localesFromFiles(paths.filter(catalog), show);
  for (const [loc, files] of Object.entries(r.sources)) {
    for (const f of files) {
      if (KNOWN.has(loc.split(/[-_]/)[0].toLowerCase())) { addSource(loc, 'catalog', f); continue; }
      // catscan reads <dir>/en/ui.json as a locale "ui" from its name; the folder names the real one.
      const dir = basename(dirname(f));
      const up = dirname(dirname(f)).replace(/^\.$/, '');
      if (/\.json$/i.test(f) && dirLocale(up, dir)) {
        addSource(dir, 'catalog', f);
        catalogWarnings.push(`${f}: catscan reads the locale "${loc}" from the file name; find-points filed it under the folder locale ${dir}.`
          + ` Fix: pass --locale ${dir} with this catalog, and --expect-locales <list> instead of --expect-locales-from ${up || '.'}.`);
      } else {
        addSource(loc, 'catalog', f);
        catalogWarnings.push(`${f}: its locale "${loc}" is not a language this catscan knows.`
          + ` Fix: name the file or folder after the locale it ships, or leave it out of --catalog; check it is a catalog at all.`);
      }
    }
  }
  catalogWarnings.push(...r.warnings.map((w) => w.message));
}
// Locale-named JavaScript or TypeScript files under an i18n folder are code catalogs. One catscan reads is a catalog;
// one it rejects (or every one, before catscan 0.66) still names a shipped locale, so it is never dropped, and
// code_catalogs lists the locales no readable catalog has.
const I18N = /^(i18n|l10n|locales?|langs?|translations|messages)$/i;
let codeReader = null;
let codeLoader = null;
// Each blob is copied to a private temp folder under its own name so catscan's loader reads the committed bytes.
let codeTmpDir = null;
let codeCopies = 0;
const codeTmp = () => {
  if (!codeTmpDir) { codeTmpDir = mkdtempSync(join(tmpdir(), 'find-points-')); process.on('exit', () => rmSync(codeTmpDir, { recursive: true, force: true })); }
  return codeTmpDir;
};
if (discovery) {
  try {
    const req = createRequire(realpathSync(catscan.at(-1)));
    codeReader = req(req.resolve('@catscan/core-js/src/code-catalog.js'));
    codeLoader = req(req.resolve('@catscan/core-js/src/catalog.js'));
    if (typeof codeReader.parse !== 'function' || typeof codeLoader.loadFile !== 'function') codeReader = null;
  } catch { codeReader = null; }
  if (!codeReader) notes.push('this catscan reads no JavaScript or TypeScript catalogs (older than 0.66): code catalogs were not read');
}
const codeTemplates = new Map();
const codeUnread = new Map();
const VENDORED = /^(static|vendors?|third[-_]?party|external|bower_components)$/i;
for (const p of paths) {
  if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p) || /\.d\.[mc]?ts$/.test(p)) continue;
  const dirs = p.split('/').slice(0, -1);
  // A library's own locale files (select2/i18n, tinymce/langs) under a static or third-party folder are not the app's.
  if (!dirs.some((d) => I18N.test(d)) || dirs.some((d) => VENDORED.test(d))) continue;
  const stem = stemLocale(p);
  const loc = stem ?? (dirs.length && dirLocale(dirs.slice(0, -1).join('/'), dirs.at(-1)) ? dirs.at(-1) : null);
  if (!loc) continue;
  // catscan 0.66+ reads object-literal code catalogs as text (core-js code-catalog.js, never run): such a file is a
  // readable catalog with a {locale} template; a file its reader rejects stays a code-catalog source with the reason.
  if (codeReader) {
    let why = null;
    try {
      // catscan's own loader decides, on the committed bytes: its size cap, its decoder (UTF-8 or a UTF-16 BOM, never
      // lossy), a bare JSON object read as JSON, and the code reader. An unread file skips every key, and a file whose
      // locale-named exports hold none for this locale is a missing catalog.
      const blob = spawnSync('git', ['-C', repo, ...PIN, 'show', `${sha}:./${p}`], { env, maxBuffer: 256 * 1024 * 1024 });
      if (blob.status !== 0) throw new Error(String(blob.stderr).trim());
      const copy = join(codeTmp(), String(codeCopies++), basename(p));
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, blob.stdout);
      const r = codeLoader.loadFile(copy, loc.replace(/_/g, '-'));
      if (!r) why = 'catscan could not open it';
      else if (r.unread) why = `code uses ${r.unread.name} at ${r.unread.line}:${r.unread.col} beyond declaring and exporting it, so no key is read`;
      else if (r.missingLocale) why = `its locale-named exports (${(r.locales ?? codeReader.locales(blob.stdout.toString('utf8'), p) ?? []).join(', ')}) hold none for ${loc}`;
    } catch (e) { why = String(e.message ?? e).split('\n')[0].replaceAll(codeTmpDir ?? '\0', ''); }
    if (!why) {
      addSource(loc, 'catalog', p);
      const t = stem ? `${dirname(p)}/{locale}${p.slice(p.lastIndexOf('.'))}` : `${dirs.slice(0, -1).join('/')}/{locale}/${basename(p)}`;
      // catscan puts the --locale value into {locale} as is, so the template's locales keep the path's spelling (pt_BR).
      (codeTemplates.get(t) ?? codeTemplates.set(t, new Set()).get(t)).add(loc);
      continue;
    }
    codeUnread.set(p, why);
  }
  addSource(loc, 'code-catalog', p);
}
// Without catscan's discovery, a readable catalog still counts by its file name: <locale>.json, <locale>.lproj,
// values-<locale>.
const readable = new Set(discovery ? [] : paths.filter(catalog).map((p) => {
  const d = basename(dirname(p));
  const l = /\.json$/i.test(p) ? stemLocale(p) ?? d : d.replace(/\.lproj$/, '').replace(/^values-/, '').replace(/-r([A-Z]{2})$/, '-$1');
  return l.replace(/_/g, '-'); // as addSource writes it
}));
const codeCatalogs = [...shipped].filter(([l, s]) => { const k = [...s.values()].map((x) => x.kind); return k.includes('code-catalog') && !k.includes('catalog') && !readable.has(l); })
  .map(([locale, s]) => {
    const files = [...s.values()].filter((x) => x.kind === 'code-catalog').map((x) => x.file).sort();
    return { locale, files, ...(codeReader ? { unread: files.map((file) => ({ file, reason: codeUnread.get(file) })) } : {}) };
  })
  .sort((a, b) => a.locale.localeCompare(b.locale));
if (codeCatalogs.length) {
  const langs = codeCatalogs.map((c) => c.locale);
  catalogWarnings.push(codeReader
    ? `${langs.join(', ')}: only JavaScript or TypeScript catalogs catscan's reader rejects (code_catalogs lists each file and why).`
      + ` Fix: export the strings as a plain object literal (export default { ... }) or to <locale>.json; until then untranslated --languages ${langs.join(',')} covers wrong-language.`
    : `${langs.join(', ')}: only JavaScript or TypeScript catalogs, which this catscan cannot read`
      + ` (code_catalogs lists the files). Fix: use catscan 0.66 or later, or export each to <locale>.json; until then untranslated --languages ${langs.join(',')} covers wrong-language.`);
}
// Test configs: Playwright `locale`, fastlane Snapfile `languages`, Maestro env (LOCALE, LANG, LANGUAGE).
const CODE_RE = /^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/;
const config = (loc, kind, file) => { if (CODE_RE.test(loc) && KNOWN.has(loc.split(/[-_]/)[0])) addSource(loc, kind, file); };
for (const h of grep({ re: String.raw`(^|[^A-Za-z_])locale[[:space:]]*:[[:space:]]*['"][A-Za-z_-]+['"]` }, WEB)) {
  const m = h.text.match(/locale\s*:\s*['"]([A-Za-z_-]+)['"]/); if (m) config(m[1], 'playwright-locale', h.file);
}
for (const f of paths.filter((p) => /(^|\/)Snapfile$/.test(p))) {
  const m = show(f).match(/languages\s*\(\s*\[([\s\S]*?)\]/);
  for (const q of m ? m[1].matchAll(/["']([A-Za-z_-]+)["']/g) : []) config(q[1], 'fastlane-languages', f);
}
for (const h of grep({ re: String.raw`(^|[^A-Za-z_])(LOCALE|LANGUAGE|LANG)[[:space:]]*[:=][[:space:]]*['"]?[a-z]{2,3}([-_][A-Za-z]{2,4})?['"]?([[:space:]]|$)` }, ['*.yaml', '*.yml'])) {
  const m = h.text.match(/(?:LOCALE|LANGUAGE|LANG)\s*[:=]\s*['"]?([a-z]{2,3}(?:[-_][A-Za-z]{2,4})?)/); if (m) config(m[1], 'maestro-env', h.file);
}

// The reader for each locale on this Mac, from `catscan doctor --expect-locales <list> --json`, and
// setup point 00 when a locale needs Tesseract that is missing here. The fix is doctor's own, named for this Mac's setup: with an override
// (CATSCAN_TESSERACT or TESSDATA_PREFIX) or a non-Homebrew tessdata there is no brew command to run.
const list = [...shipped.keys()].sort();
// Only well-formed codes reach doctor: one odd catalog key (a space, a comma) would fail the whole call.
const asked = list.filter((l) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l));
let readers = null;
if (catscan && asked.length) {
  const r = run(['doctor', '--expect-locales', asked.join(','), '--json']);
  const d = json(r);
  if (d && Array.isArray(d.requested)) readers = d;
  else notes.push(`catscan doctor --expect-locales printed no locale rows (exit ${r.status ?? r.signal}): readers unknown`);
}
const rows = new Map((readers?.requested ?? []).map((x) => [x.locale, x]));
const locales = list.map((loc) => {
  const x = rows.get(loc);
  return { locale: loc, sources: [...shipped.get(loc).values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file)),
    reader: x ? x.reader : null, reads_now: x ? x.ok : null, ...(x?.error ? { error: { code: x.error.code, message: x.error.message, hint: x.error.hint ?? null } } : {}) };
});
const shq = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const missing = locales.filter((l) => l.reader === 'tesseract' && l.error?.code === 'reader-missing');
let setup = null;
if (missing.length) {
  const fix = readers.fallback?.fix || missing[0].error.hint;
  const override = process.env.CATSCAN_TESSERACT ? 'CATSCAN_TESSERACT' : process.env.TESSDATA_PREFIX ? 'TESSDATA_PREFIX' : null;
  const brew = override ? null : (fix.match(/^(brew install [a-z][a-z -]*?)(?= \(about|,|$)/)?.[1] ?? null);
  setup = { point: '00', locales: missing.map((l) => l.locale), fix, command: brew, override,
    // The proof runs the catscan find-catscan found, never whichever `catscan` is first on PATH.
    check: [...catscan, 'doctor', '--expect-locales', missing.map((l) => l.locale).join(',')].map(shq).join(' ') };
}

// Large generated files (bundles checked in under another name) are not test code.
const files = [...new Set(candidates.filter((c) => c.line > 0).map((c) => c.file))];
const big = new Set();
if (files.length) {
  const sizes = spawnSync('git', ['-C', repo, ...PIN, 'cat-file', '--batch-check=%(objectsize)'], { input: files.map((f) => `${sha}:${f}`).join('\n') + '\n', encoding: 'utf8', env });
  sizes.stdout.split('\n').forEach((s, i) => { if (Number(s) > 1024 * 1024) big.add(files[i]); });
}
const kept = candidates.filter((c) => !big.has(c.file))
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.producer.localeCompare(b.producer));
const counts = {};
for (const c of kept) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
// A group is one kind and producer in one folder: usually one test suite or one game.
const groups = new Map();
for (const c of kept) {
  const dir = c.line === 0 ? c.file : c.file.split('/').slice(0, -1).join('/') || '.';
  const key = `${c.kind}\0${c.producer}\0${dir}`;
  const g = groups.get(key) ?? { kind: c.kind, producer: c.producer, dir, lines: 0, files: new Set(), examples: [] };
  g.lines++; g.files.add(c.file);
  // A video group keeps every line: one suite file can hold several recordings, each its own point. An
  // attachment group too: each is a dropped line of its own.
  if (all || c.kind === 'video' || c.producer === 'report-attachment' || g.examples.length < 3) g.examples.push({ file: c.file, line: c.line, evidence: c.evidence });
  groups.set(key, g);
}
// A video producer run only by hand gives `video` no point, but one a test starts does: run_by lists, per producer
// file that is not a test itself, up to 3 test lines that name its base name, in or out of --path. A hint the agent opens, never a verdict.
const isTest = (f) => /(^|\/)(test|tests|Tests|[^/]*Tests|androidTest|__tests__)\//.test(f) || /\.(test|spec)\.[^/.]+$/.test(f);
const runBy = new Map();
const runByOf = (f) => {
  if (!runBy.has(f)) {
    const name = basename(f);
    runBy.set(f, isTest(f) ? [] : grep({ re: `(^|[^A-Za-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)` }, TESTS, [], true)
      .filter((h) => h.file !== f).slice(0, 3).map((h) => ({ file: h.file, line: h.line, evidence: h.text.trim().slice(0, 160) })));
  }
  return runBy.get(f);
};
const out = [...groups.values()].map((g) => ({ ...g, files: g.files.size,
  ...(g.kind === 'video' ? { run_by: [...g.files].sort().flatMap(runByOf) } : {}) }))
  .sort((a, b) => a.kind.localeCompare(b.kind) || b.lines - a.lines || a.dir.localeCompare(b.dir));
console.log(JSON.stringify({ schema: 1, repo: top.stdout.trim(), rev, path: scope, head: sha, dirty, counts, groups: out,
  locales, code_catalog_templates: [...codeTemplates].map(([template, l]) => ({ template, locales: [...l].sort() })).sort((a, b) => a.template.localeCompare(b.template)),
  code_catalogs: codeCatalogs, catalog_warnings: catalogWarnings, setup, notes }, null, 1));
