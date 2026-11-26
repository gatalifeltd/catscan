// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import base from './base';
import { t } from 'i18n-lib';
const name = 'x';

export default {
  early: 'Written before the spread',
  ...base,
  late: 'Written after the spread',
  nested: { inner: 'Also before', ...base.nested, after: 'After the inner spread' },
  greet: `Hello ${name}`,
  call: t('greeting'),
  wrapped: defineMessage({ id: 'x' }),
  fn: () => 'arrow',
  fn2: function () { return 'f'; },
  method() { return 'm'; },
  get accessor() { return 'g'; },
  ref: someImport.value,
  section: base,
  concat: 'a' + 'b',
  flag: true,
  nothing: null,
  shorthandMissing,
  comp: { [KEY]: 'computed name' },
  jsx: <b>Bold</b>,
  plain: 'Plain text',
};
