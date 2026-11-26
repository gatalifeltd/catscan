// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 18 D15, D17: the report page itself. Screenshots go to .build/report-browser for a person to look at.
const path = require("path");
const { test, expect } = require("@playwright/test");

const url = (name) => "file://" + path.join(process.env.CATSCAN_REPORT_DIR, name);

async function open(page, name) {
  await page.goto(url(name));
  await expect(page.locator("body[data-ready='1']")).toHaveCount(1);
}

for (const scheme of ["light", "dark"]) {
  test(`screenshots of the matrix, contact sheet and image view (${scheme})`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, "embed.html");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe(scheme === "dark" ? "rgb(13, 17, 23)" : "rgb(255, 255, 255)");
    await page.locator("#matrix").screenshot({ path: info.outputPath(`matrix-${scheme}.png`) });
    await page.locator("#sheet").screenshot({ path: info.outputPath(`sheet-${scheme}.png`) });
    await page.locator(".card").first().click();
    await expect(page.locator("#view")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`view-${scheme}.png`) });
  });
}

test("the theme toggle switches light and dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, "embed.html");
  await page.click("#theme");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(13, 17, 23)");
});

test("matrix: the missing locale shows as missing; the coverage line counts cells", async ({ page }) => {
  await open(page, "embed.html");
  await expect(page.locator('[data-cell="fr/home"]')).toHaveText("missing");
  await expect(page.locator(".coverage")).toHaveText("received 5 of 9 expected cells (3 screens x 3 locales), 4 missing, 0 duplicate");
  await page.click('[data-cell="de/home"]');
  await expect(page.locator("#view-path")).toContainText("shots/de/home.png");
});

test("a filter click and arrow-key and Esc navigation", async ({ page }) => {
  await open(page, "embed.html");
  const all = await page.locator(".card").count();
  await page.click('[data-filter="failed"]');
  const failed = await page.locator(".card").count();
  expect(failed).toBeLessThan(all);
  await expect(page.locator(".card .badge.v-pass")).toHaveCount(0);
  await page.fill("#search", "en/raw");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.fill("#search", "");
  await expect(page.locator(".card")).toHaveCount(failed); // the search redraw is debounced
  // Opened from the keyboard (WebKit does not focus a clicked button), so Esc can return focus to the card.
  await page.locator(".card").first().focus();
  await page.keyboard.press("Enter");
  const first = await page.locator("#view-path").textContent();
  // Tab wraps inside the open dialog: from the last control to the first, and back with Shift+Tab.
  const controls = 'button, summary, a[href]';
  await page.locator(`#view :is(${controls})`).last().focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate((c) => document.activeElement === document.querySelectorAll(`#view :is(${c})`)[0], controls)).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate((c) => { const f = document.querySelectorAll(`#view :is(${c})`); return document.activeElement === f[f.length - 1]; }, controls)).toBe(true);
  await page.keyboard.press("ArrowRight");
  expect(await page.locator("#view-path").textContent()).not.toBe(first);
  await page.keyboard.press("ArrowLeft");
  expect(await page.locator("#view-path").textContent()).toBe(first);
  await page.keyboard.press("Escape");
  await expect(page.locator("#view")).toBeHidden();
  expect(await page.evaluate(() => document.activeElement.classList.contains("card"))).toBe(true);
});

test("hovering a finding highlights its box", async ({ page }) => {
  await open(page, "embed.html");
  await page.click('[data-filter="failed"]');
  await page.locator(".card").first().click();
  const entry = page.locator(".entries li").first();
  await entry.hover();
  await expect(page.locator("#view rect.hl")).toHaveCount(1);
});

test("no network: the page makes zero requests beyond itself", async ({ page }) => {
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await open(page, "embed.html");
  await page.locator(".card").first().click();
  expect(requests.filter((u) => !u.startsWith("data:") && u !== url("embed.html"))).toEqual([]);
});

