// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 15: JUnit XML. Validated against the vendored Jenkins XSD with xmllint (ships with macOS).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const ci = require("../src/ci");
const F = require("./fixtures/ci-envelopes");

const XSD = path.join(__dirname, "../../../test/fixtures/ci/junit.xsd");

function validates(xml) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-junit-")), "j.xml");
  fs.writeFileSync(f, xml);
  const r = spawnSync("xmllint", ["--noout", "--schema", XSD, f], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

const all = [F.passCheck, F.failCheck, F.skippedCheck, F.errorInput, F.unsupportedInput, F.truncatedFail, F.missing("ja/paywall")];

test("junit: one testsuite per folder, one testcase per check and per finding input", { skip: process.platform !== "darwin" && "xmllint --schema is checked on macOS" }, () => {
  const xml = ci.junit(all);
  validates(xml);
  const suites = [...xml.matchAll(/<testsuite name="([^"]+)" tests="(\d+)" failures="(\d+)" errors="(\d+)" skipped="(\d+)"/g)].map((m) => m.slice(1).join(" "));
  assert.deepEqual(suites, ["shots/de 4 3 0 0", "shots/fr 3 0 1 1", "shots/el 1 0 1 0", "ja 1 1 0 0"]);
  assert.match(xml, /<testsuites name="catscan" tests="9" failures="4" errors="2" time="[\d.]+">/);
  assert.match(xml, /<testcase name="present &quot;Weiter&quot;" classname="shots\/de\/home.png" time="0.100"\/>/);
  // Two failed checks of one image share its time.
  assert.match(xml, /<testcase name="absent &quot;KEY_&quot;" classname="shots\/de\/paywall.png" time="0.050">\n {6}<failure type="absent" message="absent &quot;KEY_&quot;: shown in &quot;KEY_buy&quot; at \[0.1, 0.2, 0.3, 0.4\]">/);
  assert.match(xml, /<skipped message="present &quot;x&quot;: skipped \(catalog-missing\)"\/>/);
  assert.match(xml, /<testcase name="check" classname="shots\/fr\/broken.png" time="0.100">\n {6}<error type="error" message="unreadable-image: not an image">/);
  assert.match(xml, /<testcase name="check" classname="shots\/el\/home.png"[^>]*>\n {6}<error type="unsupported"/);
  // One testcase per finding input, one failure line per finding.
  assert.match(xml, /<testcase name="truncated" classname="shots\/de\/home.png"[^>]*>\n {6}<failure type="truncated" message="truncated \(ellipsis\) &quot;Weiter...&quot; at \[0, 0, 1, 1\]">truncated \(ellipsis\) "Weiter..." at \[0, 0, 1, 1\]\ntruncated/);
  assert.match(xml, /<testcase name="missing: ja\/paywall" classname="ja\/paywall" time="0.000">\n {6}<failure type="missing"/);
});

test("junit: XML escaping of untrusted text and control characters", { skip: process.platform !== "darwin" && "xmllint" }, () => {
  const env = F.base({ command: "check", path: "shots/<a>&\"b\".png", verdict: "fail", checks: [F.absent("]]><x>", "fail", "]]><x>\n'q'")] });
  // Screen text is JSON-quoted in messages; an error text reaches the XML raw, control characters included.
  const err = F.base({ command: "read", path: "shots/c.png", verdict: "error", error: { code: "unreadable-image", message: "bad\u0001\u001f<x>" } });
  const xml = ci.junit([env, err]);
  validates(xml);
  assert.ok(!xml.includes("<x>") && !xml.includes("\u0001"));
  assert.match(xml, /classname="shots\/&lt;a&gt;&amp;&quot;b&quot;.png"/);
  assert.match(xml, /�/);
});

test("junit: GitLab's and CircleCI's documented minimal shape parses (testsuites > testsuite > testcase > failure)", () => {
  // Both read <testcase name classname time> with an optional <failure>, <error> or <skipped> child.
  const xml = ci.junit([F.failCheck]);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites[^>]*>\n {2}<testsuite [^>]*>\n {4}<testcase name="[^"]+" classname="[^"]+" time="[\d.]+">\n {6}<failure /);
});
