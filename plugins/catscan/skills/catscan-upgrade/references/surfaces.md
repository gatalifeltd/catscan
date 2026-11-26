# Surfaces: where a project holds catscan and how each moves

`find-surfaces.mjs` reads the committed tree only. Every row of `surfaces[]` carries `surface`, `file`, `line`
(where the file has lines), `current` and `scope` (`project`, or `user` for a file outside the repo).

| Surface | Where | Moved by |
| --- | --- | --- |
| S1 npm packages | every `package.json` that names `@catscan/cli`, `@catscan/core-js`, `@catscan/cli-darwin-arm64`, `@catscan/mcp` or `@catscan/playwright` (dependencies, `overrides`, `resolutions`, `pnpm.overrides`), and every lockfile | the package manager of the nearest lockfile (`commands[]`); overrides and peer pins by pin rewrite |
| S2 CI pins | `.github/workflows/*.yml`, `.gitlab-ci.yml`, `.circleci/config.yml`, `bitrise.yml`, `codemagic.yml`, `azure-pipelines.yml`, `.buildkite/*.yml`, `Jenkinsfile`, the scripts they call, and `package.json` scripts | pin rewrite (`edits[]`) |
| S3 MCP config | project `.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`; user `~/.claude.json`, `~/.codex/config.toml` | project: pin rewrite; user: a printed command |
| S4 agent plugin | the agent's plugin install of this skill and its siblings | a printed update command (below) |
| S5 rule blocks | marker pairs in `AGENTS.md`, `CLAUDE.md`, `docs/testing.md` | the target version's own installer, rerun |
| S6 baselines | files named by `--baseline` in CI files and package scripts | `catscan results baseline`, only after the user's yes |

## S1: package-manager commands

`commands[]` holds one line per `package.json` (and per dependency field), run from that manifest's folder with
the manager of its lockfile, pinning each exactly pinned `@catscan/` package it names to the target. A folder with
no lockfile of its own uses an ancestor's only when that ancestor declares workspaces (`workspaces` or
`pnpm-workspace.yaml`); any other folder gets pin rewrites only. A range, tag, `file:` or `workspace:` spec gets no
command: it is listed in `references[]` for the user.

- `package-lock.json`: `npm install --save-exact <pkg>@<target> ...`
- `pnpm-lock.yaml`: `pnpm add --save-exact <pkg>@<target> ...`
- `yarn.lock`: `yarn add --exact <pkg>@<target> ...`
- `bun.lock` / `bun.lockb`: `bun add --exact <pkg>@<target> ...`

A dev dependency keeps its field (`--save-dev` for npm, `-D` for the others). An `edits[]` row on a
`package.json` with `via: "command"` is what these commands write: do not apply it by hand. One with
`via: "edit"` (no lockfile, or a peer dependency) is applied as a pin rewrite. A binary `bun.lockb` cannot be
read; its row says to run `bun install` and read the text lockfile it writes.

## Reference shapes (`references[]`)

| Shape | Example | Action |
| --- | --- | --- |
| `pinned` | `@catscan/cli@0.58.0`, `"@catscan/mcp": "0.58.0"` | rewritten in `edits[]` |
| `unpinned` | `npx -y @catscan/mcp`, `"^0.58.0"`, `"latest"` | listed: an unpinned CI run moves on its own; offer an exact pin |
| `variable` | `@catscan/cli@${{ env.CATSCAN }}`, `$CATSCAN_VERSION` | listed: name where the variable is set; the user edits it |
| `checkout` | `node ../catscan/packages/mcp/catscan-mcp.js` | listed: a checkout moves with `git pull` there, not here |

Never rewrite a ranged, unpinned or variable reference into a pin without the user's yes.

## S3 user files

For `~/.claude.json` print the `claude mcp` commands that re-add the server at the target, in the scope the row
names (`mcp_scope`: `user` for every project, `local` for this one; run the `local` pair from the repo):

```
claude mcp remove -s <mcp_scope> catscan
claude mcp add -s <mcp_scope> catscan -- npx -y @catscan/mcp@<target>
```

For `~/.codex/config.toml` print the `[mcp_servers.catscan]` table with
`args = ["-y", "@catscan/mcp@<target>"]`. Restart the agent afterwards so the server starts again.

## S4: update the skills first

`skill.version` is this skill's plugin version; `unknown` means a copied folder without its plugin manifest,
which counts as older than any target. Print the command for the agent in use:

- Claude Code: `claude plugin marketplace update catscan`, then `claude plugin update catscan@catscan`, then
  `/reload-plugins` in an open session (or start a new one).
- Codex: skills live in folders (`.agents/skills/` in the repo, `~/.agents/skills/` for the user). Copy the
  target version's `plugins/catscan/skills/` folders over the installed ones; Codex picks them up, or restart it.
- Any other agent, or a copied folder: copy the target version's skill folders over the old ones.

Then stop and ask the user to run the skill again: the updated skill holds the target's installers and patterns.

## S5: rerun the installers

`surfaces[]` names each block (`block`):

- `test-speedup:testing-rules`: `node <plugin>/skills/test-speedup/scripts/agent-rules.mjs --root <repo>`, with
  `--doc <path>` when the rules section lives somewhere other than `docs/testing.md`.
- `test-speedup:gpu-rule`: the same script with `--gpu --gpu-helper <name> --gpu-guard <cmd>`, taking the helper
  and the guard from the current block's text.

`<plugin>` is the folder that holds this skill's folder. Both installers are idempotent: a second run changes
nothing. An unmarked GPU rule with the published text is replaced by the marked block; any other wording makes
the installer stop and name the file, for the user to edit by hand.

## S6: baselines

A baseline row says `exists: false` when the named file is not committed: list it, never create it. A baseline
moves only in Step 5, per file, on the user's yes.
