#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-072 measurement: `catscan overlap --boxes` signal `sheets` (two text elements of one line height, one inside the
// other, confirmed by ink).
// - Synthetic (D4): the TODO-067 sheet generator (bench/stacked/generate.swift), which also writes a sidecar per image,
//   one element per page's drawn line. Labeled by construction: a finding is right when it pairs one role (title,
//   subtitle, counter) of two different pages on a stacked image. Odd image numbers are held out; nothing is tuned here.
// - Real positives (D5, D12): datasets/stacked-text/boxes/<locale>/unlock-wait.{png,boxes.json}; the gate counts them as
//   captured. A copy whose y is rescaled per locale by a factor fitted from the elements Vision reads cleanly and uniquely
//   stays as a regression check for sidecars that miss their screenshot (the first capture sat about 8% low).
// - Real negatives (D6): the TODO-046 native screens reconverted with this checkout, and the natural game screens; every
//   `sheets` flag is listed for hand review (`--reviewed <file>`: {"<path>": {"<line>": "real" | "false-alarm"}}).
// Usage:
//   node bench/overlap-sheets.js --positives datasets/stacked-text/boxes [--games <dir>] [--native <dir>]... [--reviewed <file>] > results/overlap-sheets.json
//   node bench/overlap-sheets.js --manifest --positives datasets/stacked-text/boxes > bench/overlap/sheets-manifest.json
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { wilson } = require("./overlap/elements-lib");
const { reconvert, run } = require("./overlap-elements");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const GATE = { heldOutPrecision: 0.90, positivesFlagged: 10, newFalseAlarms: 0 };
// D6: the other overlap signals' flags on the same real negatives must stay as TODO-046/049 published them.
const BASELINE = path.join(ROOT, "results/overlap-elements.json");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const r4 = (v) => Number(v.toFixed(4));
const key = (t) => (t || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const sheets = (env) => (env.findings || []).filter((f) => f.kind === "overlap" && f.signal === "sheets");

/** The synthetic set: draw it, run each locale folder, score findings against the generator's labels. */
function synthetic(dir) {
  const bin = path.join(dir, "gen");
  execFileSync("swiftc", ["-O", path.join(ROOT, "bench/stacked/generate.swift"), "-o", bin]);
  execFileSync(bin, [path.join(dir, "syn")], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  const labels = JSON.parse(fs.readFileSync(path.join(dir, "syn/labels.json"), "utf8"));
  const byFile = new Map(labels.map((l) => [l.file, l]));
  const rows = [];
  for (const loc of [...new Set(labels.map((l) => l.locale))]) {
    const d = path.join(dir, "syn", loc);
    const files = fs.readdirSync(d).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(d, f));
    for (const env of run(files, d, loc)) {
      const label = byFile.get(`${loc}/${path.basename(env.path)}`);
      const idx = Number(path.basename(env.path).slice(0, 4));
      const role = (id) => /^page(\d+)-(\w+)$/.exec(id || "");
      const right = (f) => {
        const a = role(f.a?.element?.id), b = role(f.b?.element?.id);
        return label.pages > 1 && a && b && a[2] === b[2] && a[1] !== b[1];
      };
      const fs_ = (env.findings || []).filter((f) => f.kind === "overlap");
      rows.push({ label, held: idx % 2 === 1, findings: fs_.map((f) => ({ signal: f.signal, right: right(f), role: role(f.a?.element?.id)?.[2] ?? null })) });
    }
  }
  const score = (rs) => {
    const out = { images: rs.length, by_kind: {} };
    for (const sig of ["sheets", "any"]) {
      const fs_ = rs.flatMap((r) => r.findings.filter((f) => sig === "any" || f.signal === sig));
      const tp = fs_.filter((f) => f.right).length, fp = fs_.length - tp;
      out[sig] = { flags: fs_.length, tp, fp, precision: fs_.length ? r4(tp / fs_.length) : null };
    }
    for (const r of rs) {
      const k = `${r.label.kind} ${r.label.offset}`;
      const g = (out.by_kind[k] ||= { images: 0, flagged_any: 0, flagged_sheets: 0, false_flags: 0 });
      g.images++;
      if (r.findings.some((f) => f.right)) g.flagged_any++;
      if (r.findings.some((f) => f.right && f.signal === "sheets")) g.flagged_sheets++;
      g.false_flags += r.findings.filter((f) => !f.right).length;
    }
    // Recall of the bug class: stacked images (pages > 1) flagged by any overlap signal, with its Wilson interval.
    const pos = rs.filter((r) => r.label.pages > 1), found = pos.filter((r) => r.findings.some((f) => f.right)).length;
    out.stacked_recall = { images: pos.length, found, recall: pos.length ? r4(found / pos.length) : null, wilson95: wilson(found, pos.length) };
    const same = pos.filter((r) => r.label.offset === 0), sameFound = same.filter((r) => r.findings.some((f) => f.right && f.signal === "sheets")).length;
    out.same_place_sheets_recall = { images: same.length, found: sameFound, recall: same.length ? r4(sameFound / same.length) : null, wilson95: wilson(sameFound, same.length) };
    return out;
  };
  return { generator: "bench/stacked/generate.swift", images: rows.length, held_out: score(rows.filter((r) => r.held)), dev: score(rows.filter((r) => !r.held)) };
}

/**
 * D5: y scale of a sidecar against its PNG, through the origin, from the element texts Vision reads exactly once and
 * cleanly (folded key equal); null with fewer than 2 such elements.
 */
function fitY(png, boxesFile, locale) {
  const r = spawnSync(process.execPath, [CLI, "read", png, "--locale", locale, "--json"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (![0, 1].includes(r.status)) throw new Error(`catscan read ${png}: exit ${r.status ?? r.signal}: ${r.stderr}`);
  const lines = JSON.parse(r.stdout.split("\n").find(Boolean)).lines || [];
  const els = JSON.parse(fs.readFileSync(boxesFile, "utf8")).elements;
  const pairs = [];
  for (const e of els) {
    const k = key(e.text);
    if (k.length < 3 || pairs.some((p) => p.key === k)) continue;
    const m = lines.filter((l) => key(l.text) === k);
    if (m.length !== 1) continue;
    pairs.push({ key: k, box: e.box[1] + e.box[3] / 2, png: m[0].box[1] + m[0].box[3] / 2 });
  }
  if (pairs.length < 2) return { scale: null, elements: pairs.length };
  const scale = pairs.reduce((s, p) => s + p.box * p.png, 0) / pairs.reduce((s, p) => s + p.box * p.box, 0);
  const residual = Math.max(...pairs.map((p) => Math.abs(p.png - scale * p.box)));
  return { scale: r4(scale), elements: pairs.length, max_residual: r4(residual) };
}

function positives(root, dir) {
  // `flagged`: locales with a `sheets` finding (the gate); `any_overlap`: with any overlap finding.
  const out = { dir: "datasets/stacked-text/boxes", locales: {}, as_captured: { flagged: 0, any_overlap: 0 }, rescaled: { flagged: 0, any_overlap: 0 } };
  const locales = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort();
  for (const loc of locales) {
    const png = path.join(root, loc, "unlock-wait.png"), side = path.join(root, loc, "unlock-wait.boxes.json");
    const fit = fitY(png, side, loc);
    const copy = path.join(dir, "rescaled", loc);
    fs.mkdirSync(copy, { recursive: true });
    fs.symlinkSync(path.resolve(png), path.join(copy, "unlock-wait.png"));
    const b = JSON.parse(fs.readFileSync(side, "utf8"));
    const s = fit.scale ?? 1;
    // A scale above 1 can push a box past the bottom edge: drop it (no box, as a dump drops an element off screen).
    b.elements = b.elements.filter((e) => e.box[1] * s < 1).map((e) => ({ ...e, box: [e.box[0], r4(e.box[1] * s), e.box[2], r4(Math.min(e.box[3] * s, 1 - e.box[1] * s))] }));
    fs.writeFileSync(path.join(copy, "unlock-wait.boxes.json"), JSON.stringify(b));
    const [asIs] = run([png], path.join(root, loc), loc);
    const [scaled] = run([path.join(copy, "unlock-wait.png")], copy, loc);
    const count = (env) => (env.findings || []).filter((f) => f.kind === "overlap").length;
    out.locales[loc] = { engine: asIs.engine ?? null, fit, as_captured: { overlap: count(asIs), sheets: sheets(asIs).length }, rescaled: { overlap: count(scaled), sheets: sheets(scaled).length } };
    if (sheets(asIs).length) out.as_captured.flagged++;
    if (sheets(scaled).length) out.rescaled.flagged++;
    if (count(asIs)) out.as_captured.any_overlap++;
    if (count(scaled)) out.rescaled.any_overlap++;
  }
  out.count = locales.length;
  return out;
}

/** Real negatives: every `sheets` flag on the native mirrors and the natural game screens, with its review verdict. */
function negatives(nativeRoots, nativeDirs, gamesDir, dir, reviewed) {
  const flags = [];
  let images = 0, otherFlags = 0;
  const take = (env, rel) => {
    images++;
    otherFlags += (env.findings || []).filter((f) => f.kind === "overlap" && f.signal !== "sheets").length;
    for (const f of sheets(env)) flags.push({ path: rel, line: f.line, overlap: f.overlap, verdict: reviewed[rel]?.[f.line] ?? "unreviewed" });
  };
  nativeRoots.forEach((root, i) => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name)).flatMap((e) => {
      const f = path.join(d, e.name);
      return e.isDirectory() ? walk(f) : /\.png$/i.test(e.name) && fs.existsSync(f.replace(/\.png$/i, ".boxes.json")) ? [f] : [];
    });
    const byDir = new Map();
    for (const f of walk(root)) byDir.set(path.dirname(f), [...(byDir.get(path.dirname(f)) || []), f]);
    for (const [d, files] of byDir) {
      const loc = path.basename(d);
      for (const env of run(files, d, /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(loc) ? loc : null)) take(env, path.join(path.basename(nativeDirs[i]), path.relative(root, env.path)));
    }
  });
  let games = 0;
  if (gamesDir) {
    const boxesRoot = path.join(dir, "games-boxes");
    execFileSync(process.execPath, [path.join(__dirname, "overlap/games-to-boxes.mjs"), gamesDir, boxesRoot], { stdio: ["ignore", "ignore", "inherit"] });
    const apps = fs.readdirSync(gamesDir).filter((d) => fs.existsSync(path.join(gamesDir, d, "manifest.json"))).sort();
    apps.forEach((app, n) => {
      for (const loc of fs.readdirSync(path.join(gamesDir, app)).filter((d) => fs.statSync(path.join(gamesDir, app, d)).isDirectory()).sort()) {
        const d = path.join(gamesDir, app, loc);
        const files = fs.readdirSync(d).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(d, f))
          .filter((f) => { const s = JSON.parse(fs.readFileSync(f.replace(/\.png$/, ".json"), "utf8")); return s.kind !== "forced" && !(s.pairs || []).length; });
        for (const env of run(files, path.join(boxesRoot, app, loc), loc)) { games++; take(env, `game-${n + 1}/${loc}/${path.basename(env.path)}`); }
      }
    });
  }
  const fa = flags.filter((f) => f.verdict !== "real");
  return { images, native_images: images - games, game_images: games, other_signal_flags: otherFlags, sheets_flags: flags.length,
    unreviewed: flags.filter((f) => f.verdict === "unreviewed").length, false_alarms: fa.length, list: flags };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
  const posRoot = opt("--positives");
  if (argv.includes("--manifest")) {
    const files = posRoot ? fs.readdirSync(posRoot, { recursive: true }).map(String).filter((f) => /\.(png|boxes\.json)$/.test(f)).sort()
      .map((f) => ({ path: path.join("datasets/stacked-text/boxes", f), bytes: fs.statSync(path.join(posRoot, f)).size, sha256: sha(path.join(posRoot, f)) })) : [];
    process.stdout.write(JSON.stringify({ spec: "TODO-072", positives: { dir: "datasets/stacked-text/boxes", locales: new Set(files.map((f) => path.dirname(f.path))).size, files },
      synthetic: { generator: "bench/stacked/generate.swift", note: "drawn at run time, labels.json and images as TODO-067" } }, null, 1) + "\n");
    process.exit(0);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-overlap-sheets-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true })); // also after a throw
  const reviewed = opt("--reviewed") ? JSON.parse(fs.readFileSync(opt("--reviewed"), "utf8")) : {};
  const syn = synthetic(dir);
  const pos = posRoot ? positives(posRoot, dir) : null;
  const nativeDirs = all("--native");
  const neg = negatives(nativeDirs.length ? reconvert(nativeDirs, path.join(dir, "native")) : [], nativeDirs, opt("--games"), dir, reviewed);
  const gate = {
    held_out_precision: syn.held_out.sheets.precision !== null && syn.held_out.sheets.precision >= GATE.heldOutPrecision,
    positives_as_captured: pos ? pos.as_captured.flagged >= GATE.positivesFlagged : null,
    real_negatives: neg.images > 0 && neg.false_alarms <= GATE.newFalseAlarms && neg.unreviewed === 0,
  };
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  neg.other_signal_flags_baseline = { flags: base.native.flags + (base.games?.negative_flags ?? 0), source: "results/overlap-elements.json#/native/flags", catscan: base.tools.catscan };
  gate.other_signals_unchanged = neg.other_signal_flags === neg.other_signal_flags_baseline.flags;
  gate.pass = Object.values(gate).every((v) => v === true);
  const v = versionInfo();
  const result = {
    spec: "TODO-072", script: "bench/overlap-sheets.js", manifest: "bench/overlap/sheets-manifest.json", gate_bars: GATE, gate,
    synthetic: syn, positives: pos, real_negatives: neg,
    tools: { catscan: v.catscan, chip: v.host.chip, macos: v.macos, macos_build: v.macos_build, vision_revision: v.vision_revision, node: process.version,
      swiftc: execFileSync("swiftc", ["--version"], { encoding: "utf8" }).split("\n")[0],
      xcode: spawnSync("xcodebuild", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0] || null },
    date: new Date().toISOString().slice(0, 10),
  };
  process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  process.exit(gate.pass ? 0 : 1);
}

