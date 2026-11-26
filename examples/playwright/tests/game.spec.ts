// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Every catscan matcher on a canvas game, in each locale project.
import { test, expect } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.goto("");
});

test("the canvas shows the title, the score and game over", async ({ page }) => {
  await expect(page.locator("canvas")).toShowText(["@game.title", "@game.over"], { readyText: "@hud.score" });
});

test("the pause text is not shown", async ({ page }) => {
  await expect(page).not.toShowText("@game.paused", { readyText: "@menu.play" });
});

test("no text is cut off", async ({ page }) => {
  await expect(page).toHaveNoTruncation({ readyText: "@menu.play" });
});

test("no raw key or unfilled placeholder is shown", async ({ page }) => {
  await expect(page).toHaveNoUntranslated({ readyText: "@menu.play" });
});
