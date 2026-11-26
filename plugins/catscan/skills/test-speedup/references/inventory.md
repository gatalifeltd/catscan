# Inventory contract (schema 1)

`.test-speedup/inventory.md` is written by the agent in Phase 0 and read by every later phase and
by other skills that build on it. Columns are defined only here.

## Header (first lines, exact keys)

```
schema: 1
head: <full commit SHA from git rev-parse HEAD>
clean: yes|no   (no when git status --porcelain prints anything, untracked files included)
written: <ISO 8601 time>
```

Reuse the file only when `schema` is 1, `head` equals the current HEAD and `clean` is yes and the
tree is still clean. Otherwise rebuild it. A tree without git writes `head: none` and
`clean: unknown`, and is always rebuilt.

## Section: layers

One row per test layer found. Write `unknown` rather than guess.

| Column | What to record |
| --- | --- |
| layer | ci, unit, static (typecheck, lint, dependency rules), web-e2e, desktop-e2e (Electron), android-device, ios-device, screenshot-pipeline, native-build, other |
| runner | Jest, Vitest, XCTest, JUnit, Playwright, Cypress, Maestro, Detox, adb, xcodebuild, ... with version |
| start command | the exact command a developer runs, from package.json, Makefile or docs |
| device boot path | script or command that boots emulators or simulators; `none` |
| render path | per launch site, not per layer: gpu or cpu (SwiftShader, `-gpu auto` headless, no GPU args) or unknown; iOS simulators always draw through Metal on the host GPU (no flag, nothing to guard); per CI job also the host kind: physical Mac, Mac VM, Linux with or without a GPU (`devices.md`, Per environment) |
| fixed waits | count of `sleep`, `waitForTimeout`, `setTimeout` in tests, Maestro `optional: true`; skip 0 ms microtask flushes; count each call of a sleep helper, not its definition; mock-latency waits and one-frame yields (up to about 32 ms) count, the latter ranked low; a wait computed from a product timer counts unless it carries `fixed-wait:` |
| parallelism | workers, shards, task concurrency, and where each is set |
| cache | task cache (turbo, nx), transform cache, CI caches, and their keys |
| wall / CPU | last measured median, or `not measured` |
| runs in CI | yes, no, or which workflow and trigger |

## Section: signals

Each signal that fired, with `file:line`. Look for:
- fixed waits: `grep -rnE 'waitForTimeout|sleep\(|sleep [0-9]|setTimeout|optional: true'` in test and flow dirs and in custom runner libraries (device runners keep waits in `lib/`);
- CPU rendering at any launch site: run `node <skill-dir>/scripts/gpu-guard.mjs --root <project>` (`guards.md`, GPU guard); it covers Playwright configs, direct `chromium.launch()`, `launchPersistentContext`, `launchServer`, `_electron.launch()` and puppeteer in specs, scripts and tools, AVD boots without `-gpu host` and CPU flags; add by hand what it cannot see (a generic `browserType.launch()`, a wrapper from another module, a Chrome binary spawned directly);
- a fixed e2e port with `reuseExistingServer` set to anything but `false` (including `!process.env.CI`): parallel worktrees test each other's build; `--strictPort` on a fixed port does not fix it;
- task cache that never hits: `cache: false`, missing `inputs`, root-relative inputs, root `package.json` in global dependencies when release tooling bumps its version;
- worker oversubscription: test workers unset or `cores - 1` under a task runner that also runs tasks in parallel;
- CI cost: a per-job install matrix, `push` plus `pull_request` triggers, no `concurrency`, macOS runners;
- `expect` inside a loop over 100 or more cases: `for`/`forEach` over locales, keys, seeds or steps with an assertion inside; Jest or Vitest configs without the assertion budget (`guards.md`);
- a wait loop over `pgrep` or `ps | grep` in a script (`while`/`until` around either): it can match itself and never end; wait on a lock, a file or an exit code;
- agent instructions without the testing rules: `node <skill-dir>/scripts/agent-rules.mjs --root <project> --check`;
- a test that starts a tool process per case (ESLint, tsc, a CLI) instead of one process for all cases;
- every run tests everything: a monorepo with no changed-only or affected command for the inner loop (lever: changed-only inner loop), and separately CI that runs every package on every PR (lever: CI runs changed packages plus dependents, `ci-cost.md` Level 1); list both;
- caches inside the worktree (`node_modules/.cache`, `.turbo`, `.eslintcache`, `.expo/cache/eslint`; not Jest's default `cacheDirectory`, which is in the OS temp dir and shared) in a repo where agents or people work in many worktrees: each new worktree starts cold;
- a test that reads files outside its own package (root workflows and configs, another package, git state such as `merge-base`) while its task is cached by package inputs;
- polled assertions that dump the tree on every failed poll (`toBeNull()` inside `waitFor`);
- CI jobs that restore `node_modules` but leave tool caches cold (lint cache, Jest transform cache, tsbuildinfo);
- the test runner scans agent or user worktrees (`.claude/worktrees/`, `.worktrees/`) and runs duplicate suites;
- a CI path filter or size gate that fires on root `package.json` when release tooling bumps its version on every PR;
- device boots outside one launcher script (look for the emulator binary and `-avd` or `simctl boot` in any form, argument arrays included).

Every signal that fires becomes a lever in the full list, even when it is not in the top three.

## Section: screenshots and on-screen text

| Column | What to record |
| --- | --- |
| producer | `page.screenshot`, `toHaveScreenshot`, Maestro `takeScreenshot`, `simctl io screenshot`, `adb screencap`, store-shot pipeline |
| where | file:line or script |
| output dir | where the images land |
| checked by | pixel snapshot, an agent opening the image, nothing, other; `unknown` when a static read cannot tell |
| text kind | DOM, accessibility tree, canvas or game, image |

## Section: top levers

Three rows: lever, signal, reference file, expected range from `evidence.md` (write `no measured case` when evidence has no row).

## Section: all levers (Phase 2)

Every lever from every fired signal, ranked (write `no measured case` when evidence has no row): lever | layer | signal file:line | reference | expected range | effort (S, M, L) | needs owner (yes, no) | guard.
