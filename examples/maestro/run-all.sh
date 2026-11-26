#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 GATALIFE LTD
# Pattern 1: every flow per locale on one device, catscan per locale, one report per platform.
# Usage (from anywhere): examples/maestro/run-all.sh <ios|android> <locale>...
# Env: MAESTRO_UDID (required, from 'maestro list-devices'), APP_ID (default org.catscan.sample),
#      FLOWS (default: flows next to this script), CATSCAN_FORMAT (e.g. github), CATSCAN_JUNIT_DIR (one JUnit file
#      per command and locale; this platform and size's earlier ones are removed), TEXT_SIZE (default 'default'; a
#      label from text-sizes.tsv, set on the device for this run and restored on exit). A relative FLOWS or
#      CATSCAN_JUNIT_DIR is relative to the folder you run it from.
# Exit: a Maestro failure's code, else the highest catscan code by exit-code precedence (5, 4, 3, 1, 0); 2 usage or a
#       label with no setting for the platform; 5 a tool not on PATH or a text size that could not be set or restored.
# POSIX sh on purpose: zsh's nomatch never applies to the globs below.
set -eu

usage() {
  echo "usage: run-all.sh <ios|android> <locale>..." >&2
  exit 2
}
[ $# -ge 2 ] || usage
PLATFORM=$1
shift
case $PLATFORM in ios|android) ;; *) usage ;; esac
if [ -z "${MAESTRO_UDID:-}" ]; then
  echo "run-all: set MAESTRO_UDID to the device id from 'maestro list-devices'" >&2
  exit 2
fi
need() {
  command -v "$1" >/dev/null 2>&1 || { echo "run-all: $1 not on PATH; $2" >&2; exit 5; }
}
need maestro 'install: curl -fsSL "https://get.maestro.mobile.dev" | MAESTRO_VERSION=2.6.0 bash'
need catscan 'install: see docs/recipes/maestro.md#install'
[ "$PLATFORM" = ios ] || need adb 'install the Android SDK platform-tools'
TEXT_SIZE=${TEXT_SIZE:-default}
[ "$PLATFORM" = android ] || need xcrun 'install Xcode and its command line tools'   # also reads the default run's size

