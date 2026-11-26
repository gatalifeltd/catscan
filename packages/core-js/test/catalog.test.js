// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 02: catalog formats, fragments, limits and @key resolution. Synthetic fixtures only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const catalog = require("../src/catalog");
const { parse, UsageError } = require("../src/args");
const expectFile = require("../src/expect");

const D = path.join(__dirname, "../../../test/fixtures/catalogs");
const fx = (f) => path.join(D, f);

function table(file, locale = "en") {
  const out = {};
  for (const [k, e] of catalog.loadAll([fx(file)], locale).keys) out[k] = e.reason ? { reason: e.reason } : e.alternatives;
  return out;
}
const expected = (name) => JSON.parse(fs.readFileSync(fx(`expected/${name}.json`), "utf8"));
const usage = (fn, code, re) => assert.throws(fn, (e) => e instanceof UsageError && e.code === code && (!re || re.test(e.message)));

test("formats: each fixture gives its checked-in fragment lists", () => {
  assert.deepEqual(table("en.json"), expected("en.json"));
  assert.deepEqual(table("Localizable.strings"), expected("Localizable.strings"));
  assert.deepEqual(table("utf16le.strings"), expected("utf16.strings"));
  assert.deepEqual(table("utf16be.strings"), expected("utf16.strings"));
  assert.deepEqual(table("Localizable.xcstrings", "en"), expected("xcstrings.en"));
  assert.deepEqual(table("Localizable.xcstrings", "de"), expected("xcstrings.de"));
  assert.deepEqual(table("Localizable.xcstrings", "pt-BR"), expected("xcstrings.pt-BR"));
  assert.deepEqual(table("strings.xml"), expected("strings.xml"));
});

test("formats: Android skips translatable=false and resolves @string/ references", () => {
  const t = table("strings.xml");
  assert.equal(t.app_name, undefined);
  assert.deepEqual(t.alias, t.apostrophe);
  assert.deepEqual(t.cycle_a, [[]]); // a cycle leaves no text (D16)
});

test("formats: detected by content when the extension says nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-cat-"));
  for (const [src, name] of [["strings.xml", "a"], ["en.json", "b"], ["Localizable.xcstrings", "c"], ["Localizable.strings", "d"]]) {
    fs.copyFileSync(fx(src), path.join(dir, name));
  }
  assert.equal(catalog.loadFile(path.join(dir, "a"), "en").format, "android");
  assert.equal(catalog.loadFile(path.join(dir, "b"), "en").format, "json");
  assert.equal(catalog.loadFile(path.join(dir, "c"), "en").format, "xcstrings");
  assert.equal(catalog.loadFile(path.join(dir, "d"), "en").format, "strings");
});

test("fragments: one example per placeholder style", () => {
  const f = (s, o) => catalog.fragments(s, o).alternatives;
  assert.deepEqual(f("Hi {name}, welcome"), [["Hi", ", welcome"]]);
  assert.deepEqual(f("Hi {{name}}, welcome"), [["Hi", ", welcome"]]);
  assert.deepEqual(f("Order {0} is ready"), [["Order", "is ready"]]);
  assert.deepEqual(f("Order {0, number} is ready"), [["Order", "is ready"]]);
  assert.deepEqual(f("Hello %@ there"), [["Hello", "there"]]);
  assert.deepEqual(f("%d new items"), [["new items"]]);
  assert.deepEqual(f("From %s to %s"), [["From", "to"]]);
  assert.deepEqual(f("%1$s and %2$s"), [["and"]]);
  assert.deepEqual(f("Pay %.2f now"), [["Pay", "now"]]);
  assert.deepEqual(f("%lld photos"), [["photos"]]);
  assert.deepEqual(f("Save 50%% now"), [["Save 50% now"]]); // D3: a literal %
  assert.deepEqual(f("100% done", { formatted: false }), [["100% done"]]);
  assert.deepEqual(f("{n, plural, one {# day left} other {# days left}}"), [["day left"], ["days left"]]);
  assert.deepEqual(f("{n, plural, offset:1 =0 {Nobody yet} other {You and # others}}"), [["Nobody yet"], ["You and", "others"]]);
  assert.deepEqual(f("{g, select, male {He won} other {They won}}"), [["He won"], ["They won"]]);
  assert.deepEqual(f("{p, selectordinal, one {#st place} other {#th place}}"), [["st place"], ["th place"]]);
  assert.deepEqual(f("{g, select, a {It''s on} other {Off}}"), [["It's on"], ["Off"]]);
  assert.deepEqual(f("Use {curly braces} here"), [["Use {curly braces} here"]]);
  assert.deepEqual(f("A stray { brace"), [["A stray { brace"]]);
  assert.deepEqual(f("100% done, 50% off"), [["100% done, 50% off"]]); // prose, not "% d" or "% o"
});

