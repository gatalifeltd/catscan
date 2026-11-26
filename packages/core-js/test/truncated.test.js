// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 06: `truncated` and `boxes` arguments, boxes files, sidecars, converters, request fields and rendering.
// Synthetic fixtures only (packages/core-js/test/fixtures/boxes; their dumps follow the documented formats, D25).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parse, UsageError } = require("../src/args");
const boxes = require("../src/boxes");
const truncated = require("../src/truncated");
const render = require("../src/render");
const { HELP, SHORT_USAGE } = require("../src/cli");

const F = path.join(__dirname, "fixtures/boxes");
const usage = (fn, code, line) => assert.throws(fn, (e) => {
  assert.ok(e instanceof UsageError, String(e));
  assert.equal(e.code, code);
  if (line !== undefined) assert.equal(render.diagnosticLine(e), line);
  return true;
});
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "catscan-t-"));
const write = (d, name, data) => { const f = path.join(d, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data)); return f; };
const png = (w, h) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write("IHDR", 12);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const BOXES = { image: { width: 100, height: 200 }, elements: [{ id: "t", box: [0.1, 0.1, 0.5, 0.05], text: "Einstellungen" }] };

test("args: truncated and boxes are commands with their own options", () => {
  const o = parse(["truncated", "shots", "--boxes", "b", "--reasons", "edge", "--catalog", "de.json", "--allow", "a.txt", "--locale", "de"]);
  assert.deepEqual([o.command, o.boxes, o.reasons, o.catalogs, o.allow], ["truncated", "b", "edge", ["de.json"], "a.txt"]);
  assert.deepEqual(parse(["boxes", "uiautomator", "d.xml", "--image", "s.png"]).paths, ["uiautomator", "d.xml"]);
  usage(() => parse(["check", "s", "--present", "x", "--boxes", "b"]), "option-not-valid");
  usage(() => parse(["--reasons", "edge", "read", "s"]), "option-not-valid");
  usage(() => parse(["truncated", "s", "--image", "x.png"]), "option-not-valid");
  usage(() => parse(["truncated", "s", "--present", "x"]), "option-not-valid");
  usage(() => parse(["truncated", "s", "--base", "en.json"]), "option-not-valid");
  usage(() => parse(["truncated"]), "missing-path");
  usage(() => parse(["boxes", "xcuitest"]), "missing-path", "catscan: missing-path: boxes needs a source and a dump file - try: catscan boxes xcuitest shop.xcui.txt > shop.boxes.json");
  usage(() => parse(["boxes", "xcuitest", "d", "--locale", "de"]), "option-not-valid");
});

test("--reasons: a known list, unknown names the closest, empty is an error (D27, D28)", () => {
  assert.deepEqual(truncated.parseReasons("edge, ellipsis,edge"), ["edge", "ellipsis"]);
  usage(() => truncated.parseReasons("edg"), "unknown-reason", "catscan: unknown-reason: --reasons: unknown reason edg; did you mean edge? - try: --reasons ellipsis,prefix,edge,overflow,screen-edge,pseudo-cut");
  usage(() => truncated.parseReasons(","), "unknown-reason", "catscan: unknown-reason: --reasons needs at least one reason - try: --reasons ellipsis,prefix,edge,overflow,screen-edge,pseudo-cut");
});

test("boxes file: loads with defaults; each malformed shape names its field (D7, D27)", () => {
  const d = dir();
  const ok = boxes.load(write(d, "ok.json", BOXES));
  assert.deepEqual(ok.elements[0], { id: "t", box: [0.1, 0.1, 0.5, 0.05], clips: true, text: "Einstellungen" });
  const bad = (data, field) => {
    const f = write(d, "bad.json", data);
    usage(() => boxes.load(f), "invalid-boxes", `catscan: invalid-boxes: ${f}: ${field} - try: catscan boxes <source> <dump> > ${f} writes a valid file`);
  };
  bad("{", "not JSON (Expected property name or '}' in JSON at position 1 (line 1 column 2))");
  bad([], "must be an object {image, elements}");
  bad({ image: { width: 0, height: 1 }, elements: [] }, "image must be {width, height} above 0");
  bad({ image: { width: "390", height: 844 }, elements: [] }, "image must be {width, height} above 0");
  bad({ image: { width: true, height: 1 }, elements: [] }, "image must be {width, height} above 0");
  bad({ image: { width: 1, height: 1 } }, "elements must be an array");
  bad({ image: { width: 1, height: 1 }, elements: [{ box: [0, 0, 1.2, 0.1] }] }, "elements[0].box must be 4 numbers in 0..1 with width and height above 0");
  bad({ image: { width: 1, height: 1 }, elements: [{ box: [0, 0, 0, 0.1] }] }, "elements[0].box must be 4 numbers in 0..1 with width and height above 0");
  bad({ image: { width: 1, height: 1 }, elements: [{ box: [0, 0, 1, 1], id: 3 }] }, "elements[0].id must be a string");
  bad({ image: { width: 1, height: 1 }, elements: [{ box: [0, 0, 1, 1], text: 3 }] }, "elements[0].text must be a string");
  bad({ image: { width: 1, height: 1 }, elements: [{ box: [0, 0, 1, 1], clips: "yes" }] }, "elements[0].clips must be true or false");
  const missing = path.join(d, "none.json");
  usage(() => boxes.load(missing), "boxes-not-found", `catscan: boxes-not-found: cannot read the boxes file ${missing}: ENOENT - try: check the --boxes path; it is read from the working directory`);
});

