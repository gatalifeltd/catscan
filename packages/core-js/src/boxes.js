// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Element boxes for `catscan truncated` (spec 06 "--boxes format"): loading and checking a boxes file,
// finding sidecars, and `catscan boxes`, the converters from e2e dumps (D9, D10, D17, D19, D36-D39, D50, D51).
const fs = require("fs");
const path = require("path");
const { UsageError, closest } = require("./args");
const xml = require("./xml");

const SOURCES = ["xcuitest", "uiautomator", "maestro", "playwright"];
const MAX_BYTES = 32 * 1024 * 1024;
const round4 = (v) => Math.round(v * 10000) / 10000;

function readText(file, code, what, hint) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw new UsageError(code, `${what} ${file} is over 32 MB`, hint);
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(code, `cannot read ${what} ${file}: ${e.code || e.message}`, hint);
  }
}

// TODO-073 D39: a sidecar may also say the screen was upside down (uiautomator `rotation` 2); fit skips its cutout.
const ORIENTATIONS = ["portrait", "landscape-left", "landscape-right", "portrait-upside-down"];

/** A boxes file, checked field by field; every problem names the field (D27). */
function load(file) {
  const text = readText(file, "boxes-not-found", "the boxes file", "check the --boxes path; it is read from the working directory");
  let o;
  try { o = JSON.parse(text.replace(/^﻿/, "")); } catch (e) { throw invalid(file, `not JSON (${e.message})`); }
  return check(o, file);
}

function invalid(file, m) {
  return new UsageError("invalid-boxes", `${file}: ${m}`, `catscan boxes <source> <dump> > ${file} writes a valid file`);
}

/** A parsed boxes object, checked as `load` checks a file (MCP passes one inline, TODO-046 D14); `file` names it. */
function check(o, file) {
  const bad = (m) => invalid(file, m);
  if (!o || typeof o !== "object" || Array.isArray(o)) throw bad("must be an object {image, elements}");
  const img = o.image;
  const dim = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!img || !dim(img.width) || !dim(img.height)) throw bad("image must be {width, height} above 0");
  if (!Array.isArray(o.elements)) throw bad("elements must be an array");
  const elements = o.elements.map((e, i) => {
    const at = `elements[${i}]`;
    if (!e || typeof e !== "object") throw bad(`${at} must be an object`);
    const b = e.box;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === "number" && v >= 0 && v <= 1) || !(b[2] > 0) || !(b[3] > 0)) {
      throw bad(`${at}.box must be 4 numbers in 0..1 with width and height above 0`);
    }
    for (const k of ["id", "text"]) if (e[k] !== undefined && e[k] !== null && typeof e[k] !== "string") throw bad(`${at}.${k} must be a string`);
    for (const k of ["clips", "offscreen", "dynamic", "graphic", "panel", "scrolls", "control", "enabled"]) if (e[k] !== undefined && typeof e[k] !== "boolean") throw bad(`${at}.${k} must be true or false`);
    const out = { id: e.id ?? null, box: b, clips: e.clips ?? true };
    if (typeof e.text === "string") out.text = e.text;
    if (e.offscreen) out.offscreen = true;
    if (e.graphic) out.graphic = true; // TODO-046: a drawn non-text leaf (icon, image, control)
    if (e.dynamic) out.dynamic = true; // TODO-039 D10: user names, server content; never judged as hardcoded
    if (e.panel) out.panel = true; // TODO-049 D2: an opaque surface drawn over what is not inside it
    if (e.scrolls) out.scrolls = true; // TODO-049 D2: inside a scroll container that can still scroll
    if (e.control) out.control = true; // TODO-073 D7: tappable (button, switch, link, tab)
    if (e.enabled === false) out.enabled = false; // TODO-054 D7: a disabled control, exempt from contrast
    // TODO-074 D2: the declared line limit (a game export or by hand; no native dump states it).
    if (e.max_lines !== undefined && e.max_lines !== null) {
      if (!Number.isInteger(e.max_lines) || e.max_lines < 1) throw bad(`${at}.max_lines must be an integer of at least 1`);
      out.max_lines = e.max_lines;
    }
    return out;
  });
  // TODO-073 D5: the screen orientation of the dump, when the source states it (uiautomator `rotation`).
  if (o.orientation !== undefined && o.orientation !== null && !ORIENTATIONS.includes(o.orientation)) throw bad(`orientation must be one of ${ORIENTATIONS.join(", ")}`);
  // TODO-054 D6: image pixels per dump unit (point), when the converter knew both.
  if (o.scale !== undefined && o.scale !== null && !(typeof o.scale === "number" && o.scale >= 1 && o.scale <= 4)) throw bad("scale must be a number from 1 to 4");
  return { image: { width: img.width, height: img.height }, ...(o.orientation ? { orientation: o.orientation } : {}), ...(typeof o.scale === "number" ? { scale: o.scale } : {}), elements };
}

