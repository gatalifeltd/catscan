#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 05: the public synthetic benchmark. Draws the planned images with bench/generate.swift, sends each to catscan
// `serve` (check, truncated, read), scores them with catscan's own verdicts and writes CSV files.
// Usage: npm run bench [-- --quick] [--lang de,ja] [--record] [--out <dir>] [--keep <dir>]
// Exit: 0 pass; 1 gate or quick regression; 2 usage or a missing prerequisite; 5 internal error (spec 05 D13).
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const client = require("../../packages/core-js/src/client");
const corpus = require("../corpus/build");
const P = require("./plan");
const { scoreLanguage, gate, compare } = require("./score");
const T = require("./table");

const ROOT = path.resolve(__dirname, "../..");
const GEN = path.join(ROOT, ".build/bench-gen");
const IN_FLIGHT = 6; // requests kept in flight; serve's own pool (2) does the queueing
const PROGRESS_EVERY = 500;

const HELP = `Usage: npm run bench -- [options]   (spec 05, docs/BENCHMARKS.md "Languages")
  --quick          10 strings x 3 cases in one variant per language, compared with the recorded quick run
  --lang <list>    only these locales (comma list), e.g. de,ja,el
  --record         write the run to bench/results/<macOS version>/ as the new record
  --out <dir>      write the run here instead of a temp folder (ignored with --record)
  --keep <dir>     keep the generated images here
Exit: 0 pass, 1 gate or quick regression, 2 usage or a missing prerequisite, 5 internal error.`;

const usage = (msg) => Object.assign(new Error(msg), { exit: 2 });

function parseArgs(argv) {
  const o = { quick: false, record: false, lang: null, out: null, keep: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quick") o.quick = true;
    else if (a === "--record") o.record = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (["--lang", "--out", "--keep"].includes(a)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw usage(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else throw usage(`unknown option ${a}; see npm run bench -- --help`);
  }
  return o;
}

/**
 * Prerequisites before any image is drawn (spec 05 D10). `env` holds what was found: { binary, swiftc, doctor }.
 * Returns messages naming the fix; empty when the run can start.
 */
function preflight(locales, env) {
  const out = [];
  if (!env.binary) out.push("catscan-core is not built: run `npm run build` (swift build -c release --package-path core)");
  if (!env.swiftc) out.push("swiftc not found: install Xcode, then `sudo xcode-select -s /Applications/Xcode.app`");
  const fb = locales.filter((l) => corpus.FALLBACK.includes(l));
  if (fb.length) {
    const d = env.doctor?.fallback;
    const others = locales.filter((l) => !fb.includes(l));
    const skip = others.length ? ` (or run --lang ${others.join(",")} without the fallback locales)` : "";
    if (!d?.path) out.push(`Tesseract is needed for ${fb.join(", ")}: brew install tesseract tesseract-lang${skip}`);
    else {
      const missing = fb.filter((l) => !(d.locales || []).find((x) => x.locale === l && x.installed));
      if (missing.length) out.push(`Tesseract language data missing for ${missing.join(", ")}: brew install tesseract-lang${skip}`);
    }
  }
  return out;
}

const first = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? `${r.stdout}${r.stderr}`.trim().split("\n")[0] : null;
};

/** Booted simulators and running emulators: the timing is marked "under load" when there are any (spec 05 D8). */
function load() {
  const sims = (spawnSync("xcrun", ["simctl", "list", "devices", "booted"], { encoding: "utf8" }).stdout || "").split("\n").filter((l) => /\(Booted\)/.test(l)).length;
  const emus = (spawnSync("adb", ["devices"], { encoding: "utf8" }).stdout || "").split("\n").filter((l) => /^emulator-\d+\s+device/.test(l)).length;
  return { sims, emus };
}

/** Runs `fn` over `list` with at most `n` in flight. */
async function pool(list, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) { const i = next++; await fn(list[i], i); }
  }));
}

