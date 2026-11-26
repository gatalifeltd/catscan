// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-036 T3 golden through the CLI and real Vision: 3 synthetic screens from test/fixtures/formats/, a de paywall
// in a DE storefront with a price file, and an English screen with two currencies and no storefront.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");

setup();
const F = path.join(__dirname, "fixtures/formats");
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-formats-"));
execFileSync(path.join(ROOT, ".build/synth"), [path.join(F, "screens.json"), shots]);
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));
const label = (f) => [f.kind, f.rule ?? f.field, f.token];
const shot = (n) => path.join(shots, `${n}.png`);

test("golden: a clean paywall, one defect per rule, and the price file (D8, D9, D20)", () => {
  const r = cli(["formats", shot("f01-clean"), shot("f02-defects"), "--locale", "de", "--storefront", "DE", "--prices", path.join(F, "prices.json"), "--json"]);
  assert.equal(r.code, 1, r.stderr);
  for (const env of r.json) assert.ok(validate(env), `${env.path}: ${JSON.stringify(validate.errors)}`);
  assert.deepEqual(r.json[0].findings, []);
  assert.equal(r.json[0].price_exempt, 0);
  assert.deepEqual(r.json[1].findings.map(label), [
    ["format", "number", "1,234.56"], ["format", "date", "11/25/2026"], ["currency", "unexpected", "4,99 $"], ["price", "period", "39,99 €"],
  ]);
  const cur = r.json[1].findings[2];
  assert.deepEqual([cur.currencies, cur.expected_currency], [["USD"], "EUR"]);
  assert.deepEqual([r.json[1].findings[3].product, r.json[1].findings[3].expected], ["pro.yearly", "pro jahr"]);
  for (const env of r.json) assert.deepEqual(env.warnings, []);
});

test("mixed currencies without a storefront, currency-unchecked, --rules and text output (D15, D17)", () => {
  const r = cli(["formats", shot("f03-mixed"), "--locale", "en", "--json"]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json[0].findings.map(label), [["currency", "mixed", "€39.99"]]);
  assert.deepEqual([r.json[0].findings[0].currencies, r.json[0].findings[0].expected_currency], [["EUR", "USD"], null]);
  assert.deepEqual(r.json[0].warnings.map((w) => w.code), ["currency-unchecked"]);
  assert.equal(r.json[0].price_exempt, null);
  const off = cli(["formats", shot("f03-mixed"), "--locale", "en", "--rules", "number,date", "--json"]);
  assert.deepEqual([off.code, off.json[0].findings], [0, []]);
  // Value: protects=D17 warning scoped to the currency and price rules; fails_when=currency-unchecked shows with --rules number,date; why_new=only findings were checked; seam=none; no_claim=Tesseract
  assert.deepEqual(off.json[0].warnings, []);
  // Value: protects=D18 errors exit 2 before serve; fails_when=formats.build throws outside main's usage catch (crash, exit 1); why_new=build was only unit-tested; seam=none; no_claim=MCP (mcp.test.js)
  const bad = cli(["formats", shot("f03-mixed"), "--storefront", "ZZ"]);
  assert.deepEqual([bad.code, /invalid-storefront/.test(bad.stderr)], [2, true], bad.stderr);
  const text = cli(["formats", shot("f02-defects"), "--locale", "de", "--storefront", "DE"]);
  assert.match(text.stdout, /currency \(unexpected\) "4,99 \$" \(USD\) in "Pro 4,99 \$ pro Monat" at \[.*\], storefront EUR/);
});

test("schema: a formats missing cell needs no price_exempt (review)", () => {
  // Value: protects=--results with --expect-locales on formats; fails_when=the formats price_exempt rule also binds missing-cell entries, so results validate, merge and baseline reject the file; why_new=review finding; seam=none; no_claim=none
  const results = require("../packages/core-js/src/results");
  const { missing } = results.coverage([], { locales: ["de"], screens: ["home"] }, "{locale}/{screen}", "formats");
  assert.equal(missing.length, 1);
  assert.ok(validate(missing[0]), JSON.stringify(validate.errors));
});
