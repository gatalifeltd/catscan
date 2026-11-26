// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// The `playwright` converter's page script (spec 06 D33, D39; spec 13 reuses it). `innerText` is the visible text;
// `ariaLabel` is the fallback for elements with no own text node. TODO-046: textless drawn leaves (img, svg, picture,
// image-like inputs, role=img, a button with no text or drawn leaf inside) are kept with `graphic: true`; TODO-049 adds
// fields and sliders, `panel`, `scrolls` and `fixed`. Run it with
// `page.evaluate(collect)` right after `page.screenshot()` of the viewport; save the result as <screen>.pw.json.
// docs/truncation-capture.md prints the same code.

const collect = () => {
  const out = [];
  // Fields and sliders (the control kinds that passed their gate) draw a box of their own; a slider
  // role counts when no text or drawn leaf is inside.
  const drawn = "img, svg, picture, input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, [role=img]";
  const roles = "[role=slider]";
  // An opaque fixed or sticky surface is a panel; a scroll container that can still scroll makes
  // what is inside it reachable (`scrolls`); `fixed` (it or an ancestor is position: fixed) is for fullPage.
  // Chromium keeps oklch(), lab() and color() as written: their alpha follows "/"; rgb() may use a fourth number.
  const alpha = (c) => {
    const m = /^(\w+)\(([^)]*)\)$/.exec((c || "").trim()); if (!m) return 0;
    const slash = m[2].split("/"); if (slash.length > 1) return parseFloat(slash[1]) / (slash[1].includes("%") ? 100 : 1);
    const p = m[2].split(/[,\s]+/).filter(Boolean); return /^rgba?$/.test(m[1]) && p.length > 3 ? Number(p[3]) : 1;
  };
  // Room ahead only: at the scroll end a hidden label is unreachable, so it counts.
  const room = (a) => a.scrollTop + a.clientHeight < a.scrollHeight - 1 || a.scrollLeft + a.clientWidth < a.scrollWidth - 1;
  for (const el of document.querySelectorAll("body *")) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const ariaLabel = el.getAttribute("aria-label");
    const bare = !(el.innerText || "").trim() && !el.querySelector(drawn);
    const graphic = el.matches(drawn) || (el.tagName === "BUTTON" && bare) || (el.matches(roles) && bare);
    // Tappable elements, for fit's textless controls (icon buttons).
    const control = el.matches("button, a[href], input, select, [role=button], [role=tab], [role=link]");
    const cs = getComputedStyle(el);
    let fixed = false, ancestorOpacity = 1, scrolls = false;
    for (let a = el; a && a !== document.body && a.nodeType === 1; a = a.parentElement) {
      const s = a === el ? cs : getComputedStyle(a);
      if (s.position === "fixed") fixed = true;
      ancestorOpacity *= Number(s.opacity ?? 1);
      if (a !== el && /(auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`) && room(a)) scrolls = true;
    }
    const panel = (cs.position === "fixed" || cs.position === "sticky") && ancestorOpacity >= 1 && ((cs.backgroundImage && cs.backgroundImage !== "none") || alpha(cs.backgroundColor) >= 1);
    // The page itself scrolls what is not fixed (or in a fixed or sticky panel).
    const se = document.scrollingElement;
    if (!fixed && se && room(se)) scrolls = true;
    if (!own && !ariaLabel && !graphic && !panel && !control) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none") continue;
    out.push({
      id: el.id || el.getAttribute("data-testid") || null,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      text: own ? (el.innerText ?? el.textContent).trim() : "", ariaLabel,
      overflow: cs.overflowX, textOverflow: cs.textOverflow,
      ...(graphic ? { graphic: true } : {}), ...(panel ? { panel: true } : {}), ...(scrolls ? { scrolls: true } : {}), ...(fixed ? { fixed: true } : {}), ...(control ? { control: true } : {}),
    });
  }
  return { viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, elements: out };
};

module.exports = { collect };