/** D6: the sidecar for an input under `--boxes <dir>`: its path inside the folder argument, `.boxes.json`. */
function sidecar(dir, inp) {
  const rel = inp.argIsDir ? path.relative(inp.arg, inp.path) : path.basename(inp.path);
  return path.join(dir, rel.slice(0, rel.length - path.extname(rel).length) + ".boxes.json");
}

/**
 * `--boxes <file|dir>` for a run (spec 06 D6, D7; TODO-046 D1: shared by truncated and overlap). Loads every file up
 * front, so a malformed one stops the run before any recognition. Returns inp -> { boxes, looked }: `boxes` the
 * loaded file or null; `looked` the sidecar path that was missing, "-" for stdin under a folder, null otherwise.
 */
function forRun(arg, list) {
  if (arg === null || arg === undefined) return () => ({ boxes: null, looked: null });
  let st = null;
  try { st = fs.statSync(arg); } catch {}
  if (!st || !st.isDirectory()) {
    if (!st) load(arg); // a missing path is boxes-not-found, not boxes-one-image
    if (list.length > 1) throw new UsageError("boxes-one-image", `--boxes ${arg} applies to one image, but ${list.length} were given`, "--boxes <dir>, with <name>.boxes.json next to each image");
    const file = load(arg);
    return () => ({ boxes: file, looked: null });
  }
  const sidecars = new Map();
  for (const inp of list) {
    if (inp.stdin) continue;
    const f = sidecar(arg, inp);
    sidecars.set(inp.path, fs.existsSync(f) ? load(f) : f);
  }
  return (inp) => {
    if (inp.stdin) return { boxes: null, looked: "-" };
    const s = sidecars.get(inp.path);
    return typeof s === "object" ? { boxes: s, looked: null } : { boxes: null, looked: s };
  };
}

/** Width and height of a PNG or JPEG, for `--image` (D17). */
function imageSize(file) {
  let b;
  try { b = fs.readFileSync(file); } catch (e) {
    throw new UsageError("missing-image", `cannot read the image ${file}: ${e.code || e.message}`, "check the --image path");
  }
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  for (let i = 2; b[0] === 0xff && b[1] === 0xd8 && i + 9 < b.length;) {
    if (b[i] !== 0xff) break;
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  throw new UsageError("missing-image", `${file} is not a PNG or JPEG`, "pass the screenshot the dump was taken with");
}

/** D36: the first non-empty field in the format's order. */
const first = (...v) => v.find((t) => typeof t === "string" && t.trim()) || null;

/**
 * D38, D50, D51 on a tree dump (raw elements carry `parent`, the index of their parent or -1, parents first):
 * a child with its parent's text and box (within half a dump unit) is dropped, then an element keeps its text
 * only when no descendant kept one or one descendant kept the same text. A displayed-text field (`shown`) always
 * keeps it (D64): an Android paragraph's link spans carry content-desc. Flat dumps (no `parent`) pass through.
 */
function treeText(raw) {
  if (!raw.length || raw[0].parent === undefined) return raw;
  const same = (a, b) => Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.w - b.w) <= 0.5 && Math.abs(a.h - b.h) <= 0.5;
  const up = raw.map((r) => r.parent); // parent after dropped duplicates
  const drop = raw.map(() => false);
  raw.forEach((r, i) => {
    let p = up[i];
    while (p >= 0 && drop[p]) p = up[p];
    up[i] = p;
    if (p >= 0 && r.text && r.text === raw[p].text && same(r, raw[p])) drop[i] = true;
  });
  const below = raw.map(() => new Set()); // texts kept by descendants
  const text = raw.map((r) => r.text);
  for (let i = raw.length - 1; i >= 0; i--) {
    if (drop[i]) continue;
    if (text[i] && !raw[i].shown && below[i].size && !below[i].has(text[i])) text[i] = null;
    const p = up[i];
    if (p < 0) continue;
    for (const t of below[i]) below[p].add(t);
    if (text[i]) below[p].add(text[i]);
  }
  return raw.flatMap((r, i) => (drop[i] ? [] : [{ ...r, text: text[i] }]));
}

