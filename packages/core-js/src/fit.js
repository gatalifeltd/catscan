// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// `catscan fit` (TODO-073): profile, orientation, boxes and reasons in, the core's `fit` request field out. The core
// matches each image to a profile by size and runs the rule; this module resolves flags and labels and words the
// run-level diagnostics (D16, D18).
const crypto = require("crypto");
const path = require("path");
const { UsageError, closest, LOCALE_RE } = require("./args");
const catalog = require("./catalog");
const boxes = require("./boxes");
const profiles = require("./device-profiles");
const { sizeOf, byTextSize, parseLayout } = require("./results");
const { loadAllow } = require("./untranslated");
const results = require("./results");
const registry = require("./findings-registry.json");

// The core's Fit.reasons, in rule order (step 5); SafeAreaTests sends each.
const ZONES = ["cutout", "corner", "home-indicator"];
// TODO-074: the wrap reasons (Wrapping.reasons) need element boxes and no device profile.
const WRAP = ["wrapped", "orphan"];
const REASONS = [...ZONES, ...WRAP];
// TODO-074 D7 (owner): orphan runs only when named in --reasons.
const OPT_IN = ["orphan"];
// TODO-074 D20: the wrapped evidence types that passed their gate (docs/BENCHMARKS.md#fit-wrapping); the others run
// only with --experimental, named once per run by fit-experimental.
const EVIDENCE = ["declared", "base", "control"];
const EVIDENCE_GATED = ["declared", "base", "control"];
const ORIENTATIONS = ["portrait", "landscape-left", "landscape-right"];
// D9, D37: controls have their own gate per zone (docs/BENCHMARKS.md#fit): corner passed; no set measured a control
// under the cutout or the home indicator, so those run only with --experimental.
const CONTROLS_GATED = ["corner"];

/** D9: reasons whose Vision row missed the gate run only when named in --reasons or with --experimental. */
const experimentalReasons = () => REASONS.filter((r) => registry.rows.some((x) => x.kind === "fit" && x.rule === r && x.reader === "vision" && x.experimental));

function parseReasons(v) {
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new UsageError("unknown-reason", "--reasons needs at least one reason", `--reasons ${REASONS.join(",")}`);
  for (const r of list) {
    if (!REASONS.includes(r)) {
      const s = closest(r, REASONS);
      throw new UsageError("unknown-reason", `--reasons: unknown reason ${r}${s ? `; did you mean ${s}?` : ""}`, `--reasons ${REASONS.join(",")}`);
    }
  }
  return [...new Set(list)];
}

const shellArg = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

/**
 * Loads everything before any image is read (a bad file or id is exit 2). Returns
 * { forInput(inp, device) -> { field, warnings }, runWarnings }.
 */
