import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  BackHandler,
  Dimensions,
  Easing,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useAppearance } from '../appearance';
import {
  addRevision,
  deleteForever,
  getItem,
  getKv,
  setKv,
  restoreItems,
  softDelete,
  subscribeToDbChanges,
  updateItem,
} from '../db';
import { countText } from '../format';
import { useNav } from '../nav';
import { withExternalUi } from '../security';
import { useSettings } from '../settings';
import { Header, IconBtn, IconName, Screen, T, confirm, toast } from '../ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function PopupMenu({
  top,
  theme,
  maxHeight,
  children,
}: {
  top: number;
  theme: any;
  maxHeight: number;
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
        minWidth: 240,
        maxHeight,
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

export type Sel = { start: number; end: number };

export type VisualLineMetric = {
  lineIndex: number;
  startOffset: number;
  endOffset: number;
  y: number;
  height: number;
};

export type NativeLayoutCache = {
  text: string;
  width: number;
  scale: number;
  fontFamily?: string;
  lines: VisualLineMetric[];
  totalHeight: number;
};

export const EDITOR_TOP_PAD = 14;
export const EDITOR_BOTTOM_PAD = 24;
export const EDITOR_H_PAD = 16;
export const WINDOW_MODE_THRESHOLD = 3600;
const WINDOW_TARGET_RADIUS = 1400;
/* Text above/below the editable window is drawn as real text (exact height, exact tap mapping) up to this many characters each side. Only beyond that is it a blank spacer with a sliding text slice, which is where gaps and mis-taps came from. */
const STATIC_NEIGHBOR_MAX_CHARS = 5000;
const STATIC_NEIGHBOR_VIS_CHARS = 4500;
/* Text drawn over the blank spacers above/below the editable window while scrolling. Wide enough to cover several screens so fast scrolling does not reveal blank gaps. */
const SPACER_SLICE_CHARS = 4500;

/**
 * Test switch. true  = on the first tap into an unfocused note, hold the screen where the user
 *                      tapped while the keyboard opens (counters Android's jump to the note's end).
 *               false = do nothing special on first tap (original behaviour).
 * Flip to false to check whether a tap/cursor problem comes from this feature.
 */
const HOLD_VIEW_ON_FIRST_TAP = false;

/**
 * Test switch. true = after the first tap into an unfocused note, nudge the caret one character and
 * back so Android draws it (otherwise it can stay invisible until a second tap). false = off.
 */
const WAKE_CARET_ON_FIRST_TAP = false;
/* TEST SWITCHES (set to false one at a time to find what causes the blank area under the text):
   MEASURE_FIRST_TAP_CARET  = invisible text copy + exact caret placement on the first tap.
   REMOVE_PAST_END_SCROLL   = pulls the screen back if it scrolls beyond the text. */
const MEASURE_FIRST_TAP_CARET = true;
const REMOVE_PAST_END_SCROLL = true;

/**
 * Temporary diagnostics: shows a small green log over the editor (taps, focus, cursor position,
 * keyboard, scroll). Set to false to hide it.
 */
const DEBUG_EDITOR_EVENTS = false;

/**
 * When the keyboard would cover the line you tapped, the screen scrolls just enough to lift that
 * line above the keyboard, leaving this many lines of space below it. Use 0 for the minimum.
 */
const KEYBOARD_GAP_LINES = 2;

/**
 * true  = Enter / typing scrolls the caret into view in ONE instant step (no animation). Android's
 *         own caret-reveal scroll and an interrupted animated scroll (rapid Enters) were fighting
 *         each other, which made the screen shake.
 * false = previous behaviour (animated scroll on Enter / typing).
 */
const INSTANT_CARET_SCROLL = true;

/**
 * true  = on the first tap into a note, the "keep the tapped line above the keyboard" correction
 *         waits until Android has stopped scrolling, then glides there once; the caret refresh also
 *         waits until the screen is still. Before, several instant corrections fought Android's own
 *         scrolling while the keyboard opened, which looked like shaking.
 * false = previous behaviour.
 */
const SMOOTH_FIRST_TAP = false;

/**
 * true  = on the first tap into a note, the caret is moved to the tapped spot at the moment the finger
 *         touches down, BEFORE the note gets focus. Android otherwise starts with the caret at the end of
 *         the text, scrolls there, and only afterwards is the caret moved to the tapped spot, which looked
 *         like the screen shaking before the cursor appears.
 * false = previous behaviour.
 */
const PRESET_CARET_ON_TOUCH = true;
const dbgLines: string[] = [];
/* Latest layout facts, kept even when the event log is cleared. */
const dbgFacts: Record<string, string> = {};
function fact(key: string, val: string): void {
  if (!DEBUG_EDITOR_EVENTS) return;
  dbgFacts[key] = val;
}
const dbgListeners = new Set<() => void>();
let dbgBurstStart = 0;
let dbgNotifyTimer: ReturnType<typeof setTimeout> | null = null;
function dbg(msg: string): void {
  if (!DEBUG_EDITOR_EVENTS) return;
  const now = Date.now();
  if (now - dbgBurstStart > 2500) {
    dbgLines.length = 0;
    dbgBurstStart = now;
  }
  dbgLines.push(`${String(now - dbgBurstStart).padStart(4, ' ')}ms ${msg}`);
  if (dbgLines.length > 34) dbgLines.shift();
  // Only repaint the overlay once things have gone quiet, so logging never disturbs the editor
  // while a tap / keyboard animation is in progress.
  if (dbgNotifyTimer) clearTimeout(dbgNotifyTimer);
  dbgNotifyTimer = setTimeout(() => {
    dbgNotifyTimer = null;
    dbgListeners.forEach((l) => l());
  }, 1200);
}

function DebugOverlay() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    dbgListeners.add(l);
    return () => {
      dbgListeners.delete(l);
    };
  }, []);
  if (!DEBUG_EDITOR_EVENTS) return null;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 96,
        left: 4,
        right: 4,
        backgroundColor: 'rgba(0,0,0,0.78)',
        padding: 4,
        zIndex: 999,
        elevation: 30,
      }}
    >
      <Text style={{ color: '#7CFC00', fontSize: 10, fontFamily: 'monospace' }}>
        {`HOLD=${HOLD_VIEW_ON_FIRST_TAP} MEASURE=${MEASURE_FIRST_TAP_CARET} PASTEND=${REMOVE_PAST_END_SCROLL}\n` +
          Object.keys(dbgFacts)
            .map((k) => `[${k}] ${dbgFacts[k]}`)
            .join('\n') +
          '\n' +
          (dbgLines.join('\n') || '(tap the note)')}
      </Text>
    </View>
  );
}

export function getEditorLineHeight(scale: number): number {
  return Math.round(17 * scale * 1.45);
}

export function estimateCharsPerLine(
  screenWidth: number,
  scale: number,
  fontFamily?: string
): number {
  const availableWidth = Math.max(100, screenWidth - EDITOR_H_PAD * 2);
  let factor = 0.54;
  if (fontFamily === 'monospace' || fontFamily === 'Menlo') {
    factor = 0.61;
  } else if (fontFamily && fontFamily.includes('condensed')) {
    factor = 0.46;
  } else if (fontFamily === 'serif' || fontFamily === 'Georgia') {
    factor = 0.56;
  }
  const charWidth = 17 * scale * factor;
  return Math.max(12, Math.floor(availableWidth / charWidth));
}

/**
 * Splits a single hard paragraph (without '\n') into visual wrapped line ranges [relStart, relEnd].
 * Wraps at word boundaries (spaces/hyphens) when possible, and falls back to hard character
 * wrapping for unbroken long tokens (such as URLs or 'A'.repeat(80)).
 */
function wrapParagraphOffsets(
  text: string,
  lineStart: number,
  lineEnd: number,
  charsPerLine: number
): { start: number; end: number }[] {
  const cap = Math.max(1, charsPerLine);
  const len = lineEnd - lineStart;
  if (len <= 0) {
    return [{ start: lineStart, end: lineStart }];
  }
  if (len <= cap) {
    return [{ start: lineStart, end: lineEnd }];
  }

  const out: { start: number; end: number }[] = [];
  let pos = lineStart;
  while (pos < lineEnd) {
    const remaining = lineEnd - pos;
    if (remaining <= cap) {
      out.push({ start: pos, end: lineEnd });
      break;
    }
    const maxEnd = pos + cap;
    let breakAt = -1;
    // Look backwards from maxEnd for a whitespace break opportunity within the current visual line
    const minBreak = pos + Math.max(1, Math.floor(cap * 0.35));
    for (let k = maxEnd; k >= minBreak; k--) {
      const code = text.charCodeAt(k - 1);
      if (code === 32 || code === 9) {
        breakAt = k;
        break;
      }
    }
    if (breakAt === -1) {
      breakAt = maxEnd;
    }
    out.push({ start: pos, end: breakAt });
    pos = breakAt;
  }
  return out;
}

/**
 * Zero-allocation visual line counter for a single hard paragraph [lineStart, lineEnd).
 */
function countParagraphVisualLines(
  text: string,
  lineStart: number,
  lineEnd: number,
  charsPerLine: number
): number {
  const cap = Math.max(1, charsPerLine);
  const len = lineEnd - lineStart;
  if (len <= cap) return 1;

  let lines = 0;
  let pos = lineStart;
  const minStep = Math.max(1, Math.floor(cap * 0.35));
  while (pos < lineEnd) {
    const remaining = lineEnd - pos;
    if (remaining <= cap) {
      lines++;
      break;
    }
    const maxEnd = pos + cap;
    let breakAt = -1;
    const minBreak = pos + minStep;
    for (let k = maxEnd; k >= minBreak; k--) {
      const code = text.charCodeAt(k - 1);
      if (code === 32 || code === 9) {
        breakAt = k;
        break;
      }
    }
    pos = breakAt === -1 ? maxEnd : breakAt;
    lines++;
  }
  return lines;
}

/**
 * Zero-allocation visual line offset within a single hard paragraph [lineStart, limit].
 */
function getParagraphVisualLineOffset(
  text: string,
  lineStart: number,
  limit: number,
  charsPerLine: number
): number {
  const cap = Math.max(1, charsPerLine);
  const len = limit - lineStart;
  if (len <= 0 || len < cap) return 0;
  if (len === cap) return 1;

  let wrappedCount = 0;
  let lastLen = 0;
  let pos = lineStart;
  const minStep = Math.max(1, Math.floor(cap * 0.35));
  while (pos < limit) {
    const remaining = limit - pos;
    if (remaining <= cap) {
      wrappedCount++;
      lastLen = remaining;
      break;
    }
    const maxEnd = pos + cap;
    let breakAt = -1;
    const minBreak = pos + minStep;
    for (let k = maxEnd; k >= minBreak; k--) {
      const code = text.charCodeAt(k - 1);
      if (code === 32 || code === 9) {
        breakAt = k;
        break;
      }
    }
    if (breakAt === -1) {
      breakAt = maxEnd;
    }
    wrappedCount++;
    lastLen = breakAt - pos;
    pos = breakAt;
  }
  return wrappedCount - 1 + (lastLen >= cap ? 1 : 0);
}

/**
 * Zero-allocation visual line counter across a substring range [rangeStart, rangeEnd].
 */
function countRangeVisualLines(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  charsPerLine: number
): number {
  if (rangeEnd < rangeStart) return 0;
  const cap = Math.max(1, charsPerLine);
  let lines = 0;
  let lineStart = rangeStart;
  for (let i = rangeStart; i <= rangeEnd; i++) {
    const isEnd = i === rangeEnd;
    if (isEnd || text.charCodeAt(i) === 10) {
      const segLen = i - lineStart;
      if (segLen <= cap) {
        lines += 1;
      } else {
        lines += countParagraphVisualLines(text, lineStart, i, cap);
      }
      lineStart = i + 1;
    }
  }
  return lines;
}

function findParagraphStart(text: string, offset: number): number {
  let p = Math.max(0, Math.min(text.length, offset));
  while (p > 0 && text.charCodeAt(p - 1) !== 10) {
    p--;
  }
  return p;
}

function findParagraphEnd(text: string, offset: number): number {
  const len = text.length;
  let p = Math.max(0, Math.min(len, offset));
  while (p < len && text.charCodeAt(p) !== 10) {
    p++;
  }
  return p;
}

/**
 * Computes seamless paragraph-aligned active window bounds [winStart, winEnd] around centerOffset
 * so the native <TextInput> never holds more than ~2,800 characters even on 10 MB notes.
 * Guarantees:
 * - winStart === 0 or text.charCodeAt(winStart - 1) === 10 (unless a single paragraph has >600 chars)
 * - winEnd === text.length or text.charCodeAt(winEnd) === 10 (unless a single paragraph has >600 chars)
 */
export function computeWindowBounds(
  text: string,
  centerOffset: number,
  enabled = true
): { winStart: number; winEnd: number } {
  const len = text.length;
  if (!enabled || len <= WINDOW_MODE_THRESHOLD) {
    return { winStart: 0, winEnd: len };
  }
  const c = Math.max(0, Math.min(len, centerOffset));
  let rawStart = Math.max(0, c - WINDOW_TARGET_RADIUS);
  let rawEnd = Math.min(len, c + WINDOW_TARGET_RADIUS);
  if (rawStart === 0) {
    rawEnd = Math.min(len, WINDOW_TARGET_RADIUS * 2);
  } else if (rawEnd === len) {
    rawStart = Math.max(0, len - WINDOW_TARGET_RADIUS * 2);
  }

  let winStart = rawStart;
  if (winStart > 0) {
    const minSearch = Math.max(0, winStart - 600);
    let foundNl = -1;
    for (let i = winStart - 1; i >= minSearch; i--) {
      if (text.charCodeAt(i) === 10) {
        foundNl = i;
        break;
      }
    }
    if (foundNl === -1) {
      const maxForward = Math.min(c, winStart + 400);
      for (let i = winStart; i < maxForward; i++) {
        if (text.charCodeAt(i) === 10) {
          foundNl = i;
          break;
        }
      }
    }
    if (foundNl !== -1) {
      winStart = foundNl + 1;
    } else if (minSearch === 0) {
      winStart = 0;
    }
  }

  let winEnd = rawEnd;
  if (winEnd < len) {
    const maxSearch = Math.min(len, winEnd + 600);
    let foundNl = -1;
    for (let i = winEnd; i < maxSearch; i++) {
      if (text.charCodeAt(i) === 10) {
        foundNl = i;
        break;
      }
    }
    if (foundNl === -1) {
      const minBackward = Math.max(c, winEnd - 400);
      for (let i = winEnd - 1; i >= minBackward; i--) {
        if (text.charCodeAt(i) === 10) {
          foundNl = i;
          break;
        }
      }
    }
    if (foundNl !== -1) {
      winEnd = foundNl;
    } else if (maxSearch === len) {
      winEnd = len;
    }
  }

  if (winStart > c) winStart = c;
  if (winEnd < c) winEnd = c;
  return { winStart, winEnd };
}

/**
 * Maps a tapped visual line & horizontal column within text[startOffset .. endOffset]
 * to the corresponding character offset.
 */
function advanceByVisualLines(
  text: string,
  startOffset: number,
  endOffset: number,
  targetLineDelta: number,
  approxCol: number,
  charsPerLine: number
): number {
  if (startOffset >= endOffset) return startOffset;
  const cap = Math.max(1, charsPerLine);
  const targetLine = Math.max(0, targetLineDelta);
  let curLine = 0;
  let lineStart = startOffset;
  for (let i = startOffset; i <= endOffset; i++) {
    const isEnd = i === endOffset;
    if (isEnd || text.charCodeAt(i) === 10) {
      const segLen = i - lineStart;
      const segLines = segLen <= cap ? 1 : countParagraphVisualLines(text, lineStart, i, cap);
      if (curLine + segLines > targetLine) {
        const subLines = targetLine - curLine;
        const subStart = Math.min(i, lineStart + subLines * cap);
        const subEnd = Math.min(i, subStart + cap);
        return Math.min(subEnd, subStart + Math.max(0, approxCol));
      }
      curLine += segLines;
      lineStart = i + 1;
    }
  }
  return endOffset;
}

type IncrementalGeoCache = {
  text: string;
  charsPerLine: number;
  totalLines: number;
  anchorOffset: number; // Always at a paragraph start (0 or after '\n')
  anchorLineIndex: number; // Exact visual lines in text[0 .. anchorOffset)
};

let lastGeoCache: IncrementalGeoCache | null = null;

function moveGeoCacheAnchor(cache: IncrementalGeoCache, targetParaStart: number): void {
  const cur = cache.anchorOffset;
  if (targetParaStart === cur) return;
  if (targetParaStart === 0) {
    cache.anchorOffset = 0;
    cache.anchorLineIndex = 0;
    return;
  }
  if (targetParaStart > cur) {
    const deltaLines = countRangeVisualLines(
      cache.text,
      cur,
      targetParaStart - 1,
      cache.charsPerLine
    );
    cache.anchorOffset = targetParaStart;
    cache.anchorLineIndex += deltaLines;
  } else {
    const deltaLines = countRangeVisualLines(
      cache.text,
      targetParaStart,
      cur - 1,
      cache.charsPerLine
    );
    cache.anchorOffset = targetParaStart;
    cache.anchorLineIndex = Math.max(0, cache.anchorLineIndex - deltaLines);
  }
}

