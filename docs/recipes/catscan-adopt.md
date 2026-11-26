# Recipe: catscan-adopt skill

`catscan-adopt` is an agent skill that wires catscan checks into the tests a project already has.
It finds five kinds of adoption points: screenshots nobody checks, text checked through
pixel snapshots or by an agent opening the image, canvas or game text the DOM cannot see,
per-locale screenshot folders, and video a test or script renders or records. For each point it proposes the catscan surface that fits (CLI step,
[Playwright matcher](./playwright.md), [Maestro recipe](./maestro.md), [CI step](./ci.md),
[MCP and instruction file](./mcp.md)) as an exact diff, applies diffs only in batches you approve,
and proves each check with a mutation through capture: change the rendered text, delete stale
screenshots, rerun, see it fail; restore, see it pass.

It needs catscan on an Apple silicon Mac (macOS 15 or newer, Node 22 or newer).

## Checks it proposes

The skill asks the catscan it found which checks exist (`list-checks.mjs` reads catscan's finding registry), so
a newer catscan brings its new checks without a new skill. For each point it proposes every check the point can
feed: text present or absent (`check`), untranslated text, raw keys, placeholders and the wrong language
(`untranslated`), cut text (`truncated`), text drawn over text or controls (`overlap`), number, date and price
formats (`formats`), text under the camera cutout, a rounded corner or the home indicator, and wrapped labels
(`fit`), and contrast (`contrast`). A point gets a check only when it has the inputs that check needs (element
boxes, catalogs, a device profile, a storefront); the plan says which input a skipped check is missing.

Experimental checks (`fit`, `contrast`, `overlap --experimental`, uncatalogued text) are opt-in only. Each one is a
diff and a batch of its own, after the default ones, labelled with its measured precision, offered once per plan on
the point that feeds it best, and never where its measured real-data precision is 0. Each experimental diff applies
on the default diffs alone, so you can take one batch without another. It runs as a separate
step with `--min-certainty high` and its own results file, so its findings show in its results and report but never
fail your run; deleting that step turns it off. A default check whose measured real-data precision is 0, where it is
the only check a screenshot set can feed, is offered the same way, as its own opt-in batch.
Every default batch applies with only the batches it names as needed, in any combination, so you can take the
batches you want and leave the rest; a batch that needs one you declined waits until you approve that one.
Video a test or script renders or records, and store art with a title or tagline rendered per locale, are points
too. Where the skill cannot tell whether a script or a recording is run by your tests, it says "could not
determine, check by hand" and lists it under "Not examined" in the plan, never a guessed reason. The plan also names checks this skill version cannot place (update the plugin)
and checks your catscan is too old for (upgrade catscan).

To pick up new checks, update the plugin and run the dry run again; plans made earlier stay valid. The plan has one
row per check command, and each command no point uses gives its reason.

For CI the plan sets up gating on new findings only: after you review the first run, a batch approves today's
findings with `results known`, every check and finding-command step passes `--known` (`read` and `video` do not take it) so only new findings fail, a `--prune` batch follows
your fixes, and a step that always runs checks the files with `results validate`. On GitLab CI it proposes
`--gitlab-codequality`. Changed-only review with `--baseline` is offered as a review aid that never changes the exit
code. When your suite has no pseudo-locale build, the plan offers one as an opt-in batch (`catscan pseudo`, then
`untranslated --pseudo` and `truncated --pseudo`).

## Install

The skill ships in the `catscan` plugin with `screen-check`, `test-speedup` and `catscan-upgrade`; the plugin commands
are in the [test-speedup recipe](./test-speedup.md#install). In Claude Code run it as
`/catscan:catscan-adopt`, in Codex as `catscan:catscan-adopt`, or ask in plain words to wire catscan
into the tests. Other agents: copy `plugins/catscan/skills/catscan-adopt/` into the agent's skills
folder.

### catscan itself, before npm publish

The npm packages are not published yet. Until they are, build catscan once from a checkout and give
the skill its path:

```bash
npm ci
```

```bash
swift build -c release --package-path core
```

```bash
node <skill dir>/scripts/find-catscan.mjs --checkout <checkout>
```

A skill that runs from that same built checkout (the plugin installed from it) finds it without `--checkout`.

The diffs the skill proposes always name the published packages pinned to one version
(`npx @catscan/cli@<version>`, `@catscan/playwright`); the plan prints how to run the same commands
from the checkout and the install line `npm install -D <checkout>/packages/playwright`, which never
goes into a diff.

## Dry run

Ask for a dry run (or "report only") to see the plan without any change: the skill writes nothing in
your repository, not even its state folder, and runs git with `GIT_OPTIONAL_LOCKS=0` so the index is not
refreshed. You get the ranked adoption points and one diff per point, made against your last commit and
checked to apply together. Outside a dry run, state lives in `.test-speedup/` (kept out of git through
`.git/info/exclude`) and diffs are applied only after you approve each batch.

When your app ships a language catscan reads with Tesseract (Greek, Hebrew, Croatian and the others in
`catscan languages`) and this Mac lacks Tesseract or the language pack, the plan starts with setup point 00:
the install command (`brew install tesseract tesseract-lang`, about 650 MB), a CI step that runs
`catscan doctor --expect-locales` first, and the proof. A dry run only shows it. In apply mode the skill runs
that one Homebrew command after you approve it as its own batch (never `sudo`, never a shell profile), then
checks each of those locales on one of your screenshots.

## Before/after numbers

In apply mode, once a batch is green and every point has its mutation proof, the skill measures the
batch on each test layer it touches and prints one row per batch and layer:

- **Coverage:** what the layer checks over what it captures. Shots (CLI, Maestro and CI steps) count the
  distinct paths in the step's `--results` files over the images the run wrote; Playwright matcher tests
  count the passed tests that carry the added assertion. Tests and shots stay apart. Before is 0, or
  `by-eye` when a person read the shots.
- **Value:** first-run findings you marked real or false, expectation edits the batch needed to pass, and
  mutation proofs passed over points applied.
- **Cost:** median wall and CPU time of the layer command before and after, in two worktrees, with
  `measure.sh` (the same script test-speedup uses). The after count of tests must equal the before count
  plus the tests the batch adds, every before test keeping its result, or the timing is void.

Before measuring, the skill prints the command and an estimate; over 15 minutes it asks whether to run it
in full (3 runs per arm), quick (1 run, marked indicative) or not at all. The method is
`references/measure.md` in the skill folder.

The adoption fixture's batch (a Playwright matcher and a CLI step on two locales), measured in quick mode
on an Apple silicon Mac:

| Batch | Layer | Checked before | Checked after | Findings (real/false) | Edits | Proofs | Tests (before -> after) | Cost (after - before) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | e2e | 0 | 2/2 shots (de, en); 2 tests (de, en, declared) | 0/0 | 0 | 2/2 | 2 -> 2 (+0) | +8.04 s wall, +0.59 s CPU, indicative |
| **Total** | | 0 | 2/2 shots; 2 tests | 0/0 | 0 | 2/2 | | +8.04 s wall, +0.59 s CPU (1 timed row) |

- batch 1 e2e: indicative: 1 measured run per arm (quick mode), so the timing is indicative. Next: measure.sh -n 3 for a full row

Every report, dry run or apply, ends with one optional feedback line. The
[form](https://docs.google.com/forms/d/e/1FAIpQLSeqqnXm_qXNuXpBLJ0yEURjYK6mrt-XL_nxor4qMK8r00RwNA/viewform)
is anonymous and needs no sign-in; leave code, repository names and screen text out of the answers. The
skill never fills it in or sends anything itself.

## Scripts

`find-catscan.mjs`, `find-points.mjs` and `check-diffs.sh` are read-only for your repository and need only
Node and git. `adopt-metrics.mjs` writes only `.test-speedup/adopt/metrics.jsonl`.

### find-catscan.mjs

```
node find-catscan.mjs [--checkout DIR] [--project DIR]
```

Finds a usable catscan command line, in order: the checkout named by `--checkout`, the project's
`node_modules/.bin/catscan` (only with `--project`, since it runs the project's own binary), `catscan` on `PATH`, the checkout in `CATSCAN_CHECKOUT`, then the catscan checkout the skill itself sits in. A candidate counts
only when `doctor --json` reports `ok: true`. Prints one JSON line: `form` (`checkout`, `local`,
`global`), `from` (`flag`, `project`, `path`, `env` or `plugin`), `command` (argv), `version`, and `skipped[]` with the reason for each candidate passed over.
Exit 0 found, 1 none usable (with every reason and the setup link), 2 usage error. It never installs or
builds anything.

### find-points.mjs

```
node find-points.mjs <repo> [--rev REV] [--path DIR] [--all] [--catscan '<command JSON>']
```

Lists candidate lines from the committed tree at `REV` (default `HEAD`) with `git grep`, so uncommitted
edits change nothing (HTML, script, YAML, shell, Swift, Kotlin, Java, Python, Ruby and Dart files): screenshot calls (Playwright, Maestro, Detox, `simctl`, `adb screencap`, XCUITest,
fastlane), pixel snapshots, tests that hash rendered images against a golden, canvas and engine text objects,
scripts that write a canvas data URL to a PNG, video writers (`ffmpeg`, `adb screenrecord`, `simctl io recordVideo`,
Playwright video, Maestro `startRecording`), store art and image paths built from a locale variable,
agent files that say to open screenshots, and committed per-locale screenshot folders (a locale folder at any depth
with at least two locales, or a locale suffix in the file name). A screenshot path that ends in a locale token
(`sheet-ru.png`) counts as per-locale. Build output, vendored code and files over 1 MB are skipped.
`--path DIR` keeps only files under `DIR`, one app of a monorepo: its locales, catalogs and candidates.
Prints one JSON document: `head`, `dirty`, `path`, `counts` per kind and `groups` (kind, producer, folder, line
and file counts, up to 3 examples; all with `--all`; a `video` group always lists every line, since one file can
hold several recordings, and adds `run_by`, up to 3 test lines per producer
file that name it). A Playwright screenshot only attached to the test report, with no file path, gets producer
`report-attachment` in a group of its own that also lists every line, since no file is saved for a CLI step to read.
The agent opens the files before it calls a group a point. Exit 0, or 2 on a usage error.

With `--catscan` (the `command` array `find-catscan.mjs` printed, as JSON) it also lists the locales your
project ships: from catalogs (read by catscan's own `--expect-locales-from` discovery, `.arb` and `.po`
included), Playwright `locale`, fastlane `languages`, Maestro env and per-locale screenshot folders, each with
its source files. For each locale it asks `catscan doctor --expect-locales` which reader reads it on this Mac
and whether it works now. When a locale needs Tesseract that is missing here, `setup` holds setup point 00:
catscan's fix for your setup, the Homebrew command (none when `CATSCAN_TESSERACT` or `TESSDATA_PREFIX` is
set) and the doctor command that proves it. `code_catalog_templates` lists each JavaScript or
TypeScript catalog under an i18n folder that catscan reads, as the `--catalog` template to pass (`src/i18n/{locale}.ts`)
with its locales, spelled as in the path (`pt_BR`), since catscan puts the `--locale` value into `{locale}` as is; values it cannot read are skipped and counted in one `catalog-values-skipped` warning. `code_catalogs`
lists the locales whose only code catalogs catscan's reader rejects, each file with the reason. `catalog_warnings` names each
catalog whose locale cannot be told and those locales, with the fix (a plain object literal, or `<locale>.json`), and
`notes` each source it could not read; the skill copies each into the plan's setup notes, since a locale hidden there
gets no reader check. A code such as `it` or `id` counts as a locale when two siblings are locales.

### list-checks.mjs

```
node list-checks.mjs --catscan '<command JSON>'
```

Prints one JSON document (`schema: 1`, the catscan version as `catscan` and its `registry` id) with every check that
catscan runs: `commands` groups them per command and opt-in argv (`opt_in`, `experimental`), each check with
its `kind`, `rule`, the inputs it `needs` and its measured `precision` (synthetic and real, with flag counts).
A `--rules` opt-in is printed with the default rules it would otherwise replace.
`needs` maps each input to its flag. `not_proposable` lists kinds no check can be wired for, `unmapped` the kinds
this skill version cannot place, `missing_in_catscan` the checks this catscan is too old for, and `notes` a
registry that could not be loaded; each carries a `fix`. It loads catscan's own registry and option modules and
runs no catscan command. Exit 0, or 2 on a usage error.

### check-diffs.sh

```
bash check-diffs.sh <repo> <plan-dir> [rev]
```

Exports the tree at the plan's commit (`<plan-dir>/commit`, else `HEAD`) as plain files through a scratch
repository that only reads your objects (export and filter attributes off), and applies
`<plan-dir>/diffs/*.diff` to those files in name order, so two diffs that touch the same file must also
apply together. Nothing is written in your repository, not even an object's timestamp. One `ok <diff> +added -removed sha256=...` line per diff. Then each
`NN-experimental-*.diff` is applied again on the default diffs alone; no two experimental diffs may touch the same
path. With `<plan-dir>/batches` (one line per default batch: `<name> <diff>... [after <batch>...]`), every
combination of batches is applied on the commit, each with the batches it names after `after`; batches that edit
no file in common cannot conflict, so combinations are tried inside each group of linked batches (at most 8 per
group). Without that file the last line says the batches are not proved. Exit 0 when all apply, 1 with a `FAIL`
line and its fix for the first diff that does not apply, an experimental diff that needs or shares a path with
another, a default diff numbered after an experimental one, a batch combination that fails or a malformed batches
file, 2 on a usage error.

### adopt-metrics.mjs

```
node adopt-metrics.mjs count|record|table ...
```

`count` prints one JSON line of coverage and findings from a run (`--stamp`, then `--shots` with
`--results`, and `--pw-json` with `--asserted` test titles and `--locale`; every input must be newer than the stamp); `record` appends one row from that
line, `measure.sh` stdout and its `--log` folder, reading test counts from Playwright, Jest, Vitest and
`node:test` summaries; `table` prints the rows as markdown with a totals row and one reason line per void,
skipped or indicative row. Exit 0, 2 usage (also an unknown metrics schema), 4 empty or unreadable input
naming the path, 5 internal error. Run it with no arguments for the full usage.

## Example

[`examples/adopt-fixture/`](../../examples/adopt-fixture/) is a canvas menu in two locales whose test
writes screenshots nobody checks. `test/adopt/fixture.test.js` applies the two edits the skill
documents for it, checks them with `check-diffs.sh`, proves each check red on a changed string and
green on the restored one, then measures the batch before and after into the table above.
