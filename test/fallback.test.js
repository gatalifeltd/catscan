// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Integration tests for the Tesseract fallback (spec 03): with Tesseract, without it, and its failure paths.
// "With Tesseract" cases need it installed (brew install tesseract tesseract-lang) and are skipped otherwise.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, BIN, setup, cli } = require("./helpers");

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(require("../core/schema/result.schema.json"));
const validateDoctor = ajv.compile(require("../core/schema/doctor.schema.json"));
const SHOTS = require("../bench/fallback/synthetic.json").filter((s) => ["el-1.png", "he-1.png"].includes(s.name));
const GREEK = SHOTS.find((s) => s.locale === "el").lines.map((l) => l.text);

let dir;
const tess = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, "bin/catscan.js"), "doctor", "--json"], {
  encoding: "utf8", env: { ...process.env, CATSCAN_CORE_BINARY: BIN },
})).fallback;
const withTess = { skip: tess.path ? false : "Tesseract is not installed (brew install tesseract tesseract-lang)" };
// Absent: PATH emptied, and the override points nowhere, since /opt/homebrew/bin is searched too (spec 03 D2).
const ABSENT = { PATH: "", CATSCAN_TESSERACT: "/nonexistent/tesseract" };

test.before(() => {
  setup();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-fallback-"));
  fs.writeFileSync(path.join(dir, "shots.json"), JSON.stringify(SHOTS));
  execFileSync(path.join(ROOT, ".build/synth"), [path.join(dir, "shots.json"), dir]);
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const el = (...args) => cli(["check", "el-1.png", "--locale", "el", ...args], { cwd: dir });

test("without Tesseract: needs-reader, exit 3, never fail (TODO-065 D1)", () => {
  const r = cli(["check", "el-1.png", "--locale", "el", "--present", GREEK[0], "--absent", "Λάθος", "--json"], { cwd: dir, env: ABSENT });
  assert.equal(r.code, 3, r.stderr);
  const env = r.json[0];
  assert.equal(env.verdict, "needs-reader");
  assert.equal(env.engine, "vision-accurate-rev3");
  assert.deepEqual(env.checks.map((c) => c.verdict), ["needs-reader", "needs-reader"]);
  assert.equal(env.error.code, "reader-missing");
  assert.match(env.error.hint, /^CATSCAN_TESSERACT=\/nonexistent\/tesseract is not a working tesseract/);
  assert.ok(validate(env), JSON.stringify(validate.errors));
});

test("without Tesseract: --fallback tesseract says why", () => {
  const r = cli(["check", "el-1.png", "--locale", "el", "--present", GREEK[0], "--fallback", "tesseract", "-q"], { cwd: dir, env: ABSENT });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /catscan: fallback-unavailable: --fallback tesseract was given, but no Tesseract was found \(looked at \/nonexistent\/tesseract\)[^\n]* - try: CATSCAN_TESSERACT=\/nonexistent\/tesseract is not a working tesseract/);
});

test("doctor without Tesseract: install hint, exit 0", () => {
  const r = cli(["doctor"], { env: ABSENT });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ok   tesseract: not installed \(looked at \/nonexistent\/tesseract\); needed only for el, .* - try: CATSCAN_TESSERACT=\/nonexistent\/tesseract is not a working tesseract/m);
  assert.doesNotMatch(r.stdout, /unsupported/);
});

test("with Tesseract: Greek present and absent checks pass", withTess, () => {
  const r = el(...GREEK.flatMap((t) => ["--present", t]), "--absent", "Λάθος κλειδί", "--json");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const env = r.json[0];
  assert.equal(env.verdict, "pass");
  assert.equal(env.engine, `tesseract-${tess.version}`);
  assert.equal(env.warnings[0].code, "fallback-engine");
  assert.ok(env.checks.every((c) => c.verdict === "pass"));
  assert.ok(validate(env), JSON.stringify(validate.errors));
});

test("with Tesseract: a missing label fails (exit 1) and the text line names the engine", withTess, () => {
  const r = el("--present", "Λάθος κλειδί", "-q");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^FAIL  el-1\.png \(tesseract-/m);
  // D6: -q still says Tesseract read it.
  assert.match(r.stderr, /catscan: fallback-engine: /);
});

test("with Tesseract: --fallback none is needs-reader with a drop hint", withTess, () => {
  const r = el("--present", GREEK[0], "--fallback", "none", "--json");
  assert.equal(r.code, 3);
  assert.equal(r.json[0].verdict, "needs-reader");
  assert.equal(r.json[0].error.hint, "drop --fallback none");
});

