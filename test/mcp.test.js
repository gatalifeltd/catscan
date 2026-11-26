// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 09 through the MCP SDK client and real Vision: every tool, parity with the CLI's --json, errors, the folder
// cap, the token budget proxy and one run of the catscan-mcp bin over stdio.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { ROOT, BIN, setup, cli } = require("./helpers");
const { createServer } = require("../packages/mcp/src/server");
const { compact } = require("../packages/mcp/src/compact");

const SYNTH = setup();
process.env.CATSCAN_CORE_BINARY = BIN;
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-mcp-")));
const U = path.join(__dirname, "fixtures/untranslated");

// Images: the synthetic set, a truncated label with its boxes sidecar, the untranslated screens, one video.
fs.cpSync(SYNTH, path.join(WORK, "shots"), { recursive: true });
fs.mkdirSync(path.join(WORK, "trunc"));
fs.writeFileSync(path.join(WORK, "trunc/s.json"), JSON.stringify([{ name: "cut.png", locale: "en", width: 1000, height: 400, lines: [{ text: "Continue with ema…", x: 100, y: 150, size: 64 }] }]));
execFileSync(path.join(ROOT, ".build/synth"), [path.join(WORK, "trunc/s.json"), path.join(WORK, "trunc")]);
fs.writeFileSync(path.join(WORK, "trunc/cut.boxes.json"), JSON.stringify({ image: { width: 1000, height: 400 }, elements: [{ id: "cta", box: [0.08, 0.3, 0.7, 0.3], clips: true, text: "Continue with email" }] }));
fs.mkdirSync(path.join(WORK, "untr"));
execFileSync(path.join(ROOT, ".build/synth"), [path.join(U, "screens.json"), path.join(WORK, "untr")]);
fs.cpSync(U, path.join(WORK, "cat"), { recursive: true });
const videoGen = path.join(ROOT, ".build/video");
if (!fs.existsSync(videoGen) || fs.statSync(videoGen).mtimeMs < fs.statSync(path.join(__dirname, "fixtures/video.swift")).mtimeMs) {
  execFileSync("swiftc", ["-O", path.join(__dirname, "fixtures/video.swift"), "-o", videoGen]);
}
fs.mkdirSync(path.join(WORK, "vid"));
fs.writeFileSync(path.join(WORK, "vid/v.json"), JSON.stringify(require("./fixtures/videos.json").filter((v) => v.name === "timed.mp4")));
execFileSync(videoGen, [path.join(WORK, "vid/v.json"), path.join(WORK, "vid")]);
const W = (p) => path.join(WORK, p);

let client, server;
test.before(async () => {
  server = createServer({ cwd: WORK, env: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.mcp.connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
});
test.after(async () => { await client.close(); await server.close(); });

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, "text", "never image content");
  return { reply: JSON.parse(r.content[0].text), bytes: Buffer.byteLength(r.content[0].text) };
}
const noWarnings = (o) => { const c = { ...o }; delete c.warnings; return c; };
const rel = (o) => ({ ...o, path: path.relative(WORK, o.path) });
/** D16: the MCP reply equals the compacted CLI envelope for the same inputs. */
function parity(reply, cliArgs, opts) {
  const r = cli([...cliArgs, "--json"], { cwd: WORK });
  assert.equal(r.json.length, 1, r.stderr);
  assert.deepEqual(noWarnings(reply), noWarnings(rel(compact(r.json[0], opts))));
}

test("check_text: pass under the token budget, fail with closest, parity with the CLI", async () => {
  // Value: protects=spec 09 check_text and the 150-token target (D9); fails_when=compaction or request building drifts from the CLI; why_new=new surface; seam=SDK in-memory transport; no_claim=tokenizer counts (bench/mcp.js)
  const { reply, bytes } = await call("check_text", { path: "shots/03-de-phone.png", present: ["Jetzt testen"], absent: ["Etwas ist schiefgelaufen"], locale: "de" });
  assert.equal(reply.verdict, "pass");
  assert.equal(reply.checks.length, 2);
  assert.ok(bytes < 290, `reply is ${bytes} bytes`); // D9: about 2 bytes per token, so under 150 tokens
  for (const k of ["host", "engine", "ms", "catscan", "schema", "image"]) assert.equal(reply[k], undefined, k);
  parity(reply, ["check", W("shots/03-de-phone.png"), "--present", "Jetzt testen", "--absent", "Etwas ist schiefgelaufen", "--locale", "de"]);
  const fail = (await call("check_text", { path: W("shots/01-en-phone.png"), present: ["Continue with emial"] })).reply;
  assert.equal(fail.verdict, "fail");
  assert.equal(fail.checks[0].closest.line, "Continue with email");
});

