// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 13 unit tests (Test plan / coverage, first block): fake Server, page, locator, test.info() and clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { harness, envelope } = require("./helpers");
const { classify, CatscanUnsupportedPlatformError, ANCHORS, RECIPE } = require("../src/verdict");
const { Backend } = require("@catscan/core-js/src/backend");
const { CatscanError } = require("@catscan/core-js/src/install");
const { killOnExit, resolveLocale, _warnedTests } = require("../src/matchers");

const ROOT = path.join(__dirname, "../../..");
const failPresent = (req) => envelope(req, { verdict: "fail", checks: [{ kind: "present", text: req.present[0], verdict: "fail", line: null, closest: { line: "GAME OVR", distance: 1, box: [0.1, 0.1, 0.2, 0.1] } }] });
const isReady = (req) => req.command === "check" && req.present.length === 1 && req.present[0] === "Play";

test("retries: fail, fail, pass gives a pass after three attempts 250 ms apart (D7)", async () => {
  // Value: protects=web-first retries; fails_when=no retry, or a pass after a failure still fails.
  const h = harness({ respond: (req, n) => (n < 3 ? failPresent(req) : envelope(req)) });
  const r = await h.matchers.toShowText.call(h.ctx(), h.page, "GAME OVER");
  assert.equal(r.pass, true);
  assert.equal(h.commands().length, 3);
  assert.equal(h.t, 3 * 50 + 2 * 250);
  assert.equal(fs.readdirSync(h.tmp).length, 0, "every screenshot is deleted on pass");
});

test("retries: a timeout reports the last attempt's failure, with attempts and the slowest attempt (D20)", async () => {
  const h = harness({ respond: failPresent, attemptMs: 400 });
  const r = await h.matchers.toShowText.call(h.ctx(false, 2000), h.page, "GAME OVER");
  assert.equal(r.pass, false);
  const m = r.message();
  assert.match(m, /expected "GAME OVER" to be shown; closest line read: "GAME OVR" \(distance 1\)/);
  assert.match(m, /attempts: 4, slowest 400 ms of a 2000 ms timeout/);
  assert.doesNotMatch(m, /raise timeout/);
  assert.match(m, /locale: en \(navigator\.language: en-US\), reader: vision/);
});

test("retries: an attempt running at the timeout finishes and counts; over half the timeout says raise timeout (D7, D20)", async () => {
  const h = harness({ respond: (req, n) => (n === 1 ? failPresent(req) : envelope(req)), attemptMs: 900 });
  const r = await h.matchers.toShowText.call(h.ctx(false, 1000), h.page, "GAME OVER");
  // 900 + 250 = 1150 > 1000: no second attempt starts.
  assert.equal(r.pass, false);
  assert.equal(h.commands().length, 1);
  const h2 = harness({ respond: failPresent, attemptMs: 1500 });
  const r2 = await h2.matchers.toShowText.call(h2.ctx(false, 1000), h2.page, "GAME OVER");
  assert.equal(h2.commands().length, 1, "the attempt past the timeout was not cut");
  assert.match(r2.message(), /attempts: 1, slowest 1500 ms .* raise timeout/);
});

test("readyText: never shown fails with readyText not shown", async () => {
  const h = harness({ respond: (req) => (isReady(req) ? failPresent(req) : envelope(req)) });
  const r = await h.matchers.toHaveNoUntranslated.call(h.ctx(false, 1000), h.page, { readyText: "Play" });
  assert.equal(r.pass, false);
  assert.match(r.message(), /readyText "Play" not shown/);
  assert.ok(h.commands().every(isReady), "the command never ran");
});

for (const [name, call, cmd] of [
  [".not.toShowText", (h) => h.matchers.toShowText.call(h.ctx(true), h.page, "home.title", { readyText: "Play" }), "check"],
  ["toHaveNoTruncation", (h) => h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: "Play" }), "truncated"],
  ["toHaveNoUntranslated", (h) => h.matchers.toHaveNoUntranslated.call(h.ctx(), h.page, { readyText: "Play" }), "untranslated"],
]) {
  test(`readyText: ${name} checks the first ready frame once and never retries into a passing frame (D2)`, async () => {
    // Value: fails_when=a negative check retries until a blank or loading frame passes.
    let readyChecks = 0;
    const h = harness({
      respond: (req) => {
        if (isReady(req)) return ++readyChecks < 2 ? failPresent(req) : envelope(req);
        return envelope(req, { verdict: "fail", checks: cmd === "check" ? [{ kind: "absent", text: "home.title", verdict: "fail", line: "home.title", box: [0, 0, 0.1, 0.1] }] : [], findings: cmd === "check" ? [] : [{ kind: "raw-key", line: "home.title", key: "home.title", reason: "ellipsis", box: [0, 0, 0.1, 0.1] }] });
      },
    });
    const r = await call(h);
    assert.equal(r.pass, name.startsWith(".not"), "the matcher reports a failure");
    const commands = h.commands().filter((q) => !isReady(q));
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, cmd);
    assert.equal(readyChecks, 2);
  });
}

