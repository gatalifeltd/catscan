# Surfaces: which catscan fits a point

`<v>` is the `version` find-catscan printed. Diffs name the published packages pinned to `<v>`. When
`npm view @catscan/cli@<v> version` finds no such release, the plan's setup steps run the same from the checkout: replace
`npx @catscan/cli@<v>` with the `command` find-catscan printed, and install packages with
`npm install --no-save <checkout>/packages/<name>` (plain `-D` would rewrite the pin in package.json).
Never put that path in a diff.

| Point | Surface | Needs |
| --- | --- | --- |
| Screenshots in a folder after a run (any runner) | CLI step | nothing new |
| Playwright test that draws canvas or DOM text | Playwright matcher | `@catscan/playwright`, `@playwright/test` >= 1.50 |
| Maestro flows with `takeScreenshot` | Maestro recipe | Maestro, a simulator or emulator |
| The suite runs in CI on a Mac runner | CI step | a macOS arm64 runner |
| An agent opens screenshots to check text | MCP and instruction file | the agent's MCP config |

## CLI step (after a run, with expectations)

Add a script next to the one that takes the shots, and an expect file per locale:

```json
"test:screens": "npx @catscan/cli@<v> check shots --expect checks/en.yaml --results catscan-results.json"
```

```yaml
locale: en
shots:
  home.png: { present: ["Play"] }
```

Keys are paths relative to the folder argument, so one expect file shared by every locale folder matches
nothing: a run that prints `no-checks` or `expect-key-unmatched` checked nothing, whatever its exit code.
Fix the keys (one expect file per locale, or a run per locale folder) before you trust a pass, and add
`--fail-on-skip` to `check` so a skipped check fails (`video` and `fit` take it too; the other finding commands do not). `--results` and `--report` need their folder to exist: put
`mkdir -p` in the same script line. To pick expected text, run `check <shots> --all-keys --catalog <catalog>`
on shots the suite already took (in a scratch copy): it lists which catalog strings each shot shows, and
a near miss there (a quote or accent read differently) stays out of the expectations. Per-locale folders (`shots/<locale>/`): one expect file
per locale, or `--layout {locale}/{screen}` with `--expect-locales-from <dir>` (or `--expect-locales <list>` when that
folder holds other JSON files). Add `untranslated` with
`--base <base catalog> --catalog <locale catalog>` when the project has catalogs, and `truncated` when it
can give element boxes. Delete the shot folder before the capture run, so stale images never pass. A wrapper that
collects shots takes every image format the producer writes (`*.png`, `*.jpg`, `*.jpeg`: catscan reads each), so a JPEG
store shot is checked, not skipped.

No expected strings (the tests assert by test ID in every language): use the finding commands, which need
none; `checks.json` lists them all, each with the inputs it needs (`checks.md`). The default groups go in this
step; experimental groups (`experimental: true`) only in their own opt-in step (`checks.md`). Run each command
the point gets with its own `--results` file, then `results merge --out <merged.json>` the default ones and `catscan report <merged.json> --out <report.html>`
for one report (`results merge` writes no report). `truncated --reasons ellipsis,screen-edge` for cut text, `untranslated --languages <app languages>`
for text in the wrong language in one run across every locale folder (`--kinds raw-key,placeholder` without
catalogs; a `{locale}` catalog template needs `--locale`, so one run per locale). A shared per-locale wrapper (one script that loops the
locales) skips a locale with no shots with a warning line naming it and goes on, and exits 4 when no locale has
shots: a run narrowed to one point still reaches its check, and an empty run never passes. Locale coverage stays
with the `--expect-locales*` flags of the full run. Or give each point its own script. A locale token at the start or end of
the file name (`ru-streak.png`, `home-pt-BR.png`) fits `--layout '{locale}-{screen}'` or `'{screen}-{locale}'`. An untagged base locale in a flat folder, only when the same screen also exists with a locale tag there (`x.png` beside `x-ru.png`): the tagged files take
`--layout '{screen}-{locale}'`, and the base locale runs with `--layout none --locale <base>` on the files that carry
no other locale's token (`find shots -maxdepth 1 -name '*.png' ! -name '*-ru.png' ! -name '*-de.png'`, one
`! -name` per other locale). Shot names that fit
no pattern (a locale in the middle of the name): run once per locale with `--layout none --locale <L>` on that
locale's files, or propose renaming the shots as its own diff.

## Playwright matcher

```ts
import { test } from "@playwright/test";
import { expect } from "@catscan/playwright";

test("menu", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("canvas")).toShowText(["Play"], { readyText: "Play" });
});
```

