#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Copies the canonical JSON Schemas (core/schema) into @catscan/core-js for `npm pack`, so
// `catscan results validate` finds them in an installed package (spec 27 D24). `--clean` removes the copy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "packages/core-js/schema");
fs.rmSync(dest, { recursive: true, force: true });
if (!process.argv.includes("--clean")) {
  fs.mkdirSync(dest);
  for (const f of ["result.schema.json", "results.schema.json", "known.schema.json"]) fs.copyFileSync(path.join(root, "core/schema", f), path.join(dest, f));
}
