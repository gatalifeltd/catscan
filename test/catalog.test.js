// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 02 round trip through the CLI and real Vision: a screen drawn from hand-written strings (D11),
// checked with @key from every catalog format.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");

setup();
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-catalog-"));
execFileSync(path.join(ROOT, ".build/synth"), [path.join(__dirname, "fixtures/catalogs/screens.json"), shots]);
const SHOT = path.join(shots, "catalog-en.png");
const C = path.join(__dirname, "fixtures/catalogs");
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));

// Keys whose filled-in text the screen shows, per catalog.
const SHOWN = {
  "en.json": ["home.title", "home.cta", "greeting", "files", "sale"],
  "Localizable.strings": ["onboarding.next", "welcome"],
  "strings.xml": ["apostrophe", "alias", "songs"],
  "Localizable.xcstrings": ["settings.title", "folder.files", "device.hint"],
  "utf16le.strings": ["utf16.title"],
  "utf16be.strings": ["utf16.title"],
  "code/en.ts": ["home.title", "home.cta", "greeting", "files", "sale"], // TODO-092: the en.json strings in TypeScript
};

for (const [file, keys] of Object.entries(SHOWN)) {
  test(`round trip: every shown key of ${file} passes --present @key`, () => {
    const r = cli(["check", SHOT, "--catalog", path.join(C, file), ...keys.flatMap((k) => ["--present", `@${k}`]), "--json"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const env = r.json[0];
    assert.ok(validate(env), JSON.stringify(validate.errors));
    assert.deepEqual(env.checks.map((c) => [c.key, c.verdict]), keys.map((k) => [k, "pass"]));
    assert.ok(env.checks.every((c) => c.catalog === path.join(C, file)));
  });
}

test("round trip: a key left off the screen fails --present, a shown key fails --absent", () => {
  const r = cli(["check", SHOT, "--catalog", path.join(C, "en.json"), "--present", "@home.items[0]", "--absent", "@home.cta", "--json"]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json[0].checks.map((c) => c.verdict), ["fail", "fail"]);
  assert.ok(r.json[0].checks[0].closest);
  const t = cli(["check", SHOT, "--catalog", path.join(C, "en.json"), "--present", "@home.items[0]"]);
  assert.match(t.stdout, /present @home\.items\[0\] "First item here" \(.*en\.json\): not found; closest/);
});

test("--all-keys: an inventory that never fails", () => {
  const r = cli(["check", SHOT, "--catalog", path.join(C, "en.json"), "--all-keys", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const env = r.json[0];
  assert.ok(validate(env), JSON.stringify(validate.errors));
  assert.equal(env.verdict, "pass");
  for (const k of SHOWN["en.json"]) assert.ok(env.inventory.found.some((f) => f.key === k), k);
  assert.ok(env.inventory.not_found.includes("home.items[0]"));
  assert.ok(env.inventory.skipped.some((s) => s.key === "short" && s.reason === "no-checkable-text"));
  const keys = env.inventory.found.map((f) => f.key);
  assert.deepEqual(keys, [...keys].sort());
  const t = cli(["check", SHOT, "--catalog", path.join(C, "en.json"), "--all-keys"]);
  assert.match(t.stdout, /inventory: \d+ of \d+ keys found, \d+ skipped/);
});

test("--expect files take @key; @@ is a literal @", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-expect-"));
  const f = path.join(dir, "expect.yaml");
  fs.writeFileSync(f, 'shots:\n  catalog-en.png:\n    present: ["@home.title"]\n    absent: ["@@home.title"]\n');
  const r = cli(["check", shots, "--catalog", path.join(C, "en.json"), "--expect", f, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json[0].checks.map((c) => [c.kind, c.key ?? c.text, c.verdict]), [["absent", "@home.title", "pass"], ["present", "home.title", "pass"]]); // literal checks come first
});

test("usage errors: unknown key names the closest, malformed catalog names the line, @key needs --catalog", () => {
  const u = cli(["check", SHOT, "--catalog", path.join(C, "en.json"), "--present", "@home.titel"]);
  assert.equal(u.code, 2);
  assert.match(u.stderr, /unknown-catalog-key: --present: the catalogs define no key home\.titel .*closest: home\.title.* - try: @home\.title/);
  const m = cli(["check", SHOT, "--catalog", path.join(C, "malformed/bad.xml"), "--present", "@a"]);
  assert.equal(m.code, 2);
  assert.match(m.stderr, /invalid-catalog: .*bad\.xml:3:26:/);
  assert.equal(cli(["check", SHOT, "--present", "@home.cta"]).code, 2);
  assert.equal(cli(["check", SHOT, "--catalog", path.join(C, "hostile/xxe.xml"), "--all-keys"]).code, 2);
});

test("{locale} template: a locale with no file skips its @key checks, loudly even under --quiet", () => {
  const r = cli(["check", SHOT, "--catalog", path.join(C, "{locale}.json"), "--locale", "fr", "--present", "@home.cta", "--json", "--quiet"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json[0].checks[0].verdict, "skipped");
  assert.equal(r.json[0].checks[0].reason, "catalog-missing");
  assert.match(r.stderr, /catalog-missing: no catalog for the locale fr/);
  const ok = cli(["check", SHOT, "--catalog", path.join(C, "{locale}.json"), "--present", "@home.cta"]);
  assert.equal(ok.code, 0, ok.stderr);
});

test("TODO-007 --fail-on-skip: a skipped check exits 1 with checks-skipped; verdicts and reports unchanged", () => {
  // Value: protects=D3, D8, D10, D11 (exit 1, the stderr line under --quiet and --format github, JSON unchanged); fails_when=the flag is not wired, the line is filtered, or verdicts change; why_new=new option; seam=none; no_claim=video range-empty (test/video.test.js)
  const base = ["check", SHOT, "--catalog", path.join(C, "{locale}.json"), "--locale", "fr", "--present", "@home.cta", "--absent", "@home.title"];
  const plain = cli([...base, "--json", "--quiet"]);
  const strict = cli([...base, "--json", "--quiet", "--fail-on-skip"]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(strict.code, 1, strict.stderr);
  // Timing differs per run, so it is dropped before the comparison (D8).
  const stable = (r) => ({ verdict: r.json[0].verdict, checks: r.json[0].checks.map((c) => { const o = { ...c }; delete o.ms; return o; }) });
  assert.deepEqual(stable(strict), stable(plain));
  assert.match(strict.stderr, /^catscan: checks-skipped: 2 checks were skipped \(catalog-missing 2\) and --fail-on-skip fails the run on them - try: --json lists each skipped check/m);
  assert.doesNotMatch(plain.stderr, /checks-skipped/);
  const gh = cli([...base, "--format", "github", "--fail-on-skip"]);
  assert.equal(gh.code, 1, gh.stderr);
  assert.doesNotMatch(gh.stdout, /::error/);
  assert.match(gh.stderr, /checks-skipped: 2 checks were skipped/);
});

test("TODO-007 --fail-on-skip: an --all-keys inventory skip with no skipped check exits 0 (D6)", () => {
  const r = cli(["check", SHOT, "--catalog", path.join(C, "Localizable.xcstrings"), "--locale", "de", "--all-keys", "--quiet", "--fail-on-skip"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /the inventory skips them/);
  assert.doesNotMatch(r.stderr, /checks-skipped/);
});

test("review fixes: an @key in a script the locale cannot read is unsupported; a broken image is an input error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-ru-"));
  const ru = path.join(dir, "ru.json");
  fs.writeFileSync(ru, JSON.stringify({ settings: "Открыть настройки" }));
  const u = cli(["check", SHOT, "--catalog", ru, "--locale", "en", "--present", "@settings", "--json"]);
  assert.equal(u.code, 3, u.stderr);
  assert.equal(u.json[0].checks[0].verdict, "unsupported");
  assert.equal(u.json[0].checks[0].key, "settings");
  const bad = path.join(dir, "broken.png");
  fs.writeFileSync(bad, "not a png");
  const e = cli(["check", bad, "--catalog", path.join(C, "en.json"), "--present", "@home.cta", "--json"]);
  assert.equal(e.code, 4); // like a literal check: an undecodable input has no checks
  assert.equal(e.json[0].verdict, "error");
  assert.ok(validate(e.json[0]), JSON.stringify(validate.errors));
});

test("review fixes: an untranslated .xcstrings key is skipped loudly, even under --quiet", () => {
  const r = cli(["check", SHOT, "--catalog", path.join(C, "Localizable.xcstrings"), "--locale", "de", "--present", "@photos.count", "--quiet"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /catalog-missing: The catalog key @photos\.count has no string for the locale de/);
});

test("review pass 2: --all-keys names its skipped untranslated keys under --quiet", () => {
  const r = cli(["check", SHOT, "--catalog", path.join(C, "Localizable.xcstrings"), "--locale", "de", "--all-keys", "--quiet"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /catalog-missing: 4 catalog keys have no string for the locale de; the inventory skips them\./);
});
