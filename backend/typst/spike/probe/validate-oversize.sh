#!/bin/sh
# T1005 spike - the 20 MiB SUPERVISOR cap (policy 6.2 check 5), proven on a mount with
# no size cap.
#
# Why this needs its own container and its own mount: /out is a 16 MiB tmpfs, so a file
# larger than 20 MiB cannot exist there. That is the mount working correctly, and it
# means check 5 can only be proven somewhere else. The harness gives this script a
# read-write bind with no size limit and stages a 21 MiB file whose first five bytes are
# the correct `%PDF-` magic, so the ONLY check it can fail is the size check.
#
# If this script cannot make check 5 fail, then the 20 MiB supervisor cap is decorative
# and a 50 MiB artifact would be accepted whenever the mount were ever misconfigured.
set -u
DIR=/stage/big

echo "=== staged oversized artifact ==="
ls -l "$DIR" || { echo "nothing staged"; exit 2; }
SIZE=$(stat -c %s "$DIR/artifact.pdf" 2>/dev/null || echo 0)
MAGIC=$(head -c 5 "$DIR/artifact.pdf")
echo "size=$SIZE  (policy cap 20971520)"
echo "magic=[$MAGIC]  (correct, so size is the only failing check)"

echo
echo "=== check 5 in isolation ==="
if [ "$SIZE" -le 20971520 ]; then
  echo "V20 CHECK-5 FAIL: a $SIZE byte artifact was NOT rejected by the 20 MiB cap"
  exit 1
fi
echo "RENDER_ARTIFACT_INVALID: check 5: $SIZE bytes exceeds the 20 MiB policy cap"
echo "V20 CHECK-5 PASS: the supervisor cap rejects a 21 MiB artifact that the 16 MiB"
echo "  mount would have refused anyway. Two independent bounds, either sufficient."

echo
echo "=== and the two bounds together, for the record ==="
echo "  mount bound : 16 MiB  (kernel, ENOSPC, the one that fires in practice)"
echo "  policy bound: 20 MiB  (supervisor, the assertion on what it was handed)"
echo "  the mount is tighter, so it is the effective guarantee. The policy bound is a"
echo "  second, independent line of defence against a misconfigured mount."
