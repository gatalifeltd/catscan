// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 10 measurement parsers (D8, D12): each agent's event stream gives tool calls classified as catscan or image
// opening, the answer and the tokens. Codex and Cursor streams are recorded runs (paths scrubbed); the Claude Code
// streams are written in its stream-json format, since no Claude run could be recorded (spec 10 results).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const a = require("../agents");

const F = (f) => fs.readFileSync(path.join(__dirname, "fixtures/agents", f), "utf8");

test("seeds plant two distinct screens, the same for every variant", () => {
  // Value: protects=D8 seeded plant; fails_when=a seed plants one screen twice or the pick drifts; why_new=new
  // script; seam=none; no_claim=none.
  for (let s = 1; s <= 10; s++) {
    const p = a.planted(s);
    assert.equal(p.length, 2);
    assert.notEqual(p[0], p[1]);
    assert.deepEqual(p, a.planted(s));
  }
  assert.deepEqual(a.planted(1), [0, 6]);
  assert.deepEqual(a.planted(2), [2, 7]);
  for (const [ok, bad] of a.SCREENS) assert.ok(!bad.toLowerCase().includes(ok.toLowerCase()), `${bad} contains ${ok}`);
});

test("Claude Code: catscan call without an image, and an image read", () => {
  // Value: protects=D12 for Claude; fails_when=a Read of a .png is missed, a listing counts as opening, or an MCP
  // call is not counted as catscan; why_new=new parser; seam=stream-json format; no_claim=a live Claude run.
  const ok = a.parseClaude(F("claude-catscan.jsonl"));
  assert.equal(ok.model, "claude-opus-5-5");
  assert.deepEqual(ok.tokens, { input: 12, cache_read: 40000, cache_write: 3000, output: 500 });
  assert.deepEqual(a.score(ok, [2, 7]), { named: [3, 8], correct: true, opened_image: false, called_catscan: true, pass: true });
  const img = a.parseClaude(F("claude-image.jsonl"));
  const s = a.score(img, [2, 7]);
  assert.equal(s.opened_image, true);
  assert.equal(s.called_catscan, false);
  assert.deepEqual(s.named, [3]); // screen-02 shows its label twice (expected = shown): fine
});

test("Codex: a view_image inside a multi-line code cell counts as opening; MCP and CLI calls count as catscan", () => {
  // Value: protects=D12 for Codex, whose JSON stream leaves out view_image; fails_when=the stderr ToolCall entries
  // are read line by line or a temp path containing "catscan" counts as a catscan call; why_new=new parser;
  // seam=recorded runs; no_claim=none.
  const img = a.parseCodex(F("codex-image.stdout.jsonl"), F("codex-image.stderr.log"));
  assert.equal(img.model, "gpt-5.6-sol");
  assert.ok(img.tokens.cache_read > 0);
  assert.deepEqual(a.score(img, [2, 7]), { named: [8], correct: false, opened_image: true, called_catscan: false, pass: false });
  const both = a.parseCodex(F("codex-catscan-and-image.stdout.jsonl"), F("codex-catscan-and-image.stderr.log"));
  const s = a.score(both, [0, 6]);
  assert.equal(s.called_catscan, true);
  assert.equal(s.opened_image, true);
});

test("Cursor: MCP catscan calls without an image, and Read calls on screenshots", () => {
  // Value: protects=D12 for Cursor; fails_when=mcpToolCall or readToolCall shapes are misread; why_new=new parser;
  // seam=recorded runs; no_claim=none.
  const ok = a.parseCursor(F("cursor-catscan.jsonl"));
  assert.equal(ok.model, "Composer 2.5");
  assert.ok(ok.calls.some((c) => c.name === "mcp:catscan:check_text" && c.catscan));
  assert.deepEqual(a.score(ok, [2, 7]), { named: [3, 8], correct: true, opened_image: false, called_catscan: true, pass: true });
  const img = a.parseCursor(F("cursor-image.jsonl"));
  const s = a.score(img, [0, 6]);
  assert.equal(s.opened_image, true);
  assert.deepEqual(s.named, [1, 7]); // the "**Correct:** screen-02 ..." line names fine screens
  assert.equal(s.correct, true);
  assert.equal(s.pass, false);
});