function build(opts, list) {
  if (opts.orientation !== null && !ORIENTATIONS.includes(opts.orientation)) {
    const s = closest(opts.orientation, ORIENTATIONS);
    throw new UsageError("invalid-orientation", `--orientation must be ${ORIENTATIONS.join(", ")}, not ${opts.orientation}`, `--orientation ${s || "landscape-left"}`);
  }
  const named = opts.reasons !== null ? parseReasons(opts.reasons) : null;
  const off = opts.experimental ? [] : experimentalReasons();
  let reasons = named ?? REASONS.filter((r) => !off.includes(r) && !OPT_IN.includes(r));
  const runWarnings = [];
  // TODO-074 D11, D16: without --boxes the wrap reasons cannot run; a default run says so and checks safe areas,
  // a --reasons list of wrap reasons alone is a usage error.
  // `boxesGiven`: the MCP server passes a boxes object, not a path.
  if (opts.boxes === null && !opts.boxesGiven && reasons.some((r) => WRAP.includes(r))) {
    const a = list.find((x) => !x.stdin);
    const hint = `catscan fit ${shellArg(a ? a.arg : "shots")} --boxes ${shellArg(a ? (a.argIsDir ? a.arg : path.dirname(a.arg)) : "shots")}`;
    const w = { code: "wrap-needs-boxes", message: "wrapped and orphan need element boxes; checked safe areas only", hint };
    if (named && named.every((r) => WRAP.includes(r))) throw new UsageError(w.code, w.message.replace("; checked safe areas only", ""), hint);
    reasons = reasons.filter((r) => !WRAP.includes(r));
    runWarnings.push(w);
  }
  // D9, D32: a reason that missed its gate runs only when named or with --experimental; with none left, say so.
  if (!reasons.length && runWarnings.length) {
    const w = runWarnings[0];
    throw new UsageError(w.code, `wrapped and orphan need element boxes, and the safe-area reasons are experimental (${off.filter((r) => ZONES.includes(r)).join(", ")})`, w.hint);
  }
  if (!reasons.length) {
    throw new UsageError("experimental-command", `fit is experimental: ${off.filter((r) => !OPT_IN.includes(r)).join(", ")} missed their gate (docs/BENCHMARKS.md#fit), so they run only with --experimental or when named in --reasons`, `catscan fit ${list[0]?.arg ?? "shots"} --experimental`);
  }
  const flag = opts.deviceProfile !== null ? profiles.resolve(opts.deviceProfile) : null;
  const allow = opts.allow ? loadAllow(opts.allow) : null;
  const zones = reasons.filter((r) => ZONES.includes(r));
  const controls = zones.filter((r) => opts.experimental || CONTROLS_GATED.includes(r));
  const ungated = zones.filter((r) => !controls.includes(r));
  const perInput = boxes.forRun(opts.boxes, list);
  const loaded = list.map((inp) => perInput(inp).boxes).filter(Boolean);
  const evidence = opts.experimental ? EVIDENCE : EVIDENCE_GATED;
  // D18: once per run, always shown, with the command that turns the missing check on.
  const argv = opts.argv || [];
  if (!zones.length) {
    // TODO-074: a wrap-only run has no zone to check textless controls in.
  } else if (!loaded.length) {
    // The sidecar folder: the folder argument, or the folder of a file argument.
    const a = list.find((x) => !x.stdin);
    const dir = a ? (a.argIsDir ? a.arg : path.dirname(a.arg)) : "shots";
    runWarnings.push({ code: "fit-controls-need-boxes", message: "no boxes: textless controls (icon buttons) were not checked, only text", hint: `catscan fit ${shellArg(a ? a.arg : "shots")} --boxes ${shellArg(dir)}` });
  } else if (ungated.length && loaded.some((b) => b.elements.some((e) => e.control))) {
    const zones = ungated.map((r) => (r === "home-indicator" ? "home indicator" : r));
    runWarnings.push({ code: "fit-experimental", message: `controls under the ${zones.join(" and ")} are experimental (not measured, docs/BENCHMARKS.md#fit) and were not checked`, hint: ["catscan", ...argv, "--experimental"].map(shellArg).join(" ") });
  }
  const demoted = EVIDENCE.filter((e) => !evidence.includes(e));
  if (reasons.includes("wrapped") && loaded.length && demoted.length) {
    runWarnings.push({ code: "fit-experimental", message: `wrapped by ${demoted.join(" and ")} evidence is experimental (missed the gate, docs/BENCHMARKS.md#fit-wrapping) and was not used`, hint: ["catscan", ...argv, "--experimental"].map(shellArg).join(" ") });
  }
  const forInput = (inp, device) => {
    const field = { reasons, controls };
    if (reasons.some((r) => WRAP.includes(r))) field.wrap = { evidence };
    if (allow) field.allow = allow;
    const label = flag ? null : profiles.forLabel(device);
    if (flag) Object.assign(field, { profile: flag.profile, matched_by: "flag", version: flag.version });
    else if (label) Object.assign(field, { profile: label, matched_by: "label", version: profiles.table().version });
    else Object.assign(field, { table: profiles.TABLE, version: profiles.table().version });
    const platform = results.platformOf(device ?? null);
    if (platform) field.platform = platform;
    const { boxes: b, looked } = perInput(inp);
    const warnings = [];
    if (b) field.boxes = b;
    // D16: an image the boxes folder has no sidecar for is checked without boxes, and says so (as truncated).
    else if (looked === "-") warnings.push({ code: "boxes-missing", message: "no boxes for - (stdin has no path to find a sidecar by); icon buttons not checked", hint: "pass the image as a file, or --boxes <file> for it" });
    else if (looked) warnings.push({ code: "boxes-missing", message: `no boxes for ${inp.path} (looked for ${looked}); icon buttons not checked`, hint: `catscan boxes <source> <dump> --image ${shellArg(inp.path)} > ${shellArg(looked)}` });
    const o = opts.orientation ?? b?.orientation ?? null;
    if (o) field.orientation = o;
    return { field, warnings };
  };
  return { forInput, runWarnings, reasons, wrap: reasons.some((r) => WRAP.includes(r)) && loaded.length > 0 };
}

