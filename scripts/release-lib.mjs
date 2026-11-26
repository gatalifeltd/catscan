#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 08 D9: the checks scripts/release.sh runs before it builds, kept here so unit tests cover them.
//   node scripts/release-lib.mjs versions [<tag>]   step 1: VERSION, every version carrier (TODO-094), repo metadata
//   node scripts/release-lib.mjs bump <X.Y.Z> [--from A.B.C] [--note "<text>"] [--renumber]   TODO-094: move every carrier
//   node scripts/release-lib.mjs minos <min>         step 2: `vtool -show-build` on stdin names minos <min>
//   node scripts/release-lib.mjs on-main             step 1: HEAD is on origin/main (fetch first)
//   node scripts/release-lib.mjs notarized           step 3: spctl output on stdin says Notarized Developer ID
//   node scripts/release-lib.mjs behavior-changes    TODO-059 T1: regenerate packages/core-js/behavior-changes.json
//   node scripts/release-lib.mjs behavior-changes --public <file> --first-public X.Y.Z   the land: drop older releases
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWLIST, parseAllowlist } from "./public-paths.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Publish order (D10): each package's internal dependencies are already on the registry.
export const PACKAGES = ["cli-darwin-arm64", "core-js", "cli", "mcp", "playwright"];
export const PUBLIC_REPO = "https://github.com/gatalifeltd/catscan";
// What `mcp-publisher publish` reads, run from packages/mcp after the npm publish (spec 25 D25).
export const SERVER_JSON = "packages/mcp/server.json";
export const PLUGIN_JSON = "plugins/catscan/.claude-plugin/plugin.json";
export const MARKETPLACE_JSON = ".claude-plugin/marketplace.json";

// TODO-094: every place the release version is written, in one list. `bump` moves them and `versionProblems` checks
// them, so a new carrier is added here once. `lab: true` carriers are required only in the lab (where the landing
// allowlist exists); the land and the test fixtures skip them when absent (D6).
const PIN_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
const versionField = (m, label = "version") => (m && typeof m === "object" ? [{ label, obj: m, key: "version" }] : []);
const pinFields = (m, prefix = "") => PIN_FIELDS.flatMap((field) => Object.keys(m?.[field] || {})
  .filter((dep) => dep.startsWith("@catscan/"))
  .map((dep) => ({ label: `${prefix}${field}.${dep}`, obj: m[field], key: dep })));