/**
 * Raw elements ({id, x, y, w, h, text, clips}) in the dump's units -> the boxes format: normalized by the
 * screen extent, clipped to it, `offscreen` when the dump box extends past it (D19).
 */
function normalize(raw, screen, image) {
  const elements = [];
  for (const r of raw) {
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
    const x1 = Math.min(screen.width, r.x + r.w), y1 = Math.min(screen.height, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) continue; // wholly off screen
    const e = { id: r.id || null, box: [x0 / screen.width, y0 / screen.height, (x1 - x0) / screen.width, (y1 - y0) / screen.height].map(round4), clips: r.clips ?? true };
    if (e.box[2] <= 0 || e.box[3] <= 0) continue;
    if (r.text) e.text = r.text;
    if (r.graphic) e.graphic = true; // TODO-046: drawn non-text leaf
    if (r.panel) e.panel = true; // TODO-049 D4
    if (r.scrolls) e.scrolls = true;
    if (r.control) e.control = true; // TODO-073 D7
    if (r.enabled === false) e.enabled = false; // TODO-054 D7
    // Half a unit of slack: frames land on fractional points.
    if (r.x < -0.5 || r.y < -0.5 || r.x + r.w > screen.width + 0.5 || r.y + r.h > screen.height + 0.5) e.offscreen = true;
    elements.push(e);
  }
  // TODO-054 D6: a dump in points with its screenshot gives the device scale (pixels per point).
  const scale = image && screen.width > 0 ? Math.round((image.width / screen.width) * 100) / 100 : null;
  return { image: image || { width: screen.width, height: screen.height }, ...(scale && scale > 1 && scale <= 4 ? { scale } : {}), elements };
}

/** TODO-046: `graphic` only on a leaf (no element below it in the tree); containers never get it. */
function leafGraphics(raw) {
  const parents = new Set(raw.map((r) => r.parent).filter((p) => p !== undefined && p >= 0));
  raw.forEach((r, i) => { if (r.graphic && parents.has(i)) r.graphic = false; });
  return raw;
}

/** TODO-049 D4: `scrolls` on every element below a scroll container (a tree dump: `parent` indexes, parents first). */
function scrollFlags(raw, isScroll) {
  raw.forEach((r) => { r.scrolls = r.parent >= 0 && (raw[r.parent].scrolls || isScroll[r.parent]); });
  return raw;
}

// TODO-046 "graphic per converter": element types that draw no text of their own. TODO-049 D5, D13 adds the control
// kinds that passed their gate: fields (a field's border is drawn; its text still counts for truncated) and sliders.
// TODO-073 D7, D12: one table with a graphic and a control column, so the two cannot drift.
const XCUI_TYPES = {
  Image: "g", Icon: "g", ProgressIndicator: "g", ActivityIndicator: "g", PageIndicator: "g", TextField: "g", SecureTextField: "g", SearchField: "g",
  Switch: "gc", Slider: "gc", Toggle: "gc", Button: "gc", Link: "c", Tab: "c",
};
const XCUI_GRAPHIC = new Set(Object.keys(XCUI_TYPES).filter((k) => XCUI_TYPES[k].includes("g")));
const XCUI_CONTROL = new Set(Object.keys(XCUI_TYPES).filter((k) => XCUI_TYPES[k].includes("c")));
// TODO-073 D7: Android marks tappable views itself (`clickable`); uiautomator `rotation` 1 and 3 are the landscapes,
// 2 is upside down (D39).
const ANDROID_ROTATION = { 0: "portrait", 1: "landscape-left", 2: "portrait-upside-down", 3: "landscape-right" };
const ANDROID_GRAPHIC = /(ImageView|ImageButton|Switch|CheckBox|RadioButton|ProgressBar|SeekBar|Slider|EditText|AutoCompleteTextView)$/;
// TODO-049 D5: react-native-svg draws an icon as an SvgView over shape views; the root is the one graphic.
const ANDROID_SVG = /^com\.horcrux\.svg\.SvgView$/;
// TODO-049 D4: surfaces drawn over the screen (a dump names them only on iOS) and scroll containers.
const XCUI_PANEL = new Set(["Keyboard", "Alert", "Sheet", "Popover", "Dialog", "Toolbar", "TabBar", "NavigationBar"]);
const XCUI_SCROLL = new Set(["ScrollView", "Table", "CollectionView", "WebView"]);

function invalidDump(file, source, why) {
  return new UsageError("invalid-dump", `${file} is not a ${source} dump: ${why}`, "docs/truncation-capture.md shows how to save it");
}

