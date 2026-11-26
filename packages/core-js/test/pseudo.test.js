// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-039 T1: `catscan pseudo`, the pseudo-locale generator. Synthetic fixtures only (test/fixtures/pseudo).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const pseudo = require("../src/pseudo");
const catalog = require("../src/catalog");
const xml = require("../src/xml");
const { parse, UsageError } = require("../src/args");

const ROOT = path.join(__dirname, "../../..");
const FX = path.join(ROOT, "test/fixtures/pseudo");
const BIN = path.join(ROOT, "bin/catscan.js");

/** A fresh copy of the fixture tree, so outputs land next to their inputs as in a real project. */
function tree() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pseudo-"));
  for (const f of ["locales", "en.lproj", "app", "Localizable.xcstrings"]) fs.cpSync(path.join(FX, f), path.join(d, f), { recursive: true });
  return d;
}

function cli(args, cwd) {
  const r = spawnSync(process.execPath, [BIN, "pseudo", ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const CASES = [
  { format: "json", input: "locales/en.json", output: "locales/en-XA.json", golden: "en-XA.json" },
  { format: "strings", input: "en.lproj/Localizable.strings", output: "en-XA.lproj/Localizable.strings", golden: "Localizable.strings" },
  { format: "android", input: "app/src/main/res/values/strings.xml", output: "app/src/debug/res/values-en-rXA/strings.xml", golden: "strings.xml" },
  { format: "xcstrings", input: "Localizable.xcstrings", output: "Localizable.xcstrings", golden: "Localizable.xcstrings", flags: ["--in-place"] },
];

// Placeholders, ICU headers and selectors in order: an independent grammar, so the test does not reuse the code under test.
const PH = /%(?:\d+\$)?#@[^@]+@|%(?:\d+\$)?arg|%(?:\d+\$)?[-+#0']*\d*(?:\.\d+)?(?:hh|h|ll|l|L|q|j|z|t)?[@dDiuUxXoOfFeEgGcCsSpaA]|\{\{[^}]+\}\}|\$\{[^}]+\}|\$t\([^)]*\)|\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\s*,|\b(?:zero|one|two|few|many|other|=\d+)\s*\{|<\/?[\w:]+[^>]*>/g;
const placeholders = (v) => v.match(PH) ?? [];

function entries(file, locale) {
  return catalog.loadFile(file, locale).entries;
}

for (const c of CASES) {
  test(`${c.format}: golden output, re-read by the loader with the same keys, placeholders and plural forms`, () => {
    const d = tree();
    const r = cli([c.input, ...(c.flags ?? [])], d);
    assert.equal(r.code, 0, r.err);
    const out = path.join(d, c.output);
    assert.equal(fs.readFileSync(out, "utf8"), fs.readFileSync(path.join(FX, "expected", c.golden), "utf8"));
    const before = entries(path.join(d, c.format === "xcstrings" ? c.output : c.input), "en");
    const after = entries(out, c.format === "xcstrings" ? "en-XA" : "en");
    assert.deepEqual([...after.keys()], [...before.keys()]);
    for (const [k, e] of before) {
      const a = after.get(k);
      if (!e.values.length || !a.values.length) continue;
      assert.equal(a.values.length, e.values.length, `plural forms of ${k}`);
      e.values.forEach((v, i) => assert.deepEqual(placeholders(a.values[i]), placeholders(v), `placeholders of ${k}`));
    }
  });
}

test("outputs parse: plutil (.strings, .xcstrings), JSON.parse (i18next), the XML parser (Android)", () => {
  const d = tree();
  for (const c of CASES) assert.equal(cli([c.input, ...(c.flags ?? [])], d).code, 0);
  execFileSync("plutil", ["-lint", path.join(d, "en-XA.lproj/Localizable.strings")]);
  // plutil -lint reads only plist syntaxes; -convert accepts the JSON an .xcstrings file is.
  execFileSync("plutil", ["-convert", "xml1", "-o", "/dev/null", path.join(d, "Localizable.xcstrings")]);
  JSON.parse(fs.readFileSync(path.join(d, "locales/en-XA.json"), "utf8"));
  assert.equal(xml.parse(fs.readFileSync(path.join(d, "app/src/debug/res/values-en-rXA/strings.xml"), "utf8")).name, "resources");
});

test("span rewrite: every byte outside a translatable value is unchanged (D2)", () => {
  const d = tree();
  for (const c of CASES.filter((x) => x.format !== "xcstrings")) {
    assert.equal(cli([c.input], d).code, 0);
    const outside = (file) => {
      const text = fs.readFileSync(path.join(d, file), "utf8");
      const parts = [];
      let at = 0;
      for (const sp of pseudo.spans(c.format, text)) { parts.push(text.slice(at, sp.start)); at = sp.end; }
      parts.push(text.slice(at));
      return parts;
    };
    assert.deepEqual(outside(c.output), outside(c.input), c.format);
  }
});

test("xcstrings in place: every other locale and field stays deep-equal; the pseudo locale is added or replaced", () => {
  const d = tree();
  const file = path.join(d, "Localizable.xcstrings");
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cli(["Localizable.xcstrings", "--in-place"], d).code, 0);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const strip = (data) => {
    const o = structuredClone(data);
    for (const e of Object.values(o.strings)) {
      if (e.localizations) delete e.localizations["en-XA"];
      if (e.localizations && !Object.keys(e.localizations).length) delete e.localizations;
    }
    return o;
  };
  assert.deepEqual(strip(after), before);
  assert.equal(after.strings.brand.localizations, undefined, "shouldTranslate: false is copied as is");
  assert.equal(after.strings.Continue.localizations["en-XA"].stringUnit.value, "[Çöñtíñüé öñé]", "a key with no source localization uses the key");
  // A second run replaces the pseudo localization: the source still reads as base, so it is not already-pseudo.
  assert.equal(cli(["Localizable.xcstrings", "--in-place", "--expand", "0"], d).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).strings.Continue.localizations["en-XA"].stringUnit.value, "[Çöñtíñüé]");
  // Substitution forms land inside their string's markers: accented only, never bracketed.
  const sub = JSON.parse(fs.readFileSync(file, "utf8")).strings.photos.localizations["en-XA"].substitutions.photos.variations.plural.one.stringUnit.value;
  assert.equal(sub, "%arg phötö");
});

test("never transformed: each placeholder style, ICU keywords, markup, escapes, URL, e-mail, digits, empty", () => {
  const t = (s, fmt = "json", extra = {}) => pseudo.transform(s, { fmt, expand: 0, variant: "accent", ...extra });
  assert.equal(t("Pay %@ and %1$s, %lld, %.2f, %#@n@ %arg").value, "[Páý %@ áñd %1$s, %lld, %.2f, %#@n@ %arg]");
  assert.equal(t("Hi {name} {0} {{user}} {{val, number}} ${who} $t(a.b)").value, "[Hí {name} {0} {{user}} {{val, number}} ${who} $t(a.b)]");
  assert.equal(t("{n, plural, one {# song} other {# songs}}").value, "[{n, plural, one {# šöñg} other {# šöñgš}}]");
  assert.equal(t("{g, select, male {He} other {They}}").value, "[{g, select, male {Hé} other {Théý}}]");
  assert.equal(t("<0>Open</0> <b>now</b> <a href=\"x\">link</a>").value, "[<0>Öpéñ</0> <b>ñöw</b> <a href=\"x\">líñk</a>]");
  assert.equal(t("Use <xliff:g id=\"c\">code</xliff:g> now", "android").value, "[Üšé <xliff:g id=\"c\">code</xliff:g> ñöw]");
  assert.equal(t("Line\\nnext \\\"q\\\" \\u00e9").value, "[Líñé\\nñéxt \\\"q\\\" \\u00e9]");
  assert.equal(t("a\\U00A0b \\n", "strings").value, "[á\\U00A0b \\n]");
  assert.equal(t("Don\\'t \\@x \\? &amp; &#169; <![CDATA[<i>i</i>]]>", "android").value, "[Döñ\\'t \\@x \\? &amp; &#169; <![CDATA[<i>í</i>]]>]");
  assert.equal(t("Go to https://example.com/path or help@example.com").value, "[Gö tö https://example.com/path ör help@example.com]");
  assert.equal(t("50% off", "android", { formatted: false }).value, "[50% öff]");
  assert.equal(t("Line%nnext %1$tY at %tc", "android").value, "[Líñé%nñéxt %1$tY át %tc]");
  assert.equal(t("Buy ^[%lld apple](inflect: true)", "xcstrings").value, "[Büý ^[%lld áppl\u00e9](inflect: true)]");
  assert.equal(t("Tom &amp; Jerry &#169;").value, "[Töm &amp; Jérrý &#169;]");
  assert.equal(t("Go $t(a, {\"name\": fn()}) now").value, "[Gö $t(a, {\"name\": fn()}) ñöw]");
  assert.equal(t("{n, plural, one {song} other}").value, "[{n, plural, one {song} other}]"); // malformed ICU kept whole
  assert.equal(t("Tap &lt;b&gt;here&lt;/b&gt; now", "android").value, "[Táp &lt;b&gt;héré&lt;/b&gt; ñöw]");
  assert.equal(t("{n, plural, offset:1 one {# song} other {I''m #}}").value, "[{n, plural, offset:1 one {# šöñg} other {Í''m #}}]");
  assert.deepEqual(t("https://example.com"), { skip: "url" });
  assert.deepEqual(t("support@example.com"), { skip: "url" });
  assert.deepEqual(t("12:30 - 4.5%"), { skip: "no-letters" });
  assert.deepEqual(t("   "), { skip: "empty" });
});

test("expansion: filler words to ceil(len * (1 + expand/100)), a placeholder counts as 6 characters", () => {
  const t = (s, expand) => pseudo.transform(s, { fmt: "json", expand, variant: "accent" }).value;
  assert.equal(t("Shop", 40), "[Šhöp öñé]"); // target 6: one word overshoots, as short UI strings do
  assert.equal(t("Shop", 0), "[Šhöp]");
  assert.equal(t("Settings", 100), "[Šéttíñgš öñé twö]"); // 8 -> 16: 8 + 4 + 4 reaches it
  // "%@ items" is 6 + 6 = 12 visible; +50% = 18: one word (16) is short, two (20) reach it.
  assert.equal(t("%@ items", 50), "[%@ ítémš öñé twö]");
  // Markers sit inside the value's own leading and trailing whitespace.
  assert.equal(t("  Hi  ", 0), "  [Hí]  ");
});

test("variants: rtl wraps in U+202E..U+202C inside the markers, tall uses the Vietnamese vowels", () => {
  assert.equal(pseudo.transform("Hello", { fmt: "json", expand: 0, variant: "rtl" }).value, "[‮Héllö‬]");
  assert.equal(pseudo.transform("Hello you", { fmt: "json", expand: 0, variant: "tall" }).value, "[Hệllộ ỹộữ]");
  const d = tree();
  const r = cli(["locales/en.json", "--variant", "rtl", "--json"], d);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).output, path.join("locales", "ar-XB.json"));
  assert.ok(fs.existsSync(path.join(d, "locales/ar-XB.json")));
});

