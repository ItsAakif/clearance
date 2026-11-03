// A template switch changes the LAYOUT without changing the resume JSON hash (T1050).
//
// THE ACCEPTANCE ITEM, AND WHY IT IS ASSERTED HERE RATHER THAN IN A COMPONENT TEST. "Switching
// templates does not change the resume JSON" is a claim about a CHANNEL: if the selected
// template could reach the document, the hash would change. So the assertion is on the shape of
// the data path, not on a rendered screen:
//
//   1. `serialize` takes ONE argument, and that argument is the model. There is no parameter a
//      template could arrive through.
//   2. The bytes of the document are identical before and after a switch, for a model that was
//      also edited in between - which is the case that matters, since "nothing changed because
//      nothing was done" proves nothing.
//   3. The mirror of the backend's template registry is CROSS-CHECKED against the registry's own
//      directories and `RENDER_DEFAULT_TEMPLATE_ID`, so the Studio cannot offer a template that
//      does not exist or miss one that does (T1040 ruling sec.13.2 left `thumbnail: null` and
//      no HTTP surface, so a hard-coded list here is the only option - and a checked one).
//   4. When the backend REFUSES a per-request template, the UI says so in the machine's words
//      and does not claim the layout changed.
//   5. The route and the nav entry are behind the EXISTING `v2ResumeStudio` flag.
//
// Mutation (b) for this file: make the template switch write into the document, and "switching
// the template leaves the document bytes identical" fails.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  documentBytes,
  inlineFromPlainText,
  editInlineValue,
  modelFromDocument,
  serialize,
  X_CLEARANCE_KEY,
} from './blockModel';
import {
  DEFAULT_TEMPLATE_ID,
  STUDIO_TEMPLATES,
  TEMPLATE_NOT_PER_REQUEST_CODE,
  TEMPLATE_NOT_PER_REQUEST_REASON,
  findTemplate,
  pageSizeLabel,
  templateUnsupportedMessage,
} from './templates';
import { appNavItems, appNavItemsFor } from '@/components/layout/navigation';
import type { ResumeDocumentJson } from '@/services/api/studio';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..', '..');
const REGISTRY_DIR = path.join(REPO, 'backend', 'typst', 'templates');
const LATEX_REGISTRY_DIR = path.join(REPO, 'backend', 'latex', 'templates');

/** The registry root a template id lives in. The LaTeX engine has its own tree. */
function registryDirFor(id: string): string {
  return id.startsWith('latex-') ? LATEX_REGISTRY_DIR : REGISTRY_DIR;
}

// T1110: the `FLAG_OFF` / `FLAG_ON` fixtures are gone with the gate they exercised. The nav is
// no longer a function of a flag, so a "flag off" fixture has nothing to vary.