test("readyText: the warning prints once per test id, also with two tests in one worker; readyText: false is silent (D2, D19)", async () => {
  _warnedTests.clear();
  const a = harness({ testId: "a" });
  await a.matchers.toHaveNoUntranslated.call(a.ctx(), a.page);
  await a.matchers.toHaveNoTruncation.call(a.ctx(), a.page);
  assert.equal(a.stderr.split("\n").filter(Boolean).length, 1);
  assert.match(a.stderr, /^catscan: no readyText, the check may run on a loading frame\. Fix: pass readyText: "<text shown when the screen is ready>", or readyText: false\n$/);
  const b = harness({ testId: "b" });
  await b.matchers.toHaveNoUntranslated.call(b.ctx(), b.page);
  assert.equal(b.stderr.split("\n").filter(Boolean).length, 1, "a second test in the worker warns again");
  const c = harness({ testId: "c" });
  await c.matchers.toHaveNoUntranslated.call(c.ctx(), c.page, { readyText: false });
  assert.equal(c.stderr, "");
  assert.equal(c.commands().length, 1, "readyText: false checks the first frame");
  const d = harness({ testId: "d" });
  await d.matchers.toShowText.call(d.ctx(), d.page, "GAME OVER");
  assert.equal(d.stderr, "", "a positive toShowText retries, so it never warns");
});

test(".not: the message names the matching line; .not on the other matchers throws playwright-usage (D14)", async () => {
  const h = harness({ respond: (req) => envelope(req, { verdict: "fail", checks: [{ kind: "absent", text: "home.title", verdict: "fail", line: "home.title!", box: [0, 0, 0.1, 0.1] }] }) });
  const r = await h.matchers.toShowText.call(h.ctx(true), h.page, "home.title", { readyText: false });
  assert.equal(r.pass, true, "pass === isNot fails the assertion");
  assert.match(r.message(), /expected "home.title" not to be shown; it matched the line "home.title!"/);
  assert.deepEqual(h.commands()[0].absent, ["home.title"]);
  assert.deepEqual(h.commands()[0].present, []);
  for (const m of ["toHaveNoTruncation", "toHaveNoUntranslated", "toHaveNoOverlap"]) {
    await assert.rejects(h.matchers[m].call(h.ctx(true), h.page), (e) => e.code === "playwright-usage" && /allow/.test(e.message));
  }
  const ok = harness();
  const r2 = await ok.matchers.toShowText.call(ok.ctx(true), ok.page, "home.title", { readyText: false });
  assert.equal(r2.pass, false, "an absent text passes .not");
});

test("verdict map: one row per classify branch (D10)", () => {
  assert.equal(classify({ verdict: "pass", checks: [], warnings: [] }).kind, "pass");
  assert.equal(classify({ verdict: "fail", checks: [], warnings: [] }).kind, "fail");
  const sk = classify({ verdict: "pass", checks: [{ verdict: "skipped", key: "home.title", catalog: "locales/de.json", reason: "catalog-string-capped" }], warnings: [] });
  assert.equal(sk.kind, "throw");
  assert.match(sk.error.message, /@home\.title.*locales\/de\.json.*skipped/);
  const cm = classify({ verdict: "pass", checks: [], warnings: [] }, [{ code: "catalog-missing", message: "no catalog for the locale de: locales/de.json; its @key checks are skipped" }]);
  assert.equal(cm.kind, "throw");
  assert.equal(cm.error.code, "catalog-missing");
  assert.match(cm.error.message, /locales\/de\.json/);
  const un = classify({ verdict: "unsupported", error: { code: "unsupported-language", message: "Tesseract is not installed", hint: "brew install tesseract tesseract-lang" }, checks: [], warnings: [] });
  assert.equal(un.kind, "unsupported");
  assert.match(un.error.message, /brew install tesseract tesseract-lang/);
  // TODO-065: needs-reader throws with its hint, so onUnsupported never sees it.
  const nr = classify({ verdict: "needs-reader", error: { code: "reader-missing", message: "catscan reads the locale el with Tesseract, which is not installed", hint: "brew install tesseract tesseract-lang" }, checks: [], warnings: [] });
  assert.equal(nr.kind, "throw");
  assert.equal(nr.error.code, "needs-reader");
  assert.equal(nr.error.anchor, "needs-reader");
  assert.match(nr.error.message, /Fix: brew install tesseract tesseract-lang/);
  assert.equal(classify({ verdict: "error", error: { code: "vision-timeout", message: "Vision did not answer", hint: "rerun" } }).error.code, "vision-timeout");
  assert.equal(classify({ verdict: "error", error: { code: "vision-languages-failed", message: "x" } }).kind, "throw");
  assert.equal(classify({ id: "x", error: { code: "invalid-request", message: "bad" } }).kind, "throw");
});

test("verdict map: unsupported throws with the hint, or calls test.skip under onUnsupported: skip (D8)", async () => {
  const unsupported = (req) => envelope(req, { verdict: "unsupported", error: { code: "unsupported-language", message: "the locale el needs Tesseract", hint: "brew install tesseract tesseract-lang" } });
  const h = harness({ respond: unsupported });
  await assert.rejects(h.matchers.toShowText.call(h.ctx(), h.page, "Γεια"), (e) => e.code === "unsupported" && /brew install tesseract/.test(e.message));
  const s = harness({ respond: unsupported, defaults: { onUnsupported: "skip" } });
  await s.matchers.toShowText.call(s.ctx(), s.page, "Γεια");
  assert.match(s.skipped, /Tesseract/);
  const p = harness({ preflight: () => { throw new CatscanError("unsupported-platform", "catscan needs macOS on Apple silicon; this is linux x64", "run catscan on a Mac with Apple silicon"); } });
  await assert.rejects(p.matchers.toShowText.call(p.ctx(), p.page, "x"), (e) => e instanceof CatscanUnsupportedPlatformError && e.anchor === "unsupported-platform");
  const ps = harness({ defaults: { onUnsupported: "skip" }, preflight: () => { throw new CatscanError("binary-not-found", "the catscan-core binary was not found", "swift build"); } });
  await ps.matchers.toShowText.call(ps.ctx(), ps.page, "x");
  assert.match(ps.skipped, /binary was not found/);
  assert.equal(ps.requests.length, 0);
});

