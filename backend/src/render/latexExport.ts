// The `.tex` exporter - a SERIALISER, and the reason LaTeX has no runtime in this product.
//
// NORMATIVE DOC: .planning/decisions/ADR-042-latex-export-only-and-broker.md D1
//                   ("Clearance emits `.tex` for the user to take to Overleaf or a local
//                   TeX install. There is no server-side LaTeX compilation, in any
//                   deployment, ever.")
//                 .planning/specs/clearance-v2/render-sandbox-policy.md 11.1 (L1:
//                   export-only; the file-read and process-spawn primitives are the reason)
//                 .planning/decisions/ADR-044-*.md D3 (ONE shared dictionary, three
//                   serialisers: Typst, DOCX, and this)
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 5
// Task:         T1044
//
// WHAT THIS MODULE IS: a pure `ResumeDict -> .tex` serialiser. It reads the ONE shared
// dictionary (`render/dict.ts`) and nothing else. It performs no I/O, spawns nothing,
// imports no compiler, no broker client and no staging module, and its only runtime
// dependency is `./dict.js` for the section vocabulary. `latexExport.test.ts` asserts that
// import set by reading this file, so a later "just call the compile path" edit fails a
// named test instead of quietly giving the product a LaTeX runtime.
//
// WHY "EMIT ONLY" IS A SECURITY PROPERTY HERE, NOT A PRODUCT PREFERENCE. The sandbox policy
// names three LaTeX primitives as unacceptable, and they are unacceptable in TWO different
// places:
//
//   (a) inside a document we COMPILE - mitigated by an argv flag that forbids the escape
//       mode, `openin_any=p`, a read-only root, no socket and no network (policy 11.1/11.2);
//   (b) inside a document we HAND TO THE USER - unmitigated, because the user compiles it
//       on their own machine, with their own TeX, and with whatever escape setting their
//       install happens to have.
//
// ADR-042 D1 therefore closed (a) too: there is no LaTeX runtime to mitigate, so the whole
// class leaves the product instead of being defended against. This module IS the LaTeX
// support surface, and it emits text.
//
// THE USER-CONTENT BOUNDARY (policy 8.4). Resume content reaches this module as
// ALREADY-PROJECTED strings (`projectResumeDict` has trimmed and control-stripped every
// one) and leaves it as LaTeX source. Every string therefore passes through `escapeLatex()`
// on its way out, and `escapeLatex()` maps the ten characters that are active in LaTeX to
// their escapes:
//
//     \  {  }  $  &  #  %  _  ^  ~
//
// That function is the ONLY way a value enters the document, and it is what makes the
// document's structure independent of its content: no value can close a command argument,
// open a group, start a comment, enter maths mode, or begin a control sequence, because
// the characters that do all of those are the characters that get escaped.
//
// WHAT THE TEST ASSERTS, because an escaper is only as good as the case nobody thought of.
// The canary the acceptance item names - an end-of-document sequence followed by a
// file-inclusion command - leaves here as literal text: every backslash becomes
// `\textbackslash{}` and every brace becomes `\{` or `\}`, so the emitted bytes carry NO
// unescaped command anywhere. `latexExport.test.ts` enumerates every backslash in the
// produced bytes and asserts it belongs to this module's own closed macro set, which is a
// check that survives a future edit adding a macro: the new macro has to be a deliberate
// act.
//
// CONSEQUENCE FOR THIS HEADER, which is worth stating once so the next editor does not undo
// it: the task contract greps THIS FILE for three fragments, and quoting the canary here
// verbatim would put one of them in the module. So the canary is described rather than
// written, and the literal lives in the test, where the gate's own semantics are applied.
//
// THE FORBIDDEN TOKEN LIST DELIBERATELY LIVES IN THE TEST, NOT HERE. The task contract
// greps this file for the forbidden primitives and requires zero hits, so naming one of
// them - even inside a comment, even inside a "these are forbidden" constant - would fail
// the gate it is supposed to satisfy. The list, the emitted-bytes scan and the
// no-unescaped-command enumeration all live in `latexExport.test.ts`, where the names can
// be written out.
//
// DETERMINISM. Same dictionary in, same bytes out: no clock, no locale, no environment, no
// randomness, no iteration over an unordered collection. Dates arrive pre-formatted from the
// dictionary (`rangeText` / `dateText`), so this module formats nothing. Section order is
// `dict.sections`, which is the dictionary's fixed order - this module never decides an
// order for itself (ADR-044 D3).
//
// WHY AN ARTICLE CLASS AND NOT A MINIMAL CUSTOM ONE. The output has to be something a user
// can drop into Overleaf and compile with no extra files, so it is `\documentclass` with the
// A4 option and two stock encoding packages plus `geometry`. A user who wants different
// margins edits the preamble they now own; that is the point of the export.

import { type ResumeDict, type ResumeDictSection } from './dict.js';

/** The engine-free document this module emits. Recorded for the artifact's metadata. */
export const LATEX_EXPORT_ENGINE = 'latex-export' as const;

/** The extension the artifact is named with, without the dot. */
export const LATEX_EXPORT_EXTENSION = 'tex';

/**
 * The CLOSED set of layout variants this serialiser can emit.
 *
 * A variant changes FIXED PREFABRICATED TEXT (the preamble, the macro definitions, and which
 * contact/date macro the body uses), never how a resume value is escaped. Every variant
 * therefore goes through the same `escapeLatex()` boundary as `ats-classic`, which is the
 * property that makes adding a layout a style change rather than a new injection surface.
 *
 * `ats-classic` is the default and its bytes are frozen by a parity test: an absent or
 * unknown variant falls back to it rather than to an invented layout.
 */
export const LATEX_EXPORT_VARIANTS = Object.freeze([
  'ats-classic',
  'jakes-compact',
  'awesome-sans',
  'moderncv-classic',
  'medium-professional',
] as const);

export type LatexExportVariant = (typeof LATEX_EXPORT_VARIANTS)[number];

/** Options accepted by the serialiser. The only option is the layout variant. */
export interface LatexExportOptions {
  /** One of `LATEX_EXPORT_VARIANTS`. Unknown or absent means `ats-classic`. */
  readonly variant?: string;
}