test("with Tesseract: a missing pack warns and is needs-reader; TESSDATA_PREFIX gets the files to add, not brew (D6)", withTess, () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-tessdata-"));
  try {
    const m = cli(["check", "el-1.png", "--locale", "el", "--present", GREEK[0], "--json"], { cwd: dir, env: { TESSDATA_PREFIX: empty } });
    assert.equal(m.code, 3, m.stderr);
    const w = m.json[0].warnings.find((x) => x.code === "fallback-pack-missing");
    assert.match(w.message, /has no script\/Greek, eng language data for el/);
    assert.equal(m.json[0].verdict, "needs-reader");
    assert.match(w.hint, /^add script\/Greek\.traineddata, eng\.traineddata to .*catscan-tessdata-.*, then rerun the same command$/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("with Tesseract: a supported locale still uses Vision", withTess, () => {
  const r = cli(["check", "07-ru-phone.png", "--locale", "ru", "--present", "Продолжить", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json[0].engine, "vision-accurate-rev3");
});

test("with Tesseract: read --locale he returns normalized lines", withTess, () => {
  const r = cli(["read", "he-1.png", "--locale", "he", "--json"], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const env = r.json[0];
  const want = SHOTS.find((s) => s.locale === "he").lines.map((l) => l.text);
  assert.deepEqual(env.lines.map((l) => l.text), want);
  for (const l of env.lines) assert.ok(l.box.every((v) => v >= 0 && v <= 1), JSON.stringify(l.box));
  assert.ok(validate(env), JSON.stringify(validate.errors));
});

test("a failing Tesseract is fallback-failed, exit 4", () => {
  const fake = path.join(dir, "tesseract");
  // Answers the probe like Tesseract, then fails on the image.
  fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  --version) echo "tesseract 9.9.9";;
  --list-langs) echo 'List of available languages in "/x/" (2):'; echo script/Greek; echo eng;;
  *) echo "Error opening data file" >&2; exit 1;;
esac
`, { mode: 0o755 });
  const r = cli(["check", "el-1.png", "--locale", "el", "--present", GREEK[0], "--json"], { cwd: dir, env: { CATSCAN_TESSERACT: fake } });
  assert.equal(r.code, 4, r.stderr);
  assert.equal(r.json[0].error.code, "fallback-failed");
  assert.match(r.json[0].error.message, /Tesseract 9\.9\.9 at .* exited with status 1: Error opening data file/);
});

test("a fake Tesseract's TSV drives the checks, without a real install", () => {
  // Covers the fallback success path on a Mac without Tesseract (the withTess cases skip there).
  const fake = path.join(dir, "tesseract-tsv");
  const row = (n, l, t, text) => `5\t1\t${n}\t1\t1\t1\t${l}\t${t}\t300\t60\t95\t${text}`;
  fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  --version) echo "tesseract 9.9.9";;
  --list-langs) echo 'List of available languages in "/x/" (2):'; echo script/Greek; echo eng;;
  *) printf 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n${row(1, 100, 200, GREEK[0])}\n${row(2, 100, 900, GREEK[1])}\n';;
esac
`, { mode: 0o755 });
  const env = { CATSCAN_TESSERACT: fake };
  const r = cli(["check", "el-1.png", "--locale", "el", "--present", GREEK[0], "--present", GREEK[1], "--absent", GREEK[2], "--json"], { cwd: dir, env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json[0].engine, "tesseract-9.9.9");
  assert.equal(r.json[0].warnings[0].code, "fallback-engine");
  assert.deepEqual(r.json[0].checks.map((c) => c.verdict), ["pass", "pass", "pass"]);
  assert.deepEqual(r.json[0].checks[0].box, [0.0775, 0.0715, 0.2326, 0.0215]);
  const none = cli(["check", "el-1.png", "--locale", "el", "--present", GREEK[0], "--fallback", "none", "--json"], { cwd: dir, env });
  assert.equal(none.code, 3);
  assert.equal(none.json[0].error.hint, "drop --fallback none");
});

// Value: protects=TODO-036 D17 (overflow on a Tesseract read says it is unmeasured, under --quiet too); fails_when=the Engine call site, its truncated/boxes guard or the ALWAYS_SHOWN entry goes; why_new=new warning; seam=fake Tesseract; no_claim=overflow on real Tesseract lines
test("truncated on a Tesseract read with boxes warns rule-unmeasured-reader, unless overflow is left out (TODO-036 D17)", () => {
  const fake = path.join(dir, "tesseract-trunc");
  fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  --version) echo "tesseract 9.9.9";;
  --list-langs) echo 'List of available languages in "/x/" (2):'; echo script/Greek; echo eng;;
  *) printf 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t100\t200\t300\t60\t95\t${GREEK[0]}\n';;
esac
`, { mode: 0o755 });
  const shot = SHOTS.find((s) => s.name === "el-1.png");
  fs.writeFileSync(path.join(dir, "el-1.boxes.json"), JSON.stringify({ image: { width: shot.width, height: shot.height }, elements: [] }));
  const env = { CATSCAN_TESSERACT: fake };
  const run = (...a) => cli(["truncated", "el-1.png", "--locale", "el", ...a], { cwd: dir, env });
  const codes = (r) => r.json[0].warnings.map((w) => w.code);
  assert.ok(codes(run("--boxes", "el-1.boxes.json", "--json")).includes("rule-unmeasured-reader"));
  assert.ok(!codes(run("--boxes", "el-1.boxes.json", "--json", "--reasons", "ellipsis,prefix,edge,screen-edge")).includes("rule-unmeasured-reader"));
  assert.ok(!codes(run("--json")).includes("rule-unmeasured-reader"), "no boxes: the rule did not run");
  const quiet = run("--boxes", "el-1.boxes.json", "--quiet");
  assert.match(quiet.stderr, /rule-unmeasured-reader/);
});

// Value: protects=TODO-067 D15, D32, D34 (stacked text, now default-on, says it was not checked on a Tesseract read, under --quiet too, and plain overlap, which then ran no reader, is unsupported with overlap-unchecked; never a silent pass); fails_when=the Engine fallback warning, the unsupported verdict or its ALWAYS_SHOWN entry goes; why_new=default-on changed when it fires; seam=fake Tesseract; no_claim=real Tesseract reads
test("overlap on a Tesseract read warns stacked-unchecked with boxes or --experimental; plain overlap is unsupported (TODO-067 D15, D35)", () => {
  const fake = path.join(dir, "tesseract-stacked");
  fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  --version) echo "tesseract 9.9.9";;
  --list-langs) echo 'List of available languages in "/x/" (2):'; echo script/Greek; echo eng;;
  *) printf 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t100\t200\t300\t60\t95\t${GREEK[0]}\n';;
esac
`, { mode: 0o755 });
  const shot = SHOTS.find((s) => s.name === "el-1.png");
  fs.writeFileSync(path.join(dir, "el-1.boxes.json"), JSON.stringify({ image: { width: shot.width, height: shot.height }, elements: [] }));
  const env = { CATSCAN_TESSERACT: fake };
  const run = (...a) => cli(["overlap", "el-1.png", "--locale", "el", ...a], { cwd: dir, env });
  const codes = (r) => r.json[0].warnings.map((w) => w.code);
  assert.ok(codes(run("--experimental", "--json")).includes("stacked-unchecked"));
  assert.ok(codes(run("--boxes", "el-1.boxes.json", "--json")).includes("stacked-unchecked"), "default-on with boxes too");
  const plain = run("--json"); // D35: no reader ran, so no pass
  assert.equal(plain.code, 3, plain.stderr);
  assert.deepEqual([plain.json[0].verdict, plain.json[0].error.code], ["unsupported", "overlap-unchecked"]);
  assert.match(run("--experimental", "--quiet").stderr, /stacked-unchecked/);
});