const fmtTime = (ms) => { const s = Math.round(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; };

/** Quick regression report (spec 05 D13): what dropped, the misread images, and the next step. */
function regressionReport(fails, rowsBy, version) {
  const lines = ["quick run differs from the recorded one:"];
  for (const f of fails) {
    lines.push(`  ${f}`);
    const l = f.split(":")[0];
    for (const r of (rowsBy[l] || []).filter((x) => x.present === "fail" || x.absent === "fail" || x.present === "error").slice(0, 5)) {
      lines.push(`    ${r.image}: present ${r.present || "-"}, absent ${r.absent || "-"}, read ${JSON.stringify(r.read ?? "")}`);
    }
  }
  lines.push(`If macOS or Vision changed on purpose, rerun with --record and commit bench/results/${version}/quick-summary.csv; otherwise this is a recognition regression.`);
  return lines.join("\n");
}

/**
 * Spec 11 D15: after a full run, the user's per-engine numbers next to the committed run of the same macOS version
 * (read before this run writes), over the same languages. Timing is printed, never compared (D10).
 */
function referenceReport(mine, ref, version) {
  if (!ref) return `bench: no committed run for macOS ${version} (bench/results/${version}/summary.csv) to compare with`;
  const want = new Set(mine.map((s) => s.locale));
  const theirs = Object.fromEntries(T.aggregate(ref.summaries.filter((s) => want.has(s.locale))).map((a) => [a.label, a]));
  const f = (v, d) => (v === null || v === undefined ? "-" : Number(v).toFixed(d));
  const lines = [`bench: your run next to bench/results/${version}/ (reference in brackets):`];
  for (const a of T.aggregate(mine)) {
    const r = theirs[a.label] || {};
    lines.push(`  ${a.label} (${a.count} languages): check accuracy median ${f(a.median, 2)}% [${f(r.median, 2)}%], lowest ${f(a.low?.check_accuracy, 2)}% ${a.low?.locale || "-"} [${f(r.low?.check_accuracy, 2)}% ${r.low?.locale || "-"}], median ms ${f(a.ms, 0)} [${f(r.ms, 0)}]`);
  }
  return lines.join("\n");
}

/** The machine-facing side of a run; tests replace it (spec 05 test plan: generator and serve stubbed). */
const HOST = {
  client,
  swiftc: () => first("swiftc", ["--version"]),
  buildGen: () => {
    fs.mkdirSync(path.dirname(GEN), { recursive: true });
    execFileSync("swiftc", ["-O", path.join(__dirname, "../generate.swift"), "-o", GEN], { stdio: ["ignore", "ignore", "inherit"] });
  },
  gen: (planFile, dir) => JSON.parse(execFileSync(GEN, [planFile, dir], { encoding: "utf8" })),
  load,
  // Read before anything is written: a --record run rewrites tracked CSVs, which would mark a clean checkout dirty.
  git: () => {
    const commit = first("git", ["-C", ROOT, "rev-parse", "HEAD"]);
    const dirty = (spawnSync("git", ["-C", ROOT, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout || "").trim() !== "";
    return dirty ? `${commit} (uncommitted changes)` : commit;
  },
  machine: () => first("sysctl", ["-n", "hw.model"]),
  swift: () => first("swift", ["--version"]),
  tesseract: (bin) => { const r = spawnSync(bin, ["--version"], { encoding: "utf8" }); return `${r.stdout}${r.stderr}`.split("\n").map((l) => l.trim()).filter(Boolean); },
  root: ROOT,
};

async function main(argv, host = HOST) {
  const { client: C, root } = host;
  const o = parseArgs(argv);
  if (o.help) { console.log(HELP); return 0; }
  const locales = P.locales(o.lang);
  let binary = null;
  try { binary = C.binaryPath(); } catch {}
  const doctor = binary ? C.doctorInfo(binary) : null;
  const pre = preflight(locales, { binary, swiftc: host.swiftc(), doctor });
  if (pre.length) { console.error(pre.map((m) => `bench: ${m}`).join("\n")); return 2; }

  const commit = host.git();
  const v = C.versionInfo(binary);
  const t = { catscan: v.catscan, macos: v.macos, macos_build: v.macos_build, vision_revision: v.vision_revision };
  const out = o.record ? path.join(root, "bench/results", v.macos) : o.out ? path.resolve(o.out) : fs.mkdtempSync(path.join(os.tmpdir(), "catscan-bench-"));
  const langDir = o.quick ? path.join(out, "quick") : out;
  const refFile = path.join(root, "bench/results", v.macos, "summary.csv");
  const ref = !o.quick && fs.existsSync(refFile) ? T.readSummaryCsv(refFile) : null;
  fs.mkdirSync(langDir, { recursive: true });
  // A record is staged and moved in only when no image errored, so a refused record leaves the old one intact.
  const stage = o.record ? fs.mkdtempSync(path.join(os.tmpdir(), "catscan-bench-stage-")) : langDir;
  const ran = [];
  const images = o.keep ? path.resolve(o.keep) : fs.mkdtempSync(path.join(os.tmpdir(), "catscan-bench-img-"));
  fs.mkdirSync(images, { recursive: true });
  host.buildGen();

  const before = host.load();
  const fonts = {};
  const rowsBy = {};
  const server = new C.Server({ bin: binary });
  await server.ready;
  let id = 0;
  const ask = (req) => server.request({ id: String(id++), ...req });
  const started = Date.now();
  let done = 0;
  const total = locales.reduce((n, l) => n + P.plan(l, { quick: o.quick }).length, 0);
  try {
    for (const [li, locale] of locales.entries()) {
      const t0 = Date.now();
      const items = P.plan(locale, { quick: o.quick });
      const fallback = corpus.FALLBACK.includes(locale);
      const planFile = path.join(images, `plan-${locale}.json`);
      fs.writeFileSync(planFile, JSON.stringify(items));
      const rep = host.gen(planFile, images);
      fonts[locale] = rep.fonts[locale] || [];
      const base = { locale, ...(fallback ? { fallback: "tesseract" } : {}) };
      const res = {};
      let n = 0;
      await pool(items, IN_FLIGHT, async (it) => {
        const p = path.join(images, it.name);
        const r = {};
        r.check = await ask({ command: "check", path: p, ...base, ...(it.case === "fit" ? { present: [it.text] } : {}), absent: [it.absent] });
        r.truncated = await ask({ command: "truncated", path: p, ...base });
        if (it.case !== "ellipsis") r.read = await ask({ command: "read", path: p, ...base });
        res[it.name] = r;
        if (++n % PROGRESS_EVERY === 0) process.stderr.write(`  ${locale}: ${n}/${items.length} images\n`);
      });
      // Timing (D8): one request at a time over the quick variant's fit images, after the parallel pass.
      const ms = [];
      for (const it of P.timed(items)) {
        const e = await ask({ command: "check", path: path.join(images, it.name), ...base, present: [it.text] });
        if (typeof e.ms === "number") ms.push(e.ms);
      }
      const { summary, rows } = scoreLanguage(locale, items, res, { ms, fallback, gated: P.GATED.includes(locale) });
      rowsBy[locale] = rows;
      fs.writeFileSync(path.join(stage, `${locale}.csv`), T.languageCsv(t, summary, rows));
      ran.push(summary);
      done += items.length;
      const el = Date.now() - started;
      process.stderr.write(`[${li + 1}/${locales.length}] ${locale}: ${items.length} images, check accuracy ${summary.check_accuracy}%, ${fmtTime(Date.now() - t0)}, ETA ${fmtTime((el / done) * (total - done))}\n`);
    }
  } catch (e) {
    if (o.record) fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  } finally {
    await server.close();
    if (!o.keep) fs.rmSync(images, { recursive: true, force: true });
  }

  if (o.record) {
    // A record with errored images would lower the bar every later run is compared with.
    const errored = ran.filter((s) => s.errors > 0).map((s) => `${s.locale} (${s.errors})`);
    if (!errored.length) for (const f of fs.readdirSync(stage)) fs.copyFileSync(path.join(stage, f), path.join(langDir, f));
    fs.rmSync(stage, { recursive: true, force: true });
    if (errored.length) { console.error(`bench: not a usable record, images errored: ${errored.join(", ")}; fix the cause and record again`); return 1; }
  }
  const after = host.load();
  const busy = { sims: Math.max(before.sims, after.sims), emus: Math.max(before.emus, after.emus) };
  const { summaries, stale } = T.collect(langDir, t, corpus.LOCALES);
  if (stale.length) console.error(`bench: not in the summary (another catscan or macOS build): ${stale.join(", ")}`);
  const tessLines = doctor?.fallback?.path ? host.tesseract(doctor.fallback.path) : [];
  const tessdata = {};
  for (const l of doctor?.fallback?.locales || []) {
    if (!locales.includes(l.locale)) continue;
    for (const pack of l.packs) {
      const f = path.join(doctor.fallback.tessdata, `${pack}.traineddata`);
      if (fs.existsSync(f)) tessdata[pack] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    }
  }
  // TODO-037: corpus files are drawn by different ICUs, so provenance is grouped over every language in the folder.
  const corpusOf = (ls) => {
    const g = new Map();
    for (const l of ls) {
      const c = JSON.parse(fs.readFileSync(corpus.file(l), "utf8"));
      const k = `${c.icu}|${c.cldr}|${c.node}`;
      if (!g.has(k)) g.set(k, { node: c.node, icu: c.icu, cldr: c.cldr, locales: [] });
      g.get(k).locales.push(l);
    }
    return { seed: corpus.SEED, groups: [...g.values()] };
  };
  const run = {
    command: `npm run bench --${argv.length ? " " + argv.join(" ") : ""}`, locales, commit, date: new Date().toISOString().slice(0, 10),
    timing: busy.sims || busy.emus
      ? `under load: ${busy.sims} simulator(s) booted, ${busy.emus} emulator(s) running; sequential check over the quick variant's fit images, median of the response ms`
      : "no simulator or emulator running; sequential check over the quick variant's fit images, median of the response ms",
  };
  const metaFile = path.join(out, o.quick ? "quick-meta.json" : "meta.json");
  // A --lang rerun into a folder that holds other languages of the same build keeps their fonts, traineddata and
  // runs, as summary.csv keeps their rows (D12).
  const prev = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : null;
  const same = prev && T.stamp(prev.tools || {}) === T.stamp(t);
  const meta = {
    spec: "05", quick: o.quick, ...run, locales: summaries.map((s) => s.locale),
    machine: host.machine(),
    tools: {
      ...t, chip: v.host.chip, host_class: v.host.host_class, node: process.version, swift: host.swift(),
      tesseract: tessLines[0] || null, leptonica: tessLines[1] || null, tessdata: { ...(same ? prev.tools.tessdata : {}), ...tessdata },
    },
    corpus: corpusOf(summaries.map((s) => s.locale)),
    fonts: { ...(same ? prev.fonts : {}), ...fonts },
    // An earlier run whose languages this run all replaced no longer contributes a number.
    runs: [...(same ? (prev.runs || []).filter((x) => !x.locales.every((l) => locales.includes(l))) : []), run],
  };
  fs.writeFileSync(path.join(out, o.quick ? "quick-summary.csv" : "summary.csv"), T.summaryCsv(t, summaries));
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
  console.log(`bench: wrote ${summaries.length} languages to ${out}`);

  const all = !o.lang;
  const gateFails = gate(summaries.filter((s) => locales.includes(s.locale)), P.GATED, { all });
  if (!o.quick) {
    console.log(referenceReport(summaries.filter((s) => locales.includes(s.locale)), ref, v.macos));
    if (gateFails.length) { console.error(`bench: gate failed (>= 98% check accuracy):\n  ${gateFails.join("\n  ")}`); return 1; }
    console.log("bench: gate passed");
    return 0;
  }
  if (gateFails.length) console.error(`bench: quick run below the full-run gate (informational, 40 checks per language):\n  ${gateFails.join("\n  ")}`);
  if (o.record) { console.log(`bench: recorded the quick run for macOS ${v.macos}`); return 0; }
  const recFile = path.join(root, "bench/results", v.macos, "quick-summary.csv");
  if (!fs.existsSync(recFile)) {
    console.error(`bench: no recorded quick run for macOS ${v.macos} (bench/results/${v.macos}/quick-summary.csv); rerun with --quick --record and commit it`);
    return 1;
  }
  const rec = T.readSummaryCsv(recFile);
  // The record is per macOS version (D5); a different build may carry a different Vision, so say so.
  if (rec.stamp !== T.stamp(t)) console.error(`bench: the record was made with ${rec.stamp.slice(2)}; this run is ${T.stamp(t).slice(2)}`);
  const fails = compare(summaries.filter((s) => locales.includes(s.locale)), rec.summaries, { all });
  if (fails.length) { console.error(regressionReport(fails, rowsBy, v.macos)); return 1; }
  console.log("bench: quick run matches the recorded one");
  return 0;
}

module.exports = { parseArgs, preflight, regressionReport, referenceReport, pool, main, HOST };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((e) => { console.error(`bench: ${e.message}`); process.exitCode = e.exit || 5; });
}
