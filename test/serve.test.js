// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// serve: 1000 requests interleaved with malformed lines, an oversized line and a decompression bomb.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { BIN, setup } = require("./helpers");
const { Server, PROTOCOL } = require("../packages/core-js/src/client");

const dir = setup();
// A GitHub macOS VM answers about 10x slower than a physical Mac: CI runs 100 (TODO-004 D3).
const REQUESTS = Number(process.env.CATSCAN_SERVE_REQUESTS || 1000);

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A valid grayscale PNG of 11000x10000 (110 megapixels) that compresses to about 100 KB. */
function bomb() {
  const w = 11000, h = 10000;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale
  const idat = zlib.deflateSync(Buffer.alloc((w + 1) * h), { level: 9 });
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

test("serve: ready line first, every request answered in order, malformed lines never end the process", { timeout: 600_000 }, async () => {
  assert.ok(Number.isInteger(REQUESTS) && REQUESTS >= 100, `CATSCAN_SERVE_REQUESTS=${process.env.CATSCAN_SERVE_REQUESTS} must be an integer >= 100`);
  const img = path.join(dir, "02-en-small.png");
  const b64 = fs.readFileSync(img).toString("base64");
  const bombPng = bomb();
  assert.ok(bombPng.length < 1024 * 1024, `bomb is ${bombPng.length} bytes`);

  // [line, expected id, kind]
  const plan = [];
  const malformed = [
    ["not json at all", null],
    ['{"id":"m-trunc","command":"check"', null],
    ['["an", "array"]', null],
    ['{"id":"m-cmd","command":"dance","path":"x.png"}', "m-cmd"],
    ['{"id":"m-noimg","command":"read"}', "m-noimg"],
    ['{"id":"m-b64","command":"read","image":42}', "m-b64"],
    ['{"id":7,"command":"read","path":"x.png"}', null],
    ['{"id":"m-planned","command":"overlap","path":"x.png"}', "m-planned"],
    // Added by /ship coverage audit.
    // Value: protects=serve rejects a string `present` and an empty `locale` as invalid-request without ending the process; fails_when=Serve.swift field validation for present/locale is dropped or mis-coded; why_new=no malformed row covered check fields or locale; seam=none; no_claim=other field types (two rows only)
    ['{"id":"m-present","command":"check","path":"x.png","present":"A"}', "m-present", "invalid-request"],
    ['{"id":"m-locale","command":"read","path":"x.png","locale":""}', "m-locale", "invalid-request"],
    // Spec 02: a present item that is neither a string nor a catalog check, and an inventory that is not a list.
    ['{"id":"m-catalog","command":"check","path":"x.png","present":[3]}', "m-catalog", "invalid-request"],
    ['{"id":"m-inventory","command":"check","path":"x.png","inventory":{}}', "m-inventory", "invalid-request"],
  ];
  let m = 0;
  for (let i = 0; i < REQUESTS; i++) {
    const id = `r${i}`;
    const req = { id, command: i % 2 ? "check" : "read", locale: "en" };
    if (i % 10 === 0) req.image = b64; else req.path = img;
    if (req.command === "check") req.present = ["GAME OVER"];
    plan.push([JSON.stringify(req), id, "valid"]);
    if (i % 7 === 3) { const [l, mid, code] = malformed[m++ % malformed.length]; plan.push([l, mid, "error", code]); }
    if (i === Math.floor(REQUESTS / 2)) plan.push([`{"id":"big","command":"read","image":"${"A".repeat(65 * 1024 * 1024)}"}`, "big", "too-large"]);
    if (i === Math.floor(REQUESTS * 0.6)) plan.push([JSON.stringify({ id: "bomb", command: "read", image: bombPng.toString("base64") }), "bomb", "bomb"]);
  }

  const proc = spawn(BIN, ["serve"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  });
  const exited = new Promise((r) => proc.on("exit", r));
  for (const [line] of plan) {
    if (!proc.stdin.write(line + "\n")) await new Promise((r) => proc.stdin.once("drain", r));
  }
  proc.stdin.end();
  assert.equal(await exited, 0);

  const ready = JSON.parse(lines[0]);
  assert.deepEqual(ready, { catscan: ready.catscan, id: null, protocol: PROTOCOL, type: "ready", vision_timeout_s: 60, engine: "vision-accurate-rev3", host: ready.host });
  assert.deepEqual(Object.keys(ready.host).sort(), ["arch", "chip", "host_class", "macos", "vision_revision"]);
  const responses = lines.slice(1).map((l) => JSON.parse(l));
  assert.equal(responses.length, plan.length);
  plan.forEach(([, id, kind, code], i) => {
    const r = responses[i];
    assert.equal(r.id, id, `response ${i}`);
    if (kind === "valid") assert.equal(r.verdict, "pass", JSON.stringify(r).slice(0, 300));
    else assert.ok(r.error && r.error.code, `response ${i} has an error`);
    if (code) assert.equal(r.error.code, code, `response ${i}`);
    if (kind === "too-large") assert.equal(r.error.code, "request-too-large");
    if (kind === "bomb") assert.equal(r.error.code, "image-too-large");
  });
  assert.equal(responses.filter((r) => r.verdict === "pass").length, REQUESTS);
  // Every edge case was sent at any request count, not only at 1000.
  for (const kind of ["too-large", "bomb"]) assert.equal(plan.filter((p) => p[2] === kind).length, 1, kind);
  assert.ok(m >= malformed.length, `only ${m} of ${malformed.length} malformed rows sent`);
});

test("catscan-core serve --jobs outside 1...16 or not a number exits 2", () => {
  // Added by /ship coverage audit.
  // Value: protects=catscan-core serve --jobs accepts only integers 1-16 and exits 2 with usage otherwise; fails_when=the main.swift range or Int parse guard is removed or widened; why_new=no test passes --jobs to the binary; seam=none; no_claim=that valid values change parallelism (exit code and usage text only)
  const { spawnSync } = require("child_process");
  for (const j of ["0", "17", "x"]) {
    const r = spawnSync(BIN, ["serve", "--jobs", j], { input: "", encoding: "utf8" });
    assert.equal(r.status, 2, `--jobs ${j}`);
    assert.match(r.stderr, /^usage: catscan-core serve \[--jobs N\]/, `--jobs ${j}`);
    assert.equal(r.stdout, "", `--jobs ${j}`);
  }
});

test("serve: a client refuses a server with a different protocol", async () => {
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-fake-")), "fake-core");
  fs.writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ id: null, type: "ready", catscan: "9.0.0", protocol: ${PROTOCOL + 1} }) + "\\n");\nprocess.stdin.resume();\n`, { mode: 0o755 });
  const s = new Server({ bin: fake });
  await assert.rejects(s.ready, (e) => e.code === "serve-protocol-mismatch" && e.message.includes(`protocol ${PROTOCOL + 1}`) && e.message.includes(`protocol ${PROTOCOL}`));
});

test("serve: the client gets results by path and by base64", async () => {
  const s = new Server({ bin: BIN });
  await s.ready;
  const img = path.join(dir, "03-de-phone.png");
  const [a, b] = await Promise.all([
    s.request({ id: "a", command: "check", path: img, present: ["Weiter"], locale: "de" }),
    s.request({ id: "b", command: "check", image: fs.readFileSync(img).toString("base64"), name: "x.png", present: ["Weiter"], locale: "de" }),
  ]);
  await s.close();
  assert.equal(a.id, "a");
  assert.equal(b.id, "b");
  assert.equal(b.path, "x.png");
  assert.deepEqual(a.checks, b.checks);
});

test("serve: CATSCAN_VISION_TIMEOUT sets the ready line's deadline; an invalid value says so and keeps 60 (TODO-032)", async () => {
  for (const [v, want, warned] of [["2.5", 2.5, false], ["abc", 60, true], ["0", 60, true]]) {
    const err = [];
    const prev = process.env.CATSCAN_VISION_TIMEOUT;
    process.env.CATSCAN_VISION_TIMEOUT = v;
    const s = new Server({ bin: BIN, stderr: (t) => err.push(t) });
    if (prev === undefined) delete process.env.CATSCAN_VISION_TIMEOUT; else process.env.CATSCAN_VISION_TIMEOUT = prev;
    const ready = await s.ready;
    await s.close();
    assert.equal(ready.vision_timeout_s, want, v);
    assert.equal(err.join("").includes(`CATSCAN_VISION_TIMEOUT=${v} is not a positive number of seconds; using 60`), warned, v);
  }
});
