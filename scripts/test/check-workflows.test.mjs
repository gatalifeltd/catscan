// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 25 workflow hardening (D4, D14, D16): each rule has a failing fixture; the repo's own workflows pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDir, checkWorkflow } from "../check-workflows.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const wf = ({ on = "push", perms = "permissions:\n  contents: read\n", runsOn = "macos-26", steps = `      - uses: actions/checkout@${SHA} # v7.0.1\n      - run: npm test\n`, jobPerms = "" } = {}) =>
  `name: t\non: ${on}\n${perms}jobs:\n  build:\n    runs-on: ${runsOn}\n${jobPerms}    steps:\n${steps}`;

test("a pinned, scoped, hosted workflow passes in both modes", () => {
  assert.deepEqual(checkWorkflow("ci.yml", wf(), { product: true }), []);
  assert.deepEqual(checkWorkflow("ci.yml", wf({ perms: "", jobPerms: "    permissions:\n      contents: read\n" }), { product: true }), []);
});

test("a tag-pinned action fails", () => {
  assert.match(checkWorkflow("ci.yml", wf({ steps: "      - uses: actions/checkout@v7\n" })).join(), /not pinned by a full commit SHA/);
  assert.match(checkWorkflow("ci.yml", wf({ steps: "      - uses: docker://alpine:3\n" })).join(), /not pinned by digest/);
});

test("a job without permissions fails when the workflow sets none", () => {
  assert.match(checkWorkflow("ci.yml", wf({ perms: "" })).join(), /job build declares no permissions/);
});

test("pull_request_target outside close-outside-prs.yml fails", () => {
  assert.match(checkWorkflow("ci.yml", wf({ on: "[push, pull_request_target]" })).join(), /allowed only in close-outside-prs\.yml/);
  assert.match(checkWorkflow("ci.yml", wf({ on: "\n  pull_request_target:\n    types: [opened]" })).join(), /allowed only/);
  assert.deepEqual(checkWorkflow("ci.yml", wf({ on: "push # not pull_request_target" })), []);
});

test("close-outside-prs.yml with a checkout or a run: step fails", () => {
  const e = checkWorkflow("close-outside-prs.yml", wf({ on: "pull_request_target" })).join("\n");
  assert.match(e, /must not check out code/);
  assert.match(e, /must have no run: step/);
});

test("a self-hosted runs-on fails in product mode only", () => {
  for (const runsOn of ["[self-hosted, macOS]", "self-hosted", "\n      - self-hosted\n      - macOS", "${{ fromJSON('[\"self-hosted\"]') }}"]) {
    assert.match(checkWorkflow("ci.yml", wf({ runsOn }), { product: true }).join(), /self-hosted runner/, runsOn);
    assert.deepEqual(checkWorkflow("ci.yml", wf({ runsOn })), [], runsOn);
  }
});

test("actions/cache in the release workflow fails", () => {
  const steps = `      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n`;
  assert.match(checkWorkflow("release.yml", wf({ steps })).join(), /must not use actions\/cache/);
  assert.deepEqual(checkWorkflow("ci.yml", wf({ steps })), []);
});

// In the product repo (no scripts/public-paths.txt, spec 25 D1) the same workflows are checked in product mode.
test("the repo's own workflows pass: lab mode in the lab, product mode in the product repo", () => {
  const product = !fs.existsSync(path.join(ROOT, "scripts/public-paths.txt"));
  assert.deepEqual(checkDir(path.join(ROOT, ".github/workflows"), { product }).errors, []);
  if (!product && fs.existsSync(path.join(ROOT, "public/.github/workflows"))) {
    assert.deepEqual(checkDir(path.join(ROOT, "public/.github/workflows"), { product: true }).errors, []);
  }
});

