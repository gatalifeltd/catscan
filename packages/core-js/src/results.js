// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// The results file (spec 27): layout mapping, expected coverage, `missing` entries, the file itself,
// `results merge` and `results validate`.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CatscanError } = require("./client");
const { UsageError, LOCALE_RE, DEVICE_RE, TEXT_SIZE_RE, BASE_LAYOUTS, OPTIONS } = require("./args");
const { version } = require("../package.json");
const scale = require("./scale");

// TODO-075 D1, D16: a file is results_schema 2 when it uses an axis, and lists the axes it uses; a reader refuses an
// axis it does not know, so a later axis adds a name here instead of a schema bump.
const RESULTS_SCHEMAS = [1, 2];
const AXES = ["device", "text_size"];
const PLATFORMS = new Set(["ios", "ipados", "android", "web", "macos", "watchos", "tvos", "visionos"]);
const DEFAULT_LAYOUT = "{locale}/{screen}";
const VERDICTS = ["pass", "fail", "needs-reader", "unsupported", "error"];

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// TODO-076 "Labels": `default`, `large`, the exact labels in the spec's table order, then any other by code point.
const TEXT_SIZE_ORDER = ["default", "large", "xl", "xxl", "xxxl", "ax1", "ax2", "ax3", "ax4", "ax5", "fs1.3", "fs1.5", "fs1.8", "fs2.0", "zoom150", "zoom200"];
const sizeRank = (t) => { const i = TEXT_SIZE_ORDER.indexOf(t); return i < 0 ? TEXT_SIZE_ORDER.length : i; };
const byTextSize = (a, b) => sizeRank(a) - sizeRank(b) || byCodePoint(a, b);
/** TODO-076 D6: a missing text size is `default` in the cell key, so runs from before the axis join the default cells. */
const sizeOf = (t) => t ?? "default";

/** JSON with object keys sorted at every level: the tie break and equality rule of spec 27. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort(byCodePoint).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// ---- layout ---------------------------------------------------------------------------------------

/**
 * Known locales for `{locale}`: every locale and alias of `catscan languages` (spec 27 D3), lowercased ->
 * the table's spelling. `info` is the `languages --json` object.
 */
function knownLocales(info) {
  const out = new Map();
  for (const l of info.languages || []) for (const c of [l.locale, ...(l.aliases || [])]) out.set(c.toLowerCase(), c);
  return out;
}

/** True when some path could map, so the languages table is worth reading (it costs a process start). */
function needsLocales(layout, rels) {
  if (layout === "none") return false;
  return rels.some((r) => r !== null && splitLayout(layout, r).length > 0);
}

/** TODO-075, TODO-076 D2: the base pattern of a layout and whether it starts with `{device}/`, then `{text_size}/`. */
function parseLayout(layout) {
  let base = layout;
  const device = base.startsWith("{device}/");
  if (device) base = base.slice("{device}/".length);
  const textSize = base.startsWith("{text_size}/");
  if (textSize) base = base.slice("{text_size}/".length);
  return { device, textSize, base };
}

/**
 * The raw {device, text_size, locale, screen} splits a pattern gives for a relative path, before the locale is checked:
 * one for the folder and dot patterns, up to two for the hyphen ones (TODO-087 D2), best first; [] when none fits.
 */
function splitLayout(layout, rel) {
  const { device, textSize, base } = parseLayout(layout);
  // One leading folder as a label, or null when there is none or it is not a label.
  const folder = (re) => {
    const i = rel.indexOf("/");
    if (i <= 0) return null;
    const label = rel.slice(0, i).toLowerCase();
    if (!re.test(label)) return null;
    rel = rel.slice(i + 1);
    return label;
  };
  const d = device ? folder(DEVICE_RE) : null;
  if (device && d === null) return [];
  const t = textSize ? folder(TEXT_SIZE_RE) : null;
  if (textSize && t === null) return [];
  return splitBase(base, rel).map((m) => ({ device: d, text_size: t, ...m }));
}

function splitBase(layout, rel) {
  const parts = rel.split("/");
  const last = parts[parts.length - 1];
  const ext = path.extname(last);
  const stem = ext ? last.slice(0, -ext.length) : last;
  const dir = parts.slice(0, -1);
  if (layout === "{locale}/{screen}") {
    if (parts.length < 2) return [];
    return [{ locale: parts[0], screen: [...parts.slice(1, -1), stem].join("/") }];
  }
  if (layout === "{screen}/{locale}") {
    if (parts.length < 2) return [];
    return [{ locale: stem, screen: dir.join("/") }];
  }
  if (layout === "{screen}.{locale}") {
    const dot = stem.lastIndexOf(".");
    if (dot <= 0 || dot === stem.length - 1) return [];
    return [{ locale: stem.slice(dot + 1), screen: [...dir, stem.slice(0, dot)].join("/") }];
  }
  // TODO-087 D2: a locale token at the start or end of the file name, two tokens (pt-BR) first, then one, so
  // settings-panel-de maps de when panel-de is no locale. mapPath keeps the first split whose locale it knows.
  const tokens = stem.split("-");
  const out = [];
  for (const n of [2, 1]) {
    if (tokens.length <= n || tokens.slice(0, n).concat(tokens.slice(-n)).some((x) => !x)) continue;
    if (layout === "{locale}-{screen}") out.push({ locale: tokens.slice(0, n).join("-"), screen: [...dir, tokens.slice(n).join("-")].join("/") });
    if (layout === "{screen}-{locale}") out.push({ locale: tokens.slice(-n).join("-"), screen: [...dir, tokens.slice(0, -n).join("-")].join("/") });
  }
  return out;
}

/** {device, text_size, locale, screen} for a relative path, or null when it does not match (spec 27 "Layout", TODO-075, TODO-076). */
function mapPath(layout, rel, known) {
  if (rel === null || layout === "none") return null;
  for (const m of splitLayout(layout, rel)) {
    if (!m.screen || !LOCALE_RE.test(m.locale)) continue;
    const locale = known.get(m.locale.toLowerCase());
    if (locale) return { device: m.device, text_size: m.text_size, locale, screen: m.screen };
  }
  return null;
}

/**
 * The layout filled in for a cell. A device or text size the layout does not hold (it came from --device or
 * --text-size) is prepended, so two devices' or sizes' missing cells never share a name (TODO-075 D6, TODO-076).
 */
function fillLayout(layout, cell) {
  const { device, textSize, base } = parseLayout(layout);
  const { locale, screen } = cell;
  // A nested screen keeps its folder in front for the hyphen patterns (auth/login -> auth/de-login), as splitBase reads
  // it; a function replacer fills each placeholder once and never reads `$&` or `$'` in a screen name.
  const cut = /-/.test(base) ? screen.lastIndexOf("/") + 1 : 0;
  const b = screen.slice(0, cut) + base.replace(/\{(screen|locale)\}/g, (_, k) => (k === "screen" ? screen.slice(cut) : locale));
  const t = cell.text_size != null ? `${cell.text_size}/` : textSize ? "{text_size}/" : "";
  return (cell.device != null ? `${cell.device}/` : device ? "{device}/" : "") + t + b;
}

/** TODO-075 D3: the platform is the label's first token when it names one, else null. */
const platformOf = (device) => {
  if (device == null) return null;
  const t = device.split(/[-_.]/)[0];
  return PLATFORMS.has(t) ? t : null;
};

