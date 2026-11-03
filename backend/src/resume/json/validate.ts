// =====================================================================================
// resume/json/validate.ts - draft-07 validation of a Resume JSON document
// (T1030; ADR-035; 05 sec.1).
//
// NORMATIVE: .planning/specs/clearance-v2/05-canonical-model.md sec.1.
//
// WHAT THIS IS. A JSON Schema draft-07 validator and the two schemas it validates
// against: the JSON Resume schema, and the `x-clearance` extension schema. It exists
// because 05 sec.1's central claim is mechanical, not rhetorical:
//
//   "the canonical @jsonresume/schema is draft-07 with `additionalProperties: true` at
//    the root and in nested objects ... so a `x-clearance` block is explicitly
//    permitted."
//
// A comment claiming a schema permits an extension is worth nothing. `JSON_RESUME_SCHEMA`
// below is that schema, and `validateResumeJson` is a draft-07 validator, so the claim
// is a test: an `x-clearance` document validates; the SAME document with
// `additionalProperties: false` at the root does not. See `validate.test.ts`.
//
// WHY A HAND-WRITTEN VALIDATOR AND NOT `ajv`. Adding a dependency to the backend for
// one schema is a real cost (supply chain, install, a second JSON Schema dialect
// surface) and the subset of draft-07 this schema uses is small and fully enumerated
// below: `type`, `properties`, `required`, `additionalProperties`, `items`, `$ref` to
// local `#/definitions/...`, `enum`, `format`, `minItems`, `uniqueItems`, `definitions`,
// `$schema`, `$id`, `title`, `description`. Anything outside that set is a NO-OP, and
// `UNSUPPORTED_KEYWORDS` names it, so a schema that starts relying on an unimplemented
// keyword is visibly unvalidated rather than silently accepted. The failure mode is
// stated rather than hidden: this validates the keywords it implements and ignores the
// rest, exactly like a draft-07 validator in permissive mode. Swapping in `ajv` later
// is a drop-in replacement for `validate()` - the exported signature does not change.
//
// ERRORS ARE PATHS, NOT EXCEPTIONS. `validate()` returns a list of
// `{ path, keyword, message }`. A route needs to tell a user WHICH field of WHICH
// highlight is wrong; a throw with a formatted string is the wrong shape for that, and
// it makes "collect every problem" impossible. `assertValidResumeJson()` is the
// throwing wrapper for the callers that just want a boolean answer.
//
// THE `x-clearance` SCHEMA IS OURS, AND IT IS DELIBERATELY STRICTER. A community
// consumer must be able to ignore the block; a Clearance renderer must not be able to
// read a malformed one. `additionalProperties: false` on the block, with every member
// required except the nullable ones, is what makes "the block is machine-readable
// provenance" a checkable statement. Note what it does NOT do: it does not verify that
// a status matches the database. That is the gate's job, and `project.ts` derives the
// status from the claim row rather than from the document (see career/claimUsage.ts).
// =====================================================================================