// Value: protects=per-job permissions split and the close-outside-prs.yml exemption; fails_when=job blocks merge so one job's permissions cover another, a nested with.permissions counts as job permissions, or close-outside-prs.yml is flagged for its own pull_request_target or pinned local/docker refs fail; why_new=existing fixtures have one job and close-outside-prs.yml is only tested failing; seam=none; no_claim=real YAML parsing
test("permissions are checked per job, and a clean close-outside-prs.yml passes", () => {
  const two = `name: t\non: push\njobs:\n  a:\n    runs-on: macos-26\n    permissions:\n      contents: read\n    steps:\n      - run: x\n  b:\n    runs-on: macos-26\n    steps:\n      - uses: ./local-action\n        with:\n          permissions: read\n      - uses: docker://alpine@sha256:${"a".repeat(64)}\n`;
  const e = checkWorkflow("ci.yml", two);
  assert.equal(e.length, 1, e.join("\n"));
  assert.match(e[0], /^ci\.yml:10: job b declares no permissions/);
  const close = wf({ on: "pull_request_target", steps: `      - uses: actions/github-script@${SHA} # v9.0.0\n        with:\n          script: close()\n` });
  assert.deepEqual(checkWorkflow("close-outside-prs.yml", close, { product: true }), []);
});

// Value: protects=the CI contract of check-workflows (exit 1 on a finding, 0 when clean, 2 without a dir); fails_when=the CLI prints errors but exits 0, so the docs.yml step goes green on a tag-pinned action; why_new=tests call checkWorkflow directly and never the CLI that docs.yml runs; seam=none; no_claim=GitHub Actions runtime
test("the CLI exits 1 on a finding, 0 when clean and 2 without a directory", async () => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const cli = path.join(ROOT, "scripts/check-workflows.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wf-"));
  fs.writeFileSync(path.join(dir, "ci.yml"), wf());
  assert.equal(spawnSync(process.execPath, [cli, dir]).status, 0);
  fs.writeFileSync(path.join(dir, "bad.yaml"), wf({ steps: "      - uses: actions/checkout@v7\n" }));
  const bad = spawnSync(process.execPath, [cli, "--product", dir], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /bad\.yaml:\d+: actions\/checkout@v7 is not pinned/);
  assert.equal(spawnSync(process.execPath, [cli]).status, 2);
});

// Value: protects=no workflow grants write-all; fails_when=the write-all check is dropped; why_new=only the presence of permissions was checked (review finding); seam=none; no_claim=minimality of named scopes
test("permissions: write-all fails at workflow or job level", () => {
  assert.match(checkWorkflow("ci.yml", wf({ perms: "permissions: write-all\n" })).join(), /write-all is never minimal/);
  assert.match(checkWorkflow("ci.yml", wf({ perms: "", jobPerms: "    permissions: write-all\n" })).join(), /write-all is never minimal/);
  assert.match(checkWorkflow("ci.yml", wf({ perms: "permissions: \"write-all\"\n" })).join(), /write-all is never minimal/);
});

// Value: protects=product runs-on accepts only GitHub-hosted labels; fails_when=a matrix expression, a runner group or a custom label reaches the owner's runner; why_new=adversarial finding: the old check matched only the literal self-hosted; seam=none; no_claim=GitHub's label resolution
test("product mode refuses expressions, groups and custom labels in runs-on", () => {
  for (const runsOn of ["${{ matrix.r }}", "catscan", "\n      group: mine", "[macos-26, catscan]", "ubuntu-self-hosted", "macos-26-selfhosted"]) {
    assert.match(checkWorkflow("ci.yml", wf({ runsOn }), { product: true }).join(), /runs-on must name GitHub-hosted labels only/, runsOn);
  }
  for (const runsOn of ["macos-26", "ubuntu-24.04", "ubuntu-24.04-arm", "macos-15-intel", "[macos-26]", "\n      - macos-15", "macos-26 # note"]) assert.deepEqual(checkWorkflow("ci.yml", wf({ runsOn }), { product: true }), [], runsOn);
});

