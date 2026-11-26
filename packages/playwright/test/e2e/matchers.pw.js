// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 13 fixture suite (Test plan / coverage): every matcher against the real catscan binary, in both browsers.
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const { test, expect: base } = require("@playwright/test");
const { expect, catscanMatchers } = require("../../src/index");

const page = (name, q = "") => pathToFileURL(path.join(__dirname, "pages", name)).href + q;
const catalogs = path.join(__dirname, "pages/locales/{locale}.json");
const names = () => test.info().attachments.map((a) => a.name).filter((n) => n.startsWith("catscan")).sort();
const failure = (p) => p.then(() => null, (e) => e);

test.describe("canvas", () => {
  test("toShowText passes on drawn text, .not on absent text; a wrong text fails with four attachments", async ({ page: p }) => {
    await p.goto(page("canvas.html"));
    await expect(p).toShowText(["GAME OVER", "Score 120"]);
    await expect(p.locator("canvas")).not.toShowText("home.title", { readyText: "GAME OVER" });
    const e = await failure(expect(p).toShowText("LEVEL UP", { timeout: 1000 }));
    base(e && e.message).toContain('expected "LEVEL UP" to be shown; closest line read:');
    base(names()).toEqual(["catscan-lines.txt", "catscan.html", "catscan.json", "catscan.png"]);
  });

  test("a delayed text passes by retrying; .not with readyText fails on the raw key shown with it", async ({ page: p }) => {
    await p.goto(page("canvas.html", "?delay=1"));
    await expect(p).toShowText("Play");
    await p.goto(page("canvas.html", "?delay=1"));
    // A retrying negative check would pass on the first frames, before the raw key is drawn (D2).
    const e = await failure(expect(p).not.toShowText("home.title", { readyText: "Play" }));
    base(e && e.message).toContain('expected "home.title" not to be shown; it matched the line');
  });
});

test.describe("truncation", () => {
  for (const dpr of [1, 2]) {
    test.describe(`device scale factor ${dpr}`, () => {
      test.use({ deviceScaleFactor: dpr, viewport: { width: 900, height: 600 } });

      test("page, locator and fullPage fail on the cut lines; the fixed page passes", async ({ page: p }) => {
        await p.goto(page("truncation.html"));
        const view = await failure(expect(p).toHaveNoTruncation({ readyText: "Settings" }));
        base(view && view.message).toMatch(/"Notifications.*" is cut off/);
        const json = JSON.parse((test.info().attachments.find((a) => a.name === "catscan.json").body).toString());
        base(json.warnings.some((w) => w.code === "boxes-unstable")).toBe(false);
        const loc = await failure(expect(p.locator("#box")).toHaveNoTruncation({ readyText: false }));
        base(loc && loc.message).toMatch(/is cut off/);
        const full = await failure(expect(p).toHaveNoTruncation({ readyText: "Settings", fullPage: true }));
        base(full && full.message).toMatch(/"Delete account.*" is cut off/);
        await p.goto(page("truncation.html", "?fixed=1"));
        await expect(p).toHaveNoTruncation({ readyText: "Settings" });
        await expect(p).toHaveNoTruncation({ readyText: "Settings", fullPage: true });
      });
    });
  }

  test("an animated page says boxes-unstable and still reports its cut line", async ({ page: p }) => {
    await p.goto(page("animated.html"));
    const e = await failure(expect(p).toHaveNoTruncation({ readyText: false, timeout: 1500 }));
    base(e && e.message).toContain("boxes-unstable");
    base(e && e.message).toMatch(/"Notifications.*" is cut off \(ellipsis\)/);
  });
});

test.describe("untranslated", () => {
  test("a canvas raw key and a canvas {count} fail toHaveNoUntranslated", async ({ page: p }) => {
    await p.goto(page("untranslated.html"));
    const e = await failure(expect(p.locator("canvas")).toHaveNoUntranslated({ readyText: "Play" }));
    base(e && e.message).toContain('"home.title" is a raw key');
    base(e && e.message).toContain('is an unfilled placeholder "{count}"');
  });

  test.describe("de context", () => {
    test.use({ locale: "de-DE" });
    const de = base.extend(catscanMatchers({ catalog: catalogs }));

    test("the context locale gives de; a base-locale string fails with base and catalog", async ({ page: p }) => {
      await p.goto(page("untranslated.html", "?english=1"));
      await de(p).toShowText("@home.play");
      const e = await failure(de(p).toHaveNoUntranslated({ readyText: "@home.play", base: path.join(__dirname, "pages/locales/en.json") }));
      base(e && e.message).toContain('"Welcome home" is untranslated');
      base(e && e.message).toContain("locale: de (navigator.language: de-DE)");
    });
  });
});

test("a Tesseract locale (el) passes toShowText", async ({ page: p }) => {
  const langs = spawnSync("tesseract", ["--list-langs"], { encoding: "utf8" });
  test.skip(langs.status !== 0 || !/^ell$/m.test(langs.stdout || ""), "Tesseract with Greek (ell) is not installed: brew install tesseract tesseract-lang");
  await p.goto(page("greek.html"));
  await expect(p).toShowText("Καλημέρα κόσμε", { locale: "el", timeout: 20_000 });
});

// TODO-088: a save folder the CLI-only checks read after the run, with the default layout and the saved boxes.
test("saveDir: en and de shots of one screen feed catscan formats, fit and contrast", async ({ page: p, browserName }) => {
  test.skip(browserName !== "chromium", "one browser is enough for the CLI handoff");
  const dir = test.info().outputPath("saved");
  const saving = base.extend(catscanMatchers({ saveDir: dir }));
  for (const lang of ["en", "de"]) {
    await p.goto(page("shop.html", `?lang=${lang}`));
    await saving(p).toHaveNoTruncation({ locale: lang, readyText: false });
  }
  const cli = (args) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, "../../../../bin/catscan.js"), ...args, "--json"], { encoding: "utf8" });
    base(r.status, `${args[0]}: ${r.stderr}`).toBeLessThan(2); // 0 pass, 1 findings
    base(r.stderr).not.toMatch(/boxes-missing|contrast-scale-unknown|wrap-no-base/);
    const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    base(rows.map((x) => x.locale).sort()).toEqual(["de", "en"]);
    base(new Set(rows.map((x) => x.screen)).size).toBe(1);
    base(rows[0].screen).toMatch(/^chromium-\d+x\d+\/matchers\.pw\/saveDir-en-and-de-.*-[0-9a-f]{6}-1$/);
    for (const x of rows) base(x.warnings.map((w) => w.code)).not.toContain("boxes-missing");
    return rows;
  };
  cli(["formats", dir]);
  // The German button wraps where the English one does not: a wrapped finding against the saved en shot proves pairing.
  const fit = cli(["fit", dir, "--boxes", dir, "--reasons", "wrapped"]).find((x) => x.locale === "de");
  base(fit.findings.map((f) => `${f.reason}/${f.evidence}/${f.element && f.element.id}`)).toContain("wrapped/base/buy");
  base(fit.findings[0].base_path).toContain("/en/chromium-");
  const contrast = cli(["contrast", dir, "--boxes", dir, "--experimental"]);
  base(contrast.every((x) => Array.isArray(x.lines) && x.lines.length > 0)).toBe(true);
});
