# Large system text

Users set large system text (iOS Dynamic Type, Android font scale, browser zoom), and layouts that fit at the default size break: labels cut with an ellipsis, text pushed past its container or off the screen, titles that wrap. catscan's checks find these on a screenshot already; this recipe captures the same screens at a large size, keeps the sizes apart with `--text-size`, and renders one report where each locale column splits into the sizes and the `large text` filter shows the cells that pass at `default` and fail at a larger size.

## Labels

Two portable labels cover the common case on every platform, so one `--expect-text-sizes default,large` is valid in a combined iOS, Android and web report:

| Label | iOS (`simctl ui content_size`) | Android (`font_scale`) | Web (page zoom) |
| --- | --- | --- | --- |
| `default` | `large` (the iOS default) | `1.0` | `100%` |
| `large` | `accessibility-extra-extra-extra-large` (AX5, the maximum) | `2.0` (the maximum) | `200%` |

`large` is each platform's largest system text size, not the same absolute scale everywhere:

- **iOS:** AX5, the largest accessibility size. SwiftUI text styles and UIKit labels with `adjustsFontForContentSizeCategory` grow to it.
- **Android:** font scale 2.0, the largest the system settings offer. Android 14 and later scale large text non-linearly up to 2.0, so a 34 sp title grows less than 14 sp body text.
- **Web:** 200% browser zoom, the size WCAG 1.4.4 asks a page to survive.

Teams that test several sizes use exact labels. The report orders them after `default` and `large` in this order, then any other label by code point:

| Exact label | iOS | Android | Web |
| --- | --- | --- | --- |
| `xl` | `extra-large` | - | - |
| `xxl` | `extra-extra-large` | - | - |
| `xxxl` | `extra-extra-extra-large` | - | - |
| `ax1` | `accessibility-medium` | - | - |
| `ax2` | `accessibility-large` | - | - |
| `ax3` | `accessibility-extra-large` | - | - |
| `ax4` | `accessibility-extra-extra-large` | - | - |
| `ax5` | `accessibility-extra-extra-extra-large` | - | - |
| `fs1.3` | - | `1.3` | - |
| `fs1.5` | - | `1.5` | - |
| `fs1.8` | - | `1.8` | - |
| `fs2.0` | - | `2.0` | - |
| `zoom150` | - | - | `150%` |
| `zoom200` | - | - | `200%` |

The mapping lives once, in [`examples/maestro/text-sizes.tsv`](../../examples/maestro/text-sizes.tsv); `run-all.sh`, the Playwright example and these tables are tested against it. A label is lowercase `a-z`, `0-9`, `.`, `_` and `-`.

## Capture

Each recipe sets the size, captures the same flows, and sets the default back even when a flow fails. Then catscan reads the screenshots with `--text-size <label>`, or with a `{text_size}/` folder in the layout (`--layout '{text_size}/{screen}.{locale}'`, after an optional `{device}/`).

### iOS simulator

```sh
xcrun simctl ui "$MAESTRO_UDID" content_size accessibility-extra-extra-extra-large
xcrun simctl shutdown "$MAESTRO_UDID"; xcrun simctl boot "$MAESTRO_UDID"; xcrun simctl bootstatus "$MAESTRO_UDID" -b
# ... run the flows; Maestro's launchApp relaunches the app, so every flow starts at the new size
xcrun simctl ui "$MAESTRO_UDID" content_size large
xcrun simctl shutdown "$MAESTRO_UDID"; xcrun simctl boot "$MAESTRO_UDID"; xcrun simctl bootstatus "$MAESTRO_UDID" -b
```

Reboot after every size change: on a booted simulator every Maestro flow failed to launch the app after a size change ("Unable to launch app", "App crashed or stopped", no crash report) until the simulator was rebooted. The size survives the reboot.

**Fixed point sizes do not scale.** Text drawn with a fixed point size (a game screen, a canvas, `.font(.system(size: 17))`) ignores Dynamic Type, so it looks the same at `large`. Such a screen passes at `large` for the wrong reason: nothing grew. Check a screen that passes at both sizes against its `default` shot before trusting it.

### Android emulator

```sh
adb -s "$MAESTRO_UDID" shell settings put system font_scale 2.0
# ... run the flows
adb -s "$MAESTRO_UDID" shell settings put system font_scale 1.0
```

No reboot is needed. Boot the emulator with `-gpu host`, so it renders on the host GPU.

### Maestro example

[`examples/maestro/run-all.sh`](../../examples/maestro/run-all.sh) reads `TEXT_SIZE=<label>` (default `default`) and runs one size per call. For a label other than `default` it sets the size on `$MAESTRO_UDID` from `text-sizes.tsv` (with the iOS reboot), sets the default back on exit (also when a flow fails, on Ctrl-C and on `TERM`), writes the screenshots under `shots/<platform>/<label>/`, and passes `--device <platform> --text-size <label>` to catscan. Results go to `out/<platform>-<label>-<command>-<locale>.json`; a run clears only its own size's earlier files, and its `out/<platform>.html` covers every size in `out/<platform>-*.json`, with `--expect-text-sizes` built from those sizes.