test("request field: reasons, allow, catalog prefixes and boxes per image (D2, D6, D24)", () => {
  const d = dir();
  const cat = write(d, "de.json", { a: "Einstellungen", b: "Willkommen, {name}", c: "" });
  const allow = write(d, "allow.txt", "# brand\nLoading...\n");
  const shot = { path: path.join(d, "shot.png"), arg: path.join(d, "shot.png"), argIsDir: false, stdin: false };
  const t = truncated.build(parse(["truncated", shot.path, "--catalog", cat, "--reasons", "edge,prefix", "--allow", allow, "--boxes", write(d, "b.json", BOXES)]), [shot]);
  const { field, warnings } = t.forInput(shot);
  assert.deepEqual(field.reasons, ["edge", "prefix"]);
  assert.deepEqual(field.allow, ["Loading..."]);
  assert.deepEqual(field.prefixes, [{ text: "Einstellungen", alternatives: [["Einstellungen"]] }, { text: "Willkommen, {name}", alternatives: [["Willkommen,"]] }]);
  assert.equal(field.boxes.elements[0].id, "t");
  assert.deepEqual(warnings, []);
  // No options: an empty field, so the core's defaults apply.
  assert.deepEqual(truncated.build(parse(["truncated", shot.path]), [shot]).forInput(shot).field, {});
});

test("--boxes <file> takes one image; <dir> maps sidecars and warns for a missing one (D6)", () => {
  const d = dir();
  const f = write(d, "b.json", BOXES);
  const inputs = ["a.png", "sub/b.png"].map((n) => ({ path: path.join(d, "shots", n), arg: path.join(d, "shots"), argIsDir: true, stdin: false }));
  usage(() => truncated.build(parse(["truncated", "x", "--boxes", f]), inputs), "boxes-one-image",
    `catscan: boxes-one-image: --boxes ${f} applies to one image, but 2 were given - try: --boxes <dir>, with <name>.boxes.json next to each image`);
  usage(() => truncated.build(parse(["truncated", "x", "--boxes", path.join(d, "nope.json")]), inputs), "boxes-not-found");
  assert.equal(boxes.sidecar(path.join(d, "shots"), inputs[1]), path.join(d, "shots/sub/b.boxes.json"));
  assert.equal(boxes.sidecar("bx", { path: "/x/y/c.png", arg: "/x/y/c.png", argIsDir: false }), path.join("bx", "c.boxes.json"));
  write(d, "shots/a.boxes.json", BOXES);
  const t = truncated.build(parse(["truncated", "x", "--boxes", path.join(d, "shots")]), inputs);
  assert.equal(t.forInput(inputs[0]).field.boxes.elements.length, 1);
  const miss = t.forInput(inputs[1]);
  assert.equal(miss.field.boxes, undefined);
  const want = path.join(d, "shots/sub/b.boxes.json");
  assert.equal(render.diagnosticLine(miss.warnings[0]),
    `catscan: boxes-missing: no boxes for ${inputs[1].path} (looked for ${want}); checked without boxes - try: catscan boxes <source> <dump> --image ${inputs[1].path} > ${want}`);
  // stdin has no path, so no sidecar: checked without boxes, and the hint says how to give them.
  const stdin = { path: "-", arg: "-", argIsDir: false, stdin: true };
  const s = truncated.build(parse(["truncated", "-", "--boxes", path.join(d, "shots")]), [stdin]).forInput(stdin);
  assert.equal(render.diagnosticLine(s.warnings[0]), "catscan: boxes-missing: no boxes for - (stdin has no path to find a sidecar by); checked without boxes - try: pass the image as a file, or --boxes <file> for it");
  // A malformed sidecar stops the run before any image is read.
  write(d, "shots/sub/b.boxes.json", "{");
  usage(() => truncated.build(parse(["truncated", "x", "--boxes", path.join(d, "shots")]), inputs), "invalid-boxes");
});

