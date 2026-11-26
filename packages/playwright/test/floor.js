// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Spec 13 D12: the fixture suite at the peer floor, by hand (`npm run test:playwright:floor`). Installs the newest
// @playwright/test 1.50.x and its Chromium in a temp dir, with this checkout's package and core-js, and runs the suite.
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Playwright 1.50's browser download hangs after 100% on Node 26 (docs/gotchas/playwright.md): run it on Node 22 or 24.
if (Number(process.versions.node.split(".")[0]) >= 26) {
  console.error(`test:playwright:floor: Node ${process.versions.node} hangs Playwright 1.50's browser install; run it with Node 22 or 24 on PATH`);
  process.exit(2);
}
const pkg = path.join(__dirname, "..");
const versions = JSON.parse(execFileSync("npm", ["view", "@playwright/test", "versions", "--json"], { encoding: "utf8" }));
const floor = versions.filter((v) => /^1\.50\.\d+$/.test(v)).sort((a, b) => Number(a.split(".")[2]) - Number(b.split(".")[2])).at(-1);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-pw-floor-"));
const sh = (cmd, args, cwd = tmp) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
};
console.log(`@playwright/test ${floor} in ${tmp}`);
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ private: true }));
sh("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "-E", `@playwright/test@${floor}`]);
fs.cpSync(path.join(pkg, "src"), path.join(tmp, "src"), { recursive: true });
fs.cpSync(path.join(pkg, "test/e2e"), path.join(tmp, "test/e2e"), { recursive: true });
fs.cpSync(path.join(pkg, "test/chromium-gpu.js"), path.join(tmp, "test/chromium-gpu.js")); // the e2e config requires it
fs.mkdirSync(path.join(tmp, "node_modules/@catscan"), { recursive: true });
fs.symlinkSync(path.join(pkg, "../core-js"), path.join(tmp, "node_modules/@catscan/core-js"));
sh("npx", ["playwright", "install", "chromium"]);
sh("npx", ["playwright", "--version"]);
sh("npx", ["playwright", "test", "-c", "test/e2e", "--project", "chromium", "--output", path.join(tmp, "results")]);
console.log(`floor passed: @playwright/test ${floor}, Chromium, catscan ${require("../package.json").version}`);
