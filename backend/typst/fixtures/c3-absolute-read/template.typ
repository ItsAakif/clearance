// T1005 fixture (c3) - absolute-path read of a file outside the root.
//
// Policy 8.2 B1 / assertion V7. The interesting part is HOW typst refuses it, and the
// mechanism differs from fixture (c1) in a way worth recording:
//
//   c1  read("../secret")     -> error: path "..." would escape the project root
//   c3  read("/etc/...")      -> error: file not found (searched at /work/etc/...)
//
// An absolute path is NOT treated as filesystem-absolute. Typst REBASES it onto the
// project root and looks it up there. So the refusal is a lookup failure against
// `<root>/etc/...`, not a root-boundary violation. Both are refusals; the diagnostics
// are not interchangeable, so nobody should later write a test that greps only for
// "outside of project root" and conclude the absolute-path case is uncovered.
//
// A second consequence, and the one that actually matters for a template author: a
// template CANNOT read an absolute host path at all, even one it is given as a string.
// Absolute paths inside a Typst document are always root-relative. That is a stronger
// property than the policy assumes, and it is why V7 passes.
//
// Expected: non-zero exit, no artifact, and a diagnostic naming `<root>/etc/...` - never
// a host path.

#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

#let secret = read("/etc/clearance-spike-canary.txt")
#raw(secret, block: true)
