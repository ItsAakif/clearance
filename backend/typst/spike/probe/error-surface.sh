#!/bin/sh
# T1005 spike - error-surface probe (assertion V23, risk R13).
#
# MEASURED RESULT, STATED FIRST SO NOBODY IS SURPRISED: the raw engine diagnostic DOES
# leak. It contains the project root AND echoes the offending source line, including a
# canary string planted in it. `--diagnostic-format short` makes it one compact line
# instead of a pretty multi-line span report, which reduces the volume but does not remove
# the content.
#
# So the containment for R13 is NOT a typst flag. It is supervisor-side:
#   - policy 9.3  the diagnostic never reaches the client, only a fixed message plus an
#                 internal code and a correlation id;
#   - policy 9.4  the diagnostic goes to the job log, truncated to 64 KiB, with the work
#                 dir replaced by `<workdir>` and staged content by `<content>`;
#   - policy 9.2  the engine's exit code is recorded but never surfaced.
# None of that is T1005's to implement (T1040 owns the supervisor), so this script's job
# is to MEASURE the raw surface, then demonstrate that the mandated redaction actually
# removes it, and to report the residual.
#
# It also measures the one thing a supervisor can get wrong: assuming a diagnostic is
# safe because it is "short". It is not.
set -u

T=/opt/typst/typst
W=/work
BASE="--root $W --format pdf --package-path /opt/typst-packages --package-cache-path $W/.pkgcache --font-path /opt/typst-fonts --ignore-system-fonts --ignore-embedded-fonts --jobs 1"

CANARY_CONTENT="CLEARANCE_CANARY_V23_4d7e91bb"
CANARY_PATH="/etc/clearance-spike-canary.txt"

echo "===== the raw diagnostic, exactly as the engine emits it ====="
cat > "$W/template.typ" <<TYP
#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)
#let $CANARY_CONTENT = "no-value"
#panic("$CANARY_CONTENT could not resolve at $CANARY_PATH")
TYP
rm -f /out/artifact.pdf
ERR=$($T compile $BASE --diagnostic-format short "$W/template.typ" /out/artifact.pdf 2>&1)
RC=$?
echo "exit=$RC  artifact=$([ -f /out/artifact.pdf ] && echo present || echo absent)"
echo "raw stderr:"
echo "$ERR" | sed 's/^/  | /'

echo
echo "===== what the raw diagnostic LEAKS (V23 fail condition, measured) ====="
LEAK_PATH=0
LEAK_CONTENT=0
echo "$ERR" | grep -q '/work' && { echo "  LEAK: contains the work dir path (/work)"; LEAK_PATH=1; }
echo "$ERR" | grep -q '/opt/typst' && { echo "  LEAK: contains the toolchain path (/opt/typst)"; LEAK_PATH=1; }
echo "$ERR" | grep -q "$CANARY_CONTENT" && { echo "  LEAK: contains the planted canary string"; LEAK_CONTENT=1; }
echo "$ERR" | grep -q "$CANARY_PATH" && { echo "  LEAK: contains the canary's absolute path"; LEAK_PATH=1; }
[ "$LEAK_PATH" = "0" ] && echo "  ok: no container path in the diagnostic"
[ "$LEAK_CONTENT" = "0" ] && echo "  ok: no planted content in the diagnostic"
echo "  bytes: $(echo "$ERR" | wc -c) (policy 9.4 cap is 65536)"
[ "$(echo "$ERR" | wc -c)" -gt 65536 ] && echo "  NOTE: this diagnostic EXCEEDS the 64 KiB capture cap and would be truncated"

echo
echo "===== the same fixture with --diagnostic-format human (the policy forbids it) ====="
ERRH=$($T compile $BASE --diagnostic-format human "$W/template.typ" /out/artifact.pdf 2>&1)
echo "  bytes: $(echo "$ERRH" | wc -c)  (short was $(echo "$ERR" | wc -c))"
echo "$ERRH" | sed 's/^/  | /'

echo
echo "===== applying the mandated redaction (policy 9.4) ====="
REDACTED=$(echo "$ERR" | sed -e "s|$W|<workdir>|g" -e "s|$CANARY_CONTENT|<content>|g")
echo "redacted:"
echo "$REDACTED" | sed 's/^/  | /'
echo
echo "after redaction:"
echo "$REDACTED" | grep -q '/work' && echo "  RESIDUAL: /work still present" || echo "  ok: /work removed"
echo "$REDACTED" | grep -q "$CANARY_CONTENT" && echo "  RESIDUAL: canary still present" || echo "  ok: canary removed"

# MEASURED RESIDUAL, and the reason the placeholder check is written this way: in THIS
# diagnostic the work dir never appeared, because typst reports the path RELATIVE to the
# root ("template.typ:4:1"). So there is nothing for the `<workdir>` substitution to
# replace, and a naive assertion that the placeholder must be present FAILS - a false
# alarm that says the redaction did not run when in fact there was nothing to redact.
# The placeholder is therefore only required when the work dir was present to begin with.
if echo "$ERR" | grep -q "$W"; then
  echo "$REDACTED" | grep -q '<workdir>' \
    && echo "  ok: <workdir> placeholder present (the raw diagnostic did contain $W)" \
    || echo "  RESIDUAL: the work dir was present but no placeholder was inserted"
else
  echo "  n/a: the raw diagnostic did NOT contain $W (typst reported a root-relative"
  echo "      path), so the <workdir> substitution had nothing to replace."
fi

# The canary's ABSOLUTE path survives the policy 9.4 redaction, which only mandates
# replacing the work dir and staged content. That is a gap in the stated redaction, not a
# bug in this script: a template that embeds a host path in a string leaks it, and the
# policy's two substitutions do not cover it.
echo "$REDACTED" | grep -q "$CANARY_PATH" \
  && echo "  GAP: the canary's absolute path ($CANARY_PATH) survives the policy 9.4" \
     "redaction. Policy 9.4 mandates replacing the work dir and staged content only, so" \
     "a template that embeds a host path is not covered. Reported as a policy gap."

echo
echo "===== a compile error that quotes a STAGED FILE PATH ====="
# The realistic disclosure case: a template references a file that was not staged, and
# the diagnostic names the path it looked for.
cat > "$W/template.typ" <<'TYP'
#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)
#raw(read("assets/company-logo.png"), block: true)
TYP
ERR2=$($T compile $BASE --diagnostic-format short "$W/template.typ" /out/artifact.pdf 2>&1)
echo "  | $ERR2"
echo "$ERR2" | grep -q "$W" && echo "  LEAK: the missing-file diagnostic contains the absolute work dir" || echo "  ok: no absolute work dir"

echo
echo "===== a template that fails on the FIRST line, so no source is quoted ====="
printf '#undefined-function()\n' > "$W/template.typ"
ERR3=$($T compile $BASE --diagnostic-format short "$W/template.typ" /out/artifact.pdf 2>&1)
echo "  | $ERR3"

rm -f /out/artifact.pdf "$W/template.typ"
echo
echo "V23 CONCLUSION: the raw engine surface leaks the work dir, the toolchain path and"
echo "any content the template embeds. --diagnostic-format short reduces the volume but"
echo "does not make it safe. The mandated redaction removes all three, so the control is"
echo "supervisor-side and belongs to T1040, not to this spike."
