// Regression tests for the independent audit (AUDIT_FINDINGS.md F-xx / AUDIT_SECURITY.md S-xx).
// Every finding has (a) a test that asserts the CORRECT behaviour (it failed before the fix) and
// (b) a "no change" test proving the normal success path behaves exactly as before.
// Same harness as ui-flows.test.mjs: real db.ts on in-memory SQLite, real screens, faked RN/Expo modules.
import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  createItem, getItem, getKv, setKv, saveListItems, addRevision, listRevisions, getListItems, importAll, softDelete, restoreItems,
  deleteForever, moveItems, batchUpdateLock, setPositions, updateListItemsIncremental, listChildren, updateItem,
} from '../../src/db.ts';
import { RevisionsScreen } from '../../src/screens/Revisions.tsx';
import { GeneralSettings } from '../../src/screens/SettingsScreens.tsx';
import { NoteEditor } from '../../src/screens/NoteEditor.tsx';
import { ListEditor } from '../../src/screens/ListEditor.tsx';
import { startupTasks } from '../../src/backup.ts';
import { GateContext, singleFlight } from '../../src/gate.ts';
import { DeletedItemsScreen } from '../../src/screens/SettingsData.tsx';
import { HomeScreen } from '../../src/screens/Home.tsx';
import { serializeListRevision, parseListRevision, listRevisionPreview } from '../../src/format.ts';
import { resetWorld, flush } from '../harness/world.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const rn = () => globalThis.__rn;
const ui = () => globalThis.__ui;
const nav = () => globalThis.__nav;
const sqlite = () => globalThis.__sqlite;

