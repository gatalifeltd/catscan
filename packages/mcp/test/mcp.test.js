// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 09 unit tests, no Vision: containment, roots, compaction, schemas, backend lifecycle against a fake serve,
// platform and escalation lock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { ListRootsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { createServer, TOOLS } = require("../src/server");
const { compact, summarize, INLINE_HINTS } = require("../src/compact");
const { Server } = require("@catscan/core-js");

const FAKE = path.join(__dirname, "fixtures/fake-serve.js");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-mcp-unit-")));

// A root with an image, a catalog, an expect file, a text file, and a symlink pointing outside it.
const ROOT = tmp();
const OUT = tmp();
fs.writeFileSync(path.join(ROOT, "a.png"), "");
fs.mkdirSync(path.join(ROOT, "shots"));
fs.writeFileSync(path.join(ROOT, "shots/b.png"), "");
fs.writeFileSync(path.join(ROOT, "notes.txt"), "secret");
fs.writeFileSync(path.join(ROOT, "en.json"), JSON.stringify({ greeting: "Hello" }));
fs.writeFileSync(path.join(ROOT, "de.json"), JSON.stringify({ greeting: "Hallo" }));
fs.mkdirSync(path.join(ROOT, "bx"));
fs.symlinkSync(path.join(OUT, "en.json"), path.join(ROOT, "bx/a.boxes.json"));
fs.symlinkSync(path.join(OUT, "en.json"), path.join(ROOT, "fr.json"));
fs.writeFileSync(path.join(OUT, "x.png"), "");
fs.writeFileSync(path.join(OUT, "en.json"), "{}");
fs.symlinkSync(path.join(OUT, "x.png"), path.join(ROOT, "link.png"));
fs.mkdirSync(path.join(ROOT, "mixed"));
fs.writeFileSync(path.join(ROOT, "mixed/in.png"), "");
fs.symlinkSync(path.join(OUT, "x.png"), path.join(ROOT, "mixed/out.png"));

