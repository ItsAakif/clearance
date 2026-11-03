// T1005 fixture (b) - SYMLINK ROOT ESCAPE. typst/typst issue #5454, opened 2024-11-23
// and STILL OPEN in typst 0.15.1.
//
// THE MEASURED RESULT, STATED FIRST BECAUSE IT IS THE MOST IMPORTANT FINDING OF THE
// SPIKE: THIS FIXTURE SUCCEEDS. With a symlink planted inside --root, typst 0.15.1
// follows it and renders the target's content into the PDF. The proof is byte-identity:
//
//   via symlink  passwd -> /etc/clearance-spike-canary.txt : 040f3d99eb3cbc654b0cf...
//   via a regular file with identical content                 : 040f3d99eb3cbc654b0cf...
//
// Byte-identity is the right test, and it is not obvious. The leaked text is rendered as
// GLYPHS with subset font encodings, so `grep` for the canary string in the PDF finds
// NOTHING - a grep-based check reports "no canary present" for a PDF that visibly
// contains the canary. Comparing against a control render is the only mechanical
// proof, and the spike runs both (see spike/probe/cross-job.sh, PHASE 5).
//
// Meanwhile a DIRECT traversal is correctly refused:
//   read("../etc/passwd")  ->  error: path `"../etc/passwd"` would escape the project root
// So --root contains literal `..` but does NOT contain a symlink. That asymmetry is the
// bug, and it is why the policy's answer (section 3.3) is a STAGER-side lstat rejection
// rather than a typst flag.
//
// WHAT ACTUALLY STOPS IT, and this is the whole point:
//
//   backend/src/render/stage.ts MUST walk the work directory with lstat and REJECT the
//   job if any entry is not a regular file or directory, or if any name is off the
//   allowlist. Measured output of that audit against this fixture:
//
//       REJECT-NAME: passwd
//       REJECT-SYMLINK: passwd -> /etc/clearance-spike-canary.txt
//
//   That code DOES NOT EXIST YET. So today, a symlink reaching /work is an
//   arbitrary-file-read of anything in the image. This is escalated, not worked around.
//
// If this fixture ever stops producing a PDF, upstream has fixed #5454 and the lstat
// rejection becomes defence in depth rather than the primary control.

#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

#let leaked = read("passwd")
#raw(leaked, block: true)
