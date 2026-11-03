// Manual / GitHub-Action driver for the full registry sweep cycle.
//
// Runs the SAME code the API and the scheduler run:
//   runSweepCycle(createSweepCycleDeps(), options)
// where `createSweepCycleDeps` (routes/jobs.ts) is the real Prisma cursor +
// registry predicate + adapter map + `upsertDiscoveredJobs` path. Nothing here
// fetches a board directly.
//
// Safe to re-run: the cursor lives in AppSetting (`deepSweep:cursor`), the
// catalogue upsert is idempotent, and the soft-close selects only rows that are
// still active and older than the cycle start. No secrets are printed.
//
// Usage (from backend/):
//   npx tsx scripts/sweep-all.ts [--batches N] [--boards N] [--max-rows N]
//                                [--minutes N] [--providers a,b] [--close]
//                                [--dry-run]
//
// Env fallbacks: SWEEP_CYCLE_BATCHES, SWEEP_CYCLE_BOARDS, SWEEP_CYCLE_MAX_ROWS,
// SWEEP_CYCLE_MINUTES, SWEEP_CYCLE_PROVIDERS, SWEEP_CYCLE_CLOSE ("1"/"true"),
// SWEEP_CYCLE_DRY_RUN. Flags win over env. DATABASE_URL must point at the
// target database.
//
// Exit code is 0 unless a fatal error occurs (bad flag, DB down, cycle throw).

import dotenv from 'dotenv';
import { resolve } from 'node:path';

// Load the repo-root .env WITHOUT overriding an explicit DATABASE_URL, and do
// it before the dynamic imports below (lib/prisma reads DATABASE_URL when the
// client is constructed).
dotenv.config({ path: resolve(process.cwd(), '../.env') });

interface CliOptions {
  batches: number;
  boards: number;
  maxRows: number;
  minutes: number;
  providers: string[];
  close: boolean;
  dryRun: boolean;
}

const DEFAULTS: CliOptions = {
  batches: 1,
  boards: 500,
  maxRows: 5000,
  minutes: 0,
  providers: [],
  close: false,
  dryRun: false,
};

function flagValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith('--') ? next : 'true';
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function boolFlag(argv: string[], name: string, env: string | undefined): boolean {
  if (argv.includes(name)) return true;
  const raw = flagValue(argv, name);
  if (raw !== undefined) return raw !== 'false' && raw !== '0';
  return env === '1' || env === 'true';
}

function intFlag(
  argv: string[],
  name: string,
  env: string | undefined,
  fallback: number,
  min: number,
): number {
  const raw = flagValue(argv, name) ?? env;
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min} (got ${raw})`);
  }
  return Math.floor(value);
}

function parseArgs(argv: string[]): CliOptions {
  return {
    batches: intFlag(argv, '--batches', process.env.SWEEP_CYCLE_BATCHES, DEFAULTS.batches, 1),
    boards: intFlag(argv, '--boards', process.env.SWEEP_CYCLE_BOARDS, DEFAULTS.boards, 1),
    maxRows: intFlag(argv, '--max-rows', process.env.SWEEP_CYCLE_MAX_ROWS, DEFAULTS.maxRows, 1),
    minutes: intFlag(argv, '--minutes', process.env.SWEEP_CYCLE_MINUTES, DEFAULTS.minutes, 0),
    providers: providersFlag(argv, '--providers', process.env.SWEEP_CYCLE_PROVIDERS),
    close: boolFlag(argv, '--close', process.env.SWEEP_CYCLE_CLOSE),
    dryRun: boolFlag(argv, '--dry-run', process.env.SWEEP_CYCLE_DRY_RUN),
  };
}

/**
 * `--providers a,b` (or SWEEP_CYCLE_PROVIDERS) restricts the cycle to the
 * given registry providers. Empty means "all providers" - the scheduler's
 * behaviour. A filtered cycle uses its own cursor keys (createSweepCycleDeps),
 * so a shard run cannot move the global cursor.
 */
function providersFlag(argv: string[], name: string, env: string | undefined): string[] {
  const raw = flagValue(argv, name) ?? env;
  if (raw === undefined) return [];
  if (raw === '' || raw === 'true') {
    throw new Error(`${name} needs a comma-separated list of provider ids`);
  }
  return [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const { default: prisma } = await import('../src/lib/prisma.js');
  const { createSweepCycleDeps, SUPPORTED_SWEEP_PROVIDERS } = await import('../src/routes/jobs.js');
  const { runSweepCycle } = await import('../src/discovery/sweepCycle.js');

  const supported = new Set(SUPPORTED_SWEEP_PROVIDERS);
  const unknownProviders = options.providers.filter((provider) => !supported.has(provider));
  if (unknownProviders.length > 0) {
    throw new Error(
      `unknown provider(s): ${unknownProviders.join(', ')}; ` +
        `supported: ${SUPPORTED_SWEEP_PROVIDERS.join(', ')}`,
    );
  }

  const counts = async () => ({
    total: await prisma.jobListing.count(),
    active: await prisma.jobListing.count({ where: { isActive: true } }),
  });

  try {
    console.log(
      `[sweep-all] start batches=${options.batches} boards=${options.boards} ` +
        `maxRows=${options.maxRows} minutes=${options.minutes} ` +
        `providers=${options.providers.length > 0 ? options.providers.join(',') : 'all'} ` +
        `close=${options.close} dryRun=${options.dryRun}`,
    );
    const before = await counts();
    console.log(`[sweep-all] catalogue before: total=${before.total} active=${before.active}`);

    const result = await runSweepCycle(createSweepCycleDeps(options.providers), {
      batchSize: options.boards,
      maxRowsPerBatch: options.maxRows,
      concurrency: 8,
      perBoardTimeoutMs: 20_000,
      maxBatches: options.batches,
      maxMinutes: options.minutes,
      closeAfterCycle: options.close,
      dryRun: options.dryRun,
    });

    const after = await counts();
    console.log(`[sweep-all] catalogue after: total=${after.total} active=${after.active}`);
    console.log(
      `[sweep-all] done batches=${result.batches} boards=${result.boards} ok=${result.ok} ` +
        `failed=${result.failed} fetched=${result.rowsFetched} persisted=${result.rowsPersisted} ` +
        `deactivated=${result.deactivated} backedOff=${result.backedOff} closed=${result.closed} ` +
        `completed=${result.completed} elapsed=${(result.elapsedMs / 1000).toFixed(1)}s ` +
        `activeDelta=${after.active - before.active}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sweep-all] failed: ${message}`);
  process.exitCode = 1;
});
