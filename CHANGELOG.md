# Changelog

All notable changes to catscan, newest first. catscan was developed privately before its first public version; earlier versions are not listed.

## [1.0.4] - 2026-11-27

### Docs
- Every npm package has a README on its npm page: what the package is, how to install it, a minimal working example, the requirements and links to the full docs. `@catscan/cli-darwin-arm64` says it is installed by the other packages and is not meant to be installed directly.
- Each npm package's description says what the package does; those of `@catscan/cli`, `@catscan/mcp` and `@catscan/playwright` also say they run on Apple silicon Macs, locally or on macOS CI runners. The keywords add the repository topics that apply to each package, so the packages show up in npm search for UI, text and localization testing, screenshot testing, Playwright, MCP and coding agents.

## [1.0.3] - 2026-11-27

### Docs
- The README opens with what catscan checks (truncated and overlapping text, missing strings and raw keys, untranslated and wrong-language text, number, date and price formats), where it runs (locally on Apple silicon Macs, screenshots never leave the machine) and how Playwright tests and mobile test tools use it.
- The README "Works with" entry for Playwright names what the matchers check in browser-rendered text, Canvas and WebGL included: missing text, truncation, overlap and untranslated strings.

### Changed
- The repository's CI runs the full test suite on every macOS and Node line catscan supports (macOS 15 and 26, Node 22 and 26), and every release passes it before its packages are published to npm.

## [1.0.2] - 2026-11-26

### Fixed
- `@catscan/playwright`: an error message that holds a very long run of dots followed by other text no longer stalls the test run while catscan formats it; trailing dots are now trimmed in linear time.
- Release tooling: a malformed `VERSION` file is reported as a problem instead of crashing the version bump.
- Benchmark scripts escape locale names, heredoc words and Android string backslashes correctly.

## [1.0.1] - 2026-11-26

### Docs
- The README opens with a "Works with" section: Playwright, Maestro, XCUITest, UIAutomator and Espresso element dumps, screenshots from any tool, the ready CI files and the coding agents catscan supports.
- CONTRIBUTING says pull requests are turned off and issues are the way to report bugs, wrong OCR and feature requests.

### Fixed
- The repository's own unit tests run green from a fresh clone: two helper scripts the Maestro end-to-end and package smoke scripts import now ship with them, and tests that need maintainer-only files skip outside the maintainers' checkout.

## [1.0.0] - 2026-11-26

The first public release. From this version on, catscan follows semantic versioning. A breaking change to the CLI, its exit codes and JSON output, the results schema, the MCP tools or the library API comes only in a new major version.

### Added
- `@catscan/cli`: checks the text on app and game screenshots with Apple's Vision framework on the Neural Engine, on your Mac, and returns `PASS` or `FAIL`, an exit code for CI and `--json` for agents. Apple silicon, macOS 15 or later, Node 22 or later; the binary is signed and notarized.
- Checks: `check --present / --absent` with keys from JSON, `.strings`, `.xcstrings`, `strings.xml`, TypeScript and JavaScript catalogs; `untranslated` (untranslated strings, raw keys, unfilled placeholders, wrong language); `truncated` (ellipsis, clipped by view or screen edge, short of its catalog string, drawn past its element); `overlap` (text over text, over icons and controls, stacked screens); `formats` (numbers, dates, prices and store currencies); `contrast`; `pseudo` and `--pseudo`; `--text-size` for large system text; `video` for text in recordings. `fit` and busy-image contrast are experimental.
- Runs: coverage with `--expect-locales`, `--expect-screens` and `--expect-devices`; changed-only review with `--baseline`; `--known` to fail only on new findings; `results merge` for sharded runs; `boxes` for element boxes from UI tests; an offline HTML report with a locale x screen matrix.
- Readers: Vision first, Tesseract for the languages Vision cannot read when it is installed, and the agent's own model when catscan cannot decide; every result names its reader.
- `@catscan/playwright` matchers (`toShowText`, `toHaveNoTruncation`, `toHaveNoOverlap`, `toHaveNoUntranslated`), the `@catscan/mcp` server for coding agents, `@catscan/core-js` for Node, and the `catscan` agent plugin with the `screen-check`, `catscan-adopt`, `catscan-upgrade` and `test-speedup` skills.
- `catscan doctor` checks the install and says when a newer version is out; the check is off with `--offline`, `CATSCAN_NO_UPDATE_CHECK=1` or in CI.
