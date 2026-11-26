# catscan in CI

catscan needs a Mac with Apple silicon (M1 or later): Vision exists only on macOS. Other jobs of a pipeline can run on Linux and depend on the macOS job. Ready-to-copy files are in [`examples/ci/`](../../examples/ci/); each names at its top what to replace and the minimal first-green command.

**Last reviewed:** 2026-11-10. Runner names, hardware, plans and prices change; this page is re-checked before each minor release.

## Supported hardware

- **Supported:** any Mac with Apple silicon, M1 or later, physical or virtual.
- **Not supported:** Intel Macs (including Intel-only hosted macOS images), Linux and Windows.
- **Measured:** an Apple M5 (physical) and GitHub's standard `macos-15` runner (time, Neural Engine evidence and identical answers in [`docs/BENCHMARKS.md`](../BENCHMARKS.md#ci-hosts)); `macos-15` and `macos-26` report `Apple M2 Pro (Virtual)` and host class `vm`, and `npm test` passes on `macos-26` with per-host goldens.
- **On a hosted VM Core ML lists no Neural Engine:** Vision runs on the CPU and a paravirtual GPU, about 10x slower per image than an M5, with the same check accuracy on the benchmark subset.
- **Every result records its host** (`host.chip`, `host.host_class`), and `catscan doctor --json` adds the CI service (`ci`) and `neural_engine`, so a number is never quoted without the machine it came from.

## Runners

