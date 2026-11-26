// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, UsageError, PLANNED_OPTIONS, PLANNED_COMMANDS } = require("../src/args");
const expect = require("../src/expect");
const render = require("../src/render");
const { PROTOCOL } = require("../src/client");

const usage = (argv, code) => assert.throws(() => parse(argv), (e) => e instanceof UsageError && e.code === code);

test("args: check with repeated options", () => {
  const o = parse(["check", "shots/", "--present", "Weiter", "--present=Zurück", "--absent", "x.y", "--locale", "de", "--json"]);
  assert.deepEqual(o.present, ["Weiter", "Zurück"]);
  assert.deepEqual(o.absent, ["x.y"]);
  assert.equal(o.locale, "de");
  assert.equal(o.format, "json");
  assert.deepEqual(o.paths, ["shots/"]);
});

test("args: usage errors", () => {
  usage(["check", "a.png", "--presnt", "x"], "unknown-option");
  usage(["chek", "a.png"], "unknown-command");
  usage(["check", "a.png"], "missing-check");
  usage(["check", "--present", "x"], "missing-path");
  usage(["read", "a.png", "--present", "x"], "option-not-valid");
  usage(["read", "a.png", "--json", "--format", "text"], "conflicting-options");
  usage(["read", "a.png", "--format", "xml"], "invalid-value");
  // spec 15: --format github, --junit and --gitlab-codequality are no longer planned options.
  assert.equal(parse(["read", "a.png", "--format", "github"]).format, "github");
  assert.equal(parse(["check", "a", "--present", "x", "--junit", "j.xml", "--gitlab-codequality", "c.json"]).junit, "j.xml");
  usage(["read", "a.png", "--json", "--format", "github"], "conflicting-options");
  usage(["doctor", "--format", "github"], "option-not-valid");
  usage(["languages", "--junit", "j.xml"], "option-not-valid");
  usage(["results", "merge", "a.json", "--out", "m.json", "--gitlab-codequality", "c.json"], "option-not-valid");
  usage(["read", "a.png", "--junit", "r.json", "--results", "./r.json"], "conflicting-options");
  // Case-insensitive macOS volumes, and the job summary under --format github (review fix).
  usage(["read", "a.png", "--junit", "R.json", "--results", "r.json"], "conflicting-options");
  usage(["read", "a.png", "--junit", "caf\u00e9.json", "--results", "cafe\u0301.json"], "conflicting-options");
  process.env.GITHUB_STEP_SUMMARY = "/tmp/summary.md";
  try {
    usage(["read", "a.png", "--format", "github", "--results", "/tmp/summary.md"], "conflicting-options");
    assert.equal(parse(["read", "a.png", "--results", "/tmp/summary.md"]).results, "/tmp/summary.md");
  } finally { delete process.env.GITHUB_STEP_SUMMARY; }
  usage(["read", "a.png", "--escalate"], "option-not-available");
  usage(["read", "a.png", "--report", "r.html", "--results", "./r.html"], "conflicting-options");
  usage(["read", "a.png", "--locale", "de_DE"], "invalid-locale");
  usage(["read", "-", "-"], "repeated-stdin");
  usage(["read", "a.png", "--locale"], "missing-value");
  usage(["overlap", "a.png", "--experimental", "--min-overlap", "0"], "invalid-min-overlap");
  // Added by /ship coverage audit.
  // Value: protects=every documented usage error exits 2 with its code, and -- ends options; fails_when=a guard for =value, repeated --expect, serve options, option-before-command or -- is dropped; why_new=these branches had no row; seam=none; no_claim=none beyond protects
  usage(["read", "a.png", "--json=yes"], "unexpected-value");
  usage(["check", "a.png", "--expect", "a.yaml", "--expect", "b.yaml"], "repeated-option");
  usage(["serve", "--json"], "option-not-valid");
  usage(["serve", "a.png"], "option-not-valid");
  usage(["--present", "x", "read", "a.png"], "option-not-valid");
  // Paths after -- are literal, even when they start with -; an unknown word far from any command gets no suggestion.
  assert.deepEqual(parse(["read", "--", "-odd.png", "--json"]).paths, ["-odd.png", "--json"]);
  assert.throws(() => parse(["zzzzzzzz"]), (e) => e.code === "unknown-command" && e.message === "unknown command zzzzzzzz" && e.hint === "catscan --help");
});

