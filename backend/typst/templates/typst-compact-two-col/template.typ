// Clearance resume template: typst-compact-two-col
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
//     faces; Typst's built-in default is not in that set.
//   - No package is declared, so nothing is imported. No evaluated code, no file
//     read, no network location, no webassembly module, and no exception control
//     flow (a try block is a parse error inside a function or a loop on the pinned
//     engine, and it cannot propagate an assignment either).
//
// LAYOUT: two columns on A4 with a tighter leading than the other two templates, and a
// hairline rule under each section heading. The column count is declared in
// metadata.json and the registry checks that the declared `atsProfile.singleColumn`
// agrees with it, because a two-column resume must not claim to be single column.
// There is no `table` call in this file; `grid` is used only for inline alignment.

#let data = json("data.json")

#set document(title: data.contact.name, author: data.contact.name)
// The margins below are the gutters: `page(gutter:)` is NOT a parameter on the pinned
// engine (0.15.1), so the gap between these two columns is a margin, not a page key.
// Measured, not assumed.
#set page(
  paper: "a4",
  columns: 2,
  margin: (top: 13mm, bottom: 13mm, left: 14mm, right: 14mm),
)
#set text(font: "Source Serif 4", size: 8.2pt, lang: "en")
// LEADING AND SPACING ARE MEASURED ON THE PINNED ENGINE (0.15.1). A leading below
// 0.72em, or a list/block spacing below 0.3em, puts consecutive lines on the same band -
// which is what made this template's right column draw over its left. Both constants are
// kept at or above those floors.
#set par(leading: 0.72em, spacing: 0.5em, justify: true)

// Join the non-empty parts of a line, so an absent detail leaves no dangling separator.
#let join-parts(parts) = {
  let kept = ()
  for part in parts {
    if part != "" { kept.push(part) }
  }
  kept.join(" - ")
}

#let contact-line() = join-parts((
  data.contact.email,
  data.contact.phone,
  data.contact.location,
))

#let profile-line() = join-parts((data.contact.linkedin, data.contact.github, data.contact.website))

// A heading is a small line over a hairline. The rule is the compact variant's
// signature: it separates sections in a dense two-column flow, where vertical space is
// the scarce resource.
// The body is a CONTENT BLOCK (`[ ... ]`), not code: a `#` inside a code-mode function
// body is a parse error on the pinned engine (0.15.1), so a section body must be markup.
// Measured, not assumed.
#let section-title(name) = block(above: 0.8em, below: 0.6em)[
  #text(weight: "semibold", size: 8.2pt, tracking: 0.12em)[#upper(name)]
  #block(above: 0.12em, below: 0pt, line(length: 100%, stroke: 0.4pt + luma(58%)))
]

#let entry-title(title) = block(above: 0.7em, below: 0.75em)[
  #text(weight: "semibold", size: 8.2pt)[#title]
]

// A meta line, omitted entirely when it would be empty. Wrapped in its own block so the
// line cannot share a band with the entry title above it.
#let entry-meta(parts) = {
  let line = join-parts(parts)
  if line != "" { block(above: 0.15em, below: 0.7em)[#text(size: 7.4pt, fill: luma(35%))[#line]] }
}

// A dash list with a hanging indent. `block(indent:)` is NOT a parameter on the pinned
// engine (0.15.1), so the indent has to come from the `list` element's own `indent` and
// `body-indent`. The set rule is scoped to this content block. Measured, not assumed.
#let bullet-lines(items) = [
  #set list(marker: [-], indent: 0.95em, body-indent: 0.45em, spacing: 1.0em)
  #for point in items [
    - #point
  ]
]

#let contact-block() = block(above: 0pt, below: 0.1em)[
  #align(center)[
    #text(size: 14pt, weight: "bold")[#data.contact.name]
    #if data.contact.headline != "" [
      #linebreak()
      #text(size: 8.6pt)[#data.contact.headline]
    ]
    #let details = contact-line()
    #if details != "" [
      #linebreak()
      #text(size: 7.4pt, fill: luma(38%))[#details]
    ]
    #let links = profile-line()
    #if links != "" [
      #linebreak()
      #text(size: 7.4pt, fill: luma(38%))[#links]
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
    #entry-title(job.title)
    #entry-meta((job.organisation, job.location))
    #entry-meta((job.rangeText,))
    #if job.summary != "" [ #text(size: 7.8pt)[#job.summary] ]
    #bullet-lines(job.highlights)
  ]
]

#let projects-block() = [
  #section-title("projects")
  #for project in data.projects [
    #entry-title(project.name)
    #entry-meta((project.rangeText,))
    #if project.keywords.len() > 0 [
      #block(above: 0.15em, below: 0.7em)[#text(size: 7.4pt, fill: luma(35%))[#project.keywords.join(", ")]]
    ]
    #bullet-lines(project.highlights)
  ]
]

#let education-block() = [
  #section-title("education")
  #for entry in data.education [
    #entry-title(entry.qualification)
    #entry-meta((entry.institution, entry.location, entry.score))
    #entry-meta((entry.rangeText,))
  ]
]

#let skills-block() = [
  #section-title("skills")
  #for skill in data.skills [
    #block(above: 0.45em)[
      #let items = if skill.keywords.len() > 0 { skill.keywords.join(", ") } else { skill.level }
      #if skill.name != "" [
        #text(weight: "semibold", size: 8pt)[#skill.name:]
        #if items != "" [ #text(size: 7.4pt, fill: luma(35%))[#items] ]
      ] else if items != "" [
        #text(size: 7.4pt, fill: luma(35%))[#items]
      ]
    ]
  ]
]

#let certifications-block() = [
  #section-title("certifications")
  #for entry in data.certifications [
    #entry-title(entry.name)
    #entry-meta((entry.issuer, entry.dateText))
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