test("determinism: the same input gives byte-identical output", () => {
  const a = tree(), b = tree();
  for (const c of CASES) {
    cli([c.input, ...(c.flags ?? [])], a);
    cli([c.input, ...(c.flags ?? [])], b);
    assert.ok(fs.readFileSync(path.join(a, c.output)).equals(fs.readFileSync(path.join(b, c.output))), c.format);
  }
});

test("UTF-16 .strings keep their encoding and BOM", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pseudo-"));
  fs.mkdirSync(path.join(d, "en.lproj"));
  for (const f of ["utf16le.strings", "utf16be.strings"]) {
    const src = fs.readFileSync(path.join(ROOT, "test/fixtures/catalogs", f));
    fs.writeFileSync(path.join(d, "en.lproj", f), src);
    assert.equal(cli([`en.lproj/${f}`], d).code, 0);
    const out = fs.readFileSync(path.join(d, "en-XA.lproj", f));
    assert.deepEqual([...out.subarray(0, 2)], [...src.subarray(0, 2)], f);
    const values = [...entries(path.join(d, "en-XA.lproj", f), "en").values()].flatMap((e) => e.values);
    assert.ok(values.length && values.every((v) => v.startsWith("[")), f);
    execFileSync("plutil", ["-lint", path.join(d, "en-XA.lproj", f)]);
  }
});