test("args: typo suggestions name the closest option", () => {
  try { parse(["check", "a.png", "--presnt", "x"]); } catch (e) {
    assert.equal(e.message, "unknown option --presnt; did you mean --present?");
  }
  try { parse(["raed", "a.png"]); } catch (e) { assert.match(e.message, /did you mean read\?/); }
});

test("args: languages (TODO-003)", () => {
  assert.equal(parse(["languages"]).command, "languages");
  assert.equal(parse(["languages", "--json"]).format, "json");
  usage(["languages", "a.png"], "option-not-valid");
  usage(["languages", "--locale", "de"], "option-not-valid");
  usage(["languages", "--present", "x"], "option-not-valid");
  // D13: an underscore form names the dashed code.
  assert.throws(() => parse(["read", "a.png", "--locale", "pt_BR"]), (e) => e.code === "invalid-locale" && e.hint === "--locale pt-BR");
  assert.throws(() => parse(["read", "a.png", "--locale", "en-US-u-nu-latn!"]), (e) => e.code === "invalid-locale" && e.hint === "catscan languages");
});

test("render: languages table and the per-OS comparison", () => {
  const info = {
    host: { macos: "27.2 (26B123)", vision_revision: 3 },
    os_table: { macos: 27, known: true, matches: true, added: [], removed: [] },
    languages: [
      { locale: "en", vision: "en-US", script: "Latin", direction: "ltr", no_spaces: false, supported: true, aliases: [] },
      { locale: "zh-Hant", vision: "zh-Hant", script: "Han", direction: "ltr", no_spaces: true, supported: true, aliases: ["zh-TW", "zh-HK"] },
      { locale: "ar", vision: "ar-SA", script: "Arabic", direction: "rtl", no_spaces: false, supported: false, aliases: [] },
    ],
  };
  const out = render.renderLanguages(info);
  assert.equal(out[0], "Locale   Vision   Script  Direction  No spaces  Supported  Aliases");
  assert.equal(out[2], "zh-Hant  zh-Hant  Han     ltr        yes        yes        zh-TW, zh-HK");
  assert.equal(out[3], "ar       ar-SA    Arabic  rtl        -          no         -");
  assert.equal(out[4], "2 languages on macOS 27.2 (26B123), Vision revision 3; matches the macOS 27 table.");
  info.os_table = { macos: 27, known: true, matches: false, added: ["he-IL"], removed: [] };
  assert.match(render.renderLanguages(info)[4], /differs from the macOS 27 table: added he-IL, removed none\.$/);
  info.os_table = { macos: 28, known: false, matches: false, added: [], removed: [] };
  assert.match(render.renderLanguages(info)[4], /no language table for macOS 28 yet\.$/);
  // TODO-037 D10: the fallback locales are named when the core lists them.
  assert.equal(render.renderLanguages(info)[5], "Other locales are read with Tesseract when it is installed (catscan doctor), else unsupported (exit 3).");
  assert.equal(render.renderLanguages({ ...info, fallback_locales: ["el", "hr"] })[5], "Read with Tesseract (install: brew install tesseract tesseract-lang; check: catscan doctor): el, hr. Other locales are unsupported (exit 3).");
  // D11: a language newer than the table shows unknowns, never guessed defaults.
  info.languages.push({ locale: "he-IL", vision: "he-IL", script: "unknown", direction: null, no_spaces: null, supported: true, aliases: [] });
  assert.match(render.renderLanguages(info)[4], /^he-IL +he-IL +unknown +\? +\? +yes +-$/);
});

test("args: --json with --format json is fine", () => {
  assert.equal(parse(["read", "a.png", "--json", "--format", "json"]).format, "json");
});

test("expect: YAML from the spec", () => {
  const e = expect.parse(`locale: de
shots:
  onboarding-1.png: { present: ["Weiter"], absent: ["onboarding.next"] }
  "paywall-*.png":  { present: ["Jetzt testen"] }
`, "de.yaml");
  assert.equal(e.locale, "de");
  assert.deepEqual(expect.checksFor(e, "onboarding-1.png"), { present: ["Weiter"], absent: ["onboarding.next"], keys: ["onboarding-1.png"] });
  assert.deepEqual(expect.checksFor(e, "paywall-2.png").present, ["Jetzt testen"]);
  assert.deepEqual(expect.checksFor(e, "sub/paywall-2.png").keys, []);
  assert.deepEqual(expect.checksFor(e, "other.png").keys, []);
});

test("expect: JSON", () => {
  const e = expect.parse(JSON.stringify({ shots: { "a.png": { present: ["A"] } } }), "x.json");
  assert.equal(e.locale, null);
  assert.deepEqual(expect.checksFor(e, "a.png").present, ["A"]);
});