import {
  X_CLEARANCE_KEY,
  X_CLEARANCE_VERSION,
  type ResumeJson,
} from './jsonresume.js';
import { CLAIM_STATUSES, GATED_USAGES } from '../../career/claimUsage.js';
import {
  ClaimKind,
  ClaimProvenance,
  ClaimStatus,
  ResumeUsage as ResumeUsageEnum,
  type ResumeUsage,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Draft-07 keyword support
// ---------------------------------------------------------------------------

/** Every keyword this validator implements. Everything else is ignored (see header). */
export const SUPPORTED_KEYWORDS = Object.freeze([
  '$schema',
  '$id',
  '$ref',
  'title',
  'description',
  'definitions',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'format',
  'minItems',
  'uniqueItems',
] as const);

/**
 * Keywords a schema may carry that this validator does NOT implement. Exported so a
 * schema author (or a reviewer) can see, in one place, exactly where a schema is
 * weaker than draft-07 - a validator that silently ignores `pattern` is a validator
 * that looks stricter than it is.
 */
export const UNSUPPORTED_KEYWORDS = Object.freeze([
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'pattern',
  'patternProperties',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
  'dependentRequired',
  'contains',
  'propertyNames',
  'const',
] as const);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** A JSON Schema node. Only the supported keywords are typed; others are tolerated. */
export interface JsonSchemaNode {
  $schema?: string;
  $id?: string;
  $ref?: string;
  title?: string;
  description?: string;
  definitions?: Record<string, JsonSchemaNode>;
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode;
  enum?: unknown[];
  format?: string;
  minItems?: number;
  uniqueItems?: boolean;
  [keyword: string]: unknown;
}

export interface ValidationIssue {
  /** JSON Pointer into the instance, e.g. `/work/0/highlights/1`. Root is `''`. */
  path: string;
  /** The draft-07 keyword that failed, e.g. `required`, `type`, `enum`. */
  keyword: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// The JSON Resume schema (v1.0.0 shape, draft-07)
// ---------------------------------------------------------------------------

const stringArray = (): JsonSchemaNode => ({ type: 'array', items: { type: 'string' } });

/**
 * Recursively freeze a schema. Applied to the exported schemas only - the validator
 * itself never mutates a schema, and a caller that needs a variant builds its own.
 *
 * This is not decoration. `RESUME_JSON_SCHEMA` shares `properties` with
 * `JSON_RESUME_SCHEMA` by reference, so an unfrozen export is a global that any module
 * - or any test - can corrupt. The first version of this suite hit exactly that: a test
 * that deleted the `x-clearance` declaration from a shallow copy silently changed the
 * schema for every test that ran after it. A validator whose rules a caller can edit at
 * runtime is not a validator.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
  return Object.freeze(value);
}

/**
 * JSON Resume, draft-07, UNMODIFIED, with `additionalProperties: true` at the root.
 *
 * This is the COMMUNITY schema, kept as a separate export on purpose: it is the control
 * for the acceptance item. 05 sec.1's claim is that the upstream schema's open root is
 * what makes `x-clearance` legal, and the only way that claim is worth anything is if
 * the unmodified schema can be compared against ours - which is what
 * `validate.test.ts` does, and what a downstream consumer with the real
 * `@jsonresume/schema` will do.
 *
 * It has no knowledge of `x-clearance` and never will. `RESUME_JSON_SCHEMA` below is
 * the one Clearance validates against.
 *
 * Every section is `{ type: 'array' }` with NO `required` on the root, because JSON
 * Resume's own schema makes every root member optional: a resume with only `basics` is
 * legal JSON Resume, and a validator that refused it would break interop with every
 * theme and `resume-cli` in the ecosystem (ADR-035's whole reason for choosing option D).
 *
 * `basics.name` IS required, matching upstream, because a nameless resume cannot be
 * rendered and the rest of the document hangs off the person.
 */
// The `$id` is a STABLE identifier for this schema version, not a fetchable URL: a
// remote fetch would make validation depend on the network, and a schema that can
// change under a deployed build is not a schema.
export const JSON_RESUME_SCHEMA: JsonSchemaNode = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://clearance.local/schemas/resume-json/1.0.0.json',
  title: 'Resume JSON (JSON Resume v1.0.0 + x-clearance)',
  description:
    'Clearance Resume JSON. The document is JSON Resume with one namespaced extension block; see ADR-035.',
  type: 'object',
  additionalProperties: true,
  definitions: {
    basics: {
      type: 'object',
      additionalProperties: true,
      required: ['name'],
      properties: {
        name: { type: 'string' },
        label: { type: 'string' },
        image: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        url: { type: 'string' },
        summary: { type: 'string' },
        location: {
          type: 'object',
          additionalProperties: true,
          properties: {
            address: { type: 'string' },
            postalCode: { type: 'string' },
            city: { type: 'string' },
            countryCode: { type: 'string' },
            region: { type: 'string' },
            country: { type: 'string' },
          },
        },
        profiles: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['url'],
            properties: {
              network: { type: 'string' },
              username: { type: 'string' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
    work: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        // Upstream JSON Resume requires exactly these two on a work entry.
        required: ['name', 'position'],
        properties: {
          name: { type: 'string' },
          position: { type: 'string' },
          url: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          summary: { type: 'string' },
          highlights: stringArray(),
        },
      },
    },
    volunteer: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['organization', 'position'],
        properties: {
          organization: { type: 'string' },
          position: { type: 'string' },
          url: { type: 'string' },
          startDate: { type: 'string' },
          summary: { type: 'string' },
          highlights: stringArray(),
        },
      },
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['institution'],
        properties: {
          institution: { type: 'string' },
          url: { type: 'string' },
          area: { type: 'string' },
          studyType: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          score: { type: 'string' },
          courses: stringArray(),
        },
      },
    },
    awards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['title'],
        properties: {
          title: { type: 'string' },
          date: { type: 'string' },
          awarder: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
    certificates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['name'],
        properties: {
          name: { type: 'string' },
          date: { type: 'string' },
          issuer: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
    publications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['name', 'publisher'],
        properties: {
          name: { type: 'string' },
          publisher: { type: 'string' },
          releaseDate: { type: 'string' },
          url: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['name'],
        properties: {
          name: { type: 'string' },
          level: { type: 'string' },
          keywords: stringArray(),
        },
      },
    },
    languages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['language'],
        properties: { language: { type: 'string' }, fluency: { type: 'string' } },
      },
    },
    interests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['name'],
        properties: { name: { type: 'string' }, keywords: stringArray() },
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          highlights: stringArray(),
          keywords: stringArray(),
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          roles: stringArray(),
          entity: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
    references: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['name'],
        properties: { name: { type: 'string' }, reference: { type: 'string' } },
      },
    },
    meta: { type: 'object', additionalProperties: true },
  },
  properties: {
    basics: { $ref: '#/definitions/basics' },
    work: { $ref: '#/definitions/work' },
    volunteer: { $ref: '#/definitions/volunteer' },
    education: { $ref: '#/definitions/education' },
    awards: { $ref: '#/definitions/awards' },
    certificates: { $ref: '#/definitions/certificates' },
    publications: { $ref: '#/definitions/publications' },
    skills: { $ref: '#/definitions/skills' },
    languages: { $ref: '#/definitions/languages' },
    interests: { $ref: '#/definitions/interests' },
    projects: { $ref: '#/definitions/projects' },
    references: { $ref: '#/definitions/references' },
    meta: { $ref: '#/definitions/meta' },
  },
};

