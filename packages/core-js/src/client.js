// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Binary launcher and `serve` client, shared by cli, mcp and playwright (spec 00).
const { spawn, spawnSync, execFileSync } = require("child_process");

const PROTOCOL = 23; // 2: catalog checks and inventory (spec 02); 3: untranslated (spec 17); 4: video (spec 07); 5: truncated (spec 06); 6: thumbnail (spec 18); 7: overlap (spec 12); 8: truncated overflow (TODO-036); 9: text_record (TODO-038); 10: pseudo (TODO-039); 11: overlap boxes and allow (TODO-046); 12: overlap occlusion, boxes panel and scrolls (TODO-049); 13: wrong_language (TODO-036 T2); 14: formats (TODO-036 T3); 15: uncatalogued (TODO-036 T4); 16: overlap stacked (TODO-067); 17: glyphs (TODO-036 T5); 18: fit (TODO-073); 19: fit orientation portrait-upside-down (TODO-073 D39); 20: fit wrapped and orphan (TODO-074); 21: contrast (TODO-054); 23: overlap geometry, stacked default-on (TODO-067 D17)

const install = require("./install");

const { CatscanError } = install;

/** The catscan-core binary path: $CATSCAN_CORE_BINARY, @catscan/cli-darwin-arm64, or a repo build (spec 08). */
function binaryPath(opts) { return install.resolveBinary(opts).path; }

function versionInfo(bin = binaryPath()) {
  return JSON.parse(execFileSync(bin, ["version", "--json"], { encoding: "utf8" }));
}

/** The language table against this Mac's Vision (spec 04): `catscan-core languages`. */
function languagesInfo(bin = binaryPath()) { return coreJSON(bin, "languages"); }

/** Version, host and the Tesseract fallback (spec 03): `catscan-core doctor`. */
/** `locales`: TODO-065 T3, a reader and a self-test per listed locale. */
function doctorInfo(bin = binaryPath(), locales = null) { return coreJSON(bin, "doctor", locales ? ["--expect-locales", locales.join(",")] : []); }

function coreJSON(bin, command, extra = []) {
  // A hung Vision daemon must not hang the CLI.
  const r = spawnSync(bin, [command, ...extra], { encoding: "utf8", timeout: 60000 });
  if (r.error) throw new CatscanError("binary-failed", `cannot start ${bin}: ${r.error.message}`, "check CATSCAN_CORE_BINARY or rebuild catscan-core");
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = null; }
  // A failed language query arrives as { error } with exit 5 (TODO-003 D9).
  if (r.status !== 0 || !out || out.error) {
    const why = r.signal ? `was killed by ${r.signal}` : `exited ${r.status}`;
    const first = (r.stderr || "").split("\n").find(Boolean);
    const e = out?.error || { code: "binary-failed", message: `catscan-core ${command} ${why}${first ? `: ${first}` : ""}`, hint: "rebuild catscan-core" };
    throw new CatscanError(e.code, e.message, e.hint);
  }
  return out;
}

/** Vision on a GitHub macOS VM writes this to stderr; it is not catscan's output (TODO-009). */
const VM_NOISE = "IOServiceMatchingfailed for: AppleM2ScalerParavirtDriver";

/** Passes catscan-core stderr on line by line, dropping only the exact `VM_NOISE` line (TODO-009 D1). */
class StderrFilter {
  constructor(write) { this.out = write; this.buf = ""; }

  push(chunk) {
    this.buf += chunk;
    let out = "", nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line !== VM_NOISE) out += line + "\n";
    }
    if (out) this.out(out);
  }

  end() {
    if (this.buf && this.buf !== VM_NOISE) this.out(this.buf);
    this.buf = "";
  }
}

/** Failures in a row (stalls or vision-timeouts) with no normal answer between them at which the client gives up (TODO-032 D2). */
const MAX_RESTARTS = 3;
/** Added to the core's per-image Vision deadline: two Tesseract reads of 60 s each plus 30 s (TODO-032 D3). */
const STALL_SLACK_MS = 150_000;

/**
 * A running `serve` process. `request()` resolves with the response object for that request;
 * responses come back in request order. TODO-032: the process is replaced after a `vision-timeout` answer or
 * when the oldest request gets no answer within the watchdog; the requests still pending are sent again.
 */
class Server {
  constructor({ bin = binaryPath(), jobs = 2, args = null, stallMs = null, stderr = (s) => process.stderr.write(s) } = {}) {
    this.bin = bin;
    this.args = args || ["serve", "--jobs", String(jobs)];
    this.stallOverride = stallMs;
    this.stderrOut = stderr;
    this.waiting = []; // { req, resolve, reject, since }
    this.digests = new Map(); // "<field>:<digest>" -> full untranslated or pseudo field, for resends (spec 17 D32)
    this.restartsInRow = 0;
    this.timer = null;
    this.readySettled = false;
    this.ready = new Promise((resolve, reject) => { this.onReady = { resolve, reject }; });
    this.ready.catch(() => {});
    this.start();
  }

