# Unit runner, task cache, gate cache, selection

## Task cache (turbo; nx is analogous)
Workspaces with no task runner (plain `npm run --workspaces`) run every package serially and uncached. Adding turbo or nx is a structural lever: measure the warm rerun against the serial run before proposing it, and count the config and CI changes it brings.
Rules that held after several reversals in one monorepo:
| Task | Rule |
| --- | --- |
| `typecheck` | TS project references (`composite`, `tsc -b`), depends on `^typecheck`, `outputs: ["**/*.tsbuildinfo"]` so a hit skips the re-check. Packages that run `tsc --noEmit` override `outputs: []`. |
| `lint` | depends on a no-op `topo` task (`topo` depends on `^topo`), `outputs: []`. |
| `test` | depends on `topo`; explicit `inputs` (`src/**`, `test/**`, `assets/**`, configs, `package.json`); `env` lists every variable the runner reads (`JEST_MAX_WORKERS`, ...) or turbo strips it; `outputs: []`. |
| `test:guard` | repo-wide scans in their own `cache: false` task that always runs. A test that reads another package's files moves into the owner package; a test that reads root files (workflows, root configs) goes to `test:guard` or lists the file as an explicit input. |
| `globalDependencies` | shared tsconfig, dependency rules, `.nvmrc`, workspace file. NOT root `package.json` if release tooling bumps its version every PR: it invalidated all 30 tasks. |

Why `topo`: without it an upstream source edit leaves dependents' test/lint cache green (stale green). Avoid `$TURBO_ROOT$/**` inputs: they ignore .gitignore and hashed 94,870 files including sibling outputs. Measured: cold 70 s (0 of 81 cached) vs warm 16.4 s (76 cached); later, with explicit inputs, warm full run ~22 s / 97 s CPU -> ~5 s / 25 s CPU.

Put the cache outside the worktree (`--cache-dir ~/.cache/<repo>/turbo`) so a fresh worktree starts warm. Same for the Jest/Vitest transform cache, keyed by a hash of the lockfile (babel-jest keys entries by options, not preset code). Prune by age (14 days) and size (10 GB) before each run.

Metro / bundler transform caches: key them on the values of build-time env (`EXPO_PUBLIC_*`), or a warm cache ships stale flags. Keep a local check that flips a value and proves a miss.

## Gate result cache (pass-only)
Key = sha256 of: step, workspace tree hash plus its dependency workspaces and shared presets (docs and `*.md` excluded for code steps), root manifest and lockfile without the `version` field, runtime version and arch, listed env vars and hashes of env files, browser version for e2e steps, device toolchain (JDK, build-tools, each AVD config hash and system image) and target/scope flags for device steps. Write only passes, only if the key is unchanged at the end, by atomic rename. Never read on a release or with an off switch. A sliced run (`--only`, `-g`) neither reads nor writes the full key. Measured: 8 gate steps re-run on the same commit in 5.7 s.

## Workers
One budget for the machine: task concurrency N, test workers = max(1, floor(cores / N)), and never more than the runner's own default. On a loaded shared host, measure before lowering workers: fewer workers can cut CPU and still double wall time. Never `cores - 1` as a ceiling: on 2 vCPU it made the critical path 1.87x slower. Unbounded workers under a task runner reached 64 workers / ~25 GB on 10 cores. Validate env overrides.

## Changed-only runs (inner loop only)
- No task runner (plain npm, pnpm or yarn workspaces): map `git diff --name-only origin/main...` plus untracked files to workspace dirs, add every workspace that depends on them (from each `package.json`), and fall back to all workspaces for any path outside a workspace.
- `turbo --affected` / `nx affected` against `origin/main`, not local `main` (stale in a worktree).
- Jest `--changedSince` misses imports from other workspace packages and untracked files: whole package suite when the diff leaves the package or has untracked files.
- Unknown path means full mode. Print what still has to run (e2e, device, native).
- Ship metadata is not code: root `VERSION`, `CHANGELOG.md`, and a root `package.json` or lockfile whose only change is the root `version` select nothing; any other change in those two files is full mode.

## Test code
- Fake timers for toasts, debounces, holds. If modern fake timers hang a screen test, try `useFakeTimers({ advanceTimers: true })` before giving up. Keep immediates real and guard `clearImmediate` (Node 22 hung a worker otherwise). Fake timers around RN `StatusBar` hang the file on Node < 24.
- Test seams for long product timers: a debug env var for a one-day reminder, a hook that shortens an ad grace, a play clock moved past an interval.
- Assert once in loops (`expect(failures).toEqual([])`); lint selector on literal loop bounds of 1000+ (the inventory signal starts at about 100 cases), and the runtime assertion budget for constant bounds, `forEach` and helpers (`guards.md`). Measured 5.6 -> 0.6 s, 6.9 -> 0.06 s.
- One child process for many samples (ESLint, compilers): 30 s -> 10 s CPU.
- Speed up or memoize CPU-bound code under test; prove unchanged by an output digest.
- In polled `waitFor`, prefer assertions that do not dump the tree on each failed poll (`toBeOnTheScreen` over `toBeNull` in RNTL).
- Do not mask a flake with `--runInBand`; find the cause (one case: tests acted on controls drawn before they were enabled).
- An expensive environment (in-process Postgres via PGlite, ESM flags) gets its own runner config and its own job, never a global flag.
- Exclude agent worktrees (`.claude/worktrees/`) from test, module and watch paths.
- Timeouts are hang guards (test 60 s, RNTL `asyncUtilTimeout` 10 s in the shared preset), not speed budgets. After a worker-budget fix keep the hang guard; per-assertion timeouts raised for load may come back down.
- Find the next target with a report-only "tests over 1 s and transform share per workspace" script and `--cpu-prof` (one app was 75% transform time).