beforeEach(async () => { await resetWorld(); mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => mock.timers.reset());

async function settle(n = 6) { for (let i = 0; i < n; i++) await act(async () => { await flush(); }); }
async function mount(el) { let r; await act(async () => { r = TestRenderer.create(el); }); await settle(); return r; }
const pressableWithText = (r, text) =>
  r.root.findAll((n) => n.type === 'Pressable' && n.findAll((c) => c.type === 'T' && c.props.children === text).length > 0)[0];
const alertTitles = () => rn().alerts.map((a) => a.title ?? a.args?.[0]);

async function openAndPressRestore(r) {
  await act(async () => { r.root.findAll((n) => n.type === 'Pressable')[0].props.onPress(); });
  await act(async () => { pressableWithText(r, 'RESTORE THIS VERSION').props.onPress(); });
}

/* ================================================================== F-01 */

test('F-01 (R5) note restore: a failing write shows an alert, applies NOTHING and leaves no stray revision', async () => {
  const note = await createItem('note', null, 'T', 'current');
  await addRevision(note.id, 'T', 'older');
  const r = await mount(React.createElement(RevisionsScreen, { id: note.id }));
  await openAndPressRestore(r);
  sqlite().faults.push({ match: /UPDATE items SET title/, times: 1, message: 'disk full' });
  const popsBefore = nav().pops;
  await act(async () => { await ui().confirms.at(-1).onOk(); });          // must not reject
  assert.ok(alertTitles().includes('Could not restore this version'), 'a visible alert is shown');
  assert.match(JSON.stringify(rn().alerts.at(-1)), /disk full/);
  assert.ok(!ui().toasts.includes('Version restored'), 'no success toast');
  assert.equal(nav().pops, popsBefore, 'does not navigate away on failure');
  assert.equal((await getItem(note.id)).body, 'current', 'note unchanged');
  assert.equal((await listRevisions(note.id)).length, 1, 'no stray revision from the first step');
});

test('F-01 list restore: failure after the entries were replaced rolls back entries, title and revisions', async () => {
  const list = await createItem('list', null, 'Groceries');
  await saveListItems(list.id, [{ id: 'e1', text: 'milk', checked: false }, { id: 'e2', text: 'eggs', checked: true }]);
  await addRevision(list.id, 'Old title', 'Old title\n[ ] bread');
  const r = await mount(React.createElement(RevisionsScreen, { id: list.id }));
  await openAndPressRestore(r);
  sqlite().faults.push({ match: /UPDATE items SET title/, times: 1, message: 'disk full' });
  await act(async () => { await ui().confirms.at(-1).onOk(); });
  assert.ok(alertTitles().includes('Could not restore this version'));
  assert.deepEqual((await getListItems(list.id)).map((e) => [e.text, e.checked]), [['milk', false], ['eggs', true]], 'entries NOT half-restored');
  assert.equal((await getItem(list.id)).title, 'Groceries', 'title unchanged');
  assert.equal((await listRevisions(list.id)).length, 1, 'no stray revision');
});

test('F-01 no-change: successful NOTE restore = same result, same toast, one pop, current text kept as revision', async () => {
  const note = await createItem('note', null, 'T', 'current text');
  await addRevision(note.id, 'Older T', 'older text');
  const r = await mount(React.createElement(RevisionsScreen, { id: note.id }));
  await openAndPressRestore(r);
  await act(async () => { await ui().confirms.at(-1).onOk(); });
  const it = await getItem(note.id);
  assert.equal(it.body, 'older text'); assert.equal(it.title, 'Older T');
  assert.deepEqual((await listRevisions(note.id)).map((v) => v.body).sort(), ['current text', 'older text']);
  assert.equal(ui().toasts.at(-1), 'Version restored');
  assert.equal(nav().pops, 1);
  assert.equal(rn().alerts.length, 0, 'no alert on success');
});

test('F-01 no-change: successful LIST restore = same entries/title, current list kept as revision, toast, one pop', async () => {
  const list = await createItem('list', null, 'Groceries');
  await saveListItems(list.id, [{ id: 'e1', text: 'milk', checked: false }, { id: 'e2', text: 'eggs', checked: true }]);
  await addRevision(list.id, 'Old', 'Old\n[x] bread\n[ ] tea');
  const r = await mount(React.createElement(RevisionsScreen, { id: list.id }));
  await openAndPressRestore(r);
  await act(async () => { await ui().confirms.at(-1).onOk(); });
  assert.deepEqual((await getListItems(list.id)).map((e) => [e.text, e.checked]), [['bread', true], ['tea', false]]);
  assert.equal((await getItem(list.id)).title, 'Old');
  const revs = await listRevisions(list.id);
  assert.equal(revs.length, 2);
  assert.ok(revs.some((v) => v.body !== 'Old\n[x] bread\n[ ] tea' && /milk/.test(v.body) && /eggs/.test(v.body)), 'previous list saved as a revision');
  assert.equal(ui().toasts.at(-1), 'Version restored'); assert.equal(nav().pops, 1);
});

test('F-01 clearRevisions: a failing delete shows an alert (no success toast); success path unchanged', async () => {
  const note = await createItem('note', null, 'T', 'b');
  await addRevision(note.id, 'T', 'v1');
  const find = (r) => r.root.findAll((n) => n.type === 'Row' && n.props.title === 'Delete all of my saved revisions')[0];
  const r = await mount(React.createElement(GeneralSettings));
  await act(async () => { find(r).props.onPress(); });
  sqlite().faults.push({ match: /DELETE FROM revisions/, times: 1, message: 'disk full' });
  await act(async () => { await ui().confirms.at(-1).onOk(); });
  assert.ok(alertTitles().includes('Could not delete revisions'));
  assert.ok(!ui().toasts.includes('All saved revisions deleted'));
  assert.equal((await listRevisions(note.id)).length, 1, 'nothing deleted');
  // success path (no change)
  rn().alerts.length = 0;
  await act(async () => { find(r).props.onPress(); });
  await act(async () => { await ui().confirms.at(-1).onOk(); });
  assert.equal(ui().toasts.at(-1), 'All saved revisions deleted');
  assert.equal((await listRevisions(note.id)).length, 0);
  assert.equal(rn().alerts.length, 0);
});

/* ================================================================== F-02 */
import { SettingsProvider, useSettings } from '../../src/settings.tsx';

async function mountSettings() {
  const box = {};
  const Probe = () => { box.ctx = useSettings(); return null; };
  box.r = await mount(React.createElement(SettingsProvider, null, React.createElement(Probe)));
  return box;
}

test('F-02 (R1) corrupt settings JSON: alert shown, update() does NOT overwrite the stored row, raw copy kept', async () => {
  const corrupt = '{"deletedAfterDays": 0, "backupFr';
  await setKv('settings', corrupt);
  const box = await mountSettings();
  assert.ok(alertTitles().includes('Could not read your settings'));
  assert.match(JSON.stringify(rn().alerts.at(-1)), /will not save changes until it is restarted/, 'alert text unchanged');
  assert.equal(box.ctx.hydrated, false, 'not reported as hydrated');
  await act(async () => { box.ctx.update({ hideInBackground: true }); await flush(); }); await settle();
  assert.equal(await getKv('settings'), corrupt, 'stored row untouched: the alert\'s promise is now true');
  assert.equal(box.ctx.s.hideInBackground, true, 'UI still reflects the change for this session');
  assert.equal(await getKv('settings.bak'), corrupt, 'raw copy kept');
});

test('F-02 syntactically valid but unusable settings ("null") also never get overwritten', async () => {
  await setKv('settings', 'null');
  const box = await mountSettings();
  await act(async () => { box.ctx.update({ fingerprint: true }); await flush(); }); await settle();
  assert.equal(await getKv('settings'), 'null');
  assert.equal(await getKv('settings.bak'), 'null');
});

test('F-02 no-change: valid saved settings load identically, hydrate, and update() persists merged settings', async () => {
  await setKv('settings', JSON.stringify({ themeId: 'light', hideInBackground: false, custom: { accent: '#ffffff' }, inactivitySeconds: 30 }));
  const box = await mountSettings();
  assert.equal(rn().alerts.length, 0, 'no alert');
  assert.equal(box.ctx.hydrated, true);
  assert.equal(box.ctx.s.themeId, 'light'); assert.equal(box.ctx.s.inactivitySeconds, 30);
  assert.equal(box.ctx.s.custom.accent, '#ffffff'); assert.equal(box.ctx.s.custom.bg, '#101820', 'custom merged over defaults');
  assert.equal(box.ctx.s.multilineTitles, false, 'missing keys come from defaults');
  await act(async () => { box.ctx.update({ hideInBackground: true }); await flush(); }); await settle();
  const stored = JSON.parse(await getKv('settings'));
  assert.equal(stored.hideInBackground, true); assert.equal(stored.themeId, 'light'); assert.equal(stored.inactivitySeconds, 30);
  assert.equal(await getKv('settings.bak'), null, 'no backup row when nothing is corrupt');
});

test('F-02 no-change: no saved settings row → defaults, hydrated, first update() writes', async () => {
  const box = await mountSettings();
  assert.equal(box.ctx.hydrated, true); assert.equal(rn().alerts.length, 0);
  await act(async () => { box.ctx.update({ fingerprint: true }); await flush(); }); await settle();
  assert.equal(JSON.parse(await getKv('settings')).fingerprint, true);
});

/* ================================================================== F-03 */
const iconBtn = (r, re) => r.root.findAll((n) => n.type === 'IconBtn' && re.test(n.props.accessibilityLabel ?? ''))[0];
const tick = (ms) => act(async () => { mock.timers.tick(ms); await flush(); });

test('F-03 settings: a failed write tells the user ONCE per failure streak, and again after a later success then failure', async () => {
  const box = await mountSettings();
  sqlite().faults.push({ match: /INSERT OR REPLACE INTO kv/, times: -1, message: 'disk full' });
  await act(async () => { box.ctx.update({ fingerprint: true }); await flush(); }); await settle();
  await act(async () => { box.ctx.update({ hideInBackground: true }); await flush(); }); await settle();
  const t = () => alertTitles().filter((x) => x === 'Could not save your settings').length;
  assert.equal(t(), 1, 'one alert, not one per toggle');
  assert.equal(box.ctx.s.fingerprint, true, 'UI state unchanged by the failure');
  sqlite().faults.length = 0;
  await act(async () => { box.ctx.update({ inactivitySeconds: 60 }); await flush(); }); await settle();
  assert.equal(t(), 1, 'successful write: no extra alert');
  sqlite().faults.push({ match: /INSERT OR REPLACE INTO kv/, times: 1, message: 'disk full' });
  await act(async () => { box.ctx.update({ resetHours: 2 }); await flush(); }); await settle();
  assert.equal(t(), 2, 'a new failure after a success is reported again');
});

test('F-03 no-change: successful settings writes show nothing', async () => {
  const box = await mountSettings();
  await act(async () => { box.ctx.update({ fingerprint: true }); await flush(); }); await settle();
  assert.equal(rn().alerts.length, 0); assert.equal(ui().toasts.length, 0);
  assert.equal(JSON.parse(await getKv('settings')).fingerprint, true);
});

test('F-03 NoteEditor: failing to READ the per-note read-only flag tells the user (toast)', async () => {
  const note = await createItem('note', null, 'T', 'body');
  sqlite().faults.push({ match: /SELECT v FROM kv WHERE k = \?/, times: 1, message: 'disk error' });
  await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));
  assert.ok(ui().toasts.includes("Could not check this note's read-only setting"), JSON.stringify(ui().toasts));
});

test('F-03 NoteEditor: failing to WRITE the per-note read-only flag shows an alert; the toggle itself still works', async () => {
  const note = await createItem('note', null, 'T', 'body');
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));
  sqlite().faults.push({ match: /INSERT OR REPLACE INTO kv/, times: 1, message: 'disk full' });
  await act(async () => { iconBtn(r, /enable read-only/i).props.onPress(); await flush(); }); await settle();
  assert.ok(alertTitles().includes("Could not save this note's read-only setting"));
  assert.ok(ui().toasts.includes('Note locked (Read-Only)'), 'existing toast unchanged');
  assert.ok(iconBtn(r, /read-only mode active/i), 'note is read-only for this session');
});

