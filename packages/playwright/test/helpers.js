// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Fakes for the spec 13 unit tests: a serve Server, a page and locator, test.info() and a clock. No binary, no browser.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Backend } = require("@catscan/core-js/src/backend");
const { createMatchers } = require("../src/matchers");
const boxes = require("../src/boxes");
const save = require("../src/save");

/** A PNG header with the given size: enough for core-js imageSize(). */
function png(width = 1280, height = 720) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const TABLE = { languages: [
  { locale: "en", aliases: [] }, { locale: "de", aliases: [] }, { locale: "fr", aliases: [] },
  { locale: "zh-Hans", aliases: ["zh-CN"] }, { locale: "el", aliases: [] },
] };

const envelope = (req, over = {}) => ({
  schema: 1, catscan: "0.0.0", command: req.command, path: req.path, verdict: "pass", engine: "vision-accurate-rev3",
  locale: req.locale, checks: [], findings: [], warnings: [], ...over,
});

/**
 * respond(req, n) -> envelope (n: 1-based count of command requests, readyText checks excluded when `readyCount` is
 * kept apart by the test). Every request advances the fake clock by `attemptMs`.
 */
function harness({ respond = (req) => envelope(req), nav = "en-US", languages = TABLE, attemptMs = 50, defaults = {}, collects = null, extra = null, box = undefined, imageSize = [1280, 720], testId = "t1", preflight = null, startServer = null, media = [], inFrame = false, info = {}, envVars = {}, render = { width: 1280, height: 720, dpr: 1, dark: false }, browser = "chromium" } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pw-"));
  const h = { t: 0, requests: [], shots: 0, stderr: "", skipped: null, starts: 0, tmp };
  const fakeServer = () => {
    h.starts++;
    return {
      ready: Promise.resolve({}), dead: null, proc: { killed: false, kill() { this.killed = true; } }, exited: false,
      async request(req) {
        h.requests.push(req);
        h.t += attemptMs;
        return respond(req, h.requests.length, h);
      },
      async close() {},
    };
  };
  h.backend = new Backend(startServer ? () => { h.starts++; return startServer(h); } : fakeServer);
  h.info = {
    testId, annotations: [], attachments: [],
    outputPath: (name) => path.join(tmp, name),
    async attach(name, o) { h.info.attachments.push({ name, ...o }); },
    // TODO-088: what the save names read.
    project: { name: "", testDir: tmp, use: {} }, file: path.join(tmp, "menu.spec.js"), titlePath: ["menu.spec.js", "shows the menu"], repeatEachIndex: 0,
    ...info,
  };
  h.envVars = envVars;
  let collectIndex = 0;
  h.page = {
    async screenshot(o) { h.shots++; h.lastShot = o; fs.writeFileSync(o.path, png(...imageSize)); },
    async evaluate(fn) {
      if (fn === boxes.collect) { const c = collects ? collects[Math.min(collectIndex, collects.length - 1)] : { viewport: { width: 1280, height: 720 }, dpr: 1, elements: [] }; collectIndex++; return c; }
      if (fn === boxes.pageExtra) return extra || { scrollX: 0, scrollY: 0 };
      if (fn === boxes.mediaRects) return media;
      if (fn === save.pageRender) return h.render;
      return nav;
    },
    context: () => ({ browser: () => ({ browserType: () => ({ name: () => browser }) }) }),
    viewportSize: () => ({ width: h.render.width, height: h.render.height }),
  };
  h.render = render;
  h.locator = {
    page: () => h.page,
    async evaluate() { return !inFrame; }, // window === window.top
    async boundingBox() { return box === undefined ? { x: 0, y: 0, width: 100, height: 100 } : box; },
    async screenshot(o) { h.shots++; h.lastShot = o; fs.writeFileSync(o.path, png(...imageSize)); },
  };
  h.env = {
    backend: () => h.backend,
    preflight: () => { if (preflight) preflight(); },
    languages: () => languages,
    testInfo: () => h.info,
    now: () => h.t,
    sleep: async (ms) => { h.t += ms; },
    stderr: (s) => { h.stderr += s; },
    skip: (reason) => { h.skipped = reason; },
    getenv: (k) => h.envVars[k],
  };
  h.matchers = createMatchers(defaults, h.env);
  h.ctx = (isNot = false, timeout = 5000) => ({ isNot, timeout });
  h.commands = () => h.requests.filter((r) => r.command !== "read");
  return h;
}

module.exports = { harness, envelope, png, TABLE };
