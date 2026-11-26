# Recipe: Playwright matchers

`@catscan/playwright` adds catscan's checks to an existing Playwright test suite on an Apple silicon Mac.
The matchers read the screenshot with Apple Vision, so they see text that the DOM cannot show: text drawn into a
`<canvas>`, WebGL or video, and text that CSS cuts off.

| Matcher | CLI equivalent | Fails when |
| --- | --- | --- |
| `toShowText(text \| text[], options?)` | `check --present` | a text is not visible; `.not.toShowText` fails when one is (`--absent`) |
| `toHaveNoTruncation(options?)` | `truncated --boxes` | a visible text is cut off; the page's element boxes are collected and passed for you |
| `toHaveNoOverlap(options?)` | `overlap --boxes` | a text is drawn over another text or over an icon, image or control, or texts are stacked at one place (`signal: "stacked"`); the page's element boxes are collected and passed for you |
| `toHaveNoUntranslated(options?)` | `untranslated` | a raw key (`home.title`), an unfilled placeholder (`{count}`), with `base` and `catalog` a base-locale string, or, with a `{locale}` `catalog` template or an `.xcstrings` catalog, a string of another project locale (`wrong-language`) is shown |

## 1. Install

In your own Playwright project, on an Apple silicon Mac (macOS 15 or later, Node 22 or later):

```bash
npm install -D @catscan/playwright
```

npm installs the catscan binary with it.

`@playwright/test` is a peer dependency (`>=1.50.0 <2`); your project's own copy is used.

## 2. See it work

The example is a canvas mini-game page in English and German, plus a `pseudo` project on its `en-XA` pseudo locale ([pseudo recipe](./pseudo.md)). From a clone of the catscan repository (`npm ci`, then `swift build -c release --package-path core`):

```bash
cd examples/playwright && npx playwright test
```

Every test passes. Now add one raw key to the page:

```bash
cd examples/playwright && FAULTS=1 npx playwright test
```

Only the raw-key test fails (once per project: `en`, `de` and `pseudo`), on `menu.quit` drawn into the canvas, with the screenshot boxed in the
attachments (`catscan.png`, `catscan.html`, `catscan-lines.txt`, `catscan.json`).

On macOS the example's Chromium projects pass `--use-angle=metal` (`launchOptions.args` in
`examples/playwright/playwright.config.ts`), so the canvas draws on the GPU instead of the CPU fallback, SwiftShader.

The `de-large` project renders the German page at 200% browser zoom (half the CSS viewport at twice the device scale
factor) and saves the screen under `shots/large/`, beside `de`'s under `shots/default/`, so one
`catscan truncated shots --layout '{text_size}/{screen}.{locale}'` and one report cover both sizes; at 200% the 900 px
canvas is cut at the 640 px viewport edge. Labels, the iOS and Android recipes and the release report:
[`large-text.md`](./large-text.md).

## 3. The first verdict in your own test

One import and one line, no catalog and no config:

```ts
import { test } from "@playwright/test";
import { expect } from "@catscan/playwright"; // Playwright's expect with the catscan matchers

test("home", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveNoUntranslated({ readyText: "Play" });
});
```

It fails on a raw key or an unfilled placeholder drawn anywhere on the screen, canvas included.

## 4. Project setup

`catscanMatchers(defaults)` sets the same options for every assertion of a project:

```ts
// fixtures.ts
import { test, expect as base } from "@playwright/test";
import { catscanMatchers } from "@catscan/playwright";

export { test };
export const expect = base.extend(catscanMatchers({ catalog: "locales/{locale}.json" }));
```

```ts
import { test, expect } from "./fixtures";

await expect(page).toShowText("GAME OVER");
await expect(page.locator("canvas")).toShowText("@hud.score", { readyText: "Score" });
await expect(page).not.toShowText("home.title", { readyText: "@home.play" });
await expect(page).toHaveNoTruncation({ readyText: "@settings.title" });
await expect(page.locator("canvas")).toHaveNoUntranslated({ base: "locales/en.json" });
```

`@key` names a catalog string (`@@x` is the literal text `@x`). Catalog paths are read from the working directory,
as the CLI reads them, and `{locale}` takes the catscan locale. Run `npx playwright test` from the folder the
paths are relative to, or pass absolute paths (`path.join(__dirname, "locales/{locale}.json")`).

Run one Playwright project per locale with `use.locale`:

```ts
// playwright.config.ts
projects: [
  { name: "en", use: { locale: "en-US" } },
  { name: "de", use: { locale: "de-DE" } },
],
```

The locale comes from, in order: the `locale` option, the page's `navigator.language` (which follows the context
`locale` of the project or `test.use`), then `en`. `de-DE` is read as `de`, with a `locale-fallback`
warning in the `catscan-warnings` annotation. A failure message names the locale and its source (`option`,
`navigator.language` or `default en`).

