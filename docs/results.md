# The results file

`--results <file>` writes a whole run to one versioned JSON file: what was expected, what was checked, on which build and machine, and every result. CI shards merge into one file with `catscan results merge`; other tools read the file instead of parsing console output. It is written to local disk only; catscan makes no network calls. The schema is [`core/schema/results.schema.json`](../core/schema/results.schema.json).

```
catscan check shots --expect checks.yaml --expect-locales de,fr,ja --results catscan-results.json --build 4512 --build-version 2.8.0
catscan results merge shard-*.json --expect-locales-from locales --out catscan-results.json
catscan results validate catscan-results.json
```

## Layout

`--layout` says how the locale and screen id are read from a path, relative to the argument that found it (`shots/de/home.png` from the argument `shots` is `de/home.png`):

| Pattern | Path | Locale | Screen |
| --- | --- | --- | --- |
| `{locale}/{screen}` (default) | `de/onboarding/1.png` | `de` | `onboarding/1` |
| `{screen}.{locale}` | `onboarding/1.de.png` | `de` | `onboarding/1` |
| `{screen}/{locale}` | `home/de.png` | `de` | `home` |
| `{locale}-{screen}` | `de-home.png` | `de` | `home` |
| `{screen}-{locale}` | `home-pt-BR.png` | `pt-BR` | `home` |
| `none` | any | from `--locale` | `null` |

- `{locale}` must be a locale or alias that `catscan languages` lists (case-insensitive; written as the table spells it). A folder such as `ios/` does not match.
- The hyphen patterns read the locale from the first or last `-` tokens of the file name, two tokens (`pt-BR`, `zh-Hant`) before one, so `settings-panel-de.png` is screen `settings-panel`. Folders above the file stay in the screen (`onboarding/zh-Hant-step-1.png` is screen `onboarding/step-1`); a locale in the middle of the name (`win-de-2.png`) maps nothing.
- A matched locale is the input's recognition locale unless `--locale` or the `--expect` file gives one. When that explicit locale differs from the path, the input gets the warning `locale-path-mismatch`, and its coverage cell is the explicit locale.
- An input that does not match has `screen: null`. With an expectation flag it gets `layout-mismatch` and is in no expected cell; when another pattern, or its `{device}/` form, maps every unmapped input, the warning names it (`- try: --layout '{screen}-{locale}'`).
- A single file argument maps from its file name only, so `catscan check shots/de/home.png` maps nothing with the default pattern; pass the folder above the locales.
- Known limit: `@key` checks and `{locale}` catalog templates still resolve with the run locale, not each input's.

## Device axis

One release is often captured on several devices: iOS and Android, a small and a large phone. The device is a third axis of the cell, beside locale and screen, so the iOS and Android shots of one screen are two cells, not a duplicate. It comes from the path or from `--device`, never from the image.

| Folder tree | What to pass |
| --- | --- |
| `shots/ios/de/home.png`, `shots/android/de/home.png` | `catscan check shots --layout '{device}/{locale}/{screen}'` |
| `shots/ios/home.de.png` (one tree per device) | `catscan check shots --layout '{device}/{screen}.{locale}'` |
| `shots/ios/de/home.png`, one job per device | `catscan check shots/ios --device ios --results ios.json`, the same with `android`, then `catscan results merge ios.json android.json --expect-devices ios,android --out all.json` |