const tag = (l) => String(l).toLowerCase().replace(/_/g, "-");

/**
 * TODO-074 "Base pairing" (D3, D9, D10, D13): which inputs are base-locale screens, each target's base input (same
 * `screen`, `device` and text size from --layout; TODO-084), the run-level warnings, and the catalog pairs per target
 * locale. `mapped` is the CLI's per-input { locale, screen, device, text_size }; `layout` the run's --layout pattern.
 * Returns
 * { baseLocale, roles: [{ base, baseIndex }], warnings, pairs(locale) -> { digest, entries } | null }.
 */
function wrapPlan(opts, list, mapped, layout = null) {
  const source = opts.catalogs.map((c) => (c.endsWith(".xcstrings") ? catalog.xcstringsSource(c) : null)).find(Boolean);
  const baseLocale = opts.baseLocale ?? (source && LOCALE_RE.test(source) ? source : null) ?? "en";
  const locs = mapped.map((m) => m.locale);
  // A base input is one of the base locale; with no exact tag in the run, one of its language (en-US for en).
  const exact = locs.some((l) => l && tag(l) === tag(baseLocale));
  const isBase = (l) => Boolean(l) && (exact ? tag(l) === tag(baseLocale) : !tag(baseLocale).includes("-") && tag(l).split("-")[0] === tag(baseLocale));
  if (opts.baseLocale !== null && !locs.some(isBase)) {
    throw new UsageError("unknown-base-locale", `--base-locale ${opts.baseLocale}: no input maps to locale ${opts.baseLocale}`, `--base-locale ${locs.find(Boolean) ?? "en"}`);
  }
  // TODO-084: text size is part of the pairing (null is `default`, as in every TODO-076 cell key).
  const key = (m) => (m.screen === null || m.screen === undefined ? null : `${m.device ?? ""}\0${sizeOf(m.text_size)}\0${m.screen}`);
  // TODO-084 D3, D6: the run has the size axis when an input's size is neither null nor `default` (as known.runAxes).
  const sizeAxis = mapped.some((m) => sizeOf(m.text_size) !== "default");
  const sizeAt = new Map(mapped.map((m) => [key(m), sizeOf(m.text_size)]));
  const sizesOf = (keys) => [...new Set([...keys].filter((k) => sizeAt.has(k)).map((k) => sizeAt.get(k)))].sort(byTextSize);
  const bases = new Map();
  mapped.forEach((m, i) => { if (isBase(m.locale) && key(m) !== null) bases.set(key(m), [...(bases.get(key(m)) || []), i]); });
  const missing = new Set(), ambiguous = new Set(), screens = new Set();
  const roles = mapped.map((m, i) => {
    if (isBase(m.locale)) return { base: true, baseIndex: null };
    const k = key(m);
    screens.add(k ?? `\0${i}`);
    const b = k === null ? [] : bases.get(k) || [];
    if (b.length > 1) { ambiguous.add(k); return { base: false, baseIndex: null }; }
    if (!b.length) { missing.add(k ?? `\0${i}`); return { base: false, baseIndex: null }; }
    return { base: false, baseIndex: b[0] };
  });
  const warnings = [];
  const a = list.find((x) => !x.stdin);
  // The folder that holds the base locale's folder too: a locale folder argument (shots/de) points at its parent.
  const dir = a ? (a.argIsDir ? a.arg : path.dirname(a.arg)) : "shots";
  const root = a && (locs.some((l) => l && tag(l) === tag(path.basename(dir))) || (LOCALE_RE.test(path.basename(dir)) && tag(path.basename(dir)) !== tag(baseLocale))) ? path.dirname(dir) : dir;
  const own = layout && layout !== "none" ? layout : null;
  // TODO-084: a size set by --text-size (not by the layout) goes into the rerun too, or it would read as default.
  const sizeFlag = (l) => (opts.textSize && !parseLayout(l).textSize ? ` --text-size ${shellArg(opts.textSize)}` : "");
  const fitCmd = (l) => `catscan fit ${shellArg(root)} --boxes ${shellArg(root)} --layout ${shellArg(l)}${sizeFlag(l)}`;
  // D16: always shown, once per run, with one runnable command.
  if (missing.size) {
    const n = `${missing.size} of ${screens.size} screen${screens.size === 1 ? "" : "s"} ${missing.size === 1 ? "has" : "have"}`;
    // TODO-084 D6: on a size run the screen may have a base shot at another size; say which sizes to capture.
    const sizes = sizeAxis ? sizesOf(missing) : [];
    if (sizes.length) {
      warnings.push({ code: "wrap-no-base", message: `${n} no ${baseLocale} screenshot at the same text size in this run; wrapped uses only declared and control evidence there`, hint: `capture ${baseLocale} screenshots at text size ${sizes.join(", ")}, then: ${fitCmd(own ?? "{locale}/{screen}")}` });
    } else {
      warnings.push({ code: "wrap-no-base", message: `${n} no ${baseLocale} screenshot in this run; wrapped uses only declared and control evidence there`, hint: fitCmd("{locale}/{screen}") });
    }
  }
  if (ambiguous.size) {
    // TODO-084 D2, D3: name the sizes, say "no device axis" only without one, and suggest {device}/ before the run's layout.
    const sizes = sizeAxis ? ` at text size ${sizesOf(ambiguous).join(", ")}` : "";
    // With a device axis (from {device}/ or --device) a {device}/ layout cannot help: the duplicate is in one device.
    const devices = mapped.some((m) => m.device != null);
    const why = devices ? "" : " (no device axis)";
    const hint = devices
      ? `two inputs map to one device, text size, ${baseLocale} locale and screen; check --layout ${shellArg(own ?? "{locale}/{screen}")} and the file names`
      : fitCmd(own ? `{device}/${own}` : "{device}/{locale}/{screen}");
    warnings.push({ code: "wrap-base-ambiguous", message: `${ambiguous.size} screen${ambiguous.size === 1 ? " has" : "s have"} two ${baseLocale} screenshots${sizes}${why}; base evidence skipped there`, hint });
  }
  // D3, D13: [key, target, base, catalog] for every key with one plain string in both locales; the core normalizes
  // and drops a string that is the value of several keys.
  const cache = new Map();
  let baseCat = null;
  const pairs = (locale) => {
    if (!opts.catalogs.length || !locale) return null;
    if (cache.has(tag(locale))) return cache.get(tag(locale));
    if (!baseCat) {
      baseCat = catalog.loadAll(opts.catalogs, baseLocale);
      warnings.push(...baseCat.warnings);
    }
    const target = catalog.loadAll(opts.catalogs, locale);
    warnings.push(...target.warnings.filter((w) => !warnings.some((x) => x.message === w.message)));
    const plain = (e) => e && !e.reason && !e.text.includes(" | ") && !e.text.startsWith("@string/") && e.text.trim();
    const entries = [];
    for (const [k, e] of target.keys) {
      const b = baseCat.keys.get(k);
      if (plain(e) && plain(b)) entries.push([k, e.text, b.text, e.catalog]);
    }
    const out = entries.length ? { digest: crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 32), entries } : null;
    cache.set(tag(locale), out);
    return out;
  };
  // Loaded before any image is read: a bad catalog is exit 2, and its warnings print once with the run's.
  mapped.forEach((m, i) => { if (roles[i].baseIndex !== null) pairs(m.locale); });
  return { baseLocale, roles, warnings, pairs };
}