test('F-03 no-change: per-note read-only flag read/write success = same toast, stored flag, nothing extra', async () => {
  const note = await createItem('note', null, 'T', 'body');
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));
  await act(async () => { iconBtn(r, /enable read-only/i).props.onPress(); await flush(); }); await settle();
  assert.equal(await getKv(`ro:${note.id}`), '1');
  assert.equal(rn().alerts.length, 0); assert.deepEqual(ui().toasts, ['Note locked (Read-Only)']);
  await act(async () => { r.unmount(); await flush(); });
  ui().toasts.length = 0;
  const r2 = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));   // reopen: flag is read back
  assert.ok(iconBtn(r2, /read-only mode active/i), 'reopens read-only');
  assert.equal(ui().toasts.length, 0); assert.equal(rn().alerts.length, 0);
});

async function mountListWithPendingEdit() {
  const list = await createItem('list', null, 'Packing');
  await saveListItems(list.id, [{ id: 'i1', text: 'Passport', checked: false }, { id: 'i2', text: 'Charger', checked: false }]);
  const r = await mount(React.createElement(ListEditor, { id: list.id, isNew: false }));
  const up = r.root.findAll((n) => n.type === 'IconBtn' && n.props.accessibilityLabel === 'Move item up');
  await act(async () => { up[1].props.onPress(); });                 // pending, un-saved reorder (debounce not ticked)
  return { list, r };
}

test('F-03 ListEditor: a failing save when the screen closes (unmount) is reported, not dropped', async () => {
  const { list, r } = await mountListWithPendingEdit();
  sqlite().faults.push({ match: /DELETE FROM list_items/, times: -1, message: 'disk full' });
  await act(async () => { r.unmount(); await flush(); }); await settle();
  assert.ok(alertTitles().includes('Could not save your list'), JSON.stringify(alertTitles()));
  sqlite().faults.length = 0;
  assert.deepEqual((await getListItems(list.id)).map((e) => e.text), ['Passport', 'Charger'], 'control: nothing was saved');
});

test('F-03 ListEditor: failing background saves alert once per failure streak', async () => {
  const { r } = await mountListWithPendingEdit();
  sqlite().faults.push({ match: /DELETE FROM list_items/, times: -1, message: 'disk full' });
  for (let i = 0; i < 3; i++) await act(async () => { rn().appStateHandlers.forEach((h) => h('background')); await flush(); });
  await settle();
  assert.equal(alertTitles().filter((x) => x === 'Could not save your list').length, 1, 'not spammy');
  sqlite().faults.length = 0;
  await act(async () => { r.unmount(); await flush(); });
});

test('F-03 no-change: ListEditor background/unmount saves that succeed are silent and persist the edit', async () => {
  const { list, r } = await mountListWithPendingEdit();
  await act(async () => { rn().appStateHandlers.forEach((h) => h('background')); await flush(); }); await settle();
  assert.deepEqual((await getListItems(list.id)).map((e) => e.text), ['Charger', 'Passport']);
  await act(async () => { r.unmount(); await flush(); }); await settle();
  assert.equal(rn().alerts.length, 0);
});

test('F-03 startupTasks: a failing trash purge is reported (not swallowed); the scheduled backup still runs', async () => {
  const note = await createItem('note', null, 'old', 'x');
  const { softDelete } = await import('../../src/db.ts');
  await softDelete([note.id]);
  sqlite().raw.exec(`UPDATE items SET deleted_at = ${Date.now() - 40 * 86400000} WHERE id = '${note.id}'`);
  sqlite().faults.push({ match: /DELETE FROM items/, times: 1, message: 'disk full' });
  const s = { deletedAfterDays: 30, backupFrequencyDays: 0, lastBackupAt: null, backupLog: [] };
  await startupTasks(s, () => {});
  assert.ok(alertTitles().includes('Could not clean up deleted items'), JSON.stringify(alertTitles()));
});

test('F-03 no-change: startupTasks purges expired trash silently when nothing fails', async () => {
  const note = await createItem('note', null, 'old', 'x');
  const { softDelete } = await import('../../src/db.ts');
  await softDelete([note.id]);
  sqlite().raw.exec(`UPDATE items SET deleted_at = ${Date.now() - 40 * 86400000} WHERE id = '${note.id}'`);
  await startupTasks({ deletedAfterDays: 30, backupFrequencyDays: 0, lastBackupAt: null, backupLog: [] }, () => {});
  assert.equal(rn().alerts.length, 0);
  assert.equal(await getItem(note.id), null, 'expired item purged as before');
});

/* ================================================================== F-05 */
// db.ts transactions: expo-sqlite's withTransactionAsync is not exclusive. Writes are now queued behind an open transaction.
const backupOf = (items, revisions = []) => ({ app: 'notepad', version: 1, items, listItems: [], revisions });

test('F-05 two overlapping multi-statement writes both succeed (second used to fail: "cannot start a transaction within a transaction")', async () => {
  const a = await createItem('list', null, 'A'); const b = await createItem('list', null, 'B');
  const res = await Promise.allSettled([
    saveListItems(a.id, [{ id: 'a1', text: 'x', checked: false }]),
    saveListItems(b.id, [{ id: 'b1', text: 'y', checked: false }]),
    batchUpdateLock([a.id, b.id], true),
  ]);
  assert.deepEqual(res.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled'], JSON.stringify(res.map((r) => r.reason?.message)));
  assert.deepEqual((await getListItems(a.id)).map((e) => e.text), ['x']);
  assert.deepEqual((await getListItems(b.id)).map((e) => e.text), ['y']);
  assert.equal((await getItem(a.id)).locked, true);
});

test('F-05 an unrelated write made while another transaction rolls back is NOT rolled back with it', async () => {
  for (let k = 0; k < 10; k++) {
    await resetWorld();
    const keep = await createItem('note', null, 'existing', 'e');
    sqlite().faults.push({ match: /INSERT INTO revisions/, times: 1, message: 'boom' });
    const imp = importAll(backupOf([{ id: 'n1', type: 'note', title: 'imp', body: '' }], [{ itemId: 'n1', title: 't', body: 'b', savedAt: 1 }]), true)
      .then(() => 'ok', (e) => e.message);
    for (let i = 0; i < k; i++) await Promise.resolve();
    const made = await createItem('note', null, 'meanwhile', 'keep me');
    assert.equal(await imp, 'boom', `k=${k}: import failed as injected`);
    assert.ok(await getItem(made.id), `k=${k}: the note created meanwhile must survive`);
    assert.ok(await getItem(keep.id), `k=${k}: import rolled back completely (replace did not wipe existing data)`);
    assert.equal(await getItem('n1'), null, `k=${k}: nothing from the failed import remains`);
  }
});

test('F-05 atomic rollback is kept: a failure half-way through a large list save leaves the old list, and the queue keeps working', async () => {
  const list = await createItem('list', null, 'L');
  await saveListItems(list.id, [{ id: 'o1', text: 'old', checked: false }]);
  const big = Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, text: `t${i}`, checked: false }));
  sqlite().faults.push({ match: /INSERT INTO list_items/, times: 1, message: 'disk full' });   // fails on first chunk insert
  await assert.rejects(saveListItems(list.id, big), /disk full/);
  assert.deepEqual((await getListItems(list.id)).map((e) => e.text), ['old'], 'old entries intact');
  await saveListItems(list.id, big);                                                            // queue not stuck
  assert.equal((await getListItems(list.id)).length, 250);
});

