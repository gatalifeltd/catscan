// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-055 T1: the known-finding key, matching, the known file and `catscan results known`. No binary needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const known = require("../src/known");
const results = require("../src/results");
const scale = require("../src/scale");
const RESULT_SCHEMA = require("../../../core/schema/result.schema.json");

const ROOT = path.resolve(__dirname, "../../..");
const BIN = path.join(ROOT, "bin/catscan.js");
const HOST = { chip: "Apple M1", arch: "arm64", host_class: "physical", macos: "15.6 (24G84)", vision_revision: 3 };
const env = (command, p, locale, screen, findings, extra = {}) => scale.annotate({
  schema: 1, catscan: "0.50.1", command, path: p, verdict: "pass", engine: "vision-accurate-rev3", locale,
  image: { width: 10, height: 20 }, screen, host: HOST, ms: 5, checks: [], findings, warnings: [], device: null, platform: null, ...extra,
});
const trunc = (line, extra = {}) => ({ kind: "truncated", box: [0.1, 0.1, 0.2, 0.05], line, reason: "ellipsis", element: null, expected: null, confidence: 0.9, ...extra });
const side = (text, extra = {}) => ({ text, box: [0, 0, 0.1, 0.1], confidence: 0.9, ...extra });
const overlapF = (a, b) => ({ kind: "overlap", signal: "boxes", box: [0, 0, 0.2, 0.2], line: a.text, a, b, overlap: 0.4 });
const fileOf = (envs, argv = ["truncated", "shots"], extra = {}) => results.build({ results: envs, coverage: null, argv, started: new Date(0), finished: new Date(0), build: null, host: HOST, ci: null, ...extra });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "catscan-known-"));
const cli = (argv, cwd) => spawnSync(process.execPath, [BIN, ...argv], { cwd, encoding: "utf8" });
const keyText = (f, e = env("truncated", "s/de/home.png", "de", "home", [f])) => known.keyOf(e, f).text;

// ---- key -------------------------------------------------------------------------------------------------------

test("key: every schema finding kind is decided, and missing alone is not approvable", () => {
  // Value: protects=D4 approvable list; fails_when=a new finding kind ships without a decision; why_new=new; seam=result.schema.json enum; no_claim=none
  const kinds = RESULT_SCHEMA.definitions.finding.properties.kind.enum;
  const DECIDED = ["truncated", "overlap", "occluded", "untranslated", "raw-key", "placeholder", "missing", "hardcoded", "pseudo-not-applied", "wrong-language", "format", "currency", "price", "uncatalogued", "fit", "low-contrast", "busy-background"];
  assert.deepEqual([...kinds].sort(), [...DECIDED].sort(), "a new finding kind needs an approvable decision in known.js (TODO-055 D4)");
  assert.deepEqual(kinds.filter((k) => !known.approvable({ kind: k })), ["missing"]);
});

test("key: identity text field per kind, overlap sides sorted, rule from the registry", () => {
  // Value: protects=spec Key and D24; fails_when=a kind keys on the wrong field or rule; why_new=new; seam=scale.ruleOf; no_claim=none
  const e = (f) => known.keyOf(env("untranslated", "s/de/home.png", "de", "home", [f]), f);
  // TODO-073: a fit line keys on its line and reason; a textless control on its element id.
  assert.deepEqual([e({ kind: "fit", box: null, line: "Einstellungen", reason: "cutout" }).text, e({ kind: "fit", box: null, line: "Einstellungen", reason: "cutout" }).rule], ["einstellungen", "cutout"]);
  assert.equal(e({ kind: "fit", box: null, line: null, reason: "corner", element: { id: "close-button", box: [0, 0, 1, 1] } }).text, "close button");
  // Two id-less icons in one cell are two identities, by place on a 5% grid (a few pixels of drift keep it).
  const icon = (b) => e({ kind: "fit", box: b, line: null, reason: "corner", element: { id: null, box: b } }).text;
  assert.equal(icon([0, 0, 0.1, 0.05]), "@5,5");
  assert.equal(icon([0.001, 0.002, 0.1, 0.05]), "@5,5");
  assert.notEqual(icon([0.9, 0, 0.1, 0.05]), icon([0, 0, 0.1, 0.05]));
  assert.equal(e({ kind: "placeholder", box: null, line: "Hi {name}", token: "{name}" }).text, "hi name");
  assert.equal(e({ kind: "price", box: null, field: "amount", token: "4,99", expected: "5,99", product: "gems" }).text, "# #");
  assert.equal(e({ kind: "price", box: null, field: "amount", token: "4,99", expected: "5,99", product: "gems" }).rule, "amount");
  assert.equal(e({ kind: "pseudo-not-applied", box: null, traits: 0.1, lines: 4 }).text, null);
  assert.equal(e({ kind: "pseudo-not-applied", box: null, traits: 0.1, lines: 4 }).rule, null);
  assert.equal(e({ kind: "wrong-language", box: null, line: "Buy", language: "en", expected_language: "de", evidence: "langid", confidence: 0.9 }).rule, "langid");
  assert.equal(e({ kind: "format", box: null, line: "1.5", rule: "number", token: "1.5", expected: "1,5" }).rule, "number");
  const ab = overlapF(side("Zurück"), side("Weiter"));
  const ba = overlapF(side("Weiter"), side("Zurück"));
  assert.equal(e(ab).text, "weiter | zuruck");
  assert.equal(e(ab).text, e(ba).text);
  assert.equal(e(ab).rule, "boxes");
  const el = overlapF(side("Buy", { element: { id: "btn_buy", box: [0, 0, 1, 1] } }), side(null, { confidence: null, element: { id: null, box: [0, 0, 1, 1] } }));
  assert.equal(e({ ...el, signal: "elements" }).text, " | btn buy");
  // "|" inside a side never makes two side pairs join alike.
  assert.notEqual(e(overlapF(side("a | b"), side("c"))).text, e(overlapF(side("a"), side("b | c"))).text);
  const stacked = { kind: "overlap", signal: "stacked", box: null, line: "Kopf", a: side("Kopf"), b: null, overlap: null, stacked_evidence: ["correction-dropped"], corrected: null };
  assert.equal(e(stacked).text, "kopf");
});

