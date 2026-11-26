// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-027: the real check-audit CLI in a temp git repo, with a fake `npm` first on PATH that replays real
// `npm audit --json` reports (fixtures/audit, npm 11.20.0) per lockfile directory (D2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { landPlan, readAllowlist, trackedFiles } from "../public-paths.mjs";

const CLI = new URL("../check-audit.mjs", import.meta.url).pathname;
const fixture = (name) => fs.readFileSync(new URL(`fixtures/audit/${name}`, import.meta.url), "utf8");
const SPIKE_HIGH = fixture("spike-high.json");
const CLEAN = fixture("root-clean.json");

// A shell script, not node: it starts in milliseconds under a loaded test run, so only the hung case meets the deadline.
// `exec sleep` keeps no grandchild holding the pipes after the timeout kills it.
// The dev pass (--include=dev) replays fake-out-all when a test gives one (D10), else the same report as the gate.
const FAKE_NPM = `#!/bin/sh
[ "$1" = --version ] && { echo 11.20.0; exit 0; }
echo "$* include=$npm_config_include also=$npm_config_also dev=$npm_config_dev" >> fake-args
[ -f fake-sleep ] && exec sleep 60
case " $* " in *" --include=dev "*) [ -f fake-out-all ] && { cat fake-out-all; exit "$(cat fake-exit-all)"; };; esac
cat fake-out
exit "$(cat fake-exit)"
`;

// dirs: { ".": [stdout, exit] | [stdout, exit, devStdout, devExit] | "sleep", "sub": ... }; every key gets a tracked
// package-lock.json. r.npmArgs maps each dir to the npm argument lines it received.
function run(dirs, { args = [], env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-audit-"));
  const bin = path.join(root, ".bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), FAKE_NPM, { mode: 0o755 });
  for (const [dir, spec] of Object.entries(dirs)) {
    const d = path.join(root, dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "package-lock.json"), "{}\n");
    if (spec === "sleep") fs.writeFileSync(path.join(d, "fake-sleep"), "");
    else {
      fs.writeFileSync(path.join(d, "fake-out"), spec[0]); fs.writeFileSync(path.join(d, "fake-exit"), String(spec[1]));
      if (spec.length > 2) { fs.writeFileSync(path.join(d, "fake-out-all"), spec[2]); fs.writeFileSync(path.join(d, "fake-exit-all"), String(spec[3])); }
    }
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env },
  });
  r.npmArgs = Object.fromEntries(Object.keys(dirs).map((dir) => {
    const f = path.join(root, dir, "fake-args");
    return [dir, fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n") : []];
  }));
  fs.rmSync(root, { recursive: true, force: true });
  return r;
}

const withSeverity = (sev) => {
  const r = JSON.parse(SPIKE_HIGH);
  for (const v of Object.values(r.vulnerabilities)) {
    v.severity = sev;
    for (const x of v.via) if (typeof x === "object") x.severity = sev;
  }
  r.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 3, [sev]: 3 };
  return JSON.stringify(r);
};