test("converters: each dump matches its golden boxes file (D9, D10, D17, D19, D36)", () => {
  const img = write(dir(), "shot.png", png(1080, 2400));
  for (const [source, dump, golden, image] of [
    ["xcuitest", "shop.xcui.txt", "xcuitest"], ["uiautomator", "shop.uia.xml", "uiautomator", img],
    ["maestro", "shop-ios.maestro.json", "maestro-ios"], ["maestro", "shop-android.maestro.json", "maestro-android", img],
    ["playwright", "shop.pw.json", "playwright"],
    // TODO-049 D4, D5: controls, fields, panels, scroll containers, a react-native-svg icon per source.
    ["xcuitest", "controls.xcui.txt", "controls-xcuitest"], ["uiautomator", "controls.uia.xml", "controls-uiautomator", img],
    ["maestro", "controls-android.maestro.json", "controls-maestro-android", img], ["playwright", "controls.pw.json", "controls-playwright"],
  ]) {
    const r = boxes.convert(source, path.join(F, dump), image || null);
    assert.deepEqual(r.boxes, JSON.parse(fs.readFileSync(path.join(F, `${golden}.golden.json`), "utf8")), golden);
    // Every converter's output is a valid boxes file.
    boxes.load(write(dir(), "o.json", r.boxes));
  }
});

test("converters: text source, points vs pixels, offscreen elements", () => {
  const x = boxes.convert("xcuitest", path.join(F, "shop.xcui.txt"), null).boxes;
  // D36: a button's label is its text (D52 keeps ", Taste" out of prefix findings); a static text's quote survives;
  // a text field shows its value, not its label.
  assert.equal(x.elements.find((e) => e.id === "continue").text, "Mit E-Mail fortfahren, Taste");
  assert.ok(x.elements.some((e) => e.text === "Anna's Konto"));
  assert.ok(x.elements.some((e) => e.id === "email" && e.text === "anna@example.com"));
  assert.ok(x.elements.find((e) => e.text === "Angebot der Woche").offscreen);
  assert.deepEqual(x.image, { width: 393, height: 852 }); // points: the root window is the screen
  const u = boxes.convert("uiautomator", path.join(F, "shop.uia.xml"), write(dir(), "s.png", png(1080, 2400))).boxes;
  assert.equal(u.elements.find((e) => e.id === "com.example:id/title").text, "Einstellungen"); // not content-desc
  assert.equal(u.elements.find((e) => e.id === "com.example:id/close").text, "Schließen"); // content-desc when text is empty
  assert.deepEqual(u.image, { width: 1080, height: 2400 }); // pixels: normalized by the screenshot, not the root
  // TODO-018 shape: the string in accessibilityText, nested pairs collapsed, a container's joined label dropped,
  // a button keeps the label its title frame also has (D51), a value chip keeps text.
  const m = boxes.convert("maestro", path.join(F, "shop-ios.maestro.json"), null).boxes;
  assert.equal(m.elements.find((e) => e.id === "title").text, "Einstellungen");
  assert.equal(m.elements.filter((e) => e.text === "Einstellungen").length, 1);
  assert.equal(m.elements.find((e) => e.id === "menu").text, undefined);
  assert.deepEqual(m.elements.filter((e) => ["Konto", "Profil", "Abmelden"].includes(e.text)).length, 3);
  assert.deepEqual(m.elements.filter((e) => e.text === "Mit E-Mail fortfahren").map((e) => e.id), ["continue", null]);
  assert.equal(m.elements.find((e) => e.id === "language").text, "Deutsch");
  assert.ok(!m.elements.some((e) => e.text === "Shop")); // the root's label is a container's
  const p = boxes.convert("playwright", path.join(F, "shop.pw.json"), null).boxes;
  assert.equal(p.elements.length, 2); // wholly outside the viewport: dropped
  assert.deepEqual(p.elements.map((e) => e.clips), [true, false]);
});