test("classify: shell listings, catscan commands and paths that contain catscan", () => {
  // Value: protects=the opened/catscan rules; fails_when=a substring match decides; why_new=new; seam=none; no_claim=none.
  assert.deepEqual(a.classify({ name: "shell", shell: "cd /x/catscan-run && npm test" }), { catscan: false, opened: false });
  assert.deepEqual(a.classify({ name: "shell", shell: "ls screenshots/*.png" }), { catscan: false, opened: false });
  assert.deepEqual(a.classify({ name: "shell", shell: "sips -g pixelWidth screenshots/screen-01.png" }), { catscan: false, opened: true });
  assert.deepEqual(a.classify({ name: "shell", shell: "npx -y @catscan/cli check screenshots --present Go --json" }), { catscan: true, opened: false });
  assert.deepEqual(a.classify({ name: "shell", shell: "catscan --version" }), { catscan: false, opened: false });
  assert.deepEqual(a.classify({ name: "Read", args: { file_path: "/x/catscan/screen-01.png" } }), { catscan: false, opened: true });
  assert.deepEqual(a.classify({ name: "globToolCall", args: { globPattern: "**/screen-*.png" } }), { catscan: false, opened: false });
  assert.deepEqual(a.classify({ name: "Glob", args: { pattern: "screenshots/*.png" } }), { catscan: false, opened: false });
});

test("summarize: the gate needs 9 passes of 10 with-file runs", () => {
  // Value: protects=spec 10 gate; fails_when=a with-file variant passes at 8 or with fewer than 10 runs; why_new=new;
  // seam=none; no_claim=none.
  const run = (pass) => ({ variant: "cursor-rule", pass, correct: pass, opened_image: false, called_catscan: true, tokens: { input: 1, cache_read: 2, cache_write: 0, output: 1 } });
  const s = (n, k) => a.summarize([...Array(n)].map((_, i) => run(i < k)), ["cursor-rule"])[0];
  assert.equal(s(10, 9).gate, "pass");
  assert.equal(s(10, 8).gate, "fail");
  assert.equal(s(7, 7).gate, "incomplete");
  assert.equal(s(10, 9).median_input_tokens, 3);
});

test("variants: 8 of 10 runs each, 5 with a file (D9, D18)", () => {
  // Value: protects=the run plan of D9 and D18; fails_when=a variant is dropped or loses its file; why_new=D18;
  // seam=none; no_claim=none.
  const v = Object.entries(a.VARIANTS);
  assert.equal(v.length, 8);
  assert.deepEqual(v.filter(([, x]) => x.file).map(([k]) => k), ["claude-skill", "codex-skill", "codex-agents-md", "cursor-rule", "cursor-agents-md"]);
});

test("classify: segments, read tools and code cells (review fixes)", () => {
  // Value: protects=D12 image-open rule; fails_when=a catscan segment hides an image read in the same command, a
  // listing prefix exempts a later read, a search tool naming *.png counts as a read, or a list of image names
  // passed to catscan counts as opening them; why_new=outside-voice review findings; seam=none; no_claim=none.
  assert.deepEqual(a.classify({ name: "shell", shell: "catscan check shots --present Go --json; sips -g pixelWidth shots/screen-01.png" }), { catscan: true, opened: true });
  assert.deepEqual(a.classify({ name: "shell", shell: "ls shots/*.png && cat shots/screen-01.png" }), { catscan: false, opened: true });
  assert.deepEqual(a.classify({ name: "shell", shell: "npx -y @catscan/cli --version" }), { catscan: false, opened: false });
  assert.deepEqual(a.classify({ name: "Grep", args: { pattern: "x", glob: "*.png" } }), { catscan: false, opened: false });
  assert.deepEqual(a.classify({ name: "grepToolCall", args: { glob: "**/*.png" } }), { catscan: false, opened: false });
  const list = 'const xs = ["screen-01.png","screen-02.png"];\nconst rs = await Promise.all(xs.map((p) => tools.mcp__catscan__check_text({path:`screenshots/${p}`})));';
  assert.deepEqual(a.classify({ name: "exec", args: list }), { catscan: true, opened: false });
  assert.deepEqual(a.classify({ name: "exec", args: list + "\nawait tools.view_image({path:'screenshots/screen-01.png'});" }), { catscan: true, opened: true });
  assert.deepEqual(a.classify({ name: "exec", args: 'const b = fs.readFileSync("screenshots/screen-01.png");' }), { catscan: false, opened: true });
});

