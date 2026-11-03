// =====================================================================================
// career/evidence.test.ts - EvidenceSource create / dedupe / read (T1011, 05 sec.5).
//
// The invariant under test here is the IMPORT one: re-uploading the same document is a
// no-op, because `@@unique([profileId, contentHash])` plus a pure dedupe means the
// claims that point at a source keep pointing at the SAME row - which is what makes
// "which claims came from this file?" answerable later (ADR-036: complete audit).
// ADR-041 D2 is checked too: bytes never reach Postgres, only a storage key + size.
// =====================================================================================

import { describe, it, expect } from 'vitest';
import { EvidenceKind } from '@prisma/client';
import {
  createEvidenceSource,
  evidenceContentHash,
  findEvidenceSourceByHash,
  getEvidenceSourceById,
  isEvidenceKind,
  listEvidenceSources,
  normalizeEvidenceText,
  type EvidenceCreateInput,
} from './evidence.js';
import { ClaimInvariantError } from './claims.js';
import { FakeCareerStore } from './careerStore.fixtures.js';

const PROFILE = 'profile-1';
const RESUME_TEXT = 'Senior Backend Engineer\nAcme Corp 2021-2026\n\n- Cut CI build time by 40%';

function resumeInput(overrides: Partial<EvidenceCreateInput> = {}): EvidenceCreateInput {
  return {
    profileId: PROFILE,
    kind: EvidenceKind.document,
    title: 'Resume 2026.pdf',
    text: RESUME_TEXT,
    ...overrides,
  };
}

describe('content hash', () => {
  it('is stable, and insensitive to line endings, trailing spaces and blank runs', () => {
    const a = evidenceContentHash(RESUME_TEXT);
    const b = evidenceContentHash('Senior Backend Engineer\r\nAcme Corp 2021-2026\r\n\r\n   \n- Cut CI build time by 40%');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes NFKC and keeps interior layout', () => {
    expect(normalizeEvidenceText('Ｔitle\r\nBody   \n\n\n\nEnd  ')).toBe('Title\nBody\n\nEnd');
  });

  it('refuses to hash empty text', () => {
    expect(() => evidenceContentHash('  \n \n')).toThrow(ClaimInvariantError);
  });
});

describe('create + dedupe on (profileId, contentHash)', () => {
  it('creates once, then returns the same source for the same content', async () => {
    const store = new FakeCareerStore();
    const first = await createEvidenceSource(resumeInput(), store.asStore());
    expect(first.outcome).toBe('created');

    const again = await createEvidenceSource(resumeInput(), store.asStore());
    expect(again.outcome).toBe('deduped');
    expect(again.source.id).toBe(first.source.id);

    // Same bytes, different line endings and a re-worded TITLE: still one row, and the
    // stored row is not rewritten (a re-import never re-dates or re-titles a source).
    const reimport = await createEvidenceSource(
      resumeInput({ title: 'my new resume v3.pdf', text: RESUME_TEXT.replace(/\n/g, '\r\n') }),
      store.asStore(),
    );
    expect(reimport.outcome).toBe('deduped');
    expect(reimport.source.title).toBe('Resume 2026.pdf');
    expect(store.evidence.size).toBe(1);
    expect(store.writes).toEqual(['evidence.create']);
  });

  it('scopes the dedupe per profile: the same file under two people is two sources', async () => {
    const store = new FakeCareerStore();
    await createEvidenceSource(resumeInput(), store.asStore());
    const other = await createEvidenceSource(resumeInput({ profileId: 'profile-2' }), store.asStore());
    expect(other.outcome).toBe('created');
    expect(store.evidence.size).toBe(2);
  });

  it('accepts a pre-computed hash instead of the text', async () => {
    const store = new FakeCareerStore();
    const hash = evidenceContentHash(RESUME_TEXT);
    const result = await createEvidenceSource(
      resumeInput({ text: null, contentHash: hash }),
      store.asStore(),
    );
    expect(result.source.contentHash).toBe(hash);
  });

  it('validates kind, title and hash shape, and writes nothing when it refuses', async () => {
    const store = new FakeCareerStore();
    await expect(
      createEvidenceSource(resumeInput({ kind: 'pdf' as EvidenceKind }), store.asStore()),
    ).rejects.toThrow(/kind must be an EvidenceKind/);
    await expect(createEvidenceSource(resumeInput({ title: '  ' }), store.asStore())).rejects.toThrow(
      /non-empty title/,
    );
    await expect(
      createEvidenceSource(
        resumeInput({ text: null, contentHash: 'not-a-hash' }),
        store.asStore(),
      ),
    ).rejects.toThrow(/64 lowercase hex/);
    await expect(
      createEvidenceSource(resumeInput({ text: null, contentHash: null }), store.asStore()),
    ).rejects.toThrow(/supply either text/);
    await expect(createEvidenceSource(resumeInput({ byteSize: -1 }), store.asStore())).rejects.toThrow(
      /byteSize must be a non-negative integer/,
    );
    expect(store.evidence.size).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('keeps bytes out of Postgres (ADR-041 D2): storage key + size metadata only', async () => {
    const store = new FakeCareerStore();
    const result = await createEvidenceSource(
      resumeInput({ storageKey: 'evidence/2026/resume.pdf', byteSize: 182_233, mimeType: 'application/pdf' }),
      store.asStore(),
    );
    expect(result.source.storageKey).toBe('evidence/2026/resume.pdf');
    expect(result.source.byteSize).toBe(182_233);
    expect(result.source).not.toHaveProperty('fileBytes');
    expect(result.source).not.toHaveProperty('bytes');
  });
});

describe('read', () => {
  it('reads by id and by hash, and lists per profile with a kind filter', async () => {
    const store = new FakeCareerStore();
    const resume = await createEvidenceSource(resumeInput(), store.asStore());
    await createEvidenceSource(
      resumeInput({
        kind: EvidenceKind.github_repo,
        title: 'github.com/me/project',
        url: 'https://github.com/me/project',
        text: 'github.com/me/project\ntypescript, postgres',
      }),
      store.asStore(),
    );

    expect((await getEvidenceSourceById(resume.source.id, store.asStore()))?.id).toBe(resume.source.id);
    expect(await getEvidenceSourceById('missing', store.asStore())).toBeNull();
    expect(
      (await findEvidenceSourceByHash(PROFILE, resume.source.contentHash, store.asStore()))?.id,
    ).toBe(resume.source.id);
    await expect(
      findEvidenceSourceByHash(PROFILE, 'nope', store.asStore()),
    ).rejects.toBeInstanceOf(ClaimInvariantError);

    const all = await listEvidenceSources({ profileId: PROFILE }, store.asStore());
    expect(all).toHaveLength(2);
    const docs = await listEvidenceSources({ profileId: PROFILE, kind: EvidenceKind.document }, store.asStore());
    expect(docs.map((row) => row.id)).toEqual([resume.source.id]);
    expect(isEvidenceKind('github_repo')).toBe(true);
    expect(isEvidenceKind('github')).toBe(false);
    await expect(listEvidenceSources({ profileId: '' }, store.asStore())).rejects.toBeInstanceOf(
      ClaimInvariantError,
    );
  });
});
