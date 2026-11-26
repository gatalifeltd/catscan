---
name: test-speedup
description: Make a project's tests and CI faster and cheaper without weakening what they prove. Quick scan first, then measured before/after experiments per layer (CI, web e2e, emulators, simulators, unit), each gain locked by a guard test.
---

# test-speedup: same proof, less time and money

Speed up the tests a repository already has and prove the proof did not change. This skill does
not judge which tests are worth keeping; it makes the ones that stay cheaper. Runs on macOS and
Linux. On Windows, stop and say it is not supported.

`<skill-dir>` below is the directory that contains this SKILL.md; run the script as `bash <skill-dir>/scripts/measure.sh`. Paths starting with `.test-speedup/` are
in the project root.

## Iron rules

1. **Measure before you touch.** No change without a baseline taken the same way as the result.
2. **CPU time, not wall time, on a shared machine.** Record the load average next to every number.
3. **Never buy speed with proof.** Raising a timeout, deleting or skipping a test, weakening an assert, or counting a partial run as the full gate needs the owner's words. Prove a sped-up pure function unchanged with a digest of its outputs.
4. **Selection fails closed.** Changed-only runs are for the inner loop. An unknown path, an untracked file, or a diff that leaves the package means the full run. The release gate is always the full suite.
5. **Wait on state, never on time.** A fixed sleep is allowed only when the wait is the behavior under test, with a `fixed-wait: <why>` comment.
6. **Lock every gain** with a guard test or ratchet (`references/guards.md`).
7. **One lever per experiment.** Set the pass bar before the run; drop arms that miss it and record why.
8. **Retries and serial runs do not fix flakes.** Retry once only for named infrastructure errors.
9. **A cache lever needs an invalidation proof.** Mutate a real test input: the cache must miss. Show every excluded path is unread by the tests it skips.

## State and resume

In report-only mode or in a tree without git, write nothing to the project: put the inventory in
the report. Otherwise all state lives in `.test-speedup/` in the main checkout (the first `git worktree list`
entry, not an experiment worktree). On first use add `/.test-speedup/` to
`$(git rev-parse --git-path info/exclude)` (works from linked worktrees; never edit `.gitignore`). Files: `inventory.md`, `baseline-*.txt`,
`experiments.jsonl` (append-only, one JSON object per experiment: `schema`, `lever`, `layer`,
`rev_before`, `rev_after`, `cache`, `bar`, `before`, `after`, `runs`, `load`, `decision`
kept|reverted, `reason`, `guard`, `proof`; `before`/`after` are `{wall_median_s, cpu_median_s}` as `measure.sh` prints them; `schema` is 1). A new session reads these first and continues; it does not re-measure a recorded
baseline for the same revision and cache state. A schema version mismatch means rebuild.

## Phase 0: Quick scan (no suite run)

1. Reuse `.test-speedup/inventory.md` only if its header shows the current HEAD and a clean tree;
   otherwise rebuild it using the contract in `references/inventory.md`.
2. Output the inventory and the **top three levers** for this repo, each with the signal that
   found it, the reference that covers it, and the expected range from `references/evidence.md`.
   Dependencies may not be installed yet: a lever that depends on a tool's defaults (a wrapper
   that already caches, a runner's default workers) is marked `verify after install`.
3. Stop and ask which levers to measure. This report is the first result; aim for under 10 minutes.

## Phase 1: Baseline

