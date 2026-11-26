// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Envelopes for the spec 15 report tests: private paths, as the CLI hands them to src/ci.js.
const base = (o) => ({ schema: 1, catscan: "0.0.0", engine: "vision-accurate-rev3", locale: "de", image: null, host: null, ms: 100, checks: [], warnings: [], ...o });

const present = (text, verdict, extra = {}) => ({ kind: "present", text, verdict, box: verdict === "pass" ? [0, 0, 1, 1] : null, line: verdict === "pass" ? text : null, confidence: 1, ...(verdict === "fail" ? { closest: null } : {}), ...extra });
const absent = (text, verdict, line = text) => ({ kind: "absent", text, verdict, box: verdict === "fail" ? [0.1, 0.2, 0.3, 0.4] : null, line: verdict === "fail" ? line : null, confidence: 1 });

const passCheck = base({ command: "check", path: "shots/de/home.png", verdict: "pass", checks: [present("Weiter", "pass")] });
const failCheck = base({ command: "check", path: "shots/de/paywall.png", verdict: "fail", checks: [present("Weiter", "fail"), absent("KEY_", "fail", "KEY_buy")] });
const skippedCheck = base({ command: "check", path: "shots/fr/home.png", verdict: "pass", locale: "fr", checks: [present("Suivant", "pass"), { ...present("x", "skipped"), reason: "catalog-missing" }] });
const errorInput = base({ command: "check", path: "shots/fr/broken.png", verdict: "error", locale: "fr", error: { code: "unreadable-image", message: "not an image" } });
const unsupportedInput = base({ command: "check", path: "shots/el/home.png", verdict: "unsupported", locale: "el", engine: null, checks: [{ ...present("Συνέχεια", "unsupported") }] });
const truncatedFail = base({ command: "truncated", path: "shots/de/home.png", verdict: "fail", findings: [
  { kind: "truncated", box: [0, 0, 1, 1], line: "Weiter...", reason: "ellipsis", element: null, expected: null, confidence: 1 },
  { kind: "truncated", box: [0, 0, 1, 1], line: "Weiter...", reason: "ellipsis", element: null, expected: null, confidence: 1 },
] });
const missing = (p) => base({ command: "check", path: null, verdict: "fail", engine: null, locale: p.split("/")[0], screen: p.split("/")[1], ms: 0,
  findings: [{ kind: "missing", box: null, expected_path: p }] });

module.exports = { base, present, absent, passCheck, failCheck, skippedCheck, errorInput, unsupportedInput, truncatedFail, missing };
