// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-035 runner for bench/overlap-signals.js: reads every screen once, re-reads split candidates once (at the
// lowest k of the grid), then scores every threshold from those reads. Thresholds are picked on the dev half only.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const O = require("../overlap");
const STRINGS = require("../untranslated/strings.json");
const R = require("../overlap-real");
const S = require("../overlap-signals");
const { versionInfo } = require("../../packages/core-js/src/client");

const ROOT = path.resolve(__dirname, "../..");
const GRID = {
  cover: [0.4, 0.5, 0.6, 0.7], // catalog: the smaller share of A and of B in the joint alignment
  explained: [0.6, 0.7, 0.8, 0.9], // catalog: the share of the read text A and B explain
  k: [1.3, 1.4, 1.5, 1.6, 1.8], // split: aspect over k x the screen median
  maxSame: [0.4, 0.5, 0.6], // split: the two parts must be less alike than this
};
const PICK = { precision: 0.95, negativesFlagged: 0 }; // dev: the highest recall that keeps both

const sha = (s) => require("crypto").createHash("sha256").update(s).digest("hex");
const r4 = (x) => (x === null ? null : Number(x.toFixed(4)));
const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

function compileCrop() {
  const bin = path.join(os.tmpdir(), `catscan-crop-${process.pid}`);
  execFileSync("swiftc", ["-O", path.join(__dirname, "crop.swift"), "-o", bin]);
  return bin;
}

/**
 * Candidates of one screen, before thresholds: catalog against the screen's own strings, catalog against every string
 * of the locale (D1: a real `--catalog` is app-wide), and split (with its ratio).
 */
function candidates(env, expected, locale, appCatalog) {
  return {
    catalog: expected ? S.catalogCandidates(env.lines || [], expected) : [],
    catalogApp: appCatalog ? S.catalogCandidates(env.lines || [], appCatalog) : [],
    split: S.splitCandidates(env, { k: Math.min(...GRID.k) }).map((c) => ({ ...c, env, locale })),
  };
}

/** candidates() with the catalog time in ms (D2, D8). */
function timed(env, expected, locale, appCatalog) {
  const t0 = process.hrtime.bigint();
  const c = candidates(env, expected, locale, appCatalog);
  c.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return c;
}

const meets = (p, q) => Math.min(p[0] + p[2], q[0] + q[2]) > Math.max(p[0], q[0]) && Math.min(p[1] + p[3], q[1] + q[3]) > Math.max(p[1], q[1]);

/**
 * Findings of one screen at one setting, one per merged line (D6): boxes first, then split, then catalog; a later
 * finding whose box meets a kept one is the same overlap. `parts` maps a split candidate to its re-read [top, bottom].
 */
function findings(c, parts, set, boxes = []) {
  const extra = [];
  if (set.k != null) for (const x of c.split) {
    if (x.ratio <= set.k) continue;
    const [t, b] = parts.get(x) || [[], []];
    if (S.splitConfirms(t, b, { maxSame: set.maxSame })) extra.push(S.finding(x.line, "split"));
  }
  if (set.cover != null) for (const x of set.app ? c.catalogApp : c.catalog) if (x.cover >= set.cover && x.explained >= set.explained) extra.push(S.finding(x.line, "catalog", { pair: [x.a, x.b] }));
  const out = [...boxes];
  for (const f of extra) if (!out.some((g) => meets(g.box, f.box))) out.push(f);
  return out;
}

function rereadAll(all, dir, crop) {
  const list = all.flatMap((c) => c.split);
  const got = S.reread(list, dir, crop);
  return { parts: new Map(list.map((c, i) => [c, got.parts.get(i)])), stats: { crops: got.crops, failed_crops: got.failed_crops, missing_reads: got.missing_reads, ms: got.ms } };
}

/** D8: extra Vision reads and ms per screen; ms is the re-read wall time shared out per crop. */
function cost(cands, set, stats) {
  const calls = cands.map((c) => 2 * c.split.filter((x) => set.k != null && x.ratio > set.k).length);
  const perCrop = stats.crops ? stats.ms / stats.crops : 0;
  const ms = calls.map((n) => Math.round(n * perCrop));
  return { reads: { median: pct(calls, 0.5), p95: pct(calls, 0.95), max: Math.max(0, ...calls) }, ms: { median: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(0, ...ms) },
    catalog_ms: { median: pct(cands.map((c) => c.ms), 0.5), p95: pct(cands.map((c) => c.ms), 0.95), max: Math.max(0, ...cands.map((c) => c.ms)) }, reread: stats };
}