/**
 * TODO-075 D13: for inputs no layout maps, the `{device}/` variant of the base pattern when it maps every one of them;
 * else (TODO-087 D10) the same prefixes with another base pattern, in BASE_LAYOUTS order. `rels` are the unmapped
 * relative paths.
 */
function suggestLayout(layout, rels, known) {
  if (layout === "none" || !rels.length) return null;
  const { device, textSize, base } = parseLayout(layout);
  const pre = (device ? "{device}/" : "") + (textSize ? "{text_size}/" : "");
  const others = (p) => BASE_LAYOUTS.filter((b) => b !== base).map((b) => p + b);
  // With no device axis, a device folder in front is tried before the same prefixes, so ios/home-de.png keeps ios a device.
  const tries = device ? others(pre) : [`{device}/${layout}`, ...others(`{device}/${pre}`), ...others(pre)];
  return tries.find((v) => rels.every((r) => mapPath(v, r, known))) ?? null;
}

/**
 * The cell key (TODO-075 D2, D10; TODO-076 D6): device (null is a value of its own), text size (null is `default`),
 * locale case-insensitively, screen.
 */
const cellKey = (c) => `${c.device ?? ""}\0${sizeOf(c.text_size)}\0${c.locale.toLowerCase()}\0${c.screen}`;

/**
 * Spec 27 and TODO-075: per input, its locale, screen, device, cell and warnings. `rels` are paths relative to their
 * argument (null for stdin); `locale` and `device` the run's --locale and --device; `exp` the expectations or null;
 * `paths` the inputs as shown.
 */
function mapInputs(layout, rels, known, { locale: locale0 = null, device: device0 = null, textSize: size0 = null, exp = null, paths }) {
  const maps = rels.map((rel) => mapPath(layout, rel, known));
  // TODO-075 D13: name the `{device}/` variant when it maps every input this layout does not.
  const unmapped = rels.filter((r, i) => r !== null && !maps[i]);
  const better = suggestLayout(layout, unmapped, known);
  const out = rels.map((rel, i) => {
    const m = maps[i];
    const warnings = [];
    const device = device0 ?? m?.device ?? null;
    const text_size = size0 ?? m?.text_size ?? null;
    if (!m) {
      if (exp) warnings.push({ code: "layout-mismatch", message: `${paths[i]} does not match --layout ${layout}, so it is in no expected cell${better ? ` - try: --layout '${better}'` : ""}`, hint: better ? `--layout '${better}'` : "move it to the layout or pass --layout" });
      return { locale: locale0, screen: null, device, text_size, cell: null, warnings };
    }
    if (locale0 && locale0.toLowerCase() !== m.locale.toLowerCase()) {
      warnings.push({ code: "locale-path-mismatch", message: `${paths[i]} is under locale ${m.locale} but is read as ${locale0}`, hint: `drop --locale, or --layout none` });
    }
    // TODO-075 D4: --device wins over the path's device.
    if (device0 !== null && m.device !== null && m.device !== device0) {
      warnings.push({ code: "device-path-mismatch", message: `${paths[i]} is under device ${m.device} but is read as ${device0}`, hint: "drop --device or move the file" });
    }
    // TODO-076 "Interface": --text-size wins over the path's size, as --device does.
    if (size0 !== null && m.text_size !== null && m.text_size !== size0) {
      warnings.push({ code: "text-size-path-mismatch", message: `${paths[i]} is under text size ${m.text_size} but is read as ${size0}`, hint: "drop --text-size or move the file" });
    }
    const locale = locale0 ?? m.locale;
    return { locale, screen: m.screen, device, text_size, cell: { device, text_size, locale, screen: m.screen }, warnings };
  });
  // TODO-075 D9: once the run has a device, an input with none makes no cell.
  const devices = [...new Set([...(exp?.devices || []), ...out.map((o) => o.device).filter((d) => d !== null)])].sort(byDevice);
  if (devices.length) {
    out.forEach((o, i) => {
      if (o.device !== null || !o.cell) return;
      o.warnings.push(DEVICE_MISSING(paths[i], devices));
      o.screen = null; o.cell = null;
    });
  }
  const counts = cellCounts(out.map((o) => o.cell));
  for (const o of out) {
    const n = o.cell ? counts.get(cellKey(o.cell)) : 0;
    if (n > 1) o.warnings.push(DUPLICATE(o.cell, n));
  }
  return out;
}

// ---- expectations ---------------------------------------------------------------------------------

function parseLocaleList(value, flag) {
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new UsageError("invalid-locale", `${flag} needs a comma-separated list such as de,fr,ja`, `${flag} de,fr,ja`);
  for (const l of list) {
    if (!LOCALE_RE.test(l)) throw new UsageError("invalid-locale", `${flag} needs BCP 47 codes such as de, pt-BR or zh-Hant, not ${l}`, `${flag} de,fr,ja`);
  }
  return list;
}

function parseDeviceList(value) {
  const list = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) throw new UsageError("invalid-device", "--expect-devices needs a comma-separated list such as ios,android", "--expect-devices ios,android");
  for (const d of list) {
    if (!DEVICE_RE.test(d)) throw new UsageError("invalid-device", `--expect-devices needs labels of a-z, 0-9, ".", "_" or "-" (up to 64, starting with a letter or digit), not ${d}`, "--expect-devices ios-se,android-pixel-9");
  }
  return list;
}

function parseTextSizeList(value) {
  const list = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) throw new UsageError("invalid-text-size", "--expect-text-sizes needs a comma-separated list such as default,large", "--expect-text-sizes default,large");
  for (const t of list) {
    if (!TEXT_SIZE_RE.test(t)) throw new UsageError("invalid-text-size", `--expect-text-sizes needs labels of a-z, 0-9, ".", "_" or "-" (up to 64, starting with a letter or digit), not ${t}`, "--expect-text-sizes default,large");
  }
  return list;
}

function readScreens(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    throw new UsageError("expect-screens-unreadable", `cannot read --expect-screens ${file}: ${e.code || e.message}`, "pass a text file with one screen id per line");
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.replace(/#.*$/, "").trim();
    if (s) out.push(s);
  }
  return out;
}

const ANDROID_RE = /^values-([a-z]{2,3})(?:-r([A-Z]{2}))?$/;

const readFile = (file) => fs.readFileSync(file, "utf8");

/**
 * spec 02 "Locale of a catalog file" for one file, or undefined when it has none (Base.lproj, plain values).
 * `read(file)` returns the file's text; catscan-adopt passes one that reads a committed git tree (TODO-065 D3).
 */
// The base subtag names a language Intl knows (`de`, `pt` in pt-BR), not a word shaped like a code (`ui`). Without
// Intl language names every code counts, as before.
const LANGUAGE_NAMES = (() => { try { return new Intl.DisplayNames(["en"], { type: "language", fallback: "code" }); } catch { return null; } })();
const isLanguage = (tag) => { const base = tag.split(/[-_]/)[0].toLowerCase(); return !LANGUAGE_NAMES || LANGUAGE_NAMES.of(base).toLowerCase() !== base; };