test("key: normalization folds case, punctuation, width, times, digits and Latin marks, and keeps kana voicing and Thai marks", () => {
  // Value: protects=key_algo 1 rule; fails_when=a reread jitter makes a known finding new, or distinct scripts collide; why_new=new; seam=none; no_claim=reader jitter rates
  const n = known.normalize;
  assert.equal(n("JETZT  Kaufen!"), "jetzt kaufen");
  assert.equal(n("Straße"), "strasse");
  assert.equal(n("ＡＢＣ１２"), "abc#"); // NFKC width
  assert.equal(n("9:41 Level 12"), "# level #");
  assert.equal(n("12:05:33"), "#");
  assert.equal(n("Café crème"), "cafe creme");
  assert.equal(n("Ёлка"), "елка");
  assert.notEqual(n("ガ"), n("カ")); // kana voicing kept
  assert.notEqual(n("ไม้"), n("ไม")); // Thai tone mark kept
  assert.notEqual(n("ılık"), n("ilik")); // Turkish dotless i is not folded into i
  assert.equal(n(null), null);
});

test("key: the cell is device, locale and screen from the layout, else the path; pseudo separates; box, confidence and severity never count", () => {
  // Value: protects=D2, D25 key fields; fails_when=a box move makes a known finding new, or two devices share a key; why_new=new; seam=TODO-075 device; no_claim=none
  const f = trunc("Weiter");
  const mapped = known.keyOf(env("truncated", "s/DE/home.png", "DE", "home", [f]), f);
  assert.deepEqual(mapped, { command: "truncated", pseudo: false, device: null, text_size: null, locale: "de", screen: "home", path: null, kind: "truncated", rule: "ellipsis", text: "weiter" });
  const unmapped = known.keyOf(env("truncated", "x.png", "de", null, [f]), f);
  assert.equal(unmapped.path, "x.png");
  assert.equal(unmapped.screen, null);
  const moved = { ...f, box: [0.5, 0.5, 0.1, 0.1], confidence: 0.3, severity: "minor", certainty: "low", precision: 0.1, gate: false };
  assert.equal(known.rowKey(known.keyOf(env("truncated", "s/de/home.png", "de", "home", [moved]), moved)), known.rowKey(mapped));
  const pseudo = known.keyOf(env("truncated", "s/de/home.png", "de", "home", [f], { pseudo: true }), f);
  assert.notEqual(known.rowKey(pseudo), known.rowKey(mapped));
  const phone = known.keyOf(env("truncated", "s/de/home.png", "de", "home", [f], { device: "iphone-15" }), f);
  assert.notEqual(known.rowKey(phone), known.rowKey(mapped));
  // TODO-076 D6, D13: `default` is the no-axis cell, so files approved before the axis still match; `large` is its own cell.
  const def = known.keyOf(env("truncated", "s/de/home.png", "de", "home", [f], { text_size: "default" }), f);
  assert.equal(known.rowKey(def), known.rowKey(mapped));
  const large = known.keyOf(env("truncated", "s/de/home.png", "de", "home", [f], { text_size: "large" }), f);
  assert.notEqual(known.rowKey(large), known.rowKey(mapped));
  // A row never says `default`: it could match nothing, so the schema refuses it (review fix).
  const row = { command: "truncated", pseudo: false, device: null, text_size: "default", locale: "de", screen: "home", path: null, kind: "truncated", rule: "ellipsis", text: "weiter", count: 1 };
  const kf = { known_schema: 1, key_algo: 1, catscan: "0.55.0", axes: ["text_size"], reader: null, scope: {}, findings: [row] };
  assert.ok(known.check(kf).some((e) => /text_size/.test(e.pointer)));
  assert.deepEqual(known.check({ ...kf, findings: [{ ...row, text_size: "large" }] }), []);
  assert.equal(keyText(trunc("Weiter", { reason: "edge" })), "weiter");
});

// ---- matching ----------------------------------------------------------------------------------------------------

const approved = (rows) => known.index({ findings: rows });
const row = (text, count, extra = {}) => ({ command: "truncated", pseudo: false, device: null, locale: "de", screen: "home", path: null, kind: "truncated", rule: "ellipsis", text, count, ...extra });

test("matching: equal and fewer are known, more makes every finding of the key new with both counts; gone per read group", () => {
  // Value: protects=D3, D9, D26 matching; fails_when=a surplus is hidden or an unread group reads as gone; why_new=new; seam=none; no_claim=none
  const idx = approved([row("weiter", 1), row("zuruck", 2), row("other", 1, { screen: "shop" })]);
  const e = env("truncated", "s/de/home.png", "de", "home", [trunc("Weiter"), trunc("Weiter!"), trunc("Zurück")]);
  const m = known.matchEnvelope(idx, e);
  assert.deepEqual([...m.values()], [
    { known: false, found: 2, approved: 1 }, { known: false, found: 2, approved: 1 }, { known: true, found: 1, approved: 2 },
  ]);
  const gone = known.goneRows(idx, [e]);
  assert.deepEqual(gone.map((r) => [r.text, r.count]), [["zuruck", 1]]); // shop was not read: not gone
  assert.equal(known.drift([row("weiter", 1)], gone).length, 1);
  assert.equal(known.drift([row("weiter", 1, { rule: "edge" })], gone).length, 0);
});

test("matching: missing, failed checks and unread inputs match nothing", () => {
  // Value: protects=D4 exit codes unchanged; fails_when=a missing cell or error input turns known; why_new=new; seam=scale.annotate; no_claim=none
  const idx = approved([row("weiter", 5)]);
  const err = env("truncated", "s/de/home.png", "de", "home", [trunc("Weiter")]);
  err.verdict = "error";
  assert.equal(known.matchEnvelope(idx, err).size, 0);
  const [miss] = results.coverage([], { locales: ["de"], screens: ["home"] }, "{locale}/{screen}", "truncated").missing;
  assert.equal(known.matchEnvelope(idx, miss).size, 0);
  assert.deepEqual(known.goneRows(idx, [err, miss]), []);
  const check = env("check", "s/de/home.png", "de", "home", [], { checks: [{ kind: "present", text: "Go", verdict: "fail", closest: null }] });
  assert.equal(known.matchEnvelope(idx, check).size, 0);
});

