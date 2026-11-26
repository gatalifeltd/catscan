// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 13 D5, D15: element boxes for toHaveNoTruncation from the spec 06 page script. The locator and fullPage
// transforms act on the raw `collect` output (CSS pixels) before core-js `boxes.convert` normalizes it.
const fs = require("fs");
const { collect } = require("@catscan/core-js/src/boxes/playwright-page");
const coreBoxes = require("@catscan/core-js/src/boxes");

/** Page side, run next to `collect` for fullPage: the scroll offset (`collect` marks fixed elements, TODO-049 D9). */
const pageExtra = () => ({ scrollX, scrollY });

/** Page side: viewport rects of canvas, video and iframe regions, whose text the page script cannot box (D5). */
const mediaRects = () => [...document.querySelectorAll("canvas, video, iframe, embed, object")]
  .filter((el) => getComputedStyle(el).visibility !== "hidden")
  .map((el) => el.getBoundingClientRect()).filter((r) => r.width >= 8 && r.height >= 8) // not a tracking pixel
  .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));

const r2 = (v) => Math.round(v * 100) / 100;
const key = (c) => JSON.stringify((c && c.elements ? c.elements : []).map((e) => [e.text, e.ariaLabel, e.graphic === true, r2(e.rect.x), r2(e.rect.y), r2(e.rect.width), r2(e.rect.height)]));

/** D15: two `collect` results agree when every element and rect is the same (to 0.01 CSS px). */
function sameRects(a, b) {
  return key(a) === key(b) && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height;
}

const intersects = (r, b) => r.x < b.x + b.width && r.x + r.width > b.x && r.y < b.y + b.height && r.y + r.height > b.y;

/** Locator screenshot: elements inside `box` (locator.boundingBox(), read after the screenshot), shifted to its origin. */
function forLocator(c, box) {
  const elements = c.elements.filter((e) => intersects(e.rect, box))
    .map((e) => ({ ...e, rect: { ...e.rect, x: e.rect.x - box.x, y: e.rect.y - box.y } }));
  return { ...c, viewport: { width: box.width, height: box.height }, elements };
}

/** Drops every element whose rect covers a canvas, video or iframe region (half a CSS pixel of slack). */
function dropMedia(c, media) {
  const covers = (r, m) => r.x <= m.x + 0.5 && r.y <= m.y + 0.5 && r.x + r.width >= m.x + m.width - 0.5 && r.y + r.height >= m.y + m.height - 0.5;
  return { ...c, elements: c.elements.filter((e) => !media.some((m) => covers(e.rect, m))) };
}

/**
 * fullPage screenshot: each rect moves by the scroll offset, except a fixed element (`collect` marks it), and the extent is
 * the document as captured (the image size over the device pixel ratio, which is the document's scroll size).
 */
function forFullPage(c, extra, extent) {
  const elements = c.elements.map((e) => (e.fixed ? e : { ...e, rect: { ...e.rect, x: e.rect.x + extra.scrollX, y: e.rect.y + extra.scrollY } }));
  return { ...c, viewport: { width: extent.width, height: extent.height }, elements };
}

/** Writes the transformed dump next to the screenshot and converts it with the screenshot as the image. */
function build(dump, dumpFile, imageFile) {
  fs.writeFileSync(dumpFile, JSON.stringify(dump));
  return coreBoxes.convert("playwright", dumpFile, imageFile);
}

module.exports = { collect, pageExtra, mediaRects, sameRects, dropMedia, forLocator, forFullPage, build, imageSize: coreBoxes.imageSize };
