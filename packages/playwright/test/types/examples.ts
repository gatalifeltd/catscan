// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 13 D13 type test (`tsc -p packages/playwright/test/types`): the five interface examples compile; a wrong option
// type and fullPage on a locator do not (each @ts-expect-error fails the build if the line compiles).
import { test, expect as base } from "@playwright/test";
import { catscanMatchers, expect as preExtended } from "@catscan/playwright";

const expect = base.extend(catscanMatchers({ catalog: "locales/{locale}.json", onUnsupported: "skip" }));

test("examples", async ({ page }) => {
  await preExtended(page).toHaveNoUntranslated({ readyText: "Play" });
  await expect(page).toShowText("GAME OVER");
  await expect(page.locator("canvas")).toShowText("@hud.score", { readyText: "Score" });
  await expect(page).not.toShowText("home.title", { readyText: "@home.play" });
  await expect(page).toHaveNoTruncation({ readyText: "@settings.title" });
  await expect(page).toHaveNoOverlap({ readyText: "Play", allow: ["avatar-badge"] });
  await expect(page.locator("canvas")).toHaveNoUntranslated({ base: "locales/en.json" });
  await expect(page).toShowText(["Score", "Lives"], { fullPage: true, readyText: false, mask: [page.locator(".clock")], fallback: "none", timeout: 10_000 });
  await preExtended(page.locator("h1")).toHaveText(/./);

  // @ts-expect-error timeout is a number
  await expect(page).toShowText("x", { timeout: "5s" });
  // @ts-expect-error fullPage applies to a page, not a locator
  await expect(page.locator("canvas")).toShowText("x", { fullPage: true });
  await expect(page).toHaveNoUntranslated({ pseudo: true, catalog: "locales/en.json" });
  // @ts-expect-error pseudo is not an overlap option
  await expect(page).toHaveNoOverlap({ pseudo: true });
  // @ts-expect-error base belongs to toHaveNoUntranslated
  await expect(page).toHaveNoTruncation({ base: "locales/en.json" });
  // @ts-expect-error base belongs to toHaveNoUntranslated
  await expect(page).toHaveNoOverlap({ base: "locales/en.json" });
  // @ts-expect-error onUnsupported is a project default, not an assertion option
  await expect(page).toShowText("x", { onUnsupported: "skip" });
  await expect(page).toHaveNoTruncation({ screen: "settings" });
  // @ts-expect-error saveDir is a project default, not an assertion option
  await expect(page).toShowText("x", { saveDir: "test-results/catscan" });
});

base.extend(catscanMatchers({ saveDir: "test-results/catscan" }));
base.extend(catscanMatchers({ saveDir: false }));
// @ts-expect-error screen names one call's shot, not a project default
base.extend(catscanMatchers({ screen: "settings" }));
