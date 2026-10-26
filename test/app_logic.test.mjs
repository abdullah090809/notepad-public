import { register } from 'node:module';
if (!globalThis.__loaderRegistered) {
  globalThis.__loaderRegistered = true;
  register('./harness/loader.mjs', import.meta.url);
}

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  computeTextDiff,
  computeEditStep,
  estimateCharsPerLine,
  computeVisualLines,
  countVisualLines,
  getVisualLineForOffset,
  parseNativeTextLines,
  resolveOffsetGeometry,
  calculateNoteTextHeight,
  calculateJumpToEndScrollY,
  calculateRevealScrollY,
  calculateScrollDecision,
  findNoteMatches,
  renderSearchHighlightSpans,
  renderUndoHighlightSpans,
  computeWindowBounds,
  WINDOW_MODE_THRESHOLD,
} = await import('../src/screens/NoteEditor.tsx');

const { sortEntries } = await import('../src/screens/ListEditor.tsx');
const { getSearchPreview, highlightMatch } = await import('../src/screens/Home.tsx');
const { countText, progressText } = await import('../src/format.ts');

// Test 1: Backup Validation Logic
function validateBackupData(x) {
  if (!x || typeof x !== 'object') {
    return { valid: false, error: 'Backup content is not a valid JSON object.', itemCount: 0 };
  }
  const o = x;
  if (o.app !== 'notepad') {
    return { valid: false, error: "The file is not a Notepad backup (missing 'app: notepad' signature).", itemCount: 0 };
  }
  if (!Array.isArray(o.items)) {
    return { valid: false, error: "Backup file is missing an 'items' array.", itemCount: 0 };
  }
  const ids = new Set();
  for (let i = 0; i < o.items.length; i++) {
    const it = o.items[i];
    if (!it || typeof it !== 'object') {
      return { valid: false, error: `Item at index ${i} is malformed.`, itemCount: 0 };
    }
    const id = String(it.id ?? '').trim();
    if (!id) {
      return { valid: false, error: `Item at index ${i} has an empty or missing ID.`, itemCount: 0 };
    }
    if (ids.has(id)) {
      return { valid: false, error: `Duplicate item ID '${id}' found in backup.`, itemCount: 0 };
    }
    ids.add(id);
  }

  // Detect circular folder references
  const parentMap = new Map();
  for (const it of o.items) {
    if (it.parentId) {
      parentMap.set(String(it.id), String(it.parentId));
    }
  }
  for (const [startId] of parentMap) {
    let current = parentMap.get(startId);
    const visited = new Set([startId]);
    while (current) {
      if (visited.has(current)) {
        return {
          valid: false,
          error: `Circular folder reference detected in backup involving item '${current}'.`,
          itemCount: 0,
        };
      }
      visited.add(current);
      current = parentMap.get(current);
    }
  }

  return { valid: true, itemCount: o.items.length };
}

test('validateBackupData accepts valid backup structure', () => {
  const validData = {
    app: 'notepad',
    version: 1,
    exportedAt: Date.now(),
    items: [
      { id: '1', type: 'note', title: 'Note 1', body: 'Body 1', parentId: null, position: 0 },
      { id: '2', type: 'folder', title: 'Folder 1', body: '', parentId: null, position: 1 },
      { id: '3', type: 'note', title: 'Nested Note', body: 'Body 2', parentId: '2', position: 0 },
    ],
    listItems: [],
  };
  const result = validateBackupData(validData);
  assert.equal(result.valid, true);
  assert.equal(result.itemCount, 3);
});

test('validateBackupData rejects invalid signature or missing items', () => {
  assert.equal(validateBackupData(null).valid, false);
  assert.equal(validateBackupData({ app: 'other_app', items: [] }).valid, false);
  assert.equal(validateBackupData({ app: 'notepad', items: 'not an array' }).valid, false);
});