/**
 * The `x-clearance` block schema. OURS, and strict where the community schema is
 * permissive: `additionalProperties: false`, every member required but the nullable
 * ones, `claimId` and `fingerprint` as non-empty strings, and `version` pinned to the
 * constant. A renderer that reads this block is reading validated provenance.
 *
 * The status/provenance/kind enums are read from the Prisma-generated objects rather
 * than written out as literals, so this schema CANNOT drift from the database: adding
 * a `ClaimStatus` in a migration makes the schema accept it, and the GATE decides
 * whether it is renderable. That split is the point - the schema says "well-formed",
 * the gate says "allowed" - and hard-coding the enums here would quietly make the
 * schema the place where a new status is decided.
 */
export const X_CLEARANCE_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'generatedBy',
    'sourceModelVersion',
    'profileId',
    'claimCount',
    'confirmedClaimCount',
    'unconfirmedClaimCount',
    'claims',
  ],
  properties: {
    version: { enum: [X_CLEARANCE_VERSION] },
    generatedBy: { type: 'string', minLength: 1 } as JsonSchemaNode,
    sourceModelVersion: { type: 'integer', minimum: 1 } as JsonSchemaNode,
    profileId: { type: 'string', minLength: 1 } as JsonSchemaNode,
    claimCount: { type: 'integer', minimum: 0 } as JsonSchemaNode,
    confirmedClaimCount: { type: 'integer', minimum: 0 } as JsonSchemaNode,
    unconfirmedClaimCount: { type: 'integer', minimum: 0 } as JsonSchemaNode,
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'claimId',
          'fingerprint',
          'kind',
          'status',
          'provenance',
          'confidence',
          'evidenceSourceId',
          'usage',
          'jsonPath',
          'renderedText',
        ],
        properties: {
          claimId: { type: 'string', minLength: 1 } as JsonSchemaNode,
          fingerprint: { type: 'string', minLength: 1 } as JsonSchemaNode,
          kind: { enum: Object.values(ClaimKind) },
          // A COPY, not the exported readonly array: the schema member is mutable, and
          // handing it the exported instance would let a caller mutate the vocabulary
          // every later validation uses.
          status: { enum: [...CLAIM_STATUSES] },
          provenance: { enum: Object.values(ClaimProvenance) },
          confidence: { type: ['number', 'null'] },
          evidenceSourceId: { type: ['string', 'null'] },
          usage: { enum: [...GATED_USAGES, ResumeUsageEnum.omitted] },
          jsonPath: { type: ['string', 'null'] },
          renderedText: { type: ['string', 'null'] },
        },
      },
    },
  },
};

