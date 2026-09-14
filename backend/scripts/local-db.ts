// Local embedded PostgreSQL for development (no Docker required).
// Run: cd backend && npm run db:local
// Keeps running in the foreground; use Ctrl+C to stop. Data persists in backend/.data/pg.
// Port 5433 is deliberate: 5432 is the conventional Postgres default and may
// collide with a system-wide Postgres install.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_DB_PORT = 5433;
export const LOCAL_DB_USER = 'postgres';
export const LOCAL_DB_PASSWORD = 'postgres';
export const LOCAL_DB_NAME = 'clearance';
export const LOCAL_DATABASE_DIR = path.join(__dirname, '..', '.data', 'pg');

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

function isDataDirInitialised(dir: string): boolean {
  // initdb writes PG_VERSION + postgresql.conf into the data dir.
  return fs.existsSync(path.join(dir, 'PG_VERSION'));
}

async function ensureDatabaseExists(pg: EmbeddedPostgres, name: string): Promise<void> {
  try {
    await pg.createDatabase(name);
    console.log(`[local-db] Created database "${name}".`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already exists')) {
      console.log(`[local-db] Database "${name}" already exists.`);
      return;
    }
    throw err;
  }
}

async function main() {
  // Idempotency: a second `npm run db:local` while Postgres is already up
  // must not re-init or corrupt data — just report and exit cleanly.
  if (await isPortOpen(LOCAL_DB_PORT)) {
    console.log(
      `[local-db] Postgres already accepting connections on port ${LOCAL_DB_PORT} — nothing to do.`,
    );
    console.log(
      `[local-db] Connect with: postgresql://${LOCAL_DB_USER}:${LOCAL_DB_PASSWORD}@localhost:${LOCAL_DB_PORT}/${LOCAL_DB_NAME}?schema=public`,
    );
    return;
  }

  fs.mkdirSync(LOCAL_DATABASE_DIR, { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: LOCAL_DATABASE_DIR,
    user: LOCAL_DB_USER,
    password: LOCAL_DB_PASSWORD,
    port: LOCAL_DB_PORT,
    persistent: true,
  });

  const shutdown = async () => {
    console.log('\n[local-db] Shutting down local Postgres...');
    try {
      await pg.stop();
    } catch {
      // Best-effort shutdown; process is exiting anyway.
    }
  };
  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));

  if (isDataDirInitialised(LOCAL_DATABASE_DIR)) {
    console.log('[local-db] Reusing existing data dir backend/.data/pg.');
  } else {
    console.log('[local-db] First run — initialising new cluster in backend/.data/pg...');
    try {
      await pg.initialise();
    } catch (err) {
      console.error('[local-db] FAILED to initialise embedded Postgres.');
      console.error(err);
      process.exit(1);
    }
  }

  try {
    await pg.start();
  } catch (err) {
    console.error(`[local-db] FAILED to start Postgres on port ${LOCAL_DB_PORT}.`);
    console.error('[local-db] Is another Postgres already using that port? Stop it or free the port, then retry.');
    console.error(err);
    process.exit(1);
  }

  console.log(`[local-db] Postgres ready on port ${LOCAL_DB_PORT}.`);

  try {
    await ensureDatabaseExists(pg, LOCAL_DB_NAME);
  } catch (err) {
    console.error(`[local-db] FAILED to ensure database "${LOCAL_DB_NAME}" exists.`);
    console.error(err);
    await pg.stop().catch(() => undefined);
    process.exit(1);
  }

  console.log(`[local-db] Connect with: postgresql://${LOCAL_DB_USER}:${LOCAL_DB_PASSWORD}@localhost:${LOCAL_DB_PORT}/${LOCAL_DB_NAME}?schema=public`);
  console.log('[local-db] Running in foreground — press Ctrl+C to stop (data is persistent).');

  // Hold the process so the cluster keeps running until Ctrl+C.
  await new Promise(() => undefined);
}

main().catch((err) => {
  console.error('[local-db] Unexpected failure.');
  console.error(err);
  process.exit(1);
});