test('F-05 no-change: every converted write still gives the same results on the normal path', async () => {
  const f = await createItem('folder', null, 'F'); const n1 = await createItem('note', f.id, 'n1', 'b'); const n2 = await createItem('note', null, 'n2', 'b');
  const l = await createItem('list', null, 'L');
  await setPositions([n2.id, f.id, l.id]);
  await moveItems([n2.id], f.id);
  assert.deepEqual((await listChildren(f.id)).map((x) => x.id).sort(), [n1.id, n2.id].sort());
  await saveListItems(l.id, [{ id: 'a', text: '1', checked: false }, { id: 'b', text: '2', checked: false }]);
  await updateListItemsIncremental(l.id, [{ id: 'a', text: '1x', checked: true }, { id: 'b', text: '2x', checked: false }]);
  assert.deepEqual((await getListItems(l.id)).map((e) => [e.text, e.checked]), [['1x', true], ['2x', false]]);
  await softDelete([f.id]); assert.ok((await getItem(n1.id)).deletedAt);
  await restoreItems([f.id]); assert.equal((await getItem(n1.id)).deletedAt, null);
  await addRevision(l.id, 'L', 'L\n[ ] z');
  await softDelete([l.id]); await deleteForever([l.id]);
  assert.equal(await getItem(l.id), null); assert.equal((await listRevisions(l.id)).length, 0);
  const data = backupOf([{ id: 'x1', type: 'note', title: 'T', body: 'B' }]);
  assert.equal(await importAll(data, false), 1);
  assert.equal(await importAll(data, false), 0, 'merge import skips existing ids as before');
});

/* ================================================================== F-06 */
test('F-06 (R4) end to end: entries and titles containing line breaks survive revision save + restore exactly', async () => {
  const list = await createItem('list', null, 'Multi\nline title');
  const orig = [{ id: 'a', text: 'line one\nline two', checked: true }, { id: 'b', text: 'second', checked: false }];
  await saveListItems(list.id, orig);
  const r = await mount(React.createElement(ListEditor, { id: list.id, isNew: false }));
  const up = r.root.findAll((n) => n.type === 'IconBtn' && n.props.accessibilityLabel === 'Move item up');
  await act(async () => { up[1].props.onPress(); });                                  // real edit -> revision of the ORIGINAL list
  await tick(700); await settle();
  assert.deepEqual((await getListItems(list.id)).map((e) => e.id), ['b', 'a']);
  await act(async () => { r.unmount(); await flush(); });
  const revs = await listRevisions(list.id);
  assert.equal(revs.length, 1);
  const rv = await mount(React.createElement(RevisionsScreen, { id: list.id }));
  await openAndPressRestore(rv);
  await act(async () => { await ui().confirms.at(-1).onOk(); });
  assert.deepEqual((await getListItems(list.id)).map(({ text, checked }) => ({ text, checked })),
    [{ text: 'line one\nline two', checked: true }, { text: 'second', checked: false }], 'exactly the original two entries');
});

test('F-06 round trip of the helpers, including odd characters', () => {
  const entries = [{ checked: true, text: 'a\nb' }, { checked: false, text: '[x] looks like markup' }, { checked: false, text: '' }, { checked: true, text: 'tab\there \u0001LIST1' }];
  const body = serializeListRevision('T\nitle', entries);
  assert.deepEqual(parseListRevision(body), { title: 'T\nitle', entries });
});

test('F-06 no-change: OLD-format revisions still parse, preview and restore as before', async () => {
  const old = 'Groceries\n[x] bread\n[ ] tea\n[ ] two words';
  assert.deepEqual(parseListRevision(old), { title: 'Groceries', entries: [
    { checked: true, text: 'bread' }, { checked: false, text: 'tea' }, { checked: false, text: 'two words' }] });
  assert.equal(listRevisionPreview(old), '[x] bread\n[ ] tea\n[ ] two words', 'preview identical to the previous slice(1) behaviour');
  const list = await createItem('list', null, 'Now');
  await saveListItems(list.id, [{ id: 'z', text: 'current', checked: false }]);
  await addRevision(list.id, 'Groceries', old);
  const rv = await mount(React.createElement(RevisionsScreen, { id: list.id }));
  await openAndPressRestore(rv);
  await act(async () => { await ui().confirms.at(-1).onOk(); });
  assert.deepEqual((await getListItems(list.id)).map(({ text, checked }) => [text, checked]), [['bread', true], ['tea', false], ['two words', false]]);
  assert.equal((await getItem(list.id)).title, 'Groceries');
});

test('F-06 no-change: an empty list still serialises to the old "title\\n" shape (no revision for a blank list)', () => {
  assert.equal(serializeListRevision('', []), '\n');
  assert.equal(serializeListRevision('Shopping', []), 'Shopping\n');
});

/* ================================================================== F-07 */
test('F-07 (R3) deleteForever removes the per-note read-only flag (also for folder descendants and big batches)', async () => {
  const f = await createItem('folder', null, 'F'); const inner = await createItem('note', f.id, 'in', 'b');
  const n = await createItem('note', null, 'x', 'y');
  for (const id of [f.id, inner.id, n.id]) await setKv(`ro:${id}`, '1');
  await setKv('settings', '{"keep":1}'); await setKv('other', 'v');
  await softDelete([f.id, n.id]); await deleteForever([f.id, n.id]);
  for (const id of [f.id, inner.id, n.id]) assert.equal(await getKv(`ro:${id}`), null, `ro flag of ${id} removed`);
  assert.equal(await getKv('settings'), '{"keep":1}', 'other kv rows untouched'); assert.equal(await getKv('other'), 'v');
  // > 20 ids takes the chunked path
  const many = []; for (let i = 0; i < 25; i++) { const m = await createItem('note', null, `m${i}`, ''); many.push(m.id); await setKv(`ro:${m.id}`, '1'); }
  const keep = await createItem('note', null, 'keep', ''); await setKv(`ro:${keep.id}`, '1');
  await softDelete(many); await deleteForever(many);
  for (const id of many) assert.equal(await getKv(`ro:${id}`), null);
  assert.equal(await getKv(`ro:${keep.id}`), '1', 'flag of a surviving note is kept');
});

