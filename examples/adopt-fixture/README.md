# catscan-adopt fixture

A small Playwright project for the `catscan-adopt` skill: a canvas menu in English and
German whose text the DOM cannot see, and a test that writes one screenshot per locale to `shots/<locale>/`
that nobody checks. `adopt.mjs` applies the two edits the skill documents for it (a Playwright matcher and a
CLI step with an expect file per locale); `test/adopt/fixture.test.js` proves each one turns red when the
rendered text changes and green again when it is restored.