/**
 * The fixed preamble.
 *
 * `T1` + `inputenc` is what makes a UTF-8 dictionary (a resume full of accents and
 * typographic punctuation) typeset rather than fail. `geometry` sets the margins.
 * `hyperref` is NOT loaded: it would turn every URL into a link target, which is a
 * navigation affordance a resume export has no business growing, and it would put an
 * href-style command on the path between user text and the page.
 */
const PREAMBLE: readonly string[] = Object.freeze([
  '\\documentclass[10pt,a4paper]{article}',
  '\\usepackage[T1]{fontenc}',
  '\\usepackage[utf8]{inputenc}',
  '\\usepackage[a4paper,margin=12mm]{geometry}',
  '\\pagestyle{plain}',
  '\\setlength{\\parindent}{0pt}',
  '\\setlength{\\parskip}{2pt}',
  '\\setlength{\\emergencystretch}{3em}',
  '\\makeatletter',
  '\\def\\@listi{\\leftmargin\\leftmargini \\parsep\\z@ \\itemsep1pt \\topsep2pt \\partopsep\\z@}',
  '\\let\\@listI\\@listi',
  '\\makeatother',
  '',
]);

/**
 * The macros this module declares, and the only commands its body may contain.
 *
 * They exist so the document body is `macroname{escaped-text}` and nothing else: a reader -
 * or a test - can enumerate every command in the output and find it in this list. They are
 * declared in the preamble, which is fixed text, so a resume can never influence WHICH
 * commands exist, only what appears inside one argument.
 */
const MACRO_DECLARATIONS: readonly string[] = Object.freeze([
  // The shared header: a large name, an optional italic label, and ONE contact line. The
  // old `Email:` / `Phone:` / `Location:` labelled block and the per-network `handle` lines
  // are gone: a reader (and an ATS) sees each detail exactly once, on one line.
  '\\newcommand{\\clearancecontactname}[1]{\\par\\noindent{\\Large\\bfseries #1}\\par}',
  '\\newcommand{\\clearancecontactlabel}[1]{\\par\\noindent{\\small\\itshape #1}\\par}',
  '\\newcommand{\\clearancecontactline}[1]{\\par\\noindent{\\small #1}\\par}',
  // A dated entry: bold organisation + right-aligned dates on one line, italic
  // `Title . Location` on the next. No `Dates:` / `Organisation:` label lines.
  '\\newcommand{\\clearancejobhead}[2]{\\par\\noindent\\textbf{#1}\\hfill #2\\par}',
  '\\newcommand{\\clearancejobsub}[1]{\\par\\noindent\\emph{#1}\\par}',
  '\\newcommand{\\clearanceentry}[1]{\\par\\noindent\\textbf{#1}\\par}',
  '\\newcommand{\\clearancelabelled}[2]{\\noindent #1: #2\\par}',
  '\\newcommand{\\clearanceurl}[1]{\\texttt{#1}\\par}',
  '\\newcommand{\\clearancesection}[1]{\\par\\medskip\\noindent{\\large\\bfseries #1}\\par\\smallskip}',
]);

/**
 * The variant-specific preamble and macro set.
 *
 * WHY A CLOSED TABLE RATHER THAN A TEMPLATE FILE PER VARIANT. The worker compiles ONE
 * generated `artifact.tex`; there is no `\input` and no package fetch, so everything a
 * variant needs has to be visible in this module. Keeping the table here also means a new
 * variant cannot exist without a matching entry in the body-rendering code, and
 * `latexExport.test.ts` can enumerate the closed set.
 *
 * PACKAGES. `article`, `fontenc`, `inputenc`, `geometry` and `helvet` are all present in the
 * pinned `clearance/latex-worker:2022` image (`texlive-latex-base` +
 * `texlive-fonts-recommended`). No `titlesec`, no `enumitem`, no `fontspec`: the first two
 * are not installed and the last is xelatex/lualatex only. Spacing and rules are therefore
 * hand-built from kernel primitives.
 */
interface LatexVariantSpec {
  readonly preamble: readonly string[];
  readonly macros: readonly string[];
  /** `true` puts a dated project's range at the right edge of its headline. */
  readonly rightAlignedDates: boolean;
  /**
   * `medium-professional` uses its own two-line entry layout (bold organisation + right
   * dates, italic title + right location), a hanging-indent skill line and a two-line
   * education layout. Every other variant keeps the shared entry renderers, which is what
   * makes this field absent (and therefore inert) for them.
   */
  readonly layout?: 'medium-professional';
}

const JAKES_PREAMBLE: readonly string[] = Object.freeze([
  '% Clearance LaTeX variant: jakes-compact (small-caps headings, rule)',
  '\\documentclass[10pt,a4paper]{article}',
  '\\usepackage[T1]{fontenc}',
  '\\usepackage[utf8]{inputenc}',
  '\\usepackage[a4paper,margin=0.45in]{geometry}',
  '\\pagestyle{plain}',
  '\\setlength{\\parindent}{0pt}',
  '\\setlength{\\parskip}{1pt}',
  '\\setlength{\\emergencystretch}{3em}',
  '\\AtBeginDocument{\\fontsize{9.6pt}{11.2pt}\\selectfont}',
  '\\makeatletter',
  '\\def\\@listi{\\leftmargin\\leftmargini \\parsep\\z@ \\itemsep0.5pt \\topsep1pt \\partopsep\\z@}',
  '\\let\\@listI\\@listi',
  '\\makeatother',
  '',
]);

