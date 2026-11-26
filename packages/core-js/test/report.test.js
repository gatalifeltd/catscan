// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// spec 18: the HTML report. No binary: thumbnails come from a stub `serve` client, and `catscan report` runs on
// results files whose images are absent (no thumbnail request, so no binary start).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const report = require("../src/report");
const overlay = require("../src/report/overlay");
const results = require("../src/results");
const args = require("../src/args");
const baseline = require("../src/baseline");

const ROOT = path.join(__dirname, "../../..");
const CLI = path.join(ROOT, "bin/catscan.js");
const GOLDEN = path.join(ROOT, "test/golden/report-5.html");
const HOST = { chip: "Apple M1", arch: "arm64", host_class: "physical", macos: "26.1 (25B78)", vision_revision: 3 };
const env = (p, locale, screen, verdict = "pass", extra = {}) => ({
  schema: 1, catscan: "0.14.0", command: "check", path: p, verdict, engine: "vision-accurate-rev3", locale,
  image: { width: 100, height: 200 }, screen, host: HOST, ms: 5, checks: [], findings: [], warnings: [], ...extra,
});
const missing = (locale, screen) => ({
  schema: 1, catscan: "0.14.0", command: "check", path: null, verdict: "fail", engine: null, locale, screen, image: null, host: null,
  ms: 0, checks: [], findings: [{ kind: "missing", box: null, expected_path: `${locale}/${screen}` }], warnings: [],
});
const DUP = { code: "duplicate-cell", message: "2 inputs map to locale en, screen home", hint: "remove the extra screenshot or fix --layout" };
const presentFail = { kind: "present", text: "Continue", verdict: "fail", box: null, line: null, confidence: null, closest: { line: "Contin", box: [0.1, 0.2, 0.3, 0.05], distance: 2 } };
const presentPass = { kind: "present", text: "Welcome", verdict: "pass", box: [0.1, 0.1, 0.4, 0.05], line: "Welcome", confidence: 1 };
const FIXED = new Date("2026-11-10T10:00:00Z");
const fileOf = (entries, coverage = null, argv = ["check", "shots"]) => results.build({
  results: entries, coverage, argv, started: FIXED, finished: FIXED, build: null, host: HOST, ci: null,
});
const cov = (locales, screens, received, miss = []) => ({ layout: "{locale}/{screen}", expected_locales: locales, expected_screens: screens, received, missing: miss });
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "catscan-report-"));
const stub = () => {
  const calls = [];
  return { calls, request: async (req) => { calls.push(req); return { id: req.id, width: 50, height: 100, jpeg: Buffer.from(req.path + (req.t ?? "")).toString("base64") }; } };
};
const dataOf = (html) => JSON.parse(html.match(/<script type="application\/json" id="catscan-data">([^]*?)<\/script>/)[1]);
const cli = (argv, cwd) => spawnSync(process.execPath, [CLI, ...argv], { cwd, encoding: "utf8", env: { ...process.env, CATSCAN_CORE_BINARY: "/nonexistent/catscan-core" } });

/** The five results of the golden snapshot: pass, fail, duplicate, unmapped, missing, with injection text. */
function five() {
  const e = [
    env("shots/en/home.png", "en", "home", "pass", { checks: [presentPass] }),
    env("shots/de/home.png", "de", "home", "fail", { checks: [presentFail] }),
    env("shots/de/shop.png", "de", "shop", "fail", { command: "check", findings: [{ kind: "raw-key", box: [0.2, 0.5, 0.3, 0.04], line: "</script><script>alert(1)</script>" }], warnings: [DUP] }),
    env('shots/"><img src=x onerror=alert(1)>.png', "en", null, "error", { error: { code: "input-unreadable", message: "bad\u2028line" } }),
    missing("en", "shop"),
  ];
  const f = fileOf(e, cov(["de", "en"], ["home", "shop"], 3, [{ locale: "en", screen: "shop" }]));
  f.run.catscan = "0.0.0-golden"; // a release bump must not change the snapshot
  return f;
}

test("overlay: every finding kind in the result schema has a color, style and label (D20)", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "core/schema/result.schema.json"), "utf8"));
  for (const k of schema.definitions.finding.properties.kind.enum) {
    const s = overlay.STYLES[k];
    assert.ok(s, `overlay.js has no style for ${k}`);
    assert.match(s.color, /^#[0-9a-f]{6}$/);
    assert.equal(typeof s.dash, "boolean");
    assert.ok(s.label);
  }
  for (const k of ["present-pass", "present-fail", "absent-fail"]) assert.ok(overlay.STYLES[k], k);
  // Color is never the only signal: the failed present check is dashed, the absent one solid.
  assert.equal(overlay.STYLES["present-fail"].dash, true);
  assert.equal(overlay.STYLES["absent-fail"].dash, false);
  const svg = overlay.svg(env("a.png", "en", null, "fail", { checks: [presentFail], findings: [{ kind: "overlap", box: [0, 0, 0.6, 0.6], a: { text: "A", box: [0, 0, 0.1, 0.1], confidence: 1 }, b: { text: "B", box: [0.5, 0.5, 0.1, 0.1], confidence: 1 }, overlap: 0.3, signal: "boxes" }] }));
  assert.equal((svg.match(/<rect /g) || []).length, 3, "the closest line plus both overlap line boxes, not their union (spec 12 D7)");
  assert.ok(!svg.includes('width="600"'), "the union box is not drawn");
  assert.match(svg, /stroke-dasharray/);
  // TODO-049 D1: an occluded finding draws the text's ink and the panel, not their union.
  const occ = overlay.svg(env("a.png", "en", null, "fail", { findings: [{ kind: "occluded", box: [0, 0, 0.6, 0.6], line: "A / [p]", a: { text: "A", box: [0, 0, 0.1, 0.1], confidence: null }, b: { text: null, box: [0.5, 0.5, 0.1, 0.1], confidence: null }, overlap: 0.3, signal: "elements" }] }));
  assert.equal((occ.match(/<rect /g) || []).length, 2);
  // TODO-067 D18: a stacked finding has one read and b null: one box, the merged region (box), not its first read.
  const st = overlay.svg(env("a.png", "en", null, "fail", { findings: [{ kind: "overlap", box: [0.2, 0.7, 0.5, 0.035], line: "Entn2:AhAckunck", a: { text: "Entn2:AhAckunck", box: [0.2, 0.7, 0.5, 0.02], confidence: 0.3 }, b: null, overlap: null, signal: "stacked", stacked_evidence: ["correction-dropped", "correction-changed"], corrected: "EiD Bild" }] }));
  assert.equal((st.match(/<rect /g) || []).length, 1);
  assert.deepEqual(overlay.shapes(env("a.png", "en", null, "fail", { findings: [{ kind: "overlap", box: [0.2, 0.7, 0.5, 0.035], line: "x", a: { text: "x", box: [0.2, 0.7, 0.5, 0.02], confidence: 0.3 }, b: null, overlap: null, signal: "stacked", stacked_evidence: ["correction-dropped"], corrected: null }] }))[0].boxes, [[0.2, 0.7, 0.5, 0.035]]);
});

