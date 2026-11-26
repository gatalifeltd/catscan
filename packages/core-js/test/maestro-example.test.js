// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 14 test plan: the Maestro example's flows, checks, screen list and recipe stay in step, and the two
// scripts run with stub maestro, catscan and adb on PATH (no device, no binary).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const YAML = require("yaml");

const ROOT = path.join(__dirname, "../../..");
const DIR = path.join(ROOT, "examples/maestro");
const RECIPE = path.join(ROOT, "docs/recipes/maestro.md");
const VERSION = require("../../cli/package.json").version;
const SCREENS = fs.readFileSync(path.join(DIR, "screens.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const yamlFiles = (d) => fs.readdirSync(path.join(DIR, d)).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(DIR, d, f));
const shotsOf = (doc) => (Array.isArray(doc) ? doc : []).filter((s) => s && typeof s === "object" && "takeScreenshot" in s).map((s) => s.takeScreenshot);

test("flows and checks parse; every screenshot is shots/${PLATFORM}/<id>.${LOCALE}; ids equal screens.txt both ways", () => {
  const ids = new Set();
  for (const f of [...yamlFiles("flows"), ...yamlFiles("checks")]) {
    const docs = YAML.parseAllDocuments(fs.readFileSync(f, "utf8"));
    for (const d of docs) assert.deepEqual(d.errors, [], f);
    if (!f.includes(`${path.sep}flows${path.sep}`)) continue;
    assert.equal(docs.length, 2, `${f}: config, then steps`);
    for (const shot of shotsOf(docs[1].toJS())) {
      const m = /^shots\/\$\{PLATFORM\}\/([a-z0-9-]+)\.\$\{LOCALE\}$/.exec(shot);
      assert.ok(m, `${f}: ${shot}`);
      ids.add(m[1]);
    }
    // TODO-076: run-all.sh passes PLATFORM=<platform>/<size> for a non-default size, so PLATFORM may name nothing else.
    for (const line of fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes("${PLATFORM}"))) assert.match(line, /takeScreenshot:/, `${f}: ${line}`);
  }
  assert.deepEqual([...ids].sort(), [...SCREENS].sort());
});

test("every check key is <id>.<locale>.png for a listed screen", () => {
  for (const f of yamlFiles("checks")) {
    const locale = path.basename(f).replace(/\.ya?ml$/, "");
    const doc = YAML.parse(fs.readFileSync(f, "utf8"));
    assert.equal(doc.locale, locale, f);
    for (const key of Object.keys(doc.shots)) {
      const m = /^(.+)\.([^.]+)\.png$/.exec(key);
      assert.ok(m && m[2] === locale && SCREENS.includes(m[1]), `${f}: ${key}`);
    }
  }
});

test("recipe: tested catscan version is the release; shell blocks use the scripts' variable names", () => {
  const text = fs.readFileSync(RECIPE, "utf8");
  const tested = /Tested with catscan ([0-9][^ ,]*)/.exec(text);
  assert.ok(tested, "recipe names its tested catscan version");
  assert.equal(tested[1], VERSION);
  const scripts = ["run-all.sh", "run-with-catscan.sh"].map((s) => fs.readFileSync(path.join(DIR, s), "utf8")).join("\n");
  const flows = yamlFiles("flows").map((f) => fs.readFileSync(f, "utf8")).join("\n");
  for (const v of ["MAESTRO_UDID", "PLATFORM", "LOCALE", "APP_ID", "LAYOUT"]) assert.ok(scripts.includes(v) || flows.includes(v), v);
  const blocks = [...text.matchAll(/```(?:sh|bash|yaml)\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 4);
  // Names a recipe block may use: the scripts' and flows' own, the loop variable and the wrapper's catalogs.
  const known = new Set([...`${scripts}\n${flows}`.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]));
  for (const b of blocks) {
    for (const m of b.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)) assert.ok(known.has(m[1]) || m[1] === "L", `recipe uses $${m[1]}`);
  }
});

const RELEASE_REPORT = "catscan report out/*.json --layout '{screen}.{locale}' --expect-devices ios,android --expect-text-sizes default,large --expect-locales de,fr --expect-screens screens.txt --out out/all.html";

test("recipe: the one release report (TODO-075 D15) is the command the end-to-end run executes", () => {
  const text = fs.readFileSync(RECIPE, "utf8");
  const sec = text.split(/^## /m).find((s) => s.startsWith("4. One release report"));
  assert.ok(sec, "section 4. One release report");
  const line = sec.match(/```sh\n([\s\S]*?)```/)[1].split("\n").find((l) => l.startsWith("catscan report "));
  assert.equal(line, RELEASE_REPORT);
  for (const p of ["ios", "android"]) for (const step of [`./run-all.sh ${p} de fr`, `TEXT_SIZE=large ./run-all.sh ${p} de fr`]) assert.ok(sec.includes(`\`${step}\``), step);
  assert.match(fs.readFileSync(path.join(ROOT, "scripts/e2e-maestro.mjs"), "utf8"), /4\. One release report/, "the e2e reads this section");
});

// --- scripts with stubs --------------------------------------------------------------------------------------

// A stub logs its argv as one JSON line. maestro 'test' writes the screenshots its flows name (STUB_SKIP drops
// screens, STUB_NO_SHOTS drops all) and exits STUB_MAESTRO_RC; catscan exits STUB_RC_<COMMAND> and writes --results.
// xcrun simctl and adb report the text size STUB_CONTENT_SIZE / STUB_FONT_SCALE and fail to set it with STUB_SET_FAIL
// (1: any value, else only that value); STUB_GET_FAIL makes the read fail.
const STUB = `
const fs = require("fs"), path = require("path");
const name = path.basename(process.argv[1]); const args = process.argv.slice(2);
const cwd = process.cwd();
const shots = (fs.existsSync(cwd) && fs.readdirSync(cwd).includes("shots")) ? fs.readdirSync(path.join(cwd, "shots")).flatMap((p) => fs.readdirSync(path.join(cwd, "shots", p)).map((f) => p + "/" + f)) : [];
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ name, args, shots }) + "\\n");
if (name === "maestro") {
  if (args.includes("hierarchy")) { process.stdout.write('{"text":"Einstellungen"}'); process.exit(Number(process.env.STUB_HIERARCHY_RC || 0)); }
  const env = {}; args.forEach((a, i) => { if (args[i - 1] === "-e") { const [k, v] = a.split("="); env[k] = v; } });
  const target = args[args.indexOf("test") + 1];
  const once = process.env.STUB_FAIL_ONCE && process.env.STUB_FAIL_ONCE + ".failed";
  if (once && !fs.existsSync(once)) { fs.writeFileSync(once, ""); process.exit(1); }
  if (process.env.STUB_FAIL_FLOW && target.endsWith(process.env.STUB_FAIL_FLOW)) process.exit(1);
  if (process.env.STUB_MAESTRO_SIGNAL) { process.kill(process.ppid, process.env.STUB_MAESTRO_SIGNAL); process.exit(1); }
  const flows = fs.statSync(target).isDirectory() ? fs.readdirSync(target).map((f) => path.join(target, f)) : [target];
  const skip = (process.env.STUB_SKIP || "").split(",");
  for (const f of flows) {
    if (args.includes("--exclude-tags") && /\\n\\s*-\\s*boxes/.test(fs.readFileSync(f, "utf8"))) continue;
    for (const m of fs.readFileSync(f, "utf8").matchAll(/takeScreenshot:\\s*(\\S+)/g)) {
      const p = m[1].replace("\${PLATFORM}", env.PLATFORM).replace("\${LOCALE}", env.LOCALE) + ".png";
      if (process.env.STUB_NO_SHOTS || process.env.STUB_NO_SHOTS_LOCALE === env.LOCALE || skip.includes(path.basename(p).split(".")[0])) continue;
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "");
    }
  }
  process.exit(Number(process.env.STUB_MAESTRO_RC || 0));
}
if (name === "xcrun") {   // simctl only
  const [, sub, , what, value] = args;
  if (sub === "ui" && value === undefined && process.env.STUB_GET_FAIL) process.exit(1);
  if (sub === "ui" && what === "content_size" && value === undefined) { process.stdout.write((process.env.STUB_CONTENT_SIZE || "large") + "\\n"); process.exit(0); }
  if (sub === "ui" && ["1", value].includes(process.env.STUB_SET_FAIL)) { process.stderr.write("An error was encountered processing the command (code=405)\\n"); process.exit(1); }
  process.exit(0);
}
if (name === "adb" && args.includes("font_scale")) {
  if (args.includes("get") && process.env.STUB_GET_FAIL) process.exit(1);
  if (args.includes("get")) { process.stdout.write((process.env.STUB_FONT_SCALE || "null") + "\\r\\n"); process.exit(0); }
  if (["1", args.at(-1)].includes(process.env.STUB_SET_FAIL)) { process.stderr.write("error: device 'SIM-1' not found\\n"); process.exit(1); }
}
if (name === "catscan") {
  const cmd = args[0] === "boxes" ? "BOXES" : args[0].toUpperCase();
  const r = args.indexOf("--results"); if (r > 0) fs.writeFileSync(args[r + 1], "{}");
  if (cmd === "BOXES") process.stdout.write(process.env.STUB_RC_BOXES ? "partial" : "{}");
  process.exit(Number(process.env["STUB_RC_" + cmd] || 0));
}
process.exit(0);
`;

function sandbox({ omit = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan maestro "));   // a space in the path on purpose
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  for (const n of ["maestro", "catscan", "adb", "xcrun"]) {
    if (omit.includes(n)) continue;
    fs.writeFileSync(path.join(bin, n), `#!${process.execPath}\n${STUB}`, { mode: 0o755 });
  }
  const work = path.join(tmp, "work");
  fs.mkdirSync(work);
  for (const f of ["run-all.sh", "run-with-catscan.sh", "screens.txt", "text-sizes.tsv"]) fs.copyFileSync(path.join(DIR, f), path.join(work, f));
  for (const d of ["flows", "checks"]) fs.cpSync(path.join(DIR, d), path.join(work, d), { recursive: true });
  return { tmp, bin, work, log: path.join(tmp, "log.jsonl") };
}

function run(sb, argv, env = {}, opts = {}) {
  const r = spawnSync(opts.shell || "/bin/sh", opts.shell ? ["-c", argv.join(" ")] : argv, {
    cwd: sb.work, encoding: "utf8",
    env: { PATH: `${sb.bin}:/usr/bin:/bin`, STUB_LOG: sb.log, MAESTRO_UDID: "SIM-1", HOME: sb.tmp, ...env },
  });
  const calls = fs.existsSync(sb.log) ? fs.readFileSync(sb.log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { code: r.status, stderr: r.stderr, calls };
}
function runAsync(sb, argv, env = {}) {
  return new Promise((resolve) => {
    const p = spawn("/bin/sh", argv, { cwd: sb.work, env: { PATH: `${sb.bin}:/usr/bin:/bin`, STUB_LOG: sb.log, MAESTRO_UDID: "SIM-1", HOME: sb.tmp, ...env } });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => {
      const calls = fs.existsSync(sb.log) ? fs.readFileSync(sb.log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
      resolve({ code, stderr, calls });
    });
  });
}
const cat = (calls, sub) => calls.filter((c) => c.name === "catscan" && c.args[0] === sub);

test("run-with-catscan: Maestro fails, catscan passes: Maestro's code, catscan still ran", () => {
  const sb = sandbox();
  const r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "ios", "de"], { STUB_MAESTRO_RC: "7" });
  assert.equal(r.code, 7);
  assert.equal(cat(r.calls, "untranslated").length, 1);
  assert.equal(cat(r.calls, "check").length, 1);
});

test("run-with-catscan: untranslated 1 and check 4 give 4; both pass give 0; --udid reaches maestro", () => {
  let sb = sandbox();
  let r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "ios", "de"], { STUB_RC_UNTRANSLATED: "1", STUB_RC_CHECK: "4" });
  assert.equal(r.code, 4);
  sb = sandbox();
  r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "ios", "de"]);
  assert.equal(r.code, 0);
  const m = r.calls.find((c) => c.name === "maestro");
  assert.deepEqual(m.args.slice(0, 2), ["--udid", "SIM-1"]);
  const u = cat(r.calls, "untranslated")[0].args;
  assert.deepEqual(u.slice(0, 2), ["untranslated", "shots/ios/onboarding.de.png"]);
  assert.ok(u.join(" ").includes("--layout {screen}.{locale} --locale de"));
  assert.match(r.stderr, /CATSCAN_BASE unset.*CATSCAN_CATALOG/);
});