test("expect: globs", () => {
  const g = expect.globToRegExp;
  assert.ok(g("*.png").test("a.png"));
  assert.ok(!g("*.png").test("d/a.png"));
  assert.ok(g("**/*.png").test("d/e/a.png"));
  assert.ok(g("**/*.png").test("a.png"));
  assert.ok(g("shot-?.png").test("shot-1.png"));
  assert.ok(g("shot-[!0].png").test("shot-1.png"));
  assert.ok(!g("shot-[!0].png").test("shot-0.png"));
  assert.ok(!g("a.png").test("aXpng"));
});

test("expect: review fixes (invalid globs, locale, NFC, lone surrogates, stdin)", () => {
  // Value: protects=bad expect input is a usage error (exit 2), and NFD file names match NFC keys; fails_when=globToRegExp throws raw, locale skips LOCALE_RE, keys are compared unnormalized or lone surrogates pass; why_new=red-team findings; seam=none; no_claim=APFS itself (strings stand in for file names)
  const bad = (text, re, file = "x.yaml") => assert.throws(() => expect.parse(text, file), (e) => e.code === "invalid-expect-file" && re.test(e.message));
  bad('shots:\n  "[z-a].png": { present: [A] }\n', /not a valid glob/);
  bad("locale: de de\nshots: {}\n", /BCP 47/);
  bad(JSON.stringify({ shots: { "a.png": { present: ["\ud800"] } } }).replace("\\ud800", "\\ud800"), /not valid Unicode/, "x.json");
  const e = expect.parse("shots:\n  \u00dc.png: { present: [A] }\n  \"a]*.png\": { present: [B] }\n", "x.yaml");
  assert.deepEqual(expect.checksFor(e, expect.relativeTo("d", "d/U\u0308.png", true)).present, ["A"]);
  assert.deepEqual(expect.checksFor(e, "a]1.png").present, ["B"]);
  usage(["check", "-", "--expect", "e.yaml"], "missing-check");
  assert.equal(parse(["check", "-", "--expect", "e.yaml", "--present", "x"]).paths[0], "-");
});

test("expect: relative key matching", () => {
  assert.equal(expect.relativeTo("shots/de", "shots/de/sub/a.png", true), "sub/a.png");
  assert.equal(expect.relativeTo("shots/de/a.png", "shots/de/a.png", false), "a.png");
});

test("expect: safe parsing rejects", () => {
  const bad = (text, re, file = "x.yaml") => assert.throws(() => expect.parse(text, file), (e) => e.code === "invalid-expect-file" && re.test(e.message));
  bad("shots:\n  a.png: !custom { present: [A] }\n", /custom tags/);
  bad("shots:\n  a.png: !!binary aGk=\n", /custom tags|must be a mapping/);
  bad("shots:\n  /etc/a.png: { present: [A] }\n", /relative path/);
  bad("shots:\n  ../a.png: { present: [A] }\n", /relative path/);
  bad("shots:\n  a.png: { present: A }\n", /list of strings/);
  bad("shots:\n  a.png: { presnt: [A] }\n", /unknown key presnt/);
  bad("locale: de\n", /shots must be a mapping/);
  bad("shots: [\n", /invalid YAML/);
  bad("{", /invalid JSON/, "x.json");
  bad("a".repeat(expect.MAX_BYTES + 1), /1 MB/);
  // Billion laughs: alias expansion past 1000 nodes.
  let y = "a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n";
  for (let i = 1; i < 6; i++) y += `a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(", ")}]\n`;
  bad(y + "shots: {}\n", /alias expansion/);
  // Added by /ship coverage audit.
  // Value: protects=the expect-file schema rejects wrong shapes with exit-2 usage errors; fails_when=a validate() guard is removed and a bad file reaches the engine; why_new=these shape rows were missing; seam=none; no_claim=none beyond protects
  bad("- a.png\n", /top level must be a mapping/);
  bad("locale: de\nshot: {}\n", /unknown key shot/);
  bad("locale: 5\nshots: {}\n", /locale must be a BCP 47 code/);
  bad("shots:\n  a.png: [A]\n", /must be a mapping with present and absent/);
  bad('shots:\n  "C:/a.png": { present: [A] }\n', /relative path/);
  bad('shots:\n  "": { present: [A] }\n', /relative path/);
  assert.throws(() => expect.load(__dirname), (e) => e.code === "invalid-expect-file" && /not a file/.test(e.message));
});

