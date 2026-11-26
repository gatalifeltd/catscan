// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Inputs: images, folders (searched recursively) and `-` for one image on stdin (spec 00).
const fs = require("fs");
const path = require("path");
const { CatscanError } = require("./client");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".heic"]);
const VIDEO_EXT = new Set([".mp4", ".mov"]); // spec 07 D4

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// TODO-107: entries are visited in the order the final sort gives (a folder keys as "name/", so "b.png" comes before
// "b/x.png", as in a code-point sort of full paths), so a walk that stops at `limit` keeps the files a full walk would
// list first.
const walkKey = (e) => (e.isDirectory() ? `${e.name}/` : e.name);

/** Returns false once `out` holds `limit` paths, so the caller stops walking. */
function walk(dir, out, exts, limit = Infinity) {
  let entries;
  // An unreadable folder stays an input (the core reports it), so it cannot hide failing screenshots.
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { out.push(dir); return out.length < limit; }
  entries.sort((a, b) => byCodePoint(walkKey(a), walkKey(b)));
  for (const e of entries) {
    if (out.length >= limit) return false;
    const p = path.join(dir, e.name);
    // Symlinked folders are not followed, so a link loop cannot hang the run.
    if (e.isDirectory()) { if (!walk(p, out, exts, limit)) return false; }
    else if ((e.isFile() || e.isSymbolicLink()) && exts.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out.length < limit;
}

/**
 * Expands the path arguments into inputs: { path, arg, argIsDir, stdin }.
 * Arguments keep their order; files inside each folder are sorted by path.
 * A missing path stays an input, so it is reported with verdict "error" and the run continues.
 * `limit` (TODO-107, the MCP server's max_images + 1) stops each folder walk once that many inputs are held.
 */
function collect(args, exts = IMAGE_EXT, { limit = Infinity } = {}) {
  const out = [];
  for (const arg of args) {
    if (out.length >= limit) break;
    if (arg === "-") { out.push({ path: "-", arg, argIsDir: false, stdin: true }); continue; }
    let st = null;
    try { st = fs.statSync(arg); } catch {}
    if (st && st.isDirectory()) {
      const files = [];
      walk(arg, files, exts, Math.max(0, limit - out.length));
      files.sort(byCodePoint);
      for (const f of files) out.push({ path: f, arg, argIsDir: true, stdin: false });
      // An empty or unreadable folder stays an input, so the core reports it (no-images) instead of a silent pass.
      if (files.length === 0) out.push({ path: arg, arg, argIsDir: false, stdin: false });
    } else {
      out.push({ path: arg, arg, argIsDir: false, stdin: false });
    }
  }
  return out;
}

// Base64 of a larger image would not fit the 64 MB serve line.
const STDIN_MAX = 47 * 1024 * 1024;

/** Reads one image from stdin, up to STDIN_MAX bytes; throws image-too-large beyond it. */
function readStdin() {
  const chunks = [];
  let n = 0;
  const fd = 0;
  const buf = Buffer.alloc(1 << 20);
  for (;;) {
    let r;
    try { r = fs.readSync(fd, buf, 0, buf.length, null); } catch (e) {
      if (e.code === "EAGAIN") continue;
      if (e.code === "EOF") break;
      throw e;
    }
    if (r === 0) break;
    n += r;
    if (n > STDIN_MAX) {
      throw new CatscanError("image-too-large", `The image on stdin is over the limit of ${STDIN_MAX / 1024 / 1024} MB.`, "pass a file path instead of -");
    }
    chunks.push(Buffer.from(buf.subarray(0, r)));
  }
  return Buffer.concat(chunks, n);
}

module.exports = { collect, readStdin, IMAGE_EXT, VIDEO_EXT, STDIN_MAX };
