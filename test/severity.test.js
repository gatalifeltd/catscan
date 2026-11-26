// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-077 through the CLI and real Vision: severity, certainty and gate on a synthetic overflow screen, thresholds
// turning a medium-only screen into a pass, JSON order unchanged, and the results file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");
const scale = require("../packages/core-js/src/scale");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = require("../packages/mcp/src/server");
const { BIN } = require("./helpers");

setup();
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-severity-"));
fs.writeFileSync(path.join(DIR, "s.json"), JSON.stringify([
  { name: "over.png", locale: "de", width: 1179, height: 600, lines: [{ text: "Jetzt kostenlos testen", x: 160, y: 260, size: 44, over: 2.5, clips: false }] },
]));
execFileSync(path.join(ROOT, ".build/synth"), [path.join(DIR, "s.json"), DIR]);
const strip = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => !["severity", "certainty", "precision", "gate"].includes(k)));

test("truncated --boxes: the finding carries the registry's band; --min-certainty high makes the screen pass", () => {
  const r = cli(["truncated", DIR, "--locale", "de", "--json", "--boxes", DIR]);
  assert.equal(r.code, 1, r.stderr);
  const [env] = r.json;
  assert.ok(validate(env), JSON.stringify(validate.errors));
  assert.equal(env.verdict, "fail");
  const f = env.findings.find((x) => x.reason === "overflow");
  assert.ok(f, JSON.stringify(env.findings));
  const row = scale.lookup("truncated", "overflow", "vision");
  assert.deepEqual([f.severity, f.certainty, f.gate], [row.severity, row.certainty, true]);
  assert.equal(f.precision, Math.round(row.synthetic.precision * 1000) / 1000);

  const h = cli(["truncated", DIR, "--locale", "de", "--json", "--boxes", DIR, "--min-certainty", "high", "--results", path.join(DIR, "r.json")]);
  assert.equal(h.code, 0, h.stderr);
  const [e2] = h.json;
  assert.equal(e2.verdict, "pass");
  assert.ok(e2.findings.every((x) => x.gate === false));
  // JSON findings[] keeps the emission order: only the four fields differ.
  assert.deepEqual(e2.findings.map(strip), env.findings.map(strip));
  const file = JSON.parse(fs.readFileSync(path.join(DIR, "r.json"), "utf8"));
  assert.deepEqual(file.run.thresholds, { min_severity: "minor", min_certainty: "high" });
  assert.match(file.run.registry, /^[0-9a-f]{12}$/);
  assert.equal(cli(["results", "validate", path.join(DIR, "r.json")]).code, 0);

  const t = cli(["truncated", DIR, "--locale", "de", "--boxes", DIR, "--min-certainty", "high"]);
  assert.equal(t.code, 0);
  assert.match(t.stdout, /^PASS {2}.*over\.png\n {2}note major\/medium {2}truncated \(overflow\)/m);
  assert.match(t.stdout, /1 image: 1 pass, \d+ below threshold \(--min-certainty high\) \(/);
  const q = cli(["truncated", DIR, "--locale", "de", "--boxes", DIR, "--min-certainty", "high", "--quiet"]);
  assert.doesNotMatch(q.stdout, /note/);
});

test("thresholds: usage errors before any input is read", () => {
  const r = cli(["truncated", DIR, "--min-severity", "high"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /catscan: invalid-threshold: --min-severity "high" is not a severity \(critical, major, minor\) - try: --min-certainty high/);
  const v = cli(["read", DIR, "--min-certainty", "high"]);
  assert.equal(v.code, 2);
  assert.match(v.stderr, /catscan: option-not-valid: --min-certainty is not valid for read/);
});

test("one owner: a screen whose findings all fall below --min-certainty high passes in the CLI and MCP alike (D8)", async (t) => {
  process.env.CATSCAN_CORE_BINARY = BIN;
  const server = createServer({ cwd: DIR, env: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.mcp.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (args) => JSON.parse((await client.callTool({ name: "find_truncation", arguments: args })).content[0].text);
  const dflt = await call({ path: ".", locale: "de", boxes_path: "." });
  assert.equal(dflt.fail, 1, JSON.stringify(dflt));
  const high = await call({ path: ".", locale: "de", boxes_path: ".", min_certainty: "high" });
  assert.deepEqual([high.fail, high.pass], [0, 1], JSON.stringify(high));
  assert.equal(high.results.length, 0, "needsAttention ignores below-threshold findings");
  assert.equal(high.below_threshold[0].path, "over.png");
  const cliRun = cli(["truncated", DIR, "--locale", "de", "--boxes", DIR, "--min-certainty", "high", "--json"]);
  assert.equal(cliRun.code, 0);
});
