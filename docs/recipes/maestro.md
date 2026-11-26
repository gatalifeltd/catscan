# catscan with Maestro

Maestro checks screens through the accessibility tree. Text drawn by a game engine, a canvas or a web view without accessibility labels is invisible to `assertVisible`, so a screen can show a raw key or the wrong language and still pass. catscan reads the screenshots your flows already take, with Apple Vision on the Mac, and fails on raw keys, untranslated strings, missing text and cut-off labels.

Maestro's `runScript` sandbox cannot start processes, so catscan runs next to the flow, not inside a step. Tested with catscan 1.0.2, Maestro 2.6.0, Xcode 27.2 (iOS 27.2 simulator) and an Android 16 QPR2 emulator (API 36.1); [`results/maestro-e2e/`](../../results/maestro-e2e/) has every version of the last end-to-end run.

## 0. First verdict (one minute)

On one locale's Maestro screenshots you already have, with no expect file and no catalog:

```sh
catscan untranslated path/to/de-screenshots --locale de
```

It reports raw keys (`onboarding.title`) and unfilled placeholders (`{count}`) on every screen, including text `assertVisible` cannot see. Every input is read in the `--locale` language, so the argument holds one locale's screenshots: a folder, or `*.de.png`.

## Install

1. catscan, then `catscan doctor` to confirm the Mac reads text:

   ```sh
   npm install -g @catscan/cli
   catscan doctor
   ```

2. Maestro 2.6.0 (`curl -fsSL "https://get.maestro.mobile.dev" | MAESTRO_VERSION=2.6.0 bash`), plus Xcode for iOS, or the Android SDK with an API 33+ emulator for Android.

## 1. After the run (recommended)

[`examples/maestro/`](../../examples/maestro/) holds two sample apps (SwiftUI and Kotlin Compose, both `org.catscan.sample`), shared flows, expect files and two scripts. Build and install the app for one platform, pick the device, then run every flow for every locale:

```sh
cd examples/maestro
maestro list-devices
export MAESTRO_UDID=<the device id>
# iOS: build, then install on that simulator
xcodebuild -project app-ios/CatscanSample.xcodeproj -scheme CatscanSample -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build/ios build
xcrun simctl install "$MAESTRO_UDID" build/ios/Build/Products/Debug-iphonesimulator/CatscanSample.app
# Android: (cd app-android && ./gradlew assembleDebug) && adb -s "$MAESTRO_UDID" install -r app-android/build/outputs/apk/debug/catscan-sample-debug.apk
./run-all.sh ios de fr
```

`run-all.sh` writes `shots/<platform>/<screen>.<locale>.png`, one results file per command and locale in `out/` (`out/<platform>-<size>-<command>-<locale>.json`, the size `default` unless `TEXT_SIZE` says otherwise), and `out/<platform>.html`. It exits 1 when a check fails, a screen is missing or a locale is missing; a Maestro failure exits with Maestro's code. What it runs per locale (shown for iOS; this is the explanation, the script is the block to paste):

```yaml
# flows/onboarding.yaml
appId: ${APP_ID}
---
- launchApp:
    arguments: { AppleLanguages: "(${LOCALE})", AppleLocale: "${LOCALE}" }   # iOS; Android sets the locale before the run
- takeScreenshot: shots/${PLATFORM}/onboarding.${LOCALE}
```

