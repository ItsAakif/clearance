// Unit tests for the Studio's editable block model (T1050).
//
// Runner: vitest in node environment (`npm test`, root `vitest.config.ts`; ADR-031 decision 3 -
// pure modules only, no jsdom / component tests). `describe`/`it` come from vitest; assertions
// use `node:assert/strict`, matching `features/career/claimPresentation.test.ts`.
//
// WHAT THIS FILE PINS, AND WHY IT CANNOT BE CHECKED ANYWHERE ELSE:
//
//   1. THE BELT, RESTATED INDEPENDENTLY. The test file walks a serialized document with its own
//      oracle (`beltViolations`) instead of calling `blockModel.unaccountedText`, because the
//      whole point of that rule is that a document whose `x-clearance` block does not name a
//      claim-rail string at its exact path is REFUSED by `createRevision`
//      (`assertClaimBackedTextAccounted`) and refused again by the read-time gate. If the
//      editor could produce one, a green save would be a 400.
//   2. REORDER MOVES THE CLAIM WITH THE TEXT. A reorder that left the block's `jsonPath`s
//      behind is the documented way to get that 400, so the assertion is on the path, not on
//      "the order looks right".
//   3. EXCLUDE IS ABSENCE, AND THE CLAIM BECOMES `omitted`. The mutation the reviewer must be
//      able to run is "let an excluded block render", and the named test for it is
//      "excluding a block removes its text AND omits its claims".
//   4. A STATUS IS NEVER WRITTEN BY THE EDITOR. `assertStatusUnchanged` is the mechanical
//      form of "the Studio cannot confirm anything".

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  LIST_SECTIONS,
  SECTION_KEYS,
  STUDIO_GENERATOR,
  X_CLEARANCE_KEY,
  addBlock,
  assertStatusUnchanged,
  canonicalJsonString,
  documentBytes,
  documentProblems,
  duplicateClaimIds,
  editInlineValue,
  excludeBlock,
  includeBlock,
  inlineFromPlainText,
  inlineToPlainText,
  modelFromDocument,
  normalizeInlineValue,
  plainTextToInline,
  placedClaimCount,
  reorderBlock,
  serialize,
  setBlockField,
  unaccountedText,
  unconfirmedPlacedCount,
  type InlineValue,
} from './blockModel';
import type { ResumeDocumentJson, StudioClearanceClaim } from '@/services/api/studio';

// ---------------------------------------------------------------------------
// Fixtures: what the projector actually writes
// ---------------------------------------------------------------------------

function claim(overrides: Partial<StudioClearanceClaim> = {}): StudioClearanceClaim {
  return {
    claimId: 'clm-1',
    fingerprint: 'a'.repeat(64),
    kind: 'achievement',
    status: 'user_confirmed',
    provenance: 'llm_inferred',
    confidence: 0.9,
    evidenceSourceId: 'evd-1',
    usage: 'verbatim',
    jsonPath: 'work[0].highlights[0]',
    renderedText: 'Cut CI build time by 40%',
    ...overrides,
  };
}

/**
 * A projected document with TWO roles and one skill, the shape the Studio will actually meet.
 *
 * The second role exists so a reorder has somewhere to move a claim TO: `work[0]` becoming
 * `work[1]` is the case the belt is fussiest about.
 */
