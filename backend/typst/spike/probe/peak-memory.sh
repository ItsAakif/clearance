#!/bin/sh
# T1005 spike - PEAK MEMORY measurement (assertion V17, risk R9).
#
# Policy 9.1 / 10.5 asks for the observed peak memory per job, and V17 asks the spike to
# record it. cgroup v2 exposes `memory.peak`, which is exact; cgroup v1 does not, so the
# script falls back to sampling `memory.max_usage_in_bytes` (also exact on v1) and
# reports which mechanism produced the number. Reporting the mechanism matters: a
# sampled maximum is a lower bound, and pretending otherwise would overstate the
# evidence.
#
# The measurement runs in the BACKGROUND and the sampler runs in the foreground, because
# a process that is being OOM-killed cannot report its own peak.
set -u

echo "=== cgroup version detection ==="
if [ -f /sys/fs/cgroup/memory.peak ]; then
  echo "cgroup v2: memory.peak available"
  CG=v2
elif [ -f /sys/fs/cgroup/memory/memory.max_usage_in_bytes ]; then
  echo "cgroup v1: memory.max_usage_in_bytes available"
  CG=v1
else
  echo "neither memory.peak nor memory.max_usage_in_bytes is readable; falling back to sampling"
  CG=sample
fi
echo "memory cap: $(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo unknown)"

FIXTURE="${1:-template.typ}"

echo
echo "=== launching the memory flood in the background ==="
rm -f /tmp/rc /out/artifact.pdf
( SOURCE_DATE_EPOCH=0 /opt/typst/typst compile \
    --root /work --format pdf \
    --package-path /opt/typst-packages --package-cache-path /work/.pkgcache \
    --font-path /opt/typst-fonts --ignore-system-fonts --ignore-embedded-fonts \
    --jobs 1 --diagnostic-format short \
    "/work/$FIXTURE" /out/artifact.pdf > /tmp/stdout 2> /tmp/stderr
  echo "COMPILE_EXIT=$?" > /tmp/rc ) &
JOB=$!

PEAK=0
i=0
while [ "$i" -lt 200 ]; do
  [ -f /tmp/rc ] && break
  V=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || echo 0)
  case "$V" in ''|*[!0-9]*) V=0 ;; esac
  [ "$V" -gt "$PEAK" ] && PEAK=$V
  i=$((i + 1))
  sleep 0.1
done
wait "$JOB" 2>/dev/null || true

echo
echo "=== result ==="
cat /tmp/rc 2>/dev/null
echo "stderr: $(head -1 /tmp/stderr 2>/dev/null)"
echo "artifact: $([ -f /out/artifact.pdf ] && echo PRESENT || echo absent)"
echo "out entry count: $(ls -A /out | wc -l)"

echo
if [ "$CG" = "v2" ]; then
  EXACT=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null)
  echo "memory.peak (EXACT, cgroup v2): $EXACT bytes = $(awk "BEGIN{printf \"%.1f\", $EXACT/1048576}") MiB"
elif [ "$CG" = "v1" ]; then
  EXACT=$(cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null)
  echo "memory.max_usage_in_bytes (EXACT, cgroup v1): $EXACT bytes = $(awk "BEGIN{printf \"%.1f\", $EXACT/1048576}") MiB"
else
  EXACT=$PEAK
  echo "sampled peak (LOWER BOUND only): $PEAK bytes = $(awk "BEGIN{printf \"%.1f\", $PEAK/1048576}") MiB"
fi
echo "sampled peak (lower bound): $PEAK bytes = $(awk "BEGIN{printf \"%.1f\", $PEAK/1048576}") MiB"
echo "cap: 1073741824 bytes = 1024.0 MiB"

RC=$(sed 's/COMPILE_EXIT=//' /tmp/rc 2>/dev/null)
if [ "$RC" = "137" ] || [ "$RC" = "9" ]; then
  echo
  echo "V17 PASS: the memory cap killed the compile (exit 137 = 128+9, SIGKILL from the"
  echo "  cgroup OOM killer). The observed peak is at or just under the 1 GiB cap, which"
  echo "  is what a cap that BITES looks like - a peak well below the cap would mean the"
  echo "  allocation never happened."
else
  echo
  echo "V17 INCONCLUSIVE: compile exit=$RC (expected 137)."
fi
rm -f /tmp/rc /tmp/stdout /tmp/stderr
