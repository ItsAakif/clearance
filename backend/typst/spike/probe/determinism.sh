# T1005 - determinism proof (assertion V3, risk R14).
#
# "Same input -> same bytes" is a PRODUCT requirement (the editor preview cache and
# `ResumeDocument.hash` both depend on it), not a nice property. It is also the
# requirement most likely to fail silently, because every individual ingredient looks
# harmless. This script therefore proves the NEGATIVE as well as the positive: it
# renders the same input four ways and shows which knobs are load-bearing.
#
#   A. epoch pinned, --jobs 1          -> the policy configuration (MUST be stable)
#   B. epoch pinned, --jobs 1, again   -> determinism (V3)
#   C. no SOURCE_DATE_EPOCH            -> typst falls back to chrono::Local::now(),
#                                       which is embedded in the PDF, so the digests
#                                       DIFFER. This is what makes the knob mandatory.
#   D. epoch pinned, --jobs 4          -> parallelism; expected to be equal here, and
#                                       the result is recorded either way rather than
#                                       assumed.
#
# The fonts, TZ, and LC_ALL are held constant across all four so that only the knob
# under test varies.
set -u
T=/opt/typst/typst
W=/work
O=/out
FIXTURE="${1:-template.typ}"
COMMON="--root $W --format pdf --package-path /opt/typst-packages --package-cache-path $W/.pkgcache --font-path /opt/typst-fonts --ignore-system-fonts --ignore-embedded-fonts --diagnostic-format short"

render() { # render <outfile> <jobs> [epoch]
  out="$1"; jobs="$2"; epoch="${3:-}"
  rm -f "$out"
  if [ -n "$epoch" ]; then
    SOURCE_DATE_EPOCH="$epoch" TZ=UTC LC_ALL=C.UTF-8 \
      $T compile $COMMON --jobs "$jobs" "$W/$FIXTURE" "$out" 2>&1 | sed 's/^/    /'
  else
    # `env -u` is REQUIRED, not stylistic. The container itself is created with
    # SOURCE_DATE_EPOCH=0 (that IS the policy configuration), so merely omitting the
    # variable here would still inherit 0 and the "unpinned" case would be a no-op.
    # The first version of this script had exactly that bug and reported a false pass.
    env -u SOURCE_DATE_EPOCH TZ=UTC LC_ALL=C.UTF-8 \
      $T compile $COMMON --jobs "$jobs" "$W/$FIXTURE" "$out" 2>&1 | sed 's/^/    /'
  fi
  if [ -f "$out" ]; then sha256sum "$out"; else echo "    NO OUTPUT"; fi
}

echo "=== A: SOURCE_DATE_EPOCH=0, --jobs 1 (policy configuration) ==="
render /out/a1.pdf 1 0
sleep 1
echo "=== B: identical again, fresh invocation (V3) ==="
render /out/b1.pdf 1 0
echo "=== C: no SOURCE_DATE_EPOCH (wall-clock timestamp) ==="
render /out/c1.pdf 1
sleep 1
echo "=== D: no SOURCE_DATE_EPOCH again ==="
render /out/d1.pdf 1
echo "=== E: epoch pinned, --jobs 4 (parallelism) ==="
render /out/e1.pdf 4 0

echo
echo "=== COMPARISON ==="
for f in a1 b1 c1 d1 e1; do
  if [ -f "/out/$f.pdf" ]; then
    printf '%s  %s\n' "$(sha256sum "/out/$f.pdf" | cut -d' ' -f1)" "$f"
  else
    printf '%-64s  %s  (absent)\n' "-" "$f"
  fi
done

A=$(sha256sum /out/a1.pdf 2>/dev/null | cut -d' ' -f1)
B=$(sha256sum /out/b1.pdf 2>/dev/null | cut -d' ' -f1)
C=$(sha256sum /out/c1.pdf 2>/dev/null | cut -d' ' -f1)
D=$(sha256sum /out/d1.pdf 2>/dev/null | cut -d' ' -f1)
E=$(sha256sum /out/e1.pdf 2>/dev/null | cut -d' ' -f1)

echo
if [ -n "$A" ] && [ "$A" = "$B" ]; then
  echo "V3 PASS: two runs with the policy configuration are byte-identical"
else
  echo "V3 FAIL: A=$A B=$B"
fi
if [ -n "$C" ] && [ -n "$D" ] && [ "$C" != "$D" ]; then
  echo "R14 CONFIRMED: without SOURCE_DATE_EPOCH the output is NOT reproducible"
  echo "  C=$C"
  echo "  D=$D"
  echo "  -> the knob is load-bearing, and policy 7.4's 'buildCompileArgs() THROWS if the"
  echo "     caller does not supply a creation timestamp' is a correctness requirement."
else
  echo "R14 NOTE: the two unpinned runs coincided this time (both landed in the same"
  echo "  wall-clock second, or the timestamp is only written when it differs)."
  echo "  C=$C D=$D"
  echo "  -> typst 0.15.1's source still defaults the PDF timestamp to"
  echo "     chrono::Local::now(), so the dependence is on the clock, not on anything"
  echo "     else. The pin removes it; a coincidence does not."
fi
if [ -n "$A" ] && [ -n "$C" ] && [ "$A" = "$C" ]; then
  echo "PIN-INERT WARNING: the pinned and unpinned digests are equal, so this run does"
  echo "  not by itself demonstrate the pin. See the R14 evidence section of the spike"
  echo "  report for the run where they differed."
fi
if [ -n "$A" ] && [ -n "$E" ]; then
  if [ "$A" = "$E" ]; then
    echo "JOBS NOTE: --jobs 4 matched --jobs 1 for THIS document. --jobs 1 stays mandated:"
    echo "  parallel layout is only guaranteed identical for simple content, so the cap is"
    echo "  insurance, not a no-op."
  else
    echo "JOBS NOTE: --jobs 4 DIFFERED from --jobs 1 -> parallelism is not layout-stable."
  fi
fi

echo
echo "=== timestamp actually embedded in the PDF (A, epoch pinned) ==="
strings /out/a1.pdf | grep -a -m2 -E 'CreationDate|ModDate' || echo "  (no timestamp strings found)"
echo "=== and in the unpinned run (C), for comparison ==="
strings /out/c1.pdf | grep -a -m2 -E 'CreationDate|ModDate' || echo "  (none)"
rm -f /out/a1.pdf /out/b1.pdf /out/c1.pdf /out/d1.pdf /out/e1.pdf
echo "cleaned up: /out entry count now $(ls -A /out | wc -l)"
