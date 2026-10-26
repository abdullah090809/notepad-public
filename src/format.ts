export type DateFormat = 'DMY' | 'MDY' | 'YMD';

const p2 = (n: number): string => (n < 10 ? '0' : '') + n;

export function formatDate(
  ts: number,
  fmt: DateFormat,
  withTime = false,
  withSeconds = false
): string {
  const d = new Date(ts);
  const D = p2(d.getDate());
  const M = p2(d.getMonth() + 1);
  const Y = d.getFullYear();
  let s =
    fmt === 'DMY' ? `${D}/${M}/${Y}` : fmt === 'MDY' ? `${M}/${D}/${Y}` : `${Y}/${M}/${D}`;
  if (withTime) {
    s += ` ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    if (withSeconds) s += `:${p2(d.getSeconds())}`;
  }
  return s;
}

export function countText(s: string): { chars: number; words: number; lines: number } {
  const len = s.length;
  if (len === 0) return { chars: 0, words: 0, lines: 0 };
  let words = 0;
  let lines = 1;
  let inWord = false;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) {
      lines++;
      inWord = false;
    } else if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12 || c === 160) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return { chars: len, words, lines };
}

export const DEFAULT_EXPORT_TEMPLATE = 'Notes {DD_MM_YYYY} Backup';

export function fileNameFromTemplate(template: string, now: Date = new Date()): string {
  const D = p2(now.getDate());
  const M = p2(now.getMonth() + 1);
  const Y = String(now.getFullYear());
  const H = p2(now.getHours());
  const Mi = p2(now.getMinutes());
  let s = template
    .replace(/\{DD_MM_YYYY\}/g, `${D}_${M}_${Y}`)
    .replace(/\{MM_DD_YYYY\}/g, `${M}_${D}_${Y}`)
    .replace(/\{YYYY_MM_DD\}/g, `${Y}_${M}_${D}`)
    .replace(/\{HH_MM\}/g, `${H}_${Mi}`);
  s = s.replace(/[\\/:*?"<>|]/g, '_').trim();
  return s || 'Notes Backup';
}

export function formatRemaining(ms: number): string {
  const totalMin = Math.max(1, Math.ceil(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export type ProgressType = 'fraction' | 'percent' | 'fractionFirst' | 'percentFirst';

export function progressText(done: number, total: number, type: ProgressType): string {
  const pct = total > 0 ? Math.round((done / total) * 10000) / 100 : 0;
  const frac = `${done}/${total}`;
  const pc = `${pct}%`;
  switch (type) {
    case 'fraction':
      return frac;
    case 'percent':
      return pc;
    case 'fractionFirst':
      return `${frac} (${pc})`;
    default:
      return `${pc} (${frac})`;
  }
}

export function progressColor(done: number, total: number): string {
  if (total === 0) return '#6b6b78';
  const pct = (done / total) * 100;
  if (pct >= 100) return '#2e7d32';
  if (pct >= 50) return '#f9a825';
  if (pct > 0) return '#ef6c00';
  return '#c62828';
}

/* ---------- list revisions ----------
   New list revisions are stored as a JSON payload behind a marker line, so entries and titles containing
   line breaks round-trip exactly. Revisions saved by earlier versions ("title\n[x] text" lines) are still read. */
const LIST_REV_MARK = '\u0001LIST1\n';
export type ListRevisionEntry = { checked: boolean; text: string };

export function serializeListRevision(title: string, entries: { checked: boolean; text: string }[]): string {
  // An empty list keeps the old shape ("title\n") so "is there anything to save" checks behave as before.
  if (entries.length === 0) return title + '\n';
  return LIST_REV_MARK + JSON.stringify({ title, entries: entries.map((e) => ({ c: e.checked ? 1 : 0, t: e.text })) });
}

function parseLegacyListRevision(body: string): { title: string; entries: ListRevisionEntry[] } {
  const lines = body.split('\n');
  return {
    title: lines[0] ?? '',
    entries: lines
      .slice(1)
      .filter((l) => l.length > 0)
      .map((l) => ({ checked: l.startsWith('[x]'), text: l.replace(/^\[[ x]\] ?/, '') })),
  };
}

export function parseListRevision(body: string): { title: string; entries: ListRevisionEntry[] } {
  if (body.startsWith(LIST_REV_MARK)) {
    try {
      const o = JSON.parse(body.slice(LIST_REV_MARK.length));
      if (o && typeof o.title === 'string' && Array.isArray(o.entries)) {
        return {
          title: o.title,
          entries: o.entries.map((e: { c?: number; t?: unknown }) => ({ checked: e.c === 1, text: String(e.t ?? '') })),
        };
      }
    } catch {
      // fall through to the legacy reader
    }
  }
  return parseLegacyListRevision(body);
}

/** Text shown in the revision list for a list revision (same look as before for old revisions). */
export function listRevisionPreview(body: string): string {
  if (!body.startsWith(LIST_REV_MARK)) return body.split('\n').slice(1).join('\n');
  return parseListRevision(body)
    .entries.map((e) => `${e.checked ? '[x]' : '[ ]'} ${e.text}`)
    .join('\n');
}
