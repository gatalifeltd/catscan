// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
/* Keys, values and escapes the reader accepts. */
const helper = (n: number): string => `${n / 2}`; // a function, stepped over
const re = /["'`]/g;
type Dict = Record<string, (n: number) => string>;
const shared: { [k: string]: string } = { shared: 'Shared text' };

const de = {
  plain: 'Einstellungen',
  "double": "Doppelt \"zitiert\"",
  esc: 'Zeile\neins\tTab \x41 é \u{1F600} \\ \' \0',
  cont: 'Eins \
zwei',
  tpl: `Mehrere
Zeilen`,
  num: 42,
  neg: -1.5,
  big: 1e3,
  12: 'Zahl als Schluessel',
  'a.b': 'Flacher Punkt',
  [`computed`]: 'Berechnet',
  nested: { deep: { deeper: 'Tief' }, list: ['Eins', `Zwei`, ['Drei']] },
  dup: 'Alt',
  dup: 'Neu',
  ref: shared,
  typed: 'Typ' as string,
  bang: 'Ausruf'!,
  odd: { ['comp' + '']: 'a computed key nobody can read' },
};

export default de;
