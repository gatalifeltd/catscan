// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Allowed roots and path containment (spec 09 D6, D13, D14, D21). Pure fs: no @catscan/core-js, so it
// runs on any platform.
const fs = require("fs");
const os = require("os");
const path = require("path");

class PathError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** The realpath of `p`; for a missing path, the realpath of its nearest existing ancestor plus the rest (D6). */
function realish(p) {
  let rest = [];
  let cur = p;
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function inside(real, roots) {
  return roots.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

/** Realpaths of the existing roots, in order. */
function normalizeRoots(list) {
  const out = [];
  for (const r of list) {
    if (!r || !path.isAbsolute(r)) continue;
    let real;
    try { real = fs.realpathSync(r); } catch { continue; }
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/** `CATSCAN_MCP_ROOTS`: absolute paths joined by the path delimiter (`:` on macOS). */
function envRoots(env = process.env) {
  return (env.CATSCAN_MCP_ROOTS || "").split(path.delimiter).filter(Boolean);
}

const rootList = (roots) => roots.join(", ");

const NO_ROOTS_HINT = "set CATSCAN_MCP_ROOTS in the catscan server's env to the project folders (absolute paths joined by :) and restart the server, or start the client in a project folder";

/**
 * TODO-107: the server's working directory as the root nobody named. `/`, the home folder or a folder above it would
 * open every screenshot on the disk to an agent, so they fail closed with PathError no-roots.
 */
function implicitRoots(cwd, home = os.homedir()) {
  const roots = normalizeRoots([cwd]);
  let realHome = home;
  try { realHome = fs.realpathSync(home); } catch {}
  const wide = roots.find((r) => r === path.parse(r).root || inside(realHome, [r]));
  if (wide || !roots.length) {
    throw new PathError("no-roots", `no allowed roots: the client sent no workspace roots, CATSCAN_MCP_ROOTS is unset, and the server's working directory ${wide || cwd} is too wide to allow`, NO_ROOTS_HINT);
  }
  return roots;
}

// TODO-107: the most a data file (results, known, catalog, boxes and the like) may hold before the server reads it.
const MAX_DATA_BYTES = 64 * 1024 * 1024;

/** Throws PathError input-too-large when the existing file `abs` is over `max` bytes, unsupported-input for a FIFO or device; checked before any read. */
function checkSize(abs, name = "file", max = MAX_DATA_BYTES) {
  let st;
  try { st = fs.statSync(abs); } catch { return; } // a missing or unreadable file is the reader's error
  // A FIFO or device would block or never end the read. A folder (of boxes sidecars) is the reader's to walk.
  if (st.isDirectory()) return;
  if (!st.isFile()) throw new PathError("unsupported-input", `${name} ${abs} is not a regular file`, `pass the ${name} file itself`);
  const size = st.size;
  if (size > max) {
    throw new PathError("input-too-large", `${name} ${abs} is ${Math.ceil(size / 1024 / 1024)} MB, over the limit of ${max / 1024 / 1024} MB`, "pass a smaller file; the catscan CLI reads larger ones");
  }
}

/**
 * Resolves one argument against the roots. Returns { abs, exists }. Throws PathError
 * path-outside-root, or input-not-found when `mustExist` and the path is missing.
 * Containment is checked before anything reads the file (D13).
 */
function resolve(arg, roots, { mustExist = false, name = "path", maxBytes = null } = {}) {
  let abs;
  if (path.isAbsolute(arg)) abs = path.resolve(arg);
  else {
    // D14: the first root where the path exists, else the first root.
    // Only contained candidates are probed, so an error never says whether an outside file exists.
    abs = roots.map((r) => path.resolve(r, arg)).find((p) => inside(realish(p), roots) && fs.existsSync(p)) || path.resolve(roots[0], arg);
  }
  if (!inside(realish(abs), roots)) {
    throw new PathError("path-outside-root", `${name} ${abs} is outside the allowed roots (${rootList(roots)})`,
      "add its folder to the client's workspace roots, or to CATSCAN_MCP_ROOTS in the catscan server's env");
  }
  const exists = fs.existsSync(abs);
  if (mustExist && !exists) {
    throw new PathError("input-not-found", `no such file: ${abs}`,
      `pass a path relative to one of the allowed roots (${rootList(roots)}) or an absolute path inside one`);
  }
  if (exists && maxBytes != null) checkSize(abs, name, maxBytes);
  return { abs, exists };
}

/** A result's path relative to the root holding it, so replies do not repeat long absolute paths (D9). */
function display(abs, roots) {
  const real = realish(abs);
  const root = roots.find((r) => inside(real, [r]));
  return root ? path.relative(root, real) || path.basename(real) : abs;
}

module.exports = { display, resolve, inside, realish, normalizeRoots, envRoots, implicitRoots, checkSize, MAX_DATA_BYTES, PathError };
