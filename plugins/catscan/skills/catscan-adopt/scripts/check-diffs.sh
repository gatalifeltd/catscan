#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 GATALIFE LTD
# check-diffs v1 (catscan-adopt skill). Proves a plan's diffs apply, in order and together,
# without touching the target repo: a scratch repository borrows the target's objects read-only (alternates),
# exports the plan's commit as plain files with every export and filter attribute switched off, and the diffs
# (<plan-dir>/diffs/*.diff, name order) are applied to those files with `git apply` outside any repository.
# Nothing writes an object, so the target's objects are not even freshened; no checkout, commit or hook runs.
# Then each NN-experimental-*.diff is applied again on the default diffs alone (an opt-in batch may be taken alone);
# no two experimental diffs may touch the same path, so any set of them applies. With <plan-dir>/batches (one line
# per default batch: `<name> <diff>... [after <batch>...]`), every combination of batches is applied on the commit,
# each with the batches its members name after `after`, so a developer may take any batches in any combination.
# Batches that share no file and no after link cannot conflict: combinations are tried inside each group of
# linked batches only (at most 8 per group).
# Usage: check-diffs.sh <repo> <plan-dir> [rev]   rev defaults to <plan-dir>/commit, else HEAD.
# Exit 0: every diff applies (one "ok" line each with +added -removed and sha256). 1: a diff fails, an experimental
# diff needs or shares a path with another, a batch combination fails, or the batches file is malformed (each a
# FAIL line on stderr with the fix). 2: usage error. Bash 3.2 compatible.
set -u
set -o pipefail
# An inherited GIT_DIR or GIT_INDEX_FILE (a hook, an agent shell) would point the scratch commands at the
# target repo; GIT_NO_LAZY_FETCH stops a partial clone from fetching into it.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR \
  GIT_NAMESPACE GIT_PREFIX GIT_CEILING_DIRECTORIES
export GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 LC_ALL=C
usage() { echo "check-diffs: $1" >&2; echo "usage: check-diffs.sh <repo> <plan-dir> [rev]" >&2; exit 2; }
[ $# -ge 2 ] && [ $# -le 3 ] || usage "expected 2 or 3 arguments"
repo=$1; plan=$2
[ -d "$plan/diffs" ] || usage "$plan/diffs is not a folder"
git -C "$repo" rev-parse --show-toplevel >/dev/null 2>&1 || usage "$repo is not a git repository"
if [ $# -eq 3 ]; then rev=$3
elif [ -f "$plan/commit" ]; then rev=$(tr -d ' \r\n\t' < "$plan/commit")
else rev=HEAD; fi
sha=$(git -C "$repo" rev-parse --verify --quiet "$rev^{commit}") || usage "$rev is not a commit in $repo"
objects=$(cd "$repo" && cd "$(git rev-parse --git-common-dir)" && pwd)/objects
[ -d "$objects" ] || usage "cannot find the object folder of $repo"

if command -v shasum >/dev/null 2>&1; then sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else sha256_of() { sha256sum "$1" | cut -d' ' -f1; }; fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/check-diffs.XXXXXX") || exit 2
trap 'rm -rf "$scratch"' EXIT
plan_abs=$(cd "$plan" && pwd)
g() { git --git-dir="$scratch/repo.git" -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
format=$(git -C "$repo" rev-parse --show-object-format) || usage "cannot read the object format of $repo"
# The scratch repo must use the target's object format (sha1 or sha256), whatever init.defaultObjectFormat says.
git init -q --bare --template= --object-format="$format" "$scratch/repo.git" || { echo "check-diffs: scratch repository failed" >&2; exit 2; }
mkdir -p "$scratch/repo.git/objects/info" && printf '%s\n' "$objects" > "$scratch/repo.git/objects/info/alternates"
# Highest-precedence attributes: no export-ignore/export-subst, no smudge filter or line-ending conversion.
mkdir -p "$scratch/repo.git/info" && printf '* !filter !text !eol !ident !working-tree-encoding -export-ignore -export-subst\n' > "$scratch/repo.git/info/attributes"
mkdir "$scratch/tree"
g -c core.autocrlf=false archive --format=tar "$sha" | tar -x -C "$scratch/tree" \
  || { echo "check-diffs: cannot export $sha from $repo" >&2; exit 2; }
cd "$scratch/tree" || exit 2
# Plain-file apply: stop git from discovering any repository above the scratch folder.
export GIT_CEILING_DIRECTORIES=$scratch

# Experimental diffs touch disjoint paths: each applies on the defaults alone, so then every set of them applies.
paths=$scratch/exp-paths
: > "$paths"
for d in "$plan_abs"/diffs/[0-9]*-experimental-*.diff; do
  [ -e "$d" ] || continue
  git apply --numstat -z "$d" | tr '\0' '\n' | awk -F'\t' -v n="$(basename "$d")" 'p > 0 {print $0 "\t" n; p--; next} NF >= 3 {if ($3 == "") p = 2; else print $3 "\t" n}' >> "$paths"
done
dup=$(sort "$paths" | awk -F'\t' '$1 == p && $2 != q {print q " and " $2 " both touch " $1; exit} {p = $1; q = $2}')
if [ -n "$dup" ]; then
  echo "FAIL $dup; fix: an experimental diff adds only its own files, so put the shared edit in the default diffs (one hook that runs every experimental step present)" >&2
  exit 1
fi

n=0
for d in "$plan_abs"/diffs/*.diff; do
  [ -e "$d" ] || continue
  n=$((n + 1))
  name=$(basename "$d")
  if ! err=$(git apply --whitespace=nowarn "$d" 2>&1); then
    echo "FAIL $name: does not apply at ${sha:0:12} after the diffs before it" >&2
    echo "$err" | sed 's/^/  /' >&2
    exit 1
  fi
  stat=$(git apply --numstat "$d" | awk '{a+=$1; r+=$2} END {printf "+%d -%d", a, r}')
  echo "ok $name $stat sha256=$(sha256_of "$d")"
done
[ "$n" -gt 0 ] || usage "no .diff files in $plan/diffs"

# Each NN-experimental-*.diff must also apply on the default diffs alone, since the developer may
# take one opt-in batch and not another. Reverse the experimental diffs (newest first) to get back to the defaults,
# then apply and reverse each one in turn: no copy of the tree, which can be hundreds of MB.
exp=()
for d in "$plan_abs"/diffs/[0-9]*-experimental-*.diff; do [ -e "$d" ] && exp+=("$d"); done
k=${#exp[@]}
# The reverse below gets back to the default diffs only when every experimental diff sorts after them.
seen=""
for d in "$plan_abs"/diffs/*.diff; do
  case $(basename "$d") in
    [0-9]*-experimental-*.diff) seen=$(basename "$d") ;;
    *) if [ -n "$seen" ]; then
         echo "FAIL $(basename "$d"): a default diff sorts after $seen; number the experimental diffs after every default diff" >&2
         exit 1
       fi ;;
  esac
done
i=$k
while [ "$i" -gt 0 ]; do
  i=$((i - 1))
  git apply -R --whitespace=nowarn "${exp[$i]}" 2>/dev/null \
    || { echo "check-diffs: cannot reverse $(basename "${exp[$i]}") to test it alone" >&2; exit 2; }
done
for d in ${exp[@]+"${exp[@]}"}; do
  name=$(basename "$d")
  if ! err=$(git apply --whitespace=nowarn "$d" 2>&1); then
    echo "FAIL $name: applies only on top of another experimental diff; make it apply on the default diffs alone (put the shared part in a default diff or in this one)" >&2
    echo "$err" | sed 's/^/  /' >&2
    exit 1
  fi
  git apply -R --whitespace=nowarn "$d" || { echo "check-diffs: cannot reverse $name" >&2; exit 2; }
done
alone=""
[ "$k" -gt 0 ] && alone="; each of $k experimental diffs applies on the default diffs alone"

# Batches: back to the commit, then each combination of batches with the batches they name after `after`.
defaults=()
for d in "$plan_abs"/diffs/*.diff; do
  case $(basename "$d") in [0-9]*-experimental-*.diff) ;; *) defaults+=("$d") ;; esac
done
batches_note="; batches not proved alone: no $plan/batches (write one line per batch: <name> <diff>... [after <batch>...])"
if [ -f "$plan_abs/batches" ]; then
  bad() { echo "FAIL $plan/batches: $1" >&2; exit 1; }
  bname=(); bdiffs=(); bafter=()
  set -f  # batch lines are names, never globs
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    set -- $line
    [ $# -gt 0 ] || continue
    name=$1; shift
    for x in ${bname[@]+"${bname[@]}"}; do [ "$x" = "$name" ] && bad "batch $name is defined twice; fix: one line per batch"; done
    ds=""; as=""; mode=diffs
    for w in "$@"; do
      if [ "$w" = after ]; then mode=after; continue; fi
      if [ $mode = after ]; then as="$as $w"; continue; fi
      f=${w%.diff}.diff
      case $f in */*) bad "batch $name names $w; fix: name a file in $plan/diffs, with no folder" ;; esac
      [ -e "$plan_abs/diffs/$f" ] || bad "batch $name names $w, which is not in $plan/diffs; fix: use a diff file name"
      case $f in [0-9]*-experimental-*.diff) bad "batch $name lists the experimental diff $f; fix: list default diffs only (each experimental diff is its own batch)" ;; esac
      case " $ds " in *" $f "*) bad "batch $name lists $f twice; fix: name each diff once" ;; esac
      ds="$ds $f"
    done
    [ -n "$ds" ] || bad "batch $name has no diff; fix: <name> <diff>... [after <batch>...]"
    bname+=("$name"); bdiffs+=("$ds"); bafter+=("$as")
  done < "$plan_abs/batches"
  set +f
  nb=${#bname[@]}
  [ "$nb" -gt 0 ] || bad "no batch; fix: one line per batch: <name> <diff>... [after <batch>...]"
  idx() { local i=0; while [ $i -lt "$nb" ]; do [ "${bname[$i]}" = "$1" ] && { echo $i; return 0; }; i=$((i + 1)); done; return 1; }
  for d in ${defaults[@]+"${defaults[@]}"}; do
    f=$(basename "$d"); c=0; i=0
    while [ $i -lt "$nb" ]; do case " ${bdiffs[$i]} " in *" $f "*) c=$((c + 1)) ;; esac; i=$((i + 1)); done
    [ $c -eq 1 ] || bad "$f is in $c batches; fix: put every default diff in exactly one batch"
  done
  # Each batch's after list as indexes, then its closure (the batch and every batch it needs), once.
  aidx=(); i=0
  while [ $i -lt "$nb" ]; do
    s=""
    for a in ${bafter[$i]}; do j=$(idx "$a") || bad "batch ${bname[$i]} is after $a, which is no batch; fix: name a batch defined in the file"; s="$s $j"; done
    aidx+=("$s"); i=$((i + 1))
  done
  cl=(); i=0
  while [ $i -lt "$nb" ]; do
    seen=" $i "
    set -- ${aidx[$i]}
    while [ $# -gt 0 ]; do
      cur=$1; shift
      [ "$cur" -eq $i ] && bad "batch ${bname[$i]} needs itself through its after list; fix: break the cycle"
      case $seen in *" $cur "*) continue ;; esac
      seen="$seen$cur "
      set -- "$@" ${aidx[$cur]}
    done
    cl+=("$seen"); i=$((i + 1))
  done
  # The paths each batch's own diffs touch (both sides of a rename). Every subset is applied with its after
  # closure, so two batches whose own diffs share no path edit different files on top of proved closures and
  # cannot conflict: combinations are tried only inside each group linked by a shared path (or a file one batch
  # edits where another edits inside a folder of that name). An after link alone
  # does not group, so a wiring batch with many dependents that touch their own files stays small groups.
  mkdir "$scratch/p"
  i=0
  while [ $i -lt "$nb" ]; do
    for f in ${bdiffs[$i]}; do
      git apply --numstat -z "$plan_abs/diffs/$f" | tr '\0' '\n' | awk -F'\t' 'p > 0 {print; p--; next} NF >= 3 {if ($3 == "") p = 2; else print $3}'
    done | sort -u > "$scratch/p/$i"
    # Each path's parent folders: a batch that adds x/y and one that adds a file x conflict without sharing a path.
    awk -F/ '{d = $1; for (k = 2; k <= NF; k++) { print d; d = d "/" $k }}' "$scratch/p/$i" | sort -u > "$scratch/p/a$i"
    i=$((i + 1))
  done
  grp=(); i=0
  while [ $i -lt "$nb" ]; do grp+=("$i"); i=$((i + 1)); done
  i=0
  while [ $i -lt "$nb" ]; do
    j=$((i + 1))
    while [ $j -lt "$nb" ]; do
      if [ "${grp[$i]}" != "${grp[$j]}" ]; then
        if [ -n "$(comm -12 "$scratch/p/$i" "$scratch/p/$j" | head -1)" ] \
          || [ -n "$(comm -12 "$scratch/p/$i" "$scratch/p/a$j" | head -1)" ] \
          || [ -n "$(comm -12 "$scratch/p/a$i" "$scratch/p/$j" | head -1)" ]; then
          from=${grp[$j]}; to=${grp[$i]}; k=0
          while [ $k -lt "$nb" ]; do [ "${grp[$k]}" = "$from" ] && grp[$k]=$to; k=$((k + 1)); done
        fi
      fi
      j=$((j + 1))
    done
    i=$((i + 1))
  done
  j=${#defaults[@]}
  while [ "$j" -gt 0 ]; do
    j=$((j - 1))
    git apply -R --whitespace=nowarn "${defaults[$j]}" 2>/dev/null \
      || { echo "check-diffs: cannot reverse $(basename "${defaults[$j]}") to test the batches" >&2; exit 2; }
  done
  tested=" "; ngroups=0
  for g in $(for x in "${grp[@]}"; do echo "$x"; done | sort -un); do
    mem=(); i=0
    while [ $i -lt "$nb" ]; do [ "${grp[$i]}" = "$g" ] && mem+=("$i"); i=$((i + 1)); done
    k=${#mem[@]}; ngroups=$((ngroups + 1))
    if [ "$k" -gt 8 ]; then
      names=$(for i in "${mem[@]}"; do printf '%s ' "${bname[$i]}"; done)
      bad "$k batches edit shared files (${names% }), and every combination of them is applied; fix: at most 8 per group, so merge batches or move the shared edit into one batch they all name after \`after\`"
    fi
    m=1
    while [ $m -lt $((1 << k)) ]; do
      picked=""; want=""; b=0
      while [ $b -lt "$k" ]; do
        if [ $(((m >> b) & 1)) -eq 1 ]; then i=${mem[$b]}; picked="$picked+${bname[$i]}"; want="$want ${cl[$i]}"; fi
        b=$((b + 1))
      done
      m=$((m + 1))
      picked=${picked#+}
      key=$(for i in $want; do echo "$i"; done | sort -un | tr '\n' ',')
      case $tested in *" $key "*) continue ;; esac
      tested="$tested$key "
      list=$(for i in $(echo "$key" | tr ',' ' '); do for f in ${bdiffs[$i]}; do echo "$f"; done; done | sort)
      applied=()
      for f in $list; do
        if ! err=$(git apply --whitespace=nowarn "$plan_abs/diffs/$f" 2>&1); then
          names=$(for i in $(echo "$key" | tr ',' ' '); do printf '%s ' "${bname[$i]}"; done)
          echo "FAIL batches $picked: $f does not apply with only the batches ${names% } taken; fix: name the batch it needs after \`after\` on its line, or move the edit two batches share into one batch both name" >&2
          echo "$err" | sed 's/^/  /' >&2
          exit 1
        fi
        applied+=("$plan_abs/diffs/$f")
      done
      j=${#applied[@]}
      while [ "$j" -gt 0 ]; do
        j=$((j - 1))
        git apply -R --whitespace=nowarn "${applied[$j]}" || { echo "check-diffs: cannot reverse $(basename "${applied[$j]}")" >&2; exit 2; }
      done
    done
  done
  batches_note="; $nb batches apply alone and in every combination with the batches they name after ($ngroups groups that edit no file in common)"
fi
echo "check-diffs: $n diffs apply together at $sha$alone$batches_note"
