// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T3: `formats` inputs (D9, D15, D18, D36), text rendering and the overlay style.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const formats = require("../src/formats");
const args = require("../src/args");
const render = require("../src/render");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-formats-"));
const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
const opts = (o) => ({ currency: null, storefront: null, prices: null, rules: null, allow: null, ...o });
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

const STOREKIT = write("app.storekit", JSON.stringify({
  settings: { _storefront: "USA" },
  subscriptionGroups: [{ subscriptions: [
    { productID: "annual", displayPrice: "39.99", recurringSubscriptionPeriod: "P1Y", introductoryOffer: { paymentMode: "free", subscriptionPeriod: "P3D" } },
    { productID: "monthly", displayPrice: "7.99", recurringSubscriptionPeriod: "P1M", introductoryOffer: null },
  ] }],
  products: [{ productID: "lifetime", displayPrice: "99.00" }],
}));

test("formats: currency and storefront validation and conflicts (D9, D18)", () => {
  // Value: protects=D18 usage errors; fails_when=a bad code, an unknown region or a disagreeing pair reaches the core; why_new=new; seam=none; no_claim=none
  assert.deepEqual(formats.build(opts({ storefront: "DE" })).field, { rules: formats.DEFAULT_RULES, currency: "EUR", storefront: "DE" });
  assert.equal(formats.build(opts({ storefront: "deu" })).field.storefront, "DE"); // alpha-3
  assert.equal(formats.build(opts({ currency: "jpy" })).field.currency, "JPY");
  assert.equal(code(() => formats.build(opts({ currency: "EURO" }))), "invalid-currency");
  assert.equal(code(() => formats.build(opts({ storefront: "ZZ" }))), "invalid-storefront");
  assert.equal(code(() => formats.build(opts({ storefront: "DE", currency: "USD" }))), "conflicting-options");
  assert.deepEqual(formats.build(opts({})).field, { rules: formats.DEFAULT_RULES });
});

test("formats: .storekit prices take the storefront's currency; a different expected currency is an error (D36)", () => {
  // Value: protects=D36 currency provenance; fails_when=USD prices are relabeled EUR, or the trial/period are lost; why_new=new; seam=none; no_claim=Play test products
  const f = formats.build(opts({ prices: STOREKIT })).field;
  assert.equal(f.currency, "USD");
  assert.equal(f.storefront, "US");
  assert.deepEqual(f.products, [
    { product: "annual", price: 3999, digits: 2, currency: "USD", period: "P1Y", trial: "P3D" },
    { product: "monthly", price: 799, digits: 2, currency: "USD", period: "P1M", trial: null },
    { product: "lifetime", price: 9900, digits: 2, currency: "USD", period: null, trial: null },
  ]);
  assert.equal(formats.build(opts({ prices: STOREKIT, storefront: "US" })).field.currency, "USD");
  assert.equal(code(() => formats.build(opts({ prices: STOREKIT, storefront: "DE" }))), "conflicting-options");
  assert.equal(code(() => formats.build(opts({ prices: write("bad.storekit", JSON.stringify({ settings: {} })) }))), "prices-invalid");
  // Review: a duration must be a string with at most 4 digits (the core bounds it too), else prices-invalid here.
  for (const period of [["P1M"], "P99999999999999999Y"]) {
    assert.equal(code(() => formats.build(opts({ prices: write("dur.json", JSON.stringify([{ product: "a", price: 1, currency: "USD", period }])) }))), "prices-invalid");
  }
});

