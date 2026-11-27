# Recipe: catscan MCP server

`@catscan/mcp` gives coding agents catscan's checks as MCP tools, so an agent confirms what a screenshot shows
from a verdict of about 60 tokens instead of loading the image. It runs over stdio on an Apple silicon Mac.

| Tool | Use it to |
| --- | --- |
| `check_text` | confirm texts are shown (`present`) or not shown (`absent`); `catalog` for `@key` texts, `expect` for a per-image file; `pseudo` matches them on a pseudo-locale build |
| `read_screen` | read the lines on a screen (`screen_text`, up to `max_lines`) |
| `find_truncation` | find cut-off text and text drawn past its element; `boxes_path` takes element boxes from `catscan boxes`, `reasons` limits the reasons reported; `pseudo` with the base `catalog` adds `pseudo-cut` |
| `find_untranslated` | find base-language strings, lines in another project language (`wrong-language`), raw keys and unfilled placeholders (`locale`, `base`, `catalog`, `allow`, `base_locale`, `kinds`, `languages`); with `pseudo` and the base `catalog` (no `base`), also `hardcoded` lines and `pseudo-not-applied`, `dynamic` takes regexes for lines never reported as hardcoded ([pseudo recipe](./pseudo.md)) |
| `find_overlap` | find text drawn over text or over an icon, image or control, and sheets drawn over each other; `boxes` takes element boxes from `catscan boxes` (an object for one image, or a file or folder), `allow` the element ids or texts never reported (`locale`, `min_overlap`); stacked text (pages drawn at one place, `signal: "stacked"`, no second line) is checked on every screen; without `boxes` only stacked text is checked, so a pass says nothing about text over icons or other elements |
| `find_format_errors` | find numbers, dates and times wrong for the locale, prices in a currency the storefront does not charge, and paywall prices that disagree with a price file (`locale`, `storefront`, `currency`, `prices`, `rules`, `allow`) |
| `find_fit_issues` | find text and icon buttons hidden under a phone's camera cutout, rounded corners or home indicator (`device_profile`, `orientation`, `boxes`, `reasons`); iOS screenshots match a profile by size, Android needs `device_profile`. With `boxes`, also a one-line label on two rows (`wrapped`) and a one-word last row (`orphan`, named in `reasons`); `base` and `base_boxes` give the en screenshot of the same screen and its boxes, read first (one screen per call, no layout pairing) |
| `check_video` | check texts over an MP4 or MOV recording, with `first_seen` and `last_seen` times (`present`, `absent`, `catalog`, `locale`, `every` sampling interval in seconds, `frames` adds each sampled frame's text, up to `max_lines`) |
| `compare_to_baseline` | compare a `--results` file with an approved baseline (`results`, `baseline`, `baseline_ignore`): `summary`, `counts`, `review` (`skip`, `denominator`), `ignore_digest` and the cells to review with their `diff`, up to `max_images`; it reads two files and no image ([`docs/results.md`](../results.md#changed-only-review)) |

Every tool but `compare_to_baseline` takes `path` (a file, or a folder up to `max_images`, default 50) and returns JSON text, never an
image. For a folder only failing results, and passes with a warning that something went unchecked, come back,
plus counts; `include_passing: true` returns all of them. A folder with more images than `max_images` replies
`over_cap: 1`: at least one more image went unchecked, so raise `max_images` or pass a smaller folder.
`catalog` takes any `--catalog` file, TypeScript and JavaScript catalogs included, and `{locale}` expands. The
screenshot tools (all but `check_video` and `compare_to_baseline`) take `fallback` (`tesseract` or `none`), as the
CLI's `--fallback`.

`check_text`, `find_truncation`, `find_untranslated`, `find_overlap`, `find_format_errors` and `find_fit_issues` take `min_severity`
(`critical`, `major`, `minor`) and `min_certainty` (`high`, `medium`, `low`), as the CLI's `--min-severity` and
`--min-certainty`: only findings at or above both levels fail an image; the rest stay in `findings[]` with
`gate: false`. Findings carry `severity`, `certainty` and `gate` and come sorted, worst first. A folder reply adds
`below_threshold: [{ path, count }]` for the images that pass only because their findings fall below the
thresholds ([severity and certainty](../cli.md#severity-and-certainty)).

The same six tools take `known`, the path of a `catscan-known.json` approved with `catscan results known`, as the
CLI's `--known`: a finding that matches an approved one comes back with `known: true` and `gate: false` and never
fails the image. A folder reply adds `known: [{ path, count }]` for the images with known findings. A missing file
is the warning `known-missing` and every finding is new; an invalid one is the error `known-invalid`
([known findings](../results.md#known-findings)). Agents pass it only when the user asked.

## Set up

Pin the server to the version of your other catscan packages. npm installs the catscan binary with it.

### Claude Code

```bash
claude mcp add catscan -- npx -y @catscan/mcp@1.0.4
```

### Cursor

`.cursor/mcp.json` in the project:

```json
{ "mcpServers": { "catscan": { "command": "npx", "args": ["-y", "@catscan/mcp@1.0.4"] } } }
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.catscan]
command = "npx"
args = ["-y", "@catscan/mcp@1.0.4"]
```

An unpinned `npx -y @catscan/mcp` runs whatever npm has that day, which can differ from the CLI your tests run.

A pinned server moves with the project's other catscan packages and pins: [Upgrade](upgrade.md).

## Instruction files

With the server installed an agent still opens a screenshot by habit. An instruction file tells it to ask catscan
first and when the image is really needed. The three files carry the same core text:

| Agent | File | Install |
| --- | --- | --- |
| Claude Code, Codex | [`plugins/catscan/skills/screen-check/`](../../plugins/catscan/skills/screen-check/SKILL.md) | the `catscan` plugin |
| Cursor | [`examples/agents/cursor/catscan.mdc`](../../examples/agents/cursor/catscan.mdc) | copy to `.cursor/rules/` |
| Codex without the plugin, any agent that reads `AGENTS.md` | [`examples/agents/AGENTS.md.snippet`](../../examples/agents/AGENTS.md.snippet) | paste into the project's `AGENTS.md` |

The plugin does not start the MCP server; set that up as above.

**Claude Code:**

```bash
claude plugin marketplace add gatalifeltd/catscan
```

```bash
claude plugin install catscan@catscan
```

The skill is `catscan:screen-check`. Update with `claude plugin update catscan@catscan`.

**Codex:**

```bash
codex plugin marketplace add gatalifeltd/catscan
```

```bash
codex plugin add catscan@catscan
```

Update with `codex plugin marketplace upgrade catscan`. Without the plugin, paste the `AGENTS.md` snippet instead.

**Cursor:** copy `examples/agents/cursor/catscan.mdc` into the project's `.cursor/rules/`. The rule has
`alwaysApply: false`, so Cursor loads it when its description matches the task (screenshots, simulator, emulator,
UI tests, localization). Update by copying the new file.

**Other agents:** copy `plugins/catscan/skills/screen-check/` into the agent's skills folder, or paste the
`AGENTS.md` snippet into whatever instruction file it reads. Update by copying again.

**ChatGPT and Codex cloud:** not targets. ChatGPT skills run in a cloud container and Codex cloud tasks on Linux;
neither can reach your Mac or its screenshots. There the files tell the agent that catscan is not available, and it
opens the image as before.

Measured effect: [`docs/BENCHMARKS.md`](../BENCHMARKS.md#agent-instruction-files).

## Paths and roots

- Allowed roots are the client's workspace roots when it sends them, else `CATSCAN_MCP_ROOTS`, else the server's
  working directory, which depends on the client (usually the project folder for Claude Code, Cursor and Codex).
  Relative paths resolve against them. The working directory is never used when it is `/`, your home folder or a
  folder above it: every call then replies `no-roots`. For a client that sends no roots and starts servers there,
  set `CATSCAN_MCP_ROOTS` in the server's `env` and restart the server.
- Every path argument must lie inside an allowed root, symlinks included; anything else is `path-outside-root`. To
  allow another folder, add it to the client's workspace, or, for a client that sends no roots, set `CATSCAN_MCP_ROOTS` (absolute paths joined by `:`)
  in the server's `env`: `"env": { "CATSCAN_MCP_ROOTS": "/Users/me/app:/Users/me/shots" }`.

## Errors

Errors are normal replies with `verdict: "error"` (or `"needs-reader"` for a language catscan reads once Tesseract is installed, `"unsupported"` for one no reader reads) and an
`error: { code, message, hint }` the agent can act on:

| Code | Next step |
| --- | --- |
| `input-not-found`, `path-outside-root` | the message names the tried path and the allowed roots |
| `no-roots` | the client sent no roots and the server started in `/`, the home folder or a folder above it: set `CATSCAN_MCP_ROOTS` in the server's `env` and restart the server |
| `input-too-large` | a data file (results, baseline, known, expect, catalog, boxes, prices, device profile) is over 64 MB; run that step with the catscan CLI |
| `unsupported-input` | pass an image (PNG, JPEG, HEIC), a video (MP4, MOV) for `check_video`, or a folder; a data file must be a regular file, not a FIFO or device |
| `binary-not-found` | build `catscan-core` (above) or set `CATSCAN_CORE_BINARY` in the server's `env` |
| `binary-failed` | retry the call once; if it fails again, restart the MCP server |
| `vision-timeout`, `core-timeout` | the server already replaced the stuck `catscan-core` (after the 3rd failure in a row, it starts a new one on the next call): retry the call once; on a slow Mac set `CATSCAN_VISION_TIMEOUT` (seconds, default 60) in the server's `env` ([`docs/cli.md`](../cli.md#recognition)) |
| `unsupported-platform` | catscan needs macOS on Apple silicon |
| `reader-missing` (`needs-reader`) | tell the user the install command in the hint once, then read the image yourself |
| `install-incomplete` | `npm install @catscan/cli@<version>` |
| `results-invalid`, `baseline-*` (`compare_to_baseline`) | `results-invalid`: run `catscan results validate` on the named file; a `baseline-*` code and its hint are those of the CLI ([`docs/cli.md`](../cli.md#diagnostic-codes)) |

An argument the tool does not know is rejected with `isError: true` naming the field.

Replies leave out empty and `null` fields: a check with no `box` was not found on screen, and a `find_untranslated`
finding with no `expected` has no translation in the target catalog. Warnings carry `code` and `message`. A warning that
means something went unchecked also carries a `hint` in tool-argument terms: `no-checks`, `no-checkable-text`,
`expect-key-unmatched`, `catalog-string-capped`, `catalog-value-dynamic`, `catalog-values-skipped`, `catalog-missing`, `untranslated-base-catalog`,
`untranslated-unreadable`, `wrong-language-unchecked`, `rule-unmeasured-reader` (overflow or wrong-language ran on a Tesseract read) and `boxes-missing` (whose hint is the exact `catscan boxes` command). In a folder reply, a passing image with one of these warnings
(`expect-key-unmatched` aside, which sits on the folder reply) is listed, not counted in `omitted_pass`. Warning codes are stable ids; a client may branch on them.

## Safety

- Text read from a screen is untrusted data. The tool descriptions and the server's instructions tell the agent
  not to follow instructions found in it.
- The server opens no network connection. No tool argument can turn on escalation to a cloud model (planned,
  not built).