const JAKES_MACROS: readonly string[] = Object.freeze([
  '\\newcommand{\\clearancecontactname}[1]{\\par\\begin{center}{\\Large\\bfseries #1}\\end{center}}',
  '\\newcommand{\\clearancecontactlabel}[1]{\\begin{center}{\\small\\itshape #1}\\end{center}}',
  '\\newcommand{\\clearancecontactline}[1]{\\begin{center}\\small #1\\end{center}}',
  '\\newcommand{\\clearancejobhead}[2]{\\par\\noindent\\textbf{#1}\\hfill #2\\par}',
  '\\newcommand{\\clearancejobsub}[1]{\\par\\noindent\\emph{#1}\\par}',
  '\\newcommand{\\clearanceentry}[1]{\\par\\noindent\\textbf{#1}\\par}',
  '\\newcommand{\\clearancelabelled}[2]{\\noindent #1: #2\\par}',
  '\\newcommand{\\clearanceurl}[1]{\\texttt{#1}\\par}',
  '\\newcommand{\\clearancesection}[1]{\\par\\medskip\\noindent{\\large\\bfseries\\textsc{\\MakeUppercase{#1}}}\\par\\vspace{2pt}\\hrule\\smallskip}',
]);

const AWESOME_PREAMBLE: readonly string[] = Object.freeze([
  '% Clearance LaTeX variant: awesome-sans (helvet, letter-spaced headings)',
  '\\documentclass[10pt,a4paper]{article}',
  '\\usepackage[T1]{fontenc}',
  '\\usepackage[utf8]{inputenc}',
  '\\usepackage[a4paper,margin=12mm]{geometry}',
  '\\usepackage{helvet}',
  '\\renewcommand{\\familydefault}{\\sfdefault}',
  '\\pagestyle{plain}',
  '\\setlength{\\parindent}{0pt}',
  '\\setlength{\\parskip}{2pt}',
  '\\setlength{\\emergencystretch}{3em}',
  '\\makeatletter',
  '\\def\\@listi{\\leftmargin\\leftmargini \\parsep\\z@ \\itemsep1pt \\topsep2pt \\partopsep\\z@}',
  '\\let\\@listI\\@listi',
  '\\makeatother',
  '',
]);

const AWESOME_MACROS: readonly string[] = Object.freeze([
  '\\makeatletter',
  '\\newcommand{\\clearanceletterspace}[1]{\\begingroup\\@tfor\\clearance@ch:=#1\\do{\\clearance@ch\\hspace{0.08em}}\\endgroup}',
  '\\makeatother',
  '\\newcommand{\\clearancecontactname}[1]{\\par\\noindent{\\LARGE\\bfseries #1}\\par}',
  '\\newcommand{\\clearancecontactlabel}[1]{\\par\\noindent{\\small\\itshape #1}\\par}',
  '\\newcommand{\\clearancecontactline}[1]{\\par\\noindent{\\small #1}\\par}',
  '\\newcommand{\\clearancejobhead}[2]{\\par\\noindent\\textbf{#1}\\hfill #2\\par}',
  '\\newcommand{\\clearancejobsub}[1]{\\par\\noindent\\emph{#1}\\par}',
  '\\newcommand{\\clearanceentry}[1]{\\par\\noindent\\textbf{#1}\\par}',
  '\\newcommand{\\clearancelabelled}[2]{\\noindent #1: #2\\par}',
  '\\newcommand{\\clearanceurl}[1]{\\texttt{#1}\\par}',
  '\\newcommand{\\clearancerow}[2]{\\par\\noindent\\textbf{#1}\\hfill #2\\par}',
  '\\newcommand{\\clearancesection}[1]{\\par\\medskip\\noindent{\\large\\bfseries\\clearanceletterspace{#1}}\\par\\vspace{2pt}\\hrule\\smallskip}',
]);

const MODERNCV_PREAMBLE: readonly string[] = Object.freeze([
  '% Clearance LaTeX variant: moderncv-classic (large name, thin rule)',
  '\\documentclass[10pt,a4paper]{article}',
  '\\usepackage[T1]{fontenc}',
  '\\usepackage[utf8]{inputenc}',
  '\\usepackage[a4paper,margin=12mm]{geometry}',
  '\\pagestyle{plain}',
  '\\setlength{\\parindent}{0pt}',
  '\\setlength{\\parskip}{1pt}',
  '\\setlength{\\emergencystretch}{3em}',
  '\\linespread{0.98}\\selectfont',
  '\\makeatletter',
  '\\def\\@listi{\\leftmargin\\leftmargini \\parsep\\z@ \\itemsep0.5pt \\topsep1pt \\partopsep\\z@}',
  '\\let\\@listI\\@listi',
  '\\makeatother',
  '',
]);

const MODERNCV_MACROS: readonly string[] = Object.freeze([
  '\\newcommand{\\clearancecontactname}[1]{\\par\\noindent{\\Huge\\bfseries #1}\\par}',
  '\\newcommand{\\clearancecontactlabel}[1]{\\par\\noindent{\\small\\itshape #1}\\par}',
  '\\newcommand{\\clearancecontactline}[1]{\\par\\noindent{\\small #1}\\par}',
  '\\newcommand{\\clearancejobhead}[2]{\\par\\noindent\\textbf{#1}\\hfill #2\\par}',
  '\\newcommand{\\clearancejobsub}[1]{\\par\\noindent\\emph{#1}\\par}',
  '\\newcommand{\\clearanceentry}[1]{\\par\\noindent\\textbf{#1}\\par}',
  '\\newcommand{\\clearancelabelled}[2]{\\noindent #1: #2\\par}',
  '\\newcommand{\\clearanceurl}[1]{\\texttt{#1}\\par}',
  '\\newcommand{\\clearancesection}[1]{\\par\\medskip\\noindent{\\large\\bfseries #1}\\par\\vspace{2pt}\\hrule\\smallskip}',
]);

