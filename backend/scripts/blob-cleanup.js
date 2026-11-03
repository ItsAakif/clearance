/**
 * ONE-SHOT render-artifact blob cleanup.
 *
 * WHAT IT IS FOR. Our own live runs (T1031/T1043/T1052) rendered real documents into the
 * shared `render-artifacts` volume and then removed the DATABASE rows with them. The
 * content-addressed BYTES have no such cascade: `remove(key)` is not on any database path,
 * so every abandoned run left a blob behind. Eleven of them sat unreferenced, and one of
 * those was a 0-BYTE file whose key names a real sha256 - a PowerShell quoting bug in an
 * earlier probe had damaged it.
 *
 * WHY THE 0-BYTE ONE MATTERS MORE THAN THE OTHER TEN. `put` is idempotent and fails CLOSED:
 * a key that already exists is re-verified against the digest the key names, so the empty
 * file would raise `STORAGE_HASH_MISMATCH` / `EXISTING_HASH_MISMATCH` on the next legitimate
 * render of that exact content - a spurious storage failure with nothing wrong with the
 * renderer. An unreferenced blob is litter; a 0-byte blob that claims an address is a
 * landmine.
 *
 * WHAT IT DOES. Lists the storage root through the `fs`, resolves every blob to its storage
 * KEY (`artifacts/<first two hex>/<sha256>`), asks the real database which keys a
 * `ResumeDocument` row still references, and removes the unreferenced ones plus any 0-byte
 * file - THROUGH THE STORAGE PORT'S OWN `remove(key)`, never a raw `unlink`, so the port's
 * key-pattern, containment, regular-file and post-conditions all run. Then it verifies: every
 * remaining blob is referenced by a row AND hashes to the digest both its key and its row
 * claim.
 *
 * HYGIENE. It removes BLOBS only. No row is deleted, no other volume is touched (`pgdata`
 * is never named), nothing is truncated, and `--dry-run` prints the plan and exits.
 *
 * USAGE.
 *   # inside the backend container, where RENDER_STORAGE_ROOT and DATABASE_URL are real:
 *   docker exec clearance-backend-1 node /app/scripts/blob-cleanup.js --dry-run
 *   docker exec clearance-backend-1 node /app/scripts/blob-cleanup.js
 *
 * It runs the COMPILED port (`dist/render/storage.js`) because a live container has no
 * TypeScript loader, and the compiled port is the shipped port.
 */

'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** The port, compiled. The script fails loudly rather than silently doing something else. */
function loadStoragePort() {
  const compiled = path.join(__dirname, '..', 'dist', 'render', 'storage.js');
  if (!fs.existsSync(compiled)) {
    throw new Error(
      `${compiled} is missing - run \`npm run build\` first, or run this inside the backend ` +
        'container (which ships dist). The COMPILED port is used deliberately: it is the port ' +
        'the live stack is running.',
    );
  }
  // eslint-disable-next-line
  return require(compiled);
}

const { createArtifactStore, STORAGE_KEY_PATTERN, storageKeyFor } = loadStoragePort();

const ROOT = process.env.RENDER_STORAGE_ROOT ?? '/var/lib/clearance/artifacts';
const DRY_RUN = process.argv.includes('--dry-run');
/** Relative to ROOT. The store's own layout, asserted here so a change in it is loud. */
const FANOUT = 'artifacts';

