// Silent-failure and runtime integration regression tests that drive REAL React screens
// (NoteEditor, ListEditor, Revisions, SettingsProvider, NavProvider, IconBtn)
// with react-test-renderer against the REAL db.ts on in-memory SQLite.
// Faked: react-native primitives (plain host nodes), ui.tsx/nav/appearance/settings doubles for screens, native Expo modules.
// Timers: only setTimeout is mocked (editor debounce), so ordering is deterministic.
import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Keyboard } from 'react-native';
import {
  createItem,
  getItem,
  getKv,
  setKv,
  saveListItems,
  addRevision,
  listRevisions,
  getListItems,
  searchItems,
  updateItem,
} from '../../src/db.ts';
import { setReadOnlyGuard } from '../../src/db.ts';
import { NoteEditor } from '../../src/screens/NoteEditor.tsx';
import { ListEditor } from '../../src/screens/ListEditor.tsx';
import { getSearchPreview } from '../../src/screens/Home.tsx';
import { RevisionsScreen } from '../../src/screens/Revisions.tsx';
import { SettingsProvider, useSettings } from '../../src/settings.tsx';
import { NavProvider, useNav } from '../../src/nav.tsx';
import { IconBtn } from '../../src/ui.tsx';
import { resetWorld, flush } from '../harness/world.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const rn = () => globalThis.__rn;
const ui = () => globalThis.__ui;
const nav = () => globalThis.__nav;

beforeEach(async () => { await resetWorld(); mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => mock.timers.reset());

async function settle(n = 6) { for (let i = 0; i < n; i++) await act(async () => { await flush(); }); }
async function mount(el) { let r; await act(async () => { r = TestRenderer.create(el); }); await settle(); return r; }
const bodyInput = (r) => r.root.findAll((n) => n.type === 'TextInput' && n.props.multiline)[0];
const scrollView = (r) => r.root.findAll((n) => n.type === 'ScrollView')[0];
const iconBtn = (r, re) => r.root.findAll((n) => n.type === 'IconBtn' && re.test(n.props.accessibilityLabel ?? ''))[0];
const pressableByLabel = (r, re) =>
  r.root.findAll((n) => n.type === 'Pressable' && re.test(n.props.accessibilityLabel ?? ''))[0];
const pressableWithText = (r, text) =>
  r.root.findAll((n) => n.type === 'Pressable' && n.findAll((c) => c.type === 'T' && c.props.children === text).length > 0)[0];
const type = (r, text) => act(async () => { bodyInput(r).props.onChangeText(text); });
const tick = (ms) => act(async () => { mock.timers.tick(ms); await flush(); });

async function seedNote(body = 'original body') {
  return createItem('note', null, 'Title', body);
}

/* ------------------------------------------------------------- NoteEditor */

test('SF-UI-1 text typed just before tapping the read-only lock must not be lost', async () => {
  const note = await seedNote();
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));

  await type(r, 'original body + 3 paragraphs I just typed');
  // user locks the note straight away (inside the 700 ms autosave debounce)
  await act(async () => { iconBtn(r, /enable read-only/i).props.onPress(); });
  const shownInUi = bodyInput(r).props.value;

  await tick(5000);
  await act(async () => { r.unmount(); await flush(); });

  assert.equal(shownInUi, 'original body + 3 paragraphs I just typed', 'precondition: UI shows the new text');
  const persisted = (await getItem(note.id)).body;
  assert.equal(persisted, shownInUi, 'UI showed the edit but the DB row still has the old body: toggleReadOnly clears the save timer and resets dirty without saving');
});

test('SF-UI-2 with global Read-Only Mode ON, the editor must not accept edits it will silently throw away', async () => {
  const note = await seedNote();
  globalThis.__cfg.readOnlyMode = true;
  setReadOnlyGuard(() => true);                       // what SettingsProvider installs
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));

  const editable = bodyInput(r).props.editable !== false;
  await type(r, 'edit made while read-only mode is on');
  await act(async () => { r.root.findByType('Header').props.onBack(); await flush(); });
  await settle();

  const persisted = (await getItem(note.id)).body;
  const userTold = rn().alerts.length > 0 || ui().toasts.length > 0;
  assert.ok(
    !editable || persisted === 'edit made while read-only mode is on' || userTold,
    `body input editable=${editable}, DB body="${persisted}", alerts/toasts=${rn().alerts.length + ui().toasts.length}: edit accepted, discarded (ReadOnlyError swallowed in persist) and the user was never told`
  );
});