function catalogFileLocales(file, read = readFile) {
  const ext = path.extname(file).toLowerCase();
  const dir = path.basename(path.dirname(file));
  const text = () => { try { return read(file); } catch { return null; } };
  if (ext === ".xcstrings") {
    let data;
    try { data = JSON.parse(text()); } catch { return null; }
    if (!data || typeof data.strings !== "object" || data.strings === null) return null;
    const out = new Set([typeof data.sourceLanguage === "string" ? data.sourceLanguage : "en"]);
    for (const entry of Object.values(data.strings)) {
      for (const [loc, v] of Object.entries((entry && entry.localizations) || {})) if (v && (v.stringUnit || v.variations)) out.add(loc);
    }
    return [...out];
  }
  if (ext === ".strings" || ext === ".stringsdict") {
    if (!dir.endsWith(".lproj")) return null;
    const l = dir.slice(0, -".lproj".length);
    if (l === "Base") return undefined; // its code is the development language, which has its own folder
    return LOCALE_RE.test(l.replace(/_/g, "-")) ? [l.replace(/_/g, "-")] : null;
  }
  if (ext === ".xml") {
    if (dir === "values") return undefined;
    if (!dir.startsWith("values-")) return undefined; // not a string resource folder
    if (dir.startsWith("values-b+")) {
      const l = dir.slice("values-b+".length).split("+").join("-");
      return LOCALE_RE.test(l) ? [l] : null;
    }
    const m = ANDROID_RE.exec(dir);
    return m ? [m[2] ? `${m[1]}-${m[2]}` : m[1]] : undefined; // values-night, values-v21: not a locale
  }
  if (ext === ".json") {
    // TODO-091: in a folder named for a language, a stem that names none (en/ui.json, de/app.json) is a file name,
    // so the folder is the locale. Everywhere else the stem keeps its old meaning, so a real code ICU does not name
    // (locales/nah.json, locales/me-ME.json) is never dropped.
    const stem = path.basename(file, path.extname(file));
    if (LOCALE_RE.test(stem) && !(LOCALE_RE.test(dir) && isLanguage(dir) && !isLanguage(stem))) return [stem];
    return LOCALE_RE.test(dir) ? [dir] : null;
  }
  const norm = (l) => l.replace(/_/g, "-");
  // gettext's script modifiers (sr@latin, sr@cyrillic) are BCP 47 script subtags; other modifiers are dropped.
  const code = /^[a-z]{2,3}([_-][A-Za-z]{2,4})?(@[a-z]+)?$/;
  const gettext = (l) => { const [base, mod] = l.split("@"); const sc = { latin: "Latn", cyrillic: "Cyrl" }[mod]; return norm(base) + (sc ? `-${sc}` : ""); };
  if (ext === ".arb") {
    // Flutter: "@@locale" in the file, else app_de.arb / intl_pt_BR.arb / de.arb; intl_messages.arb is the template.
    if (path.basename(file) === "intl_messages.arb") return undefined;
    let data;
    try { data = JSON.parse(text()); } catch { data = null; }
    if (data && typeof data["@@locale"] === "string" && LOCALE_RE.test(norm(data["@@locale"]))) return [norm(data["@@locale"])];
    const stem = path.basename(file, ext);
    const m = stem.match(/_([a-z]{2,3}(?:_[A-Z]{2}|_[A-Z][a-z]{3})?)$/) || stem.match(/^([a-z]{2}(?:_[A-Z]{2}|_[A-Z][a-z]{3})?)$/);
    return m ? [norm(m[1])] : null;
  }
  if (ext === ".po") {
    // gettext: the "Language:" header, then <locale>/LC_MESSAGES/x.po, then po/de.po or <locale>/x.po. When the name
    // and the folder both look like codes (src/de.po, de/app.po), the 2-letter one is the language; two different
    // 2-letter (or 3-letter) codes are unknown.
    const m = (text() || "").match(/^"Language: *([A-Za-z_@-]+)\\n"$/m);
    if (m && code.test(m[1])) return [gettext(m[1])];
    if (dir === "LC_MESSAGES") { const up = path.basename(path.dirname(path.dirname(file))); return code.test(up) ? [gettext(up)] : null; }
    const stem = path.basename(file, ext);
    const byStem = code.test(stem);
    const byDir = code.test(dir) && dir !== "po";
    if (byStem && byDir && stem !== dir) {
      const two = (x) => /^[a-z]{2}([@_-]|$)/.test(x);
      if (two(stem) === two(dir)) return null;
      return [gettext(two(stem) ? stem : dir)];
    }
    return byStem ? [gettext(stem)] : byDir ? [gettext(dir)] : null;
  }
  return undefined;
}

/** The locales of a list of catalog files, with a warning per file whose locale is unknown (spec 02, D3). */
function localesFromFiles(files, read = readFile) {
  const locales = new Set();
  const warnings = [];
  const sources = Object.create(null); // catalog keys such as "constructor" are data, not prototype names
  for (const f of files) {
    const l = catalogFileLocales(f, read);
    if (l === undefined) continue;
    if (l === null) {
      warnings.push({ code: "catalog-locale-unknown", message: `cannot read the locale of the catalog ${f}`, hint: "name it <locale>.json, put it in <locale>.lproj or values-<locale>, give a .po a \"Language:\" header or an .arb a \"@@locale\", or use --expect-locales" });
      continue;
    }
    for (const x of l) { locales.add(x); (sources[x] = sources[x] || []).push(f); }
  }
  return { locales: [...locales].sort(byCodePoint), warnings, sources };
}

/** `--expect-locales-from <dir>`: the locales of the catalogs under it, plus warnings. */
function localesFromCatalogs(dir) {
  let st;
  try { st = fs.statSync(dir); } catch { st = null; }
  if (!st || !st.isDirectory()) throw new UsageError("expect-locales-from-not-found", `--expect-locales-from needs a folder of catalogs, not ${dir}`, "--expect-locales de,fr,ja");
  const files = [];
  const warnings = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) {
      // An unreadable folder could hide a locale, so it is never silent.
      warnings.push({ code: "catalog-locale-unknown", message: `cannot list ${d}: ${e.code || e.message}; its catalogs were skipped`, hint: "fix its permissions or use --expect-locales" });
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p);
    }
  };
  walk(dir);
  files.sort(byCodePoint);
  const r = localesFromFiles(files);
  warnings.push(...r.warnings);
  if (!r.locales.length) throw new UsageError("expect-locales-from-empty", `no catalog with a known locale under ${dir}`, "--expect-locales de,fr,ja");
  return { locales: r.locales, warnings };
}

/**
 * Expectations from the options, or null when no expectation flag is given (D16).
 * Returns { locales: [..] | null, screens: [..] | null, warnings }.
 */
function expectations(opts) {
  if (opts.expectLocales === null && opts.expectLocalesFrom === null && opts.expectScreens === null && (opts.expectDevices ?? null) === null && (opts.expectTextSizes ?? null) === null) return null;
  const warnings = [];
  let locales = null;
  if (opts.expectLocales !== null) locales = parseLocaleList(opts.expectLocales, "--expect-locales");
  if (opts.expectLocalesFrom !== null) {
    const r = localesFromCatalogs(opts.expectLocalesFrom);
    warnings.push(...r.warnings);
    locales = [...new Set([...(locales || []), ...r.locales])];
  }
  const screens = opts.expectScreens !== null ? readScreens(opts.expectScreens) : null;
  const devices = (opts.expectDevices ?? null) !== null ? parseDeviceList(opts.expectDevices) : null;
  const textSizes = (opts.expectTextSizes ?? null) !== null ? parseTextSizeList(opts.expectTextSizes) : null;
  return {
    locales: locales && [...new Set(locales)].sort(byCodePoint),
    screens: screens && [...new Set(screens)].sort(byCodePoint),
    devices: devices && [...new Set(devices)].sort(byCodePoint),
    textSizes: textSizes && [...new Set(textSizes)].sort(byTextSize),
    warnings,
  };
}

