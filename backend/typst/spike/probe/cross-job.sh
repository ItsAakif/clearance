#!/bin/sh
# T1005 spike - cross-job leakage probe driver (assertion V21, risk R11).
#
# One path per document, because typst 0.15.1 cannot do what the obvious version of this
# probe wants to do. All three measured facts, each of which produced a false pass
# before this shape existed:
#
#   (1) `try`/`catch` does NOT propagate assignments in 0.15.1. The try body is a new
#       scope, so `let v = "unset"; try { v = "ok" } catch e { v = "caught" }` leaves v
#       as "unset". The catch branch is unobservable.
#   (2) `try`/`catch` inside a `for` body or an arrow-function body is a PARSE ERROR
#       ("expected semicolon or line break"), and so is `let x = try {...} catch e {...}`.
#       The natural "loop over the paths, catch each read" probe does not compile.
#   (3) A document that fails to compile exits NON-ZERO, the same exit code as a
#       document that was correctly refused. In a summary table the two look identical.
#
# So each path gets its OWN document, with no try/catch, and the exit code is the
# verdict. BOTH directions are exercised, which is what stops a probe that refuses
# everything from being recorded as a containment success.
#
# ---------------------------------------------------------------------------
# TWO MORE MEASURED FACTS, both of which produced wrong verdicts first
# ---------------------------------------------------------------------------
#
# (4) Typst REBASES an absolute path onto the project root instead of treating it as
#     filesystem-absolute. `read("/work/own-fixture.txt")` searches for
#     `<root>/work/own-fixture.txt`; `read("/etc/passwd")` searches for
#     `<root>/etc/passwd`. So a document's paths must be written ROOT-RELATIVE.
#
# (5) Typst can read ANY file inside the root, including one the policy would never
#     stage. An earlier version of this script planted a "previous job" leftover inside
#     /work and then asserted it should be refused. It was NOT refused - it rendered
#     successfully - and the script printed "LEAK!!!". That verdict was wrong: the file
#     was inside the root, so typst reading it is correct behaviour, not an escape. The
#     real control is the STAGING AUDIT, which refuses the file by name before typst
#     ever runs. Reading a planted leftover and rendering it is the staging audit
#     failing, which is a different assertion with a different fix.
#
#     This distinction is the substance of V21, so it is stated plainly:
#       - R11 is about a job seeing a PREVIOUS job's state. With a fresh container and
#         a fresh tmpfs per job, /work starts EMPTY, so there is nothing to see. The
#         probe therefore plants leftovers to show that IF they existed, they would be
#         readable - and that the audit is what prevents them from existing.
#       - The escape assertions are about paths OUTSIDE the root, and those are refused
#         by typst itself.
set -u

T=/opt/typst/typst
W=/work
BASE="--root $W --format pdf --package-path /opt/typst-packages --package-cache-path $W/.pkgcache --font-path /opt/typst-fonts --ignore-system-fonts --ignore-embedded-fonts --jobs 1 --diagnostic-format short"

# --- PHASE 1: a FRESH job, exactly as production would stage it ------------------
# Nothing planted. This is the real V21 condition: does job N+1 see anything from job N?
echo "===== PHASE 1: a fresh job sees NOTHING from any previous job ====="
mkdir -p "$W/.pkgcache"
printf '#set page(paper: "a4", margin: 20mm)\n#set text(font: "Source Serif 4", size: 10pt)\nTHIS IS A FRESH JOB\n' > "$W/template.typ"
printf '{"basics":{"name":"Job Two"}}\n' > "$W/data.json"
echo "  /work contains exactly: $(ls -A "$W" | tr '\n' ' ')"
echo "  /tmp  contains exactly: $(ls -A /tmp | tr '\n' ' ')"
echo "  /out  contains exactly: $(ls -A /out | tr '\n' ' ')  <- the previous job's artifact is GONE"
echo
STRAY=$(ls -A "$W" | grep -v -E '^(template\.typ|data\.json|\.pkgcache)$' | tr '\n' ' ')
if [ -z "$STRAY" ] && [ -z "$(ls -A /out)" ]; then
  echo "  V21 PHASE 1 PASS: the root carries only this job's payload, and /out is empty."
else
  echo "  V21 PHASE 1 FAIL: unexpected entries. /work stray: [$STRAY] /out: [$(ls -A /out)]"
fi
echo

# --- PHASE 2: POSITIVE CONTROL, this job's own file must be readable -------------
# Without this, a probe that refused everything would look perfect.
echo "===== PHASE 2: positive control, the job's own staged file IS readable ====="
probe() { # probe <path> ; echoes the verdict, sets REFUSED=0/1
  p="$1"
  cat > "$W/probe.typ" <<TYP
#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)
#raw(read("$p"), block: true)
TYP
  rm -f /out/probe.pdf
  ERR=$(SOURCE_DATE_EPOCH=0 $T compile $BASE "$W/probe.typ" /out/probe.pdf 2>&1)
  RC=$?
  FIRST=$(echo "$ERR" | head -1 | cut -c1-100)
  if [ "$RC" = "0" ] && [ -f /out/probe.pdf ]; then
    echo "  READABLE  read(\"$p\")  -> $(stat -c %s /out/probe.pdf) bytes"
    return 0
  fi
  echo "  REFUSED   read(\"$p\")  exit=$RC"
  echo "               $FIRST"
  return 1
}
if probe "template.typ"; then
  echo "  POSITIVE CONTROL PASS: the probe can read what it is allowed to read."
else
  echo "  POSITIVE CONTROL FAIL: the probe is broken; every other result here is void."