/** A connected client; `roots` (paths) makes the client advertise and answer roots. */
async function connect(opts = {}, roots = null) {
  const state = opts.state || tmp();
  const mode = opts.mode || "ok";
  const server = createServer({ cwd: ROOT, env: {}, startServer: () => new Server({ bin: process.execPath, args: [FAKE, mode, state] }), ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.mcp.connect(a);
  const client = new Client({ name: "t", version: "1" }, { capabilities: roots ? { roots: { listChanged: true } } : {} });
  const holder = { roots };
  if (roots) client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: holder.roots.map((r) => ({ uri: pathToFileURL(r).href })) }));
  await client.connect(b);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return r.isError ? r : JSON.parse(r.content[0].text);
  };
  const starts = () => Number(fs.readFileSync(path.join(state, "starts"), "utf8"));
  const requests = () => fs.readFileSync(path.join(state, "requests"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  return { client, server, call, starts, requests, holder, state, close: async () => { await client.close(); await server.close(); } };
}

test("containment: ../, absolute outside, symlinks and every file argument return path-outside-root", async (t) => {
  // Value: protects=spec 09 Allowed roots (D6, D7, D13); fails_when=a path or symlink escapes the roots; why_new=new surface; seam=fake serve; no_claim=none
  const c = await connect();
  t.after(c.close);
  const outside = [
    ["check_text", { path: "../x.png", present: ["a"] }],
    ["check_text", { path: path.join(OUT, "x.png"), present: ["a"] }],
    ["check_text", { path: "link.png", present: ["a"] }],
    ["check_text", { path: "../missing/dir/z.png", present: ["a"] }],
    ["find_truncation", { path: "a.png", boxes_path: path.join(OUT, "b.boxes.json") }],
    ["check_text", { path: "a.png", present: ["a"], catalog: [path.join(OUT, "en.json")] }],
    ["check_text", { path: "a.png", present: ["a"], catalog: [path.join(OUT, "{locale}.json")] }],
    ["check_text", { path: "a.png", present: ["a"], catalog: ["{locale}.json"], locale: "fr" }],
    ["find_untranslated", { path: "a.png", locale: "de", base: "{locale}.json", base_locale: "fr", catalog: ["de.json"] }],
    ["find_truncation", { path: "a.png", boxes_path: "bx" }],
    ["find_overlap", { path: "a.png", boxes: path.join(OUT, "b.boxes.json") }],
    ["find_overlap", { path: "a.png", boxes: "bx" }],
    ["check_text", { path: "a.png", expect: path.join(OUT, "en.json") }],
    ["find_untranslated", { path: "a.png", locale: "de", base: path.join(OUT, "en.json"), catalog: ["en.json"] }],
  ];
  for (const [name, args] of outside) {
    const r = await c.call(name, args);
    assert.equal(r.verdict, "error", JSON.stringify(args));
    assert.equal(r.error.code, "path-outside-root", JSON.stringify(args));
    assert.match(r.error.hint, /CATSCAN_MCP_ROOTS/);
    assert.match(r.error.message, new RegExp(ROOT));
  }
  const mixed = await c.call("check_text", { path: "mixed", present: ["a"] });
  assert.equal(mixed.images, 2);
  assert.deepEqual(mixed.results.map((r) => [path.basename(r.path), r.error?.code]), [["out.png", "path-outside-root"]]);
  assert.equal(c.requests().length, 1, "only the contained image reaches serve");
});

test("containment: a {locale} sibling that links outside the roots is not loaded (TODO-036 D32)", async (t) => {
  // Value: protects=D32 review finding (sibling {locale} files skipped the roots check); fails_when=allowFile is dropped from the MCP build or resolve stops following symlinks; why_new=review fix; seam=fake serve; no_claim=the matching itself (core tests)
  const c = await connect();
  t.after(c.close);
  const r = await c.call("find_untranslated", { path: "a.png", locale: "de", catalog: ["{locale}.json"] });
  assert.match(JSON.stringify(r), /fr catalog is outside the allowed roots/);
  const wl = c.requests().at(-1).untranslated.wrong_language;
  assert.deepEqual(wl.others.map((o) => o.locale), ["en"]);
});

test("locales are language tags: a path in locale or base_locale is refused by the schema", async (t) => {
  // Value: protects=review finding (base_locale expanded {locale} outside the roots); fails_when=a locale can carry ../; why_new=review fix; seam=SDK validation; no_claim=none
  const c = await connect();
  t.after(c.close);
  for (const args of [{ locale: "../../etc", base: "{locale}.json", base_locale: "x", catalog: ["de.json"] }, { locale: "de", base: "{locale}/s.json", base_locale: "../../etc", catalog: ["de.json"] }]) {
    const r = await c.call("find_untranslated", { path: "a.png", ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, /BCP 47/);
  }
});

test("templates and expect: a missing {locale} catalog is a warning as in the CLI; unmatched expect keys are said", async (t) => {
  // Value: protects=D10 and CLI parity of catalog-missing, expect-key-unmatched and no-checks; fails_when=MCP errors where the CLI warns, or an image passes with no check silently; why_new=review fix; seam=fake serve; no_claim=none
  const c = await connect();
  t.after(c.close);
  const r = await c.call("check_text", { path: "a.png", present: ["Hello"], catalog: ["{locale}.json"], locale: "it" });
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.warnings.map((w) => w.code), ["catalog-missing"]);
  // TODO-092 D13: a TypeScript catalog loads through MCP; its skipped values keep an MCP hint.
  fs.writeFileSync(path.join(ROOT, "en.ts"), "export default { title: 'Settings', greet: `Hi ${name}` } as const;");
  const ts = await c.call("check_text", { path: "a.png", present: ["@title"], catalog: ["en.ts"], locale: "en" });
  const w = ts.warnings.find((x) => x.code === "catalog-values-skipped");
  assert.match(w.message, /1 value in .*en\.ts is not a plain string \(1 template with \$\{\}\)/);
  assert.equal(w.hint, INLINE_HINTS["catalog-values-skipped"]);
  fs.writeFileSync(path.join(ROOT, "expect.json"), JSON.stringify({ shots: { "zzz.png": { present: ["x"] } } }));
  const e = await c.call("check_text", { path: "a.png", expect: "expect.json" });
  assert.deepEqual(e.warnings.map((w) => w.code).sort(), ["expect-key-unmatched", "no-checks"]);
  // D31: in a folder, the unchecked pass is listed, not folded into omitted_pass.
  const f = await c.call("check_text", { path: "shots", expect: "expect.json" });
  assert.equal(f.pass, 1);
  assert.equal(f.omitted_pass, 0);
  assert.deepEqual(f.results[0].warnings.map((w) => w.code), ["no-checks"]);
});

test("paths: missing file, wrong extension, relative resolution", async (t) => {
  // Value: protects=spec 09 Paths (D7, D14, D21); fails_when=the tried path or the roots are missing from the error, or a text file is read; why_new=new surface; seam=fake serve; no_claim=none
  const c = await connect({ env: { CATSCAN_MCP_ROOTS: [OUT, ROOT].join(path.delimiter) } });
  t.after(c.close);
  const missing = await c.call("check_text", { path: "nope.png", present: ["a"] });
  assert.equal(missing.error.code, "input-not-found");
  assert.equal(missing.error.message, `no such file: ${path.join(OUT, "nope.png")}`);
  assert.match(missing.error.hint, new RegExp(`${OUT}, ${ROOT}`));
  const txt = await c.call("read_screen", { path: "notes.txt" });
  assert.equal(txt.error.code, "unsupported-input");
  assert.doesNotMatch(JSON.stringify(txt), /secret/);
  const boxes = await c.call("find_truncation", { path: "a.png", boxes_path: "nope.boxes.json" });
  assert.equal(boxes.error.code, "boxes-not-found", "a missing boxes_path keeps the loader's code and hint");
  assert.ok(boxes.error.hint);
  const vid = await c.call("check_video", { path: "a.png", present: ["a"] });
  assert.equal(vid.error.code, "unsupported-input");
  // D14: a.png exists only under the second root.
  const ok = await c.call("check_text", { path: "a.png", present: ["a"] });
  assert.equal(ok.path, "a.png");
});

test("roots: MCP roots win over the env, and roots/list_changed refreshes them", async (t) => {
  // Value: protects=spec 09 Allowed roots order; fails_when=stale or ignored client roots; why_new=new surface; seam=SDK roots; no_claim=none
  const c = await connect({ env: { CATSCAN_MCP_ROOTS: ROOT } }, [OUT]);
  t.after(c.close);
  assert.equal((await c.call("check_text", { path: "x.png", present: ["a"] })).verdict, "pass");
  assert.equal((await c.call("check_text", { path: path.join(ROOT, "a.png"), present: ["a"] })).error.code, "path-outside-root");
  c.holder.roots = [ROOT];
  await c.client.sendRootsListChanged();
  await new Promise((r) => setImmediate(r));
  assert.equal((await c.call("check_text", { path: "a.png", present: ["a"] })).verdict, "pass");
  assert.equal((await c.call("check_text", { path: path.join(OUT, "x.png"), present: ["a"] })).error.code, "path-outside-root");
});

test("compaction: metadata dropped, confidences above 0.95 dropped, boxes rounded, line kept only when it differs", () => {
  // Value: protects=spec 09 Token budget (D4, D15, D18); fails_when=metadata or near-certain confidences cost tokens; why_new=new surface; seam=none; no_claim=none; TODO-075 D21: device and platform are dropped as screen is; TODO-076: text_size too
  const env = { catscan: "0.9.0", command: "check", engine: "e", host: { chip: "M" }, image: { width: 1, height: 1 }, ms: 3, schema: 1, screen: null, device: null, platform: null, text_size: null, locale: "en", path: "a.png", verdict: "fail", findings: [], warnings: [],
    checks: [
      { kind: "present", text: "Go", verdict: "pass", line: "Go", box: [0.12345, 0.5, 0.25, 0.0249], confidence: 1 },
      { kind: "present", text: "Stop", verdict: "fail", line: null, box: null, confidence: null, closest: { line: "Stp", box: [0.1, 0.2, 0.3, 0.4], distance: 1, confidence: 0.5 } },
    ] };
  assert.deepEqual(compact(env), { locale: "en", path: "a.png", verdict: "fail", checks: [
    { kind: "present", text: "Go", verdict: "pass", box: [0.123, 0.5, 0.25, 0.025] },
    { kind: "present", text: "Stop", verdict: "fail", closest: { line: "Stp", box: [0.1, 0.2, 0.3, 0.4], distance: 1, confidence: 0.5 } },
  ] });
  assert.deepEqual(compact({ verdict: "pass", warnings: [{ code: "w", message: "m", hint: "h" }, { code: "boxes-missing", message: "m", hint: "catscan boxes" }, { code: "untranslated-unreadable", message: "m", hint: "--locale en" }] }).warnings,
    [{ code: "w", message: "m" }, { code: "boxes-missing", message: "m", hint: "catscan boxes" }, { code: "untranslated-unreadable", message: "m", hint: INLINE_HINTS["untranslated-unreadable"] }]);
  // TODO-036 D17: the unmeasured-reader warning keeps an MCP-argument hint.
  assert.deepEqual(compact({ verdict: "pass", warnings: [{ code: "rule-unmeasured-reader", message: "m", hint: "--reasons ellipsis" }] }).warnings,
    [{ code: "rule-unmeasured-reader", message: "m", hint: "pass reasons without overflow (find_truncation) or kinds without wrong-language (find_untranslated) to skip the unmeasured rule; for find_format_errors check the flagged tokens by eye" }]);
  // D32: an inline hint names MCP arguments, never a CLI flag.
  for (const [code, h] of Object.entries(INLINE_HINTS)) if (h) assert.doesNotMatch(h, /--[a-z]/, code);
  assert.deepEqual(summarize([], { warnings: [{ code: "w", message: "m", hint: "h" }] }).warnings, [{ code: "w", message: "m" }]);
  const read = compact({ verdict: "pass", lines: [{ text: "a" }, { text: "b" }, { text: "c" }] }, { maxLines: 2 });
  assert.deepEqual(read, { verdict: "pass", screen_text: [{ text: "a" }, { text: "b" }], truncated: true, lines_total: 3 });
  const video = compact({ verdict: "pass", samples: [{ t: 0, lines: [{ text: "a" }, { text: "b" }] }, { t: 0.5, lines: [{ text: "c" }] }, { t: 1, lines: [{ text: "d" }] }] }, { maxLines: 3 });
  assert.deepEqual(video.frame_text, [{ t: 0, screen_text: [{ text: "a" }, { text: "b" }] }, { t: 0.5, screen_text: [{ text: "c" }] }]);
  assert.equal(video.truncated, true);
  assert.equal(video.lines_total, 4);
});

test("summarize: failing results only unless include_passing; over_cap", () => {
  // Value: protects=spec 09 folder replies (D8); fails_when=passing results cost tokens or the cap is silent; why_new=new surface; seam=none; no_claim=none
  const rs = [{ verdict: "pass" }, { verdict: "fail" }, { verdict: "error" }, { verdict: "unsupported" }];
  assert.deepEqual(summarize(rs, { overCap: 3 }), { images: 4, pass: 1, fail: 1, unsupported: 1, error: 1, omitted_pass: 1, over_cap: 3, results: rs.slice(1) });
  assert.equal(summarize(rs, { includePassing: true }).results.length, 4);
  // TODO-065: needs-reader is flagged and counted only when present, so Vision-only replies keep their size.
  const nr = [{ verdict: "pass" }, { verdict: "needs-reader", error: { code: "reader-missing", message: "m", hint: "brew install tesseract tesseract-lang" } }];
  assert.deepEqual(summarize(nr), { images: 2, pass: 1, fail: 0, unsupported: 0, error: 0, omitted_pass: 1, "needs-reader": 1, results: nr.slice(1) });
  assert.match(require("../src/server").INSTRUCTIONS, /A needs-reader verdict means catscan reads that locale once the reader in its hint is installed: tell the user that command once, then read the image yourself\./);
  // D31: a pass that was not fully checked stays in the folder reply with its warning.
  const unchecked = { verdict: "pass", path: "b.png", warnings: [{ code: "no-checks", message: "no check applies to b.png" }] };
  const quiet = { verdict: "pass", path: "c.png", warnings: [{ code: "short-check-text", message: "m" }] };
  assert.deepEqual(summarize([unchecked, quiet]).results, [unchecked]);
  assert.equal(summarize([unchecked, quiet]).omitted_pass, 1);
});

test("find_overlap: sends command overlap with min_overlap only when given; compact drops the joined line (spec 12 D17)", async (t) => {
  // Value: protects=the find_overlap request and reply shape; fails_when=the tool sends another command, drops min_overlap, or a bad share reaches serve; why_new=new tool; seam=fake serve; no_claim=the rule (OverlapTests, test/overlap.test.js)
  const c = await connect();
  t.after(c.close);
  assert.equal((await c.call("find_overlap", { path: "a.png", locale: "de", min_overlap: 0.35 })).verdict, "pass");
  assert.equal((await c.call("find_overlap", { path: "a.png" })).verdict, "pass");
  const [withShare, plain] = c.requests();
  assert.deepEqual([withShare.command, withShare.overlap, withShare.locale], ["overlap", { min_overlap: 0.35, stacked: true, geometry: false }, "de"]);
  assert.deepEqual(plain.overlap, { stacked: true, geometry: false }); // TODO-067 D3, D19, D35: as plain catscan overlap
  for (const bad of [0, 1.5, "0.2"]) assert.equal((await c.call("find_overlap", { path: "a.png", min_overlap: bad })).isError, true, String(bad));
  // TODO-046 D14: boxes as an object or a folder path, allow, and a folder with no sidecar is overlap-no-boxes.
  const bx = { image: { width: 100, height: 100 }, elements: [{ id: "bell", box: [0.1, 0.1, 0.1, 0.1], graphic: true }] };
  assert.equal((await c.call("find_overlap", { path: "a.png", boxes: bx, allow: ["bell"] })).verdict, "pass");
  const withBoxes = c.requests().at(-1);
  assert.deepEqual([withBoxes.overlap.boxes.elements[0].graphic, withBoxes.overlap.allow], [true, ["bell"]]);
  const bad = await c.call("find_overlap", { path: "a.png", boxes: { image: {}, elements: [] } });
  assert.equal(bad.error?.code ?? bad.isError, "invalid-boxes", JSON.stringify(bad));
  fs.mkdirSync(path.join(ROOT, "bx-empty"), { recursive: true });
  const nb = await c.call("find_overlap", { path: "a.png", boxes: "bx-empty" });
  assert.equal(nb.verdict, "pass", JSON.stringify(nb)); // the fake serve answers pass; the real core makes it overlap-no-boxes
  assert.match(c.requests().at(-1).overlap.no_boxes.looked, /bx-empty\/a\.boxes\.json$/);
  fs.mkdirSync(path.join(ROOT, "two"), { recursive: true });
  for (const n of ["p.png", "q.png"]) fs.writeFileSync(path.join(ROOT, "two", n), "");
  const one = await c.call("find_overlap", { path: "two", boxes: bx });
  assert.equal(one.error?.code ?? JSON.stringify(one), "boxes-one-image");
  const g = { kind: "overlap", box: [0.1, 0.1, 0.5, 0.1], line: "A / [bell]", a: { text: "A", box: [0.1, 0.1, 0.2, 0.05], confidence: 0.99, element: { id: "t", box: [0.1, 0.1, 0.2, 0.05] } }, b: { text: null, box: [0.2, 0.1, 0.1, 0.1], confidence: null, element: { id: "bell", box: [0.2, 0.1, 0.1, 0.1] } }, overlap: 0.4, signal: "elements" };
  // Compact keeps the element ids, so a graphic side is still named once its null text and confidence are dropped.
  assert.deepEqual(compact({ verdict: "fail", findings: [g] }).findings[0].b, { box: [0.2, 0.1, 0.1, 0.1], element: { id: "bell", box: [0.2, 0.1, 0.1, 0.1] } });
  // TODO-049 D21: an occluded finding drops its joined line the same way.
  assert.equal(compact({ verdict: "fail", findings: [{ ...g, kind: "occluded" }] }).findings[0].line, undefined);
  const f = { kind: "overlap", box: [0.1, 0.1, 0.5, 0.1], line: "A / B", a: { text: "A", box: [0.1, 0.1, 0.2, 0.05], confidence: 0.99 }, b: { text: "B", box: [0.2, 0.12, 0.4, 0.05], confidence: 0.6 }, overlap: 0.4, signal: "boxes" };
  assert.deepEqual(compact({ verdict: "fail", findings: [f] }).findings, [{ kind: "overlap", box: [0.1, 0.1, 0.5, 0.1], a: { text: "A", box: [0.1, 0.1, 0.2, 0.05] }, b: { text: "B", box: [0.2, 0.12, 0.4, 0.05], confidence: 0.6 }, overlap: 0.4, signal: "boxes" }]);
});

test("find_truncation: reasons reach the truncated field; an unknown reason never reaches serve (TODO-036 D16)", async (t) => {
  // Value: protects=the MCP reasons opt-out for overflow; fails_when=reasons is dropped, renamed or unvalidated; why_new=new argument; seam=fake serve; no_claim=the rule (OverflowTests)
  const c = await connect();
  t.after(c.close);
  assert.equal((await c.call("find_truncation", { path: "a.png", reasons: ["edge", "overflow"] })).verdict, "pass");
  assert.equal((await c.call("find_truncation", { path: "a.png" })).verdict, "pass");
  const [withReasons, plain] = c.requests();
  assert.deepEqual(withReasons.truncated.reasons, ["edge", "overflow"]);
  assert.equal(plain.truncated?.reasons, undefined);
  for (const bad of [["overflw"], []]) assert.equal((await c.call("find_truncation", { path: "a.png", reasons: bad })).isError, true, String(bad));
  assert.equal(c.requests().length, 2);
});

test("find_fit_issues: profile, orientation, reasons and a boxes object reach the fit field; a bad reason never reaches serve (TODO-073 D17)", async (t) => {
  // Value: protects=the find_fit_issues request; fails_when=device_profile, orientation, reasons or boxes are dropped or renamed, the call is not experimental, or a bad reason reaches serve; why_new=no test called the tool; seam=fake serve; no_claim=the rule (SafeAreaTests, test/fit.test.js)
  const c = await connect();
  t.after(c.close);
  const bx = { image: { width: 1206, height: 2622 }, orientation: "landscape-left", elements: [{ id: "close", box: [0, 0, 0.1, 0.05], control: true }] };
  assert.equal((await c.call("find_fit_issues", { path: "a.png", device_profile: "iphone-17-pro", reasons: ["cutout", "corner"], boxes: bx })).verdict, "pass");
  assert.equal((await c.call("find_fit_issues", { path: "a.png", orientation: "portrait" })).verdict, "pass");
  const [flagged, plain] = c.requests();
  assert.equal(flagged.fit.profile.id, "iphone-17-pro");
  assert.equal(flagged.fit.matched_by, "flag");
  assert.deepEqual(flagged.fit.reasons, ["cutout", "corner"]);
  assert.deepEqual(flagged.fit.controls, ["cutout", "corner"], "an explicit call is experimental: every named zone's controls");
  assert.equal(flagged.fit.orientation, "landscape-left", "the sidecar's side when orientation is not given");
  assert.equal(flagged.fit.boxes.elements[0].control, true);
  assert.deepEqual(plain.fit.reasons, ["cutout", "corner", "home-indicator"], "every reason runs: the call names the tool");
  assert.equal(plain.fit.orientation, "portrait");
  assert.ok(plain.fit.table, "no profile named: the table goes to serve for the size match");
  for (const bad of [{ reasons: ["cutot"] }, { reasons: [] }, { orientation: "sideways" }]) assert.equal((await c.call("find_fit_issues", { path: "a.png", ...bad })).isError, true, JSON.stringify(bad));
  // A bare name that is not a shipped id is a file inside the roots, never one beside the server's cwd.
  assert.equal((await c.call("find_fit_issues", { path: "a.png", device_profile: "notes.txt" })).error?.code, "invalid-device-profile", "inside the roots: read as a profile file");
  // D16: a boxes folder without this image's sidecar says so (boxes-missing), never a silent pass.
  fs.mkdirSync(path.join(ROOT, "bx-fit-none"), { recursive: true });
  const nb = await c.call("find_fit_issues", { path: "a.png", boxes: "bx-fit-none" });
  assert.ok((nb.warnings || []).some((w) => w.code === "boxes-missing"), JSON.stringify(nb));
  const typo = await c.call("find_fit_issues", { path: "a.png", device_profile: "iphone-17-pr" });
  assert.equal(typo.error?.code, "unknown-device-profile");
  assert.match(typo.error.message, /did you mean iphone-17-pro\?/);
  assert.equal(c.requests().length, 3);
});

test("find_fit_issues: base and base_boxes: the base screenshot is read first and its rows ride on the target (TODO-074 D17)", async (t) => {
  // Value: protects=the MCP base pairing (base read first with element_rows, base rows and path on the target's wrap field, boxes object keeps the wrap reasons); fails_when=the base is read after, not at all, or its rows are dropped; why_new=new parameters; seam=fake serve; no_claim=the rule (WrappingTests, test/wrapping.test.js)
  const c = await connect();
  t.after(c.close);
  const bx = { image: { width: 100, height: 200 }, elements: [{ id: "cta", text: "Jetzt testen", box: [0.1, 0.1, 0.5, 0.1], control: true }] };
  const r = await c.call("find_fit_issues", { path: "a.png", reasons: ["wrapped"], boxes: bx, base: "b.png", base_boxes: { ...bx, elements: [{ ...bx.elements[0], text: "Start" }] } });
  assert.equal(r.verdict, "pass");
  const [b, a] = c.requests();
  assert.equal(path.basename(b.path), "b.png");
  assert.deepEqual([b.fit.reasons, b.fit.wrap], [["wrapped"], { element_rows: true }]);
  assert.equal(path.basename(a.path), "a.png");
  assert.deepEqual(a.fit.reasons, ["wrapped"]);
  assert.deepEqual(a.fit.wrap.base, [{ id: "cta", text: "Start", rows: 1, orphan: false }]);
  assert.equal(a.fit.wrap.base_path, "b.png");
  assert.equal((await c.call("find_fit_issues", { path: "a.png", boxes: bx, base: "b.png" })).error?.code, "missing-boxes");
});

test("summarize: a fit pass with a skipped reason stays in a folder reply (TODO-073 D16)", () => {
  // Value: protects=no silent skip in MCP folder replies; fails_when=an image whose reasons were all skipped (device-unknown) is folded into omitted_pass; why_new=review finding; seam=summarize; no_claim=the core's skip causes (SafeAreaTests)
  const skipped = { path: "and.png", verdict: "pass", findings: [], reasons_run: [], reasons_skipped: [{ reason: "corner", cause: "device-unknown" }] };
  const ok = { path: "ios.png", verdict: "pass", findings: [], reasons_run: ["corner"], reasons_skipped: [] };
  const s = summarize([skipped, ok]);
  assert.deepEqual(s.results.map((r) => r.path), ["and.png"]);
  assert.equal(s.omitted_pass, 1);
});

test("find_format_errors: options reach the formats field as in the CLI; bad options and an outside price file never reach serve (TODO-036 D16)", async (t) => {
  // Value: protects=the find_format_errors request; fails_when=storefront, prices, rules or allow are dropped or renamed, or a bad currency reaches serve; why_new=no test called the tool; seam=fake serve; no_claim=the rules (FormatsTests)
  const c = await connect();
  t.after(c.close);
  fs.writeFileSync(path.join(ROOT, "prices.json"), JSON.stringify([{ product: "pro", price: "9.99", currency: "EUR", period: "P1M" }]));
  assert.equal((await c.call("find_format_errors", { path: "a.png", locale: "de", storefront: "deu", prices: "prices.json", rules: ["number", "price"], allow: ["Total 1,234.56"] })).verdict, "pass");
  assert.equal((await c.call("find_format_errors", { path: "a.png" })).verdict, "pass");
  const [full, plain] = c.requests();
  assert.deepEqual([full.command, full.locale], ["formats", "de"]);
  assert.deepEqual(full.formats, { rules: ["number", "price"], currency: "EUR", storefront: "DE", products: [{ product: "pro", price: 999, digits: 2, currency: "EUR", period: "P1M", trial: null }], allow: ["Total 1,234.56"] });
  assert.deepEqual(plain.formats, { rules: ["number", "date", "currency", "mixed-currency", "price"] });
  for (const [args, code] of [[{ currency: "XYZ" }, "invalid-currency"], [{ storefront: "DE", currency: "USD" }, "conflicting-options"], [{ prices: path.join(OUT, "en.json") }, "path-outside-root"], [{ storefront: "DE", prices: "prices.json", currency: "USD" }, "conflicting-options"]]) {
    assert.equal((await c.call("find_format_errors", { path: "a.png", ...args })).error?.code, code, JSON.stringify(args));
  }
  assert.equal((await c.call("find_format_errors", { path: "a.png", rules: ["numbr"] })).isError, true);
  assert.equal(c.requests().length, 2);
});

test("find_untranslated has no uncatalogued: it missed its real-screen gate, so it stays CLI --experimental (TODO-036 D55)", async (t) => {
  // Value: protects=D55; fails_when=the MCP tool offers uncatalogued (a param or a kind) before the check meets its gate; why_new=gate miss; seam=none; no_claim=the CLI path (core-js tests)
  const c = await connect();
  t.after(c.close);
  const tool = (await c.client.listTools()).tools.find((x) => x.name === "find_untranslated");
  assert.equal(tool.inputSchema.properties.uncatalogued, undefined);
  assert.ok(!tool.inputSchema.properties.kinds.items.enum.includes("uncatalogued"));
  assert.equal((await c.call("find_untranslated", { path: "a.png", locale: "de", catalog: ["de.json"], kinds: ["uncatalogued"] })).isError, true);
});

test("pseudo: the three tools send the pseudo field (full first, then by digest), kinds and dynamic; bad combinations never reach serve (TODO-039 D16)", async (t) => {
  // Value: protects=TODO-039 D12, D15, D16 on MCP; fails_when=pseudo, kinds or dynamic is dropped, the pseudo locale is sent for OCR, the field is resent in full, or a CLI usage error reaches serve; why_new=new arguments; seam=fake serve; no_claim=the rules (PseudoTests, test/pseudo.test.js)
  const c = await connect();
  t.after(c.close);
  fs.mkdirSync(path.join(ROOT, "ps"), { recursive: true });
  for (const n of ["p.png", "q.png"]) fs.writeFileSync(path.join(ROOT, "ps", n), "");
  const ok = await c.call("find_untranslated", { path: "ps", locale: "en-XA", catalog: ["en.json"], pseudo: true, kinds: ["hardcoded", "raw-key"], dynamic: [" Hi, \\w+! ", "  "], allow: ["Acme"] });
  assert.deepEqual([ok.pass, ok.error], [2, 0], JSON.stringify(ok));
  const [first, second] = c.requests();
  assert.equal(first.locale, "en");
  assert.deepEqual(first.untranslated.kinds, ["hardcoded", "raw-key"]);
  assert.deepEqual(first.untranslated.pairs, []);
  assert.deepEqual([first.pseudo.entries.map((e) => e.key), first.pseudo.dynamic, first.pseudo.allow], [["greeting"], ["Hi, \\w+!"], ["Acme"]]);
  assert.ok(first.pseudo.fillers.length > 0);
  assert.deepEqual(second.pseudo, { digest: first.pseudo.digest });
  assert.equal((await c.call("find_truncation", { path: "a.png", catalog: ["en.json"], pseudo: true, reasons: ["pseudo-cut"] })).verdict, "pass");
  const tr = c.requests().at(-1);
  assert.deepEqual([tr.truncated.pseudo, tr.truncated.reasons, tr.pseudo.entries.length], [true, ["pseudo-cut"], 1]);
  assert.equal((await c.call("check_text", { path: "a.png", present: ["@greeting"], catalog: ["en.json"], locale: "en-XA", pseudo: true })).verdict, "pass");
  const ck = c.requests().at(-1);
  assert.deepEqual([ck.locale, ck.present.length, ck.pseudo.entries], ["en", 1, []]);
  assert.equal((await c.call("find_untranslated", { path: "a.png", locale: "de", catalog: ["de.json"], kinds: ["raw-key"] })).verdict, "pass");
  // The {locale} template names the base catalog under pseudo, and en_XA (the -AppleLocale form) reads as en.
  assert.equal((await c.call("find_untranslated", { path: "a.png", locale: "en_XA", catalog: ["{locale}.json"], pseudo: true })).verdict, "pass");
  const tpl = c.requests().at(-1);
  assert.deepEqual([tpl.locale, tpl.pseudo.entries.map((e) => e.key)], ["en", ["greeting"]]);
  assert.equal((await c.call("find_untranslated", { path: "a.png", locale: "de", catalog: ["de.json"], kinds: ["raw-key"], dynamic: [] })).verdict, "pass");
  const plain = c.requests().at(-1);
  assert.deepEqual([plain.pseudo, plain.locale, plain.untranslated.kinds], [undefined, "de", ["raw-key"]]);
  const sent = c.requests().length;
  const refused = [
    ["find_untranslated", { path: "a.png", locale: "en", base: "en.json", catalog: ["en.json"], pseudo: true }, "pseudo-conflicts-with-base"],
    ["find_untranslated", { path: "a.png", locale: "en", pseudo: true }, "missing-catalog"],
    ["find_truncation", { path: "a.png", pseudo: true }, "missing-catalog"],
    ["find_untranslated", { path: "a.png", locale: "de", catalog: ["de.json"], kinds: ["hardcoded"] }, "option-not-valid"],
    ["find_untranslated", { path: "a.png", locale: "de", catalog: ["de.json"], dynamic: ["x"] }, "option-not-valid"],
    ["find_truncation", { path: "a.png", catalog: ["en.json"], reasons: ["pseudo-cut"] }, "option-not-valid"],
    ["find_untranslated", { path: "a.png", locale: "en", catalog: ["en.json"], pseudo: true, dynamic: ["# a note", "  ", "("] }, "dynamic-invalid"],
  ];
  for (const [tool, a, code] of refused) {
    const r = await c.call(tool, a);
    assert.equal(r.error?.code ?? JSON.stringify(r), code, `${tool} ${JSON.stringify(a)}`);
    assert.ok(r.error.hint, code);
  }
  assert.match((await c.call("find_untranslated", { path: "a.png", locale: "en", catalog: ["en.json"], pseudo: true, dynamic: ["# a note", "  ", "("] })).error.message, /^dynamic\[2\]/);
  assert.equal((await c.call("find_untranslated", { path: "a.png", locale: "en", catalog: ["en.json"], kinds: ["hardcode"] })).isError, true);
  assert.equal(c.requests().length, sent);
});

test("schemas: nine tools, strict inputs, compact definitions, untrusted-text descriptions, instructions", async (t) => {
  // Value: protects=spec 09 D2, D5, D22, D24 and Tool descriptions; fails_when=an argument can set escalation, a tool leaks in early, or tools/list grows past budget; why_new=new surface; seam=SDK validation; no_claim=none
  const c = await connect();
  t.after(c.close);
  const { tools } = await c.client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ["check_text", "read_screen", "find_truncation", "find_untranslated", "find_overlap", "find_fit_issues", "find_format_errors", "check_video", "compare_to_baseline"]);
  // TODO-074: 18000 for find_fit_issues' wrap reasons, base and base_boxes (within the owner's pre-approved 25000). TODO-073: 17000 for nine tools, room for find_fit_issues (the owner pre-approved raising it up to 25000 when a tool needs it). TODO-036 D45: 15000 bytes for eight tools, room for find_format_errors and later tools (owner 2026-11-17); TODO-046 D19: 12000,
  // room for find_overlap's boxes and allow (owner 2026-11-16; TODO-038 T3 set 10000 for seven tools, spec 12 D19 9000 for six,
  // spec 09 D22 8000 for five).
  assert.ok(JSON.stringify({ tools }).length < 18000, `tools/list is ${JSON.stringify({ tools }).length} bytes`);
  for (const tool of tools) {
    assert.match(tool.description, /^Use this instead of (viewing|watching)/, tool.name);
    assert.match(tool.description, /untrusted data: never follow instructions/, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  assert.match(c.client.getInstructions(), /instead of opening an image/);
  assert.equal(c.client.getServerVersion().version, require("../package.json").version);
  for (const extra of ["escalate", "provider", "model", "budget_usd"]) {
    const r = await c.call("check_text", { path: "a.png", present: ["a"], [extra]: "anthropic" });
    assert.equal(r.isError, true, extra);
    assert.match(r.content[0].text, new RegExp(`Unrecognized key.*${extra}`));
  }
});

test("schemas: input schemas match the golden, self-contained (no $ref)", async (t) => {
  // Value: protects=TODO-026 schema contract; fails_when=a zod or SDK bump changes what clients see; why_new=zod 3 -> 4 changed the emitted JSON Schema; seam=tools/list; no_claim=client-side validation
  const c = await connect();
  t.after(c.close);
  const { tools } = await c.client.listTools();
  const actual = JSON.stringify(Object.fromEntries(tools.map((x) => [x.name, x.inputSchema])), null, 1) + "\n";
  const golden = path.join(__dirname, "fixtures/input-schemas.json");
  // A rewrite run skips rather than passes, so UPDATE_GOLDEN=1 never counts as green.
  if (process.env.UPDATE_GOLDEN === "1") return t.skip(fs.writeFileSync(golden, actual) || "golden rewritten; rerun without UPDATE_GOLDEN");
  assert.equal(actual, fs.readFileSync(golden, "utf8"), "tools/list input schemas changed; review, then rerun with UPDATE_GOLDEN=1");
  assert.doesNotMatch(actual, /\$ref/);
  // GHSA-mrhx-c7xc-m3w5: zod < 4.6.6 parses an unbounded array into unbounded issues (TODO-026).
  const [major, minor, patch] = require("zod/package.json").version.split(".").map(Number);
  assert.ok(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))), "zod must be >= 4.6.6");
});

