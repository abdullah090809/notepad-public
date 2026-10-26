import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { File } from 'expo-file-system';
import { useAppearance } from '../appearance';
import {
  DashItem,
  deleteForever,
  importAll,
  isBackupData,
  listDeleted,
  restoreItems,
  validateBackupData,
} from '../db';
import { backupNow, exportNotes, importNotes, shareBackupFile } from '../backup';
import { fileNameFromTemplate, formatDate } from '../format';
import { useGate } from '../gate';
import { useNav } from '../nav';
import { hasPassword } from '../security';
import { useReadOnly, useSettings } from '../settings';
import {
  Body,
  Button,
  CheckRow,
  ChoiceModal,
  Header,
  InfoText,
  Row,
  Screen,
  T,
  confirm,
  toast,
} from '../ui';

/* ------------------------------------------------------------------ */
/* Data management hub                                                 */
/* ------------------------------------------------------------------ */

export function DataManagement() {
  const nav = useNav();
  const { isReadOnly, setReadOnly } = useReadOnly();

  return (
    <Screen>
      <Header title="Data Management" onBack={nav.pop} />
      <Body>
        <Row title="Backup Scheduling" onPress={() => nav.push('BackupScheduling')} right="chevron" />
        <Row title="Deleted Items" onPress={() => nav.push('DeletedItems')} right="chevron" />
        <Row title="Transferring Notes" onPress={() => nav.push('Transfer')} right="chevron" />
      </Body>
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* Backup scheduling                                                   */
/* ------------------------------------------------------------------ */

const FREQUENCY_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '1 day', value: 1 },
  { label: '3 days', value: 3 },
  { label: '1 week', value: 7 },
  { label: '2 weeks', value: 14 },
  { label: '1 month', value: 30 },
];

function frequencyLabel(days: number): string {
  return FREQUENCY_OPTIONS.find((o) => o.value === days)?.label ?? `${days} days`;
}

export function BackupSchedulingScreen() {
  const nav = useNav();
  const { s, update, get } = useSettings();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const runNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await backupNow(get(), update);
      toast(ok ? 'Backup saved' : 'Nothing to back up yet');
    } catch (e) {
      Alert.alert('Backup failed', String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Header title="Backup Scheduling" onBack={nav.pop} />
      <Body>
        <InfoText>
          Backup scheduling allows you to adjust how often your notes are backed up. Backups are
          made when you open the app and one is due. You can also back your notes up manually at
          any time with the button below or with the 'Export Notes' option in the menu on the home
          screen.
        </InfoText>
        <InfoText>
          Latest backup:{' '}
          {s.lastBackupAt === null ? 'never' : formatDate(s.lastBackupAt, s.dateFormat, true, true)}
        </InfoText>
        <Row
          title="Backup Log"
          subtitle={`You currently have ${s.backupLog.length} scheduled backup(s) recorded.`}
          onPress={() => nav.push('BackupLog')}
          right="chevron"
        />
        <Row
          title={`Backup Frequency: ${frequencyLabel(s.backupFrequencyDays)}`}
          onPress={() => setOpen(true)}
          right="chevron"
        />
        <View style={{ padding: 16, marginTop: 8 }}>
          <Button label={busy ? 'BACKING UP...' : 'BACK UP NOW'} onPress={runNow} disabled={busy} />
        </View>
      </Body>
      <ChoiceModal
        visible={open}
        title="Backup Frequency"
        options={FREQUENCY_OPTIONS}
        value={s.backupFrequencyDays}
        onSelect={(v) => update({ backupFrequencyDays: v })}
        onClose={() => setOpen(false)}
      />
    </Screen>
  );
}

