// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// A stand-in for `catscan-core serve` (spec 09 backend tests): the ready line, then one pass envelope per request.
// argv: <mode> <state dir>. Modes: ok, die-once (exits on its first request the first time it runs), die-always,
// protocol (announces protocol 99), silent (never answers, TODO-089 D3); a fit request asking for element_rows (TODO-074) gets one row; findings (TODO-077: both.png gets a truncated and an OCR-only (boxes, still low certainty) overlap finding, note.png the overlap one).
const fs = require("fs");
const path = require("path");
const [mode, dir] = process.argv.slice(2);
const starts = path.join(dir, "starts");
const n = (fs.existsSync(starts) ? Number(fs.readFileSync(starts, "utf8")) : 0) + 1;
fs.writeFileSync(starts, String(n));
process.stdout.write(JSON.stringify({ catscan: "0", id: null, protocol: mode === "protocol" ? 99 : 23, type: "ready" }) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const req = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    fs.appendFileSync(path.join(dir, "requests"), JSON.stringify({ ...req, start: n }) + "\n");
    if (mode === "die-always" || (mode === "die-once" && n === 1)) process.exit(1);
    if (mode === "silent") continue;
    const boxes = { kind: "overlap", signal: "boxes", box: [0.1, 0.1, 0.5, 0.1], line: "Kopf / Fuss", a: { text: "Kopf", box: [0.1, 0.1, 0.5, 0.05], confidence: 1 }, b: { text: "Fuss", box: [0.1, 0.12, 0.5, 0.05], confidence: 1 }, overlap: 0.4 };
    const trunc = { kind: "truncated", box: [0.1, 0.5, 0.5, 0.1], line: "Weiter...", reason: "ellipsis", element: null, expected: null, confidence: 1 };
    const name = path.basename(String(req.path));
    const findings = mode !== "findings" ? [] : name === "both.png" ? [boxes, trunc] : name === "note.png" ? [boxes] : [];
    process.stdout.write(JSON.stringify({ id: req.id, path: req.path, verdict: findings.length ? "fail" : "pass", engine: "vision-accurate-rev3", checks: [], findings, warnings: [], catscan: "0", host: {}, ms: 1, ...(req.fit?.wrap?.element_rows ? { element_rows: [{ id: "cta", text: "Start", rows: 1, orphan: false }] } : {}) }) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));
