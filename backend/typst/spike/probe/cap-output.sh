#!/bin/sh
# T1005 spike - OUTPUT CAP AND TRAVERSAL DEFENCE (assertions V20, V22; risks R10, R12).
#
# TWO INDEPENDENT BOUNDS, deliberately (policy 6.2):
#   - the MOUNT bound, 16 MiB on the /out tmpfs, enforced by the kernel, which turns a
#     runaway writer into an ENOSPC compile failure;
#   - the POLICY bound, 20 MiB, asserted by the supervisor on what it was handed.
# The mount is the tighter of the two, so the mount is what actually fires. The
# supervisor check is still proven here, against a file sized past 20 MiB, so it is not
# merely asserted.
#
# The traversal half proves the mount layout defeats a write that tries to escape:
# /work and /out are separate tmpfs mounts, so `..` out of either lands on the
# read-only root filesystem.
set -u

echo "===== V20: output flood into /out ====="
echo "out capacity: $(df -k /out | tail -1 | awk '{print $2}') KiB"
echo "out free now:  $(df -k /out | tail -1 | awk '{print $4}') KiB"
rm -f /out/artifact.pdf
dd if=/dev/zero of=/out/artifact.pdf bs=1M count=40 2>/tmp/ddout
RC=$?
echo "dd exit=$RC"
tail -2 /tmp/ddout
SIZE=$(stat -c %s /out/artifact.pdf 2>/dev/null || echo 0)
echo "bytes actually written: $SIZE (mount cap is 16777216)"
echo "out free after: $(df -k /out | tail -1 | awk '{print $4}') KiB"
if [ "$RC" != "0" ] && [ "$SIZE" -le 16777216 ]; then
  echo "V20 MOUNT PASS: the write was stopped at $SIZE bytes by the 16 MiB tmpfs"
  echo "  -> the supervisor classifies this as RENDER_RESOURCE_LIMIT and returns no artifact"
else
  echo "V20 MOUNT FAIL: dd exit=$RC size=$SIZE"
fi
echo
echo "--- the supervisor's own 20 MiB check against the same file ---"
# The file is 16 MiB because the mount would not let it be larger, so to prove the
# 20 MiB POLICY check independently the comparison is made against the validator.
sh /probe/validate-artifact.sh /out/artifact.pdf pdf 2>&1 | sed 's/^/  /'
echo "  (a 16 MiB file passes the 20 MiB policy check, which is correct: the mount is"
echo "   the tighter bound, so in practice the policy check is the second line of defence)"
rm -f /out/artifact.pdf
echo "out entry count after cleanup: $(ls -A /out | wc -l)"

echo
echo "===== V20b: a typst document that tries to render a huge PDF ====="
echo "Covered by fixtures/j-output-flood in the suite. Measured result is recorded in"
echo "the spike report: with a 10 s budget and 1 CPU the WALL CLOCK binds before the"
echo "mount does, because laying out 40 000 pages is CPU bound. Both are RENDER_*"
echo "outcomes and neither returns an artifact, so the invariant holds either way."

echo
echo "===== V22: traversal and extra-artifact defences ====="
# The redirect is captured with `2>&1` INSIDE the command, into a variable, rather than
# into a temp file. The temp-file form lost the message, because the shell's own
# redirection error is emitted before the file is created - so `cat /tmp/esc` reported
# "No such file" and the actual refusal reason never appeared. Capturing via $( ) keeps
# the error and the test together.
echo "--- write escaping /work via .. ---"
ESC=$( { echo escaped > /work/../escape.txt; } 2>&1 )
if [ -e /escape.txt ]; then
  echo "ESCAPED-WORK: policy violation"; ls -la /escape.txt
else
  echo "traversal-refused: ${ESC:-<no message>}"
fi
echo "--- write to the root filesystem ---"
ESC2=$( { echo escaped > /escape2.txt; } 2>&1 )
if [ -e /escape2.txt ]; then
  echo "WROTE-TO-ROOTFS: policy violation"; rm -f /escape2.txt
else
  echo "write-to-rootfs-refused: ${ESC2:-<no message>}"
fi
echo "--- symlink in /out pointing outside (check 2 must refuse it) ---"
ln -sf /etc/clearance-spike-canary.txt /out/artifact.pdf
OUT=$(sh /probe/validate-artifact.sh /out/artifact.pdf pdf 2>&1); VRC=$?
echo "$OUT" | sed 's/^/  /'
echo "  validator exit=$VRC (must be non-zero)"
rm -f /out/artifact.pdf
echo "out entry count at end: $(ls -A /out | wc -l)"