// ---- coverage ---------------------------------------------------------------------------------------

const isMissing = (e) => e.path === null && Array.isArray(e.findings) && e.findings.some((f) => f && f.kind === "missing");

function missingEntry(command, cell, layout) {
  return {
    schema: 1, catscan: version, command, path: null, verdict: "fail", engine: null, locale: cell.locale, screen: cell.screen,
    device: cell.device, platform: platformOf(cell.device), text_size: cell.text_size ?? null,
    image: null, host: null, ms: 0, checks: [],
    findings: [{ kind: "missing", box: null, expected_path: fillLayout(layout, cell) }], warnings: [], text: null,
  };
}

// Devices order by platform, then label (TODO-075 D8); no platform sorts last.
const byDevice = (a, b) => byCodePoint(platformOf(a) ?? "\uffff", platformOf(b) ?? "\uffff") || byCodePoint(a, b);

/**
 * Coverage over received envelopes (D6, D16, D17; TODO-075 the device dimension): { coverage, missing: [entries] }.
 * `exp` null gives coverage null and no missing entries. An envelope with no device makes no cell once the axis is
 * in use (TODO-075 D9); the caller marks it `device-missing` and unmapped.
 */
function coverage(entries, exp, layout, command) {
  if (!exp) return { coverage: null, missing: [] };
  const mapped = entries.filter((e) => !isMissing(e) && typeof e.screen === "string");
  // Locale codes are case-insensitive: an expected `pt-br` or `DE` takes the spelling of the received input.
  const seen = new Map(mapped.map((e) => [e.locale.toLowerCase(), e.locale]));
  const locales = exp.locales ? [...new Set(exp.locales.map((l) => seen.get(l.toLowerCase()) ?? l))].sort(byCodePoint)
    : [...new Set(mapped.map((e) => e.locale))].sort(byCodePoint);
  const screens = exp.screens || [...new Set(mapped.map((e) => e.screen))].sort(byCodePoint);
  const got = mapped.map((e) => e.device ?? null).filter((d) => d !== null);
  const devices = exp.devices ? [...exp.devices].sort(byDevice) : got.length ? [...new Set(got)].sort(byDevice) : null;
  const D = new Set(devices ?? [null]);
  // TODO-076: the size dimension, with no D9 rule: an envelope with no size is a `default` one (D6).
  const gotSizes = mapped.map((e) => e.text_size ?? null);
  const sizes = exp.textSizes ? [...new Set(exp.textSizes)].sort(byTextSize) : gotSizes.some((t) => t !== null) ? [...new Set(gotSizes.map(sizeOf))].sort(byTextSize) : null;
  const T = sizes && new Set(sizes);
  const L = new Set(locales.map((l) => l.toLowerCase())), S = new Set(screens);
  const have = new Set();
  let received = 0;
  for (const e of mapped) {
    if (D.has(e.device ?? null) && (!T || T.has(sizeOf(e.text_size))) && L.has(e.locale.toLowerCase()) && S.has(e.screen)) { received++; have.add(cellKey(e)); }
  }
  const cells = [];
  for (const d of devices ?? [null]) for (const t of sizes ?? [null]) for (const l of locales) for (const s of screens) {
    const c = { device: d, text_size: t, locale: l, screen: s };
    if (!have.has(cellKey(c))) cells.push(c);
  }
  return {
    coverage: { layout, expected_locales: locales, expected_screens: screens, expected_devices: devices, expected_text_sizes: sizes, received, missing: cells },
    missing: cells.map((c) => missingEntry(command, c, layout)),
  };
}

// A merge names the command, since it counts duplicates per command (TODO-043 D2); a single run has one and omits it.
const DUPLICATE = (c, n, command) => ({ code: "duplicate-cell", message: `${n} inputs map to ${c.device != null ? `device ${c.device}, ` : ""}${c.text_size != null ? `text size ${c.text_size}, ` : ""}locale ${c.locale}, screen ${c.screen}${command ? ` under ${command}` : ""}`, hint: "remove the extra screenshot or fix --layout" });

/** TODO-075 D9, D14: an input with no device once the run, merge or report has the axis. */
const DEVICE_MISSING = (p, devices) => ({
  code: "device-missing",
  message: `${p ?? "an input"} has no device, but this run has devices (${devices.join(", ")}), so it is in no cell`,
  hint: `rerun its command with --device <one of ${devices.join(", ")}>, or leave results written before the device axis out of the merge`,
});

/** Cell key -> count, for `duplicate-cell` (spec 27 "Duplicates"); locales compare case-insensitively (D26). */
function cellCounts(cells) {
  const n = new Map();
  for (const c of cells) if (c) { const k = cellKey(c); n.set(k, (n.get(k) || 0) + 1); }
  return n;
}

/** TODO-075 D1, D16, TODO-076: the axes a file uses, from its envelopes and its coverage's expectations, in key order. */
function axesOf(results, cov) {
  const out = [];
  if (results.some((e) => e.device != null) || (cov && cov.expected_devices)) out.push("device");
  if (results.some((e) => e.text_size != null) || (cov && cov.expected_text_sizes)) out.push("text_size");
  return out;
}

// ---- the file ---------------------------------------------------------------------------------------

/**
 * The path as the file records it (spec 27 "Paths", D9): relative to `cwd` when inside it, else
 * `abs:` + the last component of the argument that named it + the rest below it.
 */
