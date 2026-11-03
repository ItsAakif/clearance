// T1005 fixture (g) - VENDORED PACKAGE RESOLVES (assertion V12, positive half).
//
// Policy 7.3 / 8.1 PERMITTED: "import packages that appear in
// backend/typst/packages.lock at the pinned version".
//
// This is the positive control for package resolution, and it is the only reason the
// spike vendors a package at all. It proves, end to end, that:
//
//   - a package listed in packages.lock, mounted read-only at /opt/typst-packages, is
//     importable and the document renders;
//   - resolution came from the vendored tree, not the network - there is no network,
//     and the same spec with the tree emptied fails (fixture f);
//   - the resolution is pinned: the spec carries an exact version, and a different
//     version is a different, absent package.
//
// The package is `@clearance/spike-probe:1.0.0`, FIRST-PARTY and tracked in git
// (backend/typst/packages/clearance/spike-probe/1.0.0/). It is deliberately not a
// Typst Universe package: the spike vendors zero third-party packages, so the trusted
// mount contains no third-party code at all (packages.lock explains why, and what
// changes when a real template needs a real package).
//
// Expected: exit 0, /out/artifact.pdf present, and the text "vendored package resolved"
// rendered from inside the package.

#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

#import "@clearance/spike-probe:1.0.0": probe

#probe()
