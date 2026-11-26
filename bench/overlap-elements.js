#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-046 measurement: `catscan overlap --boxes` (the elements reader) per pair type (D6).
// - Synthetic DOM set (bench/overlap/elements-generate.mjs, Playwright Chromium): 12 locales x 4 layouts x 6 amounts x
//   3 sizes from bench/untranslated/strings.json, fixed seed; even images are the dev half, odd ones are held out.
// - Game set: spec 12's captures (datasets/overlap-games), their text rects converted to boxes
//   (bench/overlap/games-to-boxes.mjs); recall on the forced positives, flags on the natural negatives.
// - TODO-049 (appended after the TODO-046 items, same seed, so those stay byte-identical; D7): a label running into a
//   control (switch, checkbox, slider, field, select), and a label cut off by an opaque fixed panel (footer, toast,
//   sheet) by the same amounts or fully hidden, plus negatives drawn above the panel or inside a scroll container.
// - Real native negatives: the truncation gate screens that have sidecars; every flag is reviewed by hand
//   (`--reviewed <file>`: {"<path>": {"<line>": "real" | "false-alarm"}}).
// Usage:
//   node bench/overlap-elements.js [--keep <dir>] [--games <dir>] [--native <dir>]... [--reviewed <file>] > results/overlap-elements.json
//   node bench/overlap-elements.js --dev [--keep <dir>]   the dev half only (stdout table, for tuning)
//   node bench/overlap-elements.js --manifest [--keep <dir>] [--games <dir>] [--native <dir>]... > bench/overlap/elements-manifest.json
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { rng, wilson } = require("./overlap/elements-lib");
const { withoutStacked } = require("./overlap");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const S = require("./untranslated/strings.json");
const LOCALES = Object.keys(S.locales).filter((l) => l !== "en");
const LAYOUTS = ["vv", "row", "icon", "image"]; // vv, row: text-text; icon, image: text-graphic
const AMOUNTS = [-4, 0, 2, 4, 8, 16]; // CSS px of ink overlap; -4 is a 4 px gap, 0 touching
const SIZES = [13, 17, 24];
const PADS = [0, 4, 8, 12];
const GATE = { precision: 0.90, recall: 0.80, minPx: 4, falseAlarmsPer100: 2, gameRecall: 0.80 };
const SEED = 46;
const CONTROLS = ["switch", "checkbox", "slider", "field", "select"]; // TODO-049 D13: measured per kind
const SHIPPED_CONTROLS = ["field", "slider"]; // TODO-049 D13: the kinds that passed, in the converter tables
const PANELS = ["footer", "toast", "sheet"]; // TODO-049 D6
const TYPE = { vv: "text-text", row: "text-text", icon: "text-graphic", image: "text-graphic", panel: "occlusion",
  ...Object.fromEntries(CONTROLS.map((c) => [c, "text-control"])) };
const TYPES = ["text-text", "text-graphic", "text-control", "occlusion"];
// The TODO-046 types are scored on their own layouts only, so their rows equal v0.32.0's (TODO-049 D7).
const POOL = { "text-text": ["vv", "row", "icon", "image"], "text-graphic": ["vv", "row", "icon", "image"], "text-control": CONTROLS, occlusion: ["panel"] };

