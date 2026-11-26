// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 13: toShowText, toHaveNoTruncation, toHaveNoUntranslated; TODO-046 T3: toHaveNoOverlap. `env` carries everything outside this file (the
// worker's Backend, test.info(), the clock, stderr, test.skip, the language table) so unit tests run with fakes.
const fs = require("fs");
const catalog = require("@catscan/core-js/src/catalog");
const truncated = require("@catscan/core-js/src/truncated");
const { LOCALE_RE } = require("@catscan/core-js/src/args");
const untranslated = require("@catscan/core-js/src/untranslated");
const pseudoField = require("@catscan/core-js/src/pseudo-field");
const { classify, fail, wrap, startError, CatscanUnsupportedPlatformError } = require("./verdict");
const boxes = require("./boxes");
const render = require("@catscan/core-js/src/render");
const scale = require("@catscan/core-js/src/scale");
const attach = require("./attach");
const save = require("./save");

const RETRY_MS = 250; // D7
const DEFAULT_TIMEOUT = 5000; // Playwright's own expect default
const COMMON = ["locale", "catalog", "fallback", "timeout", "mask", "fullPage", "readyText"];
// TODO-039 T3 (D16): pseudo on the three matchers the CLI's --pseudo covers; not on overlap.
// TODO-077 D27: the finding matchers take the CLI's thresholds; toShowText asserts text, so it takes none.
const THRESHOLDS = ["minSeverity", "minCertainty"];
// TODO-088 D12: `screen` names one call's saved shot, so it is per call; `saveDir` is a project default.
const OPTIONS = {
  toShowText: new Set([...COMMON, "pseudo", "screen"]),
  toHaveNoTruncation: new Set([...COMMON, "allow", "pseudo", "screen", ...THRESHOLDS]),
  toHaveNoOverlap: new Set([...COMMON, "allow", "screen", ...THRESHOLDS]),
  toHaveNoUntranslated: new Set([...COMMON, "allow", "base", "pseudo", "screen", ...THRESHOLDS]),
};
const DEFAULT_KEYS = new Set([...COMMON, "allow", "base", "pseudo", "onUnsupported", "saveDir", ...THRESHOLDS]);
const READY_WARNING = 'catscan: no readyText, the check may run on a loading frame. Fix: pass readyText: "<text shown when the screen is ready>", or readyText: false\n';

// D2: the readyText warning prints once per test id, across every matcher set in this worker.
const warnedTests = new Set();
let seq = 0;

const usage = (what, hint) => fail("playwright-usage", what, hint);
const q = (s) => JSON.stringify(s);