test("namedScreens: lists after one screen, and 'except'", () => {
  // Value: protects=correctness scoring; fails_when=a list names only its first screen or an "all pass except" answer
  // flags nothing; why_new=outside-voice review findings; seam=none; no_claim=free-form phrasings beyond these.
  assert.deepEqual(a.namedScreens("Screens 3 and 7 show the wrong label."), [3, 7]);
  assert.deepEqual(a.namedScreens("Wrong: screen-03 and 07."), [3, 7]);
  assert.deepEqual(a.namedScreens("All screens pass except screen-01 and screen-07."), [1, 7]);
});

test("stopReason: structured auth or limit errors stop; debug timestamps and scored answers do not", () => {
  // Value: protects=a stop never drops a scorable run; fails_when=a ".401Z" debug timestamp or a run that answered
  // stops the agent; why_new=review findings; seam=none; no_claim=agent-specific error wording.
  const p = (error, answer = "") => ({ error, answer });
  assert.match(a.stopReason(p("API Error: 401 OAuth access token is invalid"), { code: 1, stderr: "" }), /401/);
  assert.match(a.stopReason(p(null), { code: 1, stderr: "ERROR: You've hit your usage limit" }), /usage limit/);
  assert.equal(a.stopReason(p(null), { code: 1, stderr: "2026-11-11T10:26:32.401234Z DEBUG codex_core: x" }), null);
  assert.equal(a.stopReason(p(null, "screen-03 is wrong"), { code: 1, stderr: "429" }), null);
});

test("summarize: the gate is 9 of 10 as a share, not 9 passes of any count", () => {
  // Value: protects=spec 10 gate; fails_when=9 passes of 20 reads as pass; why_new=red-team finding; seam=none; no_claim=none.
  const run = (pass) => ({ variant: "cursor-rule", pass, correct: pass, opened_image: false, called_catscan: true, tokens: null });
  assert.equal(a.summarize([...Array(20)].map((_, i) => run(i < 9)), ["cursor-rule"])[0].gate, "fail");
  assert.equal(a.summarize([...Array(20)].map((_, i) => run(i < 18)), ["cursor-rule"])[0].gate, "pass");
});

test("pass 2 fixes: shell grouping, other cmd spellings, ranges with except, stop needs a verdict", () => {
  // Value: protects=classification and scoring against formatting; fails_when=a grouped catscan call, a spaced or
  // quoted cmd, a range before "except", or an answer that only mentions screens changes the result; why_new=pass 2
  // review findings; seam=none; no_claim=none.
  assert.deepEqual(a.classify({ name: "shell", shell: "(catscan check x.png --present Go --json)" }), { catscan: true, opened: false });
  assert.deepEqual(a.classify({ name: "shell", shell: "while read f; do npx -y @catscan/cli check \"$f\" --present Go; done" }), { catscan: true, opened: false });
  assert.deepEqual(a.classify({ name: "exec", args: "await tools.exec_command({ cmd: 'cat screenshots/screen-01.png' })" }), { catscan: false, opened: true });
  assert.deepEqual(a.classify({ name: "exec", args: "const c = `sips ${'screenshots/screen-01.png'}`; await tools.exec_command({cmd: c})" }), { catscan: false, opened: true });
  assert.deepEqual(a.namedScreens("Screens 1-9 match, except screen 10."), [10]);
  assert.deepEqual(a.namedScreens("Screens 01–06 and 09–10 show the expected labels."), []);
  assert.equal(a.stopReason({ error: "usage limit reached", answer: "I could not inspect the screens." }, { code: 1, stderr: "" }), "usage limit reached");
});

test("pass 3 fixes: cmd in any position, for-loop headers, inability answers, uppercase ranges", () => {
  // Value: protects=classification and stops; fails_when=a later cmd property, a loop over *.png, "Could not inspect
  // screen-01" or "01 TO 06" changes a result; why_new=pass 3 review findings; seam=none; no_claim=none.
  assert.deepEqual(a.classify({ name: "exec", args: 'await tools.exec_command({workdir:"/tmp", cmd:"catscan check shots --present Go --json"})' }), { catscan: true, opened: false });
  assert.deepEqual(a.classify({ name: "shell", shell: 'for f in screenshots/*.png; do catscan check "$f" --present Go; done' }), { catscan: true, opened: false });
  assert.deepEqual(a.classify({ name: "shell", shell: 'for f in screenshots/screen-*.png; do printf "%s: " "$(basename "$f")"; tesseract "$f" stdout; done' }), { catscan: false, opened: true });
  assert.deepEqual(a.classify({ name: "shell", shell: 'while IFS=: read -r f l; do out=$(catscan check "screenshots/$f" --present "$l" --json 2>&1); echo "$out"; done < expected.yaml' }), { catscan: true, opened: false });
  assert.equal(a.stopReason({ error: "usage limit reached", answer: "Could not inspect screen-01.png." }, { code: 1, stderr: "" }), "usage limit reached");
  assert.deepEqual(a.namedScreens("Screens 01 TO 06 are wrong."), [1, 2, 3, 4, 5, 6]);
});

