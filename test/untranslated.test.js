// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 17 golden test through the CLI and real Vision: 10 synthetic de screens drawn from hand-written
// strings, each with its expected findings written by hand (test/fixtures/untranslated/expected.json).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");
const { Server } = require("../packages/core-js/src/client");

setup();
const U = path.join(__dirname, "fixtures/untranslated");
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-untranslated-"));
execFileSync(path.join(ROOT, ".build/synth"), [path.join(U, "screens.json"), shots]);
const EXPECTED = require("./fixtures/untranslated/expected.json");
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));
const BASE = ["--locale", "de", "--base", path.join(U, "en.json"), "--catalog", path.join(U, "de.json")];
const shot = (n) => path.join(shots, `${n}.png`);
// Vision reads `{{count}}` as `‹{count}}`, so a placeholder is compared by the name inside its token.
const label = (f) => [f.kind, f.kind === "placeholder" ? f.token.replace(/[^%\w]/g, "") : f.key ?? f.line];

test("golden: every synthetic screen gives exactly its expected findings", () => {
  const r = cli(["untranslated", shots, ...BASE, "--json"]);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.length, Object.keys(EXPECTED).length);
  for (const env of r.json) {
    const name = path.basename(env.path, ".png");
    assert.ok(validate(env), `${name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(env.command, "untranslated");
    const want = EXPECTED[name].map(([k, v]) => [k, k === "placeholder" ? v.replace(/[^%\w]/g, "") : v]);
    assert.deepEqual(env.findings.map(label), want, name);
    assert.equal(env.verdict, want.length ? "fail" : "pass", name);
  }
  const missing = r.json.find((e) => e.path.endsWith("u07-missing.png")).findings[0];
  assert.equal(missing.expected, null);
  assert.equal(missing.catalog, path.join(U, "de.json"));
});

test("exit 0 on a clean screen; the allow list and the {locale} template", () => {
  assert.equal(cli(["untranslated", shot("u01-clean"), ...BASE]).code, 0);
  const allow = path.join(shots, "allow.txt");
  fs.writeFileSync(allow, "# product terms\nStart your free trial\n");
  assert.equal(cli(["untranslated", shot("u08-cta"), ...BASE, "--allow", allow]).code, 0);
  const t = cli(["untranslated", shot("u02-privacy"), "--locale", "de", "--base", path.join(U, "en.json"), "--catalog", path.join(U, "{locale}.json"), "--json"]);
  assert.equal(t.code, 1, t.stderr);
  assert.deepEqual(t.json[0].findings.map(label), [["untranslated", "settings.privacy"]]);
});

test("catalog-free run: raw keys and placeholders without --base (D23)", () => {
  const r = cli(["untranslated", shot("u04-raw-key"), shot("u05-placeholder"), "--locale", "de", "--json"]);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json.map((e) => e.findings.map((f) => f.kind)), [["raw-key"], ["placeholder"]]);
});

// TODO-036 D21: the fixture screens are de screens; under --locale en wrong-language rightly flags them, so this
// test about the base-catalog warning opts out of it.
const NO_WL = ["--kinds", "untranslated,raw-key,placeholder"];
test("the base catalog as target: rule off, said in every envelope and under --quiet (D16, D27, D31)", () => {
  const r = cli(["untranslated", shot("u02-privacy"), shot("u01-clean"), "--locale", "en", "--base", path.join(U, "en.json"), "--catalog", path.join(U, "{locale}.json"), ...NO_WL, "--json", "--quiet"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.length, 2); // --quiet hides passes in text only
  for (const env of r.json) assert.deepEqual(env.warnings.map((w) => w.code), ["untranslated-base-catalog"]);
  assert.equal(r.stderr.match(/untranslated-base-catalog/g).length, 1);
  const q = cli(["untranslated", shot("u02-privacy"), "--locale", "en", "--base", path.join(U, "en.json"), "--catalog", path.join(U, "{locale}.json"), ...NO_WL, "--quiet"]);
  assert.match(q.stderr, /catscan: untranslated-base-catalog: /);
  assert.doesNotMatch(q.stdout, /PASS/);
});

test("text output names the key, the file to fix and the expected string (D24)", () => {
  const r = cli(["untranslated", shot("u02-privacy"), ...BASE]);
  assert.match(r.stdout, /^FAIL  .*u02-privacy\.png\n  major\/medium  untranslated @settings\.privacy "Privacy" \(.*de\.json: "Datenschutz"\) in "Privacy" at \[/m);
});

test("serve: an untranslated request through the client; a malformed one is invalid-request (D21, D28)", async () => {
  const s = new Server();
  await s.ready;
  const ok = await s.request({ id: "u1", command: "untranslated", path: shot("u02-privacy"), locale: "de", untranslated: {
    base_locale: "en", pairs: [{ key: "p", catalog: null, base: "Privacy", expected: "Datenschutz", base_alternatives: [["Privacy"]], target_alternatives: [["Datenschutz"]] }],
  } });
  assert.deepEqual(ok.findings.map((f) => [f.kind, f.key]), [["untranslated", "p"]]);
  // D32: a digest sent with the full field stands for it later in the same process; an unknown one is refused.
  const field = { base_locale: "en", digest: "d1", pairs: [{ key: "p", catalog: null, base: "Privacy", expected: "Datenschutz", base_alternatives: [["Privacy"]], target_alternatives: [["Datenschutz"]] }] };
  await s.request({ id: "u3", command: "untranslated", path: shot("u01-clean"), locale: "de", untranslated: field });
  const again = await s.request({ id: "u4", command: "untranslated", path: shot("u02-privacy"), locale: "de", untranslated: { digest: "d1" } });
  assert.deepEqual(again.findings.map((f) => f.key), ["p"]);
  const unknown = await s.request({ id: "u5", command: "untranslated", path: shot("u02-privacy"), untranslated: { digest: "nope" } });
  assert.equal(unknown.error.code, "invalid-request");
  const bad = await s.request({ id: "u2", command: "untranslated", path: shot("u02-privacy"), untranslated: { base_locale: "en", styles: ["%q"] } });
  assert.equal(bad.error.code, "invalid-request");
  assert.match(bad.error.message, /unknown style %q/);
  await s.close();
});

test("schema: a finding missing a per-kind field fails validation (D25)", () => {
  const r = cli(["untranslated", shot("u09-mixed"), ...BASE, "--json"]);
  const env = r.json[0];
  assert.ok(validate(env), JSON.stringify(validate.errors));
  for (const [kind, field] of [["untranslated", "expected"], ["untranslated", "catalog"], ["placeholder", "token"]]) {
    const broken = structuredClone(env);
    delete broken.findings.find((f) => f.kind === kind)[field];
    assert.equal(validate(broken), false, `${kind} without ${field}`);
  }
  assert.equal(validate({ ...env, findings: [{ kind: "raw-key", box: null }] }), false, "raw-key without line");
  assert.ok(validate({ ...env, findings: [{ kind: "raw-key", box: null, line: "settings support", key: "settings.support" }] }), "raw-key with key");
  assert.ok(validate({ ...env, findings: [{ kind: "raw-key", box: null, line: "a b", keys: ["a.b", "a_b"] }] }), "raw-key with keys");
});

test("each catalog warning is printed once; a serve pair without expected is invalid-request (D28)", async () => {
  const r = cli(["untranslated", shot("u02-privacy"), ...BASE, "--catalog", path.join(U, "de.json")]);
  assert.equal((r.stderr.match(/catalog-duplicate-key/g) || []).length, 1, r.stderr);
  const s = new Server();
  try {
    await s.ready;
    const bad = await s.request({ id: "u6", command: "untranslated", path: shot("u02-privacy"), untranslated: {
      base_locale: "en", pairs: [{ key: "p", catalog: null, base: "Privacy", base_alternatives: [["Privacy"]], target_alternatives: [] }],
    } });
    assert.equal(bad.error?.code, "invalid-request", JSON.stringify(bad));
  } finally { await s.close(); }
});