test("check_text: @key with catalog and an expect file", async () => {
  // Value: protects=spec 09 catalog/expect inputs (D10); fails_when=@key resolution or expect matching differs from the CLI; why_new=new surface; seam=CLI loaders; no_claim=none
  const key = (await call("check_text", { path: "untr/u01-clean.png", locale: "de", catalog: ["cat/de.json"], present: ["@settings.title"] })).reply;
  parity(key, ["check", W("untr/u01-clean.png"), "--locale", "de", "--catalog", W("cat/de.json"), "--present", "@settings.title"]);
  fs.writeFileSync(W("expect.json"), JSON.stringify({ shots: { "02-en-small.png": { present: ["GAME OVER"] } } }));
  const ex = (await call("check_text", { path: "shots", expect: "expect.json", include_passing: true })).reply;
  const small = ex.results.find((r) => r.path.endsWith("02-en-small.png"));
  assert.equal(small.verdict, "pass");
  assert.equal(small.checks[0].text, "GAME OVER");
  const unknown = (await call("check_text", { path: "shots/02-en-small.png", catalog: ["cat/de.json"], present: ["@no.such.key"] })).reply;
  assert.equal(unknown.verdict, "error");
  assert.equal(unknown.error.code, "unknown-catalog-key");
});

test("read_screen: screen_text with max_lines, parity", async () => {
  // Value: protects=spec 09 read_screen (D18, max_lines); fails_when=lines leak under their raw name or the cap is ignored; why_new=new surface; seam=none; no_claim=none
  const { reply } = await call("read_screen", { path: "shots/01-en-phone.png" });
  assert.deepEqual(reply.screen_text.map((l) => l.text), ["Welcome back", "Continue with email", "Terms of Service"]);
  assert.equal(reply.lines, undefined);
  parity(reply, ["read", W("shots/01-en-phone.png")]);
  const capped = (await call("read_screen", { path: "shots/01-en-phone.png", max_lines: 1 })).reply;
  assert.equal(capped.screen_text.length, 1);
  assert.equal(capped.truncated, true);
  assert.equal(capped.lines_total, 3);
});

test("find_truncation: with and without boxes, parity", async () => {
  // Value: protects=spec 09 find_truncation and boxes_path containment; fails_when=boxes are not sent or findings differ from the CLI; why_new=new surface; seam=truncated.build; no_claim=reason accuracy (spec 06 tests)
  const bare = (await call("find_truncation", { path: "trunc/cut.png" })).reply;
  assert.equal(bare.verdict, "fail");
  parity(bare, ["truncated", W("trunc/cut.png")]);
  const boxed = (await call("find_truncation", { path: "trunc/cut.png", boxes_path: "trunc/cut.boxes.json" })).reply;
  assert.equal(boxed.verdict, "fail");
  assert.equal(boxed.findings[0].element.id, "cta");
  parity(boxed, ["truncated", W("trunc/cut.png"), "--boxes", W("trunc/cut.boxes.json")]);
});

test("find_untranslated: base + catalog + allow over a folder, parity per screen", async () => {
  // Value: protects=spec 09 find_untranslated, digest reuse across a folder (D16) and allow as strings (D10); fails_when=later requests lose the catalogs or allow is dropped; why_new=new surface; seam=untranslated.build; no_claim=rule accuracy (spec 17 tests)
  const args = { path: "untr", locale: "de", base: "cat/en.json", catalog: ["cat/de.json"], include_passing: true };
  const { reply } = await call("find_untranslated", args);
  assert.equal(reply.images, 10);
  const r = cli(["untranslated", W("untr"), "--locale", "de", "--base", W("cat/en.json"), "--catalog", W("cat/de.json"), "--json"], { cwd: WORK });
  assert.deepEqual(reply.results.map(noWarnings), r.json.map((e) => noWarnings(rel(compact(e)))));
  const failing = reply.results.find((x) => x.findings && x.findings.some((f) => f.kind === "untranslated"));
  const allowed = (await call("find_untranslated", { ...args, path: failing.path, allow: failing.findings.map((f) => f.line) })).reply;
  assert.equal(allowed.findings, undefined, JSON.stringify(allowed));
});

