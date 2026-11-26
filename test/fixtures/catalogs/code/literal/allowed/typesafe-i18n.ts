// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Synthetic typesafe-i18n shape: the base locale satisfies a type and is the type of another.
import type { BaseTranslation } from '../types';

const en = {
  title: 'Welcome home',
  cta: 'Start playing',
} satisfies BaseTranslation;

export const fallback: typeof en = { title: 'Welcome home', cta: 'Start playing' };
export default en;