const manifest = (m) => [...versionField(m), ...pinFields(m)];
export const JSON_CARRIERS = [
  { file: "package.json", fields: manifest },
  ...PACKAGES.map((p) => ({ file: `packages/${p}/package.json`, fields: manifest })),
  // Spec 25 D25: the MCP registry entry names the npm version it installs, so a bump that skips it publishes a stale entry.
  { file: SERVER_JSON, fields: (m) => [...versionField(m), ...(m.packages || []).map((p) => ({ label: `packages ${p.identifier} version`, obj: p, key: "version" }))] },
  // TODO-059 D11: the plugin manifest is the one carrier of the skills' version; the marketplace entry carries none.
  { file: PLUGIN_JSON, fields: versionField },
  // Only the workspace entries: a third-party package that happens to sit at the old version is not ours.
  { file: "package-lock.json", lab: true, fields: (m) => [...versionField(m), ...Object.entries(m.packages || {})
    .filter(([k]) => k === "" || PACKAGES.some((p) => k === `packages/${p}`))
    .flatMap(([k, e]) => [...versionField(e, `packages["${k}"].version`), ...pinFields(e, `packages["${k}"].`)])] },
];
// `re` captures (prefix)(value); `say` names the value in a problem; `keep` lists placeholders that are not versions.
export const TEXT_CARRIERS = [
  // Spec 15 D3: the CI examples pin the release they ship with; any token after @ counts, so `${TAG}` is caught too.
  { files: "examples/ci/*", re: /(@catscan\/cli@)([^\s"'`),]+)/g, say: "pins @catscan/cli@" },
  // TODO-059 T4: the MCP recipe pins the server it documents, so an upgrade has a version to move.
  { files: "docs/recipes/mcp.md", re: /(@catscan\/mcp@)([^\s"'`),\]]+)/g, say: "pins @catscan/mcp@", keep: ["<version>"] },
  { files: "core/Sources/CatscanCore/Model.swift", re: /(catscanVersion = ")([^"]*)/g, say: "catscanVersion is ", lab: true },
  { files: "test/golden/*/read.jsonl", re: /("catscan":")([^"]*)/g, say: "stamps catscan ", lab: true },
  { files: "docs/recipes/maestro.md", re: /(Tested with catscan )([^\s,]+)/g, say: "says Tested with catscan ", lab: true },
  // Only the baseline example: the older result examples in the same file are history.
  { files: "docs/results.md", re: /("key_algo": \d+,\s*"catscan": ")([^"]*)/g, say: "baseline example catscan is ", lab: true },
  // A history: `bump` prepends the new release's entry rather than relabelling the previous one (D1).
  { files: "docs/public-release.md", re: /^(\| Lab version \| )([^\s(]+)/gm, say: "Lab version row starts with ", lab: true, history: true },
];
const SEMVER = /^\d+\.\d+\.\d+$/;

/** The repo-relative files a carrier pattern names, sorted; `*` is one path segment. */
export function carrierFiles(root, pattern) {
  let paths = [""];
  for (const seg of pattern.split("/")) {
    paths = paths.flatMap((p) => {
      if (seg !== "*") return [p ? `${p}/${seg}` : seg];
      const dir = path.join(root, p);
      return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).sort().map((n) => `${p}/${n}`) : [];
    });
  }
  return paths.filter((f) => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile());
}

const inLab = (root) => fs.existsSync(path.join(root, ALLOWLIST));

/** Every way the release version can disagree with itself; [] when VERSION, the tag and every carrier agree. */
export function versionProblems(root = ROOT, tag = null) {
  const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
  const problems = [];
  if (!SEMVER.test(version)) problems.push(`VERSION is "${version}", not X.Y.Z`);
  if (tag !== null && tag !== `v${version}`) problems.push(`HEAD is tagged ${tag || "nothing"}, not v${version}`);
  const lab = inLab(root);
  for (const c of JSON_CARRIERS) {
    if (c.lab && !lab && !fs.existsSync(path.join(root, c.file))) continue;
    const m = readJson(root, c.file, problems);
    if (!m) continue;
    for (const f of c.fields(m)) {
      if (f.obj[f.key] !== version) problems.push(`${c.file} ${f.label} is ${f.obj[f.key]}, not ${version}`);
    }
  }
  const market = readJson(root, MARKETPLACE_JSON, problems);
  for (const p of market?.plugins || []) {
    if ("version" in p) problems.push(`${MARKETPLACE_JSON} plugin ${p.name} carries a version; only ${PLUGIN_JSON} does`);
  }
  for (const c of TEXT_CARRIERS) {
    const files = carrierFiles(root, c.files);
    if (!files.length && c.lab && lab) problems.push(`${c.files}: no such carrier file`);
    for (const file of files) {
      const seen = new Set();
      const matches = [...fs.readFileSync(path.join(root, file), "utf8").matchAll(c.re)];
      if (!matches.length && c.lab && lab) problems.push(`${file}: no ${c.say.trim()} found`);
      for (const m of matches) {
        if (m[2] === version || c.keep?.includes(m[2]) || seen.has(m[2])) continue;
        seen.add(m[2]);
        problems.push(`${file} ${c.say}${m[2]}, not ${version}`);
      }
    }
  }
  return problems;
}

/** Whether `version` is released: true when origin/main's CHANGELOG has its heading, false when it does not,
 *  null when git cannot tell. Final review: a stale branch's VERSION may be one main released. Fix-check: `git log -S`
 *  misses a heading a merge added (renumber after merging main), and `-m` counts main's own headings as added. */
function isReleased(root, version) {
  const r = spawnSync("git", ["show", "origin/main:CHANGELOG.md"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout.split("\n").some((l) => l.startsWith(`## [${version}]`)) : null;
}

/** YYYY-MM-DD in local time. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * TODO-094: the edits that move every carrier from `from` (default VERSION) to `to`. Returns { writes: {file: text},
 * problems }; nothing is written here, and a caller writes only when problems is empty. Carriers already at `to` are
 * left alone, so a second run plans no write.
 */
export function planBump(root, to, { from = null, note = "see CHANGELOG.md", renumber = false, date = today(), released = undefined } = {}) {
  const problems = [];
  const writes = {};
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  if (!SEMVER.test(to)) return { writes, problems: [`the new version "${to}" is not X.Y.Z`] };
  if (from !== null && !SEMVER.test(from)) return { writes, problems: [`--from "${from}" is not X.Y.Z`] };
  if (/[|\n]/.test(note)) return { writes, problems: ["--note must be one line without |"] };
  // D11: an unreadable or malformed input is a named problem, never a stack trace; nothing is written either way.
  let current, changelog;
  try { current = read("VERSION").trim(); changelog = read("CHANGELOG.md"); } catch (e) {
    return { writes, problems: [`${e.path ? path.relative(root, e.path) : "VERSION or CHANGELOG.md"} cannot be read (${e.code || e.message}); restore it, then rerun`] };
  }
  const old = from ?? current;
  // Final review: a typo must never move every carrier back to an older release.
  if (SEMVER.test(old) && cmpVersion(to, old) < 0) return { writes, problems: [`${to} is older than ${old}; bump never moves carriers back`] };
  // D9: --renumber renames only this branch's unreleased version: the newest CHANGELOG release, whose heading a commit
  // of this branch added (`released`, read from git unless given). Anything else would rename a released heading and
  // its Lab version entry; when git cannot tell, it refuses too.
  if (renumber && old !== to) {
    const top = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog)?.[1];
    const rel = released === undefined ? isReleased(root, old) : released;
    // The heading may already read `to` (a rerun, or gstack's rebump refreshed it): still this branch's release.
    if ((top !== old && top !== to) || rel !== false) {
      const why = top !== old && top !== to ? `the newest CHANGELOG release is ${top ?? "missing"}` : rel === null ? "git cannot read origin/main:CHANGELOG.md (fetch origin first)" : "origin/main's CHANGELOG already has its heading, so it is released";
      return { writes, problems: [`--renumber renames only an unreleased ${old}, but ${why}; drop --renumber for a new release`] };
    }
  }
  const hint = from === null ? "; if VERSION already moved, name the old version with --from" : "";
  const stale = (file, what, v) => problems.push(`${file} ${what}${v}, not ${old} or ${to}${hint}`);
  if (current !== old && current !== to) stale("VERSION", "is ", current);
  else if (current !== to) writes.VERSION = `${to}\n`;

  for (const c of JSON_CARRIERS) {
    let text;
    try { text = read(c.file); } catch { problems.push(`${c.file}: no such carrier file`); continue; }
    let before, want;
    try { before = JSON.parse(text); want = JSON.parse(text); } catch (e) {
      problems.push(`${c.file}: not valid JSON (${e.message}); fix it, then rerun`);
      continue;
    }
    const fields = c.fields(want);
    if (!fields.length) { problems.push(`${c.file}: no version field to replace`); continue; }
    let moved = false;
    for (const f of fields) {
      const v = f.obj[f.key];
      if (v === to) continue;
      if (v !== old) { stale(c.file, `${f.label} is `, v); continue; }
      f.obj[f.key] = to;
      moved = true;
    }
    if (!moved) continue;
    // D4: a file that already is JSON.stringify output is rewritten from the edited object; any other is edited as
    // text at the version keys only, and refused unless the result parses to exactly the edited object.
    let out;
    if (JSON.stringify(before, null, 2) + "\n" === text) out = JSON.stringify(want, null, 2) + "\n";
    else {
      const esc = old.replace(/\./g, "\\.");
      out = text.replace(new RegExp(`("(?:version|@catscan/[^"]+)"\\s*:\\s*")${esc}(")`, "g"), `$1${to}$2`);
      if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(want)) { problems.push(`${c.file}: cannot move its versions without reformatting it`); continue; }
    }
    writes[c.file] = out;
  }

  for (const c of TEXT_CARRIERS) {
    const files = carrierFiles(root, c.files);
    if (!files.length) problems.push(`${c.files}: no such carrier file`);
    for (const file of files) {
      const text = read(file);
      let found = 0;
      const out = text.replace(c.re, (all, prefix, v) => {
        found++;
        if (v === to || c.keep?.includes(v)) return all;
        if (v !== old) { stale(file, c.say, v); return all; }
        return c.history && !renumber ? `${prefix}${to} (${note}; ${date}); ${v}` : `${prefix}${to}`;
      });
      if (!found) problems.push(`${file}: no ${c.say.trim()} found to replace`);
      else if (out !== text) writes[file] = out;
    }
  }

  // D5: an empty heading for the new release, so docs:check passes until /ship's CHANGELOG step fills it.
  if (!changelog.includes(`## [${to}]`)) {
    const oldHead = new RegExp(`^## \\[${old.replace(/\./g, "\\.")}\\]`, "m");
    if (renumber && oldHead.test(changelog)) writes["CHANGELOG.md"] = changelog.replace(oldHead, `## [${to}]`);
    else {
      const at = changelog.search(/^## \[\d/m);
      const head = `## [${to}] - ${date}\n\n`;
      writes["CHANGELOG.md"] = at < 0 ? `${changelog.replace(/\n*$/, "\n\n")}${head}` : changelog.slice(0, at) + head + changelog.slice(at);
    }
  }
  return { writes: problems.length ? {} : writes, problems };
}

/** Every missing or inconsistent public-repo field in the manifests and server.json (spec 25 D24, D25); [] when all agree. */
export function metadataProblems(root = ROOT) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
  const problems = [];
  const files = ["package.json", ...PACKAGES.map((p) => `packages/${p}/package.json`)];
  // The allowlist exists only in the lab (it never lands), so the product repo skips this part of the check.
  const allowPath = path.join(root, ALLOWLIST);
  const landing = fs.existsSync(allowPath) ? parseAllowlist(fs.readFileSync(allowPath, "utf8")) : null;
  for (const file of files) {
    const m = read(file);
    const dir = path.dirname(file);
    const want = { type: "git", url: `git+${PUBLIC_REPO}.git`, ...(dir === "." ? {} : { directory: dir }) };
    if (JSON.stringify(m.repository) !== JSON.stringify(want)) problems.push(`${file} repository is ${JSON.stringify(m.repository)}, not ${JSON.stringify(want)}`);
    if (m.bugs?.url !== `${PUBLIC_REPO}/issues`) problems.push(`${file} bugs.url is ${m.bugs?.url}, not ${PUBLIC_REPO}/issues`);
    const page = homepageFile(m.homepage);
    if (page === null) problems.push(`${file} homepage ${m.homepage} is not ${PUBLIC_REPO}#readme or a ${PUBLIC_REPO}/blob/main/ file`);
    else if (page && !fs.existsSync(path.join(root, page))) problems.push(`${file} homepage names ${page}, which does not exist`);
    else if (page && landing && !landing.some((a) => a.re.test(page))) problems.push(`${file} homepage names ${page}, which never lands in the public repo`);
    if (!Array.isArray(m.keywords) || m.keywords.length === 0 || m.keywords.some((k) => typeof k !== "string" || !k)) {
      problems.push(`${file} keywords must be a non-empty list of words`);
    }
  }
  const mcp = read("packages/mcp/package.json");
  const server = readServerJson(root, problems);
  if (!server) return problems;
  if (server.websiteUrl !== mcp.homepage) problems.push(`${SERVER_JSON} websiteUrl ${server.websiteUrl} must equal packages/mcp/package.json homepage ${mcp.homepage}`);
  if (!mcp.mcpName || mcp.mcpName !== server.name) problems.push(`packages/mcp/package.json mcpName ${mcp.mcpName} must equal ${SERVER_JSON} name ${server.name}`);
  if (!/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/.test(server.$schema || "")) {
    problems.push(`${SERVER_JSON} $schema ${server.$schema} is not a dated static.modelcontextprotocol.io schema URL`);
  }
  if (server.repository?.url !== PUBLIC_REPO || server.repository?.subfolder !== "packages/mcp") {
    problems.push(`${SERVER_JSON} repository must be ${PUBLIC_REPO} with subfolder packages/mcp`);
  }
  const npm = (server.packages || []).filter((p) => p.registryType === "npm");
  if (npm.length !== 1 || npm[0].identifier !== mcp.name) problems.push(`${SERVER_JSON} must list exactly one npm package, ${mcp.name}`);
  return problems;
}

/** The repo file a homepage URL names: "" for the README anchor, the path for a blob/main link, null for anything else. */
function homepageFile(url) {
  if (url === `${PUBLIC_REPO}#readme`) return "";
  const prefix = `${PUBLIC_REPO}/blob/main/`;
  if (typeof url !== "string" || !url.startsWith(prefix)) return null;
  const file = url.slice(prefix.length).split("#")[0];
  return file && !file.split("/").includes("..") ? file : null;
}

/** server.json parsed, or null after naming why it cannot be read, so release.sh prints a problem, not a stack. */
function readServerJson(root, problems) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, SERVER_JSON), "utf8"));
  } catch (e) {
    problems.push(`${SERVER_JSON} cannot be read: ${e.code === "ENOENT" ? "missing" : e.message}`);
    return null;
  }
}