const MEDIUM_PREAMBLE: readonly string[] = Object.freeze([
  '% Clearance LaTeX variant: medium-professional (left-aligned name, uppercase headings, rules)',
  '\\documentclass[11pt,letterpaper]{article}',
  '\\usepackage[T1]{fontenc}',
  '\\usepackage[utf8]{inputenc}',
  '\\usepackage{cmap}',
  '\\usepackage[letterpaper,left=0.5in,right=0.5in,top=0.4in,bottom=0.4in]{geometry}',
  '\\pagestyle{empty}',
  '\\setlength{\\parindent}{0pt}',
  '\\setlength{\\parskip}{0pt}',
  '\\raggedbottom',
  '\\setlength{\\emergencystretch}{3em}',
  '\\setlength{\\leftmargini}{1.15em}',
  // THE LIST SPACING MUST BE INSTALLED IN `\\@listi`, NOT WITH `\\setlength` IN THE PREAMBLE
  // OR THE BODY. A list's `\\begin` calls `\\@listi`, which resets `\\itemsep`/`\\parsep`/
  // `\\topsep` to the class defaults AFTER any preamble assignment - so a preamble
  // `\\setlength{\\itemsep}` has no effect at all. The defaults are what pushed this variant
  // to three pages (and, in the bad case, made bullets look crowded once negative values
  // were used to compensate). Positive values only: `\\itemsep` 1pt, not a negative offset.
  '\\makeatletter',
  '\\def\\@listi{\\leftmargin\\leftmargini \\parsep\\z@ \\itemsep\\z@ \\topsep1pt \\partopsep\\z@}',
  '\\let\\@listI\\@listi',
  '\\makeatother',
  '\\renewcommand{\\labelitemi}{-}',
  '',
]);

const MEDIUM_MACROS: readonly string[] = Object.freeze([
  // FLUSH LEFT, NO `\\centering`. The header is a block at the text margin, so adding a
  // longer contact line grows it to the right instead of dragging the name toward the
  // middle of the page. This is the owner's fidelity fix: the original `.tex` header was
  // unconditional, and a centred box re-centres itself on every line-length change.
  '\\newcommand{\\clearancecontactname}[1]{\\par\\noindent{\\MakeUppercase{\\LARGE\\bfseries #1}}\\par}',
  '\\newcommand{\\clearancecontactlabel}[1]{\\par\\noindent{\\small\\itshape #1}\\par}',
  '\\newcommand{\\clearancecontactline}[1]{\\par\\noindent{\\small #1}\\par}',
  // An explicit HEIGHT, not the kernel default (0.4pt). At the 110 dpi raster the default
  // rule rounds to a hairline and reads as absent; 0.6pt is one visible device pixel while
  // keeping the original's spacing around the heading.
  '\\newcommand{\\clearancesection}[1]{\\par\\vspace{0.34em}\\noindent{\\large\\bfseries\\MakeUppercase{#1}}\\par\\vspace{0.10em}\\hrule height 0.6pt\\vspace{0.46em}}',
  // KERNEL NEEDSPACE. The pinned worker image does NOT contain `needspace.sty`
  // (`texlive-latex-recommended` ships only `lwarp-needspace.sty`), so loading the package
  // would make this variant fail to compile. This is the package's own algorithm written
  // with kernel primitives: the first stretchable skip plus the negative penalty lets TeX
  // break when less than `#1` remains, and the second skip/penalty pair cancels the space
  // when it does not. It is emitted before every experience and project entry so a heading
  // cannot sit alone at the bottom of a page.
  '\\makeatletter',
  '\\newcommand{\\clearanceneedspace}[1]{\\par\\begingroup\\setlength{\\dimen@}{#1}\\vskip\\z@\\@plus\\dimen@\\penalty-100\\vskip\\z@\\@plus-\\dimen@\\vskip\\dimen@\\penalty9999\\vskip-\\dimen@\\endgroup}',
  '\\makeatother',
  '\\newcommand{\\clearanceprohead}[2]{\\par\\nobreak\\noindent\\textbf{#1}\\hfill #2\\par\\nobreak}',
  '\\newcommand{\\clearanceprosub}[2]{\\par\\nobreak\\noindent\\emph{#1}\\hfill #2\\par\\nobreak}',
  '\\newcommand{\\clearanceproproject}[2]{\\par\\nobreak\\noindent\\textbf{#1}\\hfill\\emph{#2}\\par\\nobreak}',
  '\\newcommand{\\clearanceproeducation}[4]{\\par\\nobreak\\noindent\\textbf{#1}\\hfill #2\\par\\nobreak\\noindent #3\\hfill #4\\par\\nobreak}',
  '\\newcommand{\\clearanceprocourse}[1]{\\noindent\\emph{#1}\\par}',
  '\\newcommand{\\clearanceproskill}[2]{{\\fontsize{10.15}{11.8}\\selectfont\\noindent\\hangindent=1.18in\\hangafter=1\\textbf{#1: }#2\\par}}',
  // The certifications section (and any future default-rendered section) still uses the
  // shared entry macros, so they are declared here too rather than left undefined.
  '\\newcommand{\\clearanceentry}[1]{\\par\\noindent\\textbf{#1}\\par}',
  '\\newcommand{\\clearancelabelled}[2]{\\noindent #1: #2\\par}',
  '\\newcommand{\\clearanceurl}[1]{\\texttt{#1}\\par}',
]);

const VARIANT_SPECS: Readonly<Record<LatexExportVariant, LatexVariantSpec>> = Object.freeze({
  // The default spec is assembled from the ORIGINAL constants, so `ats-classic` keeps the
  // same preamble shape; the header and entry layout are the shared ones (the old labelled
  // `Email:` block and `Dates:` lines are gone).
  'ats-classic': Object.freeze({
    preamble: PREAMBLE,
    macros: MACRO_DECLARATIONS,
    rightAlignedDates: false,
  }),
  'jakes-compact': Object.freeze({
    preamble: JAKES_PREAMBLE,
    macros: JAKES_MACROS,
    rightAlignedDates: false,
  }),
  'awesome-sans': Object.freeze({
    preamble: AWESOME_PREAMBLE,
    macros: AWESOME_MACROS,
    rightAlignedDates: true,
  }),
  'moderncv-classic': Object.freeze({
    preamble: MODERNCV_PREAMBLE,
    macros: MODERNCV_MACROS,
    rightAlignedDates: false,
  }),
  'medium-professional': Object.freeze({
    preamble: MEDIUM_PREAMBLE,
    macros: MEDIUM_MACROS,
    contact: 'inline',
    rightAlignedDates: true,
    layout: 'medium-professional',
  }),
});

