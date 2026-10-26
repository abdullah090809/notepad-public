import { Alert } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import {
  BackupData,
  createItem,
  exportAll,
  sealExistingLockedItems,
  importAll,
  isBackupData,
  isDbReadOnly,
  purgeDeleted,
  validateBackupData,
} from './db';
import { fileNameFromTemplate } from './format';
import { Settings } from './settings';
import { confirm, toast } from './ui';
import { withExternalUi } from './security';

type Update = (patch: Partial<Settings>) => void;

function writeTextFile(dir: Directory, name: string, content: string): File {
  const file = new File(dir, name);
  if (file.exists) file.delete();
  file.create();
  file.write(content);
  return file;
}

async function shareFile(file: File, mimeType: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    Alert.alert('Sharing is not available', 'This device cannot share files from the app.');
    return;
  }
  await withExternalUi(() =>
    Sharing.shareAsync(file.uri, { mimeType, dialogTitle: 'Save or send your notes' })
  );
}

function chooseFormat(): Promise<'json' | 'txt' | null> {
  return new Promise((resolve) => {
    Alert.alert(
      'Export notes',
      'Backup files (.json) keep everything and can be imported again. Plain text (.txt) is for reading elsewhere.',
      [
        { text: 'Backup (.json)', onPress: () => resolve('json') },
        { text: 'Plain text (.txt)', onPress: () => resolve('txt') },
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) }
    );
  });
}

function toPlainText(data: BackupData): string {
  const lists = new Map<string, typeof data.listItems>();
  data.listItems.forEach((li) => {
    const arr = lists.get(li.listId) ?? [];
    arr.push(li);
    lists.set(li.listId, arr);
  });
  const out: string[] = [];
  const folderTitle = new Map<string, string>();
  data.items.forEach((i) => {
    if (i.type === 'folder') folderTitle.set(i.id, i.title || 'Untitled folder');
  });
  data.items.forEach((i) => {
    if (i.type === 'folder') return;
    if (i.locked) return;
    const where = i.parentId ? ` (in ${folderTitle.get(i.parentId) ?? 'folder'})` : '';
    out.push(`==== ${i.title || 'Untitled'}${where} ====`);
    if (i.type === 'note') {
      out.push(i.body);
    } else {
      (lists.get(i.id) ?? [])
        .sort((a, b) => a.position - b.position)
        .forEach((li) => out.push(`${li.checked ? '[x]' : '[ ]'} ${li.text}`));
    }
    out.push('');
  });
  return out.join('\n');
}

/** Export everything and open the share sheet. */
export async function exportNotes(s: Settings): Promise<void> {
  const format = await chooseFormat();
  if (!format) return;
  try {
    const data = await exportAll(s.includeRevisionsInExport);
    const base = fileNameFromTemplate(s.exportNameTemplate);
    if (format === 'json') {
      const file = writeTextFile(Paths.cache, `${base}.json`, JSON.stringify(data));
      await shareFile(file, 'application/json');
    } else {
      const file = writeTextFile(Paths.cache, `${base}.txt`, toPlainText(data));
      await shareFile(file, 'text/plain');
    }
  } catch (e) {
    Alert.alert('Export failed', String(e instanceof Error ? e.message : e));
  }
}

function askImportMode(count: number): Promise<'merge' | 'replace' | null> {
  return new Promise((resolve) => {
    Alert.alert(
      'Import notes',
      `This backup has ${count} item${count === 1 ? '' : 's'}. Add them to your current notes, or replace everything?`,
      [
        { text: 'Add to my notes', onPress: () => resolve('merge') },
        { text: 'Replace everything', style: 'destructive', onPress: () => resolve('replace') },
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) }
    );
  });
}

