// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import path from "node:path";
import { test, expect as base } from "@playwright/test";
import { catscanMatchers } from "@catscan/playwright";

export { test };
// {locale} takes the catscan locale: de-DE from the de project is read as de.
export const expect = base.extend(catscanMatchers({ catalog: path.join(__dirname, "../locales/{locale}.json") }));