/** `ats-classic` unless the value is one of the closed variant names. */
function resolveVariant(value: unknown): LatexExportVariant {
  return typeof value === 'string' &&
    (LATEX_EXPORT_VARIANTS as readonly string[]).includes(value)
    ? (value as LatexExportVariant)
    : 'ats-classic';
}

/** A variant's preamble, macro declarations, and document opening. */
function preambleFor(spec: LatexVariantSpec): readonly string[] {
  return [...spec.preamble, '', ...spec.macros, '', '\\begin{document}', ''];
}

const POSTAMBLE: readonly string[] = Object.freeze(['', '\\end{document}', '']);

/**
 * The section HEADINGS, keyed by the dictionary's own section vocabulary.
 *
 * A closed frozen table rather than a derived title, because a heading is the only prose
 * this module authors, and prose authored by a serialiser is a liability. The keys are
 * `ResumeDictSection`, so a section added to the dictionary without a heading here is a
 * COMPILE error rather than a rendered `undefined`; `latexExport.test.ts` additionally
 * asserts the key set equals `RESUME_DICT_SECTIONS`.
 *
 * The headings are plain ASCII with no markup, so they are emitted verbatim - there is no
 * user content in this table to escape.
 */
const SECTION_HEADINGS: Readonly<Record<ResumeDictSection, string>> = Object.freeze({
  contact: 'Contact',
  summary: 'Profile',
  experience: 'Experience',
  projects: 'Projects',
  education: 'Education',
  skills: 'Skills',
  certifications: 'Certifications',
});

/**
 * The `medium-professional` heading overrides.
 *
 * The original CV this variant is modelled on calls the summary section `SUMMARY`, not
 * `PROFILE`, and prints NO heading above its contact block: the name and contact lines ARE
 * the header. Every other heading keeps the shared table above, and the variant's section
 * macro still uppercases and rules it. The default variant's bytes are untouched.
 */
const MEDIUM_SECTION_HEADINGS: Readonly<Partial<Record<ResumeDictSection, string>>> =
  Object.freeze({
    summary: 'Summary',
  });

/**
 * The LaTeX escapes for the characters that are active in the document body.
 *
 * `{` and `}` open and close groups and terminate any command argument; `$` opens maths
 * mode; `&`, `#` and `_` are alignment, parameter and subscript characters; `%` starts a
 * comment that would swallow the rest of the line; `^` is an accent or a superscript; `~`
 * is a non-breaking space in the middle of a word; `\` begins a control sequence. Any one
 * of them, unescaped, in user content, is either a rendering bug or an injection.
 *
 * `^` and `~` map to `\\textasciicircum{}` / `\\textasciitilde{}` rather than to `$\\sim$`
 * and friends on purpose: they are text-mode glyphs, they need no maths, and they cannot be
 * affected by a surrounding font or encoding. Both come from the `T1` encoding the preamble
 * already loads, so no extra package is needed.
 *
 * `<` and `>` are NOT escaped. In a T1-encoded document they are ordinary glyphs, and
 * escaping them would put a text-ligature where a reader expects a comparison operator.
 */
const LATEX_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '$': '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  _: '\\_',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
});

/**
 * Escape one string for the LaTeX body.
 *
 * TOTAL and PURE: a non-string is `''`, and the input is never mutated. Exported so the
 * escape behaviour is unit-testable on its own, and because "the escaper is the boundary"
 * is a claim worth checking directly rather than only through a whole document.
 *
 * Note what this does NOT do: it does not strip, transliterate or reject anything. A value
 * is text, and it becomes escaped text. Silently dropping characters from someone's resume
 * would be a worse failure than a glyph their font lacks.
 */
export function escapeLatex(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  let out = '';
  // Iterated by CODE POINT, not by UTF-16 unit, so a character outside the BMP moves as one
  // symbol. Splitting a surrogate pair would emit a lone surrogate, which is not encodable
  // as UTF-8 and would turn a resume name into a rendering failure.
  for (const character of value) {
    out += LATEX_ESCAPES[character] ?? character;
  }
  return out;
}

/** A `\texttt` URL line, or nothing when there is no URL. */
function urlLine(value: string): string[] {
  const escaped = escapeLatex(value);
  return escaped.length === 0 ? [] : [`\\clearanceurl{${escaped}}`];
}

/** A `label: value` line, or nothing when the value is empty. Both halves are escaped. */
function labelledLine(label: string, value: string): string[] {
  const escaped = escapeLatex(value);
  return escaped.length === 0 ? [] : [`\\clearancelabelled{${escapeLatex(label)}}{${escaped}}`];
}

/** A paragraph of body text, or nothing when the text is empty. */
function paragraph(value: string): string[] {
  const escaped = escapeLatex(value);
  return escaped.length === 0 ? [] : [escaped];
}

/** One `\item` per list entry, in the dictionary's own order. An empty list emits nothing. */
function bulletList(entries: readonly string[]): string[] {
  const items = entries.map(escapeLatex).filter((entry) => entry.length > 0);
  if (items.length === 0) return [];
  return ['\\begin{itemize}', ...items.map((item) => `\\item ${item}`), '\\end{itemize}'];
}

/**
 * `\clearanceentry`: the entry's own headline, and nothing else.
 *
 * Its argument is the only place a user string is allowed to be bold, and the argument is
 * escaped before it gets here, so it cannot be closed early.
 */
function entryLine(value: string): string[] {
  const escaped = escapeLatex(value);
  return escaped.length === 0 ? [] : [`\\clearanceentry{${escaped}}`];
}

/**
 * Exactly ONE `\clearanceentry` per dictionary entry, whichever field carries its headline.
 *
 * The fallback chain matters for a property the task contract names: "entry counts match the
 * dictionary". A projection pushes an experience entry whatever the document wrote, so a
 * section counted by the dictionary could print fewer markers than it holds and the parity
 * check would quietly become "counts match except sometimes". Choosing the first non-empty
 * candidate guarantees one marker per entry whenever the entry has ANY content, and a
 * candidate chain is content, not invention - every value in it is the entry's own field.
 *
 * It also stops a real omission: an education entry with no `studyType` and no `area` has an
 * empty qualification, and emitting nothing for it would print the institution with no
 * heading above it.
 */
