// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// The catscan command line: parse, run through `serve`, render, compute the exit code.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const args = require("./args");
const expectFile = require("./expect");
const catalog = require("./catalog");
const untranslated = require("./untranslated");
const formats = require("./formats");
const truncated = require("./truncated");
const fit = require("./fit");
const contrast = require("./contrast");
const deviceProfiles = require("./device-profiles");
const pseudoField = require("./pseudo-field");
const boxes = require("./boxes");
const inputs = require("./inputs");
const client = require("./client");
const doctorReport = require("./doctor");
const render = require("./render");
const results = require("./results");
const ci = require("./ci");
const report = require("./report");
const baseline = require("./baseline");
const pseudo = require("./pseudo");
const scale = require("./scale");
const known = require("./known");
const { version } = require("../package.json");
// The serve line limit (Serve.maxLine is 64 MB) less 1 MB for the rest of the request.
const SERVE_LINE_BUDGET = 63 * 1024 * 1024;

const SHORT_USAGE = `usage: catscan <command> <path...> [options]

  catscan check shots/de --present "Weiter" --locale de
  catscan read shot.png --json
  catscan untranslated shots/de --locale de --base locales/en.json --catalog locales/de.json
  catscan video take.mp4 --present "GAME OVER" --absent "KEY_" --json
  catscan truncated shots/de --locale de --boxes shots/de
  catscan overlap shots/de --locale de --boxes shots/de
  catscan fit shots/de --boxes shots/de --experimental
  catscan contrast shots/de --locale de --experimental
  catscan boxes xcuitest shop.xcui.txt > shop.boxes.json
  catscan pseudo locales/en.json
  catscan doctor

Commands: check, read, untranslated, video, truncated, overlap, formats, fit, contrast, boxes, languages, doctor, serve, results, report, pseudo. Run catscan --help for every option.`;

