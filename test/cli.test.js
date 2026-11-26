// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Integration tests for check and read through the CLI: goldens, checks, exit codes, schema.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const path = require("path");
const Ajv = require("ajv");
const { ROOT, MANIFEST, setup, cli, hostLocales, golden } = require("./helpers");

const dir = setup();
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(require("../core/schema/result.schema.json"));
const validateLanguages = ajv.compile(require("../core/schema/languages.schema.json"));

function assertSchema(envelopes) {
  for (const e of envelopes) assert.ok(validate(e), `${e.path}: ${JSON.stringify(validate.errors)}`);
}

const byLocale = {};
for (const s of MANIFEST) (byLocale[s.locale] ||= []).push(s);

/** Fixture locales this macOS reads; the rest are named in a diagnostic (TODO-004 D1: macOS 15 lacks pl and sv). */
function readableLocales(t) {
  const have = hostLocales();
  const missing = Object.keys(byLocale).filter((l) => !have.has(l));
  if (missing.length) t.diagnostic(`host-skip: locales not in this macOS row: ${missing.join(", ")}`);
  return Object.entries(byLocale).filter(([l]) => have.has(l));
}

test("read: golden output, byte for byte apart from ms", (t) => {
  const lines = [];
  for (const [locale, shots] of readableLocales(t)) {
    const r = cli(["read", ...shots.map((s) => s.name), "--json", "--locale", locale]);
    assert.equal(r.code, 0, r.stderr);
    assertSchema(r.json);
    lines.push(...r.stdout.split("\n").filter(Boolean));
  }
  // Spec 00: byte for byte apart from ms and host (M1 and M2 runners share a host class, not a chip).
  const actual = lines.map((l) => l.replace(/"ms":\d+/, '"ms":0').replace(/"host":\{[^}]*\}/, '"host":{}')).join("\n") + "\n";
  golden(t, "read.jsonl", actual);
});

test("read: deterministic across runs", () => {
  const strip = (s) => s.replace(/"ms":\d+/g, "");
  const a = cli(["read", ".", "--json"]).stdout;
  const b = cli(["read", ".", "--json"]).stdout;
  assert.equal(strip(a), strip(b));
});

test("check: every synthetic line is present with its locale, apart from this host's golden misreads (--expect)", (t) => {
  // check.json lists the lines this host's Vision misreads, per image: {} on the physical golden host. A VM reads
  // "¿ Olvidaste" on macOS 26 (TODO-004), so the exact verdicts are a per-host golden like read.jsonl.
  const misread = {};
  for (const [locale, shots] of readableLocales(t)) {
    const expect = { locale, shots: Object.fromEntries(shots.map((s) => [s.name, { present: s.lines.map((l) => l.text) }])) };
    const file = path.join(dir, `expect-${locale}.json`);
    fs.writeFileSync(file, JSON.stringify(expect));
    const r = cli(["check", ".", "--expect", file, "--json"]);
    const mine = r.json.filter((e) => shots.some((s) => s.name === e.path));
    assertSchema(r.json);
    for (const e of mine) {
      const bad = e.checks.filter((c) => c.verdict !== "pass");
      assert.equal(e.verdict, bad.length ? "fail" : "pass", `${locale} ${e.path}: ${JSON.stringify(e.checks)}`);
      if (bad.length) misread[e.path] = bad.map((c) => `${c.verdict}: ${c.text}`);
    }
    assert.equal(mine.length, shots.length);
    // Images that match no key get only the command-line checks (none here), so they pass.
    assert.equal(r.code, mine.some((e) => e.verdict !== "pass") ? 1 : 0, r.stderr);
  }
  golden(t, "check.json", JSON.stringify(misread, Object.keys(misread).sort(), 2) + "\n");
});

test("check: expect globs, relative keys and unmatched keys", () => {
  const file = path.join(dir, "glob.yaml");
  fs.writeFileSync(file, 'shots:\n  "0[12]-en-*.png": { present: ["e"] }\n  "15-*.png": { absent: ["remove ads"] }\n  missing.png: { present: [x] }\n');
  const r = cli(["check", ".", "--expect", file, "--json"]);
  const get = (n) => r.json.find((e) => e.path === n);
  assert.equal(get("01-en-phone.png").checks.length, 1);
  assert.equal(get("02-en-small.png").checks.length, 1);
  assert.equal(get("03-de-phone.png").checks.length, 0);
  assert.equal(get("15-en-wrapped.png").verdict, "fail");
  assert.match(r.stderr, /catscan: expect-key-unmatched: the expect key "missing.png" matches no input image/);
  assert.equal(r.code, 1);
});

