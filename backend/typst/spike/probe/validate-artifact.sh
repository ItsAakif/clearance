# T1005 spike - single-artifact validation (policy 6.3, all six checks in order).
#
# The policy requires the supervisor to validate the artifact BEFORE trusting it, and
# to construct the path itself rather than trusting any path that came back from inside
# the container. This script is the spike's implementation of that validator, used to
# check the positive artifact and to prove the validator REJECTS each of the planted
# corruptions.
#
#   1. lstat(/out/artifact.pdf) succeeds
#   2. lstat().isFile() and NOT isSymbolicLink()   - lstat, not stat: a symlink must be
#      refused, never followed
#   3. the directory listing of /out contains EXACTLY ONE entry, and it is artifact.pdf
#   4. realpath is a prefix-match on /out/ after normalisation, so `..` and a symlinked
#      parent cannot move the target
#   5. size <= 20 MiB
#   6. magic bytes match the declared format: %PDF- for pdf
#
# Exit 0 = the artifact is acceptable. Exit 1 = RENDER_ARTIFACT_INVALID.
set -u
ART="${1:-/out/artifact.pdf}"
FMT="${2:-pdf}"
fail() { echo "RENDER_ARTIFACT_INVALID: $*"; exit 1; }

echo "=== validating $ART (format=$FMT) ==="

# 1. lstat succeeds
[ -e "$ART" ] || fail "check 1: lstat failed, no artifact"
if [ -L "$ART" ]; then fail "check 2: artifact is a SYMLINK (lstat, not stat)"; fi
echo "check 1 lstat: ok"

# 2. regular file
[ -f "$ART" ] || fail "check 2: not a regular file"
echo "check 2 is-regular-file-and-not-symlink: ok"

# 3. EXACTLY ONE entry in /out, and it is the artifact
COUNT=$(ls -A /out | wc -l)
ENTRY=$(ls -A /out | head -1)
echo "check 3 out-entry-count=$COUNT entry=$ENTRY"
[ "$COUNT" = "1" ] || fail "check 3: /out has $COUNT entries, expected exactly 1 (extra: $(ls -A /out | tr '\n' ' '))"
[ "$ENTRY" = "$(basename "$ART")" ] || fail "check 3: /out contains '$ENTRY', not the expected artifact name"

# 4. realpath prefix-match on /out/
REAL=$(readlink -f "$ART")
REALTMP=$(readlink -f /out)
echo "check 4 realpath=$REAL out-realpath=$REALTMP"
case "$REAL" in
  "$REALTMP"/*) echo "check 4 prefix-match: ok" ;;
  *) fail "check 4: realpath $REAL is not inside $REALTMP (traversal or symlinked parent)" ;;
esac

# 5. size cap
SIZE=$(stat -c %s "$ART")
echo "check 5 size=$SIZE cap=20971520"
[ "$SIZE" -le 20971520 ] || fail "check 5: $SIZE bytes exceeds the 20 MiB policy cap"

# 6. magic bytes
MAGIC=$(head -c 5 "$ART")
echo "check 6 magic=[$MAGIC]"
case "$FMT" in
  pdf) [ "$MAGIC" = "%PDF-" ] || fail "check 6: expected %PDF-, got [$MAGIC]" ;;
  png) HEX=$(head -c 8 "$ART" | od -An -tx1 | tr -d ' \n'); [ "$HEX" = "89504e470d0a1a0a" ] || fail "check 6: bad PNG magic $HEX" ;;
  svg) [ "${MAGIC:0:4}" = "<svg" ] || fail "check 6: expected <svg, got [$MAGIC]" ;;
  *) fail "check 6: unknown format $FMT" ;;
esac

echo "ALL SIX CHECKS PASSED"
exit 0