- **`{device}/` prefix:** any pattern above may start with one folder segment `{device}/`. The rest must match the base pattern, so a folder that is not a device cannot be read as one when the locale after it does not validate.
- **`--device <label>`:** the device of every input of the run. It wins over a `{device}` segment; when both differ, the input gets `device-path-mismatch`.
- **Labels:** 1-64 characters of `a-z`, `0-9`, `.`, `_`, `-`, starting with a letter or digit, stored in lower case (`iOS-SE` is `ios-se`). Another `--device` value is exit 2 (`invalid-device`). Use `<platform>-<model>`: `ios-se`, `ios-pro-max`, `android-pixel-9`.
- **`platform`:** the label's first token (split at `-`, `_` or `.`) when it is `ios`, `ipados`, `android`, `web`, `macos`, `watchos`, `tvos` or `visionos`, else `null`.
- **`--expect-devices ios,android`:** the devices that must be present, like `--expect-locales`. Without it, the expected devices are the devices of the mapped inputs.
- **Once the axis is in use** (any input or expectation has a device), an input with no device is in no cell: it gets `device-missing`, which names the input, the run's devices and the next command. A file written before the device axis, merged with device shards, therefore makes no bogus `missing` cells.
- **`expected_path`** of a missing cell is the layout filled in; a device from `--device` that the layout does not hold is prepended (`ios/home.de`), so two devices' missing cells never share a name in CI output.
- **Layout hint:** when the inputs do not match `--layout` but all of them match its `{device}/` variant, `layout-mismatch` names it: `... does not match --layout {locale}/{screen} ... - try: --layout '{device}/{locale}/{screen}'`.
- **Nested folders:** with `{device}/{screen}.{locale}`, an argument that is already a device folder makes a nested screen folder (`onboarding/1.de.png`) read as device `onboarding`. Pass the folder above the device folders; `--expect-devices` shows such a device as `unexpected` in the report.
- **One build:** a merge refuses shards with different `run.build`, so both platform jobs of one release pass the same `--build` (the pipeline or release id) and `--build-version` (the marketing version); keep per-platform build numbers out of these flags.
- **Upgrade:** a file that uses the axis is `results_schema: 2` (see Format). catscan versions before the device axis cannot read it and refuse it with `results-schema-mismatch` or `results-invalid`: run every job that writes, merges or reports one pipeline's files on the same catscan version. A file naming an axis this version does not know is refused with `results-axis-unknown`; the fix is the same.

A `--json` envelope with the axis:

```json
{ "schema": 1, "command": "check", "path": "shots/ios/de/home.png", "verdict": "pass", "locale": "de", "screen": "home", "device": "ios", "platform": "ios", "...": "the envelope of docs/cli.md" }
```

## Text-size axis

Large system text (iOS Dynamic Type, Android font scale, browser zoom) breaks layouts that fit at the default size. The text size is an axis of its own, after the device, so one report compares a cell's sizes and shows what breaks only at large text. Capture recipes per platform: [recipes/large-text.md](./recipes/large-text.md).

| Tree | Command |
| --- | --- |
| `shots/large/de/home.png`, `shots/default/de/home.png` | `catscan check shots --layout '{text_size}/{locale}/{screen}'` |
| `shots/ios/large/home.de.png` | `catscan check shots --layout '{device}/{text_size}/{screen}.{locale}'` |
| `shots/de/home.png`, one run per size | `catscan check shots --text-size large --results large.json` (and the default run), then `catscan results merge` |

- **`{text_size}/` prefix:** one folder segment after an optional `{device}/` and before the base pattern; the order is fixed (`{device}/{text_size}/...`). A tree in another order uses `--device` or `--text-size` instead.
- **`--text-size <label>`:** the size of every input of the run. It wins over a `{text_size}` segment; when both differ, the input gets `text-size-path-mismatch`. A label outside the grammar is exit 2 (`invalid-text-size`).
- **Labels:** the device label grammar. `default` and `large` are portable: `large` is each platform's largest system size (iOS AX5, Android font scale 2.0, web 200% zoom), so one `--expect-text-sizes default,large` is valid in a combined iOS, Android and web report. Exact labels (`xl`, `xxl`, `xxxl`, `ax1` ... `ax5`, `fs1.3`, `fs1.5`, `fs1.8`, `fs2.0`, `zoom150`, `zoom200`) are for teams that test several sizes. The report orders `default`, `large`, the exact labels in that order, then any other label by code point.
- **`--expect-text-sizes default,large`:** the sizes that must be present. Without it, the expected sizes are the sizes of the mapped inputs.
- **No size is `default`:** unlike a missing device, a missing size has a natural meaning. An input with `text_size: null` is in the `default` cell, so a run captured before the axis (or with no size folder) merges with a `--text-size large` run into one report, and an old baseline or known file matches the `default` cells. An input at `default` and one with no size in the same cell are a `duplicate-cell`.
- **Every command at every size:** run the same commands at each size; a cell without, say, an `untranslated` result would read as passing it.
- **Upgrade:** a file that uses the axis is `results_schema: 2` with `text_size` in `axes`, after `device`. catscan versions before the axis refuse it with `results-axis-unknown`; run every job of one pipeline on the same catscan version.

## Coverage

`--expect-locales de,fr,ja`, `--expect-locales-from <catalog dir>`, `--expect-screens <file>` (one id per line, `#` comments) and `--expect-devices ios,android` and `--expect-text-sizes default,large` set the expected cells (devices x text sizes x locales x screens). Any of them makes `coverage` non-null:

- Expected locales without a locale flag are the locales of the mapped inputs; expected screens without `--expect-screens` are every mapped screen.
- `--expect-locales-from` reads `.xcstrings` (`sourceLanguage` plus every translated locale), `<locale>.lproj`, `values-<qualifier>` (`values-pt-rBR` is `pt-BR`, `values-b+zh+Hant` is `zh-Hant`), JSON (`de.json`, else the folder: `de/common.json`, and `en/ui.json` when the name is no language), Flutter `.arb` (its `@@locale`, else the name: `app_de.arb`, `intl_pt_BR.arb`, `de.arb`) and gettext `.po` (its `Language:` header, else `<locale>/LC_MESSAGES/`, the `<locale>.po` name or its folder; `sr@latin` is `sr-Latn`). `Base.lproj`, plain `values` and the `intl_messages.arb` template have no code and are skipped; another file whose locale cannot be read warns `catalog-locale-unknown`, which fails `catscan doctor --expect-locales-from`.
- Locale codes compare case-insensitively (`--expect-locales pt-br` matches `pt-BR/`).
- Each expected cell with no input is a `missing` result with verdict `fail`, on stdout after every input (text: `FAIL  missing: ja/paywall`) and in the file, so the run exits 1.
- A cell is (device, text size, locale, screen); without the device axis the device is `null`, and without the text-size axis the size is `null`, which counts as `default`.
- Two inputs in one cell are both kept and both get `duplicate-cell`. In a merge this is per command: results of `check` and `untranslated` for one screenshot are one cell, not a duplicate (see Merge).

## Format