test("matrix: rows and columns from (locale, screen); states, badges, unmapped and missing lists (D2, D4, D21)", () => {
  const m = report.matrix(five());
  assert.equal(m.shown, true);
  assert.deepEqual(m.locales, ["de", "en"]);
  assert.deepEqual(m.screens, ["home", "shop"]);
  const cell = (l, s) => m.cells.find((c) => c.locale === l && c.screen === s);
  assert.equal(cell("en", "home").state, "pass");
  assert.deepEqual([cell("de", "home").state, cell("de", "home").count], ["fail", 1]);
  assert.equal(cell("en", "shop").state, "missing");
  assert.deepEqual(cell("de", "shop").badges, ["duplicate"]);
  assert.equal(m.unmapped.length, 1);
  assert.deepEqual(m.missing, [{ device: null, text_size: null, locale: "en", screen: "shop", expected_path: "en/shop" }]);
  assert.equal(m.coverageLine, "received 3 of 4 expected cells (2 screens x 2 locales), 1 missing, 1 duplicate");
});

test("matrix: a merge of several commands over one cell shows no duplicate; a real duplicate keeps its badge (TODO-043)", () => {
  const shard = (command, paths) => fileOf(paths.map(([p, s]) => env(p, "en", s, "pass", { command })), cov(["en"], ["home", "pay"], paths.length), [command, "shots"]);
  const both = [["s/en/home.png", "home"], ["s/en/pay.png", "pay"]];
  const exp = { locales: ["en"], screens: ["home", "pay"] };
  const m = report.matrix(results.merge([shard("check", both), shard("untranslated", both)], { exp, layout: null, argv: [] }).file);
  assert.deepEqual(m.cells.map((c) => c.badges), [[], []]);
  assert.equal(m.coverageLine, "received 2 of 2 expected cells (2 screens x 1 locales), 0 missing, 0 duplicate");
  const d = report.matrix(results.merge([shard("check", [...both, ["t/en/home.png", "home"]]), shard("untranslated", both)], { exp, layout: null, argv: [] }).file);
  assert.deepEqual(d.cells.find((c) => c.screen === "home").badges, ["duplicate"]);
  assert.equal(d.coverageLine, "received 2 of 2 expected cells (2 screens x 1 locales), 0 missing, 1 duplicate");
});

test("matrix: a needs-reader cell outranks pass and fail, and error still outranks it (TODO-065 T1)", () => {
  // Value: protects=a cell nobody read is never drawn green; fails_when=RANK has no needs-reader key (the cell shows pass); why_new=new verdict; seam=none; no_claim=the browser-rendered totals span
  const nr = { error: { code: "reader-missing", message: "x", hint: "h" } };
  const m = report.matrix(fileOf([
    env("a/el/x.png", "el", "x", "pass"), env("b/el/x.png", "el", "x", "needs-reader", nr), env("c/el/x.png", "el", "x", "fail"),
    env("d/el/y.png", "el", "y", "needs-reader", nr), env("e/el/y.png", "el", "y", "error", { error: { code: "e", message: "e" } }),
  ], cov(["el"], ["x", "y"], 2)));
  assert.deepEqual(m.cells.map((c) => [c.screen, c.state]), [["x", "needs-reader"], ["y", "error"]]);
});

test("matrix: worst verdict wins in exit precedence; unexpected badge only with coverage; duplicate only from the warning", () => {
  const f = fileOf([
    env("a/en/x.png", "en", "x", "fail"), env("b/en/x.png", "en", "x", "unsupported", { error: { code: "u", message: "u" } }),
    env("c/en/y.png", "en", "y", "error", { error: { code: "e", message: "e" } }), env("d/en/y.png", "en", "y", "fail"),
    env("e/fr/x.png", "fr", "x", "pass"),
  ], cov(["en"], ["x", "y"], 4));
  const m = report.matrix(f);
  const cell = (l, s) => m.cells.find((c) => c.locale === l && c.screen === s);
  assert.equal(cell("en", "x").state, "unsupported");
  assert.equal(cell("en", "y").state, "error");
  assert.deepEqual(cell("fr", "x").badges, ["unexpected"]);
  // Two inputs in one cell but no duplicate-cell warning: no badge, the renderer never recounts.
  assert.deepEqual(cell("en", "x").badges, []);
  // A cell with two inputs counts once (D3).
  assert.equal(m.coverageLine, "received 2 of 2 expected cells (2 screens x 1 locales), 0 missing, 0 duplicate");
  assert.deepEqual(report.matrix(fileOf(f.results)).cells.find((c) => c.locale === "fr").badges, [], "coverage null: no unexpected badge");
});

test("matrix: coverage null draws no missing cell and no coverage line; no mapped input is a one-line hint (D2)", () => {
  const m = report.matrix(fileOf([env("shots/en/home.png", "en", "home")]));
  assert.equal(m.coverageLine, null);
  assert.ok(m.cells.every((c) => c.state !== "missing"));
  const h = report.matrix(fileOf([env("a.png", "en", null)], null, ["check", "a.png", "--layout", "{screen}.{locale}"]));
  assert.equal(h.shown, false);
  assert.equal(h.hint, "no input matched --layout '{screen}.{locale}'; see --layout and --expect-locales");
  assert.equal(h.unmapped.length, 1);
});

test("video: marks at first_seen, last_seen and failed closest.t; at most 10 thumbnails at failed times (D5)", async () => {
  const checks = [
    { kind: "present", text: "GO", verdict: "pass", box: [0, 0, 0.1, 0.1], line: "GO", confidence: 1, first_seen: 1, last_seen: 3 },
    ...Array.from({ length: 12 }, (_, i) => ({ kind: "present", text: `T${i}`, verdict: "fail", box: null, line: null, confidence: null, first_seen: null, last_seen: null, closest: { line: "x", box: [0, 0, 0.1, 0.1], distance: 1, t: i } })),
    { kind: "absent", text: "KEY_", verdict: "fail", box: [0, 0, 0.1, 0.1], line: "KEY_x", confidence: 1, first_seen: 0.5, last_seen: 0.5 },
  ];
  const v = env("take.mp4", "en", null, "fail", { command: "video", image: null, video: { width: 100, height: 200, fps: 30, duration: 20 }, frames: 40, checks });
  const tl = report.videoTimeline(v);
  assert.equal(tl.duration, 20);
  assert.deepEqual(tl.marks.filter((m) => m.ref === "c0").map((m) => [m.type, m.t]), [["first_seen", 1], ["last_seen", 3]]);
  assert.equal(tl.marks.filter((m) => m.type === "closest").length, 12);
  assert.deepEqual(tl.times, [0, 0.5, 1, 2, 3, 4, 5, 6, 7, 8]);
  const s = stub();
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "take.mp4"), "");
  await report.build(fileOf([v]), { root: dir, request: s.request, locate: (e) => report.resolveUnder(dir, e.path), reportPath: path.join(dir, "r.html") });
  assert.equal(s.calls.length, 10);
  assert.ok(s.calls.every((c) => typeof c.t === "number" && c.command === "thumbnail"));
});