test("output placement: Android lands in src/debug/res; namespace folders; unknown layouts need --out", () => {
  assert.equal(pseudo.defaultOutput("app/src/main/res/values/strings.xml", "android", "en-XA"), path.join("app/src/debug/res/values-en-rXA/strings.xml"));
  assert.equal(pseudo.defaultOutput("src/main/res/values/strings.xml", "android", "ar-XB"), path.join("src/debug/res/values-ar-rXB/strings.xml"));
  assert.equal(pseudo.defaultOutput("public/locales/en/common.json", "json", "en-XA"), path.join("public/locales/en-XA/common.json"));
  assert.equal(pseudo.defaultOutput("Base.lproj/Main.strings", "strings", "en-XA"), path.join("en-XA.lproj/Main.strings"));
  assert.equal(pseudo.defaultOutput("res/values/strings.xml", "android", "en-XA"), null);
  assert.equal(pseudo.androidQualifier("sr-Latn-RS"), "b+sr+Latn+RS");
  const d = tree();
  fs.writeFileSync(path.join(d, "texts.json"), "{\"a\": \"Hello\"}");
  const r = cli(["texts.json"], d);
  assert.equal(r.code, 2);
  assert.match(r.err, /catscan: output-path-unknown: .* - try: catscan pseudo texts\.json --out <path>/);
  assert.equal(cli(["texts.json", "--out", "out/pseudo.json"], d).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "out/pseudo.json"), "utf8")).a, "[Héllö öñé]");
});