test("fragments: markup is dropped with its text kept; <br> is a line break", () => {
  const f = (s) => catalog.fragments(s).alternatives;
  assert.deepEqual(f("<b>Bold</b> text"), [["Bold text"]]);
  assert.deepEqual(f("Go <1>now</1>"), [["Go now"]]);
  assert.deepEqual(f("One<br/>Two<br>Three"), [["One\nTwo\nThree"]]);
  assert.deepEqual(f("a < b and c > d"), [["a < b and c > d"]]);
  assert.deepEqual(f('a <b and c> d <b class="x">bold</b>'), [["a <b and c> d bold"]]); // prose with < is kept
});

test("fragments: placeholder styles are recorded per catalog (spec 17 reads them)", () => {
  const cat = catalog.loadAll([fx("en.json")], "en");
  assert.deepEqual([...cat.styles].sort(), ["icu", "printf", "{0}", "{name}", "{{name}}"]);
});

test("escapes: Android and iOS", () => {
  assert.equal(catalog.androidUnescape(String.raw`Don\'t \"go\" \@home\? é\nnext`), "Don't \"go\" @home? é\nnext");
  assert.equal(catalog.androidUnescape('  spaced   out  '), "spaced out");
  assert.equal(catalog.androidUnescape('"  kept   "'), "  kept   ");
  const s = catalog.parseStrings(String.raw`"k" = "a\"b\\c\n\U00E9\t\101";`, "x.strings");
  assert.deepEqual(s.get("k").values, ["a\"b\\c\né\tA"]);
});

test("limits: plural blowup and depth are capped and skipped, never truncated (D6)", () => {
  const before = process.memoryUsage().heapUsed;
  const cat = catalog.loadAll([fx("hostile/plural-blowup.json")], "en");
  assert.equal(cat.keys.get("deep").reason, "catalog-string-capped");
  assert.equal(cat.keys.get("wide").reason, "catalog-string-capped");
  assert.deepEqual(cat.keys.get("deep").alternatives, []);
  assert.equal(cat.keys.get("fine").reason, undefined);
  assert.ok(cat.warnings.some((w) => w.code === "catalog-string-capped"));
  assert.ok(process.memoryUsage().heapUsed - before < 200 * 1024 * 1024);
  const four = "{a, plural, other {{b, plural, other {{c, plural, other {{d, plural, other {Four deep}}}}}}}}";
  assert.deepEqual(catalog.fragments(four).alternatives, [["Four deep"]]);
  assert.equal(catalog.fragments(`{z, plural, other {${four}}}`).capped, true);
});

test("limits: DOCTYPE (XXE, billion laughs) and unknown entities are rejected", () => {
  usage(() => catalog.loadAll([fx("hostile/xxe.xml")], "en"), "invalid-catalog", /xxe\.xml:2:1: .*DOCTYPE/);
  usage(() => catalog.loadAll([fx("hostile/billion-laughs.xml")], "en"), "invalid-catalog", /DOCTYPE/);
  usage(() => catalog.loadAll([fx("hostile/unknown-entity.xml")], "en"), "invalid-catalog", /:2:29: .*&nbsp;/);
});