/** `XCUIElement.debugDescription`: frames in points; the first Window is the screen (D17). */
function xcuitest(text, file) {
  const re = /^\s*(?:→)?([A-Za-z][\w ]*?)(?: \([^)]*\))?, 0x[0-9a-fA-F]+, (?:pid: \d+, )?\{\{(-?[\d.]+), (-?[\d.]+)\}, \{([\d.]+), ([\d.]+)\}\}(.*)$/;
  // Quotes inside a label are not escaped ('Anna's Konto'): a quoted value ends at a quote before ", key:" or the end.
  const attr = (rest, k) => {
    const m = new RegExp(`, ${k}: '(.*?)'(?=, [A-Za-z]+: |, (?:Disabled|Selected|Focused)(?:,|\\s*$)|\\s*$)`).exec(rest) || new RegExp(`, ${k}: ([^,]*)`).exec(rest);
    return m ? m[1] : null;
  };
  const raw = [], scroll = [];
  const stack = []; // [indent, raw index] of open ancestors; the tree comes from the indentation
  let screen = null;
  for (const l of text.split(/\r?\n/)) {
    const m = re.exec(l);
    if (!m) continue;
    const indent = /^[\s→]*/.exec(l)[0].length;
    while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
    const [type, x, y, w, h] = [m[1], +m[2], +m[3], +m[4], +m[5]];
    if (type === "Window" && !screen && w > 0 && h > 0) { screen = { width: w, height: h }; continue; }
    if (type === "Application" || type === "Window") continue;
    const [label, value, title] = ["label", "value", "title"].map((k) => attr(m[6], k));
    // D36: label, value, title; a text-entry field shows its value.
    const entry = ["TextField", "SecureTextField", "TextView", "SearchField"].includes(type);
    const t = entry ? first(value, label, title) : first(label, value, title);
    const shown = entry ? Boolean(first(value)) : type === "StaticText";
    raw.push({ id: attr(m[6], "identifier"), x, y, w, h, text: t, shown, graphic: XCUI_GRAPHIC.has(type), control: XCUI_CONTROL.has(type), panel: XCUI_PANEL.has(type), enabled: !/, Disabled(,|\s*$)/.test(m[6].replace(/: '.*?'(?=, [A-Za-z]+: |, (?:Disabled|Selected|Focused)(?:,|\s*$)|\s*$)/g, ": ''")), parent: stack.length ? stack[stack.length - 1][1] : -1 });
    scroll.push(XCUI_SCROLL.has(type));
    stack.push([indent, raw.length - 1]);
  }
  if (!screen) throw invalidDump(file, "xcuitest", "no Window frame (save XCUIApplication().debugDescription)");
  return { raw: scrollFlags(leafGraphics(raw), scroll), screen };
}

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

/** `uiautomator dump` XML: bounds in screen pixels, so it needs the screenshot's size (D17). */
function uiautomator(text, file, image) {
  if (!image) throw new UsageError("missing-image", "uiautomator dumps are in screen pixels; --image is needed to normalize them", `catscan boxes uiautomator ${file} --image ${file.replace(/\.uia\.xml$|\.xml$/, "")}.png`);
  let root;
  try { root = xml.parse(text); } catch (e) { throw invalidDump(file, "uiautomator", e.message); }
  if (root.name !== "hierarchy") throw invalidDump(file, "uiautomator", "no <hierarchy> root");
  const raw = [], scroll = [];
  const walk = (n, parent) => {
    for (const c of n.children) {
      if (typeof c !== "object" || c.name !== "node") continue;
      const b = BOUNDS.exec(c.attrs.bounds || "");
      let me = parent;
      if (b) {
        const [x1, y1, x2, y2] = b.slice(1).map(Number);
        const a = c.attrs;
        const svg = ANDROID_SVG.test(a.class || "");
        raw.push({ id: a["resource-id"] || null, x: x1, y: y1, w: x2 - x1, h: y2 - y1, text: first(a.text, a["content-desc"], a.hint, a.hintText), shown: Boolean(first(a.text)), graphic: svg || ANDROID_GRAPHIC.test(a.class || ""), control: a.clickable === "true", enabled: a.enabled !== "false", parent });
        scroll.push(a.scrollable === "true");
        me = raw.length - 1;
        if (svg) continue; // its shape children are the drawing, not elements
      }
      walk(c, me);
    }
  };
  walk(root, -1);
  return { raw: scrollFlags(leafGraphics(raw), scroll), screen: image, orientation: ANDROID_ROTATION[root.attrs.rotation] };
}

