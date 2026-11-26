// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 05 output: CSV files, summary rebuild, the Languages section, and the runner's options and messages.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const T = require("../languages/table");
const R = require("../languages/run");

const tools = { catscan: "0.10.1", macos: "27.2", macos_build: "26B123", vision_revision: 3 };
const sum = (locale, x = {}) => ({ locale, engine: "vision-accurate-rev3", gated: true, images: 30, errors: 0, checks: 40, correct: 40,
  check_accuracy: 100, fit_images: 10, fit_read: 10, fit_recall: 1, cer: 0, trunc_tp: 20, trunc_fp: 0, trunc_fn: 0, trunc_tn: 10,
  trunc_precision: 1, trunc_recall: 1, median_ms: 17, conf_fit: "0|0|0|0|0|0|0|0|0|10", conf_clip: "0|0|0|0|0|0|0|0|1|9", ...x });

test("language CSV: header row with versions, summary row, wrong images, quoting", () => {
  const rows = [{ image: "de/01-fit.png", case: "fit", present: "fail", absent: "pass", truncated: "no", cer: 2, read: 'Ein, "x"' }];
  const text = T.languageCsv(tools, sum("de"), rows);
  assert.equal(text.split("\n")[0], "# catscan=0.10.1 macos=27.2 macos_build=26B123 vision_revision=3");
  const back = T.readLanguageCsv(write(text));
  assert.deepEqual(back.summary, sum("de"));
  assert.deepEqual(back.rows, rows);
  assert.deepEqual(T.split('a,"b,""c""",'), ["a", 'b,"c"', ""]);
});

test("summary is rebuilt from language CSVs with the same stamp; another build is listed, not used (D12)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-out-"));
  fs.writeFileSync(path.join(dir, "de.csv"), T.languageCsv(tools, sum("de"), []));
  fs.writeFileSync(path.join(dir, "en.csv"), T.languageCsv(tools, sum("en"), []));
  fs.writeFileSync(path.join(dir, "ja.csv"), T.languageCsv({ ...tools, macos_build: "26A1" }, sum("ja"), []));
  const { summaries, stale } = T.collect(dir, tools, ["en", "de", "ja", "ko"]);
  assert.deepEqual(summaries.map((s) => s.locale), ["en", "de"]);
  assert.equal(stale.length, 1);
  assert.match(stale[0], /^ja\.csv .*26A1/);
  const back = T.readSummaryCsv(write(T.summaryCsv(tools, summaries)));
  assert.deepEqual(back.summaries, summaries);
});

test("Languages section: a table per macOS folder with a full run, rewritten only between the markers", () => {
  const res = fs.mkdtempSync(path.join(os.tmpdir(), "bench-res-"));
  fs.mkdirSync(path.join(res, "27.2"));
  fs.writeFileSync(path.join(res, "27.2/summary.csv"), T.summaryCsv(tools, [sum("en"), sum("vi", { gated: false, check_accuracy: 90 }), sum("de", { check_accuracy: 97 })]));
  fs.writeFileSync(path.join(res, "27.2/meta.json"), JSON.stringify({ machine: "Mac17,2", commit: "abc", date: "2026-11-06", timing: "idle",
    corpus: { icu: "78.3", cldr: "48.0", seed: 5 }, tools: { ...tools, chip: "Apple M5", node: "v24", swift: "Swift 6.4", tesseract: "tesseract 5.5.3", leptonica: "leptonica-1.87.0" } }));
  fs.mkdirSync(path.join(res, "26.1")); // only a quick run: no table
  const body = T.section(res);
  assert.match(body, /### macOS 27\.2/);
  assert.doesNotMatch(body, /### macOS 26\.1/);
  assert.match(body, /\| en \| vision-accurate-rev3 \| 100\.00% \| 1\.000 \| 0\.000 \| 1\.000 \/ 1\.000 \| 17 \| pass \|/);
  assert.match(body, /\| vi .* partial \|/);
  assert.match(body, /\| de .* fail \|/);
  assert.match(body, /Rerun \(full/);
  assert.match(body, /Rerun \(quick/);
  const doc = `# Title\n\nbefore\n${T.START}\nold\n${T.END}\nafter\n`;
  const next = T.rewrite(doc, body);
  assert.ok(next.startsWith("# Title\n\nbefore\n<!-- bench:languages:start -->"));
  assert.ok(next.endsWith(`${T.END}\nafter\n`));
  assert.doesNotMatch(next, /\nold\n/);
  assert.throws(() => T.rewrite("# no markers\n", body), /markers/);
  assert.match(T.section(fs.mkdtempSync(path.join(os.tmpdir(), "bench-empty-"))), /No full run is recorded yet/);
});

test("runner options: flags, values and usage errors exit 2", () => {
  assert.deepEqual(R.parseArgs(["--quick", "--lang", "de,ja", "--out", "x"]), { quick: true, record: false, lang: "de,ja", out: "x", keep: null, help: false });
  assert.throws(() => R.parseArgs(["--lang"]), (e) => e.exit === 2 && /needs a value/.test(e.message));
  assert.throws(() => R.parseArgs(["--lang", "--quick"]), (e) => e.exit === 2);
  assert.throws(() => R.parseArgs(["--fast"]), (e) => e.exit === 2 && /unknown option --fast/.test(e.message));
});

test("preflight names the fix for each missing prerequisite (D10)", () => {
  const ok = { binary: "/b", swiftc: "swift", doctor: { fallback: { path: "/t", locales: [{ locale: "el", installed: true }, { locale: "he", installed: false }] } } };
  assert.deepEqual(R.preflight(["de", "el"], ok), []);
  assert.match(R.preflight(["de"], { ...ok, binary: null }).join(), /npm run build/);
  assert.match(R.preflight(["de"], { ...ok, swiftc: null }).join(), /install Xcode/);
  const noTess = R.preflight(["de", "el"], { ...ok, doctor: { fallback: { path: null } } }).join();
  assert.match(noTess, /brew install tesseract tesseract-lang/);
  assert.match(noTess, /--lang de without the fallback/);
  assert.match(R.preflight(["he"], ok).join(), /language data missing for he: brew install tesseract-lang$/);
  assert.deepEqual(R.preflight(["de"], { ...ok, doctor: null }), []); // Vision locales need no Tesseract
});

test("quick regression report names the language, counts, misread images and --record (D13)", () => {
  const text = R.regressionReport(["de: check 38/40, recorded 40/40"], {
    de: [{ image: "de/02-fit-16-light-flat.png", present: "fail", absent: "pass", read: "Ein" }, { image: "de/03-clip.png", present: "", absent: "pass", truncated: "no" }],
  }, "27.2");
  assert.match(text, /de: check 38\/40, recorded 40\/40/);
  assert.match(text, /de\/02-fit-16-light-flat\.png: present fail, absent pass, read "Ein"/);
  assert.doesNotMatch(text, /03-clip/);
  assert.match(text, /rerun with --record and commit bench\/results\/27\.2\/quick-summary\.csv/);
});

test("pool runs every item with a bounded number in flight", async () => {
  let now = 0, max = 0;
  const seen = [];
  await R.pool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    now++; max = Math.max(max, now);
    await new Promise((r) => setTimeout(r, 2));
    seen.push(x); now--;
  });
  assert.equal(max, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
});

function write(text) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bench-csv-")), "x.csv");
  fs.writeFileSync(f, text);
  return f;
}
