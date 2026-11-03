// The application workspace is a DOCUMENT-FIRST surface, not the old six-tab form.
//
// The harness is node-only (ADR-031 decision 3: no jsdom, no React Testing Library), so this
// test asserts the contract at the source level, the same way the Studio preview tests do:
// the tab map, the resume resolution import, the empty state and the rail are present, and
// the removed tabs are gone. It is deliberately structural, not a snapshot of markup.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'ApplicationWorkspace.tsx');

describe('the application workspace is document-first', () => {
  const source = readFileSync(PAGE, 'utf8');

  it('has exactly the five tabs the workspace promises, and no Overview or Documents tab', () => {
    for (const value of ['resume', 'posting', 'match', 'notes', 'timeline']) {
      assert.match(source, new RegExp(`<TabsTrigger value="${value}"`));
    }
    assert.equal(/<TabsTrigger value="overview"/.test(source), false);
    assert.equal(/<TabsTrigger value="documents"/.test(source), false);
    assert.equal(/<TabsTrigger value="cover/.test(source), false);
    assert.equal(/<TabsTrigger value="email"/.test(source), false);
  });

  it('renders the shared pdf.js artifact viewer and resolves the resume behind the application', () => {
    assert.match(source, /import \{ PdfPages \} from '@\/features\/studio\/PdfPages'/);
    assert.match(source, /useApplicationResumePreview\(resumeId, templateId\)/);
    assert.match(source, /tailoredResume\?\.sourceResumeId/);
    // The document is the Resume tab, not a separate tab of its own.
    assert.match(source, /<TabsContent value="resume">/);
  });

  it('states the honest empty state and its two text actions', () => {
    assert.match(source, /No resume attached to this application\./);
    assert.match(source, /Choose a resume/);
    assert.match(source, /Open Studio/);
    assert.match(source, /no endpoint for attaching a resume to an application/);
  });

  it('lays out the body as a document column plus the 320px rail', () => {
    assert.match(source, /lg:grid-cols-\[minmax\(0,1fr\)_320px\]/);
    assert.match(source, /<h2 className="section-title text-sm">Match<\/h2>/);
    assert.match(source, /<h2 className="section-title text-sm">Next actions<\/h2>/);
    for (const action of [
      'Attach a resume',
      'Tailor it',
      'Mark as sent',
      'Follow up in 5 days',
      'Log a reply',
      'Add interview date',
      'Record the offer',
    ]) {
      assert.ok(source.includes(action), `${action} is missing from the rail`);
    }
  });

  it('does not show a percentage or fake an AI surface it cannot back', () => {
    assert.equal(source.includes('%'), false, 'no percentage may appear in this workspace');
    assert.match(source, /AI refinement is not wired here yet\./);
  });
});