test("check: nothing checked never passes silently", () => {
  // Value: protects=empty folders, unmatched keys, unchecked inputs and empty check text are reported, even under --quiet; fails_when=any of them goes back to a silent exit-0 pass; why_new=review finding (silent pass in CI); seam=none; no_claim=none beyond protects
  fs.mkdirSync(path.join(dir, "empty-folder"), { recursive: true });
  const empty = cli(["check", "empty-folder", "--present", "x", "--json"]);
  assert.equal(empty.code, 4);
  assert.equal(empty.json[0].error.code, "no-images");
  const file = path.join(dir, "typo.yaml");
  fs.writeFileSync(file, "shots:\n  02-en-smal.png: { present: [GAME OVER] }\n");
  const typo = cli(["check", "02-en-small.png", "--expect", file, "-q"]);
  assert.equal(typo.code, 0);
  assert.match(typo.stderr, /catscan: expect-key-unmatched: /);
  assert.match(typo.stderr, /catscan: no-checks: no check applies to 02-en-small.png/);
  const dots = cli(["check", "02-en-small.png", "--present", "...", "-q", "--json"]);
  assert.equal(dots.json[0].checks[0].verdict, "skipped");
  assert.match(dots.stderr, /catscan: no-checkable-text: /);
});

test("check: wrapped text, failed present has closest, failed absent has a box", () => {
  const r = cli(["check", "15-en-wrapped.png", "--present", "every level and remove", "--present", "Unlock evry level", "--absent", "remove ads", "--json"]);
  const [wrapped, typo, absent] = r.json[0].checks;
  assert.equal(wrapped.verdict, "pass");
  assert.equal(wrapped.line, "Unlock every level and remove ads");
  assert.equal(typo.verdict, "fail");
  assert.equal(typo.box, null);
  assert.equal(typo.closest.line, "Unlock every level");
  assert.equal(typo.closest.distance, 1);
  assert.equal(absent.verdict, "fail");
  assert.equal(absent.box.length, 4);
  assert.equal(r.code, 1);
});

test("check: short check text matches whole words and warns", () => {
  const r = cli(["check", "19-en-short.png", "--present", "OK", "--present", "OO", "--json"]);
  assert.deepEqual(r.json[0].checks.map((c) => c.verdict), ["pass", "fail"]);
  assert.ok(r.json[0].warnings.some((w) => w.code === "short-check-text"));
  assert.match(r.stderr, /catscan: short-check-text: /);
});

test("check: large images are tiled and seam duplicates merged", () => {
  const r = cli(["read", "16-en-tall-tiled.png", "--json"]);
  assert.deepEqual(r.json[0].lines.map((l) => l.text), ["Top of the page", "Across the seam", "Bottom of the page"]);
  const ys = r.json[0].lines.map((l) => l.box[1]);
  assert.ok(Math.abs(ys[1] - 3900 / 9000) < 0.01, `seam line y ${ys[1]}`);
});

test("check: locale-script mismatch warns, and picks the only fitting locale when --locale is absent", () => {
  const ko = cli(["check", "12-ko-phone.png", "--present", "계속하기", "--json"]);
  assert.equal(ko.json[0].locale, "ko");
  assert.equal(ko.json[0].verdict, "pass");
  assert.equal(ko.json[0].warnings[0].code, "locale-script-mismatch");
  const ru = cli(["check", "07-ru-phone.png", "--present", "Продолжить"]);
  assert.match(ru.stderr, /catscan: locale-script-mismatch: The check text is Cyrillic but the locale is en\. - try: --locale ru or --locale uk/);
  // Review fix (D7): a check in a script the locale cannot read is unsupported, never a silent pass, even under -q.
  const absent = cli(["check", "07-ru-phone.png", "--absent", "Продолжить", "-q", "--json"]);
  assert.equal(absent.code, 3);
  assert.equal(absent.json[0].verdict, "unsupported");
  assert.equal(absent.json[0].checks[0].verdict, "unsupported");
  assert.equal(absent.json[0].error.code, "unsupported-script");
  assert.match(absent.stderr, /catscan: locale-script-mismatch: /);
  assert.equal(cli(["check", "07-ru-phone.png", "--absent", "Продолжить", "--locale", "ru"]).code, 1);
  const explicit = cli(["check", "12-ko-phone.png", "--present", "계속하기", "--locale", "en", "--json"]);
  assert.equal(explicit.json[0].locale, "en");
});

