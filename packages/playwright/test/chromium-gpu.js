// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Every Chromium launch in this repo takes these args (guarded by scripts/test/chromium-gpu.test.mjs). Headless
// Chromium draws with SwiftShader on the CPU by default; on macOS Metal puts it on the GPU. Other platforms keep the
// default, and WebKit projects never get them (WebKit rejects Chromium flags). CATSCAN_SWIFTSHADER=1 is the one-run
// opt-out (AGENTS.md, GPU in every test), e.g. to redraw a set first drawn with SwiftShader.
const chromiumArgs = () => (process.platform === "darwin" && process.env.CATSCAN_SWIFTSHADER !== "1" ? ["--use-angle=metal"] : []);

module.exports = { chromiumArgs };