/**
 * D16: the run-level skip lines after the run: `device-unknown` once per distinct size (with the image count and the
 * profile ids of that size), and `device-no-zones` once. Envelope warnings (`device-ambiguous`, `orientation-unknown`)
 * stay per image.
 */
function afterRun(envelopes, reasons = ZONES) {
  const out = [];
  const unknown = new Map(), zoneless = new Map();
  for (const { env } of envelopes) {
    if (env.command !== "fit" || env.verdict === "error" || !env.image) continue;
    const size = `${env.image.width}x${env.image.height}`;
    if (!env.device_profile && (env.reasons_skipped || []).some((s) => s.cause === "device-unknown")) {
      const u = unknown.get(size) || unknown.set(size, { n: 0, first: env.path, w: env.image.width, h: env.image.height }).get(size);
      u.n++;
    }
    // TODO-074: the wrap reasons run on every image; device-no-zones is about the safe-area reasons only.
    const zonal = (l) => (l || []).filter((x) => ZONES.includes(typeof x === "string" ? x : x.reason));
    if (env.device_profile && !zonal(env.reasons_run).length && !zonal(env.reasons_skipped).length) {
      zoneless.set(env.device_profile.id, (zoneless.get(env.device_profile.id) || 0) + 1);
    }
  }
  for (const [size, u] of unknown) {
    const ids = profiles.idsOfSize(u.w, u.h);
    out.push({
      code: "device-unknown",
      message: `${u.n} image${u.n === 1 ? "" : "s"} of ${size} (first: ${u.first}) ${u.n === 1 ? "has" : "have"} no device profile; safe-area reasons skipped (Android needs a named profile; profiles of this size: ${ids.join(", ") || "none"})`,
      hint: ids.length ? `catscan fit ${shellArg(u.first)} --device-profile ${ids[0]}` : "catscan fit --list-devices",
    });
  }
  for (const [id, n] of zoneless) {
    const what = reasons.filter((r) => ZONES.includes(r)).map((r) => ({ cutout: "cutout", corner: "rounded corner", "home-indicator": "home indicator" })[r]);
    const words = what.length === 1 ? what[0] : `${what.slice(0, -1).join(", ")} or ${what[what.length - 1]}`;
    out.push({ code: "device-no-zones", message: `${n} image${n === 1 ? "" : "s"} matched ${id}, which has no ${words}; nothing to check there`, hint: null });
  }
  return out;
}