test("limits: a file over 20 MB is a usage error", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-cat-")), "big.json");
  fs.writeFileSync(f, "");
  fs.truncateSync(f, catalog.MAX_FILE_BYTES + 1);
  usage(() => catalog.loadAll([f], "en"), "catalog-too-large");
});

test("errors: malformed files name file, line and column", () => {
  usage(() => catalog.loadAll([fx("malformed/bad.json")], "en"), "invalid-catalog", /bad\.json:4:1: invalid JSON/);
  usage(() => catalog.loadAll([fx("malformed/bad.xml")], "en"), "invalid-catalog", /bad\.xml:3:26: invalid XML/);
  usage(() => catalog.loadAll([fx("malformed/bad.strings")], "en"), "invalid-catalog", /bad\.strings:3:1: expected ;/);
  usage(() => catalog.decode(Buffer.from([0xc3, 0x28]), "x.json", false), "invalid-catalog", /not valid UTF-8/);
});

test("loading: last catalog wins a duplicate key, with one warning", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-cat-"));
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ x: "First value", y: "Kept value" }));
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify({ x: "Second value" }));
  const cat = catalog.loadAll([path.join(dir, "a.json"), path.join(dir, "b.json")], "en");
  assert.deepEqual(cat.keys.get("x").alternatives, [["Second value"]]);
  assert.equal(cat.keys.get("y").catalog, path.join(dir, "a.json"));
  const w = cat.warnings.filter((x) => x.code === "catalog-duplicate-key");
  assert.equal(w.length, 1);
  assert.match(w[0].message, /1 key is defined in more than one catalog; the last one wins \(x from .*b\.json\)/);
});

test("loading: a {locale} template takes the run locale; a missing file skips @key checks", () => {
  const tpl = path.join(D, "{locale}.json");
  assert.ok(catalog.loadAll([tpl], "en").keys.has("home.title"));
  const cat = catalog.loadAll([tpl], "fr");
  assert.equal(cat.warnings[0].code, "catalog-missing");
  assert.deepEqual(catalog.resolve("@home.title", cat, "--present"), { key: "home.title", catalog: null, text: "@home.title", alternatives: [], reason: "catalog-missing" });
  usage(() => catalog.loadAll([fx("nope.json")], "en"), "catalog-not-found");
});

test("resolve: @key, @@ literal, unknown keys name the closest", () => {
  const cat = catalog.loadAll([fx("en.json")], "en");
  assert.equal(catalog.resolve("Continue", cat, "--present"), "Continue");
  assert.equal(catalog.resolve("@@handle", cat, "--present"), "@handle");
  assert.deepEqual(catalog.resolve("@home.cta", cat, "--present"),
    { key: "home.cta", catalog: fx("en.json"), text: "Start your free trial", alternatives: [["Start your free trial"]] });
  usage(() => catalog.resolve("@home.titel", cat, "--present"), "unknown-catalog-key", /no key home\.titel \(\d+ keys\); closest: home\.title/);
  usage(() => catalog.resolve("@home.cta", null, "--present"), "missing-catalog");
  const xc = catalog.loadAll([fx("Localizable.xcstrings")], "de");
  assert.equal(catalog.resolve("@photos.count", xc, "--present").reason, "catalog-missing"); // D9
});

test("args: --catalog, --all-keys", () => {
  const o = parse(["check", "s/", "--catalog", "a.json", "--catalog=b.xml", "--all-keys", "--present", "@k"]);
  assert.deepEqual(o.catalogs, ["a.json", "b.xml"]);
  assert.equal(o.allKeys, true);
  assert.equal(parse(["check", "s/", "--catalog", "a.json", "--all-keys"]).allKeys, true); // --all-keys is a check
  assert.throws(() => parse(["check", "s/", "--all-keys"]), (e) => e.code === "missing-catalog");
  assert.throws(() => parse(["read", "s/", "--catalog", "a.json"]), (e) => e.code === "option-not-valid");
});

