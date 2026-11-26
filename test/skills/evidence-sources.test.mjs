// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// The lab-only source map for evidence.md stays parseable and complete per entry (TODO-006 D5).
// Value: protects=each source-map entry names repo, commit and refs; fails_when=the JSON breaks or an entry loses its repo, commit or refs;
//   why_new=no script or test read evidence-sources.json; seam=none; no_claim=row-to-entry parity (entries have no row key) or that cited lines still hold the numbers
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const map = JSON.parse(readFileSync(new URL('../../results/skills/evidence-sources.json', import.meta.url), 'utf8'));

test('each source-map entry names repo, commit and refs', () => {
  assert.ok(map.rows.length > 0);
  for (const r of map.rows) {
    assert.ok(r.lever && r.repo, `missing lever or repo: ${JSON.stringify(r)}`);
    assert.match(r.audited_head, /^[0-9a-f]{7,40}$/, r.lever);
    assert.ok(Array.isArray(r.refs) && r.refs.length > 0, `no refs: ${r.lever}`);
  }
});

// Value: protects=a row's optional `shipped` block names a commit, a PR and refs; fails_when=a shipped block lands with a bad hash,
//   no owner/repo#N PR or empty refs; why_new=the test above checks top-level fields only; seam=none; no_claim=that the PR merged
//   or that cited lines still hold the claim
test('a shipped block names commit, PR and refs', () => {
  for (const r of map.rows.filter((row) => 'shipped' in row)) {
    assert.match(r.shipped.audited_head, /^[0-9a-f]{7,40}$/, r.lever);
    assert.match(r.shipped.pr, /^[\w.-]+\/[\w.-]+#\d+$/, r.lever);
    assert.ok(Array.isArray(r.shipped.refs) && r.shipped.refs.length > 0, `no shipped refs: ${r.lever}`);
  }
});
