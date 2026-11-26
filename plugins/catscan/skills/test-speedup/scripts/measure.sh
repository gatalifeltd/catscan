#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 GATALIFE LTD
# Interleaved before/after timing for the test-speedup skill.
# Runs pairs A B, B A, A B ..., then prints medians of wall time and CPU time per arm.
# Works with macOS /bin/bash 3.2: no negative array indices, no associative arrays.
set -u
# time and awk print decimal commas under some locales, which awk then truncates to whole seconds.
# The measured command still gets the caller's locale (caller_locale in one()).
# Only through env: re-setting LC_ALL in this shell would bring the comma back into the time report.
if [ -n "${LC_ALL+1}" ]; then caller_locale=(env "LC_ALL=$LC_ALL"); else caller_locale=(env -u LC_ALL); fi
export LC_ALL=C

usage() {
  cat >&2 <<'EOF'
usage: measure.sh [-n RUNS] [--warmup N] [--allow-fail] [--log DIR] LABEL_A "CMD_A" [LABEL_B "CMD_B"]
  LABEL is name@revision:cache, cache is cold or warm, e.g. before@3f2a1c9:warm
  cold: the command must point its caches at a fresh empty dir on every run; no warmup run.
  warm: N discarded warmup runs first (default 1).
  -n RUNS        measured runs per arm (default 3)
  --log DIR      a new folder (must not exist yet): keeps each run's stdout+stderr as
                 DIR/<arm>-<warmup|run>-<i>.log (to read test counts)
  --allow-fail   accept exits 1-125 (only when failure is the measured behavior);
                 126/127 (not runnable) and signals (>128) still invalidate
exit: 0 all runs passed, 2 usage or unsupported platform, 3 a run failed (timings invalid)
EOF
  exit 2
}

runs=3
warmup=1
allow_fail=0
log_dir=
while [ $# -gt 0 ]; do
  case "$1" in
    -n) [ $# -ge 2 ] || usage; runs=$2; shift 2 ;;
    --warmup) [ $# -ge 2 ] || usage; warmup=$2; shift 2 ;;
    --allow-fail) allow_fail=1; shift ;;
    --log) { [ $# -ge 2 ] && [ -n "$2" ]; } || usage; log_dir=$2; shift 2 ;;
    -h|--help) usage ;;
    --) shift; break ;;
    -*) echo "measure.sh: unknown option $1" >&2; usage ;;
    *) break ;;
  esac
