// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// A static server for the example page (Playwright's webServer); no dependencies.
const fs = require("fs");
const http = require("http");
const path = require("path");

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json" };
const port = Number(process.env.PORT || 4173);
http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html"; } catch { res.writeHead(400); res.end(); return; }
  const file = path.join(__dirname, path.normalize(rel));
  if (!file.startsWith(__dirname + path.sep) || !TYPES[path.extname(file)] || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] });
  fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1");
