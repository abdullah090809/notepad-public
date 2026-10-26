import * as SQLite from 'expo-sqlite';
import { SEALED_PREFIX, openText, sealText, setSealedDataProbe } from './vault';

export type ItemType = 'note' | 'list' | 'folder';

export type Item = {
  id: string;
  type: ItemType;
  parentId: string | null;
  title: string;
  body: string;
  locked: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

/** Item as shown on the dashboard: body is truncated to a short preview. */
export type DashItem = Item & { childCount: number; listTotal: number; listDone: number };

export type ListEntry = { id: string; text: string; checked: boolean };

export type Revision = {
  id: number;
  itemId: string;
  title: string;
  body: string;
  savedAt: number;
};

type Row = {
  id: string;
  type: ItemType;
  parent_id: string | null;
  title: string;
  body: string;
  locked: number;
  position: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

type DashRow = Row & { child_count: number; list_total: number; list_done: number };

type ListItemRow = {
  id: string;
  list_id: string;
  text: string;
  checked: number;
  position: number;
};

type RevisionRow = {
  id: number;
  item_id: string;
  title: string;
  body: string;
  saved_at: number;
};

const toItem = (r: Row): Item => ({
  id: r.id,
  type: r.type,
  parentId: r.parent_id,
  title: r.title,
  body: r.body,
  locked: !!r.locked,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

const toDash = (r: DashRow): DashItem => ({
  ...toItem(r),
  childCount: r.child_count,
  listTotal: r.list_total,
  listDone: r.list_done,
});

/* ---------- Read-Only Guard & DB Change Notifications ---------- */

let readOnlyChecker: (() => boolean) | null = null;

export function setReadOnlyGuard(checker: (() => boolean) | null): void {
  readOnlyChecker = checker;
}

export function isDbReadOnly(): boolean {
  try {
    return !!(readOnlyChecker && readOnlyChecker());
  } catch {
    return false;
  }
}

export class ReadOnlyError extends Error {
  constructor(message = 'Cannot modify data while Read-Only Mode is active') {
    super(message);
    this.name = 'ReadOnlyError';
  }
}

function assertNotReadOnly(): void {
  if (isDbReadOnly()) {
    throw new ReadOnlyError();
  }
}

type DbListener = () => void;
const changeListeners = new Set<DbListener>();

export function subscribeToDbChanges(listener: DbListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function notifyDbChange(): void {
  changeListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // ignore listener error
    }
  });
}

/* ---------- Database Initialization & Connection ---------- */

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let rawDb: SQLite.SQLiteDatabase | null = null;
/** Set while a write transaction is open. Other writes wait for it (see runWriteTransaction). */
let activeTx: Promise<void> | null = null;

/**
 * The connection handed to callers. expo-sqlite's withTransactionAsync is NOT exclusive: any other write issued
 * on the same connection while a transaction is open becomes part of it (and is rolled back with it), and a second
 * BEGIN fails. So plain writes (runAsync/execAsync) wait until the open transaction has finished. Reads are not delayed.
 */
function gateWrites(raw: SQLite.SQLiteDatabase): SQLite.SQLiteDatabase {
  return new Proxy(raw, {
    get(target, prop) {
      const v = (target as any)[prop];
      if (typeof v !== 'function') return v;
      if (prop === 'runAsync' || prop === 'execAsync' || prop === 'withTransactionAsync') {
        return async (...args: unknown[]) => {
          while (activeTx) await activeTx;
          return v.apply(target, args);
        };
      }
      return v.bind(target);
    },
  });
}

/**
 * Runs `task` in one transaction, one at a time. Inside `task`, ALL queries must use the `tx` argument
 * (the raw connection); using the normal db object from getDb() inside would wait for this very transaction.
 * A failure rolls back everything the task wrote and is re-thrown, exactly like withTransactionAsync.
 */
async function runWriteTransaction(task: (tx: SQLite.SQLiteDatabase) => Promise<void>): Promise<void> {
  await getDb();
  const raw = rawDb as SQLite.SQLiteDatabase;
  while (activeTx) await activeTx;
  let release!: () => void;
  activeTx = new Promise<void>((res) => {
    release = res;
  });
  try {
    await raw.withTransactionAsync(() => task(raw));
  } finally {
    activeTx = null;
    release();
  }
}

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    const p = init().then((raw) => {
      rawDb = raw;
      return gateWrites(raw);
    });
    dbPromise = p;
    // A failed open must not be cached forever: forget it so the next call retries.
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
  }
  return dbPromise;
}

async function init(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('notepad.db');
  try {
    await createSchema(db);
  } catch (e) {
    // Do not leak a half-initialised connection when the next call retries.
    try {
      await db.closeAsync();
    } catch {
      // ignore
    }
    throw e;
  }
  return db;
}