The matchers are `toShowText`, `toHaveNoTruncation`, `toHaveNoOverlap` and `toHaveNoUntranslated`. Checks with no
matcher (`formats`, `fit`, `contrast`) get a CLI step on the folder the matchers save, when the installed
`@catscan/playwright` has the `saveDir` option (its `index.d.ts` names it). The project sets
`catscanMatchers({ saveDir })` or `CATSCAN_SAVE_DIR=test-results/catscan` (inside Playwright's `outputDir`,
which each run clears, so no stale shot survives), and after `npx playwright test`:

```sh
npx @catscan/cli@<v> formats test-results/catscan
npx @catscan/cli@<v> fit test-results/catscan --boxes test-results/catscan --reasons wrapped
npx @catscan/cli@<v> contrast test-results/catscan --boxes test-results/catscan --experimental
```

All three read the default layout; the matchers write the boxes beside each shot. With a package that has
no `saveDir`, those checks get the CLI step only on screenshots the spec saves itself.

Keep the project's own `expect` for its other asserts: import the catscan one under another name
(`import { expect as screen } from "@catscan/playwright"`) when the spec already imports Playwright's.
The matcher reads in the browser's locale; when the app picks its language another way (a URL
parameter, a stored setting), pass `{ locale }` or the reader drops accents (`Plätze` reads `Platze`).
Check the whole `page` unless other text on it gets in the way: a small locator crop reads worse.
For a project-wide catalog use `catscanMatchers({ catalog })` in a fixtures file. Add the dependency to
`devDependencies` pinned to `<v>`. Every Chromium project the change touches must launch with
`--use-angle=metal` on macOS; add it in the same diff when it is missing.

## Maestro recipe

Shots named `shots/${PLATFORM}/<screen>.${LOCALE}` from one-line `takeScreenshot` steps. After the
flows, one step per locale:

```sh
npx @catscan/cli@<v> check shots/ios --layout "{screen}.{locale}" --expect "checks/$L.yaml" --results "out/ios-check-$L.json"
```

Per flow, `run-with-catscan.sh` from the catscan Maestro recipe (`docs/recipes/maestro.md` in the
catscan repository) runs the flow and then catscan on its shots. A flow whose shots use another naming
needs its `takeScreenshot` lines renamed; propose that as its own diff.

Boxes for `overlap`, `fit` and `truncated` (`edge`, `overflow`) come from a view-hierarchy dump per screen:
propose the step whenever a point is a Maestro flow. Per screen that needs boxes, a flow that ends on it
(tagged `boxes`, so the screenshot run passes `--exclude-tags boxes`), then, after `maestro test` has exited
(a second Maestro process started while a flow runs kills that flow):

```sh
maestro --udid "$MAESTRO_UDID" hierarchy > "shots/ios/<screen>.$L.maestro.json"
npx @catscan/cli@<v> boxes maestro "shots/ios/<screen>.$L.maestro.json" > "shots/ios/<screen>.$L.boxes.json"
```

The checks then take `--boxes shots/ios`, which reads `<screen>.<locale>.boxes.json` by base name. The
converter also reads React Native and Flutter dumps.

## CI step

On a macOS arm64 runner after the test step: `npx @catscan/cli@<v> doctor`, then the same CLI line with
`--format github --junit catscan.xml --known catscan-known.json` (GitLab CI: `--gitlab-codequality catscan-cq.json`, declared under `artifacts: reports: codequality:`,
instead of `--format github`; `--build <id> --build-version <version>` name the build). `--known` goes on every
`check` and finding-command line, each shard, `results merge` and `report` (`read` and `video` reject it). Then, in a
step that runs even when the check failed (`if: always()`, `when: always`), when the results file exists (a usage error writes none), the same CLI's `results validate <results
file>` and, once it exists, `results validate catscan-known.json`. Upload `catscan*` as an artifact with a short retention (the
report holds the screenshots and their text). CI changes are proposed, never applied unasked (iron rule 6).

**Legacy findings gate through the known file.** Never switch a check off or loosen it for real old defects. After
the developer reviews the first run's findings, propose as its own batch `npx @catscan/cli@<v> results known
<results file> --out catscan-known.json` and committing that file; never run it unasked. CI then fails only on
findings the file does not hold; a missing file warns `known-missing` and every finding gates, so the CI diff can land
first. After fixes, propose the same command with `--prune` as its own batch: it lowers counts, never adds rows, needs
the file. Keep the check run's filter flags and `--allow` file unchanged between approvals, or `known-scope-differs` warns.

**Optional, never a gate:** when the project reviews screenshots by hand, `--baseline catscan-baseline.json` marks the
screens whose text changed since an approved run (the developer approves it with `results baseline <results file>
--out catscan-baseline.json`), so a reviewer opens only those; it never changes the exit code.

## MCP and instruction file

When an agent file says to open screenshots, propose the catscan MCP server for that agent and the
screen-check instruction block (`examples/agents/` in the catscan repository) in the agent file. The
agent then calls `check_text` instead of opening the image.