function checkKeys(opts, allowed, where) {
  if (opts === undefined || opts === null) return {};
  if (typeof opts !== "object" || Array.isArray(opts)) throw usage(`${where} options must be an object`, "pass { readyText: \"...\" } or leave the options out");
  for (const k of Object.keys(opts)) {
    if (k === "onUnsupported" && where !== "catscanMatchers()") throw usage(`onUnsupported is a project default, not a ${where} option`, "set it in catscanMatchers({ onUnsupported: \"skip\" })");
    if (k === "saveDir" && where !== "catscanMatchers()") throw usage(`saveDir is a project default, not a ${where} option`, "set it in catscanMatchers({ saveDir: \"test-results/catscan\" }), or set CATSCAN_SAVE_DIR");
    if (k === "screen" && where === "catscanMatchers()") throw usage("screen names one call's saved shot, so it is not a catscanMatchers() default", "pass screen to the matcher call: toHaveNoTruncation({ screen: \"settings\" })");
    if (!allowed.has(k)) throw usage(`${where} has no option ${k}`, `use one of ${[...allowed].join(", ")}`);
  }
  if (opts.fallback !== undefined && !["tesseract", "none"].includes(opts.fallback)) throw usage(`fallback is ${q(opts.fallback)}`, 'fallback: "tesseract" or "none"');
  if (opts.onUnsupported !== undefined && !["throw", "skip"].includes(opts.onUnsupported)) throw usage(`onUnsupported is ${q(opts.onUnsupported)}`, 'onUnsupported: "throw" or "skip"');
  if (opts.timeout !== undefined && !(Number.isFinite(opts.timeout) && opts.timeout >= 0)) throw usage(`timeout is ${q(opts.timeout)}`, "timeout: a number of milliseconds");
  // A locale fills {locale} in catalog paths, so it is a language tag and never a path fragment (as the MCP server).
  if (opts.locale !== undefined && !(typeof opts.locale === "string" && LOCALE_RE.test(opts.locale.replace(/_/g, "-")))) throw usage(`locale is ${q(opts.locale)}`, 'locale: a BCP 47 tag such as "de" or "pt-BR"');
  if (opts.allow !== undefined && ![].concat(opts.allow).every((a) => typeof a === "string")) throw usage("allow must be a string or a list of strings", 'allow: ["OK"]');
  if (opts.minSeverity !== undefined && !scale.SEVERITIES.includes(opts.minSeverity)) throw usage(`minSeverity is ${q(opts.minSeverity)}`, `minSeverity: one of ${scale.SEVERITIES.map(q).join(", ")}`);
  if (opts.minCertainty !== undefined && !scale.CERTAINTIES.includes(opts.minCertainty)) throw usage(`minCertainty is ${q(opts.minCertainty)}`, `minCertainty: one of ${scale.CERTAINTIES.map(q).join(", ")}`);
  if (opts.saveDir !== undefined && opts.saveDir !== false && !(typeof opts.saveDir === "string" && opts.saveDir.trim())) throw usage(`saveDir is ${q(opts.saveDir)}`, 'saveDir: a folder path such as "test-results/catscan", or false');
  if (opts.screen !== undefined && !(typeof opts.screen === "string" && save.screenSegments(opts.screen).length)) throw usage(`screen is ${q(opts.screen)}`, 'screen: a name such as "settings" or "shop/checkout" (letters, digits, ".", "_", "-", "/")');
  if (opts.pseudo !== undefined && typeof opts.pseudo !== "boolean") throw usage(`pseudo is ${q(opts.pseudo)}`, "pseudo: true on a pseudo-locale build (catscan pseudo)");
  return opts;
}

/**
 * D6: a BCP 47 tag -> the catscan locale, as the core resolves it (spec 04): the tag or an alias, then shorter
 * tags, then the language subtag. `table` is `catscan languages --json`, or null (the tag goes as is).
 */
function resolveLocale(tag, table) {
  const rows = (table && table.languages) || [];
  if (!rows.length) return { locale: tag, warning: null };
  const tags = (r) => [r.locale, ...(r.aliases || [])].map((t) => t.toLowerCase());
  const full = String(tag).toLowerCase().replace(/_/g, "-");
  const parts = full.split("-");
  let row = null, exact = false;
  for (let n = parts.length; n > 0 && !row; n--) {
    const t = parts.slice(0, n).join("-");
    row = rows.find((r) => tags(r).includes(t)) || null;
    exact = row !== null && t === full;
  }
  if (!row) row = rows.find((r) => r.locale.toLowerCase().split("-")[0] === parts[0]) || null;
  if (!row) return { locale: tag, warning: null };
  const warning = exact ? null : { code: "locale-fallback", message: `the locale ${tag} is not in the language table; reading it as ${row.locale}`, hint: `locale: "${row.locale}"` };
  return { locale: row.locale, warning };
}

/** The CLI's --allow file rules (loadAllow): trimmed, empty entries dropped. */
const allowList = (a) => (a === undefined ? [] : [].concat(a).map((x) => x.trim()).filter(Boolean));

/** `@key` needs the catalog option; `@@x` is the literal `@x` (catalog.js). */
function resolveText(s, cat, where) {
  if (typeof s !== "string" || !s.length) throw usage(`${where} must be a non-empty string`, `pass the text shown on the screen, or @key with catalog`);
  if (s.startsWith("@") && !s.startsWith("@@") && !cat) {
    throw fail("missing-catalog", `${where}: ${s} is a catalog key, but no catalog option was given`, `pass catalog: "locales/{locale}.json" to the matcher or to catscanMatchers(), or @${s} for the literal text`);
  }
  try { return catalog.resolve(s, cat, where); } catch (e) { throw wrap(e); }
}

/** The process.once("exit") handler: kill the worker's serve child (it also exits when its stdin closes). */
function killOnExit(backend) {
  const s = backend && backend.server;
  if (s && s.proc && !s.exited) {
    try { s.proc.kill(); } catch {}
  }
}

