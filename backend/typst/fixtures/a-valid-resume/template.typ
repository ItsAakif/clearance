// T1005 fixture (a) - a VALID A4 resume. The positive control for the whole spike:
// every other result is measured against whether this one renders deterministically.
//
// Policy references:
//   - section 5.1  the staged payload is exactly `template.typ` + `data.json`
//   - section 8.4  user content enters ONLY as string values inside data.json. This
//                  file NEVER concatenates resume content into Typst source, which is
//                  what makes a value containing `#raw("...")` or `#eval(...)` inert.
//   - section 7.4  the font is named explicitly because the font set is CLOSED to
//                  /opt/typst-fonts. Typst's built-in default (Libertinus Serif) is not
//                  in that set, so an unqualified `#set text(...)` would fail the moment
//                  `--ignore-embedded-fonts` takes effect. Naming the vendored family is
//                  the mechanism behind font allowlisting (policy 8.2 B13).
//   - ADR-038     A4 is native; the page is declared, not approximated.
//
// MEASURED, and worth knowing before editing: `#for x in y [ ... ]` is the only
// multi-statement body shape that works here. Several natural-looking forms do not
// compile on typst 0.15.1 and a non-compiling fixture exits non-zero - the same code a
// REFUSED escape produces, so a syntax error is indistinguishable from a pass in a
// summary table. Anything added to this file must be re-run, not eyeballed.

#let d = json("data.json")

#set document(title: d.basics.name + " - Resume", author: d.basics.name)
#set page(
  paper: "a4",
  margin: (top: 16mm, bottom: 16mm, left: 18mm, right: 18mm),
)
#set text(font: "Source Serif 4", size: 10pt, lang: "en")
#set par(leading: 0.58em, spacing: 0.5em)
#set list(marker: [-], indent: 1.2em, body-indent: 0.4em, spacing: 0.28em)

#let section(title) = block(above: 1.0em, below: 0.35em)[
  #text(size: 10.5pt, weight: "semibold", tracking: 0.09em)[#upper(title)]
  #block(above: 0.18em, below: 0em, line(length: 100%, stroke: 0.5pt + luma(55%)))
]

// Header. Every field is a data.json string; the template never formats user bytes into
// markup, so `#eval(...)` in a name is text, not code.
#align(center)[
  #text(size: 19pt, weight: "bold")[#d.basics.name] \
  #text(size: 10.5pt)[#d.basics.role] \
  #text(size: 9.5pt, fill: luma(30%))[
    #d.basics.contact.email
    #h(0.5em) | #h(0.5em)
    #d.basics.contact.phone
    #h(0.5em) | #h(0.5em)
    #d.basics.contact.location
  ]
]

#section("profile")
#d.summary

#section("experience")
#for job in d.experience [
  #block(above: 0.45em, below: 0.15em)[
    #grid(
      columns: (1fr, auto),
      text(weight: "semibold")[#job.role],
      text(weight: "semibold", fill: luma(25%))[#job.company],
    )
    #text(size: 9.5pt, fill: luma(35%))[#job.period] #h(0.4em) #h(0.4em) #job.location]
  #for bullet in job.highlights [
    - #bullet
  ]
]

#section("education")
#for e in d.education [
  #block(above: 0.35em)[
    #grid(
      columns: (1fr, auto),
      text(weight: "semibold")[#e.qualification],
      text(fill: luma(35%))[#e.period],
    )
    #text(size: 9.5pt, fill: luma(35%))[#e.institution]
  ]
]

#section("skills")
#d.skills.join(", ")

// A deterministic marker so the artifact proves data.json was actually READ by this run
// (not merely that a PDF appeared). It is derived from the staged payload, so it changes
// whenever the input does, which is also what makes V21 observable.
#v(0.8em)
#align(center)[
  #text(size: 6pt, fill: luma(55%))[
    T1005 fixture-a #d.meta.fixture #d.meta.dataDigest
  ]
]
