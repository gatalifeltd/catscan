#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 GATALIFE LTD
# Spec 14 end-to-end test: both sample apps on one iOS simulator and one Android emulator (API 33+), driven by
# examples/maestro/run-all.sh. Hand-run on a Mac with Xcode, the Android SDK and Maestro; not part of npm test (D10).
# Usage: npm run e2e:maestro [-- --platform ios|android]   (run it in the background: about 20 minutes)
set -eu
exec node "$(dirname "$0")/e2e-maestro.mjs" "$@"
