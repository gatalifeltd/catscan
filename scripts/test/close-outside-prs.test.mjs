// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 25 D14: the github-script step of close-outside-prs.yml, run as written with fake `github` and `context`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// The lab keeps it under public/ (D16); the product repo has it at .github/workflows/.
const WF = ["public/.github/workflows/close-outside-prs.yml", ".github/workflows/close-outside-prs.yml"].map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f));

/** The `script: |` block scalar of the workflow, dedented. */
function script() {
  const lines = fs.readFileSync(WF, "utf8").split("\n");
  const start = lines.findIndex((l) => /^\s+script: \|\s*$/.test(l));
  assert.ok(start > 0, "close-outside-prs.yml has a script: | block");
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && !/^\s{12}/.test(l)) break;
    body.push(l.slice(12));
  }
  return body.join("\n");
}

async function run(association, payload = { pull_request: { number: 7, author_association: association } }, commentFails = false) {
  const calls = [];
  const github = { rest: {
    issues: { createComment: async (a) => { calls.push(["comment", a]); if (commentFails) throw new Error("rate limited"); } },
    pulls: { update: async (a) => calls.push(["update", a]) },
  } };
  const warnings = [];
  const context = { payload, repo: { owner: "gatalifeltd", repo: "catscan" } };
  const AsyncFunction = (async () => {}).constructor;
  const result = await new AsyncFunction("github", "context", "core", script())(github, context, { warning: (m) => warnings.push(m) });
  return { result, calls, warnings };
}

// Value: protects=outside pull requests are answered and closed while maintainers' are left alone; fails_when=an outside author_association is kept open, an insider's PR is closed, or the close happens without the comment; why_new=the workflow is new and GitHub cannot be called in a test; seam=fake github/context objects stand in for actions/github-script; no_claim=GitHub permissions or the live event
test("outside authors get the comment and the close; owners, members and collaborators are left alone", async () => {
  for (const a of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN"]) {
    const { result, calls } = await run(a);
    assert.equal(result, "closed", a);
    assert.deepEqual(calls.map((c) => c[0]), ["update", "comment"], a);
    assert.deepEqual(calls[0][1], { owner: "gatalifeltd", repo: "catscan", pull_number: 7, state: "closed" });
    assert.equal(calls[1][1].issue_number, 7);
    assert.match(calls[1][1].body, /does not accept outside code/);
    assert.match(calls[1][1].body, /https:\/\/github\.com\/gatalifeltd\/catscan\/issues\/new\/choose/);
  }
  for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    const { result, calls } = await run(a);
    assert.equal(result, "kept", a);
    assert.deepEqual(calls, [], a);
  }
  assert.equal((await run("NONE", {})).result, "kept");
  // A failed comment still leaves the pull request closed.
  const failed = await run("NONE", undefined, true);
  assert.equal(failed.result, "closed");
  assert.equal(failed.calls[0][0], "update");
  assert.match(failed.warnings.join(), /comment failed/);
});