// ---- approve -----------------------------------------------------------------------------------------------------

test("approve: a new file is sorted, keyed and counted; re-approval of one group keeps the others; scope and reader recorded", () => {
  // Value: protects=D5 group update and the readable diff; fails_when=a shard approval drops another shard's rows; why_new=new; seam=none; no_claim=none
  const a = fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("Weiter"), trunc("Weiter")]), env("truncated", "s/fr/home.png", "fr", "home", [trunc("Suivant")])], ["truncated", "s", "--reasons", "ellipsis,edge", "--boxes", "b"]);
  const first = known.approve(null, [{ obj: a, name: "a.json" }]);
  assert.deepEqual(first.file.findings.map((r) => [r.locale, r.text, r.count]), [["de", "weiter", 2], ["fr", "suivant", 1]]);
  assert.deepEqual(first.file.scope, { truncated: { flags: ["--boxes", "--reasons ellipsis,edge"], allow: null } });
  assert.deepEqual(first.file.reader, { engine: "vision-accurate-rev3", vision_revision: 3, macos: "15" });
  assert.deepEqual(first.stats, { findings: 3, groups: 2, added: 3, removed: 0, unread: 0 });
  assert.deepEqual(known.check(first.file), []);
  // Shard b reads only de/home, now with one Weiter and a new line: fr keeps its row.
  const b = fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("Weiter"), trunc("Neu")])]);
  const second = known.approve(first.file, [{ obj: b, name: "b.json" }]);
  assert.deepEqual(second.file.findings.map((r) => [r.locale, r.text, r.count]), [["de", "neu", 1], ["de", "weiter", 1], ["fr", "suivant", 1]]);
  assert.deepEqual([second.stats.added, second.stats.removed], [1, 1]);
});

test("approve: --prune lowers and removes, never adds; an unread input keeps its rows; below-threshold findings are recorded", () => {
  // Value: protects=D5, D9, D17 prune and incomplete runs; fails_when=prune approves a new finding or an error drops rows; why_new=new; seam=none; no_claim=none
  const base = { ...known.approve(null, [{ obj: fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("A"), trunc("A"), trunc("B")]), env("truncated", "s/fr/home.png", "fr", "home", [trunc("C")])]), name: "x" }]).file };
  const now = fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("A"), trunc("New")]), { ...env("truncated", "s/fr/home.png", "fr", "home", []), verdict: "error", error: { code: "x", message: "y" } }]);
  const pruned = known.approve(base, [{ obj: now, name: "n" }], { prune: true });
  assert.deepEqual(pruned.file.findings.map((r) => [r.locale, r.text, r.count]), [["de", "a", 1], ["fr", "c", 1]]);
  assert.equal(pruned.stats.unread, 1);
  const below = scale.annotate(env("truncated", "s/de/home.png", "de", "home", [trunc("Low")]), { min_severity: "critical", min_certainty: "high" });
  assert.equal(below.findings[0].gate, false);
  assert.equal(known.approve(null, [{ obj: fileOf([below]), name: "b" }]).file.findings.length, 1);
});

test("approve: output is byte-stable for shuffled inputs, one row per line; duplicate cells take the most one input found", () => {
  // Value: protects=sorted file, D26 duplicate cells; fails_when=input order changes the file or duplicates double the count; why_new=new; seam=none; no_claim=none
  const e1 = env("truncated", "s/de/home.png", "de", "home", [trunc("A"), trunc("B")]);
  const e2 = env("truncated", "s/fr/home.png", "fr", "home", [trunc("C")]);
  const dup = env("truncated", "t/de/home.png", "de", "home", [trunc("A")]);
  const x = known.serialize(known.approve(null, [{ obj: fileOf([e1, e2, dup]), name: "x" }]).file);
  const y = known.serialize(known.approve(null, [{ obj: fileOf([e2, dup, e1]), name: "y" }]).file);
  assert.equal(x, y);
  const parsed = JSON.parse(x);
  assert.equal(parsed.findings.find((r) => r.text === "a").count, 1);
  assert.match(x, /\n {4}\{"command":"truncated","pseudo":false,"device":null,"locale":"de","screen":"home","path":null,"kind":"truncated","rule":"ellipsis","text":"a","count":1\},\n/);
});

test("known file: validation catches order, repeats, missing rows and device without axes; newer algo is unsupported", () => {
  // Value: protects=results validate on a known file, D7; fails_when=a hand-edited file is accepted or a future file is misread; why_new=new; seam=known.schema.json; no_claim=none
  const f = known.approve(null, [{ obj: fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("A"), trunc("B")])]), name: "x" }]).file;
  assert.deepEqual(known.check(f), []);
  const swapped = { ...f, findings: [f.findings[1], f.findings[0]] };
  assert.match(known.check(swapped).map((e) => e.message).join(), /out of order/);
  assert.match(known.check({ ...f, findings: [f.findings[0], f.findings[0]] }).map((e) => e.message).join(), /repeats/);
  assert.match(known.check({ ...f, findings: [{ ...f.findings[0], kind: "missing" }] }).map((e) => e.message).join(), /cannot be approved/);
  assert.match(known.check({ ...f, findings: [{ ...f.findings[0], device: "ipad" }] }).map((e) => e.pointer).join(), /\/axes/);
  assert.ok(known.check({ ...f, findings: [{ ...f.findings[0], count: 0 }] }).length);
  assert.equal(known.unsupported(f), null);
  assert.match(known.unsupported({ ...f, key_algo: 2 }).message, /key_algo 2.*key_algo 1/);
});

// ---- CLI -----------------------------------------------------------------------------------------------------------

