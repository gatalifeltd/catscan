// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// A stand-in for `catscan-core serve` (TODO-032 tests): node fake-core.js <mode> <log>.
// Modes: hang-once (the first process never answers from a.png on), hang-all (no process answers anything),
// vt (the first process answers a.png with vision-timeout, then keeps answering), ok (answers everything).
const fs = require("fs");
const readline = require("readline");
const { PROTOCOL } = require("../../src/client");

const [mode, log] = process.argv.slice(2);
const first = !fs.existsSync(`${log}.started`);
fs.writeFileSync(`${log}.started`, "");
const note = (s) => fs.appendFileSync(log, `${process.pid} ${s}\n`);
note("start");
process.on("SIGTERM", () => { note("SIGTERM"); process.exit(143); });
process.stderr.write("IOServiceMatchingfailed for: AppleM2ScalerParavirtDriver\nother core line\n");
process.stdout.write(JSON.stringify({
  id: null, type: "ready", catscan: "9.9.9", protocol: PROTOCOL, vision_timeout_s: 60, engine: "vision-accurate-rev3",
  host: { chip: "Apple M5", arch: "arm64", host_class: "physical", macos: "27.2 (26B123)", vision_revision: 3 },
}) + "\n");
let hung = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  note(`req ${line}`);
  const req = JSON.parse(line);
  if (mode === "hang-all" || (mode === "hang-once" && first && req.path === "a.png")) hung = true;
  if (hung) return;
  const res = { id: req.id, verdict: "pass", path: req.path, pid: process.pid };
  if (mode === "vt" && first && req.path === "a.png") Object.assign(res, { verdict: "error", error: { code: "vision-timeout" } });
  process.stdout.write(JSON.stringify(res) + "\n");
});