test("images: relative and abs: paths resolve under --images-root; ../ and symlinks out of it do not (D7)", () => {
  const dir = tmpdir(), root = path.join(dir, "root");
  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  fs.writeFileSync(path.join(root, "shots/a.png"), "x");
  fs.writeFileSync(path.join(dir, "secret.png"), "x");
  fs.symlinkSync(path.join(dir, "secret.png"), path.join(root, "shots/link.png"));
  const real = fs.realpathSync(path.join(root, "shots/a.png"));
  assert.equal(report.resolveUnder(root, "shots/a.png").abs, real);
  assert.equal(report.resolveUnder(root, "abs:shots/a.png").abs, real);
  assert.equal(report.resolveUnder(root, "../secret.png").abs, null);
  assert.deepEqual(report.resolveUnder(root, "shots/link.png").why, "outside --images-root after symlinks");
  assert.equal(report.resolveUnder(root, "shots/none.png").why, "not found");
  assert.equal(report.resolveUnder(root, "shots/none.png").abs, null);
  assert.equal(report.resolveUnder(root, "-").abs, null);
});

test("images: placeholder size from image, then video, else 9:19.5; report-image-missing capped at 10 lines (D26)", async () => {
  const dir = tmpdir();
  const entries = Array.from({ length: 12 }, (_, i) => env(`shots/en/s${String(i).padStart(2, "0")}.png`, "en", `s${i}`));
  entries[1] = { ...entries[1], image: null };
  entries[2] = { ...entries[2], image: null, command: "video", video: { width: 30, height: 40, fps: 30, duration: 2 }, frames: 4, checks: [presentFail] };
  const built = await report.build(fileOf(entries), { root: dir, request: stub().request, locate: (e) => report.resolveUnder(dir, e.path), reportPath: path.join(dir, "r.html") });
  const d = dataOf(built.html);
  const img = (p) => d.items.find((it) => it.path === p);
  assert.deepEqual([img("shots/en/s00.png").image.width, img("shots/en/s00.png").image.blob], [100, null]);
  assert.deepEqual([img("shots/en/s01.png").image.width, img("shots/en/s01.png").image.height], [9, 19.5]);
  assert.equal(img("shots/en/s02.png").timeline.frames.length, 0, "no failed time: no frame");
  assert.equal(built.images, 0);
  assert.equal(built.warnings.length, 11);
  assert.ok(built.warnings.every((w) => w.code === "report-image-missing" && w.hint));
  assert.match(built.warnings[10].message, new RegExp(`^2 more images were not found under ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} or point outside it$`));
});

test("images: link mode links PNG, JPEG, GIF, WebP only, percent-encoded and relative; embeds the rest; one request per path (D8, D18)", async () => {
  const dir = tmpdir();
  const names = ["a b.png", "c#?.jpg", "d.gif", "e.webp", "f.heic", "g.tiff", "javascript:x.png"];
  fs.mkdirSync(path.join(dir, "shots"));
  for (const n of names) fs.writeFileSync(path.join(dir, "shots", n), "x");
  const entries = names.map((n) => env(`shots/${n}`, "en", null));
  entries.push(env("shots/a b.png", "de", null)); // the same file twice: one request
  entries.push(env("abs:shots/d.gif", "fr", null)); // abs: is always embedded
  const s = stub();
  const built = await report.build(fileOf(entries), { mode: "link", root: dir, request: s.request, locate: (e) => report.resolveUnder(dir, e.path), reportPath: path.join(dir, "out/r.html") });
  const d = dataOf(built.html);
  const by = (p, l) => d.items.find((it) => it.path === p && it.locale === l).image;
  assert.equal(by("shots/a b.png", "en").url, "../shots/a%20b.png");
  assert.equal(by("shots/c#?.jpg", "en").url, "../shots/c%23%3F.jpg");
  assert.equal(by("shots/javascript:x.png", "en").url, "../shots/javascript%3Ax.png");
  for (const u of d.items.map((it) => it.image.url).filter(Boolean)) assert.doesNotMatch(u, /^[a-z][a-z0-9+.-]*:/i, "no scheme");
  assert.equal(by("shots/f.heic", "en").url, null);
  assert.equal(typeof by("shots/f.heic", "en").blob, "number");
  assert.equal(typeof by("abs:shots/d.gif", "fr").blob, "number");
  assert.deepEqual(s.calls.map((c) => path.basename(c.path)).sort(), ["d.gif", "f.heic", "g.tiff"]);
  assert.match(built.html, /img-src data: &#39;self&#39; file:;/);
  // Embed mode: one request per distinct path, and one JPEG for both thumbnail and image view (D18).
  const e = stub();
  const em = await report.build(fileOf(entries), { root: dir, request: e.request, locate: (x) => report.resolveUnder(dir, x.path), reportPath: path.join(dir, "r.html") });
  assert.equal(e.calls.length, names.length);
  assert.equal(dataOf(em.html).blobs.length, names.length);
  assert.ok(e.calls.every((c) => c.max_edge === 800 && c.quality === 0.7));
});

test("link mode: a report outside the images root embeds instead of linking out of it (spec 27 D9)", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "root/shots"), { recursive: true });
  fs.writeFileSync(path.join(dir, "root/shots/a.png"), "x");
  const root = path.join(dir, "root");
  const built = await report.build(fileOf([env("shots/a.png", "en", null)]), { mode: "link", root, request: stub().request, locate: (e) => report.resolveUnder(root, e.path), reportPath: path.join(dir, "elsewhere/r.html") });
  assert.equal(dataOf(built.html).items[0].image.url, null);
});