// Value: protects=TODO-072 D3 (a parent and child with one rect and different texts never reach overlap as a pair: the parent keeps no text); fails_when=treeText keeps both texts, so sheets would read nesting as a stack; why_new=TODO-072 relies on it; seam=none; no_claim=flat dumps (OverlapElementsTests)
test("converters: a tree parent with the child's rect and another text keeps no text (TODO-072 D3)", () => {
  const d = dir();
  const dump = ["    Window (Main), 0x0, {{0.0, 0.0}, {100.0, 200.0}}",
    "      Other, 0x1, {{0.0, 50.0}, {80.0, 10.0}}, label: 'Seite eins'",
    "        StaticText, 0x2, {{0.0, 50.0}, {80.0, 10.0}}, label: 'Seite zwei'"].join("\n");
  const els = boxes.convert("xcuitest", write(d, "tree.txt", dump), null).boxes.elements;
  assert.deepEqual(els.map((e) => e.text ?? null), [null, "Seite zwei"]);
});

test("converters: first non-empty field per format, leaf only on trees (D36, D38, D50, D51)", () => {
  const d = dir();
  const img = write(d, "s.png", png(100, 200));
  const texts = (source, name, data, image = null) => boxes.convert(source, write(d, name, data), image).boxes.elements.map((e) => e.text ?? null);
  // maestro: text, then accessibilityText, then hintText; a blank field falls through.
  const mn = (a, b) => ({ attributes: { bounds: b, ...a }, children: [] });
  assert.deepEqual(texts("maestro", "m.json", { attributes: { bounds: "[0,0][100,200]" }, children: [
    mn({ text: "T", accessibilityText: "A", hintText: "H" }, "[0,0][50,10]"), mn({ text: " ", accessibilityText: "A", hintText: "H" }, "[0,20][50,30]"),
    mn({ accessibilityText: "", hintText: "H" }, "[0,40][50,50]"), mn({}, "[0,60][50,70]"),
  ] }, img), ["T", "A", "H", null]);
  // uiautomator: text, content-desc, hint (or hintText).
  const un = (a, b) => `<node text="${a.text || ""}" content-desc="${a.cd || ""}" ${a.hint ? `hint="${a.hint}"` : ""} ${a.hintText ? `hintText="${a.hintText}"` : ""} bounds="${b}" />`;
  assert.deepEqual(texts("uiautomator", "u.uia.xml", `<hierarchy><node bounds="[0,0][100,200]">${[
    un({ text: "T", cd: "C" }, "[0,0][50,10]"), un({ cd: "C", hint: "H" }, "[0,20][50,30]"), un({ hint: "H" }, "[0,40][50,50]"), un({ hintText: "H2" }, "[0,60][50,70]"),
  ].join("")}</node></hierarchy>`, img), [null, "T", "C", "H", "H2"]);
  // xcuitest: label, value, title; a TextField takes its value first.
  const xl = (t, attrs, y) => `      ${t}, 0x1, {{0.0, ${y}.0}, {50.0, 10.0}}${attrs}`;
  assert.deepEqual(texts("xcuitest", "x.txt", ["    Window (Main), 0x0, {{0.0, 0.0}, {100.0, 200.0}}",
    xl("Button", ", label: 'L', title: 'T'", 0), xl("Button", ", title: 'T'", 20), xl("Other", ", value: V", 40),
    xl("TextField", ", label: 'Mail', value: a@b.c", 60), xl("TextField", ", label: 'Mail'", 80)].join("\n")), ["L", "T", "V", "a@b.c", "Mail"]);
  // playwright: visible text, then aria-label; flat, so no leaf-only step.
  assert.deepEqual(texts("playwright", "p.json", { viewport: { width: 100, height: 200 }, elements: [
    { rect: { x: 0, y: 0, width: 50, height: 10 }, text: "T", ariaLabel: "A" }, { rect: { x: 0, y: 20, width: 50, height: 10 }, text: "", ariaLabel: "A" },
    { rect: { x: 0, y: 0, width: 100, height: 100 }, text: "T more" },
  ] }), ["T", "A", "T more"]);
  // Tree rules on raw elements: a duplicate within half a unit collapses; a joined label drops; the same label stays.
  const t = boxes.treeText([
    { x: 0, y: 0, w: 100, h: 50, text: "A, B", parent: -1 },
    { x: 0, y: 0, w: 50, h: 10, text: "A", parent: 0 }, { x: 0.4, y: 0, w: 50, h: 10, text: "A", parent: 1 },
    { x: 0, y: 20, w: 50, h: 10, text: "B", parent: 0 }, { x: 0, y: 20, w: 50, h: 12, text: "B", parent: 3 },
  ]);
  assert.deepEqual(t.map((r) => r.text), [null, "A", "B", "B"]);
  // D64: a displayed-text field keeps its string over labeled children (an Android paragraph with link spans).
  const para = boxes.treeText([
    { x: 0, y: 0, w: 100, h: 20, text: "By continuing you agree to our Terms.", shown: true, parent: -1 },
    { x: 60, y: 10, w: 30, h: 10, text: "Terms", parent: 0 },
  ]);
  assert.deepEqual(para.map((r) => r.text), ["By continuing you agree to our Terms.", "Terms"]);
});

