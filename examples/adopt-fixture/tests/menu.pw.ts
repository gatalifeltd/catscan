// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Before adoption: the suite takes one screenshot per locale and nobody checks it.
import path from "node:path";
import { test, expect } from "@playwright/test";

const url = "file://" + path.join(__dirname, "../app/index.html");

for (const lng of ["en", "de"]) {
  test(`menu ${lng}`, async ({ page }) => {
    await page.goto(`${url}?lng=${lng}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
    await page.screenshot({ path: path.join(__dirname, `../shots/${lng}/menu.png`) });
  });
}
