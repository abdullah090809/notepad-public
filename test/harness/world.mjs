// Shared test fixture: resets every fake + the real SQLite database between tests.
import { getDb, setReadOnlyGuard, subscribeToDbChanges } from '../../src/db.ts';

export async function resetWorld() {
  const sq = (globalThis.__sqlite ??= { faults: [], log: [] });
  sq.faults.length = 0;
  setReadOnlyGuard(null);
  const db = await getDb();
  await db.execAsync('DELETE FROM kv; DELETE FROM items; DELETE FROM list_items; DELETE FROM revisions;');
  const sec = (globalThis.__secure ??= { map: new Map() });
  sec.map.clear(); sec.failGet = null; sec.failSet = null;
  const vfs = (globalThis.__vfs ??= { files: new Map(), dirs: new Set() });
  vfs.files.clear(); vfs.dirs.clear(); vfs.failWrite = null;
  const rn = (globalThis.__rn ??= { alerts: [], appStateHandlers: new Set(), backHandlers: [], scrolls: [], keyboardListeners: new Map(), focusedInputs: [] });
  rn.alerts.length = 0;
  rn.scrolls = rn.scrolls ?? [];
  rn.scrolls.length = 0;
  rn.focusedInputs = rn.focusedInputs ?? [];
  rn.focusedInputs.length = 0;
  rn.keyboardListeners = rn.keyboardListeners ?? new Map();
  rn.keyboardListeners.clear();
  const ui = (globalThis.__ui ??= { toasts: [], confirms: [] });
  ui.toasts.length = 0; ui.confirms.length = 0;
  const nav = (globalThis.__nav ??= { pops: 0, pushes: [], stack: [], depth: 1 });
  nav.pops = 0; nav.pushes.length = 0; nav.stack = [];
  for (const k of Object.keys(globalThis.__cfg ?? {})) delete globalThis.__cfg[k];
  Object.assign(globalThis.__cfg ?? (globalThis.__cfg = {}), {
    saveRevisions: true, openAtEnd: false, readOnlyMode: false, titleCaps: 'sentences',
    shareIncludeTitle: true, shareEmailSubject: true, checkedToBottom: false, progressType: 'both',
  });
  globalThis.__picked = null;
}

/** Records every notifyDbChange() so tests can tell whether a write was announced. */
export function watchDbChanges() {
  let n = 0;
  const off = subscribeToDbChanges(() => { n += 1; });
  return { count: () => n, stop: off };
}

export async function rows(sql, params = []) {
  const db = await getDb();
  return db.getAllAsync(sql, params);
}
export const flush = () => new Promise((r) => setImmediate(r));