test("languages: the table matches this Mac's Vision, and region tags fall back with a warning (TODO-003)", () => {
  const j = cli(["languages", "--json"]);
  assert.equal(j.code, 0);
  const info = j.json[0];
  assert.deepEqual(info.os_table, { added: [], known: true, macos: info.os_table.macos, matches: true, removed: [] });
  // Rows measured per macOS major (spec 04, TODO-004).
  // TODO-037 rows read with a listed model count where that model is listed.
  const count = { 15: 23, 26: 35, 27: 38 }[info.os_table.macos];
  assert.equal(info.languages.filter((l) => l.supported).length, count);
  const row = (l) => info.languages.find((x) => x.locale === l);
  assert.ok(validateLanguages(info), JSON.stringify(validateLanguages.errors));
  assert.deepEqual(row("zh-Hant"), { aliases: ["zh-TW", "zh-HK", "zh-MO"], direction: "ltr", fallback: null, in_table: true, locale: "zh-Hant", no_spaces: true, script: "Han", supported: true, vision: "zh-Hant" });
  assert.equal(row("ar").direction, "rtl");
  // TODO-037 D10: the fallback locales are listed, the same list as the benchmark corpus.
  assert.deepEqual(info.fallback_locales, require("../bench/corpus/build").FALLBACK);
  assert.match(cli(["languages"]).stdout, /Read with Tesseract \(install: brew install tesseract tesseract-lang; check: catscan doctor\): el, he, .*, hr, .*\. Other locales are unsupported \(exit 3\)\./);
  const t = cli(["languages"]);
  assert.equal(t.code, 0);
  assert.match(t.stdout, /^Locale +Vision +Script/);
  assert.match(t.stdout, new RegExp(`\\n${count} languages on macOS .*; matches the macOS \\d+ table\\.\\n`));
  const gb = cli(["check", "02-en-small.png", "--present", "GAME OVER", "--locale", "en-GB"]);
  assert.equal(gb.code, 0);
  assert.match(gb.stderr, /catscan: locale-fallback: The locale en-GB is not in the language table; reading it as en \(Vision en-US\)\. - try: --locale en/);
  const cn = cli(["check", "11-zh-Hans-phone.png", "--present", "设置", "--locale", "zh-CN", "--json"]);
  assert.equal(cn.json[0].verdict, "pass");
  assert.deepEqual(cn.json[0].warnings, []);
  const he = cli(["check", "02-en-small.png", "--present", "GAME OVER", "--locale", "jp"]);
  assert.equal(he.code, 3);
  assert.match(he.stderr, /unsupported-language: .* - try: --locale ja/);
  // D12: a fallback changes what was read, so --quiet still prints it.
  assert.match(cli(["check", "02-en-small.png", "--present", "GAME OVER", "--locale", "en-GB", "-q"]).stderr, /locale-fallback/);
  const gone = cli(["languages"], { env: { CATSCAN_CORE_BINARY: "/nonexistent/catscan-core" } });
  assert.equal(gone.code, 5);
  assert.match(gone.stderr, /binary-not-found/);
});

test("doctor --expect-locales: a Tesseract locale without its reader fails with the fix; with Tesseract it reads a word (TODO-065 T3)", () => {
  // Value: protects=the CI preflight on the real binary; fails_when=doctor passes hr without a reader, or the self-test row is missing; why_new=new flags; seam=CATSCAN_TESSERACT; no_claim=locales other than hr and de
  const no = cli(["doctor", "--expect-locales", "hr,de"], { env: { CATSCAN_TESSERACT: "/nonexistent/tesseract" } });
  assert.equal(no.code, 1, no.stdout);
  assert.match(no.stdout, /^FAIL locale: hr: catscan reads the locale hr with Tesseract, which is not installed on this Mac\. - try: CATSCAN_TESSERACT=\/nonexistent\/tesseract is not a working tesseract/m);
  assert.match(no.stdout, /^ok   locale: de: read by Vision$/m);
  const yes = cli(["doctor", "--expect-locales", "hr", "--json"]);
  const j = JSON.parse(yes.stdout);
  if (!j.fallback?.path) return; // no Tesseract on this Mac: the branch above is the whole check
  assert.equal(yes.code, 0, yes.stdout);
  assert.deepEqual(j.requested.map((r) => [r.locale, r.reader, r.ok]), [["hr", "tesseract", true]]);
  assert.equal(j.fallback.locales.find((l) => l.locale === "hr").self_test.pass, true);
});

