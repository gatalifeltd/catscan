// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// The HTML report (spec 18). Its only input is a results-file object (spec 27, D1); the page is a static shell, one
// embedded JSON block and one inline script that renders on load (D20). Thumbnails come from the binary's `serve`
// `thumbnail` request (D6, D18), so this module never decodes an image.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const overlay = require("./overlay");
const baseline = require("../baseline");
const scale = require("../scale");
const { cellKey, byDevice, byTextSize, sizeOf, platformOf } = require("../results");

/**
 * TODO-076: whether a file uses the text-size axis; then a cell with no size is shown as `default` (D6). A baseline's
 * gone cells count too, so a `large` cell only the baseline holds is not folded into the `default` one.
 */
const usesSizes = (file) => file.results.some((e) => e.text_size != null) || Boolean(file.coverage && file.coverage.expected_text_sizes)
  || Boolean(file.baseline && file.baseline.cells.some((c) => c.text_size != null && c.text_size !== "default"));

const OVERLAY_SRC = fs.readFileSync(path.join(__dirname, "overlay.js"), "utf8");
const PAGE_JS = fs.readFileSync(path.join(__dirname, "page.js"), "utf8");
const PAGE_CSS = fs.readFileSync(path.join(__dirname, "page.css"), "utf8");

const LARGE = 50 * 1024 * 1024; // D12
const QUALITY = 0.7;
const DEFAULT_MAX_EDGE = 800;
const LINKABLE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]); // D8: what every browser shows
const DEFAULT_SIZE = { width: 9, height: 19.5 }; // a phone screen, when nothing records a size
const MAX_VIDEO_THUMBS = 10; // D5
const MISSING_LINES = 10; // D26
const IN_FLIGHT = 8; // thumbnail requests outstanding at once
const RANK = { pass: 0, fail: 1, "needs-reader": 2, unsupported: 2, error: 3 }; // exit precedence (spec 00)
const DEFAULT_LAYOUT = "{locale}/{screen}";

const isMissing = (e) => e.path === null && Array.isArray(e.findings) && e.findings.some((f) => f && f.kind === "missing");
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function argvLayout(argv) {
  for (let i = 0; i < (argv || []).length; i++) {
    if (argv[i] === "--layout" && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith("--layout=")) return argv[i].slice(9);
  }
  return null;
}

/**
 * TODO-038 T3: the index of each envelope's cell in `baseline.cells[]` (D7: the report never recomputes a state),
 * by the cell's current input path and command; null for an envelope no cell names (always reviewed).
 */
function baselineCellOf(file) {
  const b = file.baseline;
  if (!b) return null;
  const byInput = new Map();
  // The cell's device and text size are part of the key: one-job-per-device (or per-size) shards share relative paths
  // (TODO-075, review fix; TODO-076).
  const key = (c, p, command) => `${c.device ?? ""}\0${sizeOf(c.text_size)}\0${p}\0${command}`;
  b.cells.forEach((c, k) => { if (c.state !== "gone") for (const x of c.inputs) if (x.path !== null) byInput.set(key(c, x.path, x.command), k); });
  return file.results.map((e) => (isMissing(e) ? null : byInput.get(key(e, e.path, e.command)) ?? null));
}

/**
 * The locale x screen matrix (D2, D3, D4) and the unmapped and missing lists. With several devices each locale column
 * splits into one sub-column per device, ordered by platform then label (TODO-075 D8), and with several text sizes
 * each device column into one per size, in label order (TODO-076 "Report layout").
 */
