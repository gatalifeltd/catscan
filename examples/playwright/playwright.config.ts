// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// catscan Playwright example: one project per locale, plus the pseudo locale and German at 200% zoom (de-large).
// FAULTS=1 adds ?faults=1, which draws one raw key.
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT || 4173);
// macOS: render on the GPU (Metal) instead of the CPU fallback, SwiftShader.
const chrome = { ...devices["Desktop Chrome"], launchOptions: { args: process.platform === "darwin" ? ["--use-angle=metal"] : [] } };

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results",
  workers: 1,
  reporter: [["list"]],
  // AGENTS.md "GPU in every test": every Chromium project renders with Metal ANGLE.
  use: { baseURL: `http://127.0.0.1:${port}/${process.env.FAULTS === "1" ? "?faults=1" : ""}`, launchOptions: { args: ["--use-angle=metal"] } },
  // The pseudo catalog is a build product: generated here before the server starts, never committed.
  webServer: { command: "node ../../packages/cli/bin/catscan.js pseudo locales/en.json --force && node serve.js", url: `http://127.0.0.1:${port}/index.html`, reuseExistingServer: false, env: { PORT: String(port) } },
  projects: [
    { name: "en", testIgnore: /pseudo\.spec/, use: { ...chrome, locale: "en-US" } },
    // tests/shots.pw.ts only saves the screen catscan reads; de and de-large run it.
    { name: "de", testMatch: [/\.spec\.ts$/, /shots\.pw\.ts$/], testIgnore: /pseudo\.spec/, use: { ...chrome, locale: "de-DE" } },
    // Browser zoom at 200% (text-sizes.tsv "large" on the web) is half the 1280x720 CSS viewport at twice the
    // device scale factor, so media queries and wrapping see what a zoomed page sees. It only saves its screen.
    { name: "de-large", testMatch: /shots\.pw\.ts$/, metadata: { textSize: "large" }, use: { ...chrome, locale: "de-DE", viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 } },
    // The pseudo build.
    { name: "pseudo", testMatch: /pseudo\.spec/, use: { ...chrome, locale: "en-US" } },
  ],
});
