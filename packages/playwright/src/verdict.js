// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 13 D10, D18: the one map from a catscan envelope to a matcher outcome, and the error shape every thrown
// error has: `catscan <code>: <what>. Fix: <next step>. See docs/recipes/playwright.md#<anchor>`.
const { CatscanError } = require("@catscan/core-js/src/install");
const { isInternal } = require("@catscan/core-js/src/render");

const RECIPE = "docs/recipes/playwright.md";
// Codes with their own troubleshooting row; every other code points at the shared row (a unit test reads the headings).
const ANCHORS = new Set([
  "readytext-warning", "readytext-not-shown", "needs-reader", "unsupported", "unsupported-platform", "timeout", "vision-timeout",
  "core-timeout", "missing-catalog", "catalog-missing", "boxes-unstable", "playwright-usage", "serve-protocol-mismatch",
  "binary-failed", "check-skipped", "boxes-missing", "overlap-no-boxes", "save-failed", "save-collision",
]);
const anchorFor = (code) => (ANCHORS.has(code) ? code : "other-errors");

// A loop, not /\.+$/: that regex is quadratic on a long run of dots followed by another character (TODO-109).
const trimDot = (s) => {
  const t = String(s ?? "").trim();
  let n = t.length;
  while (n > 0 && t[n - 1] === ".") n--;
  return t.slice(0, n);
};

/** A `CatscanError` in the D18 shape. `hint` is the one command or option that fixes it. */
function fail(code, what, hint, Cls = CatscanError) {
  const anchor = anchorFor(code);
  const e = new Cls(code, `catscan ${code}: ${trimDot(what)}. Fix: ${trimDot(hint) || "see the recipe"}. See ${RECIPE}#${anchor}`, hint);
  e.anchor = anchor;
  return e;
}

/** Elsewhere than macOS on Apple silicon, or with no binary (D8): `onUnsupported: "skip"` turns it into a skip. */
class CatscanUnsupportedPlatformError extends CatscanError {}

/** Any error from core-js (a `CatscanError` or `UsageError` with code and hint) or Node, in the D18 shape. */
function wrap(e) {
  if (e && typeof e.message === "string" && e.message.startsWith("catscan ") && e.anchor) return e;
  const code = (e && typeof e.code === "string" && e.code) || "internal";
  return fail(code, e && e.message ? e.message : String(e), (e && e.hint) || "rerun; if it repeats, run npx catscan doctor");
}

const PLATFORM_CODES = new Set(["unsupported-platform", "unsupported-os", "unsupported-node", "binary-not-found", "binary-version-mismatch"]);

/** A failure to resolve or start the binary: unsupported platform (skippable) or a hard error. */
function startError(e) {
  if (e && PLATFORM_CODES.has(e.code)) return fail(e.code, e.message, e.hint, CatscanUnsupportedPlatformError);
  return wrap(e);
}

/**
 * envelope (+ the Node-side warnings of the request) -> { kind: "pass" | "fail" | "throw" | "unsupported", error? }.
 * A skipped check must never pass; error, internal and protocol envelopes are never retried.
 */
function classify(env, warnings = []) {
  if (!env || typeof env !== "object") return { kind: "throw", error: fail("internal", "catscan-core sent no envelope", "rerun; if it repeats, run npx catscan doctor") };
  if (!env.verdict || env.verdict === "error" || isInternal(env)) {
    const er = env.error || { code: "internal", message: "malformed response" };
    return { kind: "throw", error: fail(er.code || "internal", er.message, er.hint || "rerun; if it repeats, run npx catscan doctor") };
  }
  // TODO-065: catscan reads this locale once its reader is installed, so the test fails with the install hint;
  // onUnsupported: "skip" is for hosts catscan cannot run on (spec 13 D8), never for this.
  if (env.verdict === "needs-reader") {
    const er = env.error || {};
    return { kind: "throw", error: fail("needs-reader", er.message || `catscan reads the locale ${env.locale} with a reader that is not installed`, er.hint || "npx catscan doctor --expect-locales " + env.locale) };
  }
  if (env.verdict === "unsupported") {
    const er = env.error || {};
    return { kind: "unsupported", error: fail("unsupported", er.message || `catscan cannot read the locale ${env.locale}`, er.hint || "pass locale, or run npx catscan languages") };
  }
  const missing = [...warnings, ...(env.warnings || [])].find((w) => w && w.code === "catalog-missing");
  if (missing) return { kind: "throw", error: fail("catalog-missing", missing.message, missing.hint || "add the catalog file for this locale") };
  const skipped = (env.checks || []).find((c) => c.verdict === "skipped");
  if (skipped) {
    const why = skipped.reason ? ` (${skipped.reason})` : "";
    const file = skipped.catalog ? ` from ${skipped.catalog}` : "";
    return { kind: "throw", error: fail("check-skipped", `the check ${JSON.stringify(skipped.key ? `@${skipped.key}` : skipped.text)}${file} was skipped${why}; a skipped check never passes`, "check the catalog entry, or assert the shown text instead") };
  }
  if (env.verdict === "fail") return { kind: "fail" };
  if (env.verdict === "pass") return { kind: "pass" };
  return { kind: "throw", error: fail("internal", `unknown verdict ${env.verdict}`, "upgrade @catscan/playwright to match @catscan/core-js") };
}

module.exports = { classify, fail, wrap, startError, CatscanError, CatscanUnsupportedPlatformError, RECIPE, ANCHORS, anchorFor };