/** D7: a signal that misses recall 0.80 is a candidate with >= 3x boxes-only recall and a Wilson lower bound above its upper bound. */
function candidateVerdict(v, base) {
  if (!v || !base || v.recall === null) return null;
  const lo = R.wilson(v.found, v.positives)[0], hi = R.wilson(base.found, base.positives)[1];
  return { recall_x: base.recall ? r4(v.recall / base.recall) : null, wilson_lo: lo, boxes_wilson_hi: hi, precision_ok: v.precision !== null && v.precision >= O.GATE.precision,
    candidate: v.precision !== null && v.precision >= O.GATE.precision && v.recall >= 3 * base.recall && lo > hi };
}

/** Hits and false alarms per signal (D6). */
function perSignal(rows) {
  const out = {};
  for (const r of rows) for (const f of r.findings) {
    const s = (out[f.signal] = out[f.signal] || { tp: 0, fp: 0 });
    if (r.item.amount === 2) continue;
    (r.item.amount >= O.GATE.minAmount && O.matches(f, r.truth) ? s.tp++ : s.fp++);
  }
  return out;
}

function synthetic(dir, crop, work) {
  const items = O.plan();
  const report = O.draw(items, dir);
  const reads = O.rowsFor(items, report, dir, "read", []);
  const boxesBy = new Map(O.rowsFor(items, report, dir, "overlap", []).map((r) => [r.item.name, r.findings]));
  for (const r of reads) {
    r.boxes = boxesBy.get(r.item.name) || [];
    r.cand = timed(r.env, [r.item.a, r.item.b, ...r.item.distractors], r.item.locale, STRINGS.locales[r.item.locale]);
  }
  const { parts, stats } = rereadAll(reads.map((r) => r.cand), path.join(work, "synth"), crop);
  const rowsAt = (rows, set, withBoxes) => rows.map((r) => ({ item: r.item, truth: r.truth, findings: findings(r.cand, parts, set, withBoxes ? r.boxes : []) }));
  const scoreAt = (rows, set, withBoxes) => { const x = rowsAt(rows, set, withBoxes); return { ...O.score(x), per_signal: perSignal(x) }; };
  const dev = reads.filter((r) => r.item.dev), held = reads.filter((r) => !r.item.dev);
  const sweep = { catalog: [], catalog_app: [], split: [] };
  for (const c of GRID.cover) for (const e of GRID.explained) {
    sweep.catalog.push({ cover: c, explained: e, ...pick(scoreAt(dev, { cover: c, explained: e }, false)) });
    sweep.catalog_app.push({ cover: c, explained: e, ...pick(scoreAt(dev, { cover: c, explained: e, app: true }, false)) });
  }
  for (const k of GRID.k) for (const m of GRID.maxSame) sweep.split.push({ k, maxSame: m, ...pick(scoreAt(dev, { k, maxSame: m }, false)) });
  const best = (rows) => rows.filter((s) => s.precision !== null && s.precision >= PICK.precision && s.negative_images_flagged <= PICK.negativesFlagged)
    .sort((a, b) => b.recall - a.recall)[0] || null;
  const chosen = { catalog: best(sweep.catalog), catalog_app: best(sweep.catalog_app), split: best(sweep.split) };
  const set = { cover: chosen.catalog?.cover ?? null, explained: chosen.catalog?.explained ?? null, k: chosen.split?.k ?? null, maxSame: chosen.split?.maxSame ?? null,
    appCover: chosen.catalog_app?.cover ?? null, appExplained: chosen.catalog_app?.explained ?? null };
  const only = (s) => (s === "catalog_app" ? { cover: set.appCover, explained: set.appExplained, app: true, k: null }
    : { ...set, cover: s === "catalog" ? set.cover : null, k: s === "split" ? set.k : null });
  const heldOut = {
    boxes: pick(O.score(held.map((r) => ({ item: r.item, truth: r.truth, findings: r.boxes })))),
    catalog: set.cover != null ? pick(scoreAt(held, only("catalog"), false)) : null,
    split: set.k != null ? pick(scoreAt(held, only("split"), false)) : null,
    catalog_app: set.appCover != null ? pick(scoreAt(held, only("catalog_app"), false)) : null,
    boxes_catalog: set.cover != null ? pick(scoreAt(held, only("catalog"), true)) : null,
    boxes_split: set.k != null ? pick(scoreAt(held, only("split"), true)) : null,
    all: pick(scoreAt(held, set, true)),
    all_app: set.appCover != null ? pick(scoreAt(held, { ...set, cover: set.appCover, explained: set.appExplained, app: true }, true)) : null, // no app-wide pick: no variant
  };
  const candidates_d7 = Object.fromEntries(Object.entries(heldOut).filter(([k]) => k !== "boxes").map(([k, v]) => [k, candidateVerdict(v, heldOut.boxes)]));
  const plan = JSON.stringify(items);
  return { images: reads.length, plan_sha256: sha(plan), sweep, chosen: set, held_out: heldOut, candidate_d7: candidates_d7, cost: cost(reads.map((r) => r.cand), set, stats) };
}

