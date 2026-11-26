// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// The report page script. Inlined by report/index.js after overlay.js, inside one function scope.
// Every dynamic string goes in with textContent or an attribute, never parsed as markup: the data is screen text, file names
// and catalog values, any of which can hold markup.
var data = JSON.parse(document.getElementById("catscan-data").textContent);
var app = document.getElementById("app");
var SVGNS = "http://www.w3.org/2000/svg";

function el(tag, attrs, kids) {
  var e = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (k === "text") e.textContent = attrs[k];
    else if (k === "cls") e.className = attrs[k];
    else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return e;
}
function badge(v) { return el("span", { cls: "badge v-" + v, text: v }); }
// Why a cell needs review, one phrase per `reason` code of baseline.cells[].
var REASONS = { changed: "text changed", "new": "new cell", ambiguous: "inputs do not pair one to one", failing: "a check fails",
  "baseline-incomplete": "baseline approved incomplete", "no-text": "no text read on one side", "engine-unmeasured": "engine without a measured gate",
  "reader-changed": "reader changed since the baseline", "baseline-ignore-changed": "different --baseline-ignore file", "baseline-unapproved": "baseline not approved" };
var BL = data.baseline;
function cellOf(k) { return BL && k !== null && k !== undefined ? BL.cells[k] : null; }
function reviewText(c) { return c ? (c.review ? "needs review: " + (REASONS[c.reason] || c.reason) : "skippable: text unchanged and passing") : "needs review: not compared"; }
// The change mark: a dot for changed, a badge for new and ambiguous, nothing for unchanged (dimmed when skippable).
function changeMarks(c) {
  if (!c) return [];
  var out = [];
  if (c.state === "changed") out.push(el("span", { cls: "chg", "data-change": "changed", role: "img", "aria-label": "text changed", title: "text changed", text: "\u25cf" }));
  if (c.state === "new" || c.state === "ambiguous") out.push(el("span", { cls: "tag t-" + c.state, "data-change": c.state, text: c.state }));
  if (c.minor_diff) out.push(el("span", { cls: "tag", "data-change": "minor", text: "minor OCR difference" }));
  return out;
}
var reviewOnly = !!BL; // the "needs review" filter is on by default with a baseline
function quote(a) { return /^[\w@%+=:,./{}-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'"; }

// ---- image with boxes ------------------------------------------------------------------------------------
function shot(image, env, t) {
  var img = image || { width: 9, height: 19.5, blob: null, url: null };
  var box = el("div", { cls: "shot" });
  box.style.aspectRatio = img.width + " / " + img.height;
  var src = img.blob !== null && img.blob !== undefined ? data.blobs[img.blob] : img.url;
  if (src) box.appendChild(el("img", { src: src, alt: "", loading: "lazy" }));
  else box.appendChild(el("div", { cls: "ph", text: "image not found" }));
  var svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "none");
  overlay.shapes(env).forEach(function (s) {
    if (!s.style) return;
    if (t !== undefined && t !== null && s.t !== t) return;
    var st = data.styles[s.style];
    s.boxes.forEach(function (b) {
      var r = document.createElementNS(SVGNS, "rect");
      r.setAttribute("data-ref", s.ref);
      r.setAttribute("x", b[0] * 1000); r.setAttribute("y", b[1] * 1000);
      r.setAttribute("width", b[2] * 1000); r.setAttribute("height", b[3] * 1000);
      r.setAttribute("fill", "none"); r.setAttribute("stroke", st.color); r.setAttribute("stroke-width", "3");
      r.setAttribute("vector-effect", "non-scaling-stroke");
      if (st.dash) r.setAttribute("stroke-dasharray", "8 5");
      var title = document.createElementNS(SVGNS, "title");
      title.textContent = s.label + (s.llm ? " (LLM)" : "") + (s.text ? ": " + s.text : "");
      r.appendChild(title);
      svg.appendChild(r);
    });
  });
  box.appendChild(svg);
  return box;
}

// ---- header ------------------------------------------------------------------------------------------------
function header() {
  var run = data.run;
  var theme = el("button", { type: "button", id: "theme", text: "Theme", "aria-label": "Switch light and dark theme", onclick: function () {
    var root = document.documentElement;
    var dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
  } });
  var lines = [
    "catscan " + run.catscan + (run.host ? " on macOS " + run.host.macos : "") + ", started " + run.started_at,
    "command: catscan " + (run.argv || []).map(quote).join(" "),
  ];
  if (run.build) lines.push("build: " + [run.build.id, run.build.version].filter(Boolean).join(" "));
  // One device looks as without the axis, with the device named here.
  var devs = data.matrix.devices || [];
  if (devs.length === 1) lines.push("device: " + devs[0].device + (devs[0].platform ? " (" + devs[0].platform + ")" : ""));
  var sizes = data.matrix.textSizes || [];
  if (sizes.length === 1) lines.push("text size: " + sizes[0]);
  if (run.ci) lines.push("CI: " + [run.ci.provider, run.ci.runner, run.ci.ref, run.ci.commit, run.ci.run_id].filter(Boolean).join(", "));
  (run.shards || []).forEach(function (s, i) {
    lines.push("shard " + (i + 1) + ": " + [s.host ? "macOS " + s.host.macos : "no host", s.ci ? s.ci.runner || s.ci.provider : "local", s.started_at].join(", "));
  });
  var t = data.totals;
  var bl = null;
  if (BL) {
    bl = el("div", { cls: "baseline", id: "baseline" }, [
      el("div", { cls: "summary", id: "baseline-summary", text: BL.summary }),
      el("div", { cls: "run", text: "text matches baseline (normalized), build " + (BL.build || "none") + ", approved " + (BL.approved ? BL.approved.slice(0, 10) : "never") + " (" + BL.file + ")" }),
      el("div", { cls: "run", text: "Text only: images, layout and colors are not compared, so an unchanged cell is text unchanged, not screen unchanged." }),
      el("div", { cls: "run", text: BL.review.skip + " of " + BL.review.denominator + " received cells skippable; excluded: " + BL.review.excluded.missing + " missing, " + BL.review.excluded.unmapped + " unmapped" }),
    ]);
  }
  return el("header", null, [
    el("div", { cls: "top" }, [el("h1", { text: "catscan report" }), theme]),
    el("div", { cls: "run" }, lines.map(function (l) { return el("div", { text: l }); })),
    el("div", { cls: "totals", id: "totals" }, [
      el("span", { text: data.inputs + " inputs" }), el("span", { text: data.checks + " checks" }),
      el("span", { text: t.pass + " pass" }), el("span", { text: t.fail + " fail" }),
      el("span", { text: (t["needs-reader"] || 0) + " needs-reader" }), el("span", { text: t.unsupported + " unsupported" }), el("span", { text: t.error + " error" }),
    ]),
    bl,
  ]);
}

// ---- matrix -------------------------------------------------------------------------------------------------
function matrixSection() {
  var m = data.matrix;
  var sec = el("section", { id: "matrix" }, [el("h2", { text: "Coverage" })]);
  if (BL) {
    var box = el("input", { type: "checkbox", id: "review-only", onchange: function () { reviewOnly = box.checked; applyReview(); drawGrid(); } });
    box.checked = reviewOnly;
    sec.appendChild(el("label", { cls: "review-toggle" }, [box, " Needs review only (" + BL.review.cells + " of " + BL.review.denominator + " cells; missing cells stay shown)"]));
  }
  if (!m.shown) sec.appendChild(el("p", { cls: "hint", text: m.hint }));
  else {
    var covLine = m.coverageLine ? el("p", { cls: "coverage", id: "coverage-line", text: m.coverageLine }) : null;
    // Several devices split each locale column into device sub-columns, with a device filter; several text sizes split
    // each device column into size sub-columns, in label order. One size looks as without the axis.
    var devs = m.devices || [];
    var sizes = m.textSizes || [];
    var multiDev = devs.length > 1, multiSize = sizes.length > 1;
    var multi = multiDev || multiSize;
    if (multiDev) sec.appendChild(deviceChips(devs, covLine, sizes.length || 1));
    if (covLine) sec.appendChild(covLine);
    var byKey = {};
    m.cells.forEach(function (c) { byKey[cellKey(c.device, c.text_size, c.locale, c.screen)] = c; });
    var cols = [];
    var devList = multiDev ? devs.map(function (d) { return d.device; }) : [devs.length ? devs[0].device : null];
    var sizeList = sizes.length ? sizes : [null];
    m.locales.forEach(function (l) {
      devList.forEach(function (d) { sizeList.forEach(function (t) { cols.push({ l: l, d: d, t: t }); }); });
    });
    var devAttr = function (col, attrs) { if (multiDev) attrs["data-device"] = col.d; if (multiSize) attrs["data-text-size"] = col.t; return attrs; };
    var head = [el("tr", null, [el("th", multi ? { rowspan: "2", text: "screen \\ locale" } : { text: "screen \\ locale" })].concat(m.locales.map(function (l) {
      return el("th", multi ? { scope: "colgroup", colspan: String(devList.length * sizeList.length), text: l } : { scope: "col", text: l });
    }), [el("th", multi ? { rowspan: "2", text: "failing" } : { text: "failing" })]))];
    var sub = function (c) { return [multiDev ? c.d : null, multiSize ? c.t : null].filter(Boolean).join(" "); };
    if (multi) head.push(el("tr", { cls: "devices" }, cols.map(function (c) { return el("th", devAttr(c, { scope: "col", text: sub(c) })); })));
    var colBad = cols.map(function () { return 0; });
    var rows = m.screens.map(function (s) {
      var bad = 0, badBy = {};
      var tds = cols.map(function (col, j) {
        var l = col.l, d = col.d, t = col.t;
        var pre = (multiDev ? d + " / " : "") + (multiSize ? t + " / " : "");
        var name = pre + l + " / " + s;
        var cellId = (multiDev ? d + "/" : "") + (multiSize ? t + "/" : "") + l + "/" + s;
        var c = byKey[cellKey(d, t, l, s)];
        if (!c) return el("td", devAttr(col, { cls: "empty" }));
        var bc = cellOf(c.change);
        if (c.state === "gone") return el("td", devAttr(col, { cls: "gone", "data-cell": cellId, "data-review": "false", title: name + ": only in the baseline" + (bc && bc.inputs[0] ? " (" + bc.inputs[0].baseline_path + ")" : ""), text: "gone" }));
        if (c.state !== "pass") { bad++; colBad[j]++; badBy[d] = (badBy[d] || 0) + 1; }
        var label = c.state + (c.state === "fail" && c.count ? " " + c.count : "");
        var extra = BL ? "; " + (bc ? bc.state + ", " : "") + reviewText(bc) + (bc && bc.renamed_from ? "; same text as gone screen " + bc.renamed_from : "") : "";
        var b = el("button", { type: "button", cls: "v-" + c.state + " s-" + c.state + (BL && !c.review ? " skip" : ""), "data-cell": cellId, title: name + ": " + label + (c.badges.length ? " (" + c.badges.join(", ") + ")" : "") + extra }, [label]);
        changeMarks(bc).forEach(function (x) { b.appendChild(x); });
        c.badges.forEach(function (x) { b.appendChild(el("span", { cls: "tag", text: x })); });
        if (c.severity) b.appendChild(el("span", { cls: "tag sev", text: c.severity }));
        if (c.items.length) b.addEventListener("click", function () { openView(c.items, 0); });
        return el("td", devAttr(col, BL ? { "data-review": String(c.review) } : {}), [b]);
      });
      // The row total follows the device filter (deviceChips reads data-bad).
      return el("tr", null, [el("th", { cls: "screen", scope: "row", text: s })].concat(tds, [el("td", multiDev ? { cls: "row-bad", "data-bad": JSON.stringify(badBy), text: String(bad) } : { text: String(bad) })]));
    });
    var foot = el("tr", null, [el("th", { text: "failing" })].concat(colBad.map(function (n, j) { return el("td", devAttr(cols[j], { text: String(n) })); }), [el("td")]));
    sec.appendChild(el("div", { cls: "matrix-wrap" }, [el("table", { cls: "matrix" }, [el("thead", null, head), el("tbody", null, rows), el("tfoot", null, [foot])])]));
  }
  if (m.missing.length) {
    sec.appendChild(el("h2", { text: "Missing (" + m.missing.length + ")" }));
    sec.appendChild(el("ul", { cls: "list", id: "missing" }, m.missing.map(function (x) { return el("li", { text: (x.device ? x.device + " / " : "") + (x.text_size ? x.text_size + " / " : "") + x.locale + " / " + x.screen + ": expected " + x.expected_path }); })));
  }
  if (m.unmapped.length) {
    sec.appendChild(el("h2", { text: "Unmapped (" + m.unmapped.length + ")" }));
    sec.appendChild(el("ul", { cls: "list", id: "unmapped" }, m.unmapped.map(function (i) {
      var e = data.results[i];
      return el("li", null, [badge(e.verdict), " ", el("a", { href: "#", text: e.path, onclick: function (ev) { ev.preventDefault(); openView([i], 0); } })]);
    })));
  }
  return sec;
}

function cellKey(d, t, l, s) { return (d || "") + "\u0000" + (t || "") + "\u0000" + l.toLowerCase() + "\u0000" + s; }

// The device filter: `all`, then each device; it filters the matrix, the contact sheet and the coverage line.
function deviceChips(devs, covLine, nSizes) {
  var chips = [];
  function chip(id, label) {
    var b = el("button", { type: "button", "data-device-filter": id, "aria-pressed": String(state.device === id), text: label, onclick: function () {
      state.device = id;
      chips.forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      document.querySelectorAll("#matrix [data-device]").forEach(function (n) { n.classList.toggle("dev-hide", !!id && n.getAttribute("data-device") !== id); });
      document.querySelectorAll("#matrix th[colspan]").forEach(function (n) { n.setAttribute("colspan", String((id ? 1 : devs.length) * nSizes)); });
      document.querySelectorAll("#matrix td.row-bad").forEach(function (n) {
        var by = JSON.parse(n.getAttribute("data-bad"));
        n.textContent = String(id ? by[id] || 0 : Object.keys(by).reduce(function (t, k) { return t + by[k]; }, 0));
      });
      if (covLine) covLine.textContent = id && data.matrix.coverageByDevice ? data.matrix.coverageByDevice[id] : data.matrix.coverageLine;
      drawGrid();
    } });
    chips.push(b);
    return b;
  }
  return el("div", { cls: "filters", id: "device-filter", role: "group", "aria-label": "Device" }, [chip("", "all")].concat(devs.map(function (d) { return chip(d.device, d.device); })));
}

// The "needs review" filter hides matrix cells and rows with nothing to review; missing cells stay (a coverage gap).
function applyReview() {
  document.querySelectorAll("#matrix td[data-review]").forEach(function (td) { td.classList.toggle("hide", reviewOnly && td.getAttribute("data-review") === "false"); });
  document.querySelectorAll("#matrix tbody tr").forEach(function (tr) {
    tr.hidden = reviewOnly && !tr.querySelector('td[data-review="true"]'); // a missing cell is always data-review="true"
  });
}

// ---- contact sheet -------------------------------------------------------------------------------------------
var state = { filter: "all", locale: "", query: "", sev: "", cert: "", device: "" };
var timer = null; // search redraws once typing pauses: a big run has thousands of cards
var grid, visible = [];
function matches(it) {
  if (it.video) return false;
  if (reviewOnly && it.review === false) return false;
  if (state.filter === "failed" && it.verdict === "pass") return false;
  if (state.filter === "known" && !it.known) return false; // inputs with approved known findings
  if (state.filter === "large-text" && !it.large_text) return false; // cells that fail only at a non-default size
  if (state.filter.slice(0, 5) === "kind:" && it.kinds.indexOf(state.filter.slice(5)) < 0) return false;
  if (state.locale && it.locale.toLowerCase() !== state.locale) return false; // locales fold case, as in the matrix
  if (state.device && it.device !== state.device) return false;
  if (state.sev && (it.severities || []).indexOf(state.sev) < 0) return false;
  if (state.cert && (it.certainties || []).indexOf(state.cert) < 0) return false;
  if (state.query && it.text.toLowerCase().indexOf(state.query.toLowerCase()) < 0) return false;
  return true;
}
// Rank: error inputs first, then by the worst gating item (severity, then certainty), then output order. A file
// without severities ranks as before: failed first.
function order(a, b) {
  var x = a.rank || [a.verdict === "pass" ? 2 : 0, 0, 0], y = b.rank || [b.verdict === "pass" ? 2 : 0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.i - b.i;
}
function drawGrid() {
  grid.textContent = "";
  visible = data.items.filter(matches).sort(order).map(function (it) { return it.i; });
  visible.forEach(function (i, n) {
    var it = itemOf(i);
    grid.appendChild(el("button", { type: "button", cls: "card", "data-path": it.path, onclick: function () { openView(visible, n); } }, [
      shot(it.image, data.results[i]), el("div", { cls: "name" }, [badge(it.verdict)].concat(changeMarks(cellOf(it.change)), [" ", it.path])),
    ]));
  });
  document.getElementById("shown").textContent = visible.length + " shown" + (reviewOnly ? " (needs review only)" : "");
}
function sheetSection() {
  var sec = el("section", { id: "sheet" }, [el("h2", { text: "Screenshots" })]);
  var buttons = [];
  function fbtn(id, label) {
    var b = el("button", { type: "button", "data-filter": id, "aria-pressed": String(state.filter === id), text: label, onclick: function () {
      state.filter = id; buttons.forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); drawGrid();
    } });
    buttons.push(b);
    return b;
  }
  var kinds = {}, locales = {};
  data.items.forEach(function (it) { if (it.video) return; it.kinds.forEach(function (k) { kinds[k] = 1; }); if (!locales[it.locale.toLowerCase()]) locales[it.locale.toLowerCase()] = it.locale; });
  var loc = el("select", { id: "locale", "aria-label": "Locale", onchange: function () { state.locale = loc.value; drawGrid(); } },
    [el("option", { value: "", text: "all locales" })].concat(Object.keys(locales).sort().map(function (l) { return el("option", { value: l, text: locales[l] }); })));
  function levelSelect(id, label, levels, key) {
    var s = el("select", { id: id, "aria-label": label, onchange: function () { state[key] = s.value; drawGrid(); } },
      [el("option", { value: "", text: "any " + label.toLowerCase() })].concat(levels.map(function (v) { return el("option", { value: v, text: v }); })));
    return s;
  }
  var sevSel = levelSelect("severity", "Severity", ["critical", "major", "minor"], "sev");
  var certSel = levelSelect("certainty", "Certainty", ["high", "medium", "low"], "cert");
  var q = el("input", { type: "search", id: "search", placeholder: "Search file names and text", "aria-label": "Search", oninput: function () { state.query = q.value; clearTimeout(timer); timer = setTimeout(drawGrid, 120); } });
  sec.appendChild(el("div", { cls: "filters" }, [fbtn("all", "All"), fbtn("failed", "Failed only")].concat(data.items.some(function (it) { return it.known; }) ? [fbtn("known", "Known")] : [], data.items.some(function (it) { return it.large_text; }) ? [fbtn("large-text", "Large text")] : [])
    .concat(Object.keys(kinds).sort().map(function (k) { return fbtn("kind:" + k, k); }), [loc, sevSel, certSel, q, el("span", { id: "shown" })])));
  grid = el("div", { cls: "grid", id: "grid" });
  sec.appendChild(grid);
  return sec;
}

// ---- video ---------------------------------------------------------------------------------------------------
function videoSection() {
  var vids = data.items.filter(function (it) { return it.video; });
  if (!vids.length) return null;
  return el("section", { id: "videos" }, [el("h2", { text: "Videos" })].concat(vids.map(function (it) {
    var tl = it.timeline, d = tl.duration || 1;
    var bar = el("div", { cls: "timeline", title: "0 to " + d + " s" }, tl.marks.map(function (m) {
      var x = el("span", { cls: "mark " + m.type, title: m.type + " " + m.t + " s" });
      x.style.left = Math.min(100, Math.max(0, (m.t / d) * 100)) + "%";
      return x;
    }));
    var frames = el("div", { cls: "frames" }, tl.frames.map(function (f) {
      return el("figure", null, [shot(f.image, data.results[it.i], f.t), el("figcaption", { text: f.t + " s" })]);
    }));
    return el("div", { cls: "video", "data-path": it.path }, [
      el("div", null, [badge(it.verdict), " ", el("a", { href: "#", text: it.path, onclick: function (ev) { ev.preventDefault(); openView([it.i], 0); } }), " (" + (tl.duration === null ? "?" : tl.duration) + " s)"]),
      bar, frames,
    ]);
  })));
}

// ---- image view ----------------------------------------------------------------------------------------------
var view, list = [], pos = 0, opener = null;
var byIndex = {};
data.items.forEach(function (it) { byIndex[it.i] = it; });
function itemOf(i) { return byIndex[i] || null; }
function openView(l, p) { opener = document.activeElement; list = l; pos = p; drawView(); view.hidden = false; view.querySelector(".close").focus(); }
// Focus goes back to the card or cell that opened the view, so a keyboard user keeps their place.
function closeView() { view.hidden = true; if (opener && opener.focus) opener.focus(); opener = null; }
function move(d) { if (!list.length) return; pos = (pos + d + list.length) % list.length; drawView(); }
// Up and down open the same command, screen and locale at the previous or next text size and device, in matrix order
// (sizes inside devices). Returns whether it moved, so the arrows still scroll the view when there is no twin.
function moveDevice(d) {
  var it = itemOf(list[pos]);
  var devs = (data.matrix.devices || []).map(function (x) { return x.device; });
  var sizes = data.matrix.textSizes || [];
  var order = [];
  (devs.length ? devs : [it ? it.device : null]).forEach(function (dv) { (sizes.length ? sizes : [it ? it.text_size : null]).forEach(function (t) { order.push([dv, t]); }); });
  var at = it ? order.map(function (x) { return x[0] + "\u0000" + x[1]; }).indexOf(it.device + "\u0000" + it.text_size) : -1;
  if (!it || it.screen === null || order.length < 2 || at < 0) return false;
  for (var k = 1; k < order.length; k++) {
    var to = order[(at + d * k + order.length * k) % order.length];
    var twin = data.items.filter(function (x) { return !x.video && x.device === to[0] && x.text_size === to[1] && x.command === it.command && x.screen === it.screen && x.locale.toLowerCase() === it.locale.toLowerCase(); })[0];
    if (twin) { list = list.slice(); list[pos] = twin.i; drawView(); return true; }
  }
  return false;
}
function drawView() {
  var i = list[pos], env = data.results[i], it = itemOf(i);
  var img = it.video ? (it.timeline.frames[0] ? it.timeline.frames[0].image : null) : it.image;
  // A video view shows the first failed frame's boxes; with no failed frame, none (boxes from different times would mix).
  var t = it.video ? (it.timeline.frames[0] ? it.timeline.frames[0].t : NaN) : undefined;
  var pic = shot(img, env, t);
  var entries = el("ul", { cls: "entries" }, overlay.shapes(env).map(function (s) {
    var st = s.style ? data.styles[s.style] : null;
    var when = it.video && typeof s.t === "number" ? " at " + s.t + " s" + (s.t === t ? " (shown)" : "") : "";
    var li = el("li", { "data-ref": s.ref, cls: st && st.dash ? "dash" : "" }, [el("strong", { text: s.label + when }), s.llm ? el("span", { cls: "tag", text: "LLM" }) : null, s.sev ? el("span", { cls: "tag sev", text: s.sev }) : null, " ", badge(s.verdict === "fail" ? "fail" : s.verdict === "pass" ? "pass" : s.verdict === "note" ? "note" : s.verdict === "known" ? "known" : "missing"), el("div", { text: s.text })]);
    if (st) li.style.borderLeftColor = st.color;
    li.addEventListener("mouseenter", function () { pic.querySelectorAll('rect[data-ref="' + s.ref + '"]').forEach(function (r) { r.classList.add("hl"); }); });
    li.addEventListener("mouseleave", function () { pic.querySelectorAll("rect.hl").forEach(function (r) { r.classList.remove("hl"); }); });
    return li;
  }));
  var diags = (env.warnings || []).concat(env.error ? [env.error] : []).map(function (w) { return el("li", { text: w.code + ": " + w.message }); });
  var panel = view.querySelector(".panel");
  panel.textContent = "";
  panel.appendChild(el("div", { cls: "pic" }, [pic]));
  panel.appendChild(el("div", { cls: "side" }, [
    el("div", { cls: "nav" }, [
      el("button", { type: "button", text: "Previous", onclick: function () { move(-1); } }),
      el("button", { type: "button", text: "Next", onclick: function () { move(1); } }),
      el("button", { type: "button", cls: "close", text: "Close (Esc)", onclick: closeView }),
      el("span", { text: (pos + 1) + " of " + list.length }),
    ]),
    el("h3", { id: "view-path" }, [badge(env.verdict), " ", env.path]),
    el("div", { cls: "run", id: "view-cell", text: [env.device, env.text_size, env.locale, env.screen, env.engine].filter(Boolean).join(" / ") }),
    BL ? changePanel(it) : null,
    entries,
    diags.length ? el("ul", { cls: "list" }, diags) : null,
    el("details", null, [el("summary", { text: "Raw JSON" }), el("pre", { cls: "raw", text: JSON.stringify(env, null, 2) })]),
  ]));
}

// The baseline comparison of the open item's cell: state, why it needs review, and the line diff (absent
// in digest mode, so no line text is shown then).
function lines(cls, sign, xs, total) {
  var ul = el("ul", { cls: "diff " + cls }, xs.map(function (x) { return el("li", { text: sign + " " + x }); }));
  if (total > xs.length) ul.appendChild(el("li", { cls: "more", text: (total - xs.length) + " more" }));
  return ul;
}
function diffBlock(d) { return [lines("added", "+", d.added, d.added_count), lines("removed", "-", d.removed, d.removed_count)]; }
function changePanel(it) {
  var c = cellOf(it.change);
  var box = el("div", { cls: "change", id: "view-change" }, [
    el("div", null, [el("strong", { text: "Baseline: " + (c ? c.state : "not compared") })].concat(changeMarks(c))),
    el("div", { cls: "why", text: reviewText(c) }),
  ]);
  if (!c) return box;
  if (c.renamed_from) box.appendChild(el("div", { text: "same text as the gone screen " + c.renamed_from + " (rename hint; still reviewed)" }));
  // lineDiff (baseline.js) is null both in digest mode and when the same lines differ only in tokens or order.
  var rec = data.results[it.i].text;
  if (c.diff) diffBlock(c.diff).forEach(function (x) { box.appendChild(x); });
  else if (c.state === "changed") box.appendChild(el("div", { cls: "run", text: rec && Array.isArray(rec.lines) ? "the same lines in another order or split differently; open the image" : "no line diff: the text record has no lines (--text-record digest)" }));
  if (c.minor_diff) box.appendChild(el("details", { cls: "minor" }, [el("summary", { text: "minor OCR difference (punctuation or diacritics; still unchanged)" })].concat(diffBlock(c.minor_diff))));
  return box;
}

app.appendChild(header());
app.appendChild(matrixSection());
app.appendChild(sheetSection());
var vs = videoSection();
if (vs) app.appendChild(vs);
view = el("div", { cls: "view", id: "view", role: "dialog", "aria-modal": "true", "aria-label": "Image view", hidden: "" }, [el("div", { cls: "panel" })]);
view.addEventListener("click", function (e) { if (e.target === view) closeView(); });
app.appendChild(view);
document.addEventListener("keydown", function (e) {
  if (view.hidden) return;
  if (e.key === "Escape") closeView();
  else if (e.key === "Tab") { // keep focus inside the open dialog
    var f = view.querySelectorAll("button, summary, a[href]");
    if (f.length && e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (f.length && !e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
  else if (e.key === "ArrowRight") move(1);
  else if (e.key === "ArrowLeft") move(-1);
  else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && moveDevice(e.key === "ArrowDown" ? 1 : -1)) e.preventDefault();
});
applyReview();
drawGrid();
document.body.setAttribute("data-ready", "1");
