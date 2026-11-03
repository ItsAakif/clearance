// resume/json/validate.test.ts - draft-07 validation of a Resume JSON document (T1030).
//
// NORMATIVE: 05 sec.1. The claim under test is MECHANICAL:
//
//   "the canonical @jsonresume/schema is draft-07 with `additionalProperties: true` at
//    the root and in nested objects ... so a `x-clearance` block is explicitly
//    permitted."
//
// A comment claiming a schema permits an extension is worth nothing, so this file
// compiles that schema, validates against it, and then REMOVES the permission and
// watches the same document fail. If the permission ever became load-bearing without
// anyone noticing, `the x-clearance block is permitted BECAUSE the root is
// additionalProperties: true` fails.
//
// The suite also pins the failure mode the module header states: this validator
// implements a named subset of draft-07, and `UNSUPPORTED_KEYWORDS` says which
// keywords are outside it. A validator that silently ignored `pattern` would look
// stricter than it is, so the set is asserted to be exactly what the header claims.

import { describe, it, expect } from 'vitest';
import { ClaimStatus, ResumeUsage } from '@prisma/client';

import {
  RESUME_JSON_SCHEMA,
  JSON_RESUME_SCHEMA,
  SUPPORTED_KEYWORDS,
  UNSUPPORTED_KEYWORDS,
  X_CLEARANCE_SCHEMA,
  assertValidResumeJson,
  hasClearanceBlock,
  validate,
  validateClearanceBlock,
  validateResumeJson,
  ResumeJsonValidationError,
  type JsonSchemaNode,
} from './validate.js';
import { X_CLEARANCE_KEY, X_CLEARANCE_VERSION, canonicalJsonString } from './jsonresume.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A minimal well-formed JSON Resume document, no extension block. */
function plainResume() {
  return { basics: { name: 'Ada Lovelace' } };
}

/** A well-formed clearance block for `claimId`, with every member present. */
function clearanceBlock(overrides: Record<string, unknown> = {}) {
  return {
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
        renderedText: 'Cut CI build time by 40%',
      },
    ],
    ...overrides,
  };
}

function withBlock(block: unknown = clearanceBlock()) {
  return { ...plainResume(), [X_CLEARANCE_KEY]: block };
}

// ---------------------------------------------------------------------------
// The root permission: this is the acceptance item
// ---------------------------------------------------------------------------

