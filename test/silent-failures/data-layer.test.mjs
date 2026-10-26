// Silent-failure regression tests: persistence layer, security layer, backup layer.
// REAL code under test: src/db.ts, src/security.ts, src/backup.ts, src/format.ts
// FAKED: expo-sqlite -> node:sqlite (real SQL engine, in-memory), SecureStore/FileSystem/Alert/etc -> in-memory fakes.
// Tests named "[CONTROL]" assert behaviour that is currently correct (they prove rollback/recovery works).
// All other tests assert the CORRECT contract and are expected to FAIL on the current code (confirmed defects).
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createItem, getItem, moveItems, importAll, saveListItems, getListItems, updateItem,
  searchItems, batchUpdateLock,
} from '../../src/db.ts';
import { setPassword, verifyPassword, hasPassword } from '../../src/security.ts';
import { backupNow, importNotes } from '../../src/backup.ts';
import { resetWorld, watchDbChanges, rows, flush } from '../harness/world.mjs';

beforeEach(resetWorld);

/* ------------------------------------------------------------------ db.ts */

test('SF-DB-1 moveItems into own descendant must not "succeed" silently (nothing moved, no signal)', async () => {
  const a = await createItem('folder', null, 'A');
  const b = await createItem('folder', a.id, 'B');           // B is inside A
  const c = await createItem('note', null, 'C');
  const watch = watchDbChanges();

  // Home.doMove() does: await moveItems(...); toast('Moved'). Any resolved promise therefore means "Moved".
  let outcome = 'resolved';
  await moveItems([a.id, c.id], b.id).catch(() => { outcome = 'rejected'; });

  const aAfter = await getItem(a.id);
  const cAfter = await getItem(c.id);
  const nothingMoved = aAfter.parentId === null && cAfter.parentId === null;

  // The valid half of the selection (note C) is also dropped: all-or-nothing, with no error.
  assert.ok(
    !(nothingMoved && outcome === 'resolved'),
    `moveItems resolved, announced ${watch.count()} change(s), yet moved nothing (A.parent=${aAfter.parentId}, C.parent=${cAfter.parentId}). ` +
      'Caller shows "Moved" toast for a no-op.'
  );
  watch.stop();
});

test('SF-DB-2 merge import must not silently discard list entries whose id collides with another list', async () => {
  // Valid per validateBackupData() (it never inspects listItems). Two lists each own an entry with id "x".
  const backup = {
    app: 'notepad', version: 1, exportedAt: 1,
    items: [
      { id: 'L1', type: 'list', title: 'First', body: '', parentId: null, position: 0 },
      { id: 'L2', type: 'list', title: 'Second', body: '', parentId: null, position: 1 },
    ],
    listItems: [
      { listId: 'L1', id: 'x', text: 'milk', checked: false, position: 0 },
      { listId: 'L2', id: 'x', text: 'eggs', checked: true, position: 0 },
    ],
  };
  const added = await importAll(backup, false);
  assert.equal(added, 2, 'import reports both lists as imported');

  // Authoritative source: the table itself.
  const persisted = await rows('SELECT list_id, text FROM list_items ORDER BY list_id');
  assert.deepEqual(
    persisted.map((r) => `${r.list_id}:${r.text}`),
    ['L1:milk', 'L2:eggs'],
    'import returned success but one list entry was dropped by INSERT OR IGNORE'
  );
});

test('[CONTROL] importAll(replace) with a malformed payload rolls back and keeps existing data', async () => {
  const keep = await createItem('note', null, 'keep me', 'precious');
  const bad = {
    app: 'notepad', version: 1, exportedAt: 1,
    items: [{ id: 'n1', type: 'note', title: 'new', body: 'x' }],
    listItems: [null],                      // passes validateBackupData, explodes mid-transaction
  };
  await assert.rejects(importAll(bad, true));
  const after = await rows('SELECT id, body FROM items');
  assert.deepEqual(after.map((r) => r.id), [keep.id], 'existing note must survive a failed replace-import');
  assert.equal(after[0].body, 'precious');
});

test('[CONTROL] saveListItems is atomic: a mid-write failure leaves the previous entries intact', async () => {
  const list = await createItem('list', null, 'L');
  await saveListItems(list.id, [{ id: 'a', text: 'one', checked: false }, { id: 'b', text: 'two', checked: true }]);
  let n = 0;
  globalThis.__sqlite.faults.push({ match: { test: (sql) => /INSERT INTO list_items/.test(sql) && ++n === 2 }, times: -1 });
  await assert.rejects(saveListItems(list.id, [
    { id: 'c', text: 'x', checked: false }, { id: 'd', text: 'y', checked: false }, { id: 'e', text: 'z', checked: false },
  ]));
  globalThis.__sqlite.faults.length = 0;
  assert.deepEqual((await getListItems(list.id)).map((e) => e.text), ['one', 'two']);
});

/* ---------------------------------------------------------------- security.ts */

test('SF-SEC-1 a failed password change must not invalidate the existing password', async () => {
  await setPassword('old-password');
  assert.equal(await verifyPassword('old-password'), true, 'precondition');

  // SecureStore fails on the SECOND write of setPassword (salt already replaced, hash not yet).
  globalThis.__secure.failSet = (k) => k === 'np_pw_hash';
  await assert.rejects(setPassword('new-password'));
  globalThis.__secure.failSet = null;

  assert.equal(
    await verifyPassword('old-password'),
    true,
    'salt was overwritten before the hash write failed -> old hash can never verify again (user locked out of locked notes)'
  );
});