test('F-07 importAll(replace) clears old per-note flags; merge import keeps them; other kv rows survive both', async () => {
  const n = await createItem('note', null, 'x', 'y'); await setKv(`ro:${n.id}`, '1'); await setKv('settings', '{"a":1}');
  await importAll(backupOf([{ id: 'm1', type: 'note', title: 'm', body: '' }]), false);
  assert.equal(await getKv(`ro:${n.id}`), '1', 'merge import keeps flags');
  await importAll(backupOf([{ id: n.id, type: 'note', title: 'again', body: '' }]), true);
  assert.equal(await getKv(`ro:${n.id}`), null, 'a re-imported note with the same id no longer opens read-only by accident');
  assert.equal(await getKv('settings'), '{"a":1}');
});

test('F-07 no-change: a failed replace-import still rolls back everything, including the flags', async () => {
  const n = await createItem('note', null, 'x', 'y'); await setKv(`ro:${n.id}`, '1');
  sqlite().faults.push({ match: /INSERT INTO items/, times: 1, message: 'boom' });
  await assert.rejects(importAll(backupOf([{ id: 'q', type: 'note', title: 'q', body: '' }]), true), /boom/);
  assert.equal(await getKv(`ro:${n.id}`), '1'); assert.ok(await getItem(n.id));
});

/* ================================================================== F-11 / S-08 (Deleted Items screen) */
function makeGate(answer) { const g = async () => { g.calls += 1; return answer.value; }; g.calls = 0; return g; }
async function trashed({ locked }) {
  const it = await createItem('note', null, locked ? 'secret' : 'plain', 'b');
  if (locked) await updateItem(it.id, { locked: true });
  await softDelete([it.id]);
  return it;
}
const byLabel = (r, label) => r.root.findAll((n) => n.type === 'Pressable' && n.props.accessibilityLabel === label);
async function mountTrash(gate) {
  return mount(React.createElement(GateContext.Provider, { value: gate }, React.createElement(DeletedItemsScreen)));
}

test('F-11 trash: restoring a LOCKED item asks for the password; refusal restores nothing, success restores', async () => {
  const it = await trashed({ locked: true });
  const answer = { value: false }; const gate = makeGate(answer);
  const r = await mountTrash(gate);
  await act(async () => { await byLabel(r, 'Restore item')[0].props.onPress(); }); await settle();
  assert.equal(gate.calls, 1); assert.ok((await getItem(it.id)).deletedAt, 'still in trash after a refused gate');
  assert.ok(!ui().toasts.includes('Restored'));
  answer.value = true;
  await act(async () => { await byLabel(r, 'Restore item')[0].props.onPress(); }); await settle();
  assert.equal(gate.calls, 2); assert.equal((await getItem(it.id)).deletedAt, null); assert.ok(ui().toasts.includes('Restored'));
});

test('F-11 trash: permanently deleting a LOCKED item asks for the password first', async () => {
  const it = await trashed({ locked: true });
  const answer = { value: false }; const gate = makeGate(answer);
  const r = await mountTrash(gate);
  await act(async () => { byLabel(r, 'Permanently delete item')[0].props.onPress(); });
  await act(async () => { await ui().confirms.at(-1).onOk(); }); await settle();
  assert.equal(gate.calls, 1); assert.ok(await getItem(it.id), 'refused gate: item NOT deleted forever');
  answer.value = true;
  await act(async () => { await ui().confirms.at(-1).onOk(); }); await settle();
  assert.equal(await getItem(it.id), null);
});

test('F-11 trash: "Empty deleted items" asks once if any item is locked, and deletes nothing when refused', async () => {
  const a = await trashed({ locked: false }); const b = await trashed({ locked: true });
  const answer = { value: false }; const gate = makeGate(answer);
  const r = await mountTrash(gate);
  const empty = () => r.root.findAll((n) => n.type === 'Button' && n.props.label === 'EMPTY DELETED ITEMS')[0];
  await act(async () => { empty().props.onPress(); });
  await act(async () => { await ui().confirms.at(-1).onOk(); }); await settle();
  assert.equal(gate.calls, 1); assert.ok(await getItem(a.id)); assert.ok(await getItem(b.id));
  answer.value = true;
  await act(async () => { await ui().confirms.at(-1).onOk(); }); await settle();
  assert.equal(gate.calls, 2); assert.equal(await getItem(a.id), null); assert.equal(await getItem(b.id), null);
});

test('F-11 no-change: trash actions on UNLOCKED items never prompt and behave as before', async () => {
  const a = await trashed({ locked: false }); const b = await trashed({ locked: false });
  const gate = makeGate({ value: false });                 // would block if (wrongly) consulted
  const r = await mountTrash(gate);
  await act(async () => { await byLabel(r, 'Restore item')[0].props.onPress(); }); await settle();
  await act(async () => { byLabel(r, 'Permanently delete item')[0].props.onPress(); });
  await act(async () => { await ui().confirms.at(-1).onOk(); }); await settle();
  assert.equal(gate.calls, 0);
  const left = [await getItem(a.id), await getItem(b.id)];
  assert.equal(left.filter((x) => x === null).length, 1, 'one deleted forever'); assert.equal(left.filter((x) => x && x.deletedAt === null).length, 1, 'one restored');
});

/* ================================================================== F-12 */
test('F-12 singleFlight: overlapping calls share ONE run and ALL callers settle; later calls start fresh', async () => {
  let runs = 0; let resolveRun;
  const gate = singleFlight(() => { runs += 1; return new Promise((res) => { resolveRun = res; }); });
  const p1 = gate(); const p2 = gate(); const p3 = gate();
  assert.equal(runs, 1); assert.equal(p1, p2);
  resolveRun(true);
  assert.deepEqual(await Promise.all([p1, p2, p3]), [true, true, true]);
  const p4 = gate(); assert.equal(runs, 2, 'after settling, a new call runs again'); resolveRun(false);
  assert.equal(await p4, false);
});

test('F-12 singleFlight: a rejected run is not cached (and every waiter sees the rejection)', async () => {
  let runs = 0;
  const gate = singleFlight(async () => { runs += 1; if (runs === 1) throw new Error('nope'); return 'ok'; });
  const [a, b] = await Promise.allSettled([gate(), gate()]);
  assert.equal(a.status, 'rejected'); assert.equal(b.status, 'rejected');
  assert.equal(await gate(), 'ok');
});

test('F-12 no-change: a lone call behaves like the plain function', async () => {
  const gate = singleFlight(async () => 42);
  assert.equal(await gate(), 42); assert.equal(await gate(), 42);
});

