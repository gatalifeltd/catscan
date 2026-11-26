// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 06 D43-D47, D53, D55-D57: the label review page's server and the draft safeguards, on synthetic data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REVIEW = path.join(__dirname, "../../../scripts/truncation-review.mjs");
const LABELS = path.join(__dirname, "../../../scripts/truncation-labels.mjs");
const lib = () => import(REVIEW);

const line = (truncated, cls = null) => ({ line: "Einstellun", box: [0.1, 0.1, 0.3, 0.02], truncated, class: cls, rule: truncated ? "edge" : null });

function dataset(n = 3) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  fs.mkdirSync(path.join(root, "app-1/de"), { recursive: true });
  const screens = [], labels = {};
  for (let i = 0; i < n; i++) {
    const image = `app-1/de/s${i}.png`;
    fs.writeFileSync(path.join(root, image), Buffer.from(`png ${i}`));
    screens.push({ image, app: "app-1", locale: "de", screen: `s${i}`, layout: `app-1/s${i}` });
    labels[image] = { status: "draft", checked_by: null, reviewed_by: null, lines: [line(true, "edge"), line(false)] };
  }
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ screens }));
  fs.writeFileSync(path.join(root, "labels.json"), JSON.stringify(labels));
  return root;
}

function request(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("second review: 20% of checked images rounded up, stable SHA-256 order, reviewed ones count (D46)", async () => {
  const { secondSample } = await lib();
  const images = Array.from({ length: 11 }, (_, i) => `a/de/s${i}.png`);
  const labels = Object.fromEntries(images.map((i, k) => [i, { status: k < 10 ? "checked" : "draft", checked_by: "a" }]));
  const s = secondSample(images, labels);
  assert.equal(s.quota, 2); // ceil(0.2 x 10); the draft image is not in the pool
  const rank = images.slice(0, 10).sort((a, b) => (crypto.createHash("sha256").update(a).digest("hex") < crypto.createHash("sha256").update(b).digest("hex") ? -1 : 1));
  assert.deepEqual(s.todo, rank.slice(0, 2));
  assert.deepEqual(secondSample([...images].reverse(), labels).todo, s.todo); // input order does not matter
  labels[rank[5]].reviewed_by = "b";
  const after = secondSample(images, labels);
  assert.deepEqual([after.reviewed, after.todo], [[rank[5]], [rank[0]]]);
});

test("saved entry: names, classes and boxes are checked; the server sets status (D44, D45, D57)", async () => {
  const { savedEntry, checkLines } = await lib();
  const draft = { status: "draft", checked_by: null, reviewed_by: null, lines: [] };
  assert.deepEqual(savedEntry(draft, [line(true, "prefix")], " Ann ", false), { status: "checked", checked_by: "Ann", reviewed_by: null, lines: [line(true, "prefix")] });
  // A line marked not truncated drops its class; a drawn box keeps `manual`.
  assert.deepEqual(checkLines([{ ...line(false), class: "edge" }, { ...line(true, "edge"), line: null, manual: true }]).map((l) => [l.class, l.manual]), [[null, undefined], ["edge", true]]);
  assert.throws(() => savedEntry(draft, [line(true, "clip")], "Ann", false), /lines\[0\]\.class must be ellipsis, edge, prefix/);
  assert.throws(() => savedEntry(draft, [line(true)], "Ann", false), /class/);
  assert.throws(() => savedEntry(draft, [{ ...line(false), box: [0.1, 0.1, 0, 0.1] }], "Ann", false), /lines\[0\]\.box/);
  assert.throws(() => savedEntry(draft, [{ ...line(false), truncated: "yes" }], "Ann", false), /truncated must be true or false/);
  assert.throws(() => savedEntry(draft, [], " ", false), /reviewer name/);
  assert.throws(() => savedEntry(undefined, [], "Ann", false), /no draft labels/);
  const checked = { ...draft, status: "checked", checked_by: "Ann" };
  assert.throws(() => savedEntry(draft, [], "Bo", true), /only a checked image/);
  assert.throws(() => savedEntry(checked, [], "Ann", true), /someone other than Ann/);
  assert.deepEqual(savedEntry(checked, [], "Bo", true), { status: "checked", checked_by: "Ann", reviewed_by: "Bo", lines: [] });
});

test("outset: 4 rendered pixels on each side at the drawn size, unchanged before the image has one (D71, D74)", async () => {
  const { outset } = await lib();
  const near = (got, want) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-12, `${got} vs ${want}`));
  near(outset([0.1, 0.2, 0.3, 0.05], 400, 800), [0.09, 0.195, 0.32, 0.06]);
  near(outset([0.1, 0.2, 0.3, 0.05], 800, 1600), [0.095, 0.1975, 0.31, 0.055]); // a 2x window: same 4 visible pixels
  assert.deepEqual(outset([0.1, 0.2, 0.3, 0.05], 0, 0), [0.1, 0.2, 0.3, 0.05]);
});

test("server: page, image, save with one backup per run, token, host and path checks (D43, D45, D47)", async (t) => {
  const { startServer } = await lib();
  const root = dataset();
  const { server, port, backup } = await startServer({ root, port: 0 });
  t.after(() => server.close());
  const page = await request(port, "GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Truncation labels<\/title>/);
  assert.doesNotMatch(page.body, /<script src|<link /); // offline: nothing external
  // D71, D74, D76: line and element boxes drawn outset at the rendered size; h hides every overlay and is in the help.
  assert.match(page.body, /const outset=function outset\(b, w, h, px = 4\)/);
  assert.match(page.body, /R\(O\(l\.box\),"v "/);
  assert.match(page.body, /R\(O\(x\.box\),"e"\)/);
  assert.match(page.body, /R\(l\.box,"hit",k\)/);
  assert.match(page.body, /\$\("img"\)\.addEventListener\("load",\(\)=>draw\(\)\)/);
  assert.match(page.body, /if\(!bare\)\{/);
  assert.match(page.body, /k==="h"\)\{bare=!bare;draw\(\)\}/);
  assert.match(page.body, /<kbd>h<\/kbd> hide all boxes/);
  const token = /const TOKEN="([0-9a-f]+)"/.exec(page.body)[1];
  const state = JSON.parse((await request(port, "GET", "/api/state")).body);
  assert.equal(state.screens.length, 3);
  assert.equal((await request(port, "GET", "/img?i=1")).body, "png 1");
  assert.equal((await request(port, "GET", "/img?i=9")).status, 404);
  // A manifest path through a symlinked folder that leaves the dataset is not served.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  fs.writeFileSync(path.join(outside, "s0.png"), "secret");
  fs.symlinkSync(outside, path.join(root, "app-1/link"));
  const m = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  m.screens.push({ image: "app-1/link/s0.png", app: "app-1", locale: "de", screen: "x", layout: "x" });
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(m));
  assert.equal((await request(port, "GET", "/img?i=3")).status, 404);
  assert.deepEqual(JSON.parse((await request(port, "GET", "/boxes?i=0")).body), { elements: [] });
  assert.equal((await request(port, "GET", "/", { headers: { host: "evil.example:80" } })).status, 403);
  const save = (i, lines, by, h = { "x-token": token }) => request(port, "POST", "/api/save", { body: { i, lines, by }, headers: h });
  assert.equal((await save(0, [line(true, "edge")], "Ann", { "x-token": "nope" })).status, 403);
  const bad = await save(0, [line(true, "clip")], "Ann");
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /class must be/);
  assert.equal(backup(), null); // nothing written yet
  assert.equal((await save(0, [line(true, "prefix")], "Ann")).status, 200);
  assert.equal((await save(1, [line(false)], "Ann")).status, 200);
  const labels = JSON.parse(fs.readFileSync(path.join(root, "labels.json"), "utf8"));
  assert.deepEqual([labels["app-1/de/s0.png"].status, labels["app-1/de/s0.png"].checked_by, labels["app-1/de/s0.png"].lines[0].class], ["checked", "Ann", "prefix"]);
  assert.equal(labels["app-1/de/s2.png"].status, "draft"); // other images untouched
  const baks = fs.readdirSync(root).filter((f) => f.startsWith("labels.json.bak-"));
  assert.equal(baks.length, 1); // the first write of the run only
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, baks[0]), "utf8"))["app-1/de/s0.png"].status, "draft");
  assert.ok(!fs.readdirSync(root).some((f) => f.includes(".tmp-")));
});

test("server: --second shows the sample and refuses the first checker (D57); missing labels name the commands (D55)", async (t) => {
  const { startServer } = await lib();
  const root = dataset(1);
  const f = path.join(root, "labels.json");
  const l = JSON.parse(fs.readFileSync(f, "utf8"));
  l["app-1/de/s0.png"] = { ...l["app-1/de/s0.png"], status: "checked", checked_by: "Ann" };
  fs.writeFileSync(f, JSON.stringify(l));
  const { server, port } = await startServer({ root, port: 0, second: true });
  t.after(() => server.close());
  const page = await request(port, "GET", "/");
  const token = /const TOKEN="([0-9a-f]+)"/.exec(page.body)[1];
  const state = JSON.parse((await request(port, "GET", "/api/state")).body);
  assert.deepEqual(state.sample.todo, ["app-1/de/s0.png"]);
  const save = (by) => request(port, "POST", "/api/save", { body: { i: 0, lines: [], by }, headers: { "x-token": token } });
  assert.match(JSON.parse((await save("Ann")).body).error, /someone other than Ann/);
  assert.equal(JSON.parse((await save("Bo")).body).entry.reviewed_by, "Bo");

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  const r = spawnSync(process.execPath, [LABELS, "review", empty, "--no-open"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), `catscan: missing-labels: ${path.join(empty, "manifest.json")} is missing; run: node scripts/truncation-labels.mjs manifest ${empty} && node scripts/truncation-labels.mjs draft ${empty}`);
});

test("draft: a folder whose run returns no result fails instead of writing empty drafts (D47); class from the rule (D53)", async () => {
  const { classOf } = await import(LABELS);
  assert.deepEqual(["ellipsis", "edge", "screen-edge", "prefix"].map(classOf), ["ellipsis", "edge", "edge", "prefix"]);
  const root = dataset(2);
  // Node's uncaught error exits 1 with no stdout, the code a finding also exits with.
  const crash = path.join(root, "crash.js");
  fs.writeFileSync(crash, "if (/catscan\\.js$/.test(process.argv[1] || '')) throw new Error('boom');");
  const before = fs.readFileSync(path.join(root, "labels.json"), "utf8");
  const r = spawnSync(process.execPath, [LABELS, "draft", root], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--require ${crash}` } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no result for 2 images \(exit 1\)/);
  assert.equal(fs.readFileSync(path.join(root, "labels.json"), "utf8"), before);
});
