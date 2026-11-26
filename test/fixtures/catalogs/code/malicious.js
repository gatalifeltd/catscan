// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Every line here would run code if the file were evaluated. catscan must read it as text only.
require('fs').writeFileSync(process.env.CATSCAN_PWNED || '/tmp/catscan-pwned', 'ran');
process.exit(42);
import('./does-not-exist.js');
module.exports = {
  safe: 'Safe text',
  get boom() { require('fs').writeFileSync(process.env.CATSCAN_PWNED || '/tmp/catscan-pwned', 'getter'); return 'x'; },
  iife: (() => { process.exit(43); })(),
  proto: { __proto__: 'Proto key' },
  ctor: { constructor: 'Constructor key' },
};