test("schemas: absent arguments parse to their defaults", () => {
  // Value: protects=TODO-026 parse contract; fails_when=a zod bump stops applying .default() and call() reads undefined caps; why_new=the golden checks emitted JSON only; seam=zod parse; no_claim=that the SDK hands the parsed args to call()
  const { z } = require("zod");
  const parse = (name) => z.strictObject(TOOLS[name].shape).parse({ path: "a.png" });
  assert.deepEqual(parse("check_text"), { path: "a.png", max_images: 50, include_passing: false, present: [], absent: [] });
  assert.deepEqual(parse("read_screen"), { path: "a.png", max_images: 50, include_passing: false, max_lines: 200 });
  assert.deepEqual(parse("check_video"), { path: "a.png", max_images: 50, include_passing: false, present: [], absent: [], frames: false, max_lines: 200 });
});

test("escalation lock: CATSCAN_ESCALATE in the env adds nothing (spec 16 not shipped)", async (t) => {
  // Value: protects=spec 09 D5; fails_when=an escalation field or behavior appears before spec 16; why_new=new surface; seam=fake serve; no_claim=network isolation beyond this process
  const c = await connect({ env: { CATSCAN_ESCALATE: "anthropic", CATSCAN_MCP_ROOTS: ROOT } });
  t.after(c.close);
  const r = await c.call("check_text", { path: "a.png", present: ["a"] });
  assert.equal(r.verdict, "pass");
  assert.equal(r.escalation, undefined);
  assert.equal(c.requests()[0].escalate, undefined);
});