async function createSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY NOT NULL,
      v TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      locked INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_items_parent ON items (parent_id);
    CREATE INDEX IF NOT EXISTS idx_items_parent_del ON items (parent_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_items_deleted ON items (deleted_at, position, created_at);
    CREATE INDEX IF NOT EXISTS idx_items_type_del ON items (type, deleted_at);

    CREATE TABLE IF NOT EXISTS list_items (
      id TEXT PRIMARY KEY NOT NULL,
      list_id TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      checked INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items (list_id);
    CREATE INDEX IF NOT EXISTS idx_list_items_list_checked ON list_items (list_id, checked);
    CREATE INDEX IF NOT EXISTS idx_list_items_list_pos ON list_items (list_id, position);

    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      saved_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_item ON revisions (item_id);
    CREATE INDEX IF NOT EXISTS idx_revisions_item_saved ON revisions (item_id, saved_at);
  `);
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ---------- key/value (settings) ---------- */

export async function getKv(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ v: string | null }>('SELECT v FROM kv WHERE k = ?', [key]);
  return row ? row.v : null;
}

export async function setKv(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [key, value]);
}

/* ---------- locked items are stored encrypted (see vault.ts) ---------- */

setSealedDataProbe(async () => {
  const db = await getDb();
  const n = SEALED_PREFIX.length;
  for (const sql of [
    'SELECT 1 AS x FROM items WHERE substr(body, 1, ?) = ? LIMIT 1',
    'SELECT 1 AS x FROM list_items WHERE substr(text, 1, ?) = ? LIMIT 1',
    'SELECT 1 AS x FROM revisions WHERE substr(body, 1, ?) = ? LIMIT 1',
  ]) {
    if (await db.getFirstAsync(sql, [n, SEALED_PREFIX])) return true;
  }
  return false;
});

async function isLockedItem(id: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ locked: number }>('SELECT locked FROM items WHERE id = ?', [id]);
  return !!r && r.locked === 1;
}

async function sealEntries(entries: ListEntry[]): Promise<ListEntry[]> {
  const out: ListEntry[] = [];
  for (let i = 0; i < entries.length; i += 50) {
    const part = entries.slice(i, i + 50);
    out.push(...(await Promise.all(part.map(async (e) => ({ ...e, text: await sealText(e.text) })))));
  }
  return out;
}

/**
 * Locks or unlocks items AND converts everything stored for them (note text, list entries, revisions)
 * in one transaction: locked -> encrypted, unlocked -> plain. Safe to repeat (already-converted text is left alone).
 */
async function convertLockState(ids: string[], locked: boolean): Promise<void> {
  if (ids.length === 0) return;
  const conv = (t: string) => (locked ? sealText(t) : openText(t));
  await runWriteTransaction(async (tx) => {
    const chunkSize = 150;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const part = ids.slice(i, i + chunkSize);
      const ph = part.map(() => '?').join(',');
      const items = await tx.getAllAsync<{ id: string; body: string }>(
        `SELECT id, body FROM items WHERE id IN (${ph})`,
        part
      );
      for (const it of items) {
        const nb = await conv(it.body);
        if (nb !== it.body) await tx.runAsync('UPDATE items SET body = ? WHERE id = ?', [nb, it.id]);
      }
      const lis = await tx.getAllAsync<{ id: string; list_id: string; text: string }>(
        `SELECT id, list_id, text FROM list_items WHERE list_id IN (${ph})`,
        part
      );
      for (const li of lis) {
        const nt = await conv(li.text);
        if (nt !== li.text) {
          await tx.runAsync('UPDATE list_items SET text = ? WHERE id = ? AND list_id = ?', [nt, li.id, li.list_id]);
        }
      }
      const revs = await tx.getAllAsync<{ id: number; body: string }>(
        `SELECT id, body FROM revisions WHERE item_id IN (${ph})`,
        part
      );
      for (const r of revs) {
        const nb = await conv(r.body);
        if (nb !== r.body) await tx.runAsync('UPDATE revisions SET body = ? WHERE id = ?', [nb, r.id]);
      }
      await tx.runAsync(`UPDATE items SET locked = ? WHERE id IN (${ph})`, [locked ? 1 : 0, ...part]);
    }
  });
}

/**
 * One-time (per install) clean-up: items that were locked before encryption existed are sealed now.
 * Best effort: if it fails it is retried on the next start and the error is returned to the caller.
 */
export async function sealExistingLockedItems(): Promise<void> {
  if (isDbReadOnly()) return;
  if ((await getKv('vault.sealed.v1')) === '1') return;
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM items WHERE locked = 1');
  if (rows.length > 0) await convertLockState(rows.map((r) => r.id), true);
  await setKv('vault.sealed.v1', '1');
  if (rows.length > 0) {
    // Old plain text can linger in freed database pages; compact the file to scrub it.
    try {
      await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
      await db.execAsync('VACUUM');
    } catch {
      // not critical
    }
  }
}

/* ---------- reading items ---------- */

// Subqueries only execute for the relevant item type: folders count children, lists count items
const DASH_COLS = `
  i.id, i.type, i.parent_id, i.title,
  CASE WHEN i.locked = 1 THEN '' ELSE substr(i.body, 1, 160) END AS body,
  i.locked,
  i.position, i.created_at, i.updated_at, i.deleted_at,
  CASE WHEN i.type = 'folder' THEN (SELECT COUNT(*) FROM items c WHERE c.parent_id = i.id AND c.deleted_at IS NULL) ELSE 0 END AS child_count,
  CASE WHEN i.type = 'list' THEN (SELECT COUNT(*) FROM list_items l WHERE l.list_id = i.id) ELSE 0 END AS list_total,
  CASE WHEN i.type = 'list' THEN (SELECT COUNT(*) FROM list_items l WHERE l.list_id = i.id AND l.checked = 1) ELSE 0 END AS list_done
`;

export async function listChildren(parentId: string | null): Promise<DashItem[]> {
  const db = await getDb();
  const where = parentId === null ? 'i.parent_id IS NULL' : 'i.parent_id = ?';
  const rows = await db.getAllAsync<DashRow>(
    `SELECT ${DASH_COLS} FROM items i
     WHERE i.deleted_at IS NULL AND ${where}
     ORDER BY i.position ASC, i.created_at ASC`,
    parentId === null ? [] : [parentId]
  );
  return rows.map(toDash);
}

/** At most this many search results are returned (the Home screen tells the user when the limit was reached). */
export const SEARCH_LIMIT = 300;

/**
 * GLOB pattern that matches `text` anywhere, ignoring case for ALL letters (SQLite's LIKE/lower() only fold ASCII,
 * so "école" would not find "École"). Each letter becomes a [xX] class; GLOB wildcards in the text are escaped.
 */
export function caseInsensitiveContainsGlob(text: string): string {
  let out = '*';
  for (const ch of text) {
    if (ch === '*' || ch === '?' || ch === '[') {
      out += '[' + ch + ']';
      continue;
    }
    const variants = new Set<string>([ch]);
    for (const v of [ch.toLowerCase(), ch.toUpperCase()]) if ([...v].length === 1) variants.add(v);
    out += variants.size > 1 ? '[' + [...variants].join('') + ']' : ch;
  }
  return out + '*';
}

export async function searchItems(query: string): Promise<DashItem[]> {
  const db = await getDb();
  const clean = query.trim();
  if (!clean) return [];
  // ASCII-only queries keep the original LIKE (fast on very large notes). LIKE only folds ASCII case, so queries
  // containing other letters (é, ж, ü ...) use the per-letter GLOB pattern instead.
  const ascii = /^[\x00-\x7f]*$/.test(clean);
  const like = ascii ? '%' + clean.replace(/[\\%_]/g, (m) => '\\' + m) + '%' : caseInsensitiveContainsGlob(clean);
  const MATCH = ascii ? "LIKE ? ESCAPE '\\'" : 'GLOB ?';
  const rows = await db.getAllAsync<DashRow>(
    `SELECT
       i.id, i.type, i.parent_id, i.title,
       CASE
         WHEN i.locked = 1 THEN ''
         WHEN i.type = 'list' THEN COALESCE(
           (SELECT li.text FROM list_items li WHERE li.list_id = i.id AND li.text ${MATCH} ORDER BY li.position ASC LIMIT 1),
           ''
         )
         WHEN instr(lower(i.body), lower(?)) > 0 THEN substr(i.body, max(1, instr(lower(i.body), lower(?)) - 60), 220)
         ELSE substr(i.body, 1, 160)
       END AS body,
       i.locked, i.position, i.created_at, i.updated_at, i.deleted_at,
       CASE WHEN i.type = 'folder' THEN (SELECT COUNT(*) FROM items c WHERE c.parent_id = i.id AND c.deleted_at IS NULL) ELSE 0 END AS child_count,
       CASE WHEN i.type = 'list' THEN (SELECT COUNT(*) FROM list_items l WHERE l.list_id = i.id) ELSE 0 END AS list_total,
       CASE WHEN i.type = 'list' THEN (SELECT COUNT(*) FROM list_items l WHERE l.list_id = i.id AND l.checked = 1) ELSE 0 END AS list_done
     FROM items i
     WHERE i.deleted_at IS NULL
       AND (
         i.title ${MATCH}
         OR (i.locked = 0 AND i.body ${MATCH})
         OR (i.locked = 0 AND i.type = 'list' AND EXISTS (SELECT 1 FROM list_items li WHERE li.list_id = i.id AND li.text ${MATCH}))
       )
     ORDER BY i.updated_at DESC
     LIMIT ${SEARCH_LIMIT}`,
    [like, clean, clean, like, like, like]
  );
  return rows.map(toDash);
}

export async function getItem(id: string): Promise<Item | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Row>('SELECT * FROM items WHERE id = ?', [id]);
  if (!row) return null;
  const item = toItem(row);
  item.body = await openText(item.body);
  return item;
}

export async function listAllFolders(): Promise<
  { id: string; title: string; parentId: string | null }[]
> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; title: string; parent_id: string | null }>(
    "SELECT id, title, parent_id FROM items WHERE type = 'folder' AND deleted_at IS NULL ORDER BY title"
  );
  return rows.map((r) => ({ id: r.id, title: r.title, parentId: r.parent_id }));
}

/* ---------- writing items ---------- */

async function nextPosition(parentId: string | null): Promise<number> {
  const db = await getDb();
  const where = parentId === null ? 'parent_id IS NULL' : 'parent_id = ?';
  const row = await db.getFirstAsync<{ m: number | null }>(
    `SELECT MAX(position) AS m FROM items WHERE ${where}`,
    parentId === null ? [] : [parentId]
  );
  return (row && row.m !== null ? row.m : -1) + 1;
}

export async function createItem(
  type: ItemType,
  parentId: string | null,
  title = '',
  body = ''
): Promise<Item> {
  assertNotReadOnly();
  const db = await getDb();
  const now = Date.now();
  const id = newId();
  const position = await nextPosition(parentId);
  await db.runAsync(
    `INSERT INTO items (id, type, parent_id, title, body, locked, position, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, NULL)`,
    [id, type, parentId, title, body, position, now, now]
  );
  notifyDbChange();
  return {
    id,
    type,
    parentId,
    title,
    body,
    locked: false,
    position,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export async function updateItem(
  id: string,
  patch: { title?: string; body?: string; locked?: boolean },
  touch = true
): Promise<void> {
  assertNotReadOnly();
  const db = await getDb();
  if (patch.locked !== undefined) await convertLockState([id], patch.locked);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    vals.push(patch.title);
  }
  if (patch.body !== undefined) {
    const locked = patch.locked !== undefined ? patch.locked : await isLockedItem(id);
    sets.push('body = ?');
    vals.push(locked ? await sealText(patch.body) : patch.body);
  }
  if (patch.locked !== undefined) {
    sets.push('locked = ?');
    vals.push(patch.locked ? 1 : 0);
  }
  if (touch) {
    sets.push('updated_at = ?');
    vals.push(Date.now());
  }
  if (sets.length === 0) return;
  vals.push(id);
  await db.runAsync(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`, vals);
  notifyDbChange();
}

