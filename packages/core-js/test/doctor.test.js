// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 08 D8, D13, D16: the Node-owned doctor on injected probes, plus the CLI exit code and one-object JSON.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Ajv = require("ajv");
const doctor = require("../src/doctor");

const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../../../core/schema/doctor.schema.json"));
const V = "1.2.3";
const BIN = "/x/node_modules/@catscan/cli-darwin-arm64/bin/catscan-core";
const locales = [
  { locale: "el", packs: ["ell"], installed: true, missing: [] },
  { locale: "ka", packs: ["kat"], installed: false, missing: ["kat"] },
];
const CORE = {
  schema: 1, catscan: V, engine: "vision-accurate-rev3",
  host: { chip: "Apple M5", arch: "arm64", host_class: "physical", macos: "27.2 (26B123)", vision_revision: 3, macos_build: "26B123" },
  fallback: { engine: "tesseract-5.5.4", path: "/opt/homebrew/bin/tesseract", version: "5.5.4", tessdata: null, packs: ["ell", "eng"], searched: ["/opt/homebrew/bin/tesseract"], locales },
  neural_engine: "present", vision: { revision: 3, languages: { accurate: 33, fast: 6 } }, self_test: { ms: 61, pass: true },
};
const notCalled = (what) => () => { throw new Error(`${what} must not run`); };

/** A healthy npm install: the binary package resolves, Developer ID signed and notarized. */
function run(over = {}) {
  let ran = 0;
  const r = doctor.report({
    env: {}, platform: "darwin", arch: "arm64", release: "26.2.0", translated: () => 0, nodeVersion: "26.13.0", version: V,
    dir: "/x/node_modules/@catscan/core-js/src",
    resolve: () => "/x/node_modules/@catscan/cli-darwin-arm64/package.json",
    readJSON: () => ({ version: V }),
    exists: () => true,
    core: () => { ran++; return structuredClone(CORE); },
    codesign: () => ({ valid: true, team_id: "JK3T6SMS5W" }),
    spctl: () => true,
    binaryArch: () => "arm64",
    ...over,
  });
  r.ran = ran;
  return r;
}
const check = (r, name) => r.checks.find((c) => c.name === name);
const valid = (r) => { const { ran, ...o } = r; assert.ok(validate(o), JSON.stringify(validate.errors)); };

test("doctor: a healthy package install passes every check and keeps the core fields", () => {
  const r = run();
  valid(r);
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => c.name), ["node", "platform", "macos", "binary", "version", "signature", "vision", "self_test", "tesseract"]);
  assert.deepEqual(r.binary, { path: BIN, source: "package", version: V, arch: "arm64", signature: { valid: true, team_id: "JK3T6SMS5W", notarized: true } });
  assert.deepEqual(r.node, { version: "26.13.0", arch: "arm64" });
  assert.equal(r.neural_engine, "present");
  assert.deepEqual(doctor.renderDoctor(r), [
    "ok   node: 26.13.0 arm64",
    "ok   platform: macOS on Apple silicon",
    "ok   macos: 27.2 (26B123)",
    `ok   binary: ${BIN} (package, arm64)`,
    "ok   version: 1.2.3",
    "ok   signature: Developer ID JK3T6SMS5W, notarized",
    "ok   vision: revision 3, 33 accurate and 6 fast languages",
    "ok   self_test: read a rendered word in 61 ms",
    "ok   tesseract: 5.5.4 at /opt/homebrew/bin/tesseract, reads 1 of 2 fallback locales; missing packs for ka (kat) - try: brew install tesseract-lang (about 650 MB)",
  ]);
});

test("doctor: offline notarization lookup is null and still passes", () => {
  const r = run({ spctl: () => null });
  assert.equal(r.ok, true);
  assert.equal(r.binary.signature.notarized, null);
  assert.equal(check(r, "signature").value, "Developer ID JK3T6SMS5W, notarization not checked (offline)");
});

