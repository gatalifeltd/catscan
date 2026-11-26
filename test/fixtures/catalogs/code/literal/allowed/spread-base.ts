// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// A local base spread into the catalog and into a section, a constant key, and constants in a template.
const base = { ok: 'Got it' };
const KEYS = { title: 'title' };
const APP = 'Space Cats';

export default {
  ...base,
  [KEYS.title]: 'Settings',
  header: `About ${APP}`,
  dialog: { ...base, body: 'Save your progress?' },
};
