#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 GATALIFE LTD
# Spec 08 D9: build, sign, notarize, pack, publish and smoke the four npm packages from a clean tagged checkout on
# the owner's Mac (D1). A rerun resumes: packages already on the registry at this version are skipped (D10).
#
#   scripts/release.sh             the real release: needs the Developer ID identity in the login keychain, the
#                                  `catscan-notary` notarytool profile (D19) and `npm login` with 2FA
#   scripts/release.sh --dry-run   steps 1-4 only: no signing, no notarization, no publishing; an untagged HEAD is
#                                  allowed, so the self-hosted runner can run it
set -euo pipefail

IDENTITY="Developer ID Application: GATALIFE LTD (JK3T6SMS5W)"
TEAM_ID="JK3T6SMS5W"
NOTARY_PROFILE="catscan-notary"
MIN_MACOS="15.0" # spec 00
SIZE_BUDGET=$((10 * 1024 * 1024))
PACKAGES=(cli-darwin-arm64 core-js cli mcp playwright) # publish order (D10)

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: scripts/release.sh [--dry-run]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
say() { echo "release: $*"; }
die() { echo "release: $*" >&2; exit 1; }
VERSION="$(tr -d '[:space:]' < VERSION)"
BIN_DIR="packages/cli-darwin-arm64/bin"
BIN_DEST="$BIN_DIR/catscan-core"
OUT=".build/release-packs"
ZIPDIR=""
# The copied binary exists only for packing; a checkout always runs core/.build (spec 08 D5).
trap 'rm -rf "$BIN_DIR"; [ -z "$ZIPDIR" ] || rm -rf "$ZIPDIR"' EXIT

say "step 1: checkout, tag and versions for $VERSION"
[ -z "$(git status --porcelain)" ] || die "the checkout is not clean - try: commit or stash, then rerun"
TAG="$(git describe --exact-match --tags HEAD 2>/dev/null || true)"
# Spec 25 D19: npm publishes before the land, so the files that will land are checked here; the real run needs the
# private name list, the dry run on the runner prints a notice without it (D17).
NAMES=required
[ "$DRY_RUN" = 0 ] || NAMES=if-available
node scripts/check-private.mjs --allowlist --names="$NAMES" \
  || die "private-data check failed - try: set CATSCAN_PRIVATE_NAMES_FILE, fix the finding in the lab, then tag a new version"
# TODO-027 D4, D9: audited when the release is cut, not only when its PR's CI ran (an advisory can be newer).
node scripts/check-audit.mjs \
  || die "npm audit check failed - try: for audit-high or audit-critical-dev, fix it on main in its own PR, then cut a new release commit and tag; for audit-unavailable, rerun scripts/release.sh"
if [ "$DRY_RUN" = 1 ]; then
  [ "$TAG" = "v$VERSION" ] || say "HEAD is not tagged v$VERSION; a real run refuses this"
  node scripts/release-lib.mjs on-main 2>/dev/null || say "HEAD is not on origin/main; a real run refuses this"
  node scripts/release-lib.mjs versions || die "release metadata check failed - try: fix each problem printed above (versions, server.json, repository fields)"
else
  [ "$(uname -m)" = "arm64" ] || die "the release builds on Apple silicon"
  node scripts/release-lib.mjs versions "$TAG" || die "release metadata or tag check failed - try: fix each problem printed above, or git tag v$VERSION on the release commit"
  git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main
  node scripts/release-lib.mjs on-main || die "HEAD is not on origin/main - try: merge the release PR, then tag its commit on main"
fi

say "step 2: swift build -c release --arch arm64"
swift build -c release --arch arm64 --package-path core
BUILT="$(swift build -c release --arch arm64 --package-path core --show-bin-path)/catscan-core"
# The bin folder is gitignored and packed whole: start it empty so nothing stale ships (review).
rm -rf "$BIN_DIR"
mkdir -p "$BIN_DIR"
cp "$BUILT" "$BIN_DEST"
chmod 755 "$BIN_DEST"
vtool -show-build "$BIN_DEST" | node scripts/release-lib.mjs minos "$MIN_MACOS"
[ "$(lipo -archs "$BIN_DEST")" = "arm64" ] || die "catscan-core is not arm64 only: $(lipo -archs "$BIN_DEST")"
[ "$("$BIN_DEST" version --json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).catscan)')" = "$VERSION" ] \
  || die "catscan-core does not report $VERSION - try: check catscanVersion in core/Sources"

if [ "$DRY_RUN" = 1 ]; then
  say "step 3: skipped (--dry-run: no signing or notarization)"