test("doctor --expect-locales-from and region tags: catalogs fail closed, sr-Cyrl needs only srp, a usage error is exit 2 (TODO-065 T3, D11)", () => {
  // Value: protects=the default CI preflight (the -from form) and the pack a regional locale is tested with; fails_when=doctor ignores a skipped catalog, demands srp_latn for sr-Cyrl, or a bad folder is an internal error; why_new=review findings; seam=CATSCAN_TESSERACT; no_claim=the 40 s budget
  const loc = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-doctor-loc-"));
  for (const f of ["hr.json", "de.json", "strings/x.json"]) { fs.mkdirSync(path.dirname(path.join(loc, f)), { recursive: true }); fs.writeFileSync(path.join(loc, f), "{}"); }
  const no = cli(["doctor", "--expect-locales-from", loc], { env: { CATSCAN_TESSERACT: "/nonexistent/tesseract" } });
  assert.equal(no.code, 1, no.stdout);
  assert.match(no.stdout, /^FAIL catalogs: .*x\.json/m);
  assert.match(no.stdout, /^FAIL locale: hr: /m);
  assert.match(no.stdout, /^ok   locale: de: read by Vision$/m);
  const bad = cli(["doctor", "--expect-locales-from", path.join(loc, "nope")]);
  assert.equal(bad.code, 2, bad.stderr);
  assert.doesNotMatch(bad.stderr, /internal|this is a bug/);
  const j = JSON.parse(cli(["doctor", "--expect-locales", "el-GR,sr-Cyrl,xx", "--json"], { env: { CATSCAN_TESSERACT: "/nonexistent/tesseract" } }).stdout);
  assert.deepEqual(j.requested.map((r) => [r.locale, r.reader, r.fallback_locale ?? null, r.ok, r.error.code]),
    [["el-GR", "tesseract", "el", false, "reader-missing"], ["sr-Cyrl", "tesseract", "sr", false, "reader-missing"], ["xx", null, null, false, "unsupported-language"]]);
  assert.match(j.fallback.fix, /^CATSCAN_TESSERACT=\/nonexistent\/tesseract is not a working tesseract/);
  // Tessdata with srp but no srp_latn: sr-Cyrl is read (here: a fake that reads nothing), sr needs srp_latn.
  const fake = path.join(loc, "tesseract");
  fs.writeFileSync(fake, '#!/bin/sh\ncase "$1" in\n--version) echo "tesseract 5.5.4";;\n--list-langs) printf \'List of available languages in "/t/" (2):\\neng\\nsrp\\n\';;\n*) printf \'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n\';;\nesac\n', { mode: 0o755 });
  const part = JSON.parse(cli(["doctor", "--expect-locales", "sr-Cyrl,sr", "--json"], { env: { CATSCAN_TESSERACT: fake } }).stdout);
  assert.deepEqual(part.requested.map((r) => [r.locale, r.error?.code]).sort(), [["sr", "reader-missing"], ["sr-Cyrl", "self-test-failed"]]);
  assert.match(part.requested.find((r) => r.locale === "sr").error.message, /no srp_latn language data in \/t\//);
  const yes = JSON.parse(cli(["doctor", "--expect-locales", "sr-Cyrl", "--json"]).stdout);
  if (!yes.fallback?.path || !yes.fallback.packs.includes("srp")) return; // the srp pack is needed for the read below
  const [r] = yes.requested;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.self_test.pass, true);
});

