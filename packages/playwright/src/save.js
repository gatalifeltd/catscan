// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-088: the opt-in save folder. Each checked shot goes to <dir>/<locale>/<screen>.png with its boxes sidecar
// <screen>.boxes.json, which `catscan formats|fit|contrast <dir> --boxes <dir>` read through the default
// `{locale}/{screen}` layout. <screen> is <render>/<spec>/<title>-<hash>-<n> (D2, D3) or <render>/<screen option> (D4).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { fail } = require("./verdict");

const ENV = "CATSCAN_SAVE_DIR";
const TITLE_MAX = 80;

/** One path segment: runs outside [A-Za-z0-9._-] become "-", no leading or trailing "-" or "." (so never ".."). */
function slug(s, max = Infinity) {
  const t = String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+/, "");
  return t.slice(0, max).replace(/[-.]+$/, "");
}

/** D1: the absolute folder, or null when saving is off. `saveDir` wins; `false` turns the env var off too. */
function root(defaults, getenv = (k) => process.env[k]) {
  if (defaults.saveDir === false) return null;
  const dir = typeof defaults.saveDir === "string" ? defaults.saveDir : getenv(ENV);
  return typeof dir === "string" && dir.trim() ? path.resolve(dir) : null;
}

/** A `screen` option as path segments; empty when it slugs to nothing (a usage error at the call). */
const screenSegments = (s) => String(s).split("/").map((x) => slug(x)).filter(Boolean);

/** Page side: what <render> needs besides the browser type (D2). */
const pageRender = () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, dark: matchMedia("(prefers-color-scheme: dark)").matches });

/** D2: `<browser>-<W>x<H>[-<dpr>x][-dark]`, from the page, so locale projects that render alike share it. */
async function render(page, info) {
  let browser = null;
  try { browser = page.context().browser().browserType().name(); } catch {}
  if (!browser) browser = (info.project && info.project.use && info.project.use.browserName) || "browser";
  let r = null;
  try { r = await page.evaluate(pageRender); } catch {}
  let vp = null;
  try { vp = page.viewportSize(); } catch {}
  const w = (vp && vp.width) || (r && r.width) || 0, h = (vp && vp.height) || (r && r.height) || 0;
  const dpr = r && Number.isFinite(r.dpr) ? Math.round(r.dpr * 100) / 100 : 1;
  return slug(`${browser}-${w}x${h}${dpr !== 1 ? `-${dpr}x` : ""}${r && r.dark ? "-dark" : ""}`);
}

// D3: the call count per test run (a TestInfo; a retry gets a new one) and locale, whether or not the call saves.
const counts = new WeakMap();
function count(info, locale) {
  let m = counts.get(info);
  if (!m) counts.set(info, (m = new Map()));
  const n = (m.get(locale) || 0) + 1;
  m.set(locale, n);
  return n;
}

/** The path below the folder, without extension: <locale>/<render>/<spec>/<title>-<hash>-<n>, or the `screen` option. */
function relName({ info, locale, renderLabel, n, screen }) {
  let segs;
  if (screen !== undefined) segs = screenSegments(screen);
  else {
    const file = info.file || "";
    const base = info.project && info.project.testDir ? path.relative(info.project.testDir, file) : path.basename(file);
    const spec = base.slice(0, base.length - path.extname(base).length).split(/[\\/]/).map((x) => slug(x)).filter(Boolean);
    // titlePath starts with the file; the rest is describe blocks, then the title.
    const titles = (info.titlePath || []).slice(1);
    const hash = crypto.createHash("sha1").update(JSON.stringify(titles)).digest("hex").slice(0, 6);
    segs = [...spec, `${slug(titles.join(" > "), TITLE_MAX) || "test"}-${hash}-${n}`];
  }
  // D5: a repeatEach repeat has its own files, so concurrent repeats never mix a PNG and a sidecar.
  if (info.repeatEachIndex > 0) segs[segs.length - 1] += `-repeat${info.repeatEachIndex}`;
  return [locale, renderLabel, ...segs].join("/");
}

// TODO-107: temp files get a random name and are opened O_CREAT|O_EXCL|O_NOFOLLOW, so a symlink planted at the
// temp path (by anyone who can write in the save folder) is never written through; the rename replaces a link at the
// final name instead of following it.
const randomSuffix = () => crypto.randomBytes(8).toString("hex");
let tempSuffix = randomSuffix;
const EXCL = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
function writeTemp(final, data) {
  const tmp = `${final}.${tempSuffix()}.tmp`;
  const fd = fs.openSync(tmp, EXCL, 0o644);
  try { fs.writeFileSync(fd, data); } catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); throw e; }
  fs.closeSync(fd);
  return tmp;
}

// D11: path -> the call that wrote it in this worker; a different call on the same path is a collision.
const written = new Map();
let announced = false;

/**
 * Copies the checked PNG and writes (or, with no boxes, deletes, D6) its sidecar; temp files renamed into place.
 * Returns the saved PNG path. Throws `save-collision` or `save-failed`; a failed save leaves no file of the shot (D10).
 */
function write({ dir, rel, owner, png, boxes, stderr }) {
  const abs = path.join(dir, `${rel}.png`);
  const side = path.join(dir, `${rel}.boxes.json`);
  // macOS volumes are case-insensitive by default: Settings and settings are one file.
  const key = process.platform === "darwin" ? abs.toLowerCase() : abs;
  const prev = written.get(key);
  if (prev && prev.key !== owner.key) {
    throw fail("save-collision", `${owner.title} and ${prev.title} both save to ${abs}`, "pass a screen option that is unique per locale and render to one of the calls");
  }
  // Only temp files this call created are removed on a failure, never one planted at the name.
  let tmpPng = null, tmpSide = null, escaped = false;
  try {
    // TODO-107: a folder segment planted as a symlink would carry the save (and its deletes) outside the save folder,
    // so the deepest existing folder is checked before mkdir creates anything, and the full one after.
    fs.mkdirSync(dir, { recursive: true });
    const realDir = fs.realpathSync(dir);
    const within = (p) => { const r = path.relative(realDir, fs.realpathSync(p)); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
    let existing = path.dirname(abs);
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    if (!within(existing)) { escaped = true; throw new Error("a folder in the save path links outside the save folder"); }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!within(path.dirname(abs))) { escaped = true; throw new Error("a folder in the save path links outside the save folder"); }
    tmpPng = writeTemp(abs, fs.readFileSync(png));
    if (boxes) {
      tmpSide = writeTemp(side, JSON.stringify(boxes) + "\n");
      fs.renameSync(tmpSide, side);
    } else {
      fs.rmSync(side, { force: true });
    }
    fs.renameSync(tmpPng, abs);
  } catch (e) {
    // Past a planted folder link, abs and side are someone else's files: never deleted.
    for (const f of escaped ? [] : [tmpPng, tmpSide, abs, side]) { if (f) try { fs.rmSync(f, { force: true }); } catch {} }
    throw fail("save-failed", `cannot save ${abs}: ${e.code || e.message}; no file of this shot was kept`,
      `make ${dir} writable, or unset saveDir and ${ENV} to stop saving, then rerun the test`);
  }
  written.set(key, owner);
  if (!announced) {
    announced = true;
    stderr(`catscan: saving checked screens under ${dir}\n`);
  }
  return abs;
}

module.exports = { ENV, slug, root, screenSegments, pageRender, render, count, relName, write, _written: written, _reset: () => { written.clear(); announced = false; }, _tempSuffix: (f) => { tempSuffix = f || randomSuffix; } };