| Service | Apple silicon option | How to select | Example | Status |
| --- | --- | --- | --- | --- |
| [GitHub Actions](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) | `macos-15`, `macos-26` (3 vCPU, 7 GB; documented as M1, the VM reports `Apple M2 Pro (Virtual)`); [`macos-15-xlarge`, `macos-26-xlarge`](https://docs.github.com/en/actions/reference/runners/larger-runners) (M2, 5 vCPU + 8 GPU, 14 GB, paid) | `runs-on` | [`github-actions.yml`](../../examples/ci/github-actions.yml), [`github-actions-sharded.yml`](../../examples/ci/github-actions-sharded.yml) | community-tested; catscan itself is measured on `macos-15` and runs `npm test` on `macos-26` |
| [GitLab CI (hosted)](https://docs.gitlab.com/ci/runners/hosted_runners/macos/) | `saas-macos-medium-m1` (4 vCPU, 8 GB), `saas-macos-large-m2pro` (6 vCPU, 16 GB); images `macos-15-xcode-16`, `macos-26-xcode-26` | `tags` and `image` | [`gitlab-ci.yml`](../../examples/ci/gitlab-ci.yml) | community-tested |
| [CircleCI](https://circleci.com/docs/guides/execution-managed/using-macos/) | `m4pro.medium`, `m4pro.large` (the M1 and M2 classes reached end of life on 2026-02-16) | `resource_class`, `macos.xcode` | [`circleci.yml`](../../examples/ci/circleci.yml) | community-tested |
| [Bitrise](https://docs.bitrise.io/en/bitrise-platform/infrastructure/build-machines/build-machine-types.html) | machine types `g2.mac.medium` and larger (M2 Pro or M4), on an Xcode stack | stack and machine type | [`bitrise.yml`](../../examples/ci/bitrise.yml) | community-tested |
| [Codemagic](https://docs.codemagic.io/knowledge-codemagic/machine-type) | `mac_mini_m2` | `instance_type` | [`codemagic.yaml`](../../examples/ci/codemagic.yaml) | community-tested |
| [Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/agents/hosted) | Microsoft-hosted macOS images are Intel (the arm64 preview is paused for new organizations), so use a self-hosted Apple silicon agent | `pool` | [`azure-pipelines.yml`](../../examples/ci/azure-pipelines.yml) | community-tested |
| Self-hosted runner on a physical Mac (GitHub, GitLab, Buildkite, Jenkins) | any M-series Mac, such as a Mac mini | runner labels or tags | the files above with your labels | recommended for performance gates |

"Community-tested" means no run of the example file on that service is recorded yet (the GitHub examples get one from the self-test below once it runs); the file parses and pins the current release. Report a run, or a fix, in an issue.

## Reports

| Option | Output | Consumed by |
| --- | --- | --- |
| `--format github` | up to 10 `::error` annotations, then a line counting the rest; a job summary in `$GITHUB_STEP_SUMMARY` (with `--baseline`, also the cells to review) | GitHub Actions |
| `--junit <file>` | JUnit XML | GitLab (`artifacts:reports:junit`), CircleCI (`store_test_results`), Bitrise (Export test results, then Deploy to Bitrise.io), Codemagic (`test_report`), Azure (`PublishTestResults@2`), Jenkins, Buildkite |
| `--gitlab-codequality <file>` | GitLab Code Quality JSON | the merge request widget (`artifacts:reports:codequality`) |
| `--results <file>` | the results file ([`docs/results.md`](../results.md)); shards merge with `catscan results merge` | any CI, as an artifact |

Report files are written in addition to stdout, so one run gives console output and every report. The format details are in [`docs/cli.md`](../cli.md#ci-reports). The GitHub and GitLab examples also write the HTML report (`--report catscan.html`, [`docs/report.md`](../report.md)) and keep it as an artifact: download it and open it in a browser. It holds the screenshots, so keep the artifact short-lived.

- **What fails the job:** the exit code is 1 when a check failed or a finding gates. By default every finding gates. `--min-severity critical|major|minor` and `--min-certainty high|medium|low` let only findings at or above both levels gate ([Severity and certainty](../cli.md#severity-and-certainty)); failed checks and `missing` screenshots always gate. Under thresholds, JUnit lists the findings below them in `<system-out>` (the test case passes), Code Quality marks them `info`, and GitHub does not annotate them (the job summary lists them collapsed). Start with the defaults; raise `--min-certainty` only for a rule that is noisy on your screens.
- **Expected locales:** pass `--expect-locales-from <catalog folder>` (or `--expect-locales de,fr,ja`), so a locale whose screenshots never arrived fails the job instead of passing quietly.
- **Skipped checks:** pass `--fail-on-skip` to each `check` (each shard's, when sharded), so a catalog path that names no file, or a string with nothing checkable, fails the job instead of passing with nothing checked.
- **Pipes:** piping catscan into `head`, `grep -m1` or `jq` keeps catscan's exit code and report files ([`docs/cli.md`](../cli.md#exit-codes) says how `pipefail` reads it).
- **Thresholds in a sharded run:** pass the same `--min-severity` and `--min-certainty` to every shard and to `results merge`; the merge recomputes each `gate` from the stored severity and certainty, so the merged exit code follows the merge flags.
- **Shards:** run `check --results shard-<group>.json` per shard with no expectation flags, then `catscan results merge shard-*.json --expect-locales-from locales --out catscan-results.json` in a final job that runs even when a shard failed (`if: ${{ !cancelled() }}` on GitHub). A shard that never ran shows as missing.
- **Devices:** with a device dimension in the matrix (iOS and Android, or a small and a large phone), pass `--device <label>` to each shard's `check` and `--expect-devices ios,android` to the merge, so a device whose job never ran shows as missing. Give every job of one release the same `--build` and `--build-version`, and pin one catscan version for all of them ([Device axis](../results.md#device-axis)).

## Changed-only review

Between releases most screens keep their text. With `--baseline` the job compares each locale x screen cell with an approved run and names the cells to review ([`docs/results.md`](../results.md#changed-only-review)); under `--format github` the job summary adds the summary line and a table of those cells with their added and removed lines, capped like the failure table. Annotations, JUnit and Code Quality stay failures only: a change is not a test failure.

Two ready-to-copy recipes, [`github-actions-baseline.yml`](../../examples/ci/github-actions-baseline.yml) and [`gitlab-ci-baseline.yml`](../../examples/ci/gitlab-ci-baseline.yml), follow one pattern:

1. **Pull and merge requests** fetch the latest approved baseline (on GitHub, the newest release that has one) and run `check ... --baseline catscan-baseline.json`. Before the first approval there is none: catscan warns `baseline-missing`, every cell is `new`, and the job still runs.
2. **A release tag** is the approval: the tag job runs the same check, `catscan results baseline catscan-results.json --out catscan-baseline.json` (it refuses a run with error, needs-reader, unsupported, missing or ambiguous cells), and stores the file. It approves the run it makes on the tag commit, so tag a commit whose pull or merge request run was reviewed, with no screen change merged after it.
3. **To stop on changes**, add the commented `jq -e '.baseline.review.cells == 0' catscan-results.json` step; the exit code does not change by itself.

Where the baseline lives decides whether it survives until the next release:

| Store | Retention | Used by |
| --- | --- | --- |
| GitHub release asset | never expires; public in a public repository | the GitHub recipe (private repositories only) |
| GitHub Actions artifact | expires, 90 days by default (`retention-days`); a quiet quarter loses the baseline | not recommended for the baseline |
| GitLab generic package registry | kept until deleted or removed by the project's package cleanup policy; follows project visibility | the GitLab recipe |
| GitLab job artifact | expires (`expire_in`; the instance default is 30 days) | not recommended for the baseline |
| A commit in a private repository | kept with the history | any CI |

The baseline is only as trusted as its store: protect `v*` tags, keep GitHub's default workflow token read-only and limit GitLab package publishing to Maintainers, so a pull or merge request pipeline cannot replace it. The baseline holds normalized screen text: keep it where only the project can read it, never attach it to a public issue, and mask screens with credentials or personal data with `--baseline-ignore` (or capture them with test accounts). `--text-record digest` keeps no text, at the cost of the line diff.

## Adopting a new check on an existing product

A new check usually finds defects that shipped long ago. Approve them once and fail only on new ones ([`docs/results.md`](../results.md#known-findings)):

1. Run the check once with `--results catscan-results.json`, review the findings, then `catscan results known catscan-results.json --out catscan-known.json` and commit the file. Review its pull request like code: the diff is the approval record (a CODEOWNERS line helps).
2. Add `--known catscan-known.json` to the CI command. Exit 1 now means a new gating finding; known ones stay in the report and the results file with `known: true`.
3. After fixes, `catscan results known catscan-results.json --out catscan-known.json --prune` lowers the approved counts, so a fixed defect cannot come back silently. The run prints that command when approved findings are no longer found.

| Committed file | Answers |
| --- | --- |
| `catscan-baseline.json` (`--baseline`) | Did a screen's text change since the approved release? Never changes the exit code. |
| `catscan-known.json` (`--known`) | Which findings are approved legacy defects? Only new findings fail. |

Both flags work in one job. With shards, pass `--known` to every shard and again to `results merge` and `report`, so each shard is compared against the same file. Approve a shard on its own by running `results known` over its file only: the other shards' rows are kept.

## Node on the runner

catscan needs Node 22 or newer. The GitHub examples pin Node with `actions/setup-node`. On the other services the examples print `node --version` first:
- **GitLab** macOS images ship a Node through their toolchain; when it is older than 22, add `brew install node@24` (or use a Node version manager) before `npm ci`.
- **CircleCI, Bitrise, Codemagic:** their Xcode images carry a current Node; the same `brew install node@24` applies when it does not.

## Upgrading catscan

The CI pins move with the npm packages and the MCP config in one change, or `doctor` fails `version` on a
developer's Mac while CI runs another catscan. [Upgrade](upgrade.md) lists every place and has Renovate and
Dependabot groups for them.

## Security

- **No secrets:** the checks make no network calls, so the job needs no token. Only `catscan doctor` goes online: it asks npm for a newer version (skipped in CI, or with `--offline` or `CATSCAN_NO_UPDATE_CHECK=1`) and, for an npm-installed binary, macOS checks its notarization with Apple. The GitHub examples check out with `persist-credentials: false` and `permissions: contents: read`, and pin every action by commit SHA.
- **Reports contain screen text:** artifacts on a project can be downloaded by anyone with read access, and on a public project by anyone. The examples keep them for 7 days.
- **Untrusted screen text:** `--format github` escapes all OCR text, so a screenshot cannot issue workflow commands; the summary escapes Markdown; JUnit and Code Quality are XML- and JSON-escaped.

## Languages catscan reads with Tesseract

A project that ships `el`, `he`, `bg`, `sr`, `hu`, `fa`, `ka`, `hy`, `hr`, `sk`, `sl`, `lt`, `lv`, `et`, `mt`, `ga`, `is`, `mk`, `bs`, `be`, `cy` or `sq` (`catscan languages` lists them as `fallback_locales`) needs Tesseract on the macOS runner; hosted images do not have it. Each example has the install step commented out and runs `catscan doctor --expect-locales-from locales` before the check, which fails with the install command until the step runs. A smaller cached per-locale install: [`tesseract.md`](tesseract.md#ci).

## Performance gates

Hosted runners are shared virtual machines: run functional checks there and keep timing gates for a self-hosted physical Mac, where the Neural Engine is available and timing is stable ([`docs/BENCHMARKS.md`](../BENCHMARKS.md#ci-hosts)).

## Self-test

`.github/workflows/ci-examples.yml` (run by hand once per minor release, hosted `macos-15`) runs the GitHub example and the sharded example against a tag's packed tarballs, with one shard skipped on purpose; the merge must fail on its missing locale.
