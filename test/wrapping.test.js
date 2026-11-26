// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-074 integration (real Vision): a Core Text pair, en with a one-row button and de with the same button on two
// rows, plus a de title whose last row is one word; sidecars written from the drawn rows. `fit --reasons wrapped`
// gives one `wrapped` with base evidence; `--reasons orphan` one `orphan`; the base-pairing diagnostics on a real run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Ajv = require("ajv");
const { ROOT, setup, cli } = require("./helpers");

setup();
const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../core/schema/result.schema.json"));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-wrap-"));
const W = 1000, H = 1400;
// Rows of each element, drawn as separate lines by the safe-area generator (exact rows, no layout engine).
const SCREENS = {
  en: { cta: ["Start free trial"], title: ["Change your notification settings"] },
  de: { cta: ["Jetzt kostenlos", "testen"], title: ["Ihre persönlichen Einstellungen", "für Benachrichtigungen", "anpassen"] },
};
const TEXT = { en: { cta: "Start free trial", title: "Change your notification settings" }, de: { cta: "Jetzt kostenlos testen", title: "Ihre persönlichen Einstellungen für Benachrichtigungen anpassen" } };
const gen = path.join(DIR, "gen");
execFileSync("swiftc", ["-O", path.join(ROOT, "bench/safe-area/generate.swift"), "-o", gen]);
for (const [locale, els] of Object.entries(SCREENS)) {
  const items = [];
  for (const [id, rows] of Object.entries(els)) {
    const top = id === "title" ? 300 : 900;
    rows.forEach((t, k) => items.push({ id: `${id}#${k}`, text: t, size: 56, left: 120, top: top + k * 80 }));
  }
  const out = path.join(DIR, "shots", locale);
  fs.writeFileSync(path.join(DIR, `${locale}.json`), JSON.stringify([{ name: "paywall", locale, width: W, height: H, background: "plain", seed: 1, items }]));
  execFileSync(gen, [path.join(DIR, `${locale}.json`), out]);
  fs.rmSync(path.join(out, "paywall.truth.json"));
  // One element per label: the union of its rows' boxes; the button is a control.
  const drawn = JSON.parse(fs.readFileSync(path.join(out, "paywall.boxes.json"), "utf8")).elements;
  const elements = Object.keys(els).map((id) => {
    const bs = drawn.filter((e) => e.id.startsWith(`${id}#`)).map((e) => e.box);
    const x0 = Math.min(...bs.map((b) => b[0])), y0 = Math.min(...bs.map((b) => b[1]));
    const x1 = Math.max(...bs.map((b) => b[0] + b[2])), y1 = Math.max(...bs.map((b) => b[1] + b[3]));
    return { id, text: TEXT[locale][id], box: [x0, y0, Math.min(1, 0.85) - x0 > x1 - x0 ? 0.85 - x0 : x1 - x0, y1 - y0], ...(id === "cta" ? { control: true } : {}) };
  });
  fs.writeFileSync(path.join(out, "paywall.boxes.json"), JSON.stringify({ image: { width: W, height: H }, elements }));
}
const shots = path.join(DIR, "shots");

test("fit wrapped: a de button on two rows, one row in en, is wrapped by base evidence", () => {
  // Value: protects=the whole path (sidecars, base inputs first, element_rows, base_rows, rule, envelope); fails_when=the finding is missed, its evidence or base path is wrong, element_rows leaks, or the envelope breaks the schema; why_new=new reason; seam=none (real binary); no_claim=the gate (bench/wrapping.js)
  const r = cli(["fit", shots, "--json", "--boxes", shots, "--layout", "{locale}/{screen}", "--reasons", "wrapped"]);
  assert.equal(r.code, 1, r.stderr);
  for (const e of r.json) assert.ok(validate(e), JSON.stringify(validate.errors));
  const de = r.json.find((e) => e.locale === "de");
  assert.deepEqual(de.findings.map((f) => [f.reason, f.element.id, f.evidence, f.rows, f.base_rows]), [["wrapped", "cta", "base", 2, 1]]);
  assert.equal(de.findings[0].line, "Jetzt kostenlos / testen");
  assert.equal(de.findings[0].base_path, path.join(shots, "en", "paywall.png"));
  assert.deepEqual(de.reasons_run, ["wrapped"]);
  assert.ok(r.json.every((e) => !("element_rows" in e)), "element_rows is internal");
  assert.equal(r.json.find((e) => e.locale === "en").verdict, "pass");
  // The text line names the rows and the base screenshot.
  const t = cli(["fit", shots, "--boxes", shots, "--layout", "{locale}/{screen}", "--reasons", "wrapped"]);
  assert.match(t.stdout, /fit \(wrapped\) "Jetzt kostenlos \/ testen" in \[cta\] at \[[^\]]+\]: 2 rows, 1 in the base locale \(.*en\/paywall\.png\)/);
});

test("fit orphan: a de title whose last row is one word, only when named", () => {
  // Value: protects=orphan on Vision rows (one word, a third of the widest row) and its opt-in default (D7); fails_when=the orphan is missed or runs unnamed; why_new=new reason; seam=none; no_claim=NLTokenizer on other OS builds
  const r = cli(["fit", path.join(shots, "de"), "--json", "--boxes", path.join(shots, "de"), "--reasons", "orphan"]);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.json[0].findings.map((f) => [f.reason, f.element.id, f.orphan, f.rows]), [["orphan", "title", "anpassen", 3]]);
  const d = cli(["fit", path.join(shots, "de"), "--json", "--boxes", path.join(shots, "de"), "--experimental", "--reasons", "wrapped"]);
  assert.ok(d.json[0].findings.every((f) => f.reason !== "orphan"));
});