test("cli: results known writes, updates and validates; usage and write errors have their exit codes", () => {
  // Value: protects=results known exit 0, 2, 4 and the summary line; fails_when=a wrong flag writes a file or a write failure exits 0; why_new=new; seam=bin/catscan.js; no_claim=none
  const dir = tmp();
  const write = (n, o) => fs.writeFileSync(path.join(dir, n), JSON.stringify(o));
  write("r.json", fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("Weiter"), trunc("Weiter")])]));
  const r1 = cli(["results", "known", "r.json", "--out", "catscan-known.json"], dir);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.stdout, "approved 2 findings in 1 group (+2 -0 this run) -> catscan-known.json (new file); next: add --known catscan-known.json to the CI command and commit the file\n");
  const v = cli(["results", "validate", "catscan-known.json"], dir);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /valid known file \(known_schema 1, key_algo 1\)/);
  write("r2.json", fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("Weiter")])]));
  const r2 = cli(["results", "known", "r2.json", "--out", "catscan-known.json", "--prune"], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /^pruned to 1 finding in 1 group \(\+0 -1 this run\) -> catscan-known.json \(updated\)/);
  assert.equal(cli(["results", "known", "r.json"], dir).status, 2);
  assert.equal(cli(["results", "merge", "r.json", "--out", "m.json", "--prune"], dir).status, 2);
  assert.equal(cli(["results", "known", "r.json", "--out", "r.json"], dir).status, 2);
  assert.equal(cli(["results", "known", "catscan-known.json", "--out", "k2.json"], dir).status, 2);
  fs.writeFileSync(path.join(dir, "bad.json"), "{");
  const bad = cli(["results", "known", "r.json", "--out", "bad.json"], dir);
  assert.equal(bad.status, 4);
  assert.match(bad.stderr, /known-invalid: bad.json is not JSON.*try: fix or recreate the committed known file; check it with catscan results validate bad.json/);
  write("future.json", { ...JSON.parse(fs.readFileSync(path.join(dir, "catscan-known.json"), "utf8")), known_schema: 2 });
  const fut = cli(["results", "known", "r.json", "--out", "future.json"], dir);
  assert.equal(fut.status, 2);
  assert.match(fut.stderr, /known-algo-unsupported/);
  const nodir = cli(["results", "known", "r.json", "--out", "no/such/dir/k.json"], dir);
  assert.equal(nodir.status, 4);
  assert.match(nodir.stderr, /known-write-failed: cannot write the known file no\/such\/dir\/k.json/);
});

// ---- review fixes (D30, D31) -------------------------------------------------------------------------------------

const SHA = (c) => `sha256:${c.repeat(64)}`;

test("scope: --opt=value and bare flags read as the parser reads them; the allow digest comes from the run record, never a path", () => {
  // Value: protects=D15 scope and D30; fails_when=--reasons=x records no scope, a bare flag eats the next token, or approval opens the --allow path; why_new=only separate-token flags were tested; seam=none; no_claim=none
  assert.deepEqual(known.scopeFlags(["--json", "truncated", "s", "--reasons=edge", "--boxes=b.json", "--experimental", "x", "--pseudo", "--allow", "gone.txt"]), ["--allow", "--boxes", "--experimental", "--pseudo", "--reasons edge"]);
  assert.equal(known.commandOf(["--format", "json", "overlap", "truncated"]), "overlap");
  const withAllow = fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("A")])], ["truncated", "s", "--allow", "/no/such/file"], { allow: SHA("a") });
  assert.equal(withAllow.run.allow, SHA("a"));
  assert.deepEqual(results.check(withAllow), []);
  assert.deepEqual(known.approve(null, [{ obj: withAllow, name: "a" }]).file.scope, { truncated: { flags: ["--allow"], allow: SHA("a") } });
  assert.equal(fileOf([]).run.allow, undefined, "absent without --allow");
});

test("scope: fit runs record their scope, profile and orientation included (TODO-073 D36)", () => {
  // Value: protects=known-scope-differs for fit (RUN_COMMANDS, SCOPE_VALUE); fails_when=a fit run records no scope or --device-profile/--orientation are not part of it; why_new=red-team finding; seam=none; no_claim=none
  assert.equal(known.commandOf(["fit", "s", "--experimental"]), "fit");
  assert.deepEqual(known.scopeFlags(["fit", "s", "--reasons", "corner", "--device-profile", "iphone-17-pro", "--orientation", "landscape-left", "--experimental"]),
    ["--device-profile iphone-17-pro", "--experimental", "--orientation landscape-left", "--reasons corner"]);
  const a = fileOf([env("fit", "s/de/home.png", "de", "home", [])], ["fit", "s", "--reasons", "corner"]);
  const b = fileOf([env("fit", "s/de/home.png", "de", "home", [])], ["fit", "s", "--experimental"]);
  const m = known.approve(null, [{ obj: a, name: "a" }]);
  assert.deepEqual(m.file.scope.fit.flags, ["--reasons corner"]);
  assert.match(known.approve(m.file, [{ obj: b, name: "b" }]).warnings.map((w) => w.message).join("\n"), /fit was approved with --reasons corner, these results with --experimental/);
});

test("scope: a merged file takes each shard's flags; differing shards warn once; re-approval under other flags warns", () => {
  // Value: protects=D5, D31 scope for merged CI files and its warnings; fails_when=a merged file records no scope, or one warning per input floods stderr; why_new=fileOf never had shards; seam=none; no_claim=none
  const a = fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("A")]), env("truncated", "s/fr/home.png", "fr", "home", [])], ["truncated", "s", "--reasons", "edge"]);
  const b = fileOf([env("truncated", "s/it/home.png", "it", "home", []), env("truncated", "s/es/home.png", "es", "home", [])], ["truncated", "s"]);
  const merged = results.merge([a, b], { exp: null, layout: null, argv: ["results", "merge"] }).file;
  const m = known.approve(null, [{ obj: merged, name: "m" }]);
  assert.deepEqual(m.file.scope.truncated.flags, ["--reasons edge"]);
  assert.equal(m.warnings.filter((w) => w.code === "known-scope-differs").length, 1);
  const again = known.approve(m.file, [{ obj: b, name: "b" }]);
  assert.match(again.warnings.map((w) => w.message).join("\n"), /truncated was approved with --reasons edge, these results with no filter flags/);
  assert.equal(known.approve(m.file, [{ obj: b, name: "b" }], { prune: true }).warnings.length, 0);
});