export async function batchUpdateLock(ids: string[], locked: boolean): Promise<void> {
  assertNotReadOnly();
  if (ids.length === 0) return;
  await convertLockState(ids, locked);
  notifyDbChange();
}

export async function setPositions(ids: string[]): Promise<void> {
  assertNotReadOnly();
  if (ids.length === 0) return;
  const db = await getDb();
  await runWriteTransaction(async (db) => {
    if (ids.length <= 20) {
      for (let i = 0; i < ids.length; i++) {
        await db.runAsync('UPDATE items SET position = ? WHERE id = ?', [i, ids[i]]);
      }
    } else {
      const chunkSize = 150;
      for (let start = 0; start < ids.length; start += chunkSize) {
        const end = Math.min(ids.length, start + chunkSize);
        const cases: string[] = [];
        const inPlaceholders: string[] = [];
        const params: (string | number)[] = [];
        for (let i = start; i < end; i++) {
          cases.push('WHEN ? THEN ?');
          params.push(ids[i], i);
        }
        for (let i = start; i < end; i++) {
          inPlaceholders.push('?');
          params.push(ids[i]);
        }
        await db.runAsync(
          `UPDATE items SET position = CASE id ${cases.join(' ')} ELSE position END WHERE id IN (${inPlaceholders.join(',')})`,
          params
        );
      }
    }
  });
  notifyDbChange();
}

