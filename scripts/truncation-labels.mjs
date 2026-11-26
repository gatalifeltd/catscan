#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 06 real-screen gate tooling (D12, D13, D21, D31, D32, D43-D47, D53, D55). Screens and labels stay in
// datasets/ (gitignored).
//   node scripts/truncation-labels.mjs manifest <root>   pair screenshots with dumps, write sidecars and manifest.json;
//                                                        prints the publishable summary (counts and hashes, no text)
//   node scripts/truncation-labels.mjs draft <root>      write draft labels (every recognized line) to labels.json
//   node scripts/truncation-labels.mjs score <root>      precision per reason, recall per class, Wilson 95% intervals,
//                                                        from checked labels only; plus every D82 anchor screen in the set
//   node scripts/truncation-labels.mjs review <root> [--by <name>] [--port <n>] [--second] [--no-open]
//                                                        the local label review page (npm run labels:review)
// <root> holds <app>/<locale>/<screen>.png plus one dump with the same base name (docs/truncation-capture.md).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { backup, startServer, writeJson } from "./truncation-review.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin/catscan.js");
export const DUMPS = { ".xcui.txt": "xcuitest", ".uia.xml": "uiautomator", ".maestro.json": "maestro", ".pw.json": "playwright", ".boxes.json": "boxes" };
export const MIN_CASES = 30;
const IOU = 0.3;

/** Wilson score interval at 95% for k successes of n. */
export function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Number(Math.max(0, c - h).toFixed(4)), Number(Math.min(1, c + h).toFixed(4))];
}

export function iou(a, b) {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const i = x * y;
  return i ? i / (a[2] * a[3] + b[2] * b[3] - i) : 0;
}

/** D13: checked images only, and screens sharing a layout count once per locale (the first by path). */
export function scoredImages(screens, labels) {
  const seen = new Set();
  const out = [];
  let drafts = 0, duplicates = 0;
  for (const s of [...screens].sort((a, b) => (a.image < b.image ? -1 : 1))) {
    const l = labels[s.image];
    if (!l || l.status !== "checked") { drafts++; continue; }
    const key = `${s.layout}\u0000${s.locale}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    out.push(s);
  }
  return { images: out, drafts, duplicates };
}

/**
 * D21, D32: a finding is a true positive when it overlaps a truncated label (IoU >= 0.3), whatever its reason.
 * `items`: [{ findings: [{reason, box}], lines: [{box, truncated, class}] }].
 */
export function score(items) {
  const reasons = {}, classes = {};
  let tp = 0, findings = 0, caught = 0, cut = 0;
  for (const it of items) {
    const truth = it.lines.filter((l) => l.truncated);
    const hit = new Set();
    for (const f of it.findings) {
      const r = (reasons[f.reason] ||= { findings: 0, tp: 0 });
      r.findings++; findings++;
      const m = truth.findIndex((l) => iou(f.box, l.box) >= IOU);
      if (m >= 0) { r.tp++; tp++; hit.add(m); }
    }
    truth.forEach((l, i) => {
      const c = (classes[l.class || "clip"] ||= { labels: 0, caught: 0 });
      c.labels++; cut++;
      if (hit.has(i)) { c.caught++; caught++; }
    });
  }
  const stat = (k, n) => ({ k, n, value: n ? Number((k / n).toFixed(4)) : null, ci95: wilson(k, n), too_few_cases: n < MIN_CASES });
  return {
    precision: stat(tp, findings), recall: stat(caught, cut),
    precision_by_reason: Object.fromEntries(Object.entries(reasons).map(([r, v]) => [r, stat(v.tp, v.findings)])),
    recall_by_class: Object.fromEntries(Object.entries(classes).map(([c, v]) => [c, stat(v.caught, v.labels)])),
  };
}

function walk(root) {
  const screens = [];
  for (const app of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const loc of fs.readdirSync(path.join(root, app.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const dir = path.join(root, app.name, loc.name);
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".png")).sort()) {
        const stem = f.slice(0, -4);
        const ext = Object.keys(DUMPS).find((e) => e !== ".boxes.json" && fs.existsSync(path.join(dir, stem + e)))
          || (fs.existsSync(path.join(dir, stem + ".boxes.json")) ? ".boxes.json" : null);
        screens.push({ image: path.join(app.name, loc.name, f), dump: ext ? path.join(app.name, loc.name, stem + ext) : null, source: ext ? DUMPS[ext] : null, app: app.name, locale: loc.name, screen: stem, layout: `${app.name}/${stem}` });
      }
    }
  }
  return screens;
}

const readJson = (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : fallback);

function manifest(root) {
  const old = new Map(readJson(path.join(root, "manifest.json"), { screens: [] }).screens.map((s) => [s.image, s]));
  const boxes = require("../packages/core-js/src/boxes");
  const screens = walk(root).map((s) => ({ ...s, layout: old.get(s.image)?.layout ?? s.layout }));
  for (const s of screens) {
    if (!s.source || s.source === "boxes") continue;
    const r = boxes.convert(s.source, path.join(root, s.dump), path.join(root, s.image));
    for (const w of r.warnings) process.stderr.write(`catscan: ${w.code}: ${w.message}\n`);
    fs.writeFileSync(path.join(root, s.image.slice(0, -4) + ".boxes.json"), JSON.stringify(r.boxes, null, 2) + "\n");
  }
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ screens }, null, 2) + "\n");
  const count = (k) => Object.fromEntries([...new Set(screens.map((s) => s[k]))].sort().map((v) => [v, screens.filter((s) => s[k] === v).length]));
  const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex");
  // Publishable: app aliases, locales, counts and hashes; never text or images (spec 06 "Privacy").
  process.stdout.write(JSON.stringify({
    screens: screens.length, with_boxes: screens.filter((s) => s.source).length, by_app: count("app"), by_locale: count("locale"),
    by_source: count("source"), layouts: new Set(screens.map((s) => s.layout)).size,
    hashes: Object.fromEntries(screens.map((s) => [s.image, hash(s.image)])),
  }, null, 2) + "\n");
}

/** One CLI run per app/locale folder; returns envelopes by image path relative to root. */
function runAll(root, command, screens) {
  const out = new Map();
  for (const dir of [...new Set(screens.map((s) => path.dirname(s.image)))]) {
    const locale = path.basename(dir);
    const args = [CLI, command, path.join(root, dir), "--locale", locale, "--json"];
    if (command === "truncated") args.push("--boxes", path.join(root, dir));
    const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
    // A failed run or an error envelope is not a clean screen: scoring it as one would inflate precision.
    if (![0, 1].includes(r.status)) throw new Error(`catscan ${command} ${dir}: exit ${r.status}: ${r.stderr}`);
    for (const l of r.stdout.split("\n").filter(Boolean)) {
      const env = JSON.parse(l);
      if (env.verdict === "error") throw new Error(`catscan ${command} ${env.path}: ${env.error?.code ?? "error"}: ${env.error?.message ?? ""}`);
      out.set(path.relative(root, env.path), env);
    }
    // D47: a crash exits 1 too (node's uncaught error); every image of the folder must have its envelope.
    const lost = screens.filter((s) => path.dirname(s.image) === dir && !out.has(s.image));
    if (lost.length) throw new Error(`catscan ${command} ${dir}: no result for ${lost.length} images (exit ${r.status}): ${r.stderr.split("\n")[0]}`);
  }
  return out;
}

/** D53: the class the page opens with, from the rule that fired. */
export const classOf = (reason) => (reason === "ellipsis" ? "ellipsis" : reason === "prefix" ? "prefix" : "edge");

function draft(root) {
  const { screens } = readJson(path.join(root, "manifest.json"), null) ?? (() => { throw new Error("run manifest first"); })();
  const file = path.join(root, "labels.json");
  const labels = readJson(file, {});
  const todo = screens.filter((s) => labels[s.image]?.status !== "checked"); // never overwrite a checked image
  const read = runAll(root, "read", todo), found = runAll(root, "truncated", todo);
  for (const s of todo) {
    const findings = found.get(s.image)?.findings ?? [];
    labels[s.image] = {
      status: "draft", checked_by: null, reviewed_by: null,
      lines: (read.get(s.image)?.lines ?? []).map((l) => {
        const f = findings.find((x) => x.line === l.text && iou(x.box, l.box) > 0.9);
        return { line: l.text, box: l.box, truncated: Boolean(f), class: f ? classOf(f.reason) : null, rule: f ? f.reason : null };
      }),
    };
  }
  const saved = backup(file);
  if (saved) process.stderr.write(`labels.json backed up to ${saved}\n`);
  writeJson(file, labels);
  process.stdout.write(`${todo.length} images drafted, ${screens.length - todo.length} checked kept; check them and set status: "checked"\n`);
}

/**
 * D82: each anchor screen in the set (any status; screen names may carry a `--<build>` suffix) and whether a finding
 * names the anchor's element text. Anchors are real truncations a rule change must not lose.
 */
export function anchorReport(screens, found, anchors) {
  const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
  return anchors.flatMap((a) => screens
    .filter((s) => s.app === a.app && s.locale === a.locale && s.screen.split("--")[0] === a.screen)
    .map((s) => ({ anchor: a.id, image: s.image, flagged: (found.get(s.image)?.findings ?? []).some((f) => f.expected != null && sha(f.expected) === a.text_sha256) })));
}

/** The spec 06 gate: precision with boxes, and every anchor present in the set flagged (D82). */
export const gateFails = (result, anchored) => !(result.precision.value >= 0.9) || anchored.some((a) => !a.flagged);

function scoreCommand(root) {
  const { screens } = readJson(path.join(root, "manifest.json"), { screens: [] });
  const labels = readJson(path.join(root, "labels.json"), {});
  const picked = scoredImages(screens.filter((s) => s.source), labels);
  const { anchors } = readJson(path.join(ROOT, "scripts/truncation-anchors.json"), { anchors: [] });
  const anchorScreens = screens.filter((s) => s.source && anchorReport([s], new Map(), anchors).length);
  const found = runAll(root, "truncated", [...new Set([...picked.images, ...anchorScreens])]);
  const result = score(picked.images.map((s) => ({ findings: found.get(s.image)?.findings ?? [], lines: labels[s.image].lines })));
  const anchored = anchorReport(anchorScreens, found, anchors);
  const v = require("../packages/core-js/src/client").versionInfo();
  process.stdout.write(JSON.stringify({
    spec: "06", script: "scripts/truncation-labels.mjs", images: picked.images.length, unchecked_skipped: picked.drafts, duplicate_layouts_skipped: picked.duplicates,
    locales: [...new Set(picked.images.map((s) => s.locale))].sort(), gate: { precision: 0.9, anchors: "all flagged" }, ...result,
    anchors: anchored, anchors_absent: anchors.filter((a) => !anchored.some((r) => r.anchor === a.id)).map((a) => a.id),
    tools: { catscan: v.catscan, macos: `${v.macos} (${v.macos_build})`, vision_revision: v.vision_revision, node: process.version },
  }, null, 2) + "\n");
  for (const a of anchored) process.stderr.write(`anchor ${a.anchor}: ${a.flagged ? "flagged" : "MISSED"} ${a.image}\n`);
  // D82: a set without the anchor screen (another set, or a renamed or undumped capture) says so instead of staying silent.
  for (const a of anchors) if (!anchored.some((r) => r.anchor === a.id)) process.stderr.write(`anchor ${a.id}: not in set\n`);
  if (gateFails(result, anchored)) process.exitCode = 1; // the JSON is still written
}

async function review(root, opts) {
  const flag = (k) => { const i = opts.indexOf(k); return i >= 0 ? opts[i + 1] : null; };
  let started;
  try {
    started = await startServer({ root, by: flag("--by"), port: flag("--port") ? Number(flag("--port")) : undefined, second: opts.includes("--second") });
  } catch (e) {
    process.stderr.write(`catscan: ${e.code === "missing-labels" ? "missing-labels" : "review-failed"}: ${e.message}\n`);
    process.exit(2);
  }
  process.stdout.write(`label review${opts.includes("--second") ? " (second review, 20% sample)" : ""}: ${started.url}  (Ctrl-C to stop)\n`);
  if (!opts.includes("--no-open")) spawnSync("open", [started.url]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, root, ...opts] = process.argv.slice(2);
  const run = { manifest, draft, score: scoreCommand, review }[cmd];
  if (!run || !root) {
    process.stderr.write("usage: node scripts/truncation-labels.mjs manifest|draft|score|review <root>\n");
    process.exit(2);
  }
  run(path.resolve(root), opts);
}
