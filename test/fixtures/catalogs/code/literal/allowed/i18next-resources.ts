// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Synthetic i18next TypeScript shape: the resources object indexes its own type.
export const resources = {
  en: { translation: { title: 'Welcome home' } },
} as const;

export const locales = ['en', 'de'] as const;
export type Locale = typeof locales[number];

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: typeof resources['en'];
  }
}
