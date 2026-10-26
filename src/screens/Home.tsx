import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  BackHandler,
  Easing,
  FlatList,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppearance } from '../appearance';
import { DraggableList } from '../DraggableList';
import {
  DashItem,
  Item,
  SEARCH_LIMIT,
  batchUpdateLock,
  createItem,
  getItem,
  listAllFolders,
  listChildren,
  moveItems,
  restoreItems,
  searchItems,
  setPositions,
  softDelete,
  subscribeToDbChanges,
  updateItem,
} from '../db';
import { formatDate, progressColor, progressText } from '../format';

const SEARCH_DEBOUNCE_MS = 150;
import { useGate } from '../gate';
import { useNav } from '../nav';
import { hasPassword } from '../security';
import { useReadOnly, useSettings } from '../settings';
import {
  FadeIn,
  Header,
  IconBtn,
  PressableScale,
  PickerModal,
  PromptModal,
  Screen,
  T,
  confirm,
  toast,
} from '../ui';

export function getSearchPreview(
  item: Pick<DashItem, 'type' | 'body' | 'locked'>,
  searchQuery?: string,
  showPreview = false
): string {
  if (item.locked) return '';
  const rawBody = item.body || '';
  if (!rawBody) return '';

  const cleanQuery = searchQuery?.trim() ?? '';
  if (cleanQuery.length > 0 && (item.type === 'note' || item.type === 'list')) {
    const needle = cleanQuery.toLowerCase();
    const lines = rawBody.split('\n');
    const matchedLine = lines.find((l) => l.toLowerCase().includes(needle));
    if (matchedLine) {
      const trimmed = matchedLine.trim();
      const matchPos = trimmed.toLowerCase().indexOf(needle);
      if (matchPos > 36 && trimmed.length > 64) {
        const start = Math.max(0, matchPos - 20);
        return (start > 0 ? '…' : '') + trimmed.slice(start, start + 100).trim();
      }
      return trimmed;
    }
  }

  if (item.type === 'note' && showPreview) {
    const lines = rawBody.split('\n');
    return (lines.find((l) => l.trim().length > 0) ?? '').trim();
  }
  return '';
}

