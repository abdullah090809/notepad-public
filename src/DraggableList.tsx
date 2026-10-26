import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppearance } from './appearance';

type HandleProps = {
  onStart: () => void;
  onMove: (dy: number) => void;
  onEnd: () => void;
};

function DragHandle({ onStart, onMove, onEnd }: HandleProps) {
  const { theme } = useAppearance();
  const cb = useRef<HandleProps>({ onStart, onMove, onEnd });
  cb.current = { onStart, onMove, onEnd };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => cb.current.onStart(),
      onPanResponderMove: (_e, g) => cb.current.onMove(g.dy),
      onPanResponderRelease: () => cb.current.onEnd(),
      onPanResponderTerminate: () => cb.current.onEnd(),
    })
  ).current;

  return (
    <View
      {...pan.panHandlers}
      style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}
    >
      <Ionicons pointerEvents="none" name="reorder-two" size={28} color={theme.text} />
    </View>
  );
}

type Props<T> = {
  data: T[];
  keyOf: (item: T) => string;
  rowHeight: number;
  draggable: boolean;
  renderRow: (item: T, handle: React.ReactNode | null, dragging: boolean) => React.ReactNode;
  onReorder: (items: T[]) => void;
  bottomPadding?: number;
};

/**
 * A virtualized, reorderable list for rows of identical height. Drag the handle on the right of a row.
 */
export function DraggableList<T>({
  data,
  keyOf,
  rowHeight,
  draggable,
  renderRow,
  onReorder,
  bottomPadding = 0,
}: Props<T>) {
  const [order, setOrder] = useState<string[]>(() => data.map(keyOf));
  const orderRef = useRef<string[]>(order);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragDy, setDragDy] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [viewH, setViewH] = useState(900);
  const dragKeyRef = useRef<string | null>(null);
  const startIndex = useRef(0);

  useEffect(() => {
    if (dragKeyRef.current === null) {
      const keys = data.map(keyOf);
      orderRef.current = keys;
      setOrder(keys);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const byKey = useMemo(() => {
    const m = new Map<string, T>();
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      m.set(keyOf(d), d);
    }
    return m;
  }, [data, keyOf]);

  const handleStart = (key: string) => {
    dragKeyRef.current = key;
    startIndex.current = orderRef.current.indexOf(key);
    setDragKey(key);
    setDragDy(0);
  };

  const handleMove = (dy: number) => {
    const key = dragKeyRef.current;
    if (key === null) return;
    setDragDy(dy);
    const n = orderRef.current.length;
    let target = Math.round(startIndex.current + dy / rowHeight);
    target = Math.max(0, Math.min(n - 1, target));
    const current = orderRef.current.indexOf(key);
    if (target !== current) {
      const next = orderRef.current.filter((k) => k !== key);
      next.splice(target, 0, key);
      orderRef.current = next;
      setOrder(next);
    }
  };

  const handleEnd = () => {
    const key = dragKeyRef.current;
    if (key === null) return;
    dragKeyRef.current = null;
    setDragKey(null);
    setDragDy(0);
    const next: T[] = [];
    const currentOrder = orderRef.current;
    for (let i = 0; i < currentOrder.length; i++) {
      const item = byKey.get(currentOrder[i]);
      if (item !== undefined) next.push(item);
    }
    onReorder(next);
  };

  const isVirtualized = order.length > 40 && rowHeight > 0;
  const startIdx = isVirtualized ? Math.max(0, Math.floor(scrollY / rowHeight) - 10) : 0;
  const endIdx = isVirtualized
    ? Math.min(order.length, Math.ceil((scrollY + viewH) / rowHeight) + 14)
    : order.length;

  const visibleIndices: number[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    visibleIndices.push(i);
  }
  if (dragKey !== null) {
    const dragIdx = order.indexOf(dragKey);
    if (dragIdx !== -1 && (dragIdx < startIdx || dragIdx >= endIdx)) {
      visibleIndices.push(dragIdx);
    }
  }

  return (
    <ScrollView
      scrollEnabled={dragKey === null}
      contentContainerStyle={{ paddingBottom: bottomPadding }}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16}
      onLayout={(e) => {
        const h = e.nativeEvent?.layout?.height;
        if (h && h > 0) setViewH(h);
      }}
      onScroll={(e) => {
        const y = e.nativeEvent?.contentOffset?.y ?? 0;
        if (Math.abs(y - scrollY) > rowHeight * 2) {
          setScrollY(y);
        }
      }}
    >
      <View style={{ height: order.length * rowHeight }}>
        {visibleIndices.map((idx) => {
          const k = order[idx];
          const item = byKey.get(k);
          if (item === undefined) return null;
          const dragging = k === dragKey;
          const top = dragging ? startIndex.current * rowHeight + dragDy : idx * rowHeight;
          const handle = draggable ? (
            <DragHandle
              onStart={() => handleStart(k)}
              onMove={handleMove}
              onEnd={handleEnd}
            />
          ) : null;
          return (
            <View
              key={k}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top,
                height: rowHeight,
                zIndex: dragging ? 10 : 0,
                elevation: dragging ? 6 : 0,
              }}
            >
              {renderRow(item, handle, dragging)}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}
