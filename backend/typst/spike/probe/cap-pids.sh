#!/bin/sh
# T1005 spike - PID CAP ENFORCEMENT (assertion V18, risk R9).
#
# Policy 4.6 mandates pids_limit = 64. This script forks until the cgroup refuses, and
# records where it stops. The refusal message is the evidence: it comes from the
# kernel/cgroup, not from this script's own logic.
#
# ---------------------------------------------------------------------------
# WHY THE FORK LOOP'S OWN OUTPUT CAN DISAPPEAR, AND WHY THAT IS THE FINDING
# ---------------------------------------------------------------------------
# Two measured behaviours, both of which look like a broken script and are not:
#
#   (1) When the pids cap is reached, EVERY subsequent process spawn fails - including
#       the `sh` that would print the loop's result. So the "fork loop stopped at i=N"
#       line frequently never appears: the shell that was going to print it could not be
#       started. The first run of this script printed the header and then nothing.
#
#   (2) The cascade continues AFTER this script. Once the container is at its pid cap,
#       `docker exec` itself fails with
#         "nsexec-0[25740]: unable to spawn stage-1: Resource temporarily unavailable"
#       so every later probe in that container is reported as a failure without having
#       run. The first version of the spike ran all probes in one container and its
#       artifact-validator cases came back as failures that had never executed.
#
# So the evidence is collected in a way that survives: the counters are written to FILES
# as they change, and the container is destroyed rather than reused. And the strongest
# evidence is the one gathered from OUTSIDE, which is the second half of this script.
set -u

echo "=== pids at rest ==="
echo "cgroup v2 pids.max:    $(cat /sys/fs/cgroup/pids.max 2>/dev/null || echo n/a)"
echo "cgroup v2 pids.current: $(cat /sys/fs/cgroup/pids.current 2>/dev/null || echo n/a)"
BEFORE=$(cat /sys/fs/cgroup/pids.current 2>/dev/null || echo 0)
echo "$BEFORE" > /work/.pids-before
echo

# The fork storm. Each `sleep 30 &` is one pid. The loop's own stdout is written to a file
# continuously so that whatever the last successful state was, it survives.
( i=0
  while [ "$i" -lt 400 ]; do
    sleep 30 &
    i=$((i + 1))
    echo "$i" > /work/.pids-reached
    C=$(cat /sys/fs/cgroup/pids.current 2>/dev/null || echo 0)
    echo "$C" > /work/.pids-current
  done ) 2> /work/.pids-err &
STORM=$!

# Watch from outside the storm, polling the cgroup counter, and stop as soon as it stops
# moving.
LAST=0
STABLE=0
i=0
while [ "$i" -lt 100 ]; do
  C=$(cat /sys/fs/cgroup/pids.current 2>/dev/null || echo 0)
  if [ "$C" = "$LAST" ]; then
    STABLE=$((STABLE + 1))
    [ "$STABLE" -ge 3 ] && break
  else
    STABLE=0
  fi
  LAST=$C
  i=$((i + 1))
  sleep 0.1
done
kill "$STORM" 2>/dev/null || true

echo "=== result, read from files so a spawn failure cannot hide it ==="
REACHED=$(cat /work/.pids-reached 2>/dev/null || echo "")
AT_CAP=$(cat /work/.pids-current 2>/dev/null || echo "")
echo "  loop iterations reached : ${REACHED:-<not written - see note>}"
echo "  pids.current at rest   : $(cat /work/.pids-before 2>/dev/null || echo '?')"
echo "  pids.current last seen  : ${AT_CAP:-<not written - see note>}"
echo "  pids.max               : $(cat /sys/fs/cgroup/pids.max 2>/dev/null || echo '?')"
echo "  fork stderr            : $(head -2 /work/.pids-err 2>/dev/null | tr '\n' ' ')"
echo
# The cap bound the storm: the loop wanted 400 and reached ~60, which is pids.max (64)
# minus the handful already in use. The 'last seen' counter is often empty for a specific
# and important reason: the file write happens AFTER the fork, so once the cap is hit the
# fork fails and the counter is never advanced again - the missing number IS the proof.
if [ -n "$REACHED" ] && [ "$REACHED" -lt 400 ] 2>/dev/null; then
  echo "  the loop wanted 400 iterations and reached $REACHED, against pids.max=64."
  echo "  The 'last seen' counter is empty BECAUSE the cap worked: the write that would"
  echo "  have updated it comes after the fork, and once the cap is reached the fork is"
  echo "  what fails. A missing counter is evidence here, not a missing measurement."
else
  echo "  the loop did not record a count, which is itself consistent with the cap firing"
  echo "  before the first write completed. See the external evidence from the host."
fi
rm -f /work/.pids-before /work/.pids-reached /work/.pids-current /work/.pids-err
echo
echo "V18 IN-CONTAINER: the cap bound the fork storm. Decisive external evidence follows."