/** The plan: one item per image, in a fixed order; `dev` is the even half. */
function plan(seed = SEED) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const items = [];
  for (const locale of LOCALES) {
    const strings = S.locales[locale];
    const short = [...strings].sort((a, b) => [...a].length - [...b].length).slice(0, Math.ceil(strings.length / 2));
    for (const layout of LAYOUTS) for (const amount of AMOUNTS) for (const size of SIZES) {
      const pool = layout === "row" ? short : strings;
      const a = pick(pool);
      let b = pick(pool);
      while (b === a) b = pick(pool);
      const distractors = [];
      while (distractors.length < 3) { const d = pick(strings); if (![a, b, ...distractors].includes(d)) distractors.push(d); }
      const i = items.length;
      items.push({
        name: `${locale}/${String(i).padStart(4, "0")}-${layout}-${amount}-${size}.png`, locale, layout, amount, size,
        theme: i % 3 === 2 ? "dark" : "light", a, b, distractors, shift: Math.round(rand() * 20) / 100,
        padA: pick(PADS), padB: pick(PADS), padG: pick(PADS), button: rand() < 0.5, icon: pick([20, 24, 32]), axis: pick(["h", "v"]),
        dpr: pick([1, 2, 3]), dev: i % 2 === 0,
      });
    }
  }
  // TODO-049: appended with the same random stream, after every TODO-046 item.
  const extra = (o) => {
    const strings = S.locales[o.locale];
    const a = pick(strings);
    const distractors = [];
    while (distractors.length < 3) { const d = pick(strings); if (![a, ...distractors].includes(d)) distractors.push(d); }
    const i = items.length;
    items.push({
      name: `${o.locale}/${String(i).padStart(4, "0")}-${o.layout}${o.panel ? `-${o.panel}-${o.variant}` : ""}-${o.amount}-${o.size}.png`, ...o,
      theme: i % 3 === 2 ? "dark" : "light", a, b: "", distractors, shift: 0, padA: pick(PADS), padB: 0, padG: 0, button: false, icon: 24,
      axis: o.axis ?? pick(["h", "v"]), dpr: pick([1, 2, 3]), dev: i % 2 === 0,
    });
  };
  for (const locale of LOCALES) {
    for (const layout of CONTROLS) for (const amount of AMOUNTS) extra({ locale, layout, amount, size: pick(SIZES) });
    for (const panel of PANELS) {
      for (const amount of [...AMOUNTS, "full"]) extra({ locale, layout: "panel", panel, variant: "cut", amount, size: pick(SIZES), axis: panel === "toast" ? "h" : "v" });
      for (const variant of ["top", "scroll"]) for (const amount of [8, 16]) extra({ locale, layout: "panel", panel, variant, amount, size: pick(SIZES), axis: panel === "toast" ? "h" : "v" });
    }
  }
  return items;
}

const area = (r) => Math.max(0, r[2]) * Math.max(0, r[3]);
const inter = (p, q) => area([Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.min(p[0] + p[2], q[0] + q[2]) - Math.max(p[0], q[0]), Math.min(p[1] + p[3], q[1] + q[3]) - Math.max(p[1], q[1])]);

/** D2: the pair's element boxes, one 90% or more inside the other, is nesting (reported, not gated). */
function contained(boxesFile, ids) {
  const els = JSON.parse(fs.readFileSync(boxesFile, "utf8")).elements;
  const [p, q] = ids.map((id) => els.find((e) => e.id === id));
  if (!p || !q) return null;
  return inter(p.box, q.box) / Math.min(area(p.box), area(q.box)) >= 0.9;
}

const ftype = (f) => (f.kind === "occluded" ? "occlusion" : f.a.text !== null && f.b.text !== null ? "text-text" : "text-graphic");
/** The pair type a finding scores under on a synthetic row: a text-graphic finding on a control row is text-control. */
const rtype = (f, r) => (ftype(f) === "text-graphic" && TYPE[r.item.layout] === "text-control" ? "text-control" : ftype(f));
const names = (f, ids) => {
  const got = [f.a.element?.id ?? null, f.b.element?.id ?? null];
  return (got[0] === ids[0] && got[1] === ids[1]) || (got[0] === ids[1] && got[1] === ids[0]);
};