/* ================================================================== F-11 / S-08 (Home: delete + move) */
async function mountHomeSelecting(title, gate) {
  const r = await mount(React.createElement(GateContext.Provider, { value: gate }, React.createElement(HomeScreen, { folderId: null })));
  const row = r.root.findAll((n) => n.type === 'Pressable' && n.props.accessibilityLabel === `note: ${title}`)[0];
  assert.ok(row, `row "${title}" is shown`);
  await act(async () => { row.props.onLongPress(); }); await settle();
  return r;
}
const homeBtn = (r, label) => r.root.findAll((n) => n.type === 'Pressable' && n.props.accessibilityLabel === label)[0];

test('F-11 Home: deleting a LOCKED note asks for the password; refusal deletes nothing', async () => {
  const n = await createItem('note', null, 'HomeSecret', 'b'); await updateItem(n.id, { locked: true });
  const answer = { value: false }; const gate = makeGate(answer);
  const r = await mountHomeSelecting('HomeSecret', gate);
  await act(async () => { homeBtn(r, 'Delete selected items').props.onPress(); });
  await act(async () => { await ui().confirms.at(-1).onOk(); }); await settle();
  assert.equal(gate.calls, 1); assert.equal((await getItem(n.id)).deletedAt, null, 'not deleted after refusal');
  assert.ok(!ui().toasts.includes('Moved to Deleted Items'));
  answer.value = true;
  await act(async () => { await ui().confirms.at(-1).onOk(); }); await settle();
  assert.equal(gate.calls, 2); assert.ok((await getItem(n.id)).deletedAt, 'deleted after a successful gate');
});

test('F-11 Home: moving a LOCKED note asks for the password before offering destinations', async () => {
  await createItem('folder', null, 'Dest');
  const n = await createItem('note', null, 'MoveSecret', 'b'); await updateItem(n.id, { locked: true });
  const answer = { value: false }; const gate = makeGate(answer);
  const r = await mountHomeSelecting('MoveSecret', gate);
  const picker = () => r.root.findAll((n2) => n2.type === 'PickerModal')[0];
  await act(async () => { await homeBtn(r, 'Move selected items').props.onPress(); }); await settle();
  assert.equal(gate.calls, 1); assert.equal(picker().props.visible, false, 'no destination list after a refusal');
  answer.value = true;
  await act(async () => { await homeBtn(r, 'Move selected items').props.onPress(); }); await settle();
  assert.equal(picker().props.visible, true);
});

test('F-11 no-change: Home delete/move of UNLOCKED notes never prompts; same toast as before', async () => {
  await createItem('folder', null, 'Dest2');
  const n = await createItem('note', null, 'Plain', 'b');
  const gate = makeGate({ value: false });
  const r = await mountHomeSelecting('Plain', gate);
  const picker = () => r.root.findAll((n2) => n2.type === 'PickerModal')[0];
  await act(async () => { await homeBtn(r, 'Move selected items').props.onPress(); }); await settle();
  assert.equal(picker().props.visible, true);
  await act(async () => { picker().props.onClose(); }); await settle();
  await act(async () => { homeBtn(r, 'Delete selected items').props.onPress(); });
  await act(async () => { await ui().confirms.at(-1).onOk(); }); await settle();
  assert.equal(gate.calls, 0);
  assert.ok((await getItem(n.id)).deletedAt); assert.equal(ui().toasts.at(-1), 'Moved to Deleted Items');
});

/* ================================================================== F-22 */
const clip = () => globalThis.__clip;
const bodyInputOf = (r) => r.root.findAll((n) => n.type === 'TextInput' && n.props.multiline)[0];
beforeEach(() => { Object.assign(globalThis.__clip ?? (globalThis.__clip = {}), { text: '', failGet: false, failSet: false }); });

test('F-22 copy: a clipboard failure shows a toast instead of an unhandled rejection; no success toast', async () => {
  const note = await createItem('note', null, 'T', 'hello world');
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));
  clip().failSet = true;
  await act(async () => { await iconBtn(r, /copy note or selection/i).props.onPress(); await flush(); });
  assert.deepEqual(ui().toasts, ['Could not copy to the clipboard']);
});

test('F-22 paste: a clipboard failure shows a toast and leaves the note untouched', async () => {
  const note = await createItem('note', null, 'T', 'hello world');
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));
  clip().failGet = true;
  await act(async () => { await iconBtn(r, /paste from clipboard/i).props.onPress(); await flush(); });
  assert.deepEqual(ui().toasts, ['Could not read the clipboard']);
  assert.equal(bodyInputOf(r).props.value, 'hello world');
});

test('F-22 no-change: copy/paste success paths give the same toasts and results', async () => {
  const note = await createItem('note', null, 'T', 'hello world');
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));
  await act(async () => { await iconBtn(r, /copy note or selection/i).props.onPress(); await flush(); });
  assert.equal(clip().text, 'hello world'); assert.equal(ui().toasts.at(-1), 'Note copied');
  await act(async () => { await iconBtn(r, /paste from clipboard/i).props.onPress(); await flush(); });
  assert.equal(ui().toasts.at(-1), 'Note copied', 'pasting non-empty text shows no toast');
  assert.ok(bodyInputOf(r).props.value.includes('hello world') && bodyInputOf(r).props.value.length > 'hello world'.length, 'text was pasted');
  clip().text = '';
  await act(async () => { await iconBtn(r, /paste from clipboard/i).props.onPress(); await flush(); });
  assert.equal(ui().toasts.at(-1), 'Clipboard is empty');
});

/* ================================================================== F-08 */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function seedForest(rand, n) {
  const rows = new Map();
  const raw = sqlite().raw;
  const ins = raw.prepare('INSERT INTO items (id,type,parent_id,title,body,locked,position,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,0,?,1,1,?)');
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `r${i}`; ids.push(id);
    const parent = i > 0 && rand() < 0.55 ? ids[Math.floor(rand() * i)] : null;
    rows.set(id, { parent, pos: Math.floor(rand() * 8), del: null });
  }
  // deletions: whole subtrees at one of three timestamps, plus some single nodes
  const kids = (p) => ids.filter((x) => rows.get(x).parent === p);
  const sub = (p) => [p, ...kids(p).flatMap(sub)];
  for (let k = 0; k < Math.max(14, n / 3); k++) {
    const root = ids[Math.floor(rand() * n)]; const ts = [1000, 2000, 3000][Math.floor(rand() * 3)];
    for (const x of rand() < 0.7 ? sub(root) : [root]) if (rows.get(x).del === null) rows.get(x).del = ts;
  }
  for (const id of ids) { const r = rows.get(id); ins.run(id, 'folder', r.parent, id, '', r.pos, r.del); }
  return { rows, ids, sub };
}
const snapshot = async () => new Map((await (await import('../../src/db.ts')).getDb().then((d) => d.getAllAsync('SELECT id,parent_id,position,deleted_at FROM items'))).map((r) => [r.id, { parent: r.parent_id, pos: r.position, del: r.deleted_at }]));