test("short text gets a second, upscaled read; tall text one unscaled read (TODO-020)", () => {
  const reads = (height) => {
    const fake = path.join(dir, `tesseract-h${height}`);
    const log = `${fake}.log`;
    // Logs the BMP size of each read: the second read's file is the larger image.
    fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  --version) echo "tesseract 9.9.9";;
  --list-langs) echo 'List of available languages in "/x/" (2):'; echo script/Greek; echo eng;;
  *) stat -f %z "$1" >> "${log}"; printf 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t100\t200\t300\t${height}\t95\t${GREEK[0]}\n';;
esac
`, { mode: 0o755 });
    const r = cli(["check", "el-1.png", "--locale", "el", "--present", GREEK[0], "--json"], { cwd: dir, env: { CATSCAN_TESSERACT: fake } });
    assert.equal(r.code, 0, r.stderr);
    return { sizes: fs.readFileSync(log, "utf8").trim().split("\n").map(Number), warning: r.json[0].warnings[0] };
  };
  const tall = reads(60);
  assert.equal(tall.sizes.length, 1);
  assert.match(tall.warning.message, /Tesseract 9\.9\.9 read it \(-l script\/Greek\+eng\)/);
  const short = reads(20);
  const [first, second] = short.sizes;
  assert.equal(short.warning.code, "fallback-engine");
  assert.match(short.warning.message, /read its short text \(median line 20 px\) again at 2(\.\d+)?x/);
  assert.ok(second > 3 * first, `second read ${second} bytes vs first ${first}`);
});

test("Tesseract output that is not TSV is fallback-failed, never an empty read", () => {
  // Without <tessdata>/configs/tsv, Tesseract prints plain text and exits 0 (red-team review): an empty
  // read would pass every --absent check.
  const fake = path.join(dir, "tesseract-text");
  fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  --version) echo "tesseract 9.9.9";;
  --list-langs) echo 'List of available languages in "/x/" (2):'; echo script/Greek; echo eng;;
  *) echo "Ρυθμίσεις";;
esac
`, { mode: 0o755 });
  const r = cli(["check", "el-1.png", "--locale", "el", "--absent", GREEK[0], "--json"], { cwd: dir, env: { CATSCAN_TESSERACT: fake } });
  assert.equal(r.code, 4, r.stderr);
  assert.equal(r.json[0].error.code, "fallback-failed");
  assert.match(r.json[0].error.message, /did not write TSV output/);
});