| Option | Matchers | Meaning |
| --- | --- | --- |
| `locale` | all | screen locale; default as above |
| `catalog` | all | one path or a list; enables `@key` |
| `base` | `toHaveNoUntranslated` | the base-locale catalog (`untranslated --base`); needs `catalog` |
| `allow` | `toHaveNoTruncation`, `toHaveNoUntranslated`, `toHaveNoOverlap` | lines never reported; for `toHaveNoOverlap`, element ids or texts |
| `pseudo` | `toShowText`, `toHaveNoTruncation`, `toHaveNoUntranslated` | the page shows a pseudo-locale build (`catscan pseudo`): `catalog` is the base catalog, `en-XA` reads as `en`; adds `pseudo-cut`, `hardcoded` and `pseudo-not-applied` ([pseudo recipe](./pseudo.md)) |
| `minSeverity`, `minCertainty` | `toHaveNoTruncation`, `toHaveNoUntranslated`, `toHaveNoOverlap`, `catscanMatchers()` | only findings at or above both levels fail the test: `"critical"`, `"major"`, `"minor"` (default) and `"high"`, `"medium"`, `"low"` (default); the rest go to `catscan.json`, not the message ([severity and certainty](../cli.md#severity-and-certainty)) |
| `fallback` | all | `tesseract` or `none`; default Tesseract when installed |
| `timeout` | all | default the project's `expect` timeout |
| `mask` | all | locators painted over before the screenshot is read |
| `fullPage` | page only | the whole scrollable page |
| `readyText` | all | text (or `@key`) to wait for before the check; `false`: the first frame is ready |
| `onUnsupported` | `catscanMatchers()` only | `"throw"` (default) or `"skip"`; never skips `needs-reader` |
| `saveDir` | `catscanMatchers()` only | folder for each checked shot and its boxes, for the CLI checks ([step 9](#9-run-the-cli-checks-after-the-test-run)); default `CATSCAN_SAVE_DIR`, else off; `false`: off |
| `screen` | all, per call | the saved shot's screen name instead of the one made from the test title |

## 5. Wait for the screen: `readyText`

Each attempt takes a screenshot, checks `readyText` on it, then runs the check on the same file.

- A positive `toShowText` retries both every 250 ms until it passes or the timeout ends, like Playwright's own matchers.
- `.not.toShowText`, `toHaveNoTruncation`, `toHaveNoOverlap` and `toHaveNoUntranslated` wait only for `readyText`, then check that frame
  once. They never retry into a passing frame: a negative check that retried would pass on any blank or loading frame.
- Without `readyText` they check the first screenshot and print one line to stderr per test. `readyText: false` says
  the first frame is ready and silences it.

Canvas and WebGL text is read like any other text. `toHaveNoTruncation` gets no element boxes for canvas or WebGL
text, iframes or shadow roots, so those regions are checked from the pixels alone (recall 0.877 against 0.992 with
boxes, [`docs/BENCHMARKS.md`](../BENCHMARKS.md)). An element that covers a canvas, video or iframe (an `aria-label` on
the canvas, a labelled wrapper) is left out of the boxes, so the lines drawn there are checked the same way. An
element that animates moves between the two box reads around the screenshot; the matcher retakes it until they
agree, else checks without boxes and says `boxes-unstable`. `toHaveNoOverlap` collects the same boxes (icons, images and
controls too); without them it stops with [`overlap-no-boxes`](#overlap-no-boxes) instead of running the OCR-only
overlap reader, which finds about 1 in 16 overlaps.

Paint over a loading overlay or a clock with `mask`:

```ts
await expect(page).toHaveNoUntranslated({ readyText: "Play", mask: [page.locator(".spinner")] });
```

## 6. Tesseract locales

Locales Vision cannot read (Greek, Hebrew, Bulgarian and the others in [`tesseract.md`](tesseract.md)) are read by
Tesseract when it is installed (`brew install tesseract tesseract-lang`). A Tesseract read is slower than Vision; an
attempt still running at the timeout finishes and counts, but raise `timeout` for those locales:

```ts
await expect(page).toShowText("Γεια σου", { timeout: 15_000 });
```

`fallback: "none"` skips Tesseract for fast local runs: those locales then throw [`needs-reader`](#needs-reader).

## 7. Mixed Linux and Mac CI

catscan needs macOS on Apple silicon. Tag catscan tests `@catscan` and run them in a Mac-only project:

```ts
// playwright.config.ts
const mac = process.platform === "darwin" && process.arch === "arm64";
projects: [
  { name: "web", grepInvert: /@catscan/ },
  ...(mac ? [{ name: "catscan", grep: /@catscan/ }] : []),
],
```

```ts
test("game over @catscan", async ({ page }) => { /* ... */ });
```

As a guard when a tagged test lands on Linux anyway, `catscanMatchers({ onUnsupported: "skip" })` calls
`test.skip()` with the reason. It skips the whole test, including its other assertions, so keep catscan assertions
in their own tests. It never skips a locale catscan reads with Tesseract when Tesseract is missing: that test fails
with the install command ([`needs-reader`](#needs-reader)).

## 8. CI reporters and tested versions

A catscan failure is a Playwright test failure, so the project's own reporters (`github`, `junit`, `html`) carry it;
the HTML reporter shows `catscan.png` inline. The matchers write no `--results` file and no catscan report; to run
the CLI checks on the same screens, save them ([step 9](#9-run-the-cli-checks-after-the-test-run)).

Tested with `@playwright/test` 1.65.1 (Chromium and WebKit) and macOS 27.2.1 on Apple silicon; the
peer floor is 1.50.x. The peer floor and the tested version move only after `npm run test:playwright:floor` and the
fixture suite (`npm run test:playwright`) pass.

## 9. Run the CLI checks after the test run

Number, date and price formats, wrapped text and contrast are CLI checks with no matcher. With a save folder, each
matcher also writes the screenshot it checked and the page's element boxes, and the CLI runs on that folder after
the test run.

Install the CLI next to the matchers, at the same version:

```bash
npm install -D @catscan/cli
```

Turn saving on with `CATSCAN_SAVE_DIR`, or `catscanMatchers({ saveDir: "test-results/catscan" })`. A folder inside
Playwright's `outputDir` (`test-results` by default) is cleared by Playwright at the start of every run, so no shot
from an earlier run is left; clear any other folder yourself before the run. Running only some projects clears it
too, so run the base locale with the others. A relative folder is read from the working directory, as catalog
paths are: run `npx playwright test` from the folder that holds the config, or pass an absolute path.

```bash
CATSCAN_SAVE_DIR=test-results/catscan npx playwright test
```

Then run each check as its own CI step that runs even when an earlier step failed, so one finding never hides the
others:

```bash
npx catscan formats test-results/catscan --results catscan-formats.json
```

```bash
npx catscan fit test-results/catscan --boxes test-results/catscan --reasons wrapped --results catscan-fit.json
```

```bash
npx catscan contrast test-results/catscan --boxes test-results/catscan --experimental --results catscan-contrast.json
```

- `formats` runs its default rules (number, date, mixed currency); add `--storefront <region>` or `--prices <file>`
  for currency and price ([Formats](../cli.md#formats)).
- `fit` is experimental, so the reason is named. Web screenshots have no device profile, so the safe-area reasons do
  not apply; `wrapped` compares each translated screen with the base-locale shot of the same screen.
  `--fail-on-skip` fails a shot that has no boxes.
- `contrast` runs with `--experimental` ([Contrast](../cli.md#contrast)).

A shot is saved as `<locale>/<render>/<spec>/<title>-<hash>-<n>.png` with `<same name>.boxes.json`, which the
CLI's default `--layout '{locale}/{screen}'` reads with no flag:

- `<render>` is the browser, viewport, scale and color scheme (`chromium-1280x720`, `webkit-390x844-3x-dark`), so
  one project per locale shares a screen name across locales, and `fit` pairs them; a pseudo-locale page adds
  `-pseudo`, so its shots never replace the base locale's;
- `<spec>` is the test file, `<title>` the test title with a short hash, and `<n>` the order of the catscan call
  within the test in that locale;
- `screen: "settings"` on one call replaces `<spec>/<title>-<hash>-<n>`, for tests whose titles or order differ per
  locale. It must be unique per locale and render: two calls on one name throw
  [`save-collision`](#save-collision) when they run in one worker. Without a save folder, `screen` does nothing.

Only the last checked frame of each call is saved, pass or fail; a call whose `readyText` never showed saves
nothing. A retry overwrites its own files, and a `repeatEach` repeat adds `-repeat<k>`. The first save in each
worker prints the folder to stderr, and a failure message names the saved file.

With `--shard`, each shard saves in its own job. Copy every shard's folder into one before the CLI steps (a test
runs in one shard, so names never clash, and `fit` pairs locales only within one run); `--expect-locales` and
`--expect-screens` ([results.md](../results.md)) catch a missing shard.

## 10. Troubleshooting

Every thrown error reads `catscan <code>: <what>. Fix: <next step>` and links one of these rows.

### readytext-warning

`catscan: no readyText, the check may run on a loading frame` on stderr: a negative check ran on the first
screenshot. Pass `readyText: "<text shown when the screen is ready>"`, or `readyText: false` when the first frame is
ready.

### readytext-not-shown

The failure says `readyText "..." not shown; the check did not run`: the ready text never appeared before the
timeout. Check the text against `catscan-lines.txt`, or raise `timeout`.

### needs-reader

`catscan needs-reader`: catscan reads this locale (`el`, `he`, `hr` and the other Tesseract locales) with Tesseract,
which is not installed or lacks the language data. The Fix names the command for this Mac, usually
`brew install tesseract tesseract-lang`; rerun the tests afterwards, no restart needed. `onUnsupported: "skip"` does
not skip it. `npx catscan doctor --expect-locales el` checks the setup.

### unsupported

`catscan unsupported`: no reader in catscan reads the locale. Pass `locale` for one that has it;
`catscan languages` lists them.

### unsupported-platform

`CatscanUnsupportedPlatformError` (`unsupported-platform`, `unsupported-os`, `unsupported-node`, `binary-not-found`,
`binary-version-mismatch`): not macOS 15+ on Apple silicon with Node 22+, or the catscan binary is missing. Run the
tests on an Apple silicon Mac and build catscan (step 1); on mixed CI use step 7.

### timeout

A failure on a Tesseract locale that says `raise timeout (one attempt took over half of it)`: pass a larger `timeout`
for that assertion, or `fallback: "none"` for fast local runs.

### vision-timeout

`catscan vision-timeout`: Vision did not answer for one image. Rerun; if it repeats, restart the Mac.
`CATSCAN_VISION_TIMEOUT` raises the per-image wait.

### core-timeout

`catscan core-timeout`: catscan-core stopped answering several times in a row. Rerun the job; if it repeats, run
`npx catscan doctor`.

### missing-catalog

`@key` with no `catalog`: pass `catalog: "locales/{locale}.json"` to the matcher or to `catscanMatchers()`, or write
`@@key` for the literal text `@key`. `base` also needs `catalog`, and so does `pseudo` on `toHaveNoTruncation` and
`toHaveNoUntranslated` (the base catalog, e.g. `catalog: "locales/en.json"`).

### catalog-missing

A `{locale}` catalog has no file for this locale, so every `@key` would be skipped; the matcher throws instead of
passing. Add the file, or pass `locale` for a locale that has one.

### boxes-unstable

The page's element boxes moved around every screenshot until the timeout, so `toHaveNoTruncation` checked without
boxes. Pass `readyText` for a text shown once the page settles, or stop the animation before the assertion. `mask`
does not help: it paints over pixels, while the boxes are read from the live page. Raising `timeout` does not help
either.

### boxes-missing

A `catscan-warnings` annotation: the locator had no bounding box after the screenshot (detached or hidden), or it
sits inside an iframe, whose elements the page script cannot read. The check ran without boxes. Assert on a visible
element of the main document for boxed truncation.

### overlap-no-boxes

`toHaveNoOverlap` got no element boxes: the page never settled, or the locator sits inside an iframe or had no
bounding box. It throws rather than run the OCR-only overlap reader, which finds about 1 in 16 real overlaps.
Settle the page as for `boxes-unstable`, or assert on a visible element of the main document.

### check-skipped

A check was skipped (a catalog string too long to check, a reference with no text, a TypeScript or JavaScript catalog
value catscan cannot read as a literal: `catalog-value-dynamic`), and a skipped check never
passes. Fix the catalog entry the message names, or assert the shown text instead of its `@key`.

### playwright-usage

A matcher was called in a way it does not support: `.not.toHaveNoTruncation`, `.not.toHaveNoOverlap` or `.not.toHaveNoUntranslated` (accept
a known line with `allow: ["<line>"]` instead), `fullPage` on a locator, `onUnsupported` or `saveDir` on one assertion (set them in
`catscanMatchers()`), `screen` in `catscanMatchers()` (it names one call), or an unknown option.

### save-failed

A shot could not be saved to the save folder (not writable, disk full, a folder in the save path that links outside
the save folder); the message names the path and the system error, and no file of that shot is kept. Make the folder writable, or unset `saveDir` and `CATSCAN_SAVE_DIR` to stop
saving, then rerun the test. On a failing check this is a line of the failure message, not a separate error.

### save-collision

Two different calls in one worker saved to the same file: a repeated `screen` value, or two projects that render
the same way (browser, viewport, scale, color scheme) and differ only in state such as the base URL or sign-in,
or two regional variants that catscan reads as one locale (`en-US` and `en-GB` both save under `en`).
Pass a `screen` that is unique per locale and render to one of them. Collisions across workers are not detected,
so keep `screen` values unique.

### serve-protocol-mismatch

The catscan binary and `@catscan/core-js` are different versions. Install the same version of every `@catscan/`
package ([Upgrade](upgrade.md)).

### binary-failed

catscan-core could not start or exited. Run `npx catscan doctor` and rebuild if it says so.

### other-errors

Any other code is catscan's own (for example `unknown-catalog-key`, `catalog-not-found`, `invalid-catalog`): the
message names the file or value and the `Fix:` part names the next step, as in the CLI.