Run `bash <skill-dir>/scripts/measure.sh` (when it may outlast the shell's time limit, in the background with `set -o pipefail;` first and `2>&1 | tee .test-speedup/baseline-<name>.txt`, `<name>` without `/`, so exit 3 survives the pipe) with the project's full local test command (or the layer's command; with no single command, chain the commands the CI jobs run):
interleaved runs, median wall and CPU, load average. Labels are `name@revision:cold|warm`. If load
is above 2x the core count, wait for it to drop if you can; otherwise use 5 runs, decided before
the first run. Never rerun a missed bar with more runs; if load changed, rerun the whole
comparison and report both results. CPU excludes daemons (emulator,
simulator, Gradle daemon, Metro); for device levers measure settle core-seconds as in
`references/devices.md`. Any failed run makes the timings invalid (exit 3): fix the command first.
CI levers are measured in billed minutes from the last runs (`gh run list` and job durations),
as `references/ci-cost.md` says, not with `measure.sh`. Without `gh` access, use timing comments
or docs and mark the number `[estimated]`.

## Phase 2: Pick levers

For the full list, read the reference of every layer the inventory found; for an experiment,
read only the reference of the layer you change:

| Symptom | Reference |
| --- | --- |
| CI minutes, billing red checks, slow required checks | `references/ci-cost.md` |
| Playwright, headless Chrome, Electron, any browser launch in scripts, canvas or WebGL | `references/web-e2e.md` |
| Emulator or simulator boots, service cleanup, jank, Maestro | `references/devices.md` |
| Unit runner (Jest, Vitest, node:test), static checks, task cache, workers, changed-only runs, gate cache | `references/unit-and-cache.md` |
| Making a gain stick | `references/guards.md` |
| What the inventory records | `references/inventory.md` |
| Expected gains from measured cases | `references/evidence.md` |

Write the full ranked list (`references/inventory.md`, "all levers"). Order: correctness levers
first, because they make later numbers valid (shared ports, stale cache inputs, a worker budget
whose overload made someone raise timeouts); then expected gain
per effort, cheapest proven first (GPU flags, polling interval, worker budget, CI triggers); then
structural ones (virtual clock, task runner, result cache, moving tests down a layer). When the
goal is billed CI minutes, never trade them for wall time (fanning out jobs costs more minutes).

Proof unchanged for an infrastructure lever (renderer, emulator flags, workers): the full suite
passes on the same tree in 3 runs with no new flake. Tightening a timeout is allowed; raising one
needs the owner.

## Phase 3: Experiment

1. State the bar first, for example "boot under 10 s, no new flake in 3 runs". Pick its metric by
   lever kind: removed waits move wall time of the affected files (CPU barely changes); compute
   and cache levers move CPU; parallelism levers must not raise either.
2. Per experiment `<n>`, with `<base-rev>` the user's branch HEAD now: `git worktree add --detach ../<repo>-ts<n>-before <base-rev>`
   and the same for `../<repo>-ts<n>-after`. Make the change only in the after worktree and commit it there (`<after-rev>`)
   before measuring. Copy dependencies (`cp -cR` on macOS APFS, `cp -R --reflink=auto` on Linux) unless they hold absolute
   paths (Python venvs, editable installs): reinstall those. Cache state for both arms: cold (the command points caches at a
   fresh empty dir on every run: write `\$(mktemp -d)` escaped in step 3's double quotes, or it expands once and runs 2+ are warm) or warm (`measure.sh` discards one warmup run).
3. `bash <skill-dir>/scripts/measure.sh --log .test-speedup/logs/ts<n>-<k> before@<base-rev>:warm "cd ../<repo>-ts<n>-before && <cmd>" after@<after-rev>:warm "cd ../<repo>-ts<n>-after && <cmd>"`
   (`--log` takes a new folder per call, `<k>` counting calls; in zsh write `${rev}:warm`: `$rev:warm` and `$rev:cold` are read as modifiers); both arms' logs must show the same test count (quote it), or the after arm ran less and the timing is void.
4. Keep (commit in the after worktree, cherry-pick onto the user's branch) or revert (drop that commit; never reset or
   clean the main checkout; a conflict on a ratchet baseline is regenerated on the user's branch, `references/guards.md`). Append the result to
   `.test-speedup/experiments.jsonl`, then `git worktree remove --force` both (the copied dependencies are untracked).
5. Flakes: rerun once on the same tree; a second failure is real.

## Phase 4: Lock

Add the guard from `references/guards.md` that fails when someone undoes the gain. The GPU lever's lock is three parts: `scripts/gpu-guard.mjs` copied into the project's check command, the renderer smoke spec, and the GPU rule in the project's agent instructions (`references/guards.md`, GPU guard). Every project also gets the testing rules (`scripts/agent-rules.mjs`) and, with Jest or Vitest, `scripts/assertion-budget.cjs` in every test config (`references/guards.md`, Assertion budget). For a cache lever, add the invalidation proof as a test, or as a script the PR runs when it is too slow for the unit suite. A gain without a guard is not done.

## Report

First the combined result: the user's branch with every kept lever against `<base-rev>`, the Phase 1 command and run count, one
interleaved `measure.sh` call. It is the number of record: per-lever numbers taken at other loads do not add up.
Then one line per lever: `lever | layer | before -> after (median wall / median CPU, load) | runs | revisions and cache state | guard | proof unchanged by`.
Then: what needs the owner, what was not measured, and which runs ran on a loaded machine.

## Needs the owner

Stop and ask before: changing required CI checks or branch protection, billing budgets, deleting
or skipping tests, raising timeouts, changing what the release gate runs, narrowing what a full device run covers (scenario
scoping), exempting a launch site from the GPU (a `gpu-launch:` comment), or making anything that writes outside the repo the default (shared caches in `~/.cache`, AVD snapshots, simulator templates).