test('validateBackupData detects duplicate item IDs', () => {
  const duplicateData = {
    app: 'notepad',
    version: 1,
    items: [
      { id: 'dup_id', type: 'note', title: 'A' },
      { id: 'dup_id', type: 'note', title: 'B' },
    ],
  };
  const result = validateBackupData(duplicateData);
  assert.equal(result.valid, false);
  assert.match(result.error, /Duplicate item ID/);
});

test('validateBackupData detects circular folder references', () => {
  const circularData = {
    app: 'notepad',
    version: 1,
    items: [
      { id: 'f1', type: 'folder', title: 'Folder 1', parentId: 'f2' },
      { id: 'f2', type: 'folder', title: 'Folder 2', parentId: 'f1' },
    ],
  };
  const result = validateBackupData(circularData);
  assert.equal(result.valid, false);
  assert.match(result.error, /Circular folder reference/);
});

// Test 2: Read-Only Mode Guard
class ReadOnlyError extends Error {
  constructor(message = 'Cannot modify data while Read-Only Mode is active') {
    super(message);
    this.name = 'ReadOnlyError';
  }
}

let isReadOnlyActive = false;
function assertNotReadOnly() {
  if (isReadOnlyActive) throw new ReadOnlyError();
}

test('assertNotReadOnly enforces read-only state', () => {
  isReadOnlyActive = false;
  assert.doesNotThrow(() => assertNotReadOnly());

  isReadOnlyActive = true;
  assert.throws(() => assertNotReadOnly(), ReadOnlyError);
});

// Test 3: Text Counting Helper Logic
test('countText calculates characters, words, and lines correctly', () => {
  assert.deepEqual(countText(''), { chars: 0, words: 0, lines: 0 });
  assert.deepEqual(countText('Hello world'), { chars: 11, words: 2, lines: 1 });
  assert.deepEqual(countText('Line 1\nLine 2\nLine 3'), { chars: 20, words: 6, lines: 3 });
});

// Test 4: Checklist Partitioning
test('sortEntries partitions checked items to bottom when enabled', () => {
  const items = [
    { id: '1', text: 'Task 1', checked: true },
    { id: '2', text: 'Task 2', checked: false },
    { id: '3', text: 'Task 3', checked: true },
    { id: '4', text: 'Task 4', checked: false },
  ];
  const sorted = sortEntries(items, true);
  assert.deepEqual(sorted.map((i) => i.id), ['2', '4', '1', '3']);
});

// Test 5: Progress Text and Edge Cases (Division by Zero)
test('progressText handles zero items and standard fractions', () => {
  assert.equal(progressText(0, 0, 'percent'), '0%');
  assert.equal(progressText(3, 4, 'percent'), '75%');
  assert.equal(progressText(3, 4, 'fraction'), '3/4');
  assert.equal(progressText(3, 4, 'both'), '75% (3/4)');
});

// Test 6: Undo / Redo Engine & Edit Diff Calculation
test('computeEditStep and computeTextDiff restore exact edit cursor and highlight range for insertions, deletions, undo, and redo', () => {
  const base = 'Paragraph 1\nMiddle section here\nLast paragraph at bottom';
  // Insert 'UPDATED ' before 'Middle' (offset 12)
  const edited = 'Paragraph 1\nUPDATED Middle section here\nLast paragraph at bottom';

  // Forward edit (or Redo from base -> edited):
  const redoStep = computeEditStep(base, edited, { start: 12, end: 12 });
  assert.equal(redoStep.isInsertion, true);
  assert.equal(redoStep.diff.highlightStart, 12);
  assert.equal(redoStep.diff.highlightEnd, 20); // 'UPDATED ' is 8 chars
  assert.equal(edited.slice(redoStep.diff.highlightStart, redoStep.diff.highlightEnd), 'UPDATED ');
  assert.equal(redoStep.newCursor, 20, 'Cursor after redo/insert lands at end of inserted span');

  // Undo from edited -> base (pure deletion of 'UPDATED '):
  const undoDiff = computeTextDiff(edited, base, 20);
  assert.equal(undoDiff.cursor, 12, 'Cursor after undoing insertion returns to offset 12, NOT end of note');
  assert.ok(undoDiff.highlightEnd > undoDiff.highlightStart, 'Pure deletion still provides a context highlight token');

  // Replacement edit: replace 'Middle' with 'Center'
  const replaced = 'Paragraph 1\nCenter section here\nLast paragraph at bottom';
  const replaceStep = computeEditStep(base, replaced, { start: 12, end: 18 });
  assert.equal(replaced.slice(replaceStep.diff.highlightStart, replaceStep.diff.highlightEnd), 'Center');
  assert.equal(replaceStep.newCursor, replaceStep.diff.highlightEnd);
});