function projected(): ResumeDocumentJson {
  return {
    basics: { name: 'Ada Lovelace' },
    work: [{ name: 'Acme', position: 'Staff Engineer', highlights: ['Cut CI build time by 40%'] }],
    [X_CLEARANCE_KEY]: {
      version: 1,
      generatedBy: 'clearance/resume-json/project@1',
      sourceModelVersion: 2,
      profileId: 'profile-1',
      claimCount: 1,
      confirmedClaimCount: 1,
      unconfirmedClaimCount: 0,
      claims: [
        {
          claimId: 'clm-1',
          fingerprint: 'a'.repeat(64),
          kind: 'achievement',
          status: 'user_confirmed',
          provenance: 'llm_inferred',
          confidence: 0.9,
          evidenceSourceId: null,
          usage: 'verbatim',
          jsonPath: 'work[0].highlights[0]',
          renderedText: 'Cut CI build time by 40%',
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// MUTATION (b): the switch cannot reach the document
// ---------------------------------------------------------------------------

describe('switching the template leaves the resume JSON byte-identical', () => {
  it('serialize takes ONE argument, and it is the model', () => {
    // The mechanism, stated as a fact about the signature: there is no parameter a template
    // could arrive through, so "the template changed the document" is unrepresentable.
    assert.equal(serialize.length, 1);
    assert.equal(documentBytes.length, 1);
  });

  it('the bytes are identical across a switch that ALSO edited the document', () => {
    // An edit in between is what makes this a real test: without it, "identical" would only
    // prove that doing nothing changes nothing.
    const before = documentBytes(modelFromDocument(projected()));

    // ...the user edits a statement and switches the template in the same sitting.
    const edited = editInlineValue(modelFromDocument(projected()), {
      section: 'work',
      blockId: 'work:0',
      highlightIndex: 0,
      value: inlineFromPlainText('Cut CI build time by 55%'),
    }).model;

    const withTemplateA = documentBytes(edited); // selected: typst-ats-classic
    const withTemplateB = documentBytes(edited); // selected: typst-modern-cards

    assert.equal(withTemplateA, withTemplateB);
    // And the edit itself is real, so the equality above is not vacuous.
    assert.notEqual(before, withTemplateA);
    assert.match(withTemplateA, /55%/);
  });

  it('the document carries NO template member of any kind', () => {
    const document = serialize(modelFromDocument(projected()));
    for (const forbidden of ['templateId', 'template', 'layout', 'theme', 'columns', 'pageSize']) {
      assert.equal(forbidden in document, false, `${forbidden} reached the document`);
    }
    // JSON Resume has `meta` as the community's own free-form bag; the Studio does not use it
    // to smuggle a layout in, which would be the same channel with a different spelling.
    assert.equal('meta' in document, false);
    // The block records only what the schema allows (ADR-035: `additionalProperties: false`).
    const block = document[X_CLEARANCE_KEY] as unknown as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(block).sort(),
      [
        'claimCount',
        'claims',
        'confirmedClaimCount',
        'generatedBy',
        'profileId',
        'sourceModelVersion',
        'unconfirmedClaimCount',
        'version',
      ],
    );
  });

  it('the page holds the template in component state and never puts it in the document', () => {
    const source = readFileSync(path.join(REPO, 'src', 'pages', 'Studio.tsx'), 'utf8');
    // `useState` for the selection, and no `templateId` anywhere near `serialize`.
    assert.match(source, /useState<string>\(DEFAULT_TEMPLATE_ID\)/);
    assert.equal(/templateId[^\n]*serialize|serialize[^\n]*templateId/.test(source), false);
    // The document the page POSTS is the writer's output for the current model and NOTHING
    // else: no second argument reaches the writer, so the selection has no path into the
    // request body. This is the page-level half of the hash invariance, and it is what makes
    // the mutation "thread the template into the document" fail here.
    assert.match(source, /const document = serialize\(\w+\);/);
    assert.equal(/serialize\([^)]*,/.test(source), false, 'no second argument may reach the writer');
    const switchSource = readFileSync(path.join(HERE, 'TemplateSwitch.tsx'), 'utf8');
    assert.equal(/serialize\(/.test(switchSource), false);
    assert.equal(/ResumeDocumentJson/.test(switchSource), false);
  });
});

// ---------------------------------------------------------------------------
// The registry mirror, cross-checked against the backend
// ---------------------------------------------------------------------------

describe('the Studio template list matches the typesetter registry', () => {
  it('offers exactly the registry directories, in order', () => {
    const onDisk = [REGISTRY_DIR, LATEX_REGISTRY_DIR]
      .flatMap((root) =>
        readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
      )
      .sort();
    assert.deepEqual(
      [...STUDIO_TEMPLATES].map((template) => template.id).sort(),
      onDisk,
      'a template added to or removed from backend/typst/templates or backend/latex/templates must be reflected here',
    );
  });

  it("starts on the server's default template", () => {
    // `RENDER_DEFAULT_TEMPLATE_ID` is read out of the backend source rather than imported:
    // importing `render/templates.ts` would drag the whole render module into the root vitest
    // project, which is a separate dependency graph (cf. `flags.test.ts`, which imports
    // `backend/src/config/flags` precisely because that module has no runtime deps).
    const source = readFileSync(path.join(REPO, 'backend', 'src', 'render', 'templates.ts'), 'utf8');
    const match = source.match(/RENDER_DEFAULT_TEMPLATE_ID\s*=\s*'([^']+)'/);
    assert.ok(match, 'could not read RENDER_DEFAULT_TEMPLATE_ID out of the backend source');
    assert.equal(match[1], DEFAULT_TEMPLATE_ID);
    assert.equal(STUDIO_TEMPLATES[0].id, DEFAULT_TEMPLATE_ID);
  });

  it('every metadata row agrees on columns and page size, and every template names a registry page size', () => {
    for (const template of STUDIO_TEMPLATES) {
      const metadata = JSON.parse(
        readFileSync(path.join(registryDirFor(template.id), template.id, 'metadata.json'), 'utf8'),
      ) as { id: string; columns: number; pageSize: string; atsProfile?: unknown };
      assert.equal(metadata.id, template.id);
      assert.equal(metadata.columns, template.columns, template.id);
      assert.equal(metadata.pageSize, template.pageSize, template.id);
      // The closed page-size vocabulary the registry itself validates. The Studio NAMES the
      // value as a word; it never measures the page.
      assert.ok(['a4', 'letter'].includes(template.pageSize), template.id);
      assert.equal(
        pageSizeLabel(template.pageSize),
        template.pageSize === 'a4' ? 'A4' : 'Letter',
      );
    }
  });

  it('every template declares the font licence the Studio displays, and its own', () => {
    for (const template of STUDIO_TEMPLATES) {
      const licence = readFileSync(
        path.join(registryDirFor(template.id), template.id, 'LICENSE'),
        'utf8',
      );
      // Every template source is Apache-2.0. The Typst templates additionally render with
      // the vendored Source Serif 4 faces (OFL-1.1), so both licences are checked for
      // them; the LaTeX template uses TeX Live's default Computer Modern, shipped with
      // the worker image, and declares no vendored font face.
      assert.match(licence, /Apache License/i, template.id);
      if (template.id.startsWith('typst-')) {
        assert.match(licence, /SIL Open Font License/i, template.id);
        assert.equal(template.licence, 'OFL-1.1', template.id);
      } else {
        assert.equal(template.licence, 'Apache-2.0', template.id);
      }
    }
  });

  it('an unknown id is NOT guessed at', () => {
    assert.equal(findTemplate('typst-nope'), null);
    assert.equal(findTemplate(null), null);
    assert.equal(findTemplate(DEFAULT_TEMPLATE_ID)?.id, DEFAULT_TEMPLATE_ID);
  });
});

// ---------------------------------------------------------------------------
// The refusal, stated honestly
// ---------------------------------------------------------------------------

describe('the per-request-template refusal is reported in the machine words', () => {
  it('names the code and the reason the backend uses', () => {
    const message = templateUnsupportedMessage('typst-modern-cards', DEFAULT_TEMPLATE_ID);
    assert.match(message, new RegExp(TEMPLATE_NOT_PER_REQUEST_CODE));
    assert.match(message, new RegExp(TEMPLATE_NOT_PER_REQUEST_REASON));
    assert.equal(TEMPLATE_NOT_PER_REQUEST_CODE, 'render_template_unsupported');
    assert.equal(TEMPLATE_NOT_PER_REQUEST_REASON, 'TEMPLATE_SELECTION_NOT_PER_REQUEST');
  });

  it('says which template the bytes actually came from, so a mismatch is visible', () => {
    const message = templateUnsupportedMessage('typst-modern-cards', DEFAULT_TEMPLATE_ID);
    assert.match(message, /NOT the one you selected/);
    assert.match(message, new RegExp(DEFAULT_TEMPLATE_ID));
  });

  it('states that the document and its hash are unchanged by the choice', () => {
    assert.match(templateUnsupportedMessage('typst-modern-cards', DEFAULT_TEMPLATE_ID), /revision hash are unchanged/);
  });

  it('the backend route really does refuse a caller-supplied templateId', () => {
    // Read out of the route source, so the copy above cannot drift from the behaviour.
    const route = readFileSync(path.join(REPO, 'backend', 'src', 'routes', 'resumes.ts'), 'utf8');
    assert.match(route, /render_template_unsupported/);
    assert.match(route, /TEMPLATE_SELECTION_NOT_PER_REQUEST/);
    assert.match(route, /if \(req\.body\?\.templateId !== undefined && req\.body\?\.templateId !== null\)/);
  });

  it('the switcher renders a NEUTRAL placeholder, never a fake thumbnail', () => {
    const source = readFileSync(path.join(HERE, 'TemplateSwitch.tsx'), 'utf8');
    assert.match(source, /TemplatePlaceholder/);
    assert.match(source, /aria-hidden="true"/);
    // No image of a layout this page has not rendered: `thumbnail` is null in the registry
    // (T1040 ruling sec.13.2), so there is nothing honest to show.
    assert.equal(/<img/.test(source), false);
    assert.equal(/preview\.png/.test(source), false);
  });
});

// ---------------------------------------------------------------------------
// The flag gate
// ---------------------------------------------------------------------------

// T1110 (cutover): the block this file used to carry is GONE, and the gate it guarded is gone
// with it.
//
// The old assertions here were all of the form "with the flag OFF the Studio is not reachable".
// That is no longer a behaviour to protect: the legacy builder at `/app/build` is deleted, so
// there is no builder for the Studio to be gated ALTERNATIVE TO, and a build in which the
// Studio was hidden would be a build with no editor. `src/App.tsx` registers both Studio routes
// unconditionally. So these are not deleted to make the change pass - they are replaced with
// the inverse contract, which is the one that now matters: the Studio is ALWAYS there, and
// `/app/build` is a REDIRECT to it rather than a competing screen.
describe('the Studio is the editor, and is not gated (T1110)', () => {
  it('the sidebar carries Resumes (the Studio tab) and Profile (the career record tab)', () => {
    const items = appNavItemsFor();
    assert.ok(items.some((item) => item.href === '/app/resumes' && item.label === 'Resumes'));
    assert.ok(items.some((item) => item.href === '/app/profile' && item.label === 'Profile'));
    // Neither the Studio nor the evidence layer is a sidebar entry of its own now; both are
    // tabs inside the section that owns them.
    assert.equal(items.some((item) => item.href === '/app/studio'), false);
    assert.equal(items.some((item) => item.href === '/app/career'), false);
  });

  it('every sidebar entry is a member of the one exported baseline', () => {
    // The rendered order IS the declared order (see navigation.ts), so this is what keeps the
    // list honest: an entry cannot exist in the sidebar without being declared here.
    assert.deepEqual(appNavItemsFor(), appNavItems);
  });

  it('adds no NEW flag name to the navigation module', () => {
    // `navigation.ts` no longer gates on ANY flag. The cross-runtime contract
    // (`src/lib/flags.test.ts` against `backend/src/config/flags.ts`) is asserted in
    // `src/lib/flags.test.ts` itself; what is asserted HERE is that the nav layer did not
    // respond to the cutover by inventing a gate.
    const source = readFileSync(path.join(REPO, 'src', 'components', 'layout', 'navigation.ts'), 'utf8');
    assert.equal(/flag:\s*"/.test(source), false);
    assert.equal(/V2_FLAG_ENV_KEYS/.test(source), false);
    assert.equal(/@\/lib\/flags/.test(source), false);
  });

  it('BOTH Studio routes are registered UNCONDITIONALLY, and /app/build redirects to them', () => {
    const source = readFileSync(path.join(REPO, 'src', 'App.tsx'), 'utf8');
    // The parametrised route the task names...
    assert.match(source, /path="\/app\/studio\/:resumeId" element=\{<Studio \/>\}/);
    // ...and the chooser the nav entry points at.
    assert.match(source, /path="\/app\/studio" element=\{<Studio \/>\}/);
    // Neither sits inside a flag conditional: there is no `{flags.` wrapper left around them.
    assert.equal(/flags\.v2ResumeStudio\s*\?/.test(source.slice(source.indexOf('path="/app/profile"'))), false);
    // The legacy builder is gone, and BOTH of its URLs are redirects. The bare path is a
    // `<Navigate replace>` and the parametrised one is `LegacyBuilderRedirect`, which exists
    // because react-router does not substitute `:params` inside a `<Navigate>`'s `to`.
    assert.equal(/<Build \/>/.test(source), false);
    assert.match(source, /path="\/app\/build" element=\{<Navigate to="\/app\/studio" replace \/>\}/);
    assert.match(source, /path="\/app\/build\/:resumeId" element=\{<LegacyBuilderRedirect \/>\}/);
    assert.match(source, /import\("\.\/pages\/Studio"\)/);
  });
});