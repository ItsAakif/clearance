# T1005 spike - post-compile observation. Reports every fact the verification
# checklist needs from inside the container, in one place, so the transcript of a run
# is a single coherent record rather than an accumulation of ad-hoc commands.
#
# Note on the `docker cp` constraint documented in harness.ps1: this script prints the
# artifact's digest, size and magic bytes INSIDE the container, because copying a file
# out of a read-only-rootfs container is not possible via `docker cp`. The supervisor
# in T1040 will need the same answer; the reading here is that artifact extraction must
# happen through an exec-based channel rather than `docker cp`.
echo "--- /out (policy 6.3 checks 1-3) ---"
ls -la /out
echo "entry-count=$(ls -A /out | wc -l)"

echo "--- /work after compile (policy 3.3: root carries only what this job needs) ---"
ls -A /work

echo "--- package cache entry count (V10: must be 0) ---"
ls -A /work/.pkgcache 2>/dev/null | wc -l

echo "--- artifact digest / size / magic bytes (policy 6.3 checks 1, 2, 5, 6) ---"
if [ -f /out/artifact.pdf ]; then
  sha256sum /out/artifact.pdf
  stat -c '%s bytes' /out/artifact.pdf
  printf 'magic='
  head -c 5 /out/artifact.pdf | od -c | head -1
  if [ -L /out/artifact.pdf ]; then echo 'ARTIFACT-IS-SYMLINK'; else echo 'artifact-is-regular-file'; fi
else
  echo 'NO ARTIFACT'
fi

echo "--- canary presence in the artifact (must be absent) ---"
if [ -f /out/artifact.pdf ]; then
  if grep -ac CLEARANCE_CANARY_7f3a91c4 /out/artifact.pdf 2>/dev/null; then :; fi
  if grep -q CLEARANCE_CANARY_7f3a91c4 /out/artifact.pdf 2>/dev/null; then
    echo 'CANARY-PRESENT-IN-ARTIFACT'
  else
    echo 'canary-absent-from-artifact'
  fi
else
  echo 'no artifact to inspect'
fi

echo "--- A4 page geometry (V2) ---"
if [ -f /out/artifact.pdf ]; then
  strings /out/artifact.pdf | grep -a MediaBox | head -1
  echo "page-objects=$(strings /out/artifact.pdf | grep -ac '/Type */Page[^s]')"
fi