test("escaping: injection text renders as data; the embedded JSON escapes <, >, &, U+2028, U+2029 (spec 18 Escaping)", () => {
  const html = report.html(five());
  const block = html.match(/<script type="application\/json" id="catscan-data">([^]*?)<\/script>/)[1];
  assert.doesNotMatch(block, /[<>&\u2028\u2029]/);
  assert.equal((html.match(/<script/g) || []).length, 2, "the data block and the one inline script, nothing from the data");
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
  const d = dataOf(html);
  assert.equal(d.results.find((e) => e.findings.length && e.findings[0].kind === "raw-key").findings[0].line, "</script><script>alert(1)</script>");
  assert.equal(d.results.find((e) => e.error).error.message, "bad\u2028line");
  assert.ok(!html.includes("onerror=alert(1)>"), "a file name with markup never reaches the HTML raw");
  // The page script inserts no dynamic string as markup.
  assert.doesNotMatch(report.pageScript(), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.equal(report.embedJSON({ s: "<&>\u2028\u2029" }), '{"s":"\\u003c\\u0026\\u003e\\u2028\\u2029"}');
});

test("CSP: the hash matches the inline script; img-src differs by mode (D17)", () => {
  for (const mode of ["embed", "link"]) {
    const html = report.html(five(), { mode });
    const script = html.match(/<script>([^]*?)<\/script>/)[1];
    const hash = crypto.createHash("sha256").update(script, "utf8").digest("base64");
    const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1].replace(/&#39;/g, "'");
    assert.ok(policy.includes(`script-src 'sha256-${hash}'`), mode);
    assert.ok(policy.startsWith("default-src 'none'; "), mode);
    assert.ok(policy.endsWith("; base-uri 'none'; form-action 'none'"), mode);
    assert.ok(policy.includes(mode === "link" ? "img-src data: 'self' file:;" : "img-src data:;"), mode);
  }
  // No external request: no fonts, CDNs or analytics; the one URL is the SVG namespace, an identifier never fetched.
  assert.deepEqual([...new Set(report.html(five()).match(/https?:\/\/[^\s"']+/g))], ["http://www.w3.org/2000/svg"]);
});

test("privacy: argv and paths keep the spec 27 D9 rewrite; no home folder or user name in the file (D9)", async () => {
  const home = os.homedir();
  const argv = results.privateArgv(["check", path.join(home, "secret-project/shots"), "--present", "Continue", "--report", path.join(home, "r.html")], tmpdir());
  const dir = tmpdir();
  const f = fileOf([env("abs:shots/en/home.png", "en", "home")], null, argv);
  const built = await report.build(f, { root: dir, request: stub().request, locate: (e) => report.resolveUnder(dir, e.path), reportPath: path.join(dir, "r.html") });
  assert.ok(!built.html.includes(home), "no home folder");
  assert.ok(!built.html.includes(os.userInfo().username + "/"), "no user name path");
  assert.ok(dataOf(built.html).run.argv.includes("abs:shots"));
});

test("D1: the same results object gives the same HTML, whichever entry point built it", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "shots/en"), { recursive: true });
  fs.writeFileSync(path.join(dir, "shots/en/home.png"), "x");
  const f = fileOf([env("shots/en/home.png", "en", "home")]);
  const viaReport = await report.build(f, { root: dir, request: stub().request, locate: (e) => report.resolveUnder(dir, e.path), reportPath: path.join(dir, "r.html") });
  const real = fs.realpathSync(path.join(dir, "shots/en/home.png"));
  const viaRun = await report.build(JSON.parse(JSON.stringify(f)), { root: dir, request: stub().request, locate: () => ({ abs: real, tried: real }), reportPath: path.join(dir, "r.html") });
  assert.equal(viaRun.html, viaReport.html);
});

test("snapshot: the generated file for a fixed set of 5 results (test/golden/report-5.html, D20)", () => {
  const html = report.html(five());
  if (process.env.CATSCAN_UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, html);
  assert.equal(html, fs.readFileSync(GOLDEN, "utf8"), "run with CATSCAN_UPDATE_GOLDEN=1 after an intended change");
});

test("size: report-large only over the threshold, with the hint (D12); the D24 summary line", () => {
  assert.equal(report.largeWarning(1000, 2000), null);
  const w = report.largeWarning(3 * 1048576, 2 * 1048576);
  assert.equal(w.code, "report-large");
  assert.match(w.hint, /--report-images link/);
  assert.match(w.hint, /--report-max-edge/);
  assert.equal(report.largeWarning(report.LARGE), null);
  assert.equal(report.summaryLine("out/r.html", 2.5 * 1048576, 12), "catscan: report: out/r.html (2.5 MB, 12 images)");
});

test("args: --report, --report-images and --report-max-edge parse on every checking command (D25)", () => {
  for (const c of ["check", "read", "untranslated", "video", "truncated"]) {
    const extra = c === "check" || c === "video" ? ["--present", "x"] : [];
    const o = args.parse([c, "a", ...extra, "--report", "r.html", "--report-images", "link", "--report-max-edge", "600"]);
    assert.deepEqual([o.report, o.reportImages, o.reportMaxEdge], ["r.html", "link", 600], c);
  }
  const usage = (argv, code) => assert.throws(() => args.parse(argv), (e) => e.code === code, argv.join(" "));
  usage(["read", "a.png", "--report-images", "link"], "option-not-valid");
  usage(["read", "a.png", "--report", "r.html", "--report-images", "zip"], "invalid-value");
  usage(["read", "a.png", "--report", "r.html", "--report-max-edge", "10"], "invalid-value");
  usage(["read", "a.png", "--images-root", "."], "option-not-valid");
  usage(["languages", "--report", "r.html"], "option-not-valid");
  usage(["report"], "missing-path");
  usage(["report", "a.json", "--json"], "option-not-valid");
  usage(["report", "a.json", "--report", "r.html"], "option-not-valid");
  assert.equal(args.parse(["report", "a.json"]).out, "catscan-report.html");
  assert.equal(args.parse(["report", "a.json", "--images-root", "x", "--out", "o.html"]).imagesRoot, "x");
});

test("catscan report: no file is exit 2 with the hint; exit from merged verdicts, missing included; a missing image warns only (D11, D25)", () => {
  const dir = tmpdir();
  const none = cli(["report"], dir);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /catscan: missing-path: report needs at least one results file - try: catscan report catscan-results.json/);
  const a = fileOf([env("shots/de/home.png", "de", "home")], null, ["check", "shots"]);
  const b = { ...fileOf([env("shots/en/home.png", "en", "home")], null, ["check", "shots", "--x"]) };
  b.run = { ...b.run, started_at: "2026-11-10T10:01:00Z" };
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(a));
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify(b));
  const ok = cli(["report", "a.json", "b.json"], dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /catscan: report-image-missing: .*shots\/de\/home\.png: not found/);
  assert.match(ok.stderr, /catscan: report: catscan-report\.html \(0\.\d MB, 0 images\)/);
  const d = dataOf(fs.readFileSync(path.join(dir, "catscan-report.html"), "utf8"));
  assert.deepEqual(d.matrix.locales, ["de", "en"], "two shards, one matrix");
  assert.equal(d.run.shards.length, 2);
  const miss = cli(["report", "a.json", "b.json", "--expect-locales", "de,en,fr", "--out", "m.html", "-q"], dir);
  assert.equal(miss.status, 1, miss.stderr);
  assert.equal(dataOf(fs.readFileSync(path.join(dir, "m.html"), "utf8")).matrix.missing.length, 1);
});

