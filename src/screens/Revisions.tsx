import React, { useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppearance } from '../appearance';
import { Revision, getItem, getListItems, listRevisions, newId, restoreRevision } from '../db';
import { formatDate, listRevisionPreview, parseListRevision, serializeListRevision } from '../format';
import { useNav } from '../nav';
import { useReadOnly, useSettings } from '../settings';
import { Body, Header, Screen, T, confirm, toast } from '../ui';

export function RevisionsScreen({ id }: { id: string }) {
  const nav = useNav();
  const { theme } = useAppearance();
  const { s } = useSettings();
  const { isReadOnly, setReadOnly } = useReadOnly();
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [kind, setKind] = useState<'note' | 'list' | 'folder'>('note');
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    listRevisions(id).then(setRevs);
    getItem(id).then((it) => {
      if (it) setKind(it.type);
    });
  }, [id]);

  const restore = (r: Revision) => {
    if (isReadOnly) {
      Alert.alert(
        'Read-Only Mode Active',
        'Cannot restore earlier versions while Read-Only Mode is active.',
        [
          { text: 'Disable Read-Only Mode', onPress: () => setReadOnly(false) },
          { text: 'OK', style: 'cancel' },
        ]
      );
      return;
    }
    confirm(
      'Restore this version?',
      'Your current text is saved as a revision first, so you can switch back.',
      'Restore',
      async () => {
        try {
          const cur = await getItem(id);
          let snapshot: { title: string; body: string } | null = null;
          if (cur && kind === 'note') {
            snapshot = { title: cur.title, body: cur.body };
          } else if (cur) {
            const curEntries = await getListItems(id);
            snapshot = {
              title: cur.title,
              body: serializeListRevision(cur.title, curEntries),
            };
          }
          // The snapshot, the restored content and the title are written in ONE transaction,
          // so a failure leaves nothing half-applied and no stray revision.
          if (kind === 'note') {
            await restoreRevision({ id, snapshot, title: r.title, body: r.body });
          } else {
            // new revisions are JSON, old ones are "title\n[x] text" lines; parseListRevision reads both
            const entries = parseListRevision(r.body).entries.map((x) => ({ id: newId(), checked: x.checked, text: x.text }));
            await restoreRevision({ id, snapshot, title: r.title, entries });
          }
        } catch (e) {
          Alert.alert('Could not restore this version', String(e instanceof Error ? e.message : e));
          return;
        }
        toast('Version restored');
        nav.pop();
      }
    );
  };

  return (
    <Screen>
      <Header title="Revision history" onBack={nav.pop} />
      <Body>
        {revs === null ? null : revs.length === 0 ? (
          <T dim style={{ padding: 20, lineHeight: 24 }}>
            {s.saveRevisions
              ? 'No earlier versions yet. A copy is saved the first time you change a note each time you open it.'
              : 'Saving revisions is turned off. You can turn it on in Settings > General > Item Revisions.'}
          </T>
        ) : (
          revs.map((r) => {
            const open = openId === r.id;
            const preview = kind === 'note' ? r.body : listRevisionPreview(r.body);
            return (
              <View key={r.id} style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}>
                <Pressable
                  onPress={() => setOpenId(open ? null : r.id)}
                  style={{ flexDirection: 'row', alignItems: 'center', padding: 16 }}
                >
                  <View pointerEvents="none" style={{ flex: 1 }}>
                    <T bold size={16}>
                      {formatDate(r.savedAt, s.dateFormat, true, true)}
                    </T>
                    {!open ? (
                      <T dim size={14} numberOfLines={1} style={{ marginTop: 2 }}>
                        {preview.trim() || '(empty)'}
                      </T>
                    ) : null}
                  </View>
                  <Ionicons pointerEvents="none" name={open ? 'chevron-up' : 'chevron-down'} size={22} color={theme.text} />
                </Pressable>
                {open ? (
                  <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                    <T size={15} selectable style={{ lineHeight: 22 }}>
                      {preview.length > 6000 ? preview.slice(0, 6000) + '\n…' : preview || '(empty)'}
                    </T>
                    <Pressable
                      onPress={() => restore(r)}
                      disabled={isReadOnly}
                      style={{
                        alignSelf: 'flex-start',
                        marginTop: 14,
                        backgroundColor: isReadOnly ? (theme.isDark ? '#444' : '#ccc') : theme.accent,
                        borderRadius: 8,
                        paddingVertical: 10,
                        paddingHorizontal: 18,
                        opacity: isReadOnly ? 0.6 : 1,
                      }}
                    >
                      <T bold style={{ color: isReadOnly ? theme.subtext : theme.accentText }}>
                        {isReadOnly ? 'RESTORE (READ-ONLY)' : 'RESTORE THIS VERSION'}
                      </T>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </Body>
    </Screen>
  );
}
