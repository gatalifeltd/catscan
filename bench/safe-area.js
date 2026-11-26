#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-073 "Measurement": the `fit` gate (D9) per reason and per target (text, controls).
//   synthetic: bench/safe-area/generate.swift draws screens at the exact size of shipped profiles (portrait and both
//     landscapes, 13 locales, plain, gradient and noise backgrounds) with a label and an icon button pushed 1 to 16 px
//     of ink into, or 2 to 8 px short of, a zone. Truth: a line is positive when half of one letter's or digit's
//     glyph rect lies in the zone; an icon when a quarter of its padded box does. Predictions run the normal path
//     (`catscan fit --json --boxes`), so they measure Vision's character boxes. Dev and held-out halves by seed.
//   real: every lab screenshot of a profile size, run with and without its reconverted sidecar; every flag is listed
//     for hand review by a hash of its path (a flag that shows a real defect is a find, not a false alarm).
//   rendered: screens of the probe app on simulators, from bench/safe-area/rendered.mjs (--rendered <dir>).
//
//   node bench/safe-area.js [--keep <dir>] [--real <dir>[=<profile id>]]... [--rendered <file>] [--reviewed <file>] > results/safe-area.json
// Exits 1 below the gate.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const { versionInfo } = require("../packages/core-js/src/client");
const { rng, wilson } = require("./overlap/elements-lib");
const TABLE = require("../packages/core-js/src/device-profiles.json");
const S = require("./untranslated/strings.json");

const ROOT = path.join(__dirname, "..");
const SEED = 73;
const REASONS = ["cutout", "corner", "home-indicator"];
// Ink past the zone's edge (negative: short of it). 24 and 32 add positives past half a glyph or a quarter icon.
const DEPTHS = [1, 2, 4, 8, 16, 24, 32, -2, -4, -8];
// The grown handle zone ends about 16 px above the screen edge: 32 px of ink there puts the line's box at the edge,
// which step 4 leaves to `truncated`, so the home items stop at 24 (20 in 32's place).
const HOME_DEPTHS = [1, 2, 4, 8, 16, 24, 20, -2, -4, -8];
const LOCALES = Object.keys(S.locales);
const BACKGROUNDS = ["plain", "gradient", "noise"];
// Profiles drawn: island, notch, iPad and a zone-less phone (D24: iOS has no home-indicator zone); the shared-size
// iPhones (12, 13, 14) are scored again under the D3 intersection.
const SYNTH = ["iphone-17-pro", "iphone-14", "ipad-pro-13-inch-m5", "iphone-se-3rd-generation"];
const SHARED = ["iphone-12", "iphone-13", "iphone-14"];
// PR 2 (D28): two Android punch-holes with the gesture handle; drawn after every iOS shot, so the iOS shots, their
// seeds and halves are the ones PR 1 measured.
const ANDROID = ["pixel-9", "pixel-9-pro-xl"];
const GATE = { precision: 0.95, recall: 0.9, rendered: 0.9, realText: 1, realControls: 2 };

const PROFILES = [...SYNTH, ...SHARED.filter((x) => !SYNTH.includes(x)), ...ANDROID];

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const args = (k) => process.argv.flatMap((a, i) => (a === k ? [process.argv[i + 1]] : []));
const profile = (id) => TABLE.profiles.find((p) => p.id === id);

// ---- zones as pixel masks in an orientation (mirrors Fit.layout) ------------------------------------------------