function matrix(file) {
  const cov = file.coverage;
  const layout = cov ? cov.layout : argvLayout(file.run.argv) || DEFAULT_LAYOUT;
  const cells = new Map();
  const spell = new Map(); // lowercased locale -> the first spelling seen
  const screens = new Set();
  const unmapped = [];
  const missing = [];
  const sized = usesSizes(file);
  const cellOf = (device, size, locale, screen) => {
    device = device ?? null;
    const text_size = sized ? sizeOf(size) : null;
    const k = cellKey({ device, text_size, locale, screen });
    if (!spell.has(locale.toLowerCase())) spell.set(locale.toLowerCase(), locale);
    screens.add(screen);
    if (!cells.has(k)) cells.set(k, { device, text_size, locale: spell.get(locale.toLowerCase()), screen, items: [], missing: false, duplicate: false });
    return cells.get(k);
  };
  if (cov) {
    for (const l of cov.expected_locales) spell.set(l.toLowerCase(), spell.get(l.toLowerCase()) ?? l);
    for (const s of cov.expected_screens) screens.add(s);
  }
  file.results.forEach((e, i) => {
    if (isMissing(e)) {
      cellOf(e.device, e.text_size, e.locale, e.screen).missing = true;
      missing.push({ device: e.device ?? null, text_size: e.text_size ?? null, locale: e.locale, screen: e.screen, expected_path: e.findings.find((f) => f.kind === "missing").expected_path });
      return;
    }
    if (typeof e.screen !== "string") { unmapped.push(i); return; }
    const c = cellOf(e.device, e.text_size, e.locale, e.screen);
    c.items.push(i);
    // D4: the badge comes from the spec 27 warning, never a recount.
    if ((e.warnings || []).some((w) => w.code === "duplicate-cell")) c.duplicate = true;
  });
  // TODO-038: a mapped cell only in the baseline is a grey `gone` cell, unless the run already lists it as missing.
  const gone = new Map(); // cell key -> index in baseline.cells
  (file.baseline ? file.baseline.cells : []).forEach((c, k) => {
    if (c.state !== "gone" || typeof c.screen !== "string" || cells.has(cellKey(c))) return;
    cellOf(c.device, c.text_size, c.locale, c.screen);
    gone.set(cellKey(c), k);
  });
  const anyMapped = [...cells.values()].some((c) => c.items.length || c.missing);
  if (!anyMapped) {
    // TODO-075 D13: the run's layout-mismatch warnings name a {device}/ variant when it maps every input.
    const tries = new Set(unmapped.map((i) => {
      const w = (file.results[i].warnings || []).find((x) => x.code === "layout-mismatch");
      return w && /^--layout '/.test(w.hint || "") ? w.hint : null;
    }));
    const better = tries.size === 1 && !tries.has(null) ? [...tries][0] : null;
    const hint = better ? `no input matched --layout '${layout}' - try: ${better}` : `no input matched --layout '${layout}'; see --layout and --expect-locales`;
    return { shown: false, hint, unmapped, missing, coverageLine: null, devices: [], textSizes: [], coverageByDevice: null };
  }
  const L = cov ? new Set(cov.expected_locales.map((l) => l.toLowerCase())) : null;
  const S = cov ? new Set(cov.expected_screens) : null;
  const D = cov && cov.expected_devices ? new Set(cov.expected_devices) : null;
  const T = cov && cov.expected_text_sizes ? new Set(cov.expected_text_sizes) : null;
  const of = baselineCellOf(file);
  const out = [];
  for (const c of cells.values()) {
    if (gone.has(cellKey(c))) {
      out.push({ device: c.device, text_size: c.text_size, locale: c.locale, screen: c.screen, state: "gone", count: 0, badges: [], items: [], change: gone.get(cellKey(c)), review: false });
      continue;
    }
    const state = c.missing ? "missing" : c.items.map((i) => file.results[i].verdict).reduce((a, v) => (RANK[v] > RANK[a] ? v : a), "pass");
    const count = c.items.reduce((n, i) => n + failures(file.results[i]), 0);
    const badges = [];
    if (cov && (!L.has(c.locale.toLowerCase()) || !S.has(c.screen) || (D && !D.has(c.device)) || (T && !T.has(c.text_size)))) badges.push("unexpected");
    if (c.duplicate) badges.push("duplicate");
    const cell = { device: c.device, text_size: c.text_size, locale: c.locale, screen: c.screen, state, count, badges, items: c.items };
    // TODO-077: a cell keeps its verdict and shows its worst gating severity.
    const worst = scale.sortItems(c.items.flatMap((i) => [...(file.results[i].checks || []).filter((x) => x.verdict === "fail"), ...(file.results[i].findings || [])]).filter((x) => x.gate !== false && x.severity !== undefined))[0];
    if (worst) cell.severity = worst.severity;
    if (of) {
      // A missing cell is outside the skip-share denominator (D10) but is a gap the tester must see: it stays shown.
      // Any input that no cell names or whose cell needs review keeps the whole matrix cell in review.
      const k = c.items.length ? of[c.items[0]] : null;
      cell.change = k;
      cell.review = !c.items.length || c.items.some((i) => of[i] === null || file.baseline.cells[of[i]].review);
    }
    out.push(cell);
  }
  const locales = [...new Set([...spell.values()])].filter((l) => out.some((c) => c.locale.toLowerCase() === l.toLowerCase()) || (L && L.has(l.toLowerCase()))).sort(byCodePoint);
  const rows = [...screens].sort(byCodePoint);
  const devices = [...new Set([...(cov && cov.expected_devices ? cov.expected_devices : []), ...out.map((c) => c.device).filter((d) => d !== null)])].sort(byDevice);
  const textSizes = sized ? [...new Set([...(cov && cov.expected_text_sizes ? cov.expected_text_sizes : []), ...out.map((c) => c.text_size)])].sort(byTextSize) : [];
  out.sort((a, b) => byCodePoint(a.screen, b.screen) || byCodePoint(a.locale, b.locale) || byDevice(a.device ?? "", b.device ?? "") || byTextSize(a.text_size ?? "", b.text_size ?? ""));
  // TODO-076 D8: `large text` marks a cell at a non-default size that fails while its default twin passes: a defect
  // only large text shows. No badge when the default cell is missing or does not pass.
  if (sized) {
    const byCell = new Map(out.map((c) => [cellKey(c), c]));
    for (const c of out) {
      if (c.text_size === "default" || c.state !== "fail") continue;
      const twin = byCell.get(cellKey({ ...c, text_size: "default" }));
      if (twin && twin.state === "pass") c.badges.push("large text");
    }
  }
  // The device filter shows one device's coverage line (TODO-075 "Device filter").
  const coverageByDevice = devices.length > 1 && cov ? Object.fromEntries(devices.map((d) => [d, coverageLine({ ...cov, expected_devices: [d] }, out.filter((c) => c.device === d))])) : null;
  return { shown: true, layout, locales, screens: rows, devices: devices.map((d) => ({ device: d, platform: platformOf(d) })), textSizes, cells: out, unmapped, missing, coverageLine: coverageLine(cov, out), coverageByDevice };
}