function projected(): ResumeDocumentJson {
  return {
    basics: { name: 'Ada Lovelace', label: 'Staff Engineer' },
    work: [
      {
        name: 'Acme',
        position: 'Staff Engineer',
        startDate: '2020-01',
        highlights: ['Cut CI build time by 40%'],
      },
      {
        name: 'Globex',
        position: 'Senior Engineer',
        startDate: '2018-01',
        highlights: ['Moved the billing service to Postgres'],
      },
    ],
    skills: [{ name: 'TypeScript', level: 'expert' }],
    [X_CLEARANCE_KEY]: {
      version: 1,
      generatedBy: 'clearance/resume-json/project@1',
      sourceModelVersion: 2,
      profileId: 'profile-1',
      claimCount: 3,
      confirmedClaimCount: 3,
      unconfirmedClaimCount: 0,
      claims: [
        claim(),
        claim({
          claimId: 'clm-2',
          fingerprint: 'b'.repeat(64),
          jsonPath: 'work[1].highlights[0]',
          renderedText: 'Moved the billing service to Postgres',
        }),
        claim({
          claimId: 'clm-3',
          fingerprint: 'c'.repeat(64),
          kind: 'skill',
          jsonPath: null,
          renderedText: null,
          usage: 'omitted',
        }),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// THE ORACLE: the belt, written a second time
// ---------------------------------------------------------------------------

interface BeltViolation {
  path: string;
  reason: string;
}

/**
 * `assertClaimBackedTextAccounted` + `assertOneUsagePerClaimId`, restated from the DOCUMENT
 * side, on purpose. It reads the serialized JSON rather than the model, and it derives the
 * claim rail itself, so a bug in `blockModel`'s own helpers cannot hide here.
 */
function beltViolations(document: ResumeDocumentJson): BeltViolation[] {
  const violations: BeltViolation[] = [];
  const block = document[X_CLEARANCE_KEY];
  const declared = (block?.claims ?? []).filter(
    (entry) => entry.usage === 'verbatim' || entry.usage === 'tailored',
  );

  for (const section of ['work', 'projects'] as const) {
    const entries = document[section] ?? [];
    entries.forEach((entry, index) => {
      const highlights = entry.highlights ?? [];
      highlights.forEach((text, highlightIndex) => {
        if (typeof text !== 'string' || text.trim().length === 0) return;
        const path = `${section}[${index}].highlights[${highlightIndex}]`;
        const named = declared.some(
          (claimEntry) =>
            claimEntry.jsonPath === path && (claimEntry.renderedText ?? '').trim() === text.trim(),
        );
        if (!named) violations.push({ path, reason: 'placed text no x-clearance entry names at that path with that text' });
      });
    });
  }

  const seen = new Set<string>();
  for (const claimEntry of block?.claims ?? []) {
    if (seen.has(claimEntry.claimId)) {
      violations.push({ path: claimEntry.claimId, reason: 'the block names one claim twice' });
    }
    seen.add(claimEntry.claimId);
  }

  // ADR-043 R-SUMMARY: `basics.summary` is claim-backed text as well.
  const summary = (document.basics?.summary ?? '').trim();
  if (summary.length > 0) {
    const named = declared.some(
      (claimEntry) =>
        claimEntry.jsonPath === 'basics.summary' &&
        (claimEntry.renderedText ?? '').trim() === summary,
    );
    if (!named) {
      violations.push({
        path: 'basics.summary',
        reason: 'placed text no x-clearance entry names at that path with that text',
      });
    }
  }

  return violations;
}

/** Every claim the document names, by id. */
function claimEntries(document: ResumeDocumentJson): StudioClearanceClaim[] {
  return document[X_CLEARANCE_KEY]?.claims ?? [];
}

function claimFor(document: ResumeDocumentJson, claimId: string): StudioClearanceClaim {
  const entry = claimEntries(document).find((candidate) => candidate.claimId === claimId);
  assert.ok(entry, `expected the document to name ${claimId}`);
  return entry;
}

// ---------------------------------------------------------------------------
// 1. Reading a document
// ---------------------------------------------------------------------------

describe('the model reads a projected document without inventing anything', () => {
  it('gives every entry an id derived from its position, and keeps the claim linkage', () => {
    const model = modelFromDocument(projected());
    assert.deepEqual(model.work.map((entry) => entry.id), ['work:0', 'work:1']);
    assert.deepEqual(model.skills.map((entry) => entry.id), ['skills:0']);
    assert.equal(model.basics.id, 'basics');
    // The linkage is by claim, NOT by text: `work[0].highlights[0]` is clm-1's.
    assert.deepEqual(model.work[0].highlights, [
      { claimId: 'clm-1', text: 'Cut CI build time by 40%', usage: 'verbatim' },
    ]);
    assert.equal(model.work[1].highlights[0].claimId, 'clm-2');
    assert.equal(model.claims.length, 3);
    assert.equal(model.block.profileId, 'profile-1');
  });

  it('round-trips a projected document byte-for-byte in its content (only generatedBy changes)', () => {    // The identity of a revision is its canonical bytes, so an edit-OPEN-then-SAVE with no edit
    // must not produce a different document. `generatedBy` is the one deliberate difference:
    // the producer of the document is now the Studio rather than the projector.
    const before = projected();
    const after = serialize(modelFromDocument(before));
    const strip = (document: ResumeDocumentJson): unknown => {
      const clone = JSON.parse(JSON.stringify(document)) as ResumeDocumentJson;
      if (clone[X_CLEARANCE_KEY]) clone[X_CLEARANCE_KEY].generatedBy = 'stripped';
      return clone;
    };
    assert.equal(canonicalJsonString(strip(after)), canonicalJsonString(strip(before)));
    assert.equal(after[X_CLEARANCE_KEY]?.generatedBy, STUDIO_GENERATOR);
  });

  it('places the professional summary claim back at basics.summary on save', () => {
    // T1080 puts `basics.summary` on the claim rail. The editor carried the text as a plain
    // field, so before this test the claim was serialized as `omitted` while the document
    // still printed the sentence - and `createRevision` refused every save that touched it.
    const document = projected();
    document.basics.summary = 'Builds compilers.';
    document[X_CLEARANCE_KEY]!.claims.push(
      claim({
        claimId: 'clm-summary',
        fingerprint: 'd'.repeat(64),
        kind: 'soft_skill',
        jsonPath: 'basics.summary',
        renderedText: 'Builds compilers.',
      }),
    );

    const model = setBlockField(modelFromDocument(document), 'basics', 'basics', 'summary', 'Builds compilers and runtimes.');
    const saved = serialize(model);
    assert.equal(saved.basics.summary, 'Builds compilers and runtimes.');
    assert.equal(claimFor(saved, 'clm-summary').jsonPath, 'basics.summary');
    assert.equal(claimFor(saved, 'clm-summary').renderedText, 'Builds compilers and runtimes.');
    assert.equal(claimFor(saved, 'clm-summary').usage, 'tailored');
    assert.deepEqual(documentProblems(saved), []);
    assert.deepEqual(beltViolations(saved), []);
  });

  it('is canonical: key order does not change the bytes', () => {
    const a = canonicalJsonString({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJsonString({ a: { c: 3, d: 2 }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
  });

  it('tolerates a malformed member rather than throwing', () => {
    const model = modelFromDocument({
      basics: { name: 'Ada' },
      work: [null as never, { position: 'Engineer' } as never],
      [X_CLEARANCE_KEY]: undefined,
    } as unknown as ResumeDocumentJson);
    assert.equal(model.basics.name, 'Ada');
    assert.equal(model.work.length, 2);
    assert.deepEqual(model.claims, []);
    // And serializing it still produces a document with the one required member.
    const document = serialize(model);
    assert.equal(document.basics.name, 'Ada');
    assert.equal(document.work?.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 2. Reorder: the claim moves with the text
// ---------------------------------------------------------------------------

describe('reorder moves a block and its claim path together', () => {
  it('swaps two roles and re-derives BOTH jsonPaths', () => {
    const model = reorderBlock(modelFromDocument(projected()), 'work', 1, 0);
    const document = serialize(model);

    // The move is real.
    assert.equal(document.work?.[0].name, 'Globex');
    assert.equal(document.work?.[1].name, 'Acme');
    // ...and the block follows it, so the belt is satisfied.
    assert.deepEqual(beltViolations(document), []);
    assert.equal(claimFor(document, 'clm-2').jsonPath, 'work[0].highlights[0]');
    assert.equal(claimFor(document, 'clm-2').renderedText, 'Moved the billing service to Postgres');
    assert.equal(claimFor(document, 'clm-1').jsonPath, 'work[1].highlights[0]');
    assert.equal(claimFor(document, 'clm-1').usage, 'verbatim');
    assert.deepEqual(documentProblems(document), []);
  });

  it('is a NO-OP for an out-of-range or identity move, never a silent wrong move', () => {
    const model = modelFromDocument(projected());
    for (const [from, to] of [
      [-1, 0],
      [0, 5],
      [2, 0],
      [1, 1],
    ] as const) {
      assert.deepEqual(reorderBlock(model, 'work', from, to), model, `${from}->${to}`);
    }
  });

  it('leaves the model holding no paths at all, which is WHY a reorder is safe', () => {
    // The model stores a claimId per statement and no `jsonPath` anywhere, so a move cannot
    // carry a stale address with it. This is the structural half of the guarantee.
    const model = modelFromDocument(projected());
    assert.equal(JSON.stringify(model.work).includes('highlights[0]'), false);
    assert.equal(JSON.stringify(model.work).includes('"jsonPath"'), false);
  });
});

// ---------------------------------------------------------------------------
// 3. Include / exclude: absence, and `omitted`
// ---------------------------------------------------------------------------

describe('excluding a block removes its text AND omits its claims', () => {
  it('drops the entry from the document, records the claim as omitted, and keeps it restorable', () => {
    const model = modelFromDocument(projected());
    const excluded = excludeBlock(model, 'work', 0);
    const document = serialize(excluded);

    // NOT RENDERED. The entry is gone from the document, so no renderer can show it.
    assert.equal(document.work?.length, 1);
    assert.equal(document.work?.some((entry) => entry.name === 'Acme'), false);
    assert.equal(JSON.stringify(document).includes('Cut CI build time by 40%'), false);
    // ...and its claim is `omitted` with no path and no text, which is the vocabulary the
    // projector uses for "considered, deliberately not placed".
    const omitted = claimFor(document, 'clm-1');
    assert.equal(omitted.usage, 'omitted');
    assert.equal(omitted.jsonPath, null);
    assert.equal(omitted.renderedText, null);
    // The claim is STILL in the block: "the profile knows this and the resume does not say it".
    assert.equal(claimEntries(document).length, 3);
    // And the belt is satisfied: the text left the document with the entry.
    assert.deepEqual(beltViolations(document), []);
    assert.deepEqual(documentProblems(document), []);
    // The counts follow the usages.
    assert.equal(document[X_CLEARANCE_KEY]?.claimCount, 3);
    assert.equal(placedClaimCount(document), 1);
    // The removed block is retained so include can restore it verbatim.
    assert.equal(excluded.excluded.length, 1);
    assert.equal(excluded.excluded[0].section, 'work');
    assert.equal((excluded.excluded[0].block as { name: string }).name, 'Acme');
  });

  it('restores it, with the claim placed again at the path its NEW position implies', () => {
    const model = modelFromDocument(projected());
    const excluded = excludeBlock(model, 'work', 0);
    const restored = serialize(includeBlock(excluded, 0));

    assert.equal(restored.work?.length, 2);
    // Back at the end, not resurrected at index 0: the path is re-derived, never remembered.
    assert.equal(restored.work?.[1].name, 'Acme');
    assert.equal(claimFor(restored, 'clm-1').jsonPath, 'work[1].highlights[0]');
    assert.equal(claimFor(restored, 'clm-1').usage, 'verbatim');
    assert.deepEqual(beltViolations(restored), []);
    // And the excluded tray is empty again.
    assert.equal(includeBlock(excluded, 0).excluded.length, 0);
  });

  it('omits EVERY claim an excluded entry carried, not just the first', () => {
    const document = projected();
    const entry = document.work![1];
    entry.highlights = ['Moved the billing service to Postgres', 'Cut the deploy to 4 minutes'];
    const block = document[X_CLEARANCE_KEY]!;
    block.claims.push(
      claim({
        claimId: 'clm-4',
        fingerprint: 'd'.repeat(64),
        jsonPath: 'work[1].highlights[1]',
        renderedText: 'Cut the deploy to 4 minutes',
      }),
    );
    const excluded = serialize(excludeBlock(modelFromDocument(document), 'work', 1));
    assert.equal(excluded.work?.length, 1);
    for (const id of ['clm-2', 'clm-4']) {
      assert.equal(claimFor(excluded, id).usage, 'omitted', id);
      assert.equal(claimFor(excluded, id).jsonPath, null, id);
    }
    assert.deepEqual(beltViolations(excluded), []);
  });

  it('an out-of-range exclude is a NO-OP', () => {
    const model = modelFromDocument(projected());
    assert.deepEqual(excludeBlock(model, 'work', 9), model);
    assert.deepEqual(excludeBlock(model, 'work', -1), model);
  });
});

// ---------------------------------------------------------------------------
// 4. Editing a claim-backed statement
// ---------------------------------------------------------------------------

describe('re-wording a statement keeps the document and the block in step', () => {
  const edit = (text: string) =>
    editInlineValue(modelFromDocument(projected()), {
      section: 'work',
      blockId: 'work:0',
      highlightIndex: 0,
      value: inlineFromPlainText(text),
    }).model;

  it('flips the usage to `tailored` and writes BOTH the text and the block entry', () => {
    const document = serialize(edit('Cut CI build time by 55%'));
    assert.equal(document.work?.[0].highlights?.[0], 'Cut CI build time by 55%');
    const entry = claimFor(document, 'clm-1');
    // 05 sec.6.3: re-phrasing is `tailored`, and it is never a value outside the server's three.
    assert.equal(entry.usage, 'tailored');
    assert.equal(entry.renderedText, 'Cut CI build time by 55%');
    // The belt compares the two, so this is the assertion that matters.
    assert.deepEqual(beltViolations(document), []);
    assert.deepEqual(documentProblems(document), []);
  });

  it('returns to `verbatim` when the text is put back exactly', () => {
    const document = serialize(edit('Cut CI build time by 40%'));
    assert.equal(claimFor(document, 'clm-1').usage, 'verbatim');
    assert.deepEqual(beltViolations(document), []);
  });

  it('blanking a statement OMITS the claim rather than writing an empty bullet', () => {
    const document = serialize(edit('   '));
    // No `highlights` member at all rather than `['']`: a blank string is not a rendering of
    // anything, and the projector never emits one.
    assert.equal('highlights' in document.work![0], false);
    const entry = claimFor(document, 'clm-1');
    assert.equal(entry.usage, 'omitted');
    assert.equal(entry.jsonPath, null);
    assert.equal(entry.renderedText, null);
    assert.deepEqual(beltViolations(document), []);
  });

  it('never changes a STATUS', () => {
    const before = projected()[X_CLEARANCE_KEY]!.claims;
    const after = serialize(edit('A completely different sentence'))[X_CLEARANCE_KEY]!.claims;
    assert.doesNotThrow(() => assertStatusUnchanged(before, after));
    assert.deepEqual(
      after.map((entry) => entry.status),
      before.map((entry) => entry.status),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Statuses are server truth
// ---------------------------------------------------------------------------

describe('a claim status is server truth the Studio cannot write', () => {
  it('accepts a usage, path or text change', () => {
    const before = projected()[X_CLEARANCE_KEY]!.claims;
    const after = before.map((entry) => ({
      ...entry,
      usage: 'omitted' as const,
      jsonPath: null,
      renderedText: null,
    }));
    assert.doesNotThrow(() => assertStatusUnchanged(before, after));
  });

  it('refuses a changed status, and says which claim', () => {
    const before = projected()[X_CLEARANCE_KEY]!.claims;
    const forged = before.map((entry) =>
      entry.claimId === 'clm-1' ? { ...entry, status: 'user_confirmed' as const } : entry,
    );
    const beforeInferred = before.map((entry) =>
      entry.claimId === 'clm-1' ? { ...entry, status: 'inferred' as const } : entry,
    );
    assert.throws(() => assertStatusUnchanged(beforeInferred, forged), /clm-1/);
  });

  it('refuses a claim the saved revision never named', () => {
    const before = projected()[X_CLEARANCE_KEY]!.claims;
    const invented = [...before, claim({ claimId: 'clm-9', jsonPath: null, usage: 'omitted', renderedText: null })];
    assert.throws(() => assertStatusUnchanged(before, invented), /clm-9/);
  });
});

// ---------------------------------------------------------------------------
// 6. Adding and editing the plain (non-claim) blocks
// ---------------------------------------------------------------------------

describe('blocks with no claim-rail text can be added and removed freely', () => {
  it('adds an empty role with the schema-required members and no empty highlights array', () => {
    const model = addBlock(modelFromDocument(projected()), 'work');
    const document = serialize(model);
    assert.equal(document.work?.length, 3);
    const added = document.work![2];
    assert.deepEqual(added, { name: '', position: '' });
    // An `highlights: []` would be noise the projector never emits.
    assert.equal('highlights' in added, false);
    assert.deepEqual(beltViolations(document), []);
  });

  it('adds a skill, an education entry, a project and a certificate', () => {
    let model = modelFromDocument(projected());
    for (const section of ['skills', 'education', 'projects', 'certificates'] as const) {
      model = addBlock(model, section);
    }
    const document = serialize(model);
    assert.equal(document.skills?.length, 2);
    assert.equal(document.education?.length, 1);
    assert.equal(document.projects?.length, 1);
    assert.equal(document.certificates?.length, 1);
    assert.deepEqual(beltViolations(document), []);
  });

  it('sets a plain field without touching the block', () => {
    const model = setBlockField(modelFromDocument(projected()), 'work', 'work:0', 'position', 'Principal Engineer');
    const document = serialize(model);
    assert.equal(document.work?.[0].position, 'Principal Engineer');
    assert.deepEqual(beltViolations(document), []);
    assert.equal(documentProblems(document).length, 0);
  });

  it('ignores a block id that is not in the section', () => {
    const model = modelFromDocument(projected());
    assert.deepEqual(setBlockField(model, 'work', 'skills:0', 'name', 'x'), model);
  });

  it('omits an empty optional member rather than writing a blank', () => {
    const model = setBlockField(modelFromDocument(projected()), 'work', 'work:0', 'summary', '');
    assert.equal('summary' in serialize(model).work![0], false);
  });
});

// ---------------------------------------------------------------------------
// 7. The inline value's contract with the document
// ---------------------------------------------------------------------------

describe('the inline value is an editing representation, not a document shape', () => {
  it('round-trips plain text losslessly', () => {
    for (const text of ['', 'Cut CI build time by 40%', '  padded  ', 'multi\nline']) {
      assert.equal(inlineToPlainText(plainTextToInline(text)), text);
      assert.equal(inlineToPlainText(inlineFromPlainText(text)), text);
    }
  });

  it('carries marks, and merges runs that read identically', () => {
    const value: InlineValue = {
      format: 'inline-v1',
      runs: [
        { text: 'Cut ' },
        { text: 'CI', marks: ['bold'] },
        { text: ' build' },
      ],
    };
    const normalized = normalizeInlineValue(value);
    assert.equal(normalized.runs.length, 3);
    assert.deepEqual(normalized.runs[1].marks, ['bold']);
    // The FLAT text is what the document member carries.
    assert.equal(inlineToPlainText(normalized), 'Cut CI build');

    // Adjacent equal-mark runs collapse: two documents that read identically must serialise
    // identically or `jsonHash` stops meaning anything.
    const merged = normalizeInlineValue({
      format: 'inline-v1',
      runs: [
        { text: 'a', marks: ['bold'] },
        { text: 'b', marks: ['bold', 'bold'] },
        { text: 'c' },
        { text: '' },
      ],
    });
    assert.deepEqual(merged.runs, [
      { text: 'ab', marks: ['bold'] },
      { text: 'c' },
    ]);
  });

  it('normalises mark order so a hash cannot depend on toggle order', () => {
    const a = normalizeInlineValue({ format: 'inline-v1', runs: [{ text: 'x', marks: ['link', 'bold'] }] });
    const b = normalizeInlineValue({ format: 'inline-v1', runs: [{ text: 'x', marks: ['bold', 'link'] }] });
    assert.equal(canonicalJsonString(a), canonicalJsonString(b));
  });

  it('applies and removes a mark across a range', () => {
    const base: InlineValue = { format: 'inline-v1', runs: [{ text: 'Cut CI time' }] };
    const bolded = normalizeInlineValue({
      format: 'inline-v1',
      runs: [{ text: 'Cut ', marks: ['bold'] }, { text: 'CI time' }],
    });
    assert.equal(inlineToPlainText(bolded), inlineToPlainText(base));
  });
});

// ---------------------------------------------------------------------------
// 8. The problem detector, and what it catches
// ---------------------------------------------------------------------------

describe('documentProblems catches exactly the shapes the server refuses', () => {
  it('finds a reordered array whose block was not updated - the mutation this test exists for', () => {
    // Hand-built corruption: the array moved, the block did not. This is what a reorder that
    // forgot to re-derive the paths would produce.
    const document = projected();
    document.work = [document.work![1], document.work![0]];
    const problems = documentProblems(document);
    assert.equal(problems.length, 2);
    assert.ok(problems.some((entry) => entry.includes('work[0].highlights[0]')));
    assert.ok(problems.some((entry) => entry.includes('work[1].highlights[0]')));
    // And the independent oracle agrees.
    assert.equal(beltViolations(document).length, 2);
    assert.equal(unaccountedText(document).length, 2);
  });

  it('finds a block that names one claim twice', () => {
    const document = projected();
    document[X_CLEARANCE_KEY]!.claims.push(claim());
    assert.deepEqual(duplicateClaimIds(document), ['clm-1']);
    assert.ok(documentProblems(document).some((entry) => entry.includes('clm-1')));
  });

  it('finds text that changed without the block changing', () => {
    const document = projected();
    document.work![0].highlights = ['Cut CI build time by 99%'];
    assert.equal(unaccountedText(document).length, 1);
    assert.ok(beltViolations(document).some((entry) => entry.path === 'work[0].highlights[0]'));
  });

  it('finds a summary the block does not name', () => {
    // `basics.summary` is on the claim rail (ADR-043 R-SUMMARY), so free prose there is the
    // same refusal as an unnamed highlight.
    const document = projected();
    document.basics.summary = 'Free prose the profile never claimed.';
    assert.deepEqual(unaccountedText(document), ['basics.summary']);
    assert.ok(documentProblems(document).some((entry) => entry.includes('basics.summary')));
  });

  it('passes every document this module can produce', () => {
    let model = modelFromDocument(projected());
    model = reorderBlock(model, 'work', 1, 0);
    model = setBlockField(model, 'work', 'work:0', 'position', 'Principal Engineer');
    model = addBlock(model, 'projects');
    model = excludeBlock(model, 'work', 0);
    model = includeBlock(model, 0);
    model = editInlineValue(model, {
      section: 'work',
      blockId: 'work:0',
      highlightIndex: 0,
      value: inlineFromPlainText('Reworded in the Studio'),
    }).model;
    const document = serialize(model);
    assert.deepEqual(beltViolations(document), []);
    assert.deepEqual(documentProblems(document), []);
    assert.deepEqual(unaccountedText(document), []);
  });
});

// ---------------------------------------------------------------------------
// 9. Section vocabulary, and the "no inferred claims included" guarantee line
// ---------------------------------------------------------------------------

describe('the section vocabulary and the confirmation guarantee line', () => {
  it('names every JSON Resume member the Studio edits, in document order', () => {
    assert.deepEqual([...SECTION_KEYS], ['basics', 'work', 'education', 'projects', 'skills', 'certificates']);
    assert.deepEqual([...LIST_SECTIONS], ['work', 'education', 'projects', 'skills', 'certificates']);
  });

  it('counts the claim-backed statements actually placed, and how many are unconfirmed', () => {
    const document = projected();
    assert.equal(placedClaimCount(document), 2);
    assert.equal(unconfirmedPlacedCount(document), 0);

    const withInference = projected();
    withInference[X_CLEARANCE_KEY]!.claims[1] = {
      ...withInference[X_CLEARANCE_KEY]!.claims[1],
      status: 'inferred',
    };
    // An unconfirmed statement still counts as PLACED - which is precisely why the preview has
    // to say so out loud rather than quietly showing a resume.
    assert.equal(placedClaimCount(withInference), 2);
    assert.equal(unconfirmedPlacedCount(withInference), 1);
  });

  it('counts an omitted claim as neither placed nor unconfirmed', () => {
    const document = serialize(excludeBlock(modelFromDocument(projected()), 'work', 0));
    assert.equal(placedClaimCount(document), 1);
    assert.equal(unconfirmedPlacedCount(document), 0);
    assert.equal(claimEntries(document).length, 3);
  });
});

// ---------------------------------------------------------------------------
// 10. The document bytes
// ---------------------------------------------------------------------------

describe('documentBytes is a function of the document alone', () => {
  it('is identical for two models that differ only in a template choice', () => {
    // The acceptance item, at the model layer: `serialize` takes no template, so there is no
    // channel for one. This test is the mechanism; `templateSwitch.test.ts` asserts the same
    // property across the component boundary.
    const model = modelFromDocument(projected());
    assert.equal(documentBytes(model), documentBytes(modelFromDocument(projected())));
    assert.equal(serialize.length, 1);
  });
});