function mask(p, o, kinds) {
  const land = o !== "portrait", W = land ? p.screen.height : p.screen.width, H = land ? p.screen.width : p.screen.height;
  const m = new Uint8Array(W * H);
  // Rule step 1: the home indicator box grown by its own height on each side; stored per orientation.
  const home = kinds.includes("home-indicator") ? (land ? p.landscape?.["home-indicator"]?.box : p.zones.find((z) => z.kind === "home-indicator")?.box) : null;
  if (home) {
    const g = home[3];
    for (let y = Math.max(0, home[1] - g); y < Math.min(H, home[1] + home[3] + g); y++) for (let x = Math.max(0, home[0] - g); x < Math.min(W, home[0] + home[2] + g); x++) m[y * W + x] = 1;
  }
  for (const z of p.zones) {
    if (!kinds.includes(z.kind) || !z.runs) continue;
    for (const [y, x0, x1] of z.runs) for (let x = x0; x < x1; x++) {
      const [nx, ny] = !land ? [x, y] : o === "landscape-left" ? [y, p.screen.width - 1 - x] : [p.screen.height - 1 - y, x];
      m[ny * W + nx] = 1;
    }
  }
  return { m, W, H };
}

/** Share of a pixel rect [x, y, w, h] inside a mask. */
function share(r, { m, W, H }) {
  const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1])), x1 = Math.min(W, Math.ceil(r[0] + r[2])), y1 = Math.min(H, Math.ceil(r[1] + r[3]));
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (m[y * W + x]) n++;
  return r[2] * r[3] > 0 ? n / (r[2] * r[3]) : 0;
}

function bbox({ m, W, H }) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** The last hidden pixel along a corner's diagonal, from the corner inwards. */
function diagonal(cm, corner) {
  const { m, W, H } = cm;
  let t = 0;
  for (let k = 0; k < Math.min(W, H) / 2; k++) {
    const x = corner.includes("l") ? k : W - 1 - k, y = corner.includes("t") ? k : H - 1 - k;
    if (m[y * W + x]) t = k + 1; else break;
  }
  return t;
}

/** The zone's edge on row y, met from the left (`fromLeft`) or the right: the first hidden x, or the end of the last run. */
function edge({ m, W }, y, fromLeft, x0 = 0, x1 = W) {
  if (fromLeft) { for (let x = x0; x < x1; x++) if (m[y * W + x]) return x; return null; }
  for (let x = x1 - 1; x >= x0; x--) if (m[y * W + x]) return x + 1;
  return null;
}

/** Rows of one corner's zone: how far it reaches from the top or bottom edge. */
function cornerRows({ m, W, H }, top) {
  let n = 0;
  for (let k = 0; k < H / 2; k++) { const y = top ? k : H - 1 - k; if (m[y * W] || m[y * W + W - 1]) n = k + 1; else break; }
  return n;
}

// ---- plan ---------------------------------------------------------------------------------------------------

const usable = (t) => t && !/[{}%]/.test(t);
const texts = (loc) => S.locales[loc].filter(usable);

