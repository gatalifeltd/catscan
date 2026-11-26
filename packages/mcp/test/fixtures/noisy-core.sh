#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 GATALIFE LTD
# A stand-in for catscan-core (TODO-056 D4): writes a stderr line every 0.1 s, which the MCP server relays; touches
# $NOISY_CORE_MARKER once it runs; never answers; exits on stdin EOF.
( while :; do echo "catscan-core: a relayed stderr line" >&2; sleep 0.1; done ) &
loop=$!
touch "$NOISY_CORE_MARKER"
cat >/dev/null
kill "$loop"