// Value: protects=the product test matrix over the promised macOS lines passes, while a matrix that can reach another runner fails; fails_when=matrix.os resolution trusts an include, a computed matrix or another job's list; why_new=public CI spans macos-15 and macos-26; seam=none; no_claim=GitHub's matrix expansion
test("product mode resolves runs-on: ${{ matrix.os }} only from the job's literal hosted list", () => {
  const job = (matrix) => `name: t\non: push\npermissions:\n  contents: read\njobs:\n  build:\n    strategy:\n      fail-fast: false\n      matrix:\n${matrix}    runs-on: \${{ matrix.os }}\n    steps:\n      - run: npm test\n`;
  for (const ok of ["        os: [macos-15, macos-26]\n        node: [22.23.5, 26.13.0]\n", "        node: [22]\n        os: ['macos-26'] # note\n        exclude:\n          - os: macos-26\n"]) {
    assert.deepEqual(checkWorkflow("ci.yml", job(ok), { product: true }), [], ok);
  }
  for (const bad of ["        os: [macos-26, catscan]\n", "        os: [macos-26]\n        include:\n          - os: catscan\n", "        os: ${{ fromJSON(vars.OS) }}\n",
    "        os:\n          - macos-26\n", "        node: [22]\n", "        os: [macos-26, self-hosted]\n",
    "        os: [macos-26]\n        include :\n          - os: catscan\n", "        os: [macos-26]\n        'include':\n          - os: catscan\n",
    "        os: [macos-26]\n        \"incl\\u0075de\":\n          - os: catscan\n", "        os: [macos-26]\n        <<: *more\n",
    "        os: [macos-26]\n        node: [22]\n          - os: catscan\n", "        os: &l [macos-26]\n", "        os: [macos-26]\n        {include: [{os: catscan}]}\n"]) {
    assert.match(checkWorkflow("ci.yml", job(bad), { product: true }).join(), /runs-on must name GitHub-hosted labels only/, bad);
  }
  const noStrategy = `name: t\non: push\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: \${{ matrix.os }}\n    steps:\n      - run: x\n  other:\n    strategy:\n      matrix:\n        os: [macos-26]\n    runs-on: macos-26\n    steps:\n      - run: x\n`;
  assert.match(checkWorkflow("ci.yml", noStrategy, { product: true }).join(), /job build may run on a self-hosted runner/);
  // A one-line matrix is never read as a block: its job-level siblings are not the matrix (red-team review).
  const oneLine = `name: t\non: push\npermissions:\n  contents: read\njobs:\n  build:\n    strategy:\n      matrix: \${{ fromJSON(vars.M) }}\n    needs: [ubuntu-24]\n    runs-on: \${{ matrix.needs }}\n    steps:\n      - run: x\n`;
  assert.match(checkWorkflow("ci.yml", oneLine, { product: true }).join(), /job build may run on a self-hosted runner/);
  // A quoted matrix key is refused too: plain names only, so no YAML spelling of include can slip through.
  assert.match(checkWorkflow("ci.yml", job("        \"os\" : [macos-15, macos-26]\n"), { product: true }).join(), /self-hosted runner/);
});

