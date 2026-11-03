// The template registry, mirrored (T1050; 04 D.4; T1040 sec.6, ruling sec.13.2).
//
// WHY THIS LIST EXISTS HERE AT ALL. The typesetter's registry (`backend/src/render/templates.ts`
// over `backend/typst/templates/<id>/`) has NO HTTP surface - the spec puts "list templates"
// on `GET /templates`, and this build's `/templates` route is still the legacy DOCX registry,
// which this task must not touch. So the Studio cannot ask the server what templates exist.
//
// The alternative was a hard-coded list in a component, and that is exactly the kind of second
// source of truth this program has been deleting all along. So the list is a MODULE-level
// export in the frontend, and `templateSwitch.test.ts` CROSS-CHECKS it against the registry's
// own directories and against `RENDER_DEFAULT_TEMPLATE_ID` in the backend source - the same
// technique `features/career/claimPresentation.test.ts` uses to keep a mirror honest. A
// template added to, or removed from, `backend/typst/templates/` FAILS that test rather than
// silently never appearing in the Studio.
//
// NO THUMBNAILS, DELIBERATELY. `thumbnail: null` is what T1040 ships (ruling sec.13.2: a PNG
// render of a multi-page resume is a second artifact, which the sandbox policy refuses), and
// the rasteriser decision is a named open item T1050 owns. `TemplateSwitch.tsx` renders a
// neutral placeholder with the template's real metadata (columns, page size, ATS profile,
// licence) rather than a fake image of a layout it has not rendered.
//
// NO PAGE GEOMETRY HERE. `pageSize` is reported because the registry declares it, and the two
// values a shipped template may declare are named as WORDS ("A4", "Letter"); `TemplateSwitch`
// renders the page size as a WORD. No width, height, `in`, `pt` or page dimension appears
// anywhere in this tree - the typesetter owns layout, and a number in the UI would be a second
// authority pretending to be one. `noLetterGeometry.test.ts` is the grep that keeps it that
// way, and it scans this file too.

export interface StudioTemplate {
  id: string;
  /** Human label. The registry id is machine vocabulary; this is what the user reads. */
  label: string;
  /** One line about the layout, from the registry's own `description`. */
  description: string;
  columns: 1 | 2;
  pageSize: 'a4' | 'letter';
  /** Whether the registry declares the ATS profile. Displayed, never enforced client-side. */
  atsFriendly: boolean;
  /** The vendored font set's licence, as every template declares it. */
  licence: string;
}

/**
 * The registry ids, in the order the Studio offers them. The FIRST entry is the server's
 * default (`RENDER_DEFAULT_TEMPLATE_ID`), so a build that renders without a template choice
 * previews the same layout the switcher starts on.
 */
export const STUDIO_TEMPLATES: readonly StudioTemplate[] = [
  {
    id: 'typst-ats-classic',
    label: 'ATS classic',
    description: 'One column, serif, no rules or tables. Headings by weight and size.',
    columns: 1,
    pageSize: 'a4',
    atsFriendly: true,
    licence: 'OFL-1.1',
  },
  {
    id: 'typst-compact-two-col',
    label: 'Compact two column',
    description: 'Two columns, serif, tighter leading.',
    columns: 2,
    pageSize: 'a4',
    atsFriendly: false,
    licence: 'OFL-1.1',
  },
  {
    id: 'typst-modern-cards',
    label: 'Modern cards',
    description: 'One column, each entry in a card with a stroke and an inset.',
    columns: 1,
    pageSize: 'a4',
    atsFriendly: false,
    licence: 'OFL-1.1',
  },
  {
    id: 'latex-ats-classic',
    label: 'LaTeX ATS classic',
    description: 'One column, serif, no rules or tables. Compiled server-side by pdfLaTeX.',
    columns: 1,
    pageSize: 'a4',
    atsFriendly: true,
    // The LaTeX template renders with TeX Live's default Computer Modern; the
    // registry records the template itself as Apache-2.0 and no vendored font face.
    licence: 'Apache-2.0',
  },
  {
    id: 'latex-jakes-compact',
    label: "LaTeX Jake's compact",
    description: 'Single column, small caps headings - ATS-safe',
    columns: 1,
    pageSize: 'a4',
    atsFriendly: true,
    licence: 'Apache-2.0',
  },
  {
    id: 'latex-awesome-sans',
    label: 'LaTeX Awesome sans',
    description: 'Single column, sans-serif with tracked-out headings',
    columns: 1,
    pageSize: 'a4',
    atsFriendly: true,
    licence: 'Apache-2.0',
  },
  {
    id: 'latex-moderncv-classic',
    label: 'LaTeX ModernCV classic',
    description: 'Single column, large name, thin rules under headings',
    columns: 1,
    pageSize: 'a4',
    atsFriendly: true,
    licence: 'Apache-2.0',
  },
  {
    id: 'latex-medium-professional',
    label: 'Medium Length Professional',
    description: 'The classic Hunner CV: uppercase headings, rules, tight bullets',
    columns: 1,
    pageSize: 'letter',
    atsFriendly: true,
    licence: 'Apache-2.0',
  },
];

/** The template the server renders with when a request names none. */
export const DEFAULT_TEMPLATE_ID = STUDIO_TEMPLATES[0].id;

/** A template by id, or `null`. An id this build does not know is never guessed at. */
export function findTemplate(id: string | null | undefined): StudioTemplate | null {
  if (typeof id !== 'string') return null;
  return STUDIO_TEMPLATES.find((template) => template.id === id) ?? null;
}

