// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Synthetic react-i18next shape: resources typed with keyof typeof.
export const en = {
  translation: { title: 'Welcome home', cta: 'Start playing' },
};

export type Namespaces = keyof typeof en;
export type Resources = (typeof en)['translation'];