test("exit code precedence: 5, 4, 3, 1, 0", () => {
  assert.equal(render.exitCode([]), 0);
  assert.equal(render.exitCode(["pass", "pass"]), 0);
  assert.equal(render.exitCode(["pass", "fail"]), 1);
  assert.equal(render.exitCode(["fail", "unsupported"]), 3);
  assert.equal(render.exitCode(["unsupported", "error", "fail"]), 4);
  assert.equal(render.exitCode(["error"], { internal: true }), 5);
});

test("TODO-007 --fail-on-skip: a skipped check ranks at 1, under 3, 4 and 5; valid on check and video only", () => {
  // Value: protects=D1, D2 (flag scope, exit precedence); fails_when=skipped is ignored, outranks error/unsupported, or the flag leaks to other commands; why_new=new option; seam=none; no_claim=the CLI wiring (test/catalog.test.js)
  assert.equal(render.exitCode(["pass"]), 0);
  assert.equal(render.exitCode(["pass"], { skipped: true }), 1);
  assert.equal(render.exitCode(["pass", "unsupported"], { skipped: true }), 3);
  assert.equal(render.exitCode(["pass", "error"], { skipped: true }), 4);
  assert.equal(render.exitCode(["pass"], { internal: true, skipped: true }), 5);
  assert.equal(parse(["check", "a.png", "--present", "x", "--fail-on-skip"]).failOnSkip, true);
  assert.equal(parse(["video", "t.mp4", "--present", "x", "--fail-on-skip"]).failOnSkip, true);
  assert.equal(parse(["check", "a.png", "--present", "x"]).failOnSkip, false);
  usage(["read", "a.png", "--fail-on-skip"], "option-not-valid");
  assert.equal(parse(["--fail-on-skip"]).command, null); // no command: main() says missing-command, never "not valid for null"
  usage(["--fail-on-skip", "truncated", "a.png"], "option-not-valid"); // before the command: validate() catches it
  usage(["results", "merge", "a.json", "--out", "m.json", "--fail-on-skip"], "option-not-valid");
});

test("render: totals and diagnostics", () => {
  assert.equal(render.totalsLine(["pass", "pass", "fail", "error"], 0.84), "4 images: 2 pass, 1 fail, 1 error (0.8 s)");
  assert.equal(render.totalsLine(["pass"], 0.1), "1 image: 1 pass (0.1 s)");
  assert.equal(render.diagnosticLine({ code: "locale-script-mismatch", message: "m.", hint: "--locale ru" }), "catscan: locale-script-mismatch: m. - try: --locale ru");
  assert.equal(render.countsLine(["pass", "fail"]), "catscan: counts: 1 pass, 1 fail, 0 needs-reader, 0 unsupported, 0 error");
});

test("render: text lines for read and every failed check kind", () => {
  // Added by /ship coverage audit.
  // Value: protects=the human text output for read and for each non-pass check; fails_when=a checkDetail branch or the read line count is changed or broken; why_new=CLI tests cover only present-not-found text; seam=none; no_claim=wording in docs/cli.md (no golden for text)
  const read = (n) => render.renderText({ command: "read", path: "a.png", verdict: "pass", lines: Array.from({ length: n }, (_, i) => ({ text: `L${i}` })) });
  assert.deepEqual(read(1), ["PASS  a.png (1 line)", "  L0"]);
  assert.deepEqual(read(2), ["PASS  a.png (2 lines)", "  L0", "  L1"]);
  const env = {
    command: "check", path: "b.png", verdict: "fail",
    checks: [
      { kind: "present", text: "Go", verdict: "pass", line: "Go" },
      { kind: "absent", text: "key.x", verdict: "fail", line: "key.x shown", box: [0.1, 0.2, 0.3, 0.04] },
      { kind: "present", text: "Weiter", verdict: "fail", closest: null },
      { kind: "present", text: "…", verdict: "skipped", reason: "no-checkable-text" },
    ],
  };
  assert.deepEqual(render.renderText(env), [
    "FAIL  b.png",
    '  absent "key.x": shown in "key.x shown" at [0.1, 0.2, 0.3, 0.04]',
    '  present "Weiter": not found; no text recognized',
    '  present "…": skipped (no-checkable-text)',
  ]);
  const unsup = { command: "check", path: "c.png", verdict: "unsupported", error: { code: "unsupported-language", message: "m" }, checks: [{ kind: "present", text: "x", verdict: "unsupported" }] };
  assert.deepEqual(render.renderText(unsup), ["UNSUPPORTED c.png", "  unsupported-language: m", '  present "x": unsupported']);
  // TODO-065 D1: a locale catscan reads once its reader is installed names the fix on the check line.
  const nr = { command: "check", path: "d.png", verdict: "needs-reader", error: { code: "reader-missing", message: "m", hint: "brew install tesseract tesseract-lang" }, checks: [{ kind: "present", text: "x", verdict: "needs-reader" }] };
  assert.deepEqual(render.renderText(nr), ["NEEDS-READER d.png", "  reader-missing: m", '  present "x": needs a reader (brew install tesseract tesseract-lang)']);
  assert.equal(render.exitCode(["pass", "needs-reader"]), 3);
  assert.equal(render.exitCode(["needs-reader", "error"]), 4);
  assert.equal(render.countsLine(["needs-reader", "unsupported"]), "catscan: counts: 0 pass, 0 fail, 1 needs-reader, 1 unsupported, 0 error");
  assert.match(render.totalsLine(["pass", "needs-reader"], 1), /: 1 pass, 1 needs-reader \(/);
});

test("cli: a broken or misbehaving catscan-core exits 5 with a diagnostic", () => {
  // Added by /ship coverage audit.
  // Value: protects=exit 5 (internal) when the binary crashes, speaks another protocol or answers without a verdict; fails_when=cli.js catch/internal paths stop setting exit 5; why_new=no test drives cli.js with a failing core; seam=none (uses the documented CATSCAN_CORE_BINARY); no_claim=a real Vision crash (fake node scripts stand in for catscan-core)
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-fakecore-"));
  const ready = (p) => `process.stdout.write(JSON.stringify({ id: null, type: "ready", catscan: "0.0.1", protocol: ${p} }) + "\\n");`;
  const fake = (name, body) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    return f;
  };
  const crash = fake("crash", `${ready(PROTOCOL)} process.stdin.once("data", () => process.exit(9));`);
  const mismatch = fake("mismatch", `${ready(PROTOCOL + 1)} process.stdin.resume();`);
  const noVerdict = fake("noverdict", `${ready(PROTOCOL)} let b = ""; process.stdin.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\\n")) >= 0) { const r = JSON.parse(b.slice(0, i)); b = b.slice(i + 1); process.stdout.write(JSON.stringify({ id: r.id, error: { code: "invalid-request", message: "nope" } }) + "\\n"); } });`);
  const run = (bin, args) => spawnSync(process.execPath, [path.resolve(__dirname, "../../../bin/catscan.js"), ...args], {
    encoding: "utf8", env: { ...process.env, CATSCAN_CORE_BINARY: bin },
  });
  const args = ["check", path.join(tmp, "a.png"), "--present", "x"];
  const c = run(crash, args);
  assert.equal(c.status, 5, c.stderr);
  assert.match(c.stderr, /catscan: binary-failed: catscan-core exited \(9\) with requests pending/);
  assert.match(c.stdout, /^0 images: 0 pass \(\d+\.\d s\)\n$/);
  const m = run(mismatch, args);
  assert.equal(m.status, 5, m.stderr);
  assert.match(m.stderr, /catscan: serve-protocol-mismatch: /);
  const n = run(noVerdict, args);
  assert.equal(n.status, 5, n.stderr);
  assert.match(n.stderr, /catscan: invalid-request: nope/);
  // Review fix: a crash with several requests pending still exits 5, without unhandled rejections.
  const two = run(crash, ["check", path.join(tmp, "a.png"), path.join(tmp, "b.png"), "--present", "x"]);
  assert.equal(two.status, 5, two.stderr);
  assert.doesNotMatch(two.stderr, /Unhandled|at ChildProcess/);
  // TODO-003 D9: a failed Vision language query is exit 5 for languages and for check, never 3 or 4.
  const langFail = fake("langfail", `const err = { code: "vision-languages-failed", message: "Vision could not list its recognition languages: boom", hint: "rerun" };
if (process.argv[2] === "languages") { process.stdout.write(JSON.stringify({ error: err }) + "\\n"); process.exit(5); }
${ready(PROTOCOL)} let b = ""; process.stdin.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\\n")) >= 0) { const r = JSON.parse(b.slice(0, i)); b = b.slice(i + 1); process.stdout.write(JSON.stringify({ id: r.id, schema: 1, command: r.command, path: r.path, verdict: "error", error: err, checks: [], findings: [], warnings: [] }) + "\\n"); } });`);
  const lf = run(langFail, ["languages"]);
  assert.equal(lf.status, 5, lf.stderr);
  assert.match(lf.stderr, /^catscan: vision-languages-failed: Vision could not list its recognition languages: boom - try: rerun/);
  const cf = run(langFail, args);
  assert.equal(cf.status, 5, cf.stderr);
  assert.match(cf.stderr, /vision-languages-failed/);
  const garbage = run(fake("garbage", `process.stdout.write("not json\\n");`), ["languages"]);
  assert.equal(garbage.status, 5);
  assert.match(garbage.stderr, /binary-failed: catscan-core languages exited 0/);
  // Review fix: --version with a missing binary reports a documented code.
  const v = run(path.join(tmp, "missing-core"), ["--version"]);
  assert.equal(v.status, 5);
  assert.match(v.stderr, /^catscan: binary-not-found: CATSCAN_CORE_BINARY points to a missing file/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("client: a request after the core died rejects instead of hanging", async () => {
  // Value: protects=Server.request settles after the process is gone; fails_when=request() queues onto a dead stdin; why_new=no test sends after exit; seam=none; no_claim=a real binary crash (fake node core)
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { Server } = require("../src/client");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-dead-")), "core");
  fs.writeFileSync(f, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ id: null, type: "ready", catscan: "0.0.1", protocol: ${PROTOCOL} }) + "\\n");\nprocess.stdin.once("data", () => process.exit(3));\n`, { mode: 0o755 });
  const s = new Server({ bin: f });
  await s.ready;
  await assert.rejects(s.request({ id: "a", command: "read", path: "x" }), (e) => e.code === "binary-failed");
  await assert.rejects(s.request({ id: "b", command: "read", path: "x" }), (e) => e.code === "binary-failed");
});

test("client: a core whose first line is not JSON, or not the ready line, rejects ready with binary-failed", async () => {
  // Added by /ship coverage audit.
  // Value: protects=Server.ready rejects with binary-failed when catscan-core's first line is not JSON or not type ready; fails_when=client.js onData stops checking the first line or uses another code; why_new=only the protocol-mismatch and crash paths are tested; seam=none; no_claim=a real catscan-core misbehaving (fake node scripts stand in)
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { Server } = require("../src/client");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-fakecore-"));
  const fake = (name, line) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(line + "\n")});\nprocess.stdin.resume();\n`, { mode: 0o755 });
    return f;
  };
  const cases = [
    [fake("notjson", "hello from core"), /not JSON/],
    [fake("notready", JSON.stringify({ id: "x", verdict: "pass" })), /did not send the ready line first/],
  ];
  for (const [bin, msg] of cases) {
    const s = new Server({ bin });
    await assert.rejects(s.ready, (e) => e.code === "binary-failed" && msg.test(e.message));
    await s.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("inputs: a folder walk keeps image extensions only and does not follow symlinked folders", () => {
  // Added by /ship coverage audit.
  // Value: protects=collect() on a folder returns only .png/.jpg/.jpeg/.heic (any case), sorted, and skips symlinked folders; fails_when=the IMAGE_EXT filter or the no-follow rule in walk() is dropped; why_new=goldens use a folder with images only and no links; seam=none; no_claim=symlinks to files outside the folder, HEIC decoding
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { collect } = require("../src/inputs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-inputs-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-outside-"));
  for (const f of ["b.png", "a.JPG", "c.jpeg", "d.heic", "notes.txt", "e.gif", "png"]) fs.writeFileSync(path.join(tmp, f), "");
  fs.mkdirSync(path.join(tmp, "sub"));
  fs.writeFileSync(path.join(tmp, "sub", "z.png"), "");
  fs.writeFileSync(path.join(outside, "linked.png"), "");
  fs.symlinkSync(outside, path.join(tmp, "link"));
  fs.symlinkSync(tmp, path.join(tmp, "sub", "loop"));
  const got = collect([tmp]);
  assert.deepEqual(got.map((i) => path.relative(tmp, i.path)), ["a.JPG", "b.png", "c.jpeg", "d.heic", "sub/z.png"]);
  assert.ok(got.every((i) => i.arg === tmp && i.argIsDir && !i.stdin));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("args: --fallback (spec 03)", () => {
  assert.equal(parse(["check", "a.png", "--present", "x", "--fallback", "none"]).fallback, "none");
  assert.equal(parse(["read", "a.png", "--fallback=tesseract"]).fallback, "tesseract");
  assert.equal(parse(["read", "a.png"]).fallback, null);
  assert.throws(() => parse(["read", "a.png", "--fallback", "tesserct"]), (e) => e.code === "invalid-value" && e.hint === "--fallback tesseract");
  assert.throws(() => parse(["read", "a.png", "--fallback", "llm"]), (e) => e.code === "invalid-value");
  usage(["languages", "--fallback", "none"], "option-not-valid");
  usage(["read", "a.png", "--fallbak", "none"], "unknown-option");
});

test("args: doctor (spec 03 D1)", () => {
  assert.equal(parse(["doctor"]).command, "doctor");
  assert.equal(parse(["doctor", "--json"]).format, "json");
  usage(["doctor", "a.png"], "option-not-valid");
  usage(["doctr"], "unknown-command");
});

test("render: Tesseract inputs say so on their line (spec 03 D7)", () => {
  const env = { command: "check", path: "el/a.png", verdict: "pass", engine: "tesseract-5.5.3", checks: [] };
  assert.deepEqual(render.renderText(env), ["PASS  el/a.png (tesseract-5.5.3)"]);
  assert.deepEqual(render.renderText({ ...env, engine: "vision-accurate-rev3" }), ["PASS  el/a.png"]);
});

test("args: help and planned-option errors cite no lab spec, TODO or decision ID (TODO-093)", () => {
  // Value: protects=user-facing CLI text carries no lab ids; fails_when=a planned entry or plannedMessage gains a spec number again, or HELP cites one; why_new=check-internal cannot see an id joined at run time; seam=PLANNED_* exports (D1); no_claim=messages of other usage errors
  const LAB_ID = /TODO-\d+|\b[Ss]pecs? \d+|\bD\d{1,3}\b/;
  const { HELP, SHORT_USAGE } = require("../src/cli");
  assert.doesNotMatch(HELP, LAB_ID);
  assert.doesNotMatch(SHORT_USAGE, LAB_ID);
  assert.ok(Object.keys(PLANNED_OPTIONS).length > 0);
  const errors = [
    ...Object.keys(PLANNED_OPTIONS).map((o) => ["read", "a.png", o]),
    ...PLANNED_COMMANDS.map((c) => [c, "a.png"]),
  ].map((argv) => { try { parse(argv); } catch (e) { return e; } return null; });
  for (const e of errors) {
    assert.ok(e instanceof UsageError);
    assert.match(e.code, /^(option|command)-not-available$/);
    assert.doesNotMatch(`${e.message} ${e.hint}`, LAB_ID);
    assert.ok(e.hint, "a planned entry names the next step");
  }
  const esc = errors[Object.keys(PLANNED_OPTIONS).indexOf("--escalate")];
  assert.equal(esc.code, "option-not-available");
  assert.equal(esc.message, "--escalate is not available in this version");
  assert.equal(esc.hint, "run the same command without --escalate");
  // The registry of planned commands is empty today; a temporary entry proves that branch, not unknown-command.
  PLANNED_COMMANDS.push("planned-probe");
  try {
    const cmd = (() => { try { parse(["planned-probe", "a.png"]); } catch (e) { return e; } return null; })();
    assert.ok(cmd instanceof UsageError);
    assert.equal(cmd.code, "command-not-available");
    assert.equal(cmd.message, "the command planned-probe is not available in this version");
    assert.equal(cmd.hint, "catscan --help");
  } finally { PLANNED_COMMANDS.pop(); }
});

test("help: catscan <command> --help prints that command's usage, options and exit codes only (TODO-093 T2)", () => {
  // Value: protects=per-command help names exactly the options the command takes, plus its usage and exit codes;
  // fails_when=a help block has no command tag, a command's help names an option its parser rejects, or misses one it
  // takes; why_new=no test covered per-command help; seam=HELP_BLOCKS, commandHelp exports; no_claim=wording
  const { HELP, HELP_BLOCKS, commandHelp } = require("../src/cli");
  const { COMMANDS, OPTIONS } = require("../src/args");
  const LAB_ID = /TODO-\d+|\b[Ss]pecs? \d+|\bD\d{1,3}\b/;
  for (const block of HELP.split("\n\n")) {
    assert.ok(HELP_BLOCKS.some(([prefix]) => block.startsWith(prefix)), `help block has a command tag: ${block.slice(0, 40)}`);
  }
  // The options help documents: the --names before an entry's description (two spaces after the names), and every
  // option in the command's usage lines.
  const documented = (help) => new Set(help.split("\n").flatMap((l) => {
    if (l.startsWith("  --")) return l.slice(2).split(/ {2,}/)[0].match(/--[a-z][a-z-]*/g) || [];
    if (/^ {2}catscan |^ {3,}\[/.test(l)) return l.match(/--[a-z][a-z-]*/g) || [];
    return [];
  }));
  // The real parser is the oracle: a command takes an option when parse() does not reject it there.
  const ARGS = { check: ["a.png"], read: ["a.png"], untranslated: ["a.png"], video: ["a.mp4"], truncated: ["a.png"],
    overlap: ["a.png", "--boxes", "b"], formats: ["a.png"], fit: ["a.png", "--experimental"],
    contrast: ["a.png", "--experimental"], boxes: ["xcuitest", "d.txt"], languages: [], doctor: [], serve: [],
    results: [["merge", "a.json", "--out", "o.json"], ["validate", "a.json"], ["known", "a.json", "--out", "k.json"],
      ["baseline", "a.json", "--out", "b.json"]], report: ["a.json"], pseudo: ["en.json"] };
  // Options that only work beside another one, as their own help says.
  const WITH = { "--report-images": ["--report", "r.html"], "--report-max-edge": ["--report", "r.html"], "--frames": ["--json"],
    "untranslated --dynamic": ["--pseudo", "--catalog", "c.json"], "untranslated --boxes": ["--pseudo", "--catalog", "c.json"],
    "untranslated --experimental": ["--catalog", "c.json", "--uncatalogued"] };
  // A valid value, so a value error cannot hide the command's own rejection.
  const VALUE = { "--fallback": "none", "--format": "json", "--text-record": "digest", "--min-severity": "major",
    "--min-certainty": "high", "--level": "AA", "--orientation": "portrait", "--report-images": "embed",
    "--variant": "accent", "--layout": "{locale}/{screen}", "--locale": "de", "--reasons": "ellipsis" };
  // Bases may still miss a check option; only an option error counts.
  const optionError = (argv) => { try { parse(argv); return false; } catch (e) { return /^(option-not-valid|unknown-option)$/.test(e.code); } };
  // A helper option is added only where the command takes it, so an option error then comes from the probe itself,
  // whatever its message (languages, serve and doctor reject with generic messages).
  // results takes an option when any of its subcommands does.
  const takes = (command, option) => (Array.isArray(ARGS[command][0]) ? ARGS[command] : [ARGS[command]]).some((args) => {
    const spec = OPTIONS[option];
    const helper = WITH[`${command} ${option}`] || WITH[option] || [];
    const base = optionError([command, ...args, ...helper]) ? [command, ...args] : [command, ...args, ...helper];
    assert.ok(!optionError(base), `probe base has no option error: ${base.join(" ")}`);
    return !optionError([...base, option, ...(spec && spec.value ? [VALUE[option] || "1"] : [])]);
  });
  // Shown although the probe above rejects them: each takes another subcommand or input.
  const SHOWN_ANYWAY = {
    "fit --list-devices": "takes no paths",
    "--help": "every command", "--version": "every command",
  };
  // Taken but not shown: experimental on purpose.
  const NOT_SHOWN = { "untranslated --uncatalogued": "experimental, out of the help on purpose",
    "untranslated --experimental": "only with --uncatalogued" };
  for (const command of COMMANDS) {
    const help = commandHelp(command);
    assert.match(help, new RegExp(`^  catscan ${command}\\b`, "m"), `${command}: usage line`);
    assert.match(help, /^Exit codes: /m, `${command}: exit codes`);
    assert.doesNotMatch(help, LAB_ID, `${command}: no lab id`);
    const shown = documented(help);
    for (const option of shown) {
      if (SHOWN_ANYWAY[option] !== undefined || SHOWN_ANYWAY[`${command} ${option}`] !== undefined) continue;
      assert.ok(takes(command, option), `${command} --help names ${option}, which ${command} rejects`);
    }
    for (const [option, spec] of Object.entries(OPTIONS)) {
      if ((spec.commands && !spec.commands.includes(command)) || NOT_SHOWN[`${command} ${option}`] || !takes(command, option)) continue;
      assert.ok(shown.has(option), `${command} --help documents ${option}`);
    }
  }
  assert.doesNotMatch(commandHelp("check"), /--every/);
  assert.match(commandHelp("video"), /--every/);
  assert.match(commandHelp("results"), /results baseline:/);
  assert.doesNotMatch(commandHelp("check"), /results baseline:|--prune/);
});
