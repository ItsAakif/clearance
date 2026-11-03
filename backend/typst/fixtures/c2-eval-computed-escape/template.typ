// T1005 fixture (c2) - a path ASSEMBLED AT EVALUATION TIME that escapes the root.
//
// Policy 8.2 B2 / risk R4 / assertion V6 (second half). The point of this fixture is
// that the escape is not a literal in the source: it is built from a tuple and a `join`,
// so a reviewer reading the template sees only `("..", "etc", "passwd")` and a string
// concatenation. Whatever the compiler does, the resulting path must be validated AFTER
// evaluation, not before - a validator that only pattern-matches the source is defeated
// by this, and by anything else that assembles a path at run time.
//
// MEASURED on typst 0.15.1:
//   template.typ:18:19: error: path `"../etc/passwd"` would escape the project root
//   exit 1, /out empty, no artifact
//
// So typst validates the RESOLVED path, not the literal, which is the correct place to
// validate it. Good.
//
// Expected: non-zero exit, that diagnostic, no artifact, no canary.

#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

// Assembled at evaluation time. Nothing in the source is a traversal.
#let pieces = ("..", "etc", "passwd")
#let escape = pieces.join("/")

#let secret = read(escape)
#raw(secret, block: true)
