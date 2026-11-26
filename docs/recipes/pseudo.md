# Pseudo-localization with catscan

Find cut-off labels and hardcoded strings before the first translation is ordered. A pseudo build shows every catalog string expanded by about 40%, accented and wrapped in brackets (`Settings` -> `[Šéttíñgš öñé]`). catscan reads its screens with Apple Vision and reports:

- `pseudo-cut` (truncated): a string lost its `[` or `]`, so the UI cut it. `lost: "filler"` means the base text still fits but a 30-40% longer translation will not.
- `hardcoded` (untranslated): a line with no pseudo trait, so it never went through the catalog. `evidence: "base"` names the key it copies.
- `pseudo-not-applied`: the screen shows base text, so the build or launch did not load the pseudo locale. It fails the run (exit 1), so a broken pseudo job never passes green.
- `raw-key` and `placeholder`, as on any build.

The flow is the same on every platform: generate the pseudo catalog inside the pseudo build job (never commit it), launch the app in `en-XA`, capture the screens as you already do, then run the checks with the base catalog. Capture itself is not repeated here: [Maestro](./maestro.md) for iOS and Android, [Playwright](./playwright.md) for the web. Every flag and finding: [`docs/cli.md`](../cli.md#pseudo-localized-builds).

Tested on the sample apps in [`examples/`](../../examples/): see each platform for the device it ran on.

## 1. Generate the pseudo catalog in the build job

`catscan pseudo <base catalog>` writes the `en-XA` catalog next to the base one and prints the two next steps for its format. It reads no images, so it runs on any CI host with Node. Run it as a step of the pseudo build only: a committed pseudo catalog can reach a release build or the store language list.

```sh
catscan pseudo Localizable.xcstrings --in-place --force        # iOS String Catalog: adds en-XA to the file itself
catscan pseudo en.lproj/Localizable.strings                     # iOS .strings: writes en-XA.lproj/Localizable.strings
catscan pseudo app/src/main/res/values/strings.xml              # Android: writes app/src/debug/res/values-en-rXA/strings.xml
catscan pseudo locales/en.json                                  # i18next: writes locales/en-XA.json
```

`--in-place` changes the `.xcstrings` in the build job's checkout only; do not commit it. For an Android variant other than `debug`, pass `--out app/src/<variant>/res/values-en-rXA/strings.xml`. `--force` lets a rerun overwrite the previous output.

## 2. Launch the app in en-XA

### iOS

Generate in the pseudo build job, build as usual, then launch with the pseudo locale as the first preferred language:

```sh
catscan pseudo Localizable.xcstrings --in-place --force
xcodebuild -scheme <scheme> -sdk iphonesimulator -destination "id=<udid>" -derivedDataPath build build
xcrun simctl install <udid> build/Build/Products/Debug-iphonesimulator/<App>.app
xcrun simctl launch <udid> <bundle-id> -AppleLanguages "(en-XA)" -AppleLocale en_XA
```

With Maestro, the same two values go in `launchApp` `arguments` (`{ AppleLanguages: "(en-XA)", AppleLocale: "en_XA" }`, as the sample flows pass `${LOCALE}`); with XCUITest, in `app.launchArguments`. Xcode builds the `en-XA` localization from the String Catalog as is; adding `en-XA` to the project's localizations (`knownRegions`) was not needed. For `.strings`, the generated `en-XA.lproj` folder must be in the app target's resources (unverified: the sample app uses a String Catalog).

Verified on the sample app `examples/maestro/app-ios` (Xcode 27.2, iPhone 18 Pro simulator on iOS 27.2): both screens pass `untranslated` and `truncated --pseudo`; the same app launched without the arguments fails with `pseudo-not-applied`. Boot the simulator before the build and give `simctl bootstatus` a timeout: a boot started during an `xcodebuild` can hang.

### Android

Generate into the debug source set in the pseudo build job, build the debug variant, then switch the app (not the device) to `en-XA` (Android 13+, API 33):

```sh
catscan pseudo app/src/main/res/values/strings.xml          # -> app/src/debug/res/values-en-rXA/strings.xml
./gradlew assembleDebug
adb -s <serial> install app/build/outputs/apk/debug/<app>-debug.apk
adb -s <serial> shell cmd locale set-app-locales <package> --locales en-XA
adb -s <serial> shell am start -W -n <package>/<activity>
```

Leave `pseudoLocalesEnabled` off: Android's own pseudo accents are not read reliably by Vision, and catscan's catalog replaces them. If the build sets `androidResources { localeFilters += ... }`, add `"en-rXA"` to it for the pseudo build, or Gradle strips the pseudo strings from the APK and every screen is `pseudo-not-applied` (check with `aapt2 dump resources <apk> | grep en-rXA`). `locales_config.xml` does not need `en-XA`. In an instrumented test, the same switch is `LocaleManager.setApplicationLocales(LocaleList.forLanguageTags("en-XA"))` (unverified); with Maestro, run the `set-app-locales` line before the flow, as [`run-with-catscan.sh`](../../examples/maestro/run-with-catscan.sh) does per locale. Wait for the first frame after a cold start (`am start -W`), or the capture catches the splash screen.

Verified on the sample app `examples/maestro/app-android` (AGP 9.5.1, API 36 emulator), with `en-rXA` added to its `localeFilters`: `untranslated --pseudo` and `truncated --pseudo` pass, and the base-language launch fails with `pseudo-not-applied`. A body string that wraps onto a second line passes even when Vision reads its closing `]` as `_`, `j`, `)` or `1` or drops it, as long as both lines sit as one paragraph and the whole filler run is on screen. If you added `--reasons ellipsis,prefix,edge,overflow,screen-edge` to work around that false positive, remove it: it also hides real `pseudo-cut` findings.

### Web (i18next)

Load `locales/en-XA.json` when the URL says `?lng=en-XA` (the i18next language detector reads `lng` from the query string), or pass `lng: "en-XA"` to `i18next.init`. With Playwright, pass `pseudo: true` and the base catalog to the matchers:

```ts
test("pseudo build: no hardcoded text, nothing cut", async ({ page }) => {
  await page.goto("/?lng=en-XA");
  await expect(page).toHaveNoUntranslated({ pseudo: true, catalog: "locales/en.json", readyText: "@menu.play" });
  await expect(page).toHaveNoTruncation({ pseudo: true, catalog: "locales/en.json", readyText: "@menu.play" });
});
```

`toShowText` takes `pseudo: true` too: texts and `@key`s written for the base language match the pseudo screen. The example game runs this as its `pseudo` project ([`examples/playwright/`](../../examples/playwright/), Chromium on the host GPU): its web server runs `catscan pseudo locales/en.json --force` before it starts, so `en-XA.json` is generated on every run and gitignored. Verified on Chromium (Playwright 1.65.1): 3 tests pass; with `?faults=1` only the raw-key test fails.

## 3. Check the screens

With `--locale` left at the base language (an `en-XA` locale is read as `en` anyway) and the base catalog, never the pseudo one:

```sh
catscan untranslated shots/ --pseudo --catalog locales/en.json
catscan truncated shots/ --pseudo --catalog locales/en.json
```

Pass the same file you generated from: for an `.xcstrings`, the catalog itself (its source language is the base). On the example game, a correct pseudo screen passes both; the same screen with one label set in code fails with `hardcoded "Settings" ... (equals @menu.settings in locales/en.json; not from the pseudo catalog; look it up by key)`; the base-language screen fails with `pseudo-not-applied: 0% of 5 lines show pseudo text`.

Options worth knowing: `--dynamic <file>` (regexes for user names and server text that are never `hardcoded`), `--allow <file>` (brand names), `--kinds hardcoded` and `--reasons pseudo-cut` to report one kind only, `--boxes` with `dynamic: true` elements. Agents get the same through the MCP tools `find_untranslated`, `find_truncation` and `check_text` with `pseudo: true` ([MCP recipe](./mcp.md)).

## Not covered

- `.stringsdict` plurals: catscan does not read them, so they stay in the base language (`catscan pseudo` warns `stringsdict-skipped`). Move them into a String Catalog.
- Strings outside the catalogs catscan reads (server text, images with text): they show as `hardcoded` unless `--dynamic` or `--allow` names them.
- System UI (permission dialogs, the status bar, the keyboard): not transformed by the app's catalog; catscan skips the status-bar band and the iOS and Android permission dialogs.
- Variants: only `--variant accent` is measured. `rtl` and `tall` catalogs can be generated; their checks are not measured yet.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `pseudo-not-applied` on every screen | The app launched in the base language | iOS: the launch arguments (with `.strings`, the `en-XA.lproj` folder in the app target's resources); Android: `adb shell cmd locale get-app-locales <package>`; web: the `lng` parameter |
| `output-exists` (exit 2) | A previous pseudo catalog is still there | add `--force`, as in the build-job commands above |
| `in-place-required` (exit 2) | An `.xcstrings` holds every locale | add `--in-place` (or `--out <copy.xcstrings>`) |
| `format-not-supported` (exit 2) | The base catalog is a TypeScript or JavaScript file | export the strings to `locales/en.json` and pass that file |
| `already-pseudo` (exit 2) | The input is a pseudo catalog | pass the base catalog |
| `pseudo-conflicts-with-base` (exit 2) | `--base` with `--pseudo` | drop `--base`; the one `--catalog` is the base |
| Many `hardcoded` lines with user or server text | Dynamic content | list it in `--dynamic`, or mark the elements `dynamic: true` in `--boxes` |