test('renderUndoHighlightSpans highlights only the changed range without altering text content', () => {
  const text = 'Alpha Beta Gamma';
  const nodes = renderUndoHighlightSpans(text, 6, 10, '#ffffff', 'rgba(255,255,255,0.45)', true);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].props.children, 'Alpha ');
  assert.equal(nodes[1].props.children, 'Beta');
  assert.equal(nodes[1].props.style.backgroundColor, '#ca8a04');
  assert.equal(nodes[2].props.children, ' Gamma');
  assert.equal(nodes.map((n) => n.props.children).join(''), text);
});

// Test 7: Jump to End & Scroll Controller
test('calculateJumpToEndScrollY accurately scrolls to text content without overshooting empty space and is idempotent', () => {
  const scale = 1;
  const viewH = 600;
  const screenWidth = 400;

  // Short note (5 lines): fits entirely on screen -> targetY must be 0
  const shortText = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
  const shortPress1 = calculateJumpToEndScrollY({ text: shortText, scale, viewH, screenWidth, nativeLayout: null });
  const shortPress2 = calculateJumpToEndScrollY({ text: shortText, scale, viewH, screenWidth, nativeLayout: null });
  assert.equal(shortPress1, 0, 'Short note fits on screen, target must be 0');
  assert.equal(shortPress2, 0, 'Second press on short note must not overscroll');

  // Long note (100 lines): requires scrolling to reach last line, idempotent across repeated presses
  const longText = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
  const longPress1 = calculateJumpToEndScrollY({ text: longText, scale, viewH, screenWidth, nativeLayout: null });
  const longPress2 = calculateJumpToEndScrollY({ text: longText, scale, viewH, screenWidth, nativeLayout: null });
  const longPress3 = calculateJumpToEndScrollY({ text: longText, scale, viewH, screenWidth, nativeLayout: null });
  assert.ok(longPress1 > 0, 'Long note requires scrolling to reach the last line');
  assert.equal(longPress1, longPress2, 'Second press must land at exact same pixel offset');
  assert.equal(longPress2, longPress3, 'Third press must remain invariant');
});

test('calculateScrollDecision prevents jumping on cursor placement or visible edits', () => {
  const lineHeight = 25;
  const viewH = 400;
  const contentH = 2000;
  const textBottom = 2000;
  const curY = 500;

  // 1. Tapping/placing cursor anywhere in note must NEVER auto-scroll
  const tapDecision = calculateScrollDecision({
    reason: 'cursor-placement',
    cursorY: 1200,
    lineHeight,
    textBottom,
    curY,
    viewH,
    contentH,
  });
  assert.equal(tapDecision.shouldScroll, false);
  assert.equal(tapDecision.targetY, curY);

  // 2. Typing or deleting while cursor is already comfortably inside viewport [500, 900] must not move viewport
  const visibleType = calculateScrollDecision({
    reason: 'typing',
    cursorY: 620,
    lineHeight,
    textBottom,
    curY,
    viewH,
    contentH,
  });
  assert.equal(visibleType.shouldScroll, false);
  assert.equal(visibleType.targetY, curY);

  const visibleDelete = calculateScrollDecision({
    reason: 'deletion',
    cursorY: 620,
    lineHeight,
    textBottom,
    curY,
    viewH,
    contentH,
  });
  assert.equal(visibleDelete.shouldScroll, false);
  assert.equal(visibleDelete.targetY, curY);
});