  start() {
    const proc = spawn(this.bin, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.buf = "";
    this.isReady = false;
    this.exited = false;
    // TODO-032 D4: a replaced process's late lines and exit must never touch the requests.
    const live = () => this.proc === proc;
    const filter = new StderrFilter(this.stderrOut);
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => { if (live()) this.onData(d, proc); });
    proc.stderr.on("data", (d) => filter.push(d));
    proc.stderr.on("end", () => filter.end());
    proc.on("error", (e) => { if (live()) this.die(new CatscanError("binary-failed", `could not start catscan-core: ${e.message}`)); });
    proc.on("exit", (code, signal) => {
      if (!live()) return;
      this.exited = true;
      this.die(new CatscanError("binary-failed", `catscan-core exited (${signal || code}) with requests pending`));
    });
    proc.stdin.on("error", () => {});
  }

  onData(d, proc) {
    // Search only the new bytes: a video response with frames can be tens of MB (spec 07 review).
    let from = this.buf.length;
    this.buf += d;
    let nl;
    while (this.proc === proc && (nl = this.buf.indexOf("\n", from)) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      from = 0;
      let obj;
      try { obj = JSON.parse(line); } catch {
        return this.die(new CatscanError("binary-failed", "catscan-core wrote a line that is not JSON"));
      }
      if (!this.isReady) {
        if (obj.type !== "ready") return this.die(new CatscanError("binary-failed", "catscan-core did not send the ready line first"));
        if (obj.protocol !== PROTOCOL) {
          return this.die(new CatscanError("serve-protocol-mismatch",
            `catscan-core speaks serve protocol ${obj.protocol}, this client speaks protocol ${PROTOCOL}`,
            "install matching versions of @catscan/cli and its binary"));
        }
        this.isReady = true;
        this.info = obj;
        if (!this.readySettled) { this.readySettled = true; this.onReady.resolve(obj); }
        continue;
      }
      const w = this.waiting.shift();
      if (!w) continue;
      w.resolve(obj);
      if (obj.error && obj.error.code === "vision-timeout") {
        // The abandoned Vision call may hold its thread for good; a fresh process read the same screens (D2).
        this.replace();
      } else {
        this.restartsInRow = 0;
        this.arm();
      }
    }
  }

  stallMs() { return this.stallOverride ?? (this.info?.vision_timeout_s ?? 60) * 1000 + STALL_SLACK_MS; }

  /** The watchdog for the oldest pending request; video has none (D3). */
  arm() {
    clearTimeout(this.timer);
    this.timer = null;
    const head = this.waiting[0];
    if (!head || this.dead || head.req.command === "video") return;
    head.since ??= Date.now();
    this.timer = setTimeout(() => this.onStall(), Math.max(0, head.since + this.stallMs() - Date.now()));
    this.timer.unref();
  }

  onStall() {
    const head = this.waiting.shift();
    if (!head) return;
    const s = Math.round(this.stallMs() / 1000);
    const last = this.restartsInRow + 1 >= MAX_RESTARTS;
    head.resolve(this.failed(head, `catscan-core gave no answer for ${this.inputName(head.req)} within ${s} s${last ? "." : "; catscan restarted it and went on."}`,
      "rerun; if it repeats, run catscan doctor and report it with catscan --version"));
    this.replace();
  }

  /** Stops the current process and starts a new one for the pending requests, or gives up past the cap (D2). */
  replace() {
    clearTimeout(this.timer);
    this.timer = null;
    const old = this.proc;
    this.proc = null; // detaches the old listeners before anything else (D4)
    old.stdout.destroy();
    old.unref(); // a core stuck in the kernel must not keep this process alive
    old.kill("SIGTERM"); // TODO-005: serve removes its Tesseract temp files on SIGTERM
    const force = setTimeout(() => {
      old.kill("SIGKILL");
      old.stdin.destroy();
      old.stderr.destroy();
    }, 2000);
    force.unref();
    old.once("exit", () => clearTimeout(force));
    if (++this.restartsInRow >= MAX_RESTARTS) {
      const err = new CatscanError("core-timeout", `catscan-core stopped answering ${MAX_RESTARTS} times in a row`,
        "rerun the job; if it repeats, restart the Mac; CATSCAN_VISION_TIMEOUT raises the per-image wait");
      for (const w of this.waiting.splice(0)) {
        w.resolve(this.failed(w, `catscan-core stopped answering ${MAX_RESTARTS} times in a row; ${this.inputName(w.req)} was not checked.`, err.hint));
      }
      this.dead = err;
      this.exited = true;
      return;
    }
    this.start();
    for (const w of this.waiting) {
      w.since = null;
      this.send(w.req, true);
    }
    if (this.closing) this.proc.stdin.end(); // close() waits for this process too
    this.arm();
  }

