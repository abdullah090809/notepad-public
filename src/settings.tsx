import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { getKv, setKv, setReadOnlyGuard } from './db';
import { CustomColors, DEFAULT_CUSTOM, ThemeId } from './theme';
import { DateFormat, DEFAULT_EXPORT_TEMPLATE, ProgressType } from './format';

export type TextSize = 'xs' | 's' | 'm' | 'l' | 'xl' | 'xxl';

export type BackupLogEntry = {
  at: number;
  name: string;
  uri: string;
  items: number;
};

export type Settings = {
  /* app-wide read-only mode */
  readOnlyMode: boolean;
  /* theme */
  themeId: ThemeId;
  custom: CustomColors;
  /* general: dashboard */
  multilineTitles: boolean;
  showPreview: boolean;
  showModified: boolean;
  showSeconds: boolean;
  iconNotes: boolean;
  iconLists: boolean;
  chipsLists: boolean;
  iconFolders: boolean;
  ordering: 'custom' | 'alpha';
  /* general: revisions, lists, sharing, notes */
  saveRevisions: boolean;
  listCheckedToBottom: boolean;
  listUncheckedToTop: boolean;
  listProgressAbove: boolean;
  progressType: ProgressType;
  shareIncludeTitle: boolean;
  shareEmailSubject: boolean;
  openAtEnd: boolean;
  /* customisation */
  dateFormat: DateFormat;
  titleCaps: 'words' | 'sentences';
  orientation: 'auto' | 'portrait' | 'landscape';
  keepAwake: boolean;
  navBarMatch: boolean;
  dashFont: string;
  inputFont: string;
  textSize: TextSize;
  splashAnimation: boolean;
  /* security */
  fingerprint: boolean;
  inactivitySeconds: number;
  resetHours: number;
  hideInBackground: boolean;
  /* data management */
  deletedAfterDays: number;
  includeRevisionsInExport: boolean;
  exportNameTemplate: string;
  backupFrequencyDays: number;
  lastBackupAt: number | null;
  backupLog: BackupLogEntry[];
};

export const DEFAULT_SETTINGS: Settings = {
  readOnlyMode: false,
  themeId: 'dark',
  custom: DEFAULT_CUSTOM,
  multilineTitles: false,
  showPreview: false,
  showModified: false,
  showSeconds: false,
  iconNotes: true,
  iconLists: true,
  chipsLists: true,
  iconFolders: true,
  ordering: 'custom',
  saveRevisions: true,
  listCheckedToBottom: false,
  listUncheckedToTop: false,
  listProgressAbove: false,
  progressType: 'percent',
  shareIncludeTitle: false,
  shareEmailSubject: true,
  openAtEnd: false,
  dateFormat: 'DMY',
  titleCaps: 'words',
  orientation: 'auto',
  keepAwake: false,
  navBarMatch: false,
  dashFont: 'default',
  inputFont: 'default',
  textSize: 'm',
  splashAnimation: true,
  fingerprint: false,
  inactivitySeconds: 5,
  resetHours: 24,
  hideInBackground: false,
  deletedAfterDays: 30,
  includeRevisionsInExport: true,
  exportNameTemplate: DEFAULT_EXPORT_TEMPLATE,
  backupFrequencyDays: 7,
  lastBackupAt: null,
  backupLog: [],
};

type Ctx = {
  s: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Always returns the latest settings, even from inside async callbacks. */
  get: () => Settings;
  /** True once the saved settings were read successfully (or none exist yet). */
  hydrated: boolean;
};

const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<Settings>(DEFAULT_SETTINGS);
  const hydrated = useRef(false);
  const saveFailNotified = useRef(false);
  const [hydratedOk, setHydratedOk] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      let raw: string | null = null;
      try {
        raw = await getKv('settings');
        if (raw && alive) {
          const parsed = JSON.parse(raw) as Partial<Settings>;
          const merged: Settings = {
            ...DEFAULT_SETTINGS,
            ...parsed,
            custom: { ...DEFAULT_CUSTOM, ...(parsed.custom ?? {}) },
          };
          ref.current = merged;
          setS(merged);
        }
        // Only now are the stored settings known to be readable, so only now may update() write them.
        hydrated.current = true;
        if (alive) setHydratedOk(true);
      } catch {
        // Keep running on defaults, but never write them over the stored settings (see update()).
        // If the row was read but could not be parsed, keep a copy of the raw text for recovery.
        if (raw) {
          try {
            await setKv('settings.bak', raw);
          } catch {
            // best effort: the original row is untouched either way
          }
        }
        if (alive) {
          Alert.alert(
            'Could not read your settings',
            'The app is using default settings and will not save changes until it is restarted.'
          );
        }
      } finally {
        if (alive) {
          setReadOnlyGuard(() => ref.current.readOnlyMode);
          setLoaded(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    const next = { ...ref.current, ...patch };
    ref.current = next;
    setS(next);
    setReadOnlyGuard(() => next.readOnlyMode);
    if (hydrated.current) {
      setKv('settings', JSON.stringify(next))
        .then(() => {
          saveFailNotified.current = false;
        })
        .catch(() => {
          // Tell the user once per failure streak (not on every toggle), so a setting that did not
          // persist is never silently reverted after a restart.
          if (saveFailNotified.current) return;
          saveFailNotified.current = true;
          Alert.alert(
            'Could not save your settings',
            'Your change is applied for now, but it may be lost when the app restarts.'
          );
        });
    }
  }, []);

  const get = useCallback(() => ref.current, []);

  const value = useMemo(() => ({ s, update, get, hydrated: hydratedOk }), [s, update, get, hydratedOk]);

  if (!loaded) return null;
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const c = useContext(SettingsContext);
  if (!c) throw new Error('useSettings must be used inside SettingsProvider');
  return c;
}

export function useReadOnly(): { isReadOnly: boolean; setReadOnly: (v: boolean) => void } {
  const { s, update } = useSettings();
  const setReadOnly = useCallback((v: boolean) => update({ readOnlyMode: v }), [update]);
  return { isReadOnly: s.readOnlyMode, setReadOnly };
}