test("verdict map: needs-reader fails the test under onUnsupported: skip (TODO-065, spec 13 D8)", async () => {
  // Value: protects=a supported locale is never skipped silently; fails_when=needs-reader is routed to onUnsupported; why_new=new verdict; seam=none; no_claim=a real Playwright run
  const nr = (req) => envelope(req, { verdict: "needs-reader", error: { code: "reader-missing", message: "catscan reads the locale el with Tesseract, which is not installed on this Mac", hint: "brew install tesseract tesseract-lang (about 650 MB), then rerun the same command" } });
  const s = harness({ respond: nr, defaults: { onUnsupported: "skip" } });
  await assert.rejects(s.matchers.toShowText.call(s.ctx(), s.page, "Γεια"), (e) => e.code === "needs-reader" && /brew install tesseract/.test(e.message));
  assert.equal(s.skipped, null);
});

test("verdict map: protocol mismatch, missing binary and internal envelopes throw after one request, no retry (D10)", async () => {
  const internal = harness({ respond: (req) => envelope(req, { verdict: "error", error: { code: "vision-languages-failed", message: "Vision listed no languages" } }) });
  await assert.rejects(internal.matchers.toShowText.call(internal.ctx(), internal.page, "x"), (e) => e.code === "vision-languages-failed");
  assert.equal(internal.requests.length, 1);
  const mismatch = harness({ startServer: () => ({ ready: Promise.reject(Object.assign(new CatscanError("serve-protocol-mismatch", "catscan-core speaks serve protocol 8", "install matching versions"))), dead: new CatscanError("serve-protocol-mismatch", "x"), request: async () => { throw new Error("unreachable"); } }) });
  await assert.rejects(mismatch.matchers.toShowText.call(mismatch.ctx(), mismatch.page, "x"), (e) => e.code === "serve-protocol-mismatch" && /Fix: install matching versions/.test(e.message));
  assert.equal(mismatch.starts, 1, "a protocol mismatch is not restarted");
  const missing = harness({ startServer: () => { throw new CatscanError("binary-not-found", "the catscan-core binary was not found", "swift build -c release --package-path core"); } });
  await assert.rejects(missing.matchers.toShowText.call(missing.ctx(), missing.page, "x"), (e) => e instanceof CatscanUnsupportedPlatformError && e.code === "binary-not-found");
});

test("Backend: dies once -> replaced and succeeds; twice -> throws; one Server across many assertions; exit kills the child (D1)", async () => {
  let starts = 0, deaths = 0;
  const make = (dieTimes) => () => {
    starts++;
    const s = { ready: Promise.resolve(), dead: null, proc: { kill() { s.killed = true; } }, exited: false,
      async request(req) { if (deaths < dieTimes) { deaths++; s.dead = new CatscanError("binary-failed", "catscan-core exited"); throw s.dead; } return envelope(req); } };
    return s;
  };
  const h = harness({ startServer: make(1) });
  assert.equal((await h.matchers.toShowText.call(h.ctx(), h.page, "x")).pass, true);
  assert.equal(starts, 2);
  for (let i = 0; i < 5; i++) await h.matchers.toShowText.call(h.ctx(), h.page, "x");
  assert.equal(starts, 2, "one Server for every later assertion");
  starts = 0; deaths = 0;
  const h2 = harness({ startServer: make(2) });
  await assert.rejects(h2.matchers.toShowText.call(h2.ctx(), h2.page, "x"), (e) => e.code === "binary-failed");
  assert.equal(starts, 2);
  const b = new Backend(make(0));
  b.current();
  killOnExit(b);
  assert.equal(b.server.killed, true);
});

test("locale: navigator.language de-DE sends de and {locale} expands to de; an option wins; none gives en (D6)", async () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "catscan-pw-cat-"));
  fs.writeFileSync(path.join(dir, "de.json"), JSON.stringify({ hud: { score: "Punkte" } }));
  const h = harness({ nav: "de-DE" });
  await h.matchers.toShowText.call(h.ctx(), h.page, "@hud.score", { catalog: path.join(dir, "{locale}.json") });
  const req = h.commands()[0];
  assert.equal(req.locale, "de");
  assert.equal(req.present[0].key, "hud.score");
  assert.equal(req.present[0].text, "Punkte");
  assert.ok(h.info.annotations.some((a) => a.type === "catscan-warnings" && /locale-fallback/.test(a.description)));
  const o = harness({ nav: "de-DE" });
  await o.matchers.toShowText.call(o.ctx(), o.page, "x", { locale: "fr" });
  assert.equal(o.commands()[0].locale, "fr");
  const n = harness({ nav: null });
  await n.matchers.toShowText.call(n.ctx(), n.page, "x");
  assert.equal(n.commands()[0].locale, "en");
  assert.equal(resolveLocale("zh-CN", { languages: [{ locale: "zh-Hans", aliases: ["zh-CN"] }] }).locale, "zh-Hans");
  assert.equal(resolveLocale("pt-BR", null).locale, "pt-BR", "no table: the tag goes as is");
});

