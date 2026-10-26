const st = (globalThis.__secure ??= { map: new Map(), failGet: null, failSet: null });
export async function getItemAsync(k) {
  if (st.failGet && st.failGet(k)) throw new Error('keystore read failure');
  return st.map.has(k) ? st.map.get(k) : null;
}
export async function setItemAsync(k, v) {
  if (st.failSet && st.failSet(k)) throw new Error('keystore write failure');
  st.map.set(k, v);
}
export async function deleteItemAsync(k) { st.map.delete(k); }