function pick(s) {
  const found = s.recall === null ? 0 : Math.round(s.recall * s.positives);
  return { precision: s.precision, recall: s.recall, found, recall_wilson95: R.wilson(found, s.positives), tp: s.tp, fp: s.fp, per_signal: s.per_signal, positives: s.positives, negatives: s.negatives,
    negative_images_flagged: s.negative_images_flagged, gate_pass: s.gate_pass,
    per_amount: Object.fromEntries(Object.entries(s.per_amount).map(([k, v]) => [k, { found: v.found, false_alarms: v.false_alarms, images: v.images }])),
    per_size_4px_up: Object.fromEntries(Object.entries(s.per_size_4px_up).map(([k, v]) => [k, v.rate])), per_layout_4px_up: Object.fromEntries(Object.entries(s.per_layout_4px_up).map(([k, v]) => [k, v.rate])) };
}

/** Every string of a game's locale at the captured build's commit (read-only `git show`), flattened. */
function gameCatalog(repo, app, commit, locale) {
  if (!/^[0-9a-f]{7,40}$/.test(commit || "")) return null; // a manifest value is never a git option
  if (!repo) return null;
  try {
    const raw = execFileSync("git", ["-C", repo, "show", `${commit}:apps/${app}/src/i18n/${locale}.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const flat = (o) => (typeof o === "string" ? [o] : o && typeof o === "object" ? Object.values(o).flatMap(flat) : []);
    return flat(JSON.parse(raw));
  } catch { return null; }
}

function real(gamesRoot, studyDirs, set, crop, work, gameRepo) {
  const screens = [], catalogs = {}, manifests = {}, commits = {};
  if (gamesRoot) for (const app of fs.readdirSync(gamesRoot).filter((d) => fs.existsSync(path.join(gamesRoot, d, "manifest.json")))) {
    const mtext = fs.readFileSync(path.join(gamesRoot, app, "manifest.json"), "utf8");
    const manifest = JSON.parse(mtext);
    manifests[app] = sha(mtext);
    commits[app] = manifest.game_commit ?? null; // D9: the build whose locale file the app-wide arm read
    for (const locale of fs.readdirSync(path.join(gamesRoot, app)).filter((d) => fs.statSync(path.join(gamesRoot, app, d)).isDirectory())) {
      const dir = path.join(gamesRoot, app, locale);
      const appCatalog = gameCatalog(gameRepo, app, manifest.game_commit, locale);
      catalogs[`${app}/${locale}`] = appCatalog ? appCatalog.length : null;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(dir, f));
      const boxesBy = new Map(O.run("overlap", files, locale).map((e) => [e.path, e.findings || []]));
      for (const env of O.run("read", files, locale)) {
        const side = JSON.parse(fs.readFileSync(env.path.replace(/\.png$/, ".json"), "utf8"));
        screens.push({ set: `${app}`, root: path.join(gamesRoot, app), env, truth: R.truth(side), boxes: boxesBy.get(env.path) || [], cand: timed(env, side.texts_px.map((t) => t.text), locale, appCatalog) });
      }
    }
  }
  for (const dir of studyDirs) {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(png|jpe?g|heic)$/i.test(e.name)) files.push(f);
    } };
    walk(dir);
    manifests[path.basename(dir)] = sha(files.map((f) => `${path.relative(dir, f)} ${fs.statSync(f).size}`).join("\n")); // no manifest file: paths and sizes
    const boxesBy = new Map(O.run("overlap", files, null).map((e) => [e.path, e.findings || []]));
    for (const env of O.run("read", files, null)) screens.push({ set: path.basename(dir), root: dir, env, truth: { kind: "negative", pairs: [] }, boxes: boxesBy.get(env.path) || [], cand: timed(env, null, null) });
  }
  const { parts, stats } = rereadAll(screens.map((s) => s.cand), path.join(work, "real"), crop);
  const only = (s) => (s === "catalog_app" ? { cover: set.appCover, explained: set.appExplained, app: true, k: null }
    : { ...set, cover: s === "catalog" ? set.cover : null, k: s === "split" ? set.k : null });
  const variants = { boxes: null, catalog: only("catalog"), catalog_app: only("catalog_app"), split: only("split"), boxes_catalog: only("catalog"), boxes_split: only("split"), all: set,
    all_app: set.appCover != null ? { ...set, cover: set.appCover, explained: set.appExplained, app: true } : { cover: null, k: null } };
  const out = {};
  for (const [name, v] of Object.entries(variants)) {
    if (v && v.cover == null && v.k == null) { out[name] = null; continue; }
    const withBoxes = name.startsWith("boxes") || name.startsWith("all");
    const neg = {}, pos = { positives: 0, found: 0, other_flags: 0 }, axis = {}, flagged = [];
    for (const s of screens) {
      if (s.truth.kind === "excluded") continue;
      const f = v ? findings(s.cand, parts, v, withBoxes ? s.boxes : []) : s.boxes;
      const { width: w, height: h } = s.env.image;
      if (s.truth.kind === "negative") {
        neg[s.set] = neg[s.set] || { screens: 0, flags: 0 };
        neg[s.set].screens++; neg[s.set].flags += f.length;
        if (f.length && name === "all") flagged.push({ path: `${s.set}/${path.relative(s.root, s.env.path)}`, flags: f.map((x) => x.signal) });
      } else {
        pos.positives++;
        const hit = f.some((x) => s.truth.pairs.some((p) => R.names(x, p, w, h)));
        if (hit) pos.found++;
        // D4: a flag on a positive screen that does not name the moved pair is a false alarm too.
        pos.other_flags += f.filter((x) => !s.truth.pairs.some((p) => R.names(x, p, w, h))).length;
        const a = (axis[s.truth.axis] = axis[s.truth.axis] || { images: 0, found: 0 });
        a.images++; a.found += hit ? 1 : 0;
      }
    }
    const screensN = Object.values(neg).reduce((n, x) => n + x.screens, 0), flags = Object.values(neg).reduce((n, x) => n + x.flags, 0);
    for (const x of Object.values(neg)) x.per_100 = r4(100 * x.flags / x.screens);
    for (const x of Object.values(axis)) { x.recall = r4(x.found / x.images); x.wilson95 = R.wilson(x.found, x.images); }
    const flaggedScreens = screens.filter((s) => s.truth.kind === "negative" && (v ? findings(s.cand, parts, v, withBoxes ? s.boxes : []) : s.boxes).length).length;
    out[name] = { game_recall: pos.positives ? r4(pos.found / pos.positives) : null, game_found: pos.found, game_positives: pos.positives, game_recall_wilson95: R.wilson(pos.found, pos.positives), game_by_axis: axis,
      other_flags_on_positives: pos.other_flags, negatives: neg, negative_screens: screensN, flags, flags_per_100: screensN ? r4(100 * flags / screensN) : null,
      flagged_screens: flaggedScreens, flagged_screens_wilson95: R.wilson(flaggedScreens, screensN), ...(name.startsWith("all") ? { flagged } : {}) };
  }
  return { screens: screens.length, game_commits: commits, app_catalog_strings: catalogs, manifests_sha256: manifests, variants: out, cost: cost(screens.map((s) => s.cand), set, stats),
    note: "catalog runs only where a catalog exists (game screens: the sidecar texts); study flags are unreviewed and count as false alarms" };
}

function main(argv) {
  const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
  const one = (k) => all(k)[0] ?? null;
  const synthDir = path.resolve(one("--synth") || path.join(ROOT, "datasets/overlap-synth"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-signals-"));
  let crop = null;
  try { // crops of private screens never outlive the run, even when it throws
    crop = compileCrop();
    const syn = synthetic(synthDir, crop, work);
    const re = one("--games") || all("--study").length ? real(one("--games"), all("--study"), syn.chosen, crop, work, one("--game-repo")) : null;
    const v = versionInfo();
    const result = {
      todo: "035", spec: "12", script: "bench/overlap-signals.js", grid: GRID, pick: PICK, gate: O.GATE,
      synthetic: syn, real: re,
      catscan: v.catscan, chip: v.host.chip, macos: v.macos, macos_build: v.macos_build, vision_revision: v.vision_revision,
      node: process.version, date: new Date().toISOString().slice(0, 10),
      swiftc: execFileSync("swiftc", ["--version"], { encoding: "utf8" }).split("\n")[0],
    };
    process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    if (crop) fs.rmSync(crop, { force: true });
  }
}

module.exports = { main, findings, candidates, candidateVerdict, perSignal, GRID, PICK };
