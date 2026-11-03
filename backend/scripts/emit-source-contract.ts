// Contract emitter (T624; ADR-031 decision 1; wave-1 spec SCOPE item 6).
// Emits the cross-boundary discovery contract to shared/job-sources.json.
//
// Source of truth is the provider registry (ADR-025):
// - source ids: allSourceIds() (backend/src/jobSources/providerRegistry.ts)
// - board types + per-provider descriptor data: PROVIDERS (same module)
// Wave 0 (T603) read the hand-maintained JOB_SOURCE_VALUES + a BOARD_TYPE_VALUES
// mirror; wave 1 repoints both at the registry. The `sources`/`boardTypes`
// values are unchanged by the repoint (verified: allSourceIds() order equals
// the wave-0 artifact order, PROVIDERS declaration order equals the wave-0
// board-type order); the shape grows additively with `providers`.
//
// Determinism: stable key order (sources, boardTypes, providers; per-provider
// id, type, sourceIds, kind, tier, auth, requires, enabledByDefault, explain),
// registry declaration order preserved, no timestamps, no absolute paths, no
// machine-specific data. Two runs with no registry change produce a
// byte-identical file.
//
// Run: cd backend && npx tsx scripts/emit-source-contract.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { allSourceIds, PROVIDERS } from '../src/jobSources/providerRegistry.js';

export interface SourceContractProvider {
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

export interface SourceContract {
  sources: string[];
  boardTypes: string[];
  providers: SourceContractProvider[];
}

// Registry is the single source of truth: board types are PROVIDERS
// declaration order, source ids come from allSourceIds(), and each provider
// entry carries the descriptor data waves 4/7/10 need (id, kind, tier, auth,
// requires, enabledByDefault, explain). Nothing here is hand-maintained:
// to change the contract, change the registry and re-run this emitter.
export function buildSourceContract(): SourceContract {
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

export function contractArtifactPath(): string {
  // __dirname is available both under tsx (which shims it) and compiled CJS.
  return path.resolve(__dirname, '../../shared/job-sources.json');
}

function main(): void {
  const contract = buildSourceContract();
  const body = `${JSON.stringify(contract, null, 2)}\n`;
  const outPath = contractArtifactPath();
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, body, 'utf8');
  console.log(
    `wrote shared/job-sources.json (${contract.sources.length} sources, ${contract.boardTypes.length} board types, ${contract.providers.length} providers)`,
  );
}

main();
