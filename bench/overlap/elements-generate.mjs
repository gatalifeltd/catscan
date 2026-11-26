// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-046 synthetic DOM set: a pair of a label over a label (vertical or one row) or a label over a graphic (icon or
// image), drawn by Playwright Chromium with a controlled ink overlap and padded element frames, plus distractor labels
// (TODO-049 adds a label running into a control, and a label cut off by an opaque fixed panel),
// and an icon far from the pair. Each screen saves the PNG, the page-script dump (`collect`, spec 06 D33) and its
// `catscan boxes playwright` conversion. Labeled by construction: ink rects are the text's Range client rects and the
// graphic leaf's box, in CSS px (D5 of spec 12: the typographic box).
// Usage: node bench/overlap/elements-generate.mjs <plan.json> <outdir>  (prints {images: [...], tools: {...}})
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const { collect } = require("../../packages/core-js/src/boxes/playwright-page");
const boxes = require("../../packages/core-js/src/boxes");
const { chromiumArgs } = require("../../packages/playwright/test/chromium-gpu.js");

const VIEW = { width: 390, height: 700 };
const CONTROL_KINDS = ["switch", "checkbox", "slider", "field", "select"];
const PATH = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v6h-2V7zm0 8v2h-2v-2z";
const svg = (id, side) => `<svg${id ? ` id="${id}"` : ""} width="${side}" height="${side}" viewBox="0 0 24 24"><path fill="#2f6fd6" d="${PATH}"/></svg>`;
const PICTURE = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9b44c"/><stop offset="1" stop-color="#3d7a9e"/></linearGradient></defs><rect width="160" height="100" fill="url(#g)"/><circle cx="120" cy="30" r="14" fill="#fff3"/></svg>`);