/** Runs `catscan overlap --boxes` on batches of 12 images; a hung batch is killed and run once more (TODO-032). */
function run(files, boxesDir, locale, extra = []) {
  const out = [];
  for (let i = 0; i < files.length; i += 12) {
    const batch = files.slice(i, i + 12);
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync(process.execPath, [CLI, "overlap", ...batch, "--boxes", boxesDir, ...(locale ? ["--locale", locale] : []), "--json", ...extra],
        { encoding: "utf8", maxBuffer: 1 << 30, timeout: 120000, killSignal: "SIGKILL" });
      // TODO-067: --experimental (the panel leg) also runs the stacked reader; this bench scores the element reader only.
      if ([0, 1].includes(r.status)) { out.push(...r.stdout.split("\n").filter(Boolean).map((l) => withoutStacked(JSON.parse(l)))); break; }
      spawnSync("pkill", ["-f", path.join(ROOT, "core/.build")]);
      if (attempt === 2) throw new Error(`catscan overlap ${locale}: exit ${r.status ?? r.signal}: ${r.stderr}`);
      process.stderr.write(`catscan overlap ${locale}: batch ${i / 12} ${r.signal ? "timed out" : `exit ${r.status}`}, retrying\n`);
    }
  }
  return out;
}

function draw(items, dir) {
  const planFile = path.join(dir, "plan.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(planFile, JSON.stringify(items));
  return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "overlap/elements-generate.mjs"), planFile, dir], { encoding: "utf8", maxBuffer: 1 << 30 }));
}

/** Rows for the synthetic set: [{item, truth, findings}], truth from the generator's ink rects. */
function synthRows(items, report, dir, extra = []) {
  const truthBy = new Map(report.images.map((t) => [t.name, t]));
  const rows = [];
  for (const locale of LOCALES) {
    const mine = items.filter((i) => i.locale === locale && !truthBy.get(i.name).skipped);
    if (!mine.length) continue;
    const d = path.join(dir, locale);
    // TODO-049 D6: occlusion runs only under --experimental; the other rows run as in TODO-046.
    const envs = [...run(mine.filter((i) => i.layout !== "panel").map((i) => path.join(dir, i.name)), d, locale, extra),
      ...run(mine.filter((i) => i.layout === "panel").map((i) => path.join(dir, i.name)), d, locale, [...extra, "--experimental"])];
    for (const env of envs) {
      const name = path.relative(dir, env.path);
      const item = items.find((i) => i.name === name);
      const t = truthBy.get(name);
      const min = Math.min(...t.inter);
      const ids = ["a", t.b_id];
      // TODO-049: a fully hidden label is reported, not gated (D3); a label above the panel or in a scroll container is a negative.
      const kind = item.layout === "panel" && item.variant !== "cut" ? "negative" : item.amount === "full" ? "excluded"
        : min >= GATE.minPx ? "positive" : min > 0 ? "excluded" : "negative";
      rows.push({ item, truth: t, ids, kind, contained: contained(path.join(dir, name.replace(/\.png$/, ".boxes.json")), ids), env, findings: env.findings || [] });
    }
  }
  return rows;
}