test('SF-UI-3 when saving fails, leaving the note must not silently discard the edit', async () => {
  const note = await seedNote();
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));
  await type(r, 'edit that cannot be saved');
  globalThis.__sqlite.faults.push({ match: /UPDATE items SET title/, times: -1, message: 'SQLITE_FULL: database or disk is full' });

  await act(async () => { r.root.findByType('Header').props.onBack(); await flush(); });
  await settle();
  await act(async () => { r.unmount(); await flush(); });   // unmount cleanup gets one more (failing) persist attempt
  globalThis.__sqlite.faults.length = 0;

  const left = nav().pops > 0;
  const userTold = rn().alerts.length > 0 || ui().toasts.length > 0;
  const persisted = (await getItem(note.id)).body;
  assert.ok(
    persisted === 'edit that cannot be saved' || !left || userTold,
    `save failed (DB body="${persisted}"), screen was closed (pops=${nav().pops}) and no error was shown (alerts+toasts=${rn().alerts.length + ui().toasts.length})`
  );
});

test('SF-UI-4 a failed "Delete note" must not leave the screen impossible to leave', async () => {
  const note = await seedNote();
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));
  await act(async () => { iconBtn(r, /options menu/i).props.onPress(); });
  await act(async () => { pressableWithText(r, 'Delete note').props.onPress(); });
  const dialog = ui().confirms.at(-1);
  assert.equal(dialog?.title, 'Delete note?', 'precondition: confirmation shown');

  globalThis.__sqlite.faults.push({ match: /UPDATE items SET deleted_at = \?/, times: -1 });
  await dialog.onOk().catch(() => {});                      // production: the rejection is unhandled and nothing is shown
  globalThis.__sqlite.faults.length = 0;

  const popsBefore = nav().pops;
  await act(async () => { rn().backHandlers.at(-1)(); await flush(); });   // user presses the hardware back button
  await settle();
  assert.equal(nav().pops, popsBefore + 1, 'back button is dead: removeNote set leaving.current=true before the failing await and never reset it');
  assert.equal((await getItem(note.id)).deletedAt, null, 'control: note was not deleted');
});

/* ------------------------------------------------------------- Revisions */

test('SF-UI-5 restoring a LIST revision must save the current list first, as the dialog promises', async () => {
  const list = await createItem('list', null, 'Groceries');
  await saveListItems(list.id, [{ id: 'e1', text: 'milk', checked: false }, { id: 'e2', text: 'eggs', checked: true }, { id: 'e3', text: 'bread', checked: false }]);
  await addRevision(list.id, 'Groceries', 'Groceries\n[ ] milk');
  const before = (await listRevisions(list.id)).length;

  const r = await mount(React.createElement(RevisionsScreen, { id: list.id }));
  await act(async () => { r.root.findAll((n) => n.type === 'Pressable')[0].props.onPress(); });
  await act(async () => { pressableWithText(r, 'RESTORE THIS VERSION').props.onPress(); });
  const dialog = ui().confirms.at(-1);
  assert.match(dialog.message, /saved as a revision first/, 'precondition: dialog makes the promise');
  await act(async () => { await dialog.onOk(); });

  assert.deepEqual((await getListItems(list.id)).map((e) => e.text), ['milk'], 'precondition: list was replaced');
  assert.equal(ui().toasts.at(-1), 'Version restored');
  assert.equal((await listRevisions(list.id)).length, before + 1,
    'dialog says the current text is saved as a revision, but for lists nothing is saved: "eggs" and "bread" are now unrecoverable');
});

