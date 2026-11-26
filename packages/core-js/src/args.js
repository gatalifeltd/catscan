// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Command line parsing (spec 00, "Command line"). Usage errors are thrown as UsageError and exit 2.
const path = require("path");
const scale = require("./scale");

class UsageError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const COMMANDS = ["check", "read", "untranslated", "video", "truncated", "overlap", "formats", "fit", "contrast", "boxes", "languages", "doctor", "serve", "results", "report", "pseudo"];
const PSEUDO_VARIANTS = ["accent", "rtl", "tall"];
// Commands that return one result per input and can write a results file (spec 27).
const RUN_COMMANDS = ["check", "read", "untranslated", "video", "truncated", "overlap", "formats", "fit", "contrast"];
// TODO-077 D10, D27: the commands that emit findings take --min-severity and --min-certainty.
const THRESHOLD_COMMANDS = ["check", "untranslated", "truncated", "overlap", "formats", "fit", "contrast"];
// TODO-087 D1: the hyphen patterns read a locale token at the start or end of the file name.
const BASE_LAYOUTS = ["{locale}/{screen}", "{screen}.{locale}", "{screen}/{locale}", "{locale}-{screen}", "{screen}-{locale}"];
// TODO-075, TODO-076 D2: any base pattern may start with `{device}/`, then `{text_size}/`, in that fixed order.
const LAYOUTS = [...["", "{device}/"].flatMap((d) => ["", "{text_size}/"].flatMap((t) => BASE_LAYOUTS.map((b) => `${d}${t}${b}`))), "none"];
// TODO-075 "Label grammar": compared and stored in lower case. Text-size labels follow it too (TODO-076).
const DEVICE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TEXT_SIZE_RE = DEVICE_RE;
// Commands not built yet; they are known names, so typos still get a suggestion. User text names no spec (TODO-093).
const PLANNED_COMMANDS = [];

// name -> { value: takes a value, repeat: may repeat, commands: where it is valid (null: everywhere) }
const OPTIONS = {
  "--json": { value: false },
  "--format": { value: true },
  "--locale": { value: true },
  "--quiet": { value: false },
  "--help": { value: false },
  "--version": { value: false },
  "--present": { value: true, repeat: true, commands: ["check", "video"] },
  "--absent": { value: true, repeat: true, commands: ["check", "video"] },
  "--expect": { value: true, commands: ["check", "video"] },
  // video is listed so validate() can name what video does not take (spec 07 D20).
  "--fallback": { value: true, commands: ["check", "read", "untranslated", "video", "truncated", "overlap", "formats", "fit", "contrast"] },
  "--catalog": { value: true, repeat: true, commands: ["check", "untranslated", "video", "truncated", "fit"] },
  "--base": { value: true, commands: ["untranslated"] },
  "--base-locale": { value: true, commands: ["untranslated", "fit"] },
  "--allow": { value: true, commands: ["untranslated", "truncated", "overlap", "formats", "fit", "contrast"] },
  "--boxes": { value: true, commands: ["truncated", "untranslated", "overlap", "fit", "contrast"] },
  "--reasons": { value: true, commands: ["truncated", "fit"] },
  // TODO-073: the hardware profile and orientation of every input, and the shipped profile table.
  "--device-profile": { value: true, commands: ["fit"] },
  "--orientation": { value: true, commands: ["fit"] },
  "--list-devices": { value: false, commands: ["fit"] },
  // TODO-039 T2: checks on a pseudo-localized build (D8, D12, D15); --kinds and --dynamic per TODO-036 D15, D18.
  "--pseudo": { value: false, commands: ["untranslated", "truncated", "check"] },
  "--kinds": { value: true, commands: ["untranslated", "contrast"] },
  // TODO-054: the WCAG level and the device pixel ratio (D6, D10).
  "--level": { value: true, commands: ["contrast"] },
  "--scale": { value: true, commands: ["contrast"] },
  // TODO-036 T2: project languages for wrong-language when no {locale} catalog template names them (D4).
  "--languages": { value: true, commands: ["untranslated"] },
  "--dynamic": { value: true, commands: ["untranslated"] },
  // TODO-036 T4: uncatalogued text, opt-in (D10, D52): the same as adding uncatalogued to --kinds.
  "--uncatalogued": { value: false, commands: ["untranslated"] },
  // TODO-036 T3: storefront currency, price file and rule selection (D9, D15, D36).
  "--currency": { value: true, commands: ["formats"] },
  "--storefront": { value: true, commands: ["formats"] },
  "--prices": { value: true, commands: ["formats"] },
  "--rules": { value: true, commands: ["formats"] },
  "--min-overlap": { value: true, commands: ["overlap"] },
  "--experimental": { value: false, commands: ["overlap", "untranslated", "fit", "contrast"] },
  "--image": { value: true, commands: ["boxes"] },
  "--all-keys": { value: false, commands: ["check", "video"] },
  // TODO-007: a skipped check fails the run (exit 1); verdicts stay as they are.
  "--fail-on-skip": { value: false, commands: ["check", "video", "fit"] },
  // TODO-059 D4: doctor skips its npm update check.
  "--offline": { value: false, commands: ["doctor"] },
  // TODO-077 D10, D27: only findings at or above both levels gate; checks only (read, video) take neither.
  "--min-severity": { value: true, commands: [...THRESHOLD_COMMANDS, "results", "report"] },
  "--min-certainty": { value: true, commands: [...THRESHOLD_COMMANDS, "results", "report"] },
  "--every": { value: true, commands: ["video"] },
  "--from": { value: true, commands: ["video"] },
  "--to": { value: true, commands: ["video"] },
  "--frames": { value: false, commands: ["video"] },
  "--results": { value: true, commands: RUN_COMMANDS },
  "--build": { value: true, commands: RUN_COMMANDS },
  "--build-version": { value: true, commands: RUN_COMMANDS },
  "--layout": { value: true, commands: [...RUN_COMMANDS, "results", "report"] },
  // TODO-065 D10: doctor takes the same pair, so a CI preflight copies the args of its check line.
  "--expect-locales": { value: true, commands: [...RUN_COMMANDS, "results", "report", "doctor"] },
  "--expect-locales-from": { value: true, commands: [...RUN_COMMANDS, "results", "report", "doctor"] },
  "--expect-screens": { value: true, commands: [...RUN_COMMANDS, "results", "report"] },
  "--device": { value: true, commands: RUN_COMMANDS },
  "--expect-devices": { value: true, commands: [...RUN_COMMANDS, "results", "report"] },
  "--text-size": { value: true, commands: RUN_COMMANDS },
  "--expect-text-sizes": { value: true, commands: [...RUN_COMMANDS, "results", "report"] },
  "--out": { value: true, commands: ["results", "report", "pseudo"] },
  "--report": { value: true, commands: RUN_COMMANDS },
  "--report-images": { value: true, commands: [...RUN_COMMANDS, "report"] },
  "--report-max-edge": { value: true, commands: [...RUN_COMMANDS, "report"] },
  "--images-root": { value: true, commands: ["report"] },
  "--junit": { value: true, commands: RUN_COMMANDS },
  "--gitlab-codequality": { value: true, commands: RUN_COMMANDS },
  // TODO-038: changed-only review.
  "--baseline": { value: true, commands: [...RUN_COMMANDS, "results", "report"] },
  "--baseline-ignore": { value: true, commands: RUN_COMMANDS },
  "--text-record": { value: true, commands: RUN_COMMANDS },
  "--allow-incomplete": { value: false, commands: ["results"] },
  // TODO-055: results known --prune lowers approved counts only.
  "--prune": { value: false, commands: ["results"] },
  // TODO-055 T2: approved known findings never gate (D6); the finding commands, results merge and report.
  "--known": { value: true, commands: [...THRESHOLD_COMMANDS, "results", "report"] },
  // TODO-039 T1: the pseudo-locale generator.
  "--expand": { value: true, commands: ["pseudo"] },
  "--variant": { value: true, commands: ["pseudo"] },
  "--in-place": { value: false, commands: ["pseudo"] },
  "--force": { value: false, commands: ["pseudo"] },
};
// Options not built yet: recognized, so they get a clear message instead of a typo suggestion (TODO-093 D3, D4).
const PLANNED_OPTIONS = {
  "--escalate": { value: false },
};
const ALIASES = { "-h": "--help", "-q": "--quiet" };