test("expect files accept @key strings", () => {
  const e = expectFile.parse('shots:\n  a.png: { present: ["@home.cta"], absent: ["@@literal"] }\n', "e.yaml");
  assert.deepEqual(e.shots[0].present, ["@home.cta"]);
  assert.deepEqual(e.shots[0].absent, ["@@literal"]);
});

test("render: a catalog check names key, text and file; the inventory has its own lines (D20, D10)", () => {
  const render = require("../src/render");
  const env = {
    command: "check", path: "a.png", verdict: "fail", engine: "vision-accurate-rev3", checks: [
      { kind: "present", key: "home.title", catalog: "en.json", text: "Welcome back, {name}!", verdict: "fail", closest: null },
      { kind: "absent", key: "x", catalog: null, text: "@x", verdict: "skipped", reason: "catalog-missing" },
    ], warnings: [],
    inventory: { found: [{ key: "a", line: "A", box: [0, 0, 1, 1] }], not_found: ["b"], skipped: [{ key: "c", reason: "no-checkable-text" }] },
  };
  assert.deepEqual(render.renderText(env), [
    "FAIL  a.png",
    '  present @home.title "Welcome back, {name}!" (en.json): not found; no text recognized',
    '  absent @x "@x": skipped (catalog-missing)',
    "  inventory: 1 of 3 keys found, 1 skipped",
    "  found: a",
  ]);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "catscan-cat-"));
const write = (dir, name, data) => { const f = path.join(dir, name); fs.writeFileSync(f, data); return f; };

test("review fixes: braces stay linear; deep nesting and key collisions are invalid-catalog", () => {
  // CPU time, not wall time: the CI runner is a shared Mac with other load (TODO-004 D14). Quadratic is minutes.
  const t0 = process.cpuUsage();
  catalog.fragments("{".repeat(200000));
  catalog.fragments("{{".repeat(100000));
  const cpu = process.cpuUsage(t0);
  assert.ok((cpu.user + cpu.system) / 1e6 < 2);
  const d = tmp();
  const deep = write(d, "deep.json", `{"a":${"[".repeat(5000)}"x"${"]".repeat(5000)}}`);
  usage(() => catalog.loadAll([deep], "en"), "invalid-catalog", /nested deeper than 64/);
  const both = write(d, "both.json", JSON.stringify({ "a.b": "Flat one", a: { b: "Nested one" } }));
  usage(() => catalog.loadAll([both], "en"), "invalid-catalog", /a\.b is defined twice/);
  const xmlDeep = write(d, "deep.xml", `<resources><string name="k">${"<b>".repeat(100)}x${"</b>".repeat(100)}</string></resources>`);
  usage(() => catalog.loadAll([xmlDeep], "en"), "invalid-catalog", /nested deeper/);
});

test("review fixes: a lone surrogate escape is invalid-catalog, not a broken request", () => {
  const d = tmp();
  usage(() => catalog.loadAll([write(d, "s.strings", '"k" = "bad \\UD83D here";')], "en"), "invalid-catalog", /not valid Unicode/);
  usage(() => catalog.loadAll([write(d, "j.json", '{"k": "bad \\ud83d here"}')], "en"), "invalid-catalog", /not valid Unicode/);
});

test("review fixes: the 32 MB budget counts serialized UTF-8 bytes (D8)", () => {
  const d = tmp();
  const o = {};
  for (let i = 0; i < 2000; i++) o[`k${i}`] = "設定を開いてください".repeat(300); // ~9 KB UTF-8 each, ~18 MB file
  const f = write(d, "cjk.json", JSON.stringify(o));
  assert.ok(fs.statSync(f).size < catalog.MAX_FILE_BYTES);
  usage(() => catalog.loadAll([f], "ja"), "catalog-too-large", /32 MB/);
});

