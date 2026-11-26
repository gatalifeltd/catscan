// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// @catscan/playwright (spec 13): catscan's checks as Playwright matchers. One catscan-core `serve` per worker (D1),
// started by the first assertion and killed when the worker exits; no fixture to install.
/**
 * The user's own @playwright/test: the copy the runner already loaded, else the one the project resolves. A package
 * installed from a checkout is a symlink whose own require would load the checkout's second copy, which Playwright
 * refuses ("Requiring @playwright/test second time"; docs/gotchas/playwright.md).
 */
function playwrightTest() {
  for (const k of Object.keys(require.cache)) {
    if (/[\\/]node_modules[\\/]@playwright[\\/]test[\\/]index\.js$/.test(k)) return require.cache[k].exports;
  }
  try { return require(require.resolve("@playwright/test", { paths: [process.cwd()] })); } catch {}
  return require("@playwright/test");
}

const { test, expect: baseExpect } = playwrightTest();
const { CatscanError, CatscanUnsupportedPlatformError } = require("./verdict");
const { createMatchers, killOnExit } = require("./matchers");

let backend = null;
let preflightError;
let languages;

function getBackend() {
  if (!backend) {
    const { Server } = require("@catscan/core-js/src/client");
    const { Backend } = require("@catscan/core-js/src/backend");
    const b = new Backend(() => new Server({ jobs: 1 }));
    backend = b;
    process.once("exit", () => killOnExit(b));
  }
  return backend;
}

/** The platform, Node and binary checks, once per worker (D8). */
function preflight() {
  if (preflightError === undefined) {
    preflightError = null;
    try {
      const install = require("@catscan/core-js/src/install");
      // An options object: platformProblem reads o.translated on an Intel Mac or under Rosetta (review).
      const p = install.platformProblem({}) || install.nodeProblem(process.versions.node);
      if (p) throw p;
      require("@catscan/core-js/src/client").binaryPath();
    } catch (e) { preflightError = e; }
  }
  if (preflightError) throw preflightError;
}

/** `catscan languages --json`, read once per worker for the D6 locale resolution; null if it cannot run. */
function languageTable() {
  if (languages === undefined) {
    try { languages = require("@catscan/core-js/src/client").languagesInfo(); } catch { languages = null; }
  }
  return languages;
}

const ENV = {
  backend: getBackend,
  preflight,
  languages: languageTable,
  testInfo: () => test.info(),
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  stderr: (s) => process.stderr.write(s),
  skip: (reason) => test.skip(true, reason),
};

/** The matchers with project defaults, for `expect.extend(catscanMatchers({ catalog: "locales/{locale}.json" }))`. */
function catscanMatchers(defaults = {}) {
  return createMatchers(defaults, ENV);
}

/** D17: Playwright's expect already extended, for the one-line first verdict. */
const expect = baseExpect.extend(catscanMatchers());

module.exports = { expect, catscanMatchers, CatscanError, CatscanUnsupportedPlatformError };