test("reader: mixed readers give null; a full re-approval on one reader clears it; prune keeps reader and scope; device sets axes", () => {
  // Value: protects=spec reader rule, D31 reset, prune touching counts only, TODO-075 axis; fails_when=mixed records the first reader, null sticks, prune rewrites metadata, or a device approval fails validation; why_new=only one reader was tested; seam=none; no_claim=none
  const mac14 = { ...HOST, macos: "14.7 (23H124)" };
  const mixed = known.approve(null, [{ obj: fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("A")]), env("truncated", "s/fr/home.png", "fr", "home", [trunc("B")], { host: mac14 })]), name: "x" }]).file;
  assert.equal(mixed.reader, null);
  const full = known.approve(mixed, [{ obj: fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("A")]), env("truncated", "s/fr/home.png", "fr", "home", [trunc("B")])]), name: "y" }]).file;
  assert.deepEqual(full.reader, { engine: "vision-accurate-rev3", vision_revision: 3, macos: "15" });
  const part = known.approve(full, [{ obj: fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("A")], { host: mac14 })], ["truncated", "s", "--boxes", "b"]), name: "z" }]).file;
  assert.equal(part.reader, null);
  const pruned = known.approve(full, [{ obj: fileOf([env("truncated", "s/de/home.png", "de", "home", [], { host: mac14 }), env("truncated", "s/fr/home.png", "fr", "home", [])], ["truncated", "s", "--boxes", "b"]), name: "p" }], { prune: true }).file;
  assert.deepEqual([pruned.reader, pruned.scope, pruned.findings], [full.reader, full.scope, []]);
  assert.deepEqual(known.check(JSON.parse(known.serialize(pruned))), []);
  const dev = known.approve(null, [{ obj: fileOf([env("truncated", "s/iphone/de/home.png", "de", "home", [trunc("A")], { device: "iphone-15" })]), name: "d" }]).file;
  assert.deepEqual(dev.axes, ["device"]);
  assert.deepEqual(known.check(dev), []);
});

test("rows sort by code point, not UTF-16 units", () => {
  // Value: protects=the documented row order; fails_when=astral characters sort by surrogate units and other readers reject the file; why_new=only ASCII rows were sorted; seam=none; no_claim=none
  assert.ok(known.byCodePoint("\u{1F600}", "！") > 0);
  assert.ok(known.byCodePoint("a", "ab") < 0);
  const f = known.approve(null, [{ obj: fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("ａ"), trunc("\u{1D41A}x")])]), name: "x" }]).file;
  assert.deepEqual(known.check(f), []);
});

test("cli: validate reports invalid known files with exit 1 and --json, a newer one with exit 2; --out of another kind is exit 4; --prune needs a file", () => {
  // Value: protects=D7 exit codes for committed known files and the --prune guard; fails_when=a hand-edited file validates, a results file is overwritten as a known file, or --prune writes an empty file; why_new=only valid, not-JSON and newer cases ran; seam=bin/catscan.js; no_claim=none
  const dir = tmp();
  const write = (n, o) => fs.writeFileSync(path.join(dir, n), typeof o === "string" ? o : JSON.stringify(o));
  const r = fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("A"), trunc("B")]), { ...env("truncated", "s/fr/home.png", "fr", "home", []), verdict: "error", error: { code: "x", message: "y" } }]);
  write("r.json", r);
  const ok = cli(["results", "known", "r.json", "--out", "k.json"], dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /\(\+2 -0 this run; 1 input not read kept its rows\)/);
  const k = JSON.parse(fs.readFileSync(path.join(dir, "k.json"), "utf8"));
  write("swapped.json", { ...k, findings: [k.findings[1], k.findings[0]] });
  const v = cli(["results", "validate", "swapped.json"], dir);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /known-invalid: swapped.json#\/findings\/1: is out of order/);
  const vj = cli(["results", "validate", "swapped.json", "--json"], dir);
  assert.equal(JSON.parse(vj.stdout).valid, false);
  write("zero.json", { ...k, findings: [{ ...k.findings[0], count: 0 }] });
  assert.match(cli(["results", "validate", "zero.json"], dir).stderr, /#\/findings\/0\/count: must be >= 1/);
  write("newer.json", { ...k, key_algo: 2 });
  const nj = cli(["results", "validate", "newer.json", "--json"], dir);
  assert.equal(nj.status, 2);
  assert.equal(JSON.parse(nj.stdout).valid, false);
  const notKnown = cli(["results", "known", "r.json", "--out", "r2.json"], dir);
  assert.equal(notKnown.status, 0);
  write("res.json", r);
  const other = cli(["results", "known", "r.json", "--out", "res.json"], dir);
  assert.equal(other.status, 4);
  assert.match(other.stderr, /known-invalid: res.json is not a known file/);
  const prune = cli(["results", "known", "r.json", "--out", "none.json", "--prune"], dir);
  assert.equal(prune.status, 2);
  assert.ok(!fs.existsSync(path.join(dir, "none.json")));
});

test("package: the known schema ships with the results schemas", () => {
  // Value: protects=results validate on a known file in an installed package; fails_when=copy-schemas leaves known.schema.json out (the repo fallback hides it); why_new=new; seam=none; no_claim=the npm pack run itself (scripts/pack-smoke.mjs)
  assert.match(fs.readFileSync(path.join(ROOT, "scripts/copy-schemas.mjs"), "utf8"), /"known\.schema\.json"/);
});

