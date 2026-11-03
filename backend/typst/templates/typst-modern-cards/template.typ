// Clearance resume template: typst-modern-cards
//
// TEMPLATE CONTRACT (render-sandbox-policy.md section 8)
//   - The ONLY data this template sees is the staged `data.json`, read with
//     `json("data.json")`. Resume content is UNTRUSTED input and it reaches this
//     document as JSON string values only (policy 8.4), so a value containing a
//     typst code fragment is TEXT here, never markup.
//   - The render ORDER comes from `data.sections`, the same array every other
//     Clearance template iterates, so this document's order is the dictionary's
//     order and not this file's.
//   - The font is named explicitly because the font set is CLOSED to the vendored
//     faces; Typst's built-in default is not in that set. This template
//     differentiates by LAYOUT, weight and rules - never by adding a typeface:
//     adding a font requires a new lockfile record, a new LICENSES.md entry, a
//     fetch-assets change and a re-run of the toolchain spike, all in one change, or
//     it does not ship.
//   - No package is declared, so nothing is imported. No evaluated code, no file
//     read, no network location, no webassembly module, and no exception control
//     flow (a try block is a parse error inside a function or a loop on the pinned
//     engine, and it cannot propagate an assignment either).
//
// LAYOUT: one column, and every entry is a `block` card with a hairline stroke and an
// inset. A card is a block, not a table and not a frame, so the document stays a single
// linear text flow an applicant-tracking system can read: `tablesAllowed` is false and
// no `table` call appears in this file. `grid` is used only for inline alignment inside
// a card.

#let data = json("data.json")

#set document(title: data.contact.name, author: data.contact.name)
// The margins below are the gutters: `page(gutter:)` is NOT a parameter on the pinned
// engine (0.15.1), so a margin is the only way to space the page. Measured, not assumed.
#set page(
  paper: "a4",
  margin: (top: 15mm, bottom: 15mm, left: 16mm, right: 16mm),
)
#set text(font: "Source Serif 4", size: 9pt, lang: "en")
// Leading and block/list spacing are kept above the measured floors (0.72em leading,
// 0.3em gaps). The cards are `breakable` blocks in one linear flow; the previous 0.6em
// leading with 0.03em list spacing let consecutive lines land on the same band.
#set par(leading: 0.72em, spacing: 0.5em, justify: true)

#let join-parts(parts) = {
  let kept = ()
  for part in parts {
    if part != "" { kept.push(part) }
  }
  kept.join("  |  ")
}

// The card. `block` with a stroke and an inset, and nothing else: no frame, no table, no
// positioned overlay, so the text inside it stays in the document's linear flow.
#let card(body) = block(
  width: 100%,
  above: 0.6em,
  below: 0.6em,
  inset: (x: 6pt, y: 5pt),
  radius: 2pt,
  stroke: (paint: luma(72%), thickness: 0.5pt),
  breakable: true,
)[#body]

#let card-title(left, right) = block(above: 0pt, below: 0.75em)[
  #grid(
    columns: (1fr, auto),
    text(weight: "bold", size: 9pt)[#left],
    text(size: 8pt, fill: luma(35%))[#right],
  )
]

#let card-meta(parts) = {
  let line = join-parts(parts)
  if line != "" { block(above: 0.15em, below: 0.7em)[#text(size: 8.2pt, fill: luma(35%))[#line]] }
}

// A dash list inside the cards. `block(indent:)` is NOT a parameter on the pinned engine
// (0.15.1), so the hanging indent comes from the `list` element's own `indent` and
// `body-indent`. The set rule is scoped to this content block. Measured, not assumed.
#let bullet-lines(items) = [
  #set list(marker: [-], indent: 1.1em, body-indent: 0.5em, spacing: 1.0em)
  #for point in items [
    - #point
  ]
]

// A section heading with a rule under it. Same family as the other two templates' heads,
// so the templates differ in the ENTRY treatment rather than in everything at once.
// The body is a CONTENT BLOCK (`[ ... ]`), not code: a `#` inside a code-mode function
// body is a parse error on the pinned engine (0.15.1), so a section body must be markup.
// Measured, not assumed.
#let section-title(name) = block(above: 0.8em, below: 0.55em)[
  #text(weight: "semibold", size: 9.6pt, tracking: 0.11em)[#upper(name)]
  #block(above: 0.14em, below: 0pt, line(length: 100%, stroke: 0.5pt + luma(45%)))
]
#let contact-block() = [
  #card[
    #align(center)[
      #text(size: 17pt, weight: "bold")[#data.contact.name]
      #if data.contact.headline != "" [
        #linebreak()
        #text(size: 10pt, fill: luma(25%))[#data.contact.headline]
      ]
      #let details = join-parts((
        data.contact.email,
        data.contact.phone,
        data.contact.location,
        data.contact.website,
        data.contact.linkedin,
        data.contact.github,
      ))
      #if details != "" [
        #linebreak()
        #text(size: 8pt, fill: luma(40%))[#details]
      ]
    ]
  ]
]

#let summary-block() = [
  #section-title("summary")
  #card[#data.summary]
]

#let experience-block() = [
  #section-title("experience")
  #for job in data.experience [
    #card[
      #card-title(job.title, job.rangeText)
      #card-meta((job.organisation, job.location))
      #if job.summary != "" [ #text(size: 8.4pt)[#job.summary] ]
      #bullet-lines(job.highlights)
    ]
  ]
]

#let projects-block() = [
  #section-title("projects")
  #for project in data.projects [
    #card[
      #card-title(project.name, project.rangeText)
      #if project.keywords.len() > 0 [
        #block(above: 0.15em, below: 0.7em)[#text(size: 8pt, fill: luma(40%))[#project.keywords.join(", ")]]
      ]
      #bullet-lines(project.highlights)
    ]
  ]
]

#let education-block() = [
  #section-title("education")
  #for entry in data.education [
    #card[
      #card-title(entry.qualification, entry.rangeText)
      #card-meta((entry.institution, entry.location, entry.score))
    ]
  ]
]

#let skills-block() = [
  #section-title("skills")
  #card[
    #for skill in data.skills [
      #block(above: 0.4em)[
        #let items = if skill.keywords.len() > 0 { skill.keywords.join(", ") } else { skill.level }
        #if skill.name != "" [
          #text(weight: "semibold")[#skill.name:]
          #if items != "" [ #text(fill: luma(35%))[#items] ]
        ] else if items != "" [
          #text(fill: luma(35%))[#items]
        ]
      ]
    ]
  ]
]

#let certifications-block() = [
  #section-title("certifications")
  #for entry in data.certifications [
    #card[
      #card-title(entry.name, entry.dateText)
      #card-meta((entry.issuer,))
    ]
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
