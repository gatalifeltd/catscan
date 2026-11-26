#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 10 measurement (D8, D9, D12): does an agent with the instruction file answer a blind screenshot task through
// catscan, without opening an image? Each run copies bench/agents/fixture/ to a fresh temp folder, renders its 10
// screens with bench/generate.swift (2 wrong labels picked by the run's seed, visible only in the pixels), and asks
// the agent the spec prompt. Tokens, tool calls and the answer come from the agent's own event stream.
// Usage: node bench/agents.js [--variants a,b] [--seeds 1-10] [--out results/agent-files.json] [--append]
// --append keeps the runs of other variants already in --out (a variant run again replaces its own runs).
// The catscan MCP server (packages/mcp, local build) is configured in every variant. Agents run one run at a time
// each, the three agents in parallel. A variant whose agent is not logged in or hits a usage limit stops; the
// runs done so far are kept and the reason is recorded.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(__dirname, "agents/fixture");
const MCP_BIN = path.join(ROOT, "packages/mcp/bin/catscan-mcp.js");
const PROMPT = "Run the UI tests. Are all 10 screens showing the expected button labels? Name any that do not.";
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const CATSCAN_TOOLS = ["check_text", "read_screen", "find_truncation", "find_untranslated", "check_video"];

// Label per screen and the wrong label a run can plant on it (typo, shortened or wrong string). No wrong
// label contains its right one, so a substring match cannot pass it.
const SCREENS = [
  ["Sign in", "Sing in"], ["Continue", "Contiune"], ["Add to cart", "Add to card"], ["Checkout", "Chekout"],
  ["Save changes", "Save chanegs"], ["Send message", "Send massage"], ["Start free trial", "Start trial"],
  ["Log out", "Log in"], ["Try again", "Retry"], ["Next step", "Next stop"],
];
const shot = (i) => `screen-${String(i + 1).padStart(2, "0")}.png`;

// Variants (D9). `file` says how the instruction file reaches the agent.
const VARIANTS = {
  "claude-skill": { agent: "claude", file: "plugin skill (--plugin-dir plugins/catscan)" },
  "claude-none": { agent: "claude", file: null },
  "codex-skill": { agent: "codex", file: "skill folder in .agents/skills/screen-check" },
  "codex-none": { agent: "codex", file: null },
  "codex-agents-md": { agent: "codex", file: "AGENTS.md snippet" },
  "cursor-rule": { agent: "cursor", file: "rule in .cursor/rules/catscan.mdc" },
  "cursor-none": { agent: "cursor", file: null },
  "cursor-agents-md": { agent: "cursor", file: "AGENTS.md snippet" }, // D18
};

/** Two distinct screen indexes from a seed (mulberry32), sorted. */
function planted(seed) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const first = Math.floor(rnd() * 10);
  let second = Math.floor(rnd() * 9);
  if (second >= first) second++;
  return [first, second].sort((x, y) => x - y);
}

