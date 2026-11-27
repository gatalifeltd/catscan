# Start here

One page from zero to catscan checks in the tests you already have. Two paths: you run catscan yourself, or your coding agent does. Both start with the same install.

## Install

Requirements: Apple silicon Mac, macOS 15 or later, Node 22 or later (22, 24 or 26 LTS). In your project:

```bash
npm install --save-dev @catscan/cli
```

```bash
npx -p @catscan/cli catscan doctor
```

Playwright tests: `npm install -D @catscan/playwright` instead, then follow [`recipes/playwright.md`](./recipes/playwright.md).

`doctor` exits 0 when catscan can run; a `FAIL` line names what to fix. npm installs the catscan binary with the CLI; keep every `@catscan/` package at one version ([`recipes/upgrade.md`](./recipes/upgrade.md)).

## Path 1: you run catscan

1. **First check.** Take a screenshot with Cmd+Shift+4. Type `npx -p @catscan/cli catscan read ` and drag the screenshot into the terminal (it pastes the quoted path), then press Return. Pick a word it printed and run `npx -p @catscan/cli catscan check <dragged path> --present "<that word>"`: `PASS`, exit 0. The full flag list is in [`cli.md`](./cli.md).
2. **Pick the recipe for your stack:**

| Your stack | Recipe |
| --- | --- |
| Playwright web tests, including canvas and WebGL text | [`recipes/playwright.md`](./recipes/playwright.md): `toShowText`, `toHaveNoTruncation` and more matchers |
| Cypress, Selenium, WebdriverIO or other web tests | Save viewport PNGs (`cy.screenshot()`, `browser.saveScreenshot()`) and run `npx -p @catscan/cli catscan check`, `untranslated` or `truncated` on the folder; for boxes, run the page script from [`truncation-capture.md`](./truncation-capture.md#playwright-web) through the tool's execute-script call, save `<screen>.pw.json` and convert it with `catscan boxes playwright` |
| CI on GitHub Actions, GitLab, CircleCI, Bitrise, Codemagic or your own Mac | [`recipes/ci.md`](./recipes/ci.md): annotations, JUnit, Code Quality, changed-only review |
| Maestro flows on iOS and Android | [`recipes/maestro.md`](./recipes/maestro.md): a first verdict in one minute, then per-locale runs |
| A coding agent that reads your screenshots | [`recipes/mcp.md`](./recipes/mcp.md): the MCP server and instruction files (Path 2 below) |
| No translations yet, but cut-off labels worry you | [`recipes/pseudo.md`](./recipes/pseudo.md): an `en-XA` pseudo build and `--pseudo` checks |
| Screens that break at large system text (Dynamic Type, Android font scale, browser zoom) | [`recipes/large-text.md`](./recipes/large-text.md): capture at `large`, one report with both sizes |
| Android screenshots checked for text under the camera cutout or rounded corners | [`recipes/device-profile.md`](./recipes/device-profile.md): pick the phone profile `fit` needs |
| Languages catscan reads with Tesseract (Greek, Hebrew, Bulgarian and more) | [`recipes/tesseract.md`](./recipes/tesseract.md): install it, then `catscan doctor --expect-locales` |

## Path 2: your coding agent runs catscan

Works in Claude Code and Codex with the `catscan` plugin, in Cursor with a rule file, and in any agent that reads `AGENTS.md`. ChatGPT cannot reach your Mac, so there only `test-speedup` works, in report-only mode (step 6).

1. **Install catscan** as above.
2. **Give the agent catscan's tools (MCP server).**
   - Claude Code: `claude mcp add catscan -- npx -y @catscan/mcp@<version>`
   - Codex: `codex mcp add catscan -- npx -y @catscan/mcp@<version>`
   - Cursor: `.cursor/mcp.json` with `{ "mcpServers": { "catscan": { "command": "npx", "args": ["-y", "@catscan/mcp@<version>"] } } }`

   `<version>` is the version of your other catscan packages. Details and errors: [`recipes/mcp.md`](./recipes/mcp.md).
3. **Install the skills.**
   - Claude Code: `claude plugin marketplace add gatalifeltd/catscan`, then `claude plugin install catscan@catscan`.
   - Codex: `codex plugin marketplace add gatalifeltd/catscan`, then `codex plugin add catscan@catscan`.
   - Cursor and other agents: these files are in the catscan repository (clone https://github.com/gatalifeltd/catscan). Cursor: copy [`examples/agents/cursor/catscan.mdc`](../examples/agents/cursor/catscan.mdc) to `.cursor/rules/`. Any other agent: paste [`examples/agents/AGENTS.md.snippet`](../examples/agents/AGENTS.md.snippet) into the project's `AGENTS.md`. For `catscan-adopt`, `test-speedup` and `catscan-upgrade`, copy the skill folder from `plugins/catscan/skills/` into the agent's skills folder.
4. **Check screens: `screen-check`.** Nothing to invoke: after a UI test or a screenshot the agent asks catscan instead of opening the image. Try it with: `Does screenshots/login.png show "Sign in"? Ask catscan, do not open the image.`
5. **Move an existing suite onto catscan checks: `catscan-adopt`.** Run `/catscan:catscan-adopt` (Claude Code), `catscan:catscan-adopt` (Codex), or ask: `Wire catscan checks into this project's tests. Start with a dry run.` The dry run writes nothing and lists the adoption points (unchecked screenshots, pixel snapshots standing in for text checks, canvas text, per-locale folders, rendered or recorded video) with one diff each. Then say which batch to apply; every check is proven by a text mutation that fails it. Recipe: [`recipes/catscan-adopt.md`](./recipes/catscan-adopt.md).
6. **Make the suite fast and keep agents to the testing rules: `test-speedup`.** Run `/catscan:test-speedup` or ask: `Speed up this test suite without weakening what it proves.` You get a quick scan with three ranked levers first; measuring starts when you pick one. To write the testing rules where agents read them, ask the agent to run its `agent-rules.mjs`. In ChatGPT (Business, Enterprise, Edu) upload the zipped `plugins/catscan/skills/test-speedup/` folder under Skills. Recipe: [`recipes/test-speedup.md`](./recipes/test-speedup.md).

## Skills

All four ship in the `catscan` plugin (`plugins/catscan/skills/`).

| Skill | What it does | Needs the catscan binary | Recipe |
| --- | --- | --- | --- |
| `screen-check` | Has the agent check screenshots and recordings with catscan (MCP tools or the CLI) and open the image only when catscan cannot answer. | Yes, Apple silicon Mac | [`recipes/mcp.md`](./recipes/mcp.md#instruction-files) |
| `catscan-adopt` | Finds where existing tests should check screen text, proposes exact diffs, applies them only in batches you approve and proves each check with a mutation. | Yes, Apple silicon Mac | [`recipes/catscan-adopt.md`](./recipes/catscan-adopt.md) |
| `test-speedup` | Makes a suite and its CI faster without weakening what it proves; keeps browsers and emulators on the GPU, caps `expect` loops, writes the testing rules for agents. | No; macOS or Linux, also ChatGPT in report-only mode | [`recipes/test-speedup.md`](./recipes/test-speedup.md) |
| `catscan-upgrade` | Moves every place a project holds catscan (npm packages, CI pins, MCP config, agent skills, rule blocks, baselines) to one version, lists the behavior changes in between with their opt-outs and shows which findings change before you keep it. | Yes for the finding delta and the `doctor` check after the move (Apple silicon Mac); the plan and the move run anywhere with Node, git and npm | [`recipes/upgrade.md`](./recipes/upgrade.md) |
