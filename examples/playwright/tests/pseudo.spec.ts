// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// The same game on its pseudo locale (en-XA). The base catalog is the catalog; pseudo: true folds the
// markers, filler words and accents, so a line without them is hardcoded and a lost "]" is a cut.
import { test, expect } from "./fixtures";

const pseudo = { pseudo: true, readyText: "@menu.play" } as const;

test.beforeEach(async ({ page }) => {
  await page.goto(`${process.env.FAULTS === "1" ? "?faults=1&" : "?"}lng=en-XA`);
});

test("every string comes from the pseudo catalog (no hardcoded text, raw key or placeholder)", async ({ page }) => {
  await expect(page).toHaveNoUntranslated(pseudo);
});

test("no pseudo string is cut off", async ({ page }) => {
  await expect(page).toHaveNoTruncation(pseudo);
});

test("the title and game over are shown through the pseudo fold", async ({ page }) => {
  await expect(page.locator("canvas")).toShowText(["@game.title", "@game.over"], { ...pseudo, readyText: "@hud.score" });
});
