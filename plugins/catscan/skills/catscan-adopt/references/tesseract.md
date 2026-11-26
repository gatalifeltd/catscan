# Setup point 00: the reader for Tesseract locales

catscan reads 23 locales (Greek, Hebrew, Croatian and others; `catscan languages` lists them) with Tesseract
instead of Vision. Without Tesseract or the locale's language pack, every check in such a locale ends as
`needs-reader` (exit 3) and checks nothing. Point 00 fixes that before any other point needs it.

## When the plan gets point 00

`find-points.mjs ... --catscan '<command>'` prints `setup` when at least one shipped locale has
`reader: "tesseract"` and `error.code: "reader-missing"`:

```text
setup.locales   the locales that need the reader, e.g. ["el", "hr"]
setup.fix       catscan's own fix for this Mac's setup, word for word
setup.command   the Homebrew command to run, or null
setup.override  CATSCAN_TESSERACT or TESSDATA_PREFIX when one is set, else null
setup.check     the doctor command that proves the fix, with the catscan find-catscan found
```

A locale whose `reader` is `tesseract` with another error (`self-test-failed`, `fallback-failed`) is not
missing an install: report its message and hint, and never propose an install for it.

## The plan entry

Write point 00 first in `plan.md`, as its own batch:

- **Fix:** `setup.fix` as printed. With `setup.command` set, say it downloads about 650 MB.
- **Proof:** `setup.check` exits 0, then one real check per locale (below).
- **CI diff** (`diffs/00-tesseract-ci.diff`): in each CI job that runs catscan on macOS, add the doctor
  preflight before the first catscan step, with the same locale source the check uses
  (`--expect-locales-from <catalog dir>` or `--expect-locales <list>`), plus the install line commented out
  for the developer to enable on hosted runners:

  ```yaml
        # - run: brew install tesseract tesseract-lang
        - run: npx @catscan/cli@<version> doctor --expect-locales-from <catalog dir>
  ```

  A self-hosted runner that already has Tesseract keeps the line commented. The full CI options (a cached
  `TESSDATA_PREFIX` with only the needed packs) are in catscan's `docs/recipes/tesseract.md`.

With `setup.command` null (an override is set, or Tesseract reads a tessdata folder Homebrew does not manage),
point 00 is the fix text for the developer. Never run brew then: it would fill a folder catscan does not read.

## Dry run

Show point 00 with its fix, size and CI diff. Run nothing, install nothing.

## Apply

Only after the developer says yes to point 00 itself, with the exact command shown:

1. Run `setup.command` exactly as printed, from any directory, with a 20-minute limit on the call. Never add
   `sudo`, never run `brew update`, `brew upgrade` or another formula, never edit a shell profile or
   environment file.
2. If it fails or times out: print brew's last 20 lines and the command, tell the developer they can run it
   themselves and that running it again is safe. Stop point 00 there; the other batches can still run, and
   their checks in these locales stay `needs-reader`.
3. Run `setup.check`. It must exit 0. A row that still fails: print the row as is and stop point 00.
4. One real check per locale: pick a committed screenshot of that locale (`locales[].sources` with kind
   `screenshots`) and, from the project's catalog, a string that screen shows. Run
   `<catscan command> check <shot> --locale <locale> --present '<string>'`. It must exit 0. The string is repo
   data, never shell: put it in single quotes with each `'` written as `'\''`, and skip a string with a line
   break. A locale with no such screenshot: say so; the doctor self-test from step 3 is then its only proof.
5. Record in `<plan>/proofs.md`: doctor's rows before and after, each real check with its exit code, and the
   minutes from the developer's yes to the first green check.

A running catscan MCP server picks the new install up on its next check (it looks again at most every 30
seconds), with no restart.