test('SF-SEC-2 hasPassword must not report "no password" when the keystore read fails (fail-open lock)', async () => {
  await setPassword('s3cret');
  globalThis.__secure.failGet = () => true;           // e.g. Android keystore invalidated / transient failure
  const result = await hasPassword().catch(() => 'threw');
  globalThis.__secure.failGet = null;
  assert.notEqual(
    result, false,
    'App.tsx uses hasPassword()===false to skip the launch lock and the locked-note gate: a read error opens everything'
  );
});

/* ------------------------------------------------------------------ backup.ts */

const settingsFor = () => ({
  includeRevisionsInExport: false,
  exportNameTemplate: 'Notes {YYYY_MM_DD} Backup',
  backupLog: [],
  backupFrequencyDays: 7,
  lastBackupAt: null,
});

test('SF-BK-1 backupNow must distinguish "nothing to back up" from "backup failed"', async () => {
  const updates = [];
  const update = (p) => updates.push(p);

  const emptyResult = await backupNow(settingsFor(), update);        // no items at all

  await createItem('note', null, 'important', 'data worth backing up');
  globalThis.__vfs.failWrite = () => true;                           // disk full
  // A correct implementation may either return a distinct result or throw; both are acceptable, "false" for both is not.
  const failedResult = await backupNow(settingsFor(), update).catch(() => 'threw');

  assert.deepEqual(updates, [], 'control: nothing is logged for either outcome');
  assert.notEqual(
    emptyResult, failedResult,
    `both outcomes return ${String(failedResult)}; SettingsData.runNow() maps false to the toast "Nothing to back up yet" even though the disk write failed`
  );
});

test('SF-BK-2 importNotes must settle when the user cancels the "Replace all notes?" confirmation', async () => {
  await createItem('note', null, 'existing', 'keep');
  const backup = { app: 'notepad', version: 1, exportedAt: 1, listItems: [],
    items: [{ id: 'imp1', type: 'note', title: 'imported', body: 'b', parentId: null, position: 0 }] };
  globalThis.__vfs.files.set('file:///picked/backup.json', JSON.stringify(backup));
  globalThis.__picked = { canceled: false, assets: [{ uri: 'file:///picked/backup.json', name: 'backup.json' }] };

  const pending = importNotes();
  for (let i = 0; i < 10 && globalThis.__rn.alerts.length === 0; i++) await flush();
  const modeDialog = globalThis.__rn.alerts.at(-1);
  modeDialog.buttons.find((b) => b.text === 'Replace everything').onPress();
  for (let i = 0; i < 10 && globalThis.__ui.confirms.length === 0; i++) await flush();
  assert.equal(globalThis.__ui.confirms.length, 1, 'precondition: replace confirmation shown');
  // The user taps "Cancel". In src/ui.tsx confirm() the Cancel button has no handler, so there is nothing to invoke:
  // `onCancel` is only defined if the app passes a cancel callback to confirm() (the fix).
  globalThis.__ui.confirms[0].onCancel?.();

  const state = await Promise.race([pending.then(() => 'settled'), flush().then(flush).then(flush).then(() => 'pending')]);
  assert.equal(state, 'settled', 'importNotes() never resolves or rejects after Cancel (dangling promise; callers awaiting it hang)');
  const after = await rows('SELECT title FROM items');
  assert.deepEqual(after.map((r) => r.title), ['existing'], 'control: data untouched');
});

test('AUD-FUNC-01 searchItems matches checklist entries inside list_items', async () => {
  const note = await createItem('note', null, 'Groceries Note', 'apples and oranges');
  const list = await createItem('list', null, 'Shopping List', '');
  await saveListItems(list.id, [
    { id: 'li-1', text: 'buy organic bananas', checked: false },
    { id: 'li-2', text: 'almond milk', checked: true },
  ]);

  const results = await searchItems('bananas');
  assert.equal(results.length, 1, 'searchItems should match checklist entry');
  assert.equal(results[0].id, list.id);
  assert.equal(results[0].title, 'Shopping List');
});

test('AUD-PERF-01 batchUpdateLock updates multiple items atomically in a single transaction', async () => {
  const item1 = await createItem('note', null, 'Note 1', 'Content 1');
  const item2 = await createItem('list', null, 'List 2', '');
  const item3 = await createItem('note', null, 'Note 3', 'Content 3');

  const watch = watchDbChanges();
  await batchUpdateLock([item1.id, item2.id, item3.id], true);
  watch.stop();

  assert.equal(watch.count(), 1, 'batchUpdateLock should notify db changes exactly once');
  const r1 = await getItem(item1.id);
  const r2 = await getItem(item2.id);
  const r3 = await getItem(item3.id);
  assert.equal(r1.locked, true);
  assert.equal(r2.locked, true);
  assert.equal(r3.locked, true);
});

test('AUD-SEC-02 importAll rejects malformed list items and rolls back completely', async () => {
  const existing = await createItem('note', null, 'precious note', 'critical content');
  const badBackup = {
    app: 'notepad',
    version: 1,
    exportedAt: 1,
    items: [{ id: 'n1', type: 'note', title: 'new', body: 'x' }],
    listItems: ['invalid-string-not-an-object'],
  };
  await assert.rejects(importAll(badBackup, true));
  const itemsAfter = await rows('SELECT id, body FROM items');
  assert.deepEqual(itemsAfter.map((r) => r.id), [existing.id]);
  assert.equal(itemsAfter[0].body, 'critical content');
});

