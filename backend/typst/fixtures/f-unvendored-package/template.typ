// T1005 fixture (f) - UNVENDORED PACKAGE IMPORT (supply-chain / risk R6).
//
// Policy 7.3 / 8.2 B6 / assertions V10 and V12 (negative half).
//
// The failure this fixture is designed to produce is a *package-not-found* error, never
// a download. Three independent things make that true, and the spike checks all three:
//
//   - `network_mode: none`             - there is nothing to download from;
//   - `--package-path /opt/typst-packages` - the ONLY resolvable tree, and it is a
//     read-only bind of the vendored set, so it cannot be written to either;
//   - `--package-cache-path /work/.pkgcache` - the cache is redirected onto the tmpfs
//     so that it dies with the job. A miss therefore fails as a lookup failure, and
//     the cache is observed to be EMPTY afterwards (V10).
//
// IMPORTANT measured fact, recorded because it is the strongest argument for the
// container-level deny: in a container WITH network and WITHOUT a vendored copy of the
// same package, typst 0.15.1 silently downloads it ("downloading @preview/tidy:0.1.0",
// 8.4 KiB, exit 0). Typst's own security model does NOT block Universe fetches for
// ordinary packages. The only thing standing between a malicious template and an
// arbitrary upstream download is the container's network mode.
//
// Expected: non-zero exit, no artifact, /work/.pkgcache empty.
//
// MEASURED DIAGNOSTIC: with no network, typst 0.15.1 reports
//   error: failed to download package
//     (https://packages.typst.org/preview/this-does-not-exist-9.9.9.tar.gz:
//      Dns Failed: resolve dns name 'packages.typst.org:443': ...)
//
// Two things are worth recording here, because both are the reason this fixture is the
// strongest supply-chain evidence in the spike:
//
//   1. It says "failed to download", NOT "package not found". Typst tries the vendored
//      path, misses, and then ATTEMPTS A NETWORK FETCH. The policy's expectation of a
//      "package-not-found error, never with a download" is therefore slightly wrong
//      about typst's behaviour: typst always attempts the download, and it is the
//      CONTAINER that prevents it. The policy's own reasoning already reaches this
//      conclusion (section 4.1 calls the container-level deny "the enforcement point"),
//      so this is a wording correction, not a design change - but it is the difference
//      between a reviewer believing the isolation is in typst and believing it is here.
//
//   2. The run takes ~5 s rather than failing instantly, because it waits on a DNS
//      timeout. That latency is itself evidence: the container is not fast-failing on
//      the import, it is genuinely attempting egress and failing at the network layer.
//      A supervisor with a 10 s budget must therefore leave room for this, or a
//      malicious template can spend the whole budget on a DNS timeout before the real
//      work begins.
//
// There is NO package in packages.lock, so no package can resolve. Fixture g proves the
// positive half with the one first-party package that is vendored.

#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

#import "@preview/this-does-not-exist:9.9.9": thing
#thing()
