#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Applies the two edits the catscan-adopt skill documents for this fixture (surfaces.md: Playwright matcher,
// CLI step), the way an agent following the skill would. Usage: node adopt.mjs <fixture-copy> <catscan-version>
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, version] = process.argv.slice(2);
if (!dir || !version) { console.error('usage: node adopt.mjs <fixture-copy> <catscan-version>'); process.exit(2); }
const EXPECT = { en: ['Ready Set Go', 'Play'], de: ['Auf die Plätze', 'Spielen'] };

// Point 1 (canvas-text): the Playwright matcher next to the existing assert, the project's expect untouched.
const spec = join(dir, 'tests/menu.pw.ts');
let s = readFileSync(spec, 'utf8');
const edits = [
  ['import { test, expect } from "@playwright/test";\n', 'import { expect as screen } from "@catscan/playwright";\n'],
  // After the capture, so a red check still leaves the screenshot for the CLI step and for the developer.
  ['    await page.screenshot({ path: path.join(__dirname, `../shots/${lng}/menu.png`) });\n',
    `    await screen(page).toShowText(lng === "en" ? ${JSON.stringify(EXPECT.en)} : ${JSON.stringify(EXPECT.de)}, { locale: lng });\n`],
];
for (const [anchor, add] of edits) {
  if (!s.includes(anchor)) { console.error(`adopt: anchor not found in ${spec}: ${anchor.trim()}`); process.exit(1); }
  s = s.replace(anchor, anchor + add);
}
writeFileSync(spec, s);

// Point 2 (unchecked-shot, locale-folder): a CLI step on the per-locale shots with one expect file per locale.
mkdirSync(join(dir, 'checks'), { recursive: true });
for (const [lng, texts] of Object.entries(EXPECT)) {
  writeFileSync(join(dir, `checks/${lng}.yaml`), `locale: ${lng}\nshots:\n  menu.png: { present: ${JSON.stringify(texts)} }\n`);
}
const sh = join(dir, 'screens.sh');
writeFileSync(sh, `#!/bin/sh
# Screen text checks on the shots the e2e run took (catscan-adopt CLI step). Run it after the e2e run.
set -e
cd "$(dirname "$0")"
CATSCAN=\${CATSCAN:-"npx @catscan/cli@${version}"}
mkdir -p out
for L in en de; do
  $CATSCAN check "shots/$L" --expect "checks/$L.yaml" --results "out/$L.json"
done
`);
chmodSync(sh, 0o755);
