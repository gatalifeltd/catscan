// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-055 through the CLI and real Vision on synthetic screens: approve a run, rerun unchanged (all known, exit 0),
// add a finding (exit 1, only it new), fix one (gone, tighten, --prune shrinks the file), and shards approved
// separately merge with --known to the verdicts of one run. Formats reruns as known too.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { ROOT, setup, cli } = require("./helpers");

setup();
const SYNTH = path.join(ROOT, ".build/synth");
const line = (text, y) => ({ text, x: 120, y, size: 44 });
const screen = (name, locale, texts) => ({ name, locale, width: 1179, height: 900, lines: texts.map((t, i) => line(t, 160 + i * 160)) });
/** Writes synthetic screens under dir (names carry the {locale}/{screen} layout). */
function draw(dir, screens) {
  fs.mkdirSync(dir, { recursive: true });
  const spec = path.join(dir, "..", `${path.basename(dir)}.json`);
  fs.writeFileSync(spec, JSON.stringify(screens));
  for (const s of screens) fs.mkdirSync(path.join(dir, path.dirname(s.name)), { recursive: true });
  execFileSync(SYNTH, [spec, dir]);
}
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-known-it-")));
const json = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const run = (dir, extra = []) => cli(["truncated", "shots", "--layout", "{locale}/{screen}", "--reasons", "ellipsis", "--results", "r.json", ...extra], { cwd: dir });

test("truncated: approve, rerun unchanged, add one, fix one, prune", () => {
  const dir = tmp();
  draw(path.join(dir, "shots"), [
    screen("de/home.png", "de", ["Jetzt kaufen...", "Startseite"]),
    screen("de/shop.png", "de", ["Angebote...", "Warenkorb"]),
  ]);
  const first = run(dir);
  assert.equal(first.code, 1, first.stderr);
  const found = json(dir, "r.json").results.reduce((n, r) => n + r.findings.length, 0);
  assert.ok(found >= 2, JSON.stringify(json(dir, "r.json").results.map((r) => r.findings)));

  const ap = cli(["results", "known", "r.json", "--out", "catscan-known.json"], { cwd: dir });
  assert.equal(ap.code, 0, ap.stderr);
  assert.match(ap.stdout, /next: add --known catscan-known\.json to the CI command/);

  const again = run(dir, ["--known", "catscan-known.json"]);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  const f2 = json(dir, "r.json");
  assert.ok(f2.results.every((r) => r.verdict === "pass" && r.findings.every((f) => f.known === true && f.gate === false)));
  assert.deepEqual(f2.known.counts, { known: found, new: 0, gone: 0 });
  assert.match(again.stdout, new RegExp(`${found} known, 0 new, 0 approved no longer found \\(catscan-known\\.json\\)`));
  // Coverage extension: known findings are not also counted as below threshold in the totals line (cli.js `below`).
  assert.doesNotMatch(again.stdout, /below threshold/);
  assert.equal(cli(["results", "validate", "r.json"], { cwd: dir }).code, 0);

  // Add a finding: only it is new.
  draw(path.join(dir, "shots"), [screen("de/home.png", "de", ["Jetzt kaufen...", "Mehr erfahren...", "Startseite"]), screen("de/shop.png", "de", ["Angebote...", "Warenkorb"])]);
  const added = run(dir, ["--known", "catscan-known.json"]);
  assert.equal(added.code, 1, added.stdout);
  const fresh = json(dir, "r.json").results.flatMap((r) => r.findings.filter((f) => f.known === false));
  assert.equal(fresh.length, 1, JSON.stringify(fresh));
  assert.match(fresh[0].line, /erfahren/i);
  assert.match(added.stdout, /\(new, not in catscan-known\.json\)/);

  // Fix one: gone is counted and the tighten line names --prune.
  draw(path.join(dir, "shots"), [screen("de/home.png", "de", ["Jetzt kaufen...", "Startseite"]), screen("de/shop.png", "de", ["Angebote", "Warenkorb"])]);
  const fixed = run(dir, ["--known", "catscan-known.json"]);
  assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
  assert.ok(json(dir, "r.json").known.counts.gone >= 1);
  assert.match(fixed.stdout, /^tighten: catscan results known r\.json --out catscan-known\.json --prune$/m);
  const before = json(dir, "catscan-known.json").findings.length;
  assert.equal(cli(["results", "known", "r.json", "--out", "catscan-known.json", "--prune"], { cwd: dir }).code, 0);
  assert.ok(json(dir, "catscan-known.json").findings.length < before);
});

