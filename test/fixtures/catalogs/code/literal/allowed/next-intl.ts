// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Synthetic next-intl shape: the English messages type the other locales.
const en = {
  Home: { title: 'Welcome home', cta: 'Start playing' },
} as const;

export type Messages = typeof en;
declare global { interface IntlMessages extends Messages {} }

export default en;
