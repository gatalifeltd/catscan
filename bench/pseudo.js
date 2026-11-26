#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-039 T2 gate ("## Measurement"): synthetic pseudo-localized screens from a committed seed
// (bench/pseudo/seed.json), drawn by bench/pseudo/generate.swift and labeled by construction. 12 base catalogs
// (3 shapes x 4 formats) x 40 screens, 4 fonts, 2 scales, light and dark. Pseudo text comes from the generator itself
// (packages/core-js/src/pseudo.js, accent variant, --expand 40). Screens and catalogs go to datasets/pseudo-synth/
// (gitignored); only this script, the seed and the numbers are committed.
// Usage: node bench/pseudo.js > results/pseudo.json   (exit 1 when a gate is missed)
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const pseudo = require("../packages/core-js/src/pseudo");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin/catscan.js");
const OUT = path.join(ROOT, "datasets/pseudo-synth");
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "pseudo/seed.json"), "utf8"));
const GATE_SCREENS = 40;
const SCREENS = Number(process.env.PSEUDO_SCREENS) || GATE_SCREENS; // a smaller run is a smoke test and never passes the gate
const FONTS = ["SF", "HelveticaNeue", "Georgia", "AvenirNextCondensed-Regular"];
const FORMATS = ["json", "strings", "android", "xcstrings"];
const GATE = { roundtrip: 0.98, cut: { precision: 0.95, recall: 0.9 }, hardcoded: { precision: 0.95, recall: 0.9 }, false_per_100_clean: 1 };
const FILL = { name: "Anna", count: "3" };

// mulberry32: a stable stream per catalog and screen.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

/** The seed value in a format's own placeholder syntax. */
function inFormat(v, fmt) {
  const ph = { json: (n) => `{{${n}}}`, strings: (n) => (n === "count" ? "%d" : "%@"), android: (n) => (n === "count" ? "%1$d" : "%1$s"), xcstrings: (n) => (n === "count" ? "%lld" : "%@") }[fmt];
  return v.replace(/\{(\w+)\}/g, (_, n) => ph(n));
}
const fill = (s) => s.replace(/\{\{(\w+)\}\}|%(?:1\$)?(?:@|s|d|lld)/g, (m, n) => (n ? FILL[n] : /d$/.test(m) ? FILL.count : FILL.name));
const androidKey = (k) => k.replace(/\./g, "_");

function writeCatalog(dir, fmt, strings) {
  fs.mkdirSync(dir, { recursive: true });
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (fmt === "json") {
    const o = {};
    for (const [k, v] of Object.entries(strings)) { const p = k.split("."); let n = o; for (const s of p.slice(0, -1)) n = n[s] ??= {}; n[p.at(-1)] = v; }
    fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify(o, null, 2));
    return path.join(dir, "en.json");
  }
  if (fmt === "strings") {
    fs.mkdirSync(path.join(dir, "en.lproj"), { recursive: true });
    fs.writeFileSync(path.join(dir, "en.lproj/Localizable.strings"), Object.entries(strings).map(([k, v]) => `"${k}" = "${esc(v)}";`).join("\n") + "\n");
    return path.join(dir, "en.lproj/Localizable.strings");
  }
  if (fmt === "android") {
    const x = (s) => s.replace(/\\/g, "\\\\").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "\\'");
    fs.mkdirSync(path.join(dir, "values"), { recursive: true });
    fs.writeFileSync(path.join(dir, "values/strings.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${Object.entries(strings).map(([k, v]) => `    <string name="${k}">${x(v)}</string>`).join("\n")}\n</resources>\n`);
    return path.join(dir, "values/strings.xml");
  }
  const o = { sourceLanguage: "en", strings: {}, version: "1.0" };
  for (const [k, v] of Object.entries(strings)) o.strings[k] = { localizations: { en: { stringUnit: { state: "translated", value: v } } } };
  fs.writeFileSync(path.join(dir, "Localizable.xcstrings"), JSON.stringify(o, null, 2));
  return path.join(dir, "Localizable.xcstrings");
}

/**
 * One screen: items with their expected verdict. `expect`: null (no finding), cut-filler | cut-text | cut-start
 * (pseudo-cut), cut-ellipsis (any truncated), hardcoded-base | hardcoded-none, raw-key, placeholder.
 */