const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function editDistance(a, b) {
  const x = [...a], y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/** The closest candidate within a small edit distance, or null. */
function closest(word, candidates) {
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(word, c);
    if (d < bestD) { best = c; bestD = d; }
  }
  return bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function plannedMessage(what) {
  return `${what} is not available in this version`;
}

/**
 * Parses argv (without node and script). Returns
 * { command, paths, present, absent, expect, catalogs, allKeys, base, baseLocale, allow, boxes, reasons, minOverlap, image, every, from, to, frames, locale, fallback, format, quiet, help, version }.
 */
function parse(argv) {
  const out = {
    command: null, paths: [], present: [], absent: [], expect: null, catalogs: [], allKeys: false, failOnSkip: false, offline: false, base: null, baseLocale: null, allow: null,
    boxes: null, reasons: null, minOverlap: null, image: null, deviceProfile: null, orientation: null, listDevices: false,
    every: null, from: null, to: null, frames: false, experimental: false, locale: null, fallback: null,
    results: null, junit: null, gitlabCodequality: null, build: null, buildVersion: null, layout: null, expectLocales: null, expectLocalesFrom: null, expectScreens: null, device: null, expectDevices: null, textSize: null, expectTextSizes: null, out: null,
    report: null, reportImages: null, reportMaxEdge: null, imagesRoot: null,
    baseline: null, baselineIgnore: null, textRecord: null, allowIncomplete: false, prune: false, known: null,
    expand: null, variant: null, inPlace: false, force: false,
    minSeverity: null, minCertainty: null, level: null, scale: null,
    pseudo: false, uncatalogued: false, kinds: null, dynamic: null, languages: null, currency: null, storefront: null, prices: null, rules: null,
    format: null, json: false, quiet: false, help: false, version: false,
  };
  let i = 0;
  let endOfOptions = false;
  const allOptions = [...Object.keys(OPTIONS), ...Object.keys(PLANNED_OPTIONS)];
  while (i < argv.length) {
    let a = argv[i++];
    if (endOfOptions || a === "-" || !a.startsWith("-")) {
      if (out.command === null && !endOfOptions) {
        if (COMMANDS.includes(a)) { out.command = a; continue; }
        if (PLANNED_COMMANDS.includes(a)) throw new UsageError("command-not-available", plannedMessage(`the command ${a}`), "catscan --help");
        const s = closest(a, [...COMMANDS, ...PLANNED_COMMANDS]);
        throw new UsageError("unknown-command", `unknown command ${a}${s ? `; did you mean ${s}?` : ""}`, s ? `catscan ${s}` : "catscan --help");
      }
      out.paths.push(a);
      continue;
    }
    if (a === "--") { endOfOptions = true; continue; }
    let value;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) { value = a.slice(eq + 1); a = a.slice(0, eq); }
    a = ALIASES[a] || a;
    const planned = PLANNED_OPTIONS[a];
    if (planned) throw new UsageError("option-not-available", plannedMessage(a), `run the same command without ${a}`);
    const spec = OPTIONS[a];
    if (!spec) {
      const s = closest(a, allOptions);
      throw new UsageError("unknown-option", `unknown option ${a}${s ? `; did you mean ${s}?` : ""}`, s || "catscan --help");
    }
    if (spec.value) {
      if (value === undefined) {
        if (i >= argv.length) throw new UsageError("missing-value", `${a} needs a value`);
        value = argv[i++];
      }
    } else if (value !== undefined) {
      throw new UsageError("unexpected-value", `${a} does not take a value`);
    }
    if (spec.commands && out.command !== null && !spec.commands.includes(out.command)) {
      throw new UsageError("option-not-valid", `${a} is not valid for ${out.command}`, `catscan ${out.command} --help`);
    }
    switch (a) {
      case "--json": out.json = true; break;
      case "--format": out.format = value; break;
      case "--locale": out.locale = value; break;
      case "--fallback": out.fallback = value; break;
      case "--quiet": out.quiet = true; break;
      case "--help": out.help = true; break;
      case "--version": out.version = true; break;
      case "--present": out.present.push(value); break;
      case "--absent": out.absent.push(value); break;
      case "--catalog": out.catalogs.push(value); break;
      case "--all-keys": out.allKeys = true; break;
      case "--fail-on-skip": out.failOnSkip = true; break;
      case "--offline": out.offline = true; break;
      case "--frames": out.frames = true; break;
      case "--experimental": out.experimental = true; break;
      case "--allow-incomplete": out.allowIncomplete = true; break;
      case "--prune": out.prune = true; break;
      case "--in-place": out.inPlace = true; break;
      case "--force": out.force = true; break;
      case "--pseudo": out.pseudo = true; break;
      case "--uncatalogued": out.uncatalogued = true; break;
      case "--list-devices": out.listDevices = true; break;
      case "--every": case "--from": case "--to": {
        const k = a.slice(2);
        if (out[k] !== null) throw new UsageError("repeated-option", `${a} can be given once`);
        out[k] = value; break;
      }
      case "--base": case "--base-locale": case "--allow": case "--boxes": case "--reasons": case "--image": case "--min-overlap": {
        const k = { "--base": "base", "--base-locale": "baseLocale", "--allow": "allow", "--boxes": "boxes", "--reasons": "reasons", "--image": "image", "--min-overlap": "minOverlap" }[a];
        if (out[k] !== null) throw new UsageError("repeated-option", `${a} can be given once`);
        out[k] = value; break;
      }
      case "--results": case "--build": case "--build-version": case "--layout": case "--expect-locales":
      case "--expect-locales-from": case "--expect-screens": case "--device": case "--expect-devices": case "--text-size": case "--expect-text-sizes": case "--out": case "--junit": case "--gitlab-codequality":
      case "--report": case "--report-images": case "--report-max-edge": case "--images-root":
      case "--baseline": case "--baseline-ignore": case "--text-record": case "--expand": case "--variant":
      case "--kinds": case "--dynamic": case "--languages": case "--currency": case "--storefront": case "--prices": case "--rules":
      case "--min-severity": case "--min-certainty": case "--known": case "--device-profile": case "--orientation": case "--level": case "--scale": {
        const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (out[k] !== null) throw new UsageError("repeated-option", `${a} can be given once`);
        out[k] = value; break;
      }
      case "--expect":
        if (out.expect !== null) throw new UsageError("repeated-option", "--expect can be given once");
        out.expect = value; break;
    }
  }
  return validate(out);
}