const HELP = `catscan ${version}: on-device text checks for app and game screenshots (macOS, Apple Vision)

Usage:
  catscan check <path...> [--present <text>]... [--absent <text>]... [--expect <file>] [--locale <code>] [--fallback tesseract|none]
  catscan check <path...> --catalog <file>... [--present @<key>]... [--absent @<key>]... [--all-keys] [--fail-on-skip]
  catscan read  <path...> [--locale <code>] [--fallback tesseract|none]
  catscan untranslated <path...> [--locale <code>] [--base <file> --catalog <file>...] [--base-locale <code>] [--allow <file>]
                 [--kinds <list>]
  catscan untranslated <path...> --pseudo --catalog <base> [--dynamic <file>] [--boxes <file|dir>] [--kinds <list>]
  catscan video <file...> [--every <s>] [--from <s>] [--to <s>] [--present <text>]... [--absent <text>]... [--expect <file>] [--fail-on-skip] [--json [--frames]]
  catscan truncated <path...> [--boxes <file|dir>] [--catalog <file>]... [--reasons <list>] [--allow <file>] [--locale <code>] [--pseudo]
  catscan overlap <path...> --boxes <file|dir> [--allow <file>] [--min-overlap <share>] [--locale <code>] [--experimental]
  catscan overlap <path...> --experimental [--min-overlap <share>] [--locale <code>]
  catscan formats <path...> [--locale <code>] [--storefront <region> | --currency <ISO>] [--prices <file>] [--rules <list>]
                 [--allow <file>]
  catscan fit <path...> [--device-profile <id|file>] [--orientation portrait|landscape-left|landscape-right]
                 [--boxes <file|dir>] [--reasons <list>] [--allow <file>] [--fail-on-skip] [--experimental]
                 [--layout <pattern>] [--base-locale <code>] [--catalog <template>]...
  catscan fit --list-devices [--json]
  catscan contrast <path...> [--level AA|AAA] [--scale <n>] [--kinds <list>] [--boxes <file|dir>] [--allow <file>]
                 [--locale <code>] --experimental
  catscan boxes <source> <dump> [--image <png>]
  catscan results merge <file.json...> --out <file.json> [--layout <pattern>] [expectation options] [thresholds]
  catscan results validate <file.json> [--json]
  catscan results baseline <results.json> --out <baseline.json> [--allow-incomplete]
  catscan results known <results.json...> --out <known.json> [--prune]
  catscan report <results.json...> [--out <file.html>] [--images-root <dir>] [--layout <pattern>] [expectation options]
                 [--report-images embed|link] [--report-max-edge <px>] [thresholds]
  catscan pseudo <catalog> [--out <path>] [--locale <tag>] [--expand <percent>] [--variant accent|rtl|tall] [--in-place] [--force] [--json]
  catscan languages [--json]
  catscan doctor [--json] [--offline] [--expect-locales <list> | --expect-locales-from <dir>]
  catscan serve
  catscan --version

<path> is an image (PNG, JPEG, HEIC), a folder (searched recursively), or - for one image on stdin.

For video, <file> is an MP4 or MOV, or a folder searched for them.

check options:
  --present <text>    The text must be shown. Repeatable; applies to every input.
  --absent <text>     The text must not be shown. Repeatable; applies to every input.
  --expect <file>     Per-image checks from a YAML or JSON file (see docs/cli.md).
  --catalog <file>    Strings for @key checks: JSON, .strings, .xcstrings, Android strings.xml, or the object a
                      .ts/.js file exports (read as text, never run; docs/cli.md#catalogs). Repeatable;
                      the last file wins a duplicate key. 'locales/{locale}.json' takes the run locale.
                      @key works in --present, --absent and --expect; @@ is a literal @.
  --all-keys          Report which catalog strings each image shows (an inventory; it never fails).
  --fail-on-skip      Exit 1 when a check is skipped (a missing catalog, a string with nothing checkable, an
                      empty video range). Verdicts and reports stay as they are. Also for video.
  --pseudo            The screens show a pseudo-locale build: texts and @keys match with the pseudo markers
                      stripped and accents folded, so checks written for the base language still work.

untranslated options (exit 1 when anything is found; docs/cli.md#untranslated):
  --base <file>       The base-locale catalog (any --catalog format). Needs --catalog: base strings shown
                      on the screen are reported unless the translation is the same text.
  --catalog <file>    The translated catalog; 'locales/{locale}.json' needs --locale. Its keys found
                      verbatim on screen are raw keys. Without any catalog, only key-shaped lines and
                      unfilled placeholders ({name}, %d, %@, ...) are reported.
  --base-locale <code> The language of --base. Default: the .xcstrings sourceLanguage, else en.
  --allow <file>      Strings that are fine in any language (brand names), one per line; # comments.
  --kinds <list>      Report only these: untranslated, raw-key, placeholder, hardcoded, wrong-language.
  --languages <list>  The project's languages (es,pt-BR), for wrong-language when --catalog is not a
                      'locales/{locale}.json' template or an .xcstrings file (comma-separated).
  --pseudo            The screens show a pseudo-locale build (catscan pseudo): --catalog is the base catalog;
                      reports hardcoded lines (no pseudo markers or accents), raw keys and placeholders, and
                      pseudo-not-applied when a screen shows base text. --locale en-XA reads as en.
  --dynamic <file>    With --pseudo: regexes (one per line, whole line) for text never reported as hardcoded,
                      such as user names. Numbers, prices, dates and the status bar are skipped already.
  --boxes <file|dir>  With --pseudo: elements marked "dynamic": true are never reported as hardcoded.

video options (docs/cli.md#video):
  --present <text>, --absent <text>  Texts that must or must not be shown; repeatable, @key with --catalog.
  --catalog <file>    Strings for @key texts, as for check.
  --every <s>         Sampling interval in seconds. Default 0.5; at least one frame. Text shown for less
                      than --every can fall between samples: use a smaller --every for --absent checks.
  --from <s>, --to <s> The time range to sample. Default: the whole video; bounds inclusive.
  --present / --absent pass when the text is on at least one / on no sampled frame.
  --expect <file>     Checks per time range: ranges: {"0-2.5": {present: [...]}, "4-": {absent: [...]}}.
  --frames            With --json: one video-frame line per sampled frame (its time and recognized lines).
  --fail-on-skip      Exit 1 when a check is skipped (an empty time range, nothing checkable).

truncated options (exit 1 when a line is cut off; docs/cli.md#truncated):
  --boxes <file|dir>  Element boxes from the e2e test (catscan boxes writes them). A file for one image, or a
                      folder holding <name>.boxes.json for each image; without boxes only ellipsis, the
                      screen edge and catalog prefixes are checked.
  --catalog <file>    Catalog strings: a line that is a strict prefix of one is reported ("Contin").
  --reasons <list>    Report only these: ellipsis, prefix, edge, overflow, screen-edge, pseudo-cut (comma-separated).
                      Default: all.
  --pseudo            The screens show a pseudo-locale build; --catalog is the base catalog. A line with [ but
                      no ] (or ] but no [) is reported as pseudo-cut, with what was lost: filler or text.
  --allow <file>      Strings never reported (an intended "Loading..."), one per line; # comments.

overlap options (exit 1 when text is drawn over text or an icon; docs/cli.md#overlap):
  Every run checks stacked text (signal "stacked"): text drawn over text that Vision reads only without
  language correction or reads as non-words; one more Vision read per image. Without boxes it is the only
  reader; element-box overlap needs --boxes.
  --boxes <file|dir>  Element boxes (the truncated sidecars; catscan boxes writes them). Reader "elements": two
                      text elements, or a text and a graphic (icon, image, control), whose boxes intersect and
                      whose ink Vision confirms; "sheets": two texts of one height, one inside the other (pages
                      drawn over each other). An image with no sidecar is an error unless --experimental.
  --allow <file>      Element ids or texts never reported (an intended badge over an avatar), one per line.
  --experimental      Without boxes: also the OCR-only reader (signal "boxes"), which finds about 1 in 16 real
                      overlaps. With boxes: also "occluded", text cut off by a panel (a footer, toolbar, keyboard;
                      panel: true in the boxes file), and an image with no sidecar runs the OCR-only reader instead
                      of failing.
  --min-overlap <share> How much of the smaller box the other must cover, above 0 and at most 1. Default 0.01
                      with --boxes (element boxes), 0.3 without (line boxes).

fit options (exit 1 when text or an icon button lies under the camera cutout, a rounded corner or the home
indicator, or, with --boxes, a one-line label wraps or a title ends in one word; docs/cli.md#fit):
  --device-profile <id|file>  The device of every input: a shipped profile id or a profile file. Default: iOS and
                      iPadOS screenshots match a profile by pixel size; Android needs a profile (or a --device
                      label that names one), else its reasons are skipped with device-unknown.
  --orientation <side>  portrait, landscape-left (the device's top on the image's left) or landscape-right.
                      Default: the sidecar's orientation; a landscape image without a side skips the cutout.
  --boxes <file|dir>  Element boxes: adds textless controls (icon buttons) and skips scrolling content; needed by
                      wrapped and orphan.
  --reasons <list>    cutout, corner, home-indicator, wrapped, orphan (comma-separated). Default: the reasons that
                      passed their gate (none yet: every reason is experimental, so pass --experimental or name
                      them); orphan runs only when named.
  --base-locale <code>  wrapped: the locale whose screens show the one-row reference, paired by --layout's screen
                      (and device). Default: the --catalog source locale, else en. Its screens are checked too.
  --catalog <template>  wrapped: pairs elements with no id through the catalog key of their texts.
  --experimental      Run every reason, including those that missed their gate (low certainty).
  --allow <file>      Lines or element ids never reported (a deliberate full-bleed title), one per line.
  --fail-on-skip      Exit 1 when a reason was skipped on any image (no profile, unknown landscape side).
  --list-devices      Print the shipped profiles (--json: the array).

contrast options (exit 1 when a line's WCAG contrast is below its threshold, or its background is busy;
docs/cli.md#contrast). Every kind is experimental until it passes its gate, so --experimental is needed:
  --level AA|AAA      WCAG level: AA (default) fails normal text below 4.5:1 and large text below 3:1; AAA 7 and 4.5.
  --scale <n>         The device pixel ratio (1 to 4), which turns line height into text size. Default: the boxes
                      file, else the iOS screenshot size, else 1 (only large-text thresholds can fail;
                      contrast-scale-unknown). Android: adb shell wm density / 160.
  --kinds <list>      low-contrast, busy-background (comma-separated). Default: both.
  --boxes <file|dir>  Element boxes: disabled controls and text covered by a panel are not checked.
  --allow <file>      Lines never reported (logotypes, decorative text), one per line.
  --experimental      Required: run the kinds that have not passed their gate yet (low certainty).

formats options (exit 1 when a number, date, time, currency or price is wrong for the locale or storefront;
docs/cli.md#formats):
  --storefront <region>  The App Store / Play storefront (DE, US, JP): the currency users are charged in.
  --currency <ISO>    The expected currency (EUR), when no storefront is given. Without either, the currency and
                      price rules do not run (warning currency-unchecked).
  --prices <file>     Test products: a .storekit file, or JSON/YAML [{product, price, currency, period, trial}].
                      Shown amounts that match no product, or a wrong period or trial next to one, are findings.
  --rules <list>      Report only these: number, date, time, currency-placement, currency, mixed-currency, price.
                      Default: all but time and currency-placement.
  --allow <file>      Lines never reported, one per line; # comments.

boxes: catscan boxes xcuitest|uiautomator|maestro|playwright <dump> [--image <png>] prints a --boxes file.
  --image <png>       The screenshot the dump was taken with. Needed for uiautomator and Android maestro
                      dumps, which are in screen pixels (docs/truncation-capture.md).

Thresholds (check, untranslated, truncated, overlap, formats, fit, contrast, results merge, report; docs/cli.md#severity-and-certainty):
  --min-severity critical|major|minor  Only findings at or above both levels gate (fail the input and the exit
  --min-certainty high|medium|low      code). Default minor and low: every finding gates. Failed checks always
                      gate. The rest print as note lines and stay in --json with "gate": false.

check, read, untranslated, truncated, overlap, formats, fit and contrast:
  --fallback <engine> Reader for locales Vision cannot read (catscan languages lists them).
                      Default: tesseract when installed (catscan doctor shows it), else none (exit 3).

Results file (check, read, untranslated, video, truncated, overlap, formats, fit, contrast; docs/results.md):
  --results <file>    Also write the whole run to one versioned JSON file: run metadata, coverage, every result.
  --build <id>, --build-version <v>  The app build being checked, recorded in the file. Default: null.

Locale and screen from the path, expected coverage (the commands above, results merge, report):
  --layout <pattern>  How locale and screen are read from a path below its argument: '{locale}/{screen}'
                      (default), '{screen}.{locale}', '{screen}/{locale}', '{locale}-{screen}',
                      '{screen}-{locale}' (a locale token at the start or end of the file name), or none; each may start with
                      '{device}/', then '{text_size}/'. A matched locale is the recognition locale unless
                      --locale or the --expect file gives one.
  --expect-locales <list>     Locales that must be present, such as de,fr,ja.
  --expect-locales-from <dir> The locales of the catalogs in a folder (.xcstrings, .lproj, values-*, JSON).
  --expect-screens <file>     Screen ids that must be present, one per line; # comments. Default: every screen seen.
  --expect-devices <list>     Devices that must be present, such as ios,android. Default: every device seen.
  --expect-text-sizes <list>  Text sizes that must be present, such as default,large. Default: every size seen.
                      Each expected device, text size, locale and screen with no screenshot is a missing result
                      that fails (exit 1).

Device and text size of every input (check, read, untranslated, video, truncated, overlap, formats, fit, contrast):
  --device <label>    The device of every input, such as ios-se; wins over a {device}/ folder.
  --text-size <label> The system text size of every input, such as default or large; wins over a {text_size}/
                      folder. An input with none is a default one (docs/recipes/large-text.md).

CI reports (check, read, untranslated, video, truncated, overlap, formats, fit, contrast; docs/recipes/ci.md), written in addition to stdout:
  --junit <file>      JUnit XML: one testsuite per folder, one testcase per check (per input for the finding commands).
  --gitlab-codequality <file>  GitLab Code Quality JSON: one entry per failed check or finding, per error input.
  --format github     GitHub Actions: up to 10 ::error annotations and a job summary in $GITHUB_STEP_SUMMARY.

HTML report (check, read, untranslated, video, truncated, overlap, formats, fit, contrast; docs/report.md). It holds the screenshots: share it with care.
  --report <file>     Also write one self-contained HTML file: coverage matrix, screenshots with boxes, findings.
  --report-images embed|link  embed (default): JPEG copies inside the file. link: PNG, JPEG, GIF and WebP files are
                      referenced by relative path (smaller, but the screenshots must stay next to the report).
  --report-max-edge <px>  Long edge of embedded images. Default 800.

report: catscan report <results.json...> renders results files (shards are merged as results merge does) to
  --out <file>        Default catscan-report.html.
  --images-root <dir> The folder the paths in the results files are relative to. Default: the working directory.
  --report-images embed|link, --report-max-edge <px>  JPEG copies inside the file (default) or relative links;
                      the long edge of embedded images (default 800).
  It takes --layout and the expectation options too, and exits like the merged run.

results merge: combines shard files of one run into --out and recomputes coverage; the expectation options win
over the shards'. results validate: checks a file against the schema and its own totals (exit 0 valid, 1 not).
  --out <file>        The file merge, baseline or known writes.

Changed-only review (run commands, results merge, report; docs/results.md#changed-only-review). It compares
recognized text only, never images, layout or colors; the exit code does not change.
  --baseline <file>   Compare each locale x screen cell's text with an approved results file: changed, unchanged,
                      new, gone or ambiguous; the results file records which cells need review.

Text records (check, read, untranslated, video, truncated, overlap, formats, fit, contrast):
  --baseline-ignore <file>  Regular expressions, one per line (# comments), masked in the text (IDs, scores).
  --text-record full|digest|none  Text kept in the results file. Default full; digest keeps no text (no line
                      diff); none cannot be a baseline.

results baseline: approves a reviewed results file as a baseline (writes --out with "approved"); refuses error,
needs-reader, unsupported, missing, ambiguous and unread cells (exit 1) unless --allow-incomplete.

Known findings (docs/results.md#known-findings). results known approves every finding of the results files (all
but missing) into --out, keyed without its box; an existing file is updated only for the command x cell groups
the files read. --prune only lowers counts to what was found and removes rows that reach 0.

Known findings (check, untranslated, truncated, overlap, formats, fit, contrast, results merge, report):
  --known <file>      Findings approved in this file never fail the input or the exit code ("known": true,
                      "gate": false); only new findings do. A missing file warns known-missing.

Language (check, read, untranslated, video, truncated, overlap, formats, fit, contrast):
  --locale <code>     BCP 47 code of the screenshot language, such as de, pt-BR, zh-Hant. Default: en.
                      catscan languages lists the codes this Mac reads.

Output (check, read, untranslated, video, truncated, overlap, formats, fit, contrast):
  --json              One JSON object per input on stdout (JSON Lines). Short for --format json.
  --format text|json|github  Output format. Default: text. github: see CI reports above.

Output (languages, doctor, pseudo and results validate):
  --json              JSON on stdout. Short for --format json.
  --format text|json  Output format. Default: text.

Quiet (every command but languages, doctor and serve):
  --quiet, -q         Print only failures and the totals line.

Global options:
  --help, -h          This help; after a command, that command's help only.
  --version           catscan version, macOS version and the Vision request revision.

pseudo: writes a pseudo-locale catalog from a base catalog (.strings, .xcstrings, strings.xml, i18next JSON) for a
pseudo build: every translatable string expanded with accented filler words, accented and wrapped in [ ]. Keys,
placeholders, markup and escapes stay as they are. It reads no images.
  --out <path>        Where to write. Default: next to the input (en-XA.json, en-XA.lproj, src/debug/res/values-en-rXA).
  --locale <tag>      The pseudo locale. Default: en-XA (ar-XB for --variant rtl).
  --expand <percent>  Minimum growth of each string, 0-300. Default: 40.
  --variant accent|rtl|tall  Default: accent.
  --in-place          .xcstrings only: add the pseudo localization to the catalog itself.
  --force             Overwrite an existing output file.

doctor options (exit 0 when catscan can run, 1 when a check fails; docs/cli.md#doctor):
  --offline           Skip the check for a newer catscan on npm.
  --expect-locales <list>, --expect-locales-from <dir>  Also self-test the reader of each locale (Tesseract for
                      the locales Vision cannot read).

serve: a long-lived JSON Lines process over stdin and stdout for integrations (docs/cli.md).

Exit codes: 0 every check passed, 1 a check failed or a finding gates, 2 usage error, 3 language not read (unsupported, or
needs a reader such as Tesseract: the hint names the install; or overlap-unchecked: overlap without boxes or --experimental
on a Tesseract read), 4 an input could not be read, 5 internal error.`;