test("formats: JSON and YAML price files, minor units, mixed currencies (D18, D36)", () => {
  // Value: protects=price file parsing and its D18 errors; fails_when=a price is mis-scaled, JPY gets decimals, or mixed currencies pass silently; why_new=new; seam=none; no_claim=none
  const json = write("p.json", JSON.stringify([{ product: "pro", price: "9.99", currency: "EUR", period: "P1M" }, { product: "jp", price: 1500, currency: "JPY" }]));
  assert.equal(code(() => formats.build(opts({ prices: json }))), "missing-currency");
  const f = formats.build(opts({ prices: json, currency: "EUR" })).field;
  assert.deepEqual(f.products.map((p) => p.price), [999, 1500]);
  const yaml = write("p.yaml", "products:\n  - product: pro\n    price: 4.99\n    currency: GBP\n    period: P1W\n    trial: P1W\n");
  assert.deepEqual(formats.build(opts({ prices: yaml })).field.products, [{ product: "pro", price: 499, digits: 2, currency: "GBP", period: "P1W", trial: "P1W" }]);
  const e = (() => { try { formats.build(opts({ prices: write("q.json", JSON.stringify([{ product: "x", price: "9.999", currency: "EUR" }])) })); } catch (x) { return x; } })();
  assert.equal(e.code, "prices-invalid");
  assert.match(e.message, /\/0\/price/);
  assert.match((() => { try { formats.build(opts({ prices: write("r.json", JSON.stringify([{ product: "x", price: 1, currency: "EUR", period: "monthly" }])) })); } catch (x) { return x.message; } })(), /\/0\/period/);
  assert.equal(code(() => formats.build(opts({ prices: path.join(dir, "none.json") }))), "prices-not-found");
  assert.equal(formats.minor("1,299.00", "USD"), 129900);
  assert.equal(formats.minor("9.999", "USD"), null);
  // Review: a European decimal comma is an error, never 999 (D37); commas pass only in 3-digit groups.
  assert.equal(formats.minor("9,99", "EUR"), null);
  assert.equal(formats.minor("99999999999999999", "USD"), null);
  assert.equal(formats.minor("12,34,567", "INR"), null);
  assert.equal(formats.minor("1,234,567.50", "USD"), 123456750);
});

test("formats: --rules replaces the default and names the closest rule (D15); options only on formats", () => {
  // Value: protects=D15 selection semantics and option scoping; fails_when=an unknown rule passes or --currency is accepted by check; why_new=new; seam=none; no_claim=none
  assert.deepEqual(formats.build(opts({ rules: "time,number,time" })).field.rules, ["time", "number"]);
  assert.throws(() => formats.parseRules("numbr"), (e) => e.code === "unknown-rule" && /did you mean number/.test(e.message));
  assert.equal(code(() => args.parse(["check", "a.png", "--currency", "EUR"])), "option-not-valid");
  assert.equal(args.parse(["formats", "a.png", "--storefront", "DE", "--allow", "a.txt"]).storefront, "DE");
});

test("formats: text rendering of each kind (D8, D20)", () => {
  // Value: protects=the text line per kind; fails_when=a field is dropped or "charged" is claimed; why_new=new; seam=none; no_claim=none
  assert.equal(render.findingDetail({ kind: "format", rule: "number", token: "1,234.56", line: "Total 1,234.56", box: [0, 0, 1, 1], expected: "1.234,56" }),
    '  format (number) "1,234.56" in "Total 1,234.56" at [0, 0, 1, 1], expected "1.234,56"');
  assert.equal(render.findingDetail({ kind: "currency", rule: "unexpected", token: "$4.99", currencies: ["USD"], expected_currency: "EUR", line: "Pro $4.99 / month", box: null }),
    '  currency (unexpected) "$4.99" (USD) in "Pro $4.99 / month", storefront EUR');
  assert.equal(render.findingDetail({ kind: "currency", rule: "mixed", token: "€9.99", currencies: ["EUR", "USD"], expected_currency: null, line: "€9.99", box: null }),
    '  currency (mixed) "€9.99" (EUR, USD) in "€9.99", EUR and USD on one screen');
  assert.equal(render.findingDetail({ kind: "price", field: "period", product: "annual", token: "$39.99", line: "$39.99/month", box: null, expected: "per year" }),
    '  price (period) annual "$39.99" in "$39.99/month", price file: "per year"');
});
