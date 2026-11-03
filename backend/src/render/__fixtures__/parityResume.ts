// THE shared render-parity fixture - one document, three consumers.
//
// NORMATIVE DOC: .planning/tasks/T1041-docx-renderer.md (the fixture's owner)
//                 .planning/decisions/ADR-039-docx-renders-independently.md ("two renderers
//                   must be kept in content parity ... a Phase 4 acceptance test asserting
//                   text-level parity (section order, entry counts, bullet strings) across
//                   Typst, LaTeX and DOCX from ONE Resume JSON")
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 13 ruling 15
//                   ("the duplicated parity fixture becomes an explicit T1041 acceptance
//                   item - extract it to a shared fixture module when DOCX lands")
//                 .planning/decisions/ADR-044-...md D3 (one projection, three serialisers)
//
// WHY THIS FILE EXISTS. Three renderers have to agree about what a resume says. That claim
// is only checkable if they are handed the SAME document, so this module owns the one: Typst
// reads it through `projectResumeDict`, `.tex` reads it through `latexExport.ts`, and DOCX
// reads it through `docx.ts`. A parity test that builds its own private literal proves
// nothing, because two different documents can agree by accident.
//
// WHERE IT CAME FROM, so nobody mistakes it for a third copy. The literal below was ALREADY
// present, character for character, in `dict.test.ts` (T1040) and in `latexExport.test.ts`
// (T1044); the only difference between those two was a two-line explanatory comment. It is
// reproduced here verbatim - same entries, same order, same values - and `parity.test.ts`
// ASSERTS that equivalence against both files' sources rather than trusting this comment, so
// a future edit to either suite that silently forked the document fails a named test.
//
// WHAT THE DOCUMENT CARRIES, and why each member is here. It is a realistic canonical resume
// in the shape `resume/json/project.ts` writes, and it is dense on purpose: every section is
// populated, and each populated section exercises a code path the renderer owns rather than
// a field that happens to be there.
//
//   contact      all eight flattened fields, a SIX-member structured location (so the two
//                members a one-line address cannot carry are exercised), and THREE profiles -
//                including a network that is neither LinkedIn nor GitHub, with a handle.
//   summary       the free-text profile paragraph.
//   experience    THREE entries, so a renderer that silently drops the last one is caught.
//                One has no `endDate` (an open-ended current role), one has two highlights,
//                one has NONE, and each carries a different place.
//   projects      keywords AND highlights on the same entry, which is the only way a test can
//                tell two bullet lists apart.
//   education     a degree with both `studyType` and `area` (they join with ", "), and a
//                certificate-style entry with only `studyType`.
//   skills        one with a `level` and one with `keywords` but no level, so neither field
//                can be assumed present.
//   certifications a credential `url`, which is the member 1.0.0 of the dictionary dropped
//                and 1.1.0 restored (rule 5 of `dict.ts`'s header).
//
// DATES ARE UNFORMATTED HERE ON PURPOSE. Every date is the JSON Resume wire shape
// (`2022-03-01`, `2021`, `2019-01`) and never a formatted string, because the whole point of
// the fixture is that the FORMATTING happens once, in `dict.ts`. A fixture carrying
// `Mar 2020 - Present` would let a renderer that re-formats dates pass.

import { projectResumeDict, type ResumeDict } from '../dict.js';

/**
 * The canonical Resume JSON the three renderers are compared over.
 *
 * Exported as a plain object rather than frozen: `projectResumeDict` is total and reads
 * defensively, and several tests deliberately derive a variant from this literal (reversed
 * key order, a hostile string substituted in) which needs to copy it anyway.
 */
export const PARITY_RESUME_JSON = {
  basics: {
    name: 'Ada Lovelace',
    label: 'Staff Platform Engineer',
    email: 'ada@example.org',
    phone: '+44 20 7946 0018',
    url: 'https://example.org/ada',
    summary: 'Platform engineer. Eleven years of boring deploys.',
    // `address` and `postalCode` are the two members the one-line `location` cannot carry;
    // they must survive in `locationParts` and must NOT change the line.
    location: {
      address: '12 Pratt Street',
      postalCode: 'NW1 2QT',
      city: 'London',
      region: 'Greater London',
      countryCode: 'GB',
    },
    profiles: [
      { network: 'GitHub', url: 'https://github.com/adalovelace' },
      { network: 'LinkedIn', url: 'https://linkedin.com/in/adalovelace' },
      { network: 'Mastodon', username: '@ada@fosstodon.org', url: 'https://fosstodon.org/@ada' },
    ],
  },
  work: [
    {
      name: 'Meridian Data',
      position: 'Staff Platform Engineer',
      summary: 'London',
      startDate: '2022-03-01',
      highlights: ['First', 'Second'],
    },
    {
      name: 'Halcyon Payments',
      position: 'Senior Site Reliability Engineer',
      summary: 'Dublin',
      startDate: '2019-01-01',
      endDate: '2022-02-28',
      highlights: ['Third'],
    },
    {
      name: 'Northgate Software',
      position: 'Backend Engineer',
      summary: 'Manchester',
      startDate: '2015-06-01',
      endDate: '2019-01',
      highlights: [],
    },
  ],
  projects: [
    {
      name: 'hermetic-build',
      description: 'A build sandbox.',
      startDate: '2021',
      endDate: '2022',
      url: 'https://github.com/adalovelace/hermetic-build',
      keywords: ['Rust', 'OCI'],
      highlights: ['Faster.'],
    },
  ],
  education: [
    { institution: 'University of Bristol', studyType: 'MEng', area: 'Computer Science', endDate: '2015-06' },
    { institution: 'Open University', studyType: 'Postgraduate certificate', endDate: '2018' },
  ],
  skills: [
    { name: 'Rust', level: 'Advanced' },
    { name: 'PostgreSQL', keywords: ['logical replication'] },
  ],
  certificates: [
    { name: 'CKA', issuer: 'CNCF', date: '2021-04', url: 'https://training.linuxfoundation.org/certification/cka' },
  ],
};

/**
 * The dictionary the three renderers are compared over.
 *
 * Projected ONCE, from the literal above, so a parity assertion compares renderers against
 * each other rather than against three separately-derived projections of three separately
 * typed literals. Every renderer in this repository takes a `ResumeDict`, so this is the
 * single input shape every one of them is handed.
 */
export const PARITY_DICT: ResumeDict = projectResumeDict(PARITY_RESUME_JSON);

/**
 * The section HEADINGS each serialiser prints for a dictionary section.
 *
 * Shared because a heading is authored prose in every one of them, and a parity test that
 * compares the DOCX heading text against the `.tex` heading text needs one expected value,
 * not two. `latexExport.ts` and `docx.ts` each keep their OWN frozen table (a serialiser
 * owns the prose it prints), and this is the cross-check that they agree.
 *
 * The headings are plain ASCII with no markup, so they are emitted verbatim by all three.
 */
export const PARITY_SECTION_HEADINGS: Readonly<Record<string, string>> = Object.freeze({
  contact: 'Contact',
  summary: 'Profile',
  experience: 'Experience',
  projects: 'Projects',
  education: 'Education',
  skills: 'Skills',
  certifications: 'Certifications',
});