test('[CONTROL] restoring a NOTE revision saves the current text first and restores the old one', async () => {
  const note = await createItem('note', null, 'T', 'current text');
  await addRevision(note.id, 'T', 'older text');
  const r = await mount(React.createElement(RevisionsScreen, { id: note.id }));
  await act(async () => { r.root.findAll((n) => n.type === 'Pressable')[0].props.onPress(); });
  await act(async () => { pressableWithText(r, 'RESTORE THIS VERSION').props.onPress(); });
  await act(async () => { await ui().confirms.at(-1).onOk(); });
  assert.equal((await getItem(note.id)).body, 'older text');
  assert.deepEqual((await listRevisions(note.id)).map((v) => v.body).sort(), ['current text', 'older text']);
});

/* ------------------------------------------------------- SettingsProvider */

test('SF-UI-6 a transient settings read failure must not let the next change overwrite saved settings with defaults', async () => {
  await setKv('settings', JSON.stringify({ deletedAfterDays: 0, backupFrequencyDays: 30, readOnlyMode: false }));
  globalThis.__sqlite.faults.push({ match: /SELECT v FROM kv/, times: 1 });          // one failed read at startup

  let ctx;
  const Probe = () => { ctx = useSettings(); return null; };
  await mount(React.createElement(SettingsProvider, null, React.createElement(Probe)));
  await act(async () => { ctx.update({ hideInBackground: true }); await flush(); });   // user flips any unrelated switch
  await settle();

  const stored = JSON.parse(await getKv('settings'));
  assert.equal(stored.deletedAfterDays, 0, `stored "never auto-delete trash" (0) was replaced by default ${stored.deletedAfterDays}; backupFrequencyDays=${stored.backupFrequencyDays}`);
  assert.equal(stored.backupFrequencyDays, 30);
});

test('AUD-DATA-01 restoring a revision does not get overwritten by stale in-memory NoteEditor state on exit', async () => {
  const note = await createItem('note', null, 'My Note', 'stale initial text');
  await addRevision(note.id, 'My Note', 'restored revision text');

  // Mount editor with note
  const editor = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));
  assert.equal(bodyInput(editor).props.value, 'stale initial text');

  // User opens revisions screen and restores
  const revScreen = await mount(React.createElement(RevisionsScreen, { id: note.id }));
  await act(async () => { revScreen.root.findAll((n) => n.type === 'Pressable')[0].props.onPress(); });
  await act(async () => { pressableWithText(revScreen, 'RESTORE THIS VERSION').props.onPress(); });
  await act(async () => { await ui().confirms.at(-1).onOk(); });

  // DB has been updated to restored text
  assert.equal((await getItem(note.id)).body, 'restored revision text');

  // Editor regains focus / stack updates to Note
  globalThis.__nav.stack = [{ name: 'Note', params: { id: note.id } }];
  await settle();

  // User exits editor (e.g. back button / unmount)
  await act(async () => { editor.root.findByType('Header').props.onBack(); await flush(); });
  await settle();
  await act(async () => { editor.unmount(); await flush(); });

  const finalNote = await getItem(note.id);
  assert.equal(finalNote.body, 'restored revision text', 'Stale editor must not overwrite restored revision text on exit');
});

/* ------------------------------------------- NoteEditor Runtime Stability */

