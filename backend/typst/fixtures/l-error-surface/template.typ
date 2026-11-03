// T1005 fixture (l) - ERROR SURFACE / INFORMATION DISCLOSURE. Policy 9.3 / 9.4 /
// risk R13 / assertion V23.
//
// MEASURED RESULT, STATED FIRST SO NOBODY IS SURPRISED: this fixture SUCCEEDS AT
// LEAKING, and that is the finding. The raw engine diagnostic contains the project root
// in some shapes, and ALWAYS echoes the offending source line including any string the
// template embeds in it.
//
// The exact output measured on typst 0.15.1 with the policy's own argv
// (`--diagnostic-format short`):
//
//   template.typ:4:1: error: panicked with: <whatever the template put in panic()>
//
// and with the `human` format the policy forbids:
//
//   error: panicked with: ...
//     4 | #panic("...")
//       |   ^^^^^^^^^^^^^^^                    <- 335 bytes vs 123 for `short`
//
// Three measured properties, all of which the supervisor has to know:
//
//   1. `short` is 123 bytes where `human` is 335. It reduces volume, and it removes the
//      source-line echo - but ONLY for diagnostics that quote a span. A `panic()` with a
//      message echoes the message either way. So "we use short, so it is safe" is false.
//   2. typst reports paths RELATIVE to the project root ("template.typ:4:1"), so the
//      work dir is often absent from the diagnostic by luck rather than by design. When
//      it IS present - e.g. `file not found (searched at /work/assets/logo.png)` - the
//      work dir leaks in full.
//   3. The policy 9.4 redaction replaces the work dir and staged content. It does NOT
//      cover an arbitrary string a template embeds, so a template that writes a host
//      path into a message leaks that path past the stated redaction. Measured and
//      reported as a policy gap in `spike/probe/error-surface.sh`.
//
// Therefore the containment for R13 is NOT a typst flag. It is supervisor-side, and it
// is T1040's to build:
//   - policy 9.3  the diagnostic never reaches the client: a fixed message, an internal
//                 code, and a correlation id;
//   - policy 9.4  the diagnostic goes to the job log, truncated to 64 KiB, with the work
//                 dir and staged content replaced;
//   - policy 9.2  the engine's exit code is recorded, never surfaced.
//
// Expected: non-zero exit, no artifact, and a diagnostic that leaks - which is the
// documented and intended reason the supervisor must not pass it through.

#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

// The canary lives in the SOURCE, not in data.json, which is the realistic leak shape:
// an error line quotes the line a value landed on, so any string the template embeds is
// reflected verbatim into the diagnostic.
#let CLEARANCE_CANARY_V23_4d7e91bb = "no-value"
#panic("CLEARANCE_CANARY_V23_4d7e91bb could not resolve at /etc/clearance-spike-canary.txt")
