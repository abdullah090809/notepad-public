// Locked notes / lists are encrypted at rest (src/vault.ts + src/db.ts). Real db.ts + real SQL engine,
// AES-256-GCM replaced by node:crypto with the same layout as the native module.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createItem, updateItem, getItem, batchUpdateLock, getListItems, saveListItems,
  updateListItemsIncremental, addRevision, listRevisions, restoreRevision, exportAll, importAll,
  sealExistingLockedItems, searchItems, getDb, setKv,
} from '../../src/db.ts';
import { SEALED_PREFIX, resetVaultCacheForTests } from '../../src/vault.ts';
import { resetWorld } from '../harness/world.mjs';

const SECRET = 'bank password: hunter2-XYZ';
beforeEach(async () => {
  await resetWorld();
  resetVaultCacheForTests();
  globalThis.__aes.failDecrypt = false;
});

const rawBody = async (id) => (await (await getDb()).getFirstAsync('SELECT body FROM items WHERE id = ?', [id])).body;
const rawEntries = async (id) => (await (await getDb()).getAllAsync('SELECT text FROM list_items WHERE list_id = ? ORDER BY position', [id])).map((r) => r.text);
const rawRevs = async (id) => (await (await getDb()).getAllAsync('SELECT body FROM revisions WHERE item_id = ?', [id])).map((r) => r.body);
const dumpAll = async () => {
  const db = await getDb();
  return JSON.stringify([
    await db.getAllAsync('SELECT * FROM items'), await db.getAllAsync('SELECT * FROM list_items'), await db.getAllAsync('SELECT * FROM revisions'),
  ]);
};

test('V-1 locking a note encrypts its text; reading gives plain text back; unlocking restores plain', async () => {
  const n = await createItem('note', null, 'Bank', SECRET);
  assert.equal(await rawBody(n.id), SECRET, 'unlocked notes stay plain (search keeps working)');
  await updateItem(n.id, { locked: true });
  const sealed = await rawBody(n.id);
  assert.ok(sealed.startsWith(SEALED_PREFIX));
  assert.ok(!(await dumpAll()).includes('hunter2'), 'secret appears nowhere in the database');
  assert.equal((await getItem(n.id)).body, SECRET);
  await updateItem(n.id, { locked: false });
  assert.equal(await rawBody(n.id), SECRET);
  assert.equal((await getItem(n.id)).locked, false);
});

test('V-2 edits of a locked note are saved encrypted (autosave path: body only)', async () => {
  const n = await createItem('note', null, 'Bank', 'x');
  await batchUpdateLock([n.id], true);
  await updateItem(n.id, { title: 'Bank', body: SECRET + ' v2' });
  assert.ok((await rawBody(n.id)).startsWith(SEALED_PREFIX));
  assert.equal((await getItem(n.id)).body, SECRET + ' v2');
  assert.ok(!(await dumpAll()).includes('hunter2'));
});

test('V-3 each save uses a fresh nonce (same text -> different ciphertext)', async () => {
  const n = await createItem('note', null, 'a', '');
  await batchUpdateLock([n.id], true);
  await updateItem(n.id, { body: SECRET });
  const a = await rawBody(n.id);
  await updateItem(n.id, { body: SECRET });
  assert.notEqual(a, await rawBody(n.id));
});

test('V-4 locked lists: entries encrypted in every write path, read back plain', async () => {
  const l = await createItem('list', null, 'Logins', '');
  await saveListItems(l.id, [{ id: 'a', text: 'mail: pw1', checked: false }, { id: 'b', text: 'bank: pw2', checked: true }]);
  await batchUpdateLock([l.id], true);
  for (const t of await rawEntries(l.id)) assert.ok(t.startsWith(SEALED_PREFIX));
  await updateListItemsIncremental(l.id, [{ id: 'a', text: 'mail: pw3', checked: true }]);
  await saveListItems(l.id, [{ id: 'a', text: 'mail: pw3', checked: true }, { id: 'c', text: 'new: pw4', checked: false }]);
  for (const t of await rawEntries(l.id)) assert.ok(t.startsWith(SEALED_PREFIX));
  assert.ok(!(await dumpAll()).includes('pw'));
  assert.deepEqual((await getListItems(l.id)).map((e) => [e.text, e.checked]), [['mail: pw3', true], ['new: pw4', false]]);
  await batchUpdateLock([l.id], false);
  assert.deepEqual(await rawEntries(l.id), ['mail: pw3', 'new: pw4']);
});

test('V-5 revisions of locked items are encrypted; restore keeps them encrypted', async () => {
  const n = await createItem('note', null, 'Bank', 'old text');
  await addRevision(n.id, 'Bank', 'plain old revision');
  await batchUpdateLock([n.id], true);
  await addRevision(n.id, 'Bank', SECRET);
  for (const b of await rawRevs(n.id)) assert.ok(b.startsWith(SEALED_PREFIX));
  assert.deepEqual((await listRevisions(n.id)).map((r) => r.body).sort(), [SECRET, 'plain old revision'].sort());
  await restoreRevision({ id: n.id, snapshot: { title: 'Bank', body: 'current' }, title: 'Bank', body: SECRET });
  assert.ok((await rawBody(n.id)).startsWith(SEALED_PREFIX));
  assert.equal((await getItem(n.id)).body, SECRET);
  for (const b of await rawRevs(n.id)) assert.ok(b.startsWith(SEALED_PREFIX));
  assert.ok(!(await dumpAll()).includes('hunter2'));
});

