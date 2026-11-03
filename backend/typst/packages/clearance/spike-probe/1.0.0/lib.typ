// T1005 spike probe package - FIRST PARTY, repo-owned, not a product dependency.
//
// WHY THIS EXISTS
//   Assertion V12 has two halves: a template importing a package PRESENT in
//   packages.lock must render, and one absent from packages.lock must fail with a
//   package-not-found error rather than a download. Only the second half is provable
//   with an empty vendored tree, so the spike vendors exactly one package to give the
//   first half a subject.
//
// WHY IT IS FIRST PARTY
//   The spike vendors ZERO third-party Typst Universe packages, so this is a few lines
//   of repository source rather than a third-party payload: nothing in the read-only
//   trusted mount at /opt/typst-packages is unreviewed code, and nothing here needs a
//   licence clearance. See backend/typst/packages.lock for the full statement and for
//   what changes when a real template needs a real package.
//
//   Two third-party candidates were evaluated and REJECTED during T1005, which is why
//   they are recorded here rather than in the lock file:
//     - @preview/valkyrie:0.2.0  - GPL-3.0-only. Copyleft on any template that imports
//                                 it. Incompatible with shipping an open-source
//                                 product that renders from it.
//     - @preview/cetz:0.3.1      - LGPL-3.0-or-later AND `compiler = "0.12.0"`, i.e.
//                                 not maintained against typst 0.15. Weak copyleft is
//                                 survivable; an unmaintained pin is not, because
//                                 ADR-038 makes version pins mandatory and this would
//                                 be a pin that breaks on every engine bump.
//     - @preview/tidy:0.1.0      - MIT and dependency-free, which is why it was the
//                                 closest fit, but it does NOT compile on typst 0.15.1:
//                                 src/tidy.typ:96 uses `sort-functions: auto` and
//                                 fails with "sequence does not have field
//                                 label-prefix". Shipping a package that cannot render
//                                 would be worse than shipping none, so it was dropped.
//
//   This file is NOT a template and MUST NOT be used by one. It exists only so the
//   spike can prove the resolution mechanism.

// Entry point declared in typst.toml. The name is deliberately distinct from any
// plausible template identifier so a copy-paste into a real template is obvious.
// NOTE: the package spec is rendered as a Typst STRING passed to `text()`, never as
// literal markup. A literal `@clearance/...` in markup mode is a label reference, and
// typst resolves it against the document - which fails with
//   error: label `<clearance>` does not exist in the document
// The first version of this file had it inline and failed for exactly that reason. This
// is the same structural rule the policy states for user content (section 8.4): a value
// that happens to contain markup syntax is a string, not markup.
#let probe() = block(above: 0.6em, below: 0.6em)[
  #text(weight: "semibold")[vendored package resolved]
  #linebreak()
  #text("@clearance/spike-probe:1.0.0 loaded from the read-only bind at " +
    "/opt/typst-packages, with no network available and an empty package cache.")
]
