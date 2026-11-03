// T1005 fixture (i) - CPU-BURN LOOP. Policy 9.1 / risk R9 / assertion V19.
//
// A measured detail worth recording, because it decides the shape of this fixture:
// typst 0.15.1 REFUSES the obvious infinite loop. `#while true { }` and
// `#while i >= 0 { i += 1 }` are both rejected at compile time with
//   error: loop seems to be infinite
// and so is an opaque condition the detector cannot fold, such as
// `#while calc.rem(n, 2) >= 0 { n = n + 1 }`. The interpreter really does have a
// provably-infinite-loop detector.
//
// The second measured detail is the one that matters here, and the first version of this
// fixture got it wrong. It used a single `for i in range(1000000000)`. That is NOT a CPU
// flood: `range(1000000000)` MATERIALISES as an array of 1e9 integers, so it allocates
// ~8 GB and is killed by the MEMORY cap in ~2 s. Measured:
//
//   range(1000000000)          exit 137,  2.1 s, memory.peak 1073741824 (at the cap)
//   nested range(30000)^2      exit 137, 20.3 s, memory.peak    19820544 (19 MiB)
//
// A resource fixture that trips the wrong cap proves the wrong assertion, and reporting
// "V19 passed" for a memory kill would be a false pass. The nested loop below is a real
// CPU flood: 9e8 iterations, ~19 MiB of memory, so only the wall clock can end it.
//
// The bound (policy 9.1):
//   wall-clock budget   10000 ms  -> the supervisor stops waiting
//   hard kill grace      2000 ms  -> escalate SIGTERM -> SIGKILL to the whole container
//   compose backstop        5s    -> stop_grace_period
// Expected: the job is stopped at the budget, escalated to SIGKILL, the container is
// removed, no artifact survives, and the outcome is RENDER_TIMEOUT.
//
// A note for whoever implements the supervisor (T1040): this fixture exits 137, and so
// does the memory flood. The two are INDISTINGUISHABLE from the exit code alone, so
// classification must be by CAUSE, not by code. Policy 9.2 already requires that
// distinction; this is the measurement that makes it concrete.
#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

// 30000 x 30000 = 9e8 iterations. At one CPU that is far beyond the 10 s budget, and the
// working set is two small arrays plus one integer, so memory is nowhere near the cap.
#let acc = 0
#for i in range(30000) {
  for j in range(30000) {
    acc = acc + i + j
  }
}
#repr(acc)