test("run-with-catscan: no checks/<locale>.yaml runs untranslated only; catalogs from the env", () => {
  const sb = sandbox();
  fs.rmSync(path.join(sb.work, "checks/de.yaml"));
  const r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "ios", "de"], { CATSCAN_BASE: "a b/en.xml", CATSCAN_CATALOG: "a b/de.xml" });
  assert.equal(r.code, 0);
  assert.equal(cat(r.calls, "check").length, 0);
  const u = cat(r.calls, "untranslated")[0].args;
  assert.equal(u[u.indexOf("--base") + 1], "a b/en.xml");
  assert.equal(u[u.indexOf("--catalog") + 1], "a b/de.xml");
  assert.doesNotMatch(r.stderr, /CATSCAN_BASE unset/);
});

test("run-with-catscan: usage, MAESTRO_UDID unset and missing maestro exit 2, 2 and 5", () => {
  let sb = sandbox();
  let r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "ios"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: run-with-catscan.sh <flow.yaml> <ios\|android> <locale>/);
  r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "ios", "de"], { MAESTRO_UDID: "" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /maestro list-devices/);
  sb = sandbox({ omit: ["maestro"] });
  r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "ios", "de"]);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /maestro not on PATH; install/);
});

test("run-with-catscan: a flow path with a space passes through; old screenshots are gone before maestro runs", () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.work, "my flows"));
  fs.copyFileSync(path.join(sb.work, "flows/settings.yaml"), path.join(sb.work, "my flows/settings.yaml"));
  fs.mkdirSync(path.join(sb.work, "shots/ios"), { recursive: true });
  fs.writeFileSync(path.join(sb.work, "shots/ios/settings.de.png"), "stale");
  fs.writeFileSync(path.join(sb.work, "shots/ios/game.de.png"), "other flow");
  const r = run(sb, ["run-with-catscan.sh", "my flows/settings.yaml", "ios", "de"]);
  assert.equal(r.code, 0);
  const m = r.calls.find((c) => c.name === "maestro");
  assert.equal(m.args[m.args.indexOf("test") + 1], "my flows/settings.yaml");
  assert.deepEqual(m.shots, ["ios/game.de.png"]);
  assert.deepEqual(cat(r.calls, "untranslated")[0].args[1], "shots/ios/settings.de.png");
});