test("write: atomic; a read-only folder is exit 4 report-write-failed and keeps the old file; a usage error writes nothing (D10)", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(fileOf([env("shots/de/home.png", "de", "home")])));
  fs.mkdirSync(path.join(dir, "ro"));
  fs.writeFileSync(path.join(dir, "ro/r.html"), "old");
  fs.chmodSync(path.join(dir, "ro"), 0o555);
  try {
    const r = cli(["report", "a.json", "--out", "ro/r.html"], dir);
    assert.equal(r.status, 4);
    assert.match(r.stderr, /catscan: report-write-failed: cannot write the HTML report ro\/r\.html: EACCES - try: /);
    assert.equal(fs.readFileSync(path.join(dir, "ro/r.html"), "utf8"), "old");
    assert.deepEqual(fs.readdirSync(path.join(dir, "ro")), ["r.html"], "no temp file left");
  } finally { fs.chmodSync(path.join(dir, "ro"), 0o755); }
  const u = cli(["check", "shots", "--report", "u.html"], dir);
  assert.equal(u.status, 2);
  assert.ok(!fs.existsSync(path.join(dir, "u.html")));
});

test("privacy: a hand-made results file with home-folder paths shows them as ~ (D9, outside-voice fix)", () => {
  const home = os.homedir();
  const f = fileOf([env(`${home}/shots/en/home.png`, "en", "home", "error", { error: { code: "input-unreadable", message: `cannot read ${home}/shots/en/home.png` } }),
    env("shots/en/b.png", "en", "b", "pass", { lines: [{ text: `${home}/Documents`, box: [0, 0, 0.1, 0.1], confidence: 1 }] })], null, ["check", `${home}/shots`]);
  f.run.shards = [{ argv: ["check", `${home}/a`] }];
  const html = report.html(f);
  const d = dataOf(html);
  assert.equal(d.results.find((e) => e.error).path, "~/shots/en/home.png");
  assert.equal(d.results.find((e) => e.error).error.message, "cannot read ~/shots/en/home.png");
  assert.equal(d.results.find((e) => e.lines).lines[0].text, `${home}/Documents`, "recognized text is evidence, never rewritten");
  assert.deepEqual(d.run.argv, ["check", "~/shots"]);
  assert.equal(d.run.shards[0].argv[1], "~/a");
  assert.equal(report.html(five()), fs.readFileSync(GOLDEN, "utf8"), "a file without home paths is unchanged");
});

/** TODO-038 T3: a compared file from literal text records: changed, unchanged with minor_diff, new, ambiguous, gone. */
function compared(mode = "full") {
  // digest mode keeps algo and digest only (TODO-038 T1): no tokens, no lines.
  const rec = (lines, tokens = lines.join(" ").split(" ").sort()) => (mode === "full" ? { algo: 1, tokens, lines, digest: baseline.tokensDigest(tokens), ignore: null } : { algo: 1, digest: baseline.tokensDigest(tokens), ignore: null });
  const t = (p, l, s, lines, extra = {}) => env(p, l, s, "pass", { text: rec(lines, extra.tokens), change: null, ...extra.env });
  const base = fileOf([t("a/de/home.png", "de", "home", ["jetzt testen"]), t("a/de/pay.png", "de", "pay", ["kaufen"]), t("a/de/old.png", "de", "old", ["alt"]),
    t("a/en/home.png", "en", "home", ["play"])]);
  base.approved = { at: "2026-11-01T00:00:00Z", from: baseline.fileDigest(base) };
  const cur = fileOf([t("b/de/home.png", "de", "home", ["</script><b>neu</b>"]), t("b/de/pay.png", "de", "pay", ["kaufen!"], { tokens: ["kaufen"] }),
    t("b/de/new.png", "de", "new", ["neu"]), t("b/en/home.png", "en", "home", ["play"], { env: { warnings: [DUP] } }), t("b/en/home.jpg", "en", "home", ["play"], { env: { warnings: [DUP] } })]);
  baseline.compare(cur, base, { file: "base.json" });
  return cur;
}

test("baseline: matrix cells and items carry baseline.cells[] index and review; gone is grey and not failing (TODO-038 T3)", () => {
  // Value: protects=the report reads each cell's change and review from baseline.cells[] (D7) and shows gone cells; fails_when=the report recomputes or mismatches a state, or a gone cell counts as failing or received; why_new=new surface; seam=none; no_claim=page rendering (browser spec)
  const f = compared();
  const m = report.matrix(f);
  const at = (l, s) => m.cells.find((c) => c.locale === l && c.screen === s);
  const st = (l, s) => f.baseline.cells[at(l, s).change];
  assert.deepEqual([st("de", "home").state, at("de", "home").review], ["changed", true]);
  assert.deepEqual([st("de", "pay").state, at("de", "pay").review, !!st("de", "pay").minor_diff], ["unchanged", false, true]);
  assert.deepEqual([st("de", "new").state, at("de", "new").review], ["new", true]);
  assert.deepEqual([st("en", "home").state, at("en", "home").review], ["ambiguous", true]);
  assert.deepEqual([at("de", "old").state, st("de", "old").state, at("de", "old").items, at("de", "old").review], ["gone", "gone", [], false]);
  const d = dataOf(report.html(f));
  assert.equal(d.baseline.summary, baseline.summaryLine(f.baseline), "the header line is the CLI's, never recomputed");
  assert.deepEqual(d.items.map((it) => [it.path, it.review]), [["b/de/home.png", true], ["b/de/new.png", true], ["b/de/pay.png", false], ["b/en/home.jpg", true], ["b/en/home.png", true]]);
  // A hand-made file with home paths: envelope and cell input paths get the same rewrite, so the pairing holds (D9).
  const h = compared();
  const abs = `${os.homedir()}/b/de/home.png`;
  h.results.find((e) => e.path === "b/de/home.png").path = abs;
  h.baseline.cells.find((c) => c.state === "changed").inputs[0].path = abs;
  const hd = dataOf(report.html(h));
  const hi = hd.items.find((it) => it.path === "~/b/de/home.png");
  assert.equal(hd.baseline.cells[hi.change].state, "changed");
  assert.equal(hd.baseline.cells[hi.change].inputs[0].path, "~/b/de/home.png");
  // Without a baseline, no field and no cell index: the page renders as before.
  const plain = report.matrix(fileOf([env("shots/en/home.png", "en", "home")]));
  assert.equal("change" in plain.cells[0], false);
  // A missing cell stays in review (outside the denominator, still a gap the tester sees).
  const withMissing = compared();
  withMissing.results.push(missing("fr", "home"));
  assert.equal(report.matrix(withMissing).cells.find((c) => c.locale === "fr").review, true);
  // A baseline-only cell the run lists as missing is shown missing, never grey gone.
  const goneMissing = compared();
  goneMissing.results.push(missing("de", "old"));
  assert.deepEqual(report.matrix(goneMissing).cells.filter((c) => c.screen === "old").map((c) => c.state), ["missing"]);
  // An input no cell names needs review, and keeps its whole matrix cell in review even when a sibling is skippable.
  const unnamed = compared();
  unnamed.results.push(env("b/de/pay.png", "de", "pay", "pass", { command: "untranslated", change: null }));
  const un = dataOf(report.html(unnamed));
  assert.deepEqual([un.items.find((it) => it.path === "b/de/pay.png" && it.change === null).review], [true]);
  assert.equal(un.matrix.cells.find((c) => c.screen === "pay").review, true);
});

