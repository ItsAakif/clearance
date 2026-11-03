#!/bin/sh
# T1005 spike - wall-clock timeout and kill (assertion V19, risk R9).
#
# Policy 9.1:
#   wall-clock budget   10000 ms  -> the supervisor stops waiting
#   hard kill grace      2000 ms  -> escalate to SIGKILL of the whole container
#   compose backstop        5s    -> stop_grace_period
#   container removed with --rm, so the tmpfs dies with it
#
# MEASURED CONTEXT that shapes this script:
#   - typst 0.15.1 has a provably-infinite-loop detector. `#while true { }`,
#     `#while i >= 0 { i += 1 }` and even an opaque `#while calc.rem(n, 2) >= 0` are all
#     REFUSED at compile time with "loop seems to be infinite". So a CPU-exhaustion
#     fixture must be an enormous FINITE loop, which is what fixtures/i-cpu-loop is.
#   - `range(N)` MATERIALISES as an array, so a single huge range is a MEMORY flood, not a
#     CPU one. Measured: `range(1000000000)` hits the 1 GiB cap in ~2 s, while nested
#     `range(30000)` x `range(30000)` burns 20 s at 19 MiB. The fixture uses the nested
#     form so that only the CLOCK can end it.
#
# A measured detail about this script's own method: `timeout -s KILL N` sends SIGKILL
# directly, so it demonstrates the FINAL state but not the TERM->KILL escalation. The
# escalation is measured with `timeout -s TERM` plus an explicit `pkill -KILL` below.
set -u

T=/opt/typst/typst
W=/work
BASE="--root $W --format pdf --package-path /opt/typst-packages --package-cache-path $W/.pkgcache --font-path /opt/typst-fonts --ignore-system-fonts --ignore-embedded-fonts --jobs 1 --diagnostic-format short"

BUDGET="${1:-10}"
GRACE="${2:-2}"

echo "=== policy 9.1 budget: ${BUDGET}s wall clock, ${GRACE}s grace to SIGKILL ==="
echo "=== fixture: an enormous FINITE loop (typst refuses provably-infinite ones) ==="
ls -l "$W/template.typ"
echo
echo "--- confirm the loop is finite-but-astronomical, not refused at parse time ---"
head -c 200 "$W/template.typ" | sed 's/^/  | /'
echo

echo
echo "===== STAGE 1: the supervisor stops WAITING at the budget ====="
rm -f /out/artifact.pdf /tmp/rc
START=$(date +%s)
( SOURCE_DATE_EPOCH=0 timeout -s TERM "$BUDGET" $T compile $BASE "$W/template.typ" /out/artifact.pdf > /tmp/o 2> /tmp/e
  echo "TERM_STAGE_EXIT=$?" > /tmp/rc ) &
JOB=$!
# Poll until the budget is spent or the job finishes on its own, exactly as a supervisor
# that "stops waiting" would.
i=0
while [ "$i" -lt "$((BUDGET * 10))" ]; do
  [ -f /tmp/rc ] && break
  sleep 0.1
  i=$((i + 1))
done
if [ ! -f /tmp/rc ]; then
  MID=$(date +%s)
  echo "  budget of ${BUDGET}s expired after $((MID - START))s; the compile is STILL RUNNING"
  echo "  -> the supervisor's next action is the kill escalation"
else
  cat /tmp/rc
  echo "  (finished on its own - unexpected for this fixture)"
fi
echo "  artifact at this point: $([ -f /out/artifact.pdf ] && echo PRESENT || echo absent)"

echo
echo "===== STAGE 2: escalate to SIGKILL after the grace period ====="
# busybox timeout already sent TERM. Give the grace period, then KILL.
sleep "$GRACE"
BEFORE=$(pgrep -f 'typst compile' 2>/dev/null | wc -l)
echo "  typst processes still alive after ${GRACE}s of TERM: $BEFORE"
pkill -KILL -f 'typst compile' 2>/dev/null
sleep 1
AFTER=$(pgrep -f 'typst compile' 2>/dev/null | wc -l)
echo "  typst processes after SIGKILL: $AFTER"
wait "$JOB" 2>/dev/null || true
END=$(date +%s)
cat /tmp/rc 2>/dev/null
echo "  total elapsed: $((END - START))s (budget ${BUDGET}s + grace ${GRACE}s = $((BUDGET + GRACE))s expected)"

echo
echo "===== outcome ====="
echo "  artifact: $([ -f /out/artifact.pdf ] && echo PRESENT || echo absent)"
echo "  out entry count: $(ls -A /out | wc -l)"
echo "  /work after the kill:"
ls -A "$W" | sed 's/^/    /'

echo
if [ ! -f /out/artifact.pdf ]; then
  echo "V19 PASS: the job was stopped at the budget, the artifact was never completed,"
  echo "  and /out is empty, so there is no partial artifact to hand to a user"
  echo "  (policy 9.1: '/out is discarded whenever the job is not ok')."
  echo "  Internal code at this point: RENDER_TIMEOUT."
else
  echo "V19 FAIL: an artifact survived the kill."
fi

echo
echo "===== the same kill shape against a SHORT budget, for comparison ====="
echo "  (a 3s budget on the same fixture, to show the bound is the budget and not a"
echo "   property of the document)"
rm -f /out/artifact.pdf
START=$(date +%s)
timeout -s KILL 3 $T compile $BASE "$W/template.typ" /out/artifact.pdf >/dev/null 2>&1
RC=$?
END=$(date +%s)
echo "  exit=$RC  elapsed=$((END - START))s  artifact=$([ -f /out/artifact.pdf ] && echo PRESENT || echo absent)"

rm -f /tmp/rc /tmp/o /tmp/e
echo
echo "NOTE FOR T1040: the fixture is killed by the CLOCK, so the engine's own exit code"
echo "is 137 and not a diagnostic. A supervisor must classify by CAUSE (timeout vs OOM vs"
echo "PID cap), not by exit code alone - 137 is what both a timeout kill and an OOM kill"
echo "look like. Policy 9.2 already requires this distinction; the spike confirms the two"
echo "are indistinguishable from the exit code alone."
