// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T3: `formats` inputs. Node validates the currency, storefront, rules and price file and sends the core
// one `formats` field; the core owns the rules (D36, spec 02 D1).
"use strict";
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { UsageError, closest } = require("./args");
const { loadAllow } = require("./untranslated");
const STOREFRONTS = require("./storefronts.json");

const RULES = ["number", "date", "time", "currency-placement", "currency", "mixed-currency", "price"];
const DEFAULT_RULES = ["number", "date", "currency", "mixed-currency", "price"]; // D7
const MAX_PRICES_BYTES = 4 * 1024 * 1024;
const DURATION_RE = /^P\d{1,4}[DWMY]$/; // the core bounds the count too (review)
const DURATION = { test: (v) => typeof v === "string" && DURATION_RE.test(v) };

let currencies = null;
function isCurrency(c) {
  currencies = currencies || new Set(Intl.supportedValuesOf("currency"));
  return currencies.has(c);
}

/** Fraction digits of a currency in Node's CLDR. Foundation disagrees for PKR and RSD (0, not 2), so every product
 * carries `digits` and the core rescales it to its own (review, TODO-036 T3). */
function digits(code) {
  return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
}

/** A price as written (`39.99`, 39.99, `1,299.00`) to minor units, or null. A comma is a group separator only in
 * 3-digit groups: `9,99` is an error, never 999 (D37: parsing never guesses). */
function minor(v, code) {
  const t = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : null;
  if (t !== null && t.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return null;
  const s = t === null ? null : t.replace(/,/g, "");
  if (s === null || !/^\d+(\.\d+)?$/.test(s)) return null;
  const d = digits(code);
  const [i, f = ""] = s.split(".");
  if (f.length > d && /[1-9]/.test(f.slice(d))) return null;
  const m = Number(i) * 10 ** d + Number((f + "0".repeat(d)).slice(0, d) || 0);
  return Number.isSafeInteger(m) && m <= 1e15 ? m : null; // the core's bound (Serve.formatsJob)
}

function storefront(code) {
  const c = String(code).toUpperCase();
  if (STOREFRONTS.regions[c]) return c;
  if (STOREFRONTS.alpha3[c]) return STOREFRONTS.alpha3[c];
  return null;
}

/** `--rules a,b`: D15 semantics; the list replaces the default; unknown names name the closest one. */
function parseRules(v) {
  const list = String(v).split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new UsageError("unknown-rule", "--rules needs at least one rule", `--rules ${RULES.join(",")}`);
  for (const r of list) {
    if (!RULES.includes(r)) {
      const s = closest(r, RULES);
      throw new UsageError("unknown-rule", `--rules: unknown rule ${r}${s ? `; did you mean ${s}?` : ""}`, `--rules ${RULES.join(",")}`);
    }
  }
  return [...new Set(list)];
}

/**
 * Reads a price file: a `.storekit` configuration, or JSON or YAML holding a list of
 * `{product, price, currency, period, trial}` (or `{products: [...]}`). Returns `{products, currency, storefront}`;
 * `currency` is the products' one currency or null when they mix, `storefront` the `.storekit` region or null.
 */
function loadPrices(file) {
  let text;
  try {
    if (fs.statSync(file).size > MAX_PRICES_BYTES) throw new UsageError("prices-invalid", `the price file ${file} is over 4 MB`, "keep the test products only");
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError("prices-not-found", `cannot read the price file ${file}: ${e.code || e.message}`, "check the --prices path; it is read from the working directory");
  }
  const bad = (where, why) => new UsageError("prices-invalid", `${file}${where ? ` ${where}` : ""}: ${why}`, "see docs/cli.md#formats for the price file shape");
  const ext = path.extname(file).toLowerCase();
  let doc;
  try {
    doc = ext === ".yaml" || ext === ".yml" ? YAML.parse(text) : JSON.parse(text);
  } catch (e) {
    throw bad("", `not valid ${ext === ".yaml" || ext === ".yml" ? "YAML" : "JSON"} (${e.message.split("\n")[0]})`);
  }
  if (ext === ".storekit" || (doc && typeof doc === "object" && !Array.isArray(doc) && (doc.subscriptionGroups || doc.settings))) {
    const sf = doc?.settings?._storefront ? storefront(doc.settings._storefront) : null;
    if (!sf) throw bad("/settings/_storefront", "names no storefront, so its prices have no currency");
    const code = STOREFRONTS.regions[sf];
    const products = [];
    const take = (p, ptr) => {
      const price = minor(p.displayPrice, code);
      if (!p.productID || price === null) throw bad(ptr, "needs productID and a displayPrice such as \"39.99\"");
      const period = p.recurringSubscriptionPeriod ?? null;
      if (period !== null && !DURATION.test(period)) throw bad(`${ptr}/recurringSubscriptionPeriod`, `${period} is not an ISO 8601 duration such as P1M`);
      const intro = p.introductoryOffer;
      const trial = intro && intro.paymentMode === "free" ? intro.subscriptionPeriod ?? null : null;
      if (trial !== null && !DURATION.test(trial)) throw bad(`${ptr}/introductoryOffer/subscriptionPeriod`, `${trial} is not an ISO 8601 duration`);
      products.push({ product: p.productID, price, digits: digits(code), currency: code, period, trial });
    };
    (doc.subscriptionGroups || []).forEach((g, gi) => (g.subscriptions || []).forEach((p, i) => take(p, `/subscriptionGroups/${gi}/subscriptions/${i}`)));
    (doc.products || []).forEach((p, i) => take(p, `/products/${i}`));
    return { products, currency: code, storefront: sf };
  }
  const list = Array.isArray(doc) ? doc : doc && Array.isArray(doc.products) ? doc.products : null;
  if (!list) throw bad("", "needs a list of products or {products: [...]}");
  const prefix = Array.isArray(doc) ? "" : "/products";
  const products = list.map((p, i) => {
    const ptr = `${prefix}/${i}`;
    if (!p || typeof p !== "object") throw bad(ptr, "must be an object");
    if (typeof p.product !== "string" || !p.product) throw bad(`${ptr}/product`, "must be a product id");
    if (typeof p.currency !== "string" || !isCurrency(p.currency)) throw bad(`${ptr}/currency`, "must be an ISO 4217 code such as EUR");
    const price = minor(p.price, p.currency);
    if (price === null) throw bad(`${ptr}/price`, `must be an amount in ${p.currency} such as 9.99`);
    for (const k of ["period", "trial"]) {
      if (p[k] !== undefined && p[k] !== null && !DURATION.test(p[k])) throw bad(`${ptr}/${k}`, `${p[k]} is not an ISO 8601 duration such as P1M or null`);
    }
    return { product: p.product, price, digits: digits(p.currency), currency: p.currency, period: p.period ?? null, trial: p.trial ?? null };
  });
  const set = [...new Set(products.map((p) => p.currency))];
  return { products, currency: set.length === 1 ? set[0] : null, storefront: null };
}

/**
 * opts: { currency, storefront, prices, rules, allow } as given (strings or null). Returns `{ field, warnings }`;
 * throws UsageError for every D18 case.
 */
function build(opts) {
  let currency = null, region = null;
  if (opts.currency !== null && opts.currency !== undefined) {
    currency = String(opts.currency).toUpperCase();
    if (!isCurrency(currency)) throw new UsageError("invalid-currency", `--currency ${opts.currency} is not an ISO 4217 currency code`, "--currency EUR");
  }
  if (opts.storefront !== null && opts.storefront !== undefined) {
    region = storefront(opts.storefront);
    if (!region) throw new UsageError("invalid-storefront", `--storefront ${opts.storefront} is not an ISO 3166 region`, "--storefront DE");
    const c = STOREFRONTS.regions[region];
    if (currency && currency !== c) {
      throw new UsageError("conflicting-options", `--currency ${currency} disagrees with --storefront ${region}, whose currency is ${c}`, `--storefront ${region} alone, or --currency ${currency} alone`);
    }
    currency = c;
  }
  let products = [];
  if (opts.prices !== null && opts.prices !== undefined) {
    const p = loadPrices(opts.prices);
    products = p.products;
    if (!currency) {
      if (!p.currency) {
        throw new UsageError("missing-currency", `the products in ${opts.prices} are in more than one currency; say which one the storefront charges`, "--currency EUR or --storefront DE");
      }
      currency = p.currency;
      region = region || p.storefront;
    } else if (p.currency && p.currency !== currency) {
      // D36: amounts are never relabeled into another currency.
      throw new UsageError("conflicting-options", `the prices in ${opts.prices} are in ${p.currency}, but the expected currency is ${currency}`, `a price file for that storefront, or --currency ${p.currency}`);
    } else if (!p.currency && !products.some((x) => x.currency === currency)) {
      throw new UsageError("conflicting-options", `no product in ${opts.prices} is in ${currency}`, "a price file for that storefront");
    }
  }
  const field = { rules: opts.rules ? parseRules(opts.rules) : DEFAULT_RULES };
  if (currency) field.currency = currency;
  if (region) field.storefront = region;
  if (products.length) field.products = products;
  if (opts.allow) field.allow = loadAllow(opts.allow);
  return { field };
}

module.exports = { build, loadPrices, parseRules, minor, RULES, DEFAULT_RULES };