/** Spec 12's bars per pair type (D6): precision over findings on gated images, recall over partial 4 px+ positives. */
function score(rows) {
  const by = (sub, key) => {
    const g = {};
    for (const r of sub) {
      const k = String(key(r));
      g[k] = g[k] || { images: 0, found: 0 };
      g[k].images++;
      g[k].found += r.findings.some((f) => names(f, r.ids)) ? 1 : 0;
    }
    for (const v of Object.values(g)) v.recall = Number((v.found / v.images).toFixed(4));
    return g;
  };
  const out = {};
  for (const type of TYPES) {
    let tp = 0, fp = 0;
    const fps = [];
    for (const r of rows.filter((x) => x.kind !== "excluded" && POOL[type].includes(x.item.layout))) {
      for (const f of r.findings.filter((x) => rtype(x, r) === type)) {
        if (r.kind === "positive" && names(f, r.ids)) tp++;
        else { fp++; fps.push({ image: r.item.name, line: f.line, overlap: f.overlap }); }
      }
    }
    const mine = rows.filter((r) => TYPE[r.item.layout] === type);
    if (!mine.length) { out[type] = null; continue; }
    const pos = mine.filter((r) => r.kind === "positive" && r.contained === false);
    const found = pos.filter((r) => r.findings.some((f) => names(f, r.ids))).length;
    const precision = tp + fp ? Number((tp / (tp + fp)).toFixed(4)) : null;
    const recall = pos.length ? Number((found / pos.length).toFixed(4)) : null;
    out[type] = {
      images: mine.length, positives: pos.length, negatives: mine.filter((r) => r.kind === "negative").length, tp, fp, precision, recall,
      recall_wilson95: wilson(found, pos.length),
      gate_pass: precision !== null && recall !== null && precision >= GATE.precision && recall >= GATE.recall,
      contained_positives: by(mine.filter((r) => r.kind === "positive" && r.contained), () => "all").all ?? null,
      per_amount: by(mine, (r) => r.item.amount),
      per_layout_4px_up: by(pos, (r) => `${r.item.layout}${r.item.panel ? `-${r.item.panel}` : TYPE[r.item.layout] !== "text-text" ? `-${r.item.axis}` : ""}`),
      // TODO-049 D13: each control kind against the bars on its own.
      ...(type === "text-control" ? { per_kind: Object.fromEntries(CONTROLS.map((c) => {
        const rs = mine.filter((r) => r.item.layout === c && r.kind !== "excluded");
        let ktp = 0, kfp = 0;
        for (const r of rs) for (const f of r.findings.filter((x) => rtype(x, r) === type)) (r.kind === "positive" && names(f, r.ids) ? ktp++ : kfp++);
        const kpos = rs.filter((r) => r.kind === "positive" && r.contained === false), kfound = kpos.filter((r) => r.findings.some((f) => names(f, r.ids))).length;
        const kp = ktp + kfp ? Number((ktp / (ktp + kfp)).toFixed(4)) : null, kr = kpos.length ? Number((kfound / kpos.length).toFixed(4)) : null;
        return [c, { positives: kpos.length, found: kfound, tp: ktp, fp: kfp, precision: kp, recall: kr, recall_wilson95: wilson(kfound, kpos.length) }];
      })) } : {}),
      ...(type === "occlusion" ? { per_variant: by(mine.filter((r) => r.kind !== "excluded"), (r) => `${r.item.panel}-${r.item.variant}`),
        hidden_full: by(mine.filter((r) => r.item.amount === "full"), () => "all").all ?? null } : {}),
      per_size_4px_up: by(pos, (r) => r.item.size), per_dpr_4px_up: by(pos, (r) => r.item.dpr),
      negative_images_flagged: mine.filter((r) => r.kind === "negative" && r.findings.length).length,
      false_alarm_list: fps.slice(0, 40),
    };
  }
  return out;
}

