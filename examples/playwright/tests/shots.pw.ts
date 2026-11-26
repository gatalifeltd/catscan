// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// The matchers write no results file, so the de and de-large projects save the screen under
// shots/<text size>/ and the example's run reads both folders with one `catscan truncated` and one report.
import path from "node:path";
import { test, expect } from "@playwright/test";

test("saves the screen for the text-size report", async ({ page }, testInfo) => {
  await page.goto("");
  await expect(page.locator("#play")).not.toBeEmpty();   // the catalog has loaded and the canvas is drawn
  const size = String(testInfo.project.metadata.textSize ?? "default");
  const locale = String(testInfo.project.use.locale).split("-")[0];
  await page.screenshot({ path: path.join(__dirname, "../shots", size, `game.${locale}.png`) });
});
