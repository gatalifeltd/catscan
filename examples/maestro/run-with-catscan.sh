#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 GATALIFE LTD
# Pattern 2: run one Maestro flow for one locale, then catscan on that flow's screenshots.
# Usage: run-with-catscan.sh <flow.yaml> <ios|android> <locale>
# Env: MAESTRO_UDID (required, from 'maestro list-devices'), APP_ID (default org.catscan.sample),
#      CATSCAN_BASE and CATSCAN_CATALOG (catalogs for 'catscan untranslated'), CATSCAN_FORMAT (e.g. github).
# Run it from the folder that holds flows/, checks/ and shots/ (paths are relative to it). It runs no truncation
# check: run-all.sh does, with boxes.
# Exit: Maestro's code when Maestro failed, else the highest catscan code by exit-code precedence; 1 when the
#       flow left no screenshot (nothing was checked); 2 usage; 5 maestro, catscan or adb not on PATH.
set -eu

usage() {
  echo "usage: run-with-catscan.sh <flow.yaml> <ios|android> <locale>" >&2
  exit 2
}
[ $# -eq 3 ] || usage
FLOW=$1 PLATFORM=$2 LOCALE=$3
case $PLATFORM in ios|android) ;; *) usage ;; esac
[ -f "$FLOW" ] || { echo "run-with-catscan: no flow file: $FLOW" >&2; exit 2; }
if [ -z "${MAESTRO_UDID:-}" ]; then
  echo "run-with-catscan: set MAESTRO_UDID to the device id from 'maestro list-devices'" >&2
  exit 2
fi
need() {
  command -v "$1" >/dev/null 2>&1 || { echo "run-with-catscan: $1 not on PATH; $2" >&2; exit 5; }
}
need maestro 'install: curl -fsSL "https://get.maestro.mobile.dev" | MAESTRO_VERSION=2.6.0 bash'
need catscan 'install: see docs/recipes/maestro.md#install'
[ "$PLATFORM" = ios ] || need adb 'install the Android SDK platform-tools'
APP_ID=${APP_ID:-org.catscan.sample}
LAYOUT='{screen}.{locale}'
SHOTS="shots/$PLATFORM"   # pregate-literal: SHOTS="shots/$PLATFORM" this wrapper captures the default text size only

# The screenshots this flow takes: one-line 'takeScreenshot: shots/${PLATFORM}/<screen>.${LOCALE}' steps.
SCREENS=$(sed -n 's/^[[:space:]]*-[[:space:]]*takeScreenshot:[[:space:]]*["'\'']\{0,1\}shots\/\${PLATFORM}\/\([^"'\'' ]*\)\.\${LOCALE}["'\'']\{0,1\}[[:space:]]*$/\1/p' "$FLOW")

if [ -z "$SCREENS" ]; then
  echo "run-with-catscan: $FLOW has no step 'takeScreenshot: shots/\${PLATFORM}/<screen>.\${LOCALE}' (the one-line form)" >&2
  exit 2
fi

# One .xcstrings file holds every locale, so it can be both catalogs; a strings.xml base needs its locale's file.
if [ -n "${CATSCAN_BASE:-}" ] && [ -z "${CATSCAN_CATALOG:-}" ]; then
  case $CATSCAN_BASE in
    *.xcstrings) CATSCAN_CATALOG=$CATSCAN_BASE ;;
    *) echo "run-with-catscan: CATSCAN_BASE needs CATSCAN_CATALOG, the $LOCALE catalog (only one .xcstrings file holds every locale)" >&2; exit 2 ;;
  esac
fi

# No stale screenshot stands in for one the flow did not take this time.
mkdir -p "$SHOTS"
for s in $SCREENS; do rm -f "$SHOTS/$s.$LOCALE.png"; done

if [ "$PLATFORM" = android ]; then
  adb -s "$MAESTRO_UDID" shell cmd locale set-app-locales "$APP_ID" --locales "$LOCALE"   # API 33+
fi
mrc=0
maestro --udid "$MAESTRO_UDID" test "$FLOW" -e PLATFORM="$PLATFORM" -e LOCALE="$LOCALE" -e APP_ID="$APP_ID" || mrc=$?

set --
for s in $SCREENS; do
  [ -e "$SHOTS/$s.$LOCALE.png" ] && set -- "$@" "$SHOTS/$s.$LOCALE.png"
done
if [ $# -eq 0 ]; then
  echo "run-with-catscan: the flow left no screenshot under $SHOTS/ for $LOCALE; catscan not run" >&2
  [ "$mrc" -ne 0 ] && exit "$mrc"
  exit 1                                                          # nothing was checked: never a pass
fi

# Exit-code precedence: 5, 4, 3, 1, 0 (a usage error, 2, ranks after 3).
rank() { case $1 in 5) echo 6 ;; 4) echo 5 ;; 3) echo 4 ;; 2) echo 3 ;; 0) echo 0 ;; *) echo 2 ;; esac; }
crc=0
keep() { if [ "$(rank "$1")" -gt "$(rank "$crc")" ]; then crc=$1; fi; }
fmt=
[ -n "${CATSCAN_FORMAT:-}" ] && fmt="--format $CATSCAN_FORMAT"

rc=0
if [ -n "${CATSCAN_BASE:-}" ]; then
  # shellcheck disable=SC2086
  catscan untranslated "$@" --layout "$LAYOUT" --locale "$LOCALE" \
    --base "$CATSCAN_BASE" --catalog "$CATSCAN_CATALOG" $fmt || rc=$?
else
  echo "run-with-catscan: CATSCAN_BASE unset: untranslated checks raw keys and placeholders only (set CATSCAN_BASE and CATSCAN_CATALOG)" >&2
  if [ -n "${CATSCAN_CATALOG:-}" ]; then
    # shellcheck disable=SC2086
    catscan untranslated "$@" --layout "$LAYOUT" --locale "$LOCALE" --catalog "$CATSCAN_CATALOG" $fmt || rc=$?
  else
    # shellcheck disable=SC2086
    catscan untranslated "$@" --layout "$LAYOUT" --locale "$LOCALE" $fmt || rc=$?
  fi
fi
keep "$rc"
if [ -f "checks/$LOCALE.yaml" ]; then
  rc=0
  # shellcheck disable=SC2086
  catscan check "$@" --layout "$LAYOUT" --expect "checks/$LOCALE.yaml" $fmt || rc=$?
  keep "$rc"
fi
[ "$mrc" -ne 0 ] && exit "$mrc"
exit "$crc"