test("merge: a shard record with and without its allow digest is still the same shard", () => {
  // Value: protects=results-duplicate-shard after D30; fails_when=a shard rewritten by an older catscan (no allow) and its new record both merge and count twice; why_new=allow is a new record field; seam=none; no_claim=none
  const a = fileOf([env("truncated", "s/de/home.png", "de", "home", [trunc("A")])], ["truncated", "s", "--allow", "a.txt"], { allow: SHA("a") });
  const old = JSON.parse(JSON.stringify(results.merge([a], { exp: null, layout: null, argv: ["results", "merge"] }).file));
  delete old.run.shards[0].allow;
  assert.throws(() => results.merge([a, old], { exp: null, layout: null, argv: ["results", "merge"] }), /results-duplicate-shard|same shard/);
});

// ---- applying a known file (--known, T2) -----------------------------------------------------------------------

const ctxOf = (envs, file = "catscan-known.json") => {
  const obj = known.approve(null, [{ obj: fileOf(envs), name: "r.json" }]).file;
  return known.context(obj, file, known.serialize(obj));
};
const applied = (ctx, e, th = scale.DEFAULTS) => scale.annotate(e, th, known.match(ctx, e));
const home = (findings, extra) => env("truncated", "s/de/home.png", "de", "home", findings, extra);

test("apply: equal counts are known and pass, more found than approved makes every finding of the key new, fewer is gone", () => {
  // Value: protects=D6, D8, D9, D26 (per-input matching, counts, gone); fails_when=an extra finding hides behind an approved one, or gone is miscounted; why_new=new; seam=known.match + scale.annotate; no_claim=the CLI wiring (merge test below)
  const ctx = ctxOf([home([trunc("Weiter"), trunc("Weiter")])]);
  const eq = applied(ctx, home([trunc("Weiter"), trunc("Weiter")]));
  assert.deepEqual([eq.verdict, eq.findings.map((f) => [f.known, f.gate])], ["pass", [[true, false], [true, false]]]);
  const over = applied(ctx, home([trunc("Weiter"), trunc("Weiter"), trunc("Weiter")]));
  assert.equal(over.verdict, "fail");
  assert.ok(over.findings.every((f) => f.known === false && f.gate === true && f.known_counts.found === 3 && f.known_counts.approved === 2));
  const under = applied(ctx, home([trunc("Weiter")]));
  assert.equal(under.verdict, "pass");
  const b = known.block(ctx, [under]);
  assert.deepEqual(b.known.counts, { known: 1, new: 0, gone: 1 });
  assert.equal(b.known.digest, ctx.digest);
  // Another cell is another key; a missing file (fail closed) makes every finding new.
  assert.equal(applied(ctx, env("truncated", "s/fr/home.png", "fr", "home", [trunc("Weiter")])).verdict, "fail");
  const none = applied(known.context(null, "x.json", ""), home([trunc("Weiter")]));
  assert.deepEqual([none.verdict, none.findings[0].known, none.findings[0].known_counts], ["fail", false, { found: 1, approved: 0 }]);
});

test("apply: a failed check still fails, a below-threshold known finding stays gate false, drift pairs a new and a gone row", () => {
  // Value: protects=D4, D6, D28 and known-drift; fails_when=known hides a failed check, or a re-read string is not flagged as drift; why_new=new; seam=scale.annotate + known.block; no_claim=none
  const ctx = ctxOf([home([trunc("Weiter")])]);
  const withCheck = applied(ctx, home([trunc("Weiter")], { checks: [{ kind: "present", text: "Go", verdict: "fail", closest: null }] }));
  assert.deepEqual([withCheck.verdict, withCheck.findings[0].known], ["fail", true]);
  const strict = applied(ctx, home([trunc("Weiter")]), { min_severity: "critical", min_certainty: "high" });
  assert.deepEqual([strict.findings[0].known, strict.findings[0].gate, strict.verdict], [true, false, "pass"]);
  const reread = applied(ctx, home([trunc("Welter")]));
  const b = known.block(ctx, [reread]);
  assert.deepEqual([b.known.counts, b.drift.length, b.drift[0].text], [{ known: 0, new: 1, gone: 1 }, 1, "welter"]);
  // regate (threshold flags on merge) keeps a known finding at gate false.
  const k = applied(ctx, home([trunc("Weiter")]));
  scale.regate(k, scale.DEFAULTS);
  assert.deepEqual([k.findings[0].gate, k.verdict], [false, "pass"]);
});

test("apply: reapply turns a stored finding known or back to gating, keeping other gates", () => {
  // Value: protects=D10, D28 (merge and report recompute known per shard); fails_when=a finding that left the file stays non-gating, or reapply re-bands a below-threshold finding; why_new=new; seam=known.reapply; no_claim=none
  const ctx = ctxOf([home([trunc("Weiter")])]);
  const e = home([trunc("Weiter"), trunc("Neu")]);
  known.reapply(ctx, e, scale.DEFAULTS);
  assert.deepEqual([e.verdict, e.findings.map((f) => f.known)], ["fail", [true, false]]);
  const empty = known.context({ ...ctx.obj, findings: [] }, "k.json", "{}");
  known.reapply(empty, e, scale.DEFAULTS);
  assert.deepEqual([e.verdict, e.findings.map((f) => [f.known, f.gate])], ["fail", [[false, true], [false, true]]]);
});

test("apply: run warnings name a changed scope, --allow digest, device axis and reader, once each", () => {
  // Value: protects=D15, D20, D25; fails_when=a run under other filters or another reader matches silently; why_new=new; seam=known.runWarnings; no_claim=none
  const ctx = ctxOf([home([trunc("Weiter")])]);
  const reader = known.runReader([home([])]);
  const same = known.runWarnings(ctx, { command: "truncated", argv: ["truncated", "shots"], allow: null, axes: [], reader });
  assert.deepEqual(same, []);
  const codes = (w) => w.map((x) => x.code);
  assert.deepEqual(codes(known.runWarnings(ctx, { command: "truncated", argv: ["truncated", "shots", "--reasons=ellipsis"], allow: null, axes: [], reader })), ["known-scope-differs"]);
  assert.deepEqual(codes(known.runWarnings(ctx, { command: "truncated", argv: ["truncated", "shots"], allow: "sha256:" + "a".repeat(64), axes: [], reader })), ["known-scope-differs"]);
  assert.deepEqual(codes(known.runWarnings(ctx, { command: "truncated", argv: ["truncated", "shots"], allow: null, axes: ["device"], reader })), ["known-scope-differs"]);
  assert.deepEqual(codes(known.runWarnings(ctx, { command: "truncated", argv: ["truncated", "shots"], allow: null, axes: [], reader: { ...reader, macos: "99" } })), ["known-reader-changed"]);
  assert.deepEqual(known.runWarnings(known.context(null, "x", ""), { command: "truncated", argv: [], allow: null, axes: [], reader }), []);
});