function readerOf(env) {
  if (!env) return "vision";
  const w = (env.warnings || []).some((x) => x.code === "fallback-used");
  return w || /tesseract/i.test(String(env.engine || "")) ? "tesseract" : "vision";
}

function describe(kind, isNot, final, ready) {
  const env = final.env;
  if (final.state === "not-ready") return [`readyText ${q(ready.shown)} not shown; the check did not run`];
  if (!env) return ["no frame was checked"];
  const out = [];
  if (kind === "toShowText") {
    for (const c of env.checks || []) {
      if (c.verdict !== "fail") continue;
      if (c.kind === "present") {
        out.push(`expected ${q(c.text)} to be shown; closest line read: ${c.closest ? `${q(c.closest.line)} (distance ${c.closest.distance})` : "none (no text read)"}`);
      } else {
        out.push(`expected ${q(c.text)} not to be shown; it matched the line ${q(c.line)}`);
      }
    }
    if (!out.length && isNot) out.push("every text was absent");
  } else {
    // TODO-077: the gating findings, worst first, each with its severity and certainty; the rest go to the attachment.
    for (const f of scale.sortItems(env.findings || []).filter((x) => x.gate !== false)) {
      const b = scale.badge(f) ? `${scale.badge(f)}  ` : "";
      // TODO-046 D13: the CLI's text line, a graphic by its element id.
      if (f.kind === "overlap") { out.push(b + render.findingDetail(f).trim()); continue; }
      const what = f.kind === "truncated" ? `cut off (${f.reason}${f.expected ? `, expected ${q(f.expected)}` : ""})`
        : f.kind === "raw-key" ? `a raw key${f.key ? ` (${f.key})` : ""}`
          : f.kind === "placeholder" ? `an unfilled placeholder ${q(f.token)}`
            : f.kind === "wrong-language" ? `in ${f.language}, not ${f.expected_language}${f.expected ? ` (expected ${q(f.expected)})` : ""}`
            : f.expected ? `${f.kind} (expected ${q(f.expected)})` : f.kind;
      out.push(`${b}${q(f.line)} is ${what}`);
    }
  }
  return out;
}

/**
 * `defaults`: catscanMatchers(defaults). `env`: { backend(), preflight(), testInfo(), now(), sleep(ms), stderr(s),
 * skip(reason), languages() }.
 */
