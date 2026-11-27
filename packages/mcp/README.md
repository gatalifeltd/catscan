# @catscan/mcp

An MCP server that gives coding agents (Claude Code, Codex, Cursor) catscan's screenshot and video text checks as tools. The agent confirms what a screen shows from a verdict of about 60 tokens instead of loading the image. It runs over stdio on an Apple silicon Mac with Apple Vision; screenshots never leave the machine.

Tools: `check_text`, `read_screen`, `find_truncation`, `find_untranslated`, `find_overlap`, `find_format_errors`, `find_fit_issues`, `check_video` and `compare_to_baseline`. Each returns JSON text, never an image.

## Requirements

Apple silicon Mac, macOS 15 or later, Node 22 or later: your own Mac or a macOS CI runner (GitHub's `macos-15` and `macos-26` work). npm installs the catscan binary with the server.

## Set up

Pin the server to the version of your other catscan packages.

Claude Code:

```bash
claude mcp add catscan -- npx -y @catscan/mcp@1.0.4
```

Cursor, `.cursor/mcp.json` in the project:

```json
{ "mcpServers": { "catscan": { "command": "npx", "args": ["-y", "@catscan/mcp@1.0.4"] } } }
```

Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.catscan]
command = "npx"
args = ["-y", "@catscan/mcp@1.0.4"]
```

Then ask: `Does screenshots/login.png show "Sign in"? Ask catscan, do not open the image.`

## Learn more

- [MCP recipe](https://github.com/gatalifeltd/catscan/blob/main/docs/recipes/mcp.md): every tool and its options, and the instruction files that make an agent ask catscan first
- [catscan on GitHub](https://github.com/gatalifeltd/catscan/blob/main/README.md)

## License

Apache-2.0: [LICENSE](https://github.com/gatalifeltd/catscan/blob/main/LICENSE).
