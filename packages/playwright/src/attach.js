// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 13: what a failed matcher attaches to the test, and the warnings annotation (D21).
const fs = require("fs");
const { svg } = require("@catscan/core-js/src/report/overlay");

/** The screenshot as a data URI under the spec 18 SVG overlay; no rasterized overlay. */
function html(png, env) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>catscan</title><style>
body{margin:0;background:#fff}.shot{position:relative;display:inline-block}.shot img{display:block;max-width:100%}
.shot svg{position:absolute;inset:0;width:100%;height:100%}</style></head><body><div class="shot">
<img alt="screenshot" src="data:image/png;base64,${png.toString("base64")}">${svg(env)}</div></body></html>\n`;
}

/** catscan.png, catscan.html, catscan-lines.txt, catscan.json. */
async function failure(info, { file, env, lines }) {
  let png = null;
  try { png = fs.readFileSync(file); } catch {}
  if (png) await info.attach("catscan.png", { body: png, contentType: "image/png" });
  if (png && env) await info.attach("catscan.html", { body: html(png, env), contentType: "text/html" });
  await info.attach("catscan-lines.txt", { body: lines.length ? lines.join("\n") + "\n" : "(no lines read)\n", contentType: "text/plain" });
  if (env) await info.attach("catscan.json", { body: JSON.stringify(env, null, 2) + "\n", contentType: "application/json" });
}

/** D21: catscan warnings become `catscan-warnings` annotations, once each per test. */
function annotate(info, warnings) {
  for (const w of warnings) {
    const description = `${w.code}: ${w.message}${w.hint ? ` (${w.hint})` : ""}`;
    if (!info.annotations.some((a) => a.type === "catscan-warnings" && a.description === description)) {
      info.annotations.push({ type: "catscan-warnings", description });
    }
  }
}

module.exports = { failure, annotate, html };
