#!/bin/sh
# T1005 - vendor the pinned, licence-recorded runtime assets into ./backend/typst/.
#
# NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md (section 7)
#
# WHAT IT DOES
#   Populates two read-only bind-mount sources (policy 4.5):
#     backend/typst/toolchain/ -> /opt/typst         (the pinned typst binary)
#     backend/typst/fonts/     -> /opt/typst-fonts   (the closed font set, R14)
#   and stages the verified typst archive into backend/typst/typst-dist/ so that
#   `docker compose build typst-worker` is HERMETIC: the image build never needs
#   egress, and the exact archive that was digest-verified here is the one baked in.
#
#   backend/typst/packages/ is NOT populated: the spike vendors zero third-party
#   Typst Universe packages (see packages.lock). The first-party probe package under
#   packages/clearance/ is tracked in git and needs no fetching.
#
# EVERY DOWNLOAD IS SHA-256 VERIFIED BEFORE IT IS UNPACKED, against the digests
# recorded in LICENSES.md. A mismatch aborts; nothing is unpacked. This is the same
# guarantee the Dockerfile's own `sha256sum -c` gives, applied to the host-side copy
# so that both the bind-mounted toolchain and the baked-in toolchain are provably the
# same bytes.
#
# PRE-STAGED MODE (air-gapped / restricted-egress builders)
#   If the archives are already present in backend/typst/typst-dist/, they are used
#   and NOTHING is downloaded. That is the only supported way to build on a host whose
#   container network cannot reach the release CDN. Fetch them with whatever the host
#   has (browser, curl, PowerShell) into that directory, then run this script; it
#   still re-verifies every digest.
#
# USAGE (run from the repo root; the container needs only busybox)
#   docker run --rm -v "$(pwd)/backend/typst:/stage" alpine:3.20 \
#     sh /stage/fetch-assets.sh
#
#   Add network access on a host whose containers have egress:
#     docker run --rm -v "$(pwd)/backend/typst:/stage" alpine:3.20 \
#       sh -c "apk add --no-cache curl >/dev/null 2>&1; sh /stage/fetch-assets.sh"
#   (busybox wget is enough on its own; curl is only preferred when present.)
#
# EXIT CODES
#   0  every asset fetched/verified/extracted
#   1  a digest mismatched, a download failed, or a required file was absent

set -eu

STAGE="${STAGE:-/stage}"
DIST="$STAGE/typst-dist"
TOOLCHAIN="$STAGE/toolchain"
FONTS="$STAGE/fonts"

# --- THE PINS. These must match backend/typst/LICENSES.md, packages.lock, the
# --- Dockerfile ARGs, and backend/src/render/sandbox.ts TYPST_PIN exactly.
TYPST_VERSION="0.15.1"
TYPST_ASSET="typst-x86_64-unknown-linux-musl.tar.xz"
TYPST_SHA256="a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c"
# SHA-256 of the archive as published in the upstream release's own asset `digest`
# field, re-read from https://api.github.com/repos/typst/typst/releases on 2026-09-30.

FONT_ASSET="source-serif-4.005_Desktop.zip"
FONT_SHA256="549fdb8f9a682bd06944298621404969f6de77c2e422ff3b8244a1dcd6a0c425"
# Adobe Source Serif 4.005R, https://github.com/adobe-fonts/source-serif/releases/tag/4.005R
# Upstream publishes no `digest` field for this (pre-2024 asset), so the digest below
# was computed from the release asset and is the pin from here on.

TYPST_BASE="${TYPST_BASE:-https://github.com/typst/typst/releases/download/v${TYPST_VERSION}}"
FONT_BASE="${FONT_BASE:-https://github.com/adobe-fonts/source-serif/releases/download/4.005R}"

# Only these three faces are vendored. A closed font set is what makes two hosts with
# different installed fonts produce identical PDFs (policy 7.4, risk R14); vendoring
# the whole 16-family Source Serif distribution would be ~17 MB of surface for nothing.
FONT_FILES="SourceSerif4-Regular.ttf SourceSerif4-Semibold.ttf SourceSerif4-Bold.ttf"