test('V-6 unlocked items are untouched: plain in the database, still searchable', async () => {
  const n = await createItem('note', null, 'Shopping', 'milk and eggs');
  const l = await createItem('list', null, 'Todo', '');
  await saveListItems(l.id, [{ id: 'a', text: 'buy bread', checked: false }]);
  assert.equal(await rawBody(n.id), 'milk and eggs');
  assert.deepEqual(await rawEntries(l.id), ['buy bread']);
  assert.equal((await searchItems('eggs')).length, 1);
  assert.equal((await searchItems('bread')).length, 1);
});

test('V-7 locked text cannot be found by search', async () => {
  const n = await createItem('note', null, 'Bank', SECRET);
  await updateItem(n.id, { locked: true });
  assert.equal((await searchItems('hunter2')).length, 0);
});

test('V-8 export gives readable data; import of locked items stores them encrypted and round-trips', async () => {
  const n = await createItem('note', null, 'Bank', SECRET);
  const l = await createItem('list', null, 'Logins', '');
  await saveListItems(l.id, [{ id: 'a', text: 'mail: pw1', checked: false }]);
  await addRevision(n.id, 'Bank', SECRET);
  await batchUpdateLock([n.id, l.id], true);
  const data = await exportAll(true);
  assert.equal(data.items.find((i) => i.id === n.id).body, SECRET);
  assert.equal(data.listItems[0].text, 'mail: pw1');
  assert.equal(data.revisions[0].body, SECRET);
  assert.ok(!JSON.stringify(data).includes(SEALED_PREFIX));
  await importAll(data, true);
  assert.ok(!(await dumpAll()).includes('hunter2'));
  assert.ok(!(await dumpAll()).includes('pw1'));
  assert.ok((await rawBody(n.id)).startsWith(SEALED_PREFIX));
  assert.equal((await getItem(n.id)).body, SECRET);
  assert.equal((await getListItems(l.id))[0].text, 'mail: pw1');
  assert.equal((await listRevisions(n.id))[0].body, SECRET);
});

test('V-9 migration seals items that were locked before encryption existed, once, and keeps them readable', async () => {
  const db = await getDb();
  await db.runAsync("INSERT INTO items (id,type,parent_id,title,body,locked,position,created_at,updated_at,deleted_at) VALUES ('old1','note',NULL,'Old',?,1,0,1,1,NULL)", [SECRET]);
  await db.runAsync("INSERT INTO items (id,type,parent_id,title,body,locked,position,created_at,updated_at,deleted_at) VALUES ('oldl','list',NULL,'OldL','',1,1,1,1,NULL)");
  await db.runAsync("INSERT INTO list_items (id,list_id,text,checked,position) VALUES ('e1','oldl','secret entry',0,0)");
  await db.runAsync("INSERT INTO revisions (item_id,title,body,saved_at) VALUES ('old1','Old',?,1)", [SECRET]);
  await sealExistingLockedItems();
  assert.ok(!(await dumpAll()).includes('hunter2'));
  assert.ok(!(await dumpAll()).includes('secret entry'));
  assert.equal((await getItem('old1')).body, SECRET);
  assert.equal((await getListItems('oldl'))[0].text, 'secret entry');
  const before = await rawBody('old1');
  await sealExistingLockedItems();
  assert.equal(await rawBody('old1'), before, 'second run does nothing');
});

test('V-10 key missing while encrypted data exists: nothing is overwritten, no new key is made', async () => {
  const n = await createItem('note', null, 'Bank', SECRET);
  await updateItem(n.id, { locked: true });
  const sealedBefore = await rawBody(n.id);
  globalThis.__secure.map.clear();
  resetVaultCacheForTests();
  await assert.rejects(() => getItem(n.id), /key/i);
  await assert.rejects(() => updateItem(n.id, { body: 'overwrite attempt' }), /key/i);
  assert.equal(await rawBody(n.id), sealedBefore);
  assert.equal(globalThis.__secure.map.has('np_data_key'), false, 'no replacement key created');
});

test('V-11 a keystore READ error never creates a new key', async () => {
  const n = await createItem('note', null, 'Bank', SECRET);
  await updateItem(n.id, { locked: true });
  const keyBefore = globalThis.__secure.map.get('np_data_key');
  assert.ok(keyBefore);
  resetVaultCacheForTests();
  globalThis.__secure.failGet = (k) => k === 'np_data_key';
  await assert.rejects(() => getItem(n.id));
  globalThis.__secure.failGet = null;
  assert.equal(globalThis.__secure.map.get('np_data_key'), keyBefore);
  resetVaultCacheForTests();
  assert.equal((await getItem(n.id)).body, SECRET, 'readable again once the keystore works');
});

test('V-12 tampered ciphertext is rejected, not shown as garbage', async () => {
  const n = await createItem('note', null, 'Bank', SECRET);
  await updateItem(n.id, { locked: true });
  const db = await getDb();
  const s = await rawBody(n.id);
  const flipped = s.slice(0, -6) + (s.slice(-6, -5) === 'A' ? 'B' : 'A') + s.slice(-5);
  await db.runAsync('UPDATE items SET body = ? WHERE id = ?', [flipped, n.id]);
  await assert.rejects(() => getItem(n.id));
});

test('V-13 empty locked note stays empty; lock/unlock of a note with no text works', async () => {
  const n = await createItem('note', null, 'Empty', '');
  await batchUpdateLock([n.id], true);
  assert.equal(await rawBody(n.id), '');
  assert.equal((await getItem(n.id)).locked, true);
  await batchUpdateLock([n.id], false);
  assert.equal((await getItem(n.id)).locked, false);
});

test('V-14 unicode and large text survive lock -> save -> read', async () => {
  const big = 'pässwörd ✓ 日本語 😀\n'.repeat(50000);
  const n = await createItem('note', null, 'Big', '');
  await batchUpdateLock([n.id], true);
  await updateItem(n.id, { body: big });
  assert.equal((await getItem(n.id)).body, big);
});