fi
rm -f /out/probe.pdf
echo

# --- PHASE 3: paths OUTSIDE the root must be refused by typst itself -------------
echo "===== PHASE 3: paths OUTSIDE the root (typst's own enforcement) ====="
OUTSIDE_PASS=0
OUTSIDE_FAIL=0
for p in "../secret" \
         "../../etc/passwd" \
         "../../../../etc/clearance-spike-canary.txt" \
         "/etc/clearance-spike-canary.txt" \
         "/var/run/docker.sock" \
         "/nonexistent" \
         "nonexistent"; do
  if probe "$p"; then
    echo "               ^^ EXPECTED A REFUSAL"
    OUTSIDE_FAIL=$((OUTSIDE_FAIL + 1))
  else
    OUTSIDE_PASS=$((OUTSIDE_PASS + 1))
  fi
  rm -f /out/probe.pdf
done
echo "  outside-root: $OUTSIDE_PASS refused, $OUTSIDE_FAIL readable (expected 7 refused, 0 readable)"
echo

# --- PHASE 4: leftovers INSIDE the root, and the audit that must stop them --------
echo "===== PHASE 4: planted leftovers inside /work, and the audit that stops them ====="
printf 'leftover-manifest' > "$W/.pkgcache/manifest.json"
printf 'stale lock' > "$W/.artifact.pdf.lock"
printf 'previous job data' > "$W/previous-job"
printf 'stale tmp' > /tmp/typst-previous-job
printf 'old artifact' > /out/artifact.pdf
printf 'THIS-JOBS-OWN-STAGED-FILE\n' > "$W/own-fixture.txt"
echo "  planted: .pkgcache/manifest.json .artifact.pdf.lock previous-job own-fixture.txt"
echo "           /tmp/typst-previous-job  /out/artifact.pdf"
echo
echo "  --- can typst read them? (yes, and that is correct: they are inside the root) ---"
if probe "previous-job"; then :; else echo "               (unexpected)"; fi
rm -f /out/probe.pdf
echo
echo "  --- so the control must be the STAGING AUDIT, run before typst ---"
sh /probe/stage-audit.sh 2>&1 | grep -E 'REJECT|audit-complete' | sed 's/^/    /'
echo
echo "  ^ every planted entry is refused by name and/or by type. The stager is what"
echo "    keeps a previous job's state out of the root; typst is not, and is not asked to be."
rm -f "$W/.pkgcache/manifest.json" "$W/.artifact.pdf.lock" "$W/previous-job" \
      "$W/own-fixture.txt" /tmp/typst-previous-job /out/artifact.pdf "$W/probe.typ"
echo

# --- PHASE 5: the symlink escape, which IS a real typst-layer leak --------------
echo "===== PHASE 5: symlink escape (typst issue #5454) ====="
ln -sf /etc/clearance-spike-canary.txt "$W/passwd"
cat > "$W/probe.typ" <<'TYP'
#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)
#raw(read("passwd"), block: true)
TYP
rm -f /out/probe.pdf /out/control.pdf
ERR=$(SOURCE_DATE_EPOCH=0 $T compile $BASE "$W/probe.typ" /out/probe.pdf 2>&1)
echo "  raw typst exit=$?  artifact=$([ -f /out/probe.pdf ] && echo present || echo absent)"
if [ -f /out/probe.pdf ]; then
  echo "  >>> TYPST 0.15.1 READ THROUGH THE SYMLINK. Issue #5454 IS STILL OPEN."
  echo "  >>> artifact: $(stat -c %s /out/probe.pdf) bytes"
  echo "  >>> The canary is RENDERED as glyphs, so grepping the PDF for the canary string"
  echo "  >>> finds nothing. Byte-identity against a control render is the proof:"
  rm -f "$W/passwd"
  cp /etc/clearance-spike-canary.txt "$W/passwd"
  SOURCE_DATE_EPOCH=0 $T compile $BASE "$W/probe.typ" /out/control.pdf >/dev/null 2>&1
  A=$(sha256sum /out/probe.pdf | cut -d' ' -f1)
  B=$(sha256sum /out/control.pdf 2>/dev/null | cut -d' ' -f1)
  echo "  >>> via symlink      : $A"
  echo "  >>> via regular file : $B"
  [ -n "$B" ] && [ "$A" = "$B" ] && echo "  >>> BYTE-IDENTICAL => the target's content was read and rendered. LEAK CONFIRMED."
  rm -f /out/control.pdf
fi
echo
echo "  --- and the audit refuses the symlink before typst runs ---"
ln -sf /etc/clearance-spike-canary.txt "$W/passwd"
sh /probe/stage-audit.sh 2>&1 | grep -E 'REJECT-SYMLINK|REJECT-NAME: passwd' | sed 's/^/    /'
rm -f "$W/passwd" /out/probe.pdf "$W/probe.typ"
echo
echo "  THIS IS THE HEADLINE FINDING OF THE SPIKE: in typst 0.15.1, --root does NOT"
echo "  contain a symlink planted inside it. The containment is 100% the stager's"
echo "  lstat + name audit, and there is currently NO CODE IMPLEMENTING IT"
echo "  (backend/src/render/stage.ts does not exist). Until it does, a symlink reaching"
echo "  /work is a full read of anything in the image."

echo
echo "=================================================="
echo "V21: phase 1 $([ -z "$STRAY" ] && echo PASS || echo FAIL), outside-root $OUTSIDE_PASS/$((OUTSIDE_PASS+OUTSIDE_FAIL)) refused"
echo "=================================================="
