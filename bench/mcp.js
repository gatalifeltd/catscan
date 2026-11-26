#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 09 measurement. Usage: node bench/mcp.js > results/mcp.json, with ANTHROPIC_API_KEY (and, for a key not
// scoped to a workspace, ANTHROPIC_WORKSPACE_ID) set in the environment.
// Without ANTHROPIC_API_KEY the token counts are null (not measured) and only bytes and overhead are gated.
// On the 20 synthetic study-style screens (test/fixtures/synthetic.json):
// 1. Tokens per reply: check_text (one image, 2 checks) and read_screen, counted by the Anthropic count_tokens
//    endpoint. Only reply text is sent, never an image. A reply's tokens are the message count minus the count
//    of a one-character message.
// 2. Overhead: an MCP check_text call (SDK client, in-memory transport) minus a direct serve round trip for the
//    same request, alternated per image over 5 passes after a warm-up; median of the differences.
// Exit 1 when a target fails: check_text reply < 150 tokens (without a key, < 340 bytes as a proxy, D9),
// overhead median < 30 ms.
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { setup, MANIFEST, BIN, ROOT } = require("../test/helpers");
const { Server, versionInfo } = require("../packages/core-js/src/client");
const { createServer } = require("../packages/mcp/src/server");

const MODEL = "claude-opus-5-5"; // the tokenizer the bench counts with
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const now = () => Number(process.hrtime.bigint()) / 1e6;
const round1 = (n) => Math.round(n * 10) / 10;

async function countTokens(text) {
  const r = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    // A key that is not scoped to a workspace also needs anthropic-workspace-id.
    headers: Object.fromEntries([
      ["x-api-key", process.env.ANTHROPIC_API_KEY], ["anthropic-version", "2023-06-01"], ["content-type", "application/json"],
      ...(process.env.ANTHROPIC_WORKSPACE_ID ? [["anthropic-workspace-id", process.env.ANTHROPIC_WORKSPACE_ID]] : []),
    ]),
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: text }] }),
  });
  if (!r.ok) throw new Error(`count_tokens ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).input_tokens;
}

(async () => {
  const dir = setup();
  process.env.CATSCAN_CORE_BINARY = BIN;
  const server = createServer({ cwd: dir, env: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.mcp.connect(a);
  const client = new Client({ name: "bench", version: "1" });
  await client.connect(b);
  const direct = new Server({ bin: BIN });
  await direct.ready;

  const shots = MANIFEST.map((s) => ({ name: s.name, locale: s.locale, present: s.lines[0].text }));
  // Two checks per image: its first line shown, a typical error text not shown.
  const ABSENT = "Something went wrong";
  const args = (s) => ({ path: s.name, locale: s.locale, present: [s.present], absent: [ABSENT] });
  const req = (s) => ({ id: "x", command: "check", path: path.join(dir, s.name), locale: s.locale, present: [s.present], absent: [ABSENT] });
  const mcpCall = async (name, a2) => (await client.callTool({ name, arguments: a2 })).content[0].text;

  // Warm-up: both paths, every image once.
  for (const s of shots) { await mcpCall("check_text", args(s)); await direct.request(req(s)); }
  const diffs = [], mcpMs = [], directMs = [];
  for (let pass = 0; pass < 5; pass++) {
    for (const s of shots) {
      let t = now(); await direct.request(req(s)); const d = now() - t;
      t = now(); await mcpCall("check_text", args(s)); const m = now() - t;
      directMs.push(d); mcpMs.push(m); diffs.push(m - d);
    }
  }

  const tokens = !!process.env.ANTHROPIC_API_KEY;
  const base = tokens ? await countTokens(".") : 0;
  const count = async (t) => (tokens ? (await countTokens(t)) - base + 1 : null);
  const replies = [];
  for (const s of shots) {
    const check = await mcpCall("check_text", args(s));
    const read = await mcpCall("read_screen", { path: s.name, locale: s.locale });
    replies.push({
      image: s.name,
      check_text: { verdict: JSON.parse(check).verdict, bytes: Buffer.byteLength(check), tokens: await count(check) },
      read_screen: { lines: JSON.parse(read).screen_text?.length ?? 0, bytes: Buffer.byteLength(read), tokens: await count(read) },
    });
  }
  await client.close(); await server.close(); await direct.close();

  const checkTokens = replies.map((r) => r.check_text.tokens);
  const readTokens = replies.map((r) => r.read_screen.tokens);
  const v = versionInfo(BIN);
  const out = {
    spec: "09",
    script: "bench/mcp.js",
    images: shots.length,
    tokenizer: { endpoint: "count_tokens", model: MODEL },
    targets: { check_text_tokens_max: 150, check_text_bytes_max_without_key: 340, overhead_median_ms: 30 },
    check_text_tokens: tokens ? { median: median(checkTokens), max: Math.max(...checkTokens) } : null,
    read_screen_tokens: tokens ? { median: median(readTokens), max: Math.max(...readTokens) } : null,
    check_text_bytes: { median: median(replies.map((r) => r.check_text.bytes)), max: Math.max(...replies.map((r) => r.check_text.bytes)) },
    read_screen_bytes: { median: median(replies.map((r) => r.read_screen.bytes)), max: Math.max(...replies.map((r) => r.read_screen.bytes)) },
    overhead_ms: { median: round1(median(diffs)), mcp_median: round1(median(mcpMs)), direct_median: round1(median(directMs)), samples: diffs.length },
    replies,
    tools: {
      catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, chip: v.host.chip, host_class: v.host.host_class,
      node: process.version, mcp_sdk: require(path.join(ROOT, "node_modules/@modelcontextprotocol/sdk/package.json")).version, // the package export maps to dist/cjs/package.json
      swift: execFileSync("swift", ["--version"], { encoding: "utf8" }).split("\n")[0],
      git: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
      clean_tree: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() === "",
      date: new Date().toISOString().slice(0, 10),
    },
  };
  out.pass = (tokens ? out.check_text_tokens.max < 150 : out.check_text_bytes.max < 340) && out.overhead_ms.median < 30;
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(out.pass ? 0 : 1);
})().catch((e) => { process.stderr.write(`bench/mcp.js: ${e.stack || e.message}\n`); process.exit(1); });
