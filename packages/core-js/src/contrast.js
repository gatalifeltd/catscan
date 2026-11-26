// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-054: `catscan contrast`. The core measures ink and background per Vision line (Contrast.swift); this module
// validates the options, gates the kinds (D9, D28), resolves the device scale chain (D6), words the fix (D23) and
// builds the run's summary line (D25, D29).

const KINDS = ["low-contrast", "busy-background"];
const LEVELS = ["AA", "AAA"];
// D28: which kind passed its gate in which input mode; set by the T3 measurement (results/contrast.json,
// results/contrast-real.json) and changed only with a release. Every kind is experimental until a row says true.
const CONTRAST_GATED = Object.freeze({
  "low-contrast": Object.freeze({ boxes: false, "no-boxes": false }),
  "busy-background": Object.freeze({ boxes: false, "no-boxes": false }),
});
const SCALE_SOURCES = ["flag", "boxes", "size-table", "page", "none"];
const BUSY_FIX = "put the text on a solid or scrimmed panel";

function usage(code, message, hint) {
  const { UsageError } = require("./args"); // lazy: args requires this module
  return new UsageError(code, message, hint);
}

/** Options of `contrast` (D10, D27, D28); called from args.validate. */
function validate(o) {
  if (o.level !== null) {
    if (o.command !== "contrast") throw usage("option-not-valid", "--level works only with contrast", "catscan contrast shots/de --level AAA --experimental");
    const up = String(o.level).toUpperCase();
    if (!LEVELS.includes(up)) throw usage("invalid-level", `--level must be AA or AAA, not ${o.level}`, "--level AA");
    o.level = up;
  }
  if (o.scale !== null) {
    if (o.command !== "contrast") throw usage("option-not-valid", "--scale works only with contrast", "catscan contrast shots/de --scale 3 --experimental");
    const n = /^(\d+(\.\d*)?|\.\d+)$/.test(o.scale) ? Number(o.scale) : NaN;
    if (!(n >= 1 && n <= 4)) throw usage("invalid-scale", `--scale takes the device pixel ratio, a number from 1 to 4, not ${o.scale}`, "--scale 3");
    o.scale = n;
  }
  if (o.command !== "contrast") return;
  if (o.kinds !== null) {
    const list = String(o.kinds).split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) throw usage("unknown-kind", "--kinds needs at least one kind", `--kinds ${KINDS.join(",")}`);
    for (const k of list) {
      if (!KINDS.includes(k)) {
        const { closest } = require("./args");
        const s = closest(k, KINDS);
        throw usage("unknown-kind", `--kinds: unknown kind ${k}${s ? `; did you mean ${s}?` : ""}`, `--kinds ${KINDS.join(",")}`);
      }
    }
    o.kinds = [...new Set(list)];
  }
  if (o.help || o.experimental) return;
  const blocked = gateError(o.kinds || KINDS, o.boxes !== null);
  if (blocked) throw blocked;
}

/** D28: the usage error for the first selected kind that has not passed its gate in this input mode; null if none. */
function gateError(kinds, withBoxes, gated = CONTRAST_GATED) {
  const mode = withBoxes ? "boxes" : "no-boxes";
  const k = kinds.find((x) => !gated[x][mode]);
  if (!k) return null;
  const other = gated[k][withBoxes ? "no-boxes" : "boxes"];
  const where = withBoxes ? "with --boxes" : "without --boxes";
  const rerun = !withBoxes && other ? "rerun with --experimental, or give --boxes <dir> (it passed with boxes)"
    : withBoxes && other ? "rerun with --experimental, or drop --boxes (it passed without boxes)" : "rerun with --experimental";
  return usage("experimental-command", `${k} ${where} has not passed its gate (docs/BENCHMARKS.md#contrast); ${rerun}`,
    !withBoxes && other ? "catscan contrast shots/ --boxes shots/" : "catscan contrast shots/ --experimental");
}