test("baseline: digest mode embeds no line text; full mode escapes it in the JSON block (D14, spec 18 D15)", () => {
  // Value: protects=privacy of --text-record digest in the report and script-safe embedding of recognized lines; fails_when=the page carries lines a digest run did not record, or a line closes the script block; why_new=new data in the page; seam=none; no_claim=what the browser renders (browser spec)
  const full = report.html(compared());
  assert.ok(!full.includes("</script><b>"), "recognized text cannot close the data block");
  assert.deepEqual(dataOf(full).baseline.cells.find((c) => c.state === "changed").diff.added, ["</script><b>neu</b>"]);
  const digest = report.html(compared("digest"));
  for (const word of ["jetzt testen", "neu</b>", "\\u003c/script\\u003e\\u003cb\\u003eneu"]) assert.ok(!digest.includes(word), `the digest page holds no line text: ${word}`);
  for (const word of ["jetzt testen", "neu</b>", "kaufen!"]) assert.ok(!dataOf(digest).baseline.cells.some((c) => JSON.stringify(c).includes(word)), word);
  assert.equal(dataOf(digest).baseline.cells.find((c) => c.state === "changed").diff, null);
});

test("catscan report: usage errors for a missing --images-root, stdin and --out naming an input (D25)", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(fileOf([env("shots/de/home.png", "de", "home")])));
  const root = cli(["report", "a.json", "--images-root", "nope"], dir);
  assert.equal(root.status, 2);
  assert.match(root.stderr, /catscan: images-root-not-found: --images-root nope is not a folder/);
  const stdin = cli(["report", "-"], dir);
  assert.equal(stdin.status, 2);
  assert.match(stdin.stderr, /catscan: option-not-valid: report reads results files, not stdin/);
  const same = cli(["report", "a.json", "--out", "a.json"], dir);
  assert.equal(same.status, 2);
  assert.match(same.stderr, /catscan: conflicting-options: --out a\.json is also an input/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "a.json"), "utf8")).results_schema, 1, "the input is untouched");
});

test("link mode: an image whose real path leaves the root (a symlinked folder) is embedded, never linked (D8, D9)", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "elsewhere"));
  fs.writeFileSync(path.join(dir, "elsewhere/a.png"), "x");
  fs.mkdirSync(path.join(dir, "root"));
  fs.symlinkSync(path.join(dir, "elsewhere"), path.join(dir, "root/shots"));
  const root = path.join(dir, "root");
  const real = fs.realpathSync(path.join(dir, "elsewhere/a.png"));
  const built = await report.build(fileOf([env("shots/a.png", "en", null)]), { mode: "link", root, request: stub().request, locate: () => ({ abs: real, tried: "shots/a.png" }), reportPath: path.join(root, "r.html") });
  const img = dataOf(built.html).items[0].image;
  assert.equal(img.url, null);
  assert.equal(typeof img.blob, "number");
});

test("images: a thumbnail error reply or a failed request is a placeholder with report-image-missing naming why", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "shots"));
  for (const n of ["a.png", "b.png"]) fs.writeFileSync(path.join(dir, "shots", n), "x");
  let k = 0;
  const request = async (req) => (k++ === 0 ? { id: req.id, error: { code: "input-unreadable", message: "bad" } } : Promise.reject(Object.assign(new Error("gone"), { code: "binary-failed" })));
  const built = await report.build(fileOf([env("shots/a.png", "en", null), env("shots/b.png", "de", null)]), { root: dir, request, locate: (e) => report.resolveUnder(dir, e.path), reportPath: path.join(dir, "r.html") });
  assert.equal(built.images, 0);
  assert.deepEqual(built.warnings.map((w) => w.message.replace(/^.*: /, "").replace(/;.*$/, "")).sort(), ["binary-failed", "input-unreadable"]);
  assert.ok(built.warnings.every((w) => w.code === "report-image-missing"), "a partial failure stays per image (D27)");
  assert.ok(dataOf(built.html).items.every((it) => it.image.blob === null && it.image.url === null));
});

test("images: every thumbnail failing on the core binary is one report-images-unavailable naming catscan doctor (D27)", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "shots"));
  for (const n of ["a.png", "b.png", "c.png"]) fs.writeFileSync(path.join(dir, "shots", n), "x");
  const request = () => Promise.reject(Object.assign(new Error("could not start catscan-core: ENOENT"), { code: "binary-failed" }));
  const entries = ["a", "b", "c"].map((n) => env(`shots/${n}.png`, n, null));
  const built = await report.build(fileOf(entries), { root: dir, request, locate: (e) => report.resolveUnder(dir, e.path), reportPath: path.join(dir, "r.html") });
  assert.equal(built.images, 0);
  assert.deepEqual(built.warnings.map((w) => [w.code, w.hint]), [["report-images-unavailable", "catscan doctor"]]);
  assert.match(built.warnings[0].message, /could not make any thumbnail \(could not start catscan-core: ENOENT\)/);
  // A file that is really missing still names --images-root next to it.
  const more = await report.build(fileOf([...entries, env("shots/gone.png", "d", null)]), { root: dir, request, locate: (e) => report.resolveUnder(dir, e.path), reportPath: path.join(dir, "r.html") });
  assert.deepEqual(more.warnings.map((w) => w.code), ["report-image-missing", "report-images-unavailable"]);
  assert.match(more.warnings[0].message, /gone\.png: not found/);
  // A binary-failed reply (not a rejection) on every thumbnail is the same case.
  const replied = await report.build(fileOf(entries), { root: dir, request: async (req) => ({ id: req.id, error: { code: "binary-failed", message: "catscan-core crashed" } }), locate: (e) => report.resolveUnder(dir, e.path), reportPath: path.join(dir, "r.html") });
  assert.deepEqual(replied.warnings.map((w) => w.code), ["report-images-unavailable"]);
});