function modelRestore(rows, ids, sub) {
  for (const id of ids) {
    const r = rows.get(id); if (!r || r.del === null) continue;
    const ts = r.del; const parent = r.parent;
    for (const x of sub(id)) if (rows.get(x).del === ts) rows.get(x).del = null;
    if (parent) { const p = rows.get(parent); if (!p || p.del !== null) r.parent = null; }
  }
}

test('F-08 restoreItems (set-based fast path + fallback) matches the one-by-one algorithm on 120 random forests', async () => {
  let fast = 0, fallback = 0;
  for (let seed = 1; seed <= 120; seed++) {
    await resetWorld();
    const rand = rng(seed * 7919);
    const { rows, ids, sub } = seedForest(rand, 180);
    // selection: mostly deleted items (some related to each other), plus duplicates and unknown ids
    const deleted = ids.filter((x) => rows.get(x).del !== null);
    const pickable = rand() < 0.5 ? deleted.filter((x) => { const p = rows.get(x).parent; return p === null || rows.get(p).del === null; }) : deleted;   // alternately: only "roots"
    const sel = []; for (let i = 0; i < 40 + Math.floor(rand() * 30); i++) sel.push(pickable.length ? pickable[Math.floor(rand() * pickable.length)] : 'none');
    if (rand() < 0.4) sel.push('ghost'); if (rand() < 0.4) sel.push(ids[Math.floor(rand() * ids.length)]);
    sqlite().trace = true; sqlite().log.length = 0;
    await restoreItems(sel);
    const stmts = sqlite().log.length; sqlite().trace = false;
    const touched = new Set(sel.filter((x) => rows.get(x)?.del != null)).size;
    if (touched > 20 && stmts <= 2 * Math.ceil(touched / 150) + 1) fast++; else if (touched > 20) fallback++;
    modelRestore(rows, sel, sub);
    const got = await snapshot();
    for (const id of ids) {
      assert.deepEqual({ ...got.get(id) }, { parent: rows.get(id).parent, pos: rows.get(id).pos, del: rows.get(id).del }, `seed ${seed}: row ${id}`);
    }
  }
  assert.ok(fast >= 5, `fast path was exercised (${fast}x)`); assert.ok(fallback >= 5, `fallback path was exercised (${fallback}x)`);
});

test('F-08 moveItems matches the one-by-one algorithm on 120 random forests (duplicates, unknown ids, same-folder moves)', async () => {
  for (let seed = 1; seed <= 120; seed++) {
    await resetWorld();
    const rand = rng(seed * 104729);
    const { rows, ids, sub } = seedForest(rand, 60);
    for (const id of ids) rows.get(id).del = null; sqlite().raw.exec('UPDATE items SET deleted_at = NULL');
    const sel = []; for (let i = 0; i < 1 + Math.floor(rand() * 40); i++) sel.push(ids[Math.floor(rand() * ids.length)]);
    if (rand() < 0.4) sel.push('ghost'); if (rand() < 0.3) sel.splice(1, 0, 'ghost2');
    const forbidden = new Set(sel.flatMap((x) => (rows.has(x) ? sub(x) : [])));
    const targets = [null, ...ids.filter((x) => !forbidden.has(x))];
    const P = targets[Math.floor(rand() * targets.length)];
    await moveItems(sel, P);
    for (const id of sel) {                                    // model of the original loop
      if (id === P) continue;
      let max = -1; for (const r of rows.values()) if (r.parent === P && r.pos > max) max = r.pos;
      const r = rows.get(id); if (r) { r.parent = P; r.pos = max + 1; }
    }
    const got = await snapshot();
    for (const id of ids) assert.deepEqual({ ...got.get(id) }, { parent: rows.get(id).parent, pos: rows.get(id).pos, del: null }, `seed ${seed}: row ${id}`);
  }
});

test('F-08 moveItems keeps its guards: into itself / into its own subfolder still throw, also across chunks', async () => {
  const a = await createItem('folder', null, 'a'); const b = await createItem('folder', a.id, 'b'); const c = await createItem('folder', b.id, 'c');
  await assert.rejects(moveItems([a.id], c.id), /own subfolders/);
  await assert.rejects(moveItems([a.id], a.id), /into itself/);
  const many = []; for (let i = 0; i < 160; i++) many.push((await createItem('note', null, `n${i}`, '')).id);
  await assert.rejects(moveItems([...many, a.id], c.id), /own subfolders/, 'guard also sees ids beyond the first chunk of 150');
  await moveItems(many, c.id);
  assert.equal((await listChildren(c.id)).length, 160);
});

test('F-08 perf: restoring / moving 1,000 items takes a handful of statements, not thousands', async () => {
  const raw = sqlite().raw;
  const ins = raw.prepare("INSERT INTO items (id,type,parent_id,title,body,locked,position,created_at,updated_at,deleted_at) VALUES (?, 'note', NULL, ?, '', 0, ?, 1, 1, 5000)");
  const ids = []; for (let i = 0; i < 1000; i++) { ids.push(`p${i}`); ins.run(`p${i}`, `t${i}`, i); }
  sqlite().trace = true; sqlite().log.length = 0;
  const t0 = performance.now(); await restoreItems(ids); const tRestore = performance.now() - t0;
  const restoreStmts = sqlite().log.length;
  const folder = await createItem('folder', null, 'dest');
  sqlite().log.length = 0;
  const t1 = performance.now(); await moveItems(ids, folder.id); const tMove = performance.now() - t1;
  const moveStmts = sqlite().log.length; sqlite().trace = false;
  console.log(`F-08 perf: restore ${restoreStmts} writes ${tRestore.toFixed(1)} ms | move ${moveStmts} writes ${tMove.toFixed(1)} ms`);
  assert.ok(restoreStmts <= 40, `restore used ${restoreStmts} write statements (was ~2,000+)`);
  assert.ok(moveStmts <= 40, `move used ${moveStmts} write statements (was 1,000+)`);
  assert.ok(tRestore < 5000 && tMove < 5000, 'generous wall-clock ceiling (statement counts are the real check)');
  const left = await snapshot(); assert.equal([...left.values()].filter((r) => r.del !== null).length, 0);
  assert.equal((await listChildren(folder.id)).length, 1000);
  assert.deepEqual((await listChildren(folder.id)).slice(0, 3).map((x) => x.id), ['p0', 'p1', 'p2'], 'order preserved');
});

/* ================================================================== F-10 */
import { searchItems, caseInsensitiveContainsGlob, SEARCH_LIMIT } from '../../src/db.ts';