test("catalogs: @key sends fragments; @key with no catalog throws naming the option; a missing {locale} file throws", async () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "catscan-pw-cat-"));
  fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ hud: { score: "Score: {n}" } }));
  const h = harness();
  await h.matchers.toShowText.call(h.ctx(), h.page, "@hud.score", { catalog: path.join(dir, "{locale}.json") });
  assert.deepEqual(h.commands()[0].present[0].alternatives, [["Score:"]]);
  await assert.rejects(h.matchers.toShowText.call(h.ctx(), h.page, "@hud.score"), (e) => e.code === "missing-catalog" && /catalog option/.test(e.message) && /Fix: pass catalog:/.test(e.message));
  await assert.rejects(h.matchers.toShowText.call(h.ctx(), h.page, "Play", { readyText: "@home.play" }), (e) => e.code === "missing-catalog" && /readyText/.test(e.message));
  const de = harness({ nav: "de" });
  await assert.rejects(de.matchers.toShowText.call(de.ctx(), de.page, "@hud.score", { catalog: path.join(dir, "{locale}.json") }), (e) => e.code === "catalog-missing" && /de\.json/.test(e.message));
});

test("catalogs: a TypeScript {locale} catalog sends fragments; its skipped values are an annotation (TODO-092)", async () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "catscan-pw-ts-"));
  fs.writeFileSync(path.join(dir, "en.ts"), "export default { hud: { score: 'Score: {n}', greet: `Hi ${name}` } } as const;");
  const h = harness();
  await h.matchers.toShowText.call(h.ctx(), h.page, "@hud.score", { catalog: path.join(dir, "{locale}.ts") });
  assert.deepEqual(h.commands()[0].present[0].alternatives, [["Score:"]]);
  assert.ok(h.info.annotations.some((a) => a.type === "catscan-warnings" && /catalog-values-skipped: 1 value in .*en\.ts/.test(a.description)));
});

test("requests: each matcher sends the spec 01 shape with a path input and the fallback option", async () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "catscan-pw-cat-"));
  fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ home: { title: "Welcome home" } }));
  fs.writeFileSync(path.join(dir, "de.json"), JSON.stringify({ home: { title: "Willkommen" } }));
  const h = harness({ nav: "de" });
  await h.matchers.toShowText.call(h.ctx(), h.page, ["A", "B"], { fallback: "none" });
  await h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: false, allow: ["Sett..."] });
  await h.matchers.toHaveNoUntranslated.call(h.ctx(), h.page, { readyText: false, base: path.join(dir, "en.json"), catalog: path.join(dir, "{locale}.json"), allow: ["OK"] });
  const [c, t, u] = h.commands();
  assert.deepEqual({ command: c.command, present: c.present, absent: c.absent, fallback: c.fallback }, { command: "check", present: ["A", "B"], absent: [], fallback: "none" });
  assert.ok(path.isAbsolute(c.path) && c.path.endsWith(".png"));
  assert.equal(t.command, "truncated");
  assert.deepEqual(t.truncated.allow, ["Sett..."]);
  assert.ok(t.truncated.boxes, "boxes from the page script");
  assert.equal(u.command, "untranslated");
  assert.equal(u.untranslated.base_locale, "en");
  assert.equal(u.untranslated.pairs[0].key, "home.title");
  assert.deepEqual(u.untranslated.allow, ["OK"]);
  await assert.rejects(h.matchers.toShowText.call(h.ctx(), h.locator, "x", { fullPage: true }), (e) => e.code === "playwright-usage" && /fullPage/.test(e.message));
  await assert.rejects(h.matchers.toShowText.call(h.ctx(), h.page, "x", { onUnsupported: "skip" }), (e) => e.code === "playwright-usage");
  await assert.rejects(h.matchers.toHaveNoUntranslated.call(h.ctx(), h.page, { readyText: false, base: "en.json" }), (e) => e.code === "missing-catalog");
});

