// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import type { Messages } from './types';
import { plural } from '../util';

// Synthetic shape of a web game's i18n folder: one file per locale, a type import, a helper.
export function count(n: number) { return plural(n, 'item', 'items'); }

const en: Messages = {
  menu: { play: 'Play now', settings: 'Settings', quit: 'Quit game' },
  hud: { score: 'Score: {score}', lives: '{count, plural, one {# life left} other {# lives left}}' },
  shop: { buy: `Buy for {price}`, owned: 'Already owned' },
};

export default en;