function updateGeoCacheForEdit(
  fromText: string,
  toText: string,
  diffStart: number,
  fromEnd: number
): void {
  if (!lastGeoCache || lastGeoCache.text !== fromText || !toText) {
    return;
  }
  const cap = lastGeoCache.charsPerLine;
  const paraStart = findParagraphStart(fromText, diffStart);
  moveGeoCacheAnchor(lastGeoCache, paraStart);

  const oldParaEnd = findParagraphEnd(fromText, fromEnd);
  const newParaEnd = Math.max(
    paraStart,
    Math.min(toText.length, oldParaEnd + (toText.length - fromText.length))
  );

  const oldSpanLines = countRangeVisualLines(fromText, paraStart, oldParaEnd, cap);
  const newSpanLines = countRangeVisualLines(toText, paraStart, newParaEnd, cap);

  lastGeoCache.text = toText;
  lastGeoCache.totalLines = Math.max(1, lastGeoCache.totalLines - oldSpanLines + newSpanLines);
}

function ensureGeoCache(text: string, charsPerLine: number): IncrementalGeoCache {
  const cap = Math.max(1, charsPerLine);
  if (lastGeoCache && lastGeoCache.text === text && lastGeoCache.charsPerLine === cap) {
    return lastGeoCache;
  }
  const totalLines = text ? countRangeVisualLines(text, 0, text.length, cap) : 0;
  lastGeoCache = {
    text,
    charsPerLine: cap,
    totalLines,
    anchorOffset: 0,
    anchorLineIndex: 0,
  };
  return lastGeoCache;
}

export function computeVisualLines(
  text: string,
  charsPerLine: number,
  lineHeight = 25
): VisualLineMetric[] {
  if (!text) {
    return [];
  }
  const metrics: VisualLineMetric[] = [];
  const len = text.length;
  let lineStart = 0;
  let visualIdx = 0;

  for (let i = 0; i <= len; i++) {
    const isEnd = i === len;
    const isNewline = !isEnd && text.charCodeAt(i) === 10;
    if (isEnd || isNewline) {
      const wrapped = wrapParagraphOffsets(text, lineStart, i, charsPerLine);
      for (let w = 0; w < wrapped.length; w++) {
        metrics.push({
          lineIndex: visualIdx,
          startOffset: wrapped[w].start,
          endOffset: wrapped[w].end,
          y: visualIdx * lineHeight,
          height: lineHeight,
        });
        visualIdx++;
      }
      lineStart = i + 1;
    }
  }
  return metrics;
}

export function countVisualLines(text: string, charsPerLine: number): number {
  if (!text) return 0;
  return ensureGeoCache(text, charsPerLine).totalLines;
}

export function getVisualLineForOffset(
  text: string,
  charOffset: number,
  charsPerLine: number
): number {
  if (!text || charOffset <= 0) return 0;
  const limit = Math.min(text.length, charOffset);
  const cap = Math.max(1, charsPerLine);
  const cache = ensureGeoCache(text, cap);
  const paraStart = findParagraphStart(text, limit);
  moveGeoCacheAnchor(cache, paraStart);
  return cache.anchorLineIndex + getParagraphVisualLineOffset(text, paraStart, limit, cap);
}

export function parseNativeTextLines(
  text: string,
  rawLines: { text: string; y?: number; height?: number }[],
  defaultLineHeight: number
): { lines: VisualLineMetric[]; totalHeight: number } {
  if (!text || !rawLines || rawLines.length === 0) {
    return { lines: [], totalHeight: 0 };
  }
  const lines: VisualLineMetric[] = [];
  let pos = 0;
  let runningY = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const lineText = typeof raw.text === 'string' ? raw.text : '';
    const hasTrailingNewline = lineText.endsWith('\n');
    const contentLen = hasTrailingNewline ? lineText.length - 1 : lineText.length;
    const startOffset = pos;
    const endOffset = Math.min(text.length, startOffset + contentLen);
    const h = raw.height && raw.height > 0 ? raw.height : defaultLineHeight;
    const y = typeof raw.y === 'number' && raw.y >= 0 ? raw.y : runningY;

    lines.push({
      lineIndex: lines.length,
      startOffset,
      endOffset,
      y,
      height: h,
    });

    pos = Math.min(text.length, startOffset + lineText.length);
    runningY = y + h;
  }

  // If the text ends with a newline, the caret after that newline sits on a new trailing visual line
  if (text.endsWith('\n')) {
    const lastLine = lines[lines.length - 1];
    const nextY = lastLine ? lastLine.y + lastLine.height : runningY;
    const nextH = lastLine ? lastLine.height : defaultLineHeight;
    if (!lastLine || lastLine.startOffset < text.length || rawLines[rawLines.length - 1]?.text.endsWith('\n')) {
      lines.push({
        lineIndex: lines.length,
        startOffset: text.length,
        endOffset: text.length,
        y: nextY,
        height: nextH,
      });
      runningY = nextY + nextH;
    }
  }

  return { lines, totalHeight: runningY };
}

export function resolveOffsetGeometry({
  text,
  charOffset,
  scale,
  screenWidth,
  fontFamily,
  nativeLayout,
}: {
  text: string;
  charOffset: number;
  scale: number;
  screenWidth?: number;
  fontFamily?: string;
  nativeLayout?: NativeLayoutCache | null;
}): {
  lineIndex: number;
  totalLines: number;
  lineHeight: number;
  cursorY: number;
  textBottom: number;
} {
  const lineHeight = getEditorLineHeight(scale);
  const winWidth = screenWidth || Dimensions.get('window').width;
  const charsPerLine = estimateCharsPerLine(winWidth, scale, fontFamily);
  const clampedOffset = Math.max(0, Math.min(text.length, charOffset));

  if (!text) {
    return {
      lineIndex: 0,
      totalLines: 0,
      lineHeight,
      cursorY: EDITOR_TOP_PAD,
      textBottom: EDITOR_TOP_PAD + EDITOR_BOTTOM_PAD,
    };
  }

  // 1. Exact match with native onTextLayout measurement
  if (
    nativeLayout &&
    nativeLayout.text === text &&
    nativeLayout.scale === scale &&
    nativeLayout.lines.length > 0
  ) {
    const lines = nativeLayout.lines;
    let found = lines[lines.length - 1];
    let lo = 0;
    let hi = lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const l = lines[mid];
      if (clampedOffset < l.startOffset) {
        hi = mid - 1;
      } else if (clampedOffset > l.endOffset) {
        lo = mid + 1;
      } else {
        // If clampedOffset === l.endOffset and the next line starts at the same offset (soft wrap boundary),
        // prefer the current line unless clampedOffset is at the very end of a wrapped segment
        found = l;
        break;
      }
    }
    return {
      lineIndex: found.lineIndex,
      totalLines: lines.length,
      lineHeight: found.height || lineHeight,
      cursorY: EDITOR_TOP_PAD + found.y,
      textBottom: EDITOR_TOP_PAD + nativeLayout.totalHeight + EDITOR_BOTTOM_PAD,
    };
  }

  // 2. Prefix reuse when nativeLayout is from the immediately preceding keystroke
  if (
    nativeLayout &&
    nativeLayout.scale === scale &&
    nativeLayout.lines.length > 0 &&
    Math.abs(nativeLayout.text.length - text.length) <= 8
  ) {
    // Find paragraph start of clampedOffset
    const paraStart = findParagraphStart(text, clampedOffset);
    if (
      paraStart > 0 &&
      nativeLayout.text.length >= paraStart &&
      nativeLayout.text.charCodeAt(paraStart - 1) === 10 &&
      nativeLayout.text.charCodeAt(0) === text.charCodeAt(0)
    ) {
      // Find the native line corresponding to paraStart
      const prefixLine = nativeLayout.lines.find((l) => l.startOffset === paraStart);
      if (prefixLine) {
        const relLineIdx = getParagraphVisualLineOffset(text, paraStart, clampedOffset, charsPerLine);
        const relTotalLines = countRangeVisualLines(text, paraStart, text.length, charsPerLine);
        const totalLines = prefixLine.lineIndex + relTotalLines;
        const lineIndex = prefixLine.lineIndex + relLineIdx;
        const cursorY = EDITOR_TOP_PAD + prefixLine.y + relLineIdx * lineHeight;
        const textBottom =
          EDITOR_TOP_PAD + prefixLine.y + relTotalLines * lineHeight + EDITOR_BOTTOM_PAD;
        return {
          lineIndex,
          totalLines,
          lineHeight,
          cursorY,
          textBottom,
        };
      }
    }
  }

  // 3. Deterministic word-wrapping layout calculation (O(1) incremental via lastGeoCache)
  const totalLines = countVisualLines(text, charsPerLine);
  const lineIndex = getVisualLineForOffset(text, clampedOffset, charsPerLine);
  const cursorY = EDITOR_TOP_PAD + lineIndex * lineHeight;
  const textBottom = EDITOR_TOP_PAD + totalLines * lineHeight + EDITOR_BOTTOM_PAD;

  return {
    lineIndex,
    totalLines,
    lineHeight,
    cursorY,
    textBottom,
  };
}

export function calculateNoteTextHeight(
  text: string,
  scale: number,
  screenWidth?: number,
  nativeLayout?: NativeLayoutCache | null
): number {
  if (!text) return 0;
  const geom = resolveOffsetGeometry({
    text,
    charOffset: text.length,
    scale,
    screenWidth,
    nativeLayout,
  });
  return geom.textBottom - EDITOR_BOTTOM_PAD;
}

export function calculateJumpToEndScrollY({
  text,
  scale,
  viewH,
  screenWidth,
  fontFamily,
  nativeLayout,
}: {
  text: string;
  scale: number;
  viewH: number;
  screenWidth?: number;
  fontFamily?: string;
  nativeLayout?: NativeLayoutCache | null;
}): number {
  if (!text || viewH <= 0) return 0;
  const geom = resolveOffsetGeometry({
    text,
    charOffset: text.length,
    scale,
    screenWidth,
    fontFamily,
    nativeLayout,
  });
  return Math.max(0, Math.round(geom.textBottom - viewH));
}

export function calculateRevealScrollY({
  editY,
  lineHeight,
  curY,
  viewH,
  contentH,
}: {
  editY: number;
  lineHeight: number;
  curY: number;
  viewH: number;
  contentH: number;
}): { shouldScroll: boolean; targetY: number } {
  if (viewH <= 0) {
    return { shouldScroll: false, targetY: curY };
  }
  const isAlreadyVisible = editY >= curY + 24 && editY + lineHeight <= curY + viewH - 24;
  if (isAlreadyVisible) {
    return { shouldScroll: false, targetY: curY };
  }
  const effectiveContentH = Math.max(contentH, editY + lineHeight + EDITOR_BOTTOM_PAD);
  const maxScroll = Math.max(0, effectiveContentH - viewH);
  const targetCenterY = editY - viewH / 2 + lineHeight / 2;
  const targetY = Math.max(0, Math.min(Math.round(targetCenterY), maxScroll));
  return { shouldScroll: targetY !== curY, targetY };
}

export type ScrollReason =
  | 'cursor-placement'
  | 'typing'
  | 'enter'
  | 'deletion'
  | 'undo'
  | 'redo'
  | 'jump-to-end'
  | 'jump-to-top'
  | 'search';

export function calculateScrollDecision({
  reason,
  cursorY,
  lineHeight,
  textBottom,
  curY,
  viewH,
  contentH,
}: {
  reason: ScrollReason;
  cursorY: number;
  lineHeight: number;
  textBottom: number;
  curY: number;
  viewH: number;
  contentH: number;
}): { shouldScroll: boolean; targetY: number } {
  if (viewH <= 0) {
    return { shouldScroll: false, targetY: curY };
  }

  switch (reason) {
    case 'cursor-placement':
      // Rule 2: Cursor placement / tapping alone must never jump the viewport
      return { shouldScroll: false, targetY: curY };

    case 'jump-to-top':
      return { shouldScroll: curY !== 0, targetY: 0 };

    case 'jump-to-end': {
      const targetY = Math.max(0, Math.round(textBottom - viewH));
      return { shouldScroll: Math.abs(targetY - curY) > 1, targetY };
    }

    case 'deletion': {
      // Avoid forced upward or downward scrolling when the caret remains visible in the viewport
      const isCaretVisible =
        cursorY >= curY && cursorY + lineHeight <= curY + viewH;
      if (isCaretVisible) {
        return { shouldScroll: false, targetY: curY };
      }
      if (cursorY < curY) {
        const targetY = Math.max(0, Math.round(cursorY - EDITOR_TOP_PAD));
        return { shouldScroll: targetY !== curY, targetY };
      }
      const targetY = Math.max(0, Math.round(cursorY + lineHeight + EDITOR_BOTTOM_PAD - viewH));
      return { shouldScroll: targetY !== curY, targetY };
    }

    case 'typing':
    case 'enter': {
      // Preserve a bottom breathing margin of ~2 visual lines when viewport height allows,
      // while always keeping the previous line visible.
      const maxCushion = Math.max(0, Math.floor((viewH - 2 * lineHeight) / 2));
      const cushion = Math.min(2 * lineHeight, maxCushion);
      const bottomThreshold = curY + viewH - cushion - lineHeight;

      if (cursorY > bottomThreshold) {
        const targetY = Math.max(0, Math.round(cursorY + cushion + lineHeight - viewH));
        return { shouldScroll: targetY !== curY, targetY };
      }
      if (cursorY < curY + EDITOR_TOP_PAD) {
        const targetY = Math.max(0, Math.round(cursorY - EDITOR_TOP_PAD));
        return { shouldScroll: targetY !== curY, targetY };
      }
      return { shouldScroll: false, targetY: curY };
    }

    case 'undo':
    case 'redo':
    case 'search':
      return calculateRevealScrollY({
        editY: cursorY,
        lineHeight,
        curY,
        viewH,
        contentH: Math.max(contentH, textBottom),
      });
  }
}

export type TextDiff = {
  start: number;
  fromEnd: number;
  toEnd: number;
  removedText: string;
  insertedText: string;
  cursor: number;
  highlightStart: number;
  highlightEnd: number;
};

/**
 * Computes the exact changed range between `fromText` and `toText`.
 * Optional `anchorCursor` (in `toText` or `fromText`) disambiguates repeated identical characters
 * such as consecutive newlines or repeated letters.
 */
export function computeTextDiff(
  fromText: string,
  toText: string,
  anchorCursor?: number,
  updateCache = true
): TextDiff {
  if (fromText === toText) {
    const pos = Math.max(0, Math.min(toText.length, anchorCursor ?? toText.length));
    return {
      start: pos,
      fromEnd: pos,
      toEnd: pos,
      removedText: '',
      insertedText: '',
      cursor: pos,
      highlightStart: pos,
      highlightEnd: pos,
    };
  }

  const fromLen = fromText.length;
  const toLen = toText.length;
  const minLen = Math.min(fromLen, toLen);
  const delta = toLen - fromLen;
  const absDelta = Math.abs(delta);

  let start = -1;
  let suffixLen = -1;

  // Fast O(1) windowed diff around anchorCursor for very large documents (>60 KB)
  if (anchorCursor !== undefined && minLen > 60000 && absDelta <= 4096) {
    const radius = Math.max(256, absDelta + 160);
    const winStart = Math.max(0, Math.min(minLen, anchorCursor - radius));
    let fromWinEnd = Math.min(
      fromLen,
      Math.max(winStart, anchorCursor + radius + (delta < 0 ? absDelta : 0))
    );
    let toWinEnd = fromWinEnd + delta;
    if (toWinEnd > toLen) {
      toWinEnd = toLen;
      fromWinEnd = toWinEnd - delta;
    }
    if (fromWinEnd >= winStart && toWinEnd >= winStart) {
      const prefixOk =
        winStart === 0 ||
        (fromText.charCodeAt(winStart - 1) === toText.charCodeAt(winStart - 1) &&
          fromText.charCodeAt(0) === toText.charCodeAt(0) &&
          fromText.charCodeAt(winStart >>> 1) === toText.charCodeAt(winStart >>> 1));
      const fromMid = (fromWinEnd + fromLen) >>> 1;
      const toMid = fromMid + delta;
      const suffixOk =
        fromWinEnd === fromLen ||
        (fromText.charCodeAt(fromWinEnd) === toText.charCodeAt(toWinEnd) &&
          fromText.charCodeAt(fromLen - 1) === toText.charCodeAt(toLen - 1) &&
          fromText.charCodeAt(fromMid) === toText.charCodeAt(toMid));

      if (prefixOk && suffixOk) {
        let s = winStart;
        const winMinEnd = Math.min(fromWinEnd, toWinEnd);
        while (s < winMinEnd && fromText.charCodeAt(s) === toText.charCodeAt(s)) {
          s++;
        }
        let suf = 0;
        const maxWinSuffix = winMinEnd - s;
        while (
          suf < maxWinSuffix &&
          fromText.charCodeAt(fromWinEnd - 1 - suf) === toText.charCodeAt(toWinEnd - 1 - suf)
        ) {
          suf++;
        }
        const editStartedInside = winStart === 0 || s - winStart >= 64;
        const editEndedInside = fromWinEnd === fromLen || suf >= 64;
        const hasDiffInside = s < fromWinEnd - suf || s < toWinEnd - suf;
        if (editStartedInside && editEndedInside && hasDiffInside) {
          start = s;
          suffixLen = fromLen - fromWinEnd + suf;
        }
      }
    }
  }

  // Fallback full-range scan if edit was outside the local anchor window
  if (start === -1) {
    start = 0;
    while (start < minLen && fromText.charCodeAt(start) === toText.charCodeAt(start)) {
      start++;
    }

    suffixLen = 0;
    const maxSuffix = minLen - start;
    while (
      suffixLen < maxSuffix &&
      fromText.charCodeAt(fromLen - 1 - suffixLen) ===
      toText.charCodeAt(toLen - 1 - suffixLen)
    ) {
      suffixLen++;
    }
  }

  // If anchorCursor is provided and falls inside an ambiguous run of identical characters
  // on a pure insertion or pure deletion, align the edit boundary with anchorCursor.
  if (anchorCursor !== undefined) {
    const curFromEnd = fromLen - suffixLen;
    const curToEnd = toLen - suffixLen;
    if (delta > 0 && curFromEnd === start && anchorCursor < start) {
      // Pure insertion where greedy prefix scan overshot anchorCursor inside an identical-char run
      const candidates = [anchorCursor, anchorCursor - delta];
      for (let c = 0; c < candidates.length; c++) {
        const candidateStart = candidates[c];
        if (candidateStart >= 0 && candidateStart < start) {
          let matchesShift = true;
          for (let i = candidateStart; i < start; i++) {
            if (fromText.charCodeAt(i) !== toText.charCodeAt(i + delta)) {
              matchesShift = false;
              break;
            }
          }
          if (matchesShift) {
            start = candidateStart;
            suffixLen = fromLen - start;
            break;
          }
        }
      }
    } else if (delta < 0 && curToEnd === start && anchorCursor < start) {
      // Pure deletion where greedy prefix scan overshot anchorCursor inside an identical-char run
      const candidates = [anchorCursor, anchorCursor - absDelta];
      for (let c = 0; c < candidates.length; c++) {
        const candidateStart = candidates[c];
        if (candidateStart >= 0 && candidateStart < start) {
          let matchesShift = true;
          for (let i = candidateStart; i < start; i++) {
            if (fromText.charCodeAt(i + absDelta) !== toText.charCodeAt(i)) {
              matchesShift = false;
              break;
            }
          }
          if (matchesShift) {
            start = candidateStart;
            suffixLen = toLen - start;
            break;
          }
        }
      }
    }
  }

  const fromEnd = fromLen - suffixLen;
  const toEnd = toLen - suffixLen;
  const removedText = fromText.slice(start, fromEnd);
  const insertedText = toText.slice(start, toEnd);
  const cursor = toEnd;

  if (updateCache) {
    updateGeoCacheForEdit(fromText, toText, start, fromEnd);
  }

  let highlightStart = start;
  let highlightEnd = toEnd;

  // When an undo/redo removes text (toEnd === start) and toText is non-empty,
  // highlight the character at the deletion boundary on the same line (without inserting extra text).
  if (highlightStart === highlightEnd && toLen > 0) {
    if (start < toLen && toText.charCodeAt(start) !== 10) {
      highlightEnd = start + 1;
    } else if (start > 0 && toText.charCodeAt(start - 1) !== 10) {
      highlightStart = start - 1;
    }
  }

  return {
    start,
    fromEnd,
    toEnd,
    removedText,
    insertedText,
    cursor,
    highlightStart,
    highlightEnd,
  };
}