/** A JSON file parsed, or null after naming why it cannot be read. */
function readJson(root, file, problems) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  } catch (e) {
    problems.push(`${file} cannot be read: ${e.code === "ENOENT" ? "missing" : e.message}`);
    return null;
  }
}

// TODO-059 T1 (D5): every release's behavior changes as data, so an upgrade never parses prose. CHANGELOG.md holds
// the bullets; the committed JSON holds them plus each release's `state`, read from the code for the top release and
// kept from the committed file for older ones, so no git history is needed (the install-free docs job runs this).
export const BEHAVIOR_FILE = "packages/core-js/behavior-changes.json";
export const BEHAVIOR_FROM = "0.36.0"; // older releases predate any public install and are not backfilled
export const BEHAVIOR_KINDS = ["default-on", "exit-code", "cli", "output", "schema", "protocol", "rule-block", "reader"];
export const BEHAVIOR_HEADING = "### Behavior changes";
export const BEHAVIOR_GRAMMAR = "- `<kind>` <id>: <one sentence of what changes for the user>. Opt out: <flag, env or none>.";
const BULLET = /^- `([^`]*)` (\S+): (.+?)\. Opt out: (.+)\.$/;
const BEHAVIOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The state field and the bullet kind a change of it needs.
const STATE_KINDS = { protocol: "protocol", results_schema: "schema", doctor_schema: "schema", exit_codes: "exit-code" };
const REGEN = "node scripts/release-lib.mjs behavior-changes";

export function cmpVersion(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** { releases: [{ version, changes: [{ kind, id, text, opt_out }] }] newest first, from BEHAVIOR_FROM; problems }. */
export function parseBehaviorChanges(changelog) {
  const releases = [];
  const problems = [];
  const ids = new Map();
  let cur = null;
  let inSection = false;
  changelog.split("\n").forEach((line, i) => {
    const where = `CHANGELOG.md:${i + 1}`;
    const head = /^## \[(\d+\.\d+\.\d+)\]/.exec(line);
    if (head) {
      cur = cmpVersion(head[1], BEHAVIOR_FROM) >= 0 ? { version: head[1], changes: [] } : null;
      if (cur) releases.push(cur);
      inSection = false;
      return;
    }
    if (/^## /.test(line)) cur = null; // a non-version heading such as [Unreleased] owns no bullets
    if (/^#{1,3} /.test(line)) {
      inSection = line.trim() === BEHAVIOR_HEADING;
      if (inSection && !cur) problems.push(`${where}: ${BEHAVIOR_HEADING} outside a released version from ${BEHAVIOR_FROM} on, so it is not tracked`);
      return;
    }
    if (!inSection || !cur || !line.trim()) return;
    const b = BULLET.exec(line);
    if (!b) { problems.push(`${where}: a behavior change must read "${BEHAVIOR_GRAMMAR}" on one line`); return; }
    const [, kind, id, text, optOut] = b;
    if (!BEHAVIOR_KINDS.includes(kind)) problems.push(`${where}: unknown kind \`${kind}\`; use one of ${BEHAVIOR_KINDS.join(", ")}`);
    if (!BEHAVIOR_ID.test(id)) problems.push(`${where}: id "${id}" is not kebab-case`);
    else if (ids.has(id)) problems.push(`${where}: id "${id}" is already used at ${ids.get(id)}`);
    else ids.set(id, where);
    cur.changes.push({ kind, id, text: `${text}.`, opt_out: optOut });
  });
  return { releases, problems };
}