/** D16: `checks-skipped` for --fail-on-skip: counts per cause, e.g. "14 images skipped cutout, corner and home-indicator (device-unknown)". */
function skippedLine(envelopes) {
  const groups = new Map();
  for (const { env } of envelopes) {
    const s = env.command === "fit" ? env.reasons_skipped || [] : [];
    // One image can skip reasons for different causes (a zone for device-unknown, wrapped for boxes-missing).
    for (const cause of new Set(s.map((x) => x.cause))) {
      const key = `${s.filter((x) => x.cause === cause).map((x) => x.reason).join(",")}|${cause}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
  }
  if (!groups.size) return null;
  const words = (l) => (l.length === 1 ? l[0] : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`);
  const parts = [...groups].map(([k, n]) => { const [r, c] = k.split("|"); return `${n} image${n === 1 ? "" : "s"} skipped ${words(r.split(","))} (${c})`; });
  const first = [...groups.keys()][0].split("|")[1];
  return {
    code: "checks-skipped",
    message: `fit: ${parts.join(", ")}`,
    hint: first === "orientation-unknown" ? "--orientation landscape-left"
      : first === "boxes-missing" ? "--boxes <folder of .boxes.json sidecars>" : "catscan fit --list-devices, then --device-profile <id>",
  };
}

module.exports = { REASONS, ZONES, WRAP, ORIENTATIONS, EVIDENCE, build, wrapPlan, parseReasons, afterRun, skippedLine, experimentalReasons };