test("apply: one known-scope-differs per differing axis, device and text size; runAxes; hints name --results (TODO-084)", () => {
  // Value: protects=TODO-084 D1, D4, D7; fails_when=a size-axis difference is silent, the axes are checked together, default alone counts as an axis, or a hint keeps the placeholder when --results is set; why_new=new axis; seam=known.runWarnings, known.runAxes; no_claim=CLI wiring (test/known.test.js)
  const reader = known.runReader([home([])]);
  const ctxWith = (axes) => { const c = ctxOf([home([trunc("Weiter")])]); return known.context({ ...c.obj, axes }, "k.json", "{}"); };
  const axisOf = (w) => w.filter((x) => x.code === "known-scope-differs").map((x) => x.message.match(/the (device|text size) axis/)[1]);
  const warn = (file, run, extra = {}) => known.runWarnings(ctxWith(file), { command: "truncated", argv: ["truncated", "shots"], allow: null, axes: run, reader, ...extra });
  assert.deepEqual(axisOf(warn(["text_size"], [])), ["text size"]);
  assert.deepEqual(axisOf(warn([], ["text_size"])), ["text size"]);
  assert.deepEqual(axisOf(warn(["text_size"], ["device"])), ["device", "text size"]);
  assert.deepEqual(axisOf(warn(["device", "text_size"], [])), ["device", "text size"]);
  assert.deepEqual(axisOf(warn(["device", "text_size"], ["device"])), ["text size"]);
  assert.deepEqual(warn(["device", "text_size"], ["device", "text_size"]), []);
  // No row of the run's command: no cell to mismatch, so no axis warning.
  assert.deepEqual(warn(["device", "text_size"], [], { command: "overlap", argv: ["overlap", "shots"] }), []);
  const [size] = warn(["text_size"], []);
  assert.equal(size.message, "k.json was approved with the text size axis, this run is without it; only default-size cells match across the two");
  assert.equal(size.hint, "approve from a run with the same --text-size or layout: catscan results known <results.json> --out k.json");
  assert.match(warn(["text_size"], [], { results: "out/r.json" })[0].hint, /: catscan results known out\/r\.json --out k\.json$/);
  assert.match(warn([], [], { argv: ["truncated", "shots", "--reasons=ellipsis"], results: "out/r.json" })[0].hint, /re-approve: catscan results known out\/r\.json --out k\.json$/);
  assert.match(warn([], [], { argv: ["truncated", "shots", "--reasons=ellipsis"] })[0].hint, /re-approve: catscan results known <results\.json> --out k\.json$/);
  assert.match(warn(["text_size"], [], { results: "out dir/it's.json" })[0].hint, /: catscan results known 'out dir\/it'\\''s\.json' --out k\.json$/);
  // runAxes: a device on any entry (missing ones too), a size only when it is not default.
  assert.deepEqual(known.runAxes([home([])]), []);
  assert.deepEqual(known.runAxes([home([]), { ...home([]), device: "iphone", findings: [{ kind: "missing" }] }]), ["device"]);
  assert.deepEqual(known.runAxes([home([], { text_size: "default" })]), []);
  assert.deepEqual(known.runAxes([home([], { text_size: "default" }), home([], { text_size: "large" })]), ["text_size"]);
  // A size whose shots are all missing or unreadable is no axis, as approve counts it.
  assert.deepEqual(known.runAxes([home([]), { ...home([]), path: null, text_size: "large", findings: [{ kind: "missing" }] }]), []);
  assert.deepEqual(known.runAxes([home([]), home([], { text_size: "large", verdict: "error" })]), []);
});

test("render and CI: known lines after the rest, new lines name their counts, totals and job summary carry the counts", () => {
  // Value: protects=spec "Text", D23; fails_when=a green run with legacy findings reads as clean, or a new finding hides its approved count; why_new=new; seam=render + ci; no_claim=report HTML (report.test.js golden)
  const render = require("../src/render");
  const ci = require("../src/ci");
  const ctx = ctxOf([home([trunc("Weiter")])]);
  const e = applied(ctx, home([trunc("Weiter"), trunc("Neu")]));
  const lines = render.renderText(e, { knownFile: "catscan-known.json" });
  assert.match(lines[1], /"Neu".*\(new, not in catscan-known\.json\)$/);
  assert.match(lines[2], /^ {2}known .*"Weiter"/);
  assert.equal(lines.length, 3);
  assert.ok(render.renderText(e, { quiet: true, knownFile: "k" }).every((l) => !/known /.test(l)));
  const kb = known.block(ctx, [e]).known;
  assert.match(render.totalsLine(["fail"], 1, "image", { known: kb }), /1 known, 1 new, 0 approved no longer found \(catscan-known\.json\)/);
  assert.match(ci.githubSummary([e], { command: "truncated", known: kb }), /1 known, 1 new/);
});

test("CLI: results merge --known recomputes known per shard; --known on read is a usage error; validate refuses known that gates", () => {
  // Value: protects=D10, D28, spec option list; fails_when=merge keeps stale known or a shard approved alone merges to other verdicts; why_new=new; seam=bin/catscan.js; no_claim=the finding commands on the binary (test/known.test.js)
  const dir = tmp();
  const fr = (findings) => env("truncated", "s/fr/home.png", "fr", "home", findings);
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(fileOf([home([trunc("Weiter")])], ["truncated", "s/de"])));
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify(fileOf([fr([trunc("Suite")])], ["truncated", "s/fr"])));
  assert.equal(cli(["results", "known", "a.json", "--out", "k.json"], dir).status, 0);
  const m = cli(["results", "merge", "a.json", "b.json", "--out", "m.json", "--known", "k.json"], dir);
  assert.equal(m.status, 1, m.stderr); // fr's finding is new
  const out = JSON.parse(fs.readFileSync(path.join(dir, "m.json"), "utf8"));
  assert.deepEqual(out.known.counts, { known: 1, new: 1, gone: 0 });
  assert.deepEqual(out.results.map((r) => [r.locale, r.verdict]).sort(), [["de", "pass"], ["fr", "fail"]]);
  assert.equal(out.known.file, "k.json");
  assert.equal(cli(["results", "validate", "m.json"], dir).status, 0);
  out.results.find((r) => r.locale === "de").findings[0].gate = true;
  fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify(out));
  assert.equal(cli(["results", "validate", "bad.json"], dir).status, 1);
  // Coverage extension (TODO-055 D28, knownErrors). Value: protects=merge without --known keeps stored known flags; validate checks known.counts; fails_when=a re-merge re-gates known findings, or a tampered counts block validates; why_new=only the --known merge and the gate check were tested; seam=bin/catscan.js; no_claim=merge of several shards without --known (single input)
  const re = cli(["results", "merge", "m.json", "--out", "m3.json"], dir);
  assert.equal(re.status, 1, re.stderr);
  const m3 = JSON.parse(fs.readFileSync(path.join(dir, "m3.json"), "utf8"));
  assert.deepEqual(m3.results.map((r) => [r.locale, r.verdict, r.findings[0].known]).sort(), [["de", "pass", true], ["fr", "fail", false]]);
  const tampered = JSON.parse(fs.readFileSync(path.join(dir, "m.json"), "utf8"));
  tampered.known.counts.known = 5;
  fs.writeFileSync(path.join(dir, "counts.json"), JSON.stringify(tampered));
  const tv = cli(["results", "validate", "counts.json"], dir);
  assert.equal(tv.status, 1);
  assert.match(tv.stdout + tv.stderr, /\/known\/counts\/known/);
  const read = cli(["read", "x.png", "--known", "k.json"], dir);
  assert.equal(read.status, 2);
  assert.match(read.stderr, /option-not-valid/);
  const val = cli(["results", "validate", "m.json", "--known", "k.json"], dir);
  assert.equal(val.status, 2);
  // Missing known file on merge: fail closed with the warning.
  const miss = cli(["results", "merge", "a.json", "--out", "m2.json", "--known", "nope.json"], dir);
  assert.match(miss.stderr, /known-missing/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "m2.json"), "utf8")).results[0].verdict, "fail");
});