export function highlightMatch(text: string, q?: string, defaultColor?: string) {
  if (!q || !q.trim()) return text;
  const needle = q.trim().toLowerCase();
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let last = 0;
  let idx = lower.indexOf(needle);
  let k = 0;
  while (idx !== -1) {
    if (idx > last) {
      parts.push(text.slice(last, idx));
    }
    parts.push(
      <Text
        key={k++}
        style={{
          backgroundColor: '#fef08a',
          color: '#854d0e',
          fontWeight: '700',
          borderRadius: 2,
        }}
      >
        {text.slice(idx, idx + needle.length)}
      </Text>
    );
    last = idx + needle.length;
    idx = lower.indexOf(needle, last);
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return <Text style={{ color: defaultColor }}>{parts}</Text>;
}

/* ---------- one dashboard row ---------- */

const HomeRow = React.memo(function HomeRow({
  item,
  handle,
  editMode,
  selected,
  searchQuery,
  onPress,
  onLongPress,
}: {
  item: DashItem;
  handle: React.ReactNode | null;
  editMode: boolean;
  selected: boolean;
  searchQuery?: string;
  onPress: (item: DashItem) => void;
  onLongPress: (item: DashItem) => void;
}) {
  const { theme } = useAppearance();
  const { s } = useSettings();

  const title = item.title.trim() ? item.title : item.type === 'folder' ? 'Untitled folder' : 'Untitled';
  const preview = useMemo(
    () => getSearchPreview(item, searchQuery, s.showPreview),
    [item, searchQuery, s.showPreview]
  );

  let leftIcon: React.ComponentProps<typeof Ionicons>['name'] | null = null;
  if (item.type === 'note' && s.iconNotes) leftIcon = 'create';
  if (item.type === 'list' && s.iconLists) leftIcon = 'checkbox-outline';
  if (item.type === 'folder' && s.iconFolders) leftIcon = 'folder';

  return (
    <Pressable
      onPress={() => onPress(item)}
      onLongPress={() => onLongPress(item)}
      android_ripple={{ color: theme.border }}
      accessibilityRole="button"
      accessibilityLabel={`${item.type}: ${title}`}
      style={({ pressed }) => ({
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 16,
        backgroundColor: selected || pressed ? theme.surface : theme.bg,
        borderBottomWidth: 1,
        borderBottomColor: theme.border,
      })}
    >
      {editMode ? (
        <Ionicons
          pointerEvents="none"
          name={selected ? 'checkbox' : 'square-outline'}
          size={26}
          color={selected ? theme.accent : theme.text}
          style={{ marginRight: 14 }}
        />
      ) : null}
      {leftIcon ? (
        <Ionicons pointerEvents="none" name={leftIcon} size={26} color={theme.text} style={{ marginRight: 16, width: 28 }} />
      ) : null}
      <View pointerEvents="none" style={{ flex: 1, paddingVertical: 6 }}>
        <T size={18} numberOfLines={s.multilineTitles ? 2 : 1}>
          {searchQuery ? highlightMatch(title, searchQuery, theme.text) : title}
        </T>
        {preview ? (
          <T size={14} dim numberOfLines={1}>
            {searchQuery ? highlightMatch(preview, searchQuery, theme.subtext) : preview}
          </T>
        ) : null}
        {s.showModified ? (
          <T size={13} dim numberOfLines={1}>
            {formatDate(item.updatedAt, s.dateFormat, true, s.showSeconds)}
          </T>
        ) : null}
      </View>
      {item.locked ? (
        <Ionicons pointerEvents="none" name="lock-closed" size={18} color={theme.subtext} style={{ marginRight: 8 }} />
      ) : null}
      {item.type === 'list' && s.iconLists ? (
        s.chipsLists ? (
          <View
            pointerEvents="none"
            style={{
              backgroundColor: progressColor(item.listDone, item.listTotal),
              borderRadius: 10,
              paddingHorizontal: 8,
              paddingVertical: 3,
              marginRight: 8,
            }}
          >
            <T size={13} bold style={{ color: '#ffffff' }}>
              {progressText(item.listDone, item.listTotal, s.progressType)}
            </T>
          </View>
        ) : (
          <T pointerEvents="none" size={14} dim style={{ marginRight: 8 }}>
            {progressText(item.listDone, item.listTotal, s.progressType)}
          </T>
        )
      ) : null}
      {item.type === 'folder' && s.iconFolders ? (
        <T pointerEvents="none" size={14} dim style={{ marginRight: 8 }}>
          {item.childCount}
        </T>
      ) : null}
      {handle ?? <View pointerEvents="none" style={{ width: 12 }} />}
    </Pressable>
  );
});

/* Last loaded rows per folder, so coming back to a screen paints instantly instead of flashing empty. */
const homeCache = new Map<string, DashItem[]>();

/* ---------- the screen ---------- */

export function HomeScreen({ folderId }: { folderId: string | null }) {
  const nav = useNav();
  const { theme, scale, inputFont } = useAppearance();
  const { s, get } = useSettings();
  const { isReadOnly, setReadOnly } = useReadOnly();
  const gate = useGate();
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState<DashItem[]>(() => homeCache.get(folderId ?? '') ?? []);
  const [folder, setFolder] = useState<Item | null>(null);
  const [searchOn, setSearchOn] = useState(false);
  const [query, setQuery] = useState('');
  // The typed text shows immediately; the database is queried ~150 ms after typing pauses. Clearing is instant.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    if (query.trim() === '') {
      setDebouncedQuery('');
      return;
    }
    const t = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);
  const activeQuery = query.trim() === '' ? '' : debouncedQuery;
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [fabOpen, setFabOpen] = useState(false);
  const [folderPrompt, setFolderPrompt] = useState(false);
  const [moveOptions, setMoveOptions] = useState<
    { label: string; value: string | null; depth?: number }[] | null
  >(null);

  const searching = searchOn && activeQuery.trim().length > 0;
  const isActiveRoute =
    !nav?.route ||
    (nav.route.name === 'Home' && (nav.route.params?.folderId ?? null) === (folderId ?? null));
  const isActiveRouteRef = useRef(isActiveRoute);
  isActiveRouteRef.current = isActiveRoute;
  const pendingReloadRef = useRef(false);

  // Parallel loading of folder info and child items
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    // Only the newest request may update the screen; a slow older one must not overwrite it.
    const seq = ++loadSeq.current;
    pendingReloadRef.current = false;
    try {
      const [rows, currentFolder] = await Promise.all([
        searching ? searchItems(activeQuery.trim()) : listChildren(folderId),
        folderId ? getItem(folderId) : Promise.resolve(null),
      ]);
      if (seq !== loadSeq.current) return;
      if (!searching) homeCache.set(folderId ?? '', rows);
      setItems(rows);
      if (folderId) setFolder(currentFolder);
    } catch {
      // Keep what is on screen: an empty list would look like all notes were deleted.
      if (seq === loadSeq.current) toast('Could not load your notes');
    }
  }, [folderId, searching, activeQuery]);

  useEffect(() => {
    load();
  }, [load]);

  // Reload when returning to Home from a child screen if DB changed while covered
  useEffect(() => {
    if (isActiveRoute && pendingReloadRef.current) {
      load();
    }
  }, [isActiveRoute, load]);

  // Subscribe to reactive database changes; defer reload while covered by Note/List editor
  useEffect(() => {
    const unsub = subscribeToDbChanges(() => {
      if (isActiveRouteRef.current) {
        load();
      } else {
        pendingReloadRef.current = true;
      }
    });
    return unsub;
  }, [load]);

  // Back button closes search / edit mode first.
  useEffect(() => {
    if (!searchOn && !editMode && !fabOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (fabOpen) setFabOpen(false);
      else if (editMode) {
        setEditMode(false);
        setSelected([]);
      } else if (searchOn) {
        setSearchOn(false);
        setQuery('');
      }
      return true;
    });
    return () => sub.remove();
  }, [searchOn, editMode, fabOpen]);

  const sorted = useMemo(() => {
    if (s.ordering === 'alpha' && !searching) {
      return [...items].sort((a, b) =>
        (a.title || '~').toLowerCase().localeCompare((b.title || '~').toLowerCase())
      );
    }
    return items;
  }, [items, s.ordering, searching]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Fixed row height for the drag list: follows both the app's text size and the phone's own
  // text-size setting (capped like the text itself), so large text never clips rows.
  const sysScale = Math.min(PixelRatio.getFontScale(), 1.6);
  const rowHeight =
    Math.round(
      (44 + (s.multilineTitles ? 22 : 0) + (s.showPreview ? 20 : 0) + (s.showModified ? 18 : 0)) *
        Math.max(1, scale) *
        Math.max(1, sysScale)
    ) + 12;

  const open = async (it: DashItem) => {
    if (editMode) {
      setSelected((sel) => (sel.includes(it.id) ? sel.filter((x) => x !== it.id) : [...sel, it.id]));
      return;
    }
    if (it.locked && !(await gate())) return;
    if (it.type === 'folder') nav.push('Home', { folderId: it.id });
    else if (it.type === 'note') nav.push('Note', { id: it.id });
    else nav.push('List', { id: it.id });
  };

  const startSelect = (it: DashItem) => {
    setEditMode(true);
    setSelected([it.id]);
  };

  // Stable handlers keep the memoised rows from re-rendering on every parent update.
  const openRef = useRef(open);
  openRef.current = open;
  const selectRef = useRef(startSelect);
  selectRef.current = startSelect;
  const stableOpen = useCallback((it: DashItem) => openRef.current(it), []);
  const stableSelect = useCallback((it: DashItem) => selectRef.current(it), []);

  const handleFabPress = () => {
    if (isReadOnly) {
      Alert.alert(
        'Read-Only Mode Active',
        'Turn off Read-Only Mode to create new notes, lists, or folders.',
        [
          { text: 'Turn Off', onPress: () => setReadOnly(false) },
          { text: 'OK', style: 'cancel' },
        ]
      );
      return;
    }
    setFabOpen((v) => !v);
  };

  const creating = useRef(false);
  const createNew = async (type: 'note' | 'list') => {
    if (isReadOnly) {
      toast('Cannot create items in read-only mode');
      return;
    }
    if (creating.current) return; // ignore double taps
    creating.current = true;
    setFabOpen(false);
    try {
      const it = await createItem(type, folderId, '');
      nav.push(type === 'note' ? 'Note' : 'List', { id: it.id, isNew: true });
    } catch (e) {
      Alert.alert('Could not create it', String(e instanceof Error ? e.message : e));
    } finally {
      creating.current = false;
    }
  };

  const createFolder = async (name: string) => {
    if (isReadOnly) {
      toast('Cannot create folders in read-only mode');
      return;
    }
    try {
      await createItem('folder', folderId, name.trim() || 'New folder');
    } catch (e) {
      Alert.alert('Could not create the folder', String(e instanceof Error ? e.message : e));
    }
    load();
  };

  const deleteSelected = () => {
    if (selected.length === 0) return;
    if (isReadOnly) {
      Alert.alert('Read-Only Mode', 'Cannot delete items while Read-Only Mode is active.');
      return;
    }
    confirm(
      'Delete items?',
      `${selected.length} item${selected.length === 1 ? '' : 's'} will be moved to Deleted Items and removed permanently after ${
        get().deletedAfterDays > 0 ? get().deletedAfterDays + ' days' : 'you empty it'
      }.`,
      'Delete',
      async () => {
        const ids = selected;
        const delSet = new Set(ids);
        // Locked items need the password/fingerprint again, like opening them does.
        if (items.some((i) => delSet.has(i.id) && i.locked) && !(await gate())) return;
        const prevItems = items;
        // Optimistically remove deleted items from screen immediately for instant feedback
        const nextItems = prevItems.filter((i) => !delSet.has(i.id));
        setItems(nextItems);
        if (!searching) homeCache.set(folderId ?? '', nextItems);
        setSelected([]);
        setEditMode(false);
        try {
          await softDelete(ids);
          toast(ids.length === 1 ? 'Moved to Deleted Items' : `${ids.length} items moved to Deleted Items`, {
            label: 'Undo',
            onPress: () => {
              restoreItems(ids)
                .then(() => load())
                .catch(() => toast('Could not undo'));
            },
          });
        } catch (e) {
          setItems(prevItems);
          if (!searching) homeCache.set(folderId ?? '', prevItems);
          Alert.alert('Could not delete', String(e instanceof Error ? e.message : e));
        }
        load();
      },
      true
    );
  };

  const anySelectedLocked = useMemo(() => {
    if (selectedSet.size === 0) return false;
    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i];
      if (it.locked && selectedSet.has(it.id)) return true;
    }
    return false;
  }, [selectedSet, sorted]);

  const toggleLockSelected = async () => {
    if (selected.length === 0) return;
    if (isReadOnly) {
      Alert.alert('Read-Only Mode', 'Cannot lock or unlock items while Read-Only Mode is active.');
      return;
    }
    const pwdSet = await hasPassword();
    if (!pwdSet) {
      Alert.alert(
        'Set Password First',
        'You need to set a password in Settings -> Security before you can lock notes.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Go to Settings', onPress: () => nav.push('SecuritySettings') },
        ]
      );
      return;
    }
    const ok = await gate();
    if (!ok) return;

    const targetLock = !anySelectedLocked;

    try {
      await batchUpdateLock(selected, targetLock);
    } catch (e) {
      Alert.alert('Could not change the lock', String(e instanceof Error ? e.message : e));
      load();
      return;
    }
    toast(
      targetLock
        ? selected.length > 1
          ? 'Notes locked'
          : 'Note locked'
        : selected.length > 1
        ? 'Notes unlocked'
        : 'Note unlocked'
    );
    setSelected([]);
    setEditMode(false);
    load();
  };

  const startMove = async () => {
    if (selected.length === 0) return;
    if (isReadOnly) {
      Alert.alert('Read-Only Mode', 'Cannot move items while Read-Only Mode is active.');
      return;
    }
    if (items.some((i) => selected.includes(i.id) && i.locked) && !(await gate())) return;
    const folders = await listAllFolders();
    const blocked = new Set<string>(selected);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parentId && blocked.has(f.parentId) && !blocked.has(f.id)) {
          blocked.add(f.id);
          grew = true;
        }
      }
    }
    const byParent = new Map<string | null, typeof folders>();
    folders.forEach((f) => {
      const arr = byParent.get(f.parentId) ?? [];
      arr.push(f);
      byParent.set(f.parentId, arr);
    });
    const opts: { label: string; value: string | null; depth?: number }[] = [
      { label: 'Top level', value: null },
    ];
    const walk = (parent: string | null, depth: number) => {
      (byParent.get(parent) ?? []).forEach((f) => {
        if (blocked.has(f.id)) return;
        opts.push({ label: f.title || 'Untitled folder', value: f.id, depth: depth + 1 });
        walk(f.id, depth + 1);
      });
    };
    walk(null, 0);
    setMoveOptions(opts);
  };

  const doMove = async (target: string | null) => {
    if (isReadOnly) {
      toast('Cannot move items in read-only mode');
      return;
    }
    try {
      await moveItems(selected, target);
      toast('Moved');
      setSelected([]);
      setEditMode(false);
    } catch (e) {
      Alert.alert('Could not move', String(e instanceof Error ? e.message : e));
    }
    load();
  };

  const reorder = (next: DashItem[]) => {
    if (isReadOnly) return;
    const before = items;
    setItems(next);
    homeCache.set(folderId ?? '', next);
    setPositions(next.map((i) => i.id)).catch(() => {
      // roll the screen back so it matches what is stored
      setItems(before);
      toast('Could not save the new order');
      load();
    });
  };


  const canDrag = s.ordering === 'custom' && !searching && !editMode && !isReadOnly;

  const homeKeyExtractor = useCallback((i: DashItem) => i.id, []);
  const getHomeItemLayout = useCallback(
    (_data: ArrayLike<DashItem> | null | undefined, index: number) => ({
      length: rowHeight,
      offset: rowHeight * index,
      index,
    }),
    [rowHeight]
  );
  const renderHomeFlatItem = useCallback(
    ({ item }: { item: DashItem }) => (
      <View style={{ minHeight: rowHeight }}>
        <HomeRow
          item={item}
          handle={null}
          editMode={editMode}
          selected={selectedSet.has(item.id)}
          searchQuery={searching ? activeQuery : undefined}
          onPress={stableOpen}
          onLongPress={stableSelect}
        />
      </View>
    ),
    [rowHeight, editMode, selectedSet, searching, activeQuery, stableOpen, stableSelect]
  );

  /* ----- header ----- */
  let header: React.ReactNode;
  if (searchOn) {
    header = (
      <Header
        onBack={() => {
          setSearchOn(false);
          setQuery('');
        }}
        center={false}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%' }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus
            placeholder="Search notes and lists"
            placeholderTextColor={theme.subtext}
            style={{
              flex: 1,
              color: theme.text,
              fontFamily: inputFont,
              fontSize: 18 * scale,
              paddingVertical: 8,
            }}
          />
          {query.length > 0 ? (
            <IconBtn name="close-circle" size={20} onPress={() => setQuery('')} accessibilityLabel="Clear search" />
          ) : null}
        </View>
      </Header>
    );
  } else {
    header = (
      <Header
        center={false}
        onBack={editMode ? () => { setEditMode(false); setSelected([]); } : folderId ? nav.pop : undefined}
        backIcon={editMode ? 'close' : 'arrow-back'}
        right={
          editMode ? (
            <Pressable
              onPress={() => {
                setEditMode(false);
                setSelected([]);
              }}
              style={{
                justifyContent: 'center',
                minHeight: 36,
                paddingHorizontal: 14,
                paddingVertical: 6,
                borderRadius: 16,
                backgroundColor: theme.accent,
              }}
              accessibilityRole="button"
              accessibilityLabel="Done selection"
            >
              <T bold size={14} style={{ color: theme.accentText }}>
                DONE
              </T>
            </Pressable>
          ) : (
            <>
              <Pressable
                onPress={() => {
                  setEditMode(true);
                  setSelected([]);
                }}
                style={{ justifyContent: 'center', paddingHorizontal: 10, minHeight: 44 }}
                accessibilityRole="button"
                accessibilityLabel="Enter selection mode"
              >
                <T bold size={16}>
                  EDIT
                </T>
              </Pressable>
              <IconBtn name="search" onPress={() => setSearchOn(true)} accessibilityLabel="Search" />
              <IconBtn name="settings-outline" onPress={() => nav.push('Settings')} accessibilityLabel="Settings" />
            </>
          )
        }
      >
        <T size={editMode ? 20 : 26} bold numberOfLines={1}>
          {editMode
            ? selected.length > 0
              ? `${selected.length} Selected`
              : 'Select Notes'
            : folderId
            ? folder?.title || 'Folder'
            : 'Notes'}
        </T>
      </Header>
    );
  }

  return (
    <Screen>
      {header}

      {searching && items.length >= SEARCH_LIMIT ? (
        <T dim size={13} style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
          {`Showing the first ${SEARCH_LIMIT} results. Type more to narrow your search.`}
        </T>
      ) : null}

      {sorted.length === 0 ? (
        <FadeIn style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }} distance={12} duration={300}>
          <Ionicons
            name={searching ? 'search-outline' : folderId ? 'folder-open-outline' : 'document-text-outline'}
            size={56}
            color={theme.subtext}
            style={{ marginBottom: 16 }}
          />
          <T dim size={17} style={{ textAlign: 'center', lineHeight: 24 }}>
            {searching
              ? 'Nothing matches your search.'
              : folderId
              ? isReadOnly
                ? 'This folder is empty.'
                : 'This folder is empty.\nTap + to add something.'
              : isReadOnly
              ? 'No notes found.'
              : 'No notes yet.\nTap + to write your first one.'}
          </T>
          {!searching && !isReadOnly ? (
            <PressableScale
              onPress={() => createNew('note')}
              accessibilityRole="button"
              accessibilityLabel="Create a new note"
              style={{
                marginTop: 20,
                minHeight: 44,
                paddingHorizontal: 22,
                borderRadius: 22,
                backgroundColor: theme.accent,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <T bold style={{ color: theme.accentText }}>
                New note
              </T>
            </PressableScale>
          ) : null}
        </FadeIn>
      ) : canDrag ? (
        <DraggableList
          data={sorted}
          keyOf={(i) => i.id}
          rowHeight={rowHeight}
          draggable={canDrag}
          onReorder={reorder}
          bottomPadding={editMode ? 90 : 120}
          renderRow={(item, handle) => (
            <HomeRow
              item={item}
              handle={handle}
              editMode={editMode}
              selected={selectedSet.has(item.id)}
              searchQuery={searching ? activeQuery : undefined}
              onPress={stableOpen}
              onLongPress={stableSelect}
            />
          )}
        />
      ) : (
        /* High-performance virtualized FlatList for non-custom reorder & search */
        <FlatList
          data={sorted}
          keyExtractor={homeKeyExtractor}
          getItemLayout={getHomeItemLayout}
          extraData={selectedSet}
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          updateCellsBatchingPeriod={16}
          windowSize={7}
          removeClippedSubviews
          contentContainerStyle={{ paddingBottom: editMode ? 100 : 120 }}
          keyboardShouldPersistTaps="handled"
          renderItem={renderHomeFlatItem}
        />
      )}

      {/* Bottom bar in edit mode */}
      {editMode ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-around',
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.border,
            backgroundColor: theme.surface,
            paddingVertical: 8,
            paddingBottom: Math.max(12, insets.bottom + 6),
            shadowColor: '#000',
            shadowOffset: { width: 0, height: -3 },
            shadowOpacity: 0.1,
            shadowRadius: 6,
            elevation: 8,
          }}
        >
          {/* Select All / Deselect button */}
          <Pressable
            onPress={() =>
              setSelected(selected.length === sorted.length ? [] : sorted.map((i) => i.id))
            }
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={selected.length === sorted.length && sorted.length > 0 ? 'Deselect all' : 'Select all'}
            style={({ pressed }) => ({
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons
              pointerEvents="none"
              name={selected.length === sorted.length && sorted.length > 0 ? 'checkmark-circle' : 'checkmark-circle-outline'}
              size={22}
              color={theme.accent}
            />
            <T pointerEvents="none" size={12} bold numberOfLines={1} style={{ marginTop: 2, color: theme.text }}>
              {selected.length === sorted.length && sorted.length > 0 ? 'Deselect' : 'Select All'}
            </T>
          </Pressable>

          {/* Move button */}
          <Pressable
            onPress={startMove}
            disabled={selected.length === 0}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Move selected items"
            style={({ pressed }) => ({
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: selected.length === 0 ? 0.35 : pressed ? 0.6 : 1,
            })}
          >
            <Ionicons pointerEvents="none" name="folder-outline" size={22} color={theme.text} />
            <T pointerEvents="none" size={12} bold numberOfLines={1} style={{ marginTop: 2, color: theme.text }}>
              Move
            </T>
          </Pressable>

          {/* Lock / Unlock button */}
          <Pressable
            onPress={toggleLockSelected}
            disabled={selected.length === 0}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={anySelectedLocked ? 'Unlock selected items' : 'Lock selected items'}
            style={({ pressed }) => ({
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: selected.length === 0 ? 0.35 : pressed ? 0.6 : 1,
            })}
          >
            <Ionicons
              pointerEvents="none"
              name={anySelectedLocked ? 'lock-open-outline' : 'lock-closed-outline'}
              size={22}
              color={theme.text}
            />
            <T pointerEvents="none" size={12} bold numberOfLines={1} style={{ marginTop: 2, color: theme.text }}>
              {anySelectedLocked ? 'Unlock' : 'Lock'}
            </T>
          </Pressable>

          {/* Delete button */}
          <Pressable
            onPress={deleteSelected}
            disabled={selected.length === 0}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Delete selected items"
            style={({ pressed }) => ({
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: selected.length === 0 ? 0.35 : pressed ? 0.6 : 1,
            })}
          >
            <Ionicons pointerEvents="none" name="trash-outline" size={22} color={theme.danger} />
            <T pointerEvents="none" size={12} bold style={{ marginTop: 2, color: theme.danger }}>
              Delete
            </T>
          </Pressable>
        </View>
      ) : null}

      {/* floating add button */}
      {!editMode ? (
        <View
          pointerEvents="box-none"
          style={{ position: 'absolute', right: 20, bottom: 24 + insets.bottom, alignItems: 'flex-end' }}
        >
          {fabOpen ? (
            <View style={{ marginBottom: 12, alignItems: 'flex-end' }}>
              {(
                [
                  ['Folder', 'folder-outline', () => { setFabOpen(false); setFolderPrompt(true); }],
                  ['List', 'checkbox-outline', () => createNew('list')],
                  ['Note', 'create-outline', () => createNew('note')],
                ] as [string, React.ComponentProps<typeof Ionicons>['name'], () => void][]
              ).map(([label, icon, fn], idx) => (
                <FadeIn key={label} delay={idx * 30} distance={4} duration={150} style={{ alignSelf: 'flex-end' }}>
                  <Pressable
                    onPress={fn}
                    accessibilityRole="button"
                    accessibilityLabel={`Create new ${label}`}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      backgroundColor: theme.surface,
                      borderWidth: 1,
                      borderColor: theme.border,
                      borderRadius: 24,
                      paddingVertical: 10,
                      paddingHorizontal: 16,
                      marginTop: 10,
                      shadowColor: '#000',
                      shadowOffset: { width: 0, height: 2 },
                      shadowOpacity: 0.15,
                      shadowRadius: 4,
                      elevation: 4,
                      opacity: pressed ? 0.75 : 1,
                    })}
                  >
                    <Ionicons pointerEvents="none" name={icon} size={22} color={theme.text} />
                    <T pointerEvents="none" bold style={{ marginLeft: 10 }}>
                      {label}
                    </T>
                  </Pressable>
                </FadeIn>
              ))}
            </View>
          ) : null}
          <Pressable
            onPress={handleFabPress}
            accessibilityRole="button"
            accessibilityLabel={isReadOnly ? 'Add new item (read-only mode active)' : fabOpen ? 'Close add menu' : 'Add new item'}
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: isReadOnly
                ? (theme.isDark ? '#333' : '#bbb')
                : theme.isDark ? '#ffffff' : theme.accent,
              alignItems: 'center',
              justifyContent: 'center',
              elevation: 6,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 3 },
              shadowOpacity: 0.3,
              shadowRadius: 5,
            }}
          >
            <Ionicons
              pointerEvents="none"
              name={isReadOnly ? 'lock-closed' : fabOpen ? 'close' : 'add'}
              size={isReadOnly ? 28 : 34}
              color={
                isReadOnly
                  ? '#fff'
                  : theme.isDark
                  ? '#000000'
                  : theme.accentText
              }
            />
          </Pressable>
        </View>
      ) : null}

      <PromptModal
        visible={folderPrompt}
        title="New folder"
        placeholder="Folder name"
        okLabel="Create"
        onSubmit={createFolder}
        onClose={() => setFolderPrompt(false)}
      />

      <PickerModal
        visible={moveOptions !== null}
        title="Move to"
        options={moveOptions ?? []}
        onSelect={doMove}
        onClose={() => setMoveOptions(null)}
      />
    </Screen>
  );
}
