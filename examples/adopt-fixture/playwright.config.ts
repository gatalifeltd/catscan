// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// The catscan-adopt fixture: a canvas menu in two locales, screenshots per locale.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  // Not *.spec.ts: node --test would pick up *.spec.ts files and run them as Node tests.
  testMatch: "**/*.pw.ts",
  outputDir: "test-results",
  workers: 1,
  reporter: [["list"]],
  // AGENTS.md "GPU in every test": Chromium renders with Metal ANGLE, never SwiftShader.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--use-angle=metal"] } } }],
});