test("shards: approved separately, merged with --known, give the verdicts of one run", () => {
  const dir = tmp();
  draw(path.join(dir, "shots"), [screen("de/home.png", "de", ["Jetzt kaufen..."]), screen("fr/home.png", "fr", ["Acheter maintenant..."])]);
  const shard = (loc, out, extra = []) => cli(["truncated", `shots/${loc}`, "--layout", "{locale}/{screen}", "--reasons", "ellipsis", "--results", out, ...extra], { cwd: dir });
  // The layout reads {locale}/{screen} from the path below the argument, so each shard runs on the whole tree's folder.
  for (const [loc, out] of [["de", "a.json"], ["fr", "b.json"]]) {
    assert.equal(shard(loc, out).code, 1);
    assert.equal(cli(["results", "known", out, "--out", "k.json"], { cwd: dir }).code, 0);
  }
  for (const [loc, out] of [["de", "a.json"], ["fr", "b.json"]]) assert.equal(shard(loc, out, ["--known", "k.json"]).code, 0);
  const m = cli(["results", "merge", "a.json", "b.json", "--out", "m.json", "--known", "k.json"], { cwd: dir });
  assert.equal(m.code, 0, m.stderr);
  const merged = json(dir, "m.json");
  assert.ok(merged.results.every((r) => r.verdict === "pass"));
  assert.equal(merged.known.counts.new, 0);
  assert.ok(merged.run.shards.every((s) => typeof s.known_digest === "string"));
});

test("formats: a rerun with the approved file passes with every finding known", () => {
  const dir = tmp();
  const F = path.join(__dirname, "fixtures/formats");
  execFileSync(SYNTH, [path.join(F, "screens.json"), dir]);
  const fmt = (extra) => cli(["formats", "f02-defects.png", "--locale", "de", "--storefront", "DE", "--layout", "none", "--results", "f.json", ...extra], { cwd: dir });
  assert.equal(fmt([]).code, 1);
  assert.equal(cli(["results", "known", "f.json", "--out", "k.json"], { cwd: dir }).code, 0);
  const again = fmt(["--known", "k.json"]);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.ok(json(dir, "f.json").results[0].findings.every((f) => f.known === true));
  // Coverage extension. Value: protects=TODO-055 D7 fail closed on a finding command; fails_when=a missing --known file is ignored or approves everything; why_new=only merge, report and MCP tested a missing file; seam=none; no_claim=none beyond protects
  const miss = fmt(["--known", "nope.json"]);
  assert.equal(miss.code, 1, miss.stdout + miss.stderr);
  assert.match(miss.stderr, /known-missing: nope\.json does not exist, so every finding is new/);
  assert.ok(json(dir, "f.json").results[0].findings.every((f) => f.known === false && f.gate === true));
});

test("report --known drops a baseline comparison made under the old verdicts", () => {
  // Value: protects=the review-only view after --known changes verdicts (review fix, specialist#1); fails_when=report keeps a stored baseline whose skippable cell now fails; why_new=review finding; seam=none; no_claim=report --baseline (compares again)
  const dir = tmp();
  draw(path.join(dir, "shots"), [screen("de/home.png", "de", ["Jetzt kaufen...", "Startseite"])]);
  assert.equal(run(dir).code, 1);
  assert.equal(cli(["results", "known", "r.json", "--out", "k.json"], { cwd: dir }).code, 0);
  assert.equal(run(dir, ["--known", "k.json"]).code, 0);
  const bl = cli(["results", "baseline", "r.json", "--out", "base.json"], { cwd: dir });
  assert.equal(bl.code, 0, bl.stderr);
  assert.equal(run(dir, ["--known", "k.json", "--baseline", "base.json"]).code, 0);
  assert.ok(json(dir, "r.json").baseline, "the stored comparison exists");
  fs.writeFileSync(path.join(dir, "k0.json"), JSON.stringify({ ...json(dir, "k.json"), findings: [] }, null, 2) + "\n");
  const r = cli(["report", "r.json", "--known", "k0.json", "--out", "r.html"], { cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  const data = JSON.parse(fs.readFileSync(path.join(dir, "r.html"), "utf8").match(/<script type="application\/json" id="catscan-data">([^]*?)<\/script>/)[1]);
  assert.ok(!JSON.stringify(data).includes('"review":false'), "no cell stays skippable under a stale comparison");
});

test("--known: a file approved on a {text_size}/ tree warns known-scope-differs on a run without the axis (TODO-084)", () => {
  // Value: protects=TODO-084 D1 cli.js runInfo.axes from known.runAxes; fails_when=the CLI still builds axes from devices only; why_new=the unit test calls runWarnings directly; seam=none; no_claim=fit wrapped pairing (unit only)
  const dir = tmp();
  draw(path.join(dir, "shots"), [
    screen("default/de/home.png", "de", ["Jetzt kaufen...", "Startseite"]),
    screen("large/de/home.png", "de", ["Jetzt kaufen...", "Startseite"]),
  ]);
  const sized = cli(["truncated", "shots", "--layout", "{text_size}/{locale}/{screen}", "--reasons", "ellipsis", "--results", "r.json"], { cwd: dir });
  assert.equal(sized.code, 1, sized.stderr);
  const ap = cli(["results", "known", "r.json", "--out", "k.json"], { cwd: dir });
  assert.equal(ap.code, 0, ap.stderr);
  assert.deepEqual(json(dir, "k.json").axes, ["text_size"]);
  const flat = cli(["truncated", "shots/default", "--layout", "{locale}/{screen}", "--reasons", "ellipsis", "--results", "flat.json", "--known", "k.json"], { cwd: dir });
  assert.equal(flat.code, 0, flat.stdout + flat.stderr);
  assert.match(flat.stderr, /known-scope-differs.*k\.json was approved with the text size axis, this run is without it; only default-size cells match across the two/);
  assert.match(flat.stderr, /catscan results known flat\.json --out k\.json/);
});