test("link mode opened from file:// shows its images", async ({ page }) => {
  await open(page, "link.html");
  const imgs = page.locator(".card img");
  expect(await imgs.count()).toBeGreaterThan(0);
  expect(await imgs.evaluateAll((els) => els.every((e) => e.getAttribute("src").startsWith("shots/")))).toBe(true);
  await expect.poll(() => imgs.evaluateAll((els) => els.every((e) => e.complete && e.naturalWidth > 0))).toBe(true);
});

test("injected markup renders as text, and the CSP blocks any script without the hash", async ({ page }) => {
  const violations = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await open(page, "evil.html");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(page.locator('.card[data-path*="onerror"]')).toHaveCount(1);
  await page.locator('.card[data-path*="onerror"]').click();
  await expect(page.locator(".entries li").first()).toContainText("</script><script>window.__pwned=1</script>");
  expect(await page.locator("#app img[src='x']").count()).toBe(0);
  // A script added at run time without the hash does not run.
  const ran = await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__injected = 1";
    document.body.appendChild(s);
    return window.__injected;
  });
  expect(ran).toBeUndefined();
});

// TODO-038 T3: the changed-only review surface, from baseline.cells[] as the CLI wrote it.
test("baseline: a mark per change state, the summary header and the needs-review filter on by default", async ({ page }, info) => {
  await open(page, "baseline.html");
  await page.locator("header").screenshot({ path: info.outputPath("baseline-header.png") });
  await expect(page.locator("#baseline-summary")).toHaveText(/^baseline .*: 1 of 4 cells text unchanged and passing \(25%\), 3 to review \(1 changed, 1 new, 1 ambiguous/);
  await expect(page.locator("#baseline")).toContainText("text matches baseline (normalized)");
  await expect(page.locator("#baseline")).toContainText("images, layout and colors are not compared");
  await expect(page.locator("#baseline")).toContainText("1 of 4 received cells skippable; excluded: 0 missing, 0 unmapped");
  await expect(page.locator("#review-only")).toBeChecked();
  await expect(page.locator('[data-cell="de/home"] [data-change="changed"]')).toHaveCount(1);
  await expect(page.locator('[data-cell="en/extra"] [data-change="new"]')).toHaveCount(1);
  await expect(page.locator('[data-cell="de/raw"] [data-change="ambiguous"]')).toHaveCount(1);
  await expect(page.locator('td.gone[data-cell="en/raw"]')).toHaveText("gone");
  await expect(page.locator('[data-cell="en/home"]')).toHaveClass(/skip/);
  await expect(page.locator('[data-cell="en/home"] [data-change]')).toHaveCount(0);
  // Filter on: the skippable cell is hidden in the matrix and the sheet; off: it is back, dimmed.
  await expect(page.locator('[data-cell="en/home"]')).toBeHidden();
  await expect(page.locator('td.gone[data-cell="en/raw"]')).toBeHidden(); // its row stays for de/raw
  await expect(page.locator('.card[data-path="next/de/home.png"] [data-change="changed"]')).toHaveAttribute("aria-label", "text changed");
  await expect(page.locator("#shown")).toContainText("(needs review only)");
  await expect(page.locator('.card[data-path="next/en/home.png"]')).toHaveCount(0);
  const reviewed = await page.locator(".card").count();
  expect(reviewed).toBe(4); // de/home, en/extra, de/raw png and jpg
  await page.uncheck("#review-only");
  await expect(page.locator('[data-cell="en/home"]')).toBeVisible();
  await expect(page.locator('td.gone[data-cell="en/raw"]')).toBeVisible();
  await expect(page.locator(".card")).toHaveCount(reviewed + 1);
  await page.locator("#matrix").screenshot({ path: info.outputPath("baseline-matrix.png") });
  await page.click('[data-cell="en/home"]');
  await expect(page.locator("#view-change")).toContainText("skippable: text unchanged and passing");
});

test("baseline: the image view of a changed cell lists added and removed lines; digest mode shows no line text", async ({ page }, info) => {
  await open(page, "baseline.html");
  await page.click('[data-cell="de/home"]');
  await page.screenshot({ path: info.outputPath("baseline-view.png") });
  await expect(page.locator("#view-change")).toContainText("needs review: text changed");
  expect(await page.locator("#view-change .diff.added li").count()).toBeGreaterThan(0);
  expect(await page.locator("#view-change .diff.removed li").count()).toBeGreaterThan(0);
  await open(page, "digest.html");
  await page.click('[data-cell="de/home"]');
  await expect(page.locator("#view-change")).toContainText("--text-record digest");
  await expect(page.locator("#view-change .diff")).toHaveCount(0);
});

test("baseline: recognized text in the line diff and minor_diff renders as text; minor_diff is collapsed", async ({ page }) => {
  await open(page, "evil-baseline.html");
  await page.click('[data-cell="de/home"]');
  await expect(page.locator("#view-change .diff.added li").first()).toContainText("+ </script><script>window.__pwned=1</script>");
  await expect(page.locator("#view-change .diff.added li.more")).toHaveText("3 more");
  await page.keyboard.press("Escape");
  await page.uncheck("#review-only");
  await expect(page.locator('[data-cell="en/home"] [data-change="minor"]')).toHaveText("minor OCR difference");
  await page.click('[data-cell="en/home"]');
  const minor = page.locator("#view-change details.minor");
  await expect(minor).not.toHaveAttribute("open", /.*/);
  await minor.locator("summary").click();
  await expect(minor.locator(".diff.added li")).toContainText("</script><script>window.__pwned=1</script>");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator("#app img[src='x']").count()).toBe(0);
});