export function computeEditStep(
  prevText: string,
  nextText: string,
  prevSelection: Sel
): {
  diff: TextDiff;
  newCursor: number;
  isInsertion: boolean;
  isNewline: boolean;
  isDeletion: boolean;
} {
  const diff = computeTextDiff(prevText, nextText, prevSelection.start);
  const newCursor = diff.cursor;
  const isInsertion = nextText.length > prevText.length || diff.insertedText.length > 0;
  const isDeletion = nextText.length < prevText.length && diff.insertedText.length === 0;
  const isNewline = diff.insertedText.includes('\n');
  return {
    diff,
    newCursor,
    isInsertion,
    isNewline,
    isDeletion,
  };
}

function hasNonWhitespace(s: string): boolean {
  for (let i = 0, len = s.length; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 10 && c !== 13 && c !== 9) return true;
  }
  return false;
}

export function findNoteMatches(body: string, query: string, precomputedLowerBody?: string): number[] {
  const trimmed = query.trim();
  if (!body || !trimmed) return [];
  const hay = precomputedLowerBody !== undefined ? precomputedLowerBody : body.toLowerCase();
  const needle = trimmed.toLowerCase();
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

export function renderSearchHighlightSpans(
  text: string,
  searchQuery: string,
  matches: number[],
  activeMatchIndex: number,
  defaultTextColor: string
): React.ReactNode[] {
  if (!searchQuery || !searchQuery.trim() || !text || matches.length === 0) {
    return [
      <Text key="raw" style={{ color: defaultTextColor }}>
        {text}
      </Text>,
    ];
  }
  const needle = searchQuery.trim().toLowerCase();
  const maxWindow = 80;
  const startIdx = Math.max(0, activeMatchIndex - Math.floor(maxWindow / 2));
  const endIdx = Math.min(matches.length, startIdx + maxWindow);
  const adjustedStartIdx = Math.max(0, endIdx - maxWindow);

  const parts: React.ReactNode[] = [];
  let key = 0;
  let last = 0;

  const firstMatchChar = matches[adjustedStartIdx];
  if (adjustedStartIdx > 0 && firstMatchChar > 0) {
    parts.push(
      <Text key={key++} style={{ color: defaultTextColor }}>
        {text.slice(0, firstMatchChar)}
      </Text>
    );
    last = firstMatchChar;
  }

  for (let m = adjustedStartIdx; m < endIdx; m++) {
    const idx = matches[m];
    if (idx > last) {
      parts.push(
        <Text key={key++} style={{ color: defaultTextColor }}>
          {text.slice(last, idx)}
        </Text>
      );
    }
    const isCurrent = m === activeMatchIndex;
    parts.push(
      <Text
        key={key++}
        style={{
          backgroundColor: isCurrent ? '#16a34a' : '#dc2626',
          color: '#ffffff',
          fontWeight: '700',
          borderRadius: 2,
        }}
      >
        {text.slice(idx, idx + needle.length)}
      </Text>
    );
    last = idx + needle.length;
  }

  if (last < text.length) {
    parts.push(
      <Text key={key++} style={{ color: defaultTextColor }}>
        {text.slice(last)}
      </Text>
    );
  }

  return parts;
}

export function renderUndoHighlightSpans(
  text: string,
  highlightStart: number,
  highlightEnd: number,
  defaultTextColor: string,
  dimmedTextColor: string,
  isDark = true
): React.ReactNode[] {
  if (!text) return [];
  const start = Math.max(0, Math.min(text.length, highlightStart));
  const end = Math.max(start, Math.min(text.length, highlightEnd));

  if (start === end) {
    return [
      <Text key="all" style={{ color: defaultTextColor }}>
        {text}
      </Text>,
    ];
  }

  const parts: React.ReactNode[] = [];
  if (start > 0) {
    parts.push(
      <Text key="before" style={{ color: dimmedTextColor }}>
        {text.slice(0, start)}
      </Text>
    );
  }
  parts.push(
    <Text
      key="highlight"
      style={{
        backgroundColor: isDark ? '#ca8a04' : '#fef08a',
        color: isDark ? '#ffffff' : '#111827',
        borderRadius: 2,
      }}
    >
      {text.slice(start, end)}
    </Text>
  );
  if (end < text.length) {
    parts.push(
      <Text key="after" style={{ color: dimmedTextColor }}>
        {text.slice(end)}
      </Text>
    );
  }
  return parts;
}

type HistoryEntry = {
  text: string;
  cursor: number;
};

type UndoHighlightState = {
  start: number;
  end: number;
  cursor: number;
};

/* Memoized Toolbar containing 7 actions: Copy, Paste, Undo, Redo, Search, 123 (Note Details), Read-Only Lock */
const NoteToolbar = React.memo(function NoteToolbar({
  theme,
  visible,
  readOnly,
  canUndo,
  canRedo,
  onCopy,
  onPaste,
  onUndo,
  onRedo,
  onSearchToggle,
  onShowDetails,
  onToggleReadOnly,
}: {
  theme: any;
  visible: boolean;
  readOnly: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onUndo: () => void | boolean;
  onRedo: () => void | boolean;
  onSearchToggle: () => void;
  onShowDetails: () => void;
  onToggleReadOnly: () => void;
}) {
  if (!visible) return null;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
        borderBottomWidth: 1,
        borderBottomColor: theme.border,
        backgroundColor: theme.bg,
        paddingVertical: 2,
        paddingHorizontal: 4,
        zIndex: 10,
      }}
    >
      <IconBtn
        name="copy-outline"
        onPress={onCopy}
        accessibilityLabel="Copy note or selection"
      />
      <IconBtn
        name="clipboard-outline"
        onPress={onPaste}
        disabled={readOnly}
        accessibilityLabel="Paste from clipboard"
      />
      <IconBtn
        name="arrow-undo"
        onPress={onUndo}
        repeatPress
        disabled={readOnly || !canUndo}
        accessibilityLabel="Undo (tap, or hold for fast undo)"
      />
      <IconBtn
        name="arrow-redo"
        onPress={onRedo}
        repeatPress
        disabled={readOnly || !canRedo}
        accessibilityLabel="Redo (tap, or hold for fast redo)"
      />
      <IconBtn
        name="search"
        onPress={onSearchToggle}
        accessibilityLabel="Find in note"
      />
      {/* Note details 123 button */}
      <Pressable
        onPress={onShowDetails}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="Note details (word, character, and line count)"
        style={({ pressed }) => ({
          width: 44,
          height: 38,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 8,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <T
          pointerEvents="none"
          bold
          size={16}
          style={{
            color: theme.text,
          }}
        >
          123
        </T>
      </Pressable>
      {/* Read-Only mode toggle button */}
      <IconBtn
        name={readOnly ? 'lock-closed' : 'lock-open-outline'}
        color={readOnly ? theme.accent : theme.text}
        onPress={onToggleReadOnly}
        accessibilityLabel={
          readOnly ? 'Read-only mode active (tap to unlock)' : 'Tap to enable read-only mode'
        }
      />
    </View>
  );
});

const EMPTY_MATCHES: number[] = [];

/** One real (measured) wrapped line of a static chunk. Offsets are relative to the chunk's text. */
type ChunkLine = { start: number; end: number; y: number; height: number; x: number; width: number };

function buildChunkLines(rawLines: any[]): ChunkLine[] {
  const out: ChunkLine[] = [];
  let pos = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const r = rawLines[i];
    const t: string = typeof r?.text === 'string' ? r.text : '';
    const content = t.endsWith('\n') ? t.length - 1 : t.length;
    out.push({
      start: pos,
      end: pos + content,
      y: typeof r?.y === 'number' ? r.y : 0,
      height: typeof r?.height === 'number' ? r.height : 0,
      x: typeof r?.x === 'number' ? r.x : 0,
      width: typeof r?.width === 'number' ? r.width : 0,
    });
    pos += t.length;
  }
  return out;
}

type ChunkInfoPatch = { y?: number; h?: number; text?: string; lines?: any[] };

const WindowStaticChunk = React.memo(function WindowStaticChunk({
  text,
  chunkKind,
  paddingTop,
  paddingBottom,
  themeText,
  inputFont,
  scale,
  lineHeight,
  onChunkPress,
  onChunkInfo,
}: {
  text: string;
  chunkKind: 'prefix' | 'suffix' | 'top-spacer' | 'bottom-spacer';
  paddingTop: number;
  paddingBottom: number;
  themeText: string;
  inputFont?: string;
  scale: number;
  lineHeight: number;
  onChunkPress: (
    chunkKind: 'prefix' | 'suffix' | 'top-spacer' | 'bottom-spacer',
    locationX: number,
    locationY: number,
    paddingTop: number,
    pageX?: number,
    pageY?: number
  ) => void;
  onChunkInfo?: (kind: string, patch: ChunkInfoPatch) => void;
}) {
  if (!text) return null;
  return (
    <Pressable
      onPress={(e) => {
        const locX = e?.nativeEvent?.locationX ?? 0;
        const locY = e?.nativeEvent?.locationY ?? 0;
        onChunkPress(chunkKind, locX, locY, paddingTop, e?.nativeEvent?.pageX, e?.nativeEvent?.pageY);
      }}
      onLayout={(e) => onChunkInfo?.(chunkKind, { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height })}
      style={{
        paddingHorizontal: EDITOR_H_PAD,
        paddingTop,
        paddingBottom,
      }}
    >
      <Text
        textBreakStrategy="simple"
        onTextLayout={(e) => onChunkInfo?.(chunkKind, { text, lines: e.nativeEvent.lines })}
        style={{
          color: themeText,
          fontFamily: inputFont,
          fontSize: 17 * scale,
          lineHeight,
          fontWeight: '400',
          includeFontPadding: false,
        }}
      >
        {text}
      </Text>
    </Pressable>
  );
});