# A FLOWS given by the caller is relative to the caller's folder; the default is the one next to this script.
case ${FLOWS:-} in ''|/*) ;; *) FLOWS="$(pwd)/$FLOWS" ;; esac
case ${CATSCAN_JUNIT_DIR:-} in ''|/*) ;; *) CATSCAN_JUNIT_DIR="$(pwd)/$CATSCAN_JUNIT_DIR" ;; esac
cd "$(dirname "$0")"
APP_ID=${APP_ID:-org.catscan.sample}
FLOWS=${FLOWS:-flows}
LAYOUT='{screen}.{locale}'

# text-sizes.tsv is the one label -> setting mapping; the recipe and the Playwright example are tested against it.
size_of() { awk -F '\t' -v l="$1" -v p="$PLATFORM" '$1 == l && $2 == p { print $3 }' text-sizes.tsv; }
SETTING=$(size_of "$TEXT_SIZE")
if [ -z "$SETTING" ]; then
  labels=$(awk -F '\t' -v p="$PLATFORM" '$1 !~ /^#/ && $2 == p { printf "%s%s", s, $1; s = "," }' text-sizes.tsv)
  echo "run-all: text-size-unknown: $PLATFORM has no setting for TEXT_SIZE=$TEXT_SIZE; labels for $PLATFORM: $labels (text-sizes.tsv); e.g. TEXT_SIZE=large" >&2
  exit 2
fi
DEFAULT=$(size_of default)
if [ "$PLATFORM" = ios ]; then
  SET_CMD="xcrun simctl ui $MAESTRO_UDID content_size"
  LIST_CMD='xcrun simctl list devices booted'
  # An unreadable size (no xcrun, the device not booted) is unknown: a size run sets its size anyway, a default run
  # resets it below, and a device that cannot be set is exit 5.
  current=$(xcrun simctl ui "$MAESTRO_UDID" content_size 2>/dev/null) || current=unknown
else
  SET_CMD="adb -s $MAESTRO_UDID shell settings put system font_scale"
  LIST_CMD='adb devices'
  current=$(adb -s "$MAESTRO_UDID" shell settings get system font_scale 2>/dev/null) && current=$(printf '%s' "$current" | tr -d '\r') || current=unknown
  case $current in ''|null|1|1.0) current=$DEFAULT ;; esac              # never set: the default
fi
# A run killed by SIGKILL cannot restore the size; the next run says so here (a default run resets it below).
if [ "$current" != "$DEFAULT" ] && [ "$current" != unknown ] && [ "$TEXT_SIZE" != default ]; then
  restore_hint="$SET_CMD $DEFAULT"
  [ "$PLATFORM" = ios ] && restore_hint="$restore_hint && xcrun simctl shutdown $MAESTRO_UDID && xcrun simctl boot $MAESTRO_UDID"
  echo "run-all: text-size-not-default: $MAESTRO_UDID is at $current, not the default $DEFAULT; restore with: $restore_hint" >&2
fi

# Sets the device's text size; prints text-size-set-failed and returns 1 when it cannot.
# iOS reboots after every change: without it Maestro 2.6.0 could not launch the app until the simulator rebooted.
set_size() {
  if [ "$PLATFORM" = ios ]; then
    err=$( { xcrun simctl ui "$MAESTRO_UDID" content_size "$1" && xcrun simctl shutdown "$MAESTRO_UDID" \
      && xcrun simctl boot "$MAESTRO_UDID" && xcrun simctl bootstatus "$MAESTRO_UDID" -b; } 2>&1 >/dev/null) && return 0
  else
    err=$(adb -s "$MAESTRO_UDID" shell settings put system font_scale "$1" 2>&1 >/dev/null) && return 0
  fi
  echo "run-all: text-size-set-failed: $SET_CMD $1 failed: $err; check the device with: $LIST_CMD" >&2
  return 1
}
restore() {
  rc=$?
  trap - EXIT
  trap '' INT TERM                     # a second Ctrl-C must not cut the restore short
  # A failed restore is exit 5, unless the run was interrupted (130/143) or a Maestro flow failed (its code stays).
  set_size "$DEFAULT" || { [ "$rc" -eq 130 ] || [ "$rc" -eq 143 ] || [ "${mrc:-0}" -ne 0 ] || rc=5; }
  exit "$rc"
}
if [ "$TEXT_SIZE" != default ]; then
  trap restore EXIT                    # also when a flow fails or the run is interrupted
  trap 'exit 130' INT
  trap 'exit 143' TERM
  set_size "$SETTING" || exit 5
elif [ "$current" != "$DEFAULT" ]; then
  # A default run on a device left at another size would record that size as default.
  set_size "$DEFAULT" || exit 5
  echo "run-all: text-size-reset: $MAESTRO_UDID was at $current; set it to the default $DEFAULT" >&2
fi

# The default size keeps shots/<platform>/, which run-with-catscan.sh shares; other sizes get a folder of their own.
# The flows name screenshots shots/${PLATFORM}/<screen>.${LOCALE}, and PLATFORM is used for nothing else.
SHOTDIR=$PLATFORM
[ "$TEXT_SIZE" = default ] || SHOTDIR="$PLATFORM/$TEXT_SIZE"
SHOTS="shots/$SHOTDIR"
mkdir -p "$SHOTS" out
# Results of this size's earlier run with other locales must not reach this report; other sizes' results stay.
# out/<platform>-<command>-<locale>.json is the name from before sizes; no label in text-sizes.tsv is a command.
rm -f "out/$PLATFORM-$TEXT_SIZE"-*.json "out/$PLATFORM.html"
for c in check untranslated truncated; do rm -f "out/$PLATFORM-$c"-*.json; done
if [ -n "${CATSCAN_JUNIT_DIR:-}" ]; then
  mkdir -p "$CATSCAN_JUNIT_DIR"
  for c in check untranslated truncated; do rm -f "$CATSCAN_JUNIT_DIR/$PLATFORM-$TEXT_SIZE-$c"-*.xml "$CATSCAN_JUNIT_DIR/$PLATFORM-$c"-*.xml; done   # only ours
fi
OUT="out/$PLATFORM-$TEXT_SIZE"
JUNIT="${CATSCAN_JUNIT_DIR:-}/$PLATFORM-$TEXT_SIZE"

LOCALES=
for L in "$@"; do LOCALES="${LOCALES:+$LOCALES,}$L"; done

rank() { case $1 in 5) echo 6 ;; 4) echo 5 ;; 3) echo 4 ;; 2) echo 3 ;; 0) echo 0 ;; *) echo 2 ;; esac; }
crc=0
mrc=0
keep() { if [ "$(rank "$1")" -gt "$(rank "$crc")" ]; then crc=$1; fi; }

# One retry: Maestro's iOS driver sometimes stops answering ("Unable to launch app", "Failed to connect")
# right after a dump; a flow that really fails fails twice.
mtest() {
  maestro --udid "$MAESTRO_UDID" test "$@" -e PLATFORM="$SHOTDIR" -e LOCALE="$L" -e APP_ID="$APP_ID" || {
    echo "run-all: maestro test $1 failed for $L; retrying once" >&2
    sleep 5                                      # let a dropped iOS driver go before Maestro starts a new one
    maestro --udid "$MAESTRO_UDID" test "$@" -e PLATFORM="$SHOTDIR" -e LOCALE="$L" -e APP_ID="$APP_ID"
  }
}

for L in $(echo "$LOCALES" | tr , ' '); do
  rm -f "$SHOTS"/*."$L".png "$SHOTS"/*."$L".*.json          # no stale file stands in for a missing one
  if [ "$PLATFORM" = ios ]; then
    BASE=app-ios/Localizable.xcstrings
    CATALOG=app-ios/Localizable.xcstrings
  else
    BASE=app-android/src/main/res/values/strings.xml
    # Android names a region locale values-pt-rBR, not values-pt-BR.
    CATALOG="app-android/src/main/res/values-$(echo "$L" | sed 's/-\(..\)$/-r\1/')/strings.xml"
    adb -s "$MAESTRO_UDID" shell cmd locale set-app-locales "$APP_ID" --locales "$L"   # API 33+
  fi
  rc=0
  mtest "$FLOWS" --exclude-tags boxes || rc=$?
  [ "$rc" -ne 0 ] && [ "$mrc" -eq 0 ] && mrc=$rc
  # Boxes for settings: a flow that ends there, then a dump once maestro has exited.
  if [ -f "$FLOWS/settings-boxes.yaml" ] && [ -e "$SHOTS/settings.$L.png" ]; then
    rc=0
    mtest "$FLOWS/settings-boxes.yaml" || rc=$?
    [ "$rc" -eq 0 ] && { maestro --udid "$MAESTRO_UDID" hierarchy > "$SHOTS/settings.$L.maestro.json" || rc=$?; }
    if [ "$rc" -eq 0 ]; then
      img=
      [ "$PLATFORM" = android ] && img="--image $SHOTS/settings.$L.png"
      # A failed conversion leaves no boxes file, so truncated still checks settings without boxes.
      # shellcheck disable=SC2086
      if catscan boxes maestro "$SHOTS/settings.$L.maestro.json" $img > "$SHOTS/settings.$L.boxes.tmp"; then
        mv "$SHOTS/settings.$L.boxes.tmp" "$SHOTS/settings.$L.boxes.json"
      else
        keep $?
        rm -f "$SHOTS/settings.$L.boxes.tmp"
      fi
    elif [ "$mrc" -eq 0 ]; then
      mrc=$rc
    fi
  fi
  set -- "$SHOTS"/*."$L".png
  [ -e "$1" ] || continue                                       # no screenshots: the report shows the locale as missing
  # CI flags go on check, untranslated and truncated only; catscan report takes neither.
  if [ -f "checks/$L.yaml" ]; then
    rc=0
    catscan check "$@" --layout "$LAYOUT" --device "$PLATFORM" --text-size "$TEXT_SIZE" --expect "checks/$L.yaml" \
      --results "$OUT-check-$L.json" ${CATSCAN_FORMAT:+--format "$CATSCAN_FORMAT"} ${CATSCAN_JUNIT_DIR:+--junit "$JUNIT-check-$L.xml"} || rc=$?
    keep "$rc"
  fi
  rc=0
  catscan untranslated "$@" --layout "$LAYOUT" --device "$PLATFORM" --text-size "$TEXT_SIZE" --locale "$L" --base "$BASE" \
    --catalog "$CATALOG" --results "$OUT-untranslated-$L.json" \
    ${CATSCAN_FORMAT:+--format "$CATSCAN_FORMAT"} ${CATSCAN_JUNIT_DIR:+--junit "$JUNIT-untranslated-$L.xml"} || rc=$?
  keep "$rc"
  rc=0
  catscan truncated "$@" --layout "$LAYOUT" --device "$PLATFORM" --text-size "$TEXT_SIZE" --locale "$L" --boxes "$SHOTS" \
    --results "$OUT-truncated-$L.json" \
    ${CATSCAN_FORMAT:+--format "$CATSCAN_FORMAT"} ${CATSCAN_JUNIT_DIR:+--junit "$JUNIT-truncated-$L.xml"} || rc=$?
  keep "$rc"
done

# One report over every size this platform has results for: out/<platform>-<size>-<command>-<locale>.json.
set -- out/"$PLATFORM"-*.json
if [ -e "$1" ]; then
  SIZES=
  for f in "$@"; do
    s=$(echo "$f" | sed -nE "s/^out\/$PLATFORM-(.+)-(check|untranslated|truncated)-[^\/]+\.json\$/\1/p")
    [ -n "$s" ] || continue
    case ",$SIZES," in *",$s,"*) ;; *) SIZES="${SIZES:+$SIZES,}$s" ;; esac
  done
  rc=0
  catscan report "$@" --layout "$LAYOUT" --expect-text-sizes "${SIZES:-$TEXT_SIZE}" --expect-locales "$LOCALES" \
    --expect-screens screens.txt --out "out/$PLATFORM.html" || rc=$?
  keep "$rc"
else
  echo "run-all: no screenshot for any locale under $SHOTS/; no report" >&2
  keep 1
fi
[ "$mrc" -ne 0 ] && exit "$mrc"
exit "$crc"