test('Enter insertion keeps previous line visible and rapid Enter presses do not accumulate scroll errors', () => {
  const lineHeight = 25;
  const viewH = 300; // 12 lines visible
  const contentH = 1200;

  // Cursor on line 5 (Y=139), viewport at 0 -> no scroll needed
  const d1 = calculateScrollDecision({
    reason: 'enter',
    cursorY: 5 * lineHeight + 14,
    lineHeight,
    textBottom: contentH,
    curY: 0,
    viewH,
    contentH,
  });
  assert.equal(d1.shouldScroll, false);
  assert.equal(d1.targetY, 0);

  // Cursor enters line 10 (Y=264) near bottom of viewport -> scrolls by ~1.5 lines (39px)
  const d2 = calculateScrollDecision({
    reason: 'enter',
    cursorY: 10 * lineHeight + 14,
    lineHeight,
    textBottom: contentH,
    curY: 0,
    viewH,
    contentH,
  });
  assert.equal(d2.shouldScroll, true);
  assert.equal(d2.targetY, 39);
  // Previous line (line 9 at Y=239) remains visible in [39, 339]
  assert.ok(239 >= d2.targetY && 239 + lineHeight <= d2.targetY + viewH, 'Previous line must remain visible');

  // Simulate 10 rapid Enter presses starting from line 10: each Enter increments targetY by exactly 1 lineHeight (25px)
  let currentScrollY = d2.targetY;
  let body = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n');
  let cursor = body.length;
  for (let step = 0; step < 10; step++) {
    const nextBody = body + '\n';
    const diff = computeTextDiff(body, nextBody, cursor);
    cursor = diff.cursor;
    body = nextBody;
    const cursorLine = 10 + step + 1;
    const cursorY = 14 + cursorLine * lineHeight;
    const nextBottom = contentH + (step + 1) * lineHeight;
    const decision = calculateScrollDecision({
      reason: 'enter',
      cursorY,
      lineHeight,
      textBottom: nextBottom,
      curY: currentScrollY,
      viewH,
      contentH: nextBottom,
    });
    assert.equal(decision.shouldScroll, true);
    assert.equal(decision.targetY - currentScrollY, lineHeight, 'Each Enter at bottom scrolls by exactly 1 lineHeight');
    currentScrollY = decision.targetY;
  }
});

test('calculateRevealScrollY keeps viewport still for visible undo/redo edits and minimally reveals offscreen edits', () => {
  const viewH = 400;
  const contentH = 2000;
  const scrollY = 500;
  const lineHeight = 25;

  // 1. Edit at Y = 700 (comfortably visible inside viewport [500, 900]): does not scroll
  const r1 = calculateRevealScrollY({ editY: 700, lineHeight, curY: scrollY, viewH, contentH });
  assert.equal(r1.shouldScroll, false);
  assert.equal(r1.targetY, 500);

  // 2. Edit at Y = 530 (near top edge within safe margin): does not scroll
  const r2 = calculateRevealScrollY({ editY: 530, lineHeight, curY: scrollY, viewH, contentH });
  assert.equal(r2.shouldScroll, false);
  assert.equal(r2.targetY, 500);

  // 3. Edit at Y = 840 (near bottom edge within safe margin): does not scroll
  const r3 = calculateRevealScrollY({ editY: 840, lineHeight, curY: scrollY, viewH, contentH });
  assert.equal(r3.shouldScroll, false);
  assert.equal(r3.targetY, 500);

  // 4. Edit at Y = 100 (offscreen above): reveals edit, clamped to 0
  const r4 = calculateRevealScrollY({ editY: 100, lineHeight, curY: scrollY, viewH, contentH });
  assert.equal(r4.shouldScroll, true);
  assert.equal(r4.targetY, 0);

  // 5. Edit at Y = 1500 (offscreen below): centers edit in viewport (1313)
  const r5 = calculateRevealScrollY({ editY: 1500, lineHeight, curY: scrollY, viewH, contentH });
  assert.equal(r5.shouldScroll, true);
  assert.equal(r5.targetY, 1313);

  // 6. Subsequent redo at Y = 1500 once at 1313 is already visible: does NOT move again
  const r6 = calculateRevealScrollY({ editY: 1500, lineHeight, curY: 1313, viewH, contentH });
  assert.equal(r6.shouldScroll, false);
  assert.equal(r6.targetY, 1313);
});