test("devices (TODO-075): sub-columns, the device filter on matrix, sheet and coverage line, up/down between a cell's devices", async ({ page }, info) => {
  await open(page, "devices.html");
  await expect(page.locator("#matrix tr.devices th")).toHaveText(["android", "ios", "android", "ios"]);
  await expect(page.locator("#coverage-line")).toHaveText("received 5 of 8 expected cells (2 screens x 2 locales x 2 devices), 3 missing, 0 duplicate");
  await expect(page.locator('[data-cell="android/de/raw"]')).toHaveText("missing");
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator("#matrix").screenshot({ path: info.outputPath(`devices-matrix-${scheme}.png`) });
  }
  const all = await page.locator(".card").count();
  await page.click('[data-device-filter="android"]');
  await expect(page.locator("#coverage-line")).toHaveText("received 2 of 4 expected cells (2 screens x 2 locales), 2 missing, 0 duplicate");
  await expect(page.locator('#matrix td[data-device="ios"]:visible')).toHaveCount(0);
  await expect(page.locator(".card")).toHaveCount(2);
  expect(all).toBe(5);
  await page.click('[data-device-filter=""]');
  await expect(page.locator(".card")).toHaveCount(5);
  // The iOS de/home cell, then down to its Android twin and back up.
  await page.click('[data-cell="ios/de/home"]');
  await expect(page.locator("#view-cell")).toContainText("ios / de / home");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#view-cell")).toContainText("android / de / home");
  await expect(page.locator("#view-path")).toContainText("devices/android/de/home.png");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#view-path")).toContainText("devices/ios/de/home.png");
});

test("text sizes (TODO-076): size sub-columns, the large text badge and filter, up/down between a cell's sizes", async ({ page }) => {
  await open(page, "sizes.html");
  await expect(page.locator("#matrix tr.devices th")).toHaveText(["default", "large", "default", "large"]);
  await expect(page.locator("#coverage-line")).toHaveText("received 4 of 4 expected cells (1 screens x 2 locales x 2 text sizes), 0 missing, 0 duplicate");
  await expect(page.locator('[data-cell="large/en/home"] .tag:not(.sev)')).toHaveText(["large text"]);
  await expect(page.locator('[data-cell="large/de/home"] .tag:not(.sev)')).toHaveCount(0);
  await expect(page.locator(".card")).toHaveCount(4);
  await page.click('[data-filter="large-text"]');
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card")).toContainText("sizes/large/en/home.png");
  await page.click('[data-filter="all"]');
  // The default de/home cell, then down to its large twin and back up.
  await page.click('[data-cell="default/de/home"]');
  await expect(page.locator("#view-cell")).toContainText("default / de / home");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#view-path")).toContainText("sizes/large/de/home.png");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#view-path")).toContainText("sizes/default/de/home.png");
});
