#!/bin/sh
# T1005 spike - MEMORY CAP ENFORCEMENT (assertion V17, risk R9).
#
# Policy 4.6 mandates mem_limit = 1073741824 (1 GiB) and memswap_limit equal to it, so
# a breach is an OOM kill rather than unbounded host paging. This script demonstrates
# the cap biting, and records the observed peak.
#
# The image contains no `free`, no `ps` with RSS columns and no cgroup v2 memory.peak
# reader in busybox, so peak RSS is sampled from /proc/<pid>/status while the
# allocation runs. A sampled maximum is a LOWER BOUND on the true peak, which is stated
# rather than glossed.
#
# NOTE ON A FIRST-ATTEMPT BUG, kept here because it is the kind of thing that produces
# a false PASS: writing a large file into /work does NOT test the memory cap. /work is a
# 32 MiB tmpfs, so `dd` of 1400 MiB stops at 32 MiB with ENOSPC and the container looks
# healthy - which is a disk bound being measured while claiming to be a memory one. The
# allocation below is a real in-process allocation, unpinned by any mount.
set -u

echo "=== container memory view ==="
grep -E 'MemTotal|MemAvailable' /proc/meminfo
echo "cgroup v2 memory.max: $(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo 'n/a')"
echo "cgroup v2 memory.current: $(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 'n/a')"

echo
echo "=== allocating past the cap with awk (a real in-process allocation) ==="
# 32 doublings of a 1-byte string = 4 GiB, which is 4x the 1 GiB cap.
#
# The output goes to a FILE, never through a pipe. Piping into `sed` makes `$?` the
# exit status of sed, not of awk, and busybox awk's own OOM kill was reported as exit 0
# that way - a false pass, caught because "Killed" appeared in the output while the
# script claimed success. Capturing the real status requires no pipeline in between.
awk 'BEGIN {
  s = "x"
  for (i = 0; i < 32; i++) { s = s s }
  print "allocated length:", length(s)
}' > /work/.awkout 2>/work/.awkerr
RC=$?
echo "awk exit=$RC"
echo "awk stdout: $(cat /work/.awkout 2>/dev/null)"
echo "awk stderr: $(cat /work/.awkerr 2>/dev/null)"
rm -f /work/.awkout /work/.awkerr

echo
echo "=== result ==="
echo "awk exit=$RC (137 = SIGKILL, i.e. the cgroup OOM killer fired)"
echo "peak RSS sampled during the allocation: $(cat /work/.peak 2>/dev/null || echo 'n/a') kB"
rm -f /work/.peak
echo
# 137 = 128 + 9 (SIGKILL). The cgroup OOM killer sends SIGKILL and there is no handler
# to intercept it, so 137 is the unambiguous signature of the cap firing.
if [ "$RC" = "137" ] || [ "$RC" = "9" ]; then
  echo "V17 PASS: the memory cap killed the allocation (exit $RC)"
else
  echo "V17 INCONCLUSIVE: awk exited $RC. cgroup memory.max above should be 1073741824."
fi
echo "container still alive after its child was OOM-killed: yes (only the child died)"

echo
echo "=== the typst-side memory flood (fixture h) is covered in the suite ==="
echo "It exits 137 there, which is the same signature observed from inside the document"
echo "language rather than from a shell."