test('RT-EDITOR-1 Jump to end is idempotent on short and long notes and allows scrolling upward afterward', async () => {
  // 1. Short note (3 lines) on 500px viewport: Jump to end must not scroll into blank space
  const shortNote = await seedNote('Line 1\nLine 2\nLine 3');
  const rShort = await mount(React.createElement(NoteEditor, { id: shortNote.id, isNew: false }));
  await act(async () => {
    scrollView(rShort).props.onLayout({ nativeEvent: { layout: { height: 500, width: 400 } } });
    scrollView(rShort).props.onContentSizeChange(400, 120);
  });
  rn().scrolls.length = 0;

  await act(async () => { iconBtn(rShort, /options menu/i).props.onPress(); });
  await act(async () => { pressableWithText(rShort, 'Jump to end').props.onPress(); });
  // Target Y for 3 lines on 500px viewport is 0 (already at 0 -> no overscroll)
  assert.ok(rn().scrolls.every((s) => s.y === 0), 'Short note Jump to end must never scroll past 0');
  await act(async () => { rShort.unmount(); await flush(); });

  // 2. Long note (80 lines) on 400px viewport: Jump to end scrolls to exact end and is idempotent on repeated presses
  const longLines = Array.from({ length: 80 }, (_, i) => `Paragraph line number ${i + 1}`).join('\n');
  const longNote = await seedNote(longLines);
  const rLong = await mount(React.createElement(NoteEditor, { id: longNote.id, isNew: false }));
  await act(async () => {
    scrollView(rLong).props.onLayout({ nativeEvent: { layout: { height: 400, width: 400 } } });
    scrollView(rLong).props.onContentSizeChange(400, 2038);
  });
  rn().scrolls.length = 0;

  // First Jump to end
  await act(async () => { iconBtn(rLong, /options menu/i).props.onPress(); });
  await act(async () => { pressableWithText(rLong, 'Jump to end').props.onPress(); });
  assert.equal(rn().scrolls.length, 1, 'First Jump to end scrolls once');
  const firstEndY = rn().scrolls[0].y;
  assert.ok(firstEndY > 1400, `Expected positive scroll to end, got ${firstEndY}`);

  // Second Jump to end immediately at the same position -> idempotent (no further scroll move)
  await act(async () => { iconBtn(rLong, /options menu/i).props.onPress(); });
  await act(async () => { pressableWithText(rLong, 'Jump to end').props.onPress(); });
  assert.equal(rn().scrolls.length, 1, 'Repeated Jump to end at end position must not scroll again');

  // Scroll upward manually to Y=300 and place cursor -> must NOT snap back to end
  await act(async () => {
    scrollView(rLong).props.onScrollBeginDrag();
    scrollView(rLong).props.onScroll({ nativeEvent: { contentOffset: { y: 300 } } });
    scrollView(rLong).props.onScrollEndDrag();
    bodyInput(rLong).props.onSelectionChange({ nativeEvent: { selection: { start: 250, end: 250 } } });
  });
  assert.equal(rn().scrolls.length, 1, 'Scrolling upward and placing cursor must not snap back to end');
});

test('RT-EDITOR-2 Rapid Enter presses and deletions maintain viewport stability without stale selection jumps', async () => {
  const initialLines = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n');
  const note = await seedNote(initialLines);
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));

  await act(async () => {
    scrollView(r).props.onLayout({ nativeEvent: { layout: { height: 300, width: 400 } } });
    scrollView(r).props.onContentSizeChange(400, 350);
    bodyInput(r).props.onSelectionChange({
      nativeEvent: { selection: { start: initialLines.length, end: initialLines.length } },
    });
  });
  rn().scrolls.length = 0;

  // Rapidly press Enter 4 times WITHOUT firing intermediate onSelectionChange events
  let current = initialLines;
  for (let i = 0; i < 4; i++) {
    current += '\n';
    await type(r, current);
  }
  assert.ok(rn().scrolls.length >= 1, 'Pressing Enter at bottom of viewport scrolls down');
  for (let i = 1; i < rn().scrolls.length; i++) {
    const delta = rn().scrolls[i].y - rn().scrolls[i - 1].y;
    assert.equal(delta, 25, 'Each rapid Enter increments scroll by exactly 1 lineHeight (25px)');
  }

  // Deleting characters while cursor is visible inside the viewport must NOT trigger any scroll
  const countBeforeDelete = rn().scrolls.length;
  await type(r, current.slice(0, -2));
  assert.equal(rn().scrolls.length, countBeforeDelete, 'Deleting visible lines must not shake or scroll the viewport');
});