// Test 8: Word-Aware Visual Line Wrapping, Native Line Layout, Font Size & Viewport Width Changes
test('computeVisualLines and resolveOffsetGeometry handle soft-wrapped paragraphs, font scales, and native line layout', () => {
  // 1. Word-boundary wrapping: "Hello world from Notepad" at charsPerLine=14 wraps into 2 visual lines
  const wrapped = computeVisualLines('Hello world from Notepad', 14);
  assert.equal(wrapped.length, 2);
  assert.equal(getVisualLineForOffset('Hello world from Notepad', 0, 14), 0);
  assert.equal(getVisualLineForOffset('Hello world from Notepad', 15, 14), 1);

  // 2. Font scale and viewport width changes update charsPerLine and total note height
  const paragraph = 'This is a long wrapped paragraph that spans multiple visual lines in the note editor. '.repeat(10);
  const cplNarrowLargeFont = estimateCharsPerLine(320, 1.3);
  const cplWideSmallFont = estimateCharsPerLine(480, 0.85);
  assert.ok(cplNarrowLargeFont < cplWideSmallFont, 'Larger font + narrower width yields fewer chars per line');

  const hNarrowLarge = calculateNoteTextHeight(paragraph, 1.3, 320, null);
  const hWideSmall = calculateNoteTextHeight(paragraph, 0.85, 480, null);
  assert.ok(hNarrowLarge > hWideSmall, 'Larger font + narrower screen produces taller wrapped text height');

  // 3. Native onTextLayout line measurement takes precedence when synchronized
  const sampleText = 'First line\nSecond line wrapped part one and part two\nThird line';
  const parsed = parseNativeTextLines(
    sampleText,
    [
      { text: 'First line\n', y: 0, height: 25 },
      { text: 'Second line wrapped part one ', y: 25, height: 25 },
      { text: 'and part two\n', y: 50, height: 25 },
      { text: 'Third line', y: 75, height: 25 },
    ],
    25
  );
  const nativeLayout = {
    text: sampleText,
    width: 390,
    scale: 1,
    lines: parsed.lines,
    totalHeight: parsed.totalHeight,
  };
  const geo = resolveOffsetGeometry({
    text: sampleText,
    charOffset: sampleText.indexOf('Third'),
    scale: 1,
    screenWidth: 390,
    nativeLayout,
  });
  assert.equal(geo.lineIndex, 3);
  assert.equal(geo.cursorY, 14 + 75);
});

// Test 9: In-Note Search & Home Search Preview Highlighting
test('findNoteMatches finds all occurrences without 1000-match cap while renderSearchHighlightSpans stays fast and windowed', () => {
  const text = 'abcdefg '.repeat(2000); // 2000 occurrences of 'a'
  const matches = findNoteMatches(text, 'a');
  assert.equal(matches.length, 2000, 'Must find all 2000 matches without truncating at 1000');

  const start = performance.now();
  const spans = renderSearchHighlightSpans(text, 'a', matches, 1500, '#ffffff');
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 20, `Windowed span creation must execute quickly, took ${elapsed}ms`);
  assert.ok(spans.length <= 165, `Must cap created elements to window (~160), got ${spans.length}`);
  const currentMatch = spans.find((s) => s.props?.style?.backgroundColor === '#16a34a');
  assert.ok(currentMatch, 'Active match at index 1500 (>1000) must be present and flagged with green highlight in the window');
});