test("review fixes: BOM-less UTF-16 .strings; odd UTF-16 is invalid", () => {
  const d = tmp();
  const f = write(d, "nobom.strings", Buffer.from('"k" = "Sans BOM here";', "utf16le"));
  assert.deepEqual(catalog.loadAll([f], "en").keys.get("k").alternatives, [["Sans BOM here"]]);
  usage(() => catalog.decode(Buffer.from([0xfe, 0xff, 0x00]), "x.strings", true), "invalid-catalog", /odd number/);
});

test("review fixes: D12 skips every @key when a {locale} file is missing, even beside another catalog", () => {
  const d = tmp();
  const common = write(d, "common.json", JSON.stringify({ shared: "Shared string here" }));
  const cat = catalog.loadAll([common, path.join(d, "{locale}.json")], "fr");
  assert.equal(catalog.resolve("@shared", cat, "--present").reason, "catalog-missing");
  assert.equal(catalog.resolve("@only.in.fr", cat, "--present").reason, "catalog-missing");
});

test("review fixes: duplicate warning names each key's winning file; unreadable files are errors", () => {
  const d = tmp();
  const a = write(d, "a.json", JSON.stringify({ x: "One one", y: "Two two" }));
  const b = write(d, "b.json", JSON.stringify({ x: "Three three" }));
  const c = write(d, "c.json", JSON.stringify({ y: "Four four" }));
  const w = catalog.loadAll([a, b, c], "en").warnings.find((x) => x.code === "catalog-duplicate-key");
  assert.match(w.message, /x from .*b\.json, y from .*c\.json/);
  if (process.getuid && process.getuid() !== 0) {
    const locked = write(d, "locked.json", "{}");
    fs.chmodSync(locked, 0);
    usage(() => catalog.loadAll([locked], "en"), "catalog-not-found", /cannot read/);
  }
});

test("review fixes: .xcstrings zh-Hant never falls back to a zh-Hans source", () => {
  const d = tmp();
  const f = write(d, "zh.xcstrings", JSON.stringify({ sourceLanguage: "zh-Hans", version: "1.0", strings: { "打开设置页面": {} } }));
  assert.deepEqual(catalog.loadAll([f], "zh-Hans").keys.get("打开设置页面").alternatives, [["打开设置页面"]]);
  assert.equal(catalog.loadAll([f], "zh-Hant").keys.get("打开设置页面").reason, "catalog-missing");
});

test("review pass 2: long strings are capped, deep .xcstrings and surrogate keys are invalid, the budget counts once", () => {
  const d = tmp();
  const long = write(d, "long.json", JSON.stringify({ big: "{".repeat(70 * 1024), fine: "Normal string here" }));
  const cat = catalog.loadAll([long], "en");
  assert.equal(cat.keys.get("big").reason, "catalog-string-capped");
  let deep = { stringUnit: { value: "Leaf text here" } };
  for (let i = 0; i < 70; i++) deep = { variations: { plural: { other: deep } } };
  const xc = write(d, "deep.xcstrings", JSON.stringify({ sourceLanguage: "en", strings: { k: { localizations: { en: deep } } } }));
  usage(() => catalog.loadAll([xc], "en"), "invalid-catalog", /nested deeper/);
  usage(() => catalog.loadAll([write(d, "key.json", '{"bad \\ud83d key": "Hello there"}')], "en"), "invalid-catalog", /not valid Unicode/);
  const ascii = {};
  for (let i = 0; i < 200; i++) ascii[`k${i}`] = "a".repeat(50 * 1024); // ~10 MB of text, ~20 MB serialized
  assert.equal(catalog.loadAll([write(d, "ascii.json", JSON.stringify(ascii))], "en").keys.size, 200);
});
