// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-073 "Device profiles": the shipped table (measured by bench/devices/*-profiles.mjs, D2), user profile files,
// the TODO-075 label tier (D21) and `fit --list-devices`. Size matching runs in the core, which knows each image's size.
const fs = require("fs");
const path = require("path");
const { UsageError, closest } = require("./args");

const TABLE = path.join(__dirname, "device-profiles.json");
const KINDS = ["cutout", "corner", "home-indicator"];
const PLATFORMS = ["ios", "ipados", "android"];

let cached = null;
/** { device_profiles, version, profiles } */
function table() {
  if (!cached) cached = JSON.parse(fs.readFileSync(TABLE, "utf8"));
  return cached;
}

const recipe = "regenerate the file with docs/recipes/device-profile.md";

/** Checks a profile object; every problem names its field (`invalid-device-profile`, exit 2). */
function check(o, file) {
  const bad = (m) => new UsageError("invalid-device-profile", `${file}: ${m}`, `catscan fit --list-devices (a shipped profile), or ${recipe}`);
  const int = (v) => Number.isInteger(v) && v >= 0;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw bad("must be an object {device_profile, id, screen, zones}");
  if (o.device_profile !== 1) throw bad("device_profile must be 1");
  if (typeof o.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(o.id)) throw bad("id must be lower-case letters, digits and hyphens");
  if (o.platform !== undefined && !PLATFORMS.includes(o.platform)) throw bad(`platform must be one of ${PLATFORMS.join(", ")}`);
  const s = o.screen;
  if (!s || !(int(s.width) && s.width > 0) || !(int(s.height) && s.height > 0)) throw bad("screen must be {width, height} in pixels above 0");
  if (s.width > s.height) throw bad("screen must be the portrait size (width at most height)");
  if (!Array.isArray(o.zones)) throw bad("zones must be an array");
  const inside = (b) => Array.isArray(b) && b.length === 4 && b.every(int) && b[2] > 0 && b[3] > 0;
  o.zones.forEach((z, i) => {
    const at = `zones[${i}]`;
    if (!z || !KINDS.includes(z.kind)) throw bad(`${at}.kind must be one of ${KINDS.join(", ")}`);
    if (z.kind === "home-indicator") {
      if (!inside(z.box) || z.box[0] + z.box[2] > s.width || z.box[1] + z.box[3] > s.height) throw bad(`${at}.box must be [x, y, width, height] inside the ${s.width}x${s.height} screen`);
      return;
    }
    if (!Array.isArray(z.runs) || !z.runs.length) throw bad(`${at}.runs must be a non-empty array of [y, x0, x1)`);
    z.runs.forEach((r, j) => {
      if (!Array.isArray(r) || r.length !== 3 || !r.every(int) || r[0] >= s.height || r[1] >= r[2] || r[2] > s.width) {
        throw bad(`${at}.runs[${j}] must be [y, x0, x1) inside the ${s.width}x${s.height} screen`);
      }
    });
  });
  const lh = o.landscape?.["home-indicator"]?.box;
  // D40: the home indicator moves in landscape; without its landscape box a landscape image could not check it.
  if (o.zones.some((z) => z.kind === "home-indicator") && lh === undefined) throw bad(`landscape["home-indicator"].box is required with a home-indicator zone (the bar moves in landscape)`);
  if (o.landscape !== undefined && (!inside(lh) || lh[0] + lh[2] > s.height || lh[1] + lh[3] > s.width)) {
    throw bad(`landscape["home-indicator"].box must be [x, y, width, height] inside the ${s.height}x${s.width} landscape screen`);
  }
  return o;
}

/** A user profile file (`--device-profile <file>`). */
function loadFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    throw new UsageError("invalid-device-profile", `cannot read the device profile ${file}: ${e.code || e.message}`, `catscan fit --list-devices (a shipped profile), or ${recipe}`);
  }
  let o;
  try { o = JSON.parse(text.replace(/^﻿/, "")); } catch (e) {
    throw new UsageError("invalid-device-profile", `${file}: not JSON (${e.message})`, `catscan fit --list-devices (a shipped profile), or ${recipe}`);
  }
  return check(o, file);
}

const byId = (id) => table().profiles.find((p) => p.id === id) || null;

/**
 * `--device-profile <id|file>`: a shipped id, else a file. An argument that is neither is `unknown-device-profile`
 * with the closest id (a path-looking value that does not exist is reported as a file).
 */
function resolve(arg) {
  const p = byId(arg);
  if (p) return { profile: p, version: table().version };
  if (/[/\\]|\.json$/i.test(arg) || fs.existsSync(arg)) return { profile: loadFile(arg), version: null };
  throw unknownProfile(arg);
}

/** `unknown-device-profile` with the closest shipped id. */
function unknownProfile(arg) {
  const s = closest(arg, table().profiles.map((x) => x.id));
  return new UsageError("unknown-device-profile", `--device-profile ${arg}: no such profile${s ? `; did you mean ${s}?` : ""}`, "catscan fit --list-devices");
}

/** D21: the profile a TODO-075 device label names, bare or after its platform prefix (`ios-iphone-17-pro`). */
function forLabel(label) {
  if (!label) return null;
  const bare = byId(label);
  if (bare) return bare;
  const m = /^(ios|ipados|android)[-_.](.+)$/.exec(label);
  return m ? byId(m[2]) : null;
}

/** Profile ids of one pixel size (portrait or transposed), for the `device-unknown` hint. */
function idsOfSize(w, h) {
  return table().profiles.filter((p) => (p.screen.width === w && p.screen.height === h) || (p.screen.width === h && p.screen.height === w)).map((p) => p.id);
}

const zonesOf = (p) => {
  const k = new Set(p.zones.map((z) => z.kind));
  return KINDS.filter((x) => k.has(x));
};

/** `fit --list-devices`: one row per shipped profile. */
function list() {
  return table().profiles.map((p) => ({
    id: p.id, name: p.name, platform: p.platform, width: p.screen.width, height: p.screen.height, zones: zonesOf(p), measured: p.measured.tool,
  }));
}

function listText() {
  const rows = list();
  const cols = [["id", (r) => r.id], ["platform", (r) => r.platform], ["size", (r) => `${r.width}x${r.height}`], ["zones", (r) => r.zones.join(",") || "none"]];
  const w = cols.map(([h, f]) => Math.max(h.length, ...rows.map((r) => f(r).length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(w[i])).join("  ") + "  ";
  return [
    `device profiles ${table().version} (${rows.length})`,
    line(cols.map(([h]) => h)) + "measured on",
    ...rows.map((r) => line(cols.map(([, f]) => f(r))) + r.measured),
  ].join("\n") + "\n";
}

module.exports = { TABLE, KINDS, table, check, loadFile, resolve, unknownProfile, forLabel, idsOfSize, list, listText };