test("command substitution: its body is a command of its own, the rest of the line too", () => {
  // Value: protects=a with-file run that reads an image next to or around a catscan substitution never passes D12;
  // fails_when=substitutions are split blindly or not at all; why_new=spec 10 D19 follow-up review findings; seam=none; no_claim=none.
  const shell = (s) => a.classify({ name: "shell", shell: s });
  assert.deepEqual(shell("v=$(catscan check a.png --present OK) base64 b.png"), { catscan: true, opened: true });
  assert.deepEqual(shell("catscan check <(cat screenshots/screen-01.png) --present Go --json"), { catscan: true, opened: true });
  assert.deepEqual(shell("for f in $(ls screenshots/*.png); do tesseract \"$f\" stdout; done"), { catscan: false, opened: true });
  assert.deepEqual(shell("for f in `ls screenshots/*.png`; do sips -g pixelWidth \"$f\"; done"), { catscan: false, opened: true });
  assert.deepEqual(shell("out=`catscan check shots --present Go`; echo \"$out\""), { catscan: true, opened: false });
  assert.deepEqual(shell("echo 'out=$(catscan check shots --present Go)' > run.sh"), { catscan: false, opened: false });
  assert.deepEqual(shell('grep -c "\\$(catscan check shots)" notes.txt'), { catscan: false, opened: false });
  // Pass 2 review: loops inside a substitution, apostrophes in comments, shell -c wrappers.
  assert.deepEqual(shell("x=$(for f in shots/*.png; do base64 $f; done)"), { catscan: false, opened: true });
  assert.deepEqual(shell("# don't open the images\nout=$(catscan check shots/a.png --present Go)"), { catscan: true, opened: false });
  assert.deepEqual(shell("bash -lc 'out=$(catscan check shots --present Go); echo $out'"), { catscan: true, opened: false });
  assert.deepEqual(shell('sh -c "catscan check shots --present Go; tesseract shots/a.png stdout"'), { catscan: true, opened: true });
  // Pass 3 review: multi-line quotes stay quoted, heredoc bodies are data, wrapper forms, escaped quotes in -c scripts.
  assert.deepEqual(shell("python3 -c '\nprint(1)\n' && out=$(catscan check shots --present Go)"), { catscan: true, opened: false });
  assert.deepEqual(shell("echo '#!/bin/sh\nout=$(catscan check shots --present Go)\n' > run.sh"), { catscan: false, opened: false });
  assert.deepEqual(shell("cat <<EOF\ndon't\nEOF\nout=$(catscan check shots --present Go)"), { catscan: true, opened: false });
  // Pass 4 review: an interpreter runs its heredoc; arithmetic shifts are no heredoc; dash -c.
  assert.deepEqual(shell("python3 - <<'EOF'\nfrom PIL import Image\nim = Image.open('shots/a.png')\nEOF"), { catscan: false, opened: true });
  assert.deepEqual(shell("bash <<'EOF'\ncatscan check shots --present Go\nEOF"), { catscan: true, opened: false });
  assert.deepEqual(shell("echo $((1<<3))\ncatscan check shots --present Go"), { catscan: true, opened: false });
  assert.deepEqual(shell("dash -c 'catscan check shots --present Go'"), { catscan: true, opened: false });
  assert.deepEqual(shell("bash -lc 'catscan check shots/a.png --present Go --json'"), { catscan: true, opened: false });
  assert.deepEqual(shell('cd /tmp/run && /bin/zsh -lc "npx -y @catscan/cli check screenshots/screen-01.png --present Go --json"'), { catscan: true, opened: false });
  assert.deepEqual(shell('bash -o pipefail -c "catscan check \\"shots/screen 01.png\\" --present Go"'), { catscan: true, opened: false });
});