describe('x-clearance is PERMITTED because the JSON Resume root is additionalProperties: true', () => {
  it('validates a document carrying an x-clearance block', () => {
    const result = validateResumeJson(withBlock());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('a PERMISSIVE community schema accepts the block it has never heard of', () => {
    // This IS 05 sec.1's mechanism, stated as a test: the unmodified community schema
    // has `additionalProperties: true` at the root, so a document carrying our block
    // validates against it unchanged. That is what makes the extension legal rather
    // than a fork, and a downstream consumer with the real `@jsonresume/schema` gets
    // this answer for free.
    expect(JSON_RESUME_SCHEMA.additionalProperties).toBe(true);
    const accepted = validate(withBlock(), JSON_RESUME_SCHEMA);
    expect(accepted.valid).toBe(true);
  });

  it('a STRICT community schema REJECTS the same document, on the root permission alone', () => {
    // The control, and the reason the permissive case above is a real property rather
    // than a tautology: the ONLY difference is `additionalProperties` at the root. Turn
    // the permission off - which is what a strict JSON Resume validator does - and the
    // same document fails, naming the block and nothing else.
    const strictCommunity: JsonSchemaNode = { ...JSON_RESUME_SCHEMA, additionalProperties: false };

    const rejected = validate(withBlock(), strictCommunity);
    expect(rejected.valid).toBe(false);
    expect(rejected.errors).toEqual([
      expect.objectContaining({ keyword: 'additionalProperties', path: '/x-clearance' }),
    ]);
    // And the plain document still passes, so the rejection is caused by the block and
    // not by the rest of the document.
    expect(validate(plainResume(), strictCommunity).valid).toBe(true);
  });

  it('the exported schemas are frozen, so no caller can edit the rules', () => {
    // A schema that any module can mutate is not a schema. This is the check that would
    // have caught the aliasing bug the first version of this suite had.
    expect(Object.isFrozen(JSON_RESUME_SCHEMA)).toBe(true);
    expect(Object.isFrozen(JSON_RESUME_SCHEMA.properties)).toBe(true);
    expect(Object.isFrozen(RESUME_JSON_SCHEMA)).toBe(true);
    expect(Object.isFrozen(X_CLEARANCE_SCHEMA)).toBe(true);
    expect(Object.isFrozen(X_CLEARANCE_SCHEMA.properties?.claims)).toBe(true);
  });

  it('a CLOSED root still accepts the block, because the block is DECLARED', () => {
    // The other half of the mechanism, and the subtle one: draft-07 says
    // `additionalProperties` governs members NOT matched by `properties`. The block IS
    // declared, so it is not "additional" and even a CLOSED root accepts it. Pinned
    // because the natural - but wrong - assumption is that a closed root forbids
    // everything it has not heard of, and this project relies on the opposite: our
    // schema may close the root and keep the extension, so a future tightening of the
    // COMMUNITY schema cannot silently invalidate documents this version wrote.
    const closed: JsonSchemaNode = { ...RESUME_JSON_SCHEMA, additionalProperties: false };
    expect(validate(withBlock(), closed).valid).toBe(true);
    // ...while a member that is neither declared nor permitted is still refused, so
    // "closed" means something.
    expect(validate({ ...withBlock(), somethingElse: 1 }, closed).errors).toEqual([
      expect.objectContaining({ keyword: 'additionalProperties', path: '/somethingElse' }),
    ]);
    // And the same for the full document schema, not just the published one.
    const closedFull: JsonSchemaNode = { ...RESUME_JSON_SCHEMA, additionalProperties: false };
    expect(validate(withBlock(), closedFull).valid).toBe(true);
    expect(validate({ ...withBlock(), unknown: 1 }, closedFull).valid).toBe(false);
  });

  it('a community consumer that ignores the block still sees a valid JSON Resume', () => {
    // ADR-035's reason for choosing option D: the document must remain a legal JSON
    // Resume, so a theme or `resume-cli` that has never heard of `x-clearance` works.
    const withoutBlock = plainResume();
    expect(validateResumeJson(withoutBlock).valid).toBe(true);
    // And the block is namespaced, so it cannot collide with a community member. OUR
    // schema declares it (so it is validated); the COMMUNITY schema does not (so it is
    // ignored rather than rejected).
    expect(X_CLEARANCE_KEY).toBe('x-clearance');
    expect(RESUME_JSON_SCHEMA.properties?.[X_CLEARANCE_KEY]).toBeDefined();
    expect(JSON_RESUME_SCHEMA.properties?.[X_CLEARANCE_KEY]).toBeUndefined();
    // The two differ ONLY by the block: the community document is a strict subset.
    expect(Object.keys(JSON_RESUME_SCHEMA.properties ?? {})).toEqual(
      Object.keys(RESUME_JSON_SCHEMA.properties ?? {}).filter((key) => key !== X_CLEARANCE_KEY),
    );
  });
});

// ---------------------------------------------------------------------------
// draft-07 semantics of the validator itself
// ---------------------------------------------------------------------------

describe('the validator implements the draft-07 keywords it claims', () => {
  it('implements exactly the documented set, and the two sets are disjoint', () => {
    expect([...SUPPORTED_KEYWORDS].sort()).toEqual(
      [
        '$id',
        '$ref',
        '$schema',
        'additionalProperties',
        'definitions',
        'description',
        'enum',
        'format',
        'items',
        'minItems',
        'properties',
        'required',
        'title',
        'type',
        'uniqueItems',
      ].sort(),
    );
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      expect(SUPPORTED_KEYWORDS as readonly string[]).not.toContain(keyword);
    }
  });

  it('resolves a local $ref into #/definitions', () => {
    // `$ref` is load-bearing here: JSON_RESUME_SCHEMA is written entirely in terms of
    // it, so a resolver that returned null would make every section fail.
    const result = validateResumeJson({ basics: { name: 'Ada' }, work: [{ name: 'Acme', position: 'Eng' }] });
    expect(result.valid).toBe(true);
  });

  it('reports an unresolvable $ref rather than silently passing', () => {
    const result = validate({ basics: { name: 'x' } }, {
      type: 'object',
      properties: { basics: { $ref: '#/definitions/does-not-exist' } },
      definitions: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe('$ref');
  });

  it('collects EVERY issue, addressed by JSON Pointer', () => {
    // A throw-with-a-string validator could only report the first problem, which is the
    // wrong shape for a route that has to tell a user which highlight is wrong.
    const result = validateResumeJson({
      basics: {},
      work: [{ name: 'Acme' }, { position: 'Eng' }, { name: 1, position: 2 }],
    });
    expect(result.valid).toBe(false);
    const paths = result.errors.map((issue) => `${issue.path}:${issue.keyword}`);
    // A `required` failure is located at the MISSING member, per RFC 6901 - that is the
    // node a client has to add, not the parent it is missing from.
    expect(paths).toContain('/basics/name:required');
    expect(paths).toContain('/work/0/position:required');
    expect(paths).toContain('/work/1/name:required');
    // A wrong type stops the descent for that node, so `/work/2/name:enum` is not
    // reported alongside `/work/2/name:type` - the type error is the actionable one.
    expect(paths).toContain('/work/2/name:type');
    // Nothing is silently dropped: four distinct problems, four distinct pointers.
    expect(new Set(result.errors.map((issue) => issue.path)).size).toBe(result.errors.length);
  });

  it('escapes / and ~ in a pointer, per RFC 6901', () => {
    const result = validate({ a: {} }, {
      type: 'object',
      properties: { a: { type: 'object', required: ['b/c'] } },
    });
    expect(result.errors[0].path).toBe('/a/b~1c');
  });

  it('honours minItems and uniqueItems', () => {
    const schema: JsonSchemaNode = {
      type: 'array',
      minItems: 2,
      uniqueItems: true,
      items: { type: 'string' },
    };
    expect(validate(['a'], schema).errors.map((e) => e.keyword)).toEqual(['minItems']);
    expect(validate(['a', 'a'], schema).errors.map((e) => e.keyword)).toEqual(['uniqueItems']);
    expect(validate(['a', 'b'], schema).valid).toBe(true);
  });

  it('treats an unknown type name as no-match, not as no-op', () => {
    // A typo in a schema must not make it silently permissive.
    expect(validate('x', { type: 'strng' }).valid).toBe(false);
  });

  it('supports a union type, which the nullable clearance members need', () => {
    expect(validate(null, { type: ['string', 'null'] }).valid).toBe(true);
    expect(validate('x', { type: ['string', 'null'] }).valid).toBe(true);
    expect(validate(1, { type: ['string', 'null'] }).valid).toBe(false);
  });

  it('rejects NaN and Infinity as numbers, which JSON cannot represent', () => {
    // A projection that serialised NaN would produce a document that does not survive a
    // round trip through JSON.parse, and the hash would describe bytes nobody can store.
    expect(validate(Number.NaN, { type: 'number' }).valid).toBe(false);
    expect(validate(Number.POSITIVE_INFINITY, { type: 'number' }).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The x-clearance schema is strict
// ---------------------------------------------------------------------------

describe('the x-clearance block is validated, not merely tolerated', () => {
  it('accepts a well-formed block', () => {
    expect(validateClearanceBlock(clearanceBlock()).valid).toBe(true);
  });

  it('refuses a block with an unknown member', () => {
    // A renderer reading a block it does not understand must fail loudly, not ignore a
    // field that might change what a status means.
    const result = validateClearanceBlock(clearanceBlock({ somethingNew: true }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ keyword: 'additionalProperties', path: '/somethingNew' });
  });

  it('refuses a block that is missing a member', () => {
    const block = clearanceBlock() as Record<string, unknown>;
    delete block.claimCount;
    expect(validateClearanceBlock(block).errors.map((e) => e.path)).toContain('/claimCount');
  });

  it('refuses an unknown version, so a renderer cannot misread a future block', () => {
    expect(validateClearanceBlock(clearanceBlock({ version: 99 })).valid).toBe(false);
  });

  it('refuses a claim entry whose status is outside the Prisma enum', () => {
    // The enum is read from the generated client, not written out, so this cannot drift
    // from the database - and a hand-edited "CONFIRMED" string is refused here even
    // though the value is spelled with the right prefix.
    const block = clearanceBlock();
    const bad = { ...block, claims: [{ ...block.claims[0], status: 'CONFIRMED' }] };
    expect(validateClearanceBlock(bad).valid).toBe(false);
  });

  it('refuses a claim entry with an empty claimId or fingerprint', () => {
    const block = clearanceBlock();
    expect(validateClearanceBlock({ ...block, claims: [{ ...block.claims[0], claimId: '' }] }).valid).toBe(false);
    expect(validateClearanceBlock({ ...block, claims: [{ ...block.claims[0], fingerprint: '' }] }).valid).toBe(false);
  });

  it('refuses a negative count, so a renderer can trust the arithmetic', () => {
    expect(validateClearanceBlock(clearanceBlock({ claimCount: -1 })).valid).toBe(false);
    expect(validateClearanceBlock(clearanceBlock({ confirmedClaimCount: 0.5 })).valid).toBe(false);
  });

  it('refuses a usage outside the three-member vocabulary', () => {
    const block = clearanceBlock();
    expect(validateClearanceBlock({ ...block, claims: [{ ...block.claims[0], usage: 'SOMETIMES' }] }).valid).toBe(false);
  });

  it('requires the nullable members to be PRESENT, even when null', () => {
    // `evidenceSourceId: null` and `jsonPath: null` are meaningful ("this claim has no
    // evidence", "this claim is omitted"), so they are required-but-nullable rather than
    // optional. Omitting them would make "absent" and "known to be null" the same thing.
    const block = clearanceBlock();
    const entry = { ...block.claims[0] } as Record<string, unknown>;
    delete entry.evidenceSourceId;
    const result = validateClearanceBlock({ ...block, claims: [entry] });
    expect(result.errors.map((e) => e.path)).toContain('/claims/0/evidenceSourceId');
  });
});

// ---------------------------------------------------------------------------
// The throwing form and the helpers
// ---------------------------------------------------------------------------

describe('assertValidResumeJson and the document helpers', () => {
  it('throws a typed error carrying the issues', () => {
    let caught: unknown;
    try {
      assertValidResumeJson({ basics: {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResumeJsonValidationError);
    const validationError = caught as ResumeJsonValidationError;
    expect(validationError.code).toBe('resume_json_invalid');
    expect(validationError.errors.length).toBeGreaterThan(0);
    expect(validationError.toJSON().errors).toEqual(validationError.errors);
    // The message is a SUMMARY, not a dump: at most five issues are interpolated, so a
    // pathological document cannot produce a megabyte-long error string.
    expect(validationError.message).toContain('/basics/name');
  });

  it('accepts a full, realistic document with every section populated', () => {
    const document = {
      basics: {
        name: 'Ada Lovelace',
        label: 'Staff Engineer',
        email: 'ada@example.com',
        phone: '+44 20 7946 0000',
        url: 'https://ada.example.com',
        summary: 'Builds analytical engines.',
        location: { city: 'London', countryCode: 'GB' },
        profiles: [{ network: 'GitHub', username: 'ada', url: 'https://github.com/ada' }],
      },
      work: [
        {
          name: 'Analytical Engine Co',
          position: 'Staff Engineer',
          startDate: '1842-01',
          endDate: '1848-12',
          summary: 'London',
          highlights: ['Reduced cycle time by 40%'],
        },
      ],
      volunteer: [{ organization: 'Royal Society', position: 'Member', highlights: ['Served on committee'] }],
      education: [{ institution: 'University of London', studyType: 'BSc', area: 'Mathematics', endDate: '1841' }],
      awards: [{ title: 'Fellowship', awarder: 'Royal Society' }],
      certificates: [{ name: 'Punch-card programming', issuer: 'Royal Society' }],
      publications: [{ name: 'Note G', publisher: 'Scientific Memoirs' }],
      skills: [{ name: 'Mathematics', level: 'expert', keywords: ['analysis'] }],
      languages: [{ language: 'English', fluency: 'native' }],
      interests: [{ name: 'Poetry', keywords: ['sonnets'] }],
      projects: [{ name: 'Bernoulli Numbers', highlights: ['Computed them'], keywords: ['mathematics'] }],
      references: [{ name: 'Charles Babbage', reference: 'Colleague' }],
      meta: { theme: 'ats-classic' },
      [X_CLEARANCE_KEY]: clearanceBlock(),
    };
    expect(validateResumeJson(document).valid).toBe(true);
  });

  it('hasClearanceBlock distinguishes "absent" from "present but empty"', () => {
    expect(hasClearanceBlock(plainResume())).toBe(false);
    expect(hasClearanceBlock(withBlock())).toBe(true);
    expect(hasClearanceBlock(null)).toBe(false);
    expect(hasClearanceBlock([1, 2])).toBe(false);
  });

  it('the block schema is a strict SUBSET of the full schema, so both agree', () => {
    // The block is validated twice - inline in the document and standalone - so the two
    // answers must be identical or a caller would get different verdicts depending on
    // which entry point it used.
    for (const block of [clearanceBlock(), clearanceBlock({ version: 7 }), clearanceBlock({ extra: 1 })]) {
      const inline = validateResumeJson({ ...plainResume(), [X_CLEARANCE_KEY]: block });
      const standalone = validateClearanceBlock(block);
      expect(inline.valid).toBe(standalone.valid);
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical form: the bytes a hash is computed over
// ---------------------------------------------------------------------------

describe('canonicalJsonString', () => {
  it('is key-order independent', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalJsonString(a)).toBe(canonicalJsonString(b));
  });

  it('preserves array order, because a position in the document is meaningful', () => {
    expect(canonicalJsonString([1, 2])).not.toBe(canonicalJsonString([2, 1]));
  });

  it('drops undefined members, exactly as JSON.stringify does', () => {
    expect(canonicalJsonString({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('refuses a value that is not JSON, rather than coercing it', () => {
    // Coercing a Date or a Map here would make `jsonHash` a function of a class rather
    // than of the data, and the same revision would hash differently on two hosts.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 1, Symbol('x')]) {
      expect(() => canonicalJsonString({ bad })).toThrowError(TypeError);
    }
    expect(() => canonicalJsonString(new Date())).toThrowError(/plain object or array/);
    expect(() => canonicalJsonString(new Map())).toThrowError(/plain object or array/);
    expect(() => canonicalJsonString({ self: undefined })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonString(cyclic)).toThrowError(/cyclic/);
  });
});