/** Game set: forced pairs are positives, natural screens with no touching rects are negatives (spec 12 D11). */
function games(root, boxesRoot) {
  const out = { negatives: 0, negative_flags: 0, negative_images_flagged: [], positives: 0, found: 0, contained: 0, contained_found: 0, excluded: 0, by_k: {}, by_axis: {}, apps: {} };
  for (const app of fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "manifest.json"))).sort()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, app, "manifest.json"), "utf8"));
    const name = `game-${Object.keys(out.apps).length + 1}`; // neutral name in committed results
    out.apps[name] = { game_commit: manifest.game_commit ?? null, tools: manifest.tools ?? null };
    for (const locale of fs.readdirSync(path.join(root, app)).filter((d) => fs.statSync(path.join(root, app, d)).isDirectory()).sort()) {
      const dir = path.join(root, app, locale), bdir = path.join(boxesRoot, app, locale);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(dir, f));
      for (const env of run(files, bdir, locale)) {
        const side = JSON.parse(fs.readFileSync(env.path.replace(/\.png$/, ".json"), "utf8"));
        const fs_ = env.findings || [];
        const pairs = side.kind === "forced"
          ? side.forced.moved.flatMap((m) => side.forced.onto.map((o) => [`t${m}`, `t${o}`]))
          : (side.pairs || []).filter((p) => Math.min(p.width ?? p.w ?? 0, p.height ?? p.h ?? 0) >= GATE.minPx).map((p) => [`t${p.a}`, `t${p.b}`]);
        if (!pairs.length) {
          if ((side.pairs || []).length) { out.excluded++; continue; }
          out.negatives++;
          out.negative_flags += fs_.length;
          if (fs_.length) out.negative_images_flagged.push({ path: `${name}/${locale}/${path.basename(env.path)}`, findings: fs_.map((f) => f.line) });
          continue;
        }
        const hit = fs_.some((f) => pairs.some((p) => names(f, p)));
        const boxesFile = path.join(bdir, path.basename(env.path).replace(/\.png$/, ".boxes.json"));
        if (pairs.every((p) => contained(boxesFile, p))) { out.contained++; out.contained_found += hit ? 1 : 0; continue; }
        out.positives++;
        out.found += hit ? 1 : 0;
        const k = side.kind === "forced" ? String(side.forced.k_game_px) : "natural", axis = side.kind === "forced" ? side.forced.axis : "natural";
        for (const [key, g] of [[k, out.by_k], [axis, out.by_axis]]) {
          g[key] = g[key] || { images: 0, found: 0 };
          g[key].images++;
          g[key].found += hit ? 1 : 0;
        }
      }
    }
  }
  for (const g of [out.by_k, out.by_axis]) for (const v of Object.values(g)) { v.recall = Number((v.found / v.images).toFixed(4)); v.wilson95 = wilson(v.found, v.images); }
  out.recall = out.positives ? Number((out.found / out.positives).toFixed(4)) : null;
  out.recall_wilson95 = wilson(out.found, out.positives);
  out.contained_share = out.positives + out.contained ? Number((out.contained / (out.positives + out.contained)).toFixed(4)) : null;
  out.false_alarms_per_100 = out.negatives ? Number((100 * out.negative_flags / out.negatives).toFixed(2)) : null;
  return out;
}

/**
 * The native screens reconverted with this checkout's converters (TODO-046 D16: old sidecars have no `graphic`): a
 * mirror under `out` with each PNG linked and its dump (.maestro.json, .uia.xml, .xcui.txt) converted next to it; a
 * screen with no dump keeps its existing sidecar. Returns the mirror's root per input dir.
 */
function reconvert(dirs, out) {
  const boxes = require("../packages/core-js/src/boxes");
  const SOURCES = [[".maestro.json", "maestro"], [".uia.xml", "uiautomator"], [".xcui.txt", "xcuitest"], [".pw.json", "playwright"]];
  const roots = [];
  for (const dir of dirs) {
    const root = path.join(out, path.basename(dir));
    roots.push(root);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.png$/i.test(e.name) ? [path.join(d, e.name)] : []));
    for (const png of walk(dir)) {
      const stem = png.replace(/\.png$/i, ""), to = path.join(root, path.relative(dir, stem));
      const dump = SOURCES.find(([ext]) => fs.existsSync(stem + ext));
      let b = null;
      if (dump) b = boxes.convert(dump[1], stem + dump[0], png).boxes;
      else if (fs.existsSync(`${stem}.boxes.json`)) b = boxes.load(`${stem}.boxes.json`);
      if (!b) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.rmSync(`${to}.png`, { force: true });
      fs.symlinkSync(path.resolve(png), `${to}.png`);
      fs.writeFileSync(`${to}.boxes.json`, JSON.stringify(b));
    }
  }
  return roots;
}

