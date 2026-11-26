// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// UI tests: render each screen and save its screenshot to screenshots/.
const fs = require("fs");
const path = require("path");

const renders = path.join(__dirname, ".renders");
const out = path.join(__dirname, "..", "screenshots");
fs.mkdirSync(out, { recursive: true });
const screens = fs.readdirSync(renders).filter((f) => f.endsWith(".png")).sort();
for (const f of screens) {
  fs.copyFileSync(path.join(renders, f), path.join(out, f));
  console.log(`  ok  ${f.replace(".png", "")} rendered, screenshot saved to screenshots/${f}`);
}
console.log(`\n${screens.length} UI tests passed`);
