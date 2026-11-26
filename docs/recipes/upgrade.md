# Recipe: upgrade catscan

A project holds catscan in several places, and an upgrade moves them together:

| Place | Where |
| --- | --- |
| npm packages | `@catscan/cli`, `@catscan/core-js`, `@catscan/cli-darwin-arm64`, `@catscan/mcp`, `@catscan/playwright` in every `package.json` and lockfile |
| CI pins | `npx -y @catscan/cli@X.Y.Z` in workflow files and the scripts they call |
| MCP config | `@catscan/mcp@X.Y.Z` in `.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`, and the user's `~/.claude.json` or `~/.codex/config.toml` |
| Agent skills | the catscan plugin your coding agent installed |
| Rule blocks | the testing-rules and GPU-rule blocks `agent-rules.mjs` wrote into `AGENTS.md`, `CLAUDE.md`, `docs/testing.md` |
| Baselines | files your CI job passes to `--baseline` |

With a coding agent, ask it to run the `catscan-upgrade` skill: it lists these places, shows the behavior changes
between your version and the target, applies the move as one commit on a branch, and shows which findings change
on your existing screenshots. When the target (npm `latest` unless you name one) is older than a version your
project pins, the skill stops and names both versions; it plans a downgrade only to a version you name. The steps
below do the same by hand.

## When to upgrade

`catscan doctor` prints one line when npm has a newer version:

```
ok   update: 1.0.0 installed, 1.1.0 available - try: the catscan-upgrade skill, or docs/recipes/upgrade.md
```

It is never a failure. It is off with `--offline`, with `CATSCAN_NO_UPDATE_CHECK=1`, and on CI runners
([Doctor](../cli.md#doctor)).

## Read the behavior changes first

Every `@catscan/core-js` package carries `behavior-changes.json`: per release, the changes that can turn a passing
run red or change what a file or report says. Read the target's file without installing it:

```bash
npm pack @catscan/core-js@1.1.0 --pack-destination /tmp && tar -xzOf /tmp/catscan-core-js-1.1.0.tgz package/behavior-changes.json
```

Releases are listed newest first, each with `changes[]` (`id`, `kind`, `text`, `opt_out`). Read every release
after your version up to the target. The kinds:

| Kind | What it means for you |
| --- | --- |
| `default-on` | a check now runs by default; the `opt_out` flag turns it off |
| `exit-code` | a run can now exit non-zero where it passed; CI goes red |
| `reader` | recognized text can change; approved baselines may need review |
| `cli` | a command, flag or default changed; scripts that call it may need an edit |
| `output` | a field, a report or a line changes; parsers of the output may need a look |
| `schema` | a results or doctor file has a new schema; tools that read it may need an update |
| `protocol` | the binary protocol changed; all packages must move together |
| `rule-block` | the text a skill writes into your agent files changed; rerun its installer |

The same text is in `CHANGELOG.md` under each release's `### Behavior changes`.

## Move every place

1. **npm packages.** Pin every `@catscan/` package to the same exact version, in every folder with a lockfile:
   `npm install --save-exact @catscan/cli@1.1.0` (add the other `@catscan/` packages the folder names, and edit any
   `overrides`, `resolutions` or `pnpm.overrides` entry by hand;
   `pnpm add --save-exact`, `yarn add --exact`, `bun add --exact` for those managers).
2. **CI pins.** Replace each `@catscan/cli@<old>` and `@catscan/mcp@<old>` in workflow files and the scripts they
   call. A pin held in a variable moves where the variable is set.
3. **MCP config.** Replace the pin in the project's MCP files. In your own `~/.claude.json`:
   `claude mcp remove -s user catscan`, then `claude mcp add -s user catscan -- npx -y @catscan/mcp@1.1.0` (`-s local`
   from the project folder for a server added to one project only); in
   `~/.codex/config.toml`, the `args` of `[mcp_servers.catscan]`. Restart the agent.
4. **Agent skills.** Claude Code: `claude plugin marketplace update catscan`, then
   `claude plugin update catscan@catscan`, then `/reload-plugins`. Codex or a copied folder: copy the new
   `plugins/catscan/skills/` folders over the installed ones.
5. **Rule blocks.** Rerun the updated skill's installer, for example
   `node <skills>/test-speedup/scripts/agent-rules.mjs --root .`; a second run changes nothing.
6. **Check.** On a Mac, `npx catscan doctor` must pass `binary` and `version`. Anywhere else doctor fails `platform`
   and has no binary to check, so skip it there. Everywhere, a search for `@catscan/` must show no old version left.
7. **Baselines.** Run the CI command on your current screenshots. If cells now need review because the reader
   changed, look at them, then approve the run again with `catscan results baseline`.

## Why a partial bump fails

The packages pin each other exactly: `@catscan/cli` and `@catscan/playwright` pin `@catscan/core-js`, which pins
the binary in `@catscan/cli-darwin-arm64`. Bump only some of them and the project can hold two `core-js` versions;
the older one then finds the newer binary, and catscan stops with `binary-version-mismatch` while `doctor` fails
`version`:

```
FAIL version: catscan-core is 1.1.0, @catscan/core-js is 1.0.0 - try: ...
```

Move all of them in one change, and let a dependency bot group them.

## Dependency bots

### Renovate

One group for every `@catscan/` package, and a regex manager for the CI and MCP pins npm does not see:

```json
{
  "packageRules": [
    { "matchPackageNames": ["@catscan/**"], "groupName": "catscan", "rangeStrategy": "pin" }
  ],
  "customManagers": [
    {
      "customType": "regex",
      "managerFilePatterns": ["/^\\.github/workflows/.+\\.ya?ml$/", "/(^|/)\\.mcp\\.json$/", "/\\.sh$/"],
      "matchStrings": ["(?<depName>@catscan/[a-z0-9-]+)@(?<currentValue>\\d+\\.\\d+\\.\\d+)"],
      "datasourceTemplate": "npm"
    }
  ]
}
```

Add your other CI files (`.gitlab-ci.yml`, `bitrise.yml`, `codemagic.yml`) to `managerFilePatterns`. The group
puts the package and pin bumps in one pull request, so `doctor` never sees a mix.

### Dependabot

Dependabot groups the npm packages:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      catscan:
        patterns: ["@catscan/*"]
```

Dependabot does not update an `npx` pin inside a workflow `run:` line or an MCP file. Move those by hand in the
same pull request, or use Renovate.

## Roll back

The upgrade is one commit: revert it, then reinstall (`npm ci`) so `node_modules` matches the lockfile again.
