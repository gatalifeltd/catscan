# CI cost and speed

Goal: CI proves what a local run cannot (clean checkout, provenance, docs), cheaply. Two levels; pick by how much the team trusts the local gate. In a ranked list, give both: Level 1 levers as they are, Level 2 marked as needing the owner.

## Level 1: tests stay in CI, cheaper
| Lever | Why / trap |
| --- | --- |
| `on: pull_request` only; `push` to main dropped only if branch protection requires up-to-date branches or a merge queue (else it needs the owner); `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }` | With that rule a merge re-runs a checked commit; without it the merged result is never tested. Superseded pushes keep billing. |
| Setup job fan-out: one job restores `node_modules` keyed on `${os}-node<ver>-${hash(lockfile)}`, runs install only on a miss; lint, typecheck, test run in parallel on that cache | Key on the runtime too, or a cache from another Node version is restored. |
| Restore-only caches on PR jobs (`actions/cache/restore`), saves only from a scheduled warm | PR-scoped saves are unreachable from sibling PRs and fill the 10 GB LRU (`cache: pnpm` on PR jobs did exactly this). Restore-only needs a saver: with no scheduled warm and no push-to-main run there is no cache at all. Level 1 keeps the warm; Level 2 deletes both. |
| Changed packages plus dependents (`turbo --filter='...[origin/main]'`); lockfile, patch, workflow and root-script diffs keep the full gate | |
| Task concurrency set for the runner: `--concurrency=4` (turbo default 10) on 2 vCPU; escape hatch `TURBO_CONCURRENCY=2`, then `JEST_MAX_WORKERS=1` | A shared-package PR swapped the runner and ran ~7x slower. |
| Path filters computed in code when they need exclusions | `dorny/paths-filter` `!` exclusions OR-match and do not exclude. |
| Size and bundle gates not triggered by root `package.json` (needs the owner when the step sits inside a required job) when release tooling bumps its version on every PR | Saved 34 s + 83-147 s per PR. |
| `timeout-minutes` on every job | A hung job bills to the 6 h limit. |
| `permissions: contents: read`; actions pinned to a current major | Deprecated runtimes become failures later. |

## Level 2: CI as a cheap sanity job, the suite is a local gate
| Lever | Why / trap |
| --- | --- |
| Required checks are install-free jobs (pure Node or shell: provenance, version/changelog line, docs check, dependency rules) | A per-PR install + typecheck + test matrix cost ~9 min per PR (29 jobs in one repo) and stopped starting once the free allowance was spent. Result: ~1 min per PR. |
| Delete cache-warm workflows and caches that only served the jobs that left | Typical path: nightly full warm (~500 min/month) -> split into a nightly store seed + weekly test warm -> deleted with install-free CI. |
| macOS and device work local | macOS runners bill 10x Linux minutes; a 45 min run bills ~450 min. A hosted emulator smoke was added and removed within two days for cost. |
| Warn-only, zero-dependency docs gate | Catches drift without an install. |
| A local gate that records its result (see `unit-and-cache.md`, gate result cache) | CI green alone is no longer the gate; the PR body quotes the local gate. |

## Both levels
- GitHub-hosted Linux runners have 2 vCPU on private repos and 4 vCPU on public ones; size task concurrency and workers to that, not to a laptop.
- If no e2e or device job runs in CI, say so in the report: those layers are measured locally only.
- Merge sequential task-runner calls in one job into one call (`turbo run typecheck lint test`), and drop duplicate steps that run the same check twice.
- A job that installs dependencies but runs only node built-ins does not need the install.
- Path-filtered workflows and renamed jobs stay out of required checks: a required check that never reports hangs the PR.
- Budget with stop-usage + alerts at 90% and 100%. A job that fails in 2-5 s with "spending limit" is billing, not a test.
- `gh pr merge --auto` merges at once when repo auto-merge is disabled.
- Matrix jobs that all fail for one billing reason look like N test failures. Read the first job's log before debugging tests.
- Hosted runner with nested virtualization or a self-hosted Mac only after a measured local baseline; otherwise you pay to discover the same boot problems.

## Before and after
Before: job durations and billed minutes of the last 10 runs on the default branch or recent PRs (`gh run list`, `gh run view --json jobs`). After: the same for the PR that carries the lever, then the next 10 runs. Report medians.

## Bar
Billed minutes per PR and per month, required-check wall time, and every check meaningful when red.