done
case "$runs" in ''|*[!0-9]*) echo "measure.sh: -n needs a positive integer, got '$runs'" >&2; usage ;; esac
case "$warmup" in ''|*[!0-9]*) echo "measure.sh: --warmup needs an integer, got '$warmup'" >&2; usage ;; esac
[ "$runs" -ge 1 ] || { echo "measure.sh: -n must be at least 1" >&2; usage; }
[ $# -eq 2 ] || [ $# -eq 4 ] || { echo "measure.sh: expected LABEL_A CMD_A [LABEL_B CMD_B], got $# arguments" >&2; usage; }

label_re='^[A-Za-z0-9._-]+@[A-Za-z0-9._/-]+:(cold|warm)$'
for l in "$1" ${3+"$3"}; do
  [[ "$l" =~ $label_re ]] || { echo "measure.sh: label '$l' is not name@revision:cold|warm" >&2; usage; }
done

if [ -r /proc/loadavg ]; then
  load() { cut -d' ' -f1 /proc/loadavg; }
elif sysctl -n vm.loadavg >/dev/null 2>&1; then
  load() { sysctl -n vm.loadavg | awk '{print $2}'; }
else
  echo "measure.sh: unsupported platform: needs /proc/loadavg (Linux) or sysctl vm.loadavg (macOS)" >&2
  usage
fi

# One timed run; prints "wall cpu load exit". CPU is user+sys of the command's
# process tree as reaped by bash, so daemons it hands work to are not counted.
one() { # cmd log-name
  local l out rc t sink=/dev/null
  [ -n "$log_dir" ] && sink="$log_dir/$2.log"
  l=$(load)
  # An unwritable log must not pass as the command's own exit 1 under --allow-fail: report it as not runnable.
  if ! : >"$sink"; then echo "0.00 0.00 $l 126"; return; fi
  out=$( { TIMEFORMAT='%R %U %S'; time "${caller_locale[@]}" bash -c "$1" </dev/null >"$sink" 2>&1; } 2>&1; echo "rc=$?" )
  rc=${out##*rc=}
  t=${out%%$'\n'rc=*}
  t=${t##*$'\n'} # a signal death prints a shell message before the timing line
  awk -v t="$t" -v l="$l" -v rc="$rc" 'BEGIN { split(t, a, " "); printf "%.2f %.2f %s %s\n", a[1], a[2] + a[3], l, rc }'
}

median() { sort -n | awk '{ a[NR] = $1 } END { if (NR % 2) print a[(NR + 1) / 2]; else printf "%.2f\n", (a[NR / 2] + a[NR / 2 + 1]) / 2 }'; }

failed=0
# Exit codes --allow-fail may accept: a command that ran and failed, not one that never ran or was killed.
ok_exit() { [ "$1" = 0 ] || { [ "$allow_fail" = 1 ] && [ "$1" -lt 126 ]; }; }
fail_run() { # arm label run code
  failed=1
  echo "measure.sh: arm $1 ($2) $3 exited $4; timings invalid. Fix the command, or pass --allow-fail if failure is the measured behavior." >&2
}

warm_up() { # arm label cmd
  local i r
  case "$2" in *:cold) return 0 ;; esac
  i=1
  while [ "$i" -le "$warmup" ]; do
    r=$(one "$3" "$1-warmup-$i")
    echo "$1 warmup $i (wall cpu load exit): $r" >&2
    ok_exit "${r##* }" || fail_run "$1" "$2" "warmup $i" "${r##* }"
    i=$((i + 1))
  done
}

# Created only after every usage check, and only new: a folder this script made empty holds no planted
# symlink, FIFO or stale log to write through.
if [ -n "$log_dir" ]; then
  if [ -e "$log_dir" ] || [ -L "$log_dir" ]; then echo "measure.sh: --log '$log_dir' already exists; give a new folder" >&2; usage; fi
  { mkdir -p -- "$(dirname -- "$log_dir")" && mkdir -- "$log_dir"; } || { echo "measure.sh: cannot create --log folder '$log_dir'" >&2; usage; }
fi

warm_up A "$1" "$2"
[ $# -eq 4 ] && warm_up B "$3" "$4"

A=(); B=()
i=1
run_a() { r=$(one "$2" "A-run-$i"); A[${#A[@]}]="$r"; echo "A run $i (wall cpu load exit): $r" >&2; ok_exit "${r##* }" || fail_run A "$1" "run $i" "${r##* }"; }
run_b() { r=$(one "$4" "B-run-$i"); B[${#B[@]}]="$r"; echo "B run $i (wall cpu load exit): $r" >&2; ok_exit "${r##* }" || fail_run B "$3" "run $i" "${r##* }"; }
# Pairs alternate AB, BA, AB ... so whatever the first arm warms (page cache, heat) does not always favor B.
while [ "$i" -le "$runs" ]; do
  if [ $# -eq 2 ]; then run_a "$@"
  elif [ $((i % 2)) = 1 ]; then run_a "$@"; run_b "$@"
  else run_b "$@"; run_a "$@"; fi
  i=$((i + 1))
done

status=ok
[ "$failed" = 1 ] && status=invalid
report() { # arm label rows...
  local arm=$1 label=$2; shift 2
  printf 'arm=%s label=%s runs=%s wall_median_s=%s cpu_median_s=%s load=%s status=%s\n' "$arm" "$label" "$runs" \
    "$(printf '%s\n' "$@" | cut -d' ' -f1 | median)" \
    "$(printf '%s\n' "$@" | cut -d' ' -f2 | median)" \
    "$(printf '%s\n' "$@" | cut -d' ' -f3 | paste -sd, -)" "$status"
}
report A "$1" "${A[@]}"
[ $# -eq 4 ] && report B "$3" "${B[@]}"
echo "note: CPU is the measured process tree only; daemons (emulator, simulator, Gradle daemon, Metro) are excluded."
[ "$failed" = 1 ] && exit 3
exit 0