test("usage errors exit 2 with a hint: output-exists, --force, in-place-required, already-pseudo", () => {
  const d = tree();
  assert.equal(cli(["locales/en.json"], d).code, 0);
  let r = cli(["locales/en.json"], d);
  assert.equal(r.code, 2);
  assert.match(r.err, /output-exists: .*en-XA\.json already exists - try: catscan pseudo locales\/en\.json --force/);
  assert.equal(cli(["locales/en.json", "--force"], d).code, 0);
  r = cli(["Localizable.xcstrings"], d);
  assert.equal(r.code, 2);
  assert.match(r.err, /in-place-required: .* - try: catscan pseudo Localizable\.xcstrings --in-place/);
  const base = fs.readFileSync(path.join(d, "Localizable.xcstrings"), "utf8");
  assert.equal(cli(["Localizable.xcstrings", "--out", "copy.xcstrings"], d).code, 0, "--out to a copy needs no --in-place");
  // Real strings are never replaced (review fix): the input, the source locale or a translated locale.
  r = cli(["Localizable.xcstrings", "--in-place", "--locale", "en"], d);
  assert.match(r.err, /locale-is-source: /);
  r = cli(["Localizable.xcstrings", "--in-place", "--locale", "DE"], d);
  assert.match(r.err, /locale-exists: .* already has real de strings/);
  r = cli(["Localizable.xcstrings", "--in-place", "--out", "other.xcstrings"], d);
  assert.match(r.err, /conflicting-options: --in-place/);
  r = cli(["locales/en.json", "--out", "locales/en.json", "--force"], d);
  assert.match(r.err, /output-is-input: /);
  r = cli(["locales/en.json", "--locale", "EN", "--force"], d); // a case variant of the input on APFS
  assert.match(r.err, /output-is-input: /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "locales/en.json"), "utf8")).nav.shop, "Shop");
  r = cli(["en.lproj/Localizable.strings", "--locale", "en", "--force"], d);
  assert.equal(r.code, 2);
  assert.match(r.err, /output-is-input: /);
  assert.match(fs.readFileSync(path.join(d, "Localizable.xcstrings"), "utf8"), /"value" : "%lld Datei"/, "the real de strings are untouched");
  r = cli(["locales/en.json", "--in-place", "--force"], d);
  assert.equal(r.code, 2);
  assert.match(r.err, /option-not-valid: --in-place works only with \.xcstrings/);
  assert.equal(fs.readFileSync(path.join(d, "Localizable.xcstrings"), "utf8"), base, "--out leaves the input untouched");
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "copy.xcstrings"), "utf8")).strings.Continue.localizations["en-XA"].stringUnit.value, "[Çöñtíñüé öñé]");
  // The generated catalog fed back in: already-pseudo.
  r = cli(["locales/en-XA.json", "--out", "x.json"], d);
  assert.equal(r.code, 2);
  assert.match(r.err, /already-pseudo: 12 of 12 strings .* - try: pass the base catalog/);
});

