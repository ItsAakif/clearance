// Clearance resume template: typst-ats-classic
//
// TEMPLATE CONTRACT (render-sandbox-policy.md section 8)
//   - The ONLY data this template sees is the staged `data.json`, read with
//     `json("data.json")`. Resume content is UNTRUSTED input and it reaches this
//     document as JSON string values only (policy 8.4), so a value containing a
//     typst code fragment is TEXT here, never markup.
//   - The render ORDER comes from `data.sections`, which the shared dictionary
//     (backend/src/render/dict.ts) emits in its own fixed order and which this
//     template iterates. It never decides an order for itself, which is what makes
//     three engines produce the same document order from one input.
//   - The font is named explicitly because the font set is CLOSED to the vendored
//     faces. Typst's built-in default is not in that set, so an unqualified
//     `#set text(...)` fails the moment the embedded fonts are ignored.
//   - No package is declared, so nothing is imported: an imported package would also
//     have to appear in this template's metadata AND in the vendored lockfile.
//   - No evaluated code, no file read, no network location, no webassembly module and
//     no exception control flow (a try block is a parse error inside a function or a
//     loop on the pinned engine, and it cannot propagate an assignment either).
//
// LAYOUT: one column, serif, no rules and no tables. Section headings are weight and
// size only, because an applicant-tracking system parses a single column of text and a
// horizontal rule is markup it may drop. Entry headings use `grid` for inline
// two-column alignment, which is layout and not a table; there is no `table` call in
// this file.

#let data = json("data.json")

#set document(title: data.contact.name, author: data.contact.name)
// The margin above is the gutter: `page(gutter:)` is NOT a parameter on the pinned engine
// (0.15.1), so a column gap is a margin, not a page key. Measured, not assumed.
#set page(
  paper: "a4",
  margin: (top: 15mm, bottom: 15mm, left: 18mm, right: 18mm),
)
#set text(font: "Source Serif 4", size: 9.5pt, lang: "en")
// LEADING AND THE SPACING CONSTANTS BELOW ARE MEASURED ON THE PINNED ENGINE. In Typst
// 0.15.1 `par(leading:)` applies WITHIN a paragraph; the gap between two list items and
// between two blocks is their own `spacing`/`below`, added to a line box that is shorter
// than the glyphs. A value under ~0.3em there puts consecutive bullets on the same band
// (the overlap this template shipped with), so the list/block gaps are kept at or above
// 0.3em and the text leading is 0.72em for a readable body.
#set par(leading: 0.72em, spacing: 0.5em, justify: true)

// Join the non-empty parts of a line, so an absent detail leaves no dangling separator.
#let join-parts(parts) = {
  let kept = ()
  for part in parts {
    if part != "" { kept.push(part) }
  }
  kept.join("  |  ")
}

#let contact-line() = join-parts((
  data.contact.email,
  data.contact.phone,
  data.contact.location,
  data.contact.website,
))

// A heading is weight and size. No rule, no colour, no icon.
// EVERY block below is written as a CONTENT BLOCK (`[ ... ]`), and that is not a style
// choice: a `#` inside a CODE-mode function body is a parse error on the pinned engine
// (0.15.1), so a section body has to be markup. Measured, not assumed.
#let section-title(name) = block(above: 0.9em, below: 0.6em)[
  #text(weight: "semibold", size: 10pt, tracking: 0.11em)[#upper(name)]
]

// One line: a left-hand title and a right-hand range, with the organisation under it.
#let entry-heading(left, right) = block(above: 0.7em, below: 0.75em)[
  #grid(
    columns: (1fr, auto),
    text(weight: "semibold")[#left],
    text(size: 8.5pt, fill: luma(32%))[#right],
  )
]

// The organisation line, with the place appended only when there is one.
#let place-line(organisation, place) = block(above: 0.15em, below: 0.7em)[
  #text(size: 9pt, fill: luma(32%))[
    #organisation#if place != "" [ , #place]
  ]
]

// A dash list with a hanging indent. `block(indent:)` is NOT a parameter on the pinned
// engine (0.15.1), so the list element owns the indent, and that is what separates the
// marker from the first word and lines the continuation up under the text. The set rule
// is scoped to this function's own content block, so it cannot leak into the rest of the
// document. Measured, not assumed.
#let bullet-lines(items) = [
  #set list(marker: [-], indent: 1.2em, body-indent: 0.55em, spacing: 1.0em)
  #for point in items [
    - #point
  ]
]

#let contact-block() = block(above: 0pt, below: 0.2em)[
  #align(center)[
    #text(size: 18pt, weight: "bold")[#data.contact.name]
    #if data.contact.headline != "" [
      #linebreak()
      #text(size: 10.5pt)[#data.contact.headline]
    ]
    #let details = contact-line()
    #if details != "" [
      #linebreak()
      #text(size: 8.5pt, fill: luma(38%))[#details]
    ]
  ]
]

#let summary-block() = [
  #section-title("summary")
  #data.summary
]

#let experience-block() = [
  #section-title("experience")
  #for job in data.experience [
    #entry-heading(job.title, job.rangeText)
    #place-line(job.organisation, job.location)
    #if job.summary != "" [#job.summary]
    #bullet-lines(job.highlights)
  ]
]

#let projects-block() = [
  #section-title("projects")
  #for project in data.projects [
    #entry-heading(project.name, project.rangeText)
    #if project.keywords.len() > 0 [
      #block(above: 0.15em, below: 0.7em)[#text(size: 8.5pt, fill: luma(38%))[#project.keywords.join(", ")]]
    ]
    #bullet-lines(project.highlights)
  ]
]

#let education-block() = [
  #section-title("education")
  #for entry in data.education [
    #entry-heading(entry.qualification, entry.rangeText)
    #let places = join-parts((entry.institution, entry.location, entry.score))
    #if places != "" [ #block(above: 0.15em, below: 0.7em)[#text(size: 9pt, fill: luma(38%))[#places]] ]
  ]
]

#let skills-block() = [
  #section-title("skills")
  #for skill in data.skills [
    #block(above: 0.4em)[
      #let items = if skill.keywords.len() > 0 { skill.keywords.join(", ") } else { skill.level }
      #if skill.name != "" [
        #text(weight: "semibold")[#skill.name:]
        #if items != "" [ #text(fill: luma(32%))[#items] ]
      ] else if items != "" [
        #text(fill: luma(32%))[#items]
      ]
    ]
  ]
]

#let certifications-block() = [
  #section-title("certifications")
  #for entry in data.certifications [
    #entry-heading(entry.name, entry.dateText)
    #if entry.issuer != "" [ #block(above: 0.15em, below: 0.7em)[#text(size: 9pt, fill: luma(32%))[#entry.issuer]] ]
  ]
]

// The dispatcher. `data.sections` is the ONLY order this document has.
#let section-body(name) = {
  if name == "contact" { contact-block() }
  else if name == "summary" { summary-block() }
  else if name == "experience" { experience-block() }
  else if name == "projects" { projects-block() }
  else if name == "education" { education-block() }
  else if name == "skills" { skills-block() }
  else if name == "certifications" { certifications-block() }
  else { [] }
}

#for name in data.sections [
  #section-body(name)
]
