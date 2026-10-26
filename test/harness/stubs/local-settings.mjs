// Test double for src/settings.tsx (used by screens). IMPORTANT: identities are stable across renders,
// exactly like the real provider (get is useCallback([]), value is memoised). An unstable `get` would make the
// editors' persist() identity change every render and flush edits through effect cleanup, masking real bugs.
export const cfg = (globalThis.__cfg ??= {});
Object.assign(cfg, { saveRevisions: true, openAtEnd: false, readOnlyMode: false, titleCaps: 'sentences',
  shareIncludeTitle: true, shareEmailSubject: true });
const get = () => cfg;
const update = (p) => Object.assign(cfg, p);
const setReadOnly = (v) => { cfg.readOnlyMode = v; };
const settingsApi = { s: cfg, get, update };
export function useSettings() { return settingsApi; }
export function useReadOnly() { return { isReadOnly: !!cfg.readOnlyMode, setReadOnly }; }