test("exit codes: 0, 1, 3, 4 and precedence in one batch", () => {
  assert.equal(cli(["check", "02-en-small.png", "--present", "GAME OVER"]).code, 0);
  assert.equal(cli(["check", "02-en-small.png", "--present", "YOU WIN"]).code, 1);
  // --fallback none: el is read with Tesseract, so it needs its reader, never "unsupported" (TODO-065 D1).
  const el = cli(["check", "02-en-small.png", "--present", "GAME OVER", "--locale", "el", "--fallback", "none", "--json"]);
  assert.equal(el.code, 3);
  assert.equal(el.json[0].verdict, "needs-reader");
  assert.equal(el.json[0].error.code, "reader-missing");
  assertSchema(el.json);
  // Without Tesseract: needs-reader with the fix for this setup, the NEEDS-READER line and its count.
  const no = cli(["check", "02-en-small.png", "--present", "GAME OVER", "--locale", "hr"], { env: { CATSCAN_TESSERACT: "/nonexistent/tesseract" } });
  assert.equal(no.code, 3);
  assert.match(no.stdout, /^NEEDS-READER 02-en-small\.png$/m);
  assert.match(no.stderr, /reader-missing: 02-en-small\.png: catscan reads the locale hr with Tesseract, which is not installed on this Mac \(looked at \/nonexistent\/tesseract\)\. - try: CATSCAN_TESSERACT=\/nonexistent\/tesseract is not a working tesseract/);
  assert.match(no.stderr, /catscan: counts: 0 pass, 0 fail, 1 needs-reader, 0 unsupported, 0 error/);
  fs.writeFileSync(path.join(dir, "corrupt.png"), "not an image");
  const mixed = cli(["check", "02-en-small.png", "corrupt.png", "nope.png", "--present", "YOU WIN", "--json"]);
  assert.equal(mixed.code, 4);
  assert.deepEqual(mixed.json.map((e) => e.verdict), ["fail", "error", "error"]);
  assert.deepEqual(mixed.json.map((e) => e.error?.code), [undefined, "input-unreadable", "input-not-found"]);
  assertSchema(mixed.json);
  assert.match(mixed.stderr, /catscan: counts: 0 pass, 1 fail, 0 needs-reader, 0 unsupported, 2 error/);
  fs.unlinkSync(path.join(dir, "corrupt.png"));
});

test("usage: no arguments, typos, bad options exit 2 before reading inputs", () => {
  const none = cli([]);
  assert.equal(none.code, 2);
  for (const c of ["catscan check", "catscan read", "catscan doctor"]) assert.ok(none.stdout.includes(c));
  const typo = cli(["check", "nope.png", "--presnt", "x"]);
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /unknown option --presnt; did you mean --present\?/);
  assert.equal(typo.stdout, "");
  assert.equal(cli(["read", "a.png", "--json", "--format", "text"]).code, 2);
  // TODO-093 D2: the rendered planned-option error, exit 2, no lab spec id.
  const esc = cli(["check", "a.png", "--escalate"]);
  assert.equal(esc.code, 2);
  assert.equal(esc.stdout, "");
  assert.match(esc.stderr, /option-not-available/);
  assert.match(esc.stderr, /--escalate is not available in this version/);
  assert.match(esc.stderr, /run the same command without --escalate/);
  assert.doesNotMatch(esc.stderr, /\bspec \d/);
  // TODO-093 T2: catscan <command> --help is that command's help, exit 0; catscan --help stays the full help.
  const own = cli(["check", "--help"]);
  assert.equal(own.code, 0);
  assert.match(own.stdout, /--present <text>/);
  assert.doesNotMatch(own.stdout, /--every|catscan video/);
  assert.match(own.stdout, /^Exit codes: /m);
  const full = cli(["--help"]);
  assert.equal(full.code, 0);
  assert.match(full.stdout, /--every/);
  assert.match(full.stdout, /--present <text>/);
  assert.equal(cli(["check", "a.png", "--expect", "missing.yaml"]).code, 2);
  // Added by /ship coverage audit.
  // Value: protects=options without a command (`catscan --json`) exit 2 with missing-command and no stdout; fails_when=cli.js drops the command === null guard or its exit code; why_new=cli([]) prints help, never reaches the missing-command branch; seam=none; no_claim=other option-only combinations
  const noCmd = cli(["--json"]);
  assert.equal(noCmd.code, 2);
  assert.match(noCmd.stderr, /catscan: missing-command: no command given/);
  assert.equal(noCmd.stdout, "");
});

