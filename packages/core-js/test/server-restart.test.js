// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-032 (restart and watchdog) and TODO-009 (stderr filter) against a fake core; no Vision needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Ajv = require("ajv");
const { Server, StderrFilter, VM_NOISE } = require("../src/client");

const FAKE = path.join(__dirname, "fixtures/fake-core.js");
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../../../core/schema/result.schema.json"));

const started = [];

function start(mode, opts = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-fake-")), "log");
  const err = [];
  const s = new Server({ bin: process.execPath, args: [FAKE, mode, log], stderr: (t) => err.push(t), ...opts });
  started.push(s);
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { s, err, lines, pids: () => [...new Set(lines().filter((l) => l.endsWith(" start")).map((l) => l.split(" ")[0]))] };
}

// A failed assertion must not leave a fake core holding this file open. The watchdog windows are seconds, not
// milliseconds: a fresh node fake can take over half a second to start on a loaded machine, and that counts as a stall.
test.afterEach(() => {
  for (const s of started.splice(0)) if (s.proc && !s.exited) s.proc.kill("SIGKILL");
});
const T = { timeout: 30_000 };

const req = (id, p, extra = {}) => ({ id, command: "check", path: p, present: ["x"], ...extra });

test("a stalled request gets a core-timeout envelope; the core is replaced and the rest answered in order", T, async () => {
  const { s, lines, pids } = start("hang-once", { stallMs: 3000 });
  await s.ready;
  const t0 = Date.now();
  const [a, b, c] = await Promise.all([s.request(req("0", "a.png")), s.request(req("1", "b.png")), s.request(req("2", "c.png"))]);
  assert.ok(Date.now() - t0 < 15_000);
  assert.equal(a.verdict, "error");
  assert.equal(a.id, "0");
  assert.equal(a.error.code, "core-timeout");
  assert.equal(a.error.message, "catscan-core gave no answer for a.png within 3 s; catscan restarted it and went on.");
  assert.match(a.error.hint, /^rerun; if it repeats, run catscan doctor/);
  assert.ok(validate(a), JSON.stringify(validate.errors));
  assert.deepEqual([b.path, b.verdict, c.path, c.verdict], ["b.png", "pass", "c.png", "pass"]);
  const [p1, p2] = pids();
  assert.ok(p2, "a second process started");
  for (let i = 0; i < 250 && !lines().includes(`${p1} SIGTERM`); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(lines().includes(`${p1} SIGTERM`), "the stuck process was stopped with SIGTERM (TODO-005 cleanup)");
  assert.deepEqual(lines().filter((l) => l.startsWith(`${p2} req`)).map((l) => JSON.parse(l.slice(l.indexOf("{"))).path), ["b.png", "c.png"]);
  await s.close();
});

test("a vision-timeout answer replaces the core; the old process's later answers are ignored", T, async () => {
  const { s, lines, pids } = start("vt");
  await s.ready;
  const [a, b] = await Promise.all([s.request(req("0", "a.png")), s.request(req("1", "b.png"))]);
  assert.equal(a.error.code, "vision-timeout");
  assert.equal(b.verdict, "pass");
  const [p1, p2] = pids();
  assert.ok(p2, "replaced after vision-timeout");
  // The first process answers b.png too (vt mode keeps answering); only the new process's answer may count.
  assert.equal(b.pid, Number(p2), "b was answered by the new process");
  assert.ok(lines().some((l) => l.startsWith(`${p1} req`) && l.includes("b.png")), "the old process got b.png as well");
  // The cap counts only restarts in a row: a normal answer reset it, so more timeouts keep the run going.
  assert.equal(s.restartsInRow, 0);
  await s.close();
});

test("at the 3rd failure in a row every remaining input gets a core-timeout envelope", T, async () => {
  const { s } = start("hang-all", { stallMs: 1500 });
  // TODO-047: count spawns on the client side. A fake's own "start" log line can come after the next stall kills it
  // on a loaded machine, so the log is no count of processes inside a watchdog window.
  const spawned = [s.proc.pid];
  const spawn = s.start.bind(s);
  s.start = () => { spawn(); spawned.push(s.proc.pid); };
  await s.ready;
  const res = await Promise.all(["a", "b", "c", "d", "e"].map((n, i) => s.request(req(String(i), `${n}.png`))));
  assert.deepEqual(res.map((r) => r.error.code), Array(5).fill("core-timeout"));
  assert.match(res[1].error.message, /no answer for b\.png within 2 s; catscan restarted it and went on\.$/);
  // The 3rd stall in a row gives up: no restart is claimed, and the rest are not checked (3 x the watchdog in all).
  assert.equal(res[2].error.message, "catscan-core gave no answer for c.png within 2 s.");
  assert.equal(res[3].error.message, "catscan-core stopped answering 3 times in a row; d.png was not checked.");
  assert.match(res[4].error.hint, /^rerun the job; if it repeats, restart the Mac; CATSCAN_VISION_TIMEOUT/);
  assert.ok(res.every((r) => validate(r)));
  assert.ok(spawned.every(Number.isInteger), `every spawn got a pid: ${spawned}`);
  assert.equal(spawned.length, 3, `processes started: ${spawned}`);
  assert.equal(new Set(spawned).size, 3, `processes started: ${spawned}`);
  assert.equal(s.dead.code, "core-timeout");
  await assert.rejects(s.request(req("9", "z.png")), (e) => e.code === "core-timeout");
});

test("a resend expands a digest-only untranslated field to the full field", T, async () => {
  const { s, lines, pids } = start("hang-once", { stallMs: 3000 });
  await s.ready;
  const full = { digest: "d1", base: { k: "Hello" }, catalogs: [] };
  await Promise.all([
    s.request(req("0", "a.png", { command: "untranslated", untranslated: full })),
    s.request(req("1", "b.png", { command: "untranslated", untranslated: { digest: "d1" } })),
  ]);
  const p2 = pids()[1];
  const sent = lines().filter((l) => l.startsWith(`${p2} req`)).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
  assert.deepEqual(sent.map((r) => [r.path, r.untranslated]), [["b.png", full]]);
  await s.close();
});

test("a resend expands digest-only fit catalog pairs to the full entries (TODO-074)", T, async () => {
  // Value: protects=a replaced core gets fit.wrap.pairs entries again; fails_when=the resend keeps the digest only and every later same-locale target errors; why_new=only untranslated had a resend test; seam=none; no_claim=the real core's digest cache (fake core)
  const { s, lines, pids } = start("hang-once", { stallMs: 3000 });
  await s.ready;
  const full = { digest: "p1", entries: [["cta", "Jetzt testen", "Try now"]] };
  const fit = (pairs) => ({ command: "fit", fit: { reasons: ["wrapped"], wrap: { base: [], base_path: "en/a.png", pairs } } });
  // Nine more locales' entries go out before the restart: the first locale's entries must survive them.
  const a = s.request(req("0", "a.png", fit(full))); // the first request stalls and the core is replaced
  const more = Array.from({ length: 9 }, (_, k) => s.request(req(`m${k}`, `m${k}.png`, fit({ digest: `q${k}`, entries: [["k", "t", "b"]] }))));
  await Promise.all([a, ...more, s.request(req("1", "b.png", fit({ digest: "p1" })))]);
  const p2 = pids()[1];
  const sent = lines().filter((l) => l.startsWith(`${p2} req`)).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
  assert.deepEqual(sent.filter((r) => r.path === "b.png").map((r) => r.fit.wrap.pairs), [full]);
  await s.close();
});

test("a video request has no client watchdog", T, async () => {
  const { s, pids } = start("hang-all", { stallMs: 50 });
  await s.ready;
  let settled = false;
  s.request(req("0", "v.mp4", { command: "video" })).then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(settled, false);
  assert.equal(pids().length, 1);
  s.proc.kill("SIGKILL");
});

test("core stderr reaches the caller without the VM line (TODO-009)", T, async () => {
  const { s, err } = start("ok");
  await s.ready;
  await s.request(req("0", "a.png"));
  await s.close();
  assert.equal(err.join(""), "other core line\n");
});

test("StderrFilter drops only the exact VM line, across chunks", () => {
  const out = [];
  const f = new StderrFilter((t) => out.push(t));
  f.push(`a\n${VM_NOISE.slice(0, 10)}`);
  f.push(`${VM_NOISE.slice(10)}\nx ${VM_NOISE}\n${VM_NOISE}X\n`);
  f.push(`${VM_NOISE}\nb\nlast`);
  f.end();
  assert.equal(out.join(""), `a\nx ${VM_NOISE}\n${VM_NOISE}X\nb\nlast`);
  const g = [];
  const h = new StderrFilter((t) => g.push(t));
  h.push(VM_NOISE);
  h.end();
  assert.deepEqual(g, []);
});

test("close() during a restart waits for the replacement process too", T, async () => {
  const { s, pids } = start("vt");
  await s.ready;
  const pending = Promise.allSettled([s.request(req("0", "a.png")), s.request(req("1", "b.png"))]);
  await new Promise((r) => setTimeout(r, 0));
  const closed = s.close();
  await pending;
  await closed;
  assert.equal(s.exited, true);
  for (const pid of pids()) assert.throws(() => process.kill(Number(pid), 0), /ESRCH/, `process ${pid} still runs`);
});