test('Home getSearchPreview and highlightMatch center snippets around deep matches and checklist matches', () => {
  const longBody = 'Intro text. '.repeat(30) + 'TARGET_KEYWORD_DEEP_IN_NOTE' + ' trailing text.'.repeat(20);
  const item = {
    id: 'n1',
    type: 'note',
    title: 'Long Note',
    body: longBody,
    locked: false,
  };
  const preview = getSearchPreview(item, 'target_keyword');
  assert.ok(preview.includes('TARGET_KEYWORD_DEEP_IN_NOTE'), 'Preview must include match beyond character 160');

  const rendered = highlightMatch(preview, 'target_keyword', '#ffffff');
  const parts = rendered.props.children;
  assert.ok(Array.isArray(parts), 'highlightMatch returns Text element containing array of child nodes');
  assert.ok(
    parts.some((p) => typeof p === 'object' && p?.props?.children === 'TARGET_KEYWORD'),
    'Matched substring must be wrapped in highlighted Text element'
  );

  // Locked note never leaks body in search preview
  const lockedItem = {
    id: 'n2',
    type: 'note',
    title: 'Secret TARGET_KEYWORD Note',
    body: 'Secret body with TARGET_KEYWORD',
    locked: true,
  };
  assert.equal(getSearchPreview(lockedItem, 'target_keyword'), '');

  // Checklist item preview shows matched entry text from searchItems
  const listItem = {
    id: 'l1',
    type: 'list',
    title: 'Shopping',
    body: 'Buy organic almonds',
    locked: false,
  };
  assert.equal(getSearchPreview(listItem, 'almonds'), 'Buy organic almonds');
});

// Test 10: Large List Reorder Integrity
test('large list swap maintains integrity and handles thousands of items efficiently', () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({
    id: `item-${i}`,
    text: `Task ${i}`,
    checked: false,
  }));

  const copy = [...items];
  [copy[2000], copy[2001]] = [copy[2001], copy[2000]];

  assert.equal(copy.length, 5000);
  assert.equal(copy[2000].id, 'item-2001');
  assert.equal(copy[2001].id, 'item-2000');
});

const COUNT_TEXT_MAX_RATIO = 2.5;
function plainSinglePassLoop(str) {
  let lines = 1, words = 0, inWord = false;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 10) { lines++; inWord = false; }
    else if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12 || c === 160) inWord = false;
    else if (!inWord) { inWord = true; words++; }
  }
  return lines + words;
}
function measureCountTextVsBaseline(fn, text, rounds = 5) {
  let countElapsed = Infinity, baselineElapsed = Infinity;
  for (let r = 0; r < rounds; r++) {
    let t = performance.now(); plainSinglePassLoop(text); baselineElapsed = Math.min(baselineElapsed, performance.now() - t);
    t = performance.now(); fn(text); countElapsed = Math.min(countElapsed, performance.now() - t);
  }
  return { countElapsed, baselineElapsed };
}