// D6, D31: exact iOS screenshot sizes from TODO-073's measured device profiles (both orientations); a size two
// profiles disagree on gives no scale.
let sizeTable = null;
function iosScale(width, height) {
  if (!sizeTable) {
    sizeTable = new Map();
    for (const p of require("./device-profiles.json").profiles) {
      if (p.platform !== "ios" || !p.screen || !p.screen.scale) continue;
      for (const k of [`${p.screen.width}x${p.screen.height}`, `${p.screen.height}x${p.screen.width}`]) {
        const had = sizeTable.get(k);
        sizeTable.set(k, had === undefined || had === p.screen.scale ? p.screen.scale : null);
      }
    }
  }
  return sizeTable.get(`${width}x${height}`) ?? null;
}

/** D6: flag, then the boxes sidecar's scale, then the iOS size table, else scale 1 with source none. */
function resolveScale({ flag = null, boxes = null, size = null } = {}) {
  if (flag !== null) return { scale: flag, source: "flag" };
  if (boxes && typeof boxes.scale === "number") return { scale: boxes.scale, source: "boxes" };
  const t = size ? iosScale(size.width, size.height) : null;
  if (t) return { scale: t, source: "size-table" };
  return { scale: 1, source: "none" };
}

/** Per-run request fields: `forInput(inp)` gives the `contrast` field and that input's extra warnings. */
function build(opts, list) {
  const boxes = require("./boxes");
  const untranslated = require("./untranslated");
  const forBoxes = opts.boxes !== null ? boxes.forRun(opts.boxes, list) : null;
  const allow = opts.allow ? untranslated.loadAllow(opts.allow) : null;
  let unknown = 0;
  return {
    forInput(inp) {
      const f = {};
      const warnings = [];
      if (opts.level) f.level = opts.level;
      if (opts.kinds) f.kinds = opts.kinds;
      if (allow) f.allow = allow;
      let b = null;
      if (forBoxes) {
        const r = forBoxes(inp);
        b = r.boxes;
        if (b) f.boxes = b;
        else if (r.looked) {
          warnings.push({ code: "boxes-missing", message: `no boxes for ${inp.stdin ? "-" : inp.path}${r.looked !== "-" ? ` (looked for ${r.looked})` : ""}; disabled and covered text not skipped`, hint: `catscan boxes <source> <dump> --image ${inp.stdin ? "<screen.png>" : inp.path} > ${r.looked !== "-" ? r.looked : "<screen.boxes.json>"}` });
        }
      }
      let size = null;
      if (opts.scale === null && !inp.stdin) {
        try { size = boxes.imageSize(inp.path); } catch { size = null; }
      }
      // The sidecar's scale is per point of the image it was made with; a resized screenshot of the same screen
      // (same aspect, so boxes still match) has its own (red-team review, TODO-054 PR 1).
      let bs = b && typeof b.scale === "number" ? b.scale : null;
      if (bs !== null && size && b.image && b.image.width > 0 && size.width !== b.image.width) {
        bs = Math.min(4, Math.max(1, Math.round((bs * size.width / b.image.width) * 100) / 100));
      }
      const s = resolveScale({ flag: opts.scale, boxes: bs !== null ? { scale: bs } : null, size });
      if (s.source === "none") unknown++;
      f.scale = s.scale;
      f.scale_source = s.source;
      return { field: f, warnings };
    },
    /** D24: once per run, kept under --quiet. */
    runWarnings() {
      if (!unknown) return [];
      return [{
        code: "contrast-scale-unknown",
        message: `the device scale of ${unknown} image${unknown === 1 ? "" : "s"} is unknown (not an iOS screenshot size, no --scale), so text size is judged at scale 1 and only large-text thresholds can fail`,
        hint: "--scale 3 (iOS: the screen's @2x or @3x; Android: adb shell wm density / 160)",
      }];
    },
  };
}

// sRGB helpers (WCAG 2.x relative luminance).
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const toHex = (c) => "#" + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratioOf = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * D23: the nearest ink of the same hue that passes `threshold` against `background`: the ink blended toward black
 * when it is darker than the background (toward white when lighter), the smallest blend whose rounded hex passes.
 * Tries the other direction when one cannot reach it; null when neither can.
 */
