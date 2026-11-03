// StructureEditor.test.ts - the selected section is the ONLY section rendered.
//
// The rail is the fix for the one-long-form Studio, so the contract this file pins is narrow and
// deliberate: given a model with content in every section, rendering the editor with one
// `section` value may contain that section's controls and may not contain another section's.
//
// This repo's Vitest environment is node-only (ADR-031 decision 3: no jsdom, no React Testing
// Library), so the component is rendered to static markup with `react-dom/server` and the
// assertion is made over the REAL render output, not over the source. No DOM events are needed:
// the test is about which controls exist, not about clicking them.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StructureEditor, type StudioSection } from './StructureEditor';
import { modelFromDocument } from './blockModel';
import type { ResumeDocumentJson } from '@/services/api/studio';

const document: ResumeDocumentJson = {
  basics: {
    name: 'Ada Lovelace',
    label: 'Analyst',
    email: 'ada@example.com',
    phone: '+44 20 0000 0000',
    url: 'https://example.com',
    summary: 'A summary in her own words.',
    location: { city: 'London' },
  },
  work: [{ name: 'Analytical Engines', position: 'Mathematician', highlights: ['Wrote a note'] }],
  education: [{ institution: 'Home tutoring', area: 'Mathematics', studyType: 'Self-taught' }],
  projects: [{ name: 'Notes', description: 'A project', keywords: ['maths'] }],
  skills: [{ name: 'Mathematics', keywords: ['analysis'] }],
  certificates: [{ name: 'Fellowship', issuer: 'Royal Society' }],
  'x-clearance': {
    version: 1,
    generatedBy: 'test',
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
        provenance: 'user_entered',
        confidence: null,
        evidenceSourceId: null,
        usage: 'verbatim',
        jsonPath: 'work[0].highlights[0]',
        renderedText: 'Wrote a note',
      },
    ],
  },
};

const model = modelFromDocument(document);

function render(section: StudioSection): string {
  return renderToStaticMarkup(
    createElement(StructureEditor, { model, section, onChange: () => undefined }),
  );
}

describe('StructureEditor renders only the selected section', () => {
  it('contact renders the contact fields and not the summary or a list section', () => {
    const html = render('contact');
    assert.match(html, /id="basics-name"/);
    assert.match(html, /id="basics-email"/);
    assert.match(html, /id="basics-location"/);
    assert.equal(html.includes('id="basics-summary"'), false, 'summary must not render with contact');
    assert.equal(html.includes('work:0-name'), false, 'experience must not render with contact');
    assert.equal(html.includes('Add experience'), false);
  });

  it('summary renders the summary textarea and its formatting controls, and no contact field', () => {
    const html = render('summary');
    assert.match(html, /id="basics-summary"/);
    assert.match(html, /Formatting for Summary/);
    assert.equal(html.includes('id="basics-name"'), false, 'contact must not render with summary');
  });

  it('experience renders its entries and Add action, and no basics field', () => {
    const html = render('work');
    assert.match(html, /id="work:0-name"/);
    assert.match(html, /Add experience/);
    assert.equal(html.includes('id="basics-name"'), false);
    assert.equal(html.includes('id="basics-summary"'), false);
  });

  it('education, projects, skills and certificates each render their own section only', () => {
    const cases: Array<[StudioSection, string, string]> = [
      ['education', 'education:0-institution', 'Add education'],
      ['projects', 'projects:0-name', 'Add project'],
      ['skills', 'skills:0-name', 'Add skill'],
      ['certificates', 'certificates:0-name', 'Add certificate'],
    ];
    for (const [section, field, add] of cases) {
      const html = render(section);
      assert.match(html, new RegExp(field), section);
      assert.match(html, new RegExp(add), section);
      assert.equal(html.includes('id="basics-name"'), false, section);
      // Exactly one section heading in the pane, whatever the rail selected.
      assert.equal((html.match(/id="studio-section-heading"/g) ?? []).length, 1, section);
    }
  });
});