/** Pick a file and import it. Resolves true if anything was added. */
export async function importNotes(): Promise<boolean> {
  if (isDbReadOnly()) {
    Alert.alert('Read-Only Mode Active', 'Cannot import notes while Read-Only Mode is active.');
    return false;
  }
  try {
    const picked = await withExternalUi(() =>
      DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      })
    );
    if (picked.canceled || !picked.assets || picked.assets.length === 0) return false;
    const asset = picked.assets[0];
    const text = await new File(asset.uri).text();

    let parsed: unknown = null;
    let isJson = false;
    try {
      parsed = JSON.parse(text);
      isJson = true;
    } catch {
      parsed = null;
      isJson = false;
    }

    if (isJson && typeof parsed === 'object' && parsed !== null) {
      const validation = validateBackupData(parsed);
      if (validation.valid) {
        const backupData = parsed as BackupData;
        const mode = await askImportMode(backupData.items.length);
        if (!mode) return false;

        if (mode === 'replace') {
          const confirmed = await new Promise<boolean>((resolve) => {
            confirm(
              'Replace all notes?',
              'All current notes and lists will be permanently deleted and replaced with the imported backup.',
              'Replace everything',
              () => resolve(true),
              true,
              () => resolve(false)
            );
          });
          if (!confirmed) return false;
        }

        const added = await importAll(backupData, mode === 'replace');
        toast(added === 1 ? 'Imported 1 item' : `Imported ${added} items`);
        return added > 0 || mode === 'replace';
      } else if (asset.name?.endsWith('.json') || (parsed as any).app !== undefined) {
        Alert.alert('Invalid backup file', validation.error || 'The file is not a valid Notepad backup.');
        return false;
      }
    }

    // Treat non-JSON plain text as a new note
    const title = (asset.name || 'Imported note').replace(/\.[^.]+$/, '');
    await createItem('note', null, title, text);
    toast('Imported as a new note');
    return true;
  } catch (e) {
    Alert.alert('Import failed', String(e instanceof Error ? e.message : e));
    return false;
  }
}

/* ---------- scheduled backups ---------- */

const KEEP_FILES = 10;

export async function backupNow(s: Settings, update: Update): Promise<boolean> {
  try {
    const data = await exportAll(s.includeRevisionsInExport);
    if (data.items.length === 0) return false;
    const dir = new Directory(Paths.document, 'backups');
    if (!dir.exists) dir.create();
    const now = new Date();
    let name = `${fileNameFromTemplate(s.exportNameTemplate, now)}.json`;
    if (new File(dir, name).exists) {
      name = `${fileNameFromTemplate(s.exportNameTemplate, now)} ${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}.json`;
    }
    const file = writeTextFile(dir, name, JSON.stringify(data));
    const log = [
      { at: now.getTime(), name, uri: file.uri, items: data.items.length },
      ...s.backupLog,
    ];
    // keep only the newest files on disk
    log.slice(KEEP_FILES).forEach((entry) => {
      try {
        const old = new File(entry.uri);
        if (old.exists) old.delete();
      } catch {
        // ignore
      }
    });
    update({ lastBackupAt: now.getTime(), backupLog: log.slice(0, 50) });
    return true;
  } catch (e) {
    // Let callers distinguish "failed" from "nothing to back up" (false).
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Runs the automatic backup when it is due. Call when the app opens. */
export async function runScheduledBackup(s: Settings, update: Update): Promise<void> {
  if (s.backupFrequencyDays <= 0) return;
  const due =
    s.lastBackupAt === null || Date.now() - s.lastBackupAt >= s.backupFrequencyDays * 86400000;
  if (due) await backupNow(s, update);
}

export async function shareBackupFile(uri: string): Promise<void> {
  try {
    const file = new File(uri);
    if (!file.exists) {
      Alert.alert('File not found', 'This backup file has been removed to save space.');
      return;
    }
    await shareFile(file, 'application/json');
  } catch (e) {
    Alert.alert('Could not share', String(e instanceof Error ? e.message : e));
  }
}

export async function startupTasks(s: Settings, update: Update): Promise<void> {
  // Housekeeping must never block the app, but it must not fail silently either.
  try {
    await sealExistingLockedItems();
  } catch (e) {
    Alert.alert('Could not encrypt locked notes', String(e instanceof Error ? e.message : e));
  }
  try {
    if (!isDbReadOnly()) {
      await purgeDeleted(s.deletedAfterDays);
    }
  } catch (e) {
    // Purging old trash must not block the app, but the user is told (once per launch).
    Alert.alert('Could not clean up deleted items', String(e instanceof Error ? e.message : e));
  }
  try {
    await runScheduledBackup(s, update);
  } catch (e) {
    Alert.alert('Scheduled backup failed', String(e instanceof Error ? e.message : e));
  }
}