test("stdin input and text output", () => {
  const png = fs.readFileSync(path.join(dir, "02-en-small.png"));
  const r = cli(["check", "-", "--present", "GAME OVER"], { input: png });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^PASS  -\n1 image: 1 pass \(\d+\.\d s\)\n$/);
  const f = cli(["check", "02-en-small.png", "--present", "YOU WIN", "--quiet"]);
  assert.match(f.stdout, /^FAIL  02-en-small.png\n  critical\/medium  present "YOU WIN": not found; closest/);
  assert.equal(f.stderr, ""); // TODO-009: no withoutVmNoise(); the CLI drops Vision's VM line itself
});

test("a Vision deadline that runs out is a vision-timeout per input, exit 4, and the run ends (TODO-032)", () => {
  // 1 ms is far below any real read, so every image runs out; the client replaces the core after each one.
  const r = cli(["check", "01-en-phone.png", "02-en-small.png", "--present", "x", "--json"], { env: { CATSCAN_VISION_TIMEOUT: "0.001" }, timeout: 60_000 });
  assert.equal(r.code, 4, r.stderr);
  assert.deepEqual(r.json.map((e) => [e.path, e.verdict, e.error.code]), [["01-en-phone.png", "error", "vision-timeout"], ["02-en-small.png", "error", "vision-timeout"]]);
  for (const e of r.json) assert.ok(validate(e), JSON.stringify(validate.errors));
  assert.equal(r.json[0].error.message, "Vision did not finish reading the image in 0.001 s.");
  assert.match(r.stderr, /catscan: vision-timeout: 01-en-phone\.png: Vision did not finish reading the image in 0\.001 s\. .*CATSCAN_VISION_TIMEOUT/);
});

