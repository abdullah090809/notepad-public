// F-04 (schema-creation failure variant). Own file = fresh process = fresh db.ts module state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, getKv, setKv } from '../../src/db.ts';

const sq = (globalThis.__sqlite ??= { faults: [], log: [] });

test('F-04 a failure while creating the schema closes the half-open connection, is not cached, and the next call retries', async () => {
  sq.failExec = 1;
  await assert.rejects(getDb(), /disk I\/O error/);
  assert.equal(sq.closed, 1, 'the half-open connection was closed');
  const db = await getDb();
  assert.ok(db);
  await setKv('probe', 'ok');
  assert.equal(await getKv('probe'), 'ok');
  assert.equal(sq.closed, 1, 'a healthy open closes nothing');
});