// Shell commands that only list or stat files; naming an image in them is not opening it.
const LISTING = /^\s*(ls|find|stat|du|test|\[|wc -c|cd|for\s+\w+\s+in)\b/;
const IMAGE = /\.(png|jpe?g|heic)\b/i;
// Paths here contain "catscan" (the checkout, the temp folder), so a call counts as catscan only by its tool name or
// a catscan command with a check subcommand, never by a substring.
const CATSCAN_CMD = /^\s*(?:npx\s+(?:-y\s+)?@catscan\/cli(?:@\S+)?|catscan|\S*\/bin\/catscan(?:\.js)?)\s+(?:check|read|truncated|untranslated|video)\b/;
const CATSCAN_MCP = new RegExp(`(?:mcp__catscan__|^mcp:catscan:|catscan[-_.](?:${CATSCAN_TOOLS.join("|")}))`);
// Tools that read a file's content; a search or listing tool naming an image does not open it.
const READ_TOOL = /^(Read|readToolCall|read_file|view_image|NotebookRead)$/;

/** The command line with each substitution ($(...), <(...), >(...), `...`) outside single quotes and escapes blanked,
 * followed by the substitution bodies as commands of their own: text after "$(catscan check ...)" stays outside the
 * catscan command, and a quoted or escaped "$(catscan ...)" is no catscan call. */
function substitutions(shell) {
  const inner = [];
  let outer = "";
  let quote = null;
  const heredocs = [];
  for (let i = 0; i < shell.length; i++) {
    const c = shell[i];
    // A heredoc body (next line to its delimiter line) is judged as command lines of its own: an interpreter may run it
    // ("python3 - <<'EOF'"), and its quotes never leak into the rest of the script.
    if (c === "\n" && !quote && heredocs.length) {
      outer += c;
      for (const word of heredocs.splice(0)) {
        const re = new RegExp(`\\n\\t*${word.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}[ \\t]*(?=\\n|$)`, "g");
        re.lastIndex = i;
        const m = re.exec(shell);
        const end = m ? m.index : shell.length;
        inner.push(...shell.slice(i + 1, end).split("\n").flatMap(substitutions));
        i = m ? m.index + m[0].length - 1 : shell.length;
      }
      continue;
    }
    if (quote === "'") { outer += c; if (c === "'") quote = null; continue; }
    if (c === "\\") { outer += shell.slice(i, i + 2); i++; continue; }
    if (!quote && shell.startsWith("<<", i) && shell[i + 2] !== "<") {
      const m = /^<<-?[ \t]*(['"]?)([A-Za-z_][\w.-]*)\1/.exec(shell.slice(i));
      if (m) { heredocs.push(m[2]); outer += m[0]; i += m[0].length - 1; continue; }
    }
    // A comment runs to the end of its line and executes nothing.
    if (c === "#" && !quote && /(?:^|[\s;&|(])$/.test(outer)) { const nl = shell.indexOf("\n", i); i = (nl < 0 ? shell.length : nl) - 1; continue; }
    // "bash -lc '<script>'", "/bin/zsh -o pipefail -c \"...\"": the quoted script runs, so it is a command line of its own.
    if ((c === "'" || c === '"') && !quote && /(?:^|[\s;&|(])(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-{1,2}\w[\w-]*(?:\s+(?!-)\w+)?\s+)*-\w*c\s*$/.test(outer)) {
      let stop = i + 1;
      while (stop < shell.length && shell[stop] !== c) stop += c === '"' && shell[stop] === "\\" ? 2 : 1;
      const script = shell.slice(i + 1, Math.min(stop, shell.length));
      inner.push(...substitutions(c === '"' ? script.replace(/\\(["\\$`])/g, "$1") : script));
      outer += " ";
      i = stop;
      continue;
    }
    if (c === "'" && !quote) quote = "'";
    else if (c === '"') quote = quote ? null : '"';
    let end = -1;
    if (c === "`") end = shell.indexOf("`", i + 1) < 0 ? shell.length : shell.indexOf("`", i + 1);
    else if ("$<>".includes(c) && shell[i + 1] === "(" && shell[i + 2] !== "(") {
      let depth = 1;
      for (end = i + 2; end < shell.length && (depth += shell[end] === "(" ? 1 : shell[end] === ")" ? -1 : 0); end++);
    }
    if (end < 0) { outer += c; continue; }
    inner.push(...substitutions(shell.slice(i + (c === "`" ? 1 : 2), end)));
    outer += " ";
    i = end;
  }
  return [outer, ...inner];
}

const SEGMENT = /;|&&|\|\||\||\n/;
// Shell grouping and loop keywords ("(catscan check ...)", "do npx ...") start a segment, not a command.
const segment = (x) => x.replace(/^[\s({]*(?:(?:do|then|else|time)\s+)?/, "");

/** One shell command line, judged per segment (split on ;, &&, ||, | and command substitution): a catscan segment
 * never hides another segment that reads an image. */
function classifyShell(shell) {
  const segs = substitutions(shell).flatMap((x) => x.split(SEGMENT)).map(segment);
  const catscan = segs.some((x) => CATSCAN_CMD.test(x));
  // "for f in shots/*.png" or "for f in $(ls shots/*.png)": the header only lists, but a body command that uses $f
  // (other than catscan) reads it. Headers are read both before substitutions are split off and inside them.
  const vars = [...shell.split(SEGMENT).map(segment), ...segs].map((x) => x.match(/^for\s+(\w+)\s+in\b(.*)$/)).filter((m) => m && IMAGE.test(m[2])).map((m) => m[1]);
  const usesVar = (x) => vars.some((v) => new RegExp(`\\$\\{?${v}\\b`).test(x));
  const opened = segs.some((x) => !CATSCAN_CMD.test(x) && !LISTING.test(x) && (IMAGE.test(x) || usesVar(x)));
  return { catscan, opened };
}

/** Classifies one tool call: { catscan, opened }. `shell` is the command text for a shell call; a Codex code cell
 * (`exec`) is judged by each tool call inside it. */
function classify({ name, args, shell }) {
  const text = typeof args === "string" ? args : JSON.stringify(args ?? {});
  if (shell !== undefined) return classifyShell(shell);
  if (CATSCAN_MCP.test(name)) return { catscan: true, opened: false };
  if (name === "exec") {
    const cmdRe = /exec_command\(\s*\{[^{}]*?\bcmd["']?\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
    const inner = [...text.matchAll(cmdRe)].map((m) => { try { return m[1] === '"' ? JSON.parse(`"${m[2]}"`) : m[2]; } catch { return m[2]; } }).map(classifyShell);
    // An image name in a cell is plain data (often a list later passed to a catscan tool) unless something reads it:
    // view_image, a shell command judged above, a file read, or a tool other than catscan, exec_command and view_image.
    const rest = text.replace(cmdRe, "");
    // exec_command left over means a command built some other way (a variable): an image name in the cell may be its.
    const unparsed = /exec_command\(/.test(rest);
    const other = [...rest.matchAll(/tools\.(\w+)\(/g)].map((m) => m[1]).filter((t) => !/^(mcp__catscan__\w+|exec_command|view_image|write_stdin)$/.test(t));
    return {
      catscan: /mcp__catscan__\w+\(/.test(text) || inner.some((c) => c.catscan),
      opened: /view_image/.test(text) || inner.some((c) => c.opened) || (IMAGE.test(rest) && (unparsed || other.length > 0 || /\breadFile|\bfs\.|\bfetch\(/.test(rest))),
    };
  }
  return { catscan: false, opened: READ_TOOL.test(name) && IMAGE.test(text) };
}

/** Claude Code `-p --output-format stream-json --verbose`. */
function parseClaude(stdout) {
  const out = { model: null, calls: [], answer: "", tokens: null, error: null };
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const e = JSON.parse(line);
    if (e.type === "system" && e.subtype === "init") out.model = e.model;
    if (e.type === "assistant") for (const c of e.message?.content ?? []) {
      if (c.type !== "tool_use") continue;
      out.calls.push({ name: c.name, ...classify(c.name === "Bash" ? { name: c.name, shell: c.input?.command ?? "" } : { name: c.name, args: c.input }) });
    }
    if (e.type === "result") {
      out.answer = e.result ?? "";
      const u = e.usage ?? {};
      out.tokens = { input: u.input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 };
      if (e.is_error) out.error = String(e.result).slice(0, 300);
    }
  }
  return out;
}

/** Codex `exec --json` on stdout plus `RUST_LOG=codex_core::stream_events_utils=debug` on stderr: the JSON stream
 * leaves out some tool calls (view_image inside a code cell), the debug log has every `ToolCall:` line. */
function parseCodex(stdout, stderr) {
  const out = { model: null, calls: [], answer: "", tokens: null, error: null };
  const m = stderr.match(/Configuring session: model=([^;\s]+)/);
  if (m) out.model = m[1];
  // One log entry per timestamp; a code cell's entry runs over several lines.
  for (const entry of stderr.replace(/\x1b\[[0-9;]*m/g, "").split(/\n(?=\d{4}-\d\d-\d\dT\d)/)) {
    const t = entry.match(/ToolCall: (\S+) ([\s\S]*)$/);
    if (!t) continue;
    const [, name, args] = t;
    let shell;
    if (/^(shell|exec_command|local_shell)$/.test(name)) {
      try { const a = JSON.parse(args); shell = Array.isArray(a.command) ? a.command.join(" ") : a.cmd ?? a.command ?? args; } catch { shell = args; }
    }
    out.calls.push({ name, ...classify(shell !== undefined ? { name, shell } : { name, args }) });
  }
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const e = JSON.parse(line);
    if (e.type === "item.completed" && e.item?.type === "agent_message") out.answer = e.item.text;
    if (e.type === "turn.completed") {
      const u = e.usage ?? {};
      out.tokens = { input: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0), cache_read: u.cached_input_tokens ?? 0, cache_write: u.cache_write_input_tokens ?? 0, output: u.output_tokens ?? 0 };
    }
    if (e.type === "turn.failed" || e.type === "error") out.error = JSON.stringify(e.error ?? e.message ?? e).slice(0, 300);
  }
  return out;
}

/** Cursor `cursor-agent -p --output-format stream-json`. */
function parseCursor(stdout) {
  const out = { model: null, calls: [], answer: "", tokens: null, error: null };
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const e = JSON.parse(line);
    if (e.type === "system" && e.subtype === "init") out.model = e.model;
    if (e.type === "tool_call" && e.subtype === "started") {
      const [kind, body] = Object.entries(e.tool_call ?? {}).find(([k]) => k.endsWith("ToolCall")) ?? ["unknown", {}];
      const args = body?.args ?? {};
      if (kind === "shellToolCall") out.calls.push({ name: kind, ...classify({ name: kind, shell: args.command ?? "" }) });
      else {
        const name = kind === "mcpToolCall" ? `mcp:${args.providerIdentifier ?? ""}:${args.toolName ?? args.name ?? ""}` : kind;
        out.calls.push({ name, ...classify({ name, args }) });
      }
    }
    if (e.type === "result") {
      out.answer = e.result ?? "";
      const u = e.usage ?? {};
      out.tokens = { input: u.inputTokens ?? 0, cache_read: u.cacheReadTokens ?? 0, cache_write: u.cacheWriteTokens ?? 0, output: u.outputTokens ?? 0 };
      if (e.is_error) out.error = String(e.result).slice(0, 300);
    }
  }
  return out;
}

// "screen-03", "screen 3", and lists after one: "screens 3 and 7", "screen-03, 07".
// A range ("screens 1-9", "01–06") names every screen in it.
const SCREEN_RE = /screens?[-_ ]?0?(\d{1,2})(?!\d)((?:\s*(?:,|and|&|or|-|\u2013|to|through)\s*(?:screen[-_ ]?)?`?0?\d{1,2}(?!\d)`?)*)/gi;
/** Screen numbers one SCREEN_RE match names, ranges expanded. */
function matchScreens(m) {
  const out = [Number(m[1])];
  for (const r of m[2].matchAll(/(-|\u2013|to|through)?\s*(?:screen[-_ ]?)?`?0?(\d{1,2})/gi)) {
    const n = Number(r[2]);
    if (r[1]) for (let k = out[out.length - 1] + 1; k < n; k++) out.push(k);
    out.push(n);
  }
  return out;
}
const NEG = /\b(not|except|wrong|mismatch\w*|instead|typo|incorrect|missing|fail\w*|differ\w*|misspel\w*|truncated|shortened)\b|\u274c|\u2717|\u2716/i;
const POS = /\b(match\w*|correct(ly)?|ok|pass\w*|fine|as expected|expected labels?|other)\b|\u2705|\u2713|\u2714/i;

/** Screens (1-10) the answer flags as wrong. Read per sentence (a table row is one): a screen named in a sentence with
 * a negative word is flagged; in a sentence with a positive word ("Passing:", "the other eight ... show the expected
 * labels"), under a heading with one ("### Passing (8)"), or in a row that shows its expected label twice
 * (expected = shown), it is fine; any other mention counts as named, since the prompt asks to name the wrong ones. */
function namedScreens(answer) {
  const flagged = new Set();
  let section = null; // "fine" under a positive heading, else null
  for (const line of answer.split("\n")) {
    if (/^\s*(#{1,6}\s|\*\*[^*]+\*\*:?\s*$)/.test(line)) section = POS.test(line) && !NEG.test(line) ? "fine" : null;
    // "X match, except Y": the part after "except" names the wrong screens, the part before the fine ones.
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z*`])|(?=\bexcept\b)/i)) {
      const nums = [...sentence.matchAll(SCREEN_RE)].flatMap(matchScreens).filter((n) => n >= 1 && n <= 10);
      if (!nums.length) continue;
      const neg = NEG.test(sentence);
      for (const n of nums) {
        const label = SCREENS[n - 1][0].toLowerCase();
        const twice = sentence.toLowerCase().split(label).length - 1 >= 2;
        if (neg || !(POS.test(sentence) || twice || section === "fine")) flagged.add(n);
      }
    }
  }
  return [...flagged].sort((a, b) => a - b);
}

/** The answer as stored: local run folder paths become <run>. */
const storedAnswer = (s) => s.replace(/\/[^\s()\]]*?agent-bench-[A-Za-z0-9]+(\/[a-z-]+-seed\d+)?/g, "<run>").slice(0, 2000);

/** Scores one parsed run against the planted screens (0-based). */
function score(parsed, plantedIdx) {
  const named = namedScreens(parsed.answer);
  const want = plantedIdx.map((i) => i + 1);
  const correct = named.length === want.length && named.every((n, i) => n === want[i]);
  const opened = parsed.calls.some((c) => c.opened);
  const calledCatscan = parsed.calls.some((c) => c.catscan);
  return { named, correct, opened_image: opened, called_catscan: calledCatscan, pass: correct && !opened && calledCatscan };
}

// A stop reason for the whole agent: not logged in, or a usage or rate limit.
const STOP = /\b(401|429)\b|authenticat|not logged in|log ?in required|usage limit|rate limit|quota exceeded|insufficient_quota/i;

/** Why an agent must stop, or null: the agent's own error first; the stderr tail only when it reported none. A run
 * whose answer names screens is scored, not a stop. */
function stopReason(parsed, o) {
  // A verdict, not a screen name alone ("Could not inspect screen-01.png" is no answer).
  if (namedScreens(parsed.answer).length && /\b(match\w*|wrong|incorrect|mismatch\w*|correct|instead|shows?|expected)\b/i.test(parsed.answer)) return null;
  const err = parsed.error || (o.code !== 0 ? o.stderr.split("\n").filter((l) => !/^\S*\d{4}-\d\d-\d\dT\S+\s+(DEBUG|TRACE|INFO)\b/.test(l)).join("\n").slice(-300) : null);
  return err && STOP.test(err) ? err.slice(0, 300) : null;
}

const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)));

/** The agent command for a run in `dir`. Claude gets an env without the calling session's CLAUDE and ANTHROPIC
 * variables, so it uses its own login. */
function command(variant, dir) {
  const v = VARIANTS[variant];
  if (v.agent === "claude") {
    const mcp = JSON.stringify({ mcpServers: { catscan: { command: process.execPath, args: [MCP_BIN] } } });
    return { cmd: "claude", env: withShim(clean()), args: ["-p", PROMPT, "--output-format", "stream-json", "--verbose", "--setting-sources", "project,local", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", mcp,
      "--permission-mode", "dontAsk", "--allowedTools", "Read Glob Grep Skill mcp__catscan Bash(npm test) Bash(npm run *) Bash(ls *) Bash(cat *) Bash(npx -y @catscan/cli *) Bash(catscan *)",
      ...(variant === "claude-skill" ? ["--plugin-dir", path.join(ROOT, "plugins/catscan")] : [])] };
  }
  if (v.agent === "codex") {
    return { cmd: "codex", env: withShim({ ...process.env, RUST_LOG: "codex_core::stream_events_utils=debug,codex_core::session::session=debug" }),
      args: ["exec", "--json", "--ephemeral", "--ignore-user-config", "-m", CODEX_MODEL, "-c", `model_reasoning_effort="${CODEX_EFFORT}"`, "--disable", "memories", "--skip-git-repo-check", "-s", "workspace-write",
        "-c", `mcp_servers.catscan.command=${JSON.stringify(process.execPath)}`, "-c", `mcp_servers.catscan.args=[${JSON.stringify(MCP_BIN)}]`,
        // exec runs with approvals off, which rejects MCP calls that ask for approval; allow the catscan tools only.
        "-c", `mcp_servers.catscan.default_tools_approval_mode="approve"`, PROMPT] };
  }
  return { cmd: "cursor-agent", env: withShim(process.env), args: ["-p", PROMPT, "--output-format", "stream-json", "--sandbox", "enabled", "--trust", "--approve-mcps"] };
}
// Codex reads no user config in a run (--ignore-user-config), so the owner's model and effort are passed explicitly.
const CODEX_MODEL = process.env.CATSCAN_BENCH_CODEX_MODEL || "gpt-5.6-sol";
const CODEX_EFFORT = process.env.CATSCAN_BENCH_CODEX_EFFORT || "low";

// D19: catscan as it is after the npm release, a `catscan` command on PATH, here a shim for this checkout's build.
let SHIM_DIR = null;
const withShim = (env) => (SHIM_DIR ? { ...env, PATH: `${SHIM_DIR}${path.delimiter}${env.PATH ?? ""}` } : env);
function makeShim(base) {
  SHIM_DIR = path.join(base, "bin");
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  const sq = (s) => `'${s.replaceAll("'", `'\\''`)}'`; // single quotes: sh expands nothing inside them
  fs.writeFileSync(path.join(SHIM_DIR, "catscan"), `#!/bin/sh\nexec ${sq(process.execPath)} ${sq(path.join(ROOT, "bin/catscan.js"))} "$@"\n`, { mode: 0o755 });
}

/** A fresh fixture copy for one run, with the variant's instruction file and the MCP config where the agent reads it. */
function prepare(base, variant, seed, renders) {
  const dir = path.join(base, `${variant}-seed${seed}`);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const bad = planted(seed);
  fs.mkdirSync(path.join(dir, "ui-tests/.renders"));
  SCREENS.forEach((_, i) => fs.copyFileSync(path.join(renders, bad.includes(i) ? "bad" : "ok", shot(i)), path.join(dir, "ui-tests/.renders", shot(i))));
  if (variant === "codex-skill") fs.cpSync(path.join(ROOT, "plugins/catscan/skills/screen-check"), path.join(dir, ".agents/skills/screen-check"), { recursive: true });
  if (variant === "codex-agents-md" || variant === "cursor-agents-md") fs.copyFileSync(path.join(ROOT, "examples/agents/AGENTS.md.snippet"), path.join(dir, "AGENTS.md"));
  if (VARIANTS[variant].agent === "cursor") {
    fs.mkdirSync(path.join(dir, ".cursor/rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { catscan: { command: process.execPath, args: [MCP_BIN] } } }));
    // -p mode rejects MCP calls that need approval; allow only the catscan tools and the commands the task needs
    // (no --force, which would allow every command).
    fs.writeFileSync(path.join(dir, ".cursor/cli.json"), JSON.stringify({ permissions: { allow: ["Mcp(catscan:*)", "Shell(npm)", "Shell(npx)", "Shell(catscan)", "Shell(ls)", "Shell(cat)", "Read(**)"], deny: [] } }));
    if (variant === "cursor-rule") fs.copyFileSync(path.join(ROOT, "examples/agents/cursor/catscan.mdc"), path.join(dir, ".cursor/rules/catscan.mdc"));
  }
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return { dir, bad };
}

function runAgent(variant, dir) {
  const { cmd, args, env } = command(variant, dir);
  return new Promise((resolve) => {
    // Own process group, so a timeout also ends the agent's children (MCP server, npm test).
    const p = spawn(cmd, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const kill = (sig) => { try { process.kill(-p.pid, sig); } catch {} };
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 10000).unref(); }, RUN_TIMEOUT_MS);
    p.on("exit", () => kill("SIGTERM")); // children left behind by a finished agent
    p.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

const PARSE = { claude: (o) => parseClaude(o.stdout), codex: (o) => parseCodex(o.stdout, o.stderr), cursor: (o) => parseCursor(o.stdout) };

/** Renders the 10 right and 10 wrong screens once, and checks them with the CLI: every right one passes, every wrong
 * one fails, so the task is answerable from catscan alone. */
function render(base) {
  const gen = path.join(ROOT, ".build/bench-gen");
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  execFileSync("swiftc", ["-O", path.join(ROOT, "bench/generate.swift"), "-o", gen]);
  const dir = path.join(base, "renders");
  const plan = SCREENS.flatMap(([ok, bad], i) => [["ok", ok], ["bad", bad]].map(([k, text]) => ({ name: `${k}/${shot(i)}`, locale: "en", text, case: "fit", size: 17, theme: "light", background: "flat", rtl: false })));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(base, "plan.json"), JSON.stringify(plan));
  const fonts = JSON.parse(execFileSync(gen, [path.join(base, "plan.json"), dir], { encoding: "utf8" })).fonts;
  for (const k of ["ok", "bad"]) {
    const expect = { locale: "en", shots: Object.fromEntries(SCREENS.map(([ok], i) => [shot(i), { present: [ok] }])) };
    fs.writeFileSync(path.join(base, "expect.json"), JSON.stringify(expect));
    const r = spawnSync(process.execPath, [path.join(ROOT, "bin/catscan.js"), "check", path.join(dir, k), "--expect", path.join(base, "expect.json"), "--json"], { encoding: "utf8" });
    const verdicts = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l).verdict);
    const want = k === "ok" ? "pass" : "fail";
    if (verdicts.length !== 10 || verdicts.some((v) => v !== want)) throw new Error(`renders/${k}: catscan verdicts ${verdicts.join(",")}, want 10 x ${want}`);
  }
  return { dir, fonts };
}

const version = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", env: clean() }); return (r.stdout || r.stderr || "").trim().split("\n")[0] || null; };

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const variants = opt("--variants", Object.keys(VARIANTS).join(",")).split(",");
  for (const v of variants) if (!VARIANTS[v]) throw new Error(`unknown variant ${v}; known: ${Object.keys(VARIANTS).join(", ")}`);
  const m = opt("--seeds", "1-10").match(/^(\d+)(?:-(\d+))?$/);
  if (!m || Number(m[2] ?? m[1]) < Number(m[1])) throw new Error("--seeds takes N or N-M, for example 1-10");
  const seeds = Array.from({ length: Number(m[2] ?? m[1]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i);
  const outPath = path.resolve(opt("--out", path.join(ROOT, "results/agent-files.json")));
  if (argv.includes("--rescore")) {
    const dirs = opt("--rescore", "");
    if (!dirs || dirs.startsWith("--")) throw new Error("--rescore takes the work dir(s) a run printed, comma-separated");
    return rescore(outPath, dirs.split(","));
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bench-"));
  const renders = render(base);
  makeShim(base);
  const { versionInfo } = require("../packages/core-js/src/client");
  const v = versionInfo();
  const agents = [...new Set(variants.map((x) => VARIANTS[x].agent))];
  const reported = [...variants];
  const result = {
    spec: 10, date: new Date().toISOString().slice(0, 10), prompt: PROMPT,
    catscan: { version: v.catscan, source: "local build of this checkout (packages/mcp, core release build); @catscan/cli and @catscan/mcp are not on npm yet", cli_on_path: "a catscan shim for the local build is first on PATH in the runs marked cli_shim: true (D19)" },
    host: { macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version, generator: "bench/generate.swift", fonts: renders.fonts },
    agents: Object.fromEntries(agents.map((a) => [a, {
      version: a === "claude" ? version("claude", ["--version"]) : a === "codex" ? version("codex", ["--version"]) : version("cursor-agent", ["--version"]),
      settings: a === "codex" ? { model: CODEX_MODEL, model_reasoning_effort: CODEX_EFFORT } : undefined,
      stopped: null,
    }])),
    runs: [],
  };
  if (argv.includes("--append") && fs.existsSync(outPath)) {
    const old = JSON.parse(fs.readFileSync(outPath, "utf8"));
    result.runs = old.runs.filter((r) => !variants.includes(r.variant));
    for (const [k, info] of Object.entries(old.agents)) if (!result.agents[k]) result.agents[k] = info;
    // Kept runs keep their own provenance; a run recorded before these fields existed takes the old file's. Screens
    // drawn with other fonts are another fixture, so such runs are not merged.
    if (JSON.stringify(old.host.fonts) !== JSON.stringify(result.host.fonts)) throw new Error(`--append: ${outPath} was drawn with other fonts (${JSON.stringify(old.host.fonts)}); rerun every variant`);
    for (const r of result.runs) {
      r.catscan ??= old.catscan.version;
      r.cli_shim ??= false; // runs recorded before D19 had no catscan command on PATH
      r.host = { macos: r.host?.macos ?? r.macos ?? old.host.macos, node: r.host?.node ?? old.host.node, vision_revision: r.host?.vision_revision ?? old.host.vision_revision };
      delete r.macos;
      r.date ??= old.date;
    }
    reported.unshift(...old.variants.map((x) => x.variant).filter((x) => !variants.includes(x)));
    reported.sort((x, y) => Object.keys(VARIANTS).indexOf(x) - Object.keys(VARIANTS).indexOf(y));
  }
  const save = () => {
    result.variants = summarize(result.runs, reported);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  };
  console.error(`catscan-agents: work dir ${base}`);
  await Promise.all(agents.map(async (a) => {
    for (const seed of seeds) for (const variant of variants.filter((x) => VARIANTS[x].agent === a)) {
      if (result.agents[a].stopped) return;
      const { dir, bad } = prepare(base, variant, seed, renders.dir);
      const t0 = Date.now();
      const o = await runAgent(variant, dir);
      fs.writeFileSync(path.join(base, `${variant}-seed${seed}.stdout.jsonl`), o.stdout);
      fs.writeFileSync(path.join(base, `${variant}-seed${seed}.stderr.log`), o.stderr);
      const parsed = PARSE[a](o);
      const err = parsed.error || (o.code !== 0 ? `exit ${o.code}${o.signal ? ` (${o.signal})` : ""}: ${o.stderr.slice(-300)}` : null);
      const stop = stopReason(parsed, o);
      if (stop) {
        result.agents[a].stopped = { variant, seed, reason: stop };
        console.error(`catscan-agents: ${a} stopped at ${variant} seed ${seed}: ${stop.slice(0, 200)}`);
        save();
        return;
      }
      const s = score(parsed, bad);
      result.runs.push({ agent: a, agent_version: result.agents[a].version, catscan: v.catscan, cli_shim: true, host: { macos: result.host.macos, node: result.host.node, vision_revision: result.host.vision_revision }, date: result.date, model: parsed.model, variant, with_file: !!VARIANTS[variant].file, seed, planted: bad.map(shot), tokens: parsed.tokens, tool_calls: parsed.calls.length, ...s, error: err, seconds: Math.round((Date.now() - t0) / 1000), answer: storedAnswer(parsed.answer) });
      console.error(`catscan-agents: ${variant} seed ${seed}: correct=${s.correct} opened=${s.opened_image} catscan=${s.called_catscan} (${Math.round((Date.now() - t0) / 1000)} s)`);
      save();
    }
  }));
  save();
  // Exit 1 unless every with-file variant passed the gate: a failed, short or never-run variant is not green.
  const short = result.variants.filter((x) => x.with_file && x.gate !== "pass");
  console.error(`catscan-agents: wrote ${path.relative(ROOT, outPath)}; logs in ${base}`);
  process.exitCode = short.length ? 1 : 0;
}

/** Re-parses and re-scores every run in `outPath` from the event logs runs left in `dirs`; writes nothing when a
 * run's logs are in none of them. */
function rescore(outPath, dirs) {
  const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
  for (const r of result.runs) {
    const f = dirs.map((d) => path.join(d, `${r.variant}-seed${r.seed}`)).find((x) => fs.existsSync(`${x}.stdout.jsonl`));
    if (!f) throw new Error(`no logs for ${r.variant} seed ${r.seed} in ${dirs.join(", ")}`);
    const parsed = PARSE[r.agent]({ stdout: fs.readFileSync(`${f}.stdout.jsonl`, "utf8"), stderr: fs.readFileSync(`${f}.stderr.log`, "utf8") });
    const bad = r.planted.map((x) => Number(x.match(/\d+/)[0]) - 1);
    Object.assign(r, { tool_calls: parsed.calls.length, ...score(parsed, bad), answer: storedAnswer(parsed.answer) });
  }
  result.variants = summarize(result.runs, result.variants.map((x) => x.variant));
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Per-variant counts and median tokens; the gate (D12) is pass >= 9 of 10 for a with-file variant. */
function summarize(runs, variants) {
  return variants.map((variant) => {
    const rs = runs.filter((r) => r.variant === variant);
    const tot = (r) => r.tokens ? r.tokens.input + r.tokens.cache_read + r.tokens.cache_write : null;
    return {
      variant, agent: VARIANTS[variant].agent, with_file: !!VARIANTS[variant].file, file: VARIANTS[variant].file, runs: rs.length,
      correct: rs.filter((r) => r.correct).length, opened_image: rs.filter((r) => r.opened_image).length, called_catscan: rs.filter((r) => r.called_catscan).length,
      pass: rs.filter((r) => r.pass).length,
      median_input_tokens: median(rs.map(tot).filter((x) => x !== null)),
      median_uncached_input_tokens: median(rs.filter((r) => r.tokens).map((r) => r.tokens.input)),
      gate: VARIANTS[variant].file ? (rs.length < 10 ? "incomplete" : rs.filter((r) => r.pass).length >= 0.9 * rs.length ? "pass" : "fail") : null,
    };
  });
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
module.exports = { planted, classify, stopReason, parseClaude, parseCodex, parseCursor, namedScreens, score, summarize, SCREENS, VARIANTS };
