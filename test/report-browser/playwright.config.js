// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 18 D15: the report page in Chromium and WebKit, opened from file:// as a CI artifact is.
const path = require("path");
const { defineConfig, devices } = require("@playwright/test");
const { chromiumArgs } = require("../../packages/playwright/test/chromium-gpu.js");

module.exports = defineConfig({
  testDir: __dirname,
  // Not *.spec.js: the pregate runs touched *.spec.* files under node --test (same as packages/playwright/test/e2e).
  testMatch: "*.pw.js",
  outputDir: path.join(__dirname, "../../.build/report-browser"),
  globalSetup: require.resolve("./setup.js"),
  forbidOnly: true,
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: chromiumArgs() } } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