test("doctor: a missing binary keeps the Node checks, exits not ok and is one schema-valid object with nulls", () => {
  const r = run({ resolve: () => { throw new Error("nope"); }, core: notCalled("core") });
  valid(r);
  assert.equal(r.ok, false);
  assert.equal(r.engine, null);
  assert.equal(r.host, null);
  assert.equal(r.fallback, null);
  assert.equal(r.binary, null);
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok]), [["node", true], ["platform", true], ["macos", true], ["binary", false]]);
  assert.equal(doctor.renderDoctor(r)[3], "FAIL binary: @catscan/cli-darwin-arm64 is not installed: the install skipped optional dependencies (--omit=optional) or the lockfile was made on another OS - try: npm install @catscan/cli-darwin-arm64@1.2.3");
  // An installed tree never suggests swift build.
  assert.doesNotMatch(JSON.stringify(r), /swift build/);
});

test("doctor: a wrong Team ID or a broken signature fails and the binary is not started", () => {
  for (const sig of [{ valid: true, team_id: "ABCDE12345" }, { valid: false, team_id: null }]) {
    const r = run({ codesign: () => sig, spctl: notCalled("spctl"), core: notCalled("core") });
    valid(r);
    assert.equal(r.ok, false);
    const s = check(r, "signature");
    assert.equal(s.ok, false);
    assert.equal(s.advice, "npm install @catscan/cli-darwin-arm64@1.2.3");
    assert.equal(r.binary.signature.notarized, null);
  }
});

test("doctor: codesign that cannot run fails the signature check, never reported as a rejection (review)", () => {
  const r = run({ codesign: () => ({ error: "spawnSync /usr/bin/codesign ETIMEDOUT" }), spctl: notCalled("spctl"), core: notCalled("core") });
  valid(r);
  assert.equal(r.ok, false);
  assert.deepEqual(check(r, "signature"), { name: "signature", ok: false, value: "/usr/bin/codesign could not run: spawnSync /usr/bin/codesign ETIMEDOUT", advice: "rerun catscan doctor; codesign ships with macOS" });
});

test("doctor: a core reply missing fields is a failing binary check with one valid object (review)", () => {
  for (const drop of ["fallback", "vision", "self_test", "host"]) {
    const r = run({ core: () => { const c = structuredClone(CORE); delete c[drop]; return c; } });
    valid(r);
    assert.equal(r.ok, false, drop);
    assert.equal(r.engine, null);
    const b = check(r, "binary");
    assert.equal(b.ok, false);
    assert.match(b.value, new RegExp(`returned a doctor reply without .*${drop}`));
  }
});

test("doctor: a core reply with wrong types is a failing binary check, never a false pass (review)", () => {
  const cases = [
    (c) => { c.self_test.pass = "false"; },
    (c) => { c.fallback.locales = "el"; },
    (c) => { c.fallback.locales = [{ locale: "el", installed: true }]; },
    (c) => { c.vision.languages.accurate = "33"; },
    (c) => { c.schema = 2; },
    (c) => { c.fallback.path = 7; },
    (c) => { c.fallback.version = null; },
    (c) => { c.fallback.path = ["/x"]; },
    (c) => { c.fallback.path = null; c.fallback.version = 5; },
    (c) => { c.engine = 7; },
    (c) => { delete c.host.chip; },
    (c) => { c.host.host_class = "cloud"; },
    (c) => { c.neural_engine = "maybe"; },
    (c) => { c.self_test.ms = -1; },
    (c) => { delete c.fallback.tessdata; },
    (c) => { c.fallback.packs = [1]; },
    (c) => { c.fallback.engine = "ocr"; },
    (c) => { c.fallback.locales = [{ locale: "el", installed: true, packs: [], missing: [] }]; },
  ];
  for (const mutate of cases) {
    const r = run({ core: () => { const c = structuredClone(CORE); mutate(c); return c; } });
    valid(r);
    assert.equal(r.ok, false);
    assert.match(check(r, "binary").value, /returned a doctor reply without a valid /);
  }
});

test("doctor: Vision with no accurate languages fails the vision check with advice", () => {
  const r = run({ core: () => { const c = structuredClone(CORE); c.vision.languages.accurate = 0; return c; } });
  valid(r);
  assert.equal(r.ok, false);
  const v = check(r, "vision");
  assert.equal(v.ok, false);
  assert.match(v.value, /^Vision lists no recognition languages: revision 3, 0 accurate/);
  assert.equal(v.advice, "restart the Mac, then rerun catscan doctor");
});

