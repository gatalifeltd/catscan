// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// A shared section reused in two places, and a constant read in a template.
const APP = 'Space Cats';
const buttons = { ok: 'Got it', cancel: 'Not now' };

export default {
  title: `Welcome to ${APP}`,
  dialog: { buttons, body: 'Save your progress?' },
  settings: { buttons, header: 'Settings' },
};
