# Recipe: Tesseract for languages Vision cannot read

catscan's verdicts, catalogs, coverage matrix and CI reports do not depend on one OCR engine. The text itself comes from a reader: Apple Vision on the Neural Engine by default, and [Tesseract](https://github.com/tesseract-ocr/tesseract) for the languages Vision cannot read or misreads (22; `catscan languages` lists them). This page is for projects that ship one of them.

## Why

Vision does not read Greek, Hebrew, Bulgarian, Serbian, Hungarian, Persian, Georgian or Armenian (`el`, `he`, `bg`, `sr`, `hu`, `fa`, `ka`, `hy`), and it drops letters of Croatian, Slovak, Slovenian, Lithuanian, Latvian, Estonian, Maltese, Irish, Icelandic, Macedonian, Bosnian, Belarusian, Welsh and Albanian (`hr`, `sk`, `sl`, `lt`, `lv`, `et`, `mt`, `ga`, `is`, `mk`, `bs`, `be`, `cy`, `sq`: `š` read as `s`, a false missing-text finding). For these locales catscan hands the screen to Tesseract when it is installed. Without it, or without the locale's language data, every check on such a screen is `needs-reader` (exit 3) and the hint names the install command for the setup catscan found. Every other locale always uses Vision, whether Tesseract is installed or not.

`catscan video` has no Tesseract fallback, so these locales are checked on screenshots only. Plain `catscan overlap` checks stacked text on Vision reads only: on a Tesseract locale it reports `unsupported` with `overlap-unchecked` (exit 3); pass `--boxes` to check text over text and over icons from element boxes.

catscan does not bundle or download Tesseract. It looks for it in this order: `CATSCAN_TESSERACT=<path>` when set (the only candidate then), `PATH`, `/opt/homebrew/bin`.

## Install everything (about 650 MB)

```bash
brew install tesseract tesseract-lang
catscan doctor
```

`tesseract-lang` holds the language data for about 160 languages, about 650 MB. It is the simplest setup for a developer Mac.

## Install only your locales (a few MB)

`brew install tesseract` alone brings the engine and English (about 32 MB with leptonica). catscan runs Tesseract as `-l <pack>+eng`, so a data directory needs `eng` plus the pack of each locale you ship:

| Locale | Pack file | Size |
| --- | --- | --- |
| `el` | `script/Greek.traineddata` | 3.0 MB |
| `he` | `heb.traineddata` | 1.0 MB |
| `bg` | `bul.traineddata` | 1.7 MB |
| `sr` | `srp.traineddata` and `srp_latn.traineddata` (`sr-Cyrl`: `srp` only, `sr-Latn`: `srp_latn` only) | 2.1 + 3.3 MB |
| `hu` | `hun.traineddata` | 5.3 MB |
| `fa` | `fas.traineddata` | 0.4 MB |
| `ka` | `kat.traineddata` | 2.5 MB |
| `hy` | `hye.traineddata` | 3.5 MB |
| `hr` | `hrv.traineddata` | 4.1 MB |
| `sk` | `slk.traineddata` | 4.4 MB |
| `sl` | `slv.traineddata` | 3.0 MB |
| `lt` | `lit.traineddata` | 3.2 MB |
| `lv` | `lav.traineddata` | 2.7 MB |
| `et` | `est.traineddata` | 4.5 MB |
| `mt` | `mlt.traineddata` | 2.3 MB |
| `ga` | `gle.traineddata` | 1.2 MB |
| `is` | `isl.traineddata` | 2.3 MB |
| `mk` | `mkd.traineddata` | 1.6 MB |
| `bs` | `bos.traineddata` | 2.5 MB |
| `be` | `bel.traineddata` | 3.7 MB |
| `cy` | `cym.traineddata` | 2.2 MB |
| `sq` | `sqi.traineddata` | 1.9 MB |

