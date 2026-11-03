// The `.json` exporter - unit tests.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 5 / sec. 12
//                 .planning/decisions/ADR-035-canonical-model-jsonresume-hybrid.md
//                 .planning/specs/clearance-v2/05-canonical-model.md sec. 1
// Task:         T1044
//
// NOTHING HERE NEEDS A DOCKER DAEMON, A DATABASE, OR A TEMPLATE. The exporter is
// `canonicalJsonString` plus UTF-8, and every acceptance item is a property of the bytes.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { ClaimStatus, ResumeUsage } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  X_CLEARANCE_KEY,
  X_CLEARANCE_VERSION,
  canonicalJsonHash,
  canonicalJsonString,
} from '../resume/json/jsonresume.js';
import { validateResumeJson } from '../resume/json/validate.js';
import { dictToDataJson, projectResumeDict } from './dict.js';
import {
  JSON_EXPORT_EXTENSION,
  asResumeJson,
  renderJsonExportBytes,
  renderJsonExportString,
} from './jsonExport.js';

const MODULE_SOURCE = readFileSync(path.join(__dirname, 'jsonExport.ts'), 'utf8');

/**
 * The repository-wide gate's vocabulary, ASSEMBLED rather than written out.
 *
 * `render/broker.test.ts`'s G1 greps every `.ts` file under `src/` (comments stripped) for
 * `dockerode|docker-modem|child_process` and does not exempt this directory, so naming one
 * of them here - even in a list of forbidden things - would make this file a G1 hit. The
 * assembled strings are byte-identical to the gate's.
 */
const PROCESS_AND_CLIENT_TOKENS: readonly string[] = Object.freeze([
  'docker' + 'ode',
  'docker-' + 'modem',
  'child_' + 'process',
]);

/** Comments are stripped first: prose ABOUT a call is not a call. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * A revision document in the full canonical shape: JSON Resume plus the `x-clearance`
 * ledger, with every ledger member present so the document validates (ADR-035).
 */
function revision(): Record<string, unknown> {
  return {
    basics: {
      name: 'Ada Lovelace',
      label: 'Staff Platform Engineer',
      email: 'ada@example.org',
      phone: '+44 20 7946 0018',
      url: 'https://example.org/ada',
      summary: 'Platform engineer.',
      location: { city: 'London', countryCode: 'GB' },
      profiles: [{ network: 'GitHub', username: 'ada', url: 'https://github.com/adalovelace' }],
    },
    work: [
      {
        name: 'Meridian Data',
        position: 'Staff Platform Engineer',
        startDate: '2022-03-01',
        highlights: ['First', 'Second'],
      },
    ],
    education: [{ institution: 'University of Bristol', studyType: 'MEng', endDate: '2015-06' }],
    skills: [{ name: 'Rust', level: 'Advanced' }],
    certificates: [{ name: 'CKA', issuer: 'CNCF', date: '2021-04' }],
    meta: { zzz: 1, aaa: 2, mmm: 3 },
    [X_CLEARANCE_KEY]: {
      version: X_CLEARANCE_VERSION,
      generatedBy: 'test',
      sourceModelVersion: 2,
      profileId: 'profile-1',
      claimCount: 1,
      confirmedClaimCount: 0,
      unconfirmedClaimCount: 1,
      claims: [
        {
          claimId: 'clm-1',
          fingerprint: 'a'.repeat(64),
          kind: 'achievement',
          status: ClaimStatus.inferred,
          provenance: 'llm_inferred',
          confidence: 0.7,
          evidenceSourceId: null,
          usage: ResumeUsage.verbatim,
          jsonPath: 'work[0].highlights[0]',
          renderedText: 'First',
        },
      ],
    },
  };
}

function deepShuffleKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepShuffleKeys(entry)) as unknown as T;
  }
  // `null` is typeof 'object', so it has to be excluded BEFORE the object branch or
  // `Object.keys(null)` throws. The fixture carries null members on purpose (`confidence`,
  // `evidenceSourceId`), so this is a real path and not a theoretical one.
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).reverse()) {
    out[key] = deepShuffleKeys(source[key]);
  }
  return out as unknown as T;
}

// ---------------------------------------------------------------------------
// The input-type decision, stated as a test
// ---------------------------------------------------------------------------