/** Failed checks plus findings: the count a `fail` cell shows. */
function failures(e) {
  return (e.checks || []).filter((c) => c.verdict === "fail").length + (e.findings || []).filter((f) => f.gate !== false).length;
}

/** D3: cells, not envelopes; only when coverage is not null. Several devices and text sizes multiply the cells (TODO-075, TODO-076). */
function coverageLine(cov, cells) {
  if (!cov) return null;
  const L = new Set(cov.expected_locales.map((l) => l.toLowerCase())), S = new Set(cov.expected_screens);
  const devs = cov.expected_devices || [null];
  const D = new Set(devs);
  const sizes = cov.expected_text_sizes || [null];
  const T = cov.expected_text_sizes ? new Set(sizes) : null;
  const expected = cov.expected_locales.length * cov.expected_screens.length * devs.length * sizes.length;
  const inExpected = cells.filter((c) => D.has(c.device ?? null) && (!T || T.has(sizeOf(c.text_size))) && L.has(c.locale.toLowerCase()) && S.has(c.screen));
  const received = inExpected.filter((c) => c.items.length > 0).length;
  const dup = cells.filter((c) => c.badges.includes("duplicate")).length;
  const factor = (devs.length > 1 ? ` x ${devs.length} devices` : "") + (sizes.length > 1 ? ` x ${sizes.length} text sizes` : "");
  return `received ${received} of ${expected} expected cells (${cov.expected_screens.length} screens x ${cov.expected_locales.length} locales${factor}), ${expected - received} missing, ${dup} duplicate`;
}

/** D5: marks at first_seen, last_seen and failed closest.t, and at most 10 failed frame times for thumbnails. */
function videoTimeline(e) {
  const marks = [];
  const failed = [];
  (e.checks || []).forEach((c, i) => {
    const ref = `c${i}`;
    if (typeof c.first_seen === "number") marks.push({ t: c.first_seen, type: "first_seen", ref });
    if (typeof c.last_seen === "number") marks.push({ t: c.last_seen, type: "last_seen", ref });
    if (c.verdict !== "fail") return;
    if (c.closest && typeof c.closest.t === "number") { marks.push({ t: c.closest.t, type: "closest", ref }); failed.push(c.closest.t); }
    else if (c.kind === "absent" && typeof c.first_seen === "number") failed.push(c.first_seen);
  });
  const times = [...new Set(failed)].sort((a, b) => a - b).slice(0, MAX_VIDEO_THUMBS);
  marks.sort((a, b) => a.t - b.t || byCodePoint(a.type, b.type));
  return { duration: e.video ? e.video.duration : null, marks, times };
}