test("run-with-catscan: no screenshot from the flow gives Maestro's code and no catscan call", () => {
  const sb = sandbox();
  const r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "android", "de"], { STUB_NO_SHOTS: "1", STUB_MAESTRO_RC: "1" });
  assert.equal(r.code, 1);
  assert.equal(r.calls.filter((c) => c.name === "catscan").length, 0);
  assert.ok(r.calls.find((c) => c.name === "adb").args.join(" ").includes("set-app-locales org.catscan.sample --locales de"));
});

test("run-all ios: per locale one maestro test with --udid, catscan on that locale's files, flags placed right", () => {
  const sb = sandbox();
  const r = run(sb, ["./run-all.sh", "ios", "de", "fr"], { CATSCAN_FORMAT: "github", CATSCAN_JUNIT_DIR: "out" }, { shell: "/bin/zsh" });
  assert.equal(r.code, 0, r.stderr);
  const tests = r.calls.filter((c) => c.name === "maestro" && c.args.includes("test") && c.args.includes("flows"));
  assert.equal(tests.length, 2);
  for (const t of tests) assert.deepEqual(t.args.slice(0, 2), ["--udid", "SIM-1"]);
  for (const c of r.calls.filter((c) => c.name === "maestro")) assert.deepEqual(c.args.slice(0, 2), ["--udid", "SIM-1"]);
  for (const sub of ["check", "untranslated", "truncated"]) {
    const calls = cat(r.calls, sub);
    assert.equal(calls.length, 2, sub);
    calls.forEach((c, i) => {
      const L = ["de", "fr"][i];
      const files = c.args.filter((a) => a.startsWith("shots/ios/") && a.endsWith(".png"));
      assert.deepEqual(files.sort(), SCREENS.map((s) => `shots/ios/${s}.${L}.png`).sort(), `${sub} ${L}`);
      assert.equal(c.args[c.args.indexOf("--layout") + 1], "{screen}.{locale}");
      assert.equal(c.args[c.args.indexOf("--device") + 1], "ios", `${sub}: TODO-075 tags the platform`);
      assert.equal(c.args[c.args.indexOf("--text-size") + 1], "default", `${sub}: TODO-076 tags the size`);
      assert.equal(c.args[c.args.indexOf("--results") + 1], `out/ios-default-${sub}-${L}.json`, sub);
      assert.ok(!c.args.includes("--expect-locales") && !c.args.includes("--expect-screens"), sub);
      assert.ok(c.args.includes("--format") && c.args.includes("--junit"), sub);
    });
  }
  const boxes = cat(r.calls, "boxes");
  assert.equal(boxes.length, 2);
  assert.ok(!boxes[0].args.includes("--image"));
  const rep = cat(r.calls, "report");
  assert.equal(rep.length, 1);
  assert.equal(rep[0].args[rep[0].args.indexOf("--expect-locales") + 1], "de,fr");
  assert.equal(rep[0].args[rep[0].args.indexOf("--expect-screens") + 1], "screens.txt");
  assert.equal(rep[0].args[rep[0].args.indexOf("--expect-text-sizes") + 1], "default");
  assert.ok(!rep[0].args.includes("--format") && !rep[0].args.includes("--junit"));
  assert.equal(r.calls.filter((c) => c.name === "adb").length, 0);
  assert.deepEqual(r.calls.filter((c) => c.name === "xcrun").map((c) => c.args.join(" ")), ["simctl ui SIM-1 content_size"], "default only reads the size");
});