// TODO-093 T2 (D5): every help block, keyed by its first line, names the commands it is for. `catscan --help` prints
// every block; `catscan <command> --help` prints the command's usage lines and its blocks. A block with no entry here
// fails the unit test, so a new section cannot go missing from per-command help.
const RUN = args.RUN_COMMANDS;
const ALL = args.COMMANDS;
const HELP_BLOCKS = [
  ["catscan ", ALL],
  ["Usage:", ALL],
  ["<path> is an image", RUN.filter((c) => c !== "video")],
  ["For video, <file>", ["video"]],
  ["check options:", ["check"]],
  ["untranslated options", ["untranslated"]],
  ["video options", ["video"]],
  ["truncated options", ["truncated"]],
  ["overlap options", ["overlap"]],
  ["fit options", ["fit"]],
  ["contrast options", ["contrast"]],
  ["formats options", ["formats"]],
  ["boxes:", ["boxes"]],
  ["Thresholds (", ["check", "untranslated", "truncated", "overlap", "formats", "fit", "contrast", "results", "report"]],
  ["check, read, untranslated, truncated, overlap, formats, fit and contrast:", ["check", "read", "untranslated", "truncated", "overlap", "formats", "fit", "contrast"]],
  ["Results file (", RUN],
  ["Locale and screen from the path", [...RUN, "results", "report"]],
  ["Device and text size", RUN],
  ["CI reports (", RUN],
  ["HTML report (", RUN],
  ["report:", ["report"]],
  ["results merge:", ["results"]],
  ["Changed-only review (", [...RUN, "results", "report"]],
  ["Text records (", RUN],
  ["results baseline:", ["results"]],
  ["Known findings (docs", ["results"]],
  ["Known findings (check", ["check", "untranslated", "truncated", "overlap", "formats", "fit", "contrast", "results", "report"]],
  ["Language (", RUN],
  ["Output (check", RUN],
  ["Output (languages", ["languages", "doctor", "pseudo", "results"]],
  ["Quiet (", ALL.filter((c) => !["languages", "doctor", "serve"].includes(c))],
  ["Global options:", ALL],
  ["pseudo:", ["pseudo"]],
  ["doctor options", ["doctor"]],
  ["serve:", ["serve"]],
  ["Exit codes:", ALL],
];

function helpBlockCommands(block) {
  const hit = HELP_BLOCKS.find(([prefix]) => block.startsWith(prefix));
  return hit ? hit[1] : null;
}

/** `catscan <command> --help`: the header, the command's usage lines, then every help block tagged with it. */
function commandHelp(command) {
  const out = [];
  for (const block of HELP.split("\n\n")) {
    if (block.startsWith("Usage:")) {
      const lines = block.split("\n").slice(1);
      const own = [];
      for (let k = 0; k < lines.length; k++) {
        if (!lines[k].startsWith(`  catscan ${command} `) && lines[k] !== `  catscan ${command}`) continue;
        own.push(lines[k]);
        while (k + 1 < lines.length && /^ {3,}\[/.test(lines[k + 1])) own.push(lines[++k]);
      }
      out.push(["Usage:", ...own].join("\n"));
    } else if ((helpBlockCommands(block) || []).includes(command)) {
      out.push(block);
    }
  }
  out.push("Every command: catscan --help. Reference: docs/cli.md.");
  return out.join("\n\n");
}

// Diagnostics that mean nothing was checked: --quiet never hides them.
// locale-fallback and language-not-in-table change what was checked (TODO-003 D12).
// The fallback-* warnings say another engine read the screen or none could (spec 03 D6).
const ALWAYS_SHOWN = new Set([
  "no-checkable-text", "locale-script-mismatch", "locale-fallback", "language-not-in-table",
  "fallback-engine", "fallback-pack-missing", "fallback-unavailable",
  // A skipped catalog check is never silent (spec 02 D22).
  "catalog-missing", "catalog-string-capped", "catalog-duplicate-key", "catalog-values-skipped", "catalog-value-dynamic",
  // An untranslated rule that was switched off or could not read a base string says so (spec 17 D27).
  "untranslated-base-catalog", "untranslated-unreadable",
  // wrong-language could not run, or ran without catalog evidence (TODO-036 D17, D27).
  "wrong-language-unchecked",
  // The currency and price rules had no expected currency (TODO-036 D17).
  "currency-unchecked",
  // A video check that ran on no frame, or a changed sampling interval (spec 07 D21).
  "range-empty", "every-clamped",
  // An image checked without its boxes says so (spec 06 D6, D27).
  "boxes-missing",
  // A rule ran on a reader its gate was not measured on (TODO-036 D17).
  "rule-unmeasured-reader",
  // Occlusion skipped (experimental) or had no panel to check (TODO-049 D21).
  "occlusion-experimental", "no-panel-elements",
  // Stacked text not checked on a Tesseract read (TODO-067 D15).
  "stacked-unchecked",
  // A safe-area reason or part that did not run (TODO-073 D16, D18).
  "device-unknown", "device-ambiguous", "orientation-unknown", "fit-controls-need-boxes", "fit-experimental",
  // A contrast check that was relaxed or skipped (TODO-054 D24).
  "contrast-scale-unknown", "contrast-size-uncertain", "contrast-behind-scrim",
]);

// Under --format github the runner also reads workflow commands on stderr: a path, catalog key or core message
// carrying a line break must not start a line there (spec 15 D6).
let escapeStderr = false;
function writeErr(line) { process.stderr.write((escapeStderr ? line.replace(/\r/g, "%0D").replace(/\n/g, "%0A") : line) + "\n"); }

async function main(argv) {
  if (argv.length === 0) {
    process.stdout.write(SHORT_USAGE + "\n");
    return render.EXIT.usage;
  }
  let opts;
  // Before parsing, so a usage error under --format github is escaped too (last --format wins, as in parse).
  const fmt = argv.reduce((f, a, i) => (a === "--format" ? argv[i + 1] : a.startsWith("--format=") ? a.slice(9) : f), null);
  escapeStderr = fmt === "github";
  try {
    opts = args.parse(argv);
  } catch (e) {
    if (e instanceof args.UsageError) {
      writeErr(render.diagnosticLine(e));
      return render.EXIT.usage;
    }
    throw e;
  }
  if (opts.help) { process.stdout.write((opts.command === null ? HELP : commandHelp(opts.command)) + "\n"); return 0; }
  if (opts.version) return printVersion();
  if (opts.command === null) {
    writeErr(render.diagnosticLine({ code: "missing-command", message: "no command given", hint: "catscan check --help" }));
    return render.EXIT.usage;
  }
  if (opts.command === "serve") return serve();
  if (opts.command === "languages") return languages(opts);
  if (opts.command === "doctor") return doctor(opts);
  if (opts.command === "boxes") return boxesCommand(opts);
  if (opts.command === "pseudo") return pseudoCommand(opts);
  if (opts.command === "fit" && opts.listDevices) {
    process.stdout.write(opts.format === "json" ? JSON.stringify(deviceProfiles.list()) + "\n" : deviceProfiles.listText());
    return 0;
  }
  opts.argv = argv;
  if (opts.command === "results") return resultsCommand(opts);
  if (opts.command === "report") return reportCommand(opts);

  let expect = null;
  let cat = null;
  let untr = null;
  let exp = null;
  try {
    exp = results.expectations(opts);
    if (opts.command === "untranslated") untr = untranslated.build(opts);
    if (opts.command === "formats") opts.formatsField = formats.build(opts).field;
    if (opts.expect) expect = expectFile.load(opts.expect, opts.command);
    // untranslated.build loaded these already; a second load would print every catalog warning twice.
    // truncated.build loads its catalogs in run(); a second load here would print their warnings twice.
    // fit (TODO-074) loads its catalogs per locale in fit.build.
    if (opts.catalogs.length && !untr && opts.command !== "truncated" && opts.command !== "fit") cat = catalog.loadAll(opts.catalogs, opts.locale ?? expect?.locale ?? "en");
    // Every @key resolves before any input is read: an unknown key is a usage error (spec 02).
    opts.present = opts.present.map((t) => catalog.resolve(t, cat, "--present"));
    opts.absent = opts.absent.map((t) => catalog.resolve(t, cat, "--absent"));
    if (expect) {
      for (const sh of expect.shots || expect.ranges) {
        const where = `${opts.expect}: ${expect.shots ? "shots" : "ranges"}.${sh.key}`;
        sh.present = sh.present.map((t) => catalog.resolve(t, cat, `${where}.present`));
        sh.absent = sh.absent.map((t) => catalog.resolve(t, cat, `${where}.absent`));
      }
    }
  } catch (e) {
    if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return render.EXIT.usage; }
    throw e;
  }
  if (cat) for (const w of cat.warnings) writeErr(render.diagnosticLine(w));
  if (untr) for (const w of untr.warnings) writeErr(render.diagnosticLine(w));
  if (exp) for (const w of exp.warnings) writeErr(render.diagnosticLine(w));
  let ignore = null;
  if (opts.baselineIgnore !== null) {
    try { ignore = baseline.readIgnore(opts.baselineIgnore); } catch (e) {
      if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return render.EXIT.usage; }
      throw e;
    }
  }
  // The baseline is read and checked before any screenshot, so a wrong file costs no Vision time.
  const bl = opts.baseline !== null ? loadBaseline(opts) : null;
  if (bl && bl.code !== undefined) return bl.code;
  // TODO-055: the known file too, before any Vision time.
  const kn = loadKnown(opts);
  if (kn.code !== undefined) return kn.code;
  return run(opts, expect, cat, untr, exp, { ignore, bl, kctx: kn.ctx });
}

/**
 * Reads --known (TODO-055 D7): { ctx } (null without the flag), or { code } after printing why. A missing file is
 * the warning known-missing and a context that approves nothing (every finding new: fail closed).
 */