// A relative path that climbs out of its base (`..foo` is a folder name, not a climb).
const leaves = (rel) => path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`);

// The real path when it exists: cwd is real (/private/var), an argument may name it through a symlink (/var).
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

function privatePath(p, arg, cwd = process.cwd()) {
  if (p === null || p === "-") return p;
  cwd = real(cwd);
  const abs = real(path.resolve(cwd, p));
  const rel = path.relative(cwd, abs);
  if (rel === "") return ".";
  if (!leaves(rel)) return rel.split(path.sep).join("/");
  const argAbs = real(path.resolve(cwd, arg ?? p));
  const below = path.relative(argAbs, abs);
  const inside = below === "" || !leaves(below);
  const tail = inside ? [path.basename(argAbs), below] : [path.basename(abs)];
  return "abs:" + tail.filter(Boolean).join("/").split(path.sep).join("/");
}

// Options whose value is a path; other values (`--present /Settings`) are kept as written.
const PATH_OPTIONS = new Set(["--expect", "--catalog", "--base", "--allow", "--boxes", "--image", "--results", "--expect-locales-from", "--expect-screens", "--out", "--junit", "--gitlab-codequality", "--report", "--images-root", "--baseline", "--baseline-ignore", "--known"]);
const outside = (v, cwd) => path.isAbsolute(v) || leaves(path.relative(cwd, path.resolve(cwd, v)));

/**
 * `argv` with every absolute path, or path outside the working directory, rewritten by the same rule (D9):
 * positional paths and the values of path options only.
 */
function privateArgv(argv, cwd = process.cwd()) {
  const fix = (v) => (outside(v, cwd) ? privatePath(v, v, cwd) : v);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (eq > 0) { out.push(PATH_OPTIONS.has(name) ? `${name}=${fix(a.slice(eq + 1))}` : a); continue; }
    if (a.startsWith("-") && a !== "-") {
      out.push(a);
      if (OPTIONS[a]?.value && i + 1 < argv.length) { i++; out.push(PATH_OPTIONS.has(a) ? fix(argv[i]) : argv[i]); }
      continue;
    }
    out.push(i === 0 || (argv[0] === "results" && i === 1) ? a : fix(a));
  }
  return out;
}

/**
 * Replacement pairs for the paths a run names (D27): each outside path argument (positional or a path option's
 * value; a `{locale}` template by its folder), as given and absolute, becomes its `abs:` form; the working
 * directory prefix is dropped; the home folder becomes `~`. Longest first, so a longer path wins.
 */
function scrubPairs(argv, cwd = process.cwd()) {
  const pairs = new Map();
  const add = (v) => {
    const t = v.includes("{") ? path.dirname(v.slice(0, v.indexOf("{")) + "x") : v;
    if (!t || !outside(t, cwd)) return;
    pairs.set(path.resolve(cwd, t), privatePath(t, t, cwd)); // absolute keys only: `..` or `/` alone would hit any text
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0) { if (PATH_OPTIONS.has(a.slice(0, eq))) add(a.slice(eq + 1)); continue; }
    if (a.startsWith("-") && a !== "-") { if (OPTIONS[a]?.value && i + 1 < argv.length) { i++; if (PATH_OPTIONS.has(a)) add(argv[i]); } continue; }
    add(a);
  }
  pairs.set(cwd + path.sep, "");
  pairs.set(os.homedir(), "~"); // scrubText keeps it to a path boundary
  return [...pairs].filter(([f]) => f).sort((a, b) => b[0].length - a[0].length);
}

const reEscape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces each key where it ends at a path boundary (the key `/Users/me` never rewrites the start of a longer folder name). */
function scrubText(text, pairs) {
  for (const [from, to] of pairs) {
    const tail = from.endsWith(path.sep) ? "" : "(?=$|[/\\s\"'),;:])";
    text = text.replace(new RegExp(reEscape(from) + tail, "g"), () => to);
  }
  return text;
}

/**
 * An envelope as the file records it: its path rewritten (D9), and its diagnostic messages and hints scrubbed of
 * its own path (as given and absolute) and every `scrubPairs` path (D27). Recognized text and findings are data,
 * never rewritten.
 */
function privateEnvelope(env, arg, pairs = [], cwd = process.cwd()) {
  const p = privatePath(env.path, arg, cwd);
  const own = env.path === null || p === env.path ? [] : [[path.resolve(cwd, env.path), p], [env.path, p]];
  const all = [...own, ...pairs].sort((a, b) => b[0].length - a[0].length);
  const fix = (d) => (d && typeof d === "object" ? { ...d, ...(typeof d.message === "string" ? { message: scrubText(d.message, all) } : {}), ...(typeof d.hint === "string" ? { hint: scrubText(d.hint, all) } : {}) } : d);
  // A catalog path names a file the run read, like a path option: same rewrite.
  const cat = (x) => (x && typeof x.catalog === "string" ? { ...x, catalog: scrubText(x.catalog, all) } : x);
  const out = { ...env, path: p, warnings: (env.warnings || []).map(fix) };
  if (env.error) out.error = fix(env.error);
  if (Array.isArray(env.checks)) out.checks = env.checks.map(cat);
  if (Array.isArray(env.findings)) out.findings = env.findings.map(cat);
  return out;
}

// Spec 27 "run.ci": table order is the detection order; the first marker set wins (D20).
const CI = [
  ["github-actions", "GITHUB_ACTIONS", "ImageOS", "GITHUB_SHA", "GITHUB_REF", "GITHUB_RUN_ID"],
  ["gitlab-ci", "GITLAB_CI", "CI_RUNNER_DESCRIPTION", "CI_COMMIT_SHA", "CI_COMMIT_REF_NAME", "CI_PIPELINE_ID"],
  ["circleci", "CIRCLECI", null, "CIRCLE_SHA1", "CIRCLE_BRANCH", "CIRCLE_WORKFLOW_ID"],
  ["bitrise", "BITRISE_IO", null, "BITRISE_GIT_COMMIT", "BITRISE_GIT_BRANCH", "BITRISE_BUILD_SLUG"],
  ["codemagic", "CM_BUILD_ID", null, "CM_COMMIT", "CM_BRANCH", "CM_BUILD_ID"],
  ["azure-pipelines", "TF_BUILD", "AGENT_NAME", "BUILD_SOURCEVERSION", "BUILD_SOURCEBRANCH", "BUILD_BUILDID"],
  ["buildkite", "BUILDKITE", "BUILDKITE_AGENT_NAME", "BUILDKITE_COMMIT", "BUILDKITE_BRANCH", "BUILDKITE_BUILD_ID"],
  ["jenkins", "JENKINS_URL", "NODE_NAME", "GIT_COMMIT", "BRANCH_NAME", "BUILD_ID"],
];

function ciInfo(env = process.env) {
  const get = (k) => (k && env[k] ? env[k] : null);
  for (const [provider, marker, runner, commit, ref, runId] of CI) {
    if (env[marker]) return { provider, runner: get(runner), commit: get(commit), ref: get(ref), run_id: get(runId) };
  }
  return null;
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function totals(results) {
  const t = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const r of results) t[r.verdict]++;
  return t;
}

/** `results[]` order: entries with a path by (path, command, canonical JSON), then `missing` by (device, text size, locale, screen). */
function sortResults(results) {
  const keyed = results.map((r) => ({ r, c: canonical(r) }));
  keyed.sort((a, b) => {
    const ma = isMissing(a.r), mb = isMissing(b.r);
    if (ma !== mb) return ma ? 1 : -1;
    if (ma) return byCodePoint(a.r.device ?? "", b.r.device ?? "") || byTextSize(sizeOf(a.r.text_size), sizeOf(b.r.text_size)) || byCodePoint(a.r.locale, b.r.locale) || byCodePoint(a.r.screen, b.r.screen) || byCodePoint(a.c, b.c);
    return byCodePoint(a.r.path ?? "", b.r.path ?? "") || byCodePoint(a.r.command, b.r.command) || byCodePoint(a.c, b.c);
  });
  return keyed.map((k) => k.r);
}

// TODO-038: every envelope in a file carries `change`, null until a --baseline comparison sets it.
const withChange = (results) => results.map((e) => ({ ...e, change: null }));

/** The whole file object (spec 27 "Format"). `results` already hold private paths. */
function build({ results, coverage: cov, argv, started, finished, build: b, host, ci, shards = [], thresholds = scale.DEFAULTS, allow = null, known = null }) {
  // Entries keep their object identity (spec 18 D18): `change` is set on them, not on copies.
  for (const e of results) e.change = null;
  const axes = axesOf(results, cov);
  return {
    results_schema: axes.length ? 2 : 1,
    ...(axes.length ? { axes } : {}),
    // TODO-055 D30: the --allow file's digest is taken at run time, so `results known` never opens a path from a file.
    run: { catscan: version, started_at: iso(started), finished_at: iso(finished), argv, host, ci, build: b, shards, thresholds: { ...thresholds }, registry: scale.registryId(), ...(allow ? { allow } : {}) },
    coverage: cov,
    totals: totals(results),
    results: sortResults(results),
    baseline: null,
    ...(known ? { known } : {}), // TODO-055: present only when the run applied --known
  };
}

/** Atomic write (D12): a temp file in the same folder, fsync, rename. Throws CatscanError results-write-failed. */
function write(file, obj) {
  writeAtomic(file, JSON.stringify(obj, null, 2) + "\n", "results-write-failed", "the results file",
    "check that the folder exists and is writable, or pass another --results path");
}

/** The atomic write behind --results and the spec 15 report files. Throws CatscanError `code`. */
function writeAtomic(file, text, code, what, hint) {
  // A random name opened exclusively: a planted symlink in a shared folder cannot redirect the write.
  const tmp = path.join(path.dirname(path.resolve(file)), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx");
    // writeSync may write fewer bytes than asked (quota, disk pressure): loop, never rename a truncated file.
    const buf = Buffer.from(text);
    for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw new CatscanError(code, `cannot write ${what} ${file}: ${e.code || e.message}`, hint);
  }
}

// ---- validate -----------------------------------------------------------------------------------------

let validator = null;

/** Ajv over the results schema; the schemas ship in the package (D24) or come from core/schema in the repo. */
function schemaValidator() {
  if (validator) return validator;
  const Ajv = require("ajv");
  const dir = [path.join(__dirname, "../schema"), path.join(__dirname, "../../../core/schema")].find((d) => fs.existsSync(path.join(d, "results.schema.json")));
  if (!dir) throw new CatscanError("binary-failed", "the results JSON Schema is missing from this install", "reinstall @catscan/cli");
  const load = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(load("result.schema.json"));
  validator = ajv.compile(load("results.schema.json"));
  return validator;
}

/** Schema and consistency errors of a parsed file: [{ pointer, message }] (D22). */
function check(obj) {
  const v = schemaValidator();
  if (!v(obj)) return v.errors.map((e) => ({ pointer: e.instancePath || "/", message: e.message + (e.params && e.params.allowedValues ? ` (${e.params.allowedValues.join(", ")})` : "") }));
  const errors = [];
  const t = totals(obj.results);
  // TODO-065: files written before needs-reader existed have no such total.
  for (const k of VERDICTS) if (t[k] !== (k === "needs-reader" ? obj.totals[k] ?? 0 : obj.totals[k])) errors.push({ pointer: `/totals/${k}`, message: `is ${obj.totals[k]}, but results[] has ${t[k]} ${k}` });
  errors.push(...axesErrors(obj));
  const missing = obj.results.filter(isMissing).map((e) => cellKey(e)).sort(byCodePoint);
  errors.push(...require("./baseline").checkFile(obj));
  errors.push(...gateErrors(obj), ...knownErrors(obj));
  if (obj.coverage === null) {
    if (missing.length) errors.push({ pointer: "/coverage", message: `is null, but results[] has ${missing.length} missing entries` });
    return errors;
  }
  const listed = obj.coverage.missing.map((c) => cellKey(c)).sort(byCodePoint);
  if (canonical(listed) !== canonical(missing)) errors.push({ pointer: "/coverage/missing", message: "does not list the same cells as the missing entries in results[]" });
  const L = new Set(obj.coverage.expected_locales.map((l) => l.toLowerCase())), S = new Set(obj.coverage.expected_screens);
  const D = new Set(obj.coverage.expected_devices ?? [null]);
  const T = obj.coverage.expected_text_sizes ? new Set(obj.coverage.expected_text_sizes) : null;
  const inT = (e) => !T || T.has(sizeOf(e.text_size));
  const inCell = obj.results.filter((e) => !isMissing(e) && typeof e.screen === "string" && D.has(e.device ?? null) && inT(e) && L.has(e.locale.toLowerCase()) && S.has(e.screen));
  if (inCell.length !== obj.coverage.received) errors.push({ pointer: "/coverage/received", message: `is ${obj.coverage.received}, but ${inCell.length} entries map to an expected cell` });
  const got = new Set(inCell.map((e) => cellKey(e)));
  const name = (e) => `${e.device != null ? `${e.device}/` : ""}${e.text_size != null ? `${e.text_size}/` : ""}${e.locale}/${e.screen}`;
  obj.results.forEach((e, i) => {
    if (!isMissing(e)) return;
    if (!D.has(e.device ?? null) || !inT(e) || !L.has(e.locale.toLowerCase()) || !S.has(e.screen)) errors.push({ pointer: `/results/${i}`, message: `is missing ${name(e)}, which is not an expected cell` });
    else if (got.has(cellKey(e))) errors.push({ pointer: `/results/${i}`, message: `is missing ${name(e)}, which another entry received` });
  });
  return errors;
}

/** The `axes` a file names that this version does not know (TODO-075 D16). */
const unknownAxes = (obj) => (obj && Array.isArray(obj.axes) ? obj.axes.filter((a) => !AXES.includes(a)) : []);

/** TODO-075 D1, D16: the version and `axes` agree with what the file uses. */
function axesErrors(obj) {
  const errors = [];
  const bad = unknownAxes(obj);
  if (bad.length) errors.push({ pointer: "/axes", message: `names ${bad.join(", ")}, which this catscan (${version}) does not know; upgrade every job of this pipeline to catscan ${obj.run.catscan} or later` });
  const used = axesOf(obj.results, obj.coverage);
  // D9 on read: once the axis is in use, a mapped entry has a device; a platform is the one its label gives.
  if (used.includes("device")) {
    obj.results.forEach((e, i) => {
      if (!isMissing(e) && typeof e.screen === "string" && e.device == null) errors.push({ pointer: `/results/${i}/device`, message: "is null on a mapped entry, but the file uses the device axis (device-missing entries have screen null)" });
    });
  }
  obj.results.forEach((e, i) => {
    if (e.device !== undefined && (e.platform ?? null) !== platformOf(e.device ?? null)) errors.push({ pointer: `/results/${i}/platform`, message: `is ${e.platform ?? null}, but the device ${e.device ?? null} gives ${platformOf(e.device ?? null)}` });
  });
  if (obj.results_schema === 1 && used.length) errors.push({ pointer: "/results_schema", message: `is 1, but the file uses the ${used.join(" and ")} axis, which needs results_schema 2` });
  if (obj.results_schema === 2) {
    for (const a of (obj.axes || []).filter((x) => AXES.includes(x))) if (!used.includes(a)) errors.push({ pointer: "/axes", message: `names ${a}, but no entry or expectation uses it` });
    for (const a of used) if (!(obj.axes || []).includes(a)) errors.push({ pointer: "/axes", message: `does not name ${a}, which the file uses` });
  }
  return errors;
}

/**
 * TODO-077 D15: `gate` agrees with the file's thresholds (each shard's, when `run.thresholds` is null after a mixed
 * merge), a failed check always gates, and a `fail` entry has a failed check or a gating finding.
 */
function gateErrors(obj) {
  const errors = [];
  const ths = obj.run.thresholds ? [obj.run.thresholds] : (obj.run.shards || []).map((r) => r.thresholds).filter(Boolean);
  obj.results.forEach((e, i) => {
    (e.checks || []).forEach((c, j) => {
      if (c.verdict === "fail" && c.gate === false) errors.push({ pointer: `/results/${i}/checks/${j}/gate`, message: "is false, but a failed check always gates" });
    });
    (e.findings || []).forEach((f, j) => {
      // TODO-055 D28: a known finding never gates, whatever its severity.
      if (f.known === true) { if (f.gate === true) errors.push({ pointer: `/results/${i}/findings/${j}/gate`, message: "is true, but a known finding never gates" }); return; }
      if (f.severity === undefined || f.gate === undefined || !ths.length) return;
      if (!ths.some((th) => scale.gates(f, th) === f.gate)) errors.push({ pointer: `/results/${i}/findings/${j}/gate`, message: `is ${f.gate}, but ${f.severity}/${f.certainty} under the run's thresholds gives ${!f.gate}` });
    });
    // Only an entry whose findings carry `gate`: an older or hand-made one may hold none.
    const scaled = (e.findings || []).some((f) => f.gate !== undefined);
    if (scaled && e.verdict === "fail" && !(e.checks || []).some((c) => c.verdict === "fail") && !(e.findings || []).some((f) => f.gate !== false)) {
      errors.push({ pointer: `/results/${i}/verdict`, message: "is fail, but no check failed and no finding gates" });
    }
    if (scaled && e.verdict === "pass" && ((e.checks || []).some((c) => c.verdict === "fail") || (e.findings || []).some((f) => f.gate === true))) {
      errors.push({ pointer: `/results/${i}/verdict`, message: "is pass, but a check failed or a finding gates" });
    }
  });
  return errors;
}

