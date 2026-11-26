// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-036 T2 golden through the CLI, real Vision and the real language recognizer (D6): 5 synthetic pt-BR
// screens drawn from test/fixtures/wrong-language/, catalogs en, es and pt-BR found by the {locale} template.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");

setup();
const W = path.join(__dirname, "fixtures/wrong-language");
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wrong-language-"));
execFileSync(path.join(ROOT, ".build/synth"), [path.join(W, "screens.json"), shots]);
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));
const TPL = ["--locale", "pt-BR", "--catalog", path.join(W, "{locale}.json")];
const label = (f) => (f.kind === "wrong-language" ? [f.kind, f.evidence, f.language, f.key ?? f.line] : [f.kind, f.key ?? f.line]);
const byName = (r) => Object.fromEntries(r.json.map((e) => [path.basename(e.path, ".png"), e]));

test("golden: catalog evidence, language ID, the base locale and short lines (D5, D23, D25, D26)", () => {
  const r = cli(["untranslated", shots, ...TPL, "--json"]);
  assert.equal(r.code, 1, r.stderr);
  const got = byName(r);
  for (const env of r.json) assert.ok(validate(env), `${env.path}: ${JSON.stringify(validate.errors)}`);
  assert.deepEqual(got["w01-clean"].findings, [], "shared strings and a brand name");
  assert.deepEqual(got["w02-catalog"].findings.map(label), [["wrong-language", "catalog", "es", "shop.buy"]]);
  const f = got["w02-catalog"].findings[0];
  assert.deepEqual([f.catalog, f.expected, f.evidence_catalog, f.expected_language, f.confidence],
    [path.join(W, "pt-BR.json"), "Comprar agora", path.join(W, "es.json"), "pt-BR", 1]);
  assert.deepEqual(got["w03-langid"].findings.map(label), [["wrong-language", "langid", "es", "Guarda todos los cambios antes de salir"]]);
  assert.ok(got["w03-langid"].findings[0].confidence >= 0.95);
  assert.deepEqual(got["w04-base"].findings.map(label), [["wrong-language", "catalog", "en", "settings.title"]], "no --base: en is a project locale");
  assert.deepEqual(got["w05-short"].findings, [], "two words with no catalog evidence, and a time");
  for (const env of r.json) assert.deepEqual(env.warnings, []);
});

test("--base: rule 1 reports the base string, wrong-language does not repeat it (D5, D26)", () => {
  const r = cli(["untranslated", path.join(shots, "w04-base.png"), ...TPL, "--base", path.join(W, "en.json"), "--json"]);
  assert.deepEqual(r.json[0].findings.map(label), [["untranslated", "settings.title"]]);
});

test("--kinds, --languages alone, the unchecked warning and text output (D15, D17)", () => {
  const off = cli(["untranslated", path.join(shots, "w02-catalog.png"), ...TPL, "--kinds", "untranslated,raw-key,placeholder", "--json"]);
  assert.deepEqual([off.code, off.json[0].findings, off.json[0].warnings], [0, [], []]);
  const plain = ["--locale", "pt-BR", "--catalog", path.join(W, "pt-BR.json")];
  const none = cli(["untranslated", path.join(shots, "w03-langid.png"), ...plain, "--json", "--quiet"]);
  assert.equal(none.code, 0);
  assert.deepEqual(none.json[0].warnings.map((w) => w.code), ["wrong-language-unchecked"]);
  const lid = cli(["untranslated", path.join(shots, "w02-catalog.png"), path.join(shots, "w03-langid.png"), ...plain, "--languages", "es,en", "--json"]);
  assert.deepEqual(lid.json.map((e) => e.findings.map(label)), [[], [["wrong-language", "langid", "es", "Guarda todos los cambios antes de salir"]]],
    "language ID alone never judges a two-word line");
  const text = cli(["untranslated", path.join(shots, "w02-catalog.png"), ...TPL]);
  assert.match(text.stdout, /wrong-language es @shop\.buy \(.*pt-BR\.json: "Comprar agora"; matched .*es\.json\) in "Comprar ahora" at \[/);
});
