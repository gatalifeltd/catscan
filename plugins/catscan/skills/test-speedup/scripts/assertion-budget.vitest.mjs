// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Vitest entry of assertion-budget.cjs: list this file in `test.setupFiles` and copy both files.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect } from 'vitest';

globalThis[Symbol.for('test-speedup.assertion-budget.entry')] = 'vitest';
createRequire(import.meta.url)('./assertion-budget.cjs').install({ beforeEach, afterEach, expect });