/** TODO-055: the `known` block's counts agree with the findings' `known` flags and its `gone` rows. */
function knownErrors(obj) {
  if (!obj.known) return [];
  const all = obj.results.flatMap((e) => e.findings || []);
  const want = { known: all.filter((f) => f.known === true).length, new: all.filter((f) => f.known === false).length, gone: obj.known.gone.reduce((n, r) => n + r.count, 0) };
  return Object.keys(want).filter((k) => obj.known.counts[k] !== want[k]).map((k) => ({ pointer: `/known/counts/${k}`, message: `is ${obj.known.counts[k]}, but the file has ${want[k]}` }));
}

/**
 * Applies threshold flags to a file in place (TODO-077 "Results file"): gate and verdicts from each item's stored
 * severity and certainty, then totals. Returns the warnings (`unscaled-items`).
 */
function applyThresholds(file, th) {
  let unscaled = 0;
  for (const e of file.results) unscaled += scale.regate(e, th);
  file.run.thresholds = { ...th };
  // A later merge of this file reads the records, so they say the thresholds the gates now follow (review fix).
  file.run.shards = file.run.shards.map((r) => ({ ...r, thresholds: { ...th } }));
  file.totals = totals(file.results);
  // Review fix: a stored baseline comparison was made under the old verdicts, so a cell it marks skippable may now
  // fail, and the file is no longer the one approved. `catscan report --baseline` compares again after this.
  if (file.baseline) { file.baseline = null; for (const e of file.results) e.change = null; }
  delete file.approved;
  return unscaled ? [{ code: "unscaled-items", message: `${unscaled} finding${unscaled === 1 ? "" : "s"} from an older catscan ${unscaled === 1 ? "has" : "have"} no severity and still gate${unscaled === 1 ? "s" : ""}`, hint: "rerun those shards with this catscan version" }] : [];
}