test("run-all android: set-app-locales before each locale's maestro run; --image on boxes", () => {
  const sb = sandbox();
  const r = run(sb, ["./run-all.sh", "android", "de", "fr"]);
  assert.equal(r.code, 0, r.stderr);
  const seq = r.calls.filter((c) => (c.name === "adb" && c.args.includes("set-app-locales")) || (c.name === "maestro" && c.args.includes("flows")));
  assert.deepEqual(seq.map((c) => c.name), ["adb", "maestro", "adb", "maestro"]);
  assert.ok(seq[2].args.join(" ").endsWith("set-app-locales org.catscan.sample --locales fr"));
  assert.ok(cat(r.calls, "boxes")[0].args.includes("--image"));
  const u = cat(r.calls, "untranslated")[1].args;
  assert.equal(u[u.indexOf("--catalog") + 1], "app-android/src/main/res/values-fr/strings.xml");
});

test("run-all: a locale with no screenshot skips catscan; its stale file is gone (D5); the report still runs", () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.work, "shots/ios"), { recursive: true });
  fs.writeFileSync(path.join(sb.work, "shots/ios/onboarding.fr.png"), "stale");
  const r = run(sb, ["./run-all.sh", "ios", "de", "fr"], { STUB_NO_SHOTS_LOCALE: "fr" });
  assert.equal(r.code, 0, r.stderr);
  for (const sub of ["check", "untranslated", "truncated"]) {
    assert.equal(cat(r.calls, sub).length, 1, sub);
    assert.ok(cat(r.calls, sub)[0].args.every((a) => !a.endsWith(".fr.png")), sub);
  }
  const rep = cat(r.calls, "report");
  assert.equal(rep.length, 1);
  assert.equal(rep[0].args[rep[0].args.indexOf("--expect-locales") + 1], "de,fr");
});

test("run-all: Maestro's failure code wins; no screenshot at all gives no catscan run and no report", () => {
  const sb = sandbox();
  const r = run(sb, ["./run-all.sh", "ios", "de"], { STUB_NO_SHOTS: "1", STUB_MAESTRO_RC: "3" });
  assert.equal(r.code, 3);
  assert.equal(r.calls.filter((c) => c.name === "catscan").length, 0);
  assert.match(r.stderr, /no screenshot for any locale/);
});

test("run-all: a screen a flow did not take is left out of the catscan calls", () => {
  const sb = sandbox();
  const r = run(sb, ["./run-all.sh", "ios", "de"], { STUB_SKIP: "game" });
  assert.equal(r.code, 0);
  assert.equal(cat(r.calls, "report").length, 1);
  assert.ok(!cat(r.calls, "untranslated")[0].args.includes("shots/ios/game.de.png"));
});

test("run-all: a maestro test that fails once is retried once; the run passes", () => {
  const sb = sandbox();
  const r = run(sb, ["./run-all.sh", "ios", "de"], { STUB_FAIL_ONCE: path.join(sb.tmp, "flake") });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c.name === "maestro" && c.args.includes("flows")).length, 2);
  assert.equal(cat(r.calls, "untranslated").length, 1);
});