function planScreen(name, fmt, entries, r, s, fallback) {
  const pick = (list) => list[Math.floor(r() * list.length)];
  const hasPh = (e) => /\{|%/.test(e.base);
  const shorts = entries.filter((e) => !hasPh(e) && e.base.length <= 24);
  const longs = entries.filter((e) => e.base.length > 80);
  const phs = entries.filter(hasPh);
  const used = new Set();
  const take = (list) => { if (!list.length) return null; for (let i = 0; i < 20; i++) { const e = pick(list); if (!used.has(e.key)) { used.add(e.key); return e; } } return null; };
  const items = [];
  let y = 64;
  const add = (o) => {
    const size = o.size ?? 17;
    items.push({ id: `i${items.length}`, x: 20, w: 350, size, align: "left", wrap: false, ellipsis: false, contrast: 1, panel: false, keep: null, drop: null, expect: null, ...o, y });
    y += o.wrap ? Math.ceil(o.text.length * size * 0.55 / 350) * size * 1.35 + 18 : size * 2.3;
  };
  const shown = (e) => (fallback ? fill(e.raw) : fill(e.pseudo));
  // Status bar: never pseudo (the band guard).
  items.push({ id: "bar0", text: "9:41", x: 24, y: 6, w: 60, size: 14, align: "left", wrap: false, ellipsis: false, contrast: 1, panel: false, keep: null, drop: null, expect: null });
  items.push({ id: "bar1", text: "Carrier Wi-Fi", x: 250, y: 6, w: 120, size: 13, align: "left", wrap: false, ellipsis: false, contrast: 1, panel: false, keep: null, drop: null, expect: null });
  for (let i = 0; i < 4; i++) { const e = take(shorts); if (e) add({ text: shown(e), key: e.key, clean: !fallback }); }
  if (fallback) {
    // D4: a build that fell back to base: base strings only; expects pseudo-not-applied and no hardcoded.
    for (let i = 0; i < 2; i++) { const e = take(shorts); if (e) add({ text: fill(e.raw), key: e.key }); }
    return { name, fmt, fallback: true, defects: 0, items };
  }
  // Negatives: a paragraph wrapped over 3+ lines, a filled placeholder, user content, values, a faint line.
  if (r() < 0.5) { const e = take(longs); if (e) add({ text: fill(e.pseudo), key: e.key, wrap: true, size: 15, clean: true }); }
  if (r() < 0.6) { const e = take(phs); if (e) add({ text: fill(e.pseudo), key: e.key, clean: true }); }
  if (r() < 0.4) add({ text: pick(SEED.names) });
  if (r() < 0.5) add({ text: pick(SEED.values) });
  if (r() < 0.3) { const e = take(shorts); if (e) add({ text: fill(e.pseudo), key: e.key, size: 11, contrast: 0.35 }); }
  // Seeded defects: 0-2 per screen, about a third of the screens clean.
  const kinds = ["cut-filler", "cut-text", "cut-start", "cut-ellipsis", "hardcoded-base", "hardcoded-none", "raw-key", "placeholder"];
  const n = r() < 0.34 ? 0 : r() < 0.6 ? 1 : 2;
  for (let d = 0; d < n; d++) {
    const kind = kinds[(s + d * 3 + Math.floor(r() * 2)) % kinds.length];
    const e = kind === "placeholder" ? take(phs) : take(kind === "hardcoded-base" ? shorts.filter((x) => x.base.length >= 8 || /\s/.test(x.base)) : shorts);
    if (!e) continue;
    const pv = fill(e.pseudo);
    const baseEnd = 1 + fill(e.pseudoText).length; // "[" + the transformed base text
    if (kind === "cut-filler") add({ text: pv, key: e.key, keep: baseEnd + 2, expect: kind });
    else if (kind === "cut-text") add({ text: pv, key: e.key, keep: 1 + Math.max(3, Math.ceil((baseEnd - 1) * 0.6)), expect: kind });
    else if (kind === "cut-start") add({ text: pv, key: e.key, drop: 1 + Math.max(1, Math.ceil((baseEnd - 1) * 0.4)), align: "right", expect: kind });
    else if (kind === "cut-ellipsis") add({ text: pv, key: e.key, w: Math.max(40, pv.length * 17 * 0.5 * 0.6), ellipsis: true, expect: kind });
    else if (kind === "hardcoded-base") add({ text: fill(e.raw), key: e.key, expect: kind });
    else if (kind === "hardcoded-none") { used.delete(e.key); add({ text: pick(SEED.literals), expect: kind }); }
    else if (kind === "raw-key") add({ text: fmt === "android" ? androidKey(e.key) : e.key, key: e.key, expect: kind });
    else if (kind === "placeholder") add({ text: e.pseudo, key: e.key, expect: kind });
  }
  // System UI over the app: an iOS permission alert or an Android permission dialog (never pseudo).
  if (r() < 0.2) {
    y = Math.max(y, 520);
    for (const t of SEED.system[r() < 0.5 ? "ios" : "android"]) add({ text: t, x: 56, w: 280, size: 15, panel: true });
  }
  return { name, fmt, fallback: false, defects: items.filter((i) => i.expect).length, items };
}

function center(b) { return [b[0] + b[2] / 2, b[1] + b[3] / 2]; }
function inside(p, b, m = 0.01) { return p[0] >= b[0] - m && p[0] <= b[0] + b[2] + m && p[1] >= b[1] - m && p[1] <= b[1] + b[3] + m; }
const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json", "--locale", "en", "--layout", "none", "--text-record", "none"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (![0, 1].includes(r.status)) throw new Error(`${args.join(" ")}: exit ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((x) => JSON.parse(x)).filter((e) => e.command);
}

