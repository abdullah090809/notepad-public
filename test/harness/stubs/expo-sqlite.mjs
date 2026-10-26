// expo-sqlite fake backed by Node's built-in SQLite (real SQL engine, in-memory).
// Fidelity limits (documented in the report): single synchronous connection; withTransactionAsync is
// BEGIN/COMMIT/ROLLBACK and does NOT reproduce expo-sqlite's native-thread interleaving.
import { DatabaseSync } from 'node:sqlite';

const state = (globalThis.__sqlite ??= { faults: [], log: [] });

function maybeFail(sql) {
  for (const f of state.faults) {
    if (f.times !== 0 && f.match.test(sql)) {
      if (f.times > 0) f.times -= 1;
      throw new Error(f.message ?? 'injected sqlite failure');
    }
  }
}

export async function openDatabaseAsync() {
  // Added for the audit regression tests: `state.failOpen = n` makes the next n opens reject.
  if (state.failOpen > 0) { state.failOpen -= 1; throw new Error('unable to open database file'); }
  const raw = new DatabaseSync(':memory:');
  state.raw = raw;
  return {
    // `state.failExec = n` makes the next n schema/exec calls reject; closeAsync is counted in `state.closed`.
    async execAsync(sql) { if (state.failExec > 0) { state.failExec -= 1; throw new Error('disk I/O error'); } raw.exec(sql); },
    async closeAsync() { state.closed = (state.closed ?? 0) + 1; },
    async runAsync(sql, params = []) {
      maybeFail(sql);
      if (state.trace) state.log.push({ sql: sql.replace(/\s+/g, ' ').slice(0, 90), params, stack: new Error().stack.split('\n').slice(2, 9).join('\n') });
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async getFirstAsync(sql, params = []) {
      maybeFail(sql);
      return raw.prepare(sql).get(...params) ?? null;
    },
    async getAllAsync(sql, params = []) {
      maybeFail(sql);
      if (state.traceReads) (state.reads ??= []).push(sql);   // added for the audit tests
      return raw.prepare(sql).all(...params);
    },
    async withTransactionAsync(fn) {
      raw.exec('BEGIN');
      try {
        await fn();
        raw.exec('COMMIT');
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch {}
        throw e;
      }
    },
  };
}