test("pseudo: toShowText, toHaveNoTruncation and toHaveNoUntranslated send the pseudo field and read en-XA as en; overlap takes no pseudo (TODO-039 T3, D12, D16)", async () => {
  // Value: protects=spec 13 matchers on a pseudo build; fails_when=pseudo is dropped, the pseudo locale reaches OCR or {locale}, or a bad combination reaches serve; why_new=new option; seam=fake backend; no_claim=the rules (PseudoTests)
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "catscan-pw-pseudo-"));
  fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ home: { title: "Welcome home" } }));
  const h = harness({ nav: "en-XA" });
  const cat = path.join(dir, "{locale}.json");
  await h.matchers.toShowText.call(h.ctx(), h.page, "@home.title", { readyText: false, catalog: cat, pseudo: true });
  await h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: false, catalog: cat, pseudo: true, allow: ["Beta"] });
  await h.matchers.toHaveNoUntranslated.call(h.ctx(), h.page, { readyText: false, catalog: cat, pseudo: true });
  const [c, t, u] = h.commands();
  assert.deepEqual([c.locale, t.locale, u.locale], ["en", "en", "en"]);
  assert.deepEqual([c.pseudo.entries, typeof c.pseudo.digest], [[], "string"]);
  assert.deepEqual([t.truncated.pseudo, t.pseudo.entries.map((e) => e.key), t.pseudo.allow], [true, ["home.title"], ["Beta"]]);
  assert.deepEqual([u.pseudo.entries.map((e) => e.key), u.untranslated.pairs], [["home.title"], []]);
  await h.matchers.toHaveNoUntranslated.call(h.ctx(), h.page, { readyText: "@home.title", catalog: cat, pseudo: true });
  const [ready, after] = h.commands().slice(-2);
  assert.deepEqual([ready.command, ready.pseudo.entries, after.command, after.pseudo.entries.length], ["check", [], "untranslated", 1]);
  await h.matchers.toHaveNoUntranslated.call(h.ctx(), h.page, { readyText: false, catalog: cat, locale: "en" });
  assert.equal(h.commands().at(-1).pseudo, undefined);
  const n = h.commands().length;
  await assert.rejects(h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: false, pseudo: true }), (e) => e.code === "missing-catalog");
  await assert.rejects(h.matchers.toHaveNoUntranslated.call(h.ctx(), h.page, { readyText: false, catalog: cat, base: path.join(dir, "en.json"), pseudo: true }), (e) => e.code === "pseudo-conflicts-with-base");
  await assert.rejects(h.matchers.toHaveNoOverlap.call(h.ctx(), h.page, { readyText: false, pseudo: true }), (e) => e.code === "playwright-usage" && /no option pseudo/.test(e.message));
  await assert.rejects(h.matchers.toShowText.call(h.ctx(), h.page, "x", { pseudo: "yes" }), (e) => e.code === "playwright-usage");
  assert.equal(h.commands().length, n);
});

const el = (text, x, y, width, height, extra = {}) => ({ id: null, rect: { x, y, width, height }, text, ariaLabel: null, overflow: "hidden", textOverflow: "ellipsis", ...extra });

test("boxes: viewport, locator (clip, shift, extent) and fullPage (scroll offset, fixed element) goldens (D5)", async () => {
  const c = { viewport: { width: 1000, height: 500 }, dpr: 2, elements: [el("Title", 100, 50, 200, 50), el("Inside", 420, 220, 100, 40), el("Outside", 900, 450, 50, 20)] };
  const v = harness({ collects: [c], imageSize: [2000, 1000] });
  await v.matchers.toHaveNoTruncation.call(v.ctx(), v.page, { readyText: false });
  assert.deepEqual(v.commands()[0].truncated.boxes.elements.map((e) => [e.text, e.box]), [["Title", [0.1, 0.1, 0.2, 0.1]], ["Inside", [0.42, 0.44, 0.1, 0.08]], ["Outside", [0.9, 0.9, 0.05, 0.04]]]);
  assert.deepEqual(v.commands()[0].truncated.boxes.image, { width: 2000, height: 1000 });
  const l = harness({ collects: [c], box: { x: 400, y: 200, width: 200, height: 100 }, imageSize: [400, 200] });
  await l.matchers.toHaveNoTruncation.call(l.ctx(), l.locator, { readyText: false });
  assert.deepEqual(l.commands()[0].truncated.boxes.elements.map((e) => [e.text, e.box]), [["Inside", [0.1, 0.2, 0.5, 0.4]]]);
  // TODO-049 D9: `collect` marks the fixed element; pageExtra is the scroll offset only.
  const fp = { viewport: { width: 1000, height: 500 }, dpr: 1, elements: [{ ...el("Header", 0, 0, 1000, 50), fixed: true }, el("Below", 100, 100, 200, 50)] };
  const f = harness({ collects: [fp], extra: { scrollX: 0, scrollY: 300 }, imageSize: [1000, 2000] });
  await f.matchers.toHaveNoTruncation.call(f.ctx(), f.page, { readyText: false, fullPage: true });
  assert.equal(f.lastShot.fullPage, true);
  assert.deepEqual(f.commands()[0].truncated.boxes.elements.map((e) => [e.text, e.box]), [["Header", [0, 0, 1, 0.025]], ["Below", [0.1, 0.2, 0.2, 0.025]]]);
});

test("toHaveNoOverlap: sends overlap with the page's boxes and allow; fails with the CLI line (TODO-046 T3, D13)", async () => {
  // Value: protects=T3 (boxes collected as for toHaveNoTruncation reach the overlap field, allow travels, the failure names a graphic by id); fails_when=the matcher sends truncated, drops boxes or allow, or the message loses the pair; why_new=new matcher; seam=fake backend; no_claim=the rule (OverlapElementsTests)
  const c = { viewport: { width: 1000, height: 500 }, dpr: 2, elements: [el("Title", 100, 50, 200, 50), { id: "bell", rect: { x: 280, y: 50, width: 40, height: 40 }, text: "", ariaLabel: null, overflow: "visible", textOverflow: "clip", graphic: true }] };
  const f = { kind: "overlap", box: [0.1, 0.1, 0.22, 0.1], line: "Title / [bell]", a: { text: "Title", box: [0.1, 0.1, 0.2, 0.1], confidence: 0.9, element: { id: null, box: [0.1, 0.1, 0.2, 0.1] } }, b: { text: null, box: [0.28, 0.1, 0.04, 0.08], confidence: null, element: { id: "bell", box: [0.28, 0.1, 0.04, 0.08] } }, overlap: 0.5, signal: "elements" };
  const h = harness({ collects: [c], imageSize: [2000, 1000], respond: (req) => envelope(req, req.command === "overlap" ? { verdict: "fail", findings: [f] } : {}) });
  const r = await h.matchers.toHaveNoOverlap.call(h.ctx(), h.page, { readyText: false, allow: ["avatar-badge"] });
  const cmd = h.commands()[0];
  assert.equal(cmd.command, "overlap");
  assert.deepEqual(cmd.overlap.allow, ["avatar-badge"]);
  assert.deepEqual([cmd.overlap.stacked, cmd.overlap.geometry], [true, false]); // TODO-067 D3, D19, D35: as plain catscan overlap
  assert.deepEqual(cmd.overlap.boxes.elements.map((e) => [e.id, e.text ?? null, e.graphic ?? false]), [[null, "Title", false], ["bell", null, true]]);
  assert.equal(r.pass, false);
  assert.match(r.message(), /overlap "Title" \/ \[bell\] \(50%\) at \[0\.1, 0\.1, 0\.22, 0\.1\]/);
});

