// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 13 fixture suite: the real binary in Chromium and WebKit. One worker: Vision runs stay sequential on a shared Mac.
const path = require("path");
const { defineConfig, devices } = require("@playwright/test");
const { chromiumArgs } = require("../chromium-gpu.js");

module.exports = defineConfig({
  testDir: __dirname,
  // *.pw.js, not *.spec.js: /ship's pregate runs every touched *.spec.* under node --test (docs/gotchas/tests.md).
  testMatch: "*.pw.js",
  outputDir: path.join(__dirname, "../../../../.build/playwright-e2e"),
  forbidOnly: true,
  workers: 1,
  reporter: [["list"]],
  expect: { timeout: 5000 },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: chromiumArgs() } } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