/** Every blob under the fan-out, as storage KEYS - never as filesystem paths to delete. */
function listBlobKeys(root) {
  const fanout = path.join(root, FANOUT);
  const keys = [];
  let prefixes;
  try {
    prefixes = fs.readdirSync(fanout, { withFileTypes: true });
  } catch {
    return keys;
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue;
    const prefixDir = path.join(fanout, prefix.name);
    for (const entry of fs.readdirSync(prefixDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const key = `${FANOUT}/${prefix.name}/${entry.name}`;
      if (!STORAGE_KEY_PATTERN.test(key)) {
        console.log(`  NOTE  skipping an entry that is not a storage key: ${key}`);
        continue;
      }
      keys.push(key);
    }
  }
  return keys.sort();
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function main() {
  const store = createArtifactStore({ root: ROOT });
  console.log(`storage root : ${ROOT}`);
  console.log(`descriptor   : ${JSON.stringify(store.describe())}`);
  console.log(`mode         : ${DRY_RUN ? 'DRY RUN (nothing removed)' : 'REMOVE'}`);

  const keys = listBlobKeys(ROOT);
  console.log(`\nblobs found  : ${keys.length}`);

  // The referenced set, read from the real database through the real client.
  // eslint-disable-next-line
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  return prisma.resumeDocument
    .findMany({ select: { id: true, storageKey: true, hash: true, byteSize: true } })
    .then(async (rows) => {
      const referenced = new Map(rows.map((row) => [row.storageKey, row]));
      console.log(`ResumeDocument rows: ${rows.length} (referencing ${referenced.size} distinct key(s))`);

      // The plan: unreferenced OR empty. An unreferenced blob is unreferenced whichever
      // size it is; an empty blob is the landmine, and it is removed even if some row claims
      // the key (a row pointing at 0 bytes is itself broken, and `remove` is the fix).
      const orphans = [];
      const empties = [];
      for (const key of keys) {
        const file = path.join(ROOT, ...key.split('/'));
        const size = fs.statSync(file).size;
        const row = referenced.get(key);
        if (row === undefined) orphans.push({ key, size });
        if (size === 0) empties.push({ key, size, row });
      }

      console.log(`\nunreferenced : ${orphans.length}`);
      for (const orphan of orphans) console.log(`  ORPHAN ${orphan.key} (${orphan.size} bytes)`);
      console.log(`0-byte blobs : ${empties.length}`);
      for (const empty of empties) {
        console.log(`  EMPTY  ${empty.key} (0 bytes, referenced by row: ${empty.row === undefined ? 'no' : empty.row.id})`);
      }

      const doomed = new Map();
      for (const item of [...orphans, ...empties]) doomed.set(item.key, item);

      if (doomed.size === 0) {
        console.log('\nnothing to remove.');
      } else {
        for (const key of doomed.keys()) {
          // The port's OWN remove: key pattern, resolved containment, regular-file, and the
          // post-condition that the path is gone. Not `fs.unlink`.
          if (!DRY_RUN) await store.remove(key);
          console.log(`  ${DRY_RUN ? 'would remove' : 'removed  '} ${key}`);
        }
      }

      // ---- verification: re-read the root from disk and prove what is left is sound.
      const remaining = listBlobKeys(ROOT);
      const unreferencedAfter = [];
      const hashFailures = [];
      const sizeFailures = [];
      for (const key of remaining) {
        const file = path.join(ROOT, ...key.split('/'));
        const digest = sha256(file);
        const size = fs.statSync(file).size;
        // The digest the KEY names: `<first two hex>/<sha256>`. This is the check that would
        // have caught the 0-byte file while it was still there.
        if (storageKeyFor(digest) !== key) hashFailures.push(`${key}: does not hash to its own address`);
        const row = referenced.get(key);
        if (row === undefined) {
          unreferencedAfter.push(key);
          continue;
        }
        if (row.hash !== digest) hashFailures.push(`${key}: hashes to ${digest}, row claims ${row.hash}`);
        if (row.byteSize !== size) sizeFailures.push(`${key}: ${size} bytes, row claims ${row.byteSize}`);
      }
      const emptyAfter = remaining.filter((key) => fs.statSync(path.join(ROOT, ...key.split('/'))).size === 0);

      console.log(`\nAFTER: blobs=${remaining.length} (was ${keys.length})`);
      console.log(`AFTER: unreferenced=${unreferencedAfter.length}${unreferencedAfter.length === 0 ? '' : ` -> ${unreferencedAfter.join(', ')}`}`);
      console.log(`AFTER: 0-byte=${emptyAfter.length}${emptyAfter.length === 0 ? '' : ` -> ${emptyAfter.join(', ')}`}`);
      console.log(`AFTER: hash failures=${hashFailures.length}${hashFailures.length === 0 ? '' : ` -> ${hashFailures.join(', ')}`}`);
      console.log(`AFTER: byteSize mismatches=${sizeFailures.length}${sizeFailures.length === 0 ? '' : ` -> ${sizeFailures.join(', ')}`}`);

      const ok =
        unreferencedAfter.length === 0 && emptyAfter.length === 0 && hashFailures.length === 0 && sizeFailures.length === 0;
      console.log(`\n${ok ? 'PASS' : 'FAIL'}  every remaining blob is referenced by a ResumeDocument row and hashes correctly`);
      if (!ok) process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

try {
  const outcome = main();
  if (outcome && typeof outcome.then === 'function') {
    outcome.catch((error) => {
      console.error(`BLOB CLEANUP ERROR: ${error && error.message ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
} catch (error) {
  console.error(`BLOB CLEANUP ERROR: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
}
