// F-04 "no change" test: with a healthy database nothing about getDb() differs. Own file = fresh process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, getKv, setKv } from '../../src/db.ts';

test('F-04 no-change: healthy path hands every caller the SAME cached connection and it works', async () => {
  const a = getDb(); const b = getDb();
  assert.equal(a, b, 'same cached promise while healthy');
  assert.equal(await a, await b);
  await setKv('k', 'v');
  assert.equal(await getKv('k'), 'v');
  assert.equal(getDb(), a, 'still the same promise after use');
});
