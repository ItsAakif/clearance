// Parity gate for the generated cross-boundary contract (T603; ADR-031
// decision 1; repointed at the registry by T624, wave-1 spec SCOPE item 6).
// Deep-equals shared/job-sources.json against the registry-derived object so
// a descriptor added (or edited) without an emitter run fails the suite.
//
// The expectation is derived from the registry itself (allSourceIds() +
// PROVIDERS with the emitter's field mapping), never from the artifact, and
// never hand-edited: to change the contract, change the registry and re-run
// `cd backend && npx tsx scripts/emit-source-contract.ts`.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { allSourceIds, PROVIDERS } from './providerRegistry.js';

// Local view of the emitted shape (mirrors SourceContract in
// backend/scripts/emit-source-contract.ts). Kept as a structural interface
// here - not imported from the script - so `npm run build` (rootDir ./src)
// never pulls scripts/ into the program, and so mapping drift between this
// file and the emitter fails the deep-equal below instead of compiling away.

interface SourceContractProvider {
  id: string;
  type: string;
  sourceIds: string[];
  kind: 'api' | 'feed' | 'json' | 'search' | 'scraper' | 'aggregator' | 'browser';
  tier: 1 | 2 | 3 | 4 | 5;
  auth: 'keyless' | { byok: string };
  requires: string[];
  enabledByDefault: boolean;
  explain: string;
}

interface SourceContract {
  sources: string[];
  boardTypes: string[];
  providers: SourceContractProvider[];
}
function registryContract(): SourceContract {
  return {
    sources: [...allSourceIds()],
    boardTypes: PROVIDERS.map((p) => p.type),
    providers: PROVIDERS.map((p) => ({
      id: p.type,
      type: p.type,
      sourceIds: [...p.sourceIds],
      kind: p.kind,
      tier: p.tier,
      auth: typeof p.auth === 'string' ? p.auth : { byok: p.auth.byok },
      requires: [...p.requires],
      enabledByDefault: p.enabledByDefault ?? false,
      explain: p.explain,
    })),
  };
}

function readArtifact(): SourceContract {
  // __dirname is available both when compiled to CJS and under tsx/vitest.
  const artifactPath = path.join(__dirname, '../../../shared/job-sources.json');
  return JSON.parse(readFileSync(artifactPath, 'utf8')) as SourceContract;
}

describe('source contract parity (generated artifact vs provider registry)', () => {
  it('deep-equals the artifact against the registry-derived object', () => {
    expect(readArtifact()).toEqual(registryContract());
  });

  it('fails if a descriptor is added without regenerating (provider counts match)', () => {
    const artifact = readArtifact();
    expect(artifact.providers).toHaveLength(PROVIDERS.length);
    expect(artifact.sources).toHaveLength(allSourceIds().length);
    expect(artifact.boardTypes).toHaveLength(PROVIDERS.length);
  });

  it('fails if an id in the artifact is not produced by any descriptor', () => {
    const artifact = readArtifact();
    const knownTypes = new Set(PROVIDERS.map((p) => p.type));
    for (const entry of artifact.providers) {
      expect(knownTypes.has(entry.id), `provider id "${entry.id}"`).toBe(true);
      expect(knownTypes.has(entry.type), `provider type "${entry.type}"`).toBe(true);
    }
    for (const boardType of artifact.boardTypes) {
      expect(knownTypes.has(boardType), `board type "${boardType}"`).toBe(true);
    }
  });

  it('keeps the wave-0 shape additively: sources and boardTypes intact, providers present', () => {
    const artifact = readArtifact();
    expect(Array.isArray(artifact.sources)).toBe(true);
    expect(Array.isArray(artifact.boardTypes)).toBe(true);
    expect(Array.isArray(artifact.providers)).toBe(true);
    expect(artifact.sources).toHaveLength(27);
    expect(artifact.boardTypes).toHaveLength(24);
  });

  it('has no duplicate ids in any list', () => {
    const artifact = readArtifact();
    expect(new Set(artifact.sources).size).toBe(artifact.sources.length);
    expect(new Set(artifact.boardTypes).size).toBe(artifact.boardTypes.length);
    expect(new Set(artifact.providers.map((p) => p.id)).size).toBe(artifact.providers.length);
  });
});