const SECONDS = /^(\d+(\.\d+)?|\.\d+)$/;

/** spec 07 D6, D17, D20: syntax only; the core checks the values against the video. */
function validateVideo(o) {
  if (o.allKeys || o.fallback !== null || o.paths.includes("-")) {
    throw new UsageError("option-not-valid", "--all-keys, --fallback and - (stdin) do not work with video", 'catscan video take.mp4 --present "..."');
  }
  if (o.frames && o.format !== "json") throw new UsageError("option-not-valid", "--frames needs --json", "catscan video take.mp4 --json --frames");
  const num = (flag, v, ok, rule, hint) => {
    if (v === null) return null;
    const n = SECONDS.test(v) ? Number(v) : NaN;
    if (!Number.isFinite(n) || !ok(n)) throw new UsageError("invalid-value", `${flag} must be ${rule}, not ${v}`, hint);
    return n;
  };
  o.every = num("--every", o.every, (n) => n > 0, "a number of seconds above 0", "--every 0.5");
  o.from = num("--from", o.from, () => true, "a number of seconds, 0 or more", "--from 0");
  o.to = num("--to", o.to, (n) => n > (o.from ?? 0), `a number of seconds above --from (${o.from ?? 0})`, `--to ${(o.from ?? 0) + 1}`);
}

/** spec 18: --report, --report-images, --report-max-edge and --images-root. */
function validateReport(o) {
  if (o.report !== null && !RUN_COMMANDS.includes(o.command)) {
    throw new UsageError("option-not-valid", `--report works only with ${RUN_COMMANDS.join(", ")}; catscan report renders results files`, "catscan report catscan-results.json");
  }
  if (o.imagesRoot !== null && o.command !== "report") throw new UsageError("option-not-valid", "--images-root works only with catscan report", "catscan report catscan-results.json --images-root .");
  if ((o.reportImages !== null || o.reportMaxEdge !== null) && o.command !== "report" && o.report === null) {
    throw new UsageError("option-not-valid", "--report-images and --report-max-edge need --report", "--report catscan-report.html --report-images link");
  }
  if (o.reportImages !== null && !["embed", "link"].includes(o.reportImages)) {
    throw new UsageError("invalid-value", `--report-images must be embed or link, not ${o.reportImages}`, "--report-images link");
  }
  if (o.reportMaxEdge !== null) {
    const n = /^\d+$/.test(o.reportMaxEdge) ? Number(o.reportMaxEdge) : NaN;
    if (!(n >= 64 && n <= 4096)) throw new UsageError("invalid-value", `--report-max-edge must be a whole number of pixels from 64 to 4096, not ${o.reportMaxEdge}`, "--report-max-edge 600");
    o.reportMaxEdge = n;
  }
}