/**
 * D7: a results-file path under `root`: relative joined, `abs:` joined without its prefix; null when it does not
 * exist or its real path is outside the real root, so a crafted results file cannot embed an arbitrary file.
 * Returns { abs, tried }.
 */
function resolveUnder(root, p) {
  if (typeof p !== "string" || p === "-" || p === "") return { abs: null, tried: String(p) };
  const rel = p.startsWith("abs:") ? p.slice(4) : p;
  const tried = path.resolve(root, rel);
  let realRoot, real;
  try { realRoot = fs.realpathSync(root); real = fs.realpathSync(tried); } catch { return { abs: null, tried, why: "not found" }; }
  const below = path.relative(realRoot, real);
  if (below === "" || below === ".." || below.startsWith(`..${path.sep}`) || path.isAbsolute(below)) return { abs: null, tried, why: "outside --images-root after symlinks" };
  return { abs: real, tried };
}

/** The real path of `p`, or of its nearest existing folder plus the rest (the report folder may not exist yet). */
function realish(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch {
    const up = path.dirname(abs);
    return up === abs ? abs : path.join(realish(up), path.basename(abs));
  }
}

/** D8: a relative URL, each segment percent-encoded, so no scheme can ever appear. */
function linkUrl(abs, reportDir) {
  return path.relative(reportDir, abs).split(path.sep).map((s) => (s === ".." ? ".." : encodeURIComponent(s))).join("/");
}