```sh
LAYOUT='{screen}.{locale}'
for L in de fr; do
  rm -f shots/ios/*."$L".png shots/ios/*."$L".*.json            # no stale file stands in for a missing one
  maestro --udid "$MAESTRO_UDID" test flows/ --exclude-tags boxes -e PLATFORM=ios -e LOCALE="$L" -e APP_ID=org.catscan.sample
  # boxes for settings: a flow that ends there, then a dump after maestro exits
  maestro --udid "$MAESTRO_UDID" test flows/settings-boxes.yaml -e PLATFORM=ios -e LOCALE="$L" -e APP_ID=org.catscan.sample
  maestro --udid "$MAESTRO_UDID" hierarchy > "shots/ios/settings.$L.maestro.json"
  catscan boxes maestro "shots/ios/settings.$L.maestro.json" > "shots/ios/settings.$L.boxes.json"
  set -- shots/ios/*."$L".png; [ -e "$1" ] || continue         # no screenshots: the report shows the locale as missing
  catscan check "$@" --layout "$LAYOUT" --device ios --text-size default --expect "checks/$L.yaml" --results "out/ios-default-check-$L.json"
  catscan untranslated "$@" --layout "$LAYOUT" --device ios --text-size default --locale "$L" \
    --base app-ios/Localizable.xcstrings --catalog app-ios/Localizable.xcstrings --results "out/ios-default-untranslated-$L.json"
  catscan truncated "$@" --layout "$LAYOUT" --device ios --text-size default --locale "$L" --boxes shots/ios \
    --results "out/ios-default-truncated-$L.json"
done
catscan report out/ios-*.json --layout "$LAYOUT" --expect-text-sizes default --expect-locales de,fr --expect-screens screens.txt --out out/ios.html
```