/** `maestro hierarchy` JSON: pixels on Android, points on iOS; the root's width tells which (D17). */
function maestro(text, file, image) {
  let o;
  try { o = JSON.parse(text); } catch (e) { throw invalidDump(file, "maestro", `not JSON (${e.message})`); }
  const raw = [], scroll = [];
  const walk = (n, parent) => {
    if (!n || typeof n !== "object") return;
    const a = n.attributes || {};
    const b = BOUNDS.exec(a.bounds || "");
    let me = parent;
    if (b) {
      const [x1, y1, x2, y2] = b.slice(1).map(Number);
      // D36: React Native on iOS keeps every displayed string only in accessibilityText (TODO-018).
      // TODO-046: Android dumps carry the view class; the iOS hierarchy has no element type, so no graphic.
      const svg = ANDROID_SVG.test(a.class || "");
      raw.push({ id: a["resource-id"] || a.identifier || null, x: x1, y: y1, w: x2 - x1, h: y2 - y1, text: first(a.text, a.accessibilityText, a.hintText), shown: Boolean(first(a.text)), graphic: svg || ANDROID_GRAPHIC.test(a.class || ""), control: a.clickable === true || a.clickable === "true", enabled: a.enabled !== false && a.enabled !== "false", parent });
      scroll.push(a.scrollable === true || a.scrollable === "true");
      me = raw.length - 1;
      if (svg) return; // its shape children are the drawing, not elements
    }
    for (const c of n.children || []) walk(c, me);
  };
  walk(o, -1);
  scrollFlags(leafGraphics(raw), scroll);
  if (!raw.length) throw invalidDump(file, "maestro", "no element with bounds");
  const root = raw.reduce((m, r) => (r.w * r.h > m.w * m.h ? r : m));
  const pixels = image && Math.abs(root.w - image.width) <= 1;
  // Points (iOS): the root is the screen. Android's root can omit the navigation bar, so pixels need --image.
  const screen = pixels ? image : { width: root.x + root.w, height: root.y + root.h };
  // The root stays in the tree for treeText and leaves the output after it.
  root.root = true;
  return { raw, screen };
}

/** The page script's output (boxes/playwright-page.js): CSS pixels in the viewport (D33). */
function playwright(text, file) {
  let o;
  try { o = JSON.parse(text); } catch (e) { throw invalidDump(file, "playwright", `not JSON (${e.message})`); }
  if (!o || !o.viewport || !(o.viewport.width > 0) || !Array.isArray(o.elements)) throw invalidDump(file, "playwright", "no viewport or elements (save page.evaluate(collect))");
  const raw = o.elements.filter((e) => e && e.rect).map((e) => ({
    id: e.id || null, x: e.rect.x, y: e.rect.y, w: e.rect.width, h: e.rect.height, text: first(e.text, e.ariaLabel),
    clips: (e.overflow && e.overflow !== "visible") || e.textOverflow === "ellipsis",
    graphic: e.graphic === true, panel: e.panel === true, scrolls: e.scrolls === true, control: e.control === true,
  }));
  return { raw, screen: o.viewport };
}

const CONVERTERS = { xcuitest, uiautomator, maestro, playwright };

/** `catscan boxes <source> <dump> [--image <png>]`: returns { boxes, warnings }. */
function convert(source, file, imageFile) {
  if (!CONVERTERS[source]) {
    const s = closest(source, SOURCES);
    throw new UsageError("unknown-source", `unknown boxes source ${source}${s ? `; did you mean ${s}?` : ""}`, "catscan boxes xcuitest, uiautomator, maestro or playwright <dump>");
  }
  const image = imageFile ? imageSize(imageFile) : null;
  const text = readText(file, "invalid-dump", "the dump", "docs/truncation-capture.md shows how to save it");
  const { raw, screen, orientation } = CONVERTERS[source](text, file, image);
  const boxes = normalize(treeText(raw).filter((r) => !r.root), screen, image);
  if (orientation) boxes.orientation = orientation;
  const warnings = [];
  if (!boxes.elements.some((e) => e.text)) {
    warnings.push({ code: "dump-no-text", message: `${file} has no element with displayed text; the boxes file has no text to compare`, hint: "capture after the screen has settled" });
  }
  return { boxes, warnings };
}

module.exports = { load, check, sidecar, forRun, convert, imageSize, normalize, treeText, SOURCES };
