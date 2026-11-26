# Before/after numbers for an applied batch

Apply mode only: a dry run runs no tests, so its plan shows only each batch's estimate (step 4). Every
number comes from `node <skill-dir>/scripts/adopt-metrics.mjs`; never count shots, tests or findings by hand.

A row is one batch on one test layer of the inventory. A batch that touches two layers (an e2e matcher and
a CI step) gets one row per layer, and each row has its own measure run.

## What a row holds

- **Coverage:** what the layer checks, over what it captures, per surface. Before is 0; if a person read
  the shots before, pass `--before-note by-eye`.
  - Shots (CLI step, Maestro, CI step): checked = distinct `results[].path` the checks read in the run's
    `--results` files (an `error`, `unsupported` or `needs-reader` result is unchecked); captured = images the run wrote in
    the shot folder.
  - Tests (Playwright matcher, which writes no results file): checked = passed tests that carry an
    added catscan assertion. Tests and shots are never added into one number.
  - Locales: from the results' `locale`; for the matcher, the locales the batch's tests run, given as
    `--locale` (shown as declared).
- **Value:** first-run findings the developer marked real or false (Phase 4), expectation edits the batch
  needed to pass (allow entries, expect-file lines, assertion text), mutation proofs passed over points.
- **Cost:** median wall and CPU time per arm from `measure.sh`, the delta, and the delta as a share of the
  inventory's full-layer wall when the inventory measured it.

## Steps

1. **Only a green batch is measured.** Its first run, findings and proofs are done (Phase 4).
2. **Revisions and worktrees.** Commit the batch on the branch the developer named: that commit is
   `<batch-rev>`, its parent `<base-rev>`. Then, from the repo root, with `<n>` the batch number:

   ```bash
   git worktree add --detach ../<repo>-adopt<n>-before <base-rev>
   git worktree add --detach ../<repo>-adopt<n>-after <batch-rev>
   ```

   The `-adopt<n>-` names keep them apart from test-speedup's `-ts<n>-` worktrees. Run the setup steps
   (install, build) in both.
3. **Commands.** Before = the layer command from the inventory, narrowed to the batch's touched test files
   when the runner takes file arguments (`playwright test tests/menu.spec.ts`, `jest a.test.js`). After =
   the same command, then every catscan step the batch adds, joined with `&&`, the way CI runs them. A
   step that runs only in CI is left out and recorded with `--local-na "<step>"`.
   On a Playwright layer give both arms the JSON reporter by flag, never by editing the config:
   `--reporter=list,json` with `PLAYWRIGHT_JSON_OUTPUT_FILE=<plan>/pw-<arm>.json` in front of the
   command. An older Playwright (`npx playwright --version`) that writes no such file takes
   `PLAYWRIGHT_JSON_OUTPUT_NAME` instead; check the file exists after the coverage run. The list reporter
   keeps the summary line that `record` reads.
4. **Estimate first.** Print the measure command and its estimate: 2 arms x (runs + 1 warmup) x the
   narrowed command's wall (from the inventory, or one timed run of the after command). Over 15
   minutes, ask the developer: full (`-n 3`), quick (`-n 1`, the row is marked indicative) or skip cost
   (coverage and value only). The plan shows the same estimate per batch, or "unknown until apply" when
   the inventory has no wall; a dry run never runs a probe.
5. **Coverage run** in the after worktree. Empty each shot folder the layer writes, touch a stamp, run the
   after command once, then count (shots and tests flags only for the surfaces the row has):

   ```bash
   touch <plan>/stamp-<n>
   node <skill-dir>/scripts/adopt-metrics.mjs count --shots <shot folder> --stamp <plan>/stamp-<n> \
     --results <results file> --pw-json <plan>/pw-after.json --asserted "<test title>" --locale de \
     > <plan>/count-<n>-<layer>.json
   ```

   `--results` and `--asserted` repeat, once per file and per test that got a catscan assertion (the
   title as the report shows it, `<describe> > <test>`). Checked shots are the distinct paths the checks
   read; an `error`, `unsupported` or `needs-reader` result is counted as unchecked. Exit 4 names the empty, stale or
   unreadable input: no image newer than the stamp, a results file or report older than the stamp, or a
   results file with no entry, means the run did not write what the batch checks. Fix the run, never
   record a 0/0 row.
6. **Cost run.** Before is arm A, after is arm B, from the repo root:

   ```bash
   bash <skill-dir>/scripts/measure.sh --log <plan>/logs-<n>-<layer> \
     before@<base-rev>:warm "cd ../<repo>-adopt<n>-before && <before command>" \
     after@<batch-rev>:warm "cd ../<repo>-adopt<n>-after && <after command>" > <plan>/measure-<n>-<layer>.txt
   ```

   Exit 3 means a run failed: the timing is void. Make both arms green and run again; never pass
   `--allow-fail`. GPU rules hold in both arms (Chromium `--use-angle=metal`, emulators `-gpu host`).
7. **Record the row**, in the repo root (it appends to `.test-speedup/adopt/metrics.jsonl`):

   ```bash
   node <skill-dir>/scripts/adopt-metrics.mjs record --batch <n> --layer <layer> --points 01,02 \
     --count <plan>/count-<n>-<layer>.json --measure <plan>/measure-<n>-<layer>.txt \
     --log <plan>/logs-<n>-<layer> --added <tests the batch adds> \
     --real <n> --false <n> --edits <n> --proofs <passed>/<points> [--layer-wall <s>]
   ```

   `record` reads the test counts from the run logs (Playwright, Jest, Vitest, `node:test`) and checks
   that after = before + the tests the batch adds (named in the plan), and that every before test keeps
   its result; otherwise the row is void with the reason. `--added` counts test runs: on Playwright, the
   new tests times the projects that run them. Recording a batch and layer again replaces its row. Exit 4 on a log it cannot parse: read the
   counts in that log and pass `--tests-before N --tests-after N` instead of reading them. Skipped cost:
   `--no-cost "<reason>"` in place of `--measure` and `--log`.
8. **Table:** `node <skill-dir>/scripts/adopt-metrics.mjs table` prints one row per batch and layer, a
   totals row, then one line per void, skipped or indicative row and per CI-only step, each with its
   next step. Put it in the report as printed. Each row measures its own narrowed command, so the totals
   are sums of rows: two batches that run the same test files count those shots in both rows.
9. **Clean up** the two worktrees (`git worktree remove`) after the table is in the report.

## Exit codes of adopt-metrics.mjs

0 ok; 2 usage (the usage line follows), also an unknown `schema` in the metrics file: delete it and
record each batch again; 4 input unreadable or empty, naming the path; 5 internal error with the stack.
Every error line ends with the next step.