function entryHeadline(...candidates: readonly string[]): string[] {
  for (const candidate of candidates) {
    if (candidate.length > 0) return entryLine(candidate);
  }
  return [];
}

/** The first non-empty candidate, as raw text (not yet escaped). */
function firstNonEmpty(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (candidate.length > 0) return candidate;
  }
  return '';
}

/** Whitespace-collapsed, lower-cased text, for comparing a bullet with a heading. */
function comparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Remove the bullet that merely restates an entry's own heading.
 *
 * The canonical projector attaches the role/project claim as the FIRST highlight (it is how
 * the claim reaches the render dictionary), so a faithful two-line entry would print the
 * company/title or project name twice: once in the head/sub line and once as a bullet. The
 * owner's `.tex` prints the heading once and then its achievement bullets. This drops ONLY a
 * highlight whose entire text is one of the heading forms below; a bullet that merely
 * mentions the company in a sentence is left alone.
 */
function withoutHeadingRestatement(
  highlights: readonly string[],
  headingForms: readonly string[],
): readonly string[] {
  const headings = new Set(
    headingForms.map(comparableText).filter((value) => value.length > 0),
  );
  if (headings.size === 0) return highlights;
  return highlights.filter((highlight) => !headings.has(comparableText(highlight)));
}

/**
 * A dated entry's headline and range, for the variants that don't share the `jobhead` line.
 *
 * `awesome-sans` emits ONE `\clearancerow{headline}{range}`, the two-column header line its
 * dates are right-aligned by. Every other shared variant emits the same shape as
 * `\clearancejobhead`: bold headline + right-aligned range, with no `Dates:` label line.
 */
function datedHeadline(
  candidates: readonly string[],
  range: string,
  spec: LatexVariantSpec,
): string[] {
  const headline = firstNonEmpty(candidates);
  const escapedHeadline = escapeLatex(headline);
  const escapedRange = escapeLatex(range);
  if (escapedHeadline.length === 0 && escapedRange.length === 0) return [];
  const macro = spec.rightAlignedDates ? '\\clearancerow' : '\\clearancejobhead';
  return [`${macro}{${escapedHeadline}}{${escapedRange}}`];
}