```sh
cd examples/maestro
./run-all.sh ios de fr
TEXT_SIZE=large ./run-all.sh ios de fr
```

| Message | Exit | Next command |
| --- | --- | --- |
| `run-all: text-size-not-default` (warning) | - | a size run found the device not at the default size, which a run killed with `SIGKILL` leaves behind; run the restore command in the message |
| `run-all: text-size-reset` (note) | - | a default run found the device at another size, or could not read it, and set the default before any flow; nothing to do |
| `run-all: text-size-unknown` | 2 | the platform has no setting for that label; pick one of the labels the message lists |
| `run-all: text-size-set-failed` | 5 | `xcrun simctl list devices booted` or `adb devices`, then `export MAESTRO_UDID=<id>` |

### Playwright (web)

Browser zoom at 200% is emulated by a project with half the CSS viewport and twice the device scale factor, so media queries and wrapping see what a zoomed page sees: `{ viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 }` beside the 1280x720 default. Text-only zoom (the browser's font-size setting) has no cross-browser Playwright option and is not covered.

[`examples/playwright/playwright.config.ts`](../../examples/playwright/playwright.config.ts) has a `de-large` project with that viewport. The matchers write no results file, so `tests/shots.pw.ts` saves the screen under `shots/default/` (project `de`) and `shots/large/` (project `de-large`), and one catscan run reads both folders:

```sh
cd examples/playwright && npx playwright test
mkdir -p out
catscan truncated shots --layout '{text_size}/{screen}.{locale}' --results out/truncated.json
catscan report out/truncated.json --layout '{text_size}/{screen}.{locale}' --expect-text-sizes default,large --expect-locales de --out out/report.html
```

## One release report

Run from `examples/maestro/`:

1. Run every flow on iOS: `./run-all.sh ios de fr` (with `MAESTRO_UDID` set to the simulator).
2. Run every flow on iOS at large text: `TEXT_SIZE=large ./run-all.sh ios de fr`.
3. Run every flow on Android: `./run-all.sh android de fr` (with `MAESTRO_UDID` set to the emulator).
4. Run every flow on Android at large text: `TEXT_SIZE=large ./run-all.sh android de fr`.
5. Render one report for the release:

```sh
catscan report out/*.json --layout '{screen}.{locale}' --expect-devices ios,android --expect-text-sizes default,large --expect-locales de,fr --expect-screens screens.txt --out out/all.html
```

Each locale column splits into the platforms, each platform into `default` and `large`. The `large text` badge and filter mark a screen whose `default` cell passes and whose cell at another size fails: the defects the default run cannot see. A run captured before text sizes (no `--text-size`, no size folder) counts as `default`, so it merges with a large-text run, and an older baseline matches the `default` cells.

## What the checks find at large text

- `truncated`: ellipsis and cut prefixes, and with element boxes the `edge`, `screen-edge` and `overflow` reasons. Boxes matter more at large sizes, because text that runs past its container rarely shows an ellipsis.
- `overlap` with element boxes: text that grows into its neighbor.
- `check --present` still proves a string is there, with two limits: a string wrapped over three or more lines is not found (matching joins at most two lines), and a word hyphenated across two lines (`Einstellun-` / `gen`) is not found, a known limit.

Not covered: a word broken mid-word with no hyphen, and a screen that ignores the system size (see the demo).

## Demo

Run 2026-11-17 on `examples/maestro` (locale `de`, `run-all.sh` with `check`, `untranslated`, `truncated`) and `examples/playwright` (`truncated` only), at `default` and `large` (iOS AX5, Android 2.0, web 200%). Host GPU on both devices; one simulator and one emulator. Versions: macOS 27.2.1 (26B131) on Apple M5, Xcode 27.2 (27B52), iOS 27.2 runtime on iPhone 17, Android emulator 37.2.12.0 with the API 36 `google_apis_playstore` arm64 image, Maestro 2.6.0, catscan with Vision revision 3, Node 26.13.0, Playwright 1.65.0 with Chromium 158 (`--use-angle=metal`). Screenshots stay out of git; the commands are the recipes above.

| Platform | Screen | `default` | `large` | On screen at `large` |
| --- | --- | --- | --- | --- |
| iOS | onboarding | pass | pass | body wraps to three lines; fits |
| iOS | settings | pass | `check` fail: `Einstellungen` not found, closest `Einstellun-` | title and label hyphenate across lines; nothing cut. False positive (the hyphenation limit above) |
| iOS | game | pass | pass | unchanged: the screen uses fixed point sizes and ignores Dynamic Type |
| Android | onboarding, game | pass | pass | text grows and fits |
| Android | settings | pass | pass | the long label breaks mid-word with no hyphen (`Benachrichtigungseinstellu` / `ngen`): a visible defect no check reports |
| Web | canvas page | pass | `truncated` fail, 2 `screen-edge` | the 900 px canvas is cut at the 640 px viewport edge. True positive |

`large` finds a real defect the default run cannot (web). Two of the three large-text defects on the apps are outside today's checks: a word broken mid-word with no hyphen, and a screen that ignores the system size. One `run-all.sh` pass per platform took 1:08-1:12 on Android and 2:43 on iOS after the reboot.