log()  { printf '[fetch-assets] %s\n' "$*"; }
fail() { printf '[fetch-assets] FATAL: %s\n' "$*" >&2; exit 1; }

fetch() { # fetch <url> <dest>
  if [ -f "$2" ]; then
    log "using pre-staged $(basename "$2")"
    return 0
  fi
  log "downloading $1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1" || fail "download failed: $1"
  else
    wget -q -T 60 -O "$2" "$1" || fail "download failed: $1"
  fi
}

verify() { # verify <file> <expected-sha256> <label>
  actual="$(sha256sum "$1" | cut -d' ' -f1)"
  if [ "$actual" != "$2" ]; then
    fail "SHA-256 MISMATCH for $3
     expected $2
     actual   $actual
     Nothing was unpacked. This is either a corrupted download or an upstream asset
     swap. Investigate before re-running; do not relax the pin to make it pass."
  fi
  log "verified $3 ($actual)"
}

mkdir -p "$DIST" "$TOOLCHAIN" "$FONTS"

# --- 1. typst -----------------------------------------------------------------
fetch "$TYPST_BASE/$TYPST_ASSET" "$DIST/$TYPST_ASSET"
verify "$DIST/$TYPST_ASSET" "$TYPST_SHA256" "$TYPST_ASSET"

rm -rf "$TOOLCHAIN"/* 2>/dev/null || true
tar -xJf "$DIST/$TYPST_ASSET" -C "$TOOLCHAIN" --strip-components=1
[ -x "$TOOLCHAIN/typst" ] || [ -f "$TOOLCHAIN/typst" ] || fail "typst binary missing after extract"
chmod 0755 "$TOOLCHAIN/typst"
printf '%s\n' "$TYPST_VERSION" > "$TOOLCHAIN/PIN"
sha256sum "$TOOLCHAIN/typst" > "$TOOLCHAIN/PIN.sha256"
log "typst binary: $("$TOOLCHAIN/typst" --version 2>&1 || echo '(cannot exec here; run in the image)')"
log "typst binary sha256: $(cut -d' ' -f1 < "$TOOLCHAIN/PIN.sha256")"

# --- 2. fonts -----------------------------------------------------------------
fetch "$FONT_BASE/$FONT_ASSET" "$DIST/$FONT_ASSET"
verify "$DIST/$FONT_ASSET" "$FONT_SHA256" "$FONT_ASSET"

rm -rf "$FONTS"/* 2>/dev/null || true
TMPF="$(mktemp -d)"
unzip -q -o "$DIST/$FONT_ASSET" -d "$TMPF"
for f in $FONT_FILES; do
  src="$(find "$TMPF" -name "$f" -type f | head -n 1)"
  [ -n "$src" ] || fail "font face $f not found in $FONT_ASSET"
  cp "$src" "$FONTS/$f"
done
cp "$(find "$TMPF" -name LICENSE.md -type f | head -n 1)" "$FONTS/LICENSE.md"
chmod 0644 "$FONTS"/* 2>/dev/null || true
rm -rf "$TMPF"
log "fonts vendored: $FONT_FILES"

# --- 3. receipt ---------------------------------------------------------------
{
  printf 'typst.version=%s\n' "$TYPST_VERSION"
  printf 'typst.asset=%s\n' "$TYPST_ASSET"
  printf 'typst.asset.sha256=%s\n' "$TYPST_SHA256"
  printf 'typst.binary.sha256=%s\n' "$(cut -d' ' -f1 < "$TOOLCHAIN/PIN.sha256")"
  printf 'font.asset=%s\n' "$FONT_ASSET"
  printf 'font.asset.sha256=%s\n' "$FONT_SHA256"
  for f in $FONT_FILES; do
    printf 'font.%s.sha256=%s\n' "$f" "$(sha256sum "$FONTS/$f" | cut -d' ' -f1)"
  done
} > "$STAGE/typst-dist/RECEIPT"

log "receipt written to $STAGE/typst-dist/RECEIPT"
log "OK: toolchain and fonts are vendored, verified and ready to bind mount."
