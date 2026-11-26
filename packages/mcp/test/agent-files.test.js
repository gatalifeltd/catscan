// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 10 tool-name check ("the spec 10 lint" of spec 00): the agent instruction files name exactly the tools the
// server lists, the core block names every one of them, and every MCP tool and `catscan <command>` they name is a row
// of the spec 00 surface table. Structure checks live in scripts/skills-lint.mjs (D7).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = require("../src/server");

const REPO = path.join(__dirname, "../../..");
// The spec 00 surface table lives in the lab; the published repo gets no specs, so those tests run in the lab only.
const LAB_ONLY = fs.existsSync(path.join(REPO, "scripts/public-paths.txt")) ? {} : { skip: "lab-only: needs the conventions spec" };
const FILES = ["plugins/catscan/skills/screen-check/SKILL.md", "examples/agents/cursor/catscan.mdc", "examples/agents/AGENTS.md.snippet"];
// Backticked snake_case names that are reply fields, not tools.
const FIELDS = new Set(["screen_text"]);

/** Backticked snake_case names (tool names) in a text. */
const toolNames = (s) => new Set([...s.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]).filter((n) => !FIELDS.has(n)));
/** Commands in backticked `catscan <command>` and `npx -y @catscan/cli <command>` forms; flags are not commands. */
const commands = (s) => new Set([...s.matchAll(/`(?:catscan|npx -y @catscan\/cli) ([a-z][a-z-]*)\b/g)].map((m) => m[1]));
const core = (s) => s.match(/<!-- catscan-core:start -->\n([\s\S]*?)<!-- catscan-core:end -->/)[1];

/** The spec 00 "Surface names" table: { cli: Set, mcp: Set }. */
function surface() {
  const spec = fs.readFileSync(path.join(REPO, "docs/specs/00-conventions.md"), "utf8");
  const table = spec.split("## Surface names")[1].split("\n## ")[0];
  const rows = table.split("\n").filter((l) => l.startsWith("| `"));
  const cell = (l, i) => l.split("|")[i + 1].trim().replace(/`/g, "");
  return { cli: new Set(rows.map((l) => cell(l, 0))), mcp: new Set(rows.map((l) => cell(l, 1))) };
}

async function listedTools() {
  const server = createServer({ env: {}, startServer: () => { throw new Error("no backend in this test"); } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.mcp.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return new Set(tools.map((t) => t.name));
}

/** Problems for one file's text against the listed tools and the surface table; [] when it is right. */
function problems(name, s, listed, table) {
  const out = [];
  const named = toolNames(s);
  for (const n of named) if (!listed.has(n)) out.push(`${name}: names ${n}, which tools/list does not have`);
  for (const n of named) if (!table.mcp.has(n)) out.push(`${name}: names ${n}, which is not in the spec 00 surface table`);
  const inCore = toolNames(core(s));
  for (const n of listed) if (!inCore.has(n)) out.push(`${name}: core block does not name ${n}`);
  for (const c of commands(s)) if (!table.cli.has(c)) out.push(`${name}: names catscan ${c}, which is not in the spec 00 surface table`);
  return out;
}

test("the agent files name exactly the listed tools, all in the core block and the surface table", LAB_ONLY, async () => {
  // Value: protects=spec 10 D2/D7; fails_when=a tool is renamed, added or dropped without the agent files following;
  // why_new=new files; seam=in-memory MCP client, no backend; no_claim=file structure (skills-lint).
  const listed = await listedTools();
  const table = surface();
  assert.ok(listed.size >= 5);
  for (const f of FILES) {
    const s = fs.readFileSync(path.join(REPO, f), "utf8");
    assert.deepEqual(problems(f, s, listed, table), []);
    assert.ok(commands(s).has("check"), `${f}: shows the command-line form`);
  }
});

test("a renamed tool, an unlisted tool and an unknown command each fail", LAB_ONLY, async () => {
  // Value: protects=the check above can fail; fails_when=the parser misses a name; why_new=new check; seam=none;
  // no_claim=none.
  const listed = await listedTools();
  const table = surface();
  const s = fs.readFileSync(path.join(REPO, FILES[0]), "utf8");
  const renamed = s.replaceAll("`check_text`", "`check_texts`");
  assert.ok(problems("f", renamed, listed, table).some((p) => /names check_texts, which tools\/list does not have/.test(p)));
  assert.ok(problems("f", renamed, listed, table).some((p) => /core block does not name check_text$/.test(p)));
  const extra = s + "\nAlso `which_screen`.\n";
  assert.ok(problems("f", extra, listed, table).some((p) => /names which_screen, which tools\/list does not have/.test(p)));
  const cmd = s + "\nRun `catscan scan x.png`.\n";
  assert.ok(problems("f", cmd, listed, table).some((p) => /names catscan scan/.test(p)));
});