test("already-pseudo needs 90%: a base catalog with a few bracketed strings is still transformed", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pseudo-"));
  fs.mkdirSync(path.join(d, "locales"));
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i < 9 ? `[Héllö ${i}]` : "Plain"]));
  fs.writeFileSync(path.join(d, "locales/en.json"), JSON.stringify(many));
  assert.equal(cli(["locales/en.json"], d).code, 2);
  const few = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i < 8 ? `[Héllö ${i}]` : "Plain"]));
  fs.writeFileSync(path.join(d, "locales/en.json"), JSON.stringify(few));
  assert.equal(cli(["locales/en.json"], d).code, 0);
  // Brackets alone (no accent) are not pseudo: a base catalog may bracket a few labels.
  assert.equal(pseudo.looksPseudo("[Beta]"), false);
  assert.equal(pseudo.looksPseudo(" [Bétá] "), true);
});

test("summary and next steps per format on stderr; --json is one object on stdout, diagnostics on stderr", () => {
  const d = tree();
  const want = {
    json: /<app-url>\?lng=en-XA/,
    strings: /-AppleLanguages "\(en-XA\)"/,
    android: /adb shell cmd locale set-app-locales <package> --locales en-XA/,
    xcstrings: /-AppleLanguages "\(en-XA\)"/,
  };
  for (const c of CASES) {
    const r = cli([c.input, ...(c.flags ?? [])], d);
    assert.equal(r.out, "", "text mode writes nothing on stdout");
    assert.match(r.err, new RegExp(`^catscan pseudo: \\d+ strings transformed, \\d+ skipped \\(.*\\), \\d+ placeholders kept -> ${c.output.replace(/[.]/g, "\\.")}\\n`));
    assert.match(r.err, want[c.format]);
  }
  const r = cli(["locales/en.json", "--json", "--force"], d);
  const o = JSON.parse(r.out);
  assert.equal(r.out.trim().split("\n").length, 1);
  assert.deepEqual(Object.keys(o), ["command", "input", "output", "format", "locale", "variant", "expand", "transformed", "skipped", "placeholders", "warnings", "next"]);
  assert.deepEqual(o.skipped, { empty: 1, "no-letters": 1, url: 2 });
  assert.match(o.next[0].command, want.json);
  assert.equal(r.err, "");
});