/** One screen: lays out the pair, measures ink, moves the second side into place, and returns the truth. */
async function screen(page, it) {
  const fg = it.theme === "dark" ? "#f2f2f7" : "#111", bg = it.theme === "dark" ? "#1c1c1e" : "#fff";
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const label = (id, text, pad) => `<span id="${id}" style="position:absolute;left:0;top:0;padding:${pad}px;font-size:${it.size}px;line-height:1.25;white-space:nowrap;color:${fg}">${esc(text)}</span>`;
  // An icon is a bare svg or sits in a padded textless button (a touch target); the svg is the drawn leaf either way.
  // TODO-049 D13: controls drawn with a visible border or fill at their box edge, so the box is the ink.
  const CONTROLS = {
    switch: `<div id="g" role="switch" aria-checked="true" style="position:absolute;left:0;top:0;width:51px;height:31px;border-radius:16px;background:#34c759"></div>`,
    checkbox: `<input id="g" type="checkbox" checked style="position:absolute;left:0;top:0;margin:0;width:24px;height:24px;accent-color:#2f6fd6">`,
    slider: `<input id="g" type="range" value="60" style="position:absolute;left:0;top:0;margin:0;width:160px;height:24px;accent-color:#2f6fd6">`,
    field: `<input id="g" type="text" value="" style="position:absolute;left:0;top:0;margin:0;width:180px;height:36px;box-sizing:border-box;border:2px solid #8a8f98;border-radius:6px;background:${bg}">`,
    select: `<select id="g" style="position:absolute;left:0;top:0;margin:0;width:150px;height:36px;box-sizing:border-box;border:2px solid #8a8f98;border-radius:6px;background:${bg};color:${fg};font-size:15px"><option>Option</option></select>`,
  };
  // TODO-049 D6: an opaque fixed panel (a bottom bar, a toast on the right, a keyboard-like sheet); variants: the label
  // drawn above it, or inside a scroll container that can still scroll (both negatives).
  const PANELS = { footer: "left:0;bottom:0;width:390px;height:72px", toast: "right:0;top:300px;width:170px;height:56px;border-radius:8px 0 0 8px", sheet: "left:0;bottom:0;width:390px;height:260px" };
  const panel = it.layout === "panel" ? `<div id="p" style="position:fixed;${PANELS[it.panel]};background:${it.theme === "dark" ? "#3a3a3c" : "#e5e5ea"};z-index:5"></div>` : "";
  const g = CONTROLS[it.layout] ? CONTROLS[it.layout] : it.layout === "icon"
    ? (it.button
      ? `<button id="gb" style="position:absolute;left:0;top:0;padding:${it.padG}px;border:0;background:none;line-height:0">${svg("g", it.icon)}</button>`
      : `<span id="gw" style="position:absolute;left:0;top:0;line-height:0">${svg("g", it.icon)}</span>`)
    : it.layout === "image" ? `<img id="g" src="${PICTURE}" width="160" height="100" alt="" style="position:absolute;left:0;top:0">` : "";
  const html = `<!doctype html><html lang="${it.locale}"><head><meta charset="utf-8"><style>body{margin:0;background:${bg};font-family:system-ui,-apple-system,sans-serif}</style></head><body>
${it.layout === "panel" && it.variant === "scroll" ? `<div id="sc" style="position:absolute;left:0;top:0;width:390px;height:700px;overflow:auto"><div style="position:relative;height:1400px">${label("a", it.a, it.padA)}</div></div>` : label("a", it.a, it.padA)}${it.layout === "vv" || it.layout === "row" ? label("b", it.b, it.padB) : it.layout === "panel" ? panel : g}
${it.distractors.map((d, i) => label(`d${i}`, d, it.padA)).join("")}
<span style="position:absolute;left:340px;top:30px;line-height:0">${svg(null, 24)}</span>
</body></html>`;
  await page.setContent(html, { waitUntil: "load" });
  return page.evaluate((it) => {
    const ink = (el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const rs = [...r.getClientRects()];
      const x0 = Math.min(...rs.map((q) => q.left)), y0 = Math.min(...rs.map((q) => q.top));
      return { x: x0, y: y0, w: Math.max(...rs.map((q) => q.right)) - x0, h: Math.max(...rs.map((q) => q.bottom)) - y0 };
    };
    const at = (el, x, y) => { el.style.left = `${x}px`; el.style.top = `${y}px`; };
    // Moves an element so that its measured inner rect `of` lands with its top left at (x, y).
    const place = (el, of, x, y) => { const r = of(); const b = el.getBoundingClientRect(); at(el, x - (r.x - b.x), y - (r.y - b.y)); };
    const A = document.getElementById("a");
    const inkA = () => ink(A);
    // Distractors: one per row, far from the pair (the pair lives between 220 and 470 CSS px).
    [40, 120, 560].forEach((y, i) => { const d = document.getElementById(`d${i}`); if (d) at(d, 16 + (i % 2) * 24, y); });
    let other, otherInk;
    const amount = it.amount;
    if (it.layout === "vv" || it.layout === "row") {
      const B = document.getElementById("b");
      other = B;
      otherInk = () => ink(B);
      if (it.layout === "vv") {
        place(A, inkA, 20, 260);
        const a = inkA();
        place(B, otherInk, a.x + it.shift * a.w, a.y + a.h - amount);
      } else {
        const a0 = inkA(), b0 = otherInk();
        place(A, inkA, Math.max(8, (390 - (a0.w + b0.w - amount)) / 2), 300);
        const a = inkA();
        place(B, otherInk, a.x + a.w - amount, a.y);
      }
    } else if (it.layout === "panel") {
      // The label's ink runs `amount` px under the panel's edge: up into a bottom panel, right into the toast.
      const P = document.getElementById("p");
      other = P;
      otherInk = () => { const r = P.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      if (it.variant === "top") { A.style.zIndex = "9"; A.style.position = "absolute"; }
      const p = otherInk(), a0 = inkA();
      if (it.amount === "full") place(A, inkA, it.panel === "toast" ? p.x + 8 : 20, it.panel === "toast" ? p.y + p.h / 2 - a0.h / 2 : p.y + 10);
      else if (it.panel === "toast") place(A, inkA, Math.max(8, p.x + it.amount - a0.w), p.y + p.h / 2 - a0.h / 2);
      else place(A, inkA, 20, p.y + it.amount - a0.h);
    } else {
      const G = document.getElementById("g");
      const wrap = document.getElementById("gb") || document.getElementById("gw") || G;
      other = G;
      otherInk = () => { const r = G.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      place(wrap, otherInk, it.layout === "image" ? 150 : it.layout === "slider" || it.layout === "field" || it.layout === "select" ? 200 : 250, 300);
      const g = otherInk();
      const a0 = inkA();
      // The label runs into the graphic from the left (h) or reaches down onto its top edge (v).
      if (it.axis === "h") place(A, inkA, g.x + amount - a0.w, g.y + g.h / 2 - a0.h / 2);
      else place(A, inkA, Math.min(g.x + g.w / 2, 380 - a0.w), g.y + amount - a0.h);
    }
    const a = inkA(), b = otherInk();
    // A panel spans the viewport's edge by design; only the label must fit (TODO-049).
    const skipped = a.x < 2 || a.x + a.w > 388 || (it.layout !== "panel" && (b.x < 2 || b.x + b.w > 388)) ? "pair wider than the viewport" : null;
    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return { ink: { a: [a.x, a.y, a.w, a.h], b: [b.x, b.y, b.w, b.h] }, inter: [ix, iy], b_id: other.id, skipped };
  }, it);
}

export async function generate(items, dir) {
  const browser = await chromium.launch({ args: chromiumArgs() });
  const tools = { playwright: require("@playwright/test/package.json").version, chromium: browser.version(), chromium_args: chromiumArgs() };
  const images = [];
  try {
    for (const dpr of [...new Set(items.map((i) => i.dpr))].sort()) {
      const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: dpr });
      const page = await ctx.newPage();
      for (const it of items.filter((i) => i.dpr === dpr)) {
        const t = await screen(page, it);
        const png = path.join(dir, it.name);
        fs.mkdirSync(path.dirname(png), { recursive: true });
        await page.screenshot({ path: png });
        const dump = await page.evaluate(collect);
        // TODO-049 D13: the rule is measured per control kind whether or not the page script marks that kind (only the
        // kinds that pass ship in the converters), so the control is marked here, as a game export would.
        if (CONTROL_KINDS.includes(it.layout)) {
          dump.elements = dump.elements.filter((e) => e.id !== "g");
          const rect = await page.evaluate(() => { const r = document.getElementById("g").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
          dump.elements.push({ id: "g", rect, text: "", ariaLabel: null, overflow: "visible", textOverflow: "clip", graphic: true });
        }
        const stem = png.replace(/\.png$/, "");
        fs.writeFileSync(`${stem}.pw.json`, JSON.stringify(dump));
        const { boxes: b } = boxes.convert("playwright", `${stem}.pw.json`, png);
        fs.writeFileSync(`${stem}.boxes.json`, JSON.stringify(b));
        images.push({ name: it.name, width: VIEW.width * dpr, height: VIEW.height * dpr, dpr, ...t });
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return { images, tools };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [planFile, dir] = process.argv.slice(2);
  const out = await generate(JSON.parse(fs.readFileSync(planFile, "utf8")), dir);
  process.stdout.write(JSON.stringify(out) + "\n");
}