function plan() {
  const r = rng(SEED);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const shots = [];
  let n = 0;
  for (const id of PROFILES) {
    const p = profile(id);
    if (!p) throw new Error(`profile ${id} is not in the table; run bench/devices/${ANDROID.includes(id) ? "android" : "ios"}-profiles.mjs`);
    const shared = SHARED.includes(id) && !SYNTH.includes(id);
    for (const o of ["portrait", "landscape-left", "landscape-right"]) {
      const cut = mask(p, o, ["cutout"]), cor = mask(p, o, ["corner"]);
      const cb = bbox(cut);
      const W = cut.W, H = cut.H, px = p.screen.scale || 3;
      for (const loc of shared ? LOCALES.slice(0, 4) : LOCALES) {
        for (const bg of shared ? ["plain"] : BACKGROUNDS) {
          const seed = n++;
          const depth = DEPTHS[seed % DEPTHS.length], depth2 = DEPTHS[(seed + 3) % DEPTHS.length], depth3 = DEPTHS[(seed + 5) % DEPTHS.length];
          const size = Math.round((15 + r() * 6) * px), items = [];
          // A body line in the middle: real screens have text away from the zones.
          items.push({ id: "body", text: pick(texts(loc)), size, centerX: W / 2, centerY: H / 2 });
          if (cb) {
            // The cutout, met along its middle row from the screen's inner side: the ink ends `depth` px past its edge.
            const t = pick(texts(loc).filter((x) => x.length <= 18));
            const cy = Math.round((cb.y0 + cb.y1) / 2);
            if (o === "landscape-left") items.push({ id: "cutout", text: t, size, left: edge(cut, cy, false) - depth, centerY: cy, depth, zone: "cutout" });
            else items.push({ id: "cutout", text: t, size, right: edge(cut, cy, true) + depth, centerY: cy, depth, zone: "cutout" });
            // Status-bar-like text beside the cutout (a negative) on portrait screens.
            if (o === "portrait") items.push({ id: "status", text: "9:41", size: Math.round(size * 0.9), left: cb.x1 + 3 * px + 20, centerY: cy, depth: -20, zone: "cutout" });
          }
          // A short label in a bottom corner and an icon button in a top corner, each met along a row a third of the
          // corner's height from the screen edge (off the edge, so the screen-edge skip does not apply).
          const tc = seed % 2 ? "bl" : "br", ic = seed % 2 ? "tr" : "tl";
          const rb = cornerRows(cor, false), rt = cornerRows(cor, true);
          if (rb > 6) {
            const y = H - 1 - Math.round(rb * 0.35), short = texts(loc).filter((x) => x.length <= 8);
            const it = { id: "corner", text: pick(short.length ? short : texts(loc)), size, centerY: y, depth: depth2, zone: "corner" };
            if (tc === "bl") it.left = edge(cor, y, false, 0, W >> 1) - depth2; else it.right = edge(cor, y, true, W >> 1, W) + depth2;
            items.push(it);
          }
          if (rt > 6) {
            const y = Math.round(rt * 0.35), s2 = Math.round(30 * px);
            const it = { id: "icon", text: null, size: s2, centerY: y + s2 / 4, depth: depth3, zone: "corner" };
            if (ic === "tl") it.left = edge(cor, y, false, 0, W >> 1) - depth3; else it.right = edge(cor, y, true, W >> 1, W) + depth3;
            items.push(it);
          }
          // The home indicator (Android, D24): a short label over one half of the handle (ink starting or ending at
          // the screen's center, away from the bottom-corner label) or a small icon button at the handle's other end,
          // `depth` px into the grown zone from above. One of the two per screen, alternating by seed pairs so both
          // halves get both: Vision joins a label and an icon on one row into one line ("Premium •"), and a joined
          // box reached the screen edge (step 4). Their own generator, so the shots above draw exactly as in PR 1.
          const hb = bbox(mask(p, o, ["home-indicator"]));
          if (hb) {
            const hr = rng(SEED * 1000 + seed), short = texts(loc).filter((x) => x.length <= 8), pool = short.length ? short : texts(loc);
            const d4 = HOME_DEPTHS[(seed + 1) % HOME_DEPTHS.length], s3 = Math.round(16 * px);
            if (Math.floor(seed / 2) % 2 === 0) items.push({ id: "home", text: pool[Math.floor(hr() * pool.length)], size, ...(tc === "bl" ? { left: W / 2 } : { right: W / 2 }), bottom: hb.y0 + d4, depth: d4, zone: "home-indicator" });
            else items.push({ id: "home-icon", text: null, size: s3, ...(tc === "bl" ? { right: hb.x1 } : { left: hb.x0 }), bottom: hb.y0 + d4, depth: d4, zone: "home-indicator" });
          }
          shots.push({ name: `${id}-${o}-${loc}-${bg}-${seed}`, profile: id, orientation: o, locale: loc, width: W, height: H, background: bg, seed, shared, half: seed % 2 ? "held_out" : "dev", items });
        }
      }
    }
  }
  return shots;
}

// ---- truth --------------------------------------------------------------------------------------------------

const letter = (ch) => /[\p{L}\p{N}]/u.test(ch);

/** The reason a truth item is hidden by, or null: text by its glyphs (half a glyph), an icon by its padded box. */
function truthOf(item, t, p, o, box) {
  for (const k of REASONS) {
    const z = mask(p, o, [k]);
    if (item.text) {
      if (t.glyphs.some((g) => letter(g.ch) && share(g.rect, z) >= 0.5)) return k;
    } else if (box && share(box, z) >= 0.25) return k;
  }
  return null;
}