describe('the input is the REVISION DOCUMENT, and that choice is deliberate', () => {
  it('the exported bytes are the canonical form of the document, not a projection of it', () => {
    const document = revision();
    const bytes = renderJsonExportBytes(document);
    // The same serialiser the revision snapshot and `jsonHash` use - not a re-implementation.
    expect(bytes.toString('utf8')).toBe(canonicalJsonString(document));
    expect(renderJsonExportString(document)).toBe(canonicalJsonString(document));
    expect(JSON_EXPORT_EXTENSION).toBe('json');
  });

  it('the x-clearance LEDGER survives, which a dictionary-derived export would have deleted', () => {
    // This is WHY the input is the document. `dict.ts` rule 5 puts the ledger deliberately
    // OUTSIDE the render projection ("printing a claim status beside a name on a PDF is not
    // a decision this projection may take"), so an export re-derived from the dictionary
    // would silently strip the provenance from the user's own file.
    const document = revision();
    const exported = renderJsonExportBytes(document).toString('utf8');
    const dictionaryBytes = dictToDataJson(projectResumeDict(document)).toString('utf8');

    expect(exported).toContain('"x-clearance"');
    expect(exported).toContain('"claimId":"clm-1"');
    expect(exported).toContain(`"status":"${ClaimStatus.inferred}"`);
    expect(exported).toContain('"renderedText":"First"');
    expect(exported).not.toContain('undefined');

    // The control: the dictionary genuinely does NOT carry the ledger, so the two exports are
    // different artifacts and this is a real distinction rather than a hypothetical one.
    expect(dictionaryBytes).not.toContain('x-clearance');
    expect(dictionaryBytes).not.toContain('clm-1');
    expect(exported).not.toBe(dictionaryBytes);
    // And the ledger counts survive, which a re-projection could not invent.
    expect(exported).toContain('"unconfirmedClaimCount":1');
  });

  it('the export hash is the revision hash: one serialiser, so the artifact is checkable', () => {
    const document = revision();
    expect(createHash('sha256').update(renderJsonExportBytes(document)).digest('hex')).toBe(
      canonicalJsonHash(document),
    );
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 5: canonical, stable, and schema-valid
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 5: the export is canonical, byte-identical, and schema-valid', () => {
  it('object keys are sorted at every depth, array order is preserved', () => {
    const document = revision();
    const text = renderJsonExportString(document);
    // Canonical means sorted: a top-level object written in ANY other key order would fail
    // this, because the first key emitted has to be the alphabetically smallest.
    expect(text.startsWith('{"basics":')).toBe(true);
    expect(text.indexOf('"work"')).toBeGreaterThan(text.indexOf('"skills":'));
    // `meta` is deliberately declared out of order in the fixture, so this is a test of the
    // serialiser rather than of the fixture.
    const meta = JSON.parse(text) as { meta: Record<string, unknown> };
    const metaKeys = Object.keys(meta.meta);
    expect(metaKeys).toEqual(['aaa', 'mmm', 'zzz']);
    expect([...metaKeys].sort()).toEqual(metaKeys);
    // Array order is MEANINGFUL and is preserved: `work[0]` is a position in the document,
    // and re-ordering the array changes the bytes. A two-entry array, because reversing a
    // one-entry array is a no-op and would make the control vacuous.
    const parsed = JSON.parse(text) as { work: Array<{ position: string }> };
    expect(parsed.work.map((entry) => entry.position)).toEqual(['Staff Platform Engineer']);
    const reordered = JSON.parse(JSON.stringify(revision())) as Record<string, unknown>;
    (reordered.work as unknown[]).push({ name: 'Halcyon', position: 'SRE' });
    expect(renderJsonExportString(reordered)).not.toBe(text);
    // ...and the appended entry really is in the exported array, in the position it was
    // written: the serialiser sorts KEYS, never array members.
    const exported = JSON.parse(renderJsonExportString(reordered)) as {
      work: Array<{ position: string }>;
    };
    expect(exported.work.map((entry) => entry.position)).toEqual([
      'Staff Platform Engineer',
      'SRE',
    ]);
  });

  it('byte-identical across two calls, and across a re-read of the same document', () => {
    const document = revision();
    const first = renderJsonExportBytes(document);
    const second = renderJsonExportBytes(document);
    expect(first.equals(second)).toBe(true);
    // ...and the round trip through the bytes is a fixed point: parsing and re-serialising
    // the export reproduces it exactly, which is what makes a stored artifact stable.
    const parsed = JSON.parse(first.toString('utf8')) as unknown;
    expect(renderJsonExportBytes(parsed).equals(first)).toBe(true);
  });

  it('key order in the INPUT is not information', () => {
    const document = revision();
    const shuffled = deepShuffleKeys(document);
    expect(renderJsonExportString(shuffled)).toBe(renderJsonExportString(document));
    expect(renderJsonExportBytes(shuffled).equals(renderJsonExportBytes(document))).toBe(true);
  });

  it('validates against the resume JSON schema', () => {
    const document = revision();
    const result = validateResumeJson(JSON.parse(renderJsonExportString(document)));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    // The control, so the test above is not a tautology: the same schema REJECTS a document
    // whose ledger is malformed, which is what proves the export is being checked rather
    // than trivially accepted.
    const broken = revision();
    (broken[X_CLEARANCE_KEY] as Record<string, unknown>).claimCount = 'one';
    expect(validateResumeJson(JSON.parse(renderJsonExportString(broken))).valid).toBe(false);
  });

  it('round-trips every JSON value kind, including an empty section and a null member', () => {
    const document = {
      basics: { name: 'Ada' },
      work: [],
      education: [],
      meta: { n: 1, f: 1.5, s: 'x', b: true, z: null, arr: [3, 2, 1], nested: { b: 0, a: 0 } },
    };
    const parsed = JSON.parse(renderJsonExportString(document)) as Record<string, unknown>;
    expect(parsed).toEqual(document);
    // `undefined` members are dropped, exactly as `JSON.stringify` drops them, so an absent
    // optional is absent rather than `null`.
    expect(renderJsonExportString({ basics: { name: 'Ada', label: undefined } })).toBe(
      '{"basics":{"name":"Ada"}}',
    );
  });
});

// ---------------------------------------------------------------------------
// Refusals, totality, and the import set
// ---------------------------------------------------------------------------

describe('the exporter refuses only what cannot be canonical JSON', () => {
  it('a non-JSON value is a TypeError, never a coerced surprise', () => {
    // Inherited from `canonicalJsonString` and deliberate: a projection that quietly turned a
    // `Date` into a string would make the export depend on an implementation detail, and the
    // route turns the throw into a refusal rather than into a wrong document.
    for (const value of [new Date(0), new Map(), () => 1, Number.NaN, Number.POSITIVE_INFINITY, 1n]) {
      expect(() => renderJsonExportBytes(value), `${String(value)} was accepted`).toThrow(TypeError);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => renderJsonExportBytes(cyclic)).toThrow(TypeError);
  });

  it('asResumeJson is a narrow, not a validation', () => {
    const document = revision();
    expect(asResumeJson(document)).toBe(document);
    for (const value of [null, undefined, 42, 'x', []]) {
      expect(() => asResumeJson(value)).toThrow(TypeError);
    }
  });

  it('the import set is the canonical serialiser only: no stager, no broker, no engine', () => {
    // The same import-set assertion the `.tex` exporter carries, because the failure it
    // prevents is the same one: a later edit giving the export path a compiler.
    const code = withoutComments(MODULE_SOURCE);
    const specifiers = [...code.matchAll(/(?:from|import|require\()\s*'([^']+)'/g)].map((m) => m[1]);
    expect([...new Set(specifiers)].sort()).toEqual(['../resume/json/jsonresume.js']);
    for (const forbidden of [
      'stage',
      'brokerClient',
      'broker/',
      'typst',
      'docx',
      './sandbox',
      'latexExport',
      'storage',
      'templates',
    ]) {
      expect(code.toLowerCase(), `jsonExport.ts references ${forbidden}`).not.toContain(forbidden.toLowerCase());
    }
    for (const forbidden of PROCESS_AND_CLIENT_TOKENS) {
      expect(code.toLowerCase(), `jsonExport.ts references ${forbidden}`).not.toContain(forbidden);
    }
    // And the serialiser is the SHARED one: a second implementation of "canonical JSON" in this
    // file would be the drift the whole revision hash depends on.
    expect(code).toContain('canonicalJsonString');
    expect(code).not.toContain('JSON.stringify');
  });
});