/** Real native negatives: every image under `dir` with a sidecar; each flag carries its hand-review verdict. */
function native(dirs, reviewed, root) {
  const dir = root;
  const flags = [];
  let images = 0;
  for (const nd of dirs) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name)).flatMap((e) => {
      const f = path.join(d, e.name);
      return e.isDirectory() ? walk(f) : /\.png$/i.test(e.name) && fs.existsSync(f.replace(/\.png$/i, ".boxes.json")) ? [f] : [];
    });
    const byDir = new Map();
    for (const f of walk(nd)) byDir.set(path.dirname(f), [...(byDir.get(path.dirname(f)) || []), f]);
    for (const [d, files] of walk(nd).length ? byDir : []) {
      // The folder names the locale (<set>/<app>/<locale>/<screen>.png), as for the truncation gate.
      const loc = path.basename(d);
      for (const env of run(files, d, /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(loc) ? loc : null)) {
        images++;
        const rel = path.relative(dir, env.path); // the mirror path names the dataset, app and screen
        for (const f of env.findings || []) {
          const v = reviewed[rel]?.[f.line] ?? "unreviewed";
          flags.push({ path: rel, line: f.line, overlap: f.overlap, type: ftype(f), verdict: v });
        }
      }
    }
  }
  const fa = flags.filter((f) => f.verdict !== "real");
  return { images, flags: flags.length, unreviewed: flags.filter((f) => f.verdict === "unreviewed").length, real_overlaps: flags.length - fa.length,
    false_alarms: fa.length, false_alarms_per_100: images ? Number((100 * fa.length / images).toFixed(2)) : null, list: flags };
}

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
  const dir = opt("--keep") || fs.mkdtempSync(path.join(os.tmpdir(), "catscan-overlap-elements-"));
  const items = plan();
  if (argv.includes("--dev")) {
    const dev = items.filter((i) => i.dev);
    const report = fs.existsSync(path.join(dir, "report.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")) : draw(items, dir);
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report));
    const extra = opt("--min-overlap") ? ["--min-overlap", opt("--min-overlap")] : [];
    const rows = synthRows(dev, report, dir, extra);
    if (opt("--rows")) fs.writeFileSync(opt("--rows"), JSON.stringify(rows.map((r) => ({ name: r.item.name, layout: r.item.layout, axis: r.item.axis, amount: r.item.amount, kind: r.kind, contained: r.contained, ids: r.ids, findings: r.findings }))));
    process.stdout.write(JSON.stringify(score(rows), null, 1) + "\n");
    process.exit(0);
  }
  const report = fs.existsSync(path.join(dir, "report.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")) : draw(items, dir);
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report));
  const gamesDir = opt("--games");
  const nativeDirs = all("--native").length ? reconvert(all("--native"), path.join(dir, "native")) : [];
  const gamesBoxes = gamesDir && path.join(dir, "games-boxes");
  if (gamesDir) execFileSync(process.execPath, [path.join(__dirname, "overlap/games-to-boxes.mjs"), gamesDir, gamesBoxes], { stdio: "inherit" });
  if (argv.includes("--manifest")) {
    const files = report.images.filter((t) => !t.skipped).map((t) => ({ path: t.name, sha256: sha(path.join(dir, t.name)), boxes_sha256: sha(path.join(dir, t.name.replace(/\.png$/, ".boxes.json"))) }));
    const nat = all("--native").map((d, i) => ({ dir: path.relative(ROOT, d), screens_with_boxes: fs.readdirSync(nativeDirs[i], { recursive: true }).filter((f) => String(f).endsWith(".boxes.json")).length }));
    process.stdout.write(JSON.stringify({ spec: "TODO-046, TODO-049", synthetic: { seed: SEED, generator: "bench/overlap/elements-generate.mjs", count: files.length, tools: report.tools, files }, games: gamesDir ? { dir: "datasets/overlap-games", converter: "bench/overlap/games-to-boxes.mjs" } : null, native: nat }, null, 1) + "\n");
    process.exit(0);
  }
  const rows = synthRows(items, report, dir);
  const reviewed = opt("--reviewed") ? JSON.parse(fs.readFileSync(opt("--reviewed"), "utf8")) : {};
  const held = score(rows.filter((r) => !r.item.dev));
  // TODO-049 D13: the shipped control kinds together, the numbers the text-control gate reads.
  const tc = held["text-control"];
  if (tc) {
    const k = SHIPPED_CONTROLS.map((c) => tc.per_kind[c]);
    const tp = k.reduce((n, x) => n + x.tp, 0), fp = k.reduce((n, x) => n + x.fp, 0), pos = k.reduce((n, x) => n + x.positives, 0), found = k.reduce((n, x) => n + x.found, 0);
    tc.shipped = { kinds: SHIPPED_CONTROLS, positives: pos, tp, fp, precision: Number((tp / (tp + fp)).toFixed(4)), recall: Number((found / pos).toFixed(4)), recall_wilson95: wilson(found, pos) };
    tc.shipped.gate_pass = tc.shipped.precision >= GATE.precision && tc.shipped.recall >= GATE.recall;
  }
  const g = gamesDir ? games(gamesDir, gamesBoxes) : null;
  const n = nativeDirs.length ? native(nativeDirs, reviewed, path.join(dir, "native")) : null;
  const v = versionInfo();
  const negScreens = (n ? n.images : 0) + (g ? g.negatives : 0);
  const negFlags = (n ? n.false_alarms : 0) + (g ? g.negative_flags : 0);
  const realPer100 = negScreens ? Number((100 * negFlags / negScreens).toFixed(2)) : null;
  const gate = {};
  for (const type of TYPES) {
    if (!held[type]) continue;
    gate[type] = {
      synthetic: type === "text-control" ? held[type].shipped.gate_pass : held[type].gate_pass,
      // TODO-049 D6: no real screen in the lab sets has a panel, so occlusion has no real-negative measurement.
      real_negatives: type === "occlusion" ? null : realPer100 !== null && realPer100 < GATE.falseAlarmsPer100,
      games: type === "text-text" ? (g ? g.recall >= GATE.gameRecall : null) : null,
    };
    // text-text needs the game set measured: a run without --games never passes it (games has no graphics, so
    // text-graphic is judged without it).
    gate[type].pass = gate[type].synthetic && gate[type].real_negatives === true && (type === "text-text" ? gate[type].games === true : true);
  }
  const result = {
    spec: "TODO-046, TODO-049", script: "bench/overlap-elements.js", generator: "bench/overlap/elements-generate.mjs", strings: "bench/untranslated/strings.json",
    manifest: "bench/overlap/elements-manifest.json", seed: SEED, locales: LOCALES, layouts: [...LAYOUTS, ...CONTROLS, "panel"], panels: PANELS, amounts_css_px: AMOUNTS, sizes_css_px: SIZES,
    drawn: items.length, skipped_layout: report.images.filter((t) => t.skipped).length, gate_bars: GATE,
    held_out: held, dev: score(rows.filter((r) => r.item.dev)), games: g, native: n,
    real_negatives: { screens: negScreens, false_alarms: negFlags, per_100: realPer100 }, gate,
    // The recall bars were missed; the owner shipped the reader at these numbers (TODO-046 D18).
    decision: "TODO-046 D18: ships without --experimental at the measured numbers; TODO-049 D6: occlusion runs only under --experimental (no real negatives with panels)",
    tools: { ...report.tools, catscan: v.catscan, chip: v.host.chip, macos: v.macos, macos_build: v.macos_build, vision_revision: v.vision_revision,
      node: process.version, swiftc: execFileSync("swiftc", ["--version"], { encoding: "utf8" }).split("\n")[0],
      xcode: spawnSync("xcodebuild", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0] || null },
    date: new Date().toISOString().slice(0, 10),
  };
  process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  if (!opt("--keep")) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(Object.values(gate).every((x) => x.pass) ? 0 : 1);
}

module.exports = { plan, score, GATE, LOCALES, reconvert, run };
