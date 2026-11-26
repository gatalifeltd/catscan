#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// The catscan MCP server over stdio (spec 09). stdout carries only MCP messages; the core's stderr is relayed to stderr.
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer } = require("../src/server");

const { mcp, close } = createServer();
mcp.connect(new StdioServerTransport()).catch((e) => {
  process.stderr.write(`catscan-mcp: ${e.message}\n`);
  process.exit(1);
});
let leaving = false;
const leave = () => { if (!leaving) { leaving = true; close().finally(() => process.exit(0)); } };
process.stdin.on("close", leave);
// EPIPE on stdout: the client is gone, so leave as on stdin close, with no stack trace. On stderr (catscan-core's
// relayed lines): drop the line and keep serving (TODO-056 D4).
process.stdout.on("error", (e) => { if (e.code !== "EPIPE") throw e; leave(); });
process.stderr.on("error", (e) => { if (e.code !== "EPIPE") throw e; });