test("doctor: codesignProbe reports either codesign call failing as an error, not a rejection (review)", () => {
  const ok = { status: 0, stdout: "", stderr: "TeamIdentifier=JK3T6SMS5W\n" };
  const calls = (second) => { let n = 0; return () => (n++ === 0 ? ok : second); };
  assert.deepEqual(doctor.codesignProbe("/b", calls(ok)), { valid: true, team_id: "JK3T6SMS5W" });
  assert.deepEqual(doctor.codesignProbe("/b", calls({ status: null, signal: "SIGTERM", stderr: "" })), { error: "killed by SIGTERM" });
  assert.deepEqual(doctor.codesignProbe("/b", calls({ status: null, error: new Error("spawnSync /usr/bin/codesign ETIMEDOUT") })), { error: "spawnSync /usr/bin/codesign ETIMEDOUT" });
  assert.deepEqual(doctor.codesignProbe("/b", () => ({ status: null, error: new Error("ENOENT") })), { error: "ENOENT" });
  assert.deepEqual(doctor.codesignProbe("/b", calls({ status: 1, stderr: "" })), { error: "codesign -dv exited 1" });
  // An unsigned binary: both calls fail, which is a rejection, not a probe error.
  assert.deepEqual(doctor.codesignProbe("/b", () => ({ status: 1, stderr: "code object is not signed at all\n" })), { valid: false, team_id: null });
});

test("doctor: env and build binaries need no signature", () => {
  const r = run({ env: { CATSCAN_CORE_BINARY: "/b/catscan-core" }, codesign: notCalled("codesign"), spctl: notCalled("spctl") });
  assert.equal(r.ok, true);
  assert.equal(r.binary.source, "env");
  assert.equal(r.binary.signature, null);
  assert.equal(check(r, "signature").value, "not required for an env binary");
});

test("doctor: a binary that cannot run or reports another version fails its check", () => {
  const broken = run({ core: () => { const e = new Error("catscan-core doctor exited 9"); e.hint = "rebuild catscan-core"; throw e; } });
  valid(broken);
  assert.equal(broken.ok, false);
  assert.match(check(broken, "binary").value, /cannot run: catscan-core doctor exited 9$/);
  const other = run({ env: { CATSCAN_CORE_BINARY: "/b/catscan-core" }, core: () => ({ ...structuredClone(CORE), catscan: "9.9.9" }) });
  assert.equal(other.ok, false);
  assert.deepEqual(check(other, "version"), { name: "version", ok: false, value: "catscan-core is 9.9.9, @catscan/core-js is 1.2.3", advice: "point CATSCAN_CORE_BINARY at a 1.2.3 build" });
});

test("doctor: unsupported platform, old macOS, old Node and Rosetta", () => {
  const linux = run({ platform: "linux", arch: "x64", core: notCalled("core") });
  valid(linux);
  assert.deepEqual(linux.checks.map((c) => [c.name, c.ok]), [["node", true], ["platform", false]]);
  const old = run({ release: "23.6.0", core: notCalled("core") });
  assert.deepEqual(old.checks.map((c) => [c.name, c.ok]), [["node", true], ["platform", true], ["macos", false]]);
  assert.equal(check(old, "macos").advice, "update macOS to 15 or newer");
  const node = run({ nodeVersion: "20.19.1" });
  assert.equal(node.ok, false);
  assert.equal(check(node, "node").ok, false);
  // x64 Node under Rosetta: the Mac is supported, the binary package was skipped.
  const rosetta = run({ arch: "x64", translated: () => 1, resolve: () => { throw new Error("nope"); }, core: notCalled("core") });
  assert.match(check(rosetta, "platform").value, /Rosetta/);
  assert.match(check(rosetta, "binary").advice, /install an arm64 Node/);
});

