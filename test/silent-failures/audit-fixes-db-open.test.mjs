// F-04 needs a FRESH process (db.ts caches its open promise at module level), hence its own file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, getKv, setKv } from '../../src/db.ts';

const sq = (globalThis.__sqlite ??= { faults: [], log: [] });

test('F-04 a failed database open is not cached: the next getDb() retries and succeeds', async () => {
  sq.failOpen = 1;
  await assert.rejects(getDb(), /unable to open database file/);
  const db = await getDb();                       // retry
  assert.ok(db, 'second call opens the database');
  await setKv('probe', 'ok');
  assert.equal(await getKv('probe'), 'ok', 'database is usable after the retry');
});