test("fit wrap diagnostics: no base, no boxes, unknown base locale", () => {
  // Value: protects=wrap-no-base (once, with the count; control evidence still used), wrap-needs-boxes (warning or exit 2, D11), unknown-base-locale (exit 2); fails_when=a skip is silent or the exit code is wrong; why_new=new diagnostics; seam=none; no_claim=none
  const n = cli(["fit", path.join(shots, "de"), "--json", "--boxes", path.join(shots, "de"), "--reasons", "wrapped"]);
  assert.equal((n.stderr.match(/wrap-no-base/g) || []).length, 1);
  assert.match(n.stderr, /1 of 1 screen has no en screenshot in this run; wrapped uses only declared and control evidence there - try: catscan fit \S*shots --boxes \S*shots --layout/);
  assert.deepEqual(n.json[0].findings.map((f) => f.evidence), ["control"]);
  const only = cli(["fit", shots, "--reasons", "wrapped,orphan"]);
  assert.equal(only.code, 2);
  assert.match(only.stderr, /wrap-needs-boxes: wrapped and orphan need element boxes - try: catscan fit .* --boxes /);
  const both = cli(["fit", shots, "--json", "--reasons", "corner,wrapped"]);
  assert.match(both.stderr, /wrap-needs-boxes: wrapped and orphan need element boxes; checked safe areas only/);
  const u = cli(["fit", shots, "--boxes", shots, "--layout", "{locale}/{screen}", "--reasons", "wrapped", "--base-locale", "fr"]);
  assert.equal(u.code, 2);
  assert.match(u.stderr, /unknown-base-locale: --base-locale fr: no input maps to locale fr/);
  // A base with no sidecar gives no rows: its targets lose base evidence, and the run says so once.
  const nb = path.join(DIR, "nobase");
  fs.cpSync(shots, nb, { recursive: true });
  fs.rmSync(path.join(nb, "en", "paywall.boxes.json"));
  const m = cli(["fit", nb, "--json", "--boxes", nb, "--layout", "{locale}/{screen}", "--reasons", "wrapped"]);
  assert.match(m.stderr, /wrap-no-base: 1 base screenshot gave no element rows \(\S*en\/paywall\.png; see its own line\)/);
  assert.deepEqual(m.json.find((e) => e.locale === "de").findings.map((f) => f.evidence), ["control"]);
});

test("fit wrapped on a {text_size}/ tree: a large target with only a default base gets none, and the hint keeps the run's layout (TODO-084)", () => {
  // Value: protects=TODO-084 D6 through the CLI: cli.js passes mapping.layout to wrapPlan, pairing within a text size; fails_when=the layout argument is dropped or a large target pairs with a default base; why_new=unit tests call wrapPlan directly; seam=none; no_claim=per-size pairing in the core
  const sized = path.join(DIR, "sized");
  fs.cpSync(path.join(shots, "en"), path.join(sized, "default", "en"), { recursive: true });
  fs.cpSync(path.join(shots, "de"), path.join(sized, "large", "de"), { recursive: true });
  const r = cli(["fit", sized, "--json", "--boxes", sized, "--layout", "{text_size}/{locale}/{screen}", "--reasons", "wrapped"]);
  assert.equal((r.stderr.match(/wrap-no-base/g) || []).length, 1, r.stderr);
  assert.match(r.stderr, /1 of 1 screen has no en screenshot at the same text size in this run; wrapped uses only declared and control evidence there - try: capture en screenshots at text size large, then: catscan fit \S*sized --boxes \S*sized --layout '\{text_size\}\/\{locale\}\/\{screen\}'/);
  assert.deepEqual(r.json.find((e) => e.locale === "de").findings.map((f) => f.evidence), ["control"]);
});

test("fit wrapped: --catalog pairs elements without ids by key; the second screen of a locale reuses the digest", () => {
  // Value: protects=catalog pairing end to end (entries on a locale's first target, digest alone on the next, D13); fails_when=the second target errors on an unknown digest or loses its key; why_new=the unit test covers wrapPlan only; seam=none (real binary); no_claim=the core's digest cache past 4 locales
  const cat = path.join(DIR, "app.xcstrings");
  const unit = (v) => ({ stringUnit: { state: "translated", value: v } });
  fs.writeFileSync(cat, JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: { "cta.trial": { localizations: { en: unit(TEXT.en.cta), de: unit(TEXT.de.cta) } } } }));
  const two = path.join(DIR, "catalog");
  for (const locale of ["en", "de"]) {
    fs.mkdirSync(path.join(two, locale), { recursive: true });
    const side = JSON.parse(fs.readFileSync(path.join(shots, locale, "paywall.boxes.json"), "utf8"));
    side.elements = side.elements.map((e) => ({ text: e.text, box: e.box })); // no id, no control: only the catalog pairs
    for (const screen of ["paywall", "paywall2"]) {
      fs.copyFileSync(path.join(shots, locale, "paywall.png"), path.join(two, locale, `${screen}.png`));
      fs.writeFileSync(path.join(two, locale, `${screen}.boxes.json`), JSON.stringify(side));
    }
  }
  const r = cli(["fit", two, "--json", "--boxes", two, "--layout", "{locale}/{screen}", "--reasons", "wrapped", "--catalog", cat]);
  assert.equal(r.code, 1, r.stderr);
  const de = r.json.filter((e) => e.locale === "de");
  assert.equal(de.length, 2);
  for (const e of de) assert.deepEqual(e.findings.map((f) => [f.reason, f.evidence, f.key]), [["wrapped", "base", "cta.trial"]], e.path);
});