test("catscan report: a core binary that cannot start keeps the verdict exit code and prints one warning (D27)", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "shots", "de"), { recursive: true });
  fs.writeFileSync(path.join(dir, "shots", "de", "home.png"), "x");
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(fileOf([env("shots/de/home.png", "de", "home")], null, ["check", "shots"])));
  const r = cli(["report", "a.json"], dir);
  assert.equal(r.status, 0, r.stderr);
  const diags = r.stderr.trim().split("\n").filter((l) => !/^catscan: (report|counts): /.test(l));
  assert.equal(diags.length, 1, r.stderr);
  assert.match(r.stderr, /catscan: report-images-unavailable: catscan-core could not make any thumbnail .* - try: catscan doctor/);
  assert.doesNotMatch(r.stderr, /report-image-missing|binary-failed:/);
  const fail = { ...fileOf([env("shots/de/home.png", "de", "home", "fail")], null, ["check", "shots"]) };
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify(fail));
  assert.equal(cli(["report", "b.json", "--out", "b.html"], dir).status, 1);
});

test("privacy: a missing entry's expected_path and a finding's catalog get the home rewrite too (D9)", () => {
  const home = os.homedir();
  const m = missing("en", "home");
  m.findings[0].expected_path = `${home}/p/en/home`;
  const f = fileOf([env("a.png", "en", null, "fail", { findings: [{ kind: "untranslated", box: null, key: "k", catalog: `${home}/p/de.json`, base: "Hi", expected: "Hallo", line: "Hi" }] }), m]);
  assert.ok(!report.html(f).includes(home));
});

test("catscan report: --layout none is a usage error (a report needs a layout)", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(fileOf([env("shots/de/home.png", "de", "home")])));
  const r = cli(["report", "a.json", "--layout", "none"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /catscan: invalid-layout: report needs a layout to compute coverage, not none/);
});

test("catscan report: with images present and no binary, the page is still written with placeholders", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "shots/de"), { recursive: true });
  fs.writeFileSync(path.join(dir, "shots/de/home.png"), "x");
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(fileOf([env("shots/de/home.png", "de", "home")])));
  const r = cli(["report", "a.json"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /catscan: (binary-failed|binary-missing|[a-z-]+): /);
  assert.match(r.stderr, /catscan: report: catscan-report\.html \(0\.\d MB, 0 images\)/);
});

test("images: at most 8 thumbnail requests are in flight, and every reply lands", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "shots"));
  const names = Array.from({ length: 30 }, (_, i) => `s${i}.png`);
  for (const n of names) fs.writeFileSync(path.join(dir, "shots", n), "x");
  let open = 0, peak = 0;
  const request = async (req) => {
    open++; peak = Math.max(peak, open);
    await new Promise((r) => setTimeout(r, 2));
    open--;
    return { id: req.id, width: 1, height: 2, jpeg: Buffer.from(req.path).toString("base64") };
  };
  const built = await report.build(fileOf(names.map((n) => env(`shots/${n}`, "en", null))), { root: dir, request, locate: (e) => report.resolveUnder(dir, e.path), reportPath: path.join(dir, "r.html") });
  assert.equal(peak, 8);
  assert.equal(built.images, 30);
  const d = dataOf(built.html);
  for (const it of d.items) assert.ok(Buffer.from(d.blobs[it.image.blob].split(",")[1], "base64").toString().endsWith(it.path.slice(6)), "each image gets its own reply");
});

test("TODO-077: items carry rank, severities and certainties; matrix cells their worst severity; entries sorted with badges; an older file ranks as before", () => {
  const scale = require("../src/scale");
  const overlay = require("../src/report/overlay");
  const boxes = { kind: "overlap", signal: "boxes", box: [0.1, 0.1, 0.5, 0.1], line: "Kopf / Fuss", a: { text: "Kopf", box: [0.1, 0.1, 0.5, 0.05], confidence: 1 }, b: { text: "Fuss", box: [0.1, 0.12, 0.5, 0.05], confidence: 1 }, overlap: 0.4 };
  const trunc = { kind: "truncated", box: [0.1, 0.5, 0.5, 0.1], line: "Weiter...", reason: "ellipsis", element: null, expected: null, confidence: 1 };
  const ph = { kind: "placeholder", box: [0.1, 0.7, 0.5, 0.1], line: "Hi {name}", token: "{name}" };
  const th = { min_severity: "minor", min_certainty: "medium" };
  const a = scale.annotate(env("shots/de/home.png", "de", "home", "fail", { command: "untranslated", findings: [boxes, trunc] }), th);
  const b = scale.annotate(env("shots/de/pay.png", "de", "pay", "fail", { command: "untranslated", findings: [trunc, ph].map((f) => ({ ...f })) }), th);
  const c = scale.annotate(env("shots/fr/home.png", "fr", "home", "fail", { command: "untranslated", findings: [{ ...boxes }] }), th);
  const d = dataOf(report.html(fileOf([a, b, c], cov(["de", "fr"], ["home", "pay"], 3))));
  const by = Object.fromEntries(d.items.map((it) => [it.path, it]));
  assert.deepEqual(by["shots/de/pay.png"].rank, [0, 0, 1], "critical/medium first");
  assert.deepEqual(by["shots/de/home.png"].rank, [0, 1, 1]);
  assert.deepEqual(by["shots/fr/home.png"].rank, [1, 1, 2], "a pass with a below-threshold finding ranks after the failures");
  assert.deepEqual(by["shots/de/home.png"].severities, ["major"]);
  assert.deepEqual(by["shots/de/home.png"].certainties, ["medium"], "below-threshold items do not feed the filters");
  assert.equal(by["shots/fr/home.png"].count, 0);
  const cells = Object.fromEntries(d.matrix.cells.map((x) => [`${x.locale}/${x.screen}`, x]));
  assert.equal(cells["de/pay"].severity, "critical");
  assert.equal(cells["fr/home"].severity, undefined);
  assert.equal(cells["fr/home"].state, "pass");
  const s = overlay.shapes(a);
  assert.deepEqual(s.map((x) => [x.label, x.sev, x.verdict]), [["truncated", "major/medium", "fail"], ["overlap", "major/low", "note"]]);
  // A file from before the scale: no rank key change for failures, no badge.
  const old = dataOf(report.html(fileOf([env("shots/de/x.png", "de", "x", "fail", { command: "untranslated", findings: [{ kind: "truncated", box: null, line: "W...", reason: "ellipsis", element: null, expected: null, confidence: 1 }] })])));
  assert.deepEqual(old.items[0].severities, []);
  assert.equal(overlay.shapes(old.results[0])[0].sev, null);
});