test("playwright page script: visible text, aria-label fallback, and the capture guide prints the same code (D33, D39)", () => {
  const { collect } = require("../src/boxes/playwright-page");
  const src = (t) => /const collect = \(\) => \{[\s\S]*?\n\};/.exec(t)[0];
  const doc = fs.readFileSync(path.join(__dirname, "../../../docs/truncation-capture.md"), "utf8");
  assert.equal(src(doc), src(fs.readFileSync(require.resolve("../src/boxes/playwright-page"), "utf8")));
  const el = (o) => ({ id: o.id || "", tagName: o.tag || "DIV", nodeType: 1, parentElement: null, cs: o.cs || {}, childNodes: o.text ? [{ nodeType: 3, textContent: o.text }] : [], innerText: o.inner ?? "", textContent: o.text || "",
    matches: (sel) => (o.tag === "IMG" && sel.split(", ").includes("img")) || Boolean(o.role && sel.includes(`[role=${o.role}]`)), querySelector: () => (o.icon ? {} : null),
    getAttribute: (k) => (k === "aria-label" ? o.aria ?? null : null), getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }) });
  const g = globalThis;
  Object.assign(g, { document: { querySelectorAll: () => [el({ id: "a", text: "Weiter ", inner: "WEITER" }), el({ id: "b", aria: "Schließen" }), el({ id: "c" }),
    // TODO-046: a textless img and button are graphic leaves; a button with text or an icon inside is not.
    el({ id: "i", tag: "IMG" }), el({ id: "btn", tag: "BUTTON" }), el({ id: "btn2", tag: "BUTTON", inner: "OK" }), el({ id: "btn3", tag: "BUTTON", icon: true }),
    // TODO-049: a textless slider role is a graphic, one with an icon inside is not, a switch role is not (D13); an
    // opaque fixed bar is a panel (and fixed), a see-through one is not kept.
    el({ id: "sl", role: "slider" }), el({ id: "sl2", role: "slider", icon: true }), el({ id: "sw", role: "switch" }),
    el({ id: "bar", cs: { position: "fixed", backgroundColor: "rgb(255, 255, 255)" } }), el({ id: "glass", cs: { position: "fixed", backgroundColor: "rgba(0, 0, 0, 0.4)" } }),
    // D25: Chromium keeps an oklch() color as written (Tailwind v4); with no "/ alpha" it is opaque.
    el({ id: "ok", cs: { position: "sticky", backgroundColor: "oklch(0.967 0.003 264.542)" } }), el({ id: "ok2", cs: { position: "sticky", backgroundColor: "oklch(0.967 0.003 264.542 / 0.5)" } })] },
    getComputedStyle: (e) => ({ visibility: "visible", display: "block", overflowX: "hidden", textOverflow: "clip", position: "static", opacity: "1", backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", ...e.cs }), innerWidth: 100, innerHeight: 200, devicePixelRatio: 2 });
  try {
    const out = collect();
    // innerText follows CSS text-transform; an icon button with only aria-label is kept with empty text.
    assert.deepEqual(out.elements.map((e) => [e.id, e.text, e.ariaLabel, e.graphic ?? false, e.panel ?? false, e.fixed ?? false]),
      [["a", "WEITER", null, false, false, false], ["b", "", "Schließen", false, false, false], ["i", "", null, true, false, false], ["btn", "", null, true, false, false],
        ["sl", "", null, true, false, false], ["bar", "", null, false, true, true], ["ok", "", null, false, true, false]]);
    // D4: a page that can still scroll ahead makes what is not fixed reachable; at the scroll end it is not.
    const page = (top) => { g.document.scrollingElement = { scrollTop: top, clientHeight: 800, scrollHeight: 1600, scrollLeft: 0, clientWidth: 400, scrollWidth: 400 }; return collect().elements.filter((e) => e.scrolls).map((e) => e.id); };
    assert.deepEqual(page(0), ["a", "b", "i", "btn", "sl", "ok"]);
    assert.deepEqual(page(800), []);
  } finally {
    for (const k of ["document", "getComputedStyle", "innerWidth", "innerHeight", "devicePixelRatio"]) delete g[k];
  }
});

test("converters: errors name the fix (D27)", () => {
  const d = dir();
  usage(() => boxes.convert("xcuitst", "d.txt", null), "unknown-source", "catscan: unknown-source: unknown boxes source xcuitst; did you mean xcuitest? - try: catscan boxes xcuitest, uiautomator, maestro or playwright <dump>");
  const uia = path.join(F, "shop.uia.xml");
  usage(() => boxes.convert("uiautomator", uia, null), "missing-image", `catscan: missing-image: uiautomator dumps are in screen pixels; --image is needed to normalize them - try: catscan boxes uiautomator ${uia} --image ${uia.replace(/\.uia\.xml$/, "")}.png`);
  const notXml = write(d, "x.uia.xml", "<foo/>");
  usage(() => boxes.convert("uiautomator", notXml, write(d, "s.png", png(10, 10))), "invalid-dump", `catscan: invalid-dump: ${notXml} is not a uiautomator dump: no <hierarchy> root - try: docs/truncation-capture.md shows how to save it`);
  usage(() => boxes.convert("xcuitest", write(d, "x.txt", "nothing"), null), "invalid-dump");
  usage(() => boxes.convert("maestro", write(d, "m.json", "{}"), null), "invalid-dump");
  usage(() => boxes.convert("playwright", write(d, "p.json", "{}"), null), "invalid-dump");
  usage(() => boxes.convert("xcuitest", path.join(d, "none.txt"), null), "invalid-dump");
  usage(() => boxes.convert("uiautomator", uia, write(d, "t.txt", "text")), "missing-image");
  const empty = boxes.convert("maestro", write(d, "e.json", JSON.stringify({ attributes: { bounds: "[0,0][10,10]" }, children: [{ attributes: { bounds: "[0,0][5,5]" } }] })), null);
  assert.equal(render.diagnosticLine(empty.warnings[0]), `catscan: dump-no-text: ${path.join(d, "e.json")} has no element with displayed text; the boxes file has no text to compare - try: capture after the screen has settled`);
});

test("imageSize: PNG and JPEG headers", () => {
  const d = dir();
  assert.deepEqual(boxes.imageSize(write(d, "a.png", png(1179, 2556))), { width: 1179, height: 2556 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x09, 0x60, 0x04, 0x38, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(boxes.imageSize(write(d, "a.jpg", jpg)), { width: 1080, height: 2400 });
});

test("render: one line per truncated finding with reason, element and expected (D34)", () => {
  const env = { verdict: "fail", path: "de/shop.png", command: "truncated", checks: [], findings: [
    { kind: "truncated", reason: "edge", line: "Einstellun", box: [0.1, 0.2, 0.3, 0.02], element: { id: "title", box: [0.1, 0.19, 0.3, 0.04] }, expected: "Einstellungen", confidence: 0.9 },
    { kind: "truncated", reason: "screen-edge", line: "Weit", box: [0.9, 0.5, 0.1, 0.02], element: null, expected: null, confidence: 0.8 },
  ] };
  assert.deepEqual(render.renderText(env), [
    "FAIL  de/shop.png",
    '  truncated (edge) "Einstellun" at [0.1, 0.2, 0.3, 0.02] in title [0.1, 0.19, 0.3, 0.04], expected "Einstellungen"',
    '  truncated (screen-edge) "Weit" at [0.9, 0.5, 0.1, 0.02]',
  ]);
});

test("schema: a truncated finding missing a D22 field, or with an unknown reason, fails validation", () => {
  // Value: protects=the D22 result.schema.json contract for truncated findings (reason, line, element, expected, confidence); fails_when=a field leaves the truncated "required" list or the reason enum widens; why_new=test/truncated.test.js validates only conforming output; seam=none; no_claim=that the core emits these fields (TruncationTests and test/truncated.test.js do)
  const Ajv = require("ajv");
  const validate = new Ajv({ allErrors: true, strict: false }).compile(require("../../../core/schema/result.schema.json"));
  const host = { chip: "c", arch: "arm64", host_class: "physical", macos: "27.2 (26B123)", vision_revision: 3 };
  const finding = { kind: "truncated", box: [0.1, 0.2, 0.3, 0.02], line: "Einstellun", reason: "edge", element: { id: "title", box: [0.1, 0.19, 0.3, 0.04] }, expected: "Einstellungen", confidence: 0.9 };
  const env = (f) => ({
    schema: 1, catscan: "0.8.0", command: "truncated", path: "de/shop.png", verdict: "fail", engine: "vision-accurate-rev3", locale: "de",
    image: { width: 1179, height: 2556 }, screen: null, host, ms: 1, checks: [], findings: [f], warnings: [],
  });
  assert.ok(validate(env(finding)), JSON.stringify(validate.errors));
  assert.ok(validate(env({ ...finding, element: null, expected: null })), JSON.stringify(validate.errors));
  for (const k of ["reason", "line", "element", "expected", "confidence"]) {
    const { [k]: _, ...broken } = finding;
    assert.equal(validate(env(broken)), false, `truncated without ${k}`);
  }
  assert.equal(validate(env({ ...finding, reason: "overflw" })), false, "unknown reason");
});

test("help: truncated and boxes are listed with examples (D34)", () => {
  assert.match(SHORT_USAGE, /catscan truncated shots\/de --locale de --boxes shots\/de/);
  assert.match(SHORT_USAGE, /catscan boxes xcuitest shop\.xcui\.txt > shop\.boxes\.json/);
  assert.match(HELP, /--reasons <list>/);
  assert.match(HELP, /--image <png>/);
});

// TODO-036 check 1 (T1): the overflow reason through every Node output.
const OVERFLOW_ENV = { verdict: "fail", path: "de/paywall.png", command: "truncated", checks: [], findings: [
  { kind: "truncated", reason: "overflow", line: "Jetzt kostenlos testen", box: [0.1, 0.5, 0.6, 0.02], element: { id: "settings-cta", box: [0.08, 0.49, 0.45, 0.04] }, expected: "Jetzt kostenlos testen", confidence: 0.9, overflow: 1.4 },
] };

test("overflow: reason list, text line, schema, report style and CI outputs", () => {
  // Value: protects=TODO-036 T1 surface (--reasons overflow, D34-style text, schema per-reason field, dashed orange report style, JUnit/Code Quality/GitHub); fails_when=a layer drops or misnames the new reason or its overflow field; why_new=new reason; seam=none; no_claim=the rule (OverflowTests) or Vision (test/truncated.test.js)
  assert.deepEqual(truncated.parseReasons("overflow,edge"), ["overflow", "edge"]);
  assert.deepEqual(truncated.REASONS, ["ellipsis", "prefix", "edge", "overflow", "screen-edge", "pseudo-cut"]);
  assert.deepEqual(render.renderText(OVERFLOW_ENV), [
    "FAIL  de/paywall.png",
    '  truncated (overflow) "Jetzt kostenlos testen" at [0.1, 0.5, 0.6, 0.02] past settings-cta [0.08, 0.49, 0.45, 0.04] by 1.4 line heights',
  ]);
  const Ajv = require("ajv");
  const schema = require("../../../core/schema/result.schema.json");
  const ajv = new Ajv({ allErrors: true, strict: false }).addSchema(schema, "result");
  const validate = ajv.getSchema("result#/definitions/finding");
  const f = OVERFLOW_ENV.findings[0];
  assert.ok(validate(f), JSON.stringify(validate.errors));
  const { overflow, ...noAmount } = f;
  assert.equal(validate(noAmount), false, "an overflow finding needs its overflow amount");
  assert.equal(validate({ ...f, element: null }), false, "an overflow finding names its element");
  const overlay = require("../src/report/overlay");
  const [s] = overlay.shapes(OVERFLOW_ENV);
  assert.deepEqual([s.style, s.label], ["truncated-overflow", "truncated (overflow)"]);
  assert.equal(overlay.STYLES["truncated-overflow"].color, overlay.STYLES.truncated.color);
  assert.match(overlay.svg(OVERFLOW_ENV), /stroke="#d4700a" stroke-width="3" stroke-dasharray="8 5"/);
  assert.equal(overlay.shapes({ findings: [{ ...f, reason: "edge" }] })[0].style, "truncated");
  const ci = require("../src/ci");
  assert.match(ci.junit([OVERFLOW_ENV]), /<failure type="truncated" message="truncated \(overflow\) &quot;Jetzt kostenlos testen&quot; at .* by 1\.4 line heights"/);
  assert.match(ci.githubLines([OVERFLOW_ENV])[0], /^::error file=de\/paywall.png,title=catscan truncated%3A fail::truncated \(overflow\) .* by 1\.4 line heights/);
  assert.equal(ci.codequality([OVERFLOW_ENV])[0].check_name, "catscan/truncated");
});

test("overflow synthetic set: cases per string, centered only with room, D68 negatives labeled fit (TODO-036, TODO-044)", () => {
  // Value: protects=the overflow gate's labels (bench/truncation.js); fails_when=a case is mislabeled, a too-short centered case returns (the generator then aborts) or the D68 negatives go; why_new=new set; seam=none; no_claim=what Vision reads
  // TODO-044 extension. Value: protects=the D3 cases' labels, the start/centered split and over-card-text's container holding another string; fails_when=a new case is mislabeled, left out of the split or its containerText holds the label (then it is the D5 gap, not a positive); why_new=the D3 cases had no label test; seam=none; no_claim=what Vision reads or generate.swift draws
  const set = require("../../../test/fixtures/truncation-set");
  const list = set.overflowShots(10);
  const by = (c) => list.filter((s) => s.case === c);
  assert.deepEqual(set.OVERFLOW_CASES.map((c) => [c.case, c.truncated]), [["over-clip", true], ["over-visible", true], ["over-center", true], ["overhang", false],
    ["over-card", true], ["over-card-text", true], ["over-icon", true], ["over-center-icon", true], ["overhang-card", false]]);
  assert.deepEqual([...set.START_CASES, ...set.CENTER_CASES].sort(), set.OVERFLOW_CASES.filter((c) => c.truncated).map((c) => c.case).sort());
  assert.equal(by("over-center-icon").length, 127);
  for (const s of by("over-card-text")) {
    const l = s.spec.lines[0];
    assert.ok(l.container && l.containerText && !l.containerText.includes(l.text) && !l.text.includes(l.containerText), s.name);
  }
  assert.ok(by("over-card").every((s) => s.spec.lines[0].container && s.spec.lines[0].containerText === undefined));
  assert.equal(by("over-clip").length, 130, "12 locales and ar x 10 strings");
  // 127: the count results/truncation.json was measured on (3 four-character zh-Hans labels lack room).
  assert.equal(by("over-center").length, 127);
  for (const c of set.OVERFLOW_CASES) for (const s of by(c.case)) assert.equal(s.truncated, c.truncated, s.name);
  assert.deepEqual(by("d68").map((s) => [s.locale, s.truncated, s.spec.lines[0].over]), [["el", false, 0.42], ["el", false, 0.63], ["ja", false, 0.42], ["ja", false, 0.63]]);
  assert.ok(list.every((s) => s.mode === "overflow" && s.name.startsWith("overflow/")));
});

test("graphic: leaves only, from the Android class in uiautomator and maestro dumps; load rejects a non-boolean (TODO-046 T2)", () => {
  // Value: protects=containers never graphic and the maestro Android class rule; fails_when=leafGraphics or ANDROID_GRAPHIC is dropped, or graphic: "yes" loads; why_new=no fixture has a graphic parent or a maestro class; seam=none; no_claim=real dumps
  const d = dir();
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node text="" resource-id="root" class="android.widget.FrameLayout" content-desc="" bounds="[0,0][100,200]"><node text="" resource-id="frame" class="android.widget.ImageButton" content-desc="" bounds="[0,0][100,100]"><node text="" resource-id="icon" class="android.widget.ImageView" content-desc="" bounds="[10,10][50,50]" /></node></node></hierarchy>`;
  const u = boxes.convert("uiautomator", write(d, "g.uia.xml", xml), write(d, "g.png", png(100, 200))).boxes;
  assert.deepEqual(u.elements.filter((e) => e.graphic).map((e) => e.id), ["icon"]);
  const maestro = { attributes: { bounds: "[0,0][100,200]" }, children: [{ attributes: { "resource-id": "frame", class: "android.widget.ImageButton", bounds: "[0,0][100,100]" }, children: [{ attributes: { "resource-id": "icon", class: "android.widget.ImageView", bounds: "[10,10][50,50]" }, children: [] }] }] };
  const m = boxes.convert("maestro", write(d, "g.maestro.json", JSON.stringify(maestro)), write(d, "m.png", png(100, 200))).boxes;
  assert.deepEqual(m.elements.filter((e) => e.graphic).map((e) => e.id), ["icon"]);
  const f = write(d, "bad.boxes.json", JSON.stringify({ image: { width: 1, height: 1 }, elements: [{ box: [0, 0, 1, 1], graphic: "yes" }] }));
  assert.throws(() => boxes.load(f), /elements\[0\]\.graphic must be true or false/);
});