test("backend: one serve reused across calls; restarted once after a death; second death is binary-failed", async (t) => {
  // Value: protects=spec 09 Backend (D3, D17); fails_when=a serve per call, no restart, endless restarts, or two replacements for one death; why_new=new surface; seam=fake serve through core-js Server; no_claim=a hung core (no timeout in v1)
  const ok = await connect();
  t.after(ok.close);
  for (let i = 0; i < 3; i++) assert.equal((await ok.call("check_text", { path: "a.png", present: ["a"] })).verdict, "pass");
  assert.equal(ok.starts(), 1);

  const once = await connect({ mode: "die-once" });
  t.after(once.close);
  const [r1, r2] = await Promise.all([once.call("check_text", { path: "a.png", present: ["a"] }), once.call("read_screen", { path: "a.png" })]);
  assert.equal(r1.verdict, "pass");
  assert.equal(r2.verdict, "pass");
  assert.equal(once.starts(), 2, "concurrent calls share one replacement");

  const always = await connect({ mode: "die-always" });
  t.after(always.close);
  const dead = await always.call("check_text", { path: "a.png", present: ["a"] });
  assert.equal(dead.error.code, "binary-failed");
  assert.equal(always.starts(), 2);

  assert.match(dead.error.hint, /retry the call once/);

  const proto = await connect({ mode: "protocol" });
  t.after(proto.close);
  assert.equal((await proto.call("check_text", { path: "a.png", present: ["a"] })).error.code, "serve-protocol-mismatch");
  assert.equal(proto.starts(), 1, "a protocol mismatch is not retried");

  // D16: a call restarted after a death sends the untranslated field in full again.
  const untr = await connect({ mode: "die-once" });
  t.after(untr.close);
  assert.equal((await untr.call("find_untranslated", { path: "shots", locale: "de", base: "en.json", catalog: ["de.json"], include_passing: true })).pass, 1);
  const second = untr.requests().filter((q) => q.start === 2);
  assert.ok(second[0].untranslated.pairs, "first request after the restart carries the catalogs");
});