function createMatchers(defaults, env) {
  defaults = checkKeys(defaults, DEFAULT_KEYS, "catscanMatchers()");

  async function run(ctx, kind, target, texts, callOpts) {
    const isNot = Boolean(ctx && ctx.isNot);
    // D14: only toShowText has a negation; the others would pass on any frame that shows a problem.
    if (isNot && kind !== "toShowText") {
      throw usage(`.not.${kind}() is not defined; it would pass on a frame that shows the problem`, "accept a known line with allow: [\"<line>\"] instead");
    }
    const o = { ...defaults, ...checkKeys(callOpts, OPTIONS[kind], kind) };
    const th = { min_severity: o.minSeverity ?? scale.DEFAULTS.min_severity, min_certainty: o.minCertainty ?? scale.DEFAULTS.min_certainty };
    const isLocator = target && typeof target.boundingBox === "function" && typeof target.page === "function";
    const isPage = target && !isLocator && typeof target.screenshot === "function" && typeof target.evaluate === "function";
    if (!isLocator && !isPage) throw usage(`${kind} needs a Playwright Page or Locator`, "expect(page) or expect(page.locator(\"canvas\"))");
    if (o.fullPage && isLocator) throw usage("fullPage applies to a page screenshot, not a locator", "expect(page)." + kind + "(..., { fullPage: true }), or drop fullPage");
    const page = isLocator ? target.page() : target;
    const info = env.testInfo();

    const unsupported = (err) => {
      if (defaults.onUnsupported === "skip") { env.skip(err.message); return err; }
      throw err;
    };
    try { env.preflight(); } catch (e) { return unsupported(startError(e)); }

    // D6: option, then the page's navigator.language (the context locale), then en.
    let tag = o.locale, source = "option";
    if (!tag) {
      let nav = null;
      try { nav = await page.evaluate(() => navigator.language); } catch {}
      if (typeof nav === "string" && nav) { tag = nav; source = "navigator.language"; } else { tag = "en"; source = "default en"; }
    }
    const nodeWarnings = [];
    // The page's own script sets navigator.language: a value that is not a language tag never reaches a catalog path.
    if (!LOCALE_RE.test(String(tag).replace(/_/g, "-"))) {
      nodeWarnings.push({ code: "locale-fallback", message: `navigator.language ${q(tag)} is not a language tag; reading the screen as en`, hint: 'locale: "<tag>"' });
      tag = "en";
      source = "default en";
    }
    // TODO-039 D12: a pseudo locale (en-XA, ar-XB) reads as en, and {locale} then names the base catalog.
    const pseudo = o.pseudo === true && kind !== "toHaveNoOverlap";
    // TODO-088 review: a pseudo page (en-XA) reads as en but must never save over the en project's shots.
    const pseudoPage = o.pseudo === true || pseudoField.ocrLocale(tag) !== tag;
    if (pseudo) tag = pseudoField.ocrLocale(tag);
    const { locale, warning: localeWarning } = resolveLocale(tag, env.languages());
    if (localeWarning) nodeWarnings.push(localeWarning);
    // TODO-088 D1, D3: the folder is read on every call; the call count advances whether or not this call saves.
    const saveDir = save.root(defaults, env.getenv);
    const callN = save.count(info, locale);

    const specs = o.catalog === undefined ? [] : [].concat(o.catalog);
    let cat = null;
    try { cat = specs.length ? catalog.loadAll(specs, locale) : null; } catch (e) { throw wrap(e); }
    if (cat) nodeWarnings.push(...cat.warnings);

    const ready = o.readyText === undefined || o.readyText === false ? null : { shown: o.readyText, check: resolveText(o.readyText, cat, "readyText") };
    const base = { locale };
    if (o.fallback) base.fallback = o.fallback;
    if (pseudo && kind !== "toShowText" && !specs.length) throw fail("missing-catalog", `${kind} with pseudo needs the base catalog`, 'pass catalog: "locales/en.json" (the base catalog)');
    if (pseudo && kind === "toHaveNoUntranslated" && o.base) throw fail("pseudo-conflicts-with-base", "pseudo takes the base catalog as catalog; drop base", 'pass catalog: "locales/en.json" without base');
    let ps = null; // the core's pseudo field, sent whole on every request (each matcher call is its own run)
    // check --pseudo needs no entries: it only switches matching to the pseudo fold (D8), readyText included.
    const checkPs = pseudo ? pseudoField.build(null, { dynamic: null }) : null;
    let command;
    if (kind === "toShowText") {
      const list = Array.isArray(texts) ? texts : [texts];
      if (!list.length) throw usage("toShowText needs at least one text", 'toShowText("GAME OVER") or toShowText(["Score", "Lives"])');
      const items = list.map((t, i) => resolveText(t, cat, `toShowText text ${list.length > 1 ? i + 1 : ""}`.trim()));
      command = { command: "check", present: isNot ? [] : items, absent: isNot ? items : [] };
      ps = checkPs;
    } else if (kind === "toHaveNoTruncation") {
      let field;
      try {
        const t = truncated.build({ reasons: null, allow: null, catalogs: specs, locale, boxes: null, pseudo }, []);
        field = t.forInput({ path: "" }).field;
        if (t.pseudo) ps = pseudoField.build(cat, { dynamic: null }, allowList(o.allow));
      } catch (e) { throw wrap(e); }
      if (o.allow !== undefined) field.allow = allowList(o.allow);
      command = { command: "truncated", truncated: field };
    } else if (kind === "toHaveNoOverlap") {
      // TODO-067 D3, D19, D35: as plain `catscan overlap`: stacked text, and without boxes nothing else (geometry false).
      command = { command: "overlap", overlap: { stacked: true, geometry: false, ...(o.allow !== undefined ? { allow: allowList(o.allow) } : {}) } };
    } else {
      if (o.base && !specs.length) throw fail("missing-catalog", "base needs catalog: the translated catalog to compare with", 'pass catalog: "locales/{locale}.json" next to base');
      let u;
      try {
        u = untranslated.build({ locale, allow: null, base: o.base || null, baseLocale: null, catalogs: specs, pseudo });
        if (u.pseudo) ps = pseudoField.build(cat, { dynamic: null }, allowList(o.allow));
      } catch (e) { throw wrap(e); }
      // The catalog loaders' warnings are already in nodeWarnings from loadAll; runWarnings say a rule was skipped.
      nodeWarnings.push(...u.runWarnings);
      command = { command: "untranslated", untranslated: { ...u.field, allow: allowList(o.allow) } };
    }
    if (ps) command.pseudo = { ...ps.field, digest: ps.digest };

    const request = async (req) => {
      let out;
      try {
        out = await env.backend().run((s) => s.request({ id: `pw-${++seq}`, ...base, ...req }));
      } catch (e) {
        const err = startError(e);
        if (err instanceof CatscanUnsupportedPlatformError) return { unsupportedError: unsupported(err) };
        throw err;
      }
      return out;
    };

    const timeout = o.timeout ?? (ctx && ctx.timeout) ?? DEFAULT_TIMEOUT;
    let inMainFrame = true;
    // Both read the page's element boxes around the screenshot (spec 13 D5; TODO-046 T3).
    const boxed = kind === "toHaveNoTruncation" || kind === "toHaveNoOverlap";
    // TODO-088 D8: saving reads the boxes of the other matchers too, for the sidecar only.
    const readBoxes = boxed || saveDir !== null;
    if (readBoxes && isLocator) {
      // null: the probe failed (the locator does not resolve yet); never reported as an iframe.
      try { inMainFrame = await target.evaluate(() => window === window.top); } catch { inMainFrame = null; }
    }
    const deadline = env.now() + timeout;
    const retryAll = kind === "toShowText" && !isNot;
    if (!retryAll && o.readyText === undefined && !warnedTests.has(info.testId)) {
      warnedTests.add(info.testId);
      env.stderr(READY_WARNING);
    }

    const files = [];
    const shoot = async (file) => {
      const opt = { path: file };
      if (o.mask) opt.mask = o.mask;
      if (o.fullPage) opt.fullPage = true;
      await target.screenshot(opt);
    };

    /** The page's boxes for the shot in `file` as a boxes file object (spec 06 format), after the D5 and fullPage transforms. */
    const buildBoxes = (stable, media, extra, box, file) => {
      // An element over a canvas, video or iframe (an aria-label on the canvas, a labelled wrapper) would own the
      // lines drawn there and switch off the screen-edge rule for them: those regions are checked without boxes.
      let dump = boxes.dropMedia(stable, media);
      if (isLocator) dump = boxes.forLocator(dump, box);
      else if (o.fullPage) {
        const img = boxes.imageSize(file);
        const dpr = stable.dpr || 1;
        dump = boxes.forFullPage(dump, extra, { width: img.width / dpr, height: img.height / dpr });
      }
      const dumpFile = file.replace(/\.png$/, ".pw.json");
      files.push(dumpFile);
      return boxes.build(dump, dumpFile, file);
    };

    /** TODO-088 D8: one read before and one after the screenshot, no stability loop; any failure means no sidecar. */
    const shootForSave = async (file) => {
      // The screenshot scrolls an off-screen locator into view; scroll first so both box reads see the same layout.
      if (isLocator) { try { await target.scrollIntoViewIfNeeded(); } catch {} }
      let before = null;
      try { before = await page.evaluate(boxes.collect); } catch {}
      await shoot(file);
      try {
        const after = await page.evaluate(boxes.collect);
        const media = await page.evaluate(boxes.mediaRects);
        const extra = o.fullPage ? await page.evaluate(boxes.pageExtra) : null;
        if (!before || !boxes.sameRects(before, after)) return null;
        const box = isLocator && inMainFrame ? await target.boundingBox() : null;
        if (isLocator && !box) return null;
        return buildBoxes(after, media, extra, box, file).boxes;
      } catch { return null; }
    };

    /** One attempt: screenshot (with boxes for truncation), readyText, then the command on the same file. */
    const attempt = async () => {
      const file = info.outputPath(`catscan-${process.pid}-${++seq}.png`);
      files.push(file);
      const warnings = [...nodeWarnings];
      const req = { ...command, path: file };
      let saveBoxes = null;
      if (boxed) {
        let stable = null, extra = null, media = [];
        for (;;) {
          const before = await page.evaluate(boxes.collect);
          await shoot(file);
          const after = await page.evaluate(boxes.collect);
          media = await page.evaluate(boxes.mediaRects);
          if (o.fullPage) extra = await page.evaluate(boxes.pageExtra);
          if (boxes.sameRects(before, after)) { stable = after; break; }
          if (env.now() >= deadline) break;
        }
        // The page script reads the main document only (D5): a locator in an iframe gets no boxes, never empty ones.
        const box = stable && isLocator && inMainFrame ? await target.boundingBox() : null;
        // TODO-046 D3: overlap never falls back to the OCR-only reader (about 1 in 16 real overlaps) on its own.
        if (kind === "toHaveNoOverlap" && (!stable || (isLocator && !box))) {
          const why = !stable ? "the page's element boxes moved around every screenshot until the timeout"
            : inMainFrame === false ? "the locator is inside an iframe, and element boxes come from the main document only"
            : "the locator had no bounding box or frame after the screenshot (detached, hidden or not resolved)";
          throw fail("overlap-no-boxes", `${why}; toHaveNoOverlap needs element boxes, since overlap without them finds about 1 in 16 real overlaps`,
            !stable ? "pass readyText for a frame shown once the page settles, or stop the animation before the assertion" : "assert on a visible element of the main document");
        }
        if (stable && isLocator && !box) {
          warnings.push(inMainFrame === false
            ? { code: "boxes-missing", message: "the locator is inside an iframe; element boxes come from the main document only, so it was checked without boxes", hint: "see docs/recipes/playwright.md#boxes-missing" }
            : { code: "boxes-missing", message: "the locator had no bounding box or frame after the screenshot (detached, hidden or not resolved); checked without boxes", hint: "assert on a visible element" });
        } else if (stable) {
          let built;
          try { built = buildBoxes(stable, media, extra, box, file); } catch (e) { throw wrap(e); }
          if (kind === "toHaveNoOverlap") req.overlap = { ...req.overlap, boxes: built.boxes };
          else req.truncated = { ...req.truncated, boxes: built.boxes };
          warnings.push(...built.warnings);
          saveBoxes = built.boxes;
        } else {
          warnings.push({ code: "boxes-unstable", message: "the page's element boxes moved between the two reads around every screenshot until the timeout; checked without boxes", hint: "pass readyText for a frame shown once the page settles, or stop the animation before the assertion; mask does not settle boxes" });
        }
      } else if (saveDir !== null) {
        saveBoxes = await shootForSave(file);
      } else {
        await shoot(file);
      }
      if (ready) {
        const renv = await request({ command: "check", path: file, present: [ready.check], absent: [], ...(checkPs ? { pseudo: { ...checkPs.field, digest: checkPs.digest } } : {}) });
        if (renv.unsupportedError) return { state: "skip" };
        const c = classify(renv, warnings);
        if (c.kind === "throw") throw c.error;
        if (c.kind === "unsupported") { unsupported(c.error); return { state: "skip" }; }
        if (c.kind === "fail") return { state: "not-ready", file, warnings };
      }
      const res = await request(req);
      if (res.unsupportedError) return { state: "skip" };
      res.warnings = [...warnings, ...(res.warnings || [])];
      // TODO-077 D8: the same verdict as the CLI, from the same core-js function.
      if (res.verdict && kind !== "toShowText") { try { scale.annotate(res, th); } catch (e) { throw wrap(e); } }
      const c = classify(res, warnings);
      if (c.kind === "throw") throw c.error;
      if (c.kind === "unsupported") { unsupported(c.error); return { state: "skip" }; }
      return { state: c.kind, env: res, file, warnings, saveBoxes };
    };

    let attempts = 0, slowest = 0, final, saved = null, saveError = null;
    try {
      for (;;) {
        const t0 = env.now();
        final = await attempt();
        attempts++;
        slowest = Math.max(slowest, env.now() - t0);
        if (final.state === "skip" || final.state === "pass") break;
        // D2: a negative check never retries into a passing frame; only readyText is waited for.
        if (final.state === "fail" && !retryAll) break;
        if (env.now() >= deadline) break;
        await env.sleep(RETRY_MS);
        if (env.now() >= deadline) break;
      }
      // TODO-088: the final checked frame, pass or fail; a not-ready frame or a skip was not checked (D7: an error
      // is thrown on a pass and is a message line on a fail, below).
      if (saveDir !== null && (final.state === "pass" || final.state === "fail")) {
        try {
          const renderLabel = (await save.render(page, info)) + (pseudoPage ? "-pseudo" : "");
          saved = save.write({
            // The converter leaves out scale 1; the sidecar states it, so `contrast` reads the scale from the boxes.
            dir: saveDir, png: final.file, boxes: final.saveBoxes && { ...final.saveBoxes, scale: final.saveBoxes.scale ?? 1 }, stderr: env.stderr,
            rel: save.relName({ info, locale, renderLabel, n: callN, screen: o.screen }),
            owner: { key: `${info.testId}\0${callN}`, title: (info.titlePath || []).join(" > ") || info.testId },
          });
        } catch (e) { saveError = wrap(e); }
      }
    } finally {
      // Every attempt's files but the final failing one go; the final one is attached below.
      const keep = final && final.state !== "pass" && final.state !== "skip" ? final.file : null;
      for (const f of files) {
        if (f === keep) continue;
        try { fs.unlinkSync(f); } catch {}
      }
    }
    if (final.state === "skip") return { pass: !isNot, message: () => "skipped", name: kind };

    if (final.env) attach.annotate(info, final.env.warnings || []);
    else attach.annotate(info, final.warnings || []);
    const ok = final.state === "pass";
    // TODO-077: findings below the thresholds never fail the test; they go to the catscan.json attachment.
    if (ok && final.env && (final.env.findings || []).some((f) => f.gate === false)) {
      await info.attach("catscan.json", { body: JSON.stringify(final.env, null, 2) + "\n", contentType: "application/json" });
    }
    if (ok && saveError) throw saveError;
    if (ok) return { pass: !isNot, message: () => `catscan ${kind}: passed`, name: kind };

    let lines = [];
    try {
      // Straight to the backend: a skip (onUnsupported) must never be swallowed here.
      const r = await env.backend().run((sv) => sv.request({ id: `pw-${++seq}`, ...base, command: "read", path: final.file }));
      if (r && Array.isArray(r.lines)) lines = r.lines.map((l) => l.text);
    } catch {}
    await attach.failure(info, { file: final.file, env: final.env, lines });

    const reader = readerOf(final.env);
    const detail = describe(kind, isNot, final, ready);
    const unstable = (final.env ? final.env.warnings : []).some((w) => w.code === "boxes-unstable");
    const msg = [
      `catscan ${isNot ? ".not." : ""}${kind}:`,
      ...detail.map((d) => `  ${d}`),
      `  locale: ${locale} (${source}${locale !== tag ? `: ${tag}` : ""}), reader: ${reader}`,
      `  attempts: ${attempts}, slowest ${Math.round(slowest)} ms of a ${timeout} ms timeout${slowest > timeout / 2 && !unstable ? "; raise timeout (one attempt took over half of it)" : ""}`,
      ...(unstable ? ["  boxes-unstable: the page never settled, so the check ran without element boxes"] : []),
      `  attachments: ${final.env ? "catscan.png, catscan.html, catscan-lines.txt, catscan.json" : "catscan.png, catscan-lines.txt"}`,
      ...(saved ? [`  saved: ${saved}`] : []),
      ...(saveError ? [`  ${saveError.message}`] : []),
    ].join("\n");
    // Playwright fails when pass === isNot: a failed positive check returns false, a matched .not returns true.
    return { pass: isNot, message: () => msg, name: kind, expected: texts, actual: lines.slice(0, 20).join("\n") };
  }

  return {
    async toShowText(target, text, options) { return run(this, "toShowText", target, text, options); },
    async toHaveNoTruncation(target, options) { return run(this, "toHaveNoTruncation", target, null, options); },
    async toHaveNoOverlap(target, options) { return run(this, "toHaveNoOverlap", target, null, options); },
    async toHaveNoUntranslated(target, options) { return run(this, "toHaveNoUntranslated", target, null, options); },
  };
}

module.exports = { createMatchers, resolveLocale, killOnExit, RETRY_MS, READY_WARNING, _warnedTests: warnedTests };