The files come from [`tessdata_fast`](https://github.com/tesseract-ocr/tessdata_fast) tag `4.1.0` (commit `65727574dfcd`), the same files `tesseract-lang` installs. The URLs below name the commit, not the tag, so a moved tag cannot change what you download. Example for Hebrew and Greek:

```bash
brew install tesseract
export TESSDATA_PREFIX="$HOME/.tessdata"
mkdir -p "$TESSDATA_PREFIX/script"
cp "$(brew --prefix tesseract)/share/tessdata/eng.traineddata" "$TESSDATA_PREFIX/"
base=https://github.com/tesseract-ocr/tessdata_fast/raw/65727574dfcd264acbb0c3e07860e4e9e9b22185  # tag 4.1.0
curl -fsSLo "$TESSDATA_PREFIX/heb.traineddata" "$base/heb.traineddata"
curl -fsSLo "$TESSDATA_PREFIX/script/Greek.traineddata" "$base/script/Greek.traineddata"
catscan doctor
```

- `script/Greek` keeps its `script/` folder.
- `TESSDATA_PREFIX` must be set wherever catscan runs (shell profile, CI job env); catscan passes it to Tesseract. With it set, Tesseract looks only in that directory.
- A directory without `eng.traineddata` gets `fallback-pack-missing` with the hint `add eng.traineddata to <dir>`.
- A missing locale pack gets `fallback-pack-missing` naming the pack and the directory, with the hint `brew install tesseract-lang`. With `TESSDATA_PREFIX` set, that install does not reach your directory: download the named pack into it instead.

## Check the setup

`catscan doctor` prints the Tesseract path, version, data directory and, per fallback locale, whether its packs are installed and what to install when not. `catscan doctor --json` has the same in `fallback` (`path`, `version`, `tessdata`, `locales[]` with `locale`, `installed`, `missing`).

A check on a Tesseract locale carries `"engine": "tesseract-<version>"` and the warning `fallback-engine`, so a result always says which reader produced it.

## CI

Install on the macOS job only when the project ships one of the 22 languages in the table above (23 locales with `sr-Latn`). Each example in [`examples/ci/`](../../examples/ci/) has the install step commented out and a `catscan doctor --expect-locales-from locales` preflight that fails the job with the install command until you uncomment it.

- **Simplest:** `brew install tesseract tesseract-lang` (about 650 MB on each run).
- **Faster:** `brew install tesseract` and a cached `TESSDATA_PREFIX` directory with only your packs. On GitHub Actions:

```yaml
    env:
      TESSDATA_PREFIX: ${{ github.workspace }}/.tessdata
    steps:
      # ... checkout and setup-node as in examples/ci/github-actions.yml
      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with: { path: .tessdata, key: tessdata-fast-4.1.0-heb-Greek }
      - run: |
          brew install tesseract
          base=https://github.com/tesseract-ocr/tessdata_fast/raw/65727574dfcd264acbb0c3e07860e4e9e9b22185  # tag 4.1.0
          mkdir -p .tessdata/script
          cp "$(brew --prefix tesseract)/share/tessdata/eng.traineddata" .tessdata/
          [ -f .tessdata/heb.traineddata ] || curl -fsSLo .tessdata/heb.traineddata "$base/heb.traineddata"
          [ -f .tessdata/script/Greek.traineddata ] || curl -fsSLo .tessdata/script/Greek.traineddata "$base/script/Greek.traineddata"
```

Then fail fast, before any screenshot is checked: `doctor` takes the check's own locale options, reads a rendered word in each Tesseract locale, and exits 1 with the install command when one has no working reader:

```bash
catscan doctor --expect-locales-from locales
catscan check shots --expect checks.yaml --expect-locales-from locales
```

`--expect-locales he,el` lists them instead (a sharded job passes its shard's locales). It also exits 1 when the catscan binary could not run, or when a catalog's locale cannot be told. Without the preflight, the check itself reports such a locale as `needs-reader` (exit 3) with the same install command.

## Version

Tested with Tesseract 5.5.4 (Homebrew, leptonica 1.87.0, `tesseract-lang` 4.1.0); the published numbers below use it. Other 5.x versions are expected to work but are not measured. `catscan doctor` prints the version in use.

## License

Tesseract and its language data are Apache 2.0. catscan does not redistribute them: you install them, and catscan runs the `tesseract` it finds as a separate process.

## Quality

Tesseract is weaker and slower than Vision. On the feasibility study's real screenshots (474 app and game screenshots, 8 locales; [`BENCHMARKS.md`](../BENCHMARKS.md#real-screenshots)):

| | Vision | Tesseract |
| --- | --- | --- |
| Line recall, pooled | 98.50% | 74.23% |
| Median ms per full-resolution phone screenshot, idle | 58 | about 230 |
| Energy per screenshot above idle | about 0.3 J (Neural Engine) | about 1.1 J (CPU) |

On catscan's own benchmark the fallback checks pass at a 99.27% median, with Persian lowest at 84.31% ([README benchmarks](../../README.md#benchmarks), [`BENCHMARKS.md`](../BENCHMARKS.md#tesseract-fallback)). Expect more failed checks on dense, small or stylized text in these languages than in the others. When a check on a Tesseract locale fails and the `closest` line looks garbled, the reader is the likely cause: look at the image (see [When catscan cannot decide](../../README.md#when-catscan-cannot-decide)).