// Value: protects=run-all report reads only this run's results; fails_when=the out/<platform>-*.json cleanup is dropped and an old locale's results reach the report; why_new=no test seeds out/; seam=none; no_claim=report content
test("run-all: results of an earlier run never reach this run's report", () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.work, "out"));
  fs.writeFileSync(path.join(sb.work, "out/ios-check-it.json"), "{}");           // the name from before TODO-076
  fs.writeFileSync(path.join(sb.work, "out/ios-default-check-it.json"), "{}");
  const r = run(sb, ["./run-all.sh", "ios", "de"]);
  assert.equal(r.code, 0, r.stderr);
  const rep = cat(r.calls, "report")[0].args;
  assert.ok(!rep.includes("out/ios-check-it.json") && !rep.includes("out/ios-default-check-it.json"), rep.join(" "));
  assert.ok(rep.includes("out/ios-default-untranslated-de.json"));
});

// Value: protects=run-all exit is the highest catscan code by spec 00 rank, check skipped without checks/<L>.yaml; fails_when=keep() turns last-wins or check runs without an expect file; why_new=only run-with-catscan tested; seam=none; no_claim=codes above 5
test("run-all: untranslated 4 then truncated 1 gives 4; no checks/<locale>.yaml runs no check", () => {
  const sb = sandbox();
  fs.rmSync(path.join(sb.work, "checks/de.yaml"));
  const r = run(sb, ["./run-all.sh", "ios", "de"], { STUB_RC_UNTRANSLATED: "4", STUB_RC_TRUNCATED: "1" });
  assert.equal(r.code, 4, r.stderr);
  assert.equal(cat(r.calls, "check").length, 0);
  assert.equal(cat(r.calls, "truncated").length, 1);
  assert.equal(cat(r.calls, "report").length, 1);
});

// Value: protects=run-all refuses to start without MAESTRO_UDID (D4) or adb on android; fails_when=either guard is removed and maestro prompts or adb fails mid-run; why_new=guards tested only in run-with-catscan; seam=none; no_claim=message wording beyond the hint
test("run-all: MAESTRO_UDID unset exits 2 naming maestro list-devices; android without adb exits 5", () => {
  let sb = sandbox();
  let r = run(sb, ["./run-all.sh", "ios", "de"], { MAESTRO_UDID: "" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /maestro list-devices/);
  assert.equal(r.calls.length, 0);
  sb = sandbox({ omit: ["adb"] });
  r = run(sb, ["./run-all.sh", "android", "de"]);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /adb not on PATH/);
  assert.equal(r.calls.length, 0);
});

// Value: protects=a failing settings-boxes flow fails the run with Maestro's code (D9); fails_when=the elif that records its rc is dropped and the run exits 0 without boxes; why_new=stub never failed one flow; seam=none; no_claim=hierarchy dump failure
test("run-all: a failing settings-boxes flow gives Maestro's code, no dump and no boxes", () => {
  const sb = sandbox();
  const r = run(sb, ["./run-all.sh", "ios", "de"], { STUB_FAIL_FLOW: "settings-boxes.yaml" });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.calls.filter((c) => c.name === "maestro" && c.args.includes("hierarchy")).length, 0);
  assert.equal(cat(r.calls, "boxes").length, 0);
  assert.equal(cat(r.calls, "untranslated").length, 1);
});

// Value: protects=the wrapper never passes when nothing was checked; fails_when=a flow that left no screenshot,
// takes none, or pairs a strings.xml base with itself exits 0; why_new=review finding (silent pass); seam=none;
// no_claim=Maestro's real screenshot paths (stub writes them)
test("run-with-catscan: nothing checked is never a pass; a flow with no takeScreenshot or a lone strings.xml base is exit 2", () => {
  let sb = sandbox();
  let r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "ios", "de"], { STUB_NO_SHOTS: "1" });
  assert.equal(r.code, 1);
  assert.equal(r.calls.filter((c) => c.name === "catscan").length, 0);
  sb = sandbox();
  r = run(sb, ["run-with-catscan.sh", "flows/settings-boxes.yaml", "ios", "de"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /one-line form/);
  assert.equal(r.calls.length, 0);
  sb = sandbox();
  r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "android", "de"], { CATSCAN_BASE: "values/strings.xml" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /CATSCAN_BASE needs CATSCAN_CATALOG/);
  assert.equal(r.calls.length, 0);
  sb = sandbox();
  r = run(sb, ["run-with-catscan.sh", "flows/onboarding.yaml", "ios", "de"], { CATSCAN_BASE: "Localizable.xcstrings" });
  assert.equal(r.code, 0);
  const u = cat(r.calls, "untranslated")[0].args;
  assert.equal(u[u.indexOf("--catalog") + 1], "Localizable.xcstrings");
});

// Value: protects=run-all review fixes: quoted CI paths, Android region catalogs, a failed dump or conversion is
// recorded and leaves no boxes file, a stale report is removed; fails_when=any of them regresses; why_new=review
// findings; seam=none; no_claim=real Maestro and catscan behavior (stubs)
test("run-all: CI paths with a space stay one argument; pt-BR reads values-pt-rBR; a stale report is removed", () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.work, "out"), { recursive: true });
  fs.writeFileSync(path.join(sb.work, "out/android.html"), "old");
  fs.mkdirSync(path.join(sb.work, "my junit"));
  fs.writeFileSync(path.join(sb.work, "my junit/android-check-fr.xml"), "old");
  const r = run(sb, ["./run-all.sh", "android", "pt-BR"], { CATSCAN_JUNIT_DIR: "my junit" });
  assert.equal(r.code, 0, r.stderr);
  const u = cat(r.calls, "untranslated")[0].args;
  assert.equal(u[u.indexOf("--catalog") + 1], "app-android/src/main/res/values-pt-rBR/strings.xml");
  assert.equal(u[u.indexOf("--junit") + 1], path.join(fs.realpathSync(sb.work), "my junit/android-default-untranslated-pt-BR.xml"));
  assert.ok(!fs.existsSync(path.join(sb.work, "my junit/android-check-fr.xml")));
  assert.ok(!fs.existsSync(path.join(sb.work, "out/android.html")));
});