```json
{
  "results_schema": 1,
  "run": {
    "catscan": "<version>",
    "started_at": "2026-12-01T10:15:02Z",
    "finished_at": "2026-12-01T10:16:20Z",
    "argv": ["check", "shots", "--expect-locales", "de,fr,ja", "--results", "catscan-results.json"],
    "host": { "chip": "Apple M1 (Virtual)", "arch": "arm64", "host_class": "vm", "macos": "15.6 (24G84)", "vision_revision": 3 },
    "ci": { "provider": "github-actions", "runner": "macos15", "commit": "3f2a9c1", "ref": "refs/heads/main", "run_id": "1234567" },
    "build": { "id": "4512", "version": "2.8.0" },
    "shards": [],
    "thresholds": { "min_severity": "minor", "min_certainty": "low" },
    "registry": "0161107390b8"
  },
  "coverage": {
    "layout": "{locale}/{screen}",
    "expected_locales": ["de", "fr", "ja"],
    "expected_screens": ["home", "paywall"],
    "expected_devices": null,
    "expected_text_sizes": null,
    "received": 5,
    "missing": [{ "device": null, "text_size": null, "locale": "ja", "screen": "paywall" }]
  },
  "totals": { "pass": 4, "fail": 2, "needs-reader": 0, "unsupported": 0, "error": 0 },
  "results": [
    { "schema": 1, "command": "check", "path": "shots/de/home.png", "locale": "de", "screen": "home", "device": null, "platform": null, "text_size": null, "verdict": "pass", "...": "the envelope of docs/cli.md" },
    { "schema": 1, "catscan": "<version>", "command": "check", "path": null, "verdict": "fail", "engine": null, "locale": "ja", "screen": "paywall",
      "device": null, "platform": null, "text_size": null, "image": null, "host": null, "ms": 0, "checks": [], "findings": [{ "kind": "missing", "box": null, "expected_path": "ja/paywall", "severity": "critical", "certainty": "high", "precision": null, "gate": true }], "warnings": [] }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `results_schema` | `2` when the file uses an axis (an envelope or expectation has a device or a text size), else `1`. A reader accepts a file whose `results_schema` it knows and ignores fields it does not know. Fields are added in minor versions; renaming or removing one bumps `results_schema`. This catscan reads 1 and 2; a schema-1 file reads as every device `null` and every text size `default`. |
| `axes` | Schema 2 only: the axes the file uses, in cell-key order (`["device"]`, `["text_size"]` or `["device", "text_size"]`). A reader refuses a file that names an axis it does not know (`results-axis-unknown`; `merge`, `report` and `--baseline` exit 2, `validate` exit 1), so a later axis adds a name here instead of a new `results_schema`. |
| `run.catscan` | The catscan version that wrote the file (for a merged file, the one that merged it). |
| `run.started_at`, `run.finished_at` | UTC, whole seconds. Merged: the earliest start and the latest finish. |
| `run.argv` | The command line as given, with every absolute path, or path outside the working directory, rewritten as below. catscan takes keys only from the environment, so `argv` holds none. |
| `run.host` | The machine (the envelope's `host`); `null` when no input reached the reader, or in a merged file whose shards ran on different machines. |
| `run.ci` | `null` outside CI; else filled only from the provider's standard variables (table below). catscan never runs `git`. |
| `run.build` | `{ "id", "version" }` from `--build` and `--build-version` (either may be `null`), or `null` when neither is given. |
| `run.shards` | `[]` for one run. Merged: each shard's `{started_at, finished_at, argv, host, ci, results_digest}`, sorted by `started_at`; merging a merged file flattens its shards. `results_digest` is the sha256 of the shard's canonical results without missing entries; with the run fields it identifies a shard, so the same shard given twice is refused. |
| `run.thresholds` | `{ "min_severity", "min_certainty" }`: the run's `--min-severity` and `--min-certainty` (default `minor`, `low`). Merged: the merge flags when given, else the shards' common value, else `null` with the warning `mixed-thresholds`. Absent in files from catscan versions before severity existed. |
| `run.registry` | The finding registry that set each item's severity and certainty: the first 12 hex digits of the sha256 of its canonical JSON. Merged: the shards' common value, else `null` with `mixed-registry`. Each `run.shards[]` record keeps its own `thresholds` and `registry`. |
| `run.allow` | `sha256:<hex>` of the run's `--allow` file, taken when the run read it; absent without `--allow`. Each `run.shards[]` record keeps its own. `catscan results known` records it in the known file's `scope` ([Known findings](#known-findings)). |
| `known` | Only with `--known`: the known file, its digest and the known, new and gone counts ([Known findings](#known-findings)). Each `run.shards[]` record keeps its `known_digest`. |
| `coverage` | `null` without an expectation flag. `layout` is the pattern; `expected_devices` the expected devices, or `null` without the device axis; `expected_text_sizes` the expected text sizes, or `null` without that axis; each `missing` item has `device`, `text_size`, `locale` and `screen`; `received` counts the results that map to an expected cell (a duplicate counts twice, and a merge of several commands counts a cell once per command); `missing` lists the same cells as the `missing` results. |
| `totals` | The count of `results[]` per verdict, `missing` results included. |
| `results[]` | One envelope per input ([docs/cli.md](./cli.md#the-json-envelope)), then the `missing` results. A `--pseudo` run's envelopes carry `pseudo: true` and may hold `hardcoded`, `pseudo-not-applied` and `truncated` `pseudo-cut` findings ([Pseudo-localized builds](./cli.md#pseudo-localized-builds)). Inputs are sorted by (path, command), ties by their canonical JSON; `missing` results by (device, text size, locale, screen). `video-frame` lines are stdout-only. |

**Paths:** relative to the working directory. In warning and error messages (not recognized text), every outside path the run names gets the same rewrite, and the home folder is `~`. A path outside it is `abs:` plus the last component of the argument that named it and the rest below it: `/tmp/shots/de/home.png` from the argument `/tmp/shots` is `abs:shots/de/home.png`. stdout keeps the path as given.

**Determinism:** `results[]`, `coverage` and `totals` are the same for identical runs; only `run` and each result's `ms` and `host` vary.

**Writing:** the file is written when the run reaches its end, whatever the exit code from the inputs, through a temporary file in the same folder that is renamed into place, so a killed run leaves the previous file or none. A usage error (exit 2) writes nothing, and neither does a run where the core died before every input had a result (its cells would read as missing); both failures to write are exit 4 (`results-write-failed`) unless the run is already exit 5.

### CI fields

The first provider whose marker variable is set wins.

| Provider | Marker | `runner` | `commit` | `ref` | `run_id` |
| --- | --- | --- | --- | --- | --- |
| `github-actions` | `GITHUB_ACTIONS` | `ImageOS` | `GITHUB_SHA` | `GITHUB_REF` | `GITHUB_RUN_ID` |
| `gitlab-ci` | `GITLAB_CI` | `CI_RUNNER_DESCRIPTION` | `CI_COMMIT_SHA` | `CI_COMMIT_REF_NAME` | `CI_PIPELINE_ID` |
| `circleci` | `CIRCLECI` | - | `CIRCLE_SHA1` | `CIRCLE_BRANCH` | `CIRCLE_WORKFLOW_ID` |
| `bitrise` | `BITRISE_IO` | - | `BITRISE_GIT_COMMIT` | `BITRISE_GIT_BRANCH` | `BITRISE_BUILD_SLUG` |
| `codemagic` | `CM_BUILD_ID` | - | `CM_COMMIT` | `CM_BRANCH` | `CM_BUILD_ID` |
| `azure-pipelines` | `TF_BUILD` | `AGENT_NAME` | `BUILD_SOURCEVERSION` | `BUILD_SOURCEBRANCH` | `BUILD_BUILDID` |
| `buildkite` | `BUILDKITE` | `BUILDKITE_AGENT_NAME` | `BUILDKITE_COMMIT` | `BUILDKITE_BRANCH` | `BUILDKITE_BUILD_ID` |
| `jenkins` | `JENKINS_URL` | `NODE_NAME` | `GIT_COMMIT` | `BRANCH_NAME` | `BUILD_ID` |

An unset variable gives `null` for its field.

## Merge

`catscan results merge a.json b.json ... --out merged.json` combines shards of one run, for example one CI job per locale group:

- Shards of `results_schema` 1 and 2 merge together; the output is 2 when any shard or flag uses the device or text-size axis. A shard naming an axis this version does not know is exit 2 (`results-axis-unknown`). The shards must share `run.build` (`results-build-mismatch`, `null` matches only `null`); otherwise exit 2. Different catscan versions warn `mixed-versions`. The same shard twice (directly or inside a merged file) and an `--out` that is also an input are exit 2 (`results-duplicate-shard`).
- `missing` results of the shards are dropped and coverage is computed again over every received input, so a cell one shard missed and another received is not missing. `duplicate-cell` is recomputed across shards, per command: a `check` and an `untranslated` result for one screenshot are not duplicates, two `check` results for one cell are (`2 inputs map to locale de, screen home under check`). A file merged by catscan 0.23 or older keeps its old warnings until you merge its shards again.
- Each expectation flag given to `merge` wins for its own axis; `--expect-devices` alone keeps the shards' expected locales and screens. For an axis with no flag, the union of the shards' expected locales, screens, devices and text sizes is used (a shard with no coverage adds the devices and sizes of its inputs; once any shard has a size, a shard with none adds `default`), and shards with no coverage give `coverage: null`. Pass the flags to the merge step: a shard that never ran leaves no file, and only the flags know its locales and devices (`--expect-devices ios,android` when one job per platform runs).
- The layout is `--layout`, else the shards' common layout (shards with different layouts are exit 2, `results-layout-mismatch`).
- `run.host` and `run.ci` are `null` when the shards differ. The output does not depend on the order of the input files.
- **Thresholds:** `--min-severity` and `--min-certainty` recompute every finding's `gate`, the verdicts and `totals` from each item's stored `severity` and `certainty` (no registry lookup, so old shards are not re-banded). Without them each shard's `gate` and verdicts are kept. On `catscan report <one file>` they also drop the file's stored `baseline` block, `change` fields and `approved` stamp, which were made under the old verdicts; add `--baseline` to compare again. A finding with no `severity` (written by a catscan before severity existed) always gates, and the warning `unscaled-items` counts them ([Severity and certainty](./cli.md#severity-and-certainty)).
- Exit code: 0, 1, 3 or 4 from the merged verdicts (so the merge step gates the pipeline); 2 on a usage error; 4 when a file cannot be read or fails validation.

## Validate

`catscan results validate <file>` checks the file against the schema and its own consistency (a known-findings file is checked against its own schema: [Known findings](#known-findings)): `totals` equals the per-verdict count of `results[]`, each finding's `gate` agrees with `run.thresholds` (with a shard's, when `run.thresholds` is `null`), a failed check always gates, an entry whose findings carry `gate` and whose verdict is `fail` has a failed check or a gating finding, `results_schema` and `axes` agree with the device and text-size axes the file uses, once the file uses the device axis every mapped entry has a `device`, each `platform` is the one its `device` label gives, `coverage.missing` lists the cells (device, text size, locale, screen) of the `missing` results, `coverage.received` equals the results in an expected cell, and every `missing` result is an expected cell that nothing received. With a `baseline` block, `counts`, `review` and every envelope's `change` must agree with `baseline.cells[]`; every text record's `digest` must be the sha256 of its `tokens`. Exit 0 valid, 1 invalid (one stderr line per violation, `catscan: results-invalid: <file>#<JSON pointer>: <message>`), 2 usage error, 4 unreadable. With `--json` it prints `{ "file", "valid", "errors": [{ "pointer", "message" }] }` on stdout.