test('F-10 search is case-insensitive for non-ASCII text (titles, bodies, list entries), still for ASCII', async () => {
  await createItem('note', null, 'École primaire', 'x');
  await createItem('note', null, 'plain', 'Привет МИР, как дела');
  const l = await createItem('list', null, 'shopping'); await saveListItems(l.id, [{ id: 'q', text: 'Ünïcode Bäckerei', checked: false }]);
  await createItem('note', null, 'Hello World', 'x');
  const titles = async (q) => (await searchItems(q)).map((i) => i.title).sort();
  assert.deepEqual(await titles('école'), ['École primaire']);
  assert.deepEqual(await titles('ÉCOLE'), ['École primaire']);
  assert.deepEqual(await titles('мир'), ['plain']);
  assert.deepEqual(await titles('ПРИВЕТ'), ['plain']);
  assert.deepEqual(await titles('ünï'), ['shopping']);
  assert.deepEqual(await titles('BÄCKEREI'), ['shopping']);
  assert.deepEqual(await titles('hello'), ['Hello World']);
  assert.deepEqual(await titles('WORLD'), ['Hello World']);
});

test('F-10 no-change: wildcard characters in the query are still matched literally; locked bodies still hidden', async () => {
  await createItem('note', null, 'a', 'discount 50% off'); await createItem('note', null, 'b', 'discount 50x off');
  await createItem('note', null, 'c', 'snake_case'); await createItem('note', null, 'd', 'snakeXcase');
  await createItem('note', null, 'e', 'what? [yes] a*b'); await createItem('note', null, 'f', 'whatX yes aXb');
  const hit = async (q) => (await searchItems(q)).map((i) => i.title).sort();
  assert.deepEqual(await hit('50%'), ['a']); assert.deepEqual(await hit('_case'), ['c']);
  assert.deepEqual(await hit('what?'), ['e']); assert.deepEqual(await hit('[yes]'), ['e']); assert.deepEqual(await hit('a*b'), ['e']);
  assert.deepEqual(await hit('back\\slash'), []);
  const s = await createItem('note', null, 'locked one', 'topsecretword'); await updateItem(s.id, { locked: true });
  assert.deepEqual(await hit('topsecretword'), [], 'locked body is not searchable');
  assert.deepEqual(caseInsensitiveContainsGlob('ab*'), '*[aA][bB][*]*');
});

test('F-10 search over a 10 MB body stays fast (GLOB vs the old LIKE)', async () => {
  const big = ('lorem ipsum dolor sit amet ' .repeat(400000)) + 'NEEDLE here';
  await createItem('note', null, 'big', big);
  const t0 = performance.now(); const r = await searchItems('needle'); const ms = performance.now() - t0;
  console.log(`F-10 10 MB search: ${ms.toFixed(0)} ms`);
  assert.equal(r.length, 1); assert.ok(ms < 4000, `generous ceiling, took ${ms} ms`);
});

async function mountHomeSearch() {
  const r = await mount(React.createElement(HomeScreen, { folderId: null }));
  await act(async () => { r.root.findAll((n) => n.type === 'IconBtn' && n.props.accessibilityLabel === 'Search')[0].props.onPress(); }); await settle();
  return r;
}
const searchBox = (r) => r.root.findAll((n) => n.type === 'TextInput')[0];
const typeQuery = (r, t) => act(async () => { searchBox(r).props.onChangeText(t); });
const searchReads = () => (sqlite().reads ?? []).filter((q) => /LIMIT 300/.test(q)).length;
const shownTitles = (r) => r.root.findAll((n) => n.type === 'Pressable' && /^(note|list|folder): /.test(n.props.accessibilityLabel ?? '')).map((n) => n.props.accessibilityLabel.replace(/^\w+: /, ''));

test('F-10 Home search waits ~150 ms after typing stops, then queries once; clearing is instant', async () => {
  await createItem('note', null, 'apple', 'x'); await createItem('note', null, 'apricot', 'x'); await createItem('note', null, 'banana', 'x');
  const r = await mountHomeSearch();
  sqlite().traceReads = true; sqlite().reads = [];
  await typeQuery(r, 'a'); await tick(50); await typeQuery(r, 'ap'); await tick(50); await typeQuery(r, 'apr'); await tick(100);
  await settle(); assert.equal(searchReads(), 0, 'no query while the user is still typing');
  await tick(60); await settle();
  assert.equal(searchReads(), 1, 'exactly one query after the pause');
  assert.deepEqual(shownTitles(r), ['apricot']);
  await typeQuery(r, ''); await settle();                                   // no timer tick needed
  assert.ok(shownTitles(r).length >= 3 && shownTitles(r).includes('banana'), 'back to the normal list immediately');
  sqlite().traceReads = false;
});

test('F-10 Home shows a "first 300 results" hint only when the limit was reached', async () => {
  const ins = sqlite().raw.prepare("INSERT INTO items (id,type,parent_id,title,body,locked,position,created_at,updated_at,deleted_at) VALUES (?, 'note', NULL, ?, '', 0, ?, 1, ?, NULL)");
  for (let i = 0; i < SEARCH_LIMIT + 5; i++) ins.run(`m${i}`, `findme ${i}`, i, i);
  await createItem('note', null, 'unique-one', 'x');
  const hint = (r) => r.root.findAll((n) => n.type === 'T' && typeof n.props.children === 'string' && /^Showing the first 300 results/.test(n.props.children));
  const r = await mountHomeSearch();
  await typeQuery(r, 'findme'); await tick(200); await settle();
  assert.equal(hint(r).length, 1, 'hint shown at the limit');
  await typeQuery(r, 'unique-one'); await tick(200); await settle();
  assert.equal(hint(r).length, 0, 'no hint for a short result list');
  assert.deepEqual(shownTitles(r), ['unique-one']);
});

test('F-10 no-change: without searching, Home lists and loads as before (no hint, no extra query)', async () => {
  await createItem('note', null, 'one', 'x');
  const r = await mount(React.createElement(HomeScreen, { folderId: null }));
  assert.ok(shownTitles(r).includes('one'));
  assert.equal(r.root.findAll((n) => n.type === 'T' && typeof n.props.children === 'string' && /Showing the first/.test(n.props.children)).length, 0);
});

test('F-10 no-change: ASCII queries still run the original LIKE statement; only non-ASCII queries use GLOB', async () => {
  await createItem('note', null, 'Café', 'x');
  sqlite().traceReads = true; sqlite().reads = [];
  await searchItems('cafe'); await searchItems('Café');
  sqlite().traceReads = false;
  const s = sqlite().reads.filter((q) => /LIMIT 300/.test(q));
  assert.equal(s.length, 2);
  assert.match(s[0], /i\.title LIKE \? ESCAPE/); assert.doesNotMatch(s[0], /GLOB/);
  assert.match(s[1], /i\.title GLOB \?/); assert.doesNotMatch(s[1], /LIKE \?/);
});
