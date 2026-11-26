// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 15 D5: doctor --json carries `ci` from the run.ci detector and `neural_engine` from the core.
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const doctor = require("../src/doctor");
const { ciInfo } = require("../src/results");

const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../../../core/schema/doctor.schema.json"));

const MARKERS = [
  ["github-actions", { GITHUB_ACTIONS: "true", ImageOS: "macos15", GITHUB_SHA: "abc", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "7" }, "macos15"],
  ["gitlab-ci", { GITLAB_CI: "true", CI_RUNNER_DESCRIPTION: "saas-macos-medium-m1" }, "saas-macos-medium-m1"],
  ["circleci", { CIRCLECI: "true" }, null],
  ["bitrise", { BITRISE_IO: "true" }, null],
  ["codemagic", { CM_BUILD_ID: "b1" }, null],
  ["azure-pipelines", { TF_BUILD: "True", AGENT_NAME: "Hosted Agent" }, "Hosted Agent"],
  ["buildkite", { BUILDKITE: "true", BUILDKITE_AGENT_NAME: "mini-1" }, "mini-1"],
  ["jenkins", { JENKINS_URL: "http://j", NODE_NAME: "mac" }, "mac"],
];

// A doctor run with every probe faked: no binary, so only the Node checks and the env-derived fields.
const run = (env) => doctor.report({ env, platform: "darwin", arch: "arm64", release: "25.0.0", nodeVersion: "26.13.0", translated: () => false, resolve: () => null, exists: () => false });

test("doctor --json: ci for every provider row, null outside CI, first in table order wins", () => {
  for (const [provider, env, runner] of MARKERS) {
    const r = run(env);
    assert.equal(r.ci.provider, provider);
    assert.equal(r.ci.runner, runner);
    assert.deepEqual(r.ci, ciInfo(env));
    assert.ok(validate(r), JSON.stringify(validate.errors));
  }
  const none = run({});
  assert.equal(none.ci, null);
  assert.ok(validate(none), JSON.stringify(validate.errors));
  // Two set: the earlier table row wins, whatever the order of the variables.
  assert.equal(run({ JENKINS_URL: "http://j", GITLAB_CI: "true" }).ci.provider, "gitlab-ci");
  assert.equal(run({ BUILDKITE: "true", CIRCLECI: "true", GITHUB_ACTIONS: "true" }).ci.provider, "github-actions");
});

test("doctor --json: neural_engine comes from the core and the schema allows only present, absent, unknown", () => {
  const info = { schema: 1, catscan: "0.0.0", engine: "vision", host: { chip: "Apple M2 Pro (Virtual)", arch: "arm64", host_class: "vm", macos: "15.6 (24G84)", vision_revision: 3 },
    fallback: { engine: null, path: null, version: null, tessdata: null, packs: [], searched: [], locales: [] },
    neural_engine: "absent", vision: { revision: 3, languages: { accurate: 30, fast: 10 } }, self_test: { ms: 40, pass: true } };
  const r = doctor.report({ env: { GITHUB_ACTIONS: "true", ImageOS: "macos15" }, platform: "darwin", arch: "arm64", release: "24.6.0", nodeVersion: "26.13.0", translated: () => false,
    resolve: () => ({ path: "/x/catscan-core", source: "build", version: null }), exists: () => true, core: () => info, binaryArch: () => "arm64", version: "0.0.0" });
  assert.equal(r.neural_engine, "absent");
  assert.equal(r.host.host_class, "vm");
  assert.deepEqual([r.ci.provider, r.ci.runner], ["github-actions", "macos15"]);
  assert.ok(validate(r), JSON.stringify(validate.errors));
  assert.ok(!validate({ ...r, neural_engine: "yes" }));
});