function loadKnown(opts) {
  if (opts.known === null) return { ctx: null };
  const file = results.privatePath(opts.known, opts.known);
  if (!fs.existsSync(opts.known)) {
    writeErr(render.diagnosticLine({ code: "known-missing", message: `${file} does not exist, so every finding is new`, hint: `create it after review: catscan results known <results.json> --out ${file}` }));
    return { ctx: known.context(null, file, "") };
  }
  const r = readKnown(opts.known);
  if (!r.obj) return { code: r.code };
  return { ctx: known.context(r.obj, file, fs.readFileSync(opts.known)) };
}

/**
 * Reads --baseline (TODO-038): { base, file, canon }, base null when the file does not exist (D15), or { code }
 * after printing why (exit 4 unreadable or invalid, as merge treats inputs; exit 2 for the baseline-* usage errors).
 */
function loadBaseline(opts) {
  const file = results.privatePath(opts.baseline, opts.baseline);
  let canon;
  try { canon = baseline.canonFrom(client.languagesInfo()); } catch { canon = baseline.canonFrom(null); }
  if (!fs.existsSync(opts.baseline)) return { base: null, file, canon };
  const r = readOne(opts.baseline);
  if (!r) return { code: render.EXIT.error };
  if (axisUnknown(opts.baseline, r)) return { code: render.EXIT.usage };
  const errors = errorsOf(r);
  if (errors.length) { reportInvalid(opts.baseline, errors); return { code: render.EXIT.error }; }
  try { baseline.checkBaseline(r.obj, canon, file); } catch (e) {
    if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return { code: render.EXIT.usage }; }
    throw e;
  }
  return { base: r.obj, file, canon };
}

/** Sets `file.baseline` and every `change` (TODO-038 T2). False after printing a baseline usage error (exit 2). */
function applyBaseline(file, bl, ignoreDigest = null) {
  try {
    const { block, warnings } = baseline.compare(file, bl.base, { file: bl.file, canon: bl.canon, ignoreDigest });
    file.baseline = block;
    // D22: these say why nothing is skippable, so --quiet keeps them.
    for (const w of warnings) writeErr(render.diagnosticLine(w));
    return true;
  } catch (e) {
    if (!(e instanceof args.UsageError)) throw e;
    writeErr(render.diagnosticLine(e));
    return false;
  }
}

function printVersion() {
  try {
    const v = client.versionInfo();
    process.stdout.write(`catscan ${v.catscan}\nmacOS ${v.macos} (${v.macos_build})\nVision VNRecognizeTextRequest revision ${v.vision_revision}\n`);
    return 0;
  } catch (e) {
    process.stdout.write(`catscan ${version}\n`);
    const known = e instanceof client.CatscanError;
    writeErr(render.diagnosticLine({ code: known ? e.code : "binary-failed", message: e.message, hint: e.hint }));
    return render.EXIT.internal;
  }
}

function languages(opts) {
  let info;
  try {
    info = client.languagesInfo();
  } catch (e) {
    const known = e instanceof client.CatscanError;
    writeErr(render.diagnosticLine({ code: known ? e.code : "binary-failed", message: e.message, hint: e.hint }));
    return render.EXIT.internal;
  }
  if (opts.format === "json") process.stdout.write(JSON.stringify(info) + "\n");
  else process.stdout.write(render.renderLanguages(info).join("\n") + "\n");
  return 0;
}

/** Exit 0 whenever catscan can run (Tesseract is optional), 1 otherwise, or when a --expect-locales locale has no
 * working reader (TODO-065); never 5 (spec 08 D8, D13). */
async function doctor(opts) {
  // TODO-065 T3: --expect-locales[-from] add a reader and a self-test per locale; usage errors exit 2 as elsewhere.
  let expect;
  try { expect = require("./results").expectations(opts); }
  catch (e) {
    if (!(e instanceof args.UsageError)) throw e;
    writeErr(render.diagnosticLine(e));
    return render.EXIT.usage;
  }
  const r = doctorReport.report({ expect });
  // TODO-059 D3: the update notice is a top-level field and one line, never a check, so it cannot fail doctor.
  r.update = await require("./update-check").check({ offline: opts.offline, current: r.catscan });
  if (opts.format === "json") process.stdout.write(JSON.stringify(r) + "\n");
  else process.stdout.write(doctorReport.renderDoctor(r).join("\n") + "\n");
  return r.ok ? 0 : 1;
}

/** `catscan boxes <source> <dump>`: the --boxes file on stdout (spec 06 D9). */
function boxesCommand(opts) {
  try {
    const { boxes: out, warnings } = boxes.convert(opts.paths[0], opts.paths[1], opts.image);
    for (const w of warnings) writeErr(render.diagnosticLine(w));
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return 0;
  } catch (e) {
    if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return render.EXIT.usage; }
    throw e;
  }
}

/** `catscan pseudo <catalog>` (TODO-039 T1): writes the pseudo catalog, then the summary and next steps (D6). */
function pseudoCommand(opts) {
  let r;
  try {
    r = pseudo.generate({ file: opts.paths[0], out: opts.out, locale: opts.locale, expand: opts.expand, variant: opts.variant, inPlace: opts.inPlace, force: opts.force });
  } catch (e) {
    if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return render.EXIT.usage; }
    throw e;
  }
  try {
    pseudo.write(r);
  } catch (e) {
    // writeAtomic throws a coded diagnostic; mkdir errors (a file where a folder must be) arrive raw.
    writeErr(render.diagnosticLine(e.code === "output-write-failed" ? e : { code: "output-write-failed", message: `cannot write the pseudo catalog ${r.output}: ${e.code || e.message}`, hint: "check that the folder is writable, or pass --out <path>" }));
    return render.EXIT.error;
  }
  for (const w of r.warnings) writeErr(render.diagnosticLine(w));
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(pseudo.json(r)) + "\n");
    return 0;
  }
  writeErr(pseudo.summary(r));
  if (!opts.quiet) {
    writeErr("next:");
    r.next.forEach((n, i) => writeErr(`  ${i + 1}. ${n.step}: ${n.command}`));
  }
  return 0;
}

function serve() {
  let bin;
  try { bin = client.binaryPath(); } catch (e) { writeErr(render.diagnosticLine(e)); return render.EXIT.internal; }
  return new Promise((resolve) => {
    const p = spawn(bin, ["serve"], { stdio: "inherit" });
    p.on("exit", (code) => resolve(code === null ? render.EXIT.internal : code));
    // Not executable (EACCES) or gone since the check: a diagnostic, not a stack trace.
    p.on("error", (e) => {
      writeErr(render.diagnosticLine({ code: "binary-failed", message: `cannot start ${bin}: ${e.message}`, hint: "check CATSCAN_CORE_BINARY or rebuild catscan-core" }));
      resolve(render.EXIT.internal);
    });
  });
}

/** The per-input locale, screen and spec 27 warnings from --layout, or null when the languages table cannot be read. */
function mapInputs(opts, expect, exp, list) {
  const layout = opts.layout ?? results.DEFAULT_LAYOUT;
  const rels = list.map((inp) => (inp.stdin ? null : expectFile.relativeTo(inp.arg, inp.path, inp.argIsDir)));
  let known = new Map();
  // TODO-087 D10: with expectations, the layout-mismatch hint may name another pattern, which needs the table too.
  const hint = exp && layout !== "none" && args.BASE_LAYOUTS.some((b) => results.needsLocales(b, rels));
  if (results.needsLocales(layout, rels) || hint) {
    try { known = results.knownLocales(client.languagesInfo()); } catch (e) {
      const k = e instanceof client.CatscanError;
      writeErr(render.diagnosticLine({ code: k ? e.code : "binary-failed", message: e.message, hint: e.hint }));
      return null;
    }
  }
  const explicit = opts.locale ?? expect?.locale ?? null;
  const out = results.mapInputs(layout, rels, known, { locale: explicit, device: opts.device, textSize: opts.textSize, exp, paths: list.map((x) => x.path) });
  return { layout, inputs: out };
}

