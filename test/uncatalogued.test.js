// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-036 T4 golden through the CLI and real Vision: 2 synthetic de screens from test/fixtures/uncatalogued/. A clean
// one (a catalog string, a filled placeholder, another locale's string, a time) and one with a hardcoded line, a
// near-catalog line and a user name that a boxes file marks dynamic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");

setup();
const F = path.join(__dirname, "fixtures/uncatalogued");
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-uncatalogued-"));
execFileSync(path.join(ROOT, ".build/synth"), [path.join(F, "screens.json"), shots]);
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));
const shot = (n) => path.join(shots, `${n}.png`);
const base = ["--locale", "de", "--base", path.join(F, "en.json"), "--catalog", path.join(F, "{locale}.json"), "--uncatalogued", "--experimental", "--json"];

test("golden: every loaded locale covers its lines; a hardcoded and a near-catalog line are found, with nearest (D48, D50)", () => {
  // Value: protects=Check 4 end to end on Vision reads; fails_when=a catalog, placeholder or other-locale line is flagged, the hardcoded line is missed, or nearest/language/schema drift; why_new=new kind; seam=none; no_claim=recall (bench/uncatalogued.js)
  const r = cli(["untranslated", shot("u01-clean"), shot("u02-hardcoded"), ...base]);
  assert.equal(r.code, 1, r.stderr);
  for (const env of r.json) assert.ok(validate(env), `${env.path}: ${JSON.stringify(validate.errors)}`);
  // The base-language line is `untranslated`, never also `uncatalogued` (D52); the rest of the clean screen is covered.
  assert.deepEqual(r.json[0].findings.map((f) => `${f.kind}:${f.line}`), ["untranslated:Read the latest news from our team"]);
  const u = r.json[1].findings.filter((f) => f.kind === "uncatalogued");
  assert.deepEqual(u.map((f) => f.line), ["Tägliche Belohnung abholen", "Lies hier die neuen Berichte unseres Teams", "Marta Kowalczyk"]);
  assert.deepEqual(u[1].nearest?.key, "news.title");
  assert.ok(u[0].language === "de" || u[0].language === null, u[0].language); // the recognizer over de and en, at 0.95
});

test("a dynamic: true element and --dynamic keep a name out; the kinds sugar and text output", () => {
  // Value: protects=D51 per-image rects through the CLI; fails_when=--boxes rects or --dynamic do not reach the core, or the text line drifts; why_new=new path; seam=none; no_claim=MCP (mcp.test.js)
  const boxes = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-uncatalogued-boxes-"));
  fs.writeFileSync(path.join(boxes, "u02-hardcoded.boxes.json"), JSON.stringify({ image: { width: 1100, height: 420 }, elements: [{ id: "n", box: [0, 0.66, 1, 0.16], text: "Marta Kowalczyk", dynamic: true }] }));
  const r = cli(["untranslated", shot("u02-hardcoded"), ...base, "--boxes", boxes]);
  assert.deepEqual(r.json[0].findings.filter((f) => f.kind === "uncatalogued").map((f) => f.line), ["Tägliche Belohnung abholen", "Lies hier die neuen Berichte unseres Teams"]);
  const dyn = path.join(boxes, "dynamic.txt");
  fs.writeFileSync(dyn, "^Marta .+$\n");
  const d = cli(["untranslated", shot("u02-hardcoded"), ...base, "--dynamic", dyn]);
  assert.ok(!d.json[0].findings.some((f) => f.line === "Marta Kowalczyk"));
  const off = cli(["untranslated", shot("u02-hardcoded"), "--locale", "de", "--catalog", path.join(F, "{locale}.json"), "--json"]);
  assert.ok(!off.json[0].findings.some((f) => f.kind === "uncatalogued"), "opt-in");
  const text = cli(["untranslated", shot("u02-hardcoded"), "--locale", "de", "--base", path.join(F, "en.json"), "--catalog", path.join(F, "{locale}.json"), "--kinds", "uncatalogued", "--experimental"]);
  assert.match(text.stdout, /uncatalogued "Lies hier die neuen Berichte unseres Teams" at \[.*\] \(no catalog string(; de)?; nearest @news\.title "Lies die neuesten Nachrichten unseres Teams", distance 0\.\d+\)/);
});

test("serve: the field by digest, rects per request, an unknown digest and a bad size are refused (D50, D51)", async () => {
  // Value: protects=Serve's uncatalogued digest cache and per-request dynamic rects; fails_when=a digest-only request runs with an empty or stale field, rects leak across requests, or malformed input reaches the rule; why_new=review (no Serve-level test); seam=none; no_claim=the Node resend (core-js tests)
  const { Server } = require("../packages/core-js/src/client");
  const s = new Server();
  await s.ready;
  const field = { entries: [{ key: "k", locale: "de", text: "Einstellungen", forms: [{ fragments: ["Einstellungen"] }] }], languages: ["de"], dynamic: [], allow: [] };
  const untr = { base_locale: "en", pairs: [], kinds: ["uncatalogued"] };
  const req = (id, unc) => s.request({ id, command: "untranslated", path: shot("u02-hardcoded"), locale: "de", untranslated: untr, uncatalogued: unc });
  const first = await req("c1", { ...field, digest: "c1" });
  assert.ok(first.findings.length >= 3, JSON.stringify(first.findings));
  const covered = await req("c2", { digest: "c1", dynamic_rects: [[0, 0, 1, 1]], dynamic_size: [1100, 420] });
  assert.deepEqual(covered.findings, [], "the whole screen marked dynamic");
  const again = await req("c3", { digest: "c1" });
  assert.equal(again.findings.length, first.findings.length, "the previous request's rects do not stay");
  assert.equal((await req("c4", { digest: "nope" })).error.code, "invalid-request");
  const bad = await req("c5", { digest: "c1", dynamic_rects: [[0, 0, 1, 1]], dynamic_size: [0, 420] });
  assert.match(bad.error.message, /uncatalogued\.dynamic_size must be/);
  await s.close();
});
