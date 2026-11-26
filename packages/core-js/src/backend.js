// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// One `serve` process per MCP server or Playwright worker, started on first use and replaced at most once per call
// (spec 09 D3, D17; spec 13 D1 moved it here so @catscan/mcp and @catscan/playwright share one copy).

class Backend {
  /** `start()` returns a core-js `Server` (or a test double with `ready`, `dead`, `request`, `close`). */
  constructor(start) {
    this.start = start;
    this.server = null;
    this.closed = false;
  }

  current() {
    // TODO-089 D3: a call after close() would start a core its host no longer waits for.
    if (this.closed) throw Object.assign(new Error("catscan-core is shutting down"), { code: "binary-failed" });
    if (!this.server || this.server.dead) this.server = this.start();
    return this.server;
  }

  /** Runs `fn(server)`; if the backend died during it, starts a new one and runs `fn` again, once. */
  async run(fn) {
    let s = this.current();
    try {
      await s.ready;
      return await fn(s);
    } catch (e) {
      // A protocol mismatch is a version problem a restart cannot fix (D3). After close() the death is the shutdown
      // itself: a restart would leave a core running after its host exits (TODO-089 D3).
      if (this.closed || !s.dead || s.dead.code === "serve-protocol-mismatch") throw e;
      // D17: concurrent calls that saw the same death share one replacement.
      if (this.server === s) this.server = null;
      s = this.current();
      await s.ready;
      return await fn(s);
    }
  }

  async close() {
    this.closed = true;
    const s = this.server;
    this.server = null;
    if (s && !s.dead) await s.close();
  }
}

module.exports = { Backend };