/**
 * Legacy layout names written by the V1 builder, mapped onto a REVIEWED render template.
 *
 * The two are different namespaces: `classic` (and the rest of the old DOCX list) is not a
 * registry id, so sending it to `POST /resumes/:id/render` is a 422 and the preview fell
 * back to the default without saying so. The keys are lower-case because the legacy rows
 * are mixed-case (`Classic`, `Minimal_Blue`); lookup normalises. A registry id is never a
 * key here, so an existing template cannot be shadowed.
 */
export const LEGACY_TEMPLATE_ID_MAP: Readonly<Record<string, string>> = {
  'professional-standard': DEFAULT_TEMPLATE_ID,
  classic: DEFAULT_TEMPLATE_ID,
  standard: DEFAULT_TEMPLATE_ID,
  bullets: DEFAULT_TEMPLATE_ID,
  descriptive: DEFAULT_TEMPLATE_ID,
  accountant: DEFAULT_TEMPLATE_ID,
  'ats-minimilistic': DEFAULT_TEMPLATE_ID,
  minimalist_1: DEFAULT_TEMPLATE_ID,
  minimalist_2column: DEFAULT_TEMPLATE_ID,
  'minimal-green': DEFAULT_TEMPLATE_ID,
  minimal_blue: DEFAULT_TEMPLATE_ID,
  graphic: DEFAULT_TEMPLATE_ID,
  graphic2: DEFAULT_TEMPLATE_ID,
  graphic3: DEFAULT_TEMPLATE_ID,
  desinger: DEFAULT_TEMPLATE_ID,
  marketting: DEFAULT_TEMPLATE_ID,
  marketting2: DEFAULT_TEMPLATE_ID,
  minimalist_2: DEFAULT_TEMPLATE_ID,
  minimalist_3: DEFAULT_TEMPLATE_ID,
  minimal_color: DEFAULT_TEMPLATE_ID,
  'ux-designer': DEFAULT_TEMPLATE_ID,
  'with-image': DEFAULT_TEMPLATE_ID,
  minimal: DEFAULT_TEMPLATE_ID,
  modern: DEFAULT_TEMPLATE_ID,
};

export interface ResolvedStudioTemplate {
  /** The id the Studio renders with: always a registry id. */
  id: string;
  /** The id the resume row stored, when there was one. */
  storedId: string | null;
  /** `storedId` was a legacy layout name and has been mapped. */
  mapped: boolean;
  /** `storedId` was not a registry id and is not a known legacy id: the default is used. */
  fellBack: boolean;
}

/**
 * Resolve a stored `Resume.templateId` to the id the Studio should render with.
 *
 * Order matters: a REGISTRY id wins untouched; a known legacy id maps; anything else falls
 * back to the default and says so (`fellBack`), because the alternative is sending an id
 * the server refuses and showing an error where a preview should be. The fallback is
 * reported to the page so it is VISIBLE, not silent.
 */
export function resolveStudioTemplateId(
  storedId: string | null | undefined,
): ResolvedStudioTemplate {
  if (typeof storedId !== 'string' || storedId.trim().length === 0) {
    return { id: DEFAULT_TEMPLATE_ID, storedId: null, mapped: false, fellBack: false };
  }
  const trimmed = storedId.trim();
  if (findTemplate(trimmed)) {
    return { id: trimmed, storedId: trimmed, mapped: false, fellBack: false };
  }
  const mappedId = LEGACY_TEMPLATE_ID_MAP[trimmed.toLowerCase()];
  if (mappedId !== undefined) {
    return { id: mappedId, storedId: trimmed, mapped: true, fellBack: false };
  }
  return { id: DEFAULT_TEMPLATE_ID, storedId: trimmed, mapped: false, fellBack: true };
}

/** The wording for a page size. A WORD, never a dimension. */
export function pageSizeLabel(pageSize: string): string {
  return pageSize === 'a4' ? 'A4' : pageSize === 'letter' ? 'Letter' : pageSize;
}

/**
 * What the switcher says about a template whose layout the current backend build cannot
 * render on request.
 *
 * The render port takes its template as a CONSTRUCTION-time dependency
 * (`RenderPortDeps.templateId`), so `POST /resumes/:id/render` REFUSES a caller-supplied
 * `templateId` with 422 `render_template_unsupported` / `TEMPLATE_SELECTION_NOT_PER_REQUEST`
 * rather than silently substituting the default (see `routes/resumes.ts`). The Studio
 * therefore states the limitation in the machine's own words instead of implying the switch
 * changed a layout it did not. `code` is asserted by `templateSwitch.test.ts`.
 */
export const TEMPLATE_NOT_PER_REQUEST_CODE = 'render_template_unsupported';
export const TEMPLATE_NOT_PER_REQUEST_REASON = 'TEMPLATE_SELECTION_NOT_PER_REQUEST';

/**
 * The honest line under the switcher when the render refused the choice.
 *
 * NOT a promise and not an apology: it names the code, says what the server rendered
 * instead, and keeps the claim that matters - the choice is a RENDER-TIME decision, so it
 * cannot have altered the document.
 */
export function templateUnsupportedMessage(templateId: string, defaultTemplateId: string): string {
  const lines = [
    `This build cannot render a template per request. The server refused ${templateId} with ${TEMPLATE_NOT_PER_REQUEST_CODE} / ${TEMPLATE_NOT_PER_REQUEST_REASON}.`,
    defaultTemplateId === templateId
      ? 'You are already on the default template, so the preview below is the one you asked for.'
      : `The preview below is rendered with ${defaultTemplateId}, the build's default template, which is NOT the one you selected.`,
    'The template is a render-time choice: your resume document and its revision hash are unchanged by selecting one.',
  ];
  return lines.join(' ');
}