test("doctor: no Tesseract is advice, not a failure; a failed self-test fails", () => {
  const none = run({ core: () => ({ ...structuredClone(CORE), fallback: { ...CORE.fallback, engine: null, path: null, version: null, packs: [] } }) });
  assert.equal(none.ok, true);
  // TODO-065: these locales are read with Tesseract, so the row never calls them unsupported.
  assert.equal(doctor.renderDoctor(none).at(-1), "ok   tesseract: not installed (looked at /opt/homebrew/bin/tesseract); needed only for el, ka - try: brew install tesseract tesseract-lang (about 650 MB)");
  const st = run({ core: () => ({ ...structuredClone(CORE), self_test: { ms: 70, pass: false } }) });
  assert.equal(st.ok, false);
  assert.match(doctor.renderDoctor(st).find((l) => l.includes("self_test")), /^FAIL self_test: could not read a rendered word in 70 ms - try: /);
});

test("doctor: machoArch reads the header", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-macho-"));
  const f = (name, words) => { const p = path.join(tmp, name); const b = Buffer.alloc(8); b.writeUInt32LE(words[0], 0); b.writeUInt32LE(words[1], 4); fs.writeFileSync(p, b); return p; };
  assert.equal(doctor.machoArch(f("a", [0xfeedfacf, 0x0100000c])), "arm64");
  assert.equal(doctor.machoArch(f("x", [0xfeedfacf, 0x01000007])), "x86_64");
  assert.equal(doctor.machoArch(f("s", [0x23212f2f, 0])), null);
  assert.equal(doctor.machoArch(path.join(tmp, "missing")), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cli: doctor with a missing binary exits 1 and --json prints exactly one valid object", () => {
  const cli = path.resolve(__dirname, "../../../bin/catscan.js");
  const env = { ...process.env, CATSCAN_CORE_BINARY: "/nonexistent/catscan-core", CATSCAN_NO_UPDATE_CHECK: "1" };
  const j = spawnSync(process.execPath, [cli, "doctor", "--json"], { encoding: "utf8", env });
  assert.equal(j.status, 1, j.stderr);
  const lines = j.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const o = JSON.parse(lines[0]);
  assert.ok(validate(o), JSON.stringify(validate.errors));
  assert.equal(o.ok, false);
  const t = spawnSync(process.execPath, [cli, "doctor"], { encoding: "utf8", env });
  assert.equal(t.status, 1);
  assert.match(t.stdout, /^ok   node: /m);
  assert.match(t.stdout, /^FAIL binary: CATSCAN_CORE_BINARY points to a missing file: \/nonexistent\/catscan-core - try: fix or unset CATSCAN_CORE_BINARY$/m);
});

test("doctor: --expect-locales gives each locale its reader, fails a missing one with its fix, and fails closed on catalogs (TODO-065 T3, D11)", () => {
  // Value: protects=the CI preflight never passes a locale without a working reader; fails_when=a failing requested row or a catalog warning leaves ok true; why_new=new flags; seam=o.expect (the cli passes results.expectations); no_claim=the real self-test (Swift TesseractTests)
  let asked = null;
  const requested = [
    { locale: "de", reader: "vision", ok: true },
    { locale: "el", reader: "tesseract", fallback_locale: "el", ok: true },
    { locale: "ka", reader: "tesseract", fallback_locale: "ka", ok: false, error: { code: "reader-missing", message: "catscan reads the locale ka with Tesseract, but Tesseract 5.5.4 has no kat language data in /t/.", hint: "add kat.traineddata to /t/, then rerun the same command" } },
  ];
  const withTest = locales.map((l) => (l.locale === "el" ? { ...l, self_test: { ms: 90, pass: true } } : l));
  const core = (bin, ls) => { asked = ls; return { ...structuredClone(CORE), fallback: { ...CORE.fallback, locales: withTest }, requested }; };
  const r = run({ core, expect: { locales: ["de", "el", "ka"], warnings: [] } });
  assert.deepEqual(asked, ["de", "el", "ka"]);
  valid(r);
  assert.equal(r.ok, false);
  const rows = doctor.renderDoctor(r).filter((l) => l.includes(" locale: "));
  assert.deepEqual(rows, [
    "ok   locale: de: read by Vision",
    "ok   locale: el: read by Tesseract 5.5.4 (a rendered word in 90 ms)",
    "FAIL locale: ka: catscan reads the locale ka with Tesseract, but Tesseract 5.5.4 has no kat language data in /t/. - try: add kat.traineddata to /t/, then rerun the same command",
  ]);
  const good = run({ core: () => ({ ...structuredClone(CORE), requested: requested.slice(0, 2) }), expect: { locales: ["de", "el"], warnings: [] } });
  assert.equal(good.ok, true);
  const closed = run({ core: () => ({ ...structuredClone(CORE), requested: requested.slice(0, 1) }), expect: { locales: ["de"], warnings: [{ code: "catalog-locale-unknown", message: "cannot read the locale of the catalog l/x.json" }] } });
  assert.equal(closed.ok, false);
  assert.match(doctor.renderDoctor(closed).find((l) => l.includes("catalogs")), /^FAIL catalogs: cannot read the locale of the catalog l\/x\.json - try: .*catscan doctor --expect-locales <list>$/);
  assert.equal(run({}).checks.some((c) => c.name === "locale" || c.name === "catalogs"), false, "plain doctor adds no locale rows");
  // A binary that answers without per-locale rows (a stale build) fails the listed locales instead of passing them.
  const stale = run({ core: () => structuredClone(CORE), expect: { locales: ["el"], warnings: [] } });
  assert.equal(stale.ok, false);
  assert.match(doctor.renderDoctor(stale).find((l) => l.startsWith("FAIL locale")), /^FAIL locale: catscan-core at .* did not check the listed locales - try: rebuild or reinstall catscan/);
});

// TODO-059 T2: the update check on an injected fetch and a temp cache folder; never the network.
const update = require("../src/update-check");
const NOW = Date.parse("2026-11-23T12:00:00Z");
function updateRig(reply) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-update-"));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(init);
    return { status: reply.status ?? 200, json: async () => { if (reply.body === "bad") throw new SyntaxError("bad json"); return reply.body; } };
  };
  const env = { XDG_CACHE_HOME: cache };
  const run = (o = {}) => update.check({ env, current: "0.38.0", fetch, now: NOW, ...o });
  return { cache, calls, env, run, file: path.join(cache, "catscan", "update-check.json") };
}

// Value: protects=the developer learns of a newer catscan from doctor, and nothing else leaves the machine; fails_when=newer/same/older is misjudged, the request carries the version, cookies, auth or a non-fixed user agent, or the URL names more than the package; why_new=the update check is new (TODO-059 D4); seam=o.fetch; no_claim=the real registry
test("update: newer, same and older versions from the dist-tags request, which carries only the URL and the fixed user agent", async () => {
  const cases = [["0.41.0", true], ["0.38.0", false], ["0.37.0", false], ["0.38.1-beta.1", true]];
  for (const [latest, isNewer] of cases) {
    const r = updateRig({ body: { latest, next: "9.9.9" } });
    const u = await r.run();
    assert.deepEqual(u, { latest, current: "0.38.0", newer: isNewer, checked_at: new Date(NOW).toISOString(), source: "registry" });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].url, "https://registry.npmjs.org/-/package/@catscan%2fcli/dist-tags");
    assert.deepEqual(r.calls[0].init.headers, { "User-Agent": "catscan", Accept: "application/json" });
    assert.equal(r.calls[0].init.credentials, "omit");
    assert.ok(!JSON.stringify(r.calls[0]).includes("0.38.0"), "the installed version never leaves the machine");
  }
  assert.equal(update.renderUpdate({ latest: "0.41.0", current: "0.38.0", newer: true }), "ok   update: 0.38.0 installed, 0.41.0 available - try: the catscan-upgrade skill, or docs/recipes/upgrade.md");
  assert.equal(update.renderUpdate({ latest: "0.38.0", current: "0.38.0", newer: false }), "ok   update: 0.38.0 installed, the latest");
  assert.equal(update.renderUpdate({ latest: "0.0.4", current: "0.59.0", newer: false }), "ok   update: 0.59.0 installed, npm latest is 0.0.4");
  assert.equal(update.renderUpdate(null), null);
});

// Value: protects=a broken or slow registry costs at most one wait an hour and never prints or fails; fails_when=a timeout, non-200 or malformed body gives a result, throws, or is not cached as a failure; why_new=new; seam=o.fetch; no_claim=real network timing
test("update: timeout, non-200 and malformed bodies give null and cache a failure for an hour", async () => {
  // AbortSignal.timeout's timer is unref'd: a real fetch holds a socket open, this fake holds nothing, so on Node 22
  // the event loop ended before the abort and the runner cancelled the file. A ref'd timer stands in for the socket.
  const timeout = (init) => new Promise((_, reject) => {
    const socket = setTimeout(() => {}, 60_000);
    init.signal.addEventListener("abort", () => { clearTimeout(socket); reject(init.signal.reason); });
  });
  for (const reply of [{ status: 404, body: {} }, { body: "bad" }, { body: { latest: "not-a-version" } }, { body: [] }, new TypeError("fetch failed"), timeout]) {
    const r = updateRig(reply);
    assert.equal(await r.run(), null);
    assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).ok, false);
    assert.equal(await r.run({ now: NOW + 59 * 60_000 }), null);
    assert.equal(r.calls.length, 1, "a failure under 1 h makes no request");
    await r.run({ now: NOW + 61 * 60_000 });
    assert.equal(r.calls.length, 2, "a failure over 1 h is retried");
  }
  assert.equal(update.TIMEOUT_MS, 1500);
});

// Value: protects=doctor asks the registry at most once a day; fails_when=a fresh success refetches or a stale one is reused; why_new=new; seam=o.now, XDG_CACHE_HOME; no_claim=none
test("update: a success is reused from the cache under 24 h and refetched after", async () => {
  const r = updateRig({ body: { latest: "0.41.0" } });
  await r.run();
  const cached = await r.run({ now: NOW + 23 * 3600_000, current: "0.41.0" });
  assert.deepEqual(cached, { latest: "0.41.0", current: "0.41.0", newer: false, checked_at: new Date(NOW).toISOString(), source: "cache" });
  assert.equal(r.calls.length, 1);
  assert.equal((await r.run({ now: NOW + 25 * 3600_000 })).source, "registry");
  assert.equal(r.calls.length, 2);
  assert.equal(update.cachePath({}, "/Users/me"), "/Users/me/.cache/catscan/update-check.json");
});

// Value: protects=CI and opted-out machines make no request at all; fails_when=any opt-out still calls fetch or returns an object; why_new=new opt-outs (D4); seam=o.fetch; no_claim=none
test("update: --offline, CATSCAN_NO_UPDATE_CHECK=1 and CI skip the check with no request", async () => {
  const r = updateRig({ body: { latest: "0.41.0" } });
  assert.equal(await r.run({ offline: true }), null);
  assert.equal(await r.run({ env: { ...r.env, CATSCAN_NO_UPDATE_CHECK: "1" } }), null);
  assert.equal(await r.run({ env: { ...r.env, CI: "true" } }), null);
  assert.equal(r.calls.length, 0);
  assert.ok(!fs.existsSync(r.file));
  assert.notEqual(await r.run({ env: { ...r.env, CATSCAN_NO_UPDATE_CHECK: "0", CI: "" } }), null);
});

// Value: protects=the update field keeps doctor --json valid and never changes the exit code; fails_when=an update object or null breaks schema 1, or --offline is refused; why_new=new field and flag (D3, D17); seam=CATSCAN_CORE_BINARY, --offline; no_claim=a run with a real request (unit tests above)
test("cli: doctor --offline gives update null, validates, keeps exit 1 for a missing binary, and prints no update line", () => {
  const cli = path.resolve(__dirname, "../../../bin/catscan.js");
  const env = { ...process.env, CATSCAN_CORE_BINARY: "/nonexistent/catscan-core", CI: "" };
  const j = spawnSync(process.execPath, [cli, "doctor", "--json", "--offline"], { encoding: "utf8", env });
  assert.equal(j.status, 1, j.stderr);
  const o = JSON.parse(j.stdout);
  assert.equal(o.update, null);
  assert.ok(validate(o), JSON.stringify(validate.errors));
  assert.ok(validate({ ...o, update: { latest: "0.41.0", current: "0.38.0", newer: true, checked_at: "2026-11-23T12:00:00.000Z", source: "cache" } }));
  assert.ok(!validate({ ...o, update: { latest: "0.41.0" } }), "an update object needs every field");
  const t = spawnSync(process.execPath, [cli, "doctor", "--offline"], { encoding: "utf8", env });
  assert.equal(t.status, 1);
  assert.doesNotMatch(t.stdout, /update:/);
  const r = run();
  r.update = { latest: "0.41.0", current: V, newer: true, checked_at: "x", source: "registry" };
  assert.equal(doctor.renderDoctor(r).at(-1), `ok   update: ${V} installed, 0.41.0 available - try: the catscan-upgrade skill, or docs/recipes/upgrade.md`);
  assert.equal(r.ok, true);
});