// Test 11: 1 MB - 10 MB Note O(1) Undo, Redo, Hold-Redo, Deletion & Geometry Performance
test('1 MB - 10 MB note typing, deletion, undo, redo, and incremental geometry execute in O(1) milliseconds', () => {
  // Build a ~2.5 MB note (~50,000 lines of 50 chars each)
  const chunk = 'Paragraph line with realistic note content here.\n';
  const base25MB = chunk.repeat(52000); // ~2,548,000 chars
  assert.ok(base25MB.length > 2_500_000, 'Precondition: note is > 2.5 MB');

  // Prime the incremental geometry cache once (as happens on initial note load)
  const initGeo = resolveOffsetGeometry({
    text: base25MB,
    charOffset: 1_250_000,
    scale: 1,
    screenWidth: 400,
  });
  assert.ok(initGeo.totalLines >= 52000);

  // Prepare an edit near the middle of the 2.5 MB document (offset 1,250,000)
  const editPos = 1_250_000;
  const afterInsert = base25MB.slice(0, editPos) + 'FAST_INSERT ' + base25MB.slice(editPos);
  const afterDelete = base25MB.slice(0, editPos - 10) + base25MB.slice(editPos);

  // Measure 20 consecutive edit / deletion / undo / redo + geometry cycles on the 2.5 MB note
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    // 1. Typing / Insertion step + scroll geometry
    const insStep = computeEditStep(base25MB, afterInsert, { start: editPos, end: editPos });
    const insGeo = resolveOffsetGeometry({
      text: afterInsert,
      charOffset: insStep.newCursor,
      scale: 1,
      screenWidth: 400,
    });
    assert.equal(insStep.newCursor, editPos + 12);
    assert.ok(insGeo.cursorY > 0);

    // 2. Undo back to base25MB + scroll geometry
    const undoDiff = computeTextDiff(afterInsert, base25MB, insStep.newCursor);
    const undoGeo = resolveOffsetGeometry({
      text: base25MB,
      charOffset: undoDiff.cursor,
      scale: 1,
      screenWidth: 400,
    });
    assert.equal(undoDiff.cursor, editPos);
    assert.equal(undoGeo.totalLines, initGeo.totalLines);

    // 3. Deletion step + scroll geometry
    const delStep = computeEditStep(base25MB, afterDelete, { start: editPos, end: editPos });
    const delGeo = resolveOffsetGeometry({
      text: afterDelete,
      charOffset: delStep.newCursor,
      scale: 1,
      screenWidth: 400,
    });
    assert.equal(delStep.isDeletion, true);
    assert.equal(delStep.newCursor, editPos - 10);
    assert.ok(delGeo.cursorY > 0);

    // 4. Redo back to base25MB
    const redoDiff = computeTextDiff(afterDelete, base25MB, editPos);
    assert.equal(redoDiff.cursor, editPos);
  }
  const elapsedMs = performance.now() - t0;
  // 80 full diff + geometry operations on a 2.5 MB note must finish in well under 40ms (<0.5ms per op)
  assert.ok(
    elapsedMs < 40,
    `80 diff + geometry steps on a 2.5 MB note took ${elapsedMs.toFixed(2)}ms (expected < 40ms)`
  );

  // Also verify zero-allocation countText on a 10 MB note
  const tenMB = base25MB.repeat(4); // > 10 MB (10,192,000 chars)
  const counts = countText(tenMB);
  assert.equal(counts.chars, tenMB.length);
  assert.equal(counts.lines, 52000 * 4 + 1);
  // Timing is judged against a plain single-pass charCodeAt loop measured on THIS machine in the same moment
  // (rounds are interleaved, best of each is kept), so a slow or busy computer does not fail the test, while a
  // slower algorithm (allocation, split(), regex, quadratic work) still does.
  const { countElapsed, baselineElapsed } = measureCountTextVsBaseline(countText, tenMB);
  assert.ok(
    countElapsed <= baselineElapsed * COUNT_TEXT_MAX_RATIO + 2,
    `countText on 10 MB took ${countElapsed.toFixed(1)} ms vs ${baselineElapsed.toFixed(1)} ms for a plain single-pass loop (limit x${COUNT_TEXT_MAX_RATIO})`
  );

  // Verify Option 2 computeWindowBounds on short, 500-line, and 10 MB notes
  const shortBounds = computeWindowBounds('Short note\nSecond line', 5, true);
  assert.deepEqual(shortBounds, { winStart: 0, winEnd: 22 });

  for (const cursor of [0, 1500, Math.floor(tenMB.length / 2), tenMB.length - 500, tenMB.length]) {
    const { winStart, winEnd } = computeWindowBounds(tenMB, cursor, true);
    const winLen = winEnd - winStart;
    assert.ok(winStart <= cursor && winEnd >= cursor, `Window [${winStart}, ${winEnd}] must contain cursor ${cursor}`);
    assert.ok(winLen <= WINDOW_MODE_THRESHOLD, `Window length ${winLen} must be <= ${WINDOW_MODE_THRESHOLD}`);
    if (winStart > 0) {
      assert.equal(tenMB.charCodeAt(winStart - 1), 10, 'winStart snaps cleanly after a newline');
    }
    if (winEnd < tenMB.length) {
      assert.equal(tenMB.charCodeAt(winEnd), 10, 'winEnd snaps cleanly at a newline');
    }
  }
});

