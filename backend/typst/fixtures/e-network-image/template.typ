// T1005 fixture (e) - NETWORK EGRESS ATTEMPT. Policy 8.2 B5 / risk R8 / assertion V11b.
//
// Two independent mechanisms are exercised:
//
//   1. TYPST'S OWN REFUSAL. Typst has no network API in the document language at all.
//      `image()` with an http(s) URL is not "fetched and failed" - it is rejected
//      before any request is made, and the hint it prints says so explicitly. There is
//      no `@import "https://..."` and no fetch function to reach for either.
//
//   2. THE CONTAINER'S DENY. `network_mode: none` in the compose service. This is the
//      load-bearing one, because it is what makes the guarantee unconditional rather
//      than dependent on typst continuing to refuse. The spike proves the refusal is
//      in effect by showing that a *legitimate* egress attempt cannot leave the box
//      (a shell-level probe inside the same container, which is strictly more capable
//      than anything typst can do), and by reading `NetworkMode` out of `docker inspect`.
//
// The CLI does expose a network affordance: the global `--cert` / `TYPST_CERT` pair,
// documented as "for making network requests". Neither is ever passed (assertion
// V11a is a static check over the built argv and env), and this fixture is the proof
// that a document cannot reach the network without them.
//
// Expected: non-zero exit, "network access is not supported", no artifact.
//
// MEASURED DIAGNOSTIC, recorded because the wording is a useful regression signal.
// With a URL whose host cannot resolve, typst 0.15.1 reports
//   template.typ:30:7: error: file not found (searched at /work/https:/exfil.attacker.invalid/beacon.png)
// - i.e. it does not name the network at all in `short` format, it treats the URL as a
// path relative to the root. With a RESOLVABLE host it prints the hint
//   = hint: network access is not supported
// So "the diagnostic mentions network" is NOT a reliable assertion; "the compile fails
// and no artifact is produced" is. The spike asserts the latter.
//
// THE DECISIVE EVIDENCE IS THE CONTAINER, NOT THIS FIXTURE. In a container WITH network
// and WITHOUT a vendored copy of the same package, typst 0.15.1 silently downloads it
// (measured: "downloading @preview/tidy:0.1.0", 8.4 KiB, exit 0). Typst's own security
// model does not block ordinary package fetches. Fixture f demonstrates the same thing
// for a package import; this fixture demonstrates it for an asset. Neither is possible
// here because `network_mode: none` leaves the container with loopback only, which the
// identity probe measures directly.

#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

// A remote image. `.invalid` is a reserved TLD that can never resolve, so even if the
// attempt were permitted the failure would be uninformative - which is the point: the
// failure must come from typst's refusal, not from DNS.
#image("https://exfil.attacker.invalid/beacon.png")
