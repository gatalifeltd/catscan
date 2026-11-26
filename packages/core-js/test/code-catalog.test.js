// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-092: string catalogs kept in TypeScript or JavaScript, read as text and never run. Synthetic fixtures only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const catalog = require("../src/catalog");
const code = require("../src/code-catalog");
const untranslated = require("../src/untranslated");
const pseudo = require("../src/pseudo");
const { parse, UsageError } = require("../src/args");

const D = path.join(__dirname, "../../../test/fixtures/catalogs");
const fx = (f) => path.join(D, f);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "catscan-code-"));
const write = (dir, name, text) => { const f = path.join(dir, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const texts = (cat) => Object.fromEntries([...cat.keys].map(([k, e]) => [k, e.reason ? { reason: e.reason } : e.text]));
const usage = (fn, code_, re) => assert.throws(fn, (e) => e instanceof UsageError && e.code === code_ && (!re || re.test(`${e.message} | ${e.hint}`)));

test("shapes: a TypeScript copy of en.json gives the same fragments", () => {
  const json = catalog.loadAll([fx("en.json")], "en");
  const ts = catalog.loadAll([fx("code/en.ts")], "en");
  const table = (cat) => Object.fromEntries([...cat.keys].filter(([k]) => k !== "count").map(([k, e]) => [k, e.alternatives]));
  assert.deepEqual(table(ts), table(json));
  assert.deepEqual(ts.warnings, []);
  assert.equal(catalog.loadFile(fx("code/en.ts"), "en").format, "code");
});

test("shapes: keys, escapes, numbers, templates, references and type syntax", () => {
  const cat = catalog.loadAll([fx("code/shapes.ts")], "en");
  assert.deepEqual(texts(cat), {
    plain: "Einstellungen", double: "Doppelt \"zitiert\"", esc: "Zeile\neins\tTab A é \u{1F600} \\ ' \0", cont: "Eins zwei",
    tpl: "Mehrere\nZeilen", num: "42", neg: "-1.5", big: "1000", 12: "Zahl als Schluessel", "a.b": "Flacher Punkt", computed: "Berechnet",
    "nested.deep.deeper": "Tief", "nested.list[0]": "Eins", "nested.list[1]": "Zwei", "nested.list[2][0]": "Drei", dup: "Neu",
    "ref.shared": "Shared text", typed: "Typ", bang: "Ausruf",
  });
  // `['comp' + '']` is a computed key nobody can read: any key of that object may be it.
  assert.deepEqual(cat.warnings.map((w) => w.code), ["catalog-values-skipped"]);
  assert.match(cat.warnings[0].message, /1 value in .*shapes\.ts is not a plain string \(1 computed key\) and was skipped \(odd\[\.\.\.\]\)/);
});

test("shapes: named, CommonJS, folder index, locale exports and namespaces", () => {
  assert.deepEqual(texts(catalog.loadAll([fx("code/named.ts")], "de")), { title: "Einstellungen", ok: "OK" });
  assert.deepEqual(texts(catalog.loadAll([fx("code/cjs.cjs")], "en")), { title: "Settings", "nested.ok": "Fine" });
  assert.deepEqual(texts(catalog.loadAll([fx("code/{locale}/index.ts")], "de")), { title: "Einstellungen" });
  const pt = catalog.loadAll([fx("code/locales.ts")], "pt-BR");
  assert.deepEqual(texts(pt), { title: "Configurações", save: "Salvar alterações" });
  assert.equal(texts(catalog.loadAll([fx("code/locales.ts")], "de-AT")).title, "Einstellungen"); // its language
  assert.deepEqual(catalog.codeLocales(fx("code/locales.ts")), ["de", "en", "pt-BR"]);
  assert.equal(catalog.codeLocales(fx("code/named.ts")), null);
  // D12: no export for the run locale is a missing catalog, so @key checks are skipped, not usage errors.
  const fr = catalog.loadAll([fx("code/locales.ts")], "fr");
  assert.deepEqual([fr.missing, fr.warnings.map((w) => w.code)], [[fx("code/locales.ts")], ["catalog-missing"]]);
  assert.equal(catalog.resolve("@title", fr, "--present").reason, "catalog-missing");
  assert.deepEqual(texts(catalog.loadAll([fx("code/namespaces.ts")], "en")), { "common.ok": "OK", "common.cancel": "Cancel", "settings.title": "Settings" });
  // D19: a bare JSON object in a .js file is read as JSON, as before.
  // Written here, not committed: a fixture would need the licence header, and a comment makes it no longer bare JSON.
  const bare = catalog.loadFile(write(tmp(), "bare.js", '{\n  "title": "Bare JSON in a .js file"\n}\n'), "en");
  assert.deepEqual([bare.format, bare.entries.get("title").values], ["json", ["Bare JSON in a .js file"]]);
});

test("extensions: all eight are read as code catalogs", () => {
  const d = tmp();
  const src = fs.readFileSync(fx("code/named.ts"), "utf8");
  for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
    const f = write(d, `de${ext}`, src);
    assert.equal(catalog.loadFile(f, "de").format, "code", ext);
    assert.equal(catalog.loadAll([f], "de").keys.get("title").text, "Einstellungen", ext);
  }
  assert.deepEqual(code.EXTENSIONS.sort(), [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
});

test("skipped values: kept as catalog-value-dynamic keys, counted in one warning (D5, D6, D10, D15, D18)", () => {
  const cat = catalog.loadAll([fx("code/dynamic.ts")], "en");
  const t = texts(cat);
  assert.equal(t.late, "Written after the spread");
  assert.equal(t.plain, "Plain text");
  assert.equal(t["nested.after"], "After the inner spread");
  for (const k of ["early", "nested.inner", "greet", "call", "wrapped", "fn", "fn2", "method", "accessor", "ref", "section", "concat", "flag", "nothing", "shorthandMissing", "jsx"]) {
    assert.deepEqual(t[k], { reason: "catalog-value-dynamic" }, k);
  }
  assert.equal(cat.warnings.length, 1);
  const w = cat.warnings[0];
  assert.equal(w.code, "catalog-values-skipped");
  assert.match(w.message, /^19 values in .*dynamic\.ts are not plain strings \(4 spreads, 4 functions, 3 references, 2 calls, 2 expressions, 2 true\/false\/nulls, 1 template with \$\{\}, 1 computed key\) and were skipped \(early, nested\.inner, greet, \.\.\.\); those keys get no @key, untranslated, truncated or formats checks$/);
  assert.equal(w.hint, "write those strings as literals, or pass the JSON file the code imports with --catalog");
  // An @key to a dynamic value, below one, or one only a spread could supply is a skipped check.
  for (const k of ["@greet", "@section.title", "@nested.zzz", "@anything"]) assert.equal(catalog.resolve(k, cat, "--present").reason, "catalog-value-dynamic", k);
  assert.deepEqual(catalog.resolve("@plain", cat, "--present").alternatives, [["Plain text"]]);
  // With no spread or dynamic value, an unknown key is still a usage error naming the closest.
  usage(() => catalog.resolve("@titel", catalog.loadAll([fx("code/named.ts")], "de"), "--present"), "unknown-catalog-key", /closest: title/);
  // The truncated prefix rule and the inventory never get text from a dynamic value.
  assert.ok(catalog.inventory(cat).filter((e) => e.key === "greet").every((e) => e.reason === "catalog-value-dynamic"));
});

test("never runs the file: code that would write a marker or exit is only read (D2)", () => {
  const marker = path.join(tmp(), "pwned");
  const before = process.env.CATSCAN_PWNED;
  process.env.CATSCAN_PWNED = marker;
  try {
    const cat = catalog.loadAll([fx("code/malicious.js")], "en");
    assert.deepEqual(texts(cat), {
      safe: "Safe text", boom: { reason: "catalog-value-dynamic" }, iife: { reason: "catalog-value-dynamic" },
      "proto.__proto__": "Proto key", "ctor.constructor": "Constructor key",
    });
    assert.equal(fs.existsSync(marker), false);
    assert.equal({}.boom, undefined); // nothing leaked onto Object.prototype
    assert.equal(Object.prototype.__proto__, null);
  } finally {
    if (before === undefined) delete process.env.CATSCAN_PWNED; else process.env.CATSCAN_PWNED = before;
  }
});

test("errors: unreadable exports say what they are and the fix (D14, D17)", () => {
  const e = (f) => fx(`code/errors/${f}`);
  usage(() => catalog.loadAll([e("call.ts")], "en"), "invalid-catalog",
    /call\.ts:3:1: the default export is a call \(defineMessages\(\.\.\.\)\); catscan reads only object literals and never runs the file \| export the object literal itself/);
  usage(() => catalog.loadAll([e("import.ts")], "en"), "invalid-catalog",
    /the default export is an imported value \(de from '\.\/de\.json'\).* \| pass .*errors\/de\.json with --catalog$/);
  usage(() => catalog.loadAll([e("none.ts")], "en"), "invalid-catalog", /no exported object literal \| export the strings as export default/);
  usage(() => catalog.loadAll([e("index.ts")], "en"), "invalid-catalog",
    /index\.ts:5:16: index\.ts re-exports other files \(\.\/de, \.\/en\); catscan does not follow imports \| pass those files with --catalog, e\.g\. --catalog '.*errors\/\{locale\}\.ts'/);
  usage(() => catalog.loadAll([e("unterminated.ts")], "en"), "invalid-catalog", /unterminated\.ts:4:10: unterminated string/);
  usage(() => catalog.loadAll([e("comment.ts")], "en"), "invalid-catalog", /comment\.ts:4:22: unterminated \/\* comment/);
  usage(() => catalog.loadAll([e("clash.ts")], "en"), "invalid-catalog", /the key a\.b is defined twice \(flat and nested\)/);
  let deep = "'Leaf'";
  for (let i = 0; i < 70; i++) deep = `{ k: ${deep} }`;
  usage(() => catalog.loadAll([write(tmp(), "deep.ts", `export default ${deep};`)], "en"), "invalid-catalog", /nested deeper than 64 levels/);
});

test("pseudo refuses a code catalog (D7)", () => {
  usage(() => pseudo.generate({ file: fx("code/en.ts") }), "format-not-supported", /code catalog; pseudo writes JSON/);
});

test("untranslated: a dynamic target is not a missing translation; one file with locale exports compares its locales (D6, D11)", () => {
  const d = tmp();
  // Value: protects=D6 a dynamic value on either side yields no untranslated pair; fails_when=the base side's dynamic entry is compared as text; why_new=only the target side was dynamic; seam=none; no_claim=none beyond protects
  const en = write(d, "en.ts", "export default { title: 'Settings', greet: 'Hello there friend', bye: `Bye ${name}` };");
  const de = write(d, "de.ts", "export default { title: 'Einstellungen', greet: `Hallo ${name}`, bye: 'Tschuess' };");
  const r = untranslated.build(parse(["untranslated", "shot.png", "--locale", "de", "--base", en, "--catalog", de]));
  assert.deepEqual(r.field.pairs.map((p) => [p.key, p.expected]), [["title", "Einstellungen"]]);
  const all = fx("code/locales.ts");
  const same = untranslated.build(parse(["untranslated", "shot.png", "--locale", "de", "--base", all, "--base-locale", "en", "--catalog", all]));
  assert.ok(!same.runWarnings.some((w) => w.code === "untranslated-base-catalog"));
  assert.deepEqual(same.field.pairs.map((p) => [p.key, p.base, p.expected]), [["title", "Settings", "Einstellungen"], ["save", "Save changes", "Speichern"]]);
  // wrong-language finds the file's other locales.
  const wl = untranslated.build(parse(["untranslated", "shot.png", "--locale", "de", "--catalog", all])).field.wrong_language;
  assert.deepEqual(wl.languages, ["en", "pt-BR"]);
});

test("linear time: a catalog four times larger costs about the same per key to read (D1)", () => {
  // Load-independent (docs/gotchas/tests.md): the reader is timed against itself, per key, at n and 4n keys. The two sizes
  // alternate so load drifts hit both, a GC runs before each timed read so one run's garbage stays out of the next, and
  // the median of seven back-to-back pairs drops stalls. Linear stays near 1, quadratic near 4. A ratio against JSON.parse was biased: the
  // best-of ratio picked the run whose ~10 ms JSON.parse stalled, so load alone read up to 3.3x on CI.
  const big = (n) => {
    const parts = ["// generated\nexport default {\n"];
    for (let i = 0; i < n; i++) parts.push(`  g${i}: { 'k-${i}': 'Value number ${i} with \\n escape \\u00e9', t${i}: \`Template ${i}\`, n: ${i}, arr: ['a${i}', "b"] },\n`);
    parts.push("} as const;\n");
    return parts.join("");
  };
  require("v8").setFlagsFromString("--expose-gc");
  const gc = require("vm").runInNewContext("gc");
  const ms = (fn) => { gc(); const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const small = big(10000), large = big(40000);
  for (let r = 0; r < 2; r++) code.parse(small, "warm.ts", "en"); // warm the JIT at the measured size
  // Each pair is timed back to back, so a load change shifts both halves of a pair; the median pair drops stalls.
  const growths = [];
  for (let r = 0; r < 7; r++) {
    const s1 = ms(() => code.parse(small, "big.ts", "en")) / 10000;
    growths.push(ms(() => code.parse(large, "big.ts", "en")) / 40000 / s1);
  }
  const growth = median(growths);
  // gstack-timing-ok: per-key medians of interleaved runs after a forced GC; linear ~1, quadratic ~4 (docs/gotchas/tests.md)
  assert.ok(growth < 2, `per-key read time grew ${growth}x when the catalog grew 4x`);
  // A 10 MB catalog reads in full; the bound only catches a hang.
  const text = big(80000);
  assert.ok(text.length > 10 * 1024 * 1024 * 0.9, `${text.length} bytes`);
  let keys = 0;
  // gstack-timing-ok: a hang guard 30x above the loaded-Mac time, not a speed claim
  assert.ok(ms(() => { keys = code.parse(text, "big.ts", "en").entries.size; }) < 60000);
  assert.equal(keys, 80000 * 5);
  // Unclosed brackets in a skipped value, a long run of backslashes, a long template with substitutions: a quadratic
  // pass over a million characters would not finish within the hang bound.
  const d = tmp();
  // gstack-timing-ok: hang guards; a quadratic pass over a million characters never finishes inside them
  const hang = (text_, name) => ms(() => { try { catalog.loadAll([write(d, name, text_)], "en"); } catch (e) { if (!(e instanceof UsageError)) throw e; } });
  // gstack-timing-ok: hang guard
  assert.ok(hang(`export default { a: f(${"[(".repeat(500000)} };`, "brackets.ts") < 20000);
  // gstack-timing-ok: hang guard
  assert.ok(hang(`export default { a: '${"\\\\".repeat(2500000)}' };`, "backslash.ts") < 20000);
  // gstack-timing-ok: hang guard
  assert.ok(hang(`export default { a: \`${"x${y}".repeat(500000)}\`, b: 'ok' };`, "template.ts") < 20000);
});

// D9: a seeded round trip. Random nested catalogs are printed as TypeScript in varied styles and must read back
// exactly. Nothing is evaluated: the expected map is the generator's own data.
test("round trip: 500 generated catalogs printed in varied TS styles read back exactly (D9)", () => {
  let seed = 0x92092;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const CHARS = ["a", "b", "Z", " ", "'", "\"", "`", "\\", "$", "{", "}", "\n", "\t", "\r", "é", "中", "\u{1F600}", " ", "/", "*", "%", "#", "0", "\0"];
  const str = () => Array.from({ length: Math.floor(rnd() * 12) }, () => pick(CHARS)).join("");
  const KEYS = ["title", "ok", "__proto__", "constructor", "with space", "dash-key", "über", "$dollar", "_u", "class", "default", "x1", "中文"];
  const gen = (depth) => {
    const o = Object.create(null); // `__proto__` is an own key here, as in the printed literal
    const n = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const k = rnd() < 0.5 ? pick(KEYS) : `k${Math.floor(rnd() * 50)}`;
      const r = rnd();
      o[k] = depth < 4 && r < 0.25 ? gen(depth + 1) : depth < 4 && r < 0.35 ? Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => str()) : str();
    }
    return o;
  };
  const escape = (s, q) => [...s].map((c) => {
    if (c === "\\") return "\\\\";
    if (c === q) return `\\${q}`;
    if (c === "\n") return q === "`" && rnd() < 0.5 ? "\n" : "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return rnd() < 0.5 ? "\t" : "\\t";
    if (c === "\0") return pick(["\\x00", "\\u0000"]); // `\0` before a digit would be an octal escape
    if (c === " ") return "\\u2028";
    if (c === "$" && q === "`") return "\\$";
    if (c > "\u007f" && rnd() < 0.3) return c.length === 2 ? `\\u{${c.codePointAt(0).toString(16)}}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
    return c;
  }).join("");
  const lit = (s) => { const q = pick(["'", "\"", "`"]); return `${q}${escape(s, q)}${q}`; };
  const keyText = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) && rnd() < 0.6 ? k : rnd() < 0.2 ? `[${lit(k)}]` : lit(k));
  const sep = () => pick([" ", "\n  ", " /* c */ ", " // c\n  "]);
  const print = (v) => {
    if (typeof v === "string") return lit(v) + (rnd() < 0.1 ? " as const" : "");
    if (Array.isArray(v)) return `[${v.map(print).join(`,${sep()}`)}${rnd() < 0.3 ? "," : ""}]`;
    const props = Object.keys(v).map((k) => `${keyText(k)}:${sep()}${print(v[k])}`);
    return `{${sep()}${props.join(`,${sep()}`)}${rnd() < 0.5 ? "," : ""}${sep()}}`;
  };
  const flat = (v, key, out) => {
    if (typeof v === "string") out.set(key, v);
    else if (Array.isArray(v)) v.forEach((x, i) => flat(x, `${key}[${i}]`, out));
    else for (const k of Object.keys(v)) flat(v[k], key ? `${key}.${k}` : k, out);
    return out;
  };
  const wrap = (body) => pick([
    (b) => `export default ${b};`,
    (b) => `export default ${b} as const;`,
    (b) => `import type { M } from './m';\nexport default ${b} satisfies M;`,
    (b) => `const de: Record<string, (n: number) => string> = ${b};\nexport default de;`,
    (b) => `module.exports = ${b};`,
    (b) => `export const de = (${b});`,
    (b) => `const helper = (x) => x / 2;\nconst re = /[{}'"]/g;\nexport default ${b}\n`,
  ])(body);
  for (let i = 0; i < 500; i++) {
    const data = gen(0);
    // An own __proto__ key: JSON.parse semantics, so the generator's object has it as data.
    const expected = flat(JSON.parse(JSON.stringify(data)), "", new Map());
    const text = wrap(print(data));
    const got = code.parse(text, "gen.ts", "en");
    assert.deepEqual(new Map([...got.entries].map(([k, e]) => [k, e.values[0]])), expected, text);
    assert.equal(got.skipped.count, 0, text);
  }
});

// Value: protects=every JS escape and number form is cooked as JS would, and a bad escape is invalid-catalog with line:column; fails_when=an escape or number branch drifts or a bad escape reads silently; why_new=shapes.ts has no legacy octal, hex/bigint numbers or bad escapes; seam=none; no_claim=none beyond protects
test("escapes and numbers: legacy octal, hex, binary, bigint, separators; a bad escape is invalid-catalog", () => {
  const r = code.parse("export default { a: '\\101\\7', b: 0x10, c: 010, d: 1_000, e: 10n, f: 0b11, g: .5 };", "x.ts", "en");
  assert.deepEqual(Object.fromEntries([...r.entries].map(([k, e]) => [k, e.values[0]])), { a: "A\u0007", b: "16", c: "8", d: "1000", e: "10", f: "3", g: "0.5" });
  for (const [v, msg] of [["'\\xZZ'", "invalid \\x escape"], ["'\\u12'", "invalid \\u escape"], ["'\\u{110000}'", "invalid \\u{} escape"], ["`\\1`", "octal escape in a template"]]) {
    usage(() => code.parse(`export default {\n  a: ${v} };`, "x.ts", "en"), "invalid-catalog", new RegExp(`^x\\.ts:2:7: ${msg.replace(/[\\{}]/g, "\\$&")}`));
  }
});

// Value: protects=export-list forms are read (D3) and a re-export from another file is never followed (D2); fails_when=the export { } branch is dropped or follows `from`; why_new=no fixture uses export { }; seam=none; no_claim=none beyond protects
test("shapes: export { x as default } and export { a, b } read; export { x } from is not followed", () => {
  assert.deepEqual(texts(catalog.loadAll([write(tmp(), "d.ts", "const m = { t: 'T' };\nexport { m as default };")], "en")), { t: "T" });
  assert.deepEqual(texts(catalog.loadAll([write(tmp(), "n.ts", "const common = { ok: 'OK' }, settings = { title: 'Settings' };\nexport { common, settings };")], "en")), { "common.ok": "OK", "settings.title": "Settings" });
  usage(() => catalog.loadAll([write(tmp(), "r.ts", "export { de } from './de';")], "en"), "invalid-catalog", /no exported object literal/);
});

// Value: protects=D18 an array spread leaves the array open, so @list[n] is a skipped check, not unknown-catalog-key; fails_when=the `[` open-prefix rule in resolve or the array-spread branch is removed; why_new=only object spreads are tested; seam=none; no_claim=the index of items after an array spread (undecided)
test("array spread: items before it are read, the spread slot and unknown indexes are skipped (D18)", () => {
  const cat = catalog.loadAll([write(tmp(), "a.ts", "export default { list: ['First', ...more], title: 'T' };")], "en");
  assert.equal(cat.keys.get("list[0]").text, "First");
  assert.equal(cat.keys.get("list[1]").reason, "catalog-value-dynamic");
  assert.equal(catalog.resolve("@list[5]", cat, "--present").reason, "catalog-value-dynamic");
  usage(() => catalog.resolve("@titel", cat, "--present"), "unknown-catalog-key", /closest: title/);
  // An item after a spread has no known index: never read at its written one.
  const after = catalog.loadAll([write(tmp(), "b.ts", "export default { list: ['a', ...more, 'c'] };")], "en");
  assert.deepEqual([...after.keys.keys()].sort(), ["list[0]", "list[1]"]);
  assert.equal(after.keys.get("list[1]").reason, "catalog-value-dynamic");
  assert.equal(catalog.resolve("@list[2]", after, "--present").reason, "catalog-value-dynamic");
});

// Value: protects=templates read CRLF as LF, an unterminated template is invalid-catalog, a const cycle stays dynamic; fails_when=raw CR leaks into fragments, an open template hangs or crashes, deref loops; why_new=no fixture had these; seam=none; no_claim=none beyond protects
test("templates and references: CRLF in a template is LF; an open template is invalid; a reference cycle is dynamic", () => {
  const d = tmp();
  const crlf = catalog.loadAll([write(d, "crlf.ts", "export default {\r\n  t: `One\r\nTwo\rThree`,\r\n  e: `Esc\\r`,\r\n};\r\n")], "en");
  assert.deepEqual([crlf.keys.get("t").text, crlf.keys.get("e").text], ["One\nTwo\nThree", "Esc\r"]);
  usage(() => catalog.loadAll([write(d, "open.ts", "export default {\n  t: `never closed,\n};\n")], "en"), "invalid-catalog", /open\.ts:2:6: unterminated template/);
  const cyc = catalog.loadAll([write(d, "cyc.ts", "const a = { b }; const b = { a }; export default { x: a, ok: 'Fine' };")], "en");
  assert.deepEqual([cyc.keys.get("x.b.a").reason, cyc.keys.get("ok").text], ["catalog-value-dynamic", "Fine"]);
});

// Value: protects=a folder of per-locale .ts files works as a {locale} template for check, untranslated and the truncated prefix rule; fails_when=dynamic values reach truncated prefixes or the template misses .ts siblings; why_new=the i18n fixtures were unused; seam=none; no_claim=Vision matching (test/catalog.test.js round trip covers it)
test("i18n folder: per-locale .ts files as a {locale} template; dynamic values never become truncated prefixes", () => {
  const tpl = fx("code/i18n/{locale}.ts");
  const de = catalog.loadAll([tpl], "de");
  assert.equal(de.keys.get("menu.play").text, "Jetzt spielen");
  assert.deepEqual(de.keys.get("hud.lives").alternatives, [["Leben übrig"]]);
  assert.deepEqual(untranslated.localesOnDisk(tpl), ["de", "en"]);
  const r = untranslated.build(parse(["untranslated", "shot.png", "--locale", "de", "--base", fx("code/i18n/en.ts"), "--catalog", tpl]));
  assert.equal(r.field.pairs.find((p) => p.key === "menu.quit").expected, "Spiel beenden");
  const truncated = require("../src/truncated");
  const shot = { path: path.join(tmp(), "shot.png"), arg: "shot.png", argIsDir: false, stdin: false };
  const t = truncated.build(parse(["truncated", shot.path, "--catalog", fx("code/dynamic.ts"), "--reasons", "prefix"]), [shot]);
  const { field } = t.forInput(shot);
  assert.deepEqual(field.prefixes.map((p) => p.text).sort(), ["After the inner spread", "Plain text", "Written after the spread"]);
});

// Value: protects=D3 only export names that are language codes make a locale file (pt_BR, zhHans normalized); fails_when=the language-code check is dropped and ui/app exports become locales; why_new=locales.ts has only real codes; seam=none; no_claim=none beyond protects
test("locale exports: pt_BR and zhHans are tags; ui, app or a non-locale name beside en are namespaces (D3)", () => {
  const d = tmp();
  assert.deepEqual(catalog.codeLocales(write(d, "a.ts", "export const pt_BR = { a: 'x' }; export const zhHans = { a: 'y' };")), ["pt-BR", "zh-Hans"]);
  const ns = write(d, "b.ts", "export const ui = { a: 'x' }; export const app = { a: 'y' };");
  assert.equal(catalog.codeLocales(ns), null);
  assert.deepEqual(texts(catalog.loadAll([ns], "fr")), { "ui.a": "x", "app.a": "y" });
  assert.equal(catalog.codeLocales(write(d, "c.ts", "export const en = { a: 'x' }; export const common = { a: 'y' };")), null);
});

// Value: protects=a shared const reused many times cannot blow up time or memory, keys before a late spread stay linear, JSX text with a quote is skipped not fatal; fails_when=the walk budget, the key log or the JSX scanner is removed; why_new=review findings (security, red-team, testing); seam=none; no_claim=none beyond protects
test("review fixes: reference fan-out is invalid, a late spread is linear, JSX text with quotes is skipped (D2)", () => {
  let fan = "const a0 = { x: 'v' };\n";
  for (let i = 1; i <= 30; i++) fan += `const a${i} = { l: a${i - 1}, r: a${i - 1} };\n`;
  fan += "export default a30;\n";
  // gstack-timing-ok: a hang guard; without the budget this input needs 2^30 steps
  const t0 = Date.now();
  assert.throws(() => code.parse(fan, "fan.ts", "en"), (e) => e.code === "invalid-catalog" && /expand past a million entries/.test(e.message));
  // gstack-timing-ok: same hang guard
  assert.ok(Date.now() - t0 < 20000);
  const shared = code.parse("const s = { ok: 'OK' };\nexport default { a: s, b: s, c: { d: s } };", "s.ts", "en");
  assert.deepEqual([...shared.entries.keys()].sort(), ["a.ok", "b.ok", "c.d.ok"]);
  const many = Array.from({ length: 40000 }, (_, i) => `k${i}: 'v${i}'`).join(",\n");
  const late = code.parse(`export default {\n${many},\n...base };`, "late.ts", "en");
  assert.equal(late.entries.get("k39999").reason, "catalog-value-dynamic");
  assert.equal(late.skipped.count, 40001);
  for (const ext of ["tsx", "jsx", "js"]) {
    const j = code.parse("export default {\n  rich: <p className=\"x\">Don't {user.name} <b>stop</b></p>,\n  frag: <>It's</>,\n  ok: 'Plain',\n};", `f.${ext}`, "en");
    assert.deepEqual([j.entries.get("rich").reason, j.entries.get("frag").reason, j.entries.get("ok").values[0]], ["catalog-value-dynamic", "catalog-value-dynamic", "Plain"], ext);
  }
  // In .ts, `<string>x` is a type assertion, not JSX.
  assert.equal(code.parse("export default { a: <string>x, ok: 'Plain' };", "f.ts", "en").entries.get("ok").values[0], "Plain");
});


test("review fixes 2: computed keys, lexer edge cases, collisions and open keys across files", () => {
  const read = (text, file = "f.ts") => { const r = code.parse(text, file, "en"); return Object.fromEntries([...r.entries].map(([k, e]) => [k, e.reason || e.values[0]])); };
  // A computed key may replace any key written before it; keys after it are known.
  assert.deepEqual(read("export default { a: 'A', [k]: 'x', b: 'B' };"), { a: "catalog-value-dynamic", b: "B" });
  // Lexer: ASI, division that looks like a regex, escaped identifiers, a long BigInt, an empty ${}, JSX comments and TSX generics.
  assert.deepEqual(read("const a = { x: 'X' }\nconst c = 'z'\nexport default { b: a, y: 'Y' }"), { "b.x": "X", y: "Y" });
  assert.deepEqual(read("const r = a / b / c;\nexport default { x: 'X' };", "f.js"), { x: "X" });
  assert.deepEqual(read("const \\u0061b = { x: 'X' };\nexport default ab;"), { x: "X" });
  assert.deepEqual(read(`export default { n: 1${"0".repeat(80)}n, x: 'X' };`), { n: "catalog-value-dynamic", x: "X" });
  assert.deepEqual(read("export default { t: `a${}b`, x: 'X' };"), { t: "catalog-value-dynamic", x: "X" });
  assert.deepEqual(read("export default { r: <p>{/* hi */}{<b>x</b>}</p>, x: 'X' };", "f.jsx"), { r: "catalog-value-dynamic", x: "X" });
  assert.deepEqual(read("const f = <T,>(x: T) => x;\nexport default { x: 'X' };", "f.tsx"), { x: "X" });
  // A flat key that a nested one also spells is invalid, with its position.
  assert.throws(() => code.parse("export default { 'a.b': 'one', a: { b: 'two' } };", "f.ts", "en"), (e) => e.code === "invalid-catalog" && /^f\.ts:1:\d+: the key a\.b is defined twice/.test(e.message));
  // A later file's spread makes the earlier file's keys under it unknown; a target key under a spread is not reported missing.
  const dir = tmp();
  const base = write(dir, "base.ts", "export default { a: { x: 'X' }, b: 'B' };");
  const over = write(dir, "over.ts", "export default { a: { ...more }, c: 'C' };");
  const cat = catalog.loadAll([base, over], "en");
  assert.deepEqual(texts(cat), { "a.x": { reason: "catalog-value-dynamic" }, b: "B", c: "C" });
  assert.ok(catalog.isOpen(cat, "a.y") && catalog.isOpen(cat, "a[0]") && !catalog.isOpen(cat, "b") && !catalog.isOpen(cat, "ab"));
  const en = write(dir, "en.ts", "export default { q: 'Question here', b: 'Button' };");
  const pairs = (deText) => {
    const de = write(dir, "de.ts", deText);
    return untranslated.build(parse(["untranslated", "shot.png", "--locale", "de", "--base", en, "--catalog", de])).field.pairs.map((p) => [p.key, p.expected]);
  };
  assert.deepEqual(pairs("export default { b: 'Knopf' };"), [["q", null], ["b", "Knopf"]]);
  assert.deepEqual(pairs("export default { ...shared, b: 'Knopf' };"), [["b", "Knopf"]]);
  // The byte budget counts keys and values, so one object reused by reference cannot expand past it.
  const big = `const s = { v: '${"x".repeat(1 << 20)}' };\nexport default { ${Array.from({ length: 40 }, (_, i) => `a${i}: s`).join(", ")} };`;
  usage(() => code.parse(big, "big.ts", "en"), "catalog-too-large", /expands to over 32 MB/);
});

test("plain literals only (D27): any use of a catalog object beyond its declaration and export leaves the file unread", () => {
  const read = (text, file = "f.ts") => Object.fromEntries([...code.parse(text, file, "en").entries].map(([k, e]) => [k, e.reason || e.values[0]]));
  const unread = (text, file = "f.ts") => code.parse(text, file, "en").unread;
  for (const change of [
    "export const messages = { title: 'Old' };\nmessages.title = 'New';",
    "const m = { a: 'A' };\nif (cond) { m.a = 'Z'; }\nexport default m;",
    "const m = { a: 'A' };\nfunction f() { m.a = 'Z' }\nexport default m;",
    "const m = { a: 'A' };\nkeys.forEach((k) => { m[k] = 'Z'; });\nexport default m;",
    "const m = { a: 'A' };\nconst n = m;\nexport default n;",
    "const m = { s: { a: 'A' } };\nconst s = m.s;\nexport default m;",
    "const m = { a: 'A' };\ndelete m.a;\nexport default m;",
    "const m = { a: 'A' };\nm.a += '!';\nexport default m;",
    "const m = { a: 'A' };\nObject.assign(m, more);\nexport default m;",
    "const m = { a: 'A' };\nlog(m.a);\nexport default m;",
    "const m = { a: 'A' };\nexport default { t: `x ${f(m)}` };",
    "const a = b; const b = a; export default { x: a };",
  ]) assert.ok(unread(change) && Object.keys(read(change)).length === 0, change);
  assert.deepEqual(unread("module.exports = { a: 'A' };\nmodule.exports.b = 'B';", "f.cjs"), { name: "module", line: 2, col: 1 });
  // Uses that cannot change the object: a typeof type, an export list, a literal that reuses it, a read in a literal.
  assert.deepEqual(read("export const en = { title: 'Hi' } as const;\nexport type Messages = typeof en;\nexport const de: typeof en = { title: 'Hallo' };"), { title: "Hi" });
  assert.deepEqual(read("const en = { a: 'A' };\nexport type K = keyof typeof en;\nexport { en as default };"), { a: "A" });
  assert.deepEqual(read("const common = { ok: 'OK' };\nexport default { common, home: { c: common } };"), { "common.ok": "OK", "home.c.ok": "OK" });
  assert.deepEqual(read("const APP = 'Game';\nconst KEY = 'k';\nconst en = { a: 'A' };\nexport default { t: `Play ${APP}`, x: en.a, [KEY]: 'v', b: 'B' };"), { t: "catalog-value-dynamic", x: "catalog-value-dynamic", b: "B" });
  // The warning names the file, the line and the fix; every key under it is skipped, none reported missing.
  const dir = tmp();
  const f = write(dir, "en.ts", "const en = { title: 'Settings' };\nen.title = 'Other';\nexport default en;");
  const cat = catalog.loadAll([f], "en");
  assert.equal(cat.keys.size, 0);
  assert.ok(catalog.isOpen(cat, "title"));
  assert.ok(cat.warnings.some((w) => w.code === "catalog-values-skipped" && w.message.includes(`${f}:2:1: code uses en`) && /plain literals/.test(w.hint)));
  const deep = `export default { r: ${"{<b>".repeat(5000)}x${"</b>}".repeat(5000)}, x: 'X' };`;
  assert.throws(() => code.parse(deep, "f.jsx", "en"), (e) => e.code === "invalid-catalog" && /JSX nested deeper than 64 levels/.test(e.message));
});

test("plain-literal fixtures (D27): next-intl, react-i18next and typesafe-i18n typeof shapes and a shared section are read; each rejected shape is unread", () => {
  const dir = fx("code/literal");
  const read = (f) => Object.fromEntries([...catalog.loadAll([path.join(dir, f)], "en").keys].map(([k, e]) => [k, e.reason || e.text]));
  assert.deepEqual(read("allowed/next-intl.ts"), { "Home.title": "Welcome home", "Home.cta": "Start playing" });
  assert.deepEqual(read("allowed/react-i18next.ts"), { "translation.title": "Welcome home", "translation.cta": "Start playing" });
  assert.deepEqual(read("allowed/typesafe-i18n.ts"), { title: "Welcome home", cta: "Start playing" });
  assert.deepEqual(read("allowed/shared-section.ts"), {
    title: "catalog-value-dynamic", "dialog.buttons.ok": "Got it", "dialog.buttons.cancel": "Not now", "dialog.body": "Save your progress?",
    "settings.buttons.ok": "Got it", "settings.buttons.cancel": "Not now", "settings.header": "Settings",
  });
  assert.deepEqual(read("allowed/i18next-resources.ts"), { "en.translation.title": "Welcome home" });
  assert.deepEqual(read("allowed/spread-base.ts"), { header: "catalog-value-dynamic", "dialog.body": "Save your progress?" });
  const rejected = fs.readdirSync(path.join(dir, "rejected")).sort();
  assert.equal(rejected.length, 12);
  for (const f of rejected) {
    const cat = catalog.loadAll([path.join(dir, "rejected", f)], "en");
    assert.equal(cat.keys.size, 0, f);
    assert.ok(catalog.isOpen(cat, "title"), f);
    assert.ok(cat.warnings.some((w) => w.code === "catalog-values-skipped" && /:4:\d+: code uses (en|module)/.test(w.message)), f);
  }
});
