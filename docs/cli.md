# catscan command line

catscan reads app and game screenshots on the Mac with Apple Vision and checks their text. Everything runs on the device; screenshots and their text never leave it. Only `catscan doctor` touches the network: it checks npm for a newer version (off with `--offline`, `CATSCAN_NO_UPDATE_CHECK=1` or in CI), and for an npm-installed binary macOS looks up its notarization with Apple ([Doctor](#doctor)).

```
catscan check <path...> [--present <text>]... [--absent <text>]... [--expect <file>] [--catalog <file>]... [--all-keys] [--fail-on-skip] [--locale <code>] [--fallback tesseract|none] [--pseudo]
catscan read  <path...> [--locale <code>] [--fallback tesseract|none]
catscan untranslated <path...> [--locale <code>] [--base <file> --catalog <file>...] [--base-locale <code>] [--allow <file>] [--kinds <list>] [--languages <list>]
catscan untranslated <path...> --pseudo --catalog <base> [--dynamic <file>] [--boxes <file|dir>] [--kinds <list>]
catscan video <file...> [--every <s>] [--from <s>] [--to <s>] [--present <text>]... [--absent <text>]... [--expect <file>] [--catalog <file>]... [--fail-on-skip] [--locale <code>] [--json [--frames]]
catscan truncated <path...> [--boxes <file|dir>] [--catalog <file>]... [--reasons <list>] [--allow <file>] [--locale <code>] [--pseudo]
catscan overlap <path...> [--boxes <file|dir>] [--min-overlap <share>] [--allow <file>] [--locale <code>] [--experimental]
catscan formats <path...> [--locale <code>] [--storefront <region> | --currency <ISO>] [--prices <file>] [--rules <list>] [--allow <file>]
catscan fit <path...> [--device-profile <id|file>] [--orientation portrait|landscape-left|landscape-right] [--boxes <file|dir>] [--reasons <list>] [--base-locale <code>] [--catalog <file>]... [--allow <file>] [--fail-on-skip] [--experimental] [--layout <pattern>]
catscan fit --list-devices [--json]
catscan contrast <path...> [--level AA|AAA] [--scale <n>] [--kinds <list>] [--boxes <file|dir>] [--allow <file>] [--locale <code>] --experimental
catscan boxes <source> <dump> [--image <png>]
catscan pseudo <catalog> [--out <path>] [--locale <tag>] [--expand <percent>] [--variant accent|rtl|tall] [--in-place] [--force] [--json]
catscan results merge <file.json...> --out <file.json> [--layout <pattern>] [--expect-locales <list> | --expect-locales-from <dir>] [--expect-screens <file>] [--expect-devices <list>] [--expect-text-sizes <list>] [--min-severity critical|major|minor] [--min-certainty high|medium|low] [--known <file>]
catscan results validate <file.json> [--json]
catscan results baseline <results.json> --out <baseline.json> [--allow-incomplete]
catscan results known <results.json...> --out <known.json> [--prune]
catscan report <results.json...> [--out <file.html>] [--images-root <dir>] [--layout <pattern>] [--expect-locales <list> | --expect-locales-from <dir>] [--expect-screens <file>] [--expect-devices <list>] [--expect-text-sizes <list>] [--report-images embed|link] [--report-max-edge <px>] [--min-severity critical|major|minor] [--min-certainty high|medium|low] [--known <file>]
catscan languages [--json]
catscan doctor [--json] [--offline] [--expect-locales <list> | --expect-locales-from <dir>]
catscan serve
catscan --version
```

`check`, `untranslated`, `truncated`, `overlap`, `formats`, `fit` and `contrast` also take `--min-severity`, `--min-certainty` ([Severity and certainty](#severity-and-certainty)) and `--known <file>`.

`<path>` is an image (PNG, JPEG, HEIC), a folder (searched recursively for images), or `-` for one image on stdin. Folders are processed in sorted path order; arguments keep their order. A folder with no readable images, or a subfolder that cannot be listed, is an input error (`no-images`, exit 4), never an empty pass. Symlinked images are read; symlinked folders are not followed. JPEG and HEIC orientation is applied before recognition. An image on stdin can be up to 47 MB. For `video`, inputs are MP4 and MOV files, or folders searched for them ([Video](#video)).

## Options

| Option | Commands | Meaning |
| --- | --- | --- |
| `--present <text>` | check, video | The text must be shown (for video: on at least one sampled frame). Repeatable; each one is a check on every input. |
| `--absent <text>` | check, video | The text must not be shown (for video: on no sampled frame). Repeatable. |
| `--expect <file>` | check, video | Per-image checks from a YAML or JSON file (below); for video, checks per time range ([Video](#video)). |
| `--every <s>` | video | Sampling interval in seconds. Default `0.5`; raised to one frame (`1/fps`) when shorter, with `every-clamped`. |
| `--from <s>`, `--to <s>` | video | The time range to sample, bounds inclusive. Default: the whole video. |
| `--frames` | video | With `--json`: one `video-frame` line per sampled frame before the video's envelope. |
| `--base <file>` | untranslated | The base-locale catalog, any `--catalog` format. Needs `--catalog` ([Untranslated](#untranslated)). |
| `--base-locale <code>` | untranslated, fit | The language of `--base`. Default: the `.xcstrings` `sourceLanguage`, else `en`. For `fit`, the locale whose screenshots are the one-row reference for `wrapped`; default the `--catalog` source locale, else `en` ([Wrapped labels](#wrapped-labels-and-one-word-last-rows)). |
| `--min-severity <level>`, `--min-certainty <level>` | check, untranslated, truncated, overlap, formats, fit, contrast, results merge, report | Only findings at or above both levels gate: they fail the input and the exit code. Levels: `critical`, `major`, `minor`; `high`, `medium`, `low`. Default `minor` and `low`: every finding gates. Failed checks always gate. The rest stay in `findings[]` with `gate: false` ([Severity and certainty](#severity-and-certainty)). |
| `--known <file>` | check, untranslated, truncated, overlap, formats, fit, contrast, results merge, report | Findings approved in this `catscan results known` file are marked `known: true` and never gate; only new findings fail ([results.md](./results.md#known-findings)). A missing file warns `known-missing` and every finding is new. |
| `--allow <file>` | untranslated, truncated, overlap, formats, fit, contrast | Strings that are fine in any language (brand names, product terms), or for `truncated` never cut off (an intended `Loading...`), one per line. For `overlap`: element ids or texts whose findings are dropped (an intended badge over an avatar). For `formats`: lines never reported. For `contrast`: lines never measured (logotypes, watermarks, decorative text), matched like `untranslated` (the normalized whole line). |
| `--boxes <file\|dir>` | truncated, untranslated `--pseudo`, overlap, fit, contrast | Element boxes ([Truncated](#truncated)): a file for one image, or a folder with `<name>.boxes.json` per image. With `untranslated --pseudo`, only elements marked `dynamic: true` are read ([Pseudo-localized builds](#pseudo-localized-builds)). For `contrast`: disabled elements (`enabled: false`) and text under a later `panel` are not measured ([Contrast](#contrast)). |
| `--experimental` | overlap, fit, contrast, untranslated `--uncatalogued` | `untranslated`: needed with `--uncatalogued`. `contrast`: runs the kinds that have not passed their gate (every kind today). Otherwise: runs the OCR-only reader on images with no element boxes, with boxes also reports `occluded` (text cut off by a panel), ([Overlap](#overlap)). Stacked text (`signal: "stacked"`, one more Vision read per image) runs without it. |
| `--storefront <region>` | formats | The App Store or Play storefront (`DE`, `US`, `JP`; ISO 3166 alpha-2 or alpha-3): the currency users are charged in, from CLDR ([Formats](#formats)). |
| `--currency <ISO>` | formats | The expected currency (`EUR`) when no storefront is given. Disagreeing with `--storefront` is `conflicting-options`. |
| `--prices <file>` | formats | Test products: a `.storekit` file, or JSON or YAML `[{product, price, currency, period, trial}]` ([Formats](#formats)). |
| `--rules <list>` | formats | Report only these rules: `number`, `date`, `time`, `currency-placement`, `currency`, `mixed-currency`, `price` (comma-separated). Default: all but `time` and `currency-placement`. An unknown rule is `unknown-rule` naming the closest. |
| `--min-overlap <share>` | overlap | How much of the smaller box the other must cover, above 0 and at most 1. Default `0.01` for element boxes, `0.3` for line boxes (OCR-only) ([Overlap](#overlap)). |
| `--reasons <list>` | truncated, fit | Report only these reasons: `ellipsis`, `prefix`, `edge`, `overflow`, `screen-edge`, `pseudo-cut` (comma-separated; `pseudo-cut` needs `--pseudo`). Default: all. Filtered findings do not count toward the exit code. For `fit`: `cutout`, `corner`, `home-indicator`, `wrapped`, `orphan` ([Fit](#fit)). |
| `--level AA\|AAA` | contrast | The WCAG level: `AA` (default) fails normal text below 4.5:1 and large text below 3:1; `AAA` below 7:1 and 4.5:1 ([Contrast](#contrast)). Another value is `invalid-level`. |
| `--scale <n>` | contrast | The device pixel ratio (1 to 4) that turns a line's pixel height into text size. Default: the boxes file's `scale`, else the iOS screenshot size, else 1 with `contrast-scale-unknown`. Android: `adb shell wm density` / 160. Another value is `invalid-scale`. |
| `--kinds <list>` | untranslated, contrast | Report only these finding kinds: `untranslated`, `raw-key`, `placeholder`, `hardcoded`, `wrong-language`, `uncatalogued` (comma-separated; `hardcoded` needs `--pseudo`; `uncatalogued` is the same as `--uncatalogued`). Default: all. An unknown kind is `unknown-kind` naming the closest; `pseudo-not-applied` is never filtered. For `contrast`: `low-contrast`, `busy-background`; default both. |
| `--languages <list>` | untranslated | The project's languages (`es,pt-BR`), for `wrong-language` when `--catalog` is not a `{locale}` template or an `.xcstrings` file: language identification only. A code that is not BCP 47 is `invalid-locale`; not with `--pseudo` ([Untranslated](#untranslated)). |
| `--pseudo` | untranslated, truncated, check | The screens show a pseudo-locale build made with `catscan pseudo`; `--catalog` is the base catalog ([Pseudo-localized builds](#pseudo-localized-builds)). |
| `--uncatalogued` | untranslated | Experimental, with `--experimental` and the run locale's `--catalog`: also report lines no string of any loaded catalog explains (text hardcoded in the build). Takes `--dynamic` and `--boxes`; not with `--pseudo`. |
| `--dynamic <file>` | untranslated `--pseudo` or `--uncatalogued` | Regexes, one per line (`#` comments), each matched against a whole line: text that is never reported as `hardcoded` (user names, server content). An invalid regex is `dynamic-invalid` naming `file:line`. The core runs the patterns with ICU (Apple's `NSRegularExpression`) after a JavaScript syntax check, so use the common subset: no lookbehind, no inline flags. |
| `--image <png>` | boxes | The screenshot a dump was taken with; needed for pixel dumps ([Boxes](#boxes)). |
| `--catalog <file>` | check, untranslated, video, truncated, fit | Strings for `@key` checks ([Catalogs](#catalogs)), the translated catalog for `untranslated`, the strings a cut line is a prefix of for `truncated`, or, for `fit wrapped`, the catalog keys that pair elements with no `id` to their base-locale screenshot. Repeatable; the last file wins a duplicate key. `{locale}` in the path takes the run locale. |
| `--all-keys` | check | Report, per image, which catalog strings are shown (an inventory; it never fails). Needs `--catalog`. |
| `--device-profile <id\|file>` | fit | The device of every input: a shipped profile id (`catscan fit --list-devices`) or a profile file ([Fit](#fit)). Default: iOS and iPadOS screenshots match a profile by pixel size; Android needs this flag or a `--device` label that names a profile. |
| `--orientation <side>` | fit | `portrait`, `landscape-left` (the device's top edge on the image's left) or `landscape-right`, for every input. Default: the sidecar's `orientation`, else portrait for a tall image and "landscape, side unknown" for a wide one. |
| `--list-devices` | fit | Print the shipped device profiles (id, platform, portrait size, zones, the Xcode or emulator build they were measured on); `--json` prints the array. |
| `--offline` | doctor | Skip the check for a newer catscan on npm ([Doctor](#doctor)). |
| `--fail-on-skip` | check, video, fit | Exit 1 when any check is `skipped`, whatever its reason (`catalog-missing`, `catalog-string-capped`, `catalog-value-dynamic`, `no-checkable-text`, `range-empty`), and say so in one `checks-skipped` line on stderr. Verdicts, `--json`, `--results` and the CI reports stay as they are. Error (4), needs-reader and unsupported (3) and internal (5) still win. |
| `--results <file>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | Also write the whole run to one versioned JSON file ([results.md](./results.md)). A write failure is exit 4 (`results-write-failed`). |
| `--build <id>`, `--build-version <v>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | The app build being checked, recorded in the results file. Default `null`; catscan never guesses it. |
| `--layout <pattern>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast, results merge, report | How locale and screen are read from a path below its argument: `{locale}/{screen}` (default), `{screen}.{locale}`, `{screen}/{locale}`, `{locale}-{screen}`, `{screen}-{locale}` (a locale token at the start or end of the file name), or `none`; each may start with `{device}/` ([Device axis](./results.md#device-axis)), then `{text_size}/` ([Text-size axis](./results.md#text-size-axis)). A matched locale is the recognition locale unless `--locale` or the `--expect` file gives one ([results.md](./results.md#layout)). |
| `--expect-locales <list>`, `--expect-locales-from <dir>`, `--expect-screens <file>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast, results merge, report, doctor (locales only) | Expected coverage: every expected locale and screen with no screenshot is a `missing` result that fails (exit 1) ([results.md](./results.md#coverage)). For `doctor`, the locales whose reader it checks ([Doctor](#doctor)). |
| `--device <label>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | The device of every input, such as `ios-se` or `android-pixel-9`: lower-cased, 1-64 characters of `a-z`, `0-9`, `.`, `_`, `-`. It wins over a `{device}/` layout segment ([Device axis](./results.md#device-axis)). |
| `--expect-devices <list>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast, results merge, report | Devices that must be present, such as `ios,android`: each expected device x locale x screen with no screenshot is a `missing` result that fails (exit 1). Pass it to the merge step when one job runs per device. |
| `--text-size <label>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | The system text size of every input, such as `default` or `large` (the device label grammar). It wins over a `{text_size}/` layout segment; an input with no size is a `default` one ([Text-size axis](./results.md#text-size-axis), [recipes/large-text.md](./recipes/large-text.md)). |
| `--expect-text-sizes <list>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast, results merge, report | Text sizes that must be present, such as `default,large`: each expected size x device x locale x screen with no screenshot is a `missing` result that fails (exit 1). |
| `--out <file>` | results merge, results baseline, results known, report | The merged or approved results file, or the known-findings file; for `report`, the HTML file (default `catscan-report.html`). |
| `--report <file>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | Also write one self-contained HTML report: coverage matrix, screenshots with boxes, findings ([report.md](./report.md)). It holds the screenshots. A write failure is exit 4 (`report-write-failed`); `--report` never changes the exit code otherwise. |
| `--report-images embed\|link` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast (with `--report`), report | `embed` (default): JPEG copies inside the file. `link`: PNG, JPEG, GIF and WebP files are referenced by relative path; HEIC, TIFF, BMP, `abs:` paths and video frames are still embedded. |
| `--report-max-edge <px>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast (with `--report`), report | The long edge of embedded images, 64 to 4096. Default `800`. |
| `--images-root <dir>` | report | The folder the paths in the results files are relative to. Default: the working directory. A path that resolves outside it counts as not found. |
| `--junit <file>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | Also write JUnit XML: one `<testsuite>` per input folder, one `<testcase>` per check (`check`, `video`) or per input (the finding commands, `read`); `missing` entries are test cases named `missing: <expected_path>` ([CI](#ci-reports)). |
| `--gitlab-codequality <file>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | Also write a GitLab Code Quality report: one entry per failed check or finding at its severity (`info` below the thresholds), one `critical` entry per `error`, `needs-reader` or `unsupported` input ([CI](#ci-reports)). |
| `--baseline <file>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast, results merge, report | Compare each locale x screen cell's recognized text with an approved results file ([results.md](./results.md#changed-only-review)). The exit code does not change. |
| `--baseline-ignore <file>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | Regular expressions, one per line (`#` comments), matched against normalized lines; each match becomes `#` before the text is compared. For dynamic content (install IDs, scores, user names). |
| `--text-record full\|digest\|none` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | What the results file keeps of the recognized text: `full` (default: normalized lines and tokens), `digest` (only a hash; no line diff), `none` (no record; the file cannot be a baseline). |
| `--prune` | results known | Only lower approved counts to what the results found and remove rows that reach 0; never add. The `--out` file must exist (exit 2) ([results.md](./results.md#known-findings)). |
| `--allow-incomplete` | results baseline | Approve a run that has error, needs-reader, unsupported, missing, ambiguous or unread cells; they stay non-skippable. |
| `--locale <code>` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | BCP 47 code of the screenshot language (`de`, `pt-BR`, `zh-Hant`). Default `en`. |
| `--fallback tesseract\|none` | check, read, untranslated, truncated, overlap, formats, fit, contrast | Reader for locales Vision cannot read ([Fallback](#fallback)). Default `tesseract` when it is installed, else `none`. A CLI flag only, not an `--expect` key. |
| `--json` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast, pseudo, results validate, languages, doctor | One JSON object per input on stdout (JSON Lines); for `languages`, one object. Short for `--format json`. |
| `--format text\|json\|github` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast, pseudo, results validate, languages, doctor (`github`: check to contrast only) | Output format. Default `text`. `github` prints GitHub Actions annotations and writes the job summary ([CI](#ci-reports)). `--json` with a different `--format` is a usage error. |
| `--quiet`, `-q` | check, read, untranslated, video, truncated, overlap, formats, fit, contrast | Print only failures and the totals line (text only: `--json` prints every input); no counts and no warnings on stderr, except those that mean nothing was checked (`no-checks`, `no-checkable-text`, `expect-key-unmatched`, `locale-script-mismatch`, `locale-fallback`, `language-not-in-table`, `catalog-missing`, `catalog-string-capped`, `catalog-duplicate-key`, `catalog-values-skipped`, `catalog-value-dynamic`, `checks-skipped`, `untranslated-base-catalog`, `untranslated-unreadable`, `wrong-language-unchecked`, `currency-unchecked`, `range-empty`, `every-clamped`, `boxes-missing`, `wrap-needs-boxes`, `wrap-no-base`, `wrap-base-ambiguous`), or that another engine read the screen or none could (`fallback-engine`, `fallback-pack-missing`, `fallback-unavailable`, `rule-unmeasured-reader`), occlusion that was skipped or had nothing to check (`occlusion-experimental`, `no-panel-elements`), stacked text not checked on a Tesseract read or after a failed second Vision read (`stacked-unchecked`), a safe-area reason that did not run (`device-unknown`, `device-ambiguous`, `orientation-unknown`, `fit-controls-need-boxes`, `fit-experimental`), a contrast check that was relaxed or skipped (`contrast-scale-unknown`, `contrast-size-uncertain`, `contrast-behind-scrim`, and the `contrast:` summary line), and the baseline warnings (`baseline-missing`, `baseline-unapproved`, `baseline-ignore-changed`, `reader-changed`), which say why nothing is skippable. |
| `--help`, `-h` | all | `catscan --help`: every command. `catscan <command> --help`: that command's usage lines, its options (its own and the shared ones it takes) and the exit codes. |
| `--version` | - | catscan version, macOS version and build, Vision request revision. |

`--opt=value` works as well as `--opt value`. `--` ends the options. An unknown command or option names the closest valid one: `unknown option --presnt; did you mean --present?`.

Not in this version: `--escalate` (planned, not built; it gives a usage error that says so).

Changed-only review, in one line: `--baseline` compares, `catscan results baseline` approves, the `baseline` block of the results file is the result ([results.md](./results.md#changed-only-review)).

`catscan report <results.json...>` renders results files into one HTML report ([report.md](./report.md)). Several files are merged as `results merge` does; one file with no `--layout` or expectation option is rendered as written. It exits with the code of the merged verdicts, `missing` entries included; without a file it is exit 2 with the hint `catscan report catscan-results.json`. Reading its inputs gives the same diagnostics as `results merge` (`results-unreadable`, `results-invalid`, the `results-*-mismatch` codes, `mixed-versions`).

`--results`, `--report`, `--junit` and `--gitlab-codequality` must name different files, compared case-insensitively as macOS volumes are, and none may be `$GITHUB_STEP_SUMMARY` under `--format github` (`conflicting-options`). Each is written atomically after the run; a file that cannot be written is exit 4 (`results-write-failed` or `report-write-failed`), and the others are still written.

## Output

- **Text (default):** one line per input, `PASS  path`, `FAIL  path`, `ERROR path`, `NEEDS-READER path` or `UNSUPPORTED path`, then details for each failed check and finding, each starting with `<severity>/<certainty>` (`major/medium  truncated (overflow) "Weiter zur Kas"`; JSON `kind` is unchanged), gating findings sorted first, then the findings below the thresholds as `note` lines (hidden by `--quiet`). `read` lists the recognized lines under each input. The last line is the totals line: `12 images: 10 pass, 1 fail, 1 error (0.8 s)`, plus `, 3 below threshold (--min-certainty high)` when the thresholds kept findings from gating.
- **JSON:** one envelope per input, keys sorted, byte-for-byte stable apart from `ms` and `host` on the same catscan version, macOS build and host class. The schema is [`core/schema/result.schema.json`](../core/schema/result.schema.json).
- **stderr:** warnings and input errors as `catscan: <code>: <message> - try: <hint>`, then, unless `--quiet`, the counts per verdict: `catscan: counts: 10 pass, 1 fail, 0 needs-reader, 0 unsupported, 1 error`. stdout never carries diagnostics.

### The JSON envelope

```json
{"catscan":"<version>","checks":[{"box":[0.0908,0.2228,0.3215,0.0248],"confidence":1,"kind":"present","line":"Jetzt testen","text":"Jetzt testen","verdict":"pass"}],"command":"check","device":null,"engine":"vision-accurate-rev3","findings":[],"host":{"arch":"arm64","chip":"Apple M5","host_class":"physical","macos":"27.2 (26B123)","vision_revision":3},"image":{"height":2796,"width":1290},"locale":"de","ms":77,"path":"03-de-phone.png","platform":null,"schema":1,"screen":null,"text_size":null,"verdict":"pass","warnings":[]}
```

- `verdict`: `pass`, `fail`, `needs-reader` (catscan reads the locale with Tesseract, which is missing or lacks its language data; `error.code` `reader-missing`, the hint is the fix), `unsupported` (no reader in catscan reads the locale) or `error` (the input could not be read). The last three carry `error: { code, message, hint? }`.
- `checks[]`: `kind` (`present` or `absent`), `text`, `verdict` (`pass`, `fail`, `skipped` with a `reason`, `needs-reader` or `unsupported`), and where the text was found: `box`, `line`, `confidence` (all `null` when it was not found). A failed `present` check adds `closest`: the recognized line with the smallest edit distance, with its `box` and `distance` (`null` when nothing was recognized).
- `pseudo: true` marks a run with `--pseudo` ([Pseudo-localized builds](#pseudo-localized-builds)); the key is absent otherwise.
- `read` adds `lines[]`: `{ text, box, confidence }`, top to bottom, then left to right (right to left for ar, he, fa, ur).
- Boxes are `[x, y, width, height]`, normalized 0..1, origin top left, 4 decimals. Confidence has 2 decimals.
- `host` is the machine: `chip`, `arch`, `host_class` (`physical` or `vm`), `macos` as `"<version> (<build>)"` and `vision_revision`. CI identity is not part of it (it belongs to the results file).
- `screen` is the screen id from `--layout`; `null` when the layout is `none` or the path does not match it.
- `device` is the device label from `--device` or a `{device}/` layout, `platform` its platform (`ios`, `android`, ...) when the label starts with one; both `null` otherwise ([Device axis](./results.md#device-axis)).
- `text_size` is the text-size label from `--text-size` or a `{text_size}/` layout, `null` otherwise, which a cell reads as `default` ([Text-size axis](./results.md#text-size-axis)).
- `schema` is 1 and frozen; fields can be added in minor versions.
- Every finding and every failed check carries `severity`, `certainty`, `precision` and `gate` ([Severity and certainty](#severity-and-certainty)). `findings[]` keeps the order the rules ran in: it is stable, not a priority; sort by `gate`, then severity, then certainty to fix the worst first.

## Severity and certainty

`confidence` is how well one line was read; `certainty` is how often a finding of that kind is a real defect.

```json
{ "kind": "truncated", "reason": "overflow", "line": "Weiter zur Kas", "severity": "major", "certainty": "medium", "precision": 0.998, "gate": true }
```

- **`severity`:** `critical`, `major` or `minor`: how much a real defect of this kind hurts a user, fixed per kind and rule. `critical`: a failed check, `missing`, `raw-key`, `placeholder`, `wrong-language`, `occluded`, `currency`, `price`. `major`: `truncated`, `overlap`, `untranslated`, `hardcoded`, `uncatalogued`, `pseudo-not-applied`, `format`. `minor`: none yet.
- **`certainty`:** `high`, `medium` or `low`: how likely a finding of this kind, from this reader, is a real defect, from its published precision ([BENCHMARKS.md](./BENCHMARKS.md)): `low` for an experimental rule, a reader with no measurement (Tesseract) or an unmeasured rule; `high` at a real-screen precision of 0.95 or more over at least 20 flags not used to tune the rule, `medium` at 0.80 or more; else `medium` at a synthetic precision of 0.90 or more. Synthetic numbers alone never give `high`. `missing` is deterministic: `high`.
- **`precision`:** the measured precision the band came from (3 decimals), or `null` when the band does not come from one (experimental, unmeasured, deterministic).
- **`gate`:** `true` when the item fails the input under the run's thresholds. Failed checks always gate: a check is your own assertion. A finding approved in a `--known` file has `known: true` and never gates ([results.md](./results.md#known-findings)).
- **Verdict:** `fail` when a check failed or a finding gates; an input whose findings all fall below the thresholds is `pass` and keeps them with `gate: false`. `error`, `needs-reader` and `unsupported` are unchanged.
- **Thresholds:** `--min-severity` and `--min-certainty` on `check` (its `missing` entries), `untranslated`, `truncated`, `overlap`, `formats`, `results merge` and `report`. On `read`, `video` (checks only, which always gate), `doctor`, `languages`, `boxes`, `serve` and `pseudo` they are `option-not-valid` (exit 2). The MCP tools take `min_severity` and `min_certainty`, the Playwright matchers `minSeverity` and `minCertainty`, with the same defaults.
- **Results files:** the file records `run.thresholds` and `run.registry` (the registry that set the bands). Threshold flags on `results merge` or `catscan report` recompute `gate`, verdicts and totals from each item's stored severity and certainty; without them each shard's `gate` is kept ([results.md](./results.md)).

Bands per kind and rule (generated from `packages/core-js/src/findings-registry.json`; a new rule ships with its row):

<!-- bands:start -->
| Kind | Rule | Severity | Vision certainty (precision) | Tesseract certainty |
| --- | --- | --- | --- | --- |
| `check` | `present` | critical | medium (0.980) | medium (1.000) |
| `check` | `absent` | critical | medium (0.980) | medium (1.000) |
| `missing` | - | critical | high (deterministic) | high |
| `raw-key` | - | critical | medium (1.000) | low |
| `placeholder` | - | critical | medium (1.000) | low |
| `missing-glyphs` | - | critical | low (experimental) | low |
| `wrong-language` | `catalog` | critical | medium (1.000) | low |
| `wrong-language` | `langid` | critical | medium (1.000) | low |
| `occluded` | `elements` | critical | low (experimental) | low |
| `currency` | `unexpected` | critical | medium (0.982) | low |
| `currency` | `mixed` | critical | medium (1.000) | low |
| `price` | `amount` | critical | medium (0.986) | low |
| `price` | `period` | critical | medium (1.000) | low |
| `price` | `trial` | critical | medium (1.000) | low |
| `truncated` | `ellipsis` | major | medium (1.000) | low |
| `truncated` | `prefix` | major | medium (1.000) | low |
| `truncated` | `edge` | major | medium (1.000) | low |
| `truncated` | `screen-edge` | major | medium (1.000) | low |
| `truncated` | `overflow` | major | medium (0.998) | low |
| `truncated` | `pseudo-cut` | major | medium (0.992) | low |
| `overlap` | `elements` | major | medium (0.824) | low |
| `overlap` | `boxes` | major | low (experimental) | low |
| `overlap` | `stacked` | major | medium (1.000) | low |
| `overlap` | `sheets` | major | medium (1.000) | low |
| `untranslated` | - | major | medium (1.000) | low |
| `hardcoded` | `base` | major | medium (0.991) | low |
| `hardcoded` | `none` | major | medium (0.991) | low |
| `uncatalogued` | - | major | low (experimental) | low |
| `pseudo-not-applied` | - | major | medium (1.000) | low |
| `format` | `number` | major | medium (1.000) | low |
| `format` | `date` | major | medium (1.000) | low |
| `format` | `time` | major | medium (1.000) | low |
| `format` | `currency-placement` | major | medium (0.991) | low |
| `fit` | `cutout` | major | low (experimental) | low |
| `fit` | `corner` | major | low (experimental) | low |
| `fit` | `home-indicator` | major | low (experimental) | low |
| `fit` | `wrapped` | minor | low (experimental) | low |
| `fit` | `orphan` | minor | low (experimental) | low |
| `low-contrast` | - | major | low (experimental) | low |
| `busy-background` | - | minor | low (experimental) | low |
<!-- bands:end -->

## Matching

Both the check text and each recognized line are normalized: Unicode NFKC and lowercase; `...` and `…` removed; quotes, apostrophes (the modifier letter `ʼ` as Vision reads a Ukrainian apostrophe too) and dashes unified; whitespace collapsed (removed for ja, ko, zh, yue, th); `_` read as a space; Cyrillic-Latin homoglyphs (`а в о е р с х`) folded for ru, uk and Latin-script locales. A string is present when it is a substring of one line, or of two consecutive lines joined with a space (wrapped text).

A check string shorter than 4 characters after normalization (2 for ja, ko, zh, yue, th) matches only on word boundaries in spaced scripts (`OK` does not match `BOOK`) and adds the warning `short-check-text`.

Matching compares whole grapheme clusters, so a match never splits a Devanagari conjunct, a nukta or a Thai vowel mark from its letter. Arabic is compared in logical order, as Vision returns it.

## `--expect` files

```yaml
locale: de
shots:
  onboarding-1.png: { present: ["Weiter"], absent: ["onboarding.next"] }
  "paywall-*.png":  { present: ["Jetzt testen"] }
```

- Keys are matched against each image's path relative to the folder argument that found it (for a file argument, its file name), not relative to the expect file: `catscan check shots/de --expect checks/de.yaml` matches `onboarding-1.png` in `shots/de/`.
- Globs: `*` and `?` stay inside one path segment, `**` crosses segments, `[abc]` and `[!abc]` are classes. Keys must be relative and must not contain `..`. Globs only select among the inputs given on the command line; they never cause other files to be read.
- An image can match several keys; their checks add up, together with any `--present` / `--absent`. An image that matches no key gets only the command-line checks. A key that matches no image gives the warning `expect-key-unmatched`, and an input no check applies to gives `no-checks`; both print even under `--quiet`. Keys and paths are compared in Unicode NFC, so names stored in NFD still match. Expect keys never apply to stdin (`-`): `check - --expect f.yaml` without `--present` or `--absent` is a usage error.
- `locale` applies when `--locale` is not given.
- Safe parsing: at most 1 MB; YAML 1.2 core schema; custom tags (and YAML 1.1 extras such as `!!binary`) are rejected; alias expansion is capped at 1000 nodes; unknown keys are errors. Files ending in `.json` are parsed as JSON.

## Catalogs

`--catalog` reads the strings a check refers to by key, straight from the app's localization files:

```
catscan check shots/en --catalog locales/en.json --present @home.title --absent @debug.banner
catscan check shots/de --locale de --catalog 'locales/{locale}.json' --expect checks.yaml
catscan check shots/ --catalog Localizable.xcstrings --all-keys --json
catscan check shots/de --locale de --catalog 'src/i18n/{locale}.ts' --present @settings.title
```

- `@key` works in `--present`, `--absent` and `--expect` files. `@@` at the start is a literal `@` (`--present @@handle` checks the text `@handle`).
- Paths, and the `{locale}` template, are read from the working directory. `{locale}` takes the run locale: `--locale`, else the `--expect` file's `locale`, else `en`. A locale with no file gives `catalog-missing`, and every `@key` check of the run is `skipped`, even keys another `--catalog` defines.
- An `@key` the catalogs do not define is a usage error that names the closest keys. A key defined with no string for the locale (an untranslated `.xcstrings` entry) is `skipped` with reason `catalog-missing`.
- `@key` checks come after the literal `--present` and `--absent` checks in `checks[]`. Each one carries `key`, `catalog` (its file) and `text` (the string as written in the catalog); the text line reads `present @home.title "Welcome back, {name}!" (locales/en.json): not found; closest ...`.

| Format | Detected by | What is read |
| --- | --- | --- |
| JSON, flat or nested | `.json` | Every string; nested keys joined with `.`, array items as `key[0]`. i18next `key_one`, `key_other` are separate keys. |
| Apple `.strings` | `.strings` | UTF-8 or UTF-16 (with or without a BOM); `/* */` and `//` comments; escapes `\"`, `\n`, `\t`, `\U00E9`. |
| Apple `.xcstrings` | `.xcstrings` | The `stringUnit` values for the locale (exact code, then its language: `pt-BR` -> `pt`), including plural and device variations and `%#@name@` substitutions. The source language falls back to the key; `shouldTranslate: false` uses the source string. |
| TypeScript or JavaScript | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | The object the file exports, read as text and never run ([Code catalogs](#code-catalogs)). A file that holds a bare JSON object is read as JSON. |
| Android `strings.xml` | `.xml` | `<string>`, each `<item>` of `<plurals>` (one key), `<string-array>` as `name[0]`, `name[1]`; skips `translatable="false"`; `@string/name` references (4 hops); escapes `\'`, `\"`, `\n`, `\@`, `\?`, `\u00e9`, CDATA; `formatted="false"` keeps `%` literal. |

Other extensions are detected by content.

### Code catalogs

catscan reads the strings of a TypeScript or JavaScript catalog without running it: it never executes, imports or evaluates the file, so a catalog cannot run code on the machine that checks it.

- **Which object:** `export default {...}` or `module.exports = {...}` (the last one in the file wins); else the one exported object (`export const de = {...}`). A file with several exports named like locales (`en`, `de`, `pt_BR`, `ptBR`) gives the run locale's object (exact code, then its language); with no export for the run locale it counts as a missing catalog (`catalog-missing`). Several other exports become namespaces: `export const common = { ok: 'OK' }` is `@common.ok`. An export can name a `const` object defined in the same file (`const de = {...}; export default de`), and `as const`, `satisfies Type`, `as Type` and type annotations are allowed.
- **What is read:** string literals (every JavaScript escape), templates with no `${...}`, numbers, and nested objects and arrays, keyed as in JSON (`a.b`, `items[0]`). Keys may be names, strings, numbers or computed strings (`['a.b']`). A key written twice in one object keeps the last value.
- **What is skipped:** a template with `${...}`, a call (`t('x')`, `defineMessages({...})`), a function or method, a reference to something outside the file (an import), `'a' + 'b'`, `true`, `false` and `null`, every key written before a `...spread` or a computed key it cannot read (`[KEY]`) in the same object (either may replace it), and every array item after a spread (its index is unknown). A spread in a later `--catalog` file also skips the earlier files' keys below it, since the last file wins. Each skipped key stays defined: its `@key` check is `skipped` with reason `catalog-value-dynamic`, as is an `@key` below it or one only a spread could supply, and `untranslated`, `truncated` and `formats` do not use it; `untranslated` does not report a base key as missing from a target where a spread could supply it. One `catalog-values-skipped` warning per file counts them by kind and names up to three keys.
- **Plain literals only:** a catalog object may appear only where it is declared, where it is exported, in a `typeof` type, and inside another catalog literal as a value, a spread or a key that only names it (`{ common }`, `...base`, `[KEYS.title]`, `` `Play ${APP}` ``). Any other use (`m.title = 'x'`, `delete m.title`, `Object.assign(m, more)`, `const n = m`, a call such as `f(m)`, code in a function) could change it while the app runs, so catscan reads no key of that file: one `catalog-values-skipped` warning names the file and the line of that use, and every `@key` of the file is `skipped`, never reported missing.
- **Fixes:** write the strings as literals, or pass the JSON file the code imports with `--catalog`. A default export that is a call or an import, or an index file that only re-exports other files (`export default { de, en }`), is `invalid-catalog`, and the message names the file to pass instead.
- JSX values (`<b>Bold</b>`) in `.jsx`, `.tsx` and `.js` files are skipped like other code. A file whose reused objects (`{ a: shared, b: shared }`) would expand to more keys than it has characters is `invalid-catalog`.
- A string in a code catalog is matched like a JSON string: the same placeholder, ICU and markup rules below. `pseudo` does not write code catalogs (`format-not-supported`). A plural or variation is one key with several alternatives: `@key` is present when any form is shown.

**From a catalog string to fragments:** markup is dropped with its text kept (`<b>`, `<1>`; `<br/>` is a line break), then the string is split on its placeholders. Fragments shorter than 4 characters (2 for ja, ko, zh, yue, th) are dropped after normalization ([Matching](#matching)).

| Placeholder style | Catalog string | Fragments |
| --- | --- | --- |
| `{name}` | `Welcome back, {name}!` | `Welcome back,` (the `!` is too short) |
| `{{name}}` | `Hello {{user}}, good morning` | `Hello`, `, good morning` |
| `{0}` | `Order {0} has shipped` | `Order`, `has shipped` |
| `%@`, `%d`, `%s` | `Hello, %@! You have %d new messages` | `Hello,`, `! You have`, `new messages` |
| `%1$s` | `%1$@ invited %2$@ to the party` | `invited`, `to the party` |
| `%.2f` | `Total price: %.2f euros` | `Total price:`, `euros` |
| `%%` | `Save 50%% on everything` | `Save 50% on everything` (a literal `%`) |
| ICU plural, select | `{count, plural, one {# file selected} other {# files selected}}` | `file selected` or `files selected` (`#` is a placeholder) |

- **Present:** every fragment of one form is shown, in order and without overlap, on one line or two consecutive lines. A key with forms that have no fragment left (`OK`, `%d min`) is `skipped` (`no-checkable-text`) unless another form is found.
- **Absent:** the longest fragment of every form is not shown.
- **Untrusted input:** a catalog over 20 MB, catalogs whose checks serialize to over 32 MB, nesting past 64 levels, a key defined both flat and nested, or a lone surrogate escape is a usage error. XML with a `<!DOCTYPE>` or an entity other than `&lt; &gt; &amp; &quot; &apos;` and numeric references is rejected. A string over 64 KB, or one that expands past 256 fragments or 4 nested plurals, is `skipped` with reason `catalog-string-capped`, never checked in part.
- **`--all-keys`:** each envelope gets `inventory: { found: [{key, line, box}], not_found: [key], skipped: [{key, reason}] }`, sorted by key, and the text line `inventory: 12 of 40 keys found`. The inventory never changes a verdict; an unreadable input is still `error`.

## Untranslated

```
catscan untranslated shots/de --locale de --base locales/en.json --catalog locales/de.json [--allow allow.txt]
```

Finds four defects (five with the experimental `uncatalogued`) on a translated screen, and exits 1 when it finds any:

- **`untranslated`:** a recognized line (or two consecutive lines) shows a base-locale string, or a line of 3 or more words and 16 or more characters is part of a longer base string (a paragraph wrapped over many lines, for base languages written with spaces; a line that is exactly another string, or is in the allow list, is not reported as the paragraph). Rules: the target string for that key differs from the base string after normalization (shared strings such as `OK` or `Video` are never flagged); the base string keeps 4 or more characters once its placeholders are removed (2 for ja, ko, zh, yue, th), or, when every piece is shorter, reaches it with all its pieces together, so `Go {name} on` is checked and `Go {name}` is not (such short pieces match at most 64 characters apart); it is not in the allow list; and the match is not part of a translation: it does not overlap a target string shown in the same line (`Download` inside `Download starten`), and its line is not a piece of a longer target string (a wrapped sentence quoting `STOP`). Base and target count as the same when their words match without punctuation and accents (`« TAP TO START »`, or `MENÜ` read by Vision as `MENU`). Base strings match on word boundaries and are normalized with the base locale, so English fallbacks are found on Japanese screens too; a change between Latin (or another spaced script) and Han, Kana, Hangul or Thai is a boundary, so `Settingsを開く` is found. A key the target lacks is reported with `expected: null`. Keys with the same base text are one finding; `keys` lists them.
- **`raw-key`:** a line that is exactly a catalog key, or matches `^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$` (`home.title`, `paywall.cta_title`). Domains and file names are not keys: a line starting with `www.`, or ending in a country code (`spiegel.de`, `bbc.co.uk`) or in `com net org io ai app dev co me info edu gov html htm php js json xml txt csv pdf png jpg jpeg gif svg webp heic mp4 mov zip md doc docx xls xlsx ppt pptx rtf odt ods epub mp3 wav m4a aac flac ogg avi mkv webm m4v gz tgz tar rar dmg apk ipa ics vcf yaml yml shop store xyz online site tech cloud biz`; neither is a key that equals one of the catalog strings, as shown (markup dropped) or as a piece beside a placeholder (`coins` of `{count} coins`) (iOS keys-as-text). An exact catalog key is always a key (`button.no`). One space after a dot is OCR noise (`settings. language`); two or more make a tagline (`denken. machen. teilen`), not a key. A raw-key line is not checked for base strings.
  Game-UI rendering changes how Vision reads a key, so a catalog key (two or more segments) is also found when:
  - its separators (`.` `_` `-` `/` `:`) are read as a space, `,`, `·` or `|`: `settings support`, `ui: shop:title` (bold, outlined and spaced text). Case counts: `Settings Support` is a title;
  - it is drawn in ALL CAPS with a visible separator: `SETTINGS.SUPPORT` or `SETTINGS · SUPPORT` (`SETTINGS SUPPORT` and `SETTINGS: SUPPORT` stay text);
  - it is cut by an ellipsis: `onboarding.permissions.notif...` (8 or more characters with a separator, not the start of a catalog string);
  - it sits inside a longer line: `Einstellungen: settings.support` (only keys with `.` or `_`; the key is not checked for base strings, the rest of the line is);
  - Vision splits it into two observations on one row, or it wraps onto the next line: `settings.` + `support`.

  A line equal to a catalog string (`SIGN-IN` for `Sign-in`) is that string. A key read with spaces only that equals one of the catalog strings (`game over` for `game.over` with the string `Game over`) is that string, not a key. Such a finding names the catalog key in `key` (or every candidate in `keys`). A line you know is not a key goes in the allow list.
- **`wrong-language`:** a line in another of the project's languages (a Spanish string on the Portuguese screen). Two kinds of evidence, catalog first:
  - **`catalog`:** the line is another locale's string for a key, and the run locale's string for that key differs. The other locales are the files a `{locale}` template finds on disk (`--catalog 'locales/{locale}.json'` finds `locales/es.json`, `locales/fr.json`, ...) or the localizations of one `.xcstrings` file. The base-string rules apply as above (shared strings, the run locale's own string around the match, fragments beside placeholders); accents are ignored, since Vision drops them on a screen in another script; a one-word string counts only as the whole line (`dans` inside a French sentence is not the Turkish `Dans`). With `--base` the base language is left to `untranslated`; a string equal to its base string is too. A longer foreign string beats a shorter base string inside it (`Download starten` is German, not English `Download`).
  - **`langid`:** on a line no catalog explains, Apple's language recognizer (`NLLanguageRecognizer`), limited to the project's languages plus the run language, names another language with probability 0.95 or more while the run language gets 0.02 or less. Only lines of 3 or more words (of 2 or more letters) and 15 or more letters, or 8 or more letters of Japanese, Korean, Chinese or Thai; the language must write every non-Latin script of the line. A line whose letters are all in a non-Latin script the run locale does not write (Cyrillic on a Portuguese screen) counts at 4 letters. Lines in the run locale's catalog, allow-list lines, and lines without letters are never judged.

  Vision reads only the scripts of the run locale (`catscan languages`), so a Cyrillic or CJK line on a Latin screen is read as other letters or not at all and is not found; neither is a string under the length rule (one CJK character). It runs whenever the other languages are known; otherwise every envelope says `wrong-language-unchecked` with the hint. The finding names `language` (the other locale), `expected_language` (the run locale), `evidence`, `confidence` (the recognizer's probability, 1 for catalog and script evidence) and, with catalog evidence, `key`, `catalog` and `expected` (the run locale's file and string to fix) and `evidence_catalog` (the file that holds the line). Measured gates: [BENCHMARKS.md](./BENCHMARKS.md#wrong-language).
- **`uncatalogued`** (experimental, with `--uncatalogued --experimental`): a line no string of any loaded catalog explains, so it is probably hardcoded in the build. Certainty low.
- **`placeholder`:** an unfilled token: `{name}`, `{{name}}`, `${name}`, `%@`, `%d`, `%s`, `%1$s`, plus the catalog's own styles (`{0}`, ICU `{n, plural, ...}`, every printf form). `100% done`, `50 %` and `100%%` are prose. Full-width braces (`｛count｝`, as Vision reads them on CJK screens) count.

Runs: without catalogs, only key-shaped lines and placeholders are reported; `--catalog` adds exact keys and its placeholder styles; `--base` with `--catalog` adds the base-string rule. One run checks one locale: a `{locale}` template needs `--locale` (`missing-locale`), and the many-locale matrix arrives with the layout file. When every target resolves to the base catalog (the same file, by identity) for the same locale, or every target string equals its base string, the rule is off and every envelope says `untranslated-base-catalog`; with several `--catalog` files, a string that only the base file supplies is a missing translation (`expected: null`); one `.xcstrings` file can be both, because it is read for `sourceLanguage` as the base and for `--locale` as the target.

**Allow list:** one string per line, UTF-8, blank lines and lines starting with `#` ignored, compared after normalization. An entry suppresses an equal base string and a line equal to it (raw keys, placeholders).

**Output:** each finding is one line under the input's `FAIL` line, and one object in the envelope's `findings`:

```
FAIL  shots/de/settings.png
  untranslated @settings.privacy "Privacy" (locales/de.json: "Datenschutz") in "Privacy" at [0.08, 0.42, 0.21, 0.03]
  raw-key "paywall.cta_title" at [0.2, 0.7, 0.6, 0.04]
  raw-key "settings support" (@settings.support) at [0.1, 0.8, 0.5, 0.04]
  placeholder "{count}" in "{count} Artikel" at [0.1, 0.3, 0.4, 0.03]
  wrong-language es @shop.buy (locales/de.json: "Jetzt kaufen"; matched locales/es.json) in "Comprar ahora" at [0.1, 0.5, 0.4, 0.03]
  wrong-language fr (language ID 0.99; de expected) in "Enregistrez vos modifications avant de quitter" at [0.1, 0.6, 0.7, 0.03]
```

```json
{ "kind": "untranslated", "key": "settings.privacy", "catalog": "locales/de.json", "base": "Privacy", "expected": "Datenschutz", "line": "Privacy", "box": [0.08, 0.42, 0.21, 0.03] }
{ "kind": "raw-key", "line": "paywall.cta_title", "box": [0.2, 0.7, 0.6, 0.04], "key": "paywall.cta_title" }
{ "kind": "raw-key", "line": "settings support", "box": [0.1, 0.8, 0.5, 0.04], "key": "settings.support" }
{ "kind": "placeholder", "line": "{count} Artikel", "token": "{count}", "box": [0.1, 0.3, 0.4, 0.03] }
{ "kind": "wrong-language", "line": "Comprar ahora", "box": [0.1, 0.5, 0.4, 0.03], "language": "es", "expected_language": "de", "evidence": "catalog", "confidence": 1, "key": "shop.buy", "catalog": "locales/de.json", "expected": "Jetzt kaufen", "evidence_catalog": "locales/es.json" }
```

`base` and `expected` are the catalog strings as written; plural and variation forms are joined with ` | `. `catalog` is the target file to fix. Findings are in reading order; when two base strings overlap in one line, only the longer is reported.

## Video

```
catscan video takes/round-end.mp4 --present "GAME OVER" --absent "KEY_" --json
```

Samples the video every `--every` seconds (default `0.5`) from `--from` to `--to` (default: the whole video), reads each sampled frame like `check` reads an image, and gives one verdict per check over all frames:

- **`--present`:** passes when the text is on **at least one** sampled frame. To require text over a span, use an `--expect` range.
- **`--absent`:** passes when the text is on **no** sampled frame. Text shown for less than `--every` can fall between two samples and be missed: use a smaller `--every` (down to one frame) for such checks.
- **Times:** samples are at `from + k * every` while the time is at most `--to` and before the end of the video track (audio that runs past the last frame does not extend it); grid times before the video track's first frame are skipped. Each frame comes from the exact time (no keyframe snapping); the reported time is the decoder's frame time, rounded to milliseconds, and a frame returned twice (variable frame rate) is read once. Rotated phone recordings are turned upright. At most 20,000 samples per video (`video-too-many-frames`).
- **Inputs:** MP4 and MOV in any codec AVFoundation decodes (H.264, HEVC, ProRes). Not stdin (`-`), not `--all-keys`, and no Tesseract fallback: a locale Vision cannot read is `unsupported` (exit 3), even one that screenshots read with Tesseract. A file that is missing, unreadable or has no video track is an input error (exit 4) whatever the locale.

**`--expect` ranges:** a video expect file has `ranges:` instead of `shots:`, applied to every video of the run. A key is `"<start>-<end>"` or `"<start>-"` (to the end) in seconds; bounds are inclusive and compared with each sample's requested time (`from + k * every`), not the decoded frame time. A range with no sampled frame gives its checks `skipped` (`reason: range-empty`) and a `range-empty` warning.

```yaml
locale: de
ranges:
  "0-2.5":
    present: ["Tippen zum Starten"]
  "4-":
    present: ["@game.over"]
    absent: ["KEY_"]
```

**Output:** the text line counts frames, and failed checks give times:

```
FAIL  takes/round-end.mp4 (12 frames)
  present "GAME OVER": not found on 12 frames; closest "GAME 0VER" (distance 1) at 4.5 s
  absent "KEY_" [4-]: shown 4.5 s-5 s in "KEY_TITLE" at [0.1, 0.2, 0.3, 0.04]
3 videos: 2 pass, 1 fail (2.4 s)
```

The JSON envelope has `command: "video"`, `image: null`, `video: { width, height, fps, duration }` (upright size; `duration` in seconds, to the video track's end) and `frames` (the frames read). Each check adds `first_seen` and `last_seen` (frame times, `null` when never found), `range` for an `--expect` range, and a failed `present` check's `closest` adds `t`, the time of that frame. With `--json --frames`, each sampled frame first gets a line `{"catscan","command":"video-frame","lines":[{text, box, confidence}],"path","schema":1,"t"}` ([`core/schema/video-frame.schema.json`](../core/schema/video-frame.schema.json)); filter lines by `command`.

## Truncated

```
catscan truncated shots/de --locale de --boxes shots/de
```

Reports text the UI cut off: one finding per cut line, exit 1 when there is any. Each finding has a `reason`:

| Reason | Needs | Fires when |
| --- | --- | --- |
| `ellipsis` | nothing | The line ends in `...`, `…`, `⋯` or `‥` (right to left: at either end; a trailing chevron is ignored), unless its element's text or a catalog string is that same text with the ellipsis (`Share…`). Dots alone (page dots, a `⋯` menu button) are not text. |
| `prefix` | element `text`, or `--catalog` | The element's lines, joined, are a strict prefix of its `text` (`Einstellun` for `Einstellungen`), at least 4 characters (2 in ja, ko, zh, yue, th), and the rest of the text is not on another line of the screen; or, for a line with no element text, it is a strict prefix of a catalog string (at least 4 characters and at most 85% of it) that is not on the screen itself. A line that is a row of a catalog string shown whole, on one row or wrapped onto the rows below it, is no prefix finding. Rows wrapped onto each other that spell only the start of a catalog string with a placeholder, past the text before its first placeholder, are a cut reported once on their last row when that row ends mid-word or in a lone misread symbol (`›`) where the string goes on. A row that joins catalog strings with `·`, `•` or `|` and stops mid-word in its last part is a prefix finding of that last string. A line with no element text is no cut of a catalog string where it could not end a wrapped row: when the string goes on with punctuation no line starts with (`Enter` for `Enter: go to...`), or when the line ends in punctuation the string does not have there (`less.` for `Less rivals`). |
| `edge` | `--boxes` | The line's trailing end (the left one right to left) is within 0.15 line heights of its element's edge, while its start is not (a frame that hugs its text is skipped). Elements with `clips: false` or `offscreen: true`, and elements whose lines sit on two rows, are skipped. |
| `overflow` | `--boxes`, element `text` | The line is drawn at least 1.0 line height past its element's trailing edge (the left one right to left), or, for centered text, past both edges by more than 0.3 line heights and one of them by at least 1.0; it is the element's own text (it occurs in the element's `text`) and does not end in an ellipsis. The finding adds `overflow`, the line heights past the edge (2 decimals). Elements with `offscreen: true` and elements as large as the screen are skipped; `clips: false` elements are checked too. Only elements whose `text` holds the line take part in its assignment (the other reasons keep the plain 80% owner): the smallest of them holding 80% of the line, else the one holding its first 3 characters (2 in ja, ko, zh, yue, th), else the smallest inside it and centered on it; so a card, row or icon without the line's text never takes it from its label. The line is measured from its first to its last letter or digit, plus the symbols the element's own text has at those ends ("9,99 €"), so a bullet, chevron or icon read into it does not count. An element with `offscreen: true` never takes the line. |
| `screen-edge` | nothing, or the element text | A line with no element (or every line without `--boxes`) ends within 0.15 line heights of the screen edge. With `--boxes`, also a line that sits inside a longer element text and whose missing ends are all at the screen edge (a view wider than the screen, its dump box clamped to the viewport); `expected` is that text. |

Each line goes to the smallest element that holds 80% of its box. With `--boxes <dir>`, the boxes of `shots/de/shop.png` (folder argument `shots/de`) are `<dir>/shop.boxes.json`; an image with no sidecar is checked without boxes and gets `boxes-missing`, shown even with `--quiet`. A boxes file whose aspect ratio differs from the screenshot's by more than 1% is `boxes-mismatch` (exit 4 for that image); a different scale is fine, since boxes are normalized.

**Boxes file:** `{"image": {"width", "height"}, "elements": [{"id", "box": [x, y, width, height], "text", "clips", "offscreen"}]}`, boxes normalized to 0..1 from the top left; `text` is the string the element should show, `clips` (default `true`) says the element hides overflow. `catscan boxes` writes it ([Boxes](#boxes)).

**Text matching:** every comparison uses catscan's text normalization, which also drops bidi marks, zero-width characters and soft hyphens, the space Vision puts after `¿` and `¡`, and a disclosure glyph at either end with its spaces (`>` `›` `»` `〉` `❯` `→` `▸` at the end, `<` `‹` `«` `〈` `❮` `←` `◂` at the start). So an element `text` of `Settings  >` read as `Settings ›` is not a prefix. Element `text` comes from the first non-empty field of the dump: Maestro `text`, `accessibilityText`, `hintText`; XCUITest `label`, `value`, `title` (a text field: `value` first); UiAutomator `text`, `content-desc`, `hint`; Playwright visible text, then `aria-label`. On tree dumps only the innermost element with a string keeps it, so a container's joined label is never compared; on a one-row element, a line equal to the text up to a separator (`,` `、` `，` `،`: `Play` of `Play, button`) is not a prefix.

**When a rule stays silent** (each with what to check in the sidecar when you expected a finding):
- `edge` and `screen-edge` skip a line with no letter or digit (a back chevron read as `<` or `^`). Nothing to fix: such a line is not text.
- `edge` skips a line that holds two or more on-screen elements with different `text`, each at least half inside the line (Vision merged an icon, a label and a value into one line). Check that the row's label and value are separate elements only when they are separate views.
- `edge` skips a line that ends more than 0.3 line heights past its element's edge: the glyphs show past the frame, so the frame does not clip them. Check that the element's box is the view that clips the text, taken at the same moment as the screenshot.
- `edge` skips a line equal to its element's whole `text`: every character is on screen.
- `overflow` is silent when, in this order: no element's `text` holds the line (nothing to measure against); the line is less than 1.0 line height past that element (iOS frames narrower than their glyphs overhang by up to 0.63 line heights on intact text); or the line ends in an ellipsis. A container whose `text` merges its children's (an Android `content-desc`, an XCUITest cell label) holds the line too and, being the only element holding 80% of it, takes it from the label, so a label running past its frame inside such a container is not reported; drop the container's `text` from the sidecar to measure the label. Vision sometimes reads a symbol next to the text into the line (a bullet, chevron or status icon); only the stretch between such symbols is measured, but a symbol Vision leaves out of the text still widens the box: on real screens 3 overflow flags in 535 screens remain, all false, 2 of them the Android status-bar clock. Check that the element's box is the text view, not a smaller inner frame, and leave the reason out with `--reasons` if your screens draw glyphs right next to labels.
- `edge` skips a line whose first characters (3, or 2 in ja, ko, zh, yue, th; never its last one) do not occur in its element's `text`: the line landed in another view's element. Check the element's `text` is the string it shows, not a spoken label (`69 por ciento de descuento` for `69% DTO.`).
- `prefix` skips, on a one-row element, a missing rest that is a number alone while the line ends short of the element's edge (Vision does not read a lone `6` after `SHIFT`); and a rest that another line on the screen starts with, compared without spaces or punctuation (`(3 dni)`), or, under 4 characters, that the row just below the element is exactly. Check that the element's `text` matches the screen's version of the string. With `--catalog` and no element text, rows count as one wrapped string when each is the next row down under the one above (no other row between them, at most 4 rows down), starts within 1.5 line heights of it, overlaps it across, and together they spell the whole string (case, accents, spaces and a hyphen at the break aside); a placeholder string's text before the placeholder, if 4 characters or more, is enough when a word boundary follows (`Shift 6` for `Shift {n}`), but only for the rows of that string: a line that is also the start of another catalog string is still reported. A misread row still leaves the first row reported: add it to `--allow`. A cut across rows of a placeholder string (the string's start on the first row, each placeholder read as a value of 1 to 24 characters, a hyphen at a break either dropped or kept) is checked in languages written with spaces only, up to 8 rows; it is not reported while the next row down still matches the string, or when the rows stop at a word boundary with nothing misread, and `--allow` with the last row's text silences it. A cut after a separator is also checked in languages written with spaces only, when every part before the last is itself a catalog string and the last part has 4 characters or more; it is not reported when the rows below go on with that string (up to 8 rows) or when the screen shows that piece of the string whole elsewhere, and `--allow` with the row's text silences it. The two punctuation checks for a line with no element text: the marks that no row starts with are closing and separating punctuation (`:` `;` `,` `.` `!` `?` `)` and the like; a space before `:` `;` `!` or `?`, as French sets them, counts too), not a quote, a middle dot, a hyphen or dash, `/`, `&`, `*`, `#`, `%` or `@`, and not a `.` or `,` inside a token like `1.0`; a line that ends where one catalog string goes on with such a mark is that string's label, so it is not reported as a mid-word cut of another string (`Enter` against `Entertainers`), but it still is as a cut of a string that goes on after a space (`Fast` against `Fast mode on`); the punctuation a line ends in counts only for sentence marks and closing brackets (`.` `,` `;` `:` `!` `?` `)` `]` `}`, their full-width forms, and the Arabic and Devanagari marks), compared with the marks the string goes on with before its next word: a hyphen or dash at the end is hyphenation's, and a chevron, bullet or icon is often read into a row's end. Neither check applies when the line ends in an ellipsis, or ends at the screen's trailing edge or, with `--boxes`, at the trailing edge of the textless element it sits in. No flag turns these checks off; to check such a line, give it element text with `--boxes`, where the element rule applies.

**False positives:** leave a noisy reason out with `--reasons` (`--reasons ellipsis,prefix`); list strings that are meant to look cut (`Loading...`) in an `--allow` file; or, in a sidecar, set `clips: false` on an element that does not hide overflow, or remove a `text` that is not the displayed string.

**Output:**

```
FAIL  shots/de/settings.png
  truncated (edge) "Einstellun" at [0.08, 0.42, 0.4, 0.03] in settings-title [0.08, 0.41, 0.4, 0.05], expected "Einstellungen"
```

In JSON, each finding has `kind: "truncated"`, `reason`, `line`, `box`, `element` (`{id, box}` or `null`), `expected` (the full string, or `null`) and `confidence`; an `overflow` finding adds `overflow` (line heights past the element's edge). The text line reads `truncated (overflow) "<line>" at [...] past <element> [...] by <overflow> line heights`.

## Pseudo-localized builds

`catscan pseudo` writes a pseudo-locale catalog (`en-XA`): every string expanded with accented filler words, accented and wrapped in `[` `]`. Build the app with it, capture the screens as usual, then check them with `--pseudo` and the base catalog:

```bash
catscan untranslated shots/ --pseudo --catalog locales/en.json
catscan truncated shots/ --pseudo --catalog locales/en.json
```

Step by step for iOS, Android and the web: [`docs/recipes/pseudo.md`](recipes/pseudo.md).

### `catscan pseudo`

Writes the pseudo catalog from a base catalog (`.strings`, `.xcstrings`, `strings.xml`, i18next JSON). It reads no images and needs no Vision, so it runs on any OS with Node. Run it in the pseudo build job and never commit its output: a pseudo locale must not reach a release build or the store language list.

| Input | Default output |
| --- | --- |
| `locales/en.json` (i18next; namespace folder `en/`) | `locales/en-XA.json` (`en-XA/`) |
| `en.lproj/Localizable.strings` | `en-XA.lproj/Localizable.strings` |
| `Localizable.xcstrings` | the same file, with an `en-XA` localization for every key; needs `--in-place` (Xcode builds every locale from one file) |
| `src/main/res/values/strings.xml` | `src/debug/res/values-en-rXA/strings.xml` (the debug source set, so release builds never ship it) |

| Option | Effect |
| --- | --- |
| `--out <path>` | Where to write; required when the input path matches none of the layouts above (`output-path-unknown`). For an Android variant other than `debug`: `--out src/<variant>/res/values-en-rXA/strings.xml`. |
| `--locale <tag>` | The pseudo locale. Default `en-XA` (`ar-XB` with `--variant rtl`), the CLDR pseudo regions. |
| `--expand <percent>` | Minimum growth of each string, 0-300 (`invalid-expand` outside). Default 40, the growth of German and Finnish. Whole filler words overshoot on short strings (`Shop` -> `[Šhöp öñé]`), as short UI strings do in translation; a placeholder counts as 6 characters. |
| `--variant accent\|rtl\|tall` | `accent` (default, the measured one): safe accent map. `rtl`: text wrapped in U+202E ... U+202C. `tall`: Vietnamese stacked vowels. An unknown name is `unknown-variant` naming the closest. |
| `--in-place` | `.xcstrings` only: write the pseudo localization into the catalog itself (`in-place-required` without it). Every other locale stays as it was; the file is written in Xcode's layout. |
| `--force` | Overwrite an existing output (`output-exists` without it). |
| `--json` | Print the summary as one JSON object on stdout; diagnostics stay on stderr. |

Each translatable string is expanded, accented and wrapped: `"Settings"` -> `"[Šéttíñgš öñé]"`. Only the value bytes change: comments, order, whitespace and escapes outside values stay byte-identical. Never transformed: keys, placeholders in every style catscan reads (`%@`, `%1$s`, `{name}`, `{{name}}`, `${name}`, `$t(key)`, ICU keywords and selectors, whose branch texts are transformed), markup tags (the text between them is transformed), `<xliff:g>` and its content, escapes and entities, Android `translatable="false"` and xcstrings `shouldTranslate: false` entries, empty strings, URLs, e-mail addresses and values of only digits and punctuation. Plural forms are transformed one by one. A catalog where at least 90% of strings are already bracketed and accented is `already-pseudo`. A `.stringsdict` next to the input is not transformed (`stringsdict-skipped`).

Output: one summary line on stderr, then the two next steps for the format, ready to paste:

```
catscan pseudo: 7 strings transformed, 0 skipped, 1 placeholder kept -> locales/en-XA.json
next:
  1. open the app in en-XA (i18next language detector): <app-url>?lng=en-XA
  2. capture the screens, then check them: catscan untranslated shots/ --pseudo --catalog locales/en.json
```

With `--json`: `{ input, output, format, locale, variant, expand, transformed, skipped, placeholders, warnings, next, bytes }`, where `next` is a list of `{ step, command }`. Exit 0 when written, 2 on a usage error (each with a hint), 4 when the output cannot be written. There is no MCP tool for it: it writes build files, so agents run the CLI.

### Checks on pseudo screens

Matching strips the markers and the filler words and folds accents on both sides, so the base catalog is enough and the `--expand` used for the build does not matter (a pseudo catalog passed instead works the same). `--locale en-XA` or `ar-XB` is read as `en`. `--pseudo` with `--base` is `pseudo-conflicts-with-base`; `video` does not take it.

| Finding | Command | Rule |
| --- | --- | --- |
| `truncated`, reason `pseudo-cut` | truncated | A line (or two lines joined) starts with `[` and stops before its string's end with no `]`, or ends with `]` and lacks its start. `lost: "filler"`: the whole base text is shown and the read stops in the filler words, so the base string fits but a 30-40% longer translation will not; `lost: "text"`: the base text itself is cut. `side` is `end` or `start`. Needs no boxes. A complete string whose `]` was not read is not a finding. `ellipsis`, `prefix`, `edge`, `overflow` and `screen-edge` win on the same line. |
| `hardcoded` | untranslated | A line with at least 2 words or 8 letters and no pseudo trait (no marker, no filler word, no accent its base string lacks): the text never went through the pseudo catalog. `evidence: "base"` when it equals a base catalog string (`key`, `catalog`, `expected` name it: the app draws a copy instead of looking up the key), else `evidence: "none"`. Never reported: numbers, prices, dates, times, percentages, scores and counters; the status-bar band (top 4% of the screen); `--allow` and `--dynamic` lines; elements marked `dynamic: true` in `--boxes`; iOS and Android permission dialogs; a line that is a strict part of a catalog string (a wrapped line); lines already reported as `raw-key` or `placeholder`. |
| `pseudo-not-applied` | untranslated, truncated | An image with at least 3 lines with letters, under 20% of them with a pseudo trait: the screen did not load the pseudo locale. Its `hardcoded` lines are not reported. The finding fails the run (exit 1), so a pseudo job whose build fell back to base does not pass. |

`raw-key` and `placeholder` run unchanged (keys are never transformed; an unfilled `{name}` sits inside its markers) and win over `hardcoded` on the same line. The base-string `untranslated` rule is off in `--pseudo`, and `untranslated-base-catalog` is never emitted. On `check`, `--pseudo` only switches matching: literal texts and `@key` checks written for the base language match the pseudo screen.

```json
{ "kind": "truncated", "reason": "pseudo-cut", "side": "end", "lost": "filler", "key": "settings.title", "catalog": "locales/en.json", "expected": "Settings", "line": "[Šéttíñgš ö", "box": [0.05, 0.2, 0.3, 0.03], "element": null, "confidence": 0.9 }
{ "kind": "hardcoded", "evidence": "base", "key": "bonus.daily", "catalog": "locales/en.json", "expected": "Daily reward", "line": "Daily reward", "box": [0.05, 0.3, 0.4, 0.03] }
{ "kind": "pseudo-not-applied", "box": null, "traits": 0.1, "lines": 10 }
```

Text lines: `truncated (pseudo-cut, filler lost) "[Šéttíñgš ö" at [...] @settings.title (locales/en.json: "Settings")`, `hardcoded "Daily reward" at [...] (equals @bonus.daily in locales/en.json; not from the pseudo catalog; look it up by key)`. Every envelope carries `pseudo: true`. Measured on 480 synthetic screens ([BENCHMARKS.md](./BENCHMARKS.md#pseudo-localization)); real pseudo builds are checked on the Android and iOS sample apps (`docs/recipes/pseudo.md`), not measured.

## Overlap

```
catscan overlap shots/de --locale de --boxes shots/de
catscan overlap shots/de --locale de --experimental
```

Reports text drawn over other text or over an icon, image or control: one finding per collision, exit 1 when there is any. Measured numbers: [BENCHMARKS.md](./BENCHMARKS.md#overlap-from-element-boxes).

**Readers.** What runs depends on the flags:

| Given | Readers | `signal` | Status |
| --- | --- | --- | --- |
| `--boxes` (the sidecars `truncated` uses) | element boxes, confirmed by Vision's ink | `elements` | measured: precision 0.91, recall 0.62 (text over text) and 0.78 (text over an icon or image) for overlaps of 4 px and more |
| `--boxes` | two text elements of one line height, one inside the other (sheets or pages drawn over each other), confirmed by Vision's ink | `sheets` | measured: synthetic held-out precision 1.00 (138 flags), 123 of 130 stacked sheets found by an overlap signal; 10 of 11 real stacked sheets; no flag on 1058 real screens ([BENCHMARKS.md](./BENCHMARKS.md#sheets-from-element-boxes)) |
| no boxes, `--experimental` | OCR line geometry | `boxes` | experimental: finds about 1 in 16 real overlaps |
| always, with or without boxes | stacked text: a line Vision reads only without language correction, or reads confidently as words no dictionary knows | `stacked` | measured: 0.78 false alarms per 100 held-out real screens (4 of 514, all reviewed) and none on 69 synthetic findings; finds 10 of 11 real stacked sheets and about 1 in 6 synthetic stacks, more when the lines are offset ([BENCHMARKS.md](./BENCHMARKS.md#stacked-text)) |

Three modes: `--boxes` runs `elements` and `sheets`, plus `stacked`; no boxes runs `stacked` only; `--experimental` adds the OCR-only reader `boxes` on images with no boxes (and `occluded` with boxes). Element-box overlap always needs `--boxes`. `--min-overlap` applies to `boxes`, `elements` and `sheets` only, so without `--boxes` or `--experimental` it is the usage error `option-not-valid` (a `sheets` pair already covers 0.9 of the smaller box, so only a value above 0.9 drops one).

**Stacked text** (every `overlap` run): two or more texts drawn in the same place, such as the pages of a sheet all shown at once. Vision with language correction, how catscan reads, drops such a line or reads it as plausible words; read again without correction, the same ink comes back at Vision's lowest confidence (0.3). catscan reads each image a second time without correction and reports a line, at least 6 letters and 0.8 of the screen's median line height tall, that the corrected read dropped (in a script the locale reads) or read with at least 2 letters changed inside its words. It also reports a line of the corrected read, 0.8 of the median line height tall, when at least 2 of its words are unknown to the macOS dictionaries of the run language and English (any installed English region) and those are at least half of its checked words (digits are dropped before the lookup; words under 3 letters, all-caps words of up to 4 letters and words in a script with no dictionary of the run are not checked; a word that differs from a dictionary word only by accents, a dotless i, an apostrophe or case counts as known). A Latin-script run language with no macOS dictionary (such as `ca` and `ms`; `pt` uses the first Portuguese one, `pt-BR`) checks no word, so only the correction rule runs there; a run in another script with no dictionary (`ja`, `zh-Hans`, `th`) checks its Latin words against English only. The dictionaries are the Mac's: words its user added to the spelling dictionary count as known, so two Macs can differ on a made-up word. A stacked finding inside a `boxes`, `elements` or `sheets` finding is not reported twice. The second read costs one more Vision read per image and shares the image's Vision deadline. When it fails, the image gets the warning `stacked-unchecked`, the dictionary rule still runs on the first read and the other overlap readers' findings stand; when it times out, the image is `vision-timeout`, as for the first read. **What it cannot see:** stacks Vision reads as confident, real words (most crisp stacks of the system font, see BENCHMARKS.md), a single made-up word with no second unknown word beside it, text on a busy background that no read sees (a counter on a checkerboard), stacks of near-identical strings ("1 von 3" over "2 von 3"), and Tesseract reads (`stacked-unchecked`). **False positives:** display fonts, logos and decorative text read differently with and without correction; a line half hidden under an alert or card that reads as non-words; brand or game names that are not words, two or more on one short line; add the line, as either read, to `--allow`; with `--boxes`, an `--allow` entry naming an element (id or text) also keeps quiet a stacked finding over that element and the one drawn on it.

With `--boxes <dir>`, an image with no sidecar is the error `overlap-no-boxes` (exit 4 for that image) naming the sidecar it looked for and the `catscan boxes` command that writes it; with `--experimental` too, that image runs the OCR-only reader and gets `boxes-missing`. This differs from `truncated`, which checks such an image without boxes.

**The `elements` rule.** Two text elements, or a text element and a graphic element (`graphic: true` in the boxes file: an icon, image or control; [Boxes](#boxes)), whose boxes intersect by at least `--min-overlap` (default 0.01) of the smaller box. A pair where one box lies 90% or more inside the other is nesting (a title in its button, a caption on a hero image) and never an `elements` finding; so are two graphics, two elements with the same id and two with the same text. The one exception is `sheets` below. Vision then confirms ink: each text element's ink is the lines it holds (the run of its own text inside a line Vision merged with something else, so an icon read as a character beside a label is not ink), widened to the typographic box; a line Vision garbled across the pair counts for both. A finding needs the two inks, or the text's ink and the graphic's box, to intersect at least 0.15 median line heights deep on both axes, or a partial read of a label touching the graphic drawn over the rest of it. Text Vision does not read is not reported.

**The `sheets` rule.** Pages of a sheet, or sheets, drawn over each other at once give text boxes of one height at one place, so the narrower lies wholly inside the wider. Two text elements one 90% or more inside the other are therefore checked when neither text contains the other (a container's text holds its child's) and their heights agree within 0.9 (a card or a segmented control is taller than what it holds); the same ink test then decides, and a finding has `signal: "sheets"`. A page Vision reads cleanly over nothing of the other (hidden behind it, or not drawn) is no finding. **What it cannot see:** a sidecar that does not sit on its screenshot (every box shifted or scaled: the ink is looked for in the wrong place), stacks in a Tesseract read, two pages Vision reads as one clean string, and two pages whose texts contain one another ("Week" over "Weekend" reads as a container and its label). **False positives:** an accessibility label over a drawn text that Vision garbles; add either text to `--allow`.

**What it cannot see:** overlaps of a few pixels where the letters do not touch (two labels on one row touching or 4 px into each other read the same); a label Vision does not read at all under a bigger collision; text drawn where the dump has no element (a canvas, a view the dump missed). Old sidecars with no `graphic` check text over text only; the run says `no-graphic-elements` once.

**`occluded`** (experimental; with `--boxes` and `--experimental`): text cut off by a panel, an element with `panel: true` in the boxes file (a footer, toolbar, tab bar, keyboard, sheet, alert or toast; [Boxes](#boxes)). A text element whose box crosses a panel's edge (at least `--min-overlap` of the text's box under it, less than 90%) is a finding when a line Vision read of the text ends at that edge and is cut there: its box crosses the edge by at most 0.22 median line heights, and it reads short or garbled, is shorter than 0.85 line heights, or crosses by 0.12 or more. Vision reading the text deeper inside the panel means the panel is see-through there or the text is drawn over it: no finding. `catscan overlap shots/de --boxes shots/de --experimental` checks it on the sidecars you already have, once reconverted with this version. Without `--experimental`, a run whose sidecars have panels says once `occlusion-experimental` with the command to rerun; with it, a run with no panel says `no-panel-elements`. Its measured numbers: [BENCHMARKS.md](./BENCHMARKS.md#occlusion-and-controls).

**What occlusion cannot see:** text hidden entirely (no ink to confirm; modals, the keyboard and scrolled lists hide text by design); text inside a scroll container that can still scroll (`scrolls: true`), since scrolling reaches it; Android and Maestro dumps, which name no panel (dialogs, the keyboard and toasts are other windows); a panel the dump does not report.

**False positives:** an element whose accessibility label is not drawn (`0%` on an iOS progress view, `radio button, checked`) can pair with the text under it; a padded touch target around an icon can meet a label its icon does not. Drop a finding with `--allow` (a line equal to either side's element id or text; for `occluded`, the panel's id too), tighten or remove that element's box, `graphic` or `panel` in the sidecar (or add `scrolls: true` to text a scroll reaches), or raise `--min-overlap`.

**Output:**

```
FAIL  shots/de/settings.png
  overlap "Kontoeinstellungen" / [bell-icon] (47%) at [0.12, 0.31, 0.57, 0.06]
  occluded "Gesamtsumme inklusive Versand" under [footer] (38% of its box under the panel) at [0.04, 0.88, 0.71, 0.04]
  overlap (stacked) "EiD BildastéSBiler" at [0.34, 0.8, 0.32, 0.02]: text drawn over text; Vision reads it only without language correction; read as "EiD Bild asteS Bilder" with correction; if drawn on purpose, add the line to --allow
  overlap (stacked) "4 Bil Bilde refachig Tag" at [0.31, 0.8, 0.38, 0.02]: text drawn over text; Vision reads it confidently as words no dictionary of the run language knows; if drawn on purpose, add the line to --allow
  overlap (sheets) "Hilfe-Center" / "Mitteilungen" (100%) at [0.36, 0.69, 0.28, 0.04]: two sheets drawn over each other; if one is hidden on purpose, leave it out of the boxes or allow it by its id or text
```

A `stacked` finding has `kind: "overlap"`, `signal: "stacked"`, `a` the line read without correction (`{text, box, confidence}`), `b` and `overlap` null (one read, no second line by design), `stacked_evidence` (`"correction-dropped"`: the corrected read dropped the line; `"correction-changed"`: it read other text; `"dictionary"`: the corrected read is mostly unknown words, and `a` is then the read without correction of that box if there is one, else the corrected line) and `corrected`, the corrected read of that box or null. For example: `{"kind": "overlap", "signal": "stacked", "line": "Entn2:AhAckunck", "box": [0.26, 0.77, 0.49, 0.02], "a": {"text": "Entn2:AhAckunck", "box": [0.26, 0.77, 0.49, 0.02], "confidence": 0.3}, "b": null, "overlap": null, "stacked_evidence": ["correction-dropped"], "corrected": null}`.

A `sheets` finding has the `elements` fields with `signal: "sheets"`; `overlap` is the contained share (1 when one box lies wholly inside the other). For example: `{"kind": "overlap", "signal": "sheets", "line": "Hilfe-Center / Mitteilungen", "box": [0.3613, 0.6875, 0.2775, 0.0374], "a": {"text": "Hilfe-Center", "box": [0.3613, 0.6875, 0.2775, 0.0374], "confidence": 1, "element": {"id": "page1-title", "box": [0.366, 0.6857, 0.268, 0.0353]}}, "b": {"text": "Mitteilungen", "box": [0.3613, 0.6875, 0.2775, 0.0374], "confidence": 1, "element": {"id": "page2-title", "box": [0.3641, 0.6857, 0.2718, 0.0353]}}, "overlap": 1}`.

An `occluded` finding has the same fields with `kind: "occluded"`: `a` the text (its ink box), `b` the panel (`text` and `confidence` null), `overlap` the share of the text's element box under the panel, `line` `"<text> / [<panel id>]"` (`[panel]` with no id), `signal: "elements"`.

In JSON, each finding has `kind: "overlap"`, `box` (the union of both sides), `line` (`"<a> / <b>"`, a graphic as `[<id>]` or `[graphic]`), `a` and `b`, `overlap` and `signal`. With `signal: "elements"`, `a` is the text side (two texts in reading order), each side is `{text, box, confidence, element: {id, box}}`: `text` is the element's text, `box` its ink (the HTML report and CI annotations draw it), and a graphic has `text` and `confidence` null and its element box; `overlap` is the element-box share that `--min-overlap` is compared with. With `signal: "boxes"`, `a` and `b` are the two recognized lines `{text, box, confidence}` and `overlap` the share of the smaller line box.

The OCR-only reader (`--experimental`): two recognized lines that intersect, the intersection covering at least `--min-overlap` (default `0.3`) of the smaller line's box. Pieces of one line on one baseline are joined first, and a text read twice counts once. It misses stacked lines Vision reads as one, labels colliding on one row, text over an image or icon, and overlaps of a few pixels; see [BENCHMARKS.md](./BENCHMARKS.md#overlap-without-boxes).

## Formats

```
catscan formats shots/de --locale de --storefront DE
catscan formats shots/en --locale en --storefront DE --prices StoreKit/Products.storekit
```

Reports numbers, dates and times formatted wrong for the run locale, prices in a currency the storefront does not charge, and paywall prices that disagree with a price file: one finding per token, exit 1 when there is any. The locale's formats come from the CLDR data macOS ships, read through Foundation; nothing is downloaded. Measured numbers: [BENCHMARKS.md](./BENCHMARKS.md#formats).

| Rule | Default | Finding | Fires when |
| --- | --- | --- | --- |
| `number` | on | `format` | A number with both a group and a decimal separator uses them in the wrong roles (`1,234.56` on a `de` screen), or a price with exactly its currency's decimals uses the wrong decimal separator (`9.99 €` on `de`). `1,234` alone is ambiguous and never reported. |
| `date` | on | `format` | A numeric date's field order contradicts the locale's short date, and a field proves it: a 4-digit year in another position, or a day above 12 where the locale puts the month (`11/25/2026` on `de`). ISO dates (`2026-11-25`) are never reported. |
| `time` | opt-in | `format` | An AM/PM marker in a locale whose CLDR default is 24-hour (`3:00 PM` on `de`). A 24-hour time in `en-US` is never reported. |
| `currency-placement` | opt-in | `format` | The currency sign is on the other side of the amount from the locale's pattern (`€9,99` on `de`). Spacing is not judged. |
| `currency` | on, needs a currency | `currency` (`rule: "unexpected"`) | An amount next to a currency sign or ISO code that the storefront does not charge (`$4.99` with `--storefront DE`). An ambiguous sign is fine when it can name the expected currency (`$` in a `CA` storefront). |
| `mixed-currency` | on, without a currency | `currency` (`rule: "mixed"`) | Two currencies on one screen that no single currency explains, when no storefront is given. |
| `price` | on, needs `--prices` | `price` (`field`) | On a screen where some amount matches a product (a paywall): an amount that matches no product (`amount`); a period word next to a matched amount that disagrees with its product (`period`: `$39.99/month` for a yearly product); a trial length on a line whose amounts match one product that disagrees with its trial (`trial`: `7-day free trial` against `P3D`). A monthly or weekly price derived from a yearly one (the price divided by 12 or 52, rounded down or half-up) matches it. |

The expected currency comes from the storefront, never from the UI language: an English UI in a German storefront charges EUR. Without `--storefront` or `--currency`, the `currency` and `price` rules do not run and every result says `currency-unchecked`; `--prices` alone takes the currency of its products when they share one, else it is `missing-currency`. A price file in another currency than `--storefront` or `--currency` is `conflicting-options`: amounts are never relabeled.

**Price files.** A `.storekit` configuration is read directly: its subscriptions and products (`displayPrice`, `recurringSubscriptionPeriod`, and an `introductoryOffer` with `paymentMode: "free"` as the trial), in the currency of its storefront. Otherwise JSON or YAML, a list or `{products: [...]}`:

```yaml
products:
  - { product: pro.yearly, price: 39.99, currency: EUR, period: P1Y, trial: P1W }
  - { product: pro.monthly, price: 7.99, currency: EUR, period: P1M, trial: null }
```

A shown amount binds to a product by its value alone; an amount two products share is skipped. Period and trial words are read on the same recognized line only: a period word right after the amount (`/month`, ` per year`, `/月`) or a plan word right before it (`Monthly: $7.99`), so a plan label on its own line above the price is not its period. Period words come from CLDR 49 (a committed table); plan words (`Monthly`, `Annual`) and trial words (`free trial`, `kostenlos testen`) exist for en, de, fr, es, it, pt, tr, ja, ko and ru only, so elsewhere the plan words and the trial field do not run. A higher amount before a matched one on its line, or after a "was" word (`was`, `statt`, `antes`), is a crossed-out price: exempt from `price` (the result counts them in `price_exempt`) but not from `currency`. The claim is "disagrees with the supplied price file", never "charged".

**What it cannot see:** a sign Vision misreads: it reads a drawn `₹` as `€`, `₽` or `$`, so on an `IN` storefront `€` and `₽` are never reported; a `¥` in a Latin font is often not read at all. Native digits (Arabic-Indic), units, spelled-out months, non-Gregorian calendars, percent spacing and phone numbers are out of scope.

**Output:**

```
FAIL  shots/en/paywall.png
  currency (unexpected) "$4.99" (USD) in "Pro $4.99 / month" at [0.08, 0.41, 0.52, 0.04], storefront EUR
  format (date) "11/25/2026" in "Renews on 11/25/2026" at [0.08, 0.62, 0.40, 0.03], expected "25.11.26"
  price (period) pro.yearly "39,99 €" in "39,99 € pro Monat" at [0.08, 0.47, 0.44, 0.04], price file: "pro jahr"
```

In JSON: `{kind: "format", rule, line, box, token, expected}` (`expected` is the locale's CLDR rendering of the value), `{kind: "currency", rule: "unexpected"|"mixed", line, box, token, currencies, expected_currency}` (`expected_currency` is null only for `mixed`), `{kind: "price", field: "amount"|"period"|"trial", line, box, token, product?, expected}`; every `formats` result has `price_exempt` (null when the price rule did not run). Tesseract-read inputs get `rule-unmeasured-reader`.

## Fit

`catscan fit` finds text and icon buttons that the screenshot shows but the phone hides: under the camera cutout (Dynamic Island, notch, punch-hole), a rounded display corner, or the home indicator. A longer translation that moves a label into one of these zones looks fine in the PNG and is cut on the device.

`fit` is experimental in this version: its text reasons missed their precision and recall gate ([BENCHMARKS.md](./BENCHMARKS.md#fit)), so it runs only with `--experimental` or with the reasons named in `--reasons`, and its findings carry certainty `low`. Icon buttons (with boxes) passed their own gate under the rounded corners.

```bash
catscan fit shots/de --experimental                         # iOS: each screenshot matches a profile by its pixel size
catscan fit shots/de --boxes shots/de --experimental        # also icon buttons (textless controls) from the sidecars
catscan fit shots/de --reasons corner                       # one reason, named
catscan fit shots/android --device-profile pixel-9 --experimental   # Android always needs a named profile
catscan fit --list-devices                                  # the shipped profiles
```

Reasons (`--reasons`, comma-separated; without it, every reason that passed its gate, or, with `--experimental`, all three plus `wrapped` when `--boxes` is given ([Wrapped labels](#wrapped-labels-and-one-word-last-rows))):

| Reason | Zone |
| --- | --- |
| `cutout` | the camera cutout: Dynamic Island, notch or punch-hole |
| `corner` | a rounded display corner |
| `home-indicator` | the home indicator or gesture handle, grown by its own height on each side |

A line is reported when at least half of one of its letters or digits lies in a zone, by Vision's character boxes. A textless control (`control: true` in the boxes with no line of letters or digits read inside it: a close, back or settings icon whose text is only its accessibility label, or whose only drawn text is a symbol such as `+`) is reported when a zone covers at least a quarter of its box. Controls are checked under the rounded corners; under the cutout and the home indicator they were not measured, so they are checked only with `--experimental`. One finding per line or control, the first zone in the order above.

```
fit (cutout) "Einstellungen" at [0.33, 0.012, 0.31, 0.02]: "Einst" under the cutout of iphone-17-pro
fit (corner) [close-button] 41% under the corner of iphone-17-pro at [0, 0, 0.1, 0.05]
```

JSON fields: `reason`, `line` (`null` for a control), `hidden` (the hidden characters in reading order, `null` for a control), `hidden_box`, `zone_box` (the zone that was hit, so a report draws it without the profile), `element` (`null` without boxes), `profile`, `covered` (a control's covered share, `null` for text), `confidence`. Each envelope adds `device_profile` (`id`, `ids`, `orientation`, `matched_by`: `flag`, `label`, `size` or `scale`, and the profile table `version`; `null` when no profile matched), `reasons_run` and `reasons_skipped` (each with its `cause`).

**Device profiles.** catscan ships profiles that its maintainers measure with public tools: every iPhone and iPad simulator of the current Xcode (`xcrun simctl io screenshot --mask`), and the Pixel phone definitions of the Android emulator (`WindowInsets`, `DisplayCutout`, `RoundedCorner`, and the gesture handle in a screenshot), named by their definition: `pixel-9`, `pixel-9-pro-xl`. No Apple or Google asset is read or copied. A profile is matched, first hit wins, by `--device-profile`, by a `--device` label (or `{device}/` folder) equal to a profile id with or without its platform prefix (`ios-iphone-17-pro`), by the screenshot's exact pixel size (iOS and iPadOS only, either orientation), or by a uniform downscale of exactly one profile size (never to the profile's point size, which is a browser viewport at 1x, nor for a `web-...` label). Android sizes such as 1080x2400 are shared by phones with different cutouts, so a screenshot labelled Android (`--device android-...` or an `android-.../` folder) is never matched by size. A screenshot carries no platform, though: an unlabelled Android screenshot at the exact size of an iPhone or iPad is checked as that device, so label Android runs or pass `--device-profile`. When phones of one size have different cutouts, only pixels hidden on all of them are checked (`device-ambiguous`), and a finding's `profile` names every candidate joined by `+`. For a device catscan does not ship, write a profile file with [docs/recipes/device-profile.md](./recipes/device-profile.md) and pass it to `--device-profile`.

iOS hides the home indicator from every screenshot and screen recording, so the shipped iOS and iPadOS profiles have no `home-indicator` zone; a profile file can add one. The shipped Android profiles carry the gesture handle, in portrait and landscape; a profile file with a `home-indicator` zone must give its landscape box too ([docs/recipes/device-profile.md](./recipes/device-profile.md)).

**Orientation.** A landscape screenshot needs its side for the cutout: `--orientation`, or the sidecar's `orientation` (`catscan boxes uiautomator` fills it from the dump's rotation; XCUITest and Maestro dumps do not state it). Without a side, `corner` and `home-indicator` still run and `cutout` is skipped with `orientation-unknown`; the warning says so too when `--orientation portrait` is given for a landscape image. An Android screen taken upside down (uiautomator `rotation` 2, sidecar `orientation: "portrait-upside-down"`) has its cutout at the bottom: `cutout` is skipped there with `orientation-unknown`.

**What it cannot see.** Text under the status bar, a toolbar, the keyboard or a notification (that is occlusion, [Overlap](#overlap)); Android 3-button navigation, tablet taskbars and foldable hinges; web pages (a browser viewport has no cutout). Without boxes only recognized text is checked, never icon buttons (`fit-controls-need-boxes`).

**False positives and how to drop them.** Content that scrolls under the status bar by design: give the sidecars (`scrolls: true` skips it). A line touching the screen edge on the zone's side is left to `truncated` (`screen-edge`). A deliberate full-bleed title: add the line, or its element's id, to `--allow`. A line with no letter or digit (a status-bar glyph) is never reported.

No skip is silent: `device-unknown`, `device-ambiguous`, `orientation-unknown`, `fit-controls-need-boxes`, `fit-experimental` and, per image without a sidecar in the `--boxes` folder, `boxes-missing` are shown even under `--quiet`, and `--fail-on-skip` exits 1 when any reason was skipped on any image. The measured precision and recall are in [BENCHMARKS.md](./BENCHMARKS.md#fit).

### Wrapped labels and one-word last rows

With element boxes, `fit` also checks how a label breaks into rows. A German or Russian string 30-40% longer than English turns a one-line button into two rows ("Jetzt kostenlos / testen"), or leaves one word alone on a title's last row. Nothing is cut, so `truncated` and text checks pass.

```bash
catscan fit shots --boxes shots --layout '{locale}/{screen}' --reasons wrapped --experimental   # en screens are the one-row reference
catscan fit shots/de --boxes shots/de --reasons orphan --experimental                            # one word on the last row
```

| Reason | Reported when | Default |
| --- | --- | --- |
| `wrapped` | an element meant for one row shows two or more | runs once its gate passes; experimental today |
| `orphan` | the last of an element's 2 or 3 rows is one word, at most a third as wide as the widest row | only when named in `--reasons` |

**Rows of an element.** Each Vision line goes to the smallest element with `text` that holds 80% of it (a textless container never takes a label's lines); lines that overlap vertically by half the smaller height are one row; rows with no letter or digit are dropped. An element is judged only when its rows, joined in reading order and normalized, equal its `text` with spaces ignored. A neighbor's line, a cut or an OCR misread (Vision reading "ändern" as "andern") would make any row count wrong, so such an element is not judged at all: precision first.

**Evidence for `wrapped`** (the finding's `evidence`, the first that applies):

1. `declared`: the sidecar element has `max_lines: 1` ([Boxes](#boxes); written by a game export or by hand, no native dump states it).
2. `base`: the same element on the base-locale screenshot of the same screen shows one row, and its base text is short (at most 4 words and 32 characters; 12 characters in ja, ko, zh, th). A long string that fits one row in English may wrap by design in a translation.
3. `control`: no base element was found, and the element is a control's only label: `control: true`, or 90% inside a `control: true` element at most 4 of its line heights tall that holds no other text (a button, a tab; not a card, a list row or a chip with a subtitle).

An element whose base shows two or more rows wraps by design and is never reported.

**Base pairing.** The base screens are inputs of the same run: `--layout` ([results.md](./results.md#layout)) maps every screenshot to a locale, a screen, with `{device}/`, a device and, with `{text_size}/` or `--text-size`, a text size (none counts as `default`); a target pairs with the one base-locale screenshot of the same screen, device and text size. `--base-locale` names the base (default: the `--catalog` set's source locale, else `en`; a run with `en-US` folders and no `en` uses them). Base screens are read first, once, and checked like any other input: an `en` button that wraps by `control` or `declared` evidence is reported too. Elements pair by the same `id`, else, with `--catalog`, by the catalog key whose target string is the target element's `text` and whose base string is the base element's (compared normalized; a string that is the value of several keys pairs by none). A finding paired through the catalog carries `key` and `catalog`, the string to shorten.

```
fit (wrapped) "Jetzt kostenlos / testen" in [cta-trial] at [0.3, 0.4, 0.4, 0.07]: 2 rows, 1 in the base locale (shots/en/paywall.png)
fit (orphan) "ändern" ends [title] at [0.1, 0.2, 0.8, 0.12] (row 3 of 3)
```

JSON fields: `reason`, `line` (the rows joined by " / "), `box` (their union), `element`, `rows`, `confidence` (the lowest of the element's lines); `wrapped` adds `evidence`, `base_rows` (1 with base evidence, else `null`), `base_path` (the base screenshot, else `null`) and, when paired through the catalog, `key` and `catalog`; `orphan` adds `orphan` (the last row) and `evidence: null`. `reasons_run` lists `wrapped` and `orphan`; an image with no sidecar skips them with cause `boxes-missing`.

**One word**, for `orphan`, is one `NLTokenizer` word token (Apple NaturalLanguage, the locale's language; punctuation and symbols dropped), so unspaced scripts are segmented by dictionary. In ja, zh and yue a last row of at most 2 characters, or of closing punctuation alone (`。` `、` `」` `）`, whatever its width), is an orphan too. Not reported: 4 or more rows (body text), a last row that is a number, price or time, and a base element whose last row is also one word. Right-to-left rows are ordered top to bottom and their lines right to left.

**Not reported.** `offscreen: true` elements, `--allow` entries (element `id` or `text`), and elements whose rows do not join to their `text`. Without `--boxes` a default run checks safe areas only and says `wrap-needs-boxes`; `--reasons` naming only `wrapped` or `orphan` without `--boxes` is exit 2. A target pairs with the base-locale screenshot of the same screen, device and text size. `wrap-no-base` names how many screens had no base-locale screenshot (only `declared` and `control` evidence there; on a run with the text size axis, none at the same text size, and the hint names the sizes to capture); `wrap-base-ambiguous` how many had two (two device trees without `{device}/`; the hint puts `{device}/` before the run's layout, or, when the run has a device axis, names the two files that map to one cell). An evidence type that missed its gate is used only with `--experimental` (`fit-experimental`). The measured numbers are in [BENCHMARKS.md](./BENCHMARKS.md#fit-wrapping).

## Contrast

```
catscan contrast shots/de --locale de --experimental          # iOS: the scale comes from the screenshot size
catscan contrast shots/android --scale 2.625 --experimental   # Android: adb shell wm density / 160
catscan contrast shots/de --boxes shots/de --experimental     # disabled and covered text not measured
```

For every line Vision reads, `contrast` measures the WCAG 2.x contrast ratio of the text's ink against its background and reports `low-contrast` below the threshold for its size, and `busy-background` when the text sits on an image, pattern or texture where one ratio does not describe legibility. Exit 1 when either is found. Both kinds are experimental: neither has passed its real-screen gate ([BENCHMARKS.md](./BENCHMARKS.md#contrast)), so every run needs `--experimental`, and the findings carry certainty `low`.

```
FAIL  shots/de/login.png
  major/low  low-contrast "Passwort vergessen?" 2.85:1 < 4.5:1 (normal, ink #999999 on #FFFFFF) at [0.1, 0.62, 0.5, 0.03]; fix: ink #767676 or darker
  minor/low  busy-background "Jetzt spielen" (edges 0.07 around the line) at [0.2, 0.8, 0.6, 0.04]; fix: put the text on a solid or scrimmed panel
contrast: 1 low-contrast, 1 busy-background on 1 of 40 screens; worst 2.85:1 "Passwort vergessen?" (shots/de/login.png); 12 lines not measured (3 too-small, 9 not-text)
```

**How it measures.** Inside each line box the pixels are converted to sRGB (Display P3 screenshots included) and split into background (the majority) and ink at Otsu's threshold on the square root of luminance, so dark mode needs nothing special. The background is the median of its class; the ink is the stroke core, the pixel at the 90th percentile of distance from the background, so anti-aliased edges do not lower the ratio. The line is also cut into segments two line heights wide and the worst segment counts, so a gradient behind the text is judged where it is weakest. A segment whose split is weak or whose ink holds two colours is uncertain and never gives the ratio; a line with no certain segment is `uncertain` and never a finding. A line fails when its ratio is below the threshold divided by 1.02, so boundary noise is not a finding; JSON keeps the measured ratio.

**Busy background.** The share of edges (a step over 0.06 in the square root of luminance to the right or lower neighbour) among the background pixels inside the box at least 2 px from ink, and in a ring around the box (a quarter line height wide, other recognized lines cut out). Over 0.04 inside or 0.02 in the ring, the line is `busy-background`. A busy line's ratio is the whole box's, and it is also `low-contrast` only when that fails.

**Text size and scale.** WCAG large text is 18 pt, or 14 pt bold; a platform point (iOS pt, Android dp) counts as a CSS pixel. The font size is estimated from the line height and the device scale. A line is `normal` only if even its largest plausible size (height / 0.81 / scale) is under 18.67; `large` when its median estimate (height / 0.95 / scale) reaches 24; otherwise `uncertain`, judged at the large threshold (3:1 at AA), because a screenshot does not show the weight. Lines of uncertain size that fail 4.5:1 but pass 3:1 are not findings; `contrast-size-uncertain` names them. The scale is `--scale`, else the boxes file's `scale`, else the exact iOS screenshot size (the device profiles of [Fit](#fit)), else 1 with `contrast-scale-unknown`: unknown scale can only miss failures, never add them. `scale_source` says which.

**Not measured.** A line under 4 px tall (`too-small`), with no ink (`no-ink`), with fewer than two letters or digits (`not-text`: page dots, icons read as text), in the `--allow` file (`allow`), or with `--boxes` inside a disabled element (`disabled`) or under a `panel` listed after its element (`covered`: text dimmed behind a modal). Each carries `contrast: {skipped: <reason>}` in `lines` and is counted in the summary line, so silence is never a pass. Placeholder text in a field is checked: WCAG does not exempt it.

**Known failures.** Approve them with `--known` ([results.md](./results.md#known-findings)); logotypes and decorative text go in `--allow`. `--fail-on-skip` does not apply: warnings never change the exit code.

**JSON.** Findings `low-contrast` and `busy-background` carry `ratio`, `threshold`, `size` (`normal`, `large`, `uncertain`), `ink` and `background` (sRGB hex), `edges`, `scale`, `scale_source`, `confidence` and, for `low-contrast`, `suggest` (the nearest ink of the same hue that passes, or null). The envelope's `lines` carry `contrast: {ratio, threshold, size, busy, edges, ink, background}` (plus `uncertain: true`, where the ratio is the whole box's, shown for reference and never judged) or `{skipped}`.

**What it cannot see.** Text Vision does not read (low-contrast text on busy backgrounds is often not read at all); video (frames are compressed and chroma-subsampled, which smears thin strokes); icons, borders and focus rings (WCAG 1.4.11 non-text contrast); a line Vision reads across two colours far apart is judged on its worse segment, and two colours inside one segment are `uncertain`.

## Boxes

```
catscan boxes xcuitest shop.xcui.txt > shop.boxes.json
catscan boxes uiautomator shop.uia.xml --image shop.png > shop.boxes.json
```

Converts an element dump saved by an e2e test into a `--boxes` file on stdout. [`truncation-capture.md`](./truncation-capture.md) shows how to save each dump next to its screenshot.

| Source | Dump | Units | `text` from |
| --- | --- | --- | --- |
| `xcuitest` | `XCUIApplication().debugDescription` | points; the first Window is the screen | `label`, `value`, `title` (a text field: `value` first) |
| `uiautomator` | `uiautomator dump` XML | pixels; needs `--image` | `text`, `content-desc`, `hint` |
| `maestro` | `maestro hierarchy` JSON | points on iOS (the root is the screen); pixels on Android, with `--image` | `text`, `accessibilityText`, `hintText` |
| `playwright` | the page script `packages/core-js/src/boxes/playwright-page.js` | CSS pixels in the viewport | visible text, then `aria-label`; `clips` from `overflow` and `text-overflow` |

The first non-empty field in that order is the element's `text`. On tree dumps a child with its parent's box and text is dropped, and only the innermost element with a string keeps it (or an ancestor with that same string), so a container's joined label is never `text` ([Truncated](#truncated), "Text matching"). Elements that reach past the screen get `offscreen: true`. A dump with no displayed text gives `dump-no-text`.

**`graphic`** (for `overlap`): an element that draws no text of its own gets `graphic: true`, whatever its `text` (an icon button's label is not drawn, so Vision cannot confirm it). `playwright`: `img`, `svg`, `picture`, every `input` but `hidden`, `submit`, `button` and `reset` (a field's border is drawn), `textarea`, `[role=img]`, and a `button` or `[role=slider]` with no text or drawn leaf inside (not `canvas`, `video` or `iframe`). `xcuitest`: `Image`, `Icon`, `Switch`, `Slider`, `Toggle`, `ProgressIndicator`, `ActivityIndicator`, `PageIndicator`, `TextField`, `SecureTextField`, `SearchField` (not `TextView`, which often shows read-only text), and a `Button` with no element below it. `uiautomator` and Android `maestro`: a class ending in `ImageView`, `ImageButton`, `Switch`, `CheckBox`, `RadioButton`, `ProgressBar`, `SeekBar`, `Slider`, `EditText` or `AutoCompleteTextView`, and react-native-svg's `com.horcrux.svg.SvgView` as one graphic (its shape views are dropped). A field keeps its `text` for `truncated`. Of the controls, only fields and sliders are marked, the kinds that passed their accuracy gate; switches drawn by other classes, checkboxes and `select` missed it ([BENCHMARKS.md](./BENCHMARKS.md#occlusion-and-controls)). iOS `maestro` dumps have no element type, so they set none. A container never gets it. `graphic` is optional and additive: old sidecars keep working (text over text only); reconvert the dumps to check text over icons. `truncated` never gives a line to a graphic with no `text`.

**`panel`** and **`scrolls`** (for `occluded`): `panel: true` marks an opaque surface drawn over the elements not inside it; `scrolls: true` marks an element inside a scroll container that can still scroll. `xcuitest`: `Keyboard`, `Alert`, `Sheet`, `Popover`, `Dialog`, `Toolbar`, `TabBar` and `NavigationBar` are panels; an element below a `ScrollView`, `Table`, `CollectionView` or `WebView` scrolls. `uiautomator` and Android `maestro`: no panels (a dump holds one window and names no panel class); an element below one with `scrollable` true scrolls. iOS `maestro`: neither. `playwright`: an element with `position` `fixed` or `sticky`, an opaque background (color alpha 1 or an image) and opacity 1 up its ancestors is a panel (kept even with no text); an element in a scroll container, or a page, that can still scroll scrolls. Both are optional and additive; reconvert the dumps to get them.

**`enabled`** and **`scale`** (for `contrast`): `enabled: false` marks a disabled control, which WCAG exempts from contrast. `xcuitest`: an element whose line says `Disabled`; `uiautomator` and `maestro`: `enabled` false. `scale` (top level) is the image's pixels per dump unit, written when the dump is in points and `--image` gives the screenshot (`xcuitest`, iOS `maestro`, `playwright`: the page's device pixel ratio). Both are optional.

**`control`** and **`orientation`** (for `fit`): `control: true` marks a tappable element, so `fit` can check an icon button whose text is only its accessibility label. `xcuitest`: `Button`, `Switch`, `Slider`, `Toggle`, `Link` and `Tab`; `uiautomator` and `maestro`: an element with `clickable` true; `playwright`: `button`, `a[href]`, `input`, `select`, `[role=button]`, `[role=tab]` and `[role=link]`. `uiautomator` also records the screen `orientation` (`portrait`, `landscape-left`, `landscape-right` or `portrait-upside-down`) from the dump's `rotation`; the other dumps do not state it. Both are optional; boxes files without them still load, and reconverted dumps get them.

**`max_lines`** (for `fit wrapped`): an integer of at least 1, the element's declared line limit; `max_lines: 1` is `declared` evidence. No dump states it: a game's own export or a hand edit adds it.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every check passed |
| 1 | A check failed or a finding gates ([Severity and certainty](#severity-and-certainty); a `--known` finding never gates), or with `--fail-on-skip` a check was skipped |
| 2 | Usage error (bad option, missing argument, invalid expect file); detected before any input is read |
| 3 | Language not read: `needs-reader` (its reader, Tesseract, is not installed; the hint names the install) or `unsupported` (no reader for it), or `overlap-unchecked` (overlap without boxes and without `--experimental` on an image Tesseract read: stacked text runs on Vision reads only) |
| 4 | An input could not be read or decoded, the Tesseract fallback failed on it, or an output file (`--results`, `--report`, `--junit`, `--gitlab-codequality`) could not be written |
| 5 | catscan cannot run: a broken install or an internal error (the hint names the fix) |

`catscan doctor` exits only 0 (catscan can run) or 1 (something it needs is missing or broken). Precedence over a batch is 5, 4, 3, 1, 0. The counts on stderr show every verdict, so an exit 3 or 4 does not hide failures in the same run.

A reader that leaves early (`catscan read shot.png | head -1`, `grep -m1`, `jq` that exits) only cuts the output: the run finishes, writes its report files and exits with its own code. Under `set -o pipefail` a reader that exits non-zero (`grep -m1` with no match) can still fail the pipeline; in bash, `${PIPESTATUS[0]}` is catscan's code.

## CI reports

Setup per CI service: [`docs/recipes/ci.md`](recipes/ci.md); ready-to-copy files in [`examples/ci/`](../examples/ci/).

`--fail-on-skip` acts only through the exit status: a skipped check gets no `::error` annotation, stays `<skipped/>` in JUnit and keeps its verdict in the job summary and `--results`, so the CI step must keep catscan's exit status.

- **`--format github`:** stdout holds only lines catscan builds: one `::error file=<path>,title=<title>::<message>` per input that did not pass (a `missing` entry uses its `expected_path`), in rank order (error, needs-reader and unsupported inputs, then by each input's worst gating item: severity, then certainty), each message listing the input's gating items sorted and prefixed `<severity>/<certainty>`, at most 10 (GitHub shows 10 error annotations per step), then one `::warning` line counting the rest (an 11th error would be dropped) and, when the run stopped early, one `::warning` saying the output is partial, then the totals line. stderr diagnostics keep their usual form, with line breaks escaped (`%0A`), so no path or catalog string starts a line there either. OCR text, paths and catalog strings appear only inside an escaped message (`%`, CR, LF) or property (also `:` and `,`), so a screen that reads `::add-mask::` cannot issue a workflow command. Findings below the thresholds get no annotation. The job summary appended to `$GITHUB_STEP_SUMMARY` has the counts and one row per input that did not pass, in rank order with the worst item's severity and certainty, then the findings below the thresholds in a collapsed section, with Markdown escaped (emphasis and bare URLs included) and screen text in `<code>`; it is cut at 900 KB with a note. With `--baseline` the summary adds the baseline summary line under the counts and a "Cells to review" table (locale, screen, state, the reason it needs review, and up to 5 added and 5 removed lines), read from `baseline.cells[]` and cut at the same 900 KB; annotations stay failures only. Without `GITHUB_STEP_SUMMARY` (a local run) the summary is skipped with one `github-summary-skipped` note.
- **`--junit <file>`:** validates against the Jenkins JUnit schema, which GitLab, CircleCI, Bitrise, Codemagic, Azure Pipelines, Jenkins and Buildkite read. `skipped` checks are `<skipped/>`; `error`, `needs-reader` and `unsupported` inputs are `<error>`. A gating item is a `<failure>` line prefixed `<severity>/<certainty>`, sorted; findings below the thresholds go to the test case's `<system-out>` and do not fail it. Test case time is the input's `ms`, split across its checks.
- **`--gitlab-codequality <file>`:** entries carry `description`, `check_name` (`catscan/<kind>`), `severity` (the item's own: `critical`, `major` or `minor`; `info` below the thresholds; `critical` for an error, needs-reader or unsupported input), `location.path` (relative to the working directory, or `abs:` as in the results file) and `location.lines.begin: 1`. The `fingerprint` is a SHA-256 of path, kind, the check's expected text (or the finding's line, or `expected_path`) and the index among equal entries, so GitLab tracks a finding across pipelines and OCR drift does not churn a `check` entry.

## Diagnostic codes

| Code | Where | Meaning |
| --- | --- | --- |
| `baseline-missing` | warning | The `--baseline` file does not exist: every cell is `new` and needs review, so a CI job works before the first approval. Hint: `approve a reviewed run: catscan results baseline <results.json> --out <file>`. |
| `baseline-no-text` | usage error (2) | The baseline has no text records (catscan < 0.24.0 or `--text-record none`). Approve a run from this catscan as the new baseline. |
| `baseline-incompatible` | usage error (2) | The baseline's `text.algo` differs from this catscan's. Approve a run from this catscan as the new baseline. |
| `baseline-locale-collision` | usage error (2) | Two baseline locales become one after aliases and case are folded (`zh-TW` and `zh-Hant`); the message names both. |
| `baseline-no-overlap` | usage error (2) | Both files have mapped cells and none match: a wrong file or `--layout`. The run's files are still written, without a baseline block. |
| `baseline-ignore-changed` | warning | This run used a different `--baseline-ignore` file than the baseline; those cells need review. |
| `reader-changed` | warning, once | The engine, Vision revision or macOS major version differs from the baseline's; those cells need review until a run on this reader is approved. |
| `baseline-unapproved` | warning | The baseline was never approved with `catscan results baseline`; every cell needs review. |
| `baseline-incomplete` | `results baseline`, exit 1 | One line per cell that cannot be approved (error, needs-reader, unsupported, missing, ambiguous, no text record); `--allow-incomplete` approves anyway. |
| `baseline-ignore-unreadable`, `baseline-ignore-invalid` | usage error (2) | The `--baseline-ignore` file cannot be read, or a line is not a valid regular expression. |
| `short-check-text` | warning | The check string is short; it matches whole words only. |
| `locale-fallback` | warning | The `--locale` tag is not in the language table, so a shorter tag or the language subtag was used (`en-GB` -> `en`, `pt-PT` -> `pt-BR`). The hint names the code that matches exactly. |
| `language-not-in-table` | warning | Vision on this Mac reads a language this catscan does not know yet; it is used by its Vision code, and checks in its script are not guarded. Upgrade catscan for its script rules. |
| `locale-script-mismatch` | warning | The check text uses a script the locale cannot read. Without `--locale`, when exactly one supported locale reads that script, catscan uses it and says so. When only a fallback locale reads it (Greek, Hebrew, Georgian...), the hint names it (`--locale el`); it is never picked automatically. |
| `fallback-engine` | warning | Vision cannot read the locale, so Tesseract read the screen; it is slower and less accurate on stylized text. The text line of the input ends with ` (tesseract-<version>)`. |
| `fallback-pack-missing` | warning | Tesseract is installed but has no language data for the locale; the message names the pack and the tessdata directory. The input is `needs-reader` (exit 3). Hint as for `reader-missing`. |
| `fallback-unavailable` | warning | `--fallback tesseract` was given but no Tesseract was found; the message lists where catscan looked. The input is `needs-reader` (exit 3). |
| `reader-missing` | input error | catscan reads the locale with Tesseract, which is not installed (the message lists where catscan looked), lacks the language data, or was turned off with `--fallback none` (verdict `needs-reader`, exit 3). The hint is the fix for this Mac: `brew install tesseract tesseract-lang (about 650 MB)` or `brew install tesseract-lang`; with `CATSCAN_TESSERACT` set, a working tesseract at that path or a changed launch environment; with `TESSDATA_PREFIX` or another tessdata, the `.traineddata` files to add there. A running `serve`, MCP server or Playwright run probes again at most every 30 s, so no restart is needed after an install. |
| `expect-key-unmatched` | warning | An expect key matched no input image. |
| `github-summary-skipped` | warning | `--format github` without `GITHUB_STEP_SUMMARY`: the annotations print, the job summary is not written. |
| `report-write-failed` | output error | A `--report`, `--junit` or `--gitlab-codequality` file, or the job summary, cannot be written (exit 4); the previous file, if any, is kept. The hint says to check the folder or pass another path. |
| `report-image-missing` | warning | `catscan report` (or `--report`) found no image for a result, so the report shows a grey placeholder with its boxes. At most 10 lines, then one with the remaining count and the root; the hint names `--images-root`. The exit code does not change. |
| `report-images-unavailable` | warning | `catscan report` (or `--report`) could not make any thumbnail because the core binary failed (it cannot start, or it exited); the message names the cause. One line instead of per-image `report-image-missing` lines; a failure on some images only stays per image. The hint is `catscan doctor`. The exit code does not change. |
| `report-large` | warning | The HTML report is over 50 MB; the hint names `--report-images link` and a smaller `--report-max-edge`. |
| `images-root-not-found` | usage error | `--images-root` is not a folder (exit 2). |
| `no-checks` | warning | No `--present`, `--absent` or expect key applies to an input, so nothing was checked. |
| `no-checkable-text` | warning | A check text is empty after normalization (for example `...`), or a catalog string has no fragment of 4 or more characters (2 for ja, ko, zh, yue, th); the check is `skipped`. |
| `catalog-missing` | warning | A `{locale}` template names no file for the run locale; its `@key` checks are `skipped`, or for `untranslated` the base-string rule is skipped (in every envelope). |
| `untranslated-base-catalog` | warning | `untranslated`: the target catalog is the base catalog read for the same locale, or every target string equals its base string, so the base-string rule is off (in every envelope). |
| `untranslated-unreadable` | warning | `untranslated`: base strings use a script the locale cannot read; they were not checked. |
| `wrong-language-unchecked` | warning | `untranslated`: `wrong-language` did not run because no other project language is known (the hint names a `{locale}` template and `--languages`), or ran with less catalog evidence: language ID only when the run locale has no strings in the catalog or the other locales' catalogs make the request too large, or without one locale's catalog that could not be read (or, under MCP, lies outside the allowed roots). In every envelope ([Untranslated](#untranslated)). |
| `catalog-duplicate-key` | warning | Keys are defined in more than one `--catalog`; the message names the count, up to three keys and the winning (last) file. |
| `catalog-values-skipped` | warning | A TypeScript or JavaScript catalog has values that are not plain strings (calls, templates with `${...}`, functions, references, spreads); the message counts them by kind and names up to three keys. Their checks are `skipped` with reason `catalog-value-dynamic` ([Code catalogs](#code-catalogs)). |
| `catalog-value-dynamic` | warning | An `@key` names a value a code catalog cannot read (a call, a template with `${...}`, other code); its check is `skipped` ([Code catalogs](#code-catalogs)). |
| `catalog-string-capped` | warning | Catalog strings are over 64 KB, or expand past 256 fragments or 4 nested plurals; their checks are `skipped`. |
| `unsupported-language` | input error | Vision on this Mac cannot read the locale (verdict `unsupported`, exit 3). The hint corrects country codes used as locales (`jp` -> `ja`, `kr` -> `ko`, `cn` -> `zh-Hans`, `tw` -> `zh-Hant`, `br` -> `pt-BR`, `ua` -> `uk`, `se` -> `sv`, `dk` -> `da`, `cz` -> `cs`); otherwise it points at `catscan languages`. A locale catscan reads with Tesseract is `reader-missing` instead, except in `video`, which never uses Tesseract. |
| `vision-languages-failed` | internal error | Vision could not list its recognition languages; nothing was checked (exit 5). Rerun; if it persists, report it with `catscan --version`. |
| `unsupported-script` | input error | A check text uses a script the locale cannot read (for example Cyrillic with `en`), or a script no locale reads (for example Bengali): that check is `unsupported`, never a pass, and the input's verdict is `unsupported` (exit 3). |
| `input-not-found` | input error | No such file. |
| `no-images` | input error | A folder argument has no readable PNG, JPEG or HEIC images, or a subfolder cannot be listed. |
| `input-unreadable` | input error | Not a readable PNG, JPEG or HEIC image (the hint names `catscan video` for `.mp4` and `.mov`), not a readable MP4 or MOV video, a video frame that could not be decoded (also when AVFoundation does not answer within 60 s), or not a regular file. |
| `image-too-large` | input error | The image is over 100 megapixels (checked before decoding), or the image on stdin is over 47 MB (the whole run stops with exit 4 before any input is checked, so `--json` prints nothing). |
| `recognition-failed` | input error | Vision returned an error. |
| `vision-timeout` | input error | Vision did not finish reading one image (or one video frame) within the deadline, 60 s by default (exit 4). The run goes on; the CLI and MCP replace the `catscan-core` process after it, since the abandoned read may hold a thread. Hint: rerun; on a slow host raise `CATSCAN_VISION_TIMEOUT` ([Recognition](#recognition)). |
| `core-timeout` | input error | `catscan-core` gave no answer for the input within the deadline plus 150 s, so the CLI or MCP stopped it, started a new one and went on with the other inputs (exit 4). At the 3rd such failure in a row (stalls or `vision-timeout`s with no answer between them), catscan stops restarting and every remaining input gets this code with `was not checked`. Hint: rerun; if it repeats, run `catscan doctor` and report it with `catscan --version`; past the cap: rerun the job, and if it repeats, restart the Mac (`CATSCAN_VISION_TIMEOUT` raises the per-image wait). |
| `no-videos` | input error | `video`: a folder argument has no `.mp4` or `.mov` files. |
| `no-video-track` | input error | `video`: the file has no video track (an audio-only MP4). |
| `no-frames` | input error | `video`: no sample lies between `--from` and `--to` within the video; the message names the duration. |
| `video-too-many-frames` | input error | `video`: more than 20,000 samples; the hint names an `--every` that fits. |
| `every-clamped` | warning | `video`: `--every` is shorter than one frame, so every frame is sampled. |
| `range-empty` | warning | `video`: an `--expect` range contains no sampled frame; its checks are `skipped`. |
| `checks-skipped` | `check`, `video`, `fit`, exit 1 | `--fail-on-skip` is set and checks were `skipped`: the count per reason, once per run, after the counts line. The warnings above it name the catalog or range; `--json` lists each skipped check in `checks[]`. Never hidden by `--quiet`. |
| `boxes-missing` | warning | `truncated`: `--boxes <dir>` has no sidecar for an image; it was checked without boxes. `overlap --experimental`: it was checked with the OCR-only reader. `fit`: `wrapped` and `orphan` were skipped on it (`reasons_skipped` cause `boxes-missing`). The hint is the `catscan boxes` command that writes it. |
| `overlap-no-boxes` | input error | `overlap --boxes <dir>` without `--experimental`: no sidecar for an image (exit 4 for that image). Names the sidecar it looked for; the hint is the `catscan boxes` command, or `--experimental` for the OCR-only check. |
| `overlap-unchecked` | input error | Plain `overlap` (no `--boxes`, no `--experimental`) on an image Tesseract read: stacked text runs on Vision reads only and no other reader was asked for, so nothing was checked (verdict `unsupported`, exit 3). The hint names `--boxes` and `--experimental`. |
| `stacked-unchecked` | warning | `overlap` with `--boxes` or `--experimental`: stacked text was not checked on an image Tesseract read (the hint points to `catscan languages`), and the other overlap readers still ran; or, in any mode, the second Vision read without language correction failed: the message names its code, only the dictionary rule ran, and the hint is to rerun. A second read that times out is `vision-timeout` for the image instead. Never hidden by `--quiet`. |
| `occlusion-experimental` | warning | `overlap --boxes` without `--experimental`: some sidecars have `panel` elements, but occlusion is experimental and was not checked (once per run). The hint is the run's command with `--experimental`. Never hidden by `--quiet`. |
| `no-panel-elements` | warning | `overlap --boxes --experimental`: no boxes file of the run has a `panel` element, so occlusion is not checked (once per run). Reconvert xcuitest or playwright dumps with `catscan boxes`. Never hidden by `--quiet`. |
| `no-graphic-elements` | warning | `overlap`: no boxes file of the run has a `graphic` element, so text over icons is not checked (once per run). Reconvert the dumps with `catscan boxes`. |
| `rule-unmeasured-reader` | warning | `truncated`: Tesseract read the image and the `overflow` rule ran (with boxes), but its gate is measured on Vision only, so its findings are unmeasured. The hint is the `--reasons` list without `overflow`. `untranslated`: the same for `wrong-language`; the hint is the `--kinds` list without it. `formats`: every rule is measured on Vision only. |
| `currency-unchecked` | warning | `formats`: no `--storefront` or `--currency`, so the `currency` and `price` rules did not run. In every envelope ([Formats](#formats)). |
| `boxes-mismatch` | input error | `truncated`, `overlap`: the boxes file's aspect ratio differs from the screenshot's by more than 1% (exit 4); convert the dump taken with this screenshot again. |
| `dump-no-text` | warning | `boxes`: no element in the dump has displayed text, so the prefix rule has nothing to compare; capture after the screen has settled. |
| `fallback-failed` | input error | Tesseract crashed, exited non-zero or ran over 60 s (exit 4). The message names its path, version and the end of its stderr. Hint `catscan doctor`; `--fallback none` skips it. |
| `known-algo-unsupported` | usage error | The known file has a newer `known_schema` or `key_algo` than this catscan reads (exit 2); the message names both numbers. Hint: upgrade catscan, or re-approve with this one. |
| `known-invalid` | input error | The known file is unreadable, not JSON, or fails `known.schema.json` (exit 4; `results validate` prints the same lines and exits 1); one line per violation with its JSON pointer. Hint: `fix or recreate the committed known file; check it with catscan results validate <file>`. |
| `known-scope-differs` | warning | `results known` read inputs of one command that ran with different filter flags (the file records the first set), or re-approved a command under other flags; `--known`: this run's filter flags, `--allow` file, device axis or text size axis differ from what the file approved (one warning per axis), so findings outside the approved scope show as new; across the text size axis only the `default` cells match. The hint names the run's `--results` file when it has one. Hint: run with the approved flags, or re-approve. |
| `known-missing` | warning | `--known` names a file that does not exist: every finding is new (fail closed). Hint: `create it after review: catscan results known <results.json> --out <file>`. |
| `known-reader-changed` | warning | `--known`: this run's engine, Vision revision or macOS major differs from the file's `reader`, so read text may differ; printed once. Hint: expect `known-drift` notes; re-approve after review on this reader. |
| `known-drift` | note | `--known`: a new and an approved-but-gone finding share a cell, kind and rule, probably the same finding read differently. Hint: the `catscan results known ... --out <file>` command to re-approve after review. |
| `known-write-failed` | output error | `results known` cannot write `--out` (exit 4); the previous file, if any, is kept. |
| `layout-mismatch` | warning | An expectation flag is set and the input's path does not match `--layout`, so it is in no expected cell ("unmapped"). When another pattern, or a `{device}/` form, maps every unmapped input, the message names it (`- try: --layout '{screen}-{locale}'`; [results.md](./results.md#layout)). |
| `locale-path-mismatch` | warning | `--locale` or the `--expect` file's locale differs from the locale in the input's path; the explicit one is read. |
| `device-unknown` | warning | `fit`: images of one size have no device profile, so the safe-area reasons were skipped (once per size, with the image count and the profile ids of that size). Android always needs a named profile. Hint: `catscan fit <path> --device-profile <id>`. Never hidden by `--quiet`. |
| `device-ambiguous` | warning | `fit`: the size fits several profiles with different cutouts; only pixels hidden on all of them were checked. Hint: `--device-profile <id>`. Never hidden by `--quiet`. |
| `orientation-unknown` | warning | `fit`: a landscape image without a side; `cutout` was skipped, `corner` and `home-indicator` ran. Hint: `--orientation landscape-left`. Never hidden by `--quiet`. |
| `unknown-device-profile` | usage error (2) | `--device-profile` names no shipped profile and no file; names the closest id. |
| `invalid-device-profile` | usage error (2) | A profile file is not valid; the message names the field (`zones[0].runs[3] must be [y, x0, x1) inside the 1080x2424 screen`). |
| `device-profile-mismatch` | input error (4, that image) | The image's aspect differs from the given profile's (either orientation) by more than 1%. |
| `device-no-zones` | note | `fit`: images matched a profile with no cutout, rounded corner or home indicator (iPhone SE); nothing to check there (once per run). |
| `fit-controls-need-boxes` | warning | `fit` without boxes: textless controls (icon buttons) were not checked (once per run). Hint: the run with `--boxes`. Never hidden by `--quiet`. |
| `fit-experimental` | warning | `fit`: controls under the cutout or the home indicator are not measured and were not checked, or a `wrapped` evidence type missed its gate and was not used (once per run each). Hint: the run with `--experimental`. Never hidden by `--quiet`. |
| `wrap-needs-boxes` | warning, or exit 2 | `fit` without `--boxes`: `wrapped` and `orphan` need element boxes; a default run checks safe areas only (once per run), a `--reasons` list of wrap reasons alone is a usage error. Hint: the run with `--boxes`. Never hidden by `--quiet`. |
| `wrap-no-base` | warning | `fit wrapped`: N of M screens have no base-locale screenshot in the run, so only `declared` and `control` evidence applied there (once per run). Hint: the run over the folder that holds the base locale too, with `--layout`; on a run with the text size axis (`{text_size}/` or `--text-size` other than `default`) the message says "at the same text size" and the hint names the sizes to capture before the rerun. A second line names base screenshots that gave no element rows (their own error or `boxes-missing` line says why). Never hidden by `--quiet`. |
| `wrap-base-ambiguous` | warning | `fit wrapped`: N screens have two base-locale screenshots of one device and text size (two device trees and no `{device}/` in the layout; the message names the text size on a run with the text size axis); base evidence skipped there (once per run). Hint: without a device axis, the run with `{device}/` before its layout; with one, a check of `--layout` and the file names (two inputs map to one device, text size, locale and screen). Never hidden by `--quiet`. |
| `unknown-base-locale` | usage error | `fit --base-locale xx` names a locale no input maps to. Exit 2. |
| `experimental-command` | usage error (2) | `fit` without `--experimental` or `--reasons`: every reason is experimental. Hint: the run with `--experimental`. |
| `experimental-command` | usage error (2) | `contrast` without `--experimental` while a selected kind has not passed its gate in this input mode. Four cases, each naming the kind and the mode: `low-contrast` or `busy-background`, without `--boxes` or with it; the rerun is `--experimental`, or the other mode when the kind passed there. Today no kind has passed in either mode ([BENCHMARKS.md](./BENCHMARKS.md#contrast)). |
| `invalid-level` | usage error (2) | `contrast --level` is not `AA` or `AAA`. |
| `invalid-scale` | usage error (2) | `contrast --scale` is not a number from 1 to 4. Hint: `--scale 3`. |
| `contrast-scale-unknown` | warning | `contrast`: an image's device scale is unknown (no `--scale`, no `scale` in its boxes file, not an iOS screenshot size), so it is judged at scale 1 and only large-text thresholds can fail. Once per run with the count. Hint: `--scale`, and `adb shell wm density` / 160 for Android. Never hidden by `--quiet`. |
| `contrast-size-uncertain` | warning | `contrast`: lines whose size class is uncertain (normal or large depends on a weight catscan cannot see) that fail the normal threshold but pass the large one, so they are not findings. Per image, naming up to 10 lines with their ratios. Never hidden by `--quiet`. |
| `contrast-behind-scrim` | warning | `contrast --boxes`: lines under a `panel` that comes later in the boxes file (a modal, a sheet) were not measured. Per image with the count. Never hidden by `--quiet`. |
| `invalid-orientation` | usage error (2) | `--orientation` is not `portrait`, `landscape-left` or `landscape-right`. |
| `device-path-mismatch` | warning | `--device` differs from the device folder in the input's path; `--device` is used. Hint: drop `--device` or move the file. |
| `text-size-path-mismatch` | warning | `--text-size` differs from the text-size folder in the input's path; `--text-size` is used. Hint: drop `--text-size` or move the file. |
| `device-missing` | warning | The run, merge or report has devices, but this input has none (a run without `--device`, or a file from before the device axis), so it is in no cell. The hint names the devices and the next command. |
| `duplicate-cell` | warning | Two or more inputs map to the same locale and screen (under the same command, in a merge); all are kept. |
| `catalog-locale-unknown` | warning | `--expect-locales-from`: a catalog file's locale cannot be read from its content (`.xcstrings`, an `.arb` `@@locale`, a `.po` `Language:` header), name or folder ([results.md](./results.md#coverage)); it was skipped. `doctor` fails its `catalogs` row. |
| `mixed-versions` | warning | `results merge`: the shards come from different catscan versions. |
| `results-write-failed` | output error | The results file cannot be written (exit 4); the previous file, if any, is kept. |
| `output-write-failed` | output error | `catscan pseudo` cannot write the pseudo catalog (exit 4). The hint says to check that the folder is writable or pass `--out <path>`. |
| `results-unreadable` | input error | `results merge` or `validate`: a results file cannot be read (exit 4). |
| `results-invalid` | input error | A results file breaks the schema or its consistency rules; one line per violation with its JSON pointer (`validate` exit 1, `merge` exit 4). |
| `results-build-mismatch`, `results-layout-mismatch` | usage error | `results merge`: the shards differ in `run.build` or layout (exit 2); pass `--layout` for the last. |
| `results-axis-unknown` | usage error | `results merge`, `report`, `--baseline`: a file names an axis this catscan does not know, so a later version wrote it (exit 2). Hint: upgrade every job of the pipeline to that version. |
| `invalid-device` | usage error | `--device` or `--expect-devices` has a label outside the grammar (exit 2). Hint: `--device ios-se`. |
| `invalid-text-size` | usage error | `--text-size` or `--expect-text-sizes` has a label outside the grammar (exit 2). Hint: `--text-size large`. |
| `results-duplicate-shard` | usage error | `results merge`: a shard is given twice (directly or inside a merged file), or `--out` is also an input (exit 2). |
| `invalid-layout`, `expect-screens-unreadable`, `expect-locales-from-not-found`, `expect-locales-from-empty` | usage error | A `--layout` or `--expect-*` option has a bad value (exit 2). |
| `unknown-command`, `unknown-option`, `missing-command`, `missing-path`, `missing-check`, `missing-value`, `unexpected-value`, `invalid-value`, `invalid-locale`, `conflicting-options`, `option-not-valid`, `repeated-option`, `repeated-stdin`, `command-not-available`, `option-not-available`, `expect-file-not-found`, `invalid-expect-file`, `missing-catalog`, `missing-locale`, `allow-not-found`, `allow-too-large`, `invalid-allow`, `catalog-not-found`, `invalid-catalog` (names `file:line:column`), `catalog-too-large`, `catalog-too-many-strings` (`untranslated`: more than 20,000 key pairs or target alternatives, or a string with more than 256 forms or 256 fragments), `unknown-catalog-key`, `unknown-reason`, `unknown-kind`, `pseudo-conflicts-with-base`, `dynamic-not-found`, `dynamic-invalid` (names `file:line`), `invalid-min-overlap`, `invalid-threshold` (an unknown `--min-severity` or `--min-certainty` level; when it is a level of the other flag the hint names that flag), `experimental-command`, `invalid-currency`, `invalid-storefront`, `missing-currency`, `prices-not-found`, `prices-invalid` (names the JSON pointer), `unknown-rule`, `boxes-not-found`, `invalid-boxes`, `boxes-one-image`, `unknown-source`, `missing-image`, `invalid-dump` | usage error | Exit 2. |
| `unsupported-node` | install | Node is older than 22; the message names the version found (exit 5). |
| `unsupported-platform` | install | Not macOS, or not Apple silicon; Vision exists only on macOS on Apple silicon. The message names the platform and the machine (exit 5). |
| `unsupported-os` | install | macOS is older than 15; the message names the macOS found (exit 5). |
| `binary-not-found` | install | `@catscan/cli-darwin-arm64` is missing. The hint names the cause: an x64 Node under Rosetta (install an arm64 Node), or an install that skipped optional dependencies or a lockfile from another OS (the add command for the package manager that ran catscan, at the exact version). In a repo checkout: `swift build`. Exit 5. |
| `binary-version-mismatch` | install | `@catscan/cli-darwin-arm64` has a different version than `@catscan/core-js`; the hint installs the exact version (exit 5). |
| `binary-failed`, `internal` | internal | Exit 5. |
| `registry-invalid` | internal | The finding registry is missing, unparsable or has no row for a finding the core emitted; the message names the kind, rule and reader. A bug: report it (exit 5). |
| `mixed-thresholds`, `mixed-registry` | warning | `results merge` or `report` over shards with different thresholds or finding registries: the merged `run.thresholds` or `run.registry` is `null`. Pass `--min-severity` and `--min-certainty` to recompute one set. |
| `unscaled-items` | warning | Threshold flags over findings from an older catscan, which have no severity: they still gate. Rerun those shards with this version. |
| `serve-protocol-mismatch` | client | A serve client and server speak different protocol versions. |
| `invalid-json`, `invalid-request`, `unknown-command`, `command-not-available`, `request-too-large` | serve response | A request line that could not be served. |

Codes are stable: renaming or removing one follows the same rule as the JSON schema.

## Recognition

Vision `VNRecognizeTextRequest`, accurate level, revision 3, language correction on, languages: the locale plus `en-US`. Images narrower than 1000 px are upscaled 2x. Images longer than 4096 px on the long edge are recognized in tiles of 4096 px with a 256 px overlap; lines with equal normalized text and box IoU > 0.5 are merged, keeping the higher confidence. A pool of 2 concurrent requests overlaps decode with recognition. The compute device is left to the OS.

Deadline: one image, all its tiles and the second read of `overlap` (stacked text) included, or one video frame, gets 60 s in Vision; past that it is `vision-timeout` and the run goes on. `CATSCAN_VISION_TIMEOUT=<seconds>` (a positive number) changes it for the CLI, MCP and `serve`; an invalid value keeps 60 and says so on stderr. The CLI and MCP also watch `catscan-core` itself: an image request with no answer within the deadline plus 150 s (two Tesseract reads and margin) is `core-timeout`, and the process is replaced. A `video` request has no such watchdog, since a long video has no total bound: keep a CI job timeout above your longest video, and above 3 x (deadline + 150 s), 630 s by default, for a stuck core.

## Languages

`catscan languages` lists every language Vision reads on this Mac, including the languages read with a related Vision model, and names the locales the Tesseract fallback reads: the catscan locale, the Vision code, the script, the direction, whether whitespace is dropped for matching, live support and aliases, then whether this Mac's Vision list matches catscan's table for its macOS major version. `--json` prints one object with `"schema": 1` ([`core/schema/languages.schema.json`](../core/schema/languages.schema.json), same stability rule as the result envelope): `languages[]` in table order, then languages newer than the table (`locale`, `vision`, `aliases`, `script`, `direction` `ltr`/`rtl`, `no_spaces`, `in_table`, `supported`, `fallback`, always `null` because a locale Vision reads never uses the fallback; a language newer than the table has script `unknown` and `null` direction and no_spaces) `os_table` (`macos`, `known`, `matches`, `added`, `removed`), and `fallback_locales`, the locales the Tesseract fallback reads when it is installed (`catscan doctor` says which packs are). A Mac whose macOS has no table row still lists its languages, with `known: false`.

| Locale | Vision code | Script | No spaces | Right to left |
| --- | --- | --- | --- | --- |
| en, fr, it, de, es, tr, id, cs, da, nl, ms, pl, ro, sv, fi, vi | en-US, fr-FR, ... (region added) | Latin | | |
| pt-BR (alias pt) | pt-BR | Latin | | |
| no, nb, nn | no-NO, nb-NO, nn-NO | Latin | | |
| ru, uk | ru-RU, uk-UA | Cyrillic | | |
| zh-Hans (aliases zh-CN, zh-SG) | zh-Hans | Han | yes | |
| zh-Hant (aliases zh-TW, zh-HK, zh-MO) | zh-Hant | Han | yes | |
| yue-Hans (alias yue-CN), yue-Hant (aliases yue-HK, yue-MO) | yue-Hans, yue-Hant | Han | yes | |
| ja | ja-JP | Japanese | yes | |
| ko | ko-KR | Hangul | yes | |
| th | th-TH | Thai | yes | |
| ar, ars | ar-SA, ars-SA | Arabic | | yes |
| hi, mr | hi-IN, mr-IN | Devanagari | | |
| ca, eu, gl | es-ES | Latin | | |
| lb | de-DE | Latin | | |
| fil (alias tl) | en-US | Latin | | |

The last three rows are languages Vision does not list, read with a listed model of the same letters: Vision's Latin output does not depend on the model asked, and these languages use no letter Vision drops. A row is unsupported on a Mac whose Vision does not list its model.

`--locale` is resolved by full tag (a locale, an alias or the Vision code itself), then by removing trailing subtags (`zh-Hant-TW` -> `zh-Hant`), then by language subtag (`zh` -> `zh-Hans`, `yue` -> `yue-Hant`, as Cantonese is written in Hong Kong and Macau); a match that is not exact adds `locale-fallback`. A fallback never changes script: a tag that names a row this Mac does not list, or a script subtag the row does not use (`ru-Latn`), is `unsupported-language`. The accepted form is language[-Script][-REGION]; `pt_BR` is a usage error whose hint is `--locale pt-BR`. The envelope `locale` keeps the tag you gave. A language Vision lists that the table does not know yet resolves by its Vision code. Anything else is `unsupported-language` (exit 3). On a right-to-left locale, `read` orders lines on one row from right to left.

## Fallback

Vision cannot read Greek, Hebrew, Bulgarian, Serbian, Hungarian, Persian, Georgian or Armenian, and it drops letters of Croatian, Slovak, Slovenian, Lithuanian, Latvian, Estonian, Maltese, Irish, Icelandic, Macedonian, Bosnian, Belarusian, Welsh and Albanian (`š` read as `s`, `ŵ` as `w`: a false "missing text" finding). For these locales catscan hands the screen to [Tesseract](https://github.com/tesseract-ocr/tesseract) when it is installed; catscan never downloads or bundles it.

Install per locale, CI caching, the tested version and how it compares with Vision: [`recipes/tesseract.md`](recipes/tesseract.md).

```bash
brew install tesseract tesseract-lang
catscan doctor
catscan check shots/el --locale el --present "Συνέχεια"
```

| Locale | Tesseract pack |
| --- | --- |
| `el` | `script/Greek` |
| `he` | `heb` |
| `bg` | `bul` |
| `sr` | `srp+srp_latn` (`sr-Cyrl`: `srp`, `sr-Latn`: `srp_latn`) |
| `hu` | `hun` |
| `fa` | `fas` |
| `ka` | `kat` |
| `hy` | `hye` |
| `hr` | `hrv` |
| `sk` | `slk` |
| `sl` | `slv` |
| `lt` | `lit` |
| `lv` | `lav` |
| `et` | `est` |
| `mt` | `mlt` |
| `ga` | `gle` |
| `is` | `isl` |
| `mk` | `mkd` |
| `bs` | `bos` |
| `be` | `bel` |
| `cy` | `cym` |
| `sq` | `sqi` |

- A locale Vision reads always uses Vision.
- With Tesseract and the pack installed, the envelope has `"engine": "tesseract-<version>"`, the normal verdicts and the warning `fallback-engine`. Tesseract runs as `-l <pack>+eng`, one or two processes per image (about 50 ms each on a phone screenshot, plus process start; see [`BENCHMARKS.md`](BENCHMARKS.md#tesseract-fallback)). It reads the image unscaled; when the median line is under 40 px tall, or nothing was read, it reads again upscaled toward 40 px (at most 3x and 16 MP) and keeps the second read; the `fallback-engine` warning then names the median line height and the factor.
- Without Tesseract, without the pack, or with `--fallback none`, every check on the input is `needs-reader` and the exit code is 3 (`reader-missing`). The hint says what to install for this Mac, then rerun the same command.
- Lookup: `CATSCAN_TESSERACT=<path>` when set (the only candidate), else `PATH`, else `/opt/homebrew/bin`. `TESSDATA_PREFIX` is passed through to Tesseract.
- In CI, run `catscan doctor --expect-locales-from <catalogs>` (or `--expect-locales <list>`) before the check: it exits 1 with the install command when a listed locale has no working reader ([Doctor](#doctor)).

## Doctor

`catscan doctor` prints one line per check, `ok   <name>: <value>` or `FAIL <name>: <message> - try: <advice>`, and exits 0 when catscan can run, 1 when something it needs is missing or broken. A missing Tesseract is advice, not a failure, unless a listed locale needs it.

`--expect-locales <list>` and `--expect-locales-from <dir>` (the same options as `check`) add one `locale` row per locale: the reader that reads it (Vision or Tesseract) and, for a Tesseract locale, a word rendered in its script and read with Tesseract (a shared 40 s budget). A locale with no working reader fails with its fix: the install command when Tesseract or the pack is missing, the Tesseract error otherwise. With `--expect-locales-from`, a catalog whose locale cannot be told fails a `catalogs` row: list the locales instead. This is the CI preflight in [`examples/ci/`](../examples/ci/). It never stops at a missing or broken binary: the Node checks still print.

| Check | What it looks at |
| --- | --- |
| `node` | Node version (22 or newer) and architecture |
| `platform` | macOS on Apple silicon (an x64 Node under Rosetta is named) |
| `macos` | macOS 15 or newer, with its build |
| `binary` | The `catscan-core` path, its source and architecture, and that it starts. Source `package` (`@catscan/cli-darwin-arm64` at the exact version), `env` (`CATSCAN_CORE_BINARY`) or `build` (`core/.build/release`, repo checkout only) |
| `version` | The binary's version equals the Node package's |
| `signature` | Source `package` only: `codesign --verify --strict` and catscan's Team ID `JK3T6SMS5W`; notarization from `spctl --assess --type open --context context:primary-signature` is informational and `null` offline. A binary that fails this check is not started |
| `vision` | Vision text request revision and the number of accurate and fast recognition languages |
| `self_test` | Vision reads a word rendered in memory; time in ms |
| `tesseract` | The fallback: path, version, which fallback locales it reads and the install command for missing packs |
| `catalogs` | `--expect-locales-from` only: a catalog or folder whose locale could not be read |
| `locale` | `--expect-locales[-from]` only, one row per locale: its reader and, for Tesseract, a read of a rendered word |

`--json` prints exactly one object with `"schema": 1` ([`core/schema/doctor.schema.json`](../core/schema/doctor.schema.json)): `catscan`, `engine`, `host` (with `macos_build`) and `fallback` (`engine`, `path`, `version`, `tessdata`, `packs`, `searched`, `fix` (the command that makes Tesseract read every fallback locale here, or `null`), `locales[]` with `locale`, `packs`, `installed`, `missing`, and `self_test` (`ms`, `pass`) for a locale `--expect-locales` read) from the binary; `requested[]` (`locale`, `reader`: `vision`, `tesseract` or `null`, `fallback_locale`, `ok`, `error`, and `self_test` for a Tesseract locale, read with the packs a check in it runs) with `--expect-locales[-from]`; `neural_engine` (`present`, `absent` or `unknown`), `vision` (`revision`, `languages.accurate`, `languages.fast`) and `self_test` (`ms`, `pass`) from the binary; `binary` (`path`, `source`, `version`, `arch`, `signature` with `valid`, `team_id`, `notarized`, or `null` outside `package`), `node` (`version`, `arch`), `checks[]` (`name`, `ok`, `value`, `advice`), `ok`, and `ci` from Node: the CI service (`provider`, `runner`, `commit`, `ref`, `run_id`) from the same detector as the results file's `run.ci`, or `null` outside CI. When the binary could not run, `engine`, `host` and `fallback` are `null` and `ok` is `false`; `binary` is `null` when none was found. The check names above are a stable list; a check that cannot run because an earlier one failed is left out.

**Newer version.** On a developer's machine `doctor` also asks the npm registry for the latest `@catscan/cli` and prints one line after the checks: `ok   update: 1.0.0 installed, 1.1.0 available - try: the catscan-upgrade skill, or docs/recipes/upgrade.md` (`the latest` when you have it, `npm latest is ...` when your build is ahead of npm). It is never a failure and never changes the exit code. The request sends only the package name in the URL and the user agent `catscan`: not your version, paths or OS. It waits at most 1.5 s, and the answer is cached in `$XDG_CACHE_HOME/catscan/update-check.json` (`~/.cache/catscan/` by default) for 24 hours, a failed request for 1 hour, so an offline machine pays the wait at most once an hour (a relative `XDG_CACHE_HOME` is ignored; with an unwritable cache folder every run asks). A failed or slow request prints nothing. It is off with `--offline`, with `CATSCAN_NO_UPDATE_CHECK=1`, and on a CI runner (`CI` set, or a service the results file's `run.ci` recognizes), since CI pins exact versions. The MCP server never checks. `--json` adds `update`: `{ latest, current, newer, checked_at, source }` (`source` is `registry` or `cache`), or `null` when the check was off or failed. To move every place your project holds catscan at once, see [Upgrade](recipes/upgrade.md).

## `serve`

A long-lived process for integrations (Playwright, MCP): JSON Lines over stdin and stdout.

1. The first line is `{"catscan":"<version>","id":null,"protocol":23,"type":"ready","vision_timeout_s":60,"engine":"vision-accurate-rev3","host":{...}}` (`host` as in the envelope). Clients wait for it and refuse a different `protocol` with `serve-protocol-mismatch`.
2. Each request is one line:

   ```json
   { "id": "7", "command": "check", "image": "<base64 PNG>", "present": ["GAME OVER"], "locale": "en" }
   ```

   - `command`: `check`, `read`, `untranslated`, `video`, `truncated`, `overlap`, `fit` or `thumbnail`.
   - `image` (base64) or `path`. `name` optionally sets the envelope's `path` for base64 input.
   - `present`, `absent`: arrays of strings, or of catalog checks `{ "key", "catalog", "text", "alternatives": [[fragment]], "reason" }` (the Node layer reads catalog files and sends raw fragments; `reason` makes the check `skipped`). `inventory`: an array of catalog checks for `--all-keys`. `locale`: optional; without it, the locale-script rule may pick one.
   - `fallback`: optional, `tesseract` or `none`; without it, Tesseract when installed ([Fallback](#fallback)).
   - `video` (protocol 4): `path` only (no `image`), plus optional `every`, `from`, `to` (seconds), `frames` (boolean: the envelope then carries `samples: [{t, lines}]`, which the CLI prints as `video-frame` lines) and `ranges: [{ "key", "start", "end": number|null, "present", "absent" }]`. One request holds one pool slot for the whole video.
   - `truncated` (protocol 5; `overflow` reason protocol 8): `path` or `image`, plus an optional `truncated: { boxes?, prefixes?: [{text, alternatives}], reasons?, allow?, edge_distance? }`, `boxes` in the boxes-file format. Each malformed field is `invalid-request` naming it (`truncated.reasons must be ...`).
   - `untranslated` (protocol 15): an optional `uncatalogued: { entries: [{key, locale, text, forms: [{fragments, lead, trail}]}], languages, dynamic, allow, digest?, dynamic_rects?, dynamic_size? }` for the experimental `uncatalogued` kind (CLI `--uncatalogued --experimental` only); the first request carries it in full, later ones `{digest}` plus their own `dynamic_rects`.
   - `untranslated`, `truncated` and `check` (protocol 10): an optional `pseudo: { entries: [{key, catalog, text, forms: [{fragments, lead, trail}]}], fillers, dynamic, allow, digest?, dynamic_rects? }` switches on the pseudo rules ([Pseudo-localized builds](#pseudo-localized-builds)); a request with only `digest` reuses the field sent with it earlier. `untranslated.kinds` filters findings; `truncated.pseudo: true` folds pseudo text for `overflow`.
   - Any image command (protocol 9): an optional `text_record: { "mode": "full"|"digest", "ignore"?: [regex], "ignore_digest"?: string }` adds `text` to the envelope ([results.md](./results.md#baselines-and-text-records)); `null` when nothing was read.
   - `overlap` (protocol 7; `boxes`, `allow` and `no_boxes` protocol 11; `occlusion` and the boxes fields `panel` and `scrolls` protocol 12; `stacked` protocol 16; `geometry` protocol 23): `path` or `image`, plus an optional `overlap: { min_overlap?, boxes?, allow?, no_boxes?, occlusion?, stacked?, geometry? }` (`occlusion: true` adds `occluded` findings, what `--experimental` sends with boxes; `stacked: true` adds `signal: "stacked"` findings, what the CLI, MCP and `toHaveNoOverlap` send on every run; `geometry: false` skips the OCR-only `boxes` reader on an image with no boxes, what the CLI sends without `--experimental`; all must be booleans): `min_overlap` a number above 0 and at most 1 (default 0.01 with boxes, 0.3 without), `boxes` in the boxes-file format (as `truncated`; `graphic`, `panel` and `scrolls` must be booleans), `allow` an array of element ids or texts, `no_boxes: { looked }` makes the image the `overlap-no-boxes` error naming that sidecar. A malformed field is `invalid-request` naming it.
   - `fit` (protocol 18; 19 adds `portrait-upside-down`; `wrap`, the reasons `wrapped` and `orphan` and the boxes field `max_lines` protocol 20): `path` or `image`, plus an optional `fit: { profile?, matched_by?, table?, version?, platform?, orientation?, boxes?, reasons?, allow?, controls?, min_hidden?, min_control?, wrap? }`; `wrap: { evidence?, element_rows?, base_path?, base_locale?, base?, pairs? }`: `evidence` the `wrapped` evidence types to use, `element_rows: true` adds an `element_rows` array (`{id, text, rows, orphan}` per judged element) to the envelope, `base` those rows from the base screenshot, `pairs: { digest, entries?: [[key, target, base, catalog?]] }` the catalog pairs (cached by digest like `untranslated` catalogs): `profile` a device profile object (`core/schema/device-profile.schema.json`; the Node layer resolves `--device-profile` ids and validates profile files), `table` the path of a shipped profile table matched by pixel size, `orientation` `portrait`, `landscape-left`, `landscape-right` or `portrait-upside-down` (from a sidecar), `reasons` a non-empty array of `cutout`, `corner`, `home-indicator`, `wrapped`, `orphan`, `controls` `true`, `false` or the reasons whose textless controls are checked, `min_hidden` (default 0.5, a letter's hidden share) and `min_control` (default 0.25, a control's covered share) numbers above 0 and at most 1, `boxes` in the boxes-file format (`control` must be a boolean, `max_lines` an integer of at least 1). A malformed field is `invalid-request` naming it.
   - `contrast` (protocol 21): `path` or `image`, plus an optional `contrast: { level?, scale?, scale_source?, kinds?, allow?, boxes? }`: `level` `AA` or `AAA`, `scale` a number from 1 to 4, `scale_source` `flag`, `boxes`, `size-table`, `page` or `none` (the Node layer resolves the scale chain), `kinds` a non-empty array of `low-contrast`, `busy-background`, `allow` an array of strings, `boxes` in the boxes-file format (`enabled` must be a boolean). The envelope carries `lines` with a `contrast` object each. A malformed field is `invalid-request` naming it. The gate (`--experimental`) is the CLI's; serve runs what it is asked.
   - `thumbnail` (protocol 6, for the HTML report): `{ "id", "command": "thumbnail", "path", "max_edge": 1..8192, "quality": (0, 1], "t"? }`. The reply is `{ "id", "width", "height", "jpeg" }` (`jpeg` base64), scaled to `max_edge` on the long edge (never up), orientation applied; with `t` (seconds), the video frame at that exact time. Errors use the usual envelope: `input-not-found`, `input-unreadable`, `image-too-large`, `invalid-request`.
   - `untranslated` (command `untranslated`): `{ "base_locale": string, "pairs": [{ "key", "catalog": string|null, "base", "expected": string|null, "base_alternatives": [[fragment]], "target_alternatives": [[fragment]] }], "targets": [[fragment]], "keys": [string], "texts": [string], "styles": ["{name}"|"{{name}}"|"{0}"|"icu"|"printf"], "allow": [string] }`. Only `base_locale` is required. With a `"digest"` string, the process keeps the field (the newest 4), and later requests may send `{ "digest" }` alone; an unknown digest is `invalid-request`. The CLI does this, so a run sends its catalogs once. `targets` holds the alternatives of every target string (for the span rule), `keys` the exact keys that count as raw keys, `texts` every catalog string (a key that equals one with its separators read as spaces is not reported). Limits: at most 20,000 `pairs` and 20,000 `targets`, 256 alternatives and 256 fragments per string (each `targets` entry is one form); a field over one is `invalid-request` naming the field, its count and the limit (`untranslated.pairs has 25001 items; the limit is 20000.`). Any other shape or style is `invalid-request`. An optional `wrong_language: { languages?: [locale], preferred?: locale, others?: [{ locale, catalog, pairs }] }` (protocol 13) adds `wrong-language` findings ([Untranslated](#untranslated)): `languages` the other project locales for the language recognizer, `others` one entry per other locale's catalog file (its strings as `base`, the run locale's as `expected`, in the `pairs` format and limits), `preferred` the locale named when several catalogs hold a line.
3. Each response is the envelope above plus `id`, or `{ "id": ..., "error": { "code", "message" } }`. `id` is the request's id, or `null` when the line could not be parsed (for an oversized line, catscan recovers the id from its start when it can).
4. Limits: a request line up to 64 MB, a decoded image up to 100 megapixels. Malformed JSON, oversized lines and decode failures get an error response; the process keeps serving. Blank lines are ignored and get no response.
5. Requests are answered in order. Several `serve` processes can run side by side; one per test worker is the expected use.
6. The process exits when stdin closes. On SIGINT or SIGTERM it stops any running Tesseract and removes its temporary files, then exits by that signal.
7. After a `vision-timeout` response, restart `serve`: the abandoned Vision read may keep a thread busy for the life of the process. `Server` in `@catscan/core-js` does this, and also replaces a process that stops answering ([Diagnostic codes](#diagnostic-codes), `core-timeout`).

`catscan serve` runs the binary's `serve` directly. The Node client is `Server` in `@catscan/core-js`. An envelope whose `error.code` is `vision-languages-failed` is an internal error (exit 5), not an input error, although its verdict is `error`; serve consumers use `isInternal()` from `@catscan/core-js` to map it.

## Layout

- `core/`: the Swift binary `catscan-core` (`serve`, `version`, `languages`, `doctor`): recognition, rules, JSON Lines.
- `packages/core-js`: argument parsing, `--expect`, `--catalog` parsing, the serve client, the text renderer, the HTML report (`src/report/`) and the exit code.
- `packages/cli`: `@catscan/cli`, the `catscan` command.
- `packages/mcp`: `@catscan/mcp`, the MCP server `catscan-mcp` ([`recipes/mcp.md`](recipes/mcp.md)).

Build and test:

```
swift build -c release --package-path core
npm ci
npm test
```