test("catscan serve passes stdin and stdout through to catscan-core", () => {
  // Added by /ship coverage audit.
  // Value: protects=`catscan serve` (docs/cli.md) speaks the serve protocol and exits 0 on EOF; fails_when=cli.js serve() stops spawning the binary, drops stdio inherit or misreports the exit code; why_new=serve.test.js drives the binary and the client, never the CLI; seam=none; no_claim=long-lived sessions (one request, then EOF)
  const req = { id: "s1", command: "check", path: path.join(dir, "02-en-small.png"), present: ["GAME OVER"], locale: "en" };
  const r = cli(["serve"], { input: JSON.stringify(req) + "\n" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.length, 2);
  assert.equal(r.json[0].type, "ready");
  assert.equal(r.json[1].id, "s1");
  assert.equal(r.json[1].verdict, "pass");
  assert.equal(cli(["serve", "--json"]).code, 2);
});

test("host is the spec 00 machine object, with no CI identity", () => {
  // Value: protects=the envelope host shape {chip, arch, host_class, macos "<v> (<build>)", vision_revision} and screen null; fails_when=host gains ci or loses a field; why_new=spec 00 changed the host object; seam=none; no_claim=a VM host class (physical Mac only)
  const e = cli(["read", "02-en-small.png", "--json"], { env: { CI: "true", GITHUB_ACTIONS: "true" } }).json[0];
  assert.deepEqual(Object.keys(e.host).sort(), ["arch", "chip", "host_class", "macos", "vision_revision"]);
  assert.match(e.host.macos, /^\d+(\.\d+)* \(\w+\)$/);
  assert.equal(e.host.vision_revision, 3);
  assert.equal(e.screen, null);
});

test("--version and --help", () => {
  const v = cli(["--version"]);
  assert.equal(v.code, 0);
  assert.match(v.stdout, /^catscan \d+\.\d+\.\d+\nmacOS [\d.]+ \(\w+\)\nVision VNRecognizeTextRequest revision 3\n$/);
  const h = cli(["--help"]);
  assert.equal(h.code, 0);
  for (const o of ["--present", "--absent", "--expect", "--locale", "--json", "--format", "--quiet", "--version"]) assert.ok(h.stdout.includes(o), o);
  assert.equal(require("../package.json").version, require("../packages/core-js/package.json").version);
  assert.match(fs.readFileSync(path.join(ROOT, "core/Sources/CatscanCore/Model.swift"), "utf8"), new RegExp(`catscanVersion = "${require("../package.json").version}"`));
});

test("outside review fixes: nothing unreadable passes silently", () => {
  // Value: protects=the no-silent-pass rule for unreadable subfolders, unmapped scripts, missing files under an unsupported locale, FIFOs, oversized stdin and a non-executable binary; fails_when=any of them exits 0, 3 or 5 where 4 (or 5) is documented, or hangs; why_new=Codex outside review findings 1, 2, 4, 6, 7, 8; seam=none; no_claim=EXIF orientation (CoreTests)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-or-"));
  try {
    fs.copyFileSync(path.join(dir, "02-en-small.png"), path.join(tmp, "a.png"));
    const locked = path.join(tmp, "locked");
    fs.mkdirSync(locked);
    fs.copyFileSync(path.join(dir, "02-en-small.png"), path.join(locked, "b.png"));
    if (process.getuid() !== 0) { // root reads a mode-000 folder anyway
      fs.chmodSync(locked, 0o000);
      const sub = cli(["check", tmp, "--present", "GAME OVER", "--json"]);
      fs.chmodSync(locked, 0o755);
      assert.equal(sub.code, 4);
      assert.deepEqual(sub.json.map((e) => e.verdict), ["pass", "error"]);
    }

    const arm = cli(["check", "02-en-small.png", "--absent", "Բարեւ", "--json"]);
    assert.equal(arm.code, 3);
    assert.equal(arm.json[0].error.code, "unsupported-script");

    assert.equal(cli(["check", "nope.png", "--present", "x", "--locale", "zz"]).code, 4);

    const fifoDir = path.join(tmp, "fifo");
    fs.mkdirSync(fifoDir);
    execFileSync("mkfifo", [path.join(tmp, "pipe")]);
    fs.symlinkSync(path.join(tmp, "pipe"), path.join(fifoDir, "pipe.png")); // a symlinked image is read, so its target is checked
    const fifo = cli(["check", fifoDir, "--present", "x", "--json"], { timeout: 20000 });
    assert.equal(fifo.code, 4);
    assert.equal(fifo.json[0].error.code, "input-unreadable");

    const big = cli(["check", "-", "--present", "x"], { input: Buffer.alloc(48 * 1024 * 1024) });
    assert.equal(big.code, 4);
    assert.match(big.stderr, /catscan: image-too-large: /);

    const noexec = path.join(tmp, "core");
    fs.writeFileSync(noexec, "");
    const serve = cli(["serve"], { input: "", env: { CATSCAN_CORE_BINARY: noexec } });
    assert.equal(serve.code, 5);
    assert.match(serve.stderr, /catscan: binary-failed: /);
  } finally {
    try { fs.chmodSync(path.join(tmp, "locked"), 0o755); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("doctor --json: every spec 08 field, a passing self-test and source env", () => {
  const r = cli(["doctor", "--json"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.length, 1);
  const d = r.json[0];
  const validateDoctor = ajv.compile(require("../core/schema/doctor.schema.json"));
  assert.ok(validateDoctor(d), JSON.stringify(validateDoctor.errors));
  assert.equal(d.ok, true);
  assert.equal(d.binary.source, "env");
  assert.equal(d.binary.arch, "arm64");
  assert.equal(d.binary.signature, null);
  assert.equal(d.binary.version, d.catscan);
  assert.deepEqual(d.node, { version: process.versions.node, arch: process.arch });
  assert.match(d.host.macos_build, /^\w+$/);
  assert.ok(["present", "absent", "unknown"].includes(d.neural_engine));
  assert.ok(d.vision.languages.accurate > 0 && d.vision.languages.fast > 0, JSON.stringify(d.vision));
  assert.equal(d.vision.revision, d.host.vision_revision);
  assert.equal(d.self_test.pass, true);
  assert.ok(Number.isInteger(d.self_test.ms));
  assert.deepEqual(d.checks.map((c) => c.name), ["node", "platform", "macos", "binary", "version", "signature", "vision", "self_test", "tesseract"]);
  // The text form: one line per check in the D16 shape; the macOS line names the build once (review).
  const t = cli(["doctor"]);
  assert.equal(t.code, 0, t.stderr);
  const lines = t.stdout.trim().split("\n");
  assert.equal(lines.length, 9);
  for (const l of lines) assert.match(l, /^ok   (node|platform|macos|binary|version|signature|vision|self_test|tesseract): \S/);
  assert.match(t.stdout, /^ok   macos: \d+\.\d+(\.\d+)? \(\w+\)$/m);
  assert.match(t.stdout, /^ok   self_test: read a rendered word in \d+ ms$/m);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} to catscan stops catscan-core serve (no orphan)`, async () => {
    const { spawn } = require("child_process");
    const p = spawn(process.execPath, [path.join(ROOT, "bin/catscan.js"), "check", dir, "--present", "x"], {
      cwd: dir, stdio: "ignore", env: { ...process.env, CATSCAN_CORE_BINARY: require("./helpers").BIN },
    });
    const children = () => { try { return execFileSync("pgrep", ["-P", String(p.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); } catch { return []; } };
    let core = [];
    for (let i = 0; i < 100 && !core.length; i++) { await new Promise((r) => setTimeout(r, 50)); core = children(); }
    assert.ok(core.length, "catscan-core serve started");
    const exited = new Promise((r) => p.once("exit", r));
    p.kill(signal);
    await exited;
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && core.some(alive); i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(core.filter(alive), [], `catscan-core still running after ${signal}`);
  });
}

// TODO-056: a reader that leaves early (`| head -1`, `grep -m1`) closes the pipe. Closing the read end right after spawn
// makes the first write fail with EPIPE every time (D6); `| head -1` would race the pipe buffer.
// Value: protects=TODO-056 D1-D3 (run finishes, files written, run's exit code, no stack); fails_when=the EPIPE listener in
// packages/cli/bin/catscan.js is removed or rethrows; why_new=no test closed a stream before; seam=none; no_claim=core SIGPIPE under serve (D5)
function closedRun(args, close, env = {}) {
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, "bin/catscan.js"), ...args], {
      cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CATSCAN_CORE_BINARY: require("./helpers").BIN, ...env },
    });
    let stderr = "";
    if (close.includes("stdout")) p.stdout.destroy(); else p.stdout.resume();
    if (close.includes("stderr")) p.stderr.destroy(); else p.stderr.on("data", (d) => { stderr += d; });
    p.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}

test("closed stdout or stderr: the run finishes with its own exit code and files, no EPIPE stack (TODO-056)", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-epipe-"));
  const f = (n) => path.join(out, n);
  const cases = [
    { name: "text, every report file", close: ["stdout"], code: 0,
      args: ["--results", f("text.json"), "--junit", f("text.xml"), "--report", f("text.html")], files: ["text.json", "text.xml", "text.html"] },
    { name: "--json", close: ["stdout"], code: 0, args: ["--json", "--results", f("json.json")], files: ["json.json"] },
    { name: "--format github", close: ["stdout"], code: 0, args: ["--format", "github", "--results", f("gh.json")], files: ["gh.json", "summary.md"],
      env: { GITHUB_STEP_SUMMARY: f("summary.md") } },
    { name: "failing check", close: ["stdout"], code: 1, present: "Nope", args: ["--results", f("fail.json")], files: ["fail.json"] },
    { name: "stderr closed", close: ["stderr"], code: 0, args: ["--results", f("err.json")], files: ["err.json"] },
    { name: "both closed", close: ["stdout", "stderr"], code: 0, args: ["--results", f("both.json")], files: ["both.json"] },
  ];
  for (const c of cases) {
    const r = await closedRun(["check", "19-en-short.png", "--present", c.present || "OK", ...c.args], c.close, c.env);
    assert.equal(r.code, c.code, `${c.name}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /EPIPE|Unhandled 'error'|\n\s+at /, c.name);
    for (const file of c.files) assert.ok(fs.statSync(f(file)).size > 0, `${c.name}: ${file} written`);
    // The results file is the whole run, not a stub cut short by the closed stream (D2).
    const results = JSON.parse(fs.readFileSync(f(c.files[0]), "utf8")).results;
    assert.deepEqual(results.map((e) => e.verdict), [c.code ? "fail" : "pass"], c.name);
  }
  assert.match(fs.readFileSync(f("text.xml"), "utf8"), /<testcase /);
  // A usage error with stderr closed keeps its own exit code 2 (was 1 on v0.40.0).
  assert.equal((await closedRun(["check"], ["stderr"])).code, 2);
  // A command that never starts the core (help) takes the same path.
  const help = await closedRun(["--help"], ["stdout"]);
  assert.deepEqual([help.code, help.stderr], [0, ""]);
});