export function BackupLogScreen() {
  const nav = useNav();
  const gate = useGate();
  const { s } = useSettings();
  const { isReadOnly } = useReadOnly();
  const { theme } = useAppearance();

  const addMissing = async (uri: string) => {
    if (isReadOnly) {
      Alert.alert('Read-Only Mode Active', 'Cannot restore missing items while Read-Only Mode is active.');
      return;
    }
    try {
      const file = new File(uri);
      if (!file.exists) {
        Alert.alert('File not found', 'This backup file has been removed to save space.');
        return;
      }
      const text = await file.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        Alert.alert('Corrupted File', 'This backup file contains invalid JSON.');
        return;
      }
      const validation = validateBackupData(data);
      if (!validation.valid) {
        Alert.alert('Not a backup', validation.error || 'This file is not a valid notes backup.');
        return;
      }
      const added = await importAll(data as any, false);
      toast(added === 0 ? 'Nothing was missing' : `Added ${added} missing item${added === 1 ? '' : 's'}`);
    } catch (e) {
      Alert.alert('Restore failed', String(e instanceof Error ? e.message : e));
    }
  };

  const openEntry = (name: string, uri: string) => {
    Alert.alert(name, 'What would you like to do with this backup?', [
      {
        text: 'Share or save',
        onPress: async () => {
          if (await hasPassword()) {
            const ok = await gate();
            if (!ok) return;
          }
          shareBackupFile(uri);
        },
      },
      { text: 'Add missing notes', onPress: () => addMissing(uri) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return (
    <Screen>
      <Header title="Backup Log" onBack={nav.pop} />
      <Body>
        {s.backupLog.length === 0 ? (
          <InfoText>No backups have been made yet.</InfoText>
        ) : (
          <>
            <InfoText>
              Tap a backup to share it or to add any notes that are missing from your current notes.
              Only the most recent backups are kept on this device.
            </InfoText>
            {s.backupLog.map((b) => (
              <Pressable
                key={b.uri}
                onPress={() => openEntry(b.name, b.uri)}
                android_ripple={{ color: theme.border }}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  borderTopWidth: 1,
                  borderTopColor: theme.border,
                  flexDirection: 'row',
                  alignItems: 'center',
                }}
              >
                <View pointerEvents="none" style={{ flex: 1 }}>
                  <T size={16} bold>
                    {formatDate(b.at, s.dateFormat, true, true)}
                  </T>
                  <T size={14} dim style={{ marginTop: 2 }}>
                    {b.items} item{b.items === 1 ? '' : 's'} - {b.name}
                  </T>
                </View>
                <Ionicons pointerEvents="none" name="chevron-forward" size={22} color={theme.text} />
              </Pressable>
            ))}
          </>
        )}
      </Body>
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* Deleted items                                                       */
/* ------------------------------------------------------------------ */

const DELETE_OPTIONS = [
  { label: '1 day', value: 1 },
  { label: '1 week', value: 7 },
  { label: '2 weeks', value: 14 },
  { label: '1 month', value: 30 },
  { label: '3 months', value: 90 },
  { label: 'Never', value: 0 },
];

function deleteAfterLabel(days: number): string {
  return DELETE_OPTIONS.find((o) => o.value === days)?.label ?? `${days} days`;
}

export function DeletedItemsScreen() {
  const nav = useNav();
  const { s, update } = useSettings();
  const { isReadOnly, setReadOnly } = useReadOnly();
  const { theme } = useAppearance();
  const gate = useGate();
  const [items, setItems] = useState<DashItem[] | null>(null);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async () => {
    setItems(await listDeleted());
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const restore = async (it: DashItem) => {
    if (isReadOnly) {
      Alert.alert('Read-Only Mode Active', 'Cannot restore items while Read-Only Mode is active.');
      return;
    }
    if (it.locked && !(await gate())) return;
    try {
      await restoreItems([it.id]);
      toast('Restored');
      reload();
    } catch (e) {
      Alert.alert('Could not restore item', String(e instanceof Error ? e.message : e));
    }
  };

  const remove = (it: DashItem) => {
    if (isReadOnly) {
      Alert.alert('Read-Only Mode Active', 'Cannot delete items while Read-Only Mode is active.');
      return;
    }
    confirm(
      'Delete forever?',
      `"${it.title || 'Untitled'}" will be permanently deleted and cannot be restored.`,
      'Delete',
      async () => {
        if (it.locked && !(await gate())) return;
        try {
          await deleteForever([it.id]);
          reload();
        } catch (e) {
          Alert.alert('Could not delete item', String(e instanceof Error ? e.message : e));
        }
      },
      true
    );
  };

  const emptyAll = () => {
    if (!items || items.length === 0) return;
    if (isReadOnly) {
      Alert.alert('Read-Only Mode Active', 'Cannot empty deleted items while Read-Only Mode is active.');
      return;
    }
    confirm(
      'Empty deleted items?',
      'Everything in this list will be permanently deleted.',
      'Delete all',
      async () => {
        if (items.some((i) => i.locked) && !(await gate())) return;
        try {
          await deleteForever(items.map((i) => i.id));
          reload();
        } catch (e) {
          Alert.alert('Could not empty deleted items', String(e instanceof Error ? e.message : e));
        }
      },
      true
    );
  };

  const daysLeft = (it: DashItem): string => {
    if (s.deletedAfterDays <= 0 || it.deletedAt === null) return '';
    const left = Math.ceil((it.deletedAt + s.deletedAfterDays * 86400000 - Date.now()) / 86400000);
    return left <= 0 ? ' - deleted soon' : ` - ${left} day${left === 1 ? '' : 's'} left`;
  };

  const iconFor = (type: DashItem['type']) =>
    type === 'folder' ? 'folder-outline' : type === 'list' ? 'checkbox-outline' : 'document-text-outline';

  return (
    <Screen>
      <Header title="Deleted Items" onBack={nav.pop} />
      <Body>
        <Row
          title={`Permanently delete items after: ${deleteAfterLabel(s.deletedAfterDays)}`}
          onPress={() => setOpen(true)}
          right="chevron"
        />
        {items === null ? null : items.length === 0 ? (
          <InfoText>There are currently no items marked for deletion!</InfoText>
        ) : (
          <>
            {items.map((it) => (
              <View
                key={it.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 10,
                  paddingLeft: 16,
                  paddingRight: 4,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.border,
                }}
              >
                <Ionicons name={iconFor(it.type)} size={24} color={theme.text} />
                <View style={{ flex: 1, marginHorizontal: 14 }}>
                  <T size={16} bold numberOfLines={1}>
                    {it.title || 'Untitled'}
                  </T>
                  <T size={13} dim style={{ marginTop: 2 }}>
                    {it.deletedAt !== null ? formatDate(it.deletedAt, s.dateFormat, true) : ''}
                    {daysLeft(it)}
                  </T>
                </View>
                <Pressable
                  onPress={() => restore(it)}
                  hitSlop={6}
                  style={{ padding: 10, opacity: isReadOnly ? 0.4 : 1 }}
                  accessibilityLabel="Restore item"
                >
                  <Ionicons pointerEvents="none" name="arrow-undo-outline" size={24} color={theme.text} />
                </Pressable>
                <Pressable
                  onPress={() => remove(it)}
                  hitSlop={6}
                  style={{ padding: 10, opacity: isReadOnly ? 0.4 : 1 }}
                  accessibilityLabel="Permanently delete item"
                >
                  <Ionicons pointerEvents="none" name="trash-outline" size={24} color={theme.danger} />
                </Pressable>
              </View>
            ))}
            <View style={{ padding: 16, marginTop: 8 }}>
              <Button
                label="EMPTY DELETED ITEMS"
                onPress={emptyAll}
                danger
                disabled={isReadOnly}
              />
            </View>
          </>
        )}
      </Body>
      <ChoiceModal
        visible={open}
        title="Permanently delete items after"
        options={DELETE_OPTIONS}
        value={s.deletedAfterDays}
        onSelect={(v) => update({ deletedAfterDays: v })}
        onClose={() => setOpen(false)}
      />
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* Transferring notes (import / export)                                */
/* ------------------------------------------------------------------ */

const NAME_OPTIONS = [
  { label: 'Notes {DD_MM_YYYY} Backup', value: 'Notes {DD_MM_YYYY} Backup' },
  { label: 'Notes {MM_DD_YYYY} Backup', value: 'Notes {MM_DD_YYYY} Backup' },
  { label: 'Notes {YYYY_MM_DD} Backup', value: 'Notes {YYYY_MM_DD} Backup' },
  { label: 'Notes {YYYY_MM_DD} {HH_MM}', value: 'Notes {YYYY_MM_DD} {HH_MM}' },
];

export function TransferNotesScreen() {
  const nav = useNav();
  const gate = useGate();
  const { s, update, get } = useSettings();
  const { isReadOnly, setReadOnly } = useReadOnly();
  const [open, setOpen] = useState(false);

  const options = NAME_OPTIONS.some((o) => o.value === s.exportNameTemplate)
    ? NAME_OPTIONS
    : [{ label: s.exportNameTemplate, value: s.exportNameTemplate }, ...NAME_OPTIONS];

  const handleExport = async () => {
    if (await hasPassword()) {
      const ok = await gate();
      if (!ok) return;
    }
    exportNotes(get());
  };

  return (
    <Screen>
      <Header title="Transferring Notes" onBack={nav.pop} />
      <Body>
        <View style={{ padding: 16 }}>
          <Button label="EXPORT NOTES" onPress={handleExport} />
          <View style={{ height: 12 }} />
          <Button
            label={isReadOnly ? 'IMPORT NOTES (READ-ONLY ACTIVE)' : 'IMPORT NOTES'}
            onPress={() => {
              if (isReadOnly) {
                Alert.alert(
                  'Read-Only Mode Active',
                  'Cannot import notes while Read-Only Mode is active.',
                  [
                    { text: 'Disable Read-Only Mode', onPress: () => setReadOnly(false) },
                    { text: 'OK', style: 'cancel' },
                  ]
                );
                return;
              }
              importNotes();
            }}
            disabled={isReadOnly}
          />
        </View>
        <InfoText>
          Whenever you edit a note in this app, a revision save gets made (this can be turned on or
          off in Settings &gt; General &gt; Item Revisions).
        </InfoText>
        <InfoText>
          When exporting your notes you can also include all of these saves/revisions of each of
          your notes in the exported file. This may make the export file much larger.
        </InfoText>
        <CheckRow
          label="Include previous saves"
          value={s.includeRevisionsInExport}
          onChange={(v) => update({ includeRevisionsInExport: v })}
        />
        <View style={{ height: 8 }} />
        <Row
          title="Exported File Name"
          subtitle={`When exporting files, your produced file name will be in the format: '${fileNameFromTemplate(
            s.exportNameTemplate
          )}'`}
          onPress={() => setOpen(true)}
          right="chevron"
        />
      </Body>
      <ChoiceModal
        visible={open}
        title="Exported File Name"
        options={options}
        value={s.exportNameTemplate}
        onSelect={(v) => update({ exportNameTemplate: v })}
        onClose={() => setOpen(false)}
      />
    </Screen>
  );
}