/** `catscan report <results.json...>` (spec 18 D25). */
function validateReportCommand(o, expectFlags) {
  if (o.paths.length === 0) throw new UsageError("missing-path", "report needs at least one results file", "catscan report catscan-results.json");
  if (o.paths.includes("-")) throw new UsageError("option-not-valid", "report reads results files, not stdin", "catscan report catscan-results.json");
  if (o.format !== "text") throw new UsageError("option-not-valid", "report writes --out; it has no --json or --format output", "catscan report catscan-results.json --out catscan-report.html");
  if (o.locale !== null || o.fallback !== null) throw new UsageError("option-not-valid", "report takes no --locale or --fallback", "catscan --help");
  if (o.out === null) o.out = "catscan-report.html";
  const key = (f) => path.resolve(f).normalize("NFC").toLowerCase();
  if (o.paths.some((f) => key(f) === key(o.out))) throw new UsageError("conflicting-options", `--out ${o.out} is also an input`, "catscan report catscan-results.json --out catscan-report.html");
}

/** TODO-038: --baseline, --baseline-ignore and --text-record. */
function validateBaseline(o) {
  if (o.textRecord !== null && !["full", "digest", "none"].includes(o.textRecord)) {
    throw new UsageError("invalid-value", `--text-record must be full, digest or none, not ${o.textRecord}`, "--text-record digest");
  }
  if (o.baselineIgnore !== null && o.textRecord === "none") {
    throw new UsageError("conflicting-options", "--baseline-ignore shapes the text record, which --text-record none omits", "--text-record digest");
  }
  // A run or merge writing over its own baseline would replace the approved file with an unapproved one.
  const key = (f) => path.resolve(f).normalize("NFC").toLowerCase();
  if (o.baseline !== null) {
    for (const [flag, f] of [["--results", o.results], ["--out", o.out], ["--junit", o.junit], ["--gitlab-codequality", o.gitlabCodequality], ["--report", o.report],
      ["GITHUB_STEP_SUMMARY", o.format === "github" && process.env.GITHUB_STEP_SUMMARY ? process.env.GITHUB_STEP_SUMMARY : null]]) {
      if (f !== null && key(f) === key(o.baseline)) throw new UsageError("conflicting-options", `${flag} ${f} is also the --baseline file`, "write this run to a new file, such as catscan-results.json");
    }
  }
  if (o.baseline !== null && o.paths.includes("-") && o.command !== "results") {
    throw new UsageError("option-not-valid", "--baseline compares cells by path, and stdin has none", "pass the screenshots as files");
  }
}