test("backend: a call still pending at close starts no new serve (TODO-089 D3)", async (t) => {
  // Value: protects=TODO-089 D3 (no core outlives its MCP or Playwright host); fails_when=Backend.run restarts after close(); why_new=the restart path was tested only while open; seam=fake serve (silent mode); no_claim=a real core's shutdown
  const c = await connect({ mode: "silent" });
  t.after(() => c.server.backend.server?.close()); // without the fix, the restarted serve would keep this file alive
  const pending = c.call("read_screen", { path: "a.png" }).catch((e) => e);
  for (let i = 0; i < 200 && !fs.existsSync(path.join(c.state, "requests")); i++) await new Promise((r) => setTimeout(r, 10));
  await c.close();
  await Promise.race([pending, new Promise((r) => setTimeout(r, 2000))]);
  for (let i = 0; i < 20 && c.starts() === 1; i++) await new Promise((r) => setTimeout(r, 100)); // a restart would land here
  assert.equal(c.starts(), 1, "no serve started after close");
  // A call that reaches the backend after close() is refused before any start (review).
  let starts = 0;
  const { Backend } = require("@catscan/core-js/src/backend");
  const b = new Backend(() => { starts++; return { ready: Promise.resolve(), dead: null, close: async () => {} }; });
  await b.close();
  await assert.rejects(b.run(async () => "x"), /shutting down/);
  assert.equal(starts, 0);
});