test("CLI: a finding command reads --known before any Vision time: invalid JSON is exit 4, a newer known_schema exit 2", () => {
  // Value: protects=TODO-055 D7 (a broken committed known file stops the run up front with its own code); fails_when=loadKnown moves after the run or a bad file is treated as missing (fail open to new); why_new=only merge and MCP read a bad file; seam=CATSCAN_CORE_BINARY unset path; no_claim=the missing-file path on a real run (test/known.test.js)
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "shots"));
  fs.writeFileSync(path.join(dir, "shots", "a.png"), "");
  fs.writeFileSync(path.join(dir, "bad.json"), "{");
  fs.writeFileSync(path.join(dir, "new.json"), JSON.stringify({ known_schema: 99 }));
  const run = (f) => spawnSync(process.execPath, [BIN, "truncated", "shots", "--known", f], { cwd: dir, encoding: "utf8", env: { ...process.env, CATSCAN_CORE_BINARY: "/nonexistent/catscan-core" } });
  const bad = run("bad.json");
  assert.equal(bad.status, 4, bad.stderr);
  assert.match(bad.stderr, /^catscan: known-invalid: bad\.json is not JSON/m);
  assert.ok(!/catscan-core/.test(bad.stderr), "no Vision start before the known file is read");
  const newer = run("new.json");
  assert.equal(newer.status, 2, newer.stderr);
  assert.match(newer.stderr, /known-algo-unsupported/);
});

test("CLI review fix: merge --known still catches a shard given twice", () => {
  // Value: protects=results-duplicate-shard under --known; fails_when=merge digests shards after reapply rewrote them; why_new=review finding (adversarial-native#1); seam=none; no_claim=the baseline half (test/known.test.js)
  const dir = tmp();
  const fr = (findings) => env("truncated", "s/fr/home.png", "fr", "home", findings);
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(fileOf([home([trunc("Weiter")])], ["truncated", "s/de"])));
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify(fileOf([fr([trunc("Suite")])], ["truncated", "s/fr"])));
  assert.equal(cli(["results", "known", "a.json", "--out", "k.json"], dir).status, 0);
  assert.equal(cli(["results", "merge", "a.json", "b.json", "--out", "ab.json"], dir).status, 1);
  const twice = cli(["results", "merge", "ab.json", "a.json", "--out", "x.json", "--known", "k.json"], dir);
  assert.equal(twice.status, 2, twice.stderr);
  assert.match(twice.stderr, /results-duplicate-shard/);
});

test("apply: reapply keeps a below-threshold finding that was never known at gate false", () => {
  // Value: protects=D10 (reapply regates only findings that left the file); fails_when=reapply regates every finding under the merge thresholds; why_new=review finding (specialist#2); seam=none; no_claim=none
  const empty = known.context({ ...ctxOf([home([])]).obj, findings: [] }, "k.json", "{}");
  const e = applied(empty, home([trunc("Leise")]), { min_severity: "critical", min_certainty: "high" });
  assert.equal(e.findings[0].gate, false);
  known.reapply(empty, e, scale.DEFAULTS);
  assert.deepEqual([e.findings[0].gate, e.verdict], [false, "pass"]);
});