test("check_video: verdicts with times, frames capped by max_lines", async () => {
  // Value: protects=spec 09 check_video and D15; fails_when=frame lines flood the reply or times are dropped; why_new=new surface; seam=none; no_claim=sampling accuracy (spec 07 tests)
  const { reply } = await call("check_video", { path: "vid/timed.mp4", present: ["GAME OVER"], absent: ["Level complete"] });
  assert.equal(reply.verdict, "pass");
  assert.equal(typeof reply.checks[0].first_seen, "number");
  assert.equal(reply.frame_text, undefined);
  parity(reply, ["video", W("vid/timed.mp4"), "--present", "GAME OVER", "--absent", "Level complete"]);
  const frames = (await call("check_video", { path: "vid/timed.mp4", present: ["GAME OVER"], frames: true, max_lines: 3 })).reply;
  assert.equal(frames.frame_text.reduce((n, f) => n + f.screen_text.length, 0), 3);
  assert.equal(frames.truncated, true);
});

test("errors: missing file, unsupported language, wrong kind, no checks", async () => {
  // Value: protects=spec 09 Errors as normal results (D11, D21); fails_when=an error becomes a protocol error or loses its hint; why_new=new surface; seam=none; no_claim=none
  const missing = (await call("check_text", { path: "shots/none.png", present: ["x"] })).reply;
  assert.equal(missing.error.code, "input-not-found");
  assert.match(missing.error.message, new RegExp(W("shots/none.png")));
  const el = (await call("read_screen", { path: "shots/01-en-phone.png", locale: "el", fallback: "none" })).reply;
  assert.equal(el.verdict, "needs-reader"); // TODO-065: el is read with Tesseract, never "unsupported"
  assert.ok(el.error.hint);
  const video = (await call("check_text", { path: "vid/timed.mp4", present: ["x"] })).reply;
  assert.equal(video.error.code, "unsupported-input");
  const none = (await call("check_text", { path: "shots/01-en-phone.png" })).reply;
  assert.equal(none.error.code, "no-checks");
});

test("folders: failing results only, include_passing, max_images cap", async () => {
  // Value: protects=spec 09 folder budget and D8; fails_when=passing results leak into the reply or the cap is silent; why_new=new surface; seam=none; no_claim=none
  const all = (await call("check_text", { path: "shots", present: ["GAME OVER"] })).reply;
  assert.equal(all.images, fs.readdirSync(W("shots")).filter((f) => f.endsWith(".png")).length);
  assert.equal(all.pass, 1);
  assert.equal(all.omitted_pass, 1);
  assert.ok(all.results.every((r) => r.verdict !== "pass"));
  const capped = (await call("check_text", { path: "shots", present: ["GAME OVER"], max_images: 2, include_passing: true })).reply;
  assert.equal(capped.images, 2);
  assert.equal(capped.results.length, 2);
  assert.equal(capped.over_cap, 1, "the walk stops one past the cap (TODO-107)");
  assert.equal(capped.results[0].path, "shots/01-en-phone.png", "paths relative to the root");
});

test("bin: catscan-mcp over stdio lists the tools and answers a call", async () => {
  // Value: protects=spec 09 stdio entry point (D20 recipe command); fails_when=the bin writes to stdout or cannot start; why_new=new bin; seam=StdioClientTransport; no_claim=agent configs (manual smoke, spec 25)
  const c = new Client({ name: "stdio", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "packages/mcp/bin/catscan-mcp.js")], cwd: WORK, env: { ...process.env, CATSCAN_CORE_BINARY: BIN }, stderr: "ignore" }));
  try {
    assert.equal((await c.listTools()).tools.length, 9);
    assert.match(c.getInstructions(), /untrusted/);
    const r = await c.callTool({ name: "check_text", arguments: { path: "shots/02-en-small.png", present: ["GAME OVER"] } });
    assert.equal(JSON.parse(r.content[0].text).verdict, "pass");
  } finally { await c.close(); }
});
