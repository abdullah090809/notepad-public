import { createContext, useContext } from 'react';

/**
 * Asks the user to authenticate again (password or fingerprint), for example before
 * opening a locked note. Resolves true when there is no password or the user unlocks.
 */
export const GateContext = createContext<() => Promise<boolean>>(async () => true);

export const useGate = (): (() => Promise<boolean>) => useContext(GateContext);

/**
 * Wraps an async function so that while one call is still pending, further calls get the SAME promise
 * instead of starting a second run (a second run would overwrite the first caller's resolver and leave it waiting forever).
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    const p = fn();
    pending = p;
    const clear = () => {
      if (pending === p) pending = null;
    };
    p.then(clear, clear);
    return p;
  };
}