- **Names:** `--layout '{screen}.{locale}'` reads the locale and screen from the file name, so each per-locale run maps every input to its cell. `untranslated` checks one locale per run, so each command runs per locale over that locale's files, and coverage is applied once, in `catscan report`.
- **Coverage:** `--expect-locales` and `--expect-screens` go on `catscan report` only; on a per-locale run they would mark the other locales `missing`. `screens.txt` lists every screen id the flows produce. `--expect-locales-from <catalog dir>` can replace the hand-written list.
- **Platforms:** one folder, one set of results and one report per platform. `--device "$PLATFORM"` tags every result with its platform, so the two platforms' results combine into one report ([4. One release report](#4-one-release-report)).
- **Expect files:** `checks/<locale>.yaml` uses the [`--expect` format](../cli.md#--expect-files); its keys are file names (`onboarding.de.png`). `@key` checks read the app's catalogs ([Catalogs](../cli.md#catalogs)).
- **Where Maestro writes:** Maestro 2.6.0 writes a relative `takeScreenshot` path under the working directory, or under `<dir>/screenshots/` when you pass `--test-output-dir <dir>`.
- **Text size:** `TEXT_SIZE=large ./run-all.sh ios de fr` sets the device to its largest system text size, runs the same flows into `shots/<platform>/large/`, passes `--text-size large`, and sets the default back on exit, also when a flow fails or the run is interrupted. The per-platform report then holds both sizes. Labels, what `large` means per platform and the iOS reboot: [`large-text.md`](./large-text.md).
- **Devices:** every `maestro` call passes `--udid "$MAESTRO_UDID"` (a root option, also for `hierarchy`), so a Mac with a simulator and an emulator running never stops at Maestro's device prompt.

### Android

`./run-all.sh android de fr` does the same with:
- `adb -s "$MAESTRO_UDID" shell cmd locale set-app-locales org.catscan.sample --locales "$L"` before each locale (API 33+; the app ships `locales_config.xml`);
- `--base app-android/src/main/res/values/strings.xml --catalog "app-android/src/main/res/values-$L/strings.xml"` (a region locale such as `pt-BR` reads `values-pt-rBR`);
- `catscan boxes maestro ... --image shots/android/settings.$L.png`, because an Android dump is in pixels.

### Locale switching

- **iOS:** `launchApp` `arguments` `AppleLanguages` and `AppleLocale`, as in the flows. Fallback for an app that ignores launch arguments: `xcrun simctl spawn "$MAESTRO_UDID" defaults write org.catscan.sample AppleLanguages -array de`, then relaunch.
- **Android:** `cmd locale set-app-locales` on an API 33+ image, with `android:localeConfig` in the manifest. Older images need a system locale change instead.

### In CI

`--format github` or `--junit <file>` go on the `check`, `untranslated` and `truncated` lines; `catscan report` takes neither. `run-all.sh` adds them from `CATSCAN_FORMAT=github` and `CATSCAN_JUNIT_DIR=<dir>`. Runners and examples: [`ci.md`](./ci.md) and [`examples/ci/`](../../examples/ci/).

## 2. Per flow (wrapper)

```sh
export MAESTRO_UDID=<the device id>
CATSCAN_BASE=app-ios/Localizable.xcstrings ./run-with-catscan.sh flows/settings.yaml ios de
```

[`run-with-catscan.sh`](../../examples/maestro/run-with-catscan.sh) removes that flow's old screenshots, runs the flow, then always runs `catscan untranslated` (catalogs from `CATSCAN_BASE` and `CATSCAN_CATALOG`) and, when `checks/<locale>.yaml` exists, `catscan check`, on that flow's screenshots. It exits with Maestro's code when Maestro failed, else the highest catscan code (5, 4, 3, 1, 0), and 1 when the flow left no screenshot. Use it when a CI step should fail at the flow that broke. Run it from the folder that holds `flows/`, `checks/` and `shots/`; it reads only one-line `takeScreenshot: shots/${PLATFORM}/<screen>.${LOCALE}` steps, and it runs no truncation check (`run-all.sh` does, with boxes). Unless `CATSCAN_BASE` is an `.xcstrings` file, which holds every locale, set `CATSCAN_CATALOG` to the locale's catalog too. It exits 2 on a usage error or an unset `MAESTRO_UDID`, and 5 when `maestro`, `catscan` or, on Android, `adb` is not on `PATH`.

## 3. Truncation

- **Without boxes:** `catscan truncated shots/ios/*.de.png --layout "$LAYOUT" --locale de` runs on the screenshots alone: an ellipsis, text cut at the screen edge (recall 0.877 on the synthetic set, [`BENCHMARKS.md`](../BENCHMARKS.md)).
- **With boxes** (recall 0.992): `maestro hierarchy` is a CLI command, not a flow step. A screen that needs boxes gets a flow that ends on it (`flows/settings-boxes.yaml`, tagged `boxes` so `--exclude-tags boxes` leaves it out of the screenshot run); `maestro hierarchy` dumps it only after `maestro test` has exited, because a second Maestro process started while a flow runs kills that flow. `catscan boxes maestro` converts the dump and `truncated --boxes shots/<platform>` reads `<screen>.<locale>.boxes.json` by base name. The `maestro` converter also reads React Native and Flutter dumps.

## 4. One release report

Each platform's results carry their device (`--device ios`, `--device android`) and text size (`--text-size default`, `--text-size large`), so one report can show both platforms at both sizes side by side: each locale column splits into an `android` and an `ios` sub-column, each of those into `default` and `large`, a device filter narrows the page to one platform, the `large text` filter shows the cells that pass at `default` and fail at `large`, and in the image view the up and down arrows move through a screen's sizes and platforms ([report.md](../report.md#devices), [large-text.md](./large-text.md)).

1. Run every flow on iOS: `./run-all.sh ios de fr` (with `MAESTRO_UDID` set to the simulator).
2. Run every flow on iOS at large text: `TEXT_SIZE=large ./run-all.sh ios de fr`.
3. Run every flow on Android: `./run-all.sh android de fr` (with `MAESTRO_UDID` set to the emulator).
4. Run every flow on Android at large text: `TEXT_SIZE=large ./run-all.sh android de fr`.
5. From `examples/maestro/`, so the stored relative paths resolve without `--images-root`, render one report for the release:

```sh
catscan report out/*.json --layout '{screen}.{locale}' --expect-devices ios,android --expect-text-sizes default,large --expect-locales de,fr --expect-screens screens.txt --out out/all.html
```

`--expect-devices` and `--expect-text-sizes` make a platform or a size whose run never wrote a file show as `missing` instead of silently absent. The per-platform reports (`out/ios.html`, `out/android.html`) stay.

## Languages

Any of the 61 measured locales: 38 read by Vision, 23 by the Tesseract fallback. A fallback locale needs Tesseract; without it the run is `needs-reader` (exit 3) with the install hint, and `catscan doctor --expect-locales <list>` checks the setup first: [`tesseract.md`](./tesseract.md).

## Agents

An agent that drives Maestro reads the same `shots/` folder with catscan's MCP tools (`check_text`, `find_untranslated`, `find_truncation`): [`mcp.md`](./mcp.md). Neither script ever prompts.

## What the sample screens produce

Each app has three screens: onboarding, settings with a long German label, and a game screen whose text a canvas draws with no accessibility label. A clean build passes every command; `FAULTS=1` (`xcodebuild ... FAULTS=1`, `./gradlew assembleDebug -PFAULTS=1`) plants a raw key on onboarding and cuts the German settings label:

| Screen | Clean build | `FAULTS=1` |
| --- | --- | --- |
| onboarding | `PASS` on check, untranslated, truncated | `untranslated`: `raw-key "onboarding.body"`; `check`: `absent "onboarding.body"` fails |
| settings | `PASS`; the dump holds `Benachrichtigungseinstellungen` | `truncated`: `truncated (ellipsis) "Benachrichtigung..."` |
| game (drawn text) | `PASS`: `check` finds `Level geschafft`, which `assertVisible` cannot see | `PASS` |

On the iOS 27.2 simulator, `FAULTS=1`, German:

```
FAIL  shots/ios/onboarding.de.png
  raw-key "onboarding.body" at [0.041, 0.1686, 0.3754, 0.0218]
FAIL  shots/ios/settings.de.png
  truncated (ellipsis) "Benachrichtigung..." at [0.041, 0.1817, 0.3659, 0.0189] in notifications-label [0.0398, 0.1762, 0.3657, 0.024], expected "Benachrichtigungseinstellungen"
```

## Troubleshooting

| Symptom | Cause | Next command |
| --- | --- | --- |
| No screenshots in `shots/` | Maestro wrote them under `--test-output-dir` | `find <test-output-dir>/screenshots -name '*.png'`, or drop `--test-output-dir` |
| Maestro asks which device to use | `MAESTRO_UDID` unset or wrong | `maestro list-devices`, then `export MAESTRO_UDID=<id>` |
| The app is still in English | The locale switch did not apply | iOS: check the flow's `launchApp` `arguments`; Android: `adb -s "$MAESTRO_UDID" shell cmd locale get-app-locales org.catscan.sample` |
| `screen: null` or `layout-mismatch` | The default layout is `{locale}/{screen}` | add `--layout '{screen}.{locale}'` |
| `untranslated` finds only keys and placeholders | No catalogs given | add `--base <base catalog> --catalog <locale catalog>`; for the wrapper, `export CATSCAN_BASE=... CATSCAN_CATALOG=...` |
| The boxes dump is empty or from another screen | It was dumped while a flow ran | run `maestro --udid "$MAESTRO_UDID" hierarchy` only after `maestro test` has exited |
| `needs-reader` (exit 3) | The locale needs Tesseract or its language data | the command in the hint (usually `brew install tesseract tesseract-lang`), then `catscan doctor --expect-locales <locale>` |
| `run-all: text-size-not-default` | An earlier run was killed before it set the default size back | the restore command in the message, then rerun |
| `run-all: text-size-reset` | A default run found the device at another size | nothing: it set the default size before any flow |
| `run-all: text-size-set-failed` (exit 5) | The device is not booted or not the one in `MAESTRO_UDID` | `xcrun simctl list devices booted` or `adb devices`, then `export MAESTRO_UDID=<id>` |
| `vision-timeout` (exit 4) on one screenshot | The Mac is busy (an emulator, other jobs) and Vision missed its 60 s deadline | rerun, or `export CATSCAN_VISION_TIMEOUT=180` before `run-all.sh` |

## Versions

The end-to-end test, `npm run e2e:maestro` in this repository, builds both apps, runs `run-all.sh` for `de` and `fr` on one simulator and one emulator, and checks the clean build, the fault build, a dropped screen and step 0. A Maestro upgrade reruns it before the tested version above changes.
