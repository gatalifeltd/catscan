# Guards: make the gain a failing test

| Gain | Guard |
| --- | --- |
| No fixed waits | Ratchet: a JSON file with a count per file of `sleep`, `waitForTimeout`, `setTimeout`, `setInterval`, Maestro `optional: true`. The JSON baseline is committed; the guard compares the current counts with it, and a PR may only lower it; renamed imports count. A justified wait carries `fixed-wait: <why>` and is excluded. |
| No slow real waits in unit tests | Ratchet on `waitFor` timeouts over 1000 ms and real sleeps outside fake timers. |
| GPU rendering | Every launch site, not only Playwright configs: `gpu-guard.mjs` in the project's check command, the renderer smoke spec (`web-e2e.md`) and the GPU rule in the agent instructions; see GPU guard below. |
| Config shape | Test that each e2e config uses the shared poll helper, free ports, worker count and the long-spec project. |
| One launcher | Test that no file outside the launcher boots a device. |
| Virtual clock | Lint test: every wall-clock read in app code has a `real-clock:` comment; real-clock specs are listed. Plus one clock-proof spec per app. |
| Assert once in loops | Lint selector against `expect` inside loops with large literal bounds, plus the runtime assertion budget for what lint cannot see (a constant bound, `forEach`, a helper); see Assertion budget below. |
| Cache hits | A warm rerun of the full suite must report all tasks cached (run in the PR, quote the number). |
| CI shape | A test that parses the workflow files and asserts the triggers, `concurrency`, `timeout-minutes`, install steps per job and required-check names the lever set. |
| Cache invalidation | A test that edits one real input of a cached task (a source file, a fixture, an env var listed in the key) in a temp copy or worktree, or restores it in a `finally` and checks `git diff --exit-code`, runs serially, and asserts a miss; each excluded path is shown unread by the skipped tests. A hit test alone does not prove the cache safe. The probe must change a file the task really reads (check with `tsc --listFiles` or the tool's equivalent: a package may resolve `index.d.cts`, not `index.d.ts`); under `skipLibCheck` an error inside a declaration file never fails `tsc`, so break a type that a source file uses. |

Ratchet file shape: `{ "path/to/file.spec.ts": 3, ... }`. The guard recomputes counts, fails if any file rose or a new file appeared with a count, and prints the command to lower the baseline when counts fell. When experiments built in parallel each lower the baseline, the second cherry-pick conflicts on it: take either side, then regenerate the baseline on the combined tree and commit it.

## GPU guard

`<skill-dir>/scripts/gpu-guard.mjs` (Node built-ins only) lists every launch site that bypasses the
helper: Playwright configs, `chromium.launch()`, `launchPersistentContext`, `launchServer`,
`_electron.launch()` and puppeteer calls in specs, scripts and tools (JS/TS, shell, YAML,
`package.json`, Makefiles, extensionless `#!` shell and Node scripts), a file that boots an AVD without
`-gpu host` (checked per file: one `-gpu host` clears the file), every CPU renderer flag or committed
`E2E_GPU=swiftshader` (`--use-angle=swiftshader`, `--disable-gpu`,
`disableHardwareAcceleration()`, `-gpu swiftshader_indirect|guest|auto`, ...) and a missing renderer
smoke spec. Each finding line ends with its fix; exit 0 clean, 1 findings, 2 usage error.

1. Phase 0: run `node <skill-dir>/scripts/gpu-guard.mjs --root <project>`; each finding is a signal.
2. Lock: copy it into the project's tools (`cp <skill-dir>/scripts/gpu-guard.mjs <tools-dir>/`) and
   add `node <tools-dir>/gpu-guard.mjs` to the check or test command CI runs, so every agent and CI
   run the same line. `--helper NAME` (repeatable) names the project's helper or emulator flag
   constant; `--ignore PATH` only for fixtures that hold CPU flags as data. To refresh a copy, copy
   again; its header names the guard version.
3. Not detected, so list them in the inventory by hand: a generic `browserType.launch()`, a launch
   through a wrapper of another module, a Chrome binary spawned directly, a Playwright config whose
   helper covers one project but not another, emulator boots in Gradle, Fastlane or other languages,
   and `emulator @<avd>` boots.
4. Exemptions are the owner's: a `gpu-launch: <why>` comment on the site's line or the line above
   (in a Playwright config, anywhere: a WebKit-only config). Never add one yourself; list the site
   under "Needs the owner". The helper's env opt-out line is the standing exemption. The guard
   lists every exemption with its reason.
5. Agent rule: `node <skill-dir>/scripts/agent-rules.mjs --root <project> --gpu --gpu-helper <helper> --gpu-guard '<guard command>'`
   writes the GPU rule as a marked block into `AGENTS.md` (and `CLAUDE.md` when it exists and does not import
   `@AGENTS.md`; with neither file, ask the owner before creating one). The rule: every config, spec and script
   that renders or boots a device starts on the host GPU through `<helper>`, the CPU is never a default where a
   GPU exists, GPU-less CI uses the documented opt-out with the owner's comment, and `<guard command>` fails on a
   bypass. An older unmarked copy of the same text becomes the block; a rule in other words is reported for a
   hand merge. `--print-gpu` shows the block without writing.

## Assertion budget

`<skill-dir>/scripts/assertion-budget.cjs` (no dependencies) fails any test that makes more than 1000
`expect` calls (`ASSERTION_BUDGET` overrides), with the count, the cap and the rewrite in the message.
It reads `expect.getState().assertionCalls` after each test, so it catches loops lint misses. Lock is three parts:
1. Copy it, and for Vitest also `assertion-budget.vitest.mjs`, into the project's tools. List it in every
   config that runs tests (each workspace config, or the shared preset they all extend): Jest
   `setupFilesAfterEnv: ['<rootDir>/tools/assertion-budget.cjs']`, Vitest
   `test: { setupFiles: ['./tools/assertion-budget.vitest.mjs'] }`.
2. A config-shape test in the project fails when a config drops it, for example: read every
   `jest.config.*` and `vitest.config.*` the workspaces use and assert each names `assertion-budget`.
3. The rules: `node <skill-dir>/scripts/agent-rules.mjs --root <project>` writes one line into `AGENTS.md`,
   and into `CLAUDE.md` unless it imports `@AGENTS.md` (with neither, or a `CLAUDE.md` importing a missing `@AGENTS.md`, it exits 2: ask the owner), and the
   "Testing rules" section into `docs/testing.md` (`--doc` names another file), which the line points to.
   Always-loaded text stays one line. A rerun replaces both in place; `--check` exits 1 when either is
   missing or stale, so CI can run it. The script is the only copy of the text.

There is no per-test opt-out: a test that checks many cases collects its failures and asserts once.
`ASSERTION_BUDGET` changes the budget for the whole run and is the owner's call. An `expect` inside a
`waitFor` or retry callback counts on every retry: throw there and assert once after the wait. Not covered:
Jest `test.concurrent` (its `afterEach` does not see those tests), the global `expect` in a Vitest
concurrent test (`test.concurrent`, `describe.concurrent` or `sequence.concurrent: true`; only its context `expect` is counted), `node --test` (no counter; rely on the lint
selector) and Playwright `expect` in e2e specs.