export async function moveItems(ids: string[], parentId: string | null): Promise<void> {
  assertNotReadOnly();
  const db = await getDb();

  // Validate that parentId is not among the items being moved or their descendants
  if (parentId !== null) {
    const movedSet = new Set(ids);
    if (movedSet.has(parentId)) throw new Error('Cannot move an item into itself');

    // Check descendants of moved items (one recursive query per chunk of moved items)
    const chunkSize = 150;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const descendants = await db.getAllAsync<{ id: string }>(
        `WITH RECURSIVE d(id) AS (
           SELECT id FROM items WHERE id IN (${placeholders})
           UNION ALL
           SELECT i.id FROM items i JOIN d ON i.parent_id = d.id
         )
         SELECT id FROM d WHERE id = ?`,
        [...chunk, parentId]
      );
      if (descendants.length > 0) throw new Error('Cannot move a folder into one of its own subfolders');
    }
  }

  await runWriteTransaction(async (db) => {
    // Each moved item (in the given order) takes the next free slot at the end of the target: base, base+1, ...
    // An id that does not exist moves nothing and does not use up a slot.
    const where = parentId === null ? 'parent_id IS NULL' : 'parent_id = ?';
    const maxRow = await db.getFirstAsync<{ m: number | null }>(
      `SELECT MAX(position) AS m FROM items WHERE ${where}`,
      parentId === null ? [] : [parentId]
    );
    const base = (maxRow && maxRow.m !== null ? maxRow.m : -1) + 1;
    const chunkSize = 150;
    const existing = new Set<string>();
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const rows = await db.getAllAsync<{ id: string }>(
        `SELECT id FROM items WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk
      );
      rows.forEach((r) => existing.add(r.id));
    }
    const slot = new Map<string, number>(); // a repeated id keeps its last slot, like the one-by-one version
    let k = 0;
    for (const id of ids) {
      if (id === parentId || !existing.has(id)) continue;
      slot.set(id, base + k);
      k++;
    }
    const entries = [...slot.entries()];
    for (let start = 0; start < entries.length; start += chunkSize) {
      const part = entries.slice(start, start + chunkSize);
      const cases: string[] = [];
      const params: (string | number | null)[] = [parentId];
      for (const [id, pos] of part) {
        cases.push('WHEN ? THEN ?');
        params.push(id, pos);
      }
      for (const [id] of part) params.push(id);
      await db.runAsync(
        `UPDATE items SET parent_id = ?, position = CASE id ${cases.join(' ')} END WHERE id IN (${part
          .map(() => '?')
          .join(',')})`,
        params
      );
    }
  });
  notifyDbChange();
}

/* ---------- trash ---------- */

const SUBTREE = `WITH RECURSIVE d(id) AS (
  SELECT id FROM items WHERE id = ?
  UNION ALL
  SELECT i.id FROM items i JOIN d ON i.parent_id = d.id
)`;

export async function softDelete(ids: string[]): Promise<void> {
  assertNotReadOnly();
  if (ids.length === 0) return;
  const db = await getDb();
  const now = Date.now();
  await runWriteTransaction(async (db) => {
    if (ids.length <= 20) {
      for (const id of ids) {
        await db.runAsync(
          `${SUBTREE} UPDATE items SET deleted_at = ? WHERE id IN (SELECT id FROM d) AND deleted_at IS NULL`,
          [id, now]
        );
      }
    } else {
      const chunkSize = 150;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        await db.runAsync(
          `WITH RECURSIVE d(id) AS (
             SELECT id FROM items WHERE id IN (${placeholders})
             UNION ALL
             SELECT i.id FROM items i JOIN d ON i.parent_id = d.id
           )
           UPDATE items SET deleted_at = ? WHERE id IN (SELECT id FROM d) AND deleted_at IS NULL`,
          [...chunk, now]
        );
      }
    }
  });
  notifyDbChange();
}

/**
 * Set-based restore for large selections whose items are independent of each other (none is inside another's
 * subtree), where the order of restoring cannot matter. Returns false WITHOUT writing anything when the selection
 * is not independent; the caller then uses the one-by-one version, which defines the exact semantics.
 */
async function restoreIndependentSetBased(db: SQLite.SQLiteDatabase, ids: string[]): Promise<boolean> {
  const chunkSize = 150;
  const idSet = new Set(ids);
  const unique = [...idSet];
  const roots: { id: string; parent_id: string | null }[] = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const rows = await db.getAllAsync<{ id: string; deleted_at: number | null; parent_id: string | null }>(
      `SELECT id, deleted_at, parent_id FROM items WHERE id IN (${chunk.map(() => '?').join(',')})`,
      chunk
    );
    for (const r of rows) if (r.deleted_at !== null) roots.push({ id: r.id, parent_id: r.parent_id });
  }
  const cteFor = (n: number) => `WITH RECURSIVE d(id, root, ts) AS (
      SELECT id, id, deleted_at FROM items WHERE id IN (${new Array(n).fill('?').join(',')})
      UNION ALL
      SELECT i.id, d.root, d.ts FROM items i JOIN d ON i.parent_id = d.id
    )`;
  // independence check: no selected item may sit inside another selected item's subtree
  for (let i = 0; i < roots.length; i += chunkSize) {
    const chunk = roots.slice(i, i + chunkSize).map((r) => r.id);
    const inner = await db.getAllAsync<{ id: string }>(`${cteFor(chunk.length)} SELECT id FROM d WHERE id != root`, chunk);
    if (inner.some((r) => idSet.has(r.id))) return false;
  }
  // a root whose parent is itself part of the selection is not independent either
  if (roots.some((r) => r.parent_id !== null && idSet.has(r.parent_id))) return false;
  for (let i = 0; i < roots.length; i += chunkSize) {
    const chunk = roots.slice(i, i + chunkSize).map((r) => r.id);
    await db.runAsync(
      `${cteFor(chunk.length)} UPDATE items SET deleted_at = NULL WHERE (id, deleted_at) IN (SELECT id, ts FROM d)`,
      chunk
    );
    await db.runAsync(
      `UPDATE items SET parent_id = NULL
       WHERE id IN (${chunk.map(() => '?').join(',')}) AND parent_id IS NOT NULL AND parent_id != ''
         AND NOT EXISTS (SELECT 1 FROM items p WHERE p.id = items.parent_id AND p.deleted_at IS NULL)`,
      chunk
    );
  }
  return true;
}

export async function restoreItems(ids: string[]): Promise<void> {
  assertNotReadOnly();
  const db = await getDb();
  await runWriteTransaction(async (db) => {
    if (ids.length > 20 && (await restoreIndependentSetBased(db, ids))) return;
    for (const id of ids) {
      const r = await db.getFirstAsync<{ deleted_at: number | null; parent_id: string | null }>(
        'SELECT deleted_at, parent_id FROM items WHERE id = ?',
        [id]
      );
      if (!r || r.deleted_at === null) continue;
      await db.runAsync(
        `${SUBTREE} UPDATE items SET deleted_at = NULL WHERE id IN (SELECT id FROM d) AND deleted_at = ?`,
        [id, r.deleted_at]
      );
      if (r.parent_id) {
        const p = await db.getFirstAsync<{ deleted_at: number | null }>(
          'SELECT deleted_at FROM items WHERE id = ?',
          [r.parent_id]
        );
        if (!p || p.deleted_at !== null) {
          await db.runAsync('UPDATE items SET parent_id = NULL WHERE id = ?', [id]);
        }
      }
    }
  });
  notifyDbChange();
}

export async function deleteForever(ids: string[]): Promise<void> {
  assertNotReadOnly();
  if (ids.length === 0) return;
  const db = await getDb();
  await runWriteTransaction(async (db) => {
    if (ids.length <= 20) {
      for (const id of ids) {
        await db.runAsync(`${SUBTREE} DELETE FROM kv WHERE k IN (SELECT 'ro:' || id FROM d)`, [id]);
        await db.runAsync(`${SUBTREE} DELETE FROM list_items WHERE list_id IN (SELECT id FROM d)`, [
          id,
        ]);
        await db.runAsync(`${SUBTREE} DELETE FROM revisions WHERE item_id IN (SELECT id FROM d)`, [
          id,
        ]);
        await db.runAsync(`${SUBTREE} DELETE FROM items WHERE id IN (SELECT id FROM d)`, [id]);
      }
    } else {
      const chunkSize = 150;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const cte = `WITH RECURSIVE d(id) AS (
          SELECT id FROM items WHERE id IN (${placeholders})
          UNION ALL
          SELECT i.id FROM items i JOIN d ON i.parent_id = d.id
        )`;
        await db.runAsync(`${cte} DELETE FROM kv WHERE k IN (SELECT 'ro:' || id FROM d)`, chunk);
        await db.runAsync(`${cte} DELETE FROM list_items WHERE list_id IN (SELECT id FROM d)`, chunk);
        await db.runAsync(`${cte} DELETE FROM revisions WHERE item_id IN (SELECT id FROM d)`, chunk);
        await db.runAsync(`${cte} DELETE FROM items WHERE id IN (SELECT id FROM d)`, chunk);
      }
    }
  });
  notifyDbChange();
}

export async function listDeleted(): Promise<DashItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<DashRow>(
    `SELECT ${DASH_COLS} FROM items i
     WHERE i.deleted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM items p WHERE p.id = i.parent_id AND p.deleted_at = i.deleted_at)
     ORDER BY i.deleted_at DESC`
  );
  return rows.map(toDash);
}

/** days <= 0 means "never delete automatically". */
export async function purgeDeleted(days: number): Promise<void> {
  if (days <= 0 || isDbReadOnly()) return;
  const cutoff = Date.now() - days * 86400000;
  const roots = await listDeleted();
  const old = roots.filter((r) => r.deletedAt !== null && r.deletedAt < cutoff).map((r) => r.id);
  if (old.length) await deleteForever(old);
}

/* ---------- checklist entries ---------- */

export async function getListItems(listId: string): Promise<ListEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ListItemRow>(
    'SELECT * FROM list_items WHERE list_id = ? ORDER BY position ASC',
    [listId]
  );
  const out: ListEntry[] = [];
  for (const r of rows) out.push({ id: r.id, text: await openText(r.text), checked: !!r.checked });
  return out;
}

type SqlRunner = Pick<SQLite.SQLiteDatabase, 'runAsync'>;

/** Inserts list entries (positions 0..n-1). Caller owns the transaction. */
async function insertListEntries(exec: SqlRunner, listId: string, entries: ListEntry[]): Promise<void> {
  if (entries.length <= 20) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      await exec.runAsync(
        'INSERT INTO list_items (id, list_id, text, checked, position) VALUES (?, ?, ?, ?, ?)',
        [e.id, listId, e.text, e.checked ? 1 : 0, i]
      );
    }
  } else {
    const batchSize = 100;
    for (let start = 0; start < entries.length; start += batchSize) {
      const end = Math.min(entries.length, start + batchSize);
      const placeholders: string[] = [];
      const params: (string | number)[] = [];
      for (let i = start; i < end; i++) {
        const e = entries[i];
        placeholders.push('(?, ?, ?, ?, ?)');
        params.push(e.id, listId, e.text, e.checked ? 1 : 0, i);
      }
      await exec.runAsync(
        `INSERT INTO list_items (id, list_id, text, checked, position) VALUES ${placeholders.join(',')}`,
        params
      );
    }
  }
}

export async function saveListItems(listId: string, entries: ListEntry[]): Promise<void> {
  assertNotReadOnly();
  const db = await getDb();
  const toStore = (await isLockedItem(listId)) ? await sealEntries(entries) : entries;
  await runWriteTransaction(async (db) => {
    await db.runAsync('DELETE FROM list_items WHERE list_id = ?', [listId]);
    await insertListEntries(db, listId, toStore);
  });
  notifyDbChange();
}

export async function updateListItemsIncremental(
  listId: string,
  entries: ListEntry[]
): Promise<void> {
  assertNotReadOnly();
  if (entries.length === 0) return;
  const db = await getDb();
  if (await isLockedItem(listId)) entries = await sealEntries(entries);
  if (entries.length === 1) {
    const e = entries[0];
    await db.runAsync(
      'UPDATE list_items SET text = ?, checked = ? WHERE id = ? AND list_id = ?',
      [e.text, e.checked ? 1 : 0, e.id, listId]
    );
  } else {
    await runWriteTransaction(async (db) => {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        await db.runAsync(
          'UPDATE list_items SET text = ?, checked = ? WHERE id = ? AND list_id = ?',
          [e.text, e.checked ? 1 : 0, e.id, listId]
        );
      }
    });
  }
  notifyDbChange();
}

/* ---------- revisions ---------- */

/** Inserts one revision row and keeps only the newest 50 for the item. Caller owns any transaction. */
async function insertRevisionRow(exec: SqlRunner, itemId: string, title: string, body: string): Promise<void> {
  await exec.runAsync(
    'INSERT INTO revisions (item_id, title, body, saved_at) VALUES (?, ?, ?, ?)',
    [itemId, title, body, Date.now()]
  );
  await exec.runAsync(
    `DELETE FROM revisions WHERE item_id = ? AND id NOT IN (
       SELECT id FROM revisions WHERE item_id = ? ORDER BY id DESC LIMIT 50
     )`,
    [itemId, itemId]
  );
}

export async function addRevision(itemId: string, title: string, body: string): Promise<void> {
  if (isDbReadOnly()) return;
  const db = await getDb();
  const stored = (await isLockedItem(itemId)) ? await sealText(body) : body;
  await insertRevisionRow(db, itemId, title, stored);
}

/**
 * Restores an earlier version in ONE transaction: (1) saves `snapshot` of the current state as a new
 * revision, (2) writes the restored content, (3) updates the title. If any step fails, nothing is applied
 * (no half-restored list, no stray revision).
 *  - note: pass `body` (restored text)
 *  - list: pass `entries` (restored entries)
 */
export async function restoreRevision(args: {
  id: string;
  snapshot: { title: string; body: string } | null;
  title: string;
  body?: string;
  entries?: ListEntry[];
}): Promise<void> {
  assertNotReadOnly();
  const db = await getDb();
  const lockedItem = await isLockedItem(args.id);
  const snapBody = args.snapshot && lockedItem ? await sealText(args.snapshot.body) : args.snapshot?.body ?? '';
  const entriesToStore = args.entries && lockedItem ? await sealEntries(args.entries) : args.entries;
  const bodyToStore = lockedItem ? await sealText(args.body ?? '') : args.body ?? '';
  await runWriteTransaction(async (db) => {
    if (args.snapshot) await insertRevisionRow(db, args.id, args.snapshot.title, snapBody);
    if (entriesToStore) {
      await db.runAsync('DELETE FROM list_items WHERE list_id = ?', [args.id]);
      await insertListEntries(db, args.id, entriesToStore);
      await db.runAsync('UPDATE items SET title = ?, updated_at = ? WHERE id = ?', [args.title, Date.now(), args.id]);
    } else {
      await db.runAsync('UPDATE items SET title = ?, body = ?, updated_at = ? WHERE id = ?', [
        args.title,
        bodyToStore,
        Date.now(),
        args.id,
      ]);
    }
  });
  notifyDbChange();
}

export async function listRevisions(itemId: string): Promise<Revision[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<RevisionRow>(
    'SELECT * FROM revisions WHERE item_id = ? ORDER BY id DESC',
    [itemId]
  );
  const out: Revision[] = [];
  for (const r of rows) {
    out.push({ id: r.id, itemId: r.item_id, title: r.title, body: await openText(r.body), savedAt: r.saved_at });
  }
  return out;
}

export async function deleteAllRevisions(): Promise<void> {
  assertNotReadOnly();
  const db = await getDb();
  await db.runAsync('DELETE FROM revisions');
  notifyDbChange();
}

/* ---------- export / import ---------- */

export type BackupListItem = {
  listId: string;
  id: string;
  text: string;
  checked: boolean;
  position: number;
};

export type BackupData = {
  app: 'notepad';
  version: 1;
  exportedAt: number;
  items: Item[];
  listItems: BackupListItem[];
  revisions?: Revision[];
};

export async function exportAll(includeRevisions: boolean): Promise<BackupData> {
  const db = await getDb();
  const items = (
    await db.getAllAsync<Row>('SELECT * FROM items WHERE deleted_at IS NULL ORDER BY position ASC')
  ).map(toItem);
  for (const it of items) it.body = await openText(it.body);
  const listRows = await db.getAllAsync<ListItemRow>(
    `SELECT * FROM list_items WHERE list_id IN (SELECT id FROM items WHERE deleted_at IS NULL)
     ORDER BY list_id, position`
  );
  const data: BackupData = {
    app: 'notepad',
    version: 1,
    exportedAt: Date.now(),
    items,
    listItems: [],
  };
  for (const r of listRows) {
    data.listItems.push({
      listId: r.list_id,
      id: r.id,
      text: await openText(r.text),
      checked: !!r.checked,
      position: r.position,
    });
  }
  if (includeRevisions) {
    const revRows = await db.getAllAsync<RevisionRow>(
      `SELECT * FROM revisions WHERE item_id IN (SELECT id FROM items WHERE deleted_at IS NULL)
       ORDER BY id ASC`
    );
    data.revisions = [];
    for (const r of revRows) {
      data.revisions.push({
        id: r.id,
        itemId: r.item_id,
        title: r.title,
        body: await openText(r.body),
        savedAt: r.saved_at,
      });
    }
  }
  return data;
}

export type ValidationReport = {
  valid: boolean;
  error?: string;
  itemCount: number;
};

export function validateBackupData(x: unknown): ValidationReport {
  if (!x || typeof x !== 'object') {
    return { valid: false, error: 'Backup content is not a valid JSON object.', itemCount: 0 };
  }
  const o = x as Record<string, unknown>;
  if (o.app !== 'notepad') {
    return { valid: false, error: "The file is not a Notepad backup (missing 'app: notepad' signature).", itemCount: 0 };
  }
  if (!Array.isArray(o.items)) {
    return { valid: false, error: "Backup file is missing an 'items' array.", itemCount: 0 };
  }
  const ids = new Set<string>();
  for (let i = 0; i < o.items.length; i++) {
    const it = o.items[i];
    if (!it || typeof it !== 'object') {
      return { valid: false, error: `Item at index ${i} is malformed.`, itemCount: 0 };
    }
    const id = String((it as any).id ?? '').trim();
    if (!id) {
      return { valid: false, error: `Item at index ${i} has an empty or missing ID.`, itemCount: 0 };
    }
    if (ids.has(id)) {
      return { valid: false, error: `Duplicate item ID '${id}' found in backup.`, itemCount: 0 };
    }
    ids.add(id);
  }

  // Detect circular folder references in backup
  const parentMap = new Map<string, string | null>();
  for (const it of o.items) {
    const itemObj = it as any;
    if (itemObj.parentId) {
      parentMap.set(String(itemObj.id), String(itemObj.parentId));
    }
  }
  for (const [startId] of parentMap) {
    let current: string | null | undefined = parentMap.get(startId);
    const visited = new Set<string>([startId]);
    while (current) {
      if (visited.has(current)) {
        return {
          valid: false,
          error: `Circular folder reference detected in backup involving item '${current}'.`,
          itemCount: 0,
        };
      }
      visited.add(current);
      current = parentMap.get(current);
    }
  }

  return { valid: true, itemCount: o.items.length };
}

export function isBackupData(x: unknown): x is BackupData {
  return validateBackupData(x).valid;
}

/** Returns how many items were added. */
export async function importAll(data: BackupData, replace: boolean): Promise<number> {
  assertNotReadOnly();
  const validation = validateBackupData(data);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid backup data format.');
  }

  const db = await getDb();
  let added = 0;
  await runWriteTransaction(async (db) => {
    if (replace) {
      await db.runAsync('DELETE FROM list_items');
      await db.runAsync('DELETE FROM revisions');
      await db.runAsync('DELETE FROM items');
      await db.runAsync("DELETE FROM kv WHERE k LIKE 'ro:%'");
    }
    const existing = new Set(
      (await db.getAllAsync<{ id: string }>('SELECT id FROM items')).map((r) => r.id)
    );
    const incomingIds = new Set(data.items.map((i) => String(i.id)));
    const inserted = new Set<string>();
    const lockedIds = new Set<string>();
    for (const it of data.items) {
      const id = String(it.id);
      if (existing.has(id)) continue;
      const type: ItemType = it.type === 'list' || it.type === 'folder' ? it.type : 'note';
      const parent =
        it.parentId && (incomingIds.has(String(it.parentId)) || existing.has(String(it.parentId)))
          ? String(it.parentId)
          : null;
      const now = Date.now();
      await db.runAsync(
        `INSERT INTO items (id, type, parent_id, title, body, locked, position, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          id,
          type,
          parent,
          String(it.title ?? ''),
          it.locked ? await sealText(String(it.body ?? '')) : String(it.body ?? ''),
          it.locked ? 1 : 0,
          Number(it.position) || 0,
          Number(it.createdAt) || now,
          Number(it.updatedAt) || now,
        ]
      );
      inserted.add(id);
      if (it.locked) lockedIds.add(id);
      added++;
    }
    for (const li of data.listItems ?? []) {
      if (!li || typeof li !== 'object') {
        throw new Error('Malformed list item in backup payload');
      }
      if (!inserted.has(String(li.listId))) continue;
      const liText = lockedIds.has(String(li.listId)) ? await sealText(String(li.text ?? '')) : String(li.text ?? '');
      const res = await db.runAsync(
        'INSERT OR IGNORE INTO list_items (id, list_id, text, checked, position) VALUES (?, ?, ?, ?, ?)',
        [String(li.id), String(li.listId), liText, li.checked ? 1 : 0, Number(li.position) || 0]
      );
      if (res.changes === 0) {
        await db.runAsync(
          'INSERT INTO list_items (id, list_id, text, checked, position) VALUES (?, ?, ?, ?, ?)',
          [newId(), String(li.listId), liText, li.checked ? 1 : 0, Number(li.position) || 0]
        );
      }
    }
    for (const r of data.revisions ?? []) {
      if (!r || typeof r !== 'object') {
        throw new Error('Malformed revision item in backup payload');
      }
      if (!inserted.has(String(r.itemId))) continue;
      await db.runAsync(
        'INSERT INTO revisions (item_id, title, body, saved_at) VALUES (?, ?, ?, ?)',
        [
          String(r.itemId),
          String(r.title ?? ''),
          lockedIds.has(String(r.itemId)) ? await sealText(String(r.body ?? '')) : String(r.body ?? ''),
          Number(r.savedAt) || Date.now(),
        ]
      );
    }
  });
  notifyDbChange();
  return added;
}

export async function countItems(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL'
  );
  return row ? row.c : 0;
}