test("stringsdict-skipped: a .stringsdict next to the input is named, the run still succeeds", () => {
  const d = tree();
  fs.writeFileSync(path.join(d, "en.lproj/Localizable.stringsdict"), "<plist/>");
  const r = cli(["en.lproj/Localizable.strings", "--json"], d);
  assert.equal(r.code, 0);
  assert.match(r.err, /catscan: stringsdict-skipped: Localizable\.stringsdict next to Localizable\.strings is not transformed/);
  assert.equal(JSON.parse(r.out).warnings[0].code, "stringsdict-skipped");
});

test("args: pseudo options, values and placement (D7)", () => {
  const usage = (argv, code, re) => assert.throws(() => parse(argv), (e) => e instanceof UsageError && e.code === code && (!re || re.test(e.message + " " + e.hint)));
  const o = parse(["pseudo", "en.json", "--expand", "25", "--variant", "tall", "--locale", "en-XB", "--out", "x.json", "--force"]);
  assert.deepEqual([o.expand, o.variant, o.locale, o.out, o.force, o.inPlace], [25, "tall", "en-XB", "x.json", true, false]);
  usage(["pseudo", "en.json", "--variant", "accnt"], "unknown-variant", /did you mean accent\?.*--variant accent/);
  usage(["pseudo", "en.json", "--expand", "301"], "invalid-expand", /0 to 300.*--expand 40/);
  usage(["pseudo", "en.json", "--fallback", "none"], "option-not-valid", /--fallback/);
  usage(["--fallback", "none", "pseudo", "en.json"], "option-not-valid", /no --fallback/);
  usage(["pseudo", "en.json", "--expand", "-5"], "invalid-expand");
  usage(["pseudo", "en.json", "--expand", "4.5"], "invalid-expand");
  usage(["pseudo"], "missing-path");
  usage(["pseudo", "a.json", "b.json"], "missing-path");
  usage(["pseudo", "-"], "missing-path");
  usage(["pseudo", "en.json", "--format", "github"], "option-not-valid");
  usage(["pseudo", "en.json", "--catalog", "x.json"], "option-not-valid");
  usage(["check", "shots", "--present", "x", "--expand", "40"], "option-not-valid");
  usage(["--force", "check", "shots", "--present", "x"], "option-not-valid", /work only with pseudo/);
});

test("loader errors are reused unchanged", () => {
  const d = tree();
  fs.writeFileSync(path.join(d, "locales/broken.json"), "{\"a\": }");
  let r = cli(["locales/broken.json"], d);
  assert.equal(r.code, 2);
  assert.match(r.err, /catscan: invalid-catalog: locales\/broken\.json:1:7: invalid JSON/);
  r = cli(["locales/missing.json"], d);
  assert.equal(r.code, 2);
  assert.match(r.err, /catalog-not-found/);
});

test("help and usage list pseudo", () => {
  const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.match(r.stdout, /catscan pseudo <catalog> \[--out <path>\]/);
  const u = spawnSync(process.execPath, [BIN], { encoding: "utf8" });
  assert.match(u.stdout, /Commands: .*pseudo/);
});

// Value: protects the exit-4 output-write-failed diagnostic; fails if a write error escapes as a crash or exits 0/2.
test("output-write-failed: an unwritable --out exits 4 with the path and a hint", () => {
  const d = tree();
  const r = cli(["locales/en.json", "--out", "locales/en.json/pseudo.json"], d);
  assert.equal(r.code, 4, r.err);
  assert.match(r.err, /catscan: output-write-failed: cannot write the pseudo catalog locales\/en\.json\/pseudo\.json: .* - try: check that the folder is writable/);
});

// Value: protects --quiet for pseudo; fails if next steps print under --quiet or the summary is dropped with them.
test("--quiet keeps the summary and drops the next steps", () => {
  const d = tree();
  const r = cli(["locales/en.json", "--quiet"], d);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^catscan pseudo: \d+ strings transformed/);
  assert.doesNotMatch(r.err, /next:|lng=/);
});