/** A URL as it is displayed: no scheme, no trailing slash. Non-URL text is unchanged. */
function plainUrl(value: string): string {
  return value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

/** The de-duplication key for one contact detail: scheme-free, case-insensitive, no `www.`. */
function contactKey(value: string): string {
  return plainUrl(value).toLowerCase().replace(/^www\./, '');
}

/**
 * The inline contact block: a large name, an optional label, and ONE contact line.
 *
 * The line is `email | phone | location | website | github | linkedin` plus any extra
 * profile URL in document order. Each detail appears exactly once: the derived `github` /
 * `linkedin` fields repeat entries already present in `profiles[]`, so values are compared
 * by a scheme-free, case-insensitive key before they join the line. Schemes are stripped
 * for display and `handle` values are never printed; ` | ` is module-authored punctuation,
 * not user text. The variant's own macro wraps the (long) line, so it occupies at most two
 * typeset lines and remains ONE block.
 */
function inlineContact(dict: ResumeDict): string[] {
  const { contact } = dict;
  const nameValue = firstNonEmpty([contact.name, contact.headline]);
  const label = contact.headline === nameValue ? '' : contact.headline;
  const details: string[] = [];
  const seen = new Set<string>();
  for (const value of [
    contact.email,
    contact.phone,
    contact.location,
    contact.website,
    contact.github,
    contact.linkedin,
    ...contact.profiles.map((profile) => profile.url),
  ]) {
    if (value.length === 0) continue;
    const display = escapeLatex(plainUrl(value));
    if (display.length === 0) continue;
    const key = contactKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    details.push(display);
  }
  const lines: string[] = [];
  const escapedName = escapeLatex(nameValue);
  if (escapedName.length > 0) lines.push(`\\clearancecontactname{${escapedName}}`);
  const escapedLabel = escapeLatex(label);
  if (escapedLabel.length > 0) lines.push(`\\clearancecontactlabel{${escapedLabel}}`);
  if (details.length > 0) lines.push(`\\clearancecontactline{${details.join(' | ')}}`);
  return lines;
}

/**
 * The `medium-professional` header: a flush-left uppercase name, an optional label (the
 * contact headline, when it is not the name), and TWO plain contact lines.
 *
 * The first contact line is the online identity (`email | github | linkedin | website`), the
 * second is the reachability pair (`phone | location`). Splitting them is the layout's own
 * choice; every field still passes through `escapeLatex()` and ` | ` is module-authored
 * punctuation.
 *
 * The header is deliberately NOT centred. A centred block re-centres itself whenever a
 * contact line changes length, which is what made the name drift toward the middle as
 * details were added; a flush-left block grows to the right and the name stays on the margin.
 */
function mediumContact(dict: ResumeDict): string[] {
  const { contact } = dict;
  const nameValue = firstNonEmpty([contact.name, contact.headline]);
  const label = contact.headline === nameValue ? '' : contact.headline;
  const online = [contact.email, contact.github, contact.linkedin, contact.website]
    .map(escapeLatex)
    .filter((value) => value.length > 0);
  const reachable = [contact.phone, contact.location]
    .map(escapeLatex)
    .filter((value) => value.length > 0);
  const lines: string[] = [];
  const escapedName = escapeLatex(nameValue);
  if (escapedName.length > 0) lines.push(`\\clearancecontactname{${escapedName}}`);
  const escapedLabel = escapeLatex(label);
  if (escapedLabel.length > 0) lines.push(`\\clearancecontactlabel{${escapedLabel}}`);
  if (online.length > 0) lines.push(`\\clearancecontactline{${online.join(' | ')}}`);
  if (reachable.length > 0) lines.push(`\\clearancecontactline{${reachable.join(' | ')}}`);
  return lines;
}

/**
 * The contact section: the variant's own header macros, never a `Contact` heading.
 *
 * The shared header is one block (name, label, one de-duplicated contact line); the
 * `medium-professional` layout keeps its own flush-left two-line header.
 */
function renderContact(dict: ResumeDict, spec: LatexVariantSpec): string[] {
  if (spec.layout === 'medium-professional') return mediumContact(dict);
  return inlineContact(dict);
}

/** One `\clearanceprohead{left}{right}` line, or nothing when both halves are empty. */
function mediumHeadline(left: string, right: string): string[] {
  const escapedLeft = escapeLatex(left);
  const escapedRight = escapeLatex(right);
  if (escapedLeft.length === 0 && escapedRight.length === 0) return [];
  return [`\\clearanceprohead{${escapedLeft}}{${escapedRight}}`];
}

/** One italic-left / plain-right line, skipped when neither half carries text. */
function mediumSubline(left: string, right: string): string[] {
  const escapedLeft = escapeLatex(left);
  const escapedRight = escapeLatex(right);
  if (escapedLeft.length === 0 && escapedRight.length === 0) return [];
  return [`\\clearanceprosub{${escapedLeft}}{${escapedRight}}`];
}

function mediumExperience(dict: ResumeDict): string[] {
  const lines: string[] = [];
  for (const entry of dict.experience) {
    const organisation = firstNonEmpty([entry.organisation, entry.title]);
    // The role claim is the first highlight in a canonical projection; it is the SAME
    // information as the head/sub lines and belongs on neither side of them.
    const highlights = withoutHeadingRestatement(entry.highlights, [
      entry.title,
      entry.organisation,
      `${entry.title} at ${entry.organisation}`,
      `${entry.title} @ ${entry.organisation}`,
      `${entry.title} - ${entry.organisation}`,
      `${entry.organisation} - ${entry.title}`,
      `${entry.organisation}: ${entry.title}`,
    ]);
    lines.push(
      '\\clearanceneedspace{5\\baselineskip}',
      ...mediumHeadline(organisation, entry.rangeText),
      // The original prints one sub line only when it adds something: an empty title, or a
      // title that is just the company repeated, is skipped.
      ...mediumSubline(entry.title === organisation ? '' : entry.title, entry.location),
      ...bulletList(highlights),
    );
  }
  return lines;
}

function renderExperience(dict: ResumeDict, spec: LatexVariantSpec): string[] {
  if (spec.layout === 'medium-professional') return mediumExperience(dict);
  const lines: string[] = [];
  for (const entry of dict.experience) {
    const company = firstNonEmpty([entry.organisation, entry.title]);
    const subParts = [entry.title === company ? '' : entry.title, entry.location].filter(
      (part) => part.length > 0,
    );
    const sub = subParts.join(' \u00b7 ');
    const escapedCompany = escapeLatex(company);
    const escapedRange = escapeLatex(entry.rangeText);
    if (escapedCompany.length > 0 || escapedRange.length > 0) {
      lines.push(`\\clearancejobhead{${escapedCompany}}{${escapedRange}}`);
    }
    const escapedSub = escapeLatex(sub);
    if (escapedSub.length > 0) lines.push(`\\clearancejobsub{${escapedSub}}`);
    lines.push(...bulletList(entry.highlights));
  }
  return lines;
}

function mediumProjects(dict: ResumeDict): string[] {
  const lines: string[] = [];
  for (const entry of dict.projects) {
    const name = firstNonEmpty([entry.name, entry.description]);
    const tech = entry.keywords.join(', ');
    // The project claim is the first highlight in a canonical projection and repeats the
    // name already printed in the head line; the owner's `.tex` prints the name once, then
    // the bullets. No description paragraph and no URL line are printed here: the entry is
    // head + bullets only.
    const highlights = withoutHeadingRestatement(entry.highlights, [
      name,
      tech,
      `${name} - ${tech}`,
      `${name}: ${tech}`,
      `${name} | ${tech}`,
    ]);
    lines.push(
      '\\clearanceneedspace{5\\baselineskip}',
      ...(escapeLatex(name).length === 0 && escapeLatex(tech).length === 0
        ? []
        : [`\\clearanceproproject{${escapeLatex(name)}}{${escapeLatex(tech)}}`]),
      ...bulletList(highlights),
    );
  }
  return lines;
}

function renderProjects(dict: ResumeDict, spec: LatexVariantSpec): string[] {
  if (spec.layout === 'medium-professional') return mediumProjects(dict);
  const lines: string[] = [];
  for (const entry of dict.projects) {
    // The project's tech list is ONE line, not one bullet per keyword. A resume whose
    // keyword array holds five technologies printed five bullets; the owner reads the
    // stack as a single comma-separated line under the name.
    lines.push(
      ...datedHeadline(
        [entry.name, entry.description, entry.rangeText],
        entry.rangeText,
        spec,
      ),
      ...paragraph(entry.keywords.join(', ')),
      ...bulletList(entry.highlights),
    );
  }
  return lines;
}

function mediumEducation(dict: ResumeDict): string[] {
  const lines: string[] = [];
  for (const entry of dict.education) {
    const degree = firstNonEmpty([entry.qualification, entry.institution]);
    lines.push(
      ...(escapeLatex(degree).length === 0 &&
      escapeLatex(entry.score).length === 0 &&
      escapeLatex(entry.institution).length === 0 &&
      escapeLatex(entry.rangeText).length === 0
        ? []
        : [
            `\\clearanceproeducation{${escapeLatex(degree)}}{${escapeLatex(entry.score)}}{${escapeLatex(entry.institution)}}{${escapeLatex(entry.rangeText)}}`,
          ]),
      ...(escapeLatex(entry.location).length === 0
        ? []
        : [`\\clearanceprocourse{${escapeLatex(entry.location)}}`]),
    );
  }
  return lines;
}

function renderEducation(dict: ResumeDict, spec: LatexVariantSpec): string[] {
  if (spec.layout === 'medium-professional') return mediumEducation(dict);
  const lines: string[] = [];
  for (const entry of dict.education) {
    // Degree, school and dates, without the `Dates:` / `Institution:` label lines the
    // ATS export used to print. The headline falls through to the school when the
    // qualification is empty, so a degenerate entry still gets exactly one heading.
    const headline = firstNonEmpty([
      entry.qualification,
      entry.institution,
      entry.rangeText,
    ]);
    const schoolLine = [entry.institution === headline ? '' : entry.institution, entry.location]
      .filter((part) => part.length > 0)
      .join(', ');
    lines.push(
      ...entryHeadline(headline),
      ...(schoolLine.length > 0 ? paragraph(schoolLine) : []),
      ...paragraph(entry.rangeText),
    );
  }
  return lines;
}

function mediumSkills(dict: ResumeDict): string[] {
  const lines: string[] = [];
  for (const entry of dict.skills) {
    const named = entry.name.length > 0;
    const label = firstNonEmpty([entry.name, entry.keywords[0] ?? '', entry.level]);
    const valueParts: string[] = [];
    if (named && entry.level.length > 0) valueParts.push(entry.level);
    if (named && entry.keywords.length > 0) valueParts.push(entry.keywords.join(', '));
    if (!named && entry.keywords.length > 1) valueParts.push(entry.keywords.slice(1).join(', '));
    const value = valueParts.join(', ');
    if (label.length === 0 && value.length === 0) continue;
    lines.push(`\\clearanceproskill{${escapeLatex(label)}}{${escapeLatex(value)}}`);
  }
  return lines;
}

function renderSkills(dict: ResumeDict, spec: LatexVariantSpec): string[] {
  if (spec.layout === 'medium-professional') return mediumSkills(dict);
  const lines: string[] = [];
  for (const entry of dict.skills) {
    // ONE line per skill GROUP: `Name: item, item, item`. The previous renderer emitted
    // one bullet per keyword (and a `Level:` line), so a six-group CV became thirty
    // bullets. The canonical projector stores the keyword list in `level` for a skill
    // row, so that is the fallback when `keywords` is empty.
    const value = entry.keywords.length > 0
      ? entry.keywords.join(', ')
      : entry.level;
    const line = entry.name.length > 0 && value.length > 0
      ? `${entry.name}: ${value}`
      : firstNonEmpty([entry.name, value]);
    lines.push(...entryHeadline(line));
  }
  return lines;
}

function renderCertifications(dict: ResumeDict): string[] {
  const lines: string[] = [];
  for (const entry of dict.certifications) {
    lines.push(
      ...entryHeadline(entry.name, entry.issuer, entry.dateText, entry.url),
      ...labelledLine('Issuer', entry.issuer),
      ...labelledLine('Date', entry.dateText),
      ...urlLine(entry.url),
    );
  }
  return lines;
}

/**
 * One section -> its lines.
 *
 * The DISPATCH is the dictionary's fixed order: a section absent from `dict.sections` is
 * never reached, and a section present in it is rendered exactly once, in the position the
 * dictionary gave it.
 */
const SECTION_RENDERERS: Readonly<
  Record<ResumeDictSection, (dict: ResumeDict, spec: LatexVariantSpec) => readonly string[]>
> = Object.freeze({
  contact: renderContact,
  summary: (dict: ResumeDict): readonly string[] => paragraph(dict.summary),
  experience: renderExperience,
  projects: renderProjects,
  education: renderEducation,
  skills: renderSkills,
  certifications: renderCertifications,
});

/** The heading line for a section. The heading text is authored here, never derived. */
function sectionHeading(section: ResumeDictSection, spec: LatexVariantSpec): string {
  const heading =
    (spec.layout === 'medium-professional' ? MEDIUM_SECTION_HEADINGS[section] : undefined) ??
    SECTION_HEADINGS[section];
  // Unreachable for a dictionary from `projectResumeDict`: `sections` is filtered against
  // the closed vocabulary there, and the tables above are keyed by that same type. It is
  // still checked, because the alternative is an `undefined` reaching the bytes.
  if (heading === undefined) {
    throw new Error(`RENDER_EXPORT_SECTION_UNKNOWN: no export heading for section "${section}"`);
  }
  return heading;
}

/**
 * The `.tex` SOURCE for a dictionary, as a string.
 *
 * PURE, TOTAL, DETERMINISTIC. Every section in `dict.sections` is emitted in that order
 * with its heading and its entries. A section the dictionary does not list is not emitted at
 * all - the dictionary already dropped the empty ones (rule 4 of `dict.ts`'s header).
 *
 * Throws on two things only, both programming errors rather than user input: a non-dict
 * argument, and a section the closed tables do not know.
 */
export function renderLatexExport(dict: ResumeDict, opts: LatexExportOptions = {}): string {
  if (dict === null || typeof dict !== 'object') {
    throw new TypeError('renderLatexExport: a ResumeDict is required');
  }
  const spec = VARIANT_SPECS[resolveVariant(opts?.variant)];
  const body: string[] = [];
  for (const section of dict.sections) {
    const render = SECTION_RENDERERS[section];
    if (render === undefined) {
      throw new Error(`RENDER_EXPORT_SECTION_UNKNOWN: no export renderer for section "${section}"`);
    }
    // The contact block IS the header (name, headline, contact lines) for every variant;
    // it never gets a `Contact` section heading. `medium-professional` already worked this
    // way, and the default export printed a literal "Contact" heading above the name.
    if (section !== 'contact') {
      body.push(`\\clearancesection{${sectionHeading(section, spec)}}`);
    }
    body.push(...render(dict, spec));
  }
  return [...preambleFor(spec), ...body, ...POSTAMBLE].join('\n');
}

/**
 * The `.tex` BYTES for a dictionary, UTF-8 encoded.
 *
 * This is the artifact the route stores and the user downloads: a SOURCE file, never a PDF
 * (ADR-042 D1). UTF-8 rather than ASCII because the dictionary carries whatever Unicode the
 * resume held and the preamble declares an encoding package to typeset it; dropping the
 * non-ASCII would drop a person's name.
 */
export function renderLatexExportBytes(dict: ResumeDict, opts: LatexExportOptions = {}): Buffer {
  return Buffer.from(renderLatexExport(dict, opts), 'utf8');
}