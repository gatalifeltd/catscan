// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Runs before anything else loads, so it sticks to syntax an old Node can parse (spec 08 D14): npm only warns on
// engines.node.
var MIN_NODE = 22;
// args.js COMMANDS; preflight cannot load @catscan/core-js on an old Node.
var COMMANDS = ["check", "read", "untranslated", "video", "truncated", "overlap", "formats", "fit", "contrast", "boxes", "languages", "doctor", "serve", "results", "report", "pseudo"];
// args.js OPTIONS with a separate value (unit test checks both lists).
var VALUE_OPTIONS = ["--format", "--locale", "--present", "--absent", "--expect", "--fallback", "--catalog", "--base",
  "--base-locale", "--allow", "--boxes", "--reasons", "--device-profile", "--orientation", "--min-overlap", "--image", "--every", "--from", "--to", "--results", "--build",
  "--build-version", "--layout", "--expect-locales", "--expect-locales-from", "--expect-screens", "--device", "--expect-devices", "--text-size", "--expect-text-sizes", "--out", "--junit",
  "--gitlab-codequality", "--report", "--report-images", "--report-max-edge", "--images-root", "--baseline", "--baseline-ignore",
  "--text-record", "--expand", "--variant", "--kinds", "--level", "--scale", "--known", "--languages", "--dynamic", "--currency", "--storefront", "--prices", "--rules",
  "--min-severity", "--min-certainty"];

/** The unsupported-node diagnostic line for a Node older than MIN_NODE, else null. */
function nodeTooOld(version) {
  var major = Number(String(version).split(".")[0]);
  if (major >= MIN_NODE) return null;
  return "catscan: unsupported-node: Node " + version + " is too old; catscan needs Node " + MIN_NODE +
    " or newer - try: install Node " + MIN_NODE + " or newer from https://nodejs.org";
}

/**
 * What the bin prints on a Node older than MIN_NODE, or null when Node is new enough. `doctor` keeps its own
 * contract there too (D13): exit 1, one `FAIL node` line, or with --json one schema-1 object with ok false.
 */
function preflight(argv, nodeVersion, arch, catscanVersion) {
  var line = nodeTooOld(nodeVersion);
  if (!line) return null;
  // Mirrors args.js: options may come before the command, the first bare word that is no option's value is the
  // command, nothing after `--` is an option, and the last --format wins.
  var end = argv.indexOf("--") >= 0 ? argv.indexOf("--") : argv.length;
  var command = null;
  var format = "text";
  for (var i = 0; i < end; i++) {
    var a = argv[i];
    if (a === "--json") format = "json";
    else if (a === "--format" && i + 1 < end) format = argv[++i];
    else if (a.indexOf("--format=") === 0) format = a.slice(9);
    else if (VALUE_OPTIONS.indexOf(a) >= 0) i++;
    else if (command === null && a.charAt(0) !== "-") command = a;
  }
  if (command !== "doctor") return { code: 5, stdout: "", stderr: line + "\n" };
  var message = "Node " + nodeVersion + " is too old; catscan needs Node " + MIN_NODE + " or newer";
  var advice = "install Node " + MIN_NODE + " or newer from https://nodejs.org";
  if (format !== "json") return { code: 1, stdout: "FAIL node: " + message + " - try: " + advice + "\n", stderr: "" };
  var report = {
    schema: 1, catscan: catscanVersion, engine: null, host: null, fallback: null, binary: null,
    node: { version: nodeVersion, arch: arch },
    checks: [{ name: "node", ok: false, value: message, advice: advice }], ok: false,
  };
  return { code: 1, stdout: JSON.stringify(report) + "\n", stderr: "" };
}

module.exports = { nodeTooOld: nodeTooOld, preflight: preflight, MIN_NODE: MIN_NODE, COMMANDS: COMMANDS, VALUE_OPTIONS: VALUE_OPTIONS };
