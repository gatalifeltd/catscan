# Agent runs (`bench/agents.js`)

Traps hit while measuring the agent instruction files (2026-11-11).

- **Codex hides image reads from `--json`.** `codex exec --json` emits no item for `view_image`, which Codex calls
  inside a code cell. The only record is the debug log: `RUST_LOG=codex_core::stream_events_utils=debug` prints
  `ToolCall: <name> <args>` to stderr, and a code cell's entry runs over several lines, so split the log on the
  timestamp, not on newlines.
- **Every path contains "catscan".** The checkout, the scratchpad and any temp folder named after the repo all
  contain the word, so a substring match counts an image read as a catscan call. Match MCP tool names
  (`mcp__catscan__`, Cursor's `providerIdentifier`) and `catscan <check command>` instead.
- **Cursor `-p` rejects MCP calls.** `--approve-mcps` only starts the server; each tool call still needs approval
  and `-p` answers "User rejected MCP". Put a project `.cursor/cli.json` with
  `{"permissions": {"allow": ["Mcp(catscan:*)", ...]}}` in the run folder instead of `--force`.
- **`codex exec` rejects MCP calls too.** With approvals off, a tool that would ask is refused and the agent
  reports the connector "blocked", then opens the images. Pass
  `-c mcp_servers.catscan.default_tools_approval_mode="approve"` (that server only).
- **A `claude` started from a Claude Code session inherits its host auth.** The desktop session exports
  `ANTHROPIC_*` and `CLAUDE_CODE_*` (including `CLAUDE_CODE_SIMPLE`, which is `--bare`). Drop them so the child uses
  its own login. When that login answers 401 "OAuth access token is invalid" (the first run, 2026-11-11), the owner
  runs `claude auth login` in a terminal before the Claude variants; the rerun measured both.
- **Codex `--ignore-user-config` drops the model.** Pass the owner's `model` and `model_reasoning_effort` with
  `-m` and `-c`, and record them. User skills in `~/.codex/skills` still load ("Skill descriptions were shortened")
  in every variant alike.
- **`codex exec` waits for stdin** when it is not closed; the script
  spawns it with stdin ignored.