export function NoteEditor({ id, isNew }: { id: string; isNew: boolean }) {
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { theme, scale, inputFont } = useAppearance();
  const { s, get } = useSettings();

  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState('');
  const [prefixRaw, setPrefixRaw] = useState('');
  const [windowText, setWindowText] = useState('');
  const [suffixRaw, setSuffixRaw] = useState('');
  const [windowedMode, setWindowedMode] = useState(true);
  const [scrollAnchorLine, setScrollAnchorLine] = useState(-1);
  const [readOnly, setReadOnly] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [sel, setSel] = useState<Sel | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [undoHighlight, setUndoHighlight] = useState<UndoHighlightState | null>(null);
  const undoHighlightRef = useRef<UndoHighlightState | null>(null);

  const kbHeightRef = useRef(0);
  const baseContainerHeightRef = useRef(0);
  const bodyInputRef = useRef<TextInput>(null);
  const editorWidthRef = useRef(0);
  const nativeLayoutRef = useRef<NativeLayoutCache | null>(null);
  const undoHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUndoRedoAtRef = useRef(0);
  const lastKnownCursorYRef = useRef(-1);

  const titleRef = useRef('');
  const bodyRef = useRef('');
  const prefixRawRef = useRef('');
  const windowTextRef = useRef('');
  const suffixRawRef = useRef('');
  const windowedModeRef = useRef(true);
  const prefixVisStartRef = useRef(0);
  const suffixVisEndRef = useRef(0);
  const topSpacerSliceRef = useRef({ start: 0, end: 0 });
  const bottomSpacerSliceRef = useRef({ start: 0, end: 0 });
  const scrollAnchorLineRef = useRef(-1);

  const applyFullTextAndWindow = useCallback(
    (fullText: string, centerCursor: number, enabled = windowedModeRef.current) => {
      const { winStart, winEnd } = computeWindowBounds(fullText, centerCursor, enabled);
      const nextPrefix = winStart > 0 ? fullText.slice(0, winStart) : '';
      const nextWin = fullText.slice(winStart, winEnd);
      const nextSuffix = winEnd < fullText.length ? fullText.slice(winEnd) : '';
      bodyRef.current = fullText;
      prefixRawRef.current = nextPrefix;
      windowTextRef.current = nextWin;
      suffixRawRef.current = nextSuffix;
      setPrefixRaw((prev) => (prev === nextPrefix ? prev : nextPrefix));
      setWindowText((prev) => (prev === nextWin ? prev : nextWin));
      setSuffixRaw((prev) => (prev === nextSuffix ? prev : nextSuffix));
    },
    []
  );
  const original = useRef({ title: '', body: '' });
  const dirty = useRef(false);
  const isSelfSavingRef = useRef(false);
  const revSaved = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Enhanced Undo / Redo engine */
  const historyStack = useRef<HistoryEntry[]>([{ text: '', cursor: 0 }]);
  const historyIndex = useRef<number>(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const canUndoRef = useRef(false);
  const canRedoRef = useRef(false);
  const histDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selRef = useRef<Sel>({ start: 0, end: 0 });
  const lastEditCursorRef = useRef<number>(0);
  const lastEditKindRef = useRef<'insert' | 'delete' | 'replace' | null>(null);
  const programmaticSelRef = useRef<{ start: number; end: number; until: number } | null>(null);
  const pendingChunkFocusRef = useRef(false);
  const windowWrapperYRef = useRef(0);
  const windowWrapperPrefixLenRef = useRef(0);
  const nativeWindowLayoutRef = useRef<NativeLayoutCache | null>(null);
  const pendingRevealRef = useRef<{
    revealOffset: number;
    cursorOffset: number;
    preScrollY: number;
    wasOffscreen: boolean;
    animated: boolean;
    until: number;
  } | null>(null);
  const focused = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const lastScrollAtRef = useRef(0);
  const contentH = useRef(0);
  const viewH = useRef(0);
  const textHeightRef = useRef(0);
  const isUserScrollingRef = useRef(false);
  const pendingEnd = useRef(false);
  const leaving = useRef(false);
  const hasPoppedRef = useRef(false);

  const isEffectiveReadOnly = readOnly || s.readOnlyMode;

  const applyProgrammaticSelection = useCallback((cursor: number) => {
    dbg(`PROGRAMMATIC selection -> ${cursor}`);
    const nextSel = { start: cursor, end: cursor };
    selRef.current = nextSel;
    programmaticSelRef.current = {
      start: cursor,
      end: cursor,
      until: Date.now() + 260,
    };
    setSel(nextSel);
  }, []);

  const clearUndoHighlight = useCallback(() => {
    if (undoHighlightTimer.current) {
      clearTimeout(undoHighlightTimer.current);
      undoHighlightTimer.current = null;
    }
    if (undoHighlightRef.current !== null) {
      undoHighlightRef.current = null;
      setUndoHighlight(null);
    }
  }, []);

  const triggerUndoHighlight = useCallback(
    (range: UndoHighlightState, deferForRapidBurst = false) => {
      if (undoHighlightTimer.current) {
        clearTimeout(undoHighlightTimer.current);
      }
      if (deferForRapidBurst) {
        undoHighlightTimer.current = setTimeout(() => {
          undoHighlightRef.current = range;
          setUndoHighlight(range);
          undoHighlightTimer.current = setTimeout(() => {
            undoHighlightTimer.current = null;
            undoHighlightRef.current = null;
            setUndoHighlight(null);
          }, 800);
        }, 65);
        return;
      }
      undoHighlightRef.current = range;
      setUndoHighlight(range);
      undoHighlightTimer.current = setTimeout(() => {
        undoHighlightTimer.current = null;
        undoHighlightRef.current = null;
        setUndoHighlight(null);
      }, 850);
    },
    []
  );

  /* Coherent keyboard compensation: only add bottom padding for the portion not already resized by OS */
  const osShrink =
    keyboardHeight > 0 && baseContainerHeightRef.current > 0 && containerHeight > 0
      ? Math.max(0, baseContainerHeightRef.current - containerHeight)
      : 0;
  const effectiveKbPadding =
    keyboardHeight > 0 ? Math.max(0, keyboardHeight - osShrink) : 0;

  // viewH is the ScrollView's own laid-out height. The keyboard padding is applied to its parent
  // container, so the ScrollView has ALREADY shrunk by that amount. Subtracting the padding again
  // made the editor think it had only ~80px of room, which pinned the cursor line near the top of
  // the screen on every Enter and pushed the previous line out of view.
  const getUsableViewportHeight = useCallback(() => {
    if (viewH.current > 0) {
      return Math.max(80, viewH.current);
    }
    return Math.max(80, Dimensions.get('window').height - kbHeightRef.current - 140);
  }, []);

  /* First tap into an unfocused note: Android scrolls the ScrollView to reveal the (note-tall)
     TextInput, which throws the view away from where the user tapped. Remember where the view was
     and where the tap landed, then hold the view there while the keyboard opens. */
  const pendingTapRef = useRef<{ scrollY: number; contentY: number | null; at: number } | null>(null);
  const tapRestoreRef = useRef<{
    scrollY: number;
    contentY: number | null;
    startAt: number;
    until: number;
    fixes: number;
    lastTarget?: number;
    sameTries?: number;
    glideTo?: number;
    glideUntil?: number;
  } | null>(null);

  /* Height of the text area itself (prefix + editable window + suffix). The ScrollView must never
     scroll past its bottom: anything beyond is blank "gap" under the last line. */
  const wrapH = useRef(0);
  const maxTextScroll = useCallback(
    () => (wrapH.current > 0 && viewH.current > 0 ? Math.max(0, wrapH.current - viewH.current) : Infinity),
    []
  );

  const rememberTap = useCallback((contentY: number | null) => {
    if (!HOLD_VIEW_ON_FIRST_TAP || focused.current) return;
    pendingTapRef.current = { scrollY: scrollY.current, contentY, at: Date.now() };
  }, []);

  const computeTapRestoreY = useCallback(
    (tap: { scrollY: number; contentY: number | null }) => {
      const vh = getUsableViewportHeight();
      const lh = getEditorLineHeight(scale);
      const margin = KEYBOARD_GAP_LINES * lh;
      let target = tap.scrollY;
      if (tap.contentY !== null) {
        // Keep the tapped line on screen above the keyboard with ~2 lines of space below it.
        if (tap.contentY + lh > target + vh - margin) {
          target = tap.contentY + lh + margin - vh;
        }
        if (tap.contentY < target) {
          target = tap.contentY - margin;
        }
      }
      const maxScroll = contentH.current > 0 ? Math.max(0, contentH.current - viewH.current) : Infinity;
      return Math.max(0, Math.min(Math.round(target), maxScroll, maxTextScroll()));
    },
    [getUsableViewportHeight, scale, maxTextScroll]
  );

  const enforceTapRestore = useCallback(
    (currentY: number) => {
      const tap = tapRestoreRef.current;
      if (!tap) return;
      const now = Date.now();
      if (now > tap.until || tap.fixes >= 40 || isUserScrollingRef.current) {
        tapRestoreRef.current = null;
        return;
      }
      // Do not move the view while the tap is still being completed: scrolling at that moment
      // can swallow the tap so the caret is never placed.
      if (now < tap.startAt) return;
      const target = computeTapRestoreY(tap);
      if (SMOOTH_FIRST_TAP && kbHeightRef.current > 0) {
        // Our own glide is still running toward this spot: let it finish.
        if (tap.glideTo === target && now < (tap.glideUntil ?? 0)) return;
        // Android is still scrolling by itself (keyboard opening): moving the view now would make the
        // two fight. Wait; the timers re-check once it has stopped.
        if (now - lastScrollAtRef.current < 90) return;
      }
      if (Math.abs(currentY - target) > 2) {
        // If the system keeps pulling the view back to the same place, that place is the real end of
        // the content: stop fighting it (that fight is what left blank space under the last line).
        if (tap.lastTarget === target) {
          tap.sameTries = (tap.sameTries ?? 0) + 1;
          if (tap.sameTries >= 2) {
            dbg(`gives up y=${Math.round(currentY)} tgt=${target} content=${Math.round(contentH.current)} wrap=${Math.round(wrapH.current)} input=${Math.round(textHeightRef.current)} viewH=${Math.round(viewH.current)}`);
            tapRestoreRef.current = null;
            return;
          }
        } else {
          tap.lastTarget = target;
          tap.sameTries = 0;
        }
        tap.fixes++;
        dbg(`hold-view scroll ${Math.round(currentY)} -> ${target}`);
        scrollY.current = target;
        if (SMOOTH_FIRST_TAP && kbHeightRef.current > 0 && Math.abs(currentY - target) > 12) {
          tap.glideTo = target;
          tap.glideUntil = now + 350;
          scrollRef.current?.scrollTo({ y: target, animated: true });
        } else {
          scrollRef.current?.scrollTo({ y: target, animated: false });
        }
      }
    },
    [computeTapRestoreY]
  );

  /* On the first tap Android sometimes leaves the caret un-drawn (focus + keyboard animation +
     scroll all land together). Re-applying the current selection, once the keyboard is up,
     does what a second tap used to do: it restarts the caret. Only done after the real selection
     for this focus has arrived, so it can never move the caret somewhere new. */
  const selectionSinceFocusRef = useRef(false);
  const caretWokenRef = useRef(false);
  /* Android placed the caret itself on a first tap but it is not drawn until the selection changes
     (a second tap). Setting the caret from our own code works (that is what a tap on the static
     text does), but the app's selection already equals Android's, so re-setting the same value
     does nothing. So nudge it one character and straight back, once per focus. */
  const reassertCaret = useCallback(() => {
    if (!WAKE_CARET_ON_FIRST_TAP || caretWokenRef.current) return;
    if (!focused.current || !selectionSinceFocusRef.current) return;
    if (programmaticSelRef.current && Date.now() < programmaticSelRef.current.until) return;
    // Don't nudge the caret while the screen is still moving (keyboard opening); a later timer retries.
    if (SMOOTH_FIRST_TAP && Date.now() - lastScrollAtRef.current < 120) return;
    const { start, end } = selRef.current;
    if (start !== end) return; // only for a plain caret, never over a real selection
    const winStart = prefixRawRef.current.length;
    const winEnd = winStart + windowTextRef.current.length;
    const alt = start < winEnd ? start + 1 : start > winStart ? start - 1 : -1;
    if (alt < 0) return;
    caretWokenRef.current = true;
    dbg(`wake caret ${start} via ${alt}`);
    applyProgrammaticSelection(alt);
    setTimeout(() => {
      if (focused.current && selRef.current.start === alt) {
        dbg(`wake caret back to ${start}`);
        applyProgrammaticSelection(start);
      }
    }, 45);
  }, [applyProgrammaticSelection]);

  const onKeyboardShownRef = useRef<() => void>(() => { });
  onKeyboardShownRef.current = () => {
    [60, 220, 450].forEach((ms) =>
      setTimeout(() => {
        enforceTapRestore(scrollY.current);
      }, ms)
    );
    // After the keyboard layout settles, the caret may need its nudge again.
    setTimeout(reassertCaret, 320);
    // One single, instant correction once the keyboard has finished opening: if the line with the
    // caret is hidden behind the keyboard, lift it just above it. Does nothing if it is visible.
    setTimeout(() => {
      if (!focused.current || isUserScrollingRef.current) return;
      const { start, end } = selRef.current;
      if (start !== end) return;
      const meas = windowLinesRef.current;
      if (!meas || meas.lines.length === 0 || meas.text !== windowTextRef.current) return;
      const local = Math.max(0, Math.min(meas.text.length, end - prefixRawRef.current.length));
      let line = meas.lines[meas.lines.length - 1];
      for (let i = 0; i < meas.lines.length; i++) {
        if (local <= meas.lines[i].end) {
          line = meas.lines[i];
          break;
        }
      }
      const padTop = prefixRawRef.current.length > 0 ? 0 : EDITOR_TOP_PAD;
      const lh = line.height || getEditorLineHeight(scale);
      const caretY = windowWrapperYRef.current + padTop + line.y;
      const vh = getUsableViewportHeight();
      const margin = KEYBOARD_GAP_LINES * lh;
      const cur = scrollY.current;
      let target = cur;
      if (caretY + lh > cur + vh - margin) target = caretY + lh + margin - vh;
      else if (caretY < cur) target = caretY - margin;
      const limit = Math.min(maxTextScroll(), Math.max(0, contentH.current - viewH.current));
      target = Math.max(0, Math.min(Math.round(target), Number.isFinite(limit) ? limit : target));
      if (Math.abs(target - cur) > 2) {
        scrollY.current = target;
        scrollRef.current?.scrollTo({ y: target, animated: false });
      }
    }, 300);
  };

  /* Centralized scroll controller */
  const executeScrollDecision = useCallback(
    (
      reason: ScrollReason,
      targetOffset: number,
      text: string,
      animated = true
    ): { shouldScroll: boolean; targetY: number } => {
      if (
        isUserScrollingRef.current &&
        reason !== 'jump-to-end' &&
        reason !== 'jump-to-top' &&
        reason !== 'search' &&
        reason !== 'undo' &&
        reason !== 'redo'
      ) {
        return { shouldScroll: false, targetY: scrollY.current };
      }

      const currentViewH = getUsableViewportHeight();
      const geom = resolveOffsetGeometry({
        text,
        charOffset: targetOffset,
        scale,
        screenWidth: editorWidthRef.current > 0 ? editorWidthRef.current : undefined,
        fontFamily: inputFont,
        nativeLayout: nativeLayoutRef.current,
      });
      lastKnownCursorYRef.current = geom.cursorY;

      const decision = calculateScrollDecision({
        reason,
        cursorY: geom.cursorY,
        lineHeight: geom.lineHeight,
        textBottom: geom.textBottom,
        curY: scrollY.current,
        viewH: currentViewH,
        contentH: contentH.current,
      });

      if (decision.shouldScroll) {
        scrollY.current = decision.targetY;
        scrollRef.current?.scrollTo({
          y: decision.targetY,
          animated,
        });
      }
      return decision;
    },
    [getUsableViewportHeight, scale, inputFont]
  );

  const applyPendingNativeReveal = useCallback(() => {
    const pending = pendingRevealRef.current;
    if (!pending || Date.now() > pending.until) {
      return;
    }
    const winLayout = nativeWindowLayoutRef.current;
    if (!winLayout || winLayout.text !== windowTextRef.current || winLayout.lines.length === 0) {
      return;
    }
    const curPrefixLen = prefixRawRef.current.length;
    if (curPrefixLen > 0 && windowWrapperPrefixLenRef.current !== curPrefixLen) {
      return;
    }

    const localOffset = Math.max(
      0,
      Math.min(winLayout.text.length, pending.revealOffset - curPrefixLen)
    );
    const lines = winLayout.lines;
    let found = lines[lines.length - 1];
    let lo = 0;
    let hi = lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const l = lines[mid];
      if (localOffset < l.startOffset) {
        hi = mid - 1;
      } else if (localOffset > l.endOffset) {
        lo = mid + 1;
      } else {
        found = l;
        break;
      }
    }

    const wrapperTop = curPrefixLen > 0 ? windowWrapperYRef.current : 0;
    const topPad = curPrefixLen > 0 ? 0 : EDITOR_TOP_PAD;
    const exactEditY = wrapperTop + topPad + found.y;
    const lineH = found.height || getEditorLineHeight(scale);
    const exactBottom =
      wrapperTop + topPad + winLayout.totalHeight + (suffixRawRef.current.length > 0 ? 0 : EDITOR_BOTTOM_PAD);
    const currentViewH = getUsableViewportHeight();

    const exactDecision = calculateRevealScrollY({
      editY: exactEditY,
      lineHeight: lineH,
      curY: pending.preScrollY,
      viewH: currentViewH,
      contentH: Math.max(contentH.current, exactBottom),
    });

    if (exactDecision.shouldScroll || pending.wasOffscreen) {
      const effectiveContentH = Math.max(
        contentH.current,
        exactBottom,
        exactEditY + lineH + EDITOR_BOTTOM_PAD
      );
      const maxScroll = Math.max(0, effectiveContentH - currentViewH);
      const targetCenterY = exactEditY - currentViewH / 2 + lineH / 2;
      const targetY = exactDecision.shouldScroll
        ? exactDecision.targetY
        : Math.max(0, Math.min(Math.round(targetCenterY), maxScroll));
      if (Math.abs(targetY - scrollY.current) > 1) {
        scrollY.current = targetY;
        scrollRef.current?.scrollTo({
          y: targetY,
          animated: pending.animated,
        });
      }
    }
  }, [scale, getUsableViewportHeight]);

  /* Update undo/redo availability without triggering re-renders when unchanged */
  const syncCanUndoRedo = useCallback(() => {
    const hasUncommitted =
      bodyRef.current !== (historyStack.current[historyIndex.current]?.text ?? '');
    const nextUndo = historyIndex.current > 0 || hasUncommitted;
    const nextRedo = historyIndex.current < historyStack.current.length - 1;
    if (canUndoRef.current !== nextUndo) {
      canUndoRef.current = nextUndo;
      setCanUndo(nextUndo);
    }
    if (canRedoRef.current !== nextRedo) {
      canRedoRef.current = nextRedo;
      setCanRedo(nextRedo);
    }
  }, []);

  const pushSnapshot = useCallback(
    (text: string, cursor: number) => {
      if (histDebounce.current) {
        clearTimeout(histDebounce.current);
        histDebounce.current = null;
      }
      const stack = historyStack.current;
      const idx = historyIndex.current;
      if (stack[idx] && stack[idx].text === text) {
        stack[idx].cursor = cursor;
        syncCanUndoRedo();
        return;
      }
      const maxSnapshots = text.length > 250000 ? 60 : 250;
      const nextStack = stack.slice(0, idx + 1);
      nextStack.push({ text, cursor });
      if (nextStack.length > maxSnapshots) nextStack.shift();
      historyStack.current = nextStack;
      historyIndex.current = nextStack.length - 1;
      syncCanUndoRedo();
    },
    [syncCanUndoRedo]
  );

  const pushSnapshotDebounced = useCallback(
    (text: string, cursor: number) => {
      if (histDebounce.current) clearTimeout(histDebounce.current);
      histDebounce.current = setTimeout(() => {
        pushSnapshot(text, cursor);
      }, 500);
    },
    [pushSnapshot]
  );

  /* Listen to keyboard show/hide to keep editor in view above keyboard on both Android & iOS */
  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        const h = e.endCoordinates?.height ?? 0;
        dbg(`kb show h=${Math.round(h)}`);
        kbHeightRef.current = h;
        setKeyboardHeight(h);
        onKeyboardShownRef.current();
      }
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        dbg('kb hide');
        kbHeightRef.current = 0;
        setKeyboardHeight(0);
      }
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  /* ----- load note ----- */
  useEffect(() => {
    let alive = true;
    (async () => {
      let it: Awaited<ReturnType<typeof getItem>>;
      try {
        it = await getItem(id);
      } catch {
        // e.g. a locked note that cannot be decrypted: leave the stored data untouched and go back
        if (alive) {
          toast('Could not open this note. Your data was not changed.');
          nav.pop();
        }
        return;
      }
      if (!alive) return;
      if (!it) {
        nav.pop();
        return;
      }
      const openEnd = Boolean(get().openAtEnd && !isNew && it.body.length > 0);
      const initialCursor = openEnd ? it.body.length : 0;
      titleRef.current = it.title;
      bodyRef.current = it.body;
      original.current = { title: it.title, body: it.body };
      historyStack.current = [{ text: it.body, cursor: initialCursor }];
      historyIndex.current = 0;
      selRef.current = { start: initialCursor, end: initialCursor };
      ensureGeoCache(
        it.body,
        estimateCharsPerLine(
          editorWidthRef.current > 0 ? editorWidthRef.current : Dimensions.get('window').width,
          scale,
          inputFont
        )
      );
      syncCanUndoRedo();
      setTitle(it.title);
      applyFullTextAndWindow(it.body, initialCursor, windowedModeRef.current);
      getKv(`ro:${id}`)
        .then((v) => v === '1' && setReadOnly(true))
        .catch(() => {
          toast("Could not check this note's read-only setting");
        });
      setLoaded(true);
      if (openEnd) {
        pendingEnd.current = true;
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const reloadFromDbIfModified = useCallback(() => {
    if (!loaded || isSelfSavingRef.current) return;
    getItem(id)
      .then((it) => {
        if (it && (it.body !== bodyRef.current || it.title !== titleRef.current)) {
          titleRef.current = it.title;
          bodyRef.current = it.body;
          original.current = { title: it.title, body: it.body };
          historyStack.current = [{ text: it.body, cursor: 0 }];
          historyIndex.current = 0;
          dirty.current = false;
          clearUndoHighlight();
          setTitle(it.title);
          applyFullTextAndWindow(it.body, 0, windowedModeRef.current);
          syncCanUndoRedo();
        }
      })
      .catch(() => { });
  }, [loaded, id, syncCanUndoRedo, clearUndoHighlight, applyFullTextAndWindow]);

  // Reload if note was modified in background (e.g. revision restored)
  useEffect(() => {
    if (!loaded) return;
    if (nav?.route?.name === 'Note' && nav?.route?.params?.id === id) {
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

  /* ----- saving ----- */
  const persist = useCallback(async () => {
    if (readOnly || get().readOnlyMode) {
      dirty.current = false;
      return true;
    }
    if (!dirty.current) return true;
    dirty.current = false;
    const t = titleRef.current;
    const b = bodyRef.current;
    isSelfSavingRef.current = true;
    try {
      const o = original.current;
      if (
        !revSaved.current &&
        get().saveRevisions &&
        (hasNonWhitespace(o.body) || hasNonWhitespace(o.title)) &&
        (o.body !== b || o.title !== t)
      ) {
        await addRevision(id, o.title, o.body);
        revSaved.current = true;
      }
      await updateItem(id, { title: t, body: b });
      return true;
    } catch {
      dirty.current = true;
      return false;
    } finally {
      isSelfSavingRef.current = false;
    }
  }, [id, get, readOnly]);

  const scheduleSave = useCallback(() => {
    if (readOnly || get().readOnlyMode) return;
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const delay = bodyRef.current.length > 100000 ? 1400 : 700;
    saveTimer.current = setTimeout(() => {
      persist();
    }, delay);
  }, [persist, readOnly, get]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' && !readOnly && !get().readOnlyMode) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        persist();
      }
    });
    return () => {
      sub.remove();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (histDebounce.current) clearTimeout(histDebounce.current);
      if (undoHighlightTimer.current) clearTimeout(undoHighlightTimer.current);
      if (!readOnly && !get().readOnlyMode) persist();
    };
  }, [persist, readOnly, get]);

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
    if (!readOnly && !get().readOnlyMode) {
      const saved = await persist();
      if (!saved) {
        clearTimeout(resetTimer);
        leaving.current = false;
        Alert.alert(
          'Could not save your note',
          'Your changes are still on screen. Please try again.'
        );
        return;
      }
      if (isNew && !hasNonWhitespace(titleRef.current) && !hasNonWhitespace(bodyRef.current)) {
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
  }, [persist, isNew, id, nav, readOnly, get]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (menuOpen) {
        setMenuOpen(false);
      } else if (searchOpen) {
        setSearchOpen(false);
        setQuery('');
      } else {
        leave();
      }
      return true;
    });
    return () => sub.remove();
  }, [menuOpen, searchOpen, leave]);

  /* Release controlled selection after native TextInput syncs so it never fights subsequent typing */
  useEffect(() => {
    if (!sel) return;
    const t = setTimeout(() => setSel(undefined), 180);
    return () => clearTimeout(t);
  }, [sel]);

  const changeBody = useCallback(
    (incomingText: string) => {
      if (readOnly || get().readOnlyMode) return;

      clearUndoHighlight();
      tapRestoreRef.current = null;
      caretWokenRef.current = true; // typing already shows the caret; no nudge needed
      if (inputOverrideRef.current !== null) {
        inputOverrideRef.current = null;
        setInputOverride(null);
      }
      programmaticSelRef.current = null;
      pendingRevealRef.current = null;
      const prevFullText = bodyRef.current;
      const curPrefix = prefixRawRef.current;
      const prevWin = windowTextRef.current;
      const curSuffix = suffixRawRef.current;
      const isCurrentlyWindowed = curPrefix.length > 0 || curSuffix.length > 0;

      // Support synthetic full-document onChangeText calls from test harnesses while running O(1) window edits on device
      const isFullDocOverride =
        isCurrentlyWindowed &&
        incomingText.length > prevWin.length + 2000 &&
        (curPrefix.length === 0 ||
          incomingText.startsWith(curPrefix.slice(0, Math.min(64, curPrefix.length))));

      let fullNextText: string;
      let newCursor: number;
      let globalDiffStart: number;
      let globalFromEnd: number;
      let isInsertion: boolean;
      let isDeletion: boolean;
      let isNewline: boolean;
      let removedText: string;

      if (isFullDocOverride) {
        const step = computeEditStep(prevFullText, incomingText, selRef.current);
        fullNextText = incomingText;
        newCursor = step.newCursor;
        globalDiffStart = step.diff.start;
        globalFromEnd = step.diff.fromEnd;
        isInsertion = step.isInsertion;
        isDeletion = step.isDeletion;
        isNewline = step.isNewline;
        removedText = step.diff.removedText;
        selRef.current = { start: newCursor, end: newCursor };
        applyFullTextAndWindow(fullNextText, newCursor, windowedModeRef.current);
      } else {
        const winStart = curPrefix.length;
        const localAnchor = Math.max(0, Math.min(prevWin.length, selRef.current.start - winStart));
        const localDiff = computeTextDiff(prevWin, incomingText, localAnchor, false);
        newCursor = winStart + localDiff.cursor;
        globalDiffStart = winStart + localDiff.start;
        globalFromEnd = winStart + localDiff.fromEnd;
        removedText = localDiff.removedText;
        isInsertion =
          incomingText.length > prevWin.length || localDiff.insertedText.length > 0;
        isDeletion =
          incomingText.length < prevWin.length && localDiff.insertedText.length === 0;
        isNewline = localDiff.insertedText.includes('\n');

        fullNextText = !isCurrentlyWindowed
          ? incomingText
          : curPrefix + incomingText + curSuffix;

        updateGeoCacheForEdit(
          prevFullText,
          fullNextText,
          globalDiffStart,
          globalFromEnd
        );

        selRef.current = { start: newCursor, end: newCursor };
        bodyRef.current = fullNextText;

        const lowWater = curPrefix.length > 0 && localDiff.cursor < 280;
        const highWater =
          curSuffix.length > 0 && incomingText.length - localDiff.cursor < 220;
        const crossedIntoWindow =
          !isCurrentlyWindowed &&
          windowedModeRef.current &&
          fullNextText.length > WINDOW_MODE_THRESHOLD + 400;
        const shrankOutOfWindow =
          isCurrentlyWindowed && fullNextText.length <= WINDOW_MODE_THRESHOLD - 400;

        if (lowWater || highWater || crossedIntoWindow || shrankOutOfWindow) {
          applyFullTextAndWindow(fullNextText, newCursor, windowedModeRef.current);
          applyProgrammaticSelection(newCursor);
        } else {
          windowTextRef.current = incomingText;
          setWindowText(incomingText);
          if (sel) {
            setSel(undefined);
          }
        }
      }

      // If there is an uncommitted edit in history and the user switched edit kind (insert <-> delete)
      // or edited at a non-adjacent location, commit the previous edit snapshot first so Undo/Redo
      // never merges separate locations or loses inserted text before a deletion.
      const currentCommittedText = historyStack.current[historyIndex.current]?.text ?? '';
      const nextEditKind: 'insert' | 'delete' | 'replace' =
        isInsertion && !isDeletion && removedText.length === 0
          ? 'insert'
          : isDeletion
            ? 'delete'
            : 'replace';
      if (prevFullText !== currentCommittedText) {
        const switchedKind =
          lastEditKindRef.current !== null && lastEditKindRef.current !== nextEditKind;
        const anchorToCompare = isDeletion ? globalFromEnd : globalDiffStart;
        const jumpedLocation = Math.abs(anchorToCompare - lastEditCursorRef.current) > 2;
        if (switchedKind || jumpedLocation) {
          pushSnapshot(prevFullText, lastEditCursorRef.current);
        }
      }
      lastEditCursorRef.current = newCursor;
      lastEditKindRef.current = nextEditKind;

      syncCanUndoRedo();

      // Snapshot immediately on inserted newline or space boundary, debounced on regular characters & deletions
      const lastCommittedLen = historyStack.current[historyIndex.current]?.text.length ?? 0;
      const isInsertedSpaceBoundary =
        isInsertion &&
        fullNextText.charCodeAt(newCursor - 1) === 32 &&
        Math.abs(fullNextText.length - lastCommittedLen) >= 6;
      if (isNewline || isInsertedSpaceBoundary) {
        pushSnapshot(fullNextText, newCursor);
      } else {
        pushSnapshotDebounced(fullNextText, newCursor);
      }

      scheduleSave();

      if (isNewline) {
        executeScrollDecision('enter', newCursor, fullNextText, !INSTANT_CARET_SCROLL);
      } else if (isInsertion) {
        executeScrollDecision('typing', newCursor, fullNextText, !INSTANT_CARET_SCROLL);
      } else if (isDeletion) {
        const removedNewline = removedText.includes('\n');
        const knownY = lastKnownCursorYRef.current;
        const curScrollY = scrollY.current;
        const curViewH = getUsableViewportHeight();
        const safeInView =
          !removedNewline &&
          removedText.length <= 2 &&
          knownY >= curScrollY + 32 &&
          knownY + 50 <= curScrollY + curViewH - 32;
        if (!safeInView) {
          executeScrollDecision('deletion', newCursor, fullNextText, false);
        }
      }
    },
    [
      readOnly,
      get,
      sel,
      clearUndoHighlight,
      applyFullTextAndWindow,
      applyProgrammaticSelection,
      pushSnapshot,
      pushSnapshotDebounced,
      syncCanUndoRedo,
      scheduleSave,
      executeScrollDecision,
      getUsableViewportHeight,
    ]
  );

  const changeTitle = useCallback(
    (text: string) => {
      if (readOnly || get().readOnlyMode) return;
      titleRef.current = text;
      setTitle(text);
      scheduleSave();
    },
    [readOnly, get, scheduleSave]
  );

  /* ----- reliable undo / redo with accurate diff cursor & brief range highlight ----- */
  const applyHistoryTransition = useCallback(
    (fromText: string, toText: string, anchorCursor: number, reason: 'undo' | 'redo') => {
      const now = Date.now();
      const isRapidRepeat = now - lastUndoRedoAtRef.current < 90;
      lastUndoRedoAtRef.current = now;
      isUserScrollingRef.current = false;

      const diff = computeTextDiff(fromText, toText, anchorCursor);
      const targetCursor = diff.cursor;
      const revealOffset =
        diff.highlightEnd > diff.highlightStart &&
          toText.charCodeAt(diff.highlightEnd - 1) === 10
          ? diff.highlightStart
          : targetCursor;

      lastEditCursorRef.current = targetCursor;
      lastEditKindRef.current = null;
      applyFullTextAndWindow(toText, targetCursor, windowedModeRef.current);
      applyProgrammaticSelection(targetCursor);
      syncCanUndoRedo();
      scheduleSave();

      triggerUndoHighlight(
        {
          start: diff.highlightStart,
          end: diff.highlightEnd,
          cursor: targetCursor,
        },
        isRapidRepeat && toText.length > 15000
      );

      const preScrollY = scrollY.current;
      const decision = executeScrollDecision(reason, revealOffset, toText, !isRapidRepeat);
      pendingRevealRef.current = {
        revealOffset,
        cursorOffset: targetCursor,
        preScrollY,
        wasOffscreen: decision.shouldScroll,
        animated: !isRapidRepeat,
        until: now + 320,
      };
    },
    [
      applyFullTextAndWindow,
      applyProgrammaticSelection,
      syncCanUndoRedo,
      scheduleSave,
      triggerUndoHighlight,
      executeScrollDecision,
    ]
  );

  const undo = useCallback((): boolean => {
    if (readOnly || get().readOnlyMode) return false;
    if (histDebounce.current) {
      clearTimeout(histDebounce.current);
      histDebounce.current = null;
    }

    const currentText = bodyRef.current;
    const currentCursor = selRef.current.end;
    const currentCommitted = historyStack.current[historyIndex.current];

    // If current text differs from current committed entry, save current text first at index + 1
    // so Redo can restore back to it!
    if (currentCommitted && currentText !== currentCommitted.text) {
      const uncommittedCursor =
        lastEditCursorRef.current >= 0 && lastEditCursorRef.current <= currentText.length
          ? lastEditCursorRef.current
          : currentCursor;
      const nextStack = historyStack.current.slice(0, historyIndex.current + 1);
      nextStack.push({ text: currentText, cursor: uncommittedCursor });
      historyStack.current = nextStack;
      applyHistoryTransition(currentText, currentCommitted.text, uncommittedCursor, 'undo');
      return true;
    }

    // Otherwise step back to previous entry in historyStack
    if (historyIndex.current > 0) {
      const prevEntry = historyStack.current[historyIndex.current];
      historyIndex.current -= 1;
      const targetEntry = historyStack.current[historyIndex.current];
      applyHistoryTransition(
        currentText,
        targetEntry.text,
        prevEntry?.cursor ?? currentCursor,
        'undo'
      );
      return true;
    }
    return false;
  }, [readOnly, get, applyHistoryTransition]);

  const redo = useCallback((): boolean => {
    if (readOnly || get().readOnlyMode) return false;
    if (histDebounce.current) {
      clearTimeout(histDebounce.current);
      histDebounce.current = null;
    }

    if (historyIndex.current < historyStack.current.length - 1) {
      const currentText = bodyRef.current;
      historyIndex.current += 1;
      const targetEntry = historyStack.current[historyIndex.current];
      applyHistoryTransition(currentText, targetEntry.text, targetEntry.cursor, 'redo');
      return true;
    }
    return false;
  }, [readOnly, get, applyHistoryTransition]);

  /* ----- toolbar actions ----- */
  const copy = useCallback(async () => {
    const { start, end } = selRef.current;
    const text = end > start ? bodyRef.current.slice(start, end) : bodyRef.current;
    try {
      await Clipboard.setStringAsync(text);
    } catch {
      toast('Could not copy to the clipboard');
      return;
    }
    toast(end > start ? 'Selection copied' : 'Note copied');
  }, []);

  const paste = useCallback(async () => {
    if (readOnly || get().readOnlyMode) {
      toast('Cannot paste in read-only mode');
      return;
    }
    let clip: string;
    try {
      clip = await Clipboard.getStringAsync();
    } catch {
      toast('Could not read the clipboard');
      return;
    }
    if (!clip) {
      toast('Clipboard is empty');
      return;
    }
    clearUndoHighlight();
    const { start, end } = selRef.current;
    const b = bodyRef.current;
    const currentCommittedText = historyStack.current[historyIndex.current]?.text ?? '';
    if (b !== currentCommittedText) {
      pushSnapshot(b, lastEditCursorRef.current);
    }
    const from = Math.min(start, b.length);
    const to = Math.min(Math.max(end, from), b.length);
    const next = b.slice(0, from) + clip + b.slice(to);
    const newCursor = from + clip.length;

    lastEditCursorRef.current = newCursor;
    lastEditKindRef.current = null;
    applyFullTextAndWindow(next, newCursor, windowedModeRef.current);
    applyProgrammaticSelection(newCursor);
    pushSnapshot(next, newCursor);
    scheduleSave();
    executeScrollDecision('typing', newCursor, next, !INSTANT_CARET_SCROLL);
  }, [
    readOnly,
    get,
    clearUndoHighlight,
    applyFullTextAndWindow,
    applyProgrammaticSelection,
    pushSnapshot,
    scheduleSave,
    executeScrollDecision,
  ]);

  const showCount = useCallback(() => {
    const c = countText(bodyRef.current);
    Alert.alert(
      'Note details',
      `Characters: ${c.chars.toLocaleString()}\nWords: ${c.words.toLocaleString()}\nLines: ${c.lines.toLocaleString()}`
    );
  }, []);

  /* Read-Only toggle via lock button */
  const toggleReadOnly = useCallback(() => {
    const next = !readOnly;
    setReadOnly(next);
    setKv(`ro:${id}`, next ? '1' : '0').catch(() => {
      Alert.alert(
        "Could not save this note's read-only setting",
        'The change applies now, but it may not be remembered the next time you open the note.'
      );
    });
    if (next) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void persist();
      toast('Note locked (Read-Only)');
    } else {
      toast('Note unlocked (Editing enabled)');
    }
  }, [readOnly, id, persist]);

  /* Toolbar visibility toggle via wrench button long-press */
  const toggleToolbar = useCallback(() => {
    setMenuOpen(false);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setToolbarVisible((v) => {
      const next = !v;
      toast(next ? 'Editing toolbar visible' : 'Editing toolbar closed');
      return next;
    });
  }, []);

  const toggleMenu = useCallback(() => {
    Keyboard.dismiss();
    setMenuOpen((v) => !v);
  }, []);

  const scrollToEnd = useCallback(() => {
    setMenuOpen(false);
    pendingEnd.current = false;
    const text = bodyRef.current;
    const endPos = text.length;
    selRef.current = { start: endPos, end: endPos };
    applyFullTextAndWindow(text, endPos, windowedModeRef.current);
    if (focused.current) {
      setSel({ start: endPos, end: endPos });
    }
    const targetY = calculateJumpToEndScrollY({
      text,
      scale,
      viewH: getUsableViewportHeight(),
      screenWidth: editorWidthRef.current > 0 ? editorWidthRef.current : undefined,
      fontFamily: inputFont,
      nativeLayout: nativeLayoutRef.current,
    });
    if (Math.abs(targetY - scrollY.current) > 1) {
      scrollY.current = targetY;
      scrollRef.current?.scrollTo({ y: targetY, animated: true });
    }
  }, [scale, getUsableViewportHeight, inputFont, applyFullTextAndWindow]);

  const scrollToTop = useCallback(() => {
    setMenuOpen(false);
    pendingEnd.current = false;
    applyFullTextAndWindow(bodyRef.current, 0, windowedModeRef.current);
    scrollY.current = 0;
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [applyFullTextAndWindow]);

  const toggleWindowedMode = useCallback(() => {
    setMenuOpen(false);
    const next = !windowedModeRef.current;
    windowedModeRef.current = next;
    setWindowedMode(next);
    applyFullTextAndWindow(bodyRef.current, selRef.current.end, next);
    toast(next ? 'Fast windowed editor enabled' : 'Full-note input mode enabled');
  }, [applyFullTextAndWindow]);

  const shareNote = async () => {
    setMenuOpen(false);
    const t = titleRef.current.trim();
    const message = (get().shareIncludeTitle && t ? t + '\n\n' : '') + bodyRef.current;
    const subject = get().shareEmailSubject && t ? t : undefined;
    try {
      await withExternalUi(() => Share.share({ message, title: subject }, { subject }));
    } catch {
      // cancelled
    }
  };

  const removeNote = () => {
    setMenuOpen(false);
    if (readOnly || get().readOnlyMode) {
      Alert.alert('Read-Only', 'Cannot delete note while in read-only mode.');
      return;
    }
    confirm(
      'Delete note?',
      'It will be moved to Deleted Items.',
      'Delete',
      async () => {
        leaving.current = true;
        try {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          await persist();
          await softDelete([id]);
          hasPoppedRef.current = true;
          nav.pop();
          toast('Note moved to Deleted Items', {
            label: 'Undo',
            onPress: () => {
              restoreItems([id]).catch(() => toast('Could not undo'));
            },
          });
        } catch {
          leaving.current = false;
          Alert.alert('Could not delete the note', 'Please try again.');
        }
      },
      true
    );
  };

  const openRevisions = async () => {
    setMenuOpen(false);
    if (!readOnly && !get().readOnlyMode && saveTimer.current) clearTimeout(saveTimer.current);
    if (!readOnly && !get().readOnlyMode && !(await persist())) {
      Alert.alert(
        'Could not save your note',
        'Please try again before opening the version history.'
      );
      return;
    }
    nav.push('Revisions', { id });
  };

  /* ----- search inside note (complete match count, windowed highlight nodes, zero lag) ----- */
  const activeSearchQuery = searchOpen ? query.trim() : '';

  const isWindowed = prefixRaw.length > 0 || suffixRaw.length > 0;
  const fullBodyForSearchOrHighlight = useMemo(() => {
    if (!searchOpen) return '';
    return isWindowed ? prefixRaw + windowText + suffixRaw : windowText;
  }, [searchOpen, isWindowed, prefixRaw, windowText, suffixRaw]);

  const searchLowerBody = useMemo(() => {
    if (!searchOpen) return '';
    return fullBodyForSearchOrHighlight.toLowerCase();
  }, [searchOpen, fullBodyForSearchOrHighlight]);

  const matches = useMemo(() => {
    if (!searchOpen || activeSearchQuery.length === 0) return EMPTY_MATCHES;
    return findNoteMatches(fullBodyForSearchOrHighlight, activeSearchQuery, searchLowerBody);
  }, [searchOpen, activeSearchQuery, fullBodyForSearchOrHighlight, searchLowerBody]);

  const activeMatchCharOffsetRef = useRef(0);

  const jumpTo = useCallback(
    (n: number) => {
      if (matches.length === 0) return;
      const i = ((n % matches.length) + matches.length) % matches.length;
      setMatchIdx(i);
      const start = matches[i];
      activeMatchCharOffsetRef.current = start;
      applyFullTextAndWindow(bodyRef.current, start, windowedModeRef.current);
      executeScrollDecision('search', start, bodyRef.current, true);
    },
    [matches, executeScrollDecision, applyFullTextAndWindow]
  );

  // When query or matches change during search, preserve nearest match at/after current match offset
  useEffect(() => {
    if (!searchOpen || activeSearchQuery.length === 0 || matches.length === 0) {
      setMatchIdx(0);
      if (!activeSearchQuery) {
        activeMatchCharOffsetRef.current = 0;
      }
      return;
    }
    const anchor = activeMatchCharOffsetRef.current;
    let nextIdx = matches.findIndex((m) => m >= anchor);
    if (nextIdx === -1) nextIdx = 0;
    setMatchIdx(nextIdx);
    const start = matches[nextIdx];
    activeMatchCharOffsetRef.current = start;
    applyFullTextAndWindow(bodyRef.current, start, windowedModeRef.current);
    executeScrollDecision('search', start, bodyRef.current, true);
  }, [activeSearchQuery, searchOpen, matches, executeScrollDecision, applyFullTextAndWindow]);

  const highlightNodes = useMemo(() => {
    if (!searchOpen || !activeSearchQuery) return null;
    return renderSearchHighlightSpans(
      fullBodyForSearchOrHighlight,
      activeSearchQuery,
      matches,
      matchIdx,
      theme.text
    );
  }, [searchOpen, activeSearchQuery, matches, matchIdx, theme.text, fullBodyForSearchOrHighlight]);

  const editorLineHeight = getEditorLineHeight(scale);

  const undoHighlightOverlay = useMemo(() => {
    if (!undoHighlight || searchOpen || !windowText) return null;
    const dimmedColor = theme.isDark ? 'rgba(255,255,255,0.42)' : 'rgba(0,0,0,0.42)';
    const winStart = prefixRaw.length;
    const localStart = Math.max(0, Math.min(windowText.length, undoHighlight.start - winStart));
    const localEnd = Math.max(localStart, Math.min(windowText.length, undoHighlight.end - winStart));
    const useTransparentInput = !isWindowed && windowText.length <= 15000;

    return {
      fullOverlay: useTransparentInput,
      nodes: renderUndoHighlightSpans(
        windowText,
        localStart,
        localEnd,
        theme.text,
        dimmedColor,
        theme.isDark
      ),
    };
  }, [
    undoHighlight,
    searchOpen,
    windowText,
    prefixRaw.length,
    isWindowed,
    theme.text,
    theme.isDark,
  ]);

  useEffect(() => {
    if (!pendingChunkFocusRef.current) return;
    pendingChunkFocusRef.current = false;
    bodyInputRef.current?.focus();
  }, [prefixRaw, windowText, suffixRaw]);

  /* Real measurements of the static text above / below the editable window, so a tap on it can be
     mapped to the exact line the user touched instead of an estimate. */
  /* While the body input is NOT focused, its text is also drawn invisibly so its real line layout is
     known. That lets the first tap be mapped to the exact line touched: left alone, Android puts
     the caret at the END of the text on a first tap, which is off screen in a long note. */
  const [bodyFocused, setBodyFocused] = useState(false);
  /* Text copy used only for measuring. It stays mounted while the input has focus (its content is
     simply frozen), because adding/removing a view next to the input on focus made Android leave the
     text below the input unpainted on the first tap. */
  const [measureText, setMeasureText] = useState('');
  useEffect(() => {
    if (!bodyFocused) setMeasureText(windowText);
  }, [bodyFocused, windowText]);
  const windowLinesRef = useRef<{ text: string; lines: ChunkLine[] } | null>(null);
  const intendedCaretRef = useRef<{ offset: number; at: number } | null>(null);
  const presetCaretRef = useRef<{ offset: number; at: number } | null>(null);
  const handleWindowMeasure = useCallback((text: string, e: any) => {
    const raw = e?.nativeEvent?.lines;
    if (Array.isArray(raw) && raw.length > 0) {
      windowLinesRef.current = { text, lines: buildChunkLines(raw) };
    }
  }, []);

  /* Real line layout of the text drawn over the blank top/bottom spacers, so a tap there maps to
     the exact line touched instead of an estimate. */
  const spacerSliceInfoRef = useRef<{
    top?: { start: number; text: string; y: number; lines: ChunkLine[] };
    bottom?: { start: number; text: string; y: number; lines: ChunkLine[] };
  }>({});
  const handleSliceLayout = useCallback(
    (kind: 'top' | 'bottom', start: number, text: string, y: number, e: any) => {
      const raw = e?.nativeEvent?.lines;
      if (Array.isArray(raw) && raw.length > 0) {
        spacerSliceInfoRef.current[kind] = { start, text, y, lines: buildChunkLines(raw) };
      }
    },
    []
  );

  const containerRef = useRef<View>(null);
  /** Screen y of the top of the scrolling area (same coordinate space as touch pageY). */
  const viewportTopRef = useRef<number | null>(null);
  const chunkInfoRef = useRef<Record<string, { y?: number; text?: string; lines?: ChunkLine[] }>>({});
  const handleChunkInfo = useCallback((kind: string, patch: ChunkInfoPatch) => {
    const cur = chunkInfoRef.current[kind] ?? (chunkInfoRef.current[kind] = {});
    if (patch.y !== undefined) cur.y = patch.y;
    if (patch.y !== undefined) {
      fact(`chunk ${kind}`, `y=${Math.round(patch.y)} h=${Math.round(patch.h ?? -1)}`);
    }
    if (patch.text !== undefined && patch.lines) {
      fact(`text ${kind}`, `chars=${patch.text.length} lines=${patch.lines.length}`);
      cur.text = patch.text;
      cur.lines = buildChunkLines(patch.lines);
    }
  }, []);

  const handleChunkPress = useCallback(
    (
      chunkKind: 'prefix' | 'suffix' | 'top-spacer' | 'bottom-spacer',
      locationX: number,
      locationY: number,
      paddingTop: number,
      pageX?: number,
      pageY?: number
    ) => {
      clearUndoHighlight();
      if (isEffectiveReadOnly) return;
      // Where the finger landed in scrolled-content coordinates (exact; independent of which child
      // view the touch reported its locationX/Y against).
      const viewportTop = viewportTopRef.current;
      const tapContentY =
        pageY !== undefined && viewportTop !== null ? scrollY.current + (pageY - viewportTop) : null;
      rememberTap(tapContentY);
      const fullText = bodyRef.current;
      const currentCommittedText = historyStack.current[historyIndex.current]?.text ?? '';
      if (fullText !== currentCommittedText) {
        pushSnapshot(fullText, lastEditCursorRef.current);
      }
      const winWidth = editorWidthRef.current || Dimensions.get('window').width;
      const cpl = estimateCharsPerLine(winWidth, scale, inputFont);
      const availW = Math.max(100, winWidth - EDITOR_H_PAD * 2);
      const charW = Math.max(6, availW / cpl);
      const approxCol =
        locationX > EDITOR_H_PAD ? Math.max(0, Math.round((locationX - EDITOR_H_PAD) / charW)) : 0;
      const tappedLineDelta = Math.max(
        0,
        Math.floor(Math.max(0, locationY - paddingTop) / editorLineHeight)
      );

      let targetOffset = 0;
      if (chunkKind === 'prefix') {
        const startOff = prefixVisStartRef.current;
        const endOff =
          prefixRawRef.current.length > 0 &&
            prefixRawRef.current.charCodeAt(prefixRawRef.current.length - 1) === 10
            ? prefixRawRef.current.length - 1
            : prefixRawRef.current.length;
        targetOffset = advanceByVisualLines(
          fullText,
          startOff,
          endOff,
          tappedLineDelta,
          approxCol,
          cpl
        );
      } else if (chunkKind === 'suffix') {
        const winEnd = prefixRawRef.current.length + windowTextRef.current.length;
        const startOff =
          suffixRawRef.current.length > 0 && suffixRawRef.current.charCodeAt(0) === 10
            ? winEnd + 1
            : winEnd;
        const endOff = winEnd + suffixVisEndRef.current;
        targetOffset = advanceByVisualLines(
          fullText,
          startOff,
          endOff,
          tappedLineDelta,
          approxCol,
          cpl
        );
      } else if (chunkKind === 'top-spacer') {
        const endOff = prefixVisStartRef.current;
        targetOffset = advanceByVisualLines(fullText, 0, endOff, tappedLineDelta, approxCol, cpl);
      } else {
        const winEnd = prefixRawRef.current.length + windowTextRef.current.length;
        const startOff = Math.min(fullText.length, winEnd + suffixVisEndRef.current + 1);
        targetOffset = advanceByVisualLines(
          fullText,
          startOff,
          fullText.length,
          tappedLineDelta,
          approxCol,
          cpl
        );
      }

      // Replace the estimate with the exact line from the real text layout when we have it.
      if (chunkKind === 'prefix' || chunkKind === 'suffix') {
        const info = chunkInfoRef.current[chunkKind];
        const winEnd = prefixRawRef.current.length + windowTextRef.current.length;
        let chunkStart: number;
        let chunkEnd: number;
        if (chunkKind === 'prefix') {
          chunkStart = prefixVisStartRef.current;
          chunkEnd =
            prefixRawRef.current.length > 0 &&
              prefixRawRef.current.charCodeAt(prefixRawRef.current.length - 1) === 10
              ? prefixRawRef.current.length - 1
              : prefixRawRef.current.length;
        } else {
          chunkStart =
            suffixRawRef.current.length > 0 && suffixRawRef.current.charCodeAt(0) === 10
              ? winEnd + 1
              : winEnd;
          chunkEnd = winEnd + suffixVisEndRef.current;
        }
        if (info && info.lines && info.lines.length > 0 && info.text === fullText.slice(chunkStart, chunkEnd)) {
          const tapY =
            tapContentY !== null && typeof info.y === 'number'
              ? tapContentY - info.y - paddingTop
              : Math.max(0, locationY - paddingTop);
          const tapX = pageX !== undefined ? pageX : locationX;
          let line = info.lines[info.lines.length - 1];
          for (let i = 0; i < info.lines.length; i++) {
            if (tapY < info.lines[i].y + info.lines[i].height) {
              line = info.lines[i];
              break;
            }
          }
          const span = Math.max(0, line.end - line.start);
          const frac =
            line.width > 0
              ? Math.min(1, Math.max(0, (tapX - EDITOR_H_PAD - line.x) / line.width))
              : 0;
          targetOffset = chunkStart + line.start + Math.round(frac * span);
        }
      }

      // Taps on the text drawn over the blank spacers: use that text's real line layout.
      if (chunkKind === 'top-spacer' || chunkKind === 'bottom-spacer') {
        const sInfo = spacerSliceInfoRef.current[chunkKind === 'top-spacer' ? 'top' : 'bottom'];
        if (sInfo && sInfo.lines.length > 0) {
          const g0 =
            chunkKind === 'top-spacer'
              ? sInfo.start
              : prefixRawRef.current.length + windowTextRef.current.length + sInfo.start;
          const lastLine = sInfo.lines[sInfo.lines.length - 1];
          const tapY = locationY - sInfo.y;
          if (
            fullText.slice(g0, g0 + sInfo.text.length) === sInfo.text &&
            tapY >= 0 &&
            tapY < lastLine.y + lastLine.height
          ) {
            let line = lastLine;
            for (let i = 0; i < sInfo.lines.length; i++) {
              if (tapY < sInfo.lines[i].y + sInfo.lines[i].height) {
                line = sInfo.lines[i];
                break;
              }
            }
            const span = Math.max(0, line.end - line.start);
            const frac =
              line.width > 0
                ? Math.min(1, Math.max(0, (locationX - EDITOR_H_PAD - line.x) / line.width))
                : 0;
            targetOffset = g0 + line.start + Math.round(frac * span);
          }
        }
      }

      lastEditCursorRef.current = targetOffset;
      lastEditKindRef.current = null;
      pendingChunkFocusRef.current = true;
      applyFullTextAndWindow(fullText, targetOffset, windowedModeRef.current);
      applyProgrammaticSelection(targetOffset);
    },
    [
      clearUndoHighlight,
      isEffectiveReadOnly,
      rememberTap,
      scale,
      inputFont,
      editorLineHeight,
      pushSnapshot,
      applyFullTextAndWindow,
      applyProgrammaticSelection,
    ]
  );

  // Prefix section above <TextInput>: depends ONLY on prefixRaw (never re-evaluates while editing windowText!)
  const prefixSection = useMemo(() => {
    if (prefixRaw.length === 0) {
      prefixVisStartRef.current = 0;
      return null;
    }
    const prefixContentEnd =
      prefixRaw.charCodeAt(prefixRaw.length - 1) === 10
        ? prefixRaw.length - 1
        : prefixRaw.length;
    const prefixVisStart =
      prefixContentEnd <= STATIC_NEIGHBOR_MAX_CHARS
        ? 0
        : findParagraphStart(prefixRaw, prefixContentEnd - STATIC_NEIGHBOR_VIS_CHARS);
    prefixVisStartRef.current = prefixVisStart;

    const immediatePrefixText = prefixRaw.slice(prefixVisStart, prefixContentEnd);
    if (prefixVisStart === 0) {
      return (
        <WindowStaticChunk
          text={immediatePrefixText}
          chunkKind="prefix"
          paddingTop={EDITOR_TOP_PAD}
          paddingBottom={0}
          themeText={theme.text}
          inputFont={inputFont}
          scale={scale}
          lineHeight={editorLineHeight}
          onChunkPress={handleChunkPress}
          onChunkInfo={handleChunkInfo}
        />
      );
    }

    const winWidth = editorWidthRef.current || Dimensions.get('window').width;
    const cpl = estimateCharsPerLine(winWidth, scale, inputFont);
    const topHiddenLines = countRangeVisualLines(prefixRaw, 0, prefixVisStart - 1, cpl);
    const topSpacerHeight = EDITOR_TOP_PAD + topHiddenLines * editorLineHeight;

    let floatingSliceNode: React.ReactNode = null;
    if (scrollAnchorLine >= 0 && scrollAnchorLine < topHiddenLines + 60) {
      const startLine = Math.max(0, scrollAnchorLine - 60);
      const sliceStart = advanceByVisualLines(prefixRaw, 0, prefixVisStart - 1, startLine, 0, cpl);
      const sliceEnd = findParagraphEnd(
        prefixRaw,
        Math.min(prefixVisStart - 1, sliceStart + SPACER_SLICE_CHARS)
      );
      topSpacerSliceRef.current = { start: sliceStart, end: sliceEnd };
      const sliceText = prefixRaw.slice(sliceStart, sliceEnd);
      const actualStartLine =
        sliceStart === 0 ? 0 : countRangeVisualLines(prefixRaw, 0, sliceStart - 1, cpl);
      floatingSliceNode = (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: EDITOR_TOP_PAD + actualStartLine * editorLineHeight,
            paddingHorizontal: EDITOR_H_PAD,
          }}
        >
          <Text
            textBreakStrategy="simple"
            onTextLayout={(ev) =>
              handleSliceLayout(
                'top',
                sliceStart,
                sliceText,
                EDITOR_TOP_PAD + actualStartLine * editorLineHeight,
                ev
              )
            }
            style={{
              color: theme.text,
              fontFamily: inputFont,
              fontSize: 17 * scale,
              lineHeight: editorLineHeight,
              fontWeight: '400',
              includeFontPadding: false,
            }}
          >
            {sliceText}
          </Text>
        </View>
      );
    }

    return (
      <>
        <Pressable
          onPress={(e) => {
            const locX = e?.nativeEvent?.locationX ?? 0;
            const locY = e?.nativeEvent?.locationY ?? 0;
            handleChunkPress(
              'top-spacer',
              locX,
              locY,
              EDITOR_TOP_PAD,
              e?.nativeEvent?.pageX,
              e?.nativeEvent?.pageY
            );
          }}
          style={{ height: topSpacerHeight, position: 'relative', overflow: 'hidden' }}
        >
          {floatingSliceNode}
        </Pressable>
        <WindowStaticChunk
          text={immediatePrefixText}
          chunkKind="prefix"
          paddingTop={0}
          paddingBottom={0}
          themeText={theme.text}
          inputFont={inputFont}
          scale={scale}
          lineHeight={editorLineHeight}
          onChunkPress={handleChunkPress}
          onChunkInfo={handleChunkInfo}
        />
      </>
    );
  }, [prefixRaw, scrollAnchorLine, theme.text, inputFont, scale, editorLineHeight, handleChunkPress, handleSliceLayout]);

  // Suffix section below <TextInput>: depends ONLY on suffixRaw (never re-evaluates while editing windowText!)
  const suffixSection = useMemo(() => {
    if (suffixRaw.length === 0) {
      suffixVisEndRef.current = 0;
      return null;
    }
    const suffixContentStart = suffixRaw.charCodeAt(0) === 10 ? 1 : 0;
    const suffixVisEnd =
      suffixRaw.length - suffixContentStart <= STATIC_NEIGHBOR_MAX_CHARS
        ? suffixRaw.length
        : findParagraphEnd(suffixRaw, suffixContentStart + STATIC_NEIGHBOR_VIS_CHARS);
    suffixVisEndRef.current = suffixVisEnd;

    const immediateSuffixText = suffixRaw.slice(suffixContentStart, suffixVisEnd);
    if (suffixVisEnd >= suffixRaw.length) {
      return (
        <WindowStaticChunk
          text={immediateSuffixText}
          chunkKind="suffix"
          paddingTop={0}
          paddingBottom={EDITOR_BOTTOM_PAD}
          themeText={theme.text}
          inputFont={inputFont}
          scale={scale}
          lineHeight={editorLineHeight}
          onChunkPress={handleChunkPress}
          onChunkInfo={handleChunkInfo}
        />
      );
    }

    const winWidth = editorWidthRef.current || Dimensions.get('window').width;
    const cpl = estimateCharsPerLine(winWidth, scale, inputFont);
    const bottomHiddenLines = countRangeVisualLines(
      suffixRaw,
      suffixVisEnd + 1,
      suffixRaw.length,
      cpl
    );
    const bottomSpacerHeight = bottomHiddenLines * editorLineHeight + EDITOR_BOTTOM_PAD;

    let floatingBottomNode: React.ReactNode = null;
    if (scrollAnchorLine >= 0) {
      const prefixAndWinLines = getVisualLineForOffset(
        bodyRef.current,
        prefixRawRef.current.length + windowTextRef.current.length + suffixVisEnd + 1,
        cpl
      );
      const relAnchorLine = scrollAnchorLine - prefixAndWinLines;
      if (relAnchorLine >= -60 && relAnchorLine < bottomHiddenLines + 60) {
        const startRelLine = Math.max(0, relAnchorLine - 60);
        const sliceStart = advanceByVisualLines(
          suffixRaw,
          suffixVisEnd + 1,
          suffixRaw.length,
          startRelLine,
          0,
          cpl
        );
        const sliceEnd = findParagraphEnd(
          suffixRaw,
          Math.min(suffixRaw.length, sliceStart + SPACER_SLICE_CHARS)
        );
        bottomSpacerSliceRef.current = { start: sliceStart, end: sliceEnd };
        const sliceText = suffixRaw.slice(sliceStart, sliceEnd);
        const actualRelLine =
          sliceStart <= suffixVisEnd + 1
            ? 0
            : countRangeVisualLines(suffixRaw, suffixVisEnd + 1, sliceStart - 1, cpl);
        floatingBottomNode = (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: actualRelLine * editorLineHeight,
              paddingHorizontal: EDITOR_H_PAD,
            }}
          >
            <Text
              textBreakStrategy="simple"
              onTextLayout={(ev) =>
                handleSliceLayout('bottom', sliceStart, sliceText, actualRelLine * editorLineHeight, ev)
              }
              style={{
                color: theme.text,
                fontFamily: inputFont,
                fontSize: 17 * scale,
                lineHeight: editorLineHeight,
                fontWeight: '400',
                includeFontPadding: false,
              }}
            >
              {sliceText}
            </Text>
          </View>
        );
      }
    }

    return (
      <>
        <WindowStaticChunk
          text={immediateSuffixText}
          chunkKind="suffix"
          paddingTop={0}
          paddingBottom={0}
          themeText={theme.text}
          inputFont={inputFont}
          scale={scale}
          lineHeight={editorLineHeight}
          onChunkPress={handleChunkPress}
          onChunkInfo={handleChunkInfo}
        />
        <Pressable
          onPress={(e) => {
            const locX = e?.nativeEvent?.locationX ?? 0;
            const locY = e?.nativeEvent?.locationY ?? 0;
            handleChunkPress(
              'bottom-spacer',
              locX,
              locY,
              0,
              e?.nativeEvent?.pageX,
              e?.nativeEvent?.pageY
            );
          }}
          onLayout={(e) =>
            fact('spacer bottom', `y=${Math.round(e.nativeEvent.layout.y)} h=${Math.round(e.nativeEvent.layout.height)}`)
          }
          style={{ height: bottomSpacerHeight, position: 'relative', overflow: 'hidden' }}
        >
          {floatingBottomNode}
        </Pressable>
      </>
    );
  }, [suffixRaw, scrollAnchorLine, theme.text, inputFont, scale, editorLineHeight, handleChunkPress, handleSliceLayout]);

  const handleSearchToggle = useCallback(() => {
    clearUndoHighlight();
    setSearchOpen((v) => !v);
    setQuery('');
  }, [clearUndoHighlight]);

  const memoizedHeader = useMemo(
    () => (
      <Header
        onBack={leave}
        center={false}
        right={
          <IconBtn
            name="build"
            onPress={toggleMenu}
            onLongPress={toggleToolbar}
            delayLongPress={350}
            accessibilityLabel="Tap for options menu, press and hold to show or hide toolbar"
          />
        }
      >
        <TextInput
          value={title}
          onChangeText={changeTitle}
          placeholder="Title"
          placeholderTextColor={theme.subtext}
          autoCapitalize={s.titleCaps}
          autoFocus={isNew && !isEffectiveReadOnly}
          editable={!isEffectiveReadOnly}
          returnKeyType="next"
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
    ),
    [
      leave,
      toggleMenu,
      toggleToolbar,
      title,
      changeTitle,
      theme.subtext,
      theme.text,
      s.titleCaps,
      isNew,
      isEffectiveReadOnly,
      inputFont,
      scale,
    ]
  );

  const isTransparentInput = Boolean(undoHighlightOverlay && undoHighlightOverlay.fullOverlay);
  const hasPrefix = prefixRaw.length > 0;
  const hasSuffix = suffixRaw.length > 0;
  const bodyInputStyle = useMemo(
    () => ({
      minHeight: !hasPrefix && !hasSuffix ? 120 : 0,
      paddingHorizontal: EDITOR_H_PAD,
      paddingTop: hasPrefix ? 0 : EDITOR_TOP_PAD,
      paddingBottom: hasSuffix ? 0 : EDITOR_BOTTOM_PAD,
      color: isTransparentInput ? 'transparent' : theme.text,
      fontFamily: inputFont,
      fontSize: 17 * scale,
      lineHeight: editorLineHeight,
      fontWeight: '400' as const,
      includeFontPadding: false,
    }),
    [hasPrefix, hasSuffix, isTransparentInput, theme.text, inputFont, scale, editorLineHeight]
  );

  const localSel = useMemo(() => {
    if (!sel) return undefined;
    const winStart = prefixRaw.length;
    const winLen = windowText.length;
    return {
      start: Math.max(0, Math.min(winLen, sel.start - winStart)),
      end: Math.max(0, Math.min(winLen, sel.end - winStart)),
    };
  }, [sel, prefixRaw.length, windowText.length]);

  const handleBodySelectionChange = useCallback(
    (e: any) => {
      const rawSel = e.nativeEvent.selection;
      dbg(
        `SELECTION ${rawSel.start}-${rawSel.end} winLen=${windowTextRef.current.length} ctrlSel=${!!sel}`
      );
      // Our own early caret placement (before focus): not a user action, nothing to record or fix.
      const preset = presetCaretRef.current;
      if (preset && !focused.current && Date.now() - preset.at < 1500) {
        const expectedLocal = Math.max(
          0,
          Math.min(windowTextRef.current.length, preset.offset - prefixRawRef.current.length)
        );
        if (rawSel.start === rawSel.end && rawSel.start === expectedLocal) return;
      }
      selectionSinceFocusRef.current = true;

      // First tap on the editable text: if Android put the caret somewhere other than the line the
      // user touched (it uses the end of the text), set it where they tapped from our own code.
      const want = intendedCaretRef.current;
      if (want) {
        intendedCaretRef.current = null;
        if (Date.now() - want.at < 1500 && rawSel.start === rawSel.end) {
          const nativeGlobal =
            prefixRawRef.current.length +
            Math.max(0, Math.min(windowTextRef.current.length, rawSel.start));
          if (nativeGlobal !== want.offset) {
            dbg(`caret fix: Android put it at ${nativeGlobal}, tapped ${want.offset}`);
            caretWokenRef.current = true;
            lastEditCursorRef.current = want.offset;
            applyProgrammaticSelection(want.offset);
            return;
          }
        }
      }

      const winStart = prefixRawRef.current.length;
      const winLen = windowTextRef.current.length;
      const fullLen = bodyRef.current.length;

      // If a test harness passes a global offset beyond the current window length, center window around it
      if (
        (prefixRawRef.current.length > 0 || suffixRawRef.current.length > 0) &&
        rawSel.start > winLen &&
        rawSel.start <= fullLen
      ) {
        programmaticSelRef.current = null;
        const globalSel = {
          start: Math.max(0, Math.min(fullLen, rawSel.start)),
          end: Math.max(0, Math.min(fullLen, rawSel.end)),
        };
        selRef.current = globalSel;
        lastEditCursorRef.current = globalSel.end;
        applyFullTextAndWindow(bodyRef.current, globalSel.start, windowedModeRef.current);
        return;
      }

      const localStart = Math.max(0, Math.min(winLen, rawSel.start));
      const localEnd = Math.max(0, Math.min(winLen, rawSel.end));
      const newSel = {
        start: winStart + localStart,
        end: winStart + localEnd,
      };

      // Guard against transient native ReactEditText selection resets (e.g., to 0 or winLen)
      // emitted while a programmatic Undo/Redo/Window selection is being applied
      const progSel = programmaticSelRef.current;
      if (progSel && Date.now() < progSel.until) {
        if (newSel.start === progSel.start && newSel.end === progSel.end) {
          programmaticSelRef.current = null;
          selRef.current = newSel;
          setSel(undefined);
          return;
        }
        if (sel) {
          return;
        }
        programmaticSelRef.current = null;
      }

      const changedByUser = !sel || newSel.start !== sel.start || newSel.end !== sel.end;
      selRef.current = newSel;
      if (sel && newSel.start === sel.start && newSel.end === sel.end) {
        setSel(undefined);
      }
      if (
        changedByUser &&
        undoHighlightRef.current &&
        newSel.start !== undoHighlightRef.current.cursor
      ) {
        clearUndoHighlight();
      }
      // If user places caret near the top or bottom boundary of an active window, slide the window
      // so there is always plenty of prefix/suffix text inside the native TextInput for Backspace or typing
      if (
        changedByUser &&
        !sel &&
        localStart === localEnd &&
        ((winStart > 0 && localStart < 140) ||
          (suffixRawRef.current.length > 0 && winLen - localEnd < 140))
      ) {
        applyFullTextAndWindow(bodyRef.current, newSel.start, windowedModeRef.current);
        applyProgrammaticSelection(newSel.start);
      }
    },
    [sel, clearUndoHighlight, applyFullTextAndWindow, applyProgrammaticSelection]
  );

  const handleWindowWrapperLayout = useCallback(
    (e: any) => {
      windowWrapperYRef.current = e.nativeEvent.layout.y;
      windowWrapperPrefixLenRef.current = prefixRawRef.current.length;
      applyPendingNativeReveal();
    },
    [applyPendingNativeReveal]
  );

  const handleHighlightTextLayout = useCallback(
    (e: any) => {
      const rawLines = e?.nativeEvent?.lines;
      if (!rawLines || !Array.isArray(rawLines) || rawLines.length === 0) return;
      const curWin = windowTextRef.current;
      const parsed = parseNativeTextLines(curWin, rawLines, editorLineHeight);
      const cache: NativeLayoutCache = {
        text: curWin,
        width: editorWidthRef.current || Dimensions.get('window').width,
        scale,
        fontFamily: inputFont,
        lines: parsed.lines,
        totalHeight: parsed.totalHeight,
      };
      nativeWindowLayoutRef.current = cache;
      if (prefixRawRef.current.length === 0 && suffixRawRef.current.length === 0) {
        nativeLayoutRef.current = cache;
      }
      applyPendingNativeReveal();
    },
    [editorLineHeight, scale, inputFont, applyPendingNativeReveal]
  );

  /* On a long (windowed) note, Android can lay the editable box out taller than its text (measured
     ~470 too tall in the log), which leaves a blank gap between the box and the text below it until a
     later re-measure. When the box is clearly taller than its real text, pin it to the text height;
     as soon as the text grows past the pin, release it. */
  const [inputOverride, setInputOverride] = useState<number | null>(null);
  const inputOverrideRef = useRef<number | null>(null);
  const inputLayoutHRef = useRef(0);
  /* After the pin is released because the text proved taller, do not pin again until the text itself
     changes; otherwise a wrong early height reading from Android makes it pin/release in a loop,
     which shows as the screen shaking on the first tap. */
  const pinLockLenRef = useRef(-1);
  const reconcileInputHeight = useCallback(() => {
    const windowed = prefixRawRef.current.length > 0 || suffixRawRef.current.length > 0;
    const text = textHeightRef.current;
    const box = inputLayoutHRef.current;
    const cur = inputOverrideRef.current;
    let next: number | null = cur;
    if (!windowed) {
      next = null;
    } else if (text > 0 && box > 0) {
      if (cur !== null && text > cur + 0.5) {
        next = null;
        pinLockLenRef.current = windowTextRef.current.length;
      } else if (box - text > 6 && pinLockLenRef.current !== windowTextRef.current.length) {
        next = Math.round(text);
      }
    }
    if (next !== cur) {
      dbg(`input height pin ${cur === null ? 'off' : Math.round(cur)} -> ${next === null ? 'off' : next} (box=${Math.round(box)} text=${Math.round(text)})`);
      inputOverrideRef.current = next;
      setInputOverride(next);
    }
  }, []);
  const handleBodyInputLayout = useCallback(
    (e: any) => {
      inputLayoutHRef.current = e.nativeEvent.layout.height;
      fact('input box', `h=${Math.round(inputLayoutHRef.current)}`);
      reconcileInputHeight();
    },
    [reconcileInputHeight]
  );
  const handleBodyContentSizeChange = useCallback(
    (e: any) => {
      textHeightRef.current = e.nativeEvent.contentSize.height;
      dbg(`INPUT h=${Math.round(textHeightRef.current)} chars=${windowTextRef.current.length}`);
      reconcileInputHeight();
    },
    [reconcileInputHeight]
  );

  const handleBodyTouchStart = useCallback(
    (e: any) => {
      const ly = e?.nativeEvent?.locationY;
      const lx = e?.nativeEvent?.locationX;
      dbg(
        `TOUCH locY=${Math.round(ly ?? -1)} wrapY=${Math.round(windowWrapperYRef.current)} scrollY=${Math.round(scrollY.current)} focused=${focused.current}`
      );
      if (MEASURE_FIRST_TAP_CARET && !focused.current) {
        const meas = windowLinesRef.current;
        if (
          typeof ly === 'number' &&
          typeof lx === 'number' &&
          meas &&
          meas.lines.length > 0 &&
          meas.text === windowTextRef.current
        ) {
          const padTop = prefixRawRef.current.length > 0 ? 0 : EDITOR_TOP_PAD;
          const tapY = Math.max(0, ly - padTop);
          let line = meas.lines[meas.lines.length - 1];
          for (let i = 0; i < meas.lines.length; i++) {
            if (tapY < meas.lines[i].y + meas.lines[i].height) {
              line = meas.lines[i];
              break;
            }
          }
          const span = Math.max(0, line.end - line.start);
          const frac =
            line.width > 0
              ? Math.min(1, Math.max(0, (lx - EDITOR_H_PAD - line.x) / line.width))
              : 0;
          const offset = prefixRawRef.current.length + line.start + Math.round(frac * span);
          intendedCaretRef.current = { offset, at: Date.now() };
          dbg(`intended caret ${offset}`);
          if (PRESET_CARET_ON_TOUCH) {
            const local = Math.max(
              0,
              Math.min(windowTextRef.current.length, offset - prefixRawRef.current.length)
            );
            presetCaretRef.current = { offset, at: Date.now() };
            try {
              bodyInputRef.current?.setSelection(local, local);
            } catch {
              presetCaretRef.current = null;
            }
          }
        } else {
          intendedCaretRef.current = null;
          dbg('no measured layout for this tap');
        }
      }
      // Where the finger is in scrolled-content coordinates. The screen position is exact; the
      // view-relative locationY can be off on a tall input, which sent the hold-view logic to a
      // scroll position far past the tapped line.
      const fromTouch = typeof ly === 'number' ? windowWrapperYRef.current + ly : null;
      const py = e?.nativeEvent?.pageY;
      const vt = viewportTopRef.current;
      let tapY2: number | null = fromTouch;
      if (typeof py === 'number' && vt !== null) {
        tapY2 = scrollY.current + (py - vt);
      }
      if (tapY2 !== null && wrapH.current > 0) {
        tapY2 = Math.max(0, Math.min(tapY2, wrapH.current));
      }
      dbg(`tap content y: touch=${fromTouch === null ? 'n/a' : Math.round(fromTouch)} screen=${tapY2 === null ? 'n/a' : Math.round(tapY2)}`);
      rememberTap(tapY2);
    },
    [rememberTap]
  );

  const handleBodyFocus = useCallback(() => {
    dbg(`FOCUS scrollY=${Math.round(scrollY.current)}`);
    {
      const suf = suffixRawRef.current;
      const pre = prefixRawRef.current;
      dbg(
        `NOTE pre=${pre.length} win=${windowTextRef.current.length} suf=${suf.length} sufLines=${suf.split('\n').length} sufNonBlank=${suf.replace(/\s/g, '').length} total=${bodyRef.current.length}`
      );
    }
    focused.current = true;
    setBodyFocused(true);
    // The early caret placement already delivered this focus's selection (and was ignored by the
    // selection handler), so mark it as arrived; otherwise the caret refresh below never runs.
    const presetAtFocus = presetCaretRef.current;
    selectionSinceFocusRef.current = Boolean(
      PRESET_CARET_ON_TOUCH && presetAtFocus && Date.now() - presetAtFocus.at < 1500
    );
    caretWokenRef.current = false;
    const tap = pendingTapRef.current;
    pendingTapRef.current = null;
    if (tap && Date.now() - tap.at < 1500) {
      const now = Date.now();
      tapRestoreRef.current = {
        scrollY: tap.scrollY,
        contentY: tap.contentY,
        startAt: now + 140,
        until: now + 1800,
        fixes: 0,
      };
      // Android's own scroll and the keyboard resize land at slightly different times, so re-check.
      [150, 300, 650, 1000, 1400].forEach((ms) =>
        setTimeout(() => enforceTapRestore(scrollY.current), ms)
      );
    }
    // Make the caret show once the tap's selection has arrived and the keyboard has settled.
    [160, 650, 1100].forEach((ms) => setTimeout(reassertCaret, ms));
  }, [enforceTapRestore, reassertCaret]);

  const handleBodyBlur = useCallback(() => {
    dbg('BLUR');
    focused.current = false;
    setBodyFocused(false);
    pendingTapRef.current = null;
    tapRestoreRef.current = null;
  }, []);

  const handleBottomPress = useCallback(() => {
    clearUndoHighlight();
    if (!isEffectiveReadOnly) {
      rememberTap(null);
      bodyInputRef.current?.focus();
    }
  }, [clearUndoHighlight, isEffectiveReadOnly, rememberTap]);

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
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 18,
      }}
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

  // Position anchored popup menu directly below header or toolbar
  const menuTop = insets.top + 56 + (toolbarVisible ? 48 : 0) + (searchOpen ? 48 : 0) + 4;

  return (
    <Screen>
      {searchOpen ? (
        <View
          style={{
            backgroundColor: theme.bg,
            paddingTop: insets.top + 6,
            paddingBottom: 10,
            paddingHorizontal: 16,
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
            zIndex: 20,
          }}
        >
          {/* Top row: CANCEL on left, < 1/793 > on right */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <Pressable
              onPress={() => {
                setSearchOpen(false);
                setQuery('');
              }}
              hitSlop={8}
              accessibilityLabel="Cancel search"
            >
              <T pointerEvents="none" bold size={15} style={{ color: theme.text, letterSpacing: 0.5 }}>
                CANCEL
              </T>
            </Pressable>

            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Pressable
                onPress={() => jumpTo(matchIdx - 1)}
                hitSlop={10}
                style={{ padding: 4 }}
                accessibilityLabel="Previous match"
              >
                <Ionicons pointerEvents="none" name="chevron-back" size={24} color={theme.text} />
              </Pressable>

              <T size={15} bold style={{ marginHorizontal: 8, minWidth: 44, textAlign: 'center' }}>
                {activeSearchQuery
                  ? `${matches.length === 0 ? 0 : matchIdx + 1}/${matches.length}`
                  : '0/0'}
              </T>

              <Pressable
                onPress={() => jumpTo(matchIdx + 1)}
                hitSlop={10}
                style={{ padding: 4 }}
                accessibilityLabel="Next match"
              >
                <Ionicons pointerEvents="none" name="chevron-forward" size={24} color={theme.text} />
              </Pressable>
            </View>
          </View>

          {/* Outlined "Search note" box with floating label */}
          <View style={{ position: 'relative', marginTop: 4 }}>
            <View
              style={{
                borderWidth: 1.5,
                borderColor: theme.subtext,
                borderRadius: 6,
                paddingHorizontal: 12,
                paddingVertical: Platform.OS === 'ios' ? 8 : 4,
                backgroundColor: theme.bg,
              }}
            >
              <TextInput
                value={query}
                onChangeText={setQuery}
                autoFocus
                blurOnSubmit={false}
                placeholder=""
                placeholderTextColor={theme.subtext}
                onSubmitEditing={() => jumpTo(matchIdx + 1)}
                returnKeyType="search"
                style={{
                  color: theme.text,
                  fontFamily: inputFont,
                  fontSize: 16 * scale,
                  paddingVertical: 2,
                }}
              />
            </View>
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                top: -8,
                left: 10,
                backgroundColor: theme.bg,
                paddingHorizontal: 6,
              }}
            >
              <T size={11} dim style={{ color: theme.subtext }}>
                Search note
              </T>
            </View>
          </View>
        </View>
      ) : (
        <>
          {memoizedHeader}

          {/* Editing Toolbar: Copy, Paste, Undo, Redo, Search, 123 (Note details), Read-Only Lock */}
          <NoteToolbar
            theme={theme}
            visible={toolbarVisible}
            readOnly={isEffectiveReadOnly}
            canUndo={canUndo}
            canRedo={canRedo}
            onCopy={copy}
            onPaste={paste}
            onUndo={undo}
            onRedo={redo}
            onSearchToggle={handleSearchToggle}
            onShowDetails={showCount}
            onToggleReadOnly={toggleReadOnly}
          />
        </>
      )}

      <View
        ref={containerRef}
        style={{ flex: 1, paddingBottom: effectiveKbPadding }}
        onLayout={(e) => {
          containerRef.current?.measure((_x, _y, _w, _h, _pageX, pageY) => {
            if (typeof pageY === 'number') viewportTopRef.current = pageY;
          });
          const h = e.nativeEvent.layout.height;
          setContainerHeight(h);
          if (h > baseContainerHeightRef.current) {
            baseContainerHeightRef.current = h;
          }
        }}
      >
        <ScrollView
          ref={scrollRef}
          removeClippedSubviews={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          overScrollMode="never"
          showsVerticalScrollIndicator={true}
          onScrollBeginDrag={() => {
            isUserScrollingRef.current = true;
            pendingEnd.current = false;
            tapRestoreRef.current = null;
          }}
          onScrollEndDrag={() => {
            isUserScrollingRef.current = false;
          }}
          onMomentumScrollEnd={() => {
            isUserScrollingRef.current = false;
          }}
          onScroll={(e) => {
            const y = e.nativeEvent.contentOffset.y;
            scrollY.current = y;
            lastScrollAtRef.current = Date.now();
            const maxY = maxTextScroll();
            if (REMOVE_PAST_END_SCROLL && !isUserScrollingRef.current && y > maxY + 40) {
              dbg(`past end ${Math.round(y)} > ${Math.round(maxY)}: pulled back`);
              scrollY.current = maxY;
              scrollRef.current?.scrollTo({ y: maxY, animated: false });
              return;
            }
            if (tapRestoreRef.current) {
              dbg(`scroll event y=${Math.round(y)}`);
              enforceTapRestore(y);
            }
            if (prefixRawRef.current.length > 0 || suffixRawRef.current.length > 0) {
              const approxLine = Math.max(0, Math.floor((y - EDITOR_TOP_PAD) / editorLineHeight));
              const quantized = Math.floor(approxLine / 12) * 12;
              if (quantized !== scrollAnchorLineRef.current) {
                scrollAnchorLineRef.current = quantized;
                setScrollAnchorLine(quantized);
              }
            }
          }}
          onLayout={(e) => {
            viewH.current = e.nativeEvent.layout.height;
            dbg(`layout viewH=${Math.round(viewH.current)}`);
            if (tapRestoreRef.current) enforceTapRestore(scrollY.current);
            if (pendingEnd.current && bodyRef.current.length > 0) {
              pendingEnd.current = false;
              const targetY = calculateJumpToEndScrollY({
                text: bodyRef.current,
                scale,
                viewH: e.nativeEvent.layout.height,
                screenWidth: editorWidthRef.current > 0 ? editorWidthRef.current : undefined,
                fontFamily: inputFont,
                nativeLayout: nativeLayoutRef.current,
              });
              scrollY.current = targetY;
              scrollRef.current?.scrollTo({ y: targetY, animated: false });
            }
          }}
          onContentSizeChange={(_w, h) => {
            contentH.current = h;
            dbg(
              `CONTENT h=${Math.round(h)} viewH=${Math.round(viewH.current)} scrollY=${Math.round(scrollY.current)} pre=${prefixRawRef.current.length} win=${windowTextRef.current.length} suf=${suffixRawRef.current.length} kb=${Math.round(kbHeightRef.current)}`
            );
            if (pendingEnd.current && viewH.current > 0 && bodyRef.current.length > 0) {
              pendingEnd.current = false;
              const targetY = calculateJumpToEndScrollY({
                text: bodyRef.current,
                scale,
                viewH: getUsableViewportHeight(),
                screenWidth: editorWidthRef.current > 0 ? editorWidthRef.current : undefined,
                fontFamily: inputFont,
                nativeLayout: nativeLayoutRef.current,
              });
              scrollY.current = targetY;
              scrollRef.current?.scrollTo({ y: targetY, animated: false });
            }
            applyPendingNativeReveal();
          }}
        >
          <View
            style={{ position: 'relative' }}
            onLayout={(e) => {
              editorWidthRef.current = e.nativeEvent.layout.width;
              wrapH.current = e.nativeEvent.layout.height;
              fact('wrap', `h=${Math.round(wrapH.current)}`);
              dbg(`WRAP h=${Math.round(wrapH.current)} viewH=${Math.round(viewH.current)}`);
            }}
          >
            {searchOpen && highlightNodes ? (
              <Pressable
                onPress={() => {
                  Keyboard.dismiss();
                }}
                style={{
                  paddingHorizontal: EDITOR_H_PAD,
                  paddingTop: EDITOR_TOP_PAD,
                  paddingBottom: EDITOR_BOTTOM_PAD,
                  minHeight: 120,
                }}
              >
                <Text
                  textBreakStrategy="simple"
                  style={{
                    color: theme.text,
                    fontFamily: inputFont,
                    fontSize: 17 * scale,
                    lineHeight: editorLineHeight,
                    includeFontPadding: false,
                  }}
                >
                  {highlightNodes}
                </Text>
              </Pressable>
            ) : (
              <>
                {prefixSection}

                <View style={{ position: 'relative' }} onLayout={handleWindowWrapperLayout}>
                  {MEASURE_FIRST_TAP_CARET && measureText.length > 0 ? (
                    <View
                      pointerEvents="none"
                      accessible={false}
                      importantForAccessibility="no-hide-descendants"
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: 0,
                        height: 0,
                        overflow: 'hidden',
                        opacity: 0,
                        paddingHorizontal: EDITOR_H_PAD,
                        paddingTop: hasPrefix ? 0 : EDITOR_TOP_PAD,
                      }}
                    >
                      <Text
                        textBreakStrategy="simple"
                        onTextLayout={(e) => handleWindowMeasure(measureText, e)}
                        style={{
                          color: theme.text,
                          fontFamily: inputFont,
                          fontSize: 17 * scale,
                          lineHeight: editorLineHeight,
                          fontWeight: '400',
                          includeFontPadding: false,
                        }}
                      >
                        {measureText}
                      </Text>
                    </View>
                  ) : null}
                  {undoHighlightOverlay ? (
                    <View
                      pointerEvents="none"
                      accessible={false}
                      importantForAccessibility="no-hide-descendants"
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: 0,
                        paddingHorizontal: EDITOR_H_PAD,
                        paddingTop: hasPrefix ? 0 : EDITOR_TOP_PAD,
                        paddingBottom: hasSuffix ? 0 : EDITOR_BOTTOM_PAD,
                        backgroundColor: undoHighlightOverlay.fullOverlay ? 'transparent' : theme.bg,
                        zIndex: 2,
                      }}
                    >
                      <Text
                        textBreakStrategy="simple"
                        onTextLayout={handleHighlightTextLayout}
                        style={{
                          color: theme.text,
                          fontFamily: inputFont,
                          fontSize: 17 * scale,
                          lineHeight: editorLineHeight,
                          fontWeight: '400',
                          includeFontPadding: false,
                        }}
                      >
                        {undoHighlightOverlay.nodes}
                      </Text>
                    </View>
                  ) : null}

                  <TextInput
                    ref={bodyInputRef}
                    value={windowText}
                    onChangeText={changeBody}
                    multiline
                    textBreakStrategy="simple"
                    editable={!isEffectiveReadOnly}
                    scrollEnabled={false}
                    textAlignVertical="top"
                    placeholder={
                      hasPrefix || hasSuffix
                        ? ''
                        : isEffectiveReadOnly
                          ? 'Note is locked (Read-Only).'
                          : 'Start typing...'
                    }
                    placeholderTextColor={theme.subtext}
                    selection={localSel}
                    onSelectionChange={handleBodySelectionChange}
                    onContentSizeChange={handleBodyContentSizeChange}
                    onTouchStart={handleBodyTouchStart}
                    onFocus={handleBodyFocus}
                    onBlur={handleBodyBlur}
                    onLayout={handleBodyInputLayout}
                    style={inputOverride !== null ? [bodyInputStyle, { height: inputOverride }] : bodyInputStyle}
                  />
                </View>

                {suffixSection}
              </>
            )}
          </View>
          {/* Blank area tap target on short notes so tapping empty bottom space focuses editor without adding extra scroll height on long notes */}
          <Pressable style={{ flex: 1 }} onPress={handleBottomPress} />
        </ScrollView>
      </View>

      <DebugOverlay />

      {/* Anchored floating options menu */}
      {menuOpen ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: 'transparent' }]}
            accessibilityLabel="Close menu"
            onPress={() => setMenuOpen(false)}
          />
          <PopupMenu
            top={menuTop}
            theme={theme}
            maxHeight={Math.max(
              200,
              Dimensions.get('window').height -
              menuTop -
              (keyboardHeight > 0 ? keyboardHeight : 24)
            )}
          >
            <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
              {menuItem('share-outline', 'Share', shareNote)}
              {menuItem('time-outline', 'Revision history', openRevisions)}
              {menuItem('arrow-up', 'Jump to top', scrollToTop)}
              {menuItem('arrow-down', 'Jump to end', scrollToEnd)}
              {menuItem('trash-outline', 'Delete note', removeNote, true)}
            </ScrollView>
          </PopupMenu>
        </View>
      ) : null}
    </Screen>
  );
}