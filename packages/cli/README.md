# @catscan/cli

The catscan command line: checks the text in app and game screenshots, web pages and screen recordings with Apple Vision on the Neural Engine, and returns PASS/FAIL verdicts instead of raw OCR. It catches truncated and overlapping text, missing strings and raw keys, untranslated and wrong-language text, and wrong number, date and price formats. It runs on Apple silicon Macs, locally or in CI, and screenshots never leave the machine that runs it.

## Requirements

Apple silicon Mac, macOS 15 or later, Node 22 or later: your own Mac or a macOS CI runner (GitHub's `macos-15` and `macos-26` work). npm installs the signed catscan binary with the package.

## Install

```bash
npm install --save-dev @catscan/cli
npx -p @catscan/cli catscan doctor
```

## First run

Take a screenshot with Cmd+Shift+4. Type `npx -p @catscan/cli catscan read `, drag the screenshot into the terminal (it pastes the quoted path) and press Return. Then check a word it printed:

```bash
npx -p @catscan/cli catscan check <dragged path> --present "<a word you saw>"
```

`PASS` and exit 0 mean catscan read it. Then point it at a folder of per-locale screenshots:

```bash
npx -p @catscan/cli catscan untranslated shots/de --locale de --base locales/en.json --catalog locales/de.json
npx -p @catscan/cli catscan truncated shots/de --locale de --boxes shots/de --report catscan-report.html
```

Exit 1 means a check failed or a finding gates the build, so the same commands work as a CI step.

Writing Playwright tests? Install [`@catscan/playwright`](https://www.npmjs.com/package/@catscan/playwright) instead. Coding agents use [`@catscan/mcp`](https://www.npmjs.com/package/@catscan/mcp).

## Commands

`check`, `read`, `untranslated`, `truncated`, `overlap`, `formats`, `fit`, `contrast`, `video`, `pseudo`, `boxes`, `results`, `report`, `languages` and `doctor`. CI output: `--format github`, `--junit`, `--gitlab-codequality` and an offline HTML report.

## Learn more

- [catscan on GitHub](https://github.com/gatalifeltd/catscan/blob/main/README.md)
- [CLI reference](https://github.com/gatalifeltd/catscan/blob/main/docs/cli.md)
- [CI recipes](https://github.com/gatalifeltd/catscan/blob/main/docs/recipes/ci.md) and ready-to-copy [CI files](https://github.com/gatalifeltd/catscan/tree/main/examples/ci)
- [Start here: the recipe for your stack](https://github.com/gatalifeltd/catscan/blob/main/docs/start-here.md)

## License

Apache-2.0: [LICENSE](https://github.com/gatalifeltd/catscan/blob/main/LICENSE).