/** The behavior-relevant state of a tree; `read(file)` returns its text. Throws naming the file it cannot parse. */
export function codeState(read) {
  const need = (file, re, what) => {
    const m = re.exec(read(file));
    if (!m) throw new Error(`${file}: cannot find ${what}`);
    return m;
  };
  const protocol = Number(need("packages/core-js/src/client.js", /^const PROTOCOL = (\d+);/m, "const PROTOCOL")[1]);
  const schemas = need("packages/core-js/src/results.js", /^const RESULTS_SCHEMAS = \[([\d,\s]+)\];/m, "const RESULTS_SCHEMAS")[1];
  const doctor = JSON.parse(read("core/schema/doctor.schema.json")).$id;
  if (typeof doctor !== "string") throw new Error("core/schema/doctor.schema.json: no $id");
  const table = need("docs/cli.md", /^## Exit codes\n\n\| Code \| Meaning \|\n\| --- \| --- \|\n((?:\| \d+ \|.*\n)+)/m, "the ## Exit codes table")[1];
  // D26: the codes only, so rewording a meaning in a docs-only commit never rewrites a released state.
  const exitCodes = [...table.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
  return { protocol, results_schema: schemas.split(",").map((n) => Number(n.trim())), doctor_schema: doctor, exit_codes: exitCodes };
}

/** { text, problems }: the behavior-changes.json the CHANGELOG, the code and the committed file give. */
export function buildBehaviorChanges(root = ROOT) {
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const { releases, problems } = parseBehaviorChanges(read("CHANGELOG.md"));
  let committed = { releases: [] };
  try { committed = JSON.parse(read(BEHAVIOR_FILE)); } catch (e) { if (e.code !== "ENOENT") problems.push(`${BEHAVIOR_FILE} cannot be read: ${e.message}`); }
  const kept = new Map((committed.releases || []).map((r) => [r.version, r.state]));
  let top;
  try { top = codeState(read); } catch (e) { problems.push(e.message); }
  const out = releases.map((r, i) => {
    const state = i === 0 ? top : kept.get(r.version);
    if (i > 0 && !state) problems.push(`${BEHAVIOR_FILE} has no state for ${r.version}, an older release; take the file from origin/main, then run ${REGEN}`);
    return { version: r.version, state: state || null, changes: r.changes };
  });
  // D5: a state change needs a bullet of the matching kind in the release that made it, so no protocol, schema or
  // exit-code change ships unannounced. Older states are frozen, so checking every pair costs nothing.
  for (let i = 0; i + 1 < out.length; i++) {
    const [now, before] = [out[i], out[i + 1]];
    if (!now.state || !before.state) continue;
    for (const [field, kind] of Object.entries(STATE_KINDS)) {
      if (JSON.stringify(now.state[field]) === JSON.stringify(before.state[field])) continue;
      if (now.changes.some((c) => c.kind === kind)) continue;
      const from = typeof before.state[field] === "object" ? "" : ` ${before.state[field]} -> ${now.state[field]}`;
      problems.push(`CHANGELOG.md [${now.version}]: ${field}${from} changed since ${before.version}; add a \`${kind}\` bullet under ${BEHAVIOR_HEADING} in the release that makes the change (bump VERSION and add its CHANGELOG entry first)`);
    }
  }
  return { text: JSON.stringify({ schema: 1, releases: out }, null, 2) + "\n", problems };
}

/** docs:check: CHANGELOG grammar, state coverage, and a committed file equal to what they give. */
export function behaviorProblems(root = ROOT) {
  const { text, problems } = buildBehaviorChanges(root);
  let have = null;
  try { have = fs.readFileSync(path.join(root, BEHAVIOR_FILE), "utf8"); } catch { /* named below */ }
  if (have !== text) problems.push(`${BEHAVIOR_FILE} differs from CHANGELOG.md and the code; run ${REGEN}`);
  return problems;
}

/** Refuses a symlink or other non-regular file, so a regeneration never writes through a link (review). */
export function regularFile(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  return st.isFile() ? null : `${file} is not a regular file (a symlink or special file); replace it with the generated file`;
}

/** The land: only the releases at or above the first public version, as the product CHANGELOG. */
export function publicBehaviorChanges(text, first) {
  const json = JSON.parse(text);
  json.releases = json.releases.filter((r) => cmpVersion(r.version, first) >= 0);
  return JSON.stringify(json, null, 2) + "\n";
}

/** The `minos` of an arm64 Mach-O from `vtool -show-build` output, or null. */
export function minos(vtoolOutput) {
  const m = /^\s*minos\s+(\S+)/m.exec(vtoolOutput || "");
  return m ? m[1] : null;
}

/** null when HEAD is an ancestor of origin/main, else why not: a release never publishes unmerged code (review). */
export function mainProblem(root = ROOT) {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: root, encoding: "utf8" });
  if (r.status === 0) return null;
  if (r.status === 1) return "HEAD is not on origin/main";
  return `cannot compare HEAD with origin/main: ${(r.stderr || r.error?.message || "").trim()}`;
}

