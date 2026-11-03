// T1005 fixture (j) - OUTPUT FLOOD. Policy 6.2 / risk R10 / assertion V20.
//
// Two independent bounds exist and both are exercised by the spike:
//
//   1. THE MOUNT BOUND (kernel-enforced). /out is a 16 MiB tmpfs. A writer that
//      exceeds it gets ENOSPC from the kernel, which is a compile failure, not a full
//      host disk. The spike proves this with a direct writer inside the same container,
//      because that is the mechanism the policy actually relies on.
//
//   2. THE POLICY BOUND (supervisor-enforced). 20 MiB, asserted by the supervisor on
//      what it was actually handed. The spike proves the check itself against an
//      over-large artifact, because a 16 MiB tmpfs makes a >20 MiB file inside the
//      container unreachable by construction.
//
// THIS FIXTURE is the typst-side attempt: a document that tries to render 40 000 pages
// of dense text, i.e. a multi-hundred-megabyte PDF. The measured result is recorded
// honestly in the spike: with a 10 s budget and 1 CPU, layout of 40 000 pages is CPU
// bound, so the WALL CLOCK binds first (RENDER_TIMEOUT) rather than the mount. That is
// a correct outcome - two bounds, the tighter one wins - and it is why the mount bound
// has to be proven separately.
//
// Expected: no artifact is ever returned; the job ends in RENDER_RESOURCE_LIMIT or
// RENDER_TIMEOUT, and the container never writes outside /out.

#set page(paper: "a4", margin: 5mm)
#set text(font: "Source Serif 4", size: 7pt)
#set par(spacing: 0pt, leading: 0.9em)

// Measured, not assumed: the first version of this fixture used `range(40_000)`, and
// typst 0.15.1 rejects an underscore digit separator with a bare parse error
// ("expected comma"). A document that does not compile is not a flood, so the
// separators are removed and the count is written plainly.
#for page in range(40000) {
  [Experience entry #page: ]
  lorem(140)
  [ ]
  [Achievement #page: ]
  lorem(140)
  pagebreak(weak: true)
}