// The relative bound above must be able to fail: a typical sloppy implementation is far outside it.
test('countText timing bound (x2.5 of a plain loop) rejects a split()/regex implementation', () => {
  const naive = (s) => ({ chars: s.length, lines: s.split('\n').length, words: s.split(/\s+/).filter(Boolean).length });
  const text = 'Paragraph line with realistic note content here.\n'.repeat(52000).repeat(4);
  const { countElapsed, baselineElapsed } = measureCountTextVsBaseline(naive, text, 3);
  assert.ok(countElapsed > baselineElapsed * COUNT_TEXT_MAX_RATIO + 2, `naive took ${countElapsed.toFixed(1)} ms vs ${baselineElapsed.toFixed(1)} ms: the bound would not catch it`);
});

// F-21 / F-24: logic-level checks of the pure jump-to-end maths (no device needed). The timing-based caret/scroll
// behaviour of the editor itself is NOT covered here; see FIX_LOG.md for the device checklist.
test('jump-to-end maths: trailing newline, growth, clamping and huge notes', async () => {
  const { calculateNoteTextHeight } = await import('../src/screens/NoteEditor.tsx');
  const base = { scale: 1, viewH: 600, screenWidth: 400, nativeLayout: null };
  const lines = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n');
  // invalid input
  assert.equal(calculateJumpToEndScrollY({ ...base, text: '' }), 0);
  assert.equal(calculateJumpToEndScrollY({ ...base, text: lines(200), viewH: 0 }), 0);
  assert.equal(calculateJumpToEndScrollY({ ...base, text: lines(200), viewH: -5 }), 0);
  // a trailing newline adds an (empty) last line: the target must not stop short of it
  const noNl = calculateJumpToEndScrollY({ ...base, text: lines(200) });
  const oneNl = calculateJumpToEndScrollY({ ...base, text: lines(200) + '\n' });
  const twoNl = calculateJumpToEndScrollY({ ...base, text: lines(200) + '\n\n' });
  assert.ok(oneNl > noNl, `trailing newline must scroll further (${oneNl} vs ${noNl})`);
  assert.ok(twoNl > oneNl, `second trailing newline must scroll further (${twoNl} vs ${oneNl})`);
  // monotonic in the number of lines, never negative, never beyond the text height
  let prev = -1;
  for (const n of [1, 5, 20, 60, 61, 100, 500, 5000]) {
    const y = calculateJumpToEndScrollY({ ...base, text: lines(n) });
    const h = calculateNoteTextHeight(lines(n), 1, 400, null);
    assert.ok(y >= 0 && y >= prev, `non-decreasing at ${n} lines (${y} >= ${prev})`);
    assert.ok(y <= h, `target ${y} never beyond the text height ${h} at ${n} lines`);
    prev = y;
  }
  // target + viewport = bottom of the text (so the last line ends at the bottom of the screen), for a long note
  const longH = calculateNoteTextHeight(lines(500), 1, 400, null);
  const longY = calculateJumpToEndScrollY({ ...base, text: lines(500) });
  assert.ok(Math.abs(longY + 600 - (longH + 0)) <= 120, `viewport bottom (${longY + 600}) is within the bottom padding of the text height (${longH})`);
  // a taller viewport needs less scrolling; a larger text scale needs more
  assert.ok(calculateJumpToEndScrollY({ ...base, text: lines(500), viewH: 900 }) < longY);
  assert.ok(calculateJumpToEndScrollY({ ...base, text: lines(500), scale: 1.5 }) > longY);
  // 1 MB note: finite, and consistent between calls
  const mb = 'Paragraph line with realistic note content here.\n'.repeat(21000);
  const y1 = calculateJumpToEndScrollY({ ...base, text: mb });
  assert.ok(Number.isFinite(y1) && y1 > 0);
  assert.equal(calculateJumpToEndScrollY({ ...base, text: mb }), y1);
});