// ---- runs ---------------------------------------------------------------------------------------------------

function catscan(argv) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin/catscan.js"), ...argv], { encoding: "utf8", maxBuffer: 512 << 20 });
  // 4: an image could not be read (a Vision timeout under load); its envelope says so and it is counted as errored.
  if (![0, 1, 4].includes(r.status)) throw new Error(`catscan ${argv.join(" ")} exited ${r.status}: ${r.stderr.slice(0, 2000)}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const ratio = (a, b) => (b ? Math.round((a / b) * 10000) / 10000 : null);
function cell() { return { tp: 0, fp: 0, fn: 0, small_tp: 0, small_fn: 0 }; }
function close(c) {
  return { ...c, precision: ratio(c.tp, c.tp + c.fp), recall: ratio(c.tp, c.tp + c.fn), recall_ci: c.tp + c.fn ? wilson(c.tp, c.tp + c.fn).map((x) => Math.round(x * 1000) / 1000) : null, small_recall: ratio(c.small_tp, c.small_tp + c.small_fn) };
}

function synthetic(keep) {
  const dir = keep || fs.mkdtempSync(path.join(os.tmpdir(), "catscan-safe-area-"));
  const shots = plan();
  const bin = path.join(ROOT, ".build/safe-area-gen");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  execFileSync("swiftc", ["-O", path.join(__dirname, "safe-area/generate.swift"), "-o", bin]);
  const groups = new Map();
  for (const s of shots) {
    const g = `${s.profile}-${s.orientation}${s.shared ? "-shared" : ""}`;
    (groups.get(g) || groups.set(g, []).get(g)).push(s);
  }
  const score = { dev: {}, held_out: {}, shared: {} };
  const examples = [];
  for (const [g, list] of groups) {
    const gdir = path.join(dir, g);
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, "plan.json"), JSON.stringify(list));
    execFileSync(bin, [path.join(gdir, "plan.json"), gdir]);
    const s0 = list[0];
    // The shared-size set matches by size (D3 intersection); the rest names its profile, as a user would.
    const argv = ["fit", gdir, "--json", "--experimental", "--boxes", gdir, "--orientation", s0.orientation, ...(s0.shared ? [] : ["--device-profile", s0.profile])];
    const envs = catscan(argv);
    const byName = new Map(envs.map((e) => [path.basename(e.path, ".png"), e]));
    for (const s of list) {
      const env = byName.get(s.name);
      if (!env || env.verdict === "error") throw new Error(`${s.name}: ${env ? JSON.stringify(env.error) : "no result"}`);
      const truth = JSON.parse(fs.readFileSync(path.join(gdir, `${s.name}.truth.json`), "utf8"));
      const boxes = JSON.parse(fs.readFileSync(path.join(gdir, `${s.name}.boxes.json`), "utf8"));
      const p = profile(s.profile);
      const bucket = s.shared ? score.shared : score[s.half];
      const found = new Map((env.findings || []).map((f) => [f.element?.id ?? `?${f.line}`, f]));
      for (const it of s.items) {
        const t = truth.find((x) => x.id === it.id);
        const el = boxes.elements.find((e) => e.id === it.id);
        const box = el ? [el.box[0] * s.width, el.box[1] * s.height, el.box[2] * s.width, el.box[3] * s.height] : null;
        // Truth under the profile the run used: the shared set's intersection hides only what all of them hide.
        const want = s.shared ? sharedTruth(it, t, s.orientation, box) : truthOf(it, t, p, s.orientation, box);
        const f = found.get(it.id);
        found.delete(it.id);
        const target = it.text ? "text" : "controls";
        if (!want && !f) continue;
        const reason = want || f.reason;
        const c = (bucket[`${reason}/${target}`] ||= cell());
        const deep = Math.abs(it.depth ?? 99) >= 4;
        if (want && f) { if (deep) c.tp++; else c.small_tp++; }
        else if (want && !f) { if (deep) c.fn++; else c.small_fn++; if (examples.length < 40) examples.push({ miss: s.name, item: it.id, depth: it.depth }); }
        else if (!want && f) { c.fp++; if (examples.length < 40) examples.push({ false_alarm: s.name, item: it.id, depth: it.depth, hidden: f.hidden }); }
      }
      for (const f of found.values()) { const c = (bucket[`${f.reason}/${f.line === null ? "controls" : "text"}`] ||= cell()); c.fp++; }
    }
  }
  for (const b of Object.values(score)) for (const k of Object.keys(b)) b[k] = close(b[k]);
  return { shots: shots.length, by_profile: PROFILES, score, examples };
}

/** D3: pixels hidden on every shared-size profile. */
function sharedTruth(it, t, o, box) {
  const ps = SHARED.map(profile);
  for (const k of REASONS) {
    const zs = ps.map((p) => mask(p, o, [k]));
    const z = { ...zs[0], m: zs[0].m.map((v, i) => (zs.every((q) => q.m[i]) ? 1 : 0)) };
    if (it.text ? t.glyphs.some((g) => letter(g.ch) && share(g.rect, z) >= 0.5) : box && share(box, z) >= 0.25) return k;
  }
  return null;
}

// ---- real negatives -----------------------------------------------------------------------------------------

/**
 * Every screenshot of a real set: with its sidecar reconverted for `control`, and without boxes (D8). `<dir>=<id>`
 * runs the set with that profile (Android: only the emulator definition that took it, D10).
 */
function real(dirs) {
  const out = { screens: 0, matched: 0, unmatched: 0, zoneless: 0, flags: { with_boxes: [], without_boxes: [] } };
  for (const spec of dirs) {
    const [d, named] = spec.split("=");
    const flag = named ? ["--device-profile", named] : [];
    const pngs = [];
    const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); if (e.isDirectory()) walk(f); else if (/\.png$/i.test(e.name)) pngs.push(f); } };
    walk(d);
    out.screens += pngs.length;
    // Reconverted sidecars in a scratch tree that mirrors the set (D8: `control`, `scrolls` from the dumps).
    const side = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-safe-area-real-"));
    let withSide = 0;
    for (const png of pngs) {
      const base = png.replace(/\.png$/i, ""), rel = path.relative(d, base);
      const src = [[".xcui.txt", "xcuitest"], [".uia.xml", "uiautomator"], [".maestro.json", "maestro"]].find(([e]) => fs.existsSync(base + e));
      if (!src) continue;
      const r = spawnSync(process.execPath, [path.join(ROOT, "bin/catscan.js"), "boxes", src[1], base + src[0], ...(src[1] === "xcuitest" ? [] : ["--image", png])], { encoding: "utf8" });
      if (r.status !== 0) continue;
      fs.mkdirSync(path.dirname(path.join(side, rel)), { recursive: true });
      fs.writeFileSync(path.join(side, rel + ".boxes.json"), r.stdout);
      withSide++;
    }
    for (const [mode, extra] of [["with_boxes", ["--boxes", side]], ["without_boxes", []]]) {
      if (mode === "with_boxes" && !withSide) continue;
      const envs = catscan(["fit", d, "--json", "--experimental", ...flag, ...extra]);
      for (const e of envs) {
        if (e.verdict === "error") { out.errors = (out.errors || 0) + 1; continue; }
        if (mode === "without_boxes") {
          if (!e.device_profile) out.unmatched++;
          else if (!e.reasons_run.length) out.zoneless++;
          else out.matched++;
        }
        // A screen is named by a hash of its path inside the set: lab paths can name a product (nothing proprietary in git).
        for (const f of e.findings || []) out.flags[mode].push({ path: crypto.createHash("sha256").update(path.relative(d, e.path)).digest("hex").slice(0, 12), profile: f.profile, reason: f.reason, target: f.line === null ? "controls" : "text", box: f.box });
      }
      if (mode === "with_boxes") out.with_boxes_screens = (out.with_boxes_screens || 0) + withSide;
    }
  }
  return out;
}

/**
 * D9 per reason and target. A part passes only with every leg measured: synthetic precision and recall on held-out
 * positives, rendered recall on at least 30 positives, and the real false-alarm rate. Real negatives alone measure
 * nothing (no positives), so such a part is `measured: false`. Hand review (spec 06 D43): flags listed in the reviewed
 * file (by path hash, reason and target) are finds, not false alarms.
 */
function verdictOf(result, reviewed) {
  const verdict = {};
  for (const target of ["text", "controls"]) {
    for (const reason of REASONS) {
      const key = `${reason}/${target}`;
      const c = result.synthetic.score.held_out[key];
      const r = { synthetic: c && c.tp + c.fn ? { precision: c.precision, recall: c.recall, n: c.tp + c.fn, flags: c.tp + c.fp } : null };
      const x = result.rendered?.[key];
      if (x) r.rendered = { n: x.n, tp: x.tp, recall: x.recall, recall_ci: x.recall_ci };
      if (result.real) {
        const fl = result.real.flags.with_boxes.concat(target === "text" ? result.real.flags.without_boxes : []).filter((f) => f.reason === reason && f.target === target);
        const fa = fl.filter((f) => !reviewed.finds.some((y) => y.path === f.path && y.reason === f.reason && y.target === f.target));
        const per100 = result.real.matched ? (100 * fa.length) / result.real.matched : null;
        r.real = { matched: result.real.matched, flags: fl.length, false_alarms: fa.length, per_100: per100 === null ? null : Math.round(per100 * 100) / 100 };
      }
      r.measured = Boolean(r.synthetic || r.rendered);
      r.pass = r.measured && Boolean(r.synthetic && r.synthetic.precision >= GATE.precision && r.synthetic.recall >= GATE.recall)
        && Boolean(r.rendered && r.rendered.n >= 30 && r.rendered.recall >= GATE.rendered)
        && Boolean(r.real && r.real.per_100 !== null && r.real.per_100 <= (target === "text" ? GATE.realText : GATE.realControls));
      verdict[key] = r;
    }
  }
  return verdict;
}

function main() {
  // --rescore <file>: recompute the verdict of a saved run (the gate or the hand review changed, the reads did not).
  if (arg("--rescore")) {
    const r = JSON.parse(fs.readFileSync(arg("--rescore"), "utf8"));
    r.verdict = verdictOf(r, arg("--reviewed") ? JSON.parse(fs.readFileSync(arg("--reviewed"), "utf8")) : { finds: [] });
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    if (Object.values(r.verdict).some((x) => x.measured && !x.pass)) process.exitCode = 1;
    return;
  }
  const keep = arg("--keep");
  const v = versionInfo();
  const tool = (c, a) => { try { return execFileSync(c, a, { encoding: "utf8" }).trim().split("\n")[0]; } catch { return null; } };
  const result = {
    script: "bench/safe-area.js",
    seed: SEED,
    profile_table: TABLE.version,
    tools: { catscan: v.catscan, macos: v.macos, vision_revision: v.vision_revision, xcode: tool("xcodebuild", ["-version"]), swift: tool("swift", ["--version"]), node: process.version },
    gate: GATE,
  };
  result.synthetic = synthetic(keep);
  const realDirs = args("--real");
  if (realDirs.length) result.real = real(realDirs);
  const rendered = arg("--rendered");
  if (rendered) result.rendered = JSON.parse(fs.readFileSync(rendered, "utf8"));
  result.verdict = verdictOf(result, arg("--reviewed") ? JSON.parse(fs.readFileSync(arg("--reviewed"), "utf8")) : { finds: [] });
  result.digest = crypto.createHash("sha256").update(JSON.stringify(result.synthetic.score)).digest("hex").slice(0, 16);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (Object.values(result.verdict).some((x) => x.measured && !x.pass)) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { plan, mask, share, truthOf, diagonal, edge, cornerRows, real };
