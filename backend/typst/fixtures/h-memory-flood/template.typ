// T1005 fixture (h) - MEMORY FLOOD. Policy 4.6 / risk R9 / assertion V17.
//
// The cap is a container cap, not a typst cap, so this fixture's job is simply to
// allocate past it and let the kernel act. Nothing in typst needs to cooperate.
//
// Bounds (policy 4.6):
//   mem_limit     = 1073741824 (1 GiB)
//   memswap_limit = 1073741824 (equal, so there is NO swap escape: a breach is an OOM
//                             kill, not unbounded host paging)
//   cpus          = 1.0
// Expected: the compile is SIGKILLed (exit 137), no artifact is produced, and the
// supervisor classifies the outcome as RENDER_RESOURCE_LIMIT (policy 9.2) rather than
// surfacing "out of memory" to the user.
//
// NOTE ON A FIRST-ATTEMPT BUG, kept because a resource fixture that does not compile
// looks exactly like a resource fixture that was correctly killed, and reporting the
// wrong one would be a false pass. The first version used `"A" * 1_500_000_000`, which
// typst 0.15.1 rejects at PARSE time with "expected semicolon or line break" - so it
// exited 1 instantly without allocating anything. A rejected program is not a flood.
// The form below is plain string concatenation inside a loop typst cannot prove
// infinite, which grows the allocation past the cap in a few seconds.

#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

#let s = "A"
#let n = 0
// No condition typst can prove false, so the infinite-loop detector does not fire, and
// each iteration doubles the allocation: 2^31 bytes after 31 iterations.
#while n < 31 {
  s = s + s
  n = n + 1
}
// Keep the string live so the allocator cannot have elided it before the cap is hit.
#raw(s)