/** Reads and parses one results file. Throws CatscanError results-unreadable (exit 4) when it cannot be read. */
function read(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    throw new CatscanError("results-unreadable", `cannot read the results file ${file}: ${e.code || e.message}`, "check the path");
  }
  try { return { obj: JSON.parse(text), parseError: null }; } catch (e) { return { obj: null, parseError: e.message }; }
}

// ---- merge --------------------------------------------------------------------------------------------

/**
 * TODO-075 D9: once any entry or expectation has a device, a mapped entry with none makes no cell: its screen
 * becomes null and it carries `device-missing`. Entries already unmapped keep their warnings. Returns new entries.
 */
function unmapDeviceless(entries, expectDevices) {
  const devices = [...new Set([...(expectDevices || []), ...entries.map((e) => e.device).filter((d) => d != null)])].sort(byDevice);
  if (!devices.length) return entries;
  return entries.map((e) => {
    if (e.device != null || typeof e.screen !== "string") return e;
    return { ...e, screen: null, warnings: [...e.warnings.filter((w) => w.code !== "device-missing"), DEVICE_MISSING(e.path, devices)] };
  });
}

// TODO-077 D15: each record keeps its thresholds and registry, so a merge of merged files still sees a mixture.
const shardOf = (run) => ({ started_at: run.started_at, finished_at: run.finished_at, argv: run.argv, host: run.host, ci: run.ci, thresholds: run.thresholds ?? null, registry: run.registry ?? null, ...(run.allow ? { allow: run.allow } : {}) });
const digest = (results) => crypto.createHash("sha256").update(canonical(results.filter((e) => !isMissing(e)))).digest("hex");
/** A plain file's one shard record, or a merged file's records (spec 27 D28). */
const shardRecords = (s) => (s.run.shards.length ? s.run.shards : [{ ...shardOf(s.run), results_digest: digest(s.results), ...(s.known ? { known_digest: s.known.digest } : {}) }]);
const same = (xs) => xs.every((x) => canonical(x) === canonical(xs[0]));

/**
 * Merges parsed, valid shard files (spec 27 "Merge"). `exp` is the merge-time expectations or null; `layout`
 * the merge-time --layout or null. Returns { file, warnings }. Throws UsageError for the exit 2 cases.
 */