test("boxes: differing before/after lists retake; never-stable lists run without boxes and say boxes-unstable (D15)", async () => {
  const a = { viewport: { width: 100, height: 100 }, dpr: 1, elements: [el("Moving", 0, 0, 10, 10)] };
  const b = { viewport: { width: 100, height: 100 }, dpr: 1, elements: [el("Moving", 5, 0, 10, 10)] };
  const h = harness({ collects: [a, b, b, b] });
  await h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: false });
  assert.equal(h.shots, 2, "retaken once");
  assert.ok(h.commands()[0].truncated.boxes);
  const moving = Array.from({ length: 400 }, (_, i) => ({ viewport: { width: 100, height: 100 }, dpr: 1, elements: [el("Moving", i, 0, 10, 10)] }));
  const u = harness({ collects: moving, respond: (req) => envelope(req, { verdict: "fail", findings: [{ kind: "truncated", reason: "ellipsis", line: "Sett...", box: [0, 0, 0.1, 0.1] }] }) });
  // Each screenshot is a fake 0 ms; the clock moves with the explicit tick below.
  u.page.screenshot = async (o) => { u.shots++; u.t += 100; fs.writeFileSync(o.path, require("./helpers").png()); };
  const r = await u.matchers.toHaveNoTruncation.call(u.ctx(false, 1000), u.page, { readyText: false });
  assert.equal(u.commands()[0].truncated.boxes, undefined);
  assert.match(r.message(), /boxes-unstable/);
  assert.match(r.message(), /"Sett\.\.\." is cut off \(ellipsis\)/);
  const json = JSON.parse(u.info.attachments.find((x) => x.name === "catscan.json").body);
  assert.ok(json.warnings.some((w) => w.code === "boxes-unstable"));
});

