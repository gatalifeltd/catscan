// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 25 D8: SPDX and copyright headers in the file's comment syntax, after a shebang or swift-tools-version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addHeader, checkText } from "../check-headers.mjs";

const JS = "// SPDX-License-Identifier: Apache-2.0\n// Copyright 2026 GATALIFE LTD\nexport {};\n";

test("both lines pass, after a shebang or swift-tools-version too", () => {
  assert.equal(checkText("a.js", JS), null);
  assert.equal(checkText("a.mjs", `#!/usr/bin/env node\n${JS}`), null);
  assert.equal(checkText("run.sh", "#!/bin/bash\n# SPDX-License-Identifier: Apache-2.0\n# Copyright 2025-2026 GATALIFE LTD\n"), null);
  assert.equal(checkText("Package.swift", `// swift-tools-version:6.0\n${JS}`), null);
});

test("a missing line, a wrong year format and a header before the shebang fail", () => {
  assert.match(checkText("a.js", "export {};\n"), /line 1 must be/);
  assert.match(checkText("a.js", "// SPDX-License-Identifier: Apache-2.0\nexport {};\n"), /line 2 must be/);
  assert.match(checkText("a.js", "// SPDX-License-Identifier: Apache-2.0\n// Copyright 26 GATALIFE LTD\n"), /line 2 must be/);
  assert.match(checkText("a.sh", "// SPDX-License-Identifier: Apache-2.0\n// Copyright 2026 GATALIFE LTD\n"), /"# SPDX/);
  assert.match(checkText("a.mjs", `${JS}#!/usr/bin/env node\n`), /must be the first line/);
});

test("JSON, images and listed names are skipped; an unlisted extension fails", () => {
  for (const f of ["a.json", "b.png", "LICENSE", "c.md", "d.yml"]) assert.equal(checkText(f, "x"), null, f);
  assert.match(checkText("main.rs", "fn main() {}"), /unclassified extension/);
  assert.match(checkText("Makefile", "all:"), /unclassified extension/);
});

test("--fix inserts the header after a shebang and leaves the rest", () => {
  const fixed = addHeader("x.py", "#!/usr/bin/env python3\nprint(1)\n", 2026);
  assert.equal(fixed, "#!/usr/bin/env python3\n# SPDX-License-Identifier: Apache-2.0\n# Copyright 2026 GATALIFE LTD\nprint(1)\n");
  assert.equal(checkText("x.py", fixed), null);
});

// Value: protects=the CI contract of check-headers over git-tracked files and the --fix write; fails_when=the CLI exits 0 with a missing header, checks untracked files, --fix skips writing, adds a second header to a file that has a broken one, or hides an unclassified extension; why_new=tests call checkText/addHeader only, never the CLI that docs.yml runs; seam=none; no_claim=year rollover of --fix
test("the CLI fails on tracked files, --fix writes the header once and leaves the rest failing", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const cli = new URL("../check-headers.mjs", import.meta.url).pathname;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-headers-"));
  fs.writeFileSync(path.join(root, "a.mjs"), "#!/usr/bin/env node\nexport {};\n");
  fs.writeFileSync(path.join(root, "broken.js"), "// SPDX-License-Identifier: Apache-2.0\n// Copyright 26 GATALIFE LTD\n");
  fs.writeFileSync(path.join(root, "untracked.rs"), "fn main() {}\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "a.mjs", "broken.js"], { cwd: root });
  const check = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
  assert.equal(check.status, 1);
  assert.match(check.stderr, /^a\.mjs: line 2 must be/m);
  assert.doesNotMatch(check.stderr, /untracked/);
  const fix = spawnSync(process.execPath, [cli, "--fix"], { cwd: root, encoding: "utf8" });
  assert.equal(fix.status, 1, "broken.js still fails");
  assert.match(fs.readFileSync(path.join(root, "a.mjs"), "utf8"), /^#!\/usr\/bin\/env node\n\/\/ SPDX-License-Identifier: Apache-2\.0\n\/\/ Copyright \d{4} GATALIFE LTD\nexport/);
  assert.equal(fs.readFileSync(path.join(root, "broken.js"), "utf8").match(/SPDX/g).length, 1);
  assert.match(fix.stderr, /^broken\.js: line 2 must be/m);
  assert.doesNotMatch(fix.stderr, /^a\.mjs/m);
});