// Value: protects=a broken cache never fails doctor or freezes the check (D3); fails_when=an unwritable cache dir throws, a corrupt or invalid cache throws or is trusted, or a future-dated entry is reused instead of refetched; why_new=the tests above only use a clean, writable cache; seam=o.fetch, XDG_CACHE_HOME; no_claim=file permissions on a real home
test("update: an unwritable, corrupt, invalid or future-dated cache still gives the registry answer", async () => {
  const fresh = { latest: "0.41.0", current: "0.38.0", newer: true, checked_at: new Date(NOW).toISOString(), source: "registry" };
  const blocked = updateRig({ body: { latest: "0.41.0" } });
  const notADir = path.join(blocked.cache, "file");
  fs.writeFileSync(notADir, "x");
  const env = { XDG_CACHE_HOME: notADir };
  assert.deepEqual(await blocked.run({ env }), fresh);
  assert.deepEqual(await blocked.run({ env }), fresh);
  assert.equal(blocked.calls.length, 2, "nothing cached, so each run asks");
  const entries = ["{", JSON.stringify({ checked_at: new Date(NOW).toISOString(), ok: true, latest: "x" }), JSON.stringify({ checked_at: new Date(NOW + 3600_000).toISOString(), ok: true, latest: "0.40.0" }), JSON.stringify({ checked_at: new Date(NOW + 600_000).toISOString(), ok: false, latest: null })];
  for (const entry of entries) {
    const r = updateRig({ body: { latest: "0.41.0" } });
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    fs.writeFileSync(r.file, entry);
    assert.deepEqual(await r.run(), fresh, entry);
    assert.equal(r.calls.length, 1, entry);
    assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).latest, "0.41.0", "the bad entry is replaced");
  }
});

// Value: protects=no request from a CI service that sets no CI variable, no cache in the project from a relative XDG_CACHE_HOME, and no write or hang through a planted symlink or FIFO; fails_when=disabled() ignores the CI detector, a relative base is used, or the cache is read or written through a non-regular file; why_new=ship review (D28); seam=o.fetch; no_claim=other users' permissions on a shared cache folder
test("update: CI services without CI, a relative XDG_CACHE_HOME, and a symlinked or FIFO cache file are handled (TODO-059 D28)", async () => {
  for (const env of [{ TF_BUILD: "True" }, { JENKINS_URL: "http://ci.example/" }]) {
    const r = updateRig({ body: { latest: "0.41.0" } });
    assert.equal(await r.run({ env: { ...r.env, ...env } }), null);
    assert.equal(r.calls.length, 0);
  }
  assert.equal(update.cachePath({ XDG_CACHE_HOME: "rel/cache" }, "/Users/me"), "/Users/me/.cache/catscan/update-check.json");
  const r = updateRig({ body: { latest: "0.41.0" } });
  fs.mkdirSync(path.dirname(r.file), { recursive: true });
  const victim = path.join(r.cache, "victim.txt");
  fs.writeFileSync(victim, JSON.stringify({ checked_at: new Date(NOW).toISOString(), ok: true, latest: "9.9.9" }));
  fs.symlinkSync(victim, r.file);
  assert.equal((await r.run()).latest, "0.41.0", "a symlinked cache is not read");
  assert.equal(JSON.parse(fs.readFileSync(victim, "utf8")).latest, "9.9.9", "the symlink target is not written");
  assert.ok(!fs.lstatSync(r.file).isSymbolicLink(), "the entry is replaced by a regular file");
  const f = updateRig({ body: { latest: "0.41.0" } });
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  spawnSync("mkfifo", [f.file]);
  assert.equal((await f.run()).latest, "0.41.0", "a FIFO at the cache path neither blocks nor is read");
});
