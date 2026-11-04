import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  BackHandler,
  Easing,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

function PopupMenu({
  top,
  theme,
  children,
}: {
  top: number;
  theme: any;
  children: React.ReactNode;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 160,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      useNativeDriver: true,
    }).start();
  }, [anim]);

  return (
    <Animated.View
      style={{
        position: 'absolute',
        top,
        right: 12,
        backgroundColor: theme.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.border,
        minWidth: 250,
        paddingVertical: 6,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 8,
        elevation: 12,
        zIndex: 999,
        opacity: anim,
        transform: [
          {
            scale: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [0.97, 1],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppearance } from '../appearance';
import {
  ListEntry,
  addRevision,
  deleteForever,
  getItem,
  getListItems,
  newId,
  saveListItems,
  updateListItemsIncremental,
  restoreItems,
  softDelete,
  subscribeToDbChanges,
  updateItem,
} from '../db';
import { progressColor, progressText, serializeListRevision } from '../format';
import { useNav } from '../nav';
import { withExternalUi } from '../security';
import { useReadOnly, useSettings } from '../settings';
import { useAppLocked } from '../gate';
import { Header, IconBtn, IconName, Screen, T, confirm, toast } from '../ui';

function hasNonWhitespace(s: string): boolean {
  for (let i = 0, len = s.length; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 10 && c !== 13 && c !== 9) return true;
  }
  return false;
}

function computeListCounts(list: ListEntry[]): { done: number; total: number } {
  let d = 0;
  let t = 0;
  for (let i = 0, len = list.length; i < len; i++) {
    if (hasNonWhitespace(list[i].text)) {
      t++;
      if (list[i].checked) d++;
    }
  }
  return { done: d, total: t };
}

export function sortEntries(entries: ListEntry[], toBottom: boolean, toTop = false): ListEntry[] {
  if (!toBottom && !toTop) return entries;
  // Stable partition: unchecked first when "checked to bottom" is on.
  if (toBottom) {
    return [...entries.filter((e) => !e.checked), ...entries.filter((e) => e.checked)];
  }
  return entries;
}

type ListRowProps = {
  item: ListEntry;
  isFirst: boolean;
  isLast: boolean;
  isReadOnly: boolean;
  theme: any;
  scale: number;
  inputFont?: string;
  onToggle: (id: string) => void;
  onChangeText: (id: string, text: string) => void;
  onAddAfter: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
  setInputRef: (id: string, r: TextInput | null) => void;
  onFocusLast: () => void;
};

const ListRow = React.memo(
  function ListRow({
    item: e,
    isFirst,
    isLast,
    isReadOnly,
    theme,
    scale,
    inputFont,
    onToggle,
    onChangeText,
    onAddAfter,
    onMove,
    onRemove,
    setInputRef,
    onFocusLast,
  }: ListRowProps) {
    const [localText, setLocalText] = useState(e.text);
    const latestTextRef = useRef(e.text);

    useEffect(() => {
      if (e.text !== latestTextRef.current) {
        latestTextRef.current = e.text;
        setLocalText(e.text);
      }
    }, [e.text]);

    const bindRef = useCallback(
      (r: TextInput | null) => {
        setInputRef(e.id, r);
      },
      [e.id, setInputRef]
    );

    const handleTextChange = useCallback(
      (t: string) => {
        latestTextRef.current = t;
        setLocalText(t);
        onChangeText(e.id, t);
      },
      [e.id, onChangeText]
    );

    const handleToggle = useCallback(() => onToggle(e.id), [e.id, onToggle]);
    const handleSubmit = useCallback(() => onAddAfter(e.id), [e.id, onAddAfter]);
    const handleMoveUp = useCallback(() => onMove(e.id, -1), [e.id, onMove]);
    const handleMoveDown = useCallback(() => onMove(e.id, 1), [e.id, onMove]);
    const handleRemove = useCallback(() => onRemove(e.id), [e.id, onRemove]);

    const rowStyle = useMemo(
      () => ({
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        paddingLeft: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.border,
      }),
      [theme.border]
    );

    const inputStyle = useMemo(
      () => ({
        flex: 1,
        color: e.checked ? theme.subtext : theme.text,
        textDecorationLine: (e.checked ? 'line-through' : 'none') as 'line-through' | 'none',
        fontFamily: inputFont,
        fontSize: 17 * scale,
        paddingVertical: 12,
        paddingHorizontal: 6,
      }),
      [e.checked, theme.subtext, theme.text, inputFont, scale]
    );

    const appLocked = useAppLocked();

    return (
      <View style={rowStyle}>
        <Pressable
          onPress={handleToggle}
          disabled={isReadOnly}
          accessibilityRole="checkbox"
          accessibilityLabel={hasNonWhitespace(e.text) ? e.text : 'List item'}
          accessibilityState={{ checked: e.checked, disabled: isReadOnly }}
          hitSlop={6}
          style={{ padding: 8, opacity: isReadOnly ? 0.7 : 1 }}
        >
          <Ionicons
            pointerEvents="none"
            name={e.checked ? 'checkbox' : 'square-outline'}
            size={28}
            color={e.checked ? theme.accent : theme.text}
          />
        </Pressable>
        <TextInput
          ref={bindRef}
          value={localText}
          onChangeText={handleTextChange}
          placeholder={isReadOnly ? '' : 'List item'}
          placeholderTextColor={theme.subtext}
          editable={!isReadOnly && !appLocked}
          multiline
          textBreakStrategy="simple"
          blurOnSubmit
          onSubmitEditing={handleSubmit}
          onFocus={isLast ? onFocusLast : undefined}
          style={inputStyle}
        />
        {!isReadOnly ? (
          <>
            <IconBtn
              name="arrow-up"
              size={20}
              onPress={handleMoveUp}
              disabled={isFirst}
              accessibilityLabel="Move item up"
            />
            <IconBtn
              name="arrow-down"
              size={20}
              onPress={handleMoveDown}
              disabled={isLast}
              accessibilityLabel="Move item down"
            />
            <IconBtn
              name="close"
              size={22}
              onPress={handleRemove}
              accessibilityLabel="Remove item"
            />
          </>
        ) : null}
      </View>
    );
  },
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.item.text === next.item.text &&
    prev.item.checked === next.item.checked &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast &&
    prev.isReadOnly === next.isReadOnly &&
    prev.theme === next.theme &&
    prev.scale === next.scale &&
    prev.inputFont === next.inputFont
);

export function ListEditor({ id, isNew }: { id: string; isNew: boolean }) {
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { theme, scale, inputFont } = useAppearance();
  const { s, get } = useSettings();
  const { isReadOnly } = useReadOnly();
  const appLocked = useAppLocked();

  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState('');
  const [entries, setEntries] = useState<ListEntry[]>([]);
  const [counts, setCounts] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const baseContainerHeightRef = useRef(0);

  const titleRef = useRef('');
  const entriesRef = useRef<ListEntry[]>([]);
  const indexByIdRef = useRef<Map<string, number>>(new Map());
  const original = useRef('');
  const dirty = useRef(false);
  const structureDirtyRef = useRef(false);
  const dirtyRowIdsRef = useRef<Set<string>>(new Set());
  const isSelfSavingRef = useRef(false);
  const revSaved = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaving = useRef(false);
  const hasPoppedRef = useRef(false);
  const inputs = useRef<Record<string, TextInput | null>>({});
  const flatListRef = useRef<FlatList<ListEntry>>(null);

  const rebuildIndexMap = useCallback((list: ListEntry[]) => {
    const map = new Map<string, number>();
    for (let i = 0, len = list.length; i < len; i++) {
      map.set(list[i].id, i);
    }
    indexByIdRef.current = map;
  }, []);

  const setInputRef = useCallback((eid: string, r: TextInput | null) => {
    if (r) {
      inputs.current[eid] = r;
    } else {
      delete inputs.current[eid];
    }
  }, []);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        setKeyboardHeight(e.endCoordinates?.height ?? 0);
      }
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardHeight(0);
      }
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const osShrink =
    keyboardHeight > 0 && baseContainerHeightRef.current > 0 && containerHeight > 0
      ? Math.max(0, baseContainerHeightRef.current - containerHeight)
      : 0;
  const effectiveKbPadding =
    keyboardHeight > 0 ? Math.max(0, keyboardHeight - osShrink) : 0;

  const serialize = useCallback(
    (t: string, e: ListEntry[]) => serializeListRevision(t, e),
    []
  );

  /* Clear dirty state if read-only is activated, after saving pending changes */
  useEffect(() => {
    if (isReadOnly) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      dirty.current = false;
    }
  }, [isReadOnly]);

  /* Parallel load */
  useEffect(() => {
    let alive = true;
    (async () => {
      let loadedData: [Awaited<ReturnType<typeof getItem>>, ListEntry[]];
      try {
        loadedData = await Promise.all([getItem(id), getListItems(id)]);
      } catch {
        // e.g. a locked list that cannot be decrypted: leave the stored data untouched and go back
        if (alive) {
          toast('Could not open this list. Your data was not changed.');
          nav.pop();
        }
        return;
      }
      const [it, rows] = loadedData;
      if (!alive) return;
      if (!it) {
        nav.pop();
        return;
      }
      titleRef.current = it.title;
      entriesRef.current = rows;
      rebuildIndexMap(rows);
      structureDirtyRef.current = rows.some((r) => !hasNonWhitespace(r.text));
      dirtyRowIdsRef.current.clear();
      original.current = serialize(it.title, rows);
      setTitle(it.title);
      setEntries(rows);
      setCounts(computeListCounts(rows));
      setLoaded(true);
      if (isNew && rows.length === 0 && !isReadOnly) {
        const first: ListEntry = { id: newId(), text: '', checked: false };
        entriesRef.current = [first];
        rebuildIndexMap([first]);
        structureDirtyRef.current = true;
        setEntries([first]);
        setCounts({ done: 0, total: 0 });
        setFocusId(first.id);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const reloadFromDbIfModified = useCallback(() => {
    if (!loaded || isSelfSavingRef.current) return;
    Promise.all([getItem(id), getListItems(id)])
      .then(([it, rows]) => {
        if (it && !dirty.current && !isSelfSavingRef.current) {
          const currentSerialized = serialize(titleRef.current, entriesRef.current);
          const dbSerialized = serialize(it.title, rows);
          if (currentSerialized !== dbSerialized) {
            titleRef.current = it.title;
            entriesRef.current = rows;
            rebuildIndexMap(rows);
            structureDirtyRef.current = rows.some((r) => !hasNonWhitespace(r.text));
            dirtyRowIdsRef.current.clear();
            original.current = dbSerialized;
            setTitle(it.title);
            setEntries(rows);
            setCounts(computeListCounts(rows));
            dirty.current = false;
          }
        }
      })
      .catch(() => {});
  }, [loaded, id, serialize, rebuildIndexMap]);

  // Reload if list was modified in background (e.g. revision restored)
  useEffect(() => {
    if (!loaded) return;
    if (nav?.route?.name === 'List' && nav?.route?.params?.id === id) {
      reloadFromDbIfModified();
    }
  }, [nav?.route, loaded, id, reloadFromDbIfModified]);

  useEffect(() => {
    if (!loaded) return;
    return subscribeToDbChanges(() => {
      if (!dirty.current && !isSelfSavingRef.current) {
        reloadFromDbIfModified();
      }
    });
  }, [loaded, reloadFromDbIfModified]);

  const persist = useCallback(async () => {
    if (isReadOnly) {
      dirty.current = false;
      return true;
    }
    if (!dirty.current) return true;
    dirty.current = false;
    isSelfSavingRef.current = true;
    const wasStructureDirty = structureDirtyRef.current;
    const pendingRowIds = Array.from(dirtyRowIdsRef.current);
    structureDirtyRef.current = false;
    dirtyRowIdsRef.current.clear();
    try {
      const t = titleRef.current;
      if (
        !revSaved.current &&
        get().saveRevisions &&
        hasNonWhitespace(original.current)
      ) {
        const e = entriesRef.current.filter((x) => hasNonWhitespace(x.text));
        const now = serialize(t, e);
        if (original.current !== now) {
          await addRevision(id, titleRef.current, original.current);
          revSaved.current = true;
        }
      }
      if (!wasStructureDirty && pendingRowIds.length > 0) {
        const cur = entriesRef.current;
        const idxMap = indexByIdRef.current;
        const changedEntries: ListEntry[] = [];
        for (let i = 0; i < pendingRowIds.length; i++) {
          const rid = pendingRowIds[i];
          const idx = idxMap.get(rid) ?? cur.findIndex((x) => x.id === rid);
          if (idx >= 0 && cur[idx]) {
            changedEntries.push(cur[idx]);
          }
        }
        await updateListItemsIncremental(id, changedEntries);
      } else if (wasStructureDirty) {
        const e = entriesRef.current.filter((x) => hasNonWhitespace(x.text));
        await saveListItems(id, e);
      }
      await updateItem(id, { title: t });
      return true;
    } catch {
      dirty.current = true;
      if (wasStructureDirty) {
        structureDirtyRef.current = true;
      }
      for (let i = 0; i < pendingRowIds.length; i++) {
        dirtyRowIdsRef.current.add(pendingRowIds[i]);
      }
      return false;
    } finally {
      isSelfSavingRef.current = false;
    }
  }, [id, get, isReadOnly, serialize]);

  const scheduleSave = useCallback(() => {
    if (isReadOnly) return;
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      persist();
    }, 600);
  }, [persist, isReadOnly]);

  const saveWarned = useRef(false);
  useEffect(() => {
    // Saves started by backgrounding the app / closing the screen have nobody waiting for them, so a
    // failure must be reported here (once per failure streak) instead of being dropped.
    const persistOrWarn = () => {
      void persist().then((ok) => {
        if (ok) {
          saveWarned.current = false;
        } else if (!saveWarned.current) {
          saveWarned.current = true;
          Alert.alert('Could not save your list', 'Your latest changes may not have been saved. Please open the list and check it.');
        }
      });
    };
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' && !isReadOnly) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        persistOrWarn();
      }
    });
    return () => {
      sub.remove();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (!isReadOnly) persistOrWarn();
    };
  }, [persist, isReadOnly]);

  const leave = useCallback(async () => {
    if (hasPoppedRef.current) {
      nav.pop({ immediate: true });
      return;
    }
    if (leaving.current) {
      return;
    }
    leaving.current = true;
    const resetTimer = setTimeout(() => {
      leaving.current = false;
    }, 800);

    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (!isReadOnly) {
      const saved = await persist();
      if (!saved) {
        clearTimeout(resetTimer);
        leaving.current = false;
        Alert.alert('Could not save your list', 'Your changes are still on screen. Please try again.');
        return;
      }
      if (
        isNew &&
        !hasNonWhitespace(titleRef.current) &&
        entriesRef.current.every((e) => !hasNonWhitespace(e.text))
      ) {
        try {
          await deleteForever([id]);
        } catch {
          // ignore
        }
      }
    }
    clearTimeout(resetTimer);
    if (!hasPoppedRef.current) {
      hasPoppedRef.current = true;
      nav.pop();
    }
  }, [persist, isNew, id, nav, isReadOnly]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (menuOpen) setMenuOpen(false);
      else leave();
      return true;
    });
    return () => sub.remove();
  }, [menuOpen, leave]);

  useEffect(() => {
    if (focusId) {
      const targetId = focusId;
      const t = setTimeout(() => {
        inputs.current[targetId]?.focus();
        setFocusId(null);
      }, 50);
      return () => clearTimeout(t);
    }
  }, [focusId]);

  const setAll = useCallback(
    (next: ListEntry[]) => {
      if (isReadOnly) return;
      structureDirtyRef.current = true;
      entriesRef.current = next;
      rebuildIndexMap(next);
      setEntries(next);
      setCounts(computeListCounts(next));
      scheduleSave();
    },
    [isReadOnly, rebuildIndexMap, scheduleSave]
  );

  const changeTitle = useCallback(
    (t: string) => {
      if (isReadOnly) return;
      titleRef.current = t;
      setTitle(t);
      scheduleSave();
    },
    [isReadOnly, scheduleSave]
  );

  /* O(1) text update: mutates entriesRef in place without re-rendering FlatList or sibling rows */
  const changeText = useCallback(
    (eid: string, text: string) => {
      if (isReadOnly) return;
      const cur = entriesRef.current;
      let idx = indexByIdRef.current.get(eid);
      if (idx === undefined || cur[idx]?.id !== eid) {
        idx = cur.findIndex((e) => e.id === eid);
        if (idx >= 0) indexByIdRef.current.set(eid, idx);
      }
      if (idx === undefined || idx < 0) return;

      const prev = cur[idx];
      const wasNonEmpty = hasNonWhitespace(prev.text);
      const isNowNonEmpty = hasNonWhitespace(text);

      cur[idx] = { ...prev, text };
      if (wasNonEmpty !== isNowNonEmpty) {
        structureDirtyRef.current = true;
        const delta = isNowNonEmpty ? 1 : -1;
        setCounts((c) => ({
          total: Math.max(0, c.total + delta),
          done: prev.checked ? Math.max(0, c.done + delta) : c.done,
        }));
      } else if (isNowNonEmpty) {
        dirtyRowIdsRef.current.add(eid);
      }
      scheduleSave();
    },
    [isReadOnly, scheduleSave]
  );

  const toggle = useCallback(
    (eid: string) => {
      if (isReadOnly) return;
      const cur = entriesRef.current;
      let idx = indexByIdRef.current.get(eid);
      if (idx === undefined || cur[idx]?.id !== eid) {
        idx = cur.findIndex((e) => e.id === eid);
      }
      if (idx < 0) return;
      const updated: ListEntry = { ...cur[idx], checked: !cur[idx].checked };
      const cfg = get();
      let next: ListEntry[];
      if (updated.checked && cfg.listCheckedToBottom) {
        next = [...cur.slice(0, idx), ...cur.slice(idx + 1), updated];
      } else if (!updated.checked && cfg.listUncheckedToTop) {
        next = [updated, ...cur.slice(0, idx), ...cur.slice(idx + 1)];
      } else {
        next = cur.slice();
        next[idx] = updated;
      }
      setAll(next);
    },
    [isReadOnly, get, setAll]
  );

  const addAfter = useCallback(
    (afterId: string | null) => {
      if (isReadOnly) return;
      const fresh: ListEntry = { id: newId(), text: '', checked: false };
      const cur = entriesRef.current;
      let next: ListEntry[];
      let newIdx = cur.length;
      if (afterId === null) {
        next = [...cur, fresh];
      } else {
        const idx = indexByIdRef.current.get(afterId) ?? cur.findIndex((e) => e.id === afterId);
        newIdx = idx >= 0 ? idx + 1 : cur.length;
        next = idx >= 0 ? [...cur.slice(0, idx + 1), fresh, ...cur.slice(idx + 1)] : [...cur, fresh];
      }
      setAll(next);
      setFocusId(fresh.id);
      if (afterId === null || newIdx >= cur.length) {
        setTimeout(() => {
          flatListRef.current?.scrollToEnd({ animated: true });
        }, 40);
      }
    },
    [isReadOnly, setAll]
  );

  const removeEntry = useCallback(
    (eid: string) => {
      if (isReadOnly) return;
      const cur = entriesRef.current;
      const idx = indexByIdRef.current.get(eid) ?? cur.findIndex((e) => e.id === eid);
      if (idx < 0) return;
      const next = [...cur.slice(0, idx), ...cur.slice(idx + 1)];
      setAll(next);
    },
    [isReadOnly, setAll]
  );

  const move = useCallback(
    (eid: string, dir: -1 | 1) => {
      if (isReadOnly) return;
      const cur = entriesRef.current;
      const i = indexByIdRef.current.get(eid) ?? cur.findIndex((e) => e.id === eid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return;
      const next = cur.slice();
      [next[i], next[j]] = [next[j], next[i]];
      setAll(next);
    },
    [isReadOnly, setAll]
  );

  const clearChecked = () => {
    setMenuOpen(false);
    if (isReadOnly) {
      Alert.alert('Read-Only Mode', 'Cannot remove items while Read-Only Mode is active.');
      return;
    }
    confirm('Remove checked items?', 'All ticked items will be removed from this list.', 'Remove', () => {
      setAll(entriesRef.current.filter((e) => !e.checked));
    });
  };

  const uncheckAll = () => {
    setMenuOpen(false);
    if (isReadOnly) {
      Alert.alert('Read-Only Mode', 'Cannot uncheck items while Read-Only Mode is active.');
      return;
    }
    setAll(entriesRef.current.map((e) => (e.checked ? { ...e, checked: false } : e)));
  };

  const shareList = async () => {
    setMenuOpen(false);
    const t = titleRef.current.trim();
    const lines = entriesRef.current
      .filter((e) => hasNonWhitespace(e.text))
      .map((e) => `${e.checked ? '[x]' : '[ ]'} ${e.text}`)
      .join('\n');
    const message = (get().shareIncludeTitle && t ? t + '\n\n' : '') + lines;
    const subject = get().shareEmailSubject && t ? t : undefined;
    try {
      await withExternalUi(() => Share.share({ message, title: subject }, { subject }));
    } catch {
      // cancelled
    }
  };

  const removeList = () => {
    setMenuOpen(false);
    if (isReadOnly) {
      Alert.alert('Read-Only Mode', 'Cannot delete lists while Read-Only Mode is active.');
      return;
    }
    confirm(
      'Delete list?',
      'It will be moved to Deleted Items.',
      'Delete',
      async () => {
        leaving.current = true;
        try {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          await persist();
          await softDelete([id]);
          nav.pop();
          toast('List moved to Deleted Items', {
            label: 'Undo',
            onPress: () => {
              restoreItems([id]).catch(() => toast('Could not undo'));
            },
          });
        } catch {
          leaving.current = false;
          Alert.alert('Could not delete the list', 'Please try again.');
        }
      },
      true
    );
  };

  const openRevisions = async () => {
    setMenuOpen(false);
    if (!isReadOnly && saveTimer.current) clearTimeout(saveTimer.current);
    if (!isReadOnly && !(await persist())) {
      Alert.alert('Could not save your list', 'Please try again before opening the version history.');
      return;
    }
    nav.push('Revisions', { id });
  };

  const scrollToTop = () => {
    setMenuOpen(false);
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
  };

  const scrollToEnd = () => {
    setMenuOpen(false);
    flatListRef.current?.scrollToEnd({ animated: true });
  };

  const shown = useMemo(
    () => sortEntries(entries, false, false),
    [entries]
  );

  const { done, total } = counts;
  const shownLen = shown.length;

  const keyExtractor = useCallback((e: ListEntry) => e.id, []);

  /* Tapping the last item: once the keyboard has opened, bring the list to its end so the last item
     sits fully above the keyboard with the "Add item" row under it (instead of a little too high). */
  const focusLastRow = useCallback(() => {
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 350);
  }, []);

  const renderItem = useCallback(
    ({ item: e, index: i }: { item: ListEntry; index: number }) => (
      <ListRow
        item={e}
        isFirst={i === 0}
        isLast={i === shownLen - 1}
        isReadOnly={isReadOnly}
        theme={theme}
        scale={scale}
        inputFont={inputFont}
        onToggle={toggle}
        onChangeText={changeText}
        onAddAfter={addAfter}
        onMove={move}
        onRemove={removeEntry}
        setInputRef={setInputRef}
        onFocusLast={focusLastRow}
      />
    ),
    [
      shownLen,
      isReadOnly,
      theme,
      scale,
      inputFont,
      toggle,
      changeText,
      addAfter,
      move,
      removeEntry,
      setInputRef,
      focusLastRow,
    ]
  );

  if (!loaded) {
    return (
      <Screen>
        <Header onBack={nav.pop} />
      </Screen>
    );
  }

  const menuItem = (icon: IconName, label: string, fn: () => void, danger = false) => (
    <Pressable
      key={label}
      onPress={fn}
      android_ripple={{ color: theme.border }}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 18 }}
    >
      <Ionicons
        pointerEvents="none"
        name={icon}
        color={danger ? theme.danger : theme.text}
        size={22}
        style={{ width: 28, marginRight: 8 }}
      />
      <T pointerEvents="none" size={16} style={{ color: danger ? theme.danger : theme.text }}>
        {label}
      </T>
    </Pressable>
  );

  const progress = (
    <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: theme.border, overflow: 'hidden' }}>
          <View
            style={{
              height: 8,
              width: `${total > 0 ? (done / total) * 100 : 0}%`,
              backgroundColor: progressColor(done, total),
            }}
          />
        </View>
        <T size={14} bold style={{ marginLeft: 12 }}>
          {progressText(done, total, s.progressType)}
        </T>
      </View>
    </View>
  );

  const menuTop = insets.top + 56 + (isReadOnly ? 38 : 0);

  return (
    <Screen>
      <Header
        onBack={leave}
        center={false}
        right={
          <IconBtn
            name="build"
            onPress={() => setMenuOpen((v) => !v)}
            onLongPress={() => setMenuOpen((v) => !v)}
            accessibilityLabel="List options"
          />
        }
      >
        <TextInput
          value={title}
          onChangeText={changeTitle}
          placeholder="List title"
          placeholderTextColor={theme.subtext}
          autoCapitalize={s.titleCaps}
          autoFocus={isNew && entries.length === 0 && !isReadOnly}
          editable={!isReadOnly && !appLocked}
          style={{
            width: '100%',
            color: theme.text,
            fontFamily: inputFont,
            fontSize: 19 * scale,
            fontWeight: '700',
            paddingVertical: 6,
          }}
        />
      </Header>

      {s.listProgressAbove ? progress : null}

      <View
        style={{ flex: 1, paddingBottom: effectiveKbPadding }}
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          setContainerHeight(h);
          if (h > baseContainerHeightRef.current) {
            baseContainerHeightRef.current = h;
          }
        }}
      >
        <FlatList
          ref={flatListRef}
          data={shown}
          keyExtractor={keyExtractor}
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          updateCellsBatchingPeriod={16}
          windowSize={5}
          removeClippedSubviews={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 120 }}
          style={{ flex: 1 }}
          renderItem={renderItem}
          ListFooterComponent={
            <>
              {!isReadOnly ? (
                <Pressable
                  onPress={() => addAfter(null)}
                  style={{ flexDirection: 'row', alignItems: 'center', padding: 18 }}
                >
                  <Ionicons pointerEvents="none" name="add-circle-outline" size={28} color={theme.accent} />
                  <T pointerEvents="none" size={17} style={{ marginLeft: 14, color: theme.accent }} bold>
                    Add item
                  </T>
                </Pressable>
              ) : null}
              {!s.listProgressAbove ? progress : null}
            </>
          }
        />
      </View>

      {/* Floating options menu - clean anchored popover */}
      {menuOpen ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: 'transparent' }]}
            accessibilityLabel="Close menu"
            onPress={() => setMenuOpen(false)}
          />
          <PopupMenu top={menuTop} theme={theme}>
            {menuItem('arrow-up', 'Jump to top', scrollToTop)}
            {menuItem('arrow-down', 'Jump to bottom', scrollToEnd)}
            {menuItem('share-outline', 'Share', shareList)}
            {menuItem('square-outline', 'Uncheck all', uncheckAll)}
            {menuItem('checkmark-done-outline', 'Remove checked items', clearChecked)}
            {menuItem('time-outline', 'Revision history', openRevisions)}
            {menuItem('trash-outline', 'Delete list', removeList, true)}
          </PopupMenu>
        </View>
      ) : null}
    </Screen>
  );
}