/** TODO-055 D30: `sha256:<hex>` of the --allow file the run read, or null (none, or gone since it was read). */
function allowDigest(file) {
  if (!file) return null;
  try { return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`; } catch { return null; }
}

/** The results-file object of the run, built once for --results and --report (spec 18 D18). */
function buildFile(opts, envelopes, priv, cov, started, kblock = null) {
  const host = envelopes.find((e) => e.env.host)?.env.host ?? null;
  return results.build({
    results: priv,
    coverage: cov.coverage,
    argv: results.privateArgv(opts.argv),
    started,
    finished: new Date(),
    build: opts.build !== null || opts.buildVersion !== null ? { id: opts.build, version: opts.buildVersion } : null,
    host,
    ci: results.ciInfo(),
    thresholds: opts.thresholds,
    allow: allowDigest(opts.allow),
    known: kblock,
  });
}

/** Writes --results (spec 27 D15). Returns false and prints results-write-failed when it cannot. */
function writeResults(opts, file) {
  try { results.write(opts.results, file); return true; } catch (e) {
    if (!(e instanceof client.CatscanError)) throw e;
    writeErr(render.diagnosticLine(e));
    return false;
  }
}

const readOne = (f) => {
    try { return results.read(f); } catch (e) {
      if (!(e instanceof client.CatscanError)) throw e;
    writeErr(render.diagnosticLine(e));
    return null;
  }
};
const errorsOf = (r) => (r.parseError ? [{ pointer: "/", message: `not JSON: ${r.parseError}` }] : results.check(r.obj));
/** TODO-075 D16: a file naming an axis this version does not know is refused (exit 2), before its schema is read. */
const axisUnknown = (f, r) => {
  const bad = r.obj ? results.unknownAxes(r.obj) : [];
  if (!bad.length) return false;
  const by = r.obj.run && typeof r.obj.run.catscan === "string" ? r.obj.run.catscan : "the version that wrote it";
  writeErr(render.diagnosticLine({ code: "results-axis-unknown", message: `${f} uses the axis ${bad.join(", ")}, which this catscan does not know`, hint: `upgrade every job of this pipeline to catscan ${by} or later` }));
  return true;
};
const reportInvalid = (f, errors) => {
  for (const e of errors) writeErr(render.diagnosticLine({ code: "results-invalid", message: `${f}#${e.pointer}: ${e.message}`, hint: "docs/results.md lists every field" }));
};

/**
 * Reads, validates and merges results files as `results merge` does (spec 27 "Merge"); `catscan report` shares it
 * (spec 18 D1). Returns { file } or { code } after printing why.
 */
function mergeFiles(opts, { single = false } = {}) {
  if (opts.layout === "none") {
    writeErr(render.diagnosticLine({ code: "invalid-layout", message: `${opts.command === "report" ? "report" : "results merge"} needs a layout to compute coverage, not none`, hint: "--layout '{locale}/{screen}'" }));
    return { code: render.EXIT.usage };
  }
  let exp;
  try { exp = results.expectations(opts); } catch (e) {
    if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return { code: render.EXIT.usage }; }
    throw e;
  }
  if (exp) for (const w of exp.warnings) writeErr(render.diagnosticLine(w));
  const outReal = (() => { try { return fs.realpathSync(opts.out); } catch { return null; } })();
  if (outReal && opts.paths.some((f) => { try { return fs.realpathSync(f) === outReal; } catch { return false; } })) {
    writeErr(render.diagnosticLine({ code: "results-duplicate-shard", message: `--out ${opts.out} is also an input`, hint: "write the merged file to a new path" }));
    return { code: render.EXIT.usage };
  }
  const shards = [];
  for (const f of opts.paths) {
    const r = readOne(f);
    if (!r) return { code: render.EXIT.error };
    if (axisUnknown(f, r)) return { code: render.EXIT.usage };
    const errors = errorsOf(r);
    if (errors.length) { reportInvalid(f, errors); return { code: render.EXIT.error }; }
    shards.push(r.obj);
  }
  // One file and nothing to recompute renders as written, so `--report` and `catscan report` on the same run give
  // the same page (spec 18 D1).
  const bl = opts.baseline !== null ? loadBaseline(opts) : null;
  if (bl && bl.code !== undefined) return { code: bl.code };
  const withBaseline = (file) => {
    if (!bl) return { file };
    delete file.approved; // a compared file is a new result, never the approved baseline itself
    if (!applyBaseline(file, bl)) return { code: render.EXIT.usage };
    writeErr(baseline.summaryLine(file.baseline));
    return { file };
  };
  const th = opts.thresholdsGiven ? opts.thresholds : null; // TODO-077 D15: only given flags recompute gates
  // TODO-055 D10: --known recomputes known, gate and verdicts on every shard before the merge; without it, each
  // finding keeps its shard's flags.
  const kn = loadKnown(opts);
  if (kn.code !== undefined) return { code: kn.code };
  const withKnown = (file) => {
    if (!kn.ctx) return file;
    const kr = known.block(kn.ctx, file.results);
    file.known = kr.known;
    for (const d of kr.drift) writeErr(render.diagnosticLine({ code: "known-drift", message: `${d.screen !== null ? `${d.device ? `${d.device}/` : ""}${d.text_size ? `${d.text_size}/` : ""}${d.locale}/${d.screen}` : d.path}: a new and an approved ${d.kind}${d.rule ? ` (${d.rule})` : ""} no longer found; probably the same finding read differently`, hint: `review it, then: catscan results known ${opts.out ?? "<results.json>"} --out ${kn.ctx.file}` }));
    return file;
  };
  // A shard's identity is its results as written: pin it before --known rewrites them, or a shard given twice
  // (once inside a merged file) would no longer match and count twice.
  const records = kn.ctx ? new Map(shards.map((s) => [s, results.shardRecords(s)])) : null;
  if (kn.ctx) for (const s of shards) {
    for (const e of s.results) known.reapply(kn.ctx, e, th ?? s.run.thresholds ?? scale.DEFAULTS);
    s.totals = results.totals(s.results);
    // As applyThresholds: a stored baseline comparison was made under the old verdicts, so a cell it marks
    // skippable may now fail, and the file is no longer the one approved. --baseline compares again.
    if (s.baseline) { s.baseline = null; for (const e of s.results) e.change = null; }
    delete s.approved;
  }
  if (single && shards.length === 1 && !exp && opts.layout === null) {
    if (th) for (const w of results.applyThresholds(shards[0], th)) writeErr(render.diagnosticLine(w));
    return withBaseline(withKnown(shards[0]));
  }
  let merged;
  try { merged = results.merge(shards, { exp, layout: opts.layout, argv: results.privateArgv(opts.argv), thresholds: th, records }); } catch (e) {
    if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return { code: render.EXIT.usage }; }
    throw e;
  }
  for (const w of merged.warnings) writeErr(render.diagnosticLine(w));
  return withBaseline(withKnown(merged.file));
}

/**
 * Renders and writes the HTML report (spec 18, D10, D12, D24). `ctx`: { locate(entry, i), request(req), root }.
 * Returns false after report-write-failed.
 */
async function buildReport(target, file, opts, ctx) {
  const built = await report.build(file, {
    ...ctx, mode: opts.reportImages || "embed", maxEdge: opts.reportMaxEdge || report.DEFAULT_MAX_EDGE, reportPath: target,
  });
  for (const w of built.warnings) writeErr(render.diagnosticLine(w));
  return built;
}

/** Writes a built report; false after report-write-failed. */
function writeBuiltReport(target, built) {
  try {
    results.writeAtomic(target, built.html, "report-write-failed", "the HTML report", "check that the folder exists and is writable, or pass another path");
  } catch (e) {
    if (!(e instanceof client.CatscanError)) throw e;
    writeErr(render.diagnosticLine(e));
    return false;
  }
  const bytes = Buffer.byteLength(built.html);
  const large = report.largeWarning(bytes);
  if (large) writeErr(render.diagnosticLine(large));
  writeErr(report.summaryLine(target, bytes, built.images));
  return true;
}

/** A serve process started on the first thumbnail request; `catscan report` needs none for a linked-only page. */
function lazyServer() {
  let server = null, failed = null;
  return {
    request(req) {
      if (failed) return Promise.reject(failed);
      // D27: the cause goes into the one report-images-unavailable warning, not a line of its own.
      try { server ||= new client.Server(); } catch (e) { failed = e; return Promise.reject(e); }
      return server.ready.then(() => server.request(req));
    },
    async close() { if (server && !server.dead) await server.close(); },
  };
}

/** `catscan report <results.json...>` (spec 18): exits with the merged verdicts (D11). */
async function reportCommand(opts) {
  const merged = mergeFiles(opts, { single: true });
  if (!merged.file) return merged.code;
  const root = opts.imagesRoot ?? process.cwd();
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    writeErr(render.diagnosticLine({ code: "images-root-not-found", message: `--images-root ${root} is not a folder`, hint: "pass the folder the results paths are relative to" }));
    return render.EXIT.usage;
  }
  const srv = lazyServer();
  let written;
  try {
    let built = null;
    // As in run(): a page that cannot be built is report-write-failed (exit 4), never an internal crash.
    try { built = await buildReport(opts.out, merged.file, opts, { root, request: (r) => srv.request(r), locate: (e) => report.resolveUnder(root, e.path) }); } catch (e) {
      if (!(e instanceof RangeError)) throw e; // only the size limit is an output problem; anything else is a bug (exit 5)
      writeErr(render.diagnosticLine({ code: "report-write-failed", message: `cannot build the HTML report ${opts.out}: ${e.message}`, hint: "use --report-images link or a smaller --report-max-edge, or report fewer shards at once" }));
    }
    written = built !== null && writeBuiltReport(opts.out, built);
  } finally { await srv.close(); }
  const verdicts = merged.file.results.map((r) => r.verdict);
  if (!opts.quiet) writeErr(render.countsLine(verdicts));
  const code = render.exitCode(verdicts);
  return written ? code : render.EXIT.error; // D10
}

/**
 * TODO-007 D3, D10: the `checks-skipped` diagnostic for --fail-on-skip, counted per reason in order of first
 * appearance, or null when no check was skipped. Only checks[] counts, never an --all-keys inventory (D6);
 * any skipped verdict counts, whatever its reason (D7).
 */
function skippedLine(envelopes) {
  const reasons = new Map();
  for (const { env } of envelopes) {
    for (const c of env.checks || []) if (c.verdict === "skipped") reasons.set(c.reason, (reasons.get(c.reason) || 0) + 1);
  }
  if (reasons.size === 0) return null;
  let n = 0;
  for (const k of reasons.values()) n += k;
  const why = [...reasons].map(([r, k]) => `${r ?? "no reason"} ${k}`).join(", ");
  return {
    code: "checks-skipped",
    message: `${n} check${n === 1 ? " was" : "s were"} skipped (${why}) and --fail-on-skip fails the run on them`,
    hint: "--json lists each skipped check and its reason in checks[]; fix the catalog file or range, or drop --fail-on-skip to accept unchecked strings",
  };
}

/** `catscan results validate|merge` (spec 27, D22). */
function resultsCommand(opts) {
  if (opts.subcommand === "validate") {
    const f = opts.paths[0];
    const r = readOne(f);
    if (!r) return render.EXIT.error;
    if (r.obj && known.isKnownFile(r.obj)) return validateKnown(f, r.obj, opts);
    const errors = errorsOf(r);
    if (opts.format === "json") process.stdout.write(JSON.stringify({ file: f, valid: errors.length === 0, errors }) + "\n");
    else {
      reportInvalid(f, errors);
      if (!errors.length) process.stdout.write(`${f}: valid results file (results_schema ${r.obj.results_schema})\n`);
    }
    return errors.length ? render.EXIT.fail : render.EXIT.pass;
  }
  if (opts.subcommand === "baseline") return approveCommand(opts);
  if (opts.subcommand === "known") return knownCommand(opts);
  const merged = mergeFiles(opts);
  if (!merged.file) return merged.code;
  try { results.write(opts.out, merged.file); } catch (e) {
    if (!(e instanceof client.CatscanError)) throw e;
    writeErr(render.diagnosticLine(e));
    return render.EXIT.error;
  }
  const verdicts = merged.file.results.map((r) => r.verdict);
  if (!opts.quiet) writeErr(render.countsLine(verdicts));
  return render.exitCode(verdicts);
}

