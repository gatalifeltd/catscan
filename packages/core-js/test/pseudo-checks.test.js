// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-039 T2, Node side: --pseudo, --kinds and --dynamic arguments, the request fields, text, schema, report and CI
// output of pseudo-cut, hardcoded and pseudo-not-applied. The rules are PseudoTests.swift; Vision is test/pseudo.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Ajv = require("ajv");
const { parse, UsageError } = require("../src/args");
const render = require("../src/render");
const untranslated = require("../src/untranslated");
const truncated = require("../src/truncated");
const pseudoField = require("../src/pseudo-field");
const pseudo = require("../src/pseudo");
const overlay = require("../src/report/overlay");
const ci = require("../src/ci");
const boxes = require("../src/boxes");

const usage = (argv, code, re) => assert.throws(() => parse(argv), (e) => {
  assert.ok(e instanceof UsageError, String(e));
  assert.equal(e.code, code);
  if (re) assert.match(render.diagnosticLine(e), re);
  return true;
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pc-"));
const schema = new Ajv({ allErrors: true, strict: false }).addSchema(require("../../../core/schema/result.schema.json"), "result");
const finding = schema.getSchema("result#/definitions/finding");

const CUT = { kind: "truncated", box: [0.1, 0.2, 0.3, 0.03], line: "[Šéttíñgš ö", reason: "pseudo-cut", element: null, expected: "Settings", confidence: 0.9, side: "end", lost: "filler", key: "settings.title", catalog: "en.json" };
const HARD = { kind: "hardcoded", box: [0.1, 0.3, 0.3, 0.03], line: "Daily reward", evidence: "base", key: "bonus.daily", catalog: "en.json", expected: "Daily reward" };
const NONE = { kind: "hardcoded", box: [0.1, 0.4, 0.3, 0.03], line: "Limited time offer", evidence: "none" };
const NA = { kind: "pseudo-not-applied", box: null, traits: 0.1, lines: 5 };
const ENV = { command: "untranslated", path: "shots/en-XA/home.png", verdict: "fail", locale: "en", pseudo: true, checks: [], findings: [CUT, HARD, NONE, NA], warnings: [] };

test("args: --pseudo on untranslated, truncated and check; its usage errors (D8, D12)", () => {
  // Value: protects=TODO-039 D8, D12 surface; fails_when=--pseudo takes --base, runs without a catalog, or reaches video; why_new=new flag; seam=none; no_claim=none
  assert.equal(parse(["untranslated", "s/", "--pseudo", "--catalog", "en.json"]).pseudo, true);
  assert.equal(parse(["truncated", "s/", "--pseudo", "--catalog", "en.json"]).pseudo, true);
  assert.equal(parse(["check", "s/", "--pseudo", "--present", "Settings"]).pseudo, true);
  usage(["untranslated", "s/", "--pseudo", "--base", "en.json", "--catalog", "de.json"], "pseudo-conflicts-with-base", /drop --base - try: catscan untranslated shots\/ --pseudo --catalog/);
  usage(["untranslated", "s/", "--pseudo"], "missing-catalog");
  usage(["truncated", "s/", "--pseudo"], "missing-catalog");
  usage(["video", "t.mp4", "--pseudo", "--present", "x"], "option-not-valid");
  usage(["--pseudo", "read", "s/"], "option-not-valid");
});

test("args: --kinds (TODO-036 D15) and --dynamic", () => {
  // Value: protects=D15 selection semantics and the --dynamic precondition; fails_when=an unknown kind passes or hardcoded runs without --pseudo; why_new=new flags; seam=none; no_claim=none
  assert.deepEqual(parse(["untranslated", "s/", "--kinds", "raw-key,placeholder,raw-key"]).kinds, ["raw-key", "placeholder"]);
  assert.deepEqual(parse(["untranslated", "s/", "--pseudo", "--catalog", "en.json", "--kinds", "hardcoded"]).kinds, ["hardcoded"]);
  usage(["untranslated", "s/", "--kinds", "hardcode"], "unknown-kind", /did you mean hardcoded\?/);
  usage(["untranslated", "s/", "--kinds", ","], "unknown-kind");
  usage(["untranslated", "s/", "--kinds", "hardcoded"], "option-not-valid", /needs --pseudo/);
  usage(["untranslated", "s/", "--dynamic", "d.txt"], "option-not-valid", /--pseudo/);
  usage(["truncated", "s/", "--kinds", "raw-key"], "option-not-valid");
  usage(["untranslated", "s/", "--boxes", "b.json"], "option-not-valid");
  assert.equal(parse(["untranslated", "s/", "--pseudo", "--catalog", "en.json", "--boxes", "b/"]).boxes, "b/");
  assert.throws(() => truncated.build(parse(["truncated", "s/", "--reasons", "pseudo-cut"]), []), (e) => e.code === "option-not-valid" && /needs --pseudo/.test(e.message));
});

test("request fields: the base catalog, the generator's fillers, guards; no pairs and no base-catalog warning (D3, D12)", () => {
  // Value: protects=D3, D10, D12 wire shape; fails_when=fillers drift from the generator, placeholders lose their position, or the base rule runs; why_new=new field; seam=none; no_claim=core matching
  const d = tmp();
  const cat = path.join(d, "en.json");
  fs.writeFileSync(cat, JSON.stringify({ greeting: "Hello, {{name}}!", coins: "{{n}} coins left", title: "<b>Game</b> over" }));
  const dyn = path.join(d, "dyn.txt");
  fs.writeFileSync(dyn, "# names\n(Anna|Ben) \\w+\n\n");
  const opts = parse(["untranslated", d, "--pseudo", "--catalog", cat, "--dynamic", dyn, "--kinds", "hardcoded,raw-key"]);
  const out = untranslated.build(opts);
  assert.deepEqual(out.field.pairs, []);
  assert.deepEqual(out.field.kinds, ["hardcoded", "raw-key"]);
  assert.ok(!out.runWarnings.some((w) => w.code === "untranslated-base-catalog"));
  assert.deepEqual(out.pseudo.field.fillers, pseudo.FILLER);
  assert.deepEqual(out.pseudo.field.dynamic, ["(Anna|Ben) \\w+"]);
  const forms = Object.fromEntries(out.pseudo.field.entries.map((e) => [e.key, e.forms]));
  assert.deepEqual(forms.greeting, [{ fragments: ["Hello,", "!"], lead: false, trail: false }]);
  assert.deepEqual(forms.coins, [{ fragments: ["coins left"], lead: true, trail: false }]);
  assert.deepEqual(forms.title, [{ fragments: ["Game over"], lead: false, trail: false }], "markup is not a placeholder");
  // Review fix: lead and trail come from the parser, so ICU branches and <br> do not loosen the match.
  const d2 = tmp();
  fs.writeFileSync(path.join(d2, "en.json"), JSON.stringify({ g: "{g, select, male {He} other {They}} left", br: "Line one<br>two", n: "{count, plural, one {# item} other {# items}}" }));
  const f2 = pseudoField.build(require("../src/catalog").loadAll([path.join(d2, "en.json")], "en"), {});
  const by2 = Object.fromEntries(f2.field.entries.map((e) => [e.key, e.forms]));
  assert.deepEqual(by2.g.map((f) => [f.lead, f.trail]), [[false, false], [false, false]]);
  assert.deepEqual(by2.br.map((f) => [f.lead, f.trail]), [[false, false]]);
  assert.deepEqual(by2.n.map((f) => [f.fragments, f.lead, f.trail]), [[["item"], true, false], [["items"], true, false]]);
  // Review fix: the core's caps are usage errors here, not a refused first request.
  // (Per-string form and fragment caps equal the loader's, which caps such a string first.)
  const keys = new Map(Array.from({ length: 20001 }, (_, i) => [`k${i}`, { key: `k${i}`, catalog: null, text: "Hi", alternatives: [["Hi"]] }]));
  assert.throws(() => pseudoField.build({ keys }, {}), (e) => e.code === "catalog-too-many-strings" && /20001 strings/.test(e.message));
  assert.ok(out.bytes > Buffer.byteLength(JSON.stringify(out.field)), "the pseudo field counts toward the first line");
  fs.writeFileSync(dyn, "ok\n(unclosed\n");
  assert.throws(() => pseudoField.loadDynamic(dyn), (e) => e.code === "dynamic-invalid" && /dyn\.txt:2: not a valid regex/.test(e.message));
  assert.throws(() => pseudoField.loadDynamic(path.join(d, "nope.txt")), (e) => e.code === "dynamic-not-found");
  assert.equal(pseudoField.ocrLocale("en-XA"), "en");
  assert.equal(pseudoField.ocrLocale("ar-XB"), "en");
  assert.equal(pseudoField.ocrLocale("en_XA"), "en"); // the -AppleLocale spelling (TODO-039 T3 review)
  assert.equal(pseudoField.ocrLocale("de"), "de");
  const t = truncated.build(parse(["truncated", d, "--pseudo", "--catalog", cat, "--reasons", "pseudo-cut"]), []);
  assert.equal(t.forInput({ path: "a.png" }).field.pseudo, true);
  assert.deepEqual(t.forInput({ path: "a.png" }).field.reasons, ["pseudo-cut"]);
  assert.equal(t.pseudo.field.entries.length, 3);
});

test("boxes: an element may be marked dynamic: true (D10 guard)", () => {
  // Value: protects=the dynamic-element guard input; fails_when=dynamic is dropped or a non-boolean passes; why_new=new field; seam=none; no_claim=none
  const d = tmp();
  const f = path.join(d, "b.json");
  fs.writeFileSync(f, JSON.stringify({ image: { width: 390, height: 844 }, elements: [{ id: "name", box: [0, 0.5, 1, 0.05], dynamic: true }, { id: "x", box: [0, 0.6, 1, 0.05] }] }));
  assert.deepEqual(boxes.load(f).elements.map((e) => e.dynamic ?? false), [true, false]);
  fs.writeFileSync(f, JSON.stringify({ image: { width: 390, height: 844 }, elements: [{ box: [0, 0.5, 1, 0.05], dynamic: "yes" }] }));
  assert.throws(() => boxes.load(f), /dynamic must be true or false/);
});

test("output: text lines, schema shapes, report labels and CI formats (D14)", () => {
  // Value: protects=D14 shapes in every output layer; fails_when=a layer drops or misnames a pseudo finding; why_new=new kinds; seam=none; no_claim=none
  assert.deepEqual(render.renderText(ENV), [
    "FAIL  shots/en-XA/home.png",
    '  truncated (pseudo-cut, filler lost) "[Šéttíñgš ö" at [0.1, 0.2, 0.3, 0.03] @settings.title (en.json: "Settings")',
    '  hardcoded "Daily reward" at [0.1, 0.3, 0.3, 0.03] (equals @bonus.daily in en.json; not from the pseudo catalog; look it up by key)',
    '  hardcoded "Limited time offer" at [0.1, 0.4, 0.3, 0.03] (in no catalog; not from the pseudo catalog)',
    "  pseudo-not-applied: 10% of 5 lines show pseudo text; this screen did not load the pseudo locale (launch the app in en-XA)",
  ]);
  // Added by /ship coverage audit. Value: protects=the start-side wording of a pseudo-cut; fails_when=the side branch drops; why_new=only side end was rendered; seam=none; no_claim=none
  assert.match(render.renderText({ ...ENV, findings: [{ ...CUT, side: "start" }] })[1], /^  truncated \(pseudo-cut, filler lost, at the start\) /);
  for (const f of [CUT, HARD, NONE, NA]) assert.ok(finding(f), JSON.stringify(finding.errors));
  const { side, ...noSide } = CUT;
  assert.equal(finding(noSide), false, "pseudo-cut needs side");
  const { key, ...noKey } = HARD;
  assert.equal(finding(noKey), false, "evidence base needs key, catalog and expected");
  assert.equal(finding({ ...NA, box: [0, 0, 1, 1] }), false, "pseudo-not-applied has no box");
  const s = overlay.shapes(ENV);
  assert.deepEqual(s.map((x) => [x.style, x.label]), [["truncated-pseudo-cut", "cut (pseudo)"], ["hardcoded", "hardcoded"], ["hardcoded", "hardcoded"], ["pseudo-not-applied", "pseudo not loaded"]]);
  assert.equal(overlay.STYLES["truncated-pseudo-cut"].color, overlay.STYLES.truncated.color);
  assert.equal(overlay.STYLES.hardcoded.color, overlay.STYLES.untranslated.color);
  assert.match(ci.junit([ENV]), /<failure type="untranslated" message="truncated \(pseudo-cut, filler lost\)[^>]*>[^<]*\nhardcoded "Daily reward"[^<]*\npseudo-not-applied: 10% of 5 lines/);
  assert.match(ci.githubLines([ENV])[0], /^::error file=shots\/en-XA\/home.png,title=catscan untranslated%3A fail::truncated \(pseudo-cut, filler lost\)/);
  assert.deepEqual(ci.codequality([ENV]).map((c) => c.check_name), ["catscan/truncated", "catscan/hardcoded", "catscan/hardcoded", "catscan/pseudo-not-applied"]);
});

test("pseudo next steps end with the --pseudo check command (D6)", () => {
  // Value: protects=D6 copy-paste next step; fails_when=the generator stops pointing at the check; why_new=T2 adds the command; seam=none; no_claim=none
  const d = tmp();
  const f = path.join(d, "locales/en.json");
  fs.mkdirSync(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify({ a: "Settings" }));
  const r = pseudo.generate({ file: f, out: null, locale: null, expand: null, variant: null, inPlace: false, force: false });
  assert.equal(r.next.at(-1).command, `catscan untranslated shots/ --pseudo --catalog ${f}`);
});

test("client: a replaced core gets the cached pseudo field again, with this image's dynamic rects (D32)", () => {
  // Value: protects=spec 17 D32 resend for the pseudo field; fails_when=a core restarted after a vision-timeout gets only a digest and refuses every pending pseudo request (seen on the T2 gate run); why_new=review fix; seam=Server.send; no_claim=the restart policy
  const { Server } = require("../src/client");
  const sent = [];
  const s = Object.assign(Object.create(Server.prototype), { digests: new Map(), proc: { stdin: { write: (l) => sent.push(JSON.parse(l)) } } });
  const full = { entries: [{ key: "a", catalog: null, text: "Settings", forms: [{ fragments: ["Settings"], lead: false, trail: false }] }], fillers: ["one"], dynamic: [], allow: [], digest: "p1", dynamic_rects: [[0, 0, 1, 0.1]], dynamic_size: [390, 844] };
  s.send({ id: "0", command: "untranslated", untranslated: { base_locale: "en", digest: "u1", pairs: [] }, pseudo: full });
  s.send({ id: "1", command: "untranslated", untranslated: { digest: "u1" }, pseudo: { digest: "p1" } }, true);
  s.send({ id: "2", command: "untranslated", untranslated: { digest: "u1" }, pseudo: { digest: "p1", dynamic_rects: [[0, 0.5, 1, 0.1]], dynamic_size: [390, 844] } }, true);
  s.send({ id: "3", command: "untranslated", pseudo: { digest: "p1" } });
  assert.deepEqual(sent[1].untranslated, { base_locale: "en", digest: "u1", pairs: [] });
  const { dynamic_rects: _, dynamic_size: _s, ...catalogPart } = full;
  assert.deepEqual(sent[1].pseudo, catalogPart, "the full field, without the first image's rects");
  assert.deepEqual(sent[2].pseudo.dynamic_rects, [[0, 0.5, 1, 0.1]], "the resend keeps the request's own rects");
  assert.deepEqual(sent[2].pseudo.dynamic_size, [390, 844], "and its own image size");
  assert.ok(!("dynamic_size" in sent[1].pseudo), "a cached first request's size never rides on another image");
  assert.deepEqual(sent[3].pseudo, { digest: "p1" }, "no resend: the live process has the digest");
});

test("cli: untranslated --pseudo --boxes sends the pseudo field once, dynamic rects per image and no truncated field", () => {
  // Added by /ship coverage audit.
  // Value: protects=the serve request cli.js builds for --pseudo (D12, D32 digest, D10 dynamic rects); fails_when=boxesOnly sends a
  // truncated field, the field repeats on every request, dynamic_rects drop or en-XA is sent to Vision; why_new=test/pseudo.test.js
  // never passes --boxes or inspects requests; seam=none (documented CATSCAN_CORE_BINARY); no_claim=core handling (fake node core)
  const { spawnSync } = require("child_process");
  const { PROTOCOL } = require("../src/client");
  const d = tmp();
  const log = path.join(d, "requests.jsonl");
  const core = path.join(d, "core");
  fs.writeFileSync(core, `#!/usr/bin/env node
const fs = require("fs");
process.stdout.write(JSON.stringify({ id: null, type: "ready", catscan: "0.0.1", protocol: ${PROTOCOL} }) + "\\n");
let b = ""; process.stdin.on("data", (x) => { b += x; let i; while ((i = b.indexOf("\\n")) >= 0) { const r = JSON.parse(b.slice(0, i)); b = b.slice(i + 1);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(r) + "\\n");
  process.stdout.write(JSON.stringify({ id: r.id, schema: 1, command: r.command, path: r.path, verdict: "pass", locale: "en", checks: [], findings: [], warnings: [] }) + "\\n"); } });
`, { mode: 0o755 });
  fs.mkdirSync(path.join(d, "shots"));
  fs.mkdirSync(path.join(d, "boxes"));
  for (const n of ["a", "b"]) fs.writeFileSync(path.join(d, "shots", `${n}.png`), "");
  fs.writeFileSync(path.join(d, "boxes", "a.boxes.json"), JSON.stringify({ image: { width: 390, height: 844 }, elements: [{ id: "name", box: [0, 0.5, 1, 0.05], dynamic: true }, { id: "x", box: [0, 0.6, 1, 0.05] }] }));
  fs.writeFileSync(path.join(d, "en.json"), JSON.stringify({ a: "Settings" }));
  const r = spawnSync(process.execPath, [path.resolve(__dirname, "../../../bin/catscan.js"), "untranslated", path.join(d, "shots"), "--pseudo",
    "--catalog", path.join(d, "en.json"), "--boxes", path.join(d, "boxes"), "--locale", "en-XA", "--layout", "none"], { encoding: "utf8", env: { ...process.env, CATSCAN_CORE_BINARY: core } });
  assert.equal(r.status, 0, r.stderr);
  const reqs = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).sort((x, y) => x.id - y.id);
  assert.equal(reqs.length, 2);
  for (const q of reqs) { assert.equal(q.truncated, undefined); assert.equal(q.locale, "en"); assert.equal(typeof q.pseudo.digest, "string"); }
  const [a, b] = ["a.png", "b.png"].map((n) => reqs.find((q) => path.basename(q.path) === n));
  assert.deepEqual(a.pseudo.dynamic_rects, [[0, 0.5, 1, 0.05]]);
  assert.equal(b.pseudo.dynamic_rects, undefined);
  assert.equal(reqs.filter((q) => q.pseudo.entries).length, 1, "the full field rides on one request only");
  assert.equal(reqs[0].pseudo.entries[0].key, "a");
  assert.equal(reqs[1].pseudo.digest, reqs[0].pseudo.digest);
});