/** True when `spctl --assess -vv ...` accepts the binary and names the Notarized Developer ID source (spec 08 D7). */
export function notarized(spctlOutput) {
  const out = spctlOutput || "";
  return /: accepted$/m.test(out) && !/: rejected/m.test(out) && /^source=Notarized Developer ID$/m.test(out);
}

/** Entries of the binary tarball beyond exactly package.json and bin/catscan-core: nothing else ships (review). */
export function packProblems(tarList) {
  const want = ["package/bin/catscan-core", "package/package.json"];
  const got = tarList.split("\n").map((l) => l.trim()).filter(Boolean).sort();
  const extra = got.filter((f) => !want.includes(f)).map((f) => `unexpected ${f}`);
  const missing = want.filter((f) => !got.includes(f)).map((f) => `missing ${f}`);
  return [...missing, ...extra];
}

/** Why `catscan-core doctor` of the binary about to ship fails its self-test, or null (review: test before publish). */
export function selfTestProblem(doctorJson) {
  let info;
  try { info = JSON.parse(doctorJson); } catch { return "catscan-core doctor did not print JSON"; }
  if (info?.self_test?.pass !== true) return "the catscan-core self-test did not pass";
  if (!(info?.vision?.languages?.accurate > 0)) return "Vision lists no recognition languages";
  return null;
}

