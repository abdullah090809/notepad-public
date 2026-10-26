import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler } from 'react-native';

export type Route = { name: string; params?: any };

type NavCtx = {
  route: Route;
  depth: number;
  stack: Route[];
  push: (name: string, params?: any) => void;
  pop: (opts?: { immediate?: boolean }) => void;
  replace: (name: string, params?: any) => void;
  poppingIndex: number | null;
  finishPop: (index: number) => void;
};

const NavContext = createContext<NavCtx | null>(null);

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: 'Home', params: { folderId: null } }]);
  const [poppingIndex, setPoppingIndex] = useState<number | null>(null);
  const stackRef = useRef<Route[]>(stack);
  stackRef.current = stack;
  const poppingIndexRef = useRef<number | null>(null);
  const isPoppingRef = useRef(false);
  const popTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPopTimer = useCallback(() => {
    if (popTimer.current) {
      clearTimeout(popTimer.current);
      popTimer.current = null;
    }
  }, []);

  const finishPop = useCallback((index?: number) => {
    if (!isPoppingRef.current) return;
    const activePopIdx = poppingIndexRef.current;
    if (index !== undefined && activePopIdx !== null && index !== activePopIdx) {
      return;
    }
    clearPopTimer();
    isPoppingRef.current = false;
    poppingIndexRef.current = null;
    setPoppingIndex(null);
    setStack((s) => {
      if (s.length <= 1) return s;
      const targetLen = activePopIdx !== null ? Math.max(1, activePopIdx) : s.length - 1;
      const next = s.slice(0, targetLen);
      stackRef.current = next;
      return next;
    });
  }, [clearPopTimer]);

  const push = useCallback((name: string, params?: any) => {
    if (isPoppingRef.current) {
      clearPopTimer();
      const activePopIdx = poppingIndexRef.current;
      isPoppingRef.current = false;
      poppingIndexRef.current = null;
      setPoppingIndex(null);
      setStack((s) => {
        const base = s.length > 1 && activePopIdx !== null ? s.slice(0, Math.max(1, activePopIdx)) : s;
        const next = [...base, { name, params }];
        stackRef.current = next;
        return next;
      });
      return;
    }
    setStack((s) => {
      const next = [...s, { name, params }];
      stackRef.current = next;
      return next;
    });
  }, [clearPopTimer]);

  const pop = useCallback((opts?: { immediate?: boolean }) => {
    if (stackRef.current.length <= 1) return;
    if (isPoppingRef.current) {
      // Complete the in-progress pop immediately without popping a second screen
      finishPop(poppingIndexRef.current ?? undefined);
      return;
    }
    if (opts?.immediate) {
      clearPopTimer();
      isPoppingRef.current = false;
      poppingIndexRef.current = null;
      setPoppingIndex(null);
      setStack((s) => {
        if (s.length <= 1) return s;
        const next = s.slice(0, -1);
        stackRef.current = next;
        return next;
      });
      return;
    }
    const targetIdx = stackRef.current.length - 1;
    isPoppingRef.current = true;
    poppingIndexRef.current = targetIdx;
    setPoppingIndex(targetIdx);
    clearPopTimer();
    popTimer.current = setTimeout(() => {
      finishPop(targetIdx);
    }, 350);
  }, [finishPop, clearPopTimer]);

  const replace = useCallback((name: string, params?: any) => {
    setStack((s) => {
      const next = [...s.slice(0, -1), { name, params }];
      stackRef.current = next;
      return next;
    });
  }, []);

  // Screens that need to do work before leaving register their own, later handler,
  // which runs first. This one is the fallback.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stackRef.current.length > 1) {
        pop();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [pop]);

  const value = useMemo<NavCtx>(
    () => ({
      route: stack[stack.length - 1],
      depth: stack.length,
      stack,
      push,
      pop,
      replace,
      poppingIndex,
      finishPop,
    }),
    [stack, push, pop, replace, poppingIndex, finishPop]
  );

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): NavCtx {
  const c = useContext(NavContext);
  if (!c) throw new Error('useNav must be used inside NavProvider');
  return c;
}