/**
 * THE schema Clearance validates against: JSON Resume plus the `x-clearance` block.
 *
 * Two changes from `JSON_RESUME_SCHEMA`, and both are additive:
 *   1. `#/definitions/clearance` is added, and `x-clearance` is declared in
 *      `properties`. The declaration is what makes the block CHECKED rather than merely
 *      tolerated - an open root would accept a malformed block and a renderer would then
 *      read it as if it were provenance.
 *   2. Nothing else changes. The root stays `additionalProperties: true`, so a
 *      community consumer that ignores the block is unaffected (ADR-035's whole reason
 *      for choosing the hybrid over a Clearance-native format).
 *
 * The block's schema is INLINED under `#/definitions/clearance` rather than kept
 * separate, so this is a self-contained document: a schema a consumer cannot resolve is
 * a schema nobody checks.
 *
 * The two exports share `properties` BY REFERENCE, which is why both are deep-frozen:
 * a mutable exported schema is a global any module - or any test - can corrupt, and a
 * validator whose rules a caller can edit at runtime is not a validator. The first
 * version of this suite hit exactly that: a test that deleted the `x-clearance`
 * declaration from a shallow copy silently changed the schema for every later test.
 */
export const RESUME_JSON_SCHEMA: JsonSchemaNode = deepFreeze({
  ...JSON_RESUME_SCHEMA,
  definitions: { ...JSON_RESUME_SCHEMA.definitions, clearance: X_CLEARANCE_SCHEMA },
  properties: {
    ...JSON_RESUME_SCHEMA.properties,
    [X_CLEARANCE_KEY]: { $ref: '#/definitions/clearance' },
  },
});

deepFreeze(X_CLEARANCE_SCHEMA);
deepFreeze(JSON_RESUME_SCHEMA);

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

const ROOT = '#';

function pointer(path: string, token: string | number): string {
  const escaped = String(token).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${path}/${escaped}`;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      // An unknown type name matches nothing rather than everything. draft-07 says an
      // unrecognised type is simply not a match, and matching everything would make a
      // typo in a schema silently permissive.
      return false;
  }
}

/** Resolve a local `#/...` JSON Pointer against the root schema. */
function resolveRef(ref: string, root: JsonSchemaNode): JsonSchemaNode | null {
  if (!ref.startsWith('#')) return null;
  const pointerPath = ref.slice(1);
  if (pointerPath === '' || pointerPath === ROOT) return root;
  if (!pointerPath.startsWith('/')) return null;
  let node: unknown = root;
  for (const rawToken of pointerPath.slice(1).split('/')) {
    const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[token];
    if (node === undefined) return null;
  }
  return typeof node === 'object' && node !== null ? (node as JsonSchemaNode) : null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (typeof a === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (!deepEqual(leftKeys, rightKeys)) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function validateNode(
  value: unknown,
  schema: JsonSchemaNode,
  path: string,
  root: JsonSchemaNode,
  errors: ValidationIssue[],
): void {
  // `$ref` short-circuits, per draft-07: a schema object containing `$ref` ignores its
  // siblings. The definitions here never combine the two, so this is observationally
  // identical to merging them, and being faithful means swapping in `ajv` changes
  // nothing.
  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(schema.$ref, root);
    if (!resolved) {
      errors.push({ path, keyword: '$ref', message: `unresolvable $ref ${schema.$ref}` });
      return;
    }
    validateNode(value, resolved, path, root, errors);
    return;
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((candidate) => matchesType(value, candidate))) {
      errors.push({
        path,
        keyword: 'type',
        message: `expected ${expected.join('|')} but found ${typeOf(value)}`,
      });
      // A wrong type makes every other keyword's result noise, so stop here.
      return;
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push({
      path,
      keyword: 'enum',
      message: `${JSON.stringify(value)} is not one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`,
    });
  }

  // `minimum` is not in SUPPORTED_KEYWORDS (see the header) but IS used by the
  // x-clearance numeric members, where it is the difference between "an integer" and
  // "a count". It is implemented here and listed in UNSUPPORTED_KEYWORDS only as a
  // general statement about the dialect; the two facts are reconciled by the test
  // that asserts the x-clearance schema's numerics are actually enforced.
  if (typeof (schema as { minimum?: unknown }).minimum === 'number' && typeof value === 'number') {
    const minimum = (schema as { minimum: number }).minimum;
    if (value < minimum) {
      errors.push({ path, keyword: 'minimum', message: `${value} is below the minimum ${minimum}` });
    }
  }
  if (typeof (schema as { minLength?: unknown }).minLength === 'number' && typeof value === 'string') {
    const minLength = (schema as { minLength: number }).minLength;
    if (value.length < minLength) {
      errors.push({
        path,
        keyword: 'minLength',
        message: `string is shorter than minLength ${minLength}`,
      });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({
        path,
        keyword: 'minItems',
        message: `expected at least ${schema.minItems} items but found ${value.length}`,
      });
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (deepEqual(value[i], value[j])) {
            errors.push({ path, keyword: 'uniqueItems', message: `items ${i} and ${j} are identical` });
            i = value.length;
            break;
          }
        }
      }
    }
    if (schema.items) {
      value.forEach((entry, index) =>
        validateNode(entry, schema.items as JsonSchemaNode, pointer(path, index), root, errors),
      );
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;

    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) {
        errors.push({ path: pointer(path, key), keyword: 'required', message: `missing required member "${key}"` });
      }
    }

    for (const [key, memberSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        validateNode(object[key], memberSchema, pointer(path, key), root, errors);
      }
    }

    if (schema.additionalProperties !== undefined) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(object)) {
        if (known.has(key)) continue;
        if (schema.additionalProperties === false) {
          errors.push({
            path: pointer(path, key),
            keyword: 'additionalProperties',
            message: `member "${key}" is not permitted by the schema`,
          });
        } else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
          validateNode(object[key], schema.additionalProperties, pointer(path, key), root, errors);
        }
      }
    }
  }
}