test("run-all: a failed hierarchy dump is Maestro's failure; a failed conversion leaves no boxes file", () => {
  let sb = sandbox();
  let r = run(sb, ["./run-all.sh", "ios", "de"], { STUB_HIERARCHY_RC: "6" });
  assert.equal(r.code, 6);
  assert.equal(cat(r.calls, "boxes").length, 0);
  assert.equal(cat(r.calls, "truncated").length, 1);
  sb = sandbox();
  r = run(sb, ["./run-all.sh", "ios", "de"], { STUB_RC_BOXES: "4" });
  assert.equal(r.code, 4);
  assert.ok(!fs.existsSync(path.join(sb.work, "shots/ios/settings.de.boxes.json")));
  assert.ok(!fs.existsSync(path.join(sb.work, "shots/ios/settings.de.boxes.tmp")));
  assert.equal(cat(r.calls, "truncated").length, 1);
});

// --- TODO-076: TEXT_SIZE ------------------------------------------------------------------------------------------

const TSV = fs.readFileSync(path.join(DIR, "text-sizes.tsv"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).slice(1).map((l) => l.split("\t"));
const valueOf = (label, platform) => (TSV.find(([l, p]) => l === label && p === platform) || [])[2];
const xc = (calls) => calls.filter((c) => c.name === "xcrun").map((c) => c.args.join(" "));
const setCalls = (calls) => calls.filter((c) => (c.name === "xcrun" && c.args[1] === "ui" && c.args.length === 5) || (c.name === "adb" && c.args.includes("put")));
const reboot = ["simctl shutdown SIM-1", "simctl boot SIM-1", "simctl bootstatus SIM-1 -b"];

// Value: protects=TODO-076 D5/D10 iOS set, reboot, restore and the size's own folders and flags; fails_when=the reboot,
// the restore or the flags are dropped, or large shots land in the default folder; why_new=TODO-076; seam=stub xcrun;
// no_claim=that a real simulator applies the size
test("run-all TEXT_SIZE=large ios: sets AX5 and reboots, flows run, restores large and reboots; shots, flags and files are the size's own", () => {
  const sb = sandbox();
  const r = run(sb, ["./run-all.sh", "ios", "de"], { TEXT_SIZE: "large" });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(xc(r.calls), ["simctl ui SIM-1 content_size", "simctl ui SIM-1 content_size accessibility-extra-extra-extra-large", ...reboot, "simctl ui SIM-1 content_size large", ...reboot]);
  const order = r.calls.map((c) => c.name);
  assert.ok(order.indexOf("maestro") > order.indexOf("xcrun") + 4 && order.lastIndexOf("maestro") < order.length - 4, order.join(" "));
  assert.equal(r.calls.find((c) => c.name === "maestro").args[r.calls.find((c) => c.name === "maestro").args.indexOf("-e") + 1], "PLATFORM=ios/large");
  for (const sub of ["check", "untranslated", "truncated"]) {
    const a = cat(r.calls, sub)[0].args;
    assert.deepEqual(a.filter((x) => x.endsWith(".png")).sort(), SCREENS.map((s) => `shots/ios/large/${s}.de.png`).sort(), sub);
    assert.equal(a[a.indexOf("--device") + 1], "ios", sub);
    assert.equal(a[a.indexOf("--text-size") + 1], "large", sub);
    assert.equal(a[a.indexOf("--results") + 1], `out/ios-large-${sub}-de.json`, sub);
  }
  assert.equal(cat(r.calls, "truncated")[0].args[cat(r.calls, "truncated")[0].args.indexOf("--boxes") + 1], "shots/ios/large");
  assert.ok(fs.existsSync(path.join(sb.work, "shots/ios/large/settings.de.maestro.json")));
  const rep = cat(r.calls, "report")[0].args;
  assert.equal(rep[rep.indexOf("--expect-text-sizes") + 1], "large");
});

test("run-all TEXT_SIZE=large android: font_scale 2.0 before the flows, 1.0 after", () => {
  const sb = sandbox();
  const r = run(sb, ["./run-all.sh", "android", "de"], { TEXT_SIZE: "large" });
  assert.equal(r.code, 0, r.stderr);
  const sets = setCalls(r.calls).map((c) => c.args.join(" "));
  assert.deepEqual(sets, ["-s SIM-1 shell settings put system font_scale 2.0", "-s SIM-1 shell settings put system font_scale 1.0"]);
  const i = r.calls.indexOf(setCalls(r.calls)[0]);
  const j = r.calls.indexOf(setCalls(r.calls)[1]);
  assert.ok(r.calls.slice(i, j).some((c) => c.name === "maestro") && !r.calls.slice(j).some((c) => c.name === "maestro" || c.name === "catscan"));
});

// Value: protects=the trap restores on a failing flow and on INT (D5); fails_when=the trap is set late, misses a
// signal or swallows the exit code; why_new=TODO-076; seam=stub maestro signals its parent shell; no_claim=SIGKILL
test("run-all: the size is restored when maestro fails and on INT, with the run's code", () => {
  for (const [platform, back] of [["ios", "simctl ui SIM-1 content_size large"], ["android", "-s SIM-1 shell settings put system font_scale 1.0"]]) {
    let sb = sandbox();
    // A failed hierarchy dump is a Maestro failure without the retry's 5 s pause.
    let r = run(sb, ["./run-all.sh", platform, "de"], { TEXT_SIZE: "large", STUB_HIERARCHY_RC: "7" });
    assert.equal(r.code, 7, `${platform}: ${r.stderr}`);
    assert.equal(setCalls(r.calls).at(-1).args.join(" "), back, platform);
    sb = sandbox();
    r = run(sb, ["./run-all.sh", platform, "de", "fr"], { TEXT_SIZE: "large", STUB_MAESTRO_SIGNAL: "SIGINT" });
    assert.equal(r.code, 130, `${platform}: ${r.stderr}`);
    assert.equal(r.calls.filter((c) => c.name === "maestro").length, 1, `${platform}: no retry, no next locale after INT`);
    assert.equal(setCalls(r.calls).at(-1).args.join(" "), back, platform);
  }
});

test("run-all: a size that cannot be set is exit 5 text-size-set-failed with the tool's stderr; no flow runs", () => {
  for (const [platform, list, err] of [["ios", "xcrun simctl list devices booted", "code=405"], ["android", "adb devices", "not found"]]) {
    const sb = sandbox();
    const r = run(sb, ["./run-all.sh", platform, "de"], { TEXT_SIZE: "large", STUB_SET_FAIL: "1" });
    assert.equal(r.code, 5, platform);
    assert.match(r.stderr, new RegExp(`run-all: text-size-set-failed: .*${err}.*check the device with: ${list}`), platform);
    assert.equal(r.calls.filter((c) => c.name === "maestro" || c.name === "catscan").length, 0, platform);
  }
});

test("run-all: a device not at the default size warns text-size-not-default with the restore command", () => {
  let r = run(sandbox(), ["./run-all.sh", "ios", "de"], { TEXT_SIZE: "xl", STUB_CONTENT_SIZE: "accessibility-medium", STUB_NO_SHOTS: "1" });
  assert.match(r.stderr, /run-all: text-size-not-default: SIM-1 is at accessibility-medium, not the default large; restore with: xcrun simctl ui SIM-1 content_size large && xcrun simctl shutdown SIM-1 && xcrun simctl boot SIM-1/);
  r = run(sandbox(), ["./run-all.sh", "android", "de"], { TEXT_SIZE: "large", STUB_FONT_SCALE: "1.3", STUB_NO_SHOTS: "1" });
  assert.match(r.stderr, /run-all: text-size-not-default: SIM-1 is at 1\.3, not the default 1\.0; restore with: adb -s SIM-1 shell settings put system font_scale 1\.0/);
  r = run(sandbox(), ["./run-all.sh", "android", "de"], { STUB_NO_SHOTS: "1" });
  assert.doesNotMatch(r.stderr, /text-size-not-default|text-size-reset/, "an unset font_scale is the default");
  assert.equal(setCalls(r.calls).length, 0, "a device at the default is not touched");
});

// Value: protects=TODO-076 D14 a default run never records a leftover size as default, and a failed restore is not
// exit 0; fails_when=the default run skips the reset, or a restore failure after green flows exits 0; why_new=review
// fix; seam=stub xcrun/adb STUB_SET_FAIL=<value>; no_claim=SIGKILL
test("run-all: a default run resets a leftover size first; a failed restore is exit 5", () => {
  for (const [platform, leftover, back, extra] of [["ios", { STUB_CONTENT_SIZE: "accessibility-medium" }, "simctl ui SIM-1 content_size large", reboot],
    ["android", { STUB_FONT_SCALE: "1.3" }, "-s SIM-1 shell settings put system font_scale 1.0", []]]) {
    let r = run(sandbox(), ["./run-all.sh", platform, "de"], leftover);
    assert.equal(r.code, 0, `${platform}: ${r.stderr}`);
    assert.match(r.stderr, /run-all: text-size-reset: SIM-1 was at .*; set it to the default/, platform);
    assert.doesNotMatch(r.stderr, /text-size-not-default/, platform);
    assert.deepEqual(setCalls(r.calls).map((c) => c.args.join(" ")), [back], platform);
    if (extra.length) assert.deepEqual(xc(r.calls).filter((c) => extra.includes(c)), extra, platform);
    const first = r.calls.findIndex((c) => c.name === "maestro");
    assert.ok(first > r.calls.indexOf(setCalls(r.calls)[0]), `${platform}: the reset runs before any flow`);
    // An unreadable size is reset too, and a size run on it does not warn.
    r = run(sandbox(), ["./run-all.sh", platform, "de"], { STUB_GET_FAIL: "1" });
    assert.equal(r.code, 0, `${platform}: ${r.stderr}`);
    assert.match(r.stderr, /text-size-reset: SIM-1 was at unknown/, platform);
    assert.deepEqual(setCalls(r.calls).map((c) => c.args.join(" ")), [back], platform);
    r = run(sandbox(), ["./run-all.sh", platform, "de"], { TEXT_SIZE: "large", STUB_GET_FAIL: "1", STUB_NO_SHOTS: "1" });
    assert.doesNotMatch(r.stderr, /text-size-not-default/, platform);
    // The reset cannot be done: exit 5 before any flow.
    const def = back.split(" ").at(-1);
    r = run(sandbox(), ["./run-all.sh", platform, "de"], { ...leftover, STUB_SET_FAIL: def });
    assert.equal(r.code, 5, platform);
    assert.equal(r.calls.filter((c) => c.name === "maestro").length, 0, platform);
    // Green flows at large, then the restore fails: exit 5, not 0.
    r = run(sandbox(), ["./run-all.sh", platform, "de"], { TEXT_SIZE: "large", STUB_SET_FAIL: def });
    assert.equal(r.code, 5, `${platform}: ${r.stderr}`);
    assert.match(r.stderr, /run-all: text-size-set-failed/, platform);
    // A failed Maestro flow keeps its code when the restore fails too (review fix).
    r = run(sandbox(), ["./run-all.sh", platform, "de"], { TEXT_SIZE: "large", STUB_SET_FAIL: def, STUB_HIERARCHY_RC: "7" });
    assert.equal(r.code, 7, `${platform}: ${r.stderr}`);
  }
});

// Value: protects=two sizes in one report (D5); fails_when=a size run clears the other size's results or the report
// misses a size; why_new=TODO-076; seam=none; no_claim=report content
test("run-all: a second size keeps the first size's out/ files, clears only its own, and the report gets both sizes", () => {
  const sb = sandbox();
  let r = run(sb, ["./run-all.sh", "ios", "de"]);
  assert.equal(r.code, 0, r.stderr);
  fs.writeFileSync(path.join(sb.work, "out/ios-large-check-it.json"), "{}");
  fs.writeFileSync(path.join(sb.log), "");
  r = run(sb, ["./run-all.sh", "ios", "de"], { TEXT_SIZE: "large" });
  assert.equal(r.code, 0, r.stderr);
  const rep = cat(r.calls, "report")[0].args;
  for (const s of ["default", "large"]) for (const sub of ["check", "untranslated", "truncated"]) assert.ok(rep.includes(`out/ios-${s}-${sub}-de.json`), `${s} ${sub}`);
  assert.ok(!rep.includes("out/ios-large-check-it.json"));
  assert.equal(rep[rep.indexOf("--expect-text-sizes") + 1], "default,large");
  assert.ok(fs.existsSync(path.join(sb.work, "shots/ios/settings.de.png")), "the default shots stay");
});

test("run-all: TEXT_SIZE=ax3 on android is exit 2 text-size-unknown listing the android labels; nothing runs", () => {
  const r = run(sandbox(), ["./run-all.sh", "android", "de"], { TEXT_SIZE: "ax3" });
  assert.equal(r.code, 2);
  const labels = TSV.filter(([, p]) => p === "android").map(([l]) => l).join(",");
  assert.match(r.stderr, new RegExp(`run-all: text-size-unknown: android has no setting for TEXT_SIZE=ax3; labels for android: ${labels.replace(/\./g, "\\.")} `));
  assert.equal(r.calls.length, 0);
});

// Value: protects=TODO-076 D7, one mapping; fails_when=the recipe tables, run-all.sh or the Playwright example drift
// from text-sizes.tsv; why_new=TODO-076; seam=stub xcrun and adb; no_claim=that the platform values are right
test("text-sizes.tsv equals the recipe's label tables, run-all.sh's settings and the Playwright de-large project", async () => {
  const md = fs.readFileSync(path.join(ROOT, "docs/recipes/large-text.md"), "utf8").split("\n");
  const fromDoc = [];
  let cols = null;
  for (const line of md) {
    if (/^\| (Label|Exact label) \|/.test(line)) { cols = line.split("|").slice(2, -1).map((c) => c.trim().split(" ")[0].toLowerCase()); continue; }
    if (!cols || !line.startsWith("|")) { cols = null; continue; }
    if (/^\|[\s|-]+$/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const label = /`([^`]+)`/.exec(cells[0])[1];
    cols.forEach((p, i) => { const v = /`([^`]+)`/.exec(cells[i + 1]); if (v) fromDoc.push([label, p, v[1]]); });
  }
  assert.deepEqual(fromDoc.map((r) => r.join("\t")).sort(), TSV.map((r) => r.join("\t")).sort());
  // One run per label, in parallel: the stubs are independent per sandbox.
  await Promise.all(TSV.filter(([l, p]) => l !== "default" && p !== "web").map(async ([label, platform, value]) => {
    const r = await runAsync(sandbox(), ["./run-all.sh", platform, "de"], { TEXT_SIZE: label, STUB_NO_SHOTS: "1" });
    const sets = setCalls(r.calls).map((c) => c.args.at(-1));
    assert.deepEqual(sets, [value, valueOf("default", platform)], `${platform} ${label}: ${r.stderr}`);
  }));
  const config = fs.readFileSync(path.join(ROOT, "examples/playwright/playwright.config.ts"), "utf8");
  const m = /name: "de-large".*viewport: \{ width: (\d+), height: (\d+) \}, deviceScaleFactor: (\d+)/.exec(config);
  assert.ok(m, "the de-large project");
  const zoom = parseInt(valueOf("large", "web"), 10) / 100;
  assert.deepEqual([Number(m[1]) * zoom, Number(m[2]) * zoom, Number(m[3])], [1280, 720, zoom], "200% of the 1280x720 default");
  assert.match(config.split("\n").find((l) => l.includes('name: "de-large"')), /\.\.\.chrome/, "Chromium with --use-angle=metal");
});