## Changed-only review

Between two releases most screens do not change. `--baseline` compares the text catscan reads in each locale x screen cell with the same cell of an approved earlier run, so a tester opens only the cells that changed, are new or fail. It compares recognized text only: images, layout, colors and icons are not compared, and an unchanged cell means "text unchanged since the baseline", never "screen unchanged".

Three commands:

```
catscan check shots --expect checks.yaml --results catscan-results.json          # 1. run, then review it
catscan results baseline catscan-results.json --out catscan-baseline.json        # 2. approve the reviewed run
catscan check shots --expect checks.yaml --results catscan-results.json --baseline catscan-baseline.json  # 3. next build
```

To try it locally: approve one run, change one string in one screenshot (or edit the image), run again with `--baseline`; exactly that cell is `changed`, with its added and removed lines in `baseline.cells[].diff`. The text output ends with `baseline 4511: 241 of 287 cells text unchanged and passing (84%), 46 to review (31 changed, 4 new, 11 failing or unread); 2 gone` before the totals line. `catscan results merge shard-*.json --baseline <file> --out <file>` and `catscan report <file> --baseline <file>` compare the same way. The HTML report (`--report`) then opens on the cells to review, with each changed cell's line diff ([`report.md`](report.md#what-the-page-shows)); `--format github` adds them to the job summary, and the MCP tool `compare_to_baseline` returns them to an agent. CI recipes that approve on a release tag and keep the baseline past artifact expiry: [`recipes/ci.md`](recipes/ci.md#changed-only-review).