// Value: protects=TODO-027 D1/D6/D7, a high advisory in any tracked lockfile fails with codes, advisory URLs, a fix line, and later lockfiles still audited; fails_when=the severity filter, discovery or the loop's early exit breaks; why_new=new script; seam=none (fake npm on PATH); no_claim=registry behaviour (real captured reports stand in for npm)
test("a high advisory fails with each advisory and a fix line, and the next lockfile is still audited", () => {
  const r = run({ ".": [SPIKE_HIGH, 1], sub: [CLEAN, 0] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^check-audit: audit-high package-lock\.json: 3 high, 0 critical$/m);
  for (const id of ["GHSA-f88m-g3jw-g9cj", "GHSA-rgj7-g3m4-5g8c", "GHSA-wq5f-xc86-pv6w"]) assert.match(r.stderr, new RegExp(`sharp \\(high, <=0\\.35\\.5-rc\\.1\\):.*${id}`));
  assert.match(r.stderr, /@blazediff\/codec-sharp \(high, \*\): via sharp/);
  assert.match(r.stderr, /fix: in the repo root, run `npm ls --package-lock-only sharp`.*overrides.*run `npm install --package-lock-only --ignore-scripts` there, commit package\.json and package-lock\.json/);
  // TODO-066 D10: no fix line runs an install with scripts before the re-audit.
  assert.doesNotMatch(r.stderr, /`npm install`|`npm ls sharp`/);
  assert.match(r.stdout, /^check-audit: sub\/package-lock\.json ok \(132 dependencies, 23 of them dev-only, gated on critical only, 0 high, 0 critical\)$/m);
  assert.match(r.stderr, /FAILED 1 of 2 lockfiles: package-lock\.json$/m);
});

test("clean and moderate-only reports pass with one stdout line per lockfile; a critical one fails", () => {
  const ok = run({ ".": [CLEAN, 0], "a/b": [withSeverity("moderate"), 0] });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, "");
  assert.match(ok.stdout, /package-lock\.json ok \(132 dependencies/);
  assert.match(ok.stdout, /a\/b\/package-lock\.json ok \(65 dependencies, 0 of them dev-only, gated on critical only, 0 high, 0 critical\)/);
  assert.match(ok.stdout, /check-audit: ok \(2 lockfiles\)$/m);
  const crit = run({ ".": [withSeverity("critical"), 1] });
  assert.equal(crit.status, 1);
  assert.match(crit.stderr, /audit-high package-lock\.json: 0 high, 3 critical/);
});

// Value: protects=TODO-027 D10, the gate audits only shipped deps and a dev-only high advisory warns without failing; fails_when=the gate drops --omit=dev, an inherited npm_config_include widens it, dev high findings fail the check or vanish; why_new=D10 changes the gate's scope; seam=none (fake npm on PATH); no_claim=npm's own dev/prod classification
test("the gate audits shipped deps only; a dev-only high advisory warns and passes", () => {
  const r = run({ ".": [CLEAN, 0, SPIKE_HIGH, 1], sub: [CLEAN, 0] }, { env: { npm_config_include: "dev", npm_config_also: "dev", npm_config_dev: "true" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /check-audit: ok \(2 lockfiles\)$/m);
  assert.match(r.stderr, /^check-audit: warning dev-only package-lock\.json: 3 dev package\(s\) affected .*does not fail the check$/m);
  assert.match(r.stderr, /^  sharp \(high, <=0\.35\.5-rc\.1\): .*GHSA-f88m-g3jw-g9cj/m);
  assert.doesNotMatch(r.stderr, /codec-sharp/, "only the package that carries the advisory is listed");
  assert.deepEqual(r.npmArgs["."], [
    "audit --json --audit-level=high --omit=dev --include=optional --include=peer include= also= dev=",
    "audit --json --audit-level=high --include=dev --include=optional --include=peer include= also= dev=",
  ]);
  const both = run({ ".": [SPIKE_HIGH, 1] });
  assert.equal(both.status, 1);
  assert.doesNotMatch(both.stderr, /warning dev-only/, "a shipped finding is not repeated as dev-only");
});

// Value: protects=TODO-027 D11, a critical advisory (malware included) in dev dependencies fails, a high one beside it still only warns, and an unavailable dev pass fails closed; fails_when=dev criticals are downgraded to warnings, the severity split is lost, or a dev-pass error reads as clean; why_new=D11 makes the dev pass gate criticals; seam=none (fake npm on PATH); no_claim=npm's own severity of a real malware advisory
test("a critical dev-only advisory fails, a high one beside it warns, and a failed dev pass fails closed", () => {
  const mixed = JSON.parse(withSeverity("critical"));
  mixed.vulnerabilities["@blazediff/cli"].severity = "high";
  const r = run({ ".": [CLEAN, 0, JSON.stringify(mixed), 1], sub: [CLEAN, 0, "npm ERR! oops", 1] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^check-audit: audit-critical-dev package-lock\.json: 2 dev package\(s\) affected by a critical advisory/m);
  assert.match(r.stderr, /^  sharp \(critical, <=0\.35\.5-rc\.1\): .*GHSA-f88m-g3jw-g9cj/m);
  assert.match(r.stderr, /^  fix: in the repo root, remove or replace the dev dependency that pulls it \(`npm ls --package-lock-only <pkg>`\), or raise it to a patched version \(`npm install --package-lock-only --ignore-scripts`\)/m);
  assert.match(r.stderr, /^check-audit: warning dev-only package-lock\.json: 1 dev package\(s\) affected by a high advisory/m);
  assert.match(r.stderr, /^  @blazediff\/cli \(high, /m);
  assert.match(r.stderr, /^check-audit: audit-unavailable sub\/package-lock\.json \(dev dependencies\): npm ERR! oops \(npm 11\.20\.0\)$/m);
  assert.match(r.stderr, /FAILED 2 of 2 lockfiles: package-lock\.json, sub\/package-lock\.json$/m);
  assert.doesNotMatch(r.stdout, /check-audit: ok \(/);
  assert.doesNotMatch(r.stdout, /package-lock\.json ok/, "a lockfile the dev pass fails is never reported ok");
});

// Value: protects=TODO-027 D7/D11, a lockfile that fails both the gate and the dev pass is counted once, and critical-only dev findings print no high warning; fails_when=both passes push the same lockfile (FAILED 3 of 2) or an empty high header is printed; why_new=no other test fails the gate and the dev pass together or runs the critical-only branch; seam=none (fake npm on PATH); no_claim=npm's own severity of a real malware advisory
test("a lockfile failing both passes is listed once; critical-only dev findings print no high warning", () => {
  const r = run({ ".": [SPIKE_HIGH, 1, "npm ERR! oops", 1], sub: [CLEAN, 0, withSeverity("critical"), 1] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^check-audit: audit-high package-lock\.json: 3 high/m);
  assert.match(r.stderr, /^check-audit: audit-unavailable package-lock\.json \(dev dependencies\): npm ERR! oops/m);
  assert.match(r.stderr, /^check-audit: audit-critical-dev sub\/package-lock\.json: 3 dev package\(s\) affected by a critical advisory/m);
  assert.doesNotMatch(r.stderr, /warning dev-only/);
  assert.match(r.stderr, /FAILED 2 of 2 lockfiles: package-lock\.json, sub\/package-lock\.json$/m);
});

// Value: protects=TODO-027 D10, when every advisory carrier also ships, the dev-only warning still lists its dev packages and the fix line names the directory; fails_when=the roots-or-all fallback is dropped (a header with no package under it), the shipped exclusion stops being per name, or the fix line loses its directory; why_new=the D10 test covers only all-excluded and roots-present; seam=none (fake npm on PATH); no_claim=npm's own dev/prod classification
test("dev-only packages whose advisory carrier ships are listed by name, with a fix line for their directory", () => {
  const sharpOnly = JSON.parse(SPIKE_HIGH);
  sharpOnly.vulnerabilities = { sharp: sharpOnly.vulnerabilities.sharp };
  sharpOnly.metadata.vulnerabilities = { ...sharpOnly.metadata.vulnerabilities, high: 1, total: 1 };
  const r = run({ ".": [CLEAN, 0], sub: [JSON.stringify(sharpOnly), 1, SPIKE_HIGH, 1] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^check-audit: audit-high sub\/package-lock\.json: 1 high, 0 critical$/m);
  assert.match(r.stderr, /^check-audit: warning dev-only sub\/package-lock\.json: 2 dev package\(s\)/m);
  assert.match(r.stderr, /^  @blazediff\/codec-sharp \(high, \*\): via sharp$/m);
  assert.match(r.stderr, /^  @blazediff\/cli \(high, .*\): via @blazediff\/codec-sharp$/m);
  assert.equal(r.stderr.match(/^  sharp \(/gm).length, 1, "sharp is listed once, by the gate");
  assert.match(r.stderr, /^  fix \(when a patched version exists\): raise the owning dev dependency in sub$/m);
});

// Value: protects=TODO-027 D5/D8, a registry error, garbage output, a non-zero exit without findings and a hung npm fail closed as audit-unavailable; fails_when=an npm failure reads as a clean audit or the deadline is lost; why_new=new script; seam=CATSCAN_AUDIT_TIMEOUT_MS (documented override); no_claim=real registry outage
test("npm errors, non-JSON output and a hung npm fail closed as audit-unavailable", () => {
  const registry = JSON.stringify({ message: "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: ECONNRESET", error: { summary: "", detail: "" } });
  const r = run({ ".": [registry, 1], b: ["npm ERR! oops", 1], c: [CLEAN, 1], d: "sleep" }, { env: { CATSCAN_AUDIT_TIMEOUT_MS: "3000" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /audit-unavailable package-lock\.json: request to .* ECONNRESET \(npm 11\.20\.0\)/);
  assert.match(r.stderr, /audit-unavailable b\/package-lock\.json: npm ERR! oops/);
  assert.match(r.stderr, /audit-unavailable c\/package-lock\.json: npm exited 1 without a high or critical advisory/);
  assert.match(r.stderr, /audit-unavailable d\/package-lock\.json: npm audit did not finish within 3 s/);
  assert.match(r.stderr, /fix: rerun once the npm registry answers \(locally `npm run setup`, in CI rerun the job\).*Offline, `npm ci --ignore-scripts` installs without the audit, only for a lockfile already green in CI/);
  assert.match(r.stderr, /FAILED 4 of 4 lockfiles/);
  // D10: an unavailable gate skips the dev pass, so a hung npm costs one deadline per lockfile, not two.
  for (const dir of [".", "b", "c", "d"]) assert.equal(r.npmArgs[dir].length, 1, dir);
  assert.doesNotMatch(r.stderr, /\(dev dependencies\)/);
});

// Value: protects=TODO-027 D5/D6, no tracked lockfile fails closed (never "ok (0 lockfiles)"), and a subdirectory's fix line names that directory's package.json; fails_when=discovery breaks silently or the fix line points at the root; why_new=ship coverage audit gaps; seam=none; no_claim=real repo layout
test("no tracked lockfile fails closed, and a subdirectory finding names that directory", () => {
  const none = run({});
  assert.equal(none.status, 1);
  assert.match(none.stderr, /audit-unavailable no tracked package-lock\.json/);
  const sub = run({ ".": [CLEAN, 0], spike: [SPIKE_HIGH, 1] });
  assert.equal(sub.status, 1);
  assert.match(sub.stderr, /fix: in spike, run `npm ls --package-lock-only sharp`.*"overrides" entry for sharp in spike\/package\.json/);
});

// Value: protects=spec 25 landing, the product repo's test:unit can read these fixtures (check-audit and release tests land there); fails_when=public-paths.txt drops scripts/test/fixtures/audit/; why_new=ship red team found the fixtures did not land; seam=none; no_claim=the product repo's own CI run
const REPO = new URL("../..", import.meta.url).pathname;
// public-paths.txt itself never lands (NEVER in public-paths.mjs), so the product repo skips this lab-only check.
test("the audit fixtures land in the product repo with the tests that read them", { skip: !fs.existsSync(path.join(REPO, "scripts/public-paths.txt")) && "lab only: public-paths.txt does not land" }, () => {
  const root = REPO;
  const landed = new Set(landPlan(readAllowlist(root), trackedFiles(root)).map((p) => p.dest));
  for (const f of ["scripts/test/check-audit.test.mjs", "scripts/test/release.test.mjs", "scripts/test/fixtures/audit/spike-high.json", "scripts/test/fixtures/audit/root-clean.json"]) {
    assert.ok(landed.has(f), `${f} does not land`);
  }
});

test("any argument or a bad timeout exits 2 with usage", () => {
  const r = run({ ".": [CLEAN, 0] }, { args: ["--level=critical"] });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: unexpected argument --level=critical/);
  assert.equal(r.stdout, "");
  for (const bad of ["-5", "Infinity", "1.5", "abc", "9007199254740992"]) {
    const t = run({ ".": [CLEAN, 0] }, { env: { CATSCAN_AUDIT_TIMEOUT_MS: bad } });
    assert.equal(t.status, 2, bad);
    assert.match(t.stderr, /CATSCAN_AUDIT_TIMEOUT_MS must be a positive integer/);
  }
});
