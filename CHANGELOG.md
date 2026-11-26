# Changelog

All notable changes to catscan, newest first. catscan was developed privately before its first public version; earlier versions are not listed.

## [1.0.0] - 2026-11-26

The first public release. From this version on, catscan follows semantic versioning. A breaking change to the CLI, its exit codes and JSON output, the results schema, the MCP tools or the library API comes only in a new major version.

### Added
- `@catscan/cli`: checks the text on app and game screenshots with Apple's Vision framework on the Neural Engine, on your Mac, and returns `PASS` or `FAIL`, an exit code for CI and `--json` for agents. Apple silicon, macOS 15 or later, Node 22 or later; the binary is signed and notarized.
- Checks: `check --present / --absent` with keys from JSON, `.strings`, `.xcstrings`, `strings.xml`, TypeScript and JavaScript catalogs; `untranslated` (untranslated strings, raw keys, unfilled placeholders, wrong language); `truncated` (ellipsis, clipped by view or screen edge, short of its catalog string, drawn past its element); `overlap` (text over text, over icons and controls, stacked screens); `formats` (numbers, dates, prices and store currencies); `contrast`; `pseudo` and `--pseudo`; `--text-size` for large system text; `video` for text in recordings. `fit` and busy-image contrast are experimental.
- Runs: coverage with `--expect-locales`, `--expect-screens` and `--expect-devices`; changed-only review with `--baseline`; `--known` to fail only on new findings; `results merge` for sharded runs; `boxes` for element boxes from UI tests; an offline HTML report with a locale x screen matrix.
- Readers: Vision first, Tesseract for the languages Vision cannot read when it is installed, and the agent's own model when catscan cannot decide; every result names its reader.
- `@catscan/playwright` matchers (`toShowText`, `toHaveNoTruncation`, `toHaveNoOverlap`, `toHaveNoUntranslated`), the `@catscan/mcp` server for coding agents, `@catscan/core-js` for Node, and the `catscan` agent plugin with the `screen-check`, `catscan-adopt`, `catscan-upgrade` and `test-speedup` skills.
- `catscan doctor` checks the install and says when a newer version is out; the check is off with `--offline`, `CATSCAN_NO_UPDATE_CHECK=1` or in CI.