function merge(shards, { exp, layout, argv, thresholds = null, records = null }) {
  // TODO-075: versions 1 and 2 merge together (an unknown version fails validation first); an unknown axis refuses.
  for (const s of shards) {
    const bad = unknownAxes(s);
    if (bad.length) throw new UsageError("results-axis-unknown", `a results file uses the axis ${bad.join(", ")}, which this catscan (${version}) does not know`, `upgrade every job of this pipeline to catscan ${s.run.catscan} or later`);
  }
  // A shard is its run fields plus a digest of its results: matrix jobs can share every run field (D28).
  // Merged inputs carry each shard's record, so a shard given twice is caught directly or inside merged files.
  // `records` (TODO-055): identities taken before --known rewrote the results, so the digests stay the shard's own.
  const flat = shards.flatMap((s) => records?.get(s) ?? shardRecords(s));
  // Identity is the run fields and the digest: thresholds and registry are absent on records from before TODO-077,
  // and threshold flags on a merge rewrite them (applyThresholds), yet the shard is the same.
  // `allow` too (TODO-055 D30): a record an older catscan rewrote has none, yet it is the same shard.
  const keys = flat.map(({ thresholds: _t, registry: _r, allow: _a, known_digest: _k, ...r }) => canonical(r));
  if (new Set(keys).size !== keys.length) throw new UsageError("results-duplicate-shard", "the same shard is given twice (directly or inside a merged file), so its results would count twice", "pass each shard once, and never the --out file as an input");
  if (!same(shards.map((s) => s.run.build))) throw new UsageError("results-build-mismatch", "the results files are for different builds (run.build differs)", "merge only shards of one build, or pass the same --build to every shard");
  const warnings = [];
  if (!same(shards.map((s) => s.run.catscan))) warnings.push({ code: "mixed-versions", message: `the results files come from different catscan versions: ${[...new Set(shards.map((s) => s.run.catscan))].sort(byCodePoint).join(", ")}`, hint: "pin one @catscan/cli version for every shard" });
  const withCov = shards.filter((s) => s.coverage);
  let lay = layout;
  if (!lay) {
    const ls = [...new Set(withCov.map((s) => s.coverage.layout))];
    if (ls.length > 1) throw new UsageError("results-layout-mismatch", `the results files use different layouts: ${ls.sort(byCodePoint).join(", ")}`, `--layout '${ls[0]}'`);
    lay = ls[0] || DEFAULT_LAYOUT;
  }
  let expect = exp;
  if (withCov.length) {
    const u = (k) => {
      const m = new Map();
      for (const v of withCov.flatMap((s) => s.coverage[k])) if (!m.has(k === "expected_locales" ? v.toLowerCase() : v)) m.set(k === "expected_locales" ? v.toLowerCase() : v, v);
      return [...m.values()].sort(byCodePoint);
    };
    // A merge flag replaces its own axis only (TODO-075 D22): --expect-devices alone keeps the shards' locales and screens.
    expect = { locales: exp?.locales ?? u("expected_locales"), screens: exp?.screens ?? u("expected_screens"), devices: exp?.devices ?? null, textSizes: exp?.textSizes ?? null };
  }
  // TODO-075 "Coverage": without --expect-devices the expected devices are the union of the shards' lists, and a shard
  // with no coverage adds the devices of its envelopes.
  if (expect && !expect.devices) {
    const ds = new Set();
    for (const s of shards) {
      if (s.coverage) for (const d of s.coverage.expected_devices || []) ds.add(d);
      else for (const e of s.results) if (!isMissing(e) && typeof e.screen === "string" && e.device != null) ds.add(e.device);
    }
    if (ds.size) expect = { ...expect, devices: [...ds] };
  }
  // TODO-076: the same union for text sizes; once any shard has a size, a shard with none adds `default` (D6), so a
  // run from before the axis merges with a --text-size large run as its default cells.
  if (expect && !expect.textSizes) {
    const ts = new Set();
    let plain = false;
    for (const s of shards) {
      const mapped = s.results.filter((e) => !isMissing(e) && typeof e.screen === "string");
      const own = s.coverage ? s.coverage.expected_text_sizes || [] : mapped.some((e) => e.text_size != null) ? mapped.map((e) => sizeOf(e.text_size)) : [];
      // A shard with no mapped cell (all missing or unmapped) has no size to add, not even `default`.
      if (own.length) for (const t of own) ts.add(t); else if (s.coverage || mapped.length) plain = true;
    }
    if (ts.size) expect = { ...expect, textSizes: [...(plain ? ts.add("default") : ts)].sort(byTextSize) };
  }
  // D17: duplicate-cell is recomputed over every shard, per command (TODO-043): a `check` and an `untranslated`
  // result for one screenshot are one cell seen twice, not a duplicate.
  let entries = shards.flatMap((s) => s.results.filter((e) => !isMissing(e)))
    .map((e) => ({ ...e, warnings: e.warnings.filter((w) => w.code !== "duplicate-cell") }));
  entries = unmapDeviceless(entries, expect && expect.devices);
  const byCommand = new Map();
  for (const e of entries) {
    if (typeof e.screen !== "string") continue;
    if (!byCommand.has(e.command)) byCommand.set(e.command, []);
    byCommand.get(e.command).push(e);
  }
  for (const [command, es] of byCommand) {
    const counts = cellCounts(es);
    for (const e of es) {
      const n = counts.get(cellKey(e));
      if (n > 1) e.warnings = [...e.warnings, DUPLICATE(e, n, command)];
    }
  }
  const commands = [...new Set(entries.map((e) => e.command))];
  const command = commands.length === 1 ? commands[0] : "check"; // D19
  const cov = coverage(entries, expect, lay, command);
  for (const m of cov.missing) scale.annotate(m, thresholds ?? scale.DEFAULTS); // TODO-077: a missing cell gates (critical, high)
  flat.sort((a, b) => byCodePoint(a.started_at, b.started_at) || byCodePoint(canonical(a), canonical(b)));
  const hosts = shards.map((s) => s.run.host), cis = shards.map((s) => s.run.ci);
  const all = sortResults(withChange([...entries, ...cov.missing]));
  const axes = axesOf(all, cov.coverage);
  const file = {
    results_schema: axes.length ? 2 : 1,
    ...(axes.length ? { axes } : {}),
    run: {
      catscan: version,
      started_at: shards.map((s) => s.run.started_at).sort(byCodePoint)[0],
      finished_at: shards.map((s) => s.run.finished_at).sort(byCodePoint).at(-1),
      argv,
      host: same(hosts) ? hosts[0] : null,
      ci: same(cis) ? cis[0] : null,
      build: shards[0].run.build,
      shards: flat,
      thresholds: null,
      registry: null,
    },
    coverage: cov.coverage,
    totals: null,
    results: all,
    baseline: null,
  };
  file.totals = totals(file.results);
  // TODO-077 D15: the flags recompute every gate; else the shards' common value, or null with mixed-*.
  const common = (k, code, what, flagHint) => {
    const vals = flat.map((r) => r[k] ?? null);
    if (same(vals)) return vals[0];
    const shown = [...new Set(vals.map((v) => (v && typeof v === "object" ? flags(v) : String(v))))].sort(byCodePoint);
    warnings.push({ code, message: `the results files have different ${what}: ${shown.join("; ")}`, hint: flagHint });
    return null;
  };
  const flags = (th) => `--min-severity ${th.min_severity} --min-certainty ${th.min_certainty}`;
  if (thresholds) warnings.push(...applyThresholds(file, thresholds));
  else file.run.thresholds = common("thresholds", "mixed-thresholds", "thresholds", "pass --min-severity and --min-certainty to results merge to recompute one set");
  file.run.registry = common("registry", "mixed-registry", "finding registries (catscan versions)", "pass --min-severity and --min-certainty to results merge to recompute one set, or rerun the shards with one catscan version");
  return { file, warnings };
}

module.exports = {
  AXES, RESULTS_SCHEMAS, mapInputs, cellKey, fillLayout, parseLayout, platformOf, suggestLayout, unmapDeviceless, unknownAxes, DEVICE_MISSING, byDevice,
  TEXT_SIZE_ORDER, byTextSize, sizeOf,
  DEFAULT_LAYOUT, isMissing, knownLocales, needsLocales, mapPath, expectations, localesFromCatalogs, localesFromFiles, catalogFileLocales, coverage, cellCounts, DUPLICATE,
  privatePath, privateArgv, privateEnvelope, scrubPairs, ciInfo, build, write, writeAtomic, check, read, merge, applyThresholds, canonical, totals, shardRecords,
};