  inputName(req) { return req.name ?? req.path ?? "the input"; }

  /** A client-built answer in the core's own shape: an error envelope, or `{ id, error }` for a thumbnail (D5, D6). */
  failed(w, message, hint) {
    const { req } = w;
    const error = { code: "core-timeout", message, hint };
    if (req.command === "thumbnail") return { id: req.id ?? null, error };
    const info = this.info || {};
    const env = {
      schema: 1, catscan: info.catscan ?? null, command: req.command, path: req.name ?? req.path ?? null, verdict: "error",
      engine: info.engine ?? null, locale: req.locale ?? "en", image: null, screen: null, device: null, platform: null, text_size: null, host: info.host ?? null,
      ms: Date.now() - w.sent, checks: [], findings: [], warnings: [], error,
    };
    if (req.command === "video") Object.assign(env, { video: null, frames: 0 });
    if (req.id !== undefined) env.id = req.id;
    return env;
  }

  send(req, resend = false) {
    let out = req;
    // TODO-039 T2, TODO-036 T4: pseudo and uncatalogued are cached by digest the same way; a restart resends each.
    for (const field of ["untranslated", "pseudo", "uncatalogued"]) {
      const u = req[field];
      if (!u || typeof u.digest !== "string") continue;
      const id = `${field}:${u.digest}`;
      // pseudo and uncatalogued carry dynamic_rects per image beside the digest; only the catalog part is cached.
      const perImage = ["digest", "dynamic_rects", "dynamic_size"];
      const cached = field !== "untranslated" ? Object.keys(u).some((k) => !perImage.includes(k)) : Object.keys(u).length > 1;
      if (cached) {
        this.digests.delete(id);
        this.digests.set(id, u);
        if (this.digests.size > 8) this.digests.delete(this.digests.keys().next().value);
      } else if (resend && this.digests.has(id)) {
        // A new process has no digest cache: send the full field again (spec 17 D32).
        const full = this.digests.get(id);
        if (field !== "untranslated") {
          const { dynamic_rects: _r, dynamic_size: _s, ...catalogPart } = full;
          out = { ...out, [field]: { ...catalogPart, ...(u.dynamic_rects ? { dynamic_rects: u.dynamic_rects, dynamic_size: u.dynamic_size } : {}) } };
        } else out = { ...out, [field]: full };
      }
    }
    // TODO-074: fit's catalog pairs are cached by digest in the core the same way; a restart resends the entries.
    // Kept apart and uncapped (one per target locale): the CLI sends every target at once, so a capped map would
    // drop an early locale's entries while its digest-only targets still wait.
    const pairs = req.fit?.wrap?.pairs;
    if (pairs && typeof pairs.digest === "string") {
      this.pairs = this.pairs || new Map();
      if (pairs.entries) this.pairs.set(pairs.digest, pairs);
      else if (resend && this.pairs.has(pairs.digest)) {
        out = { ...out, fit: { ...out.fit, wrap: { ...out.fit.wrap, pairs: this.pairs.get(pairs.digest) } } };
      }
    }
    this.proc.stdin.write(JSON.stringify(out) + "\n");
  }

  die(err) {
    this.dead = this.dead || err;
    clearTimeout(this.timer);
    if (!this.readySettled) { this.readySettled = true; this.onReady.reject(err); }
    for (const w of this.waiting.splice(0)) w.reject(err);
    if (this.proc && !this.exited) this.proc.kill();
  }

  request(req) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.waiting.push({ req, resolve, reject, since: null, sent: Date.now() });
      this.send(req);
      if (this.waiting.length === 1) this.arm();
    });
  }

  /** Ends stdin and waits for the process to exit, including one started by a restart meanwhile. */
  async close() {
    this.closing = true;
    while (this.proc && !this.exited) {
      const p = this.proc;
      p.stdin.end();
      await new Promise((resolve) => (p.exitCode !== null || p.signalCode !== null ? resolve() : p.once("exit", resolve)));
      if (this.proc === p) break;
    }
  }
}

module.exports = { binaryPath, versionInfo, languagesInfo, doctorInfo, Server, StderrFilter, VM_NOISE, CatscanError, PROTOCOL };
