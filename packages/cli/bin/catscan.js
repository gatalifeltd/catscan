#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// A reader that leaves early (`| head -1`) closes the pipe: drop the rest of the output, finish the run (its files and
// its exit code), no stack trace (TODO-056 D1, D2). Any other stream error still crashes as before.
for (const s of [process.stdout, process.stderr]) s.on("error", (e) => { if (e.code !== "EPIPE") throw e; });
const early = require("./preflight").preflight(process.argv.slice(2), process.versions.node, process.arch, require("../package.json").version);
if (early) {
  // exitCode, not exit(): stdout to a pipe is asynchronous on macOS and exit() could cut the JSON short.
  process.stdout.write(early.stdout);
  process.stderr.write(early.stderr);
  process.exitCode = early.code;
} else {
  const { cli } = require("@catscan/core-js");
  cli.main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => {
      process.stderr.write(`catscan: internal: ${e && e.stack ? e.stack : e} - try: this is a bug: report it\n`);
      process.exitCode = 5;
    },
  );
}