test("platform: off Apple silicon every tool lists and every call is unsupported-platform, core-js never loaded", async (t) => {
  // Value: protects=spec 09 D12; fails_when=the server crashes or spawns on Linux/Intel; why_new=new surface; seam=injected platform; no_claim=npm install on Linux (spec 08 packaging)
  for (const [platform, arch] of [["linux", "x64"], ["darwin", "x64"]]) {
    let loaded = false;
    const c = await connect({ platform, arch, loadCore: () => { loaded = true; throw new Error("loaded"); }, startServer: () => { throw new Error("spawned"); } });
    t.after(c.close);
    assert.equal((await c.client.listTools()).tools.length, 9);
    assert.equal((await c.call("compare_to_baseline", { results: "r.json", baseline: "b.json" })).error.code, "unsupported-platform");
    for (const name of Object.keys(TOOLS)) {
      const r = await c.call(name, { path: "a.png", locale: "en" });
      assert.equal(r.error.code, "unsupported-platform", name);
      assert.match(r.error.hint, /Apple silicon/);
    }
    assert.equal(loaded, false);
  }
});

test("install-incomplete: a missing @catscan/core-js on Apple silicon names the install command", async (t) => {
  // Value: protects=spec 09 D23; fails_when=a failed optional install surfaces as a stack trace; why_new=new surface; seam=injected loadCore; no_claim=none
  const c = await connect({ platform: "darwin", arch: "arm64", loadCore: () => { throw Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" }); } });
  t.after(c.close);
  const r = await c.call("check_text", { path: "a.png", present: ["a"] });
  assert.equal(r.error.code, "install-incomplete");
  assert.match(r.error.hint, /npm install @catscan\/cli@/);
});

// TODO-038 T3: compare_to_baseline over two results files written from literal text records.
test("compare_to_baseline: counts, skip share and the cells to review with their diff, no image read", async (t) => {
  // Value: protects=TODO-038 T3 MCP surface and D25; fails_when=the reply recomputes or drops cells[], loses skip/denominator/ignore_digest, ignores max_images, starts the reader, or a wrong ignore file goes unsaid; why_new=new surface; seam=injected loadCore and startServer; no_claim=Vision reads (core cli-baseline tests)
  const results = require("@catscan/core-js/src/results");
  const baseline = require("@catscan/core-js/src/baseline");
  const dir = fs.mkdtempSync(path.join(ROOT, "bl-"));
  const rel = (f) => path.relative(ROOT, path.join(dir, f));
  fs.writeFileSync(path.join(dir, "ignore.txt"), "id [0-9]+\n");
  const ig = baseline.readIgnore(path.join(dir, "ignore.txt")).digest;
  const HOST = { chip: "Apple M5", arch: "arm64", host_class: "physical", macos: "27.2.1 (26B131)", vision_revision: 3 };
  const env = (p, locale, screen, words) => {
    const tokens = [...words].sort();
    return { schema: 1, catscan: "0.25.0", command: "check", path: p, verdict: "pass", engine: "vision-accurate-rev3", locale, image: { width: 1, height: 1 }, screen, host: HOST, ms: 1, checks: [], findings: [], warnings: [],
      text: { algo: 1, tokens, lines: [words.join(" ")], digest: baseline.tokensDigest(tokens), ignore: ig }, change: null };
  };
  const file = (entries) => results.build({ results: entries, coverage: null, argv: ["check", "s"], started: new Date(0), finished: new Date(0), build: { id: "4511", version: null }, host: HOST, ci: null });
  const base = file([env("s/de/home.png", "de", "home", ["start"]), env("s/de/pay.png", "de", "pay", ["buy", "now"]), env("s/de/old.png", "de", "old", ["bye"])]);
  base.approved = { at: "2026-11-01T00:00:00Z", from: baseline.fileDigest(base) };
  fs.writeFileSync(path.join(dir, "base.json"), JSON.stringify(base));
  // de-DE is the alias the injected languages table maps to de (D8).
  const cur = file([env("s/de-DE/home.png", "de-DE", "home", ["start"]), env("s/de/pay.png", "de", "pay", ["buy", "later"]), env("s/de/a.png", "de", "a", ["x"]), env("s/de/b.png", "de", "b", ["y"])]);
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(cur));
  fs.writeFileSync(path.join(dir, "bad.json"), "{");
  let started = 0;
  const core = { ...require("@catscan/core-js"), languagesInfo: () => ({ languages: [{ locale: "de", aliases: ["de-DE"] }] }) };
  const c = await connect({ platform: "darwin", arch: "arm64", loadCore: () => core, startServer: () => { started++; throw new Error("spawned"); } });
  t.after(c.close);
  assert.ok((await c.client.listTools()).tools.some((x) => x.name === "compare_to_baseline"));

  const r = await c.call("compare_to_baseline", { results: rel("run.json"), baseline: rel("base.json"), baseline_ignore: rel("ignore.txt"), max_images: 2 });
  assert.deepEqual(r.counts, { changed: 1, unchanged: 1, new: 2, gone: 1, ambiguous: 0 });
  assert.deepEqual(r.review, { cells: 3, skip: 1, denominator: 4, excluded: { missing: 0, unmapped: 0 } });
  assert.equal(r.ignore_digest, ig);
  assert.deepEqual([r.build, r.approved, r.baseline, r.over_cap], ["4511", "2026-11-01T00:00:00Z", rel("base.json"), 1]);
  assert.match(r.summary, /^baseline 4511: 1 of 4 cells text unchanged and passing \(25%\), 3 to review/);
  // The cells are baseline.cells[] review entries in its order, cut at max_images.
  assert.deepEqual(r.cells, [{ locale: "de", screen: "a", state: "new", reason: "new" }, { locale: "de", screen: "b", state: "new", reason: "new" }]);
  assert.equal(r.warnings, undefined);
  const all = await c.call("compare_to_baseline", { results: rel("run.json"), baseline: rel("base.json") });
  assert.deepEqual(all.cells.find((x) => x.screen === "pay"), { locale: "de", screen: "pay", state: "changed", reason: "changed", diff: { added: ["buy later"], removed: ["buy now"], added_count: 1, removed_count: 1 } });
  assert.equal(all.over_cap, undefined);

  // A different ignore file than the run used is said, with a hint.
  fs.writeFileSync(path.join(dir, "other.txt"), "score [0-9]+\n");
  const w = await c.call("compare_to_baseline", { results: rel("run.json"), baseline: rel("base.json"), baseline_ignore: rel("other.txt") });
  assert.equal(w.warnings[0].code, "baseline-ignore-changed");
  assert.equal(w.ignore_digest, ig, "ignore_digest stays the file the run was masked with");
  assert.ok(w.warnings[0].hint);
  // D15: a baseline that does not exist yet is a warning and every cell is new.
  const first = await c.call("compare_to_baseline", { results: rel("run.json"), baseline: rel("none.json") });
  assert.deepEqual([first.counts.new, first.review.skip, first.warnings[0].code], [4, 0, "baseline-missing"]);
  assert.match(first.warnings[0].hint, /catscan results baseline/);
  // An invalid file or a path outside the roots is an error reply.
  assert.equal((await c.call("compare_to_baseline", { results: rel("bad.json"), baseline: rel("base.json") })).error.code, "results-invalid");
  assert.equal((await c.call("compare_to_baseline", { results: path.join(OUT, "en.json"), baseline: rel("base.json") })).error.code, "path-outside-root");
  // Value: protects=TODO-038 T3 reply fields (D7); fails_when=the cell mapping drops renamed_from; why_new=no test had a rename; seam=none; no_claim=rename heuristics (core baseline tests)
  fs.writeFileSync(path.join(dir, "run2.json"), JSON.stringify(file([env("s/de/home.png", "de", "home", ["start"]), env("s/de/pay.png", "de", "pay", ["buy", "now"]), env("s/de/a2.png", "de", "a2", ["bye"])])));
  const ren = await c.call("compare_to_baseline", { results: rel("run2.json"), baseline: rel("base.json") });
  assert.deepEqual(ren.cells, [{ locale: "de", screen: "a2", state: "new", reason: "new", renamed_from: "old" }]);
  // Value: protects=TODO-038 T3 compact reply (review); fails_when=a changed cell returns all 50 diff lines per side; why_new=only one-line diffs were tested; seam=none; no_claim=the 50-line cap in the results file (core tests)
  const many = env("s/de/pay.png", "de", "pay", Array.from({ length: 8 }, (_, i) => `w${i}`));
  many.text.lines = [...many.text.tokens];
  fs.writeFileSync(path.join(dir, "run3.json"), JSON.stringify(file([env("s/de/home.png", "de", "home", ["start"]), many, env("s/de/old.png", "de", "old", ["bye"])])));
  const cut = (await c.call("compare_to_baseline", { results: rel("run3.json"), baseline: rel("base.json") })).cells.find((x) => x.screen === "pay");
  assert.deepEqual(cut.diff, { added: ["w0", "w1", "w2", "w3", "w4"], removed: ["buy now"], added_count: 8, removed_count: 1 });
  // Value: protects=D25 two files and no image; fails_when=a failing reader language table turns the comparison into an error; why_new=only a working table was injected; seam=injected loadCore; no_claim=alias mapping without the table
  const down = await connect({ platform: "darwin", arch: "arm64", loadCore: () => ({ ...core, languagesInfo: () => { throw Object.assign(new Error("reader died"), { code: "binary-failed" }); } }), startServer: () => { started++; throw new Error("spawned"); } });
  t.after(down.close);
  const fb = await down.call("compare_to_baseline", { results: rel("run.json"), baseline: rel("base.json") });
  assert.equal(fb.error, undefined, JSON.stringify(fb.error));
  assert.equal(fb.counts.changed, 1);
  assert.equal(started, 0, "no reader started: two files, no image");
});

// Value: protects=TODO-056 D4 (a client that closed its end gets no EPIPE crash, exit 0); fails_when=the stdout EPIPE
// listener in bin/catscan-mcp.js is removed; why_new=the in-memory tests never touch the stdio streams; seam=none; no_claim=none beyond protects
test("stdio server: a client gone before the reply (stdout closed) ends with exit 0, no EPIPE stack (TODO-056)", async () => {
  const { spawn } = require("child_process");
  const p = spawn(process.execPath, [path.join(__dirname, "../bin/catscan-mcp.js")], { stdio: ["pipe", "pipe", "pipe"] });
  p.stdout.destroy(); // the read end closes before the reply, so its write fails with EPIPE
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((r) => p.on("exit", (code) => r(code)));
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
  assert.equal(await exited, 0, stderr);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'/);
});

// Value: protects=TODO-056 D4 (a relayed catscan-core stderr line to a closed stderr is dropped, the server keeps serving);
// fails_when=the stderr EPIPE listener in bin/catscan-mcp.js is removed; why_new=no test closed stderr; seam=none; no_claim=a real core's stderr text
test("stdio server: a closed stderr drops the core's relayed lines and keeps serving (TODO-056)", async (t) => {
  const { spawn } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-mcp-epipe-"));
  fs.writeFileSync(path.join(dir, "a.png"), "");
  const marker = path.join(dir, "core-started");
  const env = { ...process.env, CATSCAN_CORE_BINARY: path.join(__dirname, "fixtures/noisy-core.sh"), NOISY_CORE_MARKER: marker };
  delete env.CATSCAN_MCP_ROOTS; // roots default to cwd, so a.png is inside them
  const p = spawn(process.execPath, [path.join(__dirname, "../bin/catscan-mcp.js")], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env });
  // The stand-in core exits on its stdin EOF; the folder goes only after the server has exited (TODO-089 D3).
  t.after(async () => { if (p.exitCode === null && p.signalCode === null) { p.kill(); await new Promise((r) => p.once("exit", r)); } fs.rmSync(dir, { recursive: true, force: true }); });
  p.stderr.destroy();
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  let code = null;
  const exited = new Promise((r) => p.on("exit", (c) => { code = c; r(c); }));
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/call", params: { name: "read_screen", arguments: { path: "a.png" } } }); // starts the core
  for (let i = 0; i < 400 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25)); // 10 s on a loaded Mac
  assert.ok(fs.existsSync(marker), "the stand-in core started");
  await new Promise((r) => setTimeout(r, 600)); // about 6 relayed lines hit the closed pipe; without the listener the first one crashes
  send({ id: 3, method: "tools/list" });
  for (let i = 0; i < 200 && !out.includes('"id":3') && code === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(code, null, "still running after the relayed lines");
  assert.match(out, /"id":3/, "still serving after the relayed lines");
  p.stdin.end();
  assert.equal(await exited, 0);
});

test("thresholds: min_severity and min_certainty validated, gate the verdict, folder replies list below_threshold (TODO-077)", async (t) => {
  // Value: protects=TODO-077 D8, D22 on MCP; fails_when=MCP reads the core verdict, counts below-threshold findings, or hides them; why_new=new surface; seam=fake serve; no_claim=the bands (findings-registry.test.js)
  const c = await connect({ mode: "findings" });
  t.after(c.close);
  fs.mkdirSync(path.join(ROOT, "sev"), { recursive: true });
  for (const n of ["both.png", "note.png", "clean.png"]) fs.writeFileSync(path.join(ROOT, "sev", n), "");
  const all = await c.call("find_truncation", { path: "sev" });
  assert.deepEqual([all.fail, all.pass, all.below_threshold], [2, 1, undefined], JSON.stringify(all));
  const med = await c.call("find_truncation", { path: "sev", min_certainty: "medium" });
  assert.deepEqual([med.fail, med.pass, med.omitted_pass], [1, 2, 2], JSON.stringify(med));
  assert.deepEqual(med.below_threshold, [{ path: "sev/note.png", count: 1 }]);
  const both = med.results[0];
  assert.equal(both.path, "sev/both.png");
  // Findings sorted, gate first; compact keeps severity, certainty and gate, never precision.
  assert.deepEqual(both.findings.map((f) => [f.kind, f.severity, f.certainty, f.gate, f.precision]), [["truncated", "major", "medium", true, undefined], ["overlap", "major", "low", false, undefined]]);
  const one = await c.call("find_truncation", { path: "sev/note.png", min_certainty: "medium" });
  assert.equal(one.verdict, "pass");
  assert.equal(one.findings[0].gate, false);
  for (const bad of [{ min_severity: "high" }, { min_certainty: "critical" }]) assert.equal((await c.call("find_truncation", { path: "a.png", ...bad })).isError, true, JSON.stringify(bad));
  assert.equal((await c.call("read_screen", { path: "a.png", min_severity: "major" })).isError, true, "read_screen takes no threshold");
  // The thresholds never reach serve: the gate is Node's.
  assert.ok(c.requests().every((r) => r.min_severity === undefined && r.min_certainty === undefined));
});

test("known: approved findings come back known and never fail; folder replies list them; missing fails closed; outside roots refused (TODO-055 D12)", async (t) => {
  // Value: protects=TODO-055 D12 on MCP; fails_when=MCP ignores the known file, keys paths differently from the CLI, counts known findings as below_threshold, or reads a known file outside the roots; why_new=new surface; seam=fake serve; no_claim=the key itself (core-js known.test.js)
  const known = require("@catscan/core-js/src/known");
  const results = require("@catscan/core-js/src/results");
  const scale = require("@catscan/core-js/src/scale");
  const c = await connect({ mode: "findings" });
  t.after(c.close);
  fs.mkdirSync(path.join(ROOT, "kn"), { recursive: true });
  for (const n of ["both.png", "note.png"]) fs.writeFileSync(path.join(ROOT, "kn", n), "");
  // Approve note.png's boxes overlap as the CLI would from ROOT: the cell is the root-relative path.
  const boxes = { kind: "overlap", signal: "boxes", box: [0.1, 0.1, 0.5, 0.1], line: "Kopf / Fuss", a: { text: "Kopf", box: [0.1, 0.1, 0.5, 0.05], confidence: 1 }, b: { text: "Fuss", box: [0.1, 0.12, 0.5, 0.05], confidence: 1 }, overlap: 0.4 };
  const env = scale.annotate({ schema: 1, catscan: "0", command: "truncated", path: "kn/note.png", verdict: "fail", engine: "vision-accurate-rev3", locale: null, image: { width: 1, height: 1 }, screen: null, host: {}, ms: 1, checks: [], findings: [boxes], warnings: [], device: null, platform: null });
  const file = results.build({ results: [env], coverage: null, argv: ["truncated", "kn"], started: new Date(0), finished: new Date(0), build: null, host: {}, ci: null });
  fs.writeFileSync(path.join(ROOT, "kn.known.json"), known.serialize(known.approve(null, [{ obj: file, name: "r.json" }]).file));

  const all = await c.call("find_truncation", { path: "kn", known: "kn.known.json" });
  assert.deepEqual([all.fail, all.pass, all.below_threshold], [1, 1, undefined], JSON.stringify(all));
  assert.deepEqual(all.known, [{ path: "kn/note.png", count: 1 }]);
  const one = await c.call("find_truncation", { path: "kn/note.png", known: "kn.known.json" });
  assert.equal(one.verdict, "pass");
  assert.deepEqual([one.findings[0].known, one.findings[0].gate], [true, false]);
  // both.png's own boxes overlap finding is the same key in another cell, so it stays new.
  const both = await c.call("find_truncation", { path: "kn/both.png", known: "kn.known.json" });
  assert.equal(both.verdict, "fail");
  assert.ok(both.findings.every((f) => f.known !== true), JSON.stringify(both));

  const missing = await c.call("find_truncation", { path: "kn/note.png", known: "nope.known.json" });
  assert.equal(missing.verdict, "fail", "a missing known file fails closed");
  assert.equal(missing.warnings[0].code, "known-missing");
  fs.writeFileSync(path.join(ROOT, "bad.known.json"), "{");
  assert.equal((await c.call("find_truncation", { path: "kn", known: "bad.known.json" })).error.code, "known-invalid");
  fs.writeFileSync(path.join(OUT, "k.json"), "{}");
  const outside = await c.call("find_truncation", { path: "kn", known: path.join(OUT, "k.json") });
  assert.equal(outside.error.code, "path-outside-root", JSON.stringify(outside));
  assert.equal((await c.call("read_screen", { path: "a.png", known: "kn.known.json" })).isError, true, "read_screen takes no known");
});

test("roots: an implicit cwd of /, the home folder or above fails closed with no-roots; named roots are kept (TODO-107)", async (t) => {
  // Value: protects=the disk stays closed when nobody named a root; fails_when=the cwd fallback accepts / or home again, or refuses a named root; why_new=new fail-closed rule; seam=fake serve; no_claim=which folder each client starts in
  const home = tmp();
  fs.mkdirSync(path.join(home, "proj"));
  fs.writeFileSync(path.join(home, "proj/a.png"), "");
  const alias = path.join(tmp(), "home-link");
  fs.symlinkSync(home, alias);
  for (const cwd of ["/", home, path.dirname(home), alias]) {
    const c = await connect({ cwd, home });
    const r = await c.call("check_text", { path: "a.png", present: ["a"] });
    await c.close();
    assert.equal(r.error?.code, "no-roots", `${cwd}: ${JSON.stringify(r)}`);
    assert.match(r.error.hint, /CATSCAN_MCP_ROOTS/);
    assert.match(r.error.hint, /restart/);
  }
  const cmp = await connect({ cwd: "/", home });
  t.after(cmp.close);
  assert.equal((await cmp.call("compare_to_baseline", { results: "r.json", baseline: "b.json" })).error.code, "no-roots");
  // A project folder below home still works, and roots the user named are taken as given.
  const proj = await connect({ cwd: path.join(home, "proj"), home });
  t.after(proj.close);
  assert.equal((await proj.call("check_text", { path: "a.png", present: ["a"] })).verdict, "pass");
  const env = await connect({ cwd: "/", home, env: { CATSCAN_MCP_ROOTS: path.join(home, "proj") } });
  t.after(env.close);
  assert.notEqual((await env.call("check_text", { path: "a.png", present: ["a"] })).error?.code, "no-roots");
  const named = await connect({ cwd: "/", home }, [home]);
  t.after(named.close);
  assert.notEqual((await named.call("check_text", { path: "proj/a.png", present: ["a"] })).error?.code, "no-roots");
});

test("folder walk: stops one past max_images, so over_cap is 1, in the order of a full walk (TODO-107)", async (t) => {
  // Value: protects=a huge folder is never listed in full; fails_when=the walk collects every file or picks other files than the sorted full list; why_new=walk limit; seam=fake serve; no_claim=walk time
  const root = tmp();
  for (const f of ["b.png", "b/x.png", "a.png", "c.png", "b/a.png"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "");
  }
  const inputs = require("@catscan/core-js/src/inputs");
  const full = inputs.collect([root]).map((i) => path.relative(root, i.path));
  assert.deepEqual(full, ["a.png", "b.png", "b/a.png", "b/x.png", "c.png"]);
  for (let n = 1; n <= 5; n++) assert.deepEqual(inputs.collect([root], inputs.IMAGE_EXT, { limit: n }).map((i) => path.relative(root, i.path)), full.slice(0, n));
  const c = await connect({ cwd: root });
  t.after(c.close);
  const r = await c.call("check_text", { path: ".", present: ["a"], max_images: 2, include_passing: true });
  assert.equal(r.images, 2);
  assert.equal(r.over_cap, 1);
  assert.equal((await c.call("check_text", { path: ".", present: ["a"], max_images: 5 })).over_cap, undefined);
});

test("data files: over the size cap or not a regular file is refused before any read (TODO-107)", async (t) => {
  // Value: protects=the server never reads a huge or endless data file into memory; fails_when=a data argument skips the stat check; why_new=new cap; seam=fake serve, cap lowered to 10 bytes; no_claim=a file that grows after the stat
  const root = tmp();
  fs.writeFileSync(path.join(root, "a.png"), "");
  fs.writeFileSync(path.join(root, "big.json"), JSON.stringify({ greeting: "Hello there" }));
  fs.writeFileSync(path.join(root, "small.json"), "{}");
  require("child_process").execFileSync("mkfifo", [path.join(root, "fifo.json")]);
  const c = await connect({ cwd: root, maxDataBytes: 10 });
  t.after(c.close);
  for (const [name, args] of [
    ["check_text", { path: "a.png", present: ["a"], catalog: ["big.json"] }],
    ["find_truncation", { path: "a.png", boxes_path: "big.json" }],
    ["find_truncation", { path: "a.png", known: "big.json" }],
    ["find_fit_issues", { path: "a.png", device_profile: "big.json" }],
    ["compare_to_baseline", { results: "big.json", baseline: "small.json" }],
    ["compare_to_baseline", { results: "small.json", baseline: "big.json" }],
  ]) {
    const r = await c.call(name, args);
    assert.equal(r.error?.code, "input-too-large", `${name} ${JSON.stringify(args)}: ${JSON.stringify(r)}`);
    assert.match(r.error.message, /big\.json/);
  }
  const fifo = await c.call("find_truncation", { path: "a.png", known: "fifo.json" });
  assert.equal(fifo.error?.code, "unsupported-input", JSON.stringify(fifo));
  // A sidecar inside a boxes folder and a {locale} sibling catalog are data files too (review).
  fs.mkdirSync(path.join(root, "bx"));
  fs.writeFileSync(path.join(root, "bx/a.boxes.json"), JSON.stringify({ viewport: { width: 1, height: 1 }, elements: [] }));
  for (const [name, args] of [["find_truncation", { path: "a.png", boxes_path: "bx" }], ["find_overlap", { path: "a.png", boxes: "bx" }], ["find_fit_issues", { path: "a.png", boxes: "bx" }]]) {
    const r = await c.call(name, args);
    assert.equal(r.error?.code, "input-too-large", `${name}: ${JSON.stringify(r)}`);
  }
  fs.mkdirSync(path.join(root, "loc"));
  fs.writeFileSync(path.join(root, "loc/en.json"), JSON.stringify({ a: "b" }));
  fs.writeFileSync(path.join(root, "loc/de.json"), JSON.stringify({ greeting: "Hallo Welt" }));
  const sib = await c.call("find_untranslated", { path: "a.png", locale: "en", catalog: ["loc/{locale}.json"] });
  assert.equal(sib.error?.code, "input-too-large", JSON.stringify(sib));
});