/** `results validate` on a known file (TODO-055): schema and row order; a newer known_schema or key_algo is exit 2. */
function validateKnown(f, obj, opts) {
  const bad = known.unsupported(obj);
  if (bad) {
    if (opts.format === "json") process.stdout.write(JSON.stringify({ file: f, valid: false, errors: [{ pointer: "/", message: bad.message }] }) + "\n");
    writeErr(render.diagnosticLine(bad));
    return render.EXIT.usage;
  }
  const errors = known.check(obj);
  if (opts.format === "json") process.stdout.write(JSON.stringify({ file: f, valid: errors.length === 0, errors }) + "\n");
  else {
    for (const e of errors) writeErr(render.diagnosticLine({ code: "known-invalid", message: `${f}#${e.pointer}: ${e.message}`, hint: KNOWN_INVALID_HINT(f) }));
    if (!errors.length) process.stdout.write(`${f}: valid known file (known_schema ${obj.known_schema}, key_algo ${obj.key_algo})\n`);
  }
  return errors.length ? render.EXIT.fail : render.EXIT.pass;
}

const KNOWN_INVALID_HINT = (f) => `fix or recreate the committed known file; check it with catscan results validate ${f}`;

/**
 * Reads a known file (TODO-055 D7): { obj } or { code } after printing why: exit 2 `known-algo-unsupported` for a
 * newer known_schema or key_algo, exit 4 `known-invalid` (one line per violation) for anything unreadable or invalid.
 */
function readKnown(f) {
  const invalid = (lines) => { for (const m of lines) writeErr(render.diagnosticLine({ code: "known-invalid", message: m, hint: KNOWN_INVALID_HINT(f) })); return { code: render.EXIT.error }; };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {
    return invalid([e instanceof SyntaxError ? `${f} is not JSON: ${e.message}` : `cannot read the known file ${f}: ${e.code || e.message}`]);
  }
  const bad = known.unsupported(obj);
  if (bad) { writeErr(render.diagnosticLine(bad)); return { code: render.EXIT.usage }; }
  if (!known.isKnownFile(obj)) return invalid([`${f} is not a known file (no known_schema)`]);
  const errors = known.check(obj);
  if (errors.length) return invalid(errors.map((e) => `${f}#${e.pointer}: ${e.message}`));
  return { obj };
}

/**
 * `catscan results known` (TODO-055 D5, D17): approves every approvable finding of the given results files into
 * --out, group by group; never refuses an incomplete run (unread inputs keep their rows).
 */
function knownCommand(opts) {
  const files = [];
  for (const f of opts.paths) {
    const r = readOne(f);
    if (!r) return render.EXIT.error;
    if (axisUnknown(f, r)) return render.EXIT.usage;
    if (r.obj && known.isKnownFile(r.obj)) {
      writeErr(render.diagnosticLine({ code: "option-not-valid", message: `${f} is a known file, not a results file`, hint: `pass it as --out: catscan results known catscan-results.json --out ${f}` }));
      return render.EXIT.usage;
    }
    const errors = errorsOf(r);
    if (errors.length) { reportInvalid(f, errors); return render.EXIT.error; }
    files.push({ obj: r.obj, name: f });
  }
  const exists = fs.existsSync(opts.out);
  if (opts.prune && !exists) {
    writeErr(render.diagnosticLine({ code: "missing-path", message: `--prune lowers the counts of an existing known file, and ${opts.out} does not exist`, hint: `approve first: catscan results known ${opts.paths[0]} --out ${opts.out}` }));
    return render.EXIT.usage;
  }
  let existing = null;
  if (exists) {
    const k = readKnown(opts.out);
    if (!k.obj) return k.code;
    existing = k.obj;
  }
  const { file, stats, warnings } = known.approve(existing, files, { prune: opts.prune });
  for (const w of warnings) writeErr(render.diagnosticLine(w));
  try {
    results.writeAtomic(opts.out, known.serialize(file), "known-write-failed", "the known file", "check that the folder exists and is writable, or pass another --out path");
  } catch (e) {
    if (!(e instanceof client.CatscanError)) throw e;
    writeErr(render.diagnosticLine(e));
    return render.EXIT.error;
  }
  const n = (x, one, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
  const unread = stats.unread ? `; ${n(stats.unread, "input")} not read kept ${stats.unread === 1 ? "its" : "their"} rows` : "";
  const verb = opts.prune ? "pruned to" : "approved";
  process.stdout.write(`${verb} ${n(stats.findings, "finding")} in ${n(stats.groups, "group")} (+${stats.added} -${stats.removed} this run${unread}) -> ${opts.out} (${exists ? "updated" : "new file"}); next: add --known ${opts.out} to the CI command and commit the file\n`);
  return render.EXIT.pass;
}

/** `catscan results baseline` (TODO-038 D5, D6): the approval step a reviewer runs after reviewing the run. */
function approveCommand(opts) {
  const f = opts.paths[0];
  const r = readOne(f);
  if (!r) return render.EXIT.error;
  const errors = errorsOf(r);
  if (errors.length) { reportInvalid(f, errors); return render.EXIT.error; }
  let out;
  try { out = baseline.approve(r.obj, { allowIncomplete: opts.allowIncomplete, file: f }); } catch (e) {
    if (!(e instanceof args.UsageError)) throw e;
    writeErr(render.diagnosticLine(e));
    return render.EXIT.usage;
  }
  for (const d of out.refusals) writeErr(render.diagnosticLine(d));
  if (!out.file) return render.EXIT.fail;
  try { results.write(opts.out, out.file); } catch (e) {
    if (!(e instanceof client.CatscanError)) throw e;
    writeErr(render.diagnosticLine(e));
    return render.EXIT.error;
  }
  const kept = out.refusals.length ? `; ${out.refusals.length} incomplete entr${out.refusals.length === 1 ? "y stays" : "ies stay"} non-skippable` : "";
  process.stdout.write(`${opts.out}: approved baseline of ${f} (${r.obj.results.length} results${kept})\n`);
  return render.EXIT.pass;
}

/**
 * `--format github` (spec 15): the annotations on stdout, then the job summary appended to $GITHUB_STEP_SUMMARY.
 * Without it (a local run) the summary is skipped with one note (D7). Returns false when the summary cannot be written.
 */
function githubOutput(opts, priv, partial, bl = null, kblock = null) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  const where = [summaryFile ? "the job summary" : null, opts.results ?? null].filter(Boolean).join(" and ") || "the output of catscan --format text";
  for (const line of ci.githubLines(priv, { more: where, partial })) process.stdout.write(line + "\n");
  if (!summaryFile) {
    writeErr(render.diagnosticLine({ code: "github-summary-skipped", message: "GITHUB_STEP_SUMMARY is not set, so no job summary was written", hint: "run inside GitHub Actions, or use --format text locally" }));
    return true;
  }
  try {
    fs.appendFileSync(summaryFile, ci.githubSummary(priv, { command: opts.command, more: opts.results ?? "a --results file", partial, baseline: bl, known: kblock }));
    return true;
  } catch (e) {
    writeErr(render.diagnosticLine({ code: "report-write-failed", message: `cannot append the job summary to ${summaryFile}: ${e.code || e.message}`, hint: "check GITHUB_STEP_SUMMARY" }));
    return false;
  }
}