// Value: protects=TODO-066 D3-D7, no dependency install script or import runs on a runner the owner's Mac can serve before an unconditional audit, and installs there come only from the audited lockfile; fails_when=a rule is dropped, a multi-line block or an alias slips past, a conditional audit counts, or runner inference falls back to the literal self-hosted; why_new=no install rule existed; seam=none; no_claim=real YAML parsing and npm's alias list beyond the ones named
test("lab mode: installs skip scripts, follow an unconditional audit, and come from the lockfile on a Mac-reachable job", () => {
  const AUDIT = "      - run: node scripts/check-audit.mjs\n";
  const ok = (cmd) => `${AUDIT}      - run: ${cmd}\n`;
  const errs = (steps, runsOn = "[self-hosted, macOS]") => checkWorkflow("ci.yml", wf({ runsOn, steps }));
  const pass = [
    ok("npm ci --ignore-scripts"),
    ok("npm ci --ignore-scripts --no-audit && npm run build"),
    ok("npm cit --ignore-scripts=true"),
    `${AUDIT}      - name: x\n        run: |\n          set -e\n          npm clean-install --ignore-scripts\n`,
    `      - run: npx --no playwright install chromium && npm run build\n      - run: echo "failed (checkout, install or build)"\n`,
    ok("npm init -y >/dev/null 2>&1"),
    ok("npm audit --omit=dev && npm test 2>&1 | tee log && npm --version"),
    `${AUDIT}      -   name: wide\n          run: npm ci --ignore-scripts\n`,
    ok("npm rebuild --ignore-scripts"),
    `      - run: node scripts/check-audit.mjs\n        continue-on-error: false\n      - run: npm ci --ignore-scripts\n`,
    `      - run: node scripts/check-audit.mjs\n        continue-on-error: "false"\n      - run: npm ci --ignore-scripts\n`,
    `${AUDIT}      - run: |\n          npm ci \\\n            --ignore-scripts\n`,
    `${AUDIT}      - uses: actions/github-script@${SHA}\n        with:\n          script: npm ci\n      - run: |\n          echo ok\n        env:\n          X: npm ci\n`,
    ok("npm init -y"),
  ];
  for (const steps of pass) assert.deepEqual(errs(steps), [], steps);
  const fail = [
    [ok("npm ci"), /^ci\.yml:\d+: install-scripts: npm ci runs dependency install scripts; fix: add --ignore-scripts to this npm ci$/],
    [ok("npm run build --ignore-scripts && npm ci"), /install-scripts: npm ci/],
    [ok("npm rebuild"), /install-scripts: npm rebuild/],
    [`${AUDIT}      - run: |\n          cd x\n          npm cit\n`, /install-scripts: npm cit/],
    ["      - run: npm ci --ignore-scripts\n", /audit-before-install: npm ci runs before the npm audit.*fix: add the step "- run: node scripts\/check-audit\.mjs"/],
    [`      - run: npm ci --ignore-scripts\n${AUDIT}`, /audit-before-install: npm ci runs before/],
    [`      - if: github.event_name == 'push'\n        run: node scripts/check-audit.mjs\n      - run: npm ci --ignore-scripts\n`, /audit-before-install: this audit step does not stop the job/],
    [`      - run: node scripts/check-audit.mjs\n        continue-on-error: true\n      - run: npm ci --ignore-scripts\n`, /this audit step does not stop the job/],
    ["      - run: node scripts/check-audit.mjs || true\n      - run: npm ci --ignore-scripts\n", /this audit step does not stop the job/],
    [`${AUDIT}      - if: always()\n        run: npm ci --ignore-scripts\n`, /audit-before-install: if: always\(\) runs this install after a failed audit/],
    [ok("npm install left-pad --ignore-scripts"), /lockfile-install: npm install can resolve packages the lockfile audit never saw.*fix: use npm ci --ignore-scripts/],
    [ok("npm i x --ignore-scripts"), /lockfile-install: npm i /],
    [ok("npm i x"), /install-scripts: npm i runs/],
    // Review pass 1: quoted scalars, folded conditions, prefixes, options before the subcommand, aliases, fetches.
    [`${AUDIT}      - run: "npm ci"\n`, /install-scripts: npm ci/],
    [`${AUDIT}      - run: 'npm ci --ignore-scripts false'\n`, /install-scripts: npm ci/],
    [`${AUDIT}      - if: >-\n          always()\n        run: npm ci --ignore-scripts\n`, /if: always\(\) runs this install after a failed audit/],
    [`${AUDIT}      - run: npm ci --ignore-scripts\n        if: failure()\n`, /^ci\.yml:11: audit-before-install: if: failure\(\)/m],
    [ok("CI=1 npm ci"), /install-scripts: npm ci/],
    [ok("if true; then npm ci; fi"), /install-scripts: npm ci/],
    [ok("sudo npm ci"), /install-scripts: npm ci/],
    [ok("x=`npm ci`"), /install-scripts: npm ci/],
    [ok('bash -c "npm ci"'), /install-scripts: npm ci/],
    [ok("npm --prefix spike ci"), /install-scripts: npm ci/],
    [ok("npm -w pkg ci"), /install-scripts: npm ci/],
    [`${AUDIT}      - run: |\n          npm \\\n            ci\n`, /install-scripts: npm ci/],
    [ok("npm ic"), /install-scripts: npm ic/],
    [ok("npm rb"), /install-scripts: npm rb/],
    [ok("npm update --ignore-scripts"), /lockfile-install: npm update/],
    [ok("npm add x --ignore-scripts"), /lockfile-install: npm add/],
    [ok("npx -y some-pkg@1"), /lockfile-install: npx/],
    [ok("npm exec -- some-pkg"), /lockfile-install: npm exec/],
    [ok("npm init some-initializer"), /lockfile-install: npm init/],
    [ok("pnpm install"), /lockfile-install: pnpm is not covered/],
    [ok("corepack yarn install"), /lockfile-install: corepack is not covered/],
    [ok("bunx some-pkg"), /lockfile-install: bunx is not covered/],
    ["      - { run: npm ci }\n", /install-scripts: a flow-style step/],
    // Review pass 2: fail closed on any npm/npx word, whatever precedes it; tree-reifying subcommands are installs.
    [ok('echo "failed (checkout, npm ci or build)"'), /install-scripts: npm ci/],
    [ok("if npm ci; then :; fi"), /install-scripts: npm ci/],
    [`${AUDIT}# a column-0 comment\n      - run: npm ci\n`, /install-scripts: npm ci/],
    [ok("if ! npm ci; then exit 1; fi"), /install-scripts: npm ci/],
    [ok("{ npm ci; }"), /install-scripts: npm ci/],
    [ok("timeout 600 npm ci"), /install-scripts: npm ci/],
    [ok("arch -arm64 npm ci"), /install-scripts: npm ci/],
    [ok("/opt/homebrew/bin/npm ci"), /install-scripts: npm ci/],
    [ok("echo a & npm ci"), /install-scripts: npm ci/],
    [ok('npm exec --no -- sh -c "npm ci"'), /install-scripts: npm ci/],
    [ok("npm audit fix"), /lockfile-install: npm audit/],
    [ok("npm dedupe --ignore-scripts"), /lockfile-install: npm dedupe/],
    [ok("npm link"), /install-scripts: npm link/],
    [ok("npm uninstall x --ignore-scripts"), /lockfile-install: npm uninstall/],
    [ok("npx some-pkg --no"), /lockfile-install: npx/],
    [ok("npm ci --ignore-scripts --ignore-scripts=false"), /install-scripts: npm ci/],
    [`${AUDIT}      - run: npm\n          ci\n`, /install-scripts: npm ci/],
    // The audit is per job: one job's audit never clears another job's install.
    [`${AUDIT}  other:\n    runs-on: [self-hosted, macOS]\n    steps:\n      - run: npm ci --ignore-scripts\n`, /audit-before-install: npm ci runs before/],
  ];
  for (const [steps, re] of fail) assert.match(errs(steps).join("\n"), re, steps);
  const inline = "name: t\non: push\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: [self-hosted, macOS]\n    steps: [{run: npm ci}]\n";
  assert.match(checkWorkflow("ci.yml", inline).join(), /steps written inline cannot be checked/);
  // D5: only GitHub-hosted labels are exempt from the audit and lockfile rules; the script flag applies everywhere.
  for (const runsOn of ["${{ matrix.runner }}", "catscan", "\n      group: mine", "macos-26-selfhosted"]) {
    assert.match(errs("      - run: npm ci --ignore-scripts\n", runsOn).join(), /audit-before-install/, runsOn);
  }
  assert.deepEqual(errs("      - run: npm init -y && npm install --ignore-scripts packed/*.tgz\n", "macos-15"), []);
  assert.deepEqual(errs("      - run: pnpm install\n", "macos-15"), []);
  assert.match(errs("      - run: npm install packed/*.tgz\n", "macos-15").join(), /install-scripts: npm install/);
  // Product workflows run on GitHub-hosted runners only (spec 25 D16): the install rules are lab-only.
  for (const steps of ["      - run: npm ci\n", "      - run: npm install x\n", "      - if: always()\n        run: npm ci\n"]) {
    assert.deepEqual(checkWorkflow("ci.yml", wf({ steps }), { product: true }), [], steps);
  }
});

// Value: protects=TODO-066 D9, the local setup audits before it installs and installs without scripts; fails_when=the order flips or the flag is dropped; why_new=new script; seam=none; no_claim=npm's own handling of the flag
test("npm run setup audits before an install without scripts", () => {
  const { setup } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  assert.match(setup, /^node scripts\/check-audit\.mjs && npm ci --ignore-scripts --no-audit --no-fund$/);
});