// Value: protects formatted="false" inheritance from <plurals> to its items; fails if %s in such an item is kept as a placeholder.
test("android: formatted=\"false\" on <plurals> reaches its items, so % stays literal text", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pseudo-"));
  const dir = path.join(d, "app/src/main/res/values");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "strings.xml"), "<resources>\n<plurals name=\"p\" formatted=\"false\"><item quantity=\"other\">%s left</item></plurals>\n<plurals name=\"q\"><item quantity=\"other\">%s left</item></plurals>\n</resources>\n");
  assert.equal(cli(["app/src/main/res/values/strings.xml", "--expand", "0"], d).code, 0);
  const out = fs.readFileSync(path.join(d, "app/src/debug/res/values-en-rXA/strings.xml"), "utf8");
  assert.match(out, /name="p" formatted="false"><item quantity="other">\[%š léft\]</);
  assert.match(out, /name="q"><item quantity="other">\[%s léft\]</);
});

// Value: protects the .strings unquoted-value skip; fails if a bare value is rewritten or not counted as skipped.
test(".strings: an unquoted value is left as is and counted as unquoted", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pseudo-"));
  fs.mkdirSync(path.join(d, "en.lproj"));
  fs.writeFileSync(path.join(d, "en.lproj/L.strings"), "\"a\" = bareword;\n\"b\" = \"Shop\";\n");
  const r = cli(["en.lproj/L.strings", "--expand", "0", "--json"], d);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).skipped, { unquoted: 1 });
  assert.equal(fs.readFileSync(path.join(d, "en-XA.lproj/L.strings"), "utf8"), "\"a\" = bareword;\n\"b\" = \"[Šhöp]\";\n");
});

// Value: protects --in-place on a symlinked catalog and reruns at --expand 0; fails if the link is replaced or a rerun is refused as locale-exists.
test("xcstrings --in-place: a symlink is rewritten at its target, and a rerun at --expand 0 is allowed", () => {
  const d = tree();
  fs.renameSync(path.join(d, "Localizable.xcstrings"), path.join(d, "real.xcstrings"));
  fs.symlinkSync("real.xcstrings", path.join(d, "Localizable.xcstrings"));
  assert.equal(cli(["Localizable.xcstrings", "--in-place", "--expand", "0"], d).code, 0);
  assert.ok(fs.lstatSync(path.join(d, "Localizable.xcstrings")).isSymbolicLink());
  assert.match(fs.readFileSync(path.join(d, "real.xcstrings"), "utf8"), /"\[%lld fílé\]"/);
  const r = cli(["Localizable.xcstrings", "--in-place", "--expand", "0", "--locale", "en-xa"], d);
  assert.equal(r.code, 0, r.err);
  const locs = JSON.parse(fs.readFileSync(path.join(d, "real.xcstrings"), "utf8")).strings.files.localizations;
  assert.deepEqual(Object.keys(locs), ["de", "en", "en-XA"], "a case variant replaces en-XA, never adds a twin");
});

// Value: protects the locale-exists guard both ways; fails if a placeholder-only pseudo value blocks a rerun or an unaccented bracketed translation is overwritten.
test("xcstrings --in-place: [%lld] reruns, a real bracketed translation is refused", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pseudo-"));
  const f = path.join(d, "L.xcstrings");
  const unit = (v) => ({ stringUnit: { state: "translated", value: v } });
  fs.writeFileSync(f, JSON.stringify({ sourceLanguage: "en", strings: { "%lld": { localizations: { en: unit("%lld") } }, Draft: { localizations: { en: unit("Draft"), de: unit("[Entwurf]") } } } }));
  assert.equal(cli(["L.xcstrings", "--in-place", "--expand", "0"], d).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).strings["%lld"].localizations["en-XA"].stringUnit.value, "[%lld]");
  const again = cli(["L.xcstrings", "--in-place", "--expand", "0"], d);
  assert.equal(again.code, 0, again.err);
  const de = cli(["L.xcstrings", "--in-place", "--locale", "de"], d);
  assert.match(de.err, /locale-exists: .* real de strings/);
});
