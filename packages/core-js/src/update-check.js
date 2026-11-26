// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-059 T2 (D3, D4, D17): `catscan doctor` says when a newer catscan is on npm. No telemetry: the request carries
// only the package name (in the REGISTRY_URL) and a fixed user agent, never the installed version, paths or the OS. It never
// fails doctor and never changes its exit code; any failure gives `update: null` and prints nothing.
const fs = require("fs");
const os = require("os");
const path = require("path");

const REGISTRY_URL = "https://registry.npmjs.org/-/package/@catscan%2fcli/dist-tags";
const USER_AGENT = "catscan";
const TIMEOUT_MS = 1500;
const HOUR = 3600_000;
const OK_TTL = 24 * HOUR; // a success is reused for a day
const FAIL_TTL = HOUR; // an offline machine pays the timeout at most once an hour
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** Off with --offline, CATSCAN_NO_UPDATE_CHECK=1 or in CI, where versions are pinned exactly (D4). CI is `CI` or
 * any service the results file's detector knows (Azure Pipelines and Jenkins set no `CI`). */
function disabled(env, offline) {
  if (offline) return true;
  const no = env.CATSCAN_NO_UPDATE_CHECK;
  if (no !== undefined && no !== "" && no !== "0") return true;
  if (env.CI !== undefined && env.CI !== "") return true;
  return require("./results").ciInfo(env) !== null;
}

/** XDG: a relative XDG_CACHE_HOME is ignored, so the cache never lands in the current project. */
function cachePath(env, home = os.homedir()) {
  const base = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.join(home, ".cache");
  return path.join(base, "catscan", "update-check.json");
}

/** a > b on X.Y.Z; a prerelease counts as its release. */
function newer(a, b) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

// Only a regular file is read, and a write replaces the entry by rename, so a symlink or FIFO planted at the cache
// path is never followed or blocked on (review).
function readCache(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    const at = Date.parse(c.checked_at);
    if (!Number.isFinite(at) || typeof c.ok !== "boolean") return null;
    if (c.ok && !(typeof c.latest === "string" && SEMVER.test(c.latest))) return null;
    return { ...c, at };
  } catch { return null; }
}

function writeCache(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry) + "\n", { flag: "wx" });
    fs.renameSync(tmp, file);
  } catch { /* a read-only home only loses the cache: every run then asks the registry */ }
}

/** The latest version from the registry, or null on any failure (timeout, non-200, malformed body). */
async function fetchLatest(fetchImpl) {
  try {
    const res = await fetchImpl(REGISTRY_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) { await res.body?.cancel().catch(() => {}); return null; }
    const body = await res.json();
    const latest = body && typeof body === "object" ? body.latest : null;
    return typeof latest === "string" && SEMVER.test(latest) ? latest : null;
  } catch { return null; }
}

/**
 * `{ latest, current, newer, checked_at, source }` or null when skipped or unknown. Injectable: env, offline,
 * current (the installed version), fetch, now (ms), home.
 */
async function check(o = {}) {
  const env = o.env || process.env;
  if (disabled(env, o.offline)) return null;
  const current = o.current;
  const now = o.now === undefined ? Date.now() : o.now;
  const file = cachePath(env, o.home);
  const cached = readCache(file);
  const result = (latest, at, source) => ({ latest, current, newer: newer(latest, current), checked_at: new Date(at).toISOString(), source });
  if (cached && cached.at <= now) {
    // A cached latest older than the installed version is reused as is (the line then says "npm latest is"), so a
    // build ahead of npm never asks the registry on every run.
    if (cached.ok && now - cached.at < OK_TTL) return result(cached.latest, cached.at, "cache");
    if (!cached.ok && now - cached.at < FAIL_TTL) return null;
  }
  const latest = await fetchLatest(o.fetch || globalThis.fetch);
  writeCache(file, { checked_at: new Date(now).toISOString(), ok: latest !== null, latest });
  return latest === null ? null : result(latest, now, "registry");
}

/** D17: doctor's own line dialect, so it never reads as a failure; null prints nothing. */
function renderUpdate(u) {
  if (!u) return null;
  if (u.latest === u.current) return `ok   update: ${u.current} installed, the latest`;
  if (!u.newer) return `ok   update: ${u.current} installed, npm latest is ${u.latest}`;
  return `ok   update: ${u.current} installed, ${u.latest} available - try: the catscan-upgrade skill, or docs/recipes/upgrade.md`;
}

module.exports = { check, renderUpdate, newer, disabled, cachePath, REGISTRY_URL, USER_AGENT, TIMEOUT_MS, OK_TTL, FAIL_TTL };