(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const gen = path.join(ROOT, ".build/pseudo-gen");
  fs.mkdirSync(path.dirname(gen), { recursive: true }); // a clean checkout has no .build/ (TODO-051 rerun)
  execFileSync("swiftc", ["-O", path.join(__dirname, "pseudo/generate.swift"), "-o", gen]);
  const sets = [];
  for (const [shape, strings] of Object.entries(SEED.shapes)) {
    for (const fmt of FORMATS) {
      const id = `${shape}-${fmt}`;
      const keyed = Object.fromEntries(Object.entries(strings).map(([k, v]) => [fmt === "android" ? androidKey(k) : k, inFormat(v, fmt)]));
      const file = writeCatalog(path.join(OUT, id, "catalog"), fmt, keyed);
      const entries = Object.entries(keyed).map(([key, raw]) => {
        const t = pseudo.transform(raw, { fmt, expand: 40, variant: "accent" });
        const text = pseudo.transform(raw, { fmt, expand: 0, variant: "accent", inner: true });
        return { key, raw, base: raw, pseudo: t.value, pseudoText: text.value.trim() };
      });
      const r = rng(SEED.seed ^ hash(id));
      const screens = [];
      for (let s = 0; s < SCREENS; s++) {
        const name = `s${String(s).padStart(2, "0")}`;
        const sc = planScreen(name, fmt, entries, r, s, s % 10 === 9);
        Object.assign(sc, { width: 390, height: 844, scale: [2, 3][(s >> 2) % 2], theme: (s >> 3) % 2 ? "dark" : "light", font: FONTS[s % 4] });
        screens.push(sc);
      }
      const shots = path.join(OUT, id, "shots");
      fs.mkdirSync(shots, { recursive: true });
      const planFile = path.join(OUT, id, "plan.json");
      fs.writeFileSync(planFile, JSON.stringify(screens));
      const lines = execFileSync(gen, [planFile, shots], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const fonts = lines.pop().fonts;
      for (const l of lines) {
        const sc = screens.find((x) => x.name === l.name);
        for (const b of l.items) sc.items.find((i) => i.id === b.id).box = b.box;
      }
      sets.push({ id, fmt, file, shots, screens, fonts });
    }
  }

  const dyn = path.join(__dirname, "pseudo/dynamic.txt");
  const tally = { cut: { tp: 0, fp: 0, fn: 0, other_reason: 0, lost_or_side_wrong: 0 }, ellipsis: { seeded: 0, found: 0 }, hardcoded: { tp: 0, fp: 0, fn: 0, evidence_wrong: 0 }, raw_key: { seeded: 0, found: 0 }, placeholder: { seeded: 0, found: 0 },
    roundtrip: { lines: 0, matched: 0 }, not_applied: { seeded: 0, found: 0, false: 0 }, clean_screens: 0, clean_false: 0, eligible: { lines: 0, judged: 0 } };
  const misses = [];
  for (const set of sets) {
    const pathOf = (sc) => path.join(set.shots, sc.name + ".png");
    const U = run(["untranslated", set.shots, "--pseudo", "--catalog", set.file, "--dynamic", dyn]);
    const T = run(["truncated", set.shots, "--pseudo", "--catalog", set.file]);
    // OCR round trip: each clean single-line pseudo string is found by its key with check --pseudo (D8).
    const expectFile = path.join(OUT, set.id, "expect.json");
    const shots = {};
    for (const sc of set.screens) {
      const keys = sc.items.filter((i) => i.clean && !i.wrap && i.key).map((i) => `@${i.key}`);
      if (keys.length) shots[`${sc.name}.png`] = { present: keys };
    }
    fs.writeFileSync(expectFile, JSON.stringify({ shots }));
    const C = run(["check", set.shots, "--pseudo", "--catalog", set.file, "--expect", expectFile]);
    for (const env of C) for (const c of env.checks) { tally.roundtrip.lines++; if (c.verdict === "pass") tally.roundtrip.matched++; else misses.push(`${set.id}/${path.basename(env.path)} roundtrip ${c.key}: ${c.closest?.line ?? ""}`); }

    for (const sc of set.screens) {
      const u = U.find((e) => e.path === pathOf(sc)), t = T.find((e) => e.path === pathOf(sc));
      const findings = [...u.findings.map((f) => ({ ...f, cmd: "u" })), ...t.findings.map((f) => ({ ...f, cmd: "t" }))];
      const na = findings.filter((f) => f.kind === "pseudo-not-applied");
      if (sc.fallback) {
        tally.not_applied.seeded++;
        if (na.some((f) => f.cmd === "u")) tally.not_applied.found++; else misses.push(`${set.id}/${sc.name} not-applied missed`);
        tally.hardcoded.fp += findings.filter((f) => f.kind === "hardcoded").length;
        continue;
      }
      if (na.length) { tally.not_applied.false++; misses.push(`${set.id}/${sc.name} not-applied on a pseudo screen (${na[0].traits})`); }
      const clean = sc.defects === 0;
      if (clean) tally.clean_screens++;
      const itemOf = (f) => (f.box ? sc.items.find((i) => i.box && inside(center(f.box), i.box)) : null);
      for (const f of findings.filter((x) => x.kind !== "pseudo-not-applied")) {
        const it = itemOf(f);
        const want = it?.expect ?? null;
        const ok = (f.kind === "truncated" && f.reason === "pseudo-cut" && /^cut-(filler|text|start)$/.test(want ?? ""))
          || (f.kind === "truncated" && want === "cut-ellipsis")
          || (f.kind === "hardcoded" && /^hardcoded-/.test(want ?? ""))
          || (f.kind === want);
        if (clean) tally.clean_false++;
        if (f.kind === "truncated" && f.reason === "pseudo-cut") { if (ok) { tally.cut.tp++; if (want !== "cut-ellipsis" && `cut-${f.side === "start" ? "start" : f.lost}` !== want) { tally.cut.lost_or_side_wrong++; misses.push(`${set.id}/${sc.name} ${want} reported as ${f.side}/${f.lost}`); } } else { tally.cut.fp++; misses.push(`${set.id}/${sc.name} false pseudo-cut ${JSON.stringify(f.line)}`); } }
        if (f.kind === "hardcoded") {
          if (ok) { tally.hardcoded.tp++; if (f.evidence !== (want === "hardcoded-base" ? "base" : "none")) tally.hardcoded.evidence_wrong++; }
          else { tally.hardcoded.fp++; misses.push(`${set.id}/${sc.name} false hardcoded ${JSON.stringify(f.line)}`); }
        }
      }
      for (const it of sc.items) {
        // Eligible coverage (TODO-036 D11): lines with 2 words or 8 letters outside the status bar.
        if (!it.id.startsWith("bar")) { tally.eligible.lines++; if (it.text.split(/\s+/).length >= 2 || it.text.replace(/[^\p{L}]/gu, "").length >= 8) tally.eligible.judged++; }
        if (!it.expect) continue;
        const hit = (pred) => findings.some((f) => pred(f) && f.box && inside(center(f.box), it.box));
        if (/^cut-(filler|text|start)$/.test(it.expect)) {
          // Existing reasons win on the same line (T2), so a clipped line reported as prefix or edge is caught.
          if (!hit((f) => f.kind === "truncated" && f.reason === "pseudo-cut")) {
            if (hit((f) => f.kind === "truncated")) tally.cut.other_reason++;
            else { tally.cut.fn++; misses.push(`${set.id}/${sc.name} missed ${it.expect} ${JSON.stringify(it.text)}`); }
          }
        } else if (it.expect === "cut-ellipsis") { tally.ellipsis.seeded++; if (hit((f) => f.kind === "truncated")) tally.ellipsis.found++; }
        else if (/^hardcoded-/.test(it.expect)) { if (!hit((f) => f.kind === "hardcoded")) { tally.hardcoded.fn++; misses.push(`${set.id}/${sc.name} missed ${it.expect} ${JSON.stringify(it.text)}`); } }
        else if (it.expect === "raw-key") { tally.raw_key.seeded++; if (hit((f) => f.kind === "raw-key")) tally.raw_key.found++; }
        else if (it.expect === "placeholder") { tally.placeholder.seeded++; if (hit((f) => f.kind === "placeholder")) tally.placeholder.found++; }
      }
    }
  }
  const pr = (x) => ({ precision: ratio(x.tp, x.tp + x.fp), recall: ratio(x.tp, x.tp + x.fn), tp: x.tp, fp: x.fp, fn: x.fn });
  // The gate's recall counts pseudo-cut findings only; a cut caught by an earlier reason (which wins on its line)
  // is published beside it as recall_any_reason.
  const prCut = (x) => ({ precision: ratio(x.tp, x.tp + x.fp), recall: ratio(x.tp, x.tp + x.other_reason + x.fn), recall_any_reason: ratio(x.tp + x.other_reason, x.tp + x.other_reason + x.fn) });
  const m = {
    roundtrip: { ...tally.roundtrip, share: ratio(tally.roundtrip.matched, tally.roundtrip.lines) },
    pseudo_cut: { ...prCut(tally.cut), tp: tally.cut.tp, fp: tally.cut.fp, fn: tally.cut.fn, pseudo_cut_findings: tally.cut.tp, caught_by_other_reason: tally.cut.other_reason, lost_or_side_wrong: tally.cut.lost_or_side_wrong,
      note: "recall: seeded clip cuts reported as pseudo-cut; recall_any_reason adds those an earlier reason (ellipsis, prefix, edge, overflow, screen-edge) reported first; precision over pseudo-cut findings" },
    ellipsis_cuts: { ...tally.ellipsis, note: "seeded ellipsis cuts; the existing ellipsis reason wins on the line" },
    hardcoded: { ...pr(tally.hardcoded), evidence_wrong: tally.hardcoded.evidence_wrong },
    ...Object.fromEntries([["raw_key", tally.raw_key], ["placeholder", tally.placeholder]]),
    pseudo_not_applied: tally.not_applied,
    clean_screens: tally.clean_screens, false_per_100_clean: ratio(tally.clean_false * 100, tally.clean_screens),
    eligible: { ...tally.eligible, share: ratio(tally.eligible.judged, tally.eligible.lines) },
  };
  const drops = [];
  if (!(m.roundtrip.share >= GATE.roundtrip)) drops.push(`roundtrip ${m.roundtrip.share} < ${GATE.roundtrip}`);
  for (const k of ["pseudo_cut", "hardcoded"]) for (const q of ["precision", "recall"]) {
    const g = GATE[k === "pseudo_cut" ? "cut" : k][q];
    if (!(m[k][q] >= g)) drops.push(`${k} ${q} ${m[k][q]} < ${g}`);
  }
  if (!(m.false_per_100_clean <= GATE.false_per_100_clean)) drops.push(`false findings per 100 clean screens ${m.false_per_100_clean} > ${GATE.false_per_100_clean}`);
  if (m.pseudo_not_applied.found < m.pseudo_not_applied.seeded || m.pseudo_not_applied.false > 0) drops.push("pseudo-not-applied missed or false");
  if (SCREENS !== GATE_SCREENS || m.pseudo_not_applied.seeded === 0) drops.push(`smoke run: ${SCREENS} screens per catalog, the gate needs ${GATE_SCREENS}`);
  const v = versionInfo();
  let xcode = null;
  try { xcode = execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }).split("\n").filter(Boolean).join(" "); } catch {}
  const result = {
    todo: "039", part: "T2", script: "bench/pseudo.js", seed: "bench/pseudo/seed.json", generator: "bench/pseudo/generate.swift", dynamic: "bench/pseudo/dynamic.txt",
    catalogs: sets.length, screens_per_catalog: SCREENS, screens: sets.length * SCREENS, gate: GATE, metrics: m, drops, misses,
    fonts: [...new Set(sets.flatMap((s) => s.fonts))].sort(),
    tools: { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version, xcode },
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = drops.length ? 1 : 0;
})();