/** Embedded JSON escapes <, >, &, U+2028 and U+2029, so no text closes the script block or breaks a parser. */
function embedJSON(obj) {
  return JSON.stringify(obj).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const htmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The inline script: overlay.js (one source for Node and the page, D13) and the renderer. */
function pageScript() {
  return `(function () {\n"use strict";\nvar overlay = (function () { var module = { exports: {} };\n${OVERLAY_SRC}\nreturn module.exports; })();\n${PAGE_JS}\n})();\n`;
}

/** D17: the CSP per mode, with the hash of the one inline script. */
function csp(script, mode) {
  const hash = crypto.createHash("sha256").update(script, "utf8").digest("base64");
  const img = mode === "link" ? "img-src data: 'self' file:" : "img-src data:";
  return `default-src 'none'; ${img}; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'`;
}

/** The page data: everything the script renders. `images` maps a key to { width, height, blob | url | null }. */
function pageData(file, images, blobs) {
  const items = [];
  const sized = usesSizes(file);
  const of = baselineCellOf(file);
  file.results.forEach((e, i) => {
    if (isMissing(e)) return;
    const video = e.command === "video";
    const text = [e.path, ...(e.lines || []).map((l) => l.text), ...(e.checks || []).flatMap((c) => [c.text, c.line, c.closest && c.closest.line]),
      ...(e.findings || []).flatMap((f) => [f.line, f.key, f.base, f.expected, f.token])].filter((x) => typeof x === "string").join("\n");
    const kinds = [...new Set([...(e.findings || []).map((f) => f.kind), ...(e.checks || []).filter((c) => c.verdict === "fail").map((c) => c.kind)])].sort(byCodePoint);
    // TODO-077: the rank orders the contact sheet; severities and certainties feed the filters (gating items only).
    const gating = [...(e.checks || []).filter((c) => c.verdict === "fail"), ...(e.findings || [])].filter((x) => x.gate !== false && x.severity !== undefined);
    const item = { i, path: e.path, command: e.command, device: e.device ?? null, text_size: sized ? sizeOf(e.text_size) : null, locale: e.locale, screen: e.screen, verdict: e.verdict, video, kinds, count: failures(e), text, image: images[`r${i}`] || null,
      known: (e.findings || []).filter((f) => f.known === true).length, rank: scale.envKey(e), severities: [...new Set(gating.map((x) => x.severity))], certainties: [...new Set(gating.map((x) => x.certainty))] };
    if (of) { item.change = of[i]; item.review = of[i] === null ? true : file.baseline.cells[of[i]].review; }
    if (video) {
      const tl = videoTimeline(e);
      item.timeline = { duration: tl.duration, marks: tl.marks, frames: tl.times.map((t) => ({ t, image: images[`r${i}@${t}`] || null })) };
    }
    items.push(item);
  });
  const m = matrix(file);
  // TODO-076: the contact sheet's `large text` filter shows the inputs of the cells with that badge.
  const itemAt = new Map(items.map((it) => [it.i, it]));
  for (const c of m.cells || []) if (c.badges && c.badges.includes("large text")) for (const i of c.items) if (itemAt.has(i)) itemAt.get(i).large_text = true;
  return {
    run: file.run,
    totals: file.totals,
    inputs: file.results.filter((e) => !isMissing(e)).length,
    checks: file.results.reduce((n, e) => n + (e.checks || []).length, 0),
    matrix: m,
    baseline: file.baseline ? { ...file.baseline, summary: baseline.summaryLine(file.baseline) } : null,
    items,
    results: file.results,
    blobs,
    styles: overlay.STYLES,
  };
}

/**
 * D9 for a results file catscan did not write: the paths, command lines and diagnostics that still name the home
 * folder show it as `~`, so a hand-made or older file cannot put a user name in the page. Recognized text, checks
 * and findings are evidence and stay as read (spec 27 D9). A file catscan wrote has no such string.
 */
function privateFile(file) {
  const home = os.homedir();
  if (!home || home === path.sep) return file;
  const re = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[/\\s\"'),;:])", "g");
  const fix = (v) => (typeof v === "string" ? v.replace(re, "~") : v);
  const argv = (a) => (Array.isArray(a) ? a.map(fix) : a);
  const diag = (d) => (d && typeof d === "object" ? { ...d, message: fix(d.message), ...(d.hint !== undefined ? { hint: fix(d.hint) } : {}) } : d);
  const cat = (x) => {
    if (!x || typeof x !== "object") return x;
    const out = typeof x.catalog === "string" ? { ...x, catalog: fix(x.catalog) } : x;
    return typeof x.expected_path === "string" ? { ...out, expected_path: fix(x.expected_path) } : out;
  };
  const b = file.baseline;
  const inputs = (xs) => xs.map((x) => ({ ...x, path: fix(x.path), baseline_path: fix(x.baseline_path) }));
  return {
    ...file,
    ...(b ? { baseline: { ...b, file: fix(b.file), cells: b.cells.map((c) => ({ ...c, inputs: inputs(c.inputs) })) } } : {}),
    run: { ...file.run, argv: argv(file.run.argv), shards: (file.run.shards || []).map((sh) => ({ ...sh, argv: argv(sh.argv) })) },
    results: file.results.map((e) => ({
      ...e, path: fix(e.path), warnings: (e.warnings || []).map(diag), ...(e.error ? { error: diag(e.error) } : {}),
      ...(Array.isArray(e.checks) ? { checks: e.checks.map(cat) } : {}), ...(Array.isArray(e.findings) ? { findings: e.findings.map(cat) } : {}),
    })),
  };
}

/** The whole file as a string. Deterministic for a given input (the golden snapshot relies on it). */
function html(file, { images = {}, blobs = [], mode = "embed" } = {}) {
  const script = pageScript();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${htmlEscape(csp(script, mode))}">
<meta name="generator" content="catscan ${htmlEscape(file.run.catscan)}">
<title>catscan report</title>
<style>
${PAGE_CSS}</style>
</head>
<body>
<noscript>This report needs JavaScript to render. The raw results are in the catscan-data block of this file.</noscript>
<div id="app"></div>
<script type="application/json" id="catscan-data">${embedJSON(pageData(privateFile(file), images, blobs))}</script>
<script>${script}</script>
</body>
</html>
`;
}

/**
 * Builds the page. opts: { locate(entry, i) -> { abs, tried }, request(req) -> Promise<response>, mode, maxEdge,
 * reportPath, root }. Returns { html, images, warnings }: `images` counts embedded and linked images; `warnings` holds
 * report-image-missing (D26: at most 10 lines, then one summary) and report-images-unavailable (D27).
 */
async function build(file, opts) {
  const mode = opts.mode || "embed";
  const maxEdge = opts.maxEdge || DEFAULT_MAX_EDGE;
  const reportDir = path.dirname(path.resolve(opts.reportPath));
  const root = opts.root;
  const rootReal = realish(root);
  const dirReal = realish(reportDir);
  const inside = (p) => { const r = path.relative(rootReal, p); return r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
  const dirInRoot = inside(dirReal);
  const images = {};
  const blobs = [];
  const notFound = [];
  const jobs = new Map(); // "path\0t" -> { req, keys: [{key, size}] } (D18: one request per distinct path)
  file.results.forEach((e, i) => {
    if (isMissing(e)) return; // D21: no image, no thumbnail
    const video = e.command === "video";
    const size = e.image || e.video || DEFAULT_SIZE;
    const loc = opts.locate(e, i);
    const times = video ? videoTimeline(e).times : [null];
    const keys = video ? times.map((t) => `r${i}@${t}`) : [`r${i}`];
    if (!loc.abs) {
      notFound.push({ tried: loc.tried, why: loc.why || "not found" });
      keys.forEach((k) => { images[k] = { width: size.width, height: size.height, blob: null, url: null }; });
      return;
    }
    // D8: only images browsers show, never an abs: path or a frame; and only inside the root, so a link never
    // spells a folder outside it (spec 27 D9).
    if (mode === "link" && !video && LINKABLE.has(path.extname(loc.abs).toLowerCase()) && !String(e.path).startsWith("abs:") && dirInRoot && inside(loc.abs)) {
      images[`r${i}`] = { width: size.width, height: size.height, blob: null, url: linkUrl(loc.abs, dirReal) };
      return;
    }
    times.forEach((t, j) => {
      const k = `${loc.abs}\0${t}`;
      if (!jobs.has(k)) jobs.set(k, { req: { command: "thumbnail", path: loc.abs, max_edge: maxEdge, quality: QUALITY, ...(t === null ? {} : { t }) }, keys: [] });
      jobs.get(k).keys.push({ key: keys[j], size, tried: loc.tried });
    });
  });
  let n = 0;
  const list = [...jobs.values()];
  let unavailable = null;
  // A small window of requests in flight, so a large run never queues every reply in memory at once.
  const replies = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const idx = next++;
      replies[idx] = await opts.request({ id: `thumb-${idx}`, ...list[idx].req }).catch((err) => ({ binary: true, error: { code: err.code || "binary-failed", message: err.message } }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, list.length) }, worker));
  // D27: every thumbnail failed on the core binary (spawn, exit, protocol), not on a file: one warning naming
  // `catscan doctor` instead of per-image lines pointing at --images-root. Partial failures stay per image.
  if (list.length && replies.every((r) => r && (r.binary || (r.error && r.error.code === "binary-failed")))) unavailable = replies[0].error;
  list.forEach((j, idx) => {
    const r = replies[idx];
    if (r && typeof r.jpeg === "string") {
      blobs.push(`data:image/jpeg;base64,${r.jpeg}`);
      for (const k of j.keys) images[k.key] = { width: r.width, height: r.height, blob: blobs.length - 1, url: null };
      n += j.keys.length;
    } else {
      if (!unavailable) notFound.push({ tried: j.keys[0].tried, why: (r && r.error && r.error.code) || "no thumbnail" });
      for (const k of j.keys) images[k.key] = { width: k.size.width, height: k.size.height, blob: null, url: null };
    }
  });
  n += Object.values(images).filter((v) => v.url).length;
  const warnings = notFound.slice(0, MISSING_LINES).map((p) => ({ code: "report-image-missing", message: `${p.tried}: ${p.why}; the report shows a placeholder`, hint: `catscan report <results.json> --images-root <the folder the screenshots are under>` }));
  if (notFound.length > MISSING_LINES) {
    warnings.push({ code: "report-image-missing", message: `${notFound.length - MISSING_LINES} more images were not found under ${root} or point outside it`, hint: "pass --images-root with the folder the results paths are relative to" });
  }
  if (unavailable) warnings.push({ code: "report-images-unavailable", message: `catscan-core could not make any thumbnail (${unavailable.message || unavailable.code}); the report shows placeholders`, hint: "catscan doctor" });
  return { html: html(file, { images, blobs, mode }), images: n, warnings };
}

/** D12: the warning over the size limit; null under it. `limit` is injectable for the test. */
function largeWarning(bytes, limit = LARGE) {
  if (bytes <= limit) return null;
  return { code: "report-large", message: `the report is ${(bytes / 1048576).toFixed(1)} MB, over ${Math.round(limit / 1048576)} MB`, hint: "use --report-images link, or a smaller --report-max-edge such as 600" };
}

/** D24: the stderr line for a written report. */
function summaryLine(file, bytes, images) {
  return `catscan: report: ${file} (${(bytes / 1048576).toFixed(1)} MB, ${images} images)`;
}

module.exports = { build, html, matrix, coverageLine, videoTimeline, resolveUnder, linkUrl, embedJSON, csp, pageScript, largeWarning, summaryLine, isMissing, LARGE, DEFAULT_MAX_EDGE, QUALITY };
