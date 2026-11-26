# Recipe: test-speedup skill

`test-speedup` is an agent skill that makes a project's existing tests and CI faster and cheaper
without weakening what they prove. It needs no catscan binary and runs on macOS and
Linux.

## Install

Claude Code and Codex read the same `.claude-plugin/marketplace.json` in `gatalifeltd/catscan`,
so one repo serves both.

### Claude Code

```bash
claude plugin marketplace add gatalifeltd/catscan
```

```bash
claude plugin install catscan@catscan
```

Inside a session the same steps are `/plugin marketplace add gatalifeltd/catscan` and
`/plugin install catscan@catscan`. Third-party marketplaces do not auto-update; run
`claude plugin update catscan@catscan` for a new version.

### Codex

```bash
codex plugin marketplace add gatalifeltd/catscan
```

```bash
codex plugin add catscan@catscan
```

The skill then appears as `catscan:test-speedup`. For a new version run
`codex plugin marketplace upgrade catscan`. Checked with codex-cli 0.153.4 against a local
checkout (2026-11-03).

### ChatGPT

Skills in ChatGPT are for Business, Enterprise and Edu workspaces: zip
`plugins/catscan/skills/test-speedup/` and upload it under Skills, Create, Upload from your
computer. ChatGPT cannot reach your machine or run your tests, so there the skill can only do
the quick scan in report-only mode on a repository you upload; measuring needs an agent with a
shell (Claude Code, Codex). Not tried in a ChatGPT workspace yet.

### Other agents

Copy `plugins/catscan/skills/test-speedup/` into the agent's skills folder and run the scripts as
`bash <skill dir>/scripts/measure.sh`, `node <skill dir>/scripts/gpu-guard.mjs` and
`node <skill dir>/scripts/agent-rules.mjs`.

## Use

Ask the agent in plain words to speed up the test suite; in Claude Code you can also run
`/catscan:test-speedup`. The first result is a
quick scan (inventory plus three ranked levers with expected ranges) before any test runs. The
agent then asks which levers to measure. All state stays in `.test-speedup/` in your project, which
the skill keeps out of git through `.git/info/exclude`.

## measure.sh

```
measure.sh [-n RUNS] [--warmup N] [--allow-fail] [--log DIR] LABEL_A "CMD_A" [LABEL_B "CMD_B"]
```

`LABEL` is `name@revision:cold|warm`. Result lines are `key=value`:
`arm=A label=before@3f2a1c9:warm runs=3 wall_median_s=... cpu_median_s=... load=... status=ok`.
Exit 0 when every run passed, 2 on a usage error or unsupported platform, 3 when any run failed
(timings invalid). CPU covers the measured process tree; daemons such as emulators, simulators,
the Gradle daemon and Metro are not counted. `--log DIR` keeps each run's output as
`DIR/<arm>-<warmup|run>-<i>.log` so you can read the test counts; `DIR` must be a new folder that
does not exist yet.

## gpu-guard.mjs

```
node gpu-guard.mjs [--root DIR] [--helper NAME]... [--ignore PATH]... [--json]
```

Lists every place a project starts a browser or a device off the GPU: Playwright
configs and direct `chromium.launch()`, `launchPersistentContext`, `launchServer`,
`_electron.launch()` and puppeteer calls in specs, scripts and tools that bypass the shared helper
(`--helper`, default `gpuLaunchArgs`, repeatable), AVD boots without `-gpu host`, CPU renderer flags,
and a missing renderer smoke spec. One line per finding, `path:line: kind: what; fix: ...`, then
exemptions, skipped files and a summary; `--json` prints the same with a `fix` field. Exit 0 clean,
1 findings, 2 usage error. A site is exempt only through the owner's `gpu-launch: <why>` comment.
Node built-ins only: copy it into a project and run it from the check command
(`references/guards.md`, GPU guard). The helper template and the smoke spec are in
`references/web-e2e.md`.

## assertion-budget.cjs

A test setup file that fails any test making more than 1000 `expect` calls
(`ASSERTION_BUDGET` overrides): a loop with an `expect` inside, which lint misses when the bound is a
constant, a `forEach` or a helper. The failure names the count, the cap and the rewrite
(`expect(failures).toEqual([])` after the loop). Copy it into the project and list it in every test
config: Jest `setupFilesAfterEnv: ['<rootDir>/tools/assertion-budget.cjs']`; Vitest copies
`assertion-budget.vitest.mjs` next to it and lists `test: { setupFiles: ['./tools/assertion-budget.vitest.mjs'] }`.
There is no per-test opt-out; an `expect` inside a `waitFor` callback counts on every retry, so throw there
and assert once after the wait. Not covered: Jest `test.concurrent`, the global `expect` in a Vitest
concurrent test (`test.concurrent`, `describe.concurrent`, `sequence.concurrent`), `node --test`, Playwright `expect`.
Tested with Vitest 5.1.0 and Jest 30.5.2; the overhead on two real suites (Jest 29.7.0, Vitest 5.0.1) was
within noise.

## agent-rules.mjs

```
node agent-rules.mjs [--root DIR] [--doc PATH] [--gpu --gpu-helper NAME --gpu-guard CMD] [--check]
```

Writes one line into `AGENTS.md`, and into `CLAUDE.md` unless it imports `@AGENTS.md`, that points to
the "Testing rules" section it writes into `docs/testing.md` (lowest layer first and no duplicates, assert
once with the budget, no `pgrep` wait loops, fail-closed changed-only selection, long specs first and the
device-set lock, timeouts are hang guards). `--gpu` also writes the GPU rule as its own marked block into
the same instruction files, naming the launch helper and the guard command; an unmarked copy of the published
rule becomes the block, and a GPU rule in other words stops the run with nothing written (`--print-gpu` shows
the block to merge by hand). A rerun replaces all of them in place; `--check` writes nothing and exits 1 when
the line, the section or the block is missing or stale.
Exit 2 on a usage error, when neither file exists, or when `CLAUDE.md` imports a missing `@AGENTS.md`
(ask the owner which one the agents load).

## Development

`npm run skills:check` lints the plugin (marketplace and plugin manifests, frontmatter, size
caps, reference set, em dash, agent-specific variables, exec bits, every `measure.sh` copy
byte-identical, the one `catscan-adopt` feedback form line), checks the agent instruction
files (`screen-check`, the Cursor rule and the `AGENTS.md` snippet: under 60 lines, `.mdc`
frontmatter, one shared core block; see [`mcp.md`](mcp.md#instruction-files)) and runs the `measure.sh`, `gpu-guard.mjs`, `assertion-budget.cjs` and `agent-rules.mjs` tests (the
real-runner assertion-budget test is in `test:unit`, after `npm ci`), the `catscan-adopt` script tests
(`test/skills/adopt.test.mjs`; the fixture test `test/adopt/fixture.test.js` is in `test:playwright`)
and the evidence source map test (each entry in `results/skills/evidence-sources.json` names a
repo, a commit and references; an optional `shipped` block names a commit, a pull request and
references). Run `BASH_UNDER_TEST=/bin/bash npm run skills:check` on a
Mac to cover bash 3.2, and before a release check both agents install it:

```bash
claude plugin validate .
```

```bash
CODEX_HOME=$(mktemp -d) sh -c 'codex plugin marketplace add . && codex plugin add catscan@catscan'
```