test("with Tesseract: a check in a script the locale cannot read stays unsupported", withTess, () => {
  const r = el("--absent", "Продолжить", "--json");
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.json[0].checks[0].verdict, "unsupported");
  assert.equal(r.json[0].engine, `tesseract-${tess.version}`);
});

test("serve: an unknown fallback value is a request error", () => {
  const input = [
    JSON.stringify({ id: "a", command: "read", path: path.join(dir, "he-1.png"), locale: "he", fallback: "llm" }),
    JSON.stringify({ id: "b", command: "read", path: path.join(dir, "he-1.png"), locale: "he", fallback: "none" }),
  ].join("\n") + "\n";
  const out = execFileSync(BIN, ["serve"], { input, encoding: "utf8" }).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(out[1].error.code, "invalid-request");
  assert.equal(out[2].id, "b");
  assert.equal(out[2].verdict, "needs-reader"); // he is read with Tesseract, turned off here (TODO-065)
});

test("doctor --json matches its schema", () => {
  const r = cli(["doctor", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const info = r.json[0];
  assert.ok(validateDoctor(info), JSON.stringify(validateDoctor.errors));
  // TODO-037 D11: every fallback locale has a benchmark corpus, in table order.
  assert.deepEqual(info.fallback.locales.map((l) => l.locale), require("../bench/corpus/build").FALLBACK);
  if (tess.path) assert.ok(info.fallback.locales.find((l) => l.locale === "el").installed);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  test(`${sig} during a Tesseract read removes the temp directory and stops Tesseract (TODO-005)`, async () => {
    const { spawn } = require("child_process");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-sig-"));
    const pidFile = path.join(work, "tess.pid");
    const fake = path.join(work, "tesseract");
    // Answers the probe, then records its pid and sleeps on the image, like a slow read.
    fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  --version) echo "tesseract 9.9.9";;
  --list-langs) echo 'List of available languages in "/x/" (2):'; echo script/Greek; echo eng;;
  *) perl -e 'print join(" ", map { $SIG{$_} // "DEFAULT" } qw(INT TERM))' > "${pidFile}.sig"
     echo "$$ $1" > "${pidFile}.part"; mv "${pidFile}.part" "${pidFile}"; exec sleep 60;;
esac
`, { mode: 0o755 });
    const core = spawn(BIN, ["serve"], { env: { ...process.env, CATSCAN_TESSERACT: fake }, stdio: ["pipe", "ignore", "ignore"] });
    const exited = new Promise((r) => core.once("exit", (code, signal) => r(signal)));
    let pid = 0;
    try {
      core.stdin.write(JSON.stringify({ id: "0", command: "check", path: path.join(dir, "el-1.png"), locale: "el", present: [GREEK[0]], fallback: "tesseract" }) + "\n");
      for (let i = 0; i < 500 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
      const [p, bmp] = fs.readFileSync(pidFile, "utf8").trim().split(" ");
      pid = Number(p);
      const tmp = path.dirname(bmp);
      assert.match(path.basename(tmp), /^catscan-/);
      assert.ok(fs.existsSync(bmp), "the BMP exists while Tesseract runs");
      // serve ignores the signals for its own cleanup; Tesseract must not inherit that, or Ctrl-C and terminate() miss it.
      assert.equal(fs.readFileSync(`${pidFile}.sig`, "utf8"), "DEFAULT DEFAULT");
      core.kill(sig);
      assert.equal(await exited, sig, "dies by the same signal, so the exit status stays conventional");
      assert.equal(fs.existsSync(tmp), false, "the temp directory is gone");
    } finally {
      core.kill("SIGKILL");
    }
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)); } catch { alive = false; }
    }
    assert.equal(alive, false, "the Tesseract child was stopped");
  });
}