// Compare both sides resolved: run through a symlinked checkout (macOS /var -> /private/var, or with
// --preserve-symlinks-main) a plain comparison is false and every subcommand exited 0 doing nothing, so `versions`
// passed a stale tree (TODO-094 QA, review).
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const invoked = process.argv[1] ? real(process.argv[1]) : null;
if (invoked !== null && invoked === real(fileURLToPath(import.meta.url))) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "versions") {
    // Both checks name an unreadable server.json; print it once.
    const problems = [...new Set([...versionProblems(ROOT, arg === undefined ? null : arg), ...metadataProblems(ROOT)])];
    for (const p of problems) console.error(`release: ${p}`);
    process.exit(problems.length ? 1 : 0);
  } else if (cmd === "bump") {
    const argv = process.argv.slice(3);
    const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? "" : null);
    const to = argv[0];
    // A flag with no value, or another flag in its place, is a usage error, not an empty note (review).
    // A note may itself start with "--" (it can describe a flag); only another bump flag in its place is refused.
    const FLAGS = ["--from", "--note", "--renumber"];
    const bad = ["--from", "--note"].some((f) => { const v = opt(f); return v !== null && (!v || FLAGS.includes(v)); });
    if (!to || to.startsWith("--") || bad) {
      console.error('usage: release-lib.mjs bump <X.Y.Z> [--from <A.B.C>] [--note "<what changed>"] [--renumber]');
      process.exit(2);
    }
    const { writes, problems } = planBump(ROOT, to, { from: opt("--from"), note: opt("--note") ?? undefined, renumber: argv.includes("--renumber") });
    for (const p of problems) console.error(`release: ${p}`);
    if (problems.length) { console.error("release: nothing written"); process.exit(/not X\.Y\.Z|--note/.test(problems[0]) ? 2 : 1); }
    for (const [file, text] of Object.entries(writes)) fs.writeFileSync(path.join(ROOT, file), text);
    // D5: behavior-changes.json follows the new top release; older states are kept from the committed file.
    let behavior = [];
    if (fs.existsSync(path.join(ROOT, BEHAVIOR_FILE))) {
      const built = buildBehaviorChanges(ROOT);
      behavior = built.problems;
      // Final review: an unreadable code state would be written as null and lose the newest release's state.
      const newest = JSON.parse(built.text).releases[0];
      if (newest?.state && !behavior.some((p) => p.includes("has no state for") || p.includes("cannot be read"))) {
        const target = path.join(ROOT, BEHAVIOR_FILE);
        if (fs.readFileSync(target, "utf8") !== built.text) { fs.writeFileSync(target, built.text); writes[BEHAVIOR_FILE] = true; }
      }
    }
    const changed = Object.keys(writes);
    console.log(changed.length ? `bump: ${to} in ${changed.length} files: ${changed.join(", ")}` : `bump: every carrier already at ${to}`);
    for (const p of behavior) console.log(`bump: note: ${p}`);
    if (writes["core/Sources/CatscanCore/Model.swift"]) console.log("bump: next: npm run build, so the goldens meet a binary that prints the new version");
  } else if (cmd === "minos") {
    const found = minos(fs.readFileSync(0, "utf8"));
    if (found !== arg) { console.error(`release: catscan-core minos is ${found}, not ${arg}`); process.exit(1); }
  } else if (cmd === "on-main") {
    const problem = mainProblem();
    if (problem) { console.error(`release: ${problem}`); process.exit(1); }
  } else if (cmd === "notarized") {
    // Reads all of stdin, so spctl never dies of SIGPIPE under pipefail the way `| grep -q` can (review).
    process.exit(notarized(fs.readFileSync(0, "utf8")) ? 0 : 1);
  } else if (cmd === "pack-files" || cmd === "self-test") {
    const input = fs.readFileSync(0, "utf8");
    const problems = cmd === "pack-files" ? packProblems(input) : [selfTestProblem(input)].filter(Boolean);
    for (const p of problems) console.error(`release: ${p}`);
    process.exit(problems.length ? 1 : 0);
  } else if (cmd === "behavior-changes") {
    const argv = process.argv.slice(3);
    if (argv[0] === "--public") {
      const file = argv[1];
      const first = argv[argv.indexOf("--first-public") + 1];
      if (!file || !argv.includes("--first-public") || !/^\d+\.\d+\.\d+$/.test(first || "")) {
        console.error("usage: release-lib.mjs behavior-changes --public <file> --first-public X.Y.Z");
        process.exit(2);
      }
      const bad = regularFile(file);
      if (bad) { console.error(`release: ${bad}`); process.exit(2); }
      fs.writeFileSync(file, publicBehaviorChanges(fs.readFileSync(file, "utf8"), first));
      process.exit(0);
    }
    const target = path.join(ROOT, BEHAVIOR_FILE);
    const bad = regularFile(target);
    if (bad) { console.error(`release: ${bad}`); process.exit(2); }
    const { text, problems } = buildBehaviorChanges(ROOT);
    for (const p of problems) console.error(`release: ${p}`);
    // A missing older state or an unreadable committed file would be written as null and lose the only copy of it.
    if (problems.some((p) => p.includes("has no state for") || p.includes("cannot be read"))) {
      console.error(`release: ${BEHAVIOR_FILE} left unchanged`);
      process.exit(1);
    }
    fs.writeFileSync(target, text);
    process.exit(problems.length ? 1 : 0);
  } else {
    console.error("usage: release-lib.mjs versions [<tag>] | bump <X.Y.Z> | minos <min> | on-main | notarized | pack-files | self-test | behavior-changes");
    process.exit(2);
  }
}