test("devices (TODO-075): one device as today; two give sub-columns by platform then label, own severity, coverage factor, unexpected device", () => {
  const dev = (d, p, locale, screen, verdict = "pass", extra = {}) => env(p, locale, screen, verdict, { device: d, platform: results.platformOf(d), ...extra });
  // One device: one column per locale; the header names it.
  const one = fileOf([dev("ios", "shots/ios/de/home.png", "de", "home")], { ...cov(["de"], ["home"], 1), layout: "{device}/{locale}/{screen}", expected_devices: ["ios"] });
  const m1 = report.matrix(one);
  assert.deepEqual(m1.devices, [{ device: "ios", platform: "ios" }]);
  assert.equal(m1.coverageLine, "received 1 of 1 expected cells (1 screens x 1 locales), 0 missing, 0 duplicate");
  assert.equal(m1.coverageByDevice, null);
  // Two devices plus one outside --expect-devices; a failing Android twin keeps its own severity.
  const fail = { kind: "present", text: "Go", verdict: "fail", box: null, line: null, confidence: null, severity: "critical", certainty: "high", precision: null, gate: true };
  const e = [
    dev("web-x", "shots/web-x/de/home.png", "de", "home"),
    dev("ios", "shots/ios/de/home.png", "de", "home"),
    dev("android", "shots/android/de/home.png", "de", "home", "fail", { checks: [fail] }),
    { ...missing("de", "pay"), device: "ios", platform: "ios", findings: [{ kind: "missing", box: null, expected_path: "ios/de/pay" }] },
    dev("android", "shots/android/de/pay.png", "de", "pay"),
  ];
  const c = { ...cov(["de"], ["home", "pay"], 3, [{ device: "ios", locale: "de", screen: "pay" }]), layout: "{device}/{locale}/{screen}", expected_devices: ["android", "ios"] };
  const m = report.matrix(fileOf(e, c));
  assert.deepEqual(m.devices.map((d) => d.device), ["android", "ios", "web-x"]);
  const cell = (d, s) => m.cells.find((x) => x.device === d && x.screen === s);
  assert.equal(cell("android", "home").state, "fail");
  assert.equal(cell("android", "home").severity, "critical");
  assert.equal(cell("ios", "home").state, "pass");
  assert.equal(cell("ios", "home").severity, undefined);
  assert.equal(cell("ios", "pay").state, "missing");
  assert.deepEqual(cell("web-x", "home").badges, ["unexpected"]);
  assert.deepEqual(m.missing, [{ device: "ios", text_size: null, locale: "de", screen: "pay", expected_path: "ios/de/pay" }]);
  assert.equal(m.coverageLine, "received 3 of 4 expected cells (2 screens x 1 locales x 2 devices), 1 missing, 0 duplicate");
  assert.equal(m.coverageByDevice.ios, "received 1 of 2 expected cells (2 screens x 1 locales), 1 missing, 0 duplicate");
  assert.equal(m.coverageByDevice.android, "received 2 of 2 expected cells (2 screens x 1 locales), 0 missing, 0 duplicate");
});

test("devices (TODO-075 D13): a no-match report names the {device}/ layout the run's warnings suggested", () => {
  const w = { code: "layout-mismatch", message: "m", hint: "--layout '{device}/{locale}/{screen}'" };
  const m = report.matrix(fileOf([env("shots/ios/de/home.png", "en", null, "pass", { warnings: [w] })], cov(["de"], ["home"], 0, [])));
  assert.equal(m.shown, false);
  assert.equal(m.hint, "no input matched --layout '{locale}/{screen}' - try: --layout '{device}/{locale}/{screen}'");
});

test("known (TODO-055): report --known turns an approved finding known (item count, overlay verdict after notes); a stored known stays without the flag; a missing file fails closed", () => {
  // Value: protects=TODO-055 D10/D28 on catscan report and the page's known badge, filter count and order; fails_when=report ignores --known, drops stored known flags, items lose their known count, or a known entry sorts or badges as fail/note; why_new=known.test.js covers merge and text only; seam=none; no_claim=the browser-rendered Known filter button (report-browser spec); no images (missing-image warnings)
  const scale = require("../src/scale");
  const trunc = (line) => ({ kind: "truncated", box: [0.1, 0.5, 0.5, 0.1], line, reason: "ellipsis", element: null, expected: null, confidence: 1 });
  const dir = tmpdir();
  const e = scale.annotate(env("shots/de/home.png", "de", "home", "fail", { command: "truncated", device: null, platform: null, findings: [trunc("Weiter...")] }));
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(fileOf([e], null, ["truncated", "shots"])));
  assert.equal(cli(["results", "known", "a.json", "--out", "k.json"], dir).status, 0);
  const plain = cli(["report", "a.json", "--out", "plain.html", "-q"], dir);
  assert.equal(plain.status, 1, "without --known the finding still fails");
  assert.equal(dataOf(fs.readFileSync(path.join(dir, "plain.html"), "utf8")).items[0].known, 0);
  const r = cli(["report", "a.json", "--known", "k.json", "--out", "r.html", "-q"], dir);
  assert.equal(r.status, 0, r.stderr);
  const d = dataOf(fs.readFileSync(path.join(dir, "r.html"), "utf8"));
  assert.deepEqual([d.items[0].known, d.items[0].verdict], [1, "pass"]);
  assert.deepEqual(overlay.shapes(d.results[0]).map((s) => s.verdict), ["known"]);
  // A file written with --known keeps its flags in a later report without the flag (D28).
  assert.equal(cli(["results", "merge", "a.json", "--known", "k.json", "--out", "m.json"], dir).status, 0);
  const again = cli(["report", "m.json", "--out", "m.html", "-q"], dir);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(dataOf(fs.readFileSync(path.join(dir, "m.html"), "utf8")).items[0].known, 1);
  const miss = cli(["report", "a.json", "--known", "nope.json", "--out", "n.html", "-q"], dir);
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /known-missing: nope\.json does not exist, so every finding is new/);
  // Overlay order: failing, then below threshold (note), then known.
  const k = { ...trunc("Alt..."), severity: "major", certainty: "medium", gate: false, known: true };
  const n = { ...trunc("Leise..."), severity: "minor", certainty: "low", gate: false };
  const f = { ...trunc("Neu..."), severity: "minor", certainty: "low", gate: true, known: false };
  assert.deepEqual(overlay.shapes(env("x.png", "de", null, "fail", { command: "truncated", findings: [k, n, f] })).map((s) => s.verdict), ["fail", "note", "known"]);
});