/** spec 27: the results file, layout and expectation options, and `results merge|validate`. */
function validateResults(o) {
  const expectFlags = o.expectLocales !== null || o.expectLocalesFrom !== null || o.expectScreens !== null || o.expectDevices !== null || o.expectTextSizes !== null;
  if (o.device !== null) {
    if (!DEVICE_RE.test(o.device.toLowerCase())) throw new UsageError("invalid-device", `--device needs a label of a-z, 0-9, ".", "_" or "-" (up to 64, starting with a letter or digit), not ${o.device}`, "--device ios-se");
    o.device = o.device.toLowerCase();
  }
  if (o.textSize !== null) {
    if (!TEXT_SIZE_RE.test(o.textSize.toLowerCase())) throw new UsageError("invalid-text-size", `--text-size needs a label of a-z, 0-9, ".", "_" or "-" (up to 64, starting with a letter or digit), such as default or large, not ${o.textSize}`, "--text-size large");
    o.textSize = o.textSize.toLowerCase();
  }
  // Also when the option came before the command, which parse() cannot check yet.
  if (!RUN_COMMANDS.includes(o.command) && (o.results !== null || o.build !== null || o.buildVersion !== null || o.junit !== null || o.gitlabCodequality !== null || o.format === "github")) {
    throw new UsageError("option-not-valid", `--results, --junit, --gitlab-codequality, --format github, --build and --build-version work only with ${RUN_COMMANDS.join(", ")}`, "catscan check shots --present Continue --results catscan-results.json");
  }
  // Two writers to one file would leave only the last (spec 15). APFS volumes are case- and normalization-insensitive
  // by default, so names compare NFC and case-folded; under --format github the job summary is a writer too.
  const outFiles = [["--results", o.results], ["--junit", o.junit], ["--gitlab-codequality", o.gitlabCodequality], ["--report", o.report],
    ["GITHUB_STEP_SUMMARY", o.format === "github" && process.env.GITHUB_STEP_SUMMARY ? process.env.GITHUB_STEP_SUMMARY : null]].filter(([, f]) => f !== null);
  const key = (f) => path.resolve(f).normalize("NFC").toLowerCase();
  const same = (a, b) => key(a) === key(b);
  for (let i = 0; i < outFiles.length; i++) for (let j = i + 1; j < outFiles.length; j++) {
    if (same(outFiles[i][1], outFiles[j][1])) {
      throw new UsageError("conflicting-options", `${outFiles[i][0]} and ${outFiles[j][0]} name the same file ${outFiles[i][1]}`, "--junit catscan.xml --gitlab-codequality catscan-cq.json --results catscan-results.json");
    }
  }
  const doctorLocales = o.command === "doctor" && o.layout === null && o.expectScreens === null;
  if (![...RUN_COMMANDS, "results", "report"].includes(o.command) && !doctorLocales && (o.layout !== null || expectFlags)) {
    throw new UsageError("option-not-valid", "--layout and the --expect-locales/--expect-screens options work only with a checking command, results merge or report", "catscan --help");
  }
  validateReport(o);
  if (o.layout !== null && !LAYOUTS.includes(o.layout)) {
    const s = closest(o.layout, LAYOUTS);
    throw new UsageError("invalid-layout", `--layout must be ${BASE_LAYOUTS.join(", ")} (each may start with {device}/, then {text_size}/) or none, not ${o.layout}`, `--layout '${s || LAYOUTS[0]}'`);
  }
  if (o.layout === "none" && expectFlags) {
    throw new UsageError("conflicting-options", "--layout none maps no input to a locale and screen, so expected coverage cannot be checked", "--layout '{locale}/{screen}'");
  }
  if (o.out !== null && !["results", "report", "pseudo"].includes(o.command)) throw new UsageError("option-not-valid", "--out works only with results merge, report and pseudo", "catscan results merge a.json b.json --out merged.json");
  validateBaseline(o);
  if (o.command === "report") return validateReportCommand(o, expectFlags);
  if (o.command !== "results") return;
  const [sub, ...files] = o.paths;
  if (!["merge", "validate", "baseline", "known"].includes(sub)) {
    const s = sub && closest(sub, ["merge", "validate", "baseline", "known"]);
    throw new UsageError(sub ? "unknown-command" : "missing-command", sub ? `unknown results command ${sub}${s ? `; did you mean ${s}?` : ""}` : "results needs merge, validate, baseline or known",
      `catscan results ${s || "validate"} catscan-results.json`);
  }
  o.subcommand = sub;
  o.paths = files;
  if (o.allowIncomplete && sub !== "baseline") throw new UsageError("option-not-valid", "--allow-incomplete works only with results baseline", "catscan results baseline catscan-results.json --out catscan-baseline.json --allow-incomplete");
  if (o.baseline !== null && sub !== "merge") throw new UsageError("option-not-valid", `--baseline works with results merge, not results ${sub}`, "catscan results merge shard-*.json --baseline catscan-baseline.json --out catscan-results.json");
  if (o.known !== null && sub !== "merge") throw new UsageError("option-not-valid", `--known works with results merge, not results ${sub}`, "catscan results merge shard-*.json --known catscan-known.json --out catscan-results.json");
  if (o.prune && sub !== "known") throw new UsageError("option-not-valid", "--prune works only with results known", "catscan results known catscan-results.json --out catscan-known.json --prune");
  if (sub === "known") {
    // TODO-055: approves every approvable finding of the given results files into --out.
    const hint = "catscan results known catscan-results.json --out catscan-known.json";
    if (files.length === 0) throw new UsageError("missing-path", "results known needs at least one results file", hint);
    if (o.out === null) throw new UsageError("missing-value", "results known needs --out <file>", hint);
    if (o.layout !== null || expectFlags || o.format !== "text") throw new UsageError("option-not-valid", "results known takes only results files, --out and --prune", hint);
    const key = (f) => path.resolve(f).normalize("NFC").toLowerCase();
    if (files.some((f) => key(f) === key(o.out))) throw new UsageError("conflicting-options", `--out ${o.out} is also an input`, "write the known file to its own path, such as catscan-known.json");
  } else if (sub === "baseline") {
    if (files.length !== 1) throw new UsageError("missing-path", "results baseline approves exactly one results file", "catscan results baseline catscan-results.json --out catscan-baseline.json");
    if (o.out === null) throw new UsageError("missing-value", "results baseline needs --out <file>", "catscan results baseline catscan-results.json --out catscan-baseline.json");
    if (o.layout !== null || expectFlags || o.format !== "text") throw new UsageError("option-not-valid", "results baseline takes only a file, --out and --allow-incomplete", "catscan results baseline catscan-results.json --out catscan-baseline.json");
    const key = (f) => path.resolve(f).normalize("NFC").toLowerCase();
    if (key(files[0]) === key(o.out)) throw new UsageError("conflicting-options", `--out ${o.out} is also the input`, "write the baseline to a new path, such as catscan-baseline.json");
  } else if (sub === "validate") {
    if (files.length !== 1) throw new UsageError("missing-path", "results validate takes exactly one results file", "catscan results validate catscan-results.json");
    if (o.out !== null || o.layout !== null || expectFlags) throw new UsageError("option-not-valid", "results validate takes only a file and --json", "catscan results validate catscan-results.json");
  } else {
    if (files.length === 0) throw new UsageError("missing-path", "results merge needs at least one results file", "catscan results merge shard-*.json --out catscan-results.json");
    if (o.out === null) throw new UsageError("missing-value", "results merge needs --out <file>", "catscan results merge shard-*.json --out catscan-results.json");
    if (o.format !== "text") throw new UsageError("option-not-valid", "results merge writes --out; it has no --json output", "catscan results merge shard-*.json --out catscan-results.json");
  }
  if (o.locale !== null || o.fallback !== null) throw new UsageError("option-not-valid", "results takes no --locale or --fallback", "catscan results --help");
  if ((o.minSeverity !== null || o.minCertainty !== null) && sub !== "merge") {
    throw new UsageError("option-not-valid", `--min-severity and --min-certainty work with results merge, not results ${sub}`, "catscan results merge shard-*.json --min-certainty medium --out catscan-results.json");
  }
}