else
  say "step 3: sign, verify, notarize"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$BIN_DEST"
  codesign --verify --strict "$BIN_DEST"
  TEAM="$(codesign -dv --verbose=2 "$BIN_DEST" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  [ "$TEAM" = "$TEAM_ID" ] || die "signed with team $TEAM, not $TEAM_ID"
  ZIPDIR="$(mktemp -d)"
  ZIP="$ZIPDIR/catscan-core.zip"
  ditto -c -k --keepParent "$BIN_DEST" "$ZIP"
  NOTARY="$(xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json)"
  STATUS="$(printf '%s' "$NOTARY" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8")).status))')"
  if [ "$STATUS" != "Accepted" ]; then
    ID="$(printf '%s' "$NOTARY" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8")).id))')"
    die "notarization status $STATUS - try: xcrun notarytool log $ID --keychain-profile $NOTARY_PROFILE"
  fi
  # The ticket cannot be stapled to a bare binary, so spctl looks it up online; it can lag the Accepted status.
  for i in 1 2 3 4 5 6 7 8 9 10; do
    ASSESS="$(spctl --assess -vv --type open --context context:primary-signature "$BIN_DEST" 2>&1 || true)"
    if printf '%s\n' "$ASSESS" | node scripts/release-lib.mjs notarized; then break; fi
    [ "$i" = 10 ] && die "spctl does not report source=Notarized Developer ID - try: rerun in a few minutes"
    sleep 30
  done
  say "signed and notarized ($TEAM)"
fi
# The exact binary that ships must pass its own self-test before anything is packed or published (review).
"$BIN_DEST" doctor | node scripts/release-lib.mjs self-test || die "the binary to ship fails its catscan-core doctor self-test"

say "step 4: npm pack into $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
# TODO-059 D24: the published core-js carries the behavior changes from the first public version on, as the landed
# CHANGELOG does; the lab file is restored after packing.
BC="packages/core-js/behavior-changes.json"
FIRST="$(sed -nE "s/^export const FIRST_PUBLIC_VERSION *= *['\"]([0-9]+\.[0-9]+\.[0-9]+)['\"].*/\1/p" scripts/check-internal.mjs)"
cp "$BC" "$OUT/.behavior-changes.lab.json"
node scripts/release-lib.mjs behavior-changes --public "$BC" --first-public "${FIRST:-$VERSION}" || die "could not trim $BC to the public versions"
for p in "${PACKAGES[@]}"; do npm pack --silent --pack-destination "$OUT" "./packages/$p" > /dev/null || { cp "$OUT/.behavior-changes.lab.json" "$BC"; die "npm pack ./packages/$p failed"; }; done
cp "$OUT/.behavior-changes.lab.json" "$BC" && rm "$OUT/.behavior-changes.lab.json"
BIN_TGZ="$OUT/catscan-cli-darwin-arm64-$VERSION.tgz"
SIZE="$(stat -f %z "$BIN_TGZ")"
[ "$SIZE" -lt "$SIZE_BUDGET" ] || die "$BIN_TGZ is $SIZE bytes, over the 10 MB budget"
tar -tzf "$BIN_TGZ" | node scripts/release-lib.mjs pack-files || die "$BIN_TGZ must hold exactly package.json and bin/catscan-core"
ls -l "$OUT"

if [ "$DRY_RUN" = 1 ]; then
  say "dry run ok: $VERSION built and packed, binary tarball $SIZE bytes; nothing signed or published"
  exit 0
fi

# The tag goes out before any package, so the registry never holds a version the repo has no tag for (review).
git push origin "v$VERSION" || die "the tag v$VERSION could not be pushed - try: git push origin v$VERSION, then rerun"

say "step 5: publish in order ${PACKAGES[*]}"
published() { [ "$(npm view "$1@$VERSION" version 2>/dev/null || true)" = "$VERSION" ]; }
for p in "${PACKAGES[@]}"; do
  name="@catscan/$p"
  if published "$name"; then say "$name@$VERSION is already published, skipped"; continue; fi
  npm publish --access public "$OUT/catscan-$p-$VERSION.tgz"
  # The next package depends on this one: wait until the registry serves it (D10).
  for i in $(seq 1 60); do
    published "$name" && break
    [ "$i" = 60 ] && die "$name@$VERSION is not on the registry after 10 minutes - try: rerun scripts/release.sh"
    sleep 10
  done
  say "$name@$VERSION published"
done

say "step 6: registry smoke"
node scripts/release-smoke.mjs "$VERSION"

# D17: the placeholder is deprecated once a real release exists.
if [ -z "$(npm view @catscan/cli@0.0.4 deprecated 2>/dev/null || true)" ]; then
  say "reminder: deprecate the placeholder - try: npm deprecate @catscan/cli@0.0.4 \"placeholder, use latest\""
fi
say "released $VERSION"