test("toHaveNoOverlap without boxes throws overlap-no-boxes, never the OCR-only reader (TODO-046 D3)", async () => {
  // Value: protects=D3 in the matcher; fails_when=unstable, iframe or boxless runs send overlap without boxes and pass on the 1-in-16 reader; why_new=review finding; seam=none; no_claim=real browser timing (fake collects)
  const c = { viewport: { width: 1000, height: 500 }, dpr: 1, elements: [el("Settings", 820, 10, 150, 40)] };
  for (const [opts, why] of [[{ inFrame: true }, /iframe/], [{ box: null }, /no bounding box/]]) {
    const l = harness({ collects: [c], ...opts });
    await assert.rejects(l.matchers.toHaveNoOverlap.call(l.ctx(), l.locator, { readyText: false }), (e) => /^catscan overlap-no-boxes: /.test(e.message) && why.test(e.message) && /#overlap-no-boxes$/.test(e.message));
    assert.equal(l.commands().filter((x) => x.command === "overlap").length, 0);
  }
  const moving = Array.from({ length: 400 }, (_, i) => ({ viewport: { width: 100, height: 100 }, dpr: 1, elements: [el("Moving", i, 0, 10, 10)] }));
  const u = harness({ collects: moving });
  u.page.screenshot = async (o) => { u.shots++; u.t += 100; fs.writeFileSync(o.path, require("./helpers").png()); };
  await assert.rejects(u.matchers.toHaveNoOverlap.call(u.ctx(false, 1000), u.page, { readyText: false }), /catscan overlap-no-boxes: the page's element boxes moved/);
  assert.equal(u.commands().filter((x) => x.command === "overlap").length, 0);
});

test("errors: every thrown error has a code, the catscan <code>: ... Fix: ... shape and an anchor in the recipe (D18)", async () => {
  const recipe = fs.readFileSync(path.join(ROOT, RECIPE), "utf8");
  const anchors = new Set([...recipe.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1].trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-")));
  for (const a of [...ANCHORS, "other-errors"]) assert.ok(anchors.has(a), `the recipe has a heading for #${a}`);
  const h = harness();
  const errors = [];
  for (const p of [
    h.matchers.toShowText.call(h.ctx(), h.page, "@x"),
    h.matchers.toHaveNoTruncation.call(h.ctx(true), h.page),
    h.matchers.toShowText.call(h.ctx(), h.page, "x", { bogus: 1 }),
    h.matchers.toShowText.call(h.ctx(), {}, "x"),
    h.matchers.toShowText.call(h.ctx(), h.page, "x", { catalog: "/nonexistent/en.json" }),
  ]) await p.catch((e) => errors.push(e));
  assert.equal(errors.length, 5);
  for (const e of errors) {
    assert.ok(e instanceof CatscanError, e.message);
    assert.match(e.message, new RegExp(`^catscan ${e.code}: .+\\. Fix: .+\\. See docs/recipes/playwright\\.md#[a-z-]+$`, "s"));
    assert.ok(anchors.has(e.anchor), e.anchor);
  }
});

test("warnings: locale-fallback lands in the annotation and catscan.json, not stderr (D21)", async () => {
  const h = harness({ nav: "de-AT", respond: (req) => envelope(req, { verdict: "fail", warnings: [{ code: "fallback-used", message: "read with Tesseract" }], findings: [{ kind: "placeholder", token: "{count}", line: "{count} coins", box: [0, 0, 0.1, 0.1] }] }) });
  const r = await h.matchers.toHaveNoUntranslated.call(h.ctx(), h.page, { readyText: false });
  assert.equal(h.stderr, "");
  assert.ok(h.info.annotations.some((a) => /^locale-fallback: the locale de-AT/.test(a.description)));
  const json = JSON.parse(h.info.attachments.find((x) => x.name === "catscan.json").body);
  assert.ok(json.warnings.some((w) => w.code === "locale-fallback"));
  assert.match(r.message(), /"\{count\} coins" is an unfilled placeholder "\{count\}"/);
  assert.match(r.message(), /reader: tesseract/);
});

test("attachments: names, content types, the HTML embeds the image and the overlay SVG; lines from a read request", async () => {
  const h = harness({ respond: (req) => (req.command === "read" ? envelope(req, { lines: [{ text: "GAME OVR" }, { text: "Score 10" }] }) : failPresent(req)) });
  const r = await h.matchers.toShowText.call(h.ctx(false, 100), h.page, "GAME OVER");
  assert.equal(r.pass, false);
  assert.deepEqual(h.info.attachments.map((a) => [a.name, a.contentType]), [["catscan.png", "image/png"], ["catscan.html", "text/html"], ["catscan-lines.txt", "text/plain"], ["catscan.json", "application/json"]]);
  const html = h.info.attachments[1].body;
  assert.match(html, /<img alt="screenshot" src="data:image\/png;base64,iVBORw0KGgo/);
  assert.match(html, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1000 1000"/);
  assert.match(html, /<rect data-ref="c0"/);
  assert.equal(h.info.attachments[2].body, "GAME OVR\nScore 10\n");
  assert.equal(fs.readdirSync(h.tmp).filter((f) => f.endsWith(".png")).length, 1, "the failing screenshot stays");
});

test("index: the pre-extended expect has the three matchers and Playwright's own (D17)", () => {
  const { expect, catscanMatchers } = require("../src/index");
  const m = expect({});
  for (const k of ["toShowText", "toHaveNoTruncation", "toHaveNoUntranslated", "toHaveNoOverlap", "toHaveText", "toBe"]) assert.equal(typeof m[k], "function", k);
  assert.deepEqual(Object.keys(catscanMatchers({ catalog: "x" })).sort(), ["toHaveNoOverlap", "toHaveNoTruncation", "toHaveNoUntranslated", "toShowText"]);
  assert.throws(() => catscanMatchers({ nope: 1 }), (e) => e.code === "playwright-usage");
});

test("index: reuses the @playwright/test copy the runner loaded, never a second one (checkout symlink install)", () => {
  // Value: fails_when=a package linked from a checkout requires its own @playwright/test and Playwright aborts.
  const { spawnSync } = require("child_process");
  const code = `
    const fake = "/elsewhere/node_modules/@playwright/test/index.js";
    const marker = { extended: 0 };
    const expect = () => ({});
    expect.extend = (m) => { marker.extended = Object.keys(m).length; return expect; };
    require.cache[fake] = { id: fake, filename: fake, loaded: true, exports: { test: {}, expect } };
    require(${JSON.stringify(path.join(__dirname, "../src/index.js"))});
    if (marker.extended !== 4) throw new Error("the loaded copy was not used: " + marker.extended);
    if (Object.keys(require.cache).some((k) => k !== fake && /@playwright[\\\\/]test[\\\\/]index\\.js$/.test(k))) throw new Error("a second copy loaded");`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("review fixes: a canvas-covering element is left out of the boxes; iframe or boxless locators get no boxes", async () => {
  // Value: protects=D5 canvas text checked without boxes; fails_when=an aria-labelled canvas owns its lines and hides a screen-edge cut; why_new=red-team finding; seam=none; no_claim=core assignment (fake serve)
  const c = { viewport: { width: 1000, height: 500 }, dpr: 1, elements: [el("Game", 0, 0, 800, 400, { text: "", ariaLabel: "Game" }), el("Settings", 820, 10, 150, 40)] };
  const h = harness({ collects: [c], media: [{ x: 0, y: 0, width: 800, height: 400 }] });
  await h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: false });
  assert.deepEqual(h.commands()[0].truncated.boxes.elements.map((e) => e.text), ["Settings"]);
  for (const [opts, why] of [[{ inFrame: true }, /iframe/], [{ box: null }, /no bounding box/]]) {
    const l = harness({ collects: [c], ...opts });
    await l.matchers.toHaveNoTruncation.call(l.ctx(), l.locator, { readyText: false });
    assert.equal(l.commands()[0].truncated.boxes, undefined);
    assert.ok(l.info.annotations.some((a) => /^boxes-missing: /.test(a.description) && why.test(a.description)));
  }
});

test("review fixes: navigator.language that is not a tag never reaches a catalog path; locale and allow are validated", async () => {
  // Value: protects=the page cannot steer {locale} into a path; fails_when=a ../ tag is expanded into the catalog spec; why_new=security finding; seam=none; no_claim=none beyond protects
  const h = harness({ nav: "../../etc/x", languages: null });
  await h.matchers.toShowText.call(h.ctx(), h.page, "A");
  assert.equal(h.commands()[0].locale, "en");
  assert.ok(h.info.annotations.some((a) => /not a language tag/.test(a.description)));
  await assert.rejects(h.matchers.toShowText.call(h.ctx(), h.page, "A", { locale: "../x" }), (e) => e.code === "playwright-usage");
  await assert.rejects(h.matchers.toHaveNoUntranslated.call(h.ctx(), h.page, { allow: [1] }), (e) => e.code === "playwright-usage");
  await h.matchers.toHaveNoUntranslated.call(h.ctx(), h.page, { readyText: false, allow: ["  OK ", " "] });
  assert.deepEqual(h.commands().at(-1).untranslated.allow, ["OK"]);
});

test("review fixes: a skip raised while reading the failure's lines is never swallowed into the failure", async () => {
  // Value: protects=D8 skip semantics on the failure path; fails_when=the line read goes through the skip handler and its throw is caught; why_new=pass-2 testing finding; seam=none; no_claim=real test.skip (fake skip)
  const h = harness({ defaults: { onUnsupported: "skip" }, respond: (req) => { if (req.command === "read") throw new CatscanError("binary-not-found", "the catscan-core binary was not found", "swift build"); return failPresent(req); } });
  const r = await h.matchers.toShowText.call(h.ctx(false, 100), h.page, "GAME OVER");
  assert.equal(r.pass, false, "the failed check is reported");
  assert.equal(h.skipped, null, "the line read never calls test.skip");
});

test("thresholds: minSeverity and minCertainty validated; a below-threshold finding passes and goes to the attachment; message sorted (TODO-077)", async () => {
  // Value: protects=TODO-077 D8 on Playwright; fails_when=the matcher reads the core verdict, lists below-threshold findings in the message, or accepts a bad level; why_new=new options; seam=fake backend; no_claim=the bands (findings-registry.test.js)
  const boxes = { kind: "overlap", signal: "boxes", box: [0.1, 0.1, 0.5, 0.1], line: "Kopf / Fuss", a: { text: "Kopf", box: [0.1, 0.1, 0.5, 0.05], confidence: 1 }, b: { text: "Fuss", box: [0.1, 0.12, 0.5, 0.05], confidence: 1 }, overlap: 0.4 };
  const trunc = { kind: "truncated", box: null, line: "Weiter...", reason: "ellipsis", element: null, expected: null, confidence: 1 };
  const ph = { kind: "placeholder", box: null, line: "Hi {name}", token: "{name}" };
  const respond = (findings) => (req) => envelope(req, req.command === "read" ? {} : { verdict: "fail", engine: "vision-accurate-rev3", findings: findings.map((f) => ({ ...f })) });
  let h = harness({ respond: respond([boxes]) });
  let r = await h.matchers.toHaveNoTruncation.call(h.ctx(false, 100), h.page, { readyText: false, minCertainty: "medium" });
  assert.equal(r.pass, true);
  assert.deepEqual(h.info.attachments.map((a) => a.name), ["catscan.json"]);
  assert.match(h.info.attachments[0].body, /"gate": false/);
  h = harness({ respond: respond([boxes, trunc, ph]) });
  r = await h.matchers.toHaveNoTruncation.call(h.ctx(false, 100), h.page, { readyText: false, minCertainty: "medium" });
  assert.equal(r.pass, false);
  const msg = r.message();
  assert.match(msg, /critical\/medium {2}"Hi \{name\}" is an unfilled placeholder "\{name\}"\n {2}major\/medium {2}"Weiter\.\.\." is cut off \(ellipsis\)/);
  assert.doesNotMatch(msg, /Kopf/, "below-threshold findings stay out of the message");
  for (const bad of [{ minSeverity: "high" }, { minCertainty: "critical" }]) {
    h = harness({ respond: respond([]) });
    await assert.rejects(h.matchers.toHaveNoTruncation.call(h.ctx(), h.page, { readyText: false, ...bad }), (e) => e.code === "playwright-usage" && /one of/.test(e.message));
  }
  h = harness({ respond: respond([]) });
  await assert.rejects(h.matchers.toShowText.call(h.ctx(), h.page, "x", { readyText: false, minSeverity: "major" }), (e) => e.code === "playwright-usage");
});

// Value: protects=a long run of dots in an error message cannot stall the matcher (CodeQL js/polynomial-redos);
// fails_when=trimDot goes back to /\.+$/, which is quadratic on dots followed by another character; why_new=no test
// timed it (TODO-109); seam=none; no_claim=other regexes in the package
test("an error message with a long run of dots is trimmed in linear time (TODO-109)", () => {
  const message = `${".".repeat(100000)}x...`;
  const t0 = process.hrtime.bigint();
  const r = classify({ verdict: "error", error: { code: "internal", message, hint: "rerun." } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.kind, "throw");
  assert.ok(r.error.message.includes(`${".".repeat(100000)}x. Fix: rerun. See `), r.error.message.slice(-120));
  assert.ok(ms < 500, `classify took ${ms} ms`);
});