- **States.** Each cell is `changed`, `unchanged`, `new` (not in the baseline), `gone` (only in the baseline; no verdict) or `ambiguous` (several inputs on either side that do not pair by their path below the layout, or no text on one side). Each envelope carries `change` (its cell's state; `null` without `--baseline` and when the input has no text).
- **What is equal.** Lines are normalized as checks are (except that the modifier letter `ʼ` stays a letter, not an apostrophe, so saved baselines keep their tokens), clock times (`9:41`, `10:05 pm`) become `#`, the `--baseline-ignore` patterns become `#`; then all words of the screen are compared as a sorted list with punctuation dropped and diacritics folded (for ja, ko, zh, yue and th, one token per line). Line order, a line split or joined by the reader, punctuation and diacritics on Latin, Greek and Cyrillic letters are reading jitter; a replaced word or digit, a currency symbol, a box glyph, a removed line, kana voicing marks, Thai tone marks and Indic virama or nukta are changes. Not compared, by design: letter case, the order of words within a line, `%`, `+` and `-` signs and decimal separators (`9.99` and `9,99` read the same), because the reader confuses them; checks and the other commands cover those. A screen whose only text is masked (a clock, or an ignore pattern that matches everything) counts as no text and needs review. A diacritic- or punctuation-only difference stays skippable and is listed in `minor_diff`.
- **Skippable.** A cell may be skipped (`review: false`) only when it is `unchanged`, every verdict in it is `pass`, both sides have recognized text, it was read by Vision accurate revision 3 (Tesseract is not measured yet: `engine-unmeasured`), no input on either side is a duplicate (`duplicate-cell`), the baseline cell was not approved incomplete (error, needs-reader, unsupported), the engine, Vision revision and macOS major version match the baseline's, the `--baseline-ignore` file is the same, and the baseline was approved. `reason` names the first rule that sends a cell to review.
- **Skip share.** `baseline.review.skip / baseline.review.denominator`: the denominator is the distinct mapped cells of this run with an input; missing cells and unmapped inputs are excluded and counted in `review.excluded`. It is not a share of LQA hours.
- **Exit code.** Unchanged. A pipeline that must stop on any change reads the file: `jq -e '.baseline.counts.changed == 0' catscan-results.json`.
- **First run.** A `--baseline` path that does not exist is the warning `baseline-missing`: every cell is `new`, nothing is skippable.
- **Approval.** `catscan results baseline` writes the file unchanged plus `approved: { "at", "from": "sha256:<digest of the file>" }`. It refuses (exit 1, one `baseline-incomplete` line per cell) error, needs-reader, unsupported, missing and ambiguous cells and mapped inputs without text, unless `--allow-incomplete`; those cells are never skippable later. A baseline that was never approved, or that changed after approval (`approved.from` no longer matches; `results validate` reports it), is compared, but every cell needs review (`baseline-unapproved`). A file compared by `results merge` or `report` drops `approved`: it is a new result, never the approved baseline. Approval is a human act: run it after reviewing the run.
- **Upgrading.** Files that have no text exit 2 as a baseline (`baseline-no-text`): approve one run from the new catscan. A new macOS, Vision revision or engine makes cells need review (`reader-changed`) until a run on that reader is approved.

`baseline` block: `{ "file", "digest", "approved", "build", "started_at", "catscan", "ignore_digest", "cells": [{ "device", "text_size", "locale", "screen", "state", "review", "reason", "inputs": [{ "path", "baseline_path", "command" }], "diff", "minor_diff", "renamed_from" }], "counts": { "changed", "unchanged", "new", "gone", "ambiguous" }, "review": { "cells", "skip", "denominator", "excluded": { "missing", "unmapped" } } }`. `diff` and `minor_diff` are `{ "added", "removed", "added_count", "removed_count" }` over normalized lines, at most 50 lines each. `renamed_from` names a gone screen of the same locale with the same text; the cell stays `new` and is reviewed. `results validate` checks `counts`, `review` and every `change` against `cells[]`, and each text digest against its tokens.

### Baselines and text records

Every envelope in a results file carries `text: { "algo": 1, "tokens", "lines", "digest": "sha256:<hex>", "ignore" }` (`ignore`: the digest of the `--baseline-ignore` file, or `null`), or `null` when nothing was read (error, needs-reader, unsupported, missing, video). `--text-record digest` keeps `algo`, `digest` and `ignore` only: equality works, but there is no line diff or rename hint. `--text-record none` omits `text`; such a file cannot be a baseline. Switching record mode or ignore file means approving a new baseline. Text records add about the size of the recognized text to the file.

**Privacy.** The baseline and every results file contain normalized screen text. Store the baseline as a CI artifact with access limited to the project and a retention period, or commit it only to a private repository; never attach it to public issues. Mask screens that show credentials or personal data with `--baseline-ignore`, or capture them with test accounts. `--text-record digest` keeps no text, at the cost of the line diff. catscan sends no results file anywhere.

## Known findings

A new check on a shipped product usually finds real legacy defects. Instead of switching the check off, approve today's findings once into a small committed file, `catscan-known.json`; later runs mark a finding that matches an approved one `known`.

```
catscan truncated shots --results catscan-results.json                    # 1. the check finds legacy findings
catscan results known catscan-results.json --out catscan-known.json       # 2. after review: approve them, commit the file
catscan truncated shots --known catscan-known.json --results catscan-results.json   # 3. CI fails only on new findings
```

`results known` ends with `approved 118 findings in 41 groups (+118 -0 this run) -> catscan-known.json (new file); next: add --known catscan-known.json to the CI command and commit the file`; the first numbers are the whole file.

- **Key.** A finding is matched by `command`, `pseudo`, its cell (`device`; `text_size`, written only when it is not `default`, so files approved before the axis match the default cells; `locale` and `screen` from the layout, else the input `path`), `kind`, `rule` (the finding registry rule: `reason`, `signal`, `evidence`, `rule`, or `field` for `price`; `null` when the kind has none) and its identity text, with a count per key. The box, confidence, severity, certainty, precision, gate, reader and catscan version are never in the key, so a finding that moves or is read with another confidence stays the same finding.
- **Identity text** (`key_algo` 1). The finding's `line`, else `token`, else `key`, else `product`; for `overlap` and `occluded`, each side's element id or text, sorted and joined by ` | `; for a `fit` finding on a textless control, its element id, or for a control without an id its place (`@x,y`: its box center in percent of the screen, rounded to a 5% grid, so two id-less icons in one cell are two findings; rows from an older catscan that keyed such controls as `null` are approved again once). Normalized: NFKC, case-folded, clock times and digit runs become `#`, punctuation is dropped, diacritics on Latin, Greek and Cyrillic letters (U+0300-U+036F after NFD) are removed, whitespace is collapsed; kana voicing, Thai tone marks and Indic signs are kept.
- **Counts.** When a key is found more often than approved, every finding with that key is new (without a box the extra one cannot be told apart). Fewer found than approved is counted `gone`.
- **Approvable.** Every finding kind except `missing`. Failed `--present`/`--absent` checks are not findings, and error, needs-reader and unsupported inputs have none.
- **Updating.** When `--out` exists it is updated, not replaced: only the command x cell groups the given results read (an input with verdict `pass` or `fail`) are rewritten, so one shard or one command can approve alone; inputs it could not read keep their rows and are counted in the summary. Inside a group, a key's count is the most any one input of the cell has. Below-threshold findings are approved too. To start over, delete the file.
- **`--prune`.** Only lowers counts to what was found and removes rows that reach 0; it never adds, and the file must exist. Run it after fixes so a fixed finding cannot come back silently.
- **Changed filters.** Re-approving a command with other filter flags or another `--allow` file than the file records warns `known-scope-differs`: the groups it re-reads lose the rows only the old filters found.
- **`--known <file>`** (`check`, `untranslated`, `truncated`, `overlap`, `formats`, `fit`, `contrast`, `results merge`, `report`). A finding that matches an approved row gets `known: true` and `gate: false`, so it never fails the input or the exit code; the exit table is unchanged. Matching is per input: when a key is found more often than approved, every finding with that key stays new and carries `known_counts: { found, approved }`. Text output prints known findings after the others as `known` lines (hidden by `--quiet`), ends a new finding line with `(new: 2 found, 1 approved in catscan-known.json)` or `(new, not in file)`, and adds `, 118 known, 1 new, 3 approved no longer found (catscan-known.json)` to the totals; with gone rows a second line says `tighten: catscan results known catscan-results.json --out catscan-known.json --prune`. A missing file warns `known-missing` and every finding is new (fail closed); an invalid one is exit 4 `known-invalid`.
- **In the results file.** A top-level `known` block: `file`, `digest` (sha256 of the known file, `null` when it was missing), `key_algo`, `counts` (`known`, `new`, `gone`) and `gone[]` (approved rows no longer found, only for the groups the run read). Each shard record keeps its `known_digest`. `results validate` refuses a finding that is `known` and gates.
- **Shards.** Pass `--known` to every shard and to `results merge` (and `report`): merge recomputes `known`, `gate` and the verdicts on each shard against its own file, so shards approved separately merge to the verdicts of one run. Without `--known` on merge, each shard's stored `known` is kept.
- **Run warnings.** A run whose filter flags, `--allow` file, device axis or text size axis differ from what the file approved warns `known-scope-differs` (one warning per axis; across the text size axis only the `default` cells match); another engine, Vision revision or macOS major warns `known-reader-changed` once. A new and a gone row in one cell, kind and rule print a `known-drift` note with the `results known` command to re-approve after review.
- **Exit codes.** 0 written; 2 usage error, a known file given as input, or a file with a newer `known_schema` or `key_algo` (`known-algo-unsupported`); 4 an input cannot be read, the existing `--out` is invalid (`known-invalid`) or cannot be written (`known-write-failed`, written through a temporary file and renamed).

The file:

```json
{
  "known_schema": 1,
  "key_algo": 1,
  "catscan": "1.0.0",
  "axes": [],
  "reader": { "engine": "vision-accurate-rev3", "vision_revision": 3, "macos": "15" },
  "scope": { "truncated": { "flags": ["--reasons ellipsis,overflow"], "allow": null } },
  "findings": [
    {"command":"truncated","pseudo":false,"device":null,"locale":"de","screen":"shop","path":null,"kind":"truncated","rule":"ellipsis","text":"jetzt kaufen","count":2}
  ]
}
```

Rows are sorted by every field, one per line, with no timestamp, so the diff of a re-approval shows exactly the added, removed and recounted findings: the pull request that changes the file is the approval record. Review it like code (a CODEOWNERS line for it is a good idea). `scope` records, per command, the approving run's flags that decide which findings exist (`--reasons`, `--kinds`, `--rules`, `--min-overlap`, `--level`, `--scale`, `--device-profile`, `--orientation`, and whether `--experimental`, `--pseudo`, `--uncatalogued`, `--boxes`, `--prices` or `--allow` was given) and the sha256 of its `--allow` file, which the run records as `run.allow` in its results file (`results known` never opens a path named in a results file; files from before have `null`); `reader` the approving engine, Vision revision and macOS major (`null` when mixed); `axes` the cell axes the rows use. `catscan results validate catscan-known.json` checks the schema (`core/schema/known.schema.json`), the row order and that no key repeats.

**Privacy.** The file holds normalized finding text only: no screenshots, no text records, no hosts. The same caution as for results files applies to public repositories.

## Example per command

Each command writes the same file; only its envelopes differ ([docs/cli.md](./cli.md#the-json-envelope)):

- `check`: `checks[]` holds each `--present`/`--absent` check with its verdict, box and closest line.
- `read`: every result has `lines[]`, the recognized text with boxes; `checks[]` is empty.
- `truncated`, `untranslated`: `findings[]` holds each cut-off line or untranslated string.
- `video`: one result per video with `frames` and per-check `first_seen`/`last_seen`; frame lines stay on stdout.