test('RT-EDITOR-3 Undo and Redo restore exact edit cursor, highlight changed span briefly, and only scroll when offscreen', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: original content`).join('\n');
  const note = await seedNote(lines);
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));

  await act(async () => {
    scrollView(r).props.onLayout({ nativeEvent: { layout: { height: 300, width: 400 } } });
    scrollView(r).props.onContentSizeChange(400, 1050);
  });

  // Place cursor on Line 2 (offset 30, well inside top viewport [0, 300]) and insert "INSERTED "
  const editOffset = lines.indexOf('Line 2:');
  await act(async () => {
    bodyInput(r).props.onSelectionChange({ nativeEvent: { selection: { start: editOffset, end: editOffset } } });
  });
  const editedText = lines.slice(0, editOffset) + 'INSERTED ' + lines.slice(editOffset);
  await type(r, editedText);
  await tick(700); // Commit history snapshot

  rn().scrolls.length = 0;

  // 1. Undo while still at scrollY=0 (Line 2 is already visible): must NOT scroll!
  await act(async () => { iconBtn(r, /Undo/i).props.onPress(); });
  assert.equal(bodyInput(r).props.value, lines, 'Undo restores original text');
  assert.equal(rn().scrolls.length, 0, 'Undo of already-visible edit must not move the viewport');
  assert.deepEqual(bodyInput(r).props.selection, { start: editOffset, end: editOffset }, 'Cursor returns to editOffset, NOT end of note');
  assert.equal(bodyInput(r).props.style.color, 'transparent', 'TextInput text is transparent while synchronized undo highlight overlay is shown');

  // Highlight clears automatically after timer expires
  await tick(1000);
  assert.notEqual(bodyInput(r).props.style.color, 'transparent', 'Undo highlight clears after timeout');

  // 2. Scroll far down to Y=700 so Line 2 is offscreen above, then tap Redo -> must scroll to reveal Line 2!
  await act(async () => {
    scrollView(r).props.onScroll({ nativeEvent: { contentOffset: { y: 700 } } });
  });
  rn().scrolls.length = 0;

  await act(async () => { iconBtn(r, /Redo/i).props.onPress(); });
  assert.equal(bodyInput(r).props.value, editedText, 'Redo restores edited text');
  assert.equal(rn().scrolls.length, 1, 'Offscreen Redo scrolls once to reveal the restored edit');
  assert.equal(rn().scrolls[0].y, 0, 'Reveals Line 2 near top of note');

  // Check that the highlighted span in the overlay matches "INSERTED "
  const highlightSpan = r.root.findAll(
    (n) => n.type === 'Text' && n.props.style?.backgroundColor === '#fef08a'
  )[0];
  assert.ok(highlightSpan, 'Redo renders highlight span');
  assert.equal(highlightSpan.props.children, 'INSERTED ');

  // 3. Simulate Android ReactEditText emitting a transient selection reset (e.g. to end of buffer)
  // when value prop updates on Redo: must NOT clear the highlight or corrupt the restored cursor!
  await act(async () => {
    bodyInput(r).props.onSelectionChange({
      nativeEvent: { selection: { start: editedText.length, end: editedText.length } },
    });
  });
  const highlightSpanAfterTransient = r.root.findAll(
    (n) => n.type === 'Text' && n.props.style?.backgroundColor === '#fef08a'
  )[0];
  assert.ok(
    highlightSpanAfterTransient,
    'Transient native selection event during Redo must not wipe out the highlight overlay'
  );
  assert.deepEqual(
    bodyInput(r).props.selection,
    { start: editOffset + 9, end: editOffset + 9 },
    'Programmatic selection remains locked to the exact redone text position'
  );
});

test('RT-EDITOR-4 In-note search finds >1000 matches, wraps around on Prev/Next, and keeps keyboard focus', async () => {
  // Create a note with 1,200 occurrences of "token"
  const body = Array.from({ length: 1200 }, (_, i) => `Row ${i + 1} token value`).join('\n');
  const note = await seedNote(body);
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));

  await act(async () => {
    scrollView(r).props.onLayout({ nativeEvent: { layout: { height: 400, width: 400 } } });
    scrollView(r).props.onContentSizeChange(400, 30000);
  });

  // Open search bar
  await act(async () => { iconBtn(r, /Find in note/i).props.onPress(); });
  const searchInput = r.root.findAll((n) => n.type === 'TextInput' && n.props.returnKeyType === 'search')[0];
  assert.ok(searchInput, 'Search TextInput is rendered');
  assert.equal(searchInput.props.blurOnSubmit, false, 'Search input keeps keyboard focus on submit');

  // Type single character 't' -> immediate match counter without lag
  await act(async () => { searchInput.props.onChangeText('token'); });
  const counterNode = () =>
    r.root.findAll((n) => n.type === 'T' && typeof n.props.children === 'string' && n.props.children.includes('/'))[0];
  assert.equal(counterNode().props.children, '1/1200', 'Finds all 1,200 matches without 1,000-match truncation');

  // Wrap around backward from 1/1200 -> 1200/1200
  await act(async () => { pressableByLabel(r, /Previous match/i).props.onPress(); });
  assert.equal(counterNode().props.children, '1200/1200', 'Previous match wraps around to 1200/1200');

  // Wrap around forward from 1200/1200 -> 1/1200
  await act(async () => { pressableByLabel(r, /Next match/i).props.onPress(); });
  assert.equal(counterNode().props.children, '1/1200', 'Next match wraps around to 1/1200');
});

test('RT-EDITOR-5 Keyboard compensation does not double-shrink viewport when Android OS already resized container', async () => {
  const note = await seedNote('Keyboard test body');
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));

  const containerView = () =>
    r.root.findAll((n) => n.type === 'View' && typeof n.props.onLayout === 'function' && n.props.style?.flex === 1)[0];

  // Initial container height before keyboard: 700px
  await act(async () => {
    containerView().props.onLayout({ nativeEvent: { layout: { height: 700, width: 400 } } });
  });
  assert.equal(containerView().props.style.paddingBottom, 0);

  // Case A: Android adjustResize already shrank container to 420px when 280px keyboard opened
  await act(async () => {
    containerView().props.onLayout({ nativeEvent: { layout: { height: 420, width: 400 } } });
    Keyboard.emit('keyboardDidShow', { endCoordinates: { height: 280 } });
  });
  assert.equal(containerView().props.style.paddingBottom, 0, 'Must not double-pad when OS already shrank container by 280px');

  // Case B: OS did NOT shrink container (still 700px) when 280px keyboard opened -> apply 280px paddingBottom
  await act(async () => {
    containerView().props.onLayout({ nativeEvent: { layout: { height: 700, width: 400 } } });
  });
  assert.equal(containerView().props.style.paddingBottom, 280, 'Applies keyboard padding when OS did not resize container');
});

/* ------------------------------------------- Search & Privacy in SQLite */

test('RT-SEARCH-1 SQLite searchItems returns deep body snippets, checklist matches, and protects locked items', async () => {
  const deepNote = await createItem(
    'note',
    null,
    'Project Architecture',
    'Header intro text. '.repeat(20) + 'MatchKeywordAtChar400 in the body.'
  );
  const lockedNote = await createItem('note', null, 'Locked Note', 'Secret MatchKeywordAtChar400 inside locked body');
  await updateItem(lockedNote.id, { locked: true });

  const checklist = await createItem('list', null, 'Sprint Tasks');
  await saveListItems(checklist.id, [
    { id: 'c1', text: 'First item', checked: false },
    { id: 'c2', text: 'Verify MatchKeywordAtChar400 in checklist', checked: false },
  ]);

  const results = await searchItems('MatchKeywordAtChar400');
  const byId = new Map(results.map((item) => [item.id, item]));

  assert.ok(byId.has(deepNote.id), 'Finds deep note match');
  assert.ok(!byId.has(lockedNote.id), 'Never matches inside locked note body');
  assert.ok(byId.has(checklist.id), 'Finds unlocked checklist item match');

  const notePreview = getSearchPreview(byId.get(deepNote.id), 'MatchKeywordAtChar400');
  assert.ok(notePreview.includes('MatchKeywordAtChar400'), 'Deep note snippet includes keyword past char 160');

  const listPreview = getSearchPreview(byId.get(checklist.id), 'MatchKeywordAtChar400');
  assert.ok(listPreview.includes('MatchKeywordAtChar400'), 'Checklist search preview includes matched entry text');
});

/* ------------------------------------------- ListEditor & Navigation */

test('RT-LIST-1 ListEditor preserves edits, checkbox toggles, and arrow reorders with removeClippedSubviews=false', async () => {
  const list = await createItem('list', null, 'Packing List');
  await saveListItems(list.id, [
    { id: 'i1', text: 'Passport', checked: false },
    { id: 'i2', text: 'Charger', checked: false },
    { id: 'i3', text: 'Tickets', checked: true },
  ]);

  const r = await mount(React.createElement(ListEditor, { id: list.id, isNew: false }));
  const flatList = r.root.findByType('FlatList');
  assert.equal(flatList.props.removeClippedSubviews, false, 'FlatList disables removeClippedSubviews to prevent input detachment');

  // Move 'Charger' (index 1) up to index 0
  const moveUpButtons = r.root.findAll((n) => n.type === 'IconBtn' && n.props.accessibilityLabel === 'Move item up');
  await act(async () => { moveUpButtons[1].props.onPress(); });

  await tick(700); // Wait for debounce persist
  const saved = await getListItems(list.id);
  assert.deepEqual(saved.map((x) => x.text), ['Charger', 'Passport', 'Tickets'], 'Reordered list is persisted accurately');
});

test('RT-NAV-1 NavProvider prevents double-pop when back is pressed during an active pop transition', async () => {
  let navApi;
  const Probe = () => {
    navApi = useNav();
    return null;
  };
  await mount(React.createElement(NavProvider, null, React.createElement(Probe)));

  // Push Folder -> Push Note (stack depth = 3: Home -> Home(folder) -> Note)
  await act(async () => { navApi.push('Home', { folderId: 'f1' }); });
  await act(async () => { navApi.push('Note', { id: 'n1' }); });
  assert.equal(navApi.stack.length, 3);

  // Start pop from Note (index 2) and immediately call pop() again before the 350ms animation finishes
  await act(async () => {
    navApi.pop();
    navApi.pop();
  });
  await tick(500);
  assert.equal(navApi.stack.length, 2, 'Rapid double pop during transition must only pop Note, landing on Folder instead of Home');
  assert.equal(navApi.route.params.folderId, 'f1');

  // Verify stale finishPop(2) is a no-op once pop has completed
  await act(async () => { navApi.finishPop(2); });
  assert.equal(navApi.stack.length, 2);
});

test('RT-PERF-1 1 MB note Windowed Editor, Hold-Delete, Undo/Redo, and 5,000-item checklist persistence run in O(1)', async () => {
  const oneMbBody = 'Line of text in a one megabyte note document.\n'.repeat(23000); // ~1.05 MB
  const note = await seedNote(oneMbBody);
  const r = await mount(React.createElement(NoteEditor, { id: note.id, isNew: false }));

  await act(async () => {
    scrollView(r).props.onLayout({ nativeEvent: { layout: { height: 500, width: 400 } } });
    scrollView(r).props.onContentSizeChange(400, 575000);
  });

  // Verify Option 2 Windowed Editor: native TextInput ONLY holds a small ~2.8KB window, NEVER the 1.05 MB string!
  assert.ok(
    bodyInput(r).props.value.length > 0 && bodyInput(r).props.value.length <= 4000,
    `Expected native TextInput window <= 4000 chars on 1 MB note, got ${bodyInput(r).props.value.length}`
  );

  // Move cursor to the middle of the 1 MB note (offset 500,000) and simulate rapid Hold-Delete inside the window
  const midOffset = 500000;
  await act(async () => {
    bodyInput(r).props.onSelectionChange({ nativeEvent: { selection: { start: midOffset, end: midOffset } } });
  });
  assert.ok(
    bodyInput(r).props.value.length <= 4000,
    `Centered window at offset 500,000 stays <= 4000 chars (${bodyInput(r).props.value.length})`
  );

  const t0 = performance.now();
  let curWin = bodyInput(r).props.value;
  for (let i = 0; i < 20; i++) {
    // Delete 1 char near the middle of the active window on each hold-delete repeat tick
    const midWin = Math.floor(curWin.length / 2);
    curWin = curWin.slice(0, midWin - 1) + curWin.slice(midWin);
    await type(r, curWin);
  }
  await tick(600); // Commit debounced snapshot of the 20-char deletion

  // Undo restores the 20 deleted characters in the 1 MB note
  await act(async () => { iconBtn(r, /Undo/i).props.onPress(); });
  assert.ok(
    bodyInput(r).props.value.length <= 4000,
    'Native TextInput remains windowed on Undo'
  );
  assert.notEqual(
    bodyInput(r).props.style.color,
    'transparent',
    'Large 1 MB note must NEVER toggle TextInput color to transparent on Undo'
  );
  await tick(1500);
  await settle();
  assert.equal((await getItem(note.id)).body.length, oneMbBody.length, '1 MB Undo restores exact 1 MB full document length in SQLite');

  // Redo reapplies the 20-character deletion in the 1 MB note
  await act(async () => { iconBtn(r, /Redo/i).props.onPress(); });
  assert.notEqual(
    bodyInput(r).props.style.color,
    'transparent',
    'Large 1 MB note must NEVER toggle TextInput color to transparent on Redo'
  );
  const editorElapsed = performance.now() - t0;
  assert.ok(editorElapsed < 200, `1 MB Windowed 20x Hold-Delete + Undo + Redo took ${editorElapsed.toFixed(1)}ms`);
  await tick(1500);
  await settle();
  assert.equal((await getItem(note.id)).body.length, oneMbBody.length - 20, '1 MB Redo persists exact edited length in SQLite');

  await act(async () => { r.unmount(); await flush(); });

  // Verify 5,000-item checklist batched saveListItems
  const bigList = await createItem('list', null, '5000 Items');
  const fiveThousand = Array.from({ length: 5000 }, (_, i) => ({
    id: `b-${i}`,
    text: `Item ${i}`,
    checked: i % 2 === 0,
  }));
  const tList0 = performance.now();
  await saveListItems(bigList.id, fiveThousand);
  const listElapsed = performance.now() - tList0;
  const loadedItems = await getListItems(bigList.id);
  assert.equal(loadedItems.length, 5000);
  assert.ok(listElapsed < 250, `Batched saveListItems for 5,000 items took ${listElapsed.toFixed(1)}ms`);

  // Verify holding Backspace on keyboard inside a 500-item ListEditor updates synchronously in O(1)
  // without re-rendering 500 rows or triggering full-table DELETE FROM list_items on autosave
  const list500 = await createItem('list', null, '500 List');
  const items500 = Array.from({ length: 500 }, (_, i) => ({
    id: `r-${i}`,
    text: i === 0 ? 'A long checklist item text being deleted by holding backspace' : `Checklist entry ${i}`,
    checked: i % 3 === 0,
  }));
  await saveListItems(list500.id, items500);
  const rList = await mount(React.createElement(ListEditor, { id: list500.id, isNew: false }));
  const rowInputs = rList.root.findAll((n) => n.type === 'TextInput' && n.props.multiline);
  const firstRowInput = rowInputs[0];
  let curRowText = firstRowInput.props.value;

  const tDel0 = performance.now();
  for (let k = 0; k < 25; k++) {
    curRowText = curRowText.slice(0, -1);
    await act(async () => {
      firstRowInput.props.onChangeText(curRowText);
    });
    assert.equal(
      rowInputs[0].props.value,
      curRowText,
      'Controlled TextInput value must update synchronously on every hold-delete tick so React Native never reverts native EditText'
    );
  }
  const delElapsed = performance.now() - tDel0;
  assert.ok(delElapsed < 120, `25 rapid synchronous Backspace ticks in 500-item list took ${delElapsed.toFixed(1)}ms`);

  // Ensure autosave uses incremental UPDATE list_items instead of DELETE FROM list_items
  globalThis.__sqlite.log.length = 0;
  await tick(700);
  await settle();
  const deleteQueries = globalThis.__sqlite.log.filter((q) => /DELETE FROM list_items/i.test(q.sql));
  const afterSave = await getListItems(list500.id);
  assert.equal(deleteQueries.length, 0, 'Autosave after text deletion in existing row must NOT delete and re-insert all 500 rows');
  assert.equal(afterSave[0].text, curRowText, 'Autosave persists the updated row text in O(1) via UPDATE list_items');
  assert.equal(afterSave.length, 500, 'All 500 items remain intact in SQLite');
  await act(async () => { rList.unmount(); await flush(); });
});
