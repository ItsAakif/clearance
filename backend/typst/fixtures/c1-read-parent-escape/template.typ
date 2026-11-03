// T1005 fixture (c1) - `#read()` with a parent-directory escape.
//
// Policy 8.2 B1 / risk R4 / assertion V6. This is the case typst DOES get right, and it
// is worth contrasting with fixture (b): a LITERAL `..` in the path is resolved and
// refused before any I/O happens.
//
//   measured: template.typ:12:19: error: path `"../secret"` would escape the project root
//   measured: exit 1, /out empty, no artifact, validator rejects with check 1
//
// Expected: non-zero exit, that diagnostic, NO artifact, and the canary nowhere.
// The spike also probes `../secret`, `../../etc/passwd` and
// `../../../../etc/clearance-spike-canary.txt` in spike/probe/cross-job.sh, so the
// refusal is demonstrated at three depths, not one.

#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

#let secret = read("../secret")
#raw(secret, block: true)