function suggest(ink, background, threshold) {
  const c = rgb(ink), bg = lum(rgb(background));
  const darker = lum(c) <= bg;
  for (const towardBlack of darker ? [true, false] : [false, true]) {
    const at = (m) => c.map((v) => (towardBlack ? v * (1 - m) : v + (1 - v) * m));
    const passes = (m) => ratioOf(lum(rgb(toHex(at(m)))), bg) >= threshold;
    if (!passes(1)) continue;
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (passes(m)) hi = m; else lo = m; }
    return toHex(at(hi));
  }
  return null;
}

/** Adds `suggest` to every low-contrast finding (JSON and text alike). */
function enrich(env) {
  for (const f of env.findings || []) {
    if (f.kind === "low-contrast" && f.ink && f.background && typeof f.threshold === "number") f.suggest = suggest(f.ink, f.background, f.threshold);
  }
}

const SKIPS = ["too-small", "no-ink", "not-text", "allow", "disabled", "covered"];

/**
 * D25, D29: `contrast: 12 low-contrast, 3 busy-background on 5 of 40 screens; worst 1.90:1 "Best 99" (de/settings.png);
 * 7 lines not measured (3 too-small, 4 not-text)`.
 */
function summary(envs) {
  const n = { "low-contrast": 0, "busy-background": 0 };
  const skipped = Object.fromEntries(SKIPS.map((k) => [k, 0]));
  let screens = 0, worst = null, uncertain = 0;
  for (const e of envs) {
    const fs = (e.findings || []).filter((f) => KINDS.includes(f.kind));
    if (fs.length) screens++;
    for (const f of fs) {
      n[f.kind]++;
      if (f.kind === "low-contrast" && (!worst || f.ratio < worst.ratio)) worst = { ratio: f.ratio, line: f.line, path: e.path };
    }
    for (const l of e.lines || []) {
      if (l.contrast?.skipped) skipped[l.contrast.skipped] = (skipped[l.contrast.skipped] || 0) + 1;
      else if (l.contrast?.uncertain) uncertain++;
    }
  }
  const parts = [`contrast: ${n["low-contrast"]} low-contrast, ${n["busy-background"]} busy-background on ${screens} of ${envs.length} screen${envs.length === 1 ? "" : "s"}`];
  if (worst) parts.push(`worst ${worst.ratio.toFixed(2)}:1 ${JSON.stringify(worst.line)} (${String(worst.path).replace(/[\x00-\x1f]/g, "?")})`); // a control character could start a CI workflow line
  const notMeasured = Object.values(skipped).reduce((a, b) => a + b, 0);
  if (notMeasured) parts.push(`${notMeasured} line${notMeasured === 1 ? "" : "s"} not measured (${SKIPS.filter((k) => skipped[k]).map((k) => `${skipped[k]} ${k}`).join(", ")})`);
  if (uncertain) parts.push(`${uncertain} line${uncertain === 1 ? "" : "s"} uncertain (two ink colours or a weak split; not judged)`);
  return parts.join("; ");
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : String(v));

/** The text line of a finding (spec "Outputs"; D23 fix). */
function detail(f, at) {
  if (f.kind === "busy-background") return `  busy-background ${JSON.stringify(f.line)} (edges ${f.edges.toFixed(2)} around the line)${at}; fix: ${BUSY_FIX}`;
  const fix = f.suggest ? `; fix: ink ${f.suggest} or ${lum(rgb(f.suggest)) <= lum(rgb(f.background)) ? "darker" : "lighter"}` : "";
  return `  low-contrast ${JSON.stringify(f.line)} ${f.ratio.toFixed(2)}:1 < ${fmt(f.threshold)}:1 (${f.size}, ink ${f.ink} on ${f.background})${at}${fix}`;
}

module.exports = { KINDS, LEVELS, CONTRAST_GATED, SCALE_SOURCES, BUSY_FIX, validate, gateError, iosScale, resolveScale, build, suggest, enrich, summary, detail, ratioOf, lum, rgb };