async function run(opts, expect, cat, untr, exp, { ignore = null, bl = null, kctx = null } = {}) {
  const t0 = process.hrtime.bigint();
  const started = new Date();
  const video = opts.command === "video";
  const list = inputs.collect(opts.paths, video ? inputs.VIDEO_EXT : inputs.IMAGE_EXT);
  const mapping = mapInputs(opts, expect, exp, list);
  if (!mapping) return render.EXIT.internal;
  const usedKeys = new Set();
  const unchecked = new Set(); // inputs no check applies to; reported even under --quiet
  let trunc = null;
  let pseudo = null;
  // TODO-039 T2: untranslated --pseudo --boxes reads only the boxes' dynamic: true elements.
  const boxesOnly = opts.command === "untranslated" && opts.boxes !== null;
  if (opts.command === "truncated" || boxesOnly) {
    try { trunc = truncated.build(opts, list, { boxesOnly }); } catch (e) {
      if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return render.EXIT.usage; }
      throw e;
    }
    for (const w of trunc.warnings) writeErr(render.diagnosticLine(w));
  }
  // TODO-046: overlap with element boxes (D1, D3, D10, D12).
  let overlapBoxes = null, overlapAllow = null;
  if (opts.command === "overlap") {
    try {
      overlapBoxes = boxes.forRun(opts.boxes, list);
      if (opts.allow) overlapAllow = untranslated.loadAllow(opts.allow);
    } catch (e) {
      if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return render.EXIT.usage; }
      throw e;
    }
    const loaded = list.map((inp) => overlapBoxes(inp).boxes).filter(Boolean);
    if (loaded.length && !loaded.some((b) => b.elements.some((e) => e.graphic))) {
      writeErr(render.diagnosticLine({ code: "no-graphic-elements", message: "no boxes file has graphic elements; text-on-icon overlap is not checked", hint: "reconvert the dumps with catscan boxes (Maestro iOS dumps have no element types)" }));
    }
    // TODO-049 D6, D17: occlusion is experimental; a run says once when it skipped panels or had none to check.
    const withPanels = loaded.filter((b) => b.elements.some((e) => e.panel)).length;
    if (withPanels && !opts.experimental) {
      writeErr(render.diagnosticLine({ code: "occlusion-experimental", message: `occlusion (text cut off by a panel) is experimental and was not checked on ${withPanels} image${withPanels === 1 ? "" : "s"} with panels`, hint: ["catscan", "--experimental", ...opts.argv].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ") }));
    } else if (loaded.length && !withPanels && opts.experimental) {
      writeErr(render.diagnosticLine({ code: "no-panel-elements", message: "no boxes file has panel elements; occlusion is not checked (Android and Maestro dumps name no panels)", hint: "catscan boxes xcuitest <dump> --image <screen.png> > <screen.boxes.json> (or playwright)" }));
    }
  }
  // TODO-073: fit's profile, orientation and boxes; run-level warnings are always shown (D18).
  let fitRun = null;
  if (opts.command === "fit") {
    try { fitRun = fit.build(opts, list); } catch (e) {
      if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return render.EXIT.usage; }
      throw e;
    }
    for (const w of fitRun.runWarnings) writeErr(render.diagnosticLine(w));
  }
  // TODO-054: contrast's boxes, allow list and device scale per input (D6, D7, D27).
  let contrastRun = null;
  if (opts.command === "contrast") {
    try { contrastRun = contrast.build(opts, list); } catch (e) {
      if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return render.EXIT.usage; }
      throw e;
    }
  }
  // TODO-074 "Base pairing": base-locale screens run first and return their rows (D9); each target carries its base's.
  let wrapPlan = null;
  if (fitRun?.wrap) {
    try { wrapPlan = fit.wrapPlan(opts, list, mapping.inputs, mapping.layout); } catch (e) {
      if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return render.EXIT.usage; }
      throw e;
    }
    for (const w of wrapPlan.warnings) writeErr(render.diagnosticLine(w));
  }
  if (opts.pseudo) {
    try { pseudo = untr?.pseudo ?? trunc?.pseudo ?? pseudoField.build(null, opts); } catch (e) {
      if (e instanceof args.UsageError) { writeErr(render.diagnosticLine(e)); return render.EXIT.usage; }
      throw e;
    }
  }
  const extraWarnings = new Map(); // request id -> warnings the CLI adds to its envelope
  let stdinError = null;
  const requests = list.map((inp, i) => {
    const req = { id: String(i), command: opts.command };
    if (inp.stdin) {
      try { req.image = inputs.readStdin().toString("base64"); } catch (e) {
        if (!(e instanceof client.CatscanError)) throw e;
        stdinError = e;
      }
      req.name = "-";
    } else req.path = inp.path;
    const mapped = mapping.inputs[i];
    // TODO-039 D12: a pseudo locale (en-XA, ar-XB) is read as en; pseudo text is Latin.
    if (mapped.locale) req.locale = opts.pseudo ? pseudoField.ocrLocale(mapped.locale) : mapped.locale;
    if (opts.fallback) req.fallback = opts.fallback;
    // TODO-038 T1: the core builds the text record from the lines it reads anyway.
    if (opts.textRecord !== "none") req.text_record = { mode: opts.textRecord || "full", ...(ignore ? { ignore: ignore.patterns, ignore_digest: ignore.digest } : {}) };
    if (opts.command === "check") {
      req.present = [...opts.present];
      req.absent = [...opts.absent];
      if (expect && !inp.stdin) {
        const c = expectFile.checksFor(expect, expectFile.relativeTo(inp.arg, inp.path, inp.argIsDir));
        req.present.push(...c.present);
        req.absent.push(...c.absent);
        c.keys.forEach((k) => usedKeys.add(k));
      }
      if (opts.allKeys) req.inventory = catalog.inventory(cat);
      if (req.present.length + req.absent.length === 0 && !opts.allKeys) unchecked.add(req.id);
    }
    if (video) {
      req.present = [...opts.present];
      req.absent = [...opts.absent];
      for (const k of ["every", "from", "to"]) if (opts[k] !== null) req[k] = opts[k];
      if (opts.frames) req.frames = true;
      // Ranges apply to every video of the run (spec 07 D7).
      if (expect) req.ranges = expect.ranges.map((r) => ({ key: r.key, start: r.start, end: r.end, present: r.present, absent: r.absent }));
      // An empty ranges: file sends no check at all; say so instead of passing silently (spec 07 review).
      if (req.present.length + req.absent.length + (req.ranges || []).reduce((n, r) => n + r.present.length + r.absent.length, 0) === 0) unchecked.add(req.id);
    }
    if (opts.command === "formats") req.formats = opts.formatsField;
    if (opts.command === "overlap") {
      const o = {};
      if (opts.minOverlap !== null) o.min_overlap = opts.minOverlap;
      if (overlapAllow) o.allow = overlapAllow;
      const { boxes: b, looked } = overlapBoxes(inp);
      if (b && opts.experimental) o.occlusion = true; // TODO-049 D11
      o.stacked = true; // TODO-067 D22, D31: default-on, with or without boxes
      if (!b && !looked && !opts.experimental) o.geometry = false; // D17: plain overlap runs stacked only
      if (b) o.boxes = b;
      else if (looked && !opts.experimental) o.no_boxes = { looked }; // D3: the core reports overlap-no-boxes (exit 4)
      else if (looked) {
        const w = looked === "-"
          ? { code: "boxes-missing", message: "no boxes for - (stdin has no path to find a sidecar by); checked with the OCR-only overlap reader", hint: "pass the image as a file, or --boxes <file> for it" }
          : { code: "boxes-missing", message: `no boxes for ${inp.path} (looked for ${looked}); checked with the OCR-only overlap reader`, hint: `catscan boxes <source> <dump> --image ${inp.path} > ${looked}` };
        extraWarnings.set(req.id, [w]);
      }
      if (Object.keys(o).length) req.overlap = o;
    }
    if (contrastRun) {
      const c = contrastRun.forInput(inp);
      req.contrast = c.field;
      if (c.warnings.length) extraWarnings.set(req.id, c.warnings);
    }
    if (fitRun) {
      const f = fitRun.forInput(inp, mapped.device);
      req.fit = f.field;
      if (f.warnings.length) extraWarnings.set(req.id, f.warnings);
      if (wrapPlan && req.fit.wrap) {
        Object.assign(req.fit.wrap, { base_locale: wrapPlan.baseLocale });
        if (wrapPlan.roles[i].base) req.fit.wrap.element_rows = true;
      }
    }
    let dynamicRects = null, dynamicSize = null;
    if (trunc) {
      const t = trunc.forInput(inp);
      if (!boxesOnly) req.truncated = t.field;
      if (t.field.boxes) {
        dynamicRects = t.field.boxes.elements.filter((e) => e.dynamic).map((e) => e.box);
        dynamicSize = [t.field.boxes.image.width, t.field.boxes.image.height]; // the core drops rects for another aspect
      }
      if (t.warnings.length) extraWarnings.set(req.id, t.warnings);
    }
    // D32 as for untranslated: the first request carries the catalog, the core caches it by digest.
    if (pseudo) {
      req.pseudo = i === 0 ? { ...pseudo.field, digest: pseudo.digest } : { digest: pseudo.digest };
      if (dynamicRects && dynamicRects.length) Object.assign(req.pseudo, { dynamic_rects: dynamicRects, dynamic_size: dynamicSize });
    }
    // TODO-036 T4 (D50, D51): every catalog form on the first request, cached by digest; dynamic rects per image.
    if (untr?.uncatalogued) {
      const u = untr.uncatalogued;
      req.uncatalogued = i === 0 ? { ...u.field, digest: u.digest } : { digest: u.digest };
      if (dynamicRects && dynamicRects.length) Object.assign(req.uncatalogued, { dynamic_rects: dynamicRects, dynamic_size: dynamicSize });
    }
    if (mapped.warnings.length) extraWarnings.set(req.id, [...(extraWarnings.get(req.id) || []), ...mapped.warnings]);
    // D32: the first request carries the catalogs and their digest; the core caches them for the rest.
    if (untr) req.untranslated = i === 0 ? { ...untr.field, digest: untr.digest } : { digest: untr.digest };
    if (untr && i === 0 && req.image && req.image.length + untr.bytes > SERVE_LINE_BUDGET) {
      stdinError = new client.CatscanError("image-too-large", "the image on stdin and the untranslated catalogs together are over the 64 MB request limit", "pass a file path instead of -");
    }
    return req;
  });
  // Too large to send: an input error for the run (exit 4), never an internal failure.
  if (stdinError) { writeErr(render.diagnosticLine(stdinError)); return render.EXIT.error; }
  if (expect && expect.shots) {
    for (const s of expect.shots) {
      if (!usedKeys.has(s.key)) {
        writeErr(render.diagnosticLine({ code: "expect-key-unmatched", message: `the expect key ${JSON.stringify(s.key)} matches no input image`, hint: "check the key against the paths relative to the folder argument" }));
      }
    }
  }

  const verdicts = [];
  const envelopes = []; // for --results and coverage: { env, inp }
  // D19: with --baseline, --json lines wait for the comparison so each carries `change`.
  const deferJson = bl !== null && opts.format === "json";
  const jsonLine = (res, change) => {
    const { text, ...out } = res; // eslint-disable-line no-unused-vars -- the text record goes to the file, not stdout
    return JSON.stringify(change === undefined ? out : { ...out, change }) + "\n";
  };
  const seen = new Set();
  let internal = false;
  let server;
  try {
    server = new client.Server();
    await server.ready;
    const send = (r) => {
      const p = server.request(r);
      p.catch(() => {}); // a crash rejects every pending request; the loop below reports the first
      return p;
    };
    // TODO-074 D9: targets with a base wait for every base input, then go out in input order, so the catalog pairs
    // (cached by digest in the core) ride on the first request of each locale.
    const later = (i) => wrapPlan && wrapPlan.roles[i].baseIndex !== null && requests[i].fit?.wrap;
    const pending = requests.map((r, i) => (later(i) ? null : send(r)));
    if (wrapPlan) {
      const rowsOf = await Promise.all(pending.map((p, i) => (p && wrapPlan.roles[i].base ? p.then((res) => res.element_rows ?? null, () => null) : null)));
      // A base that errored or had no sidecar gives no rows: say so once, or its targets lose base evidence silently.
      const unread = [...new Set(requests.map((r, i) => (later(i) ? wrapPlan.roles[i].baseIndex : null)))].filter((b) => b !== null && !rowsOf[b]);
      if (unread.length) {
        const names = unread.slice(0, 3).map((b) => list[b].path ?? "-").join(", ") + (unread.length > 3 ? ", ..." : "");
        writeErr(render.diagnosticLine({ code: "wrap-no-base", message: `${unread.length} base screenshot${unread.length === 1 ? "" : "s"} gave no element rows (${names}; see ${unread.length === 1 ? "its" : "their"} own line); wrapped used only declared and control evidence on ${unread.length === 1 ? "its" : "their"} screens` }));
      }
      let lastDigest = null;
      requests.forEach((r, i) => {
        if (!later(i)) return;
        const b = wrapPlan.roles[i].baseIndex;
        r.fit.wrap.base = rowsOf[b];
        r.fit.wrap.base_path = list[b].path ?? null;
        const pairs = wrapPlan.pairs(mapping.inputs[i].locale);
        if (pairs) {
          r.fit.wrap.pairs = pairs.digest === lastDigest ? { digest: pairs.digest } : { digest: pairs.digest, entries: pairs.entries };
          lastDigest = pairs.digest;
        }
        pending[i] = send(r);
      });
    }
    for (const p of pending) {
      const res = await p;
      const id = res.id;
      if (!res.verdict) {
        // A protocol-level error for a request the CLI built itself is a bug.
        internal = true;
        writeErr(render.diagnosticLine(res.error || { code: "internal", message: "malformed response" }));
        continue;
      }
      delete res.id;
      if (contrastRun) contrast.enrich(res); // D23: the fix colour, in JSON and text alike
      delete res.element_rows; // TODO-074 D9: internal, never in the envelope
      if (untr) res.warnings.push(...untr.runWarnings); // every envelope says the rule was skipped (D27)
      if (extraWarnings.has(id)) res.warnings.push(...extraWarnings.get(id));
      if (mapping.inputs[Number(id)].screen !== null) res.screen = mapping.inputs[Number(id)].screen;
      res.device = mapping.inputs[Number(id)].device; // TODO-075: set on every envelope, null without the axis
      res.platform = results.platformOf(res.device);
      res.text_size = mapping.inputs[Number(id)].text_size; // TODO-076: null without the axis, which a cell reads as default
      // TODO-055: known findings are matched on the results-file path, so a run and its approval key alike.
      const km = kctx ? known.match(kctx, { ...res, path: results.privatePath(res.path, list[Number(id)].arg) }) : null;
      scale.annotate(res, opts.thresholds, km); // TODO-077 D8: the final verdict, before anything reads it
      if (render.isInternal(res)) internal = true;
      verdicts.push(res.verdict);
      envelopes.push({ env: res, inp: list[Number(id)] });
      // D15, D23: frame lines come before their envelope, and only with --frames.
      const samples = res.samples || [];
      delete res.samples;
      if (opts.format === "json") {
        const frames = samples.map((f) => JSON.stringify({ catscan: res.catscan, command: "video-frame", lines: f.lines, path: res.path, schema: 1, t: f.t }) + "\n").join("");
        if (deferJson) envelopes.at(-1).frames = frames;
        else process.stdout.write(frames + jsonLine(res));
      }
      // --format github prints only catscan-built lines, after the run (spec 15 D6).
      else if (opts.format === "text" && (!opts.quiet || res.verdict !== "pass")) process.stdout.write(render.renderText(res, { quiet: opts.quiet, knownFile: kctx && kctx.file }).join("\n") + "\n");
      const warnings = opts.quiet ? res.warnings.filter((w) => ALWAYS_SHOWN.has(w.code)) : res.warnings;
      const diags = [...warnings, ...(res.error ? [res.error] : [])];
      if (unchecked.has(id) && !res.error) diags.push({ code: "no-checks", message: `no check applies to ${res.path}`, hint: video ? "add --present/--absent or checks under an --expect range" : "add --present/--absent or an --expect key for it" });
      for (const d of diags) {
        const line = res.error === d ? render.diagnosticLine({ ...d, message: `${res.path}: ${d.message}` }) : render.diagnosticLine(d);
        if (!seen.has(line)) { seen.add(line); writeErr(line); }
      }
    }
  } catch (e) {
    internal = true;
    writeErr(render.diagnosticLine({ code: e.code || "internal", message: e.message, hint: e.hint || "this is a bug: report it" }));
    if (server) server.die(e);
  }
  // A throw below must not leave the serve process holding the CLI open.
  try { return await finishRun(); } finally { if (server && !server.exited) server.proc.kill(); }
  async function finishRun() {
  // spec 27: missing entries come after every input, on stdout and in the file (D14).
  // An input with no envelope (the core died) would read as a missing screenshot (D25).
  const complete = envelopes.length === list.length;
  const cov = results.coverage(envelopes.map((e) => e.env), complete ? exp : null, mapping.layout, opts.command);
  for (const m of cov.missing) {
    scale.annotate(m, opts.thresholds);
    verdicts.push(m.verdict);
    if (opts.format === "json" && !deferJson) process.stdout.write(jsonLine(m) + "");
    else if (opts.format === "text") process.stdout.write(render.renderText(m).join("\n") + "\n");
  }
  // Every report names inputs by their private path (spec 27 D9), in output order, missing entries last.
  const pairs = results.scrubPairs(opts.argv);
  const priv = [...envelopes.map(({ env, inp }) => results.privateEnvelope(env, inp.arg, pairs)), ...cov.missing];
  let written = true;
  // Built once for --results and --report (spec 18 D18); entries keep their object identity through the sort.
  // TODO-055: the known block (counts, gone rows) over the private envelopes, and the run-vs-approval warnings.
  let kb = null;
  if (kctx) {
    const kr = known.block(kctx, priv);
    kb = kr.known;
    const runInfo = { command: opts.command, argv: results.privateArgv(opts.argv), allow: allowDigest(opts.allow), axes: known.runAxes(priv), reader: known.runReader(priv), results: opts.results ?? null };
    for (const w of known.runWarnings(kctx, runInfo)) writeErr(render.diagnosticLine(w));
    for (const d of kr.drift) {
      const where = d.screen !== null ? `${d.device ? `${d.device}/` : ""}${d.text_size ? `${d.text_size}/` : ""}${d.locale}/${d.screen}` : d.path;
      writeErr(render.diagnosticLine({ code: "known-drift", message: `${where}: a new and an approved ${d.kind}${d.rule ? ` (${d.rule})` : ""} no longer found; probably the same finding read differently`, hint: `review it, then: catscan results known ${opts.results ?? "<results.json>"} --out ${kctx.file}` }));
    }
  }
  const runFile = complete && (opts.results !== null || opts.report !== null || bl !== null) ? buildFile(opts, envelopes, priv, cov, started, kb) : null;
  const baselineOk = !runFile || !bl || applyBaseline(runFile, bl, ignore && ignore.digest);
  if (deferJson) {
    const compared = runFile && runFile.baseline;
    envelopes.forEach(({ env, frames }, k) => process.stdout.write((frames || "") + jsonLine(env, compared ? priv[k].change : undefined)));
    for (const m of cov.missing) process.stdout.write(jsonLine(m, compared ? null : undefined));
  }
  const inputOf = new Map(envelopes.map(({ inp }, k) => [priv[k], inp]));
  const locate = (e) => {
    const inp = inputOf.get(e);
    if (!inp || inp.stdin) return { abs: null, tried: e.path ?? "-" };
    try { return { abs: fs.realpathSync(inp.path), tried: inp.path }; } catch { return { abs: null, tried: inp.path }; }
  };
  // The page is built (thumbnails included) before any file is written, so every file lands at the end together
  // and a run killed while thumbnails are made keeps all the previous files (spec 18 D10).
  let builtReport = null;
  if (complete && opts.report !== null) {
    // A page past V8's string limit (a huge run) fails the report alone, never the other files.
    try { builtReport = await buildReport(opts.report, runFile, opts, { root: process.cwd(), locate, request: (r) => server.request(r) }); } catch (e) {
      if (!(e instanceof RangeError)) throw e; // only the size limit is an output problem; anything else is a bug (exit 5)
      writeErr(render.diagnosticLine({ code: "report-write-failed", message: `cannot build the HTML report ${opts.report}: ${e.message}`, hint: "use --report-images link or a smaller --report-max-edge, or split the run" }));
    }
  }
  const reports = [
    [opts.results, "results-write-failed", null],
    [opts.report, "report-write-failed", "html"],
    [opts.junit, "report-write-failed", () => ["the JUnit file", ci.junit(priv)]],
    [opts.gitlabCodequality, "report-write-failed", () => ["the Code Quality file", JSON.stringify(ci.codequality(priv), null, 2) + "\n"]],
  ].filter(([f]) => f !== null);
  for (const [file, code, make] of reports) {
    if (!complete) {
      writeErr(render.diagnosticLine({ code, message: `the run ended before every input had a result, so ${file} was not written`, hint: "fix the internal error above and rerun" }));
      written = false;
    } else if (!make) written = writeResults(opts, runFile) && written;
    else if (make === "html") written = (builtReport !== null && writeBuiltReport(opts.report, builtReport)) && written;
    else {
      const [what, text] = make();
      try { results.writeAtomic(file, text, code, what, "check that the folder exists and is writable"); } catch (e) {
        if (!(e instanceof client.CatscanError)) throw e;
        writeErr(render.diagnosticLine(e));
        written = false;
      }
    }
  }
  if (server && !server.dead) await server.close();
  if (opts.format === "github") written = githubOutput(opts, priv, !complete, runFile ? runFile.baseline : null, kb) && written;
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  if (opts.format === "text" && runFile && runFile.baseline) process.stdout.write(baseline.summaryLine(runFile.baseline) + "\n");
  const below = envelopes.reduce((n, { env }) => n + (env.findings || []).filter((f) => f.gate === false && f.known !== true).length, 0);
  if (contrastRun) for (const w of contrastRun.runWarnings()) writeErr(render.diagnosticLine(w)); // D24: kept under --quiet
  if (opts.format !== "json") {
    if (contrastRun) process.stdout.write(contrast.summary(envelopes.map((e) => e.env)) + "\n"); // D29: kept under --quiet
    process.stdout.write(render.totalsLine(verdicts, seconds, video ? "video" : "image", { below, thresholds: opts.thresholds, known: kb }) + "\n");
    // TODO-055 D9: approved findings no longer found are named every run, with the command that tightens the file.
    if (kb && kb.counts.gone) process.stdout.write(`tighten: catscan results known ${opts.results ?? "<results.json>"} --out ${kb.file} --prune\n`);
  }
  if (!opts.quiet) writeErr(render.countsLine(verdicts));
  if (fitRun) for (const d of fit.afterRun(envelopes, fitRun.reasons)) if (!opts.quiet || d.code !== "device-no-zones") writeErr(render.diagnosticLine(d));
  const skipped = opts.failOnSkip ? (opts.command === "fit" ? fit.skippedLine(envelopes) : skippedLine(envelopes)) : null;
  if (skipped) writeErr(render.diagnosticLine(skipped)); // written directly, so --quiet never hides it (D3)
  const code = render.exitCode(verdicts, { internal, skipped: skipped !== null });
  if (!baselineOk && code !== render.EXIT.internal) return render.EXIT.usage; // the files are written without a baseline block
  return !written && code !== render.EXIT.internal ? render.EXIT.error : code; // D15
  }
}

module.exports = { main, SHORT_USAGE, HELP, HELP_BLOCKS, commandHelp };