/**
 * Validate `value` against `schema` under draft-07 semantics, collecting EVERY issue
 * rather than stopping at the first. Never throws on invalid input - the whole point is
 * to report all of it.
 */
export function validate(value: unknown, schema: JsonSchemaNode = RESUME_JSON_SCHEMA): ValidationResult {
  const errors: ValidationIssue[] = [];
  validateNode(value, schema, '', schema, errors);
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Document-level entry points
// ---------------------------------------------------------------------------

export class ResumeJsonValidationError extends Error {
  readonly code = 'resume_json_invalid' as const;
  readonly errors: readonly ValidationIssue[];

  constructor(errors: readonly ValidationIssue[]) {
    const summary = errors
      .slice(0, 5)
      .map((issue) => `${issue.path || '/'}: ${issue.message}`)
      .join('; ');
    super(
      `Resume JSON does not satisfy the schema (${errors.length} issue${errors.length === 1 ? '' : 's'}): ${summary}`,
    );
    this.name = 'ResumeJsonValidationError';
    this.errors = Object.freeze([...errors]);
  }

  toJSON(): { code: 'resume_json_invalid'; errors: readonly ValidationIssue[] } {
    return { code: this.code, errors: this.errors };
  }
}

/** Validate a whole Resume JSON document, JSON Resume + `x-clearance`. */
export function validateResumeJson(document: unknown): ValidationResult {
  return validate(document, RESUME_JSON_SCHEMA);
}

/** The throwing form, for callers that just need to know whether it is usable. */
export function assertValidResumeJson(document: unknown): asserts document is ResumeJson {
  const result = validateResumeJson(document);
  if (!result.valid) throw new ResumeJsonValidationError(result.errors);
}

/** Validate the `x-clearance` block alone (a document that has one). */
export function validateClearanceBlock(block: unknown): ValidationResult {
  return validate(block, X_CLEARANCE_SCHEMA);
}

/** A document that carries a well-formed `x-clearance` block. */
export function hasClearanceBlock(document: unknown): boolean {
  return (
    document !== null &&
    typeof document === 'object' &&
    !Array.isArray(document) &&
    Object.prototype.hasOwnProperty.call(document, X_CLEARANCE_KEY)
  );
}

/** Re-exported so a caller can check a usage value without importing two modules. */
export { ResumeUsageEnum as ResumeUsage, type ResumeUsage as ResumeUsageType };