/** TODO-077: --min-severity and --min-certainty, checked here also when they came before the command. */
function validateThresholds(o) {
  const given = o.minSeverity !== null || o.minCertainty !== null;
  if (given && ![...THRESHOLD_COMMANDS, "results", "report"].includes(o.command)) {
    const flag = o.minSeverity !== null ? "--min-severity" : "--min-certainty";
    throw new UsageError("option-not-valid", `${flag} is not valid for ${o.command}`, `catscan ${o.command} --help`);
  }
  if (o.minSeverity !== null) scale.parseLevel("--min-severity", o.minSeverity, UsageError);
  if (o.minCertainty !== null) scale.parseLevel("--min-certainty", o.minCertainty, UsageError);
  // The run's thresholds: the defaults gate everything (D4). `given` tells merge and report to recompute (D15).
  o.thresholds = { min_severity: o.minSeverity ?? scale.DEFAULTS.min_severity, min_certainty: o.minCertainty ?? scale.DEFAULTS.min_certainty };
  o.thresholdsGiven = given;
}

/** TODO-039 T1 (D7): `catscan pseudo <catalog>` writes one file; its option values are checked here. */
function validatePseudo(o) {
  if (o.command !== "pseudo") {
    if (o.expand !== null || o.variant !== null || o.inPlace || o.force) {
      throw new UsageError("option-not-valid", "--expand, --variant, --in-place and --force work only with pseudo", "catscan pseudo locales/en.json --expand 40");
    }
    return;
  }
  if (o.paths.length !== 1 || o.paths[0] === "-") throw new UsageError("missing-path", "pseudo takes exactly one catalog file", "catscan pseudo locales/en.json");
  if (o.format === "github") throw new UsageError("option-not-valid", "pseudo prints text or --json, not --format github", "catscan pseudo locales/en.json --json");
  if (o.fallback !== null) throw new UsageError("option-not-valid", "pseudo reads no images, so it takes no --fallback", "catscan pseudo locales/en.json");
  if (o.variant !== null && !PSEUDO_VARIANTS.includes(o.variant)) {
    const s = closest(o.variant, PSEUDO_VARIANTS);
    throw new UsageError("unknown-variant", `--variant must be ${PSEUDO_VARIANTS.join(", ")}, not ${o.variant}${s ? `; did you mean ${s}?` : ""}`, `--variant ${s || "accent"}`);
  }
  if (o.expand !== null) {
    if (!/^\d+$/.test(o.expand) || Number(o.expand) > 300) throw new UsageError("invalid-expand", `--expand must be a whole percent from 0 to 300, not ${o.expand}`, "--expand 40");
    o.expand = Number(o.expand);
  }
}

const KINDS = ["untranslated", "raw-key", "placeholder", "hardcoded", "wrong-language", "uncatalogued"];
/** The kinds untranslated reports without --kinds (uncatalogued and hardcoded are opt-in). */
const DEFAULT_KINDS = ["untranslated", "raw-key", "placeholder", "wrong-language"];

/** TODO-039 T2: `--pseudo` on untranslated, truncated and check (D8, D12); `--kinds` and `--dynamic` (D15, TODO-036 D15, D18). */
function validatePseudoChecks(o) {
  if (o.pseudo && !["untranslated", "truncated", "check"].includes(o.command)) {
    throw new UsageError("option-not-valid", "--pseudo works only with untranslated, truncated and check", "catscan untranslated shots/ --pseudo --catalog locales/en.json");
  }
  if (o.pseudo && o.base !== null) {
    throw new UsageError("pseudo-conflicts-with-base", "--pseudo takes the base catalog with --catalog; drop --base", "catscan untranslated shots/ --pseudo --catalog locales/en.json");
  }
  if (o.pseudo && o.command !== "check" && o.catalogs.length === 0) {
    throw new UsageError("missing-catalog", `${o.command} --pseudo needs the base catalog with --catalog`, `catscan ${o.command} shots/ --pseudo --catalog locales/en.json`);
  }
  if (o.dynamic !== null && o.command !== "untranslated") {
    throw new UsageError("option-not-valid", "--kinds and --dynamic work only with untranslated (--kinds also with contrast)", "catscan untranslated shots/ --pseudo --catalog locales/en.json --kinds hardcoded");
  }
  if (o.command === "contrast") { // TODO-054: contrast.validate checks its own --kinds
    if (o.uncatalogued || o.pseudo) throw new UsageError("option-not-valid", "--uncatalogued and --pseudo work only with untranslated (and --pseudo with check)", "catscan contrast shots/ --experimental");
    return;
  }
  if (o.kinds !== null && o.command !== "untranslated") {
    throw new UsageError("option-not-valid", "--kinds and --dynamic work only with untranslated (--kinds also with contrast)", "catscan untranslated shots/ --pseudo --catalog locales/en.json --kinds hardcoded");
  }
  if (o.uncatalogued && o.pseudo) {
    throw new UsageError("conflicting-options", "--uncatalogued does not work with --pseudo: a pseudo build reports text missing from the catalog as hardcoded", "catscan untranslated shots/ --pseudo --catalog locales/en.json --kinds hardcoded");
  }
  if (o.uncatalogued && o.catalogs.length === 0) {
    throw new UsageError("missing-catalog", "--uncatalogued needs the run locale's catalog with --catalog", "catscan untranslated shots/de --locale de --catalog 'locales/{locale}.json' --uncatalogued");
  }
  if (o.dynamic !== null && !o.pseudo && !o.uncatalogued) {
    throw new UsageError("option-not-valid", "--dynamic works with untranslated --uncatalogued or --pseudo (lines they never report)", "catscan untranslated shots/ --catalog 'locales/{locale}.json' --uncatalogued --dynamic dynamic.txt");
  }
  if (o.kinds !== null) {
    const list = o.kinds.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) throw new UsageError("unknown-kind", "--kinds needs at least one kind", `--kinds ${KINDS.join(",")}`);
    for (const k of list) {
      if (!KINDS.includes(k)) {
        const s = closest(k, KINDS);
        throw new UsageError("unknown-kind", `--kinds: unknown kind ${k}${s ? `; did you mean ${s}?` : ""}`, `--kinds ${KINDS.join(",")}`);
      }
    }
    if (list.includes("hardcoded") && !o.pseudo) throw new UsageError("option-not-valid", "--kinds hardcoded needs --pseudo (a pseudo-localized build)", "catscan untranslated shots/ --pseudo --catalog locales/en.json --kinds hardcoded");
    if (o.uncatalogued) list.push("uncatalogued");
    o.kinds = [...new Set(list)];
  } else if (o.uncatalogued) {
    o.kinds = [...DEFAULT_KINDS, "uncatalogued"];
  }
  if (o.languages !== null) {
    if (o.pseudo) throw new UsageError("option-not-valid", "--languages does not work with --pseudo (a pseudo build has no wrong language)", "catscan untranslated shots/ --catalog 'locales/{locale}.json' --languages es,pt-BR");
    const list = o.languages.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) throw new UsageError("invalid-locale", "--languages needs at least one locale", "--languages es,pt-BR");
    for (const l of list) {
      if (!LOCALE_RE.test(l)) throw new UsageError("invalid-locale", `--languages needs BCP 47 codes such as de, pt-BR or zh-Hant, not ${l}`, "--languages es,pt-BR");
    }
    o.languages = [...new Set(list)];
  }
}

function validate(o) {
  if (o.help || o.version) return o;
  if (o.format !== null) {
    if (!["text", "json", "github"].includes(o.format)) {
      throw new UsageError("invalid-value", `--format must be text, json or github, not ${o.format}`);
    }
    if (o.json && o.format !== "json") throw new UsageError("conflicting-options", "--json is short for --format json; do not combine it with --format " + o.format);
  }
  o.format = o.json ? "json" : (o.format || "text");
  if (o.fallback !== null && !["tesseract", "none"].includes(o.fallback)) {
    const s = closest(o.fallback, ["tesseract", "none"]);
    throw new UsageError("invalid-value", `--fallback must be tesseract or none, not ${o.fallback}`, `--fallback ${s || "tesseract"}`);
  }
  for (const [flag, v] of [["--locale", o.locale], ["--base-locale", o.baseLocale]]) {
    if (v !== null && !LOCALE_RE.test(v)) {
      const dashed = v.replace(/_/g, "-");
      throw new UsageError("invalid-locale", `${flag} needs a BCP 47 code such as de, pt-BR or zh-Hant, not ${v}`,
        LOCALE_RE.test(dashed) ? `${flag} ${dashed}` : "catscan languages");
    }
  }
  if (o.command !== "untranslated" && (o.base !== null || (o.baseLocale !== null && o.command !== "fit") || (o.allow !== null && !["truncated", "overlap", "formats", "fit", "contrast"].includes(o.command)))) {
    throw new UsageError("option-not-valid", "--base works only with untranslated, --base-locale with untranslated and fit; --allow with untranslated, truncated, overlap, formats, fit and contrast", "catscan --help");
  }
  if ((o.currency !== null || o.storefront !== null || o.prices !== null || o.rules !== null) && o.command !== "formats") {
    throw new UsageError("option-not-valid", "--currency, --storefront, --prices and --rules work only with formats", "catscan formats shots/de --storefront DE");
  }
  // TODO-036 T4: --kinds uncatalogued is --uncatalogued.
  if (o.command === "untranslated" && o.kinds !== null && o.kinds.split(",").map((s) => s.trim()).includes("uncatalogued")) o.uncatalogued = true;
  // Also when the option came before the command, which parse() cannot check yet.
  if ((o.boxes !== null && !(o.command === "truncated" || o.command === "overlap" || o.command === "fit" || o.command === "contrast" || (o.command === "untranslated" && (o.pseudo || o.uncatalogued)))) || (o.reasons !== null && !["truncated", "fit"].includes(o.command))) {
    throw new UsageError("option-not-valid", "--boxes and --reasons work only with truncated and fit (--boxes also with overlap, contrast and untranslated --pseudo or --uncatalogued)", "catscan truncated shots/de --boxes shots/de");
  }
  if ((o.deviceProfile !== null || o.orientation !== null || o.listDevices) && o.command !== "fit") {
    throw new UsageError("option-not-valid", "--device-profile, --orientation and --list-devices work only with fit", "catscan fit shots/ --device-profile iphone-17-pro");
  }
  validatePseudoChecks(o);
  validateThresholds(o);
  // Spec 12 D18: the OCR-only reader missed its gate, so it runs only when asked for by name; TODO-046 D3, D12: with
  // element boxes overlap runs without it.
  if (o.experimental && o.command !== "overlap" && o.command !== "fit" && o.command !== "contrast" && !(o.command === "untranslated" && o.uncatalogued)) {
    throw new UsageError("option-not-valid", "--experimental works only with overlap, fit, contrast and untranslated --uncatalogued", "catscan overlap shots/de --experimental");
  }
  require("./contrast").validate(o); // TODO-054: --level, --scale, --kinds and the per-kind gate (D27, D28)
  // TODO-036 D55: uncatalogued missed its real-screen precision gate (0.90; results/uncatalogued-real.json), so it
  // runs only when asked for by name.
  if (o.command === "untranslated" && o.uncatalogued && !o.experimental && !o.help) {
    throw new UsageError("experimental-command", "uncatalogued is experimental: on real screens it missed its precision gate (0.90), so it needs --experimental", "catscan untranslated shots/de --locale de --catalog 'locales/{locale}.json' --uncatalogued --experimental");
  }
  // Spec 12 D14: a share of the smaller box, in (0, 1].
  if (o.minOverlap !== null) {
    if (o.command !== "overlap") throw new UsageError("option-not-valid", "--min-overlap works only with overlap", "catscan overlap shots/de --min-overlap 0.2");
    // TODO-067 D34: stacked has no share, so without boxes or --experimental no reader would read the value.
    if (o.boxes === null && !o.experimental && !o.help) throw new UsageError("option-not-valid", "--min-overlap applies to the boxes, elements and sheets readers: give --boxes or --experimental", "catscan overlap shots/de --boxes shots/de --min-overlap 0.2");
    const n = /^(\d+(\.\d*)?|\.\d+)$/.test(o.minOverlap) ? Number(o.minOverlap) : NaN;
    if (!(n > 0 && n <= 1)) throw new UsageError("invalid-min-overlap", `--min-overlap must be a number above 0 and at most 1, not ${o.minOverlap}`, "--min-overlap 0.2");
    o.minOverlap = n;
  }
  if (o.image !== null && o.command !== "boxes") throw new UsageError("option-not-valid", "--image works only with boxes", "catscan boxes uiautomator shop.uia.xml --image shop.png");
  if (o.command === "boxes") {
    if (o.paths.length !== 2) throw new UsageError("missing-path", "boxes needs a source and a dump file", "catscan boxes xcuitest shop.xcui.txt > shop.boxes.json");
    if (o.locale !== null || o.format !== "text" || o.catalogs.length) throw new UsageError("option-not-valid", "boxes takes only a source, a dump and --image", "catscan boxes uiautomator shop.uia.xml --image shop.png");
  }
  if (o.command === "untranslated") {
    if (o.base !== null && o.catalogs.length === 0) {
      throw new UsageError("missing-catalog", "--base needs --catalog, the translated catalog to compare with",
        "catscan untranslated shots/de --locale de --base locales/en.json --catalog locales/de.json");
    }
    // A template without --locale would resolve to en, the base catalog, and pass silently (spec 17 D16).
    // Per-input locales from --layout are TODO-029.
    if (o.locale === null && o.catalogs.some((c) => c.includes("{locale}"))) {
      throw new UsageError("missing-locale", "a {locale} catalog template needs --locale; one run checks one locale", "--locale de");
    }
  }
  validatePseudo(o);
  validateResults(o);
  if (o.command === "video") validateVideo(o);
  // Also when the option came before the command, which parse() cannot check yet.
  else if (o.every !== null || o.from !== null || o.to !== null || o.frames) {
    throw new UsageError("option-not-valid", "--every, --from, --to and --frames work only with video", "catscan video take.mp4 --every 0.5");
  }
  // Also when the option came before the command, which parse() cannot check yet.
  if (o.failOnSkip && o.command !== null && !["check", "video", "fit"].includes(o.command)) {
    throw new UsageError("option-not-valid", `--fail-on-skip is not valid for ${o.command}`, "catscan check shots/ --catalog 'locales/{locale}.json' --present @home.title --fail-on-skip");
  }
  if (o.allKeys && o.catalogs.length === 0) {
    throw new UsageError("missing-catalog", "--all-keys needs --catalog", "catscan check shots/ --catalog locales/en.json --all-keys");
  }
  if (!["check", "video"].includes(o.command) && (o.present.length || o.absent.length || o.expect !== null || o.allKeys
    || (o.catalogs.length && !["untranslated", "truncated", "fit"].includes(o.command)))) {
    throw new UsageError("option-not-valid", "--present, --absent, --expect and --all-keys work only with check (and video); --catalog with check, video, untranslated, truncated and fit", "catscan check --help");
  }
  if (o.command === "fit" && o.listDevices) {
    if (o.paths.length) throw new UsageError("option-not-valid", "fit --list-devices takes no paths", "catscan fit --list-devices --json");
  } else if (RUN_COMMANDS.includes(o.command)) {
    if (o.paths.length === 0) throw new UsageError("missing-path", `${o.command} needs at least one image, folder or -`, `catscan ${o.command} shots/`);
    if (o.paths.filter((p) => p === "-").length > 1) throw new UsageError("repeated-stdin", "- (stdin) can be given once");
  }
  if (o.command === "check" && o.present.length + o.absent.length === 0 && o.expect === null && !o.allKeys) {
    throw new UsageError("missing-check", "check needs --present, --absent, --expect or --all-keys", 'catscan check shot.png --present "Continue"');
  }
  if (o.command === "check" && o.paths.includes("-") && o.expect !== null && o.present.length + o.absent.length === 0) {
    throw new UsageError("missing-check", "--expect keys never match stdin (-); add --present or --absent for it", 'catscan check - --present "Continue"');
  }
  if (o.command === "video" && o.present.length + o.absent.length === 0 && o.expect === null) {
    throw new UsageError("missing-check", "video needs --present, --absent or --expect", 'catscan video take.mp4 --present "GAME OVER"');
  }
  for (const c of ["languages", "doctor"]) {
    if (o.command === c && (o.paths.length || o.locale || o.quiet)) {
      throw new UsageError("option-not-valid", `${c} takes no paths and only --json or --format`, `catscan ${c} --json`);
    }
  }
  if (o.command === "serve" && (o.paths.length || o.locale || o.format !== "text" || o.quiet)) {
    throw new UsageError("option-not-valid", "serve takes no paths or options; requests carry them");
  }
  return o;
}

module.exports = { parse, UsageError, closest, editDistance, COMMANDS, RUN_COMMANDS, OPTIONS, PLANNED_OPTIONS, PLANNED_COMMANDS, LOCALE_RE, DEVICE_RE, TEXT_SIZE_RE, BASE_LAYOUTS, KINDS, DEFAULT_KINDS };
