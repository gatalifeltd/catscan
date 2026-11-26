// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// `catscan doctor` (spec 08 D8): Node runs its own checks, then `catscan-core doctor` when the binary can start, and
// merges both into one schema-1 object. It never stops at a broken install: each problem is a failing check.
const fs = require("fs");
const { spawnSync } = require("child_process");
const install = require("./install");

const CHECKS = ["node", "platform", "macos", "binary", "version", "signature", "vision", "self_test", "tesseract", "catalogs", "locale"];

/** The Mach-O architecture from the file header: no lipo, which needs the Xcode tools on a clean Mac. */
function machoArch(file) {
  const b = Buffer.alloc(8);
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    if (fs.readSync(fd, b, 0, 8, 0) < 8) return null;
  } catch { return null; } finally { if (fd !== null) fs.closeSync(fd); }
  if (b.readUInt32BE(0) === 0xcafebabe) return "universal";
  if (b.readUInt32LE(0) !== 0xfeedfacf) return null;
  return { 0x0100000c: "arm64", 0x01000007: "x86_64" }[b.readUInt32LE(4)] || null;
}

// System paths, never PATH: npx puts project .bin folders first, where a shim could forge the answer (review).
const CODESIGN = "/usr/bin/codesign";
const SPCTL = "/usr/sbin/spctl";

/** { valid, team_id } or { error } when codesign itself could not run. */
function codesignProbe(bin, run = spawnSync) {
  const opts = { encoding: "utf8", timeout: 30_000 };
  const verify = run(CODESIGN, ["--verify", "--strict", bin], opts);
  if (verify.error || verify.status === null) return { error: verify.error ? verify.error.message : `killed by ${verify.signal}` };
  const details = run(CODESIGN, ["-dv", "--verbose=2", bin], opts);
  if (details.error || details.status === null) return { error: details.error ? details.error.message : `killed by ${details.signal}` };
  // A binary that verifies has a signature to describe: a failing -dv is a probe failure, not a missing Team ID.
  if (verify.status === 0 && details.status !== 0) return { error: `codesign -dv exited ${details.status}` };
  return install.parseCodesign(verify.status, details.stderr);
}

function spctlProbe(bin) {
  const r = spawnSync(SPCTL, ["--assess", "-vv", "--type", "open", "--context", "context:primary-signature", bin], { encoding: "utf8", timeout: 30_000 });
  return install.parseSpctl(`${r.stdout || ""}${r.stderr || ""}`);
}

/** The catscan-core doctor fields that break core/schema/doctor.schema.json, or null when the reply conforms (review). */
function missingFields(info) {
  const at = (p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), info);
  const str = (v) => typeof v === "string";
  const strOrNull = (v) => v === null || str(v);
  const count = (v) => Number.isInteger(v) && v >= 0;
  const strings = (v) => Array.isArray(v) && v.every(str);
  const locale = (l) => l !== null && typeof l === "object" && str(l.locale) && typeof l.installed === "boolean"
    && strings(l.packs) && l.packs.length > 0 && strings(l.missing);
  const want = {
    schema: (v) => v === 1, catscan: str, engine: str,
    "host.chip": str, "host.arch": str, "host.host_class": (v) => v === "physical" || v === "vm", "host.macos": str,
    "host.vision_revision": Number.isInteger, "host.macos_build": (v) => v === undefined || str(v),
    "fallback.engine": (v) => v === null || (str(v) && /^tesseract-.+$/.test(v)), "fallback.path": strOrNull,
    "fallback.version": strOrNull, "fallback.tessdata": strOrNull, "fallback.packs": strings, "fallback.searched": strings,
    "fallback.locales": (v) => Array.isArray(v) && v.every(locale),
    neural_engine: (v) => ["present", "absent", "unknown"].includes(v),
    "vision.revision": Number.isInteger, "vision.languages.accurate": count, "vision.languages.fast": count,
    "self_test.ms": count, "self_test.pass": (v) => typeof v === "boolean",
  };
  const bad = Object.keys(want).filter((p) => !want[p](at(p)));
  if (str(at("fallback.path")) && !str(at("fallback.version"))) bad.push("fallback.version for fallback.path");
  return bad.length ? bad : null;
}

/**
 * The merged doctor object. Every probe is injectable: `install` options (env, platform, arch, release, translated,
 * nodeVersion, dir, version, resolve, exists, readJSON), `core(bin, locales)`, `codesign(bin)`, `spctl(bin)`, `binaryArch(bin)`.
 */
function report(o = {}) {
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const arch = o.arch || process.arch;
  const nodeVersion = o.nodeVersion || process.versions.node;
  const release = o.release || require("os").release();
  const version = o.version || require("../package.json").version;
  const translated = o.translated || install.rosetta;
  // TODO-065 T3: o.expect = { locales, warnings } from --expect-locales[-from]; null without them.
  const expect = o.expect || null;
  const core = o.core || ((bin, locales) => require("./client").doctorInfo(bin, locales));
  const codesign = o.codesign || codesignProbe;
  const spctl = o.spctl || spctlProbe;
  const archOf = o.binaryArch || machoArch;
  const iopts = { ...o, env, platform, arch, release, translated, nodeVersion, version };

  const checks = [];
  const add = (name, ok, value, advice = null) => checks.push({ name, ok, value, advice });
  const fail = (name, e) => add(name, false, e.message, e.hint || null);

  const nodeBad = install.nodeProblem(nodeVersion);
  if (nodeBad) fail("node", nodeBad); else add("node", true, `${nodeVersion} ${arch}`);

  // One probe each, so the platform and the macOS check report separately.
  const plat = install.platformProblem({ platform, arch, release: "99.0.0", translated });
  const rosetta = platform === "darwin" && arch !== "arm64" && !plat;
  if (plat) fail("platform", plat); else add("platform", true, `macOS on Apple silicon${rosetta ? " (Node runs under Rosetta)" : ""}`);
  const osBad = plat ? null : install.platformProblem({ platform, arch: "arm64", release });
  if (!plat) { if (osBad) fail("macos", osBad); else add("macos", true, `Darwin ${release}`); }

  let binary = null;
  let info = null;
  if (!plat && !osBad) {
    let found = null;
    try { found = install.resolveBinary(iopts); } catch (e) { fail("binary", e); }
    if (found) {
      binary = { path: found.path, source: found.source, version: found.version, arch: archOf(found.path), signature: null };
      // D5: only the npm package must carry catscan's Developer ID signature.
      let trusted = true;
      if (found.source === "package") {
        const sig = codesign(found.path);
        if (sig.error) sig.valid = false;
        const notarized = sig.valid && sig.team_id === install.TEAM_ID ? spctl(found.path) : null;
        const reinstall = install.installCommand(env, `${install.BINARY_PACKAGE}@${version}`, o.dir || __dirname, o.exists);
        binary.signature = { valid: sig.valid, team_id: sig.team_id || null, notarized };
        if (sig.error) {
          trusted = false;
          add("signature", false, `${CODESIGN} could not run: ${sig.error}`, "rerun catscan doctor; codesign ships with macOS");
        } else if (!sig.valid) {
          trusted = false;
          add("signature", false, `codesign --verify --strict rejects ${found.path}`, reinstall);
        } else if (sig.team_id !== install.TEAM_ID) {
          trusted = false;
          add("signature", false, `${found.path} is signed by team ${sig.team_id || "none"}, not catscan's ${install.TEAM_ID}`, reinstall);
        } else {
          const n = notarized === true ? "notarized" : notarized === false ? "not notarized" : "notarization not checked (offline)";
          add("signature", true, `Developer ID ${sig.team_id}, ${n}`);
        }
      } else {
        add("signature", true, `not required for ${found.source === "env" ? "an env" : "a build"} binary`);
      }
      // A binary that fails its signature check is not started.
      if (trusted) {
        try { info = core(found.path, expect && expect.locales); } catch (e) {
          fail("binary", { message: `${found.path} (${found.source}) cannot run: ${e.message}`, hint: e.hint || "reinstall catscan" });
        }
        // D13: a reply without the fields doctor reads is a broken binary, never a crash or a false pass (review).
        const missing = info && missingFields(info);
        if (missing) {
          fail("binary", { message: `${found.path} (${found.source}) returned a doctor reply without a valid ${missing.join(", ")}`, hint: `rebuild or reinstall catscan-core ${version}` });
          info = null;
        }
      }
      if (!trusted) add("binary", true, `${found.path} (${found.source}), not started: see the signature check`);
      if (info) {
        binary.version = info.catscan;
        add("binary", true, `${found.path} (${found.source}${binary.arch ? `, ${binary.arch}` : ""})`);
        if (info.catscan === version) add("version", true, version);
        else {
          const hint = found.source === "package" ? install.installCommand(env, `${install.BINARY_PACKAGE}@${version}`, o.dir || __dirname, o.exists)
            : found.source === "build" ? "npm run build" : `point CATSCAN_CORE_BINARY at a ${version} build`;
          add("version", false, `catscan-core is ${info.catscan}, @catscan/core-js is ${version}`, hint);
        }
      }
    }
  }

  if (info) {
    // host.macos is already "<version> (<build>)" (Model.swift).
    const m = checks.find((c) => c.name === "macos");
    if (m.ok) m.value = info.host.macos;
    {
      const l = info.vision.languages;
      const ok = l.accurate > 0;
      add("vision", ok, `${ok ? "" : "Vision lists no recognition languages: "}revision ${info.vision.revision}, ${l.accurate} accurate and ${l.fast} fast languages`, ok ? null : "restart the Mac, then rerun catscan doctor");
    }
    {
      const t = info.self_test;
      add("self_test", t.pass, `${t.pass ? "read" : "could not read"} a rendered word in ${t.ms} ms`, t.pass ? null : "restart the Mac, then rerun catscan doctor");
    }
    const f = info.fallback;
    // TODO-065: Tesseract is optional, so its row passes; these locales are read with it, never "unsupported".
    // TODO-065 D6: the binary's Tesseract.fix names the setup it found (CATSCAN_TESSERACT, TESSDATA_PREFIX or brew).
    if (!f.path) {
      add("tesseract", true, `not installed (looked at ${f.searched.join(", ")}); needed only for ${f.locales.map((l) => l.locale).join(", ")}`, f.fix || "brew install tesseract tesseract-lang (about 650 MB)");
    }
    else {
      const missing = f.locales.filter((l) => !l.installed);
      const reads = f.locales.length - missing.length;
      const value = `${f.version} at ${f.path}, reads ${reads} of ${f.locales.length} fallback locales${missing.length ? `; missing packs for ${missing.map((l) => `${l.locale} (${(l.missing || l.packs).join("+")})`).join(", ")}` : ""}`;
      add("tesseract", true, value, missing.length ? f.fix || "brew install tesseract-lang (about 650 MB)" : null);
    }
    if (expect) {
      // TODO-065 D11: the preflight fails closed; a catalog whose locale it could not tell may be the one needing Tesseract.
      for (const w of expect.warnings || []) add("catalogs", false, w.message, "name the catalog <locale>.json or put it in <locale>.lproj or values-<locale>, or list the locales: catscan doctor --expect-locales <list>");
      // Fail closed: a binary that answered without per-locale rows did not check the listed locales.
      if (expect.locales && expect.locales.length && !Array.isArray(info.requested)) {
        add("locale", false, `catscan-core at ${binary ? binary.path : "an unknown path"} did not check the listed locales`, "rebuild or reinstall catscan so the binary matches this package, then rerun catscan doctor");
      }
      for (const r of info.requested || []) {
        const st = r.reader === "tesseract" ? r.self_test || (f.locales.find((l) => l.locale === r.fallback_locale) || {}).self_test : null;
        if (r.ok) add("locale", true, `${r.locale}: ${r.reader === "vision" ? "read by Vision" : `read by Tesseract ${f.version}${st ? ` (a rendered word in ${st.ms} ms)` : ""}`}`);
        else add("locale", false, `${r.locale}: ${r.error.message}`, r.error.hint || null);
      }
    }
  }

  const out = info
    ? { ...info, catscan: version }
    : { schema: 1, catscan: version, engine: null, host: null, fallback: null };
  // D5: the CI service from the same detector as the results file's run.ci (spec 27 D8, D20); null outside CI.
  out.ci = require("./results").ciInfo(env);
  out.binary = binary;
  out.node = { version: nodeVersion, arch };
  out.checks = checks.sort((a, b) => CHECKS.indexOf(a.name) - CHECKS.indexOf(b.name));
  // The binary check passing means catscan can run; every other check must pass too.
  out.ok = checks.every((c) => c.ok) && Boolean(info);
  return out;
}

/** D16: `ok   <name>: <value>` or `FAIL <name>: <message> - try: <advice>`, one line per check, then the update
 * notice when there is one (TODO-059 D17). */
function renderDoctor(r) {
  const lines = r.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.value}${c.advice ? ` - try: ${c.advice}` : ""}`);
  const update = require("./update-check").renderUpdate(r.update);
  return update ? [...lines, update] : lines;
}

module.exports = { report, renderDoctor, machoArch, codesignProbe, CHECKS };
