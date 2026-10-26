const st = (globalThis.__shared ??= []);
export async function isAvailableAsync() { return true; }
export async function shareAsync(uri, opts) { st.push({ uri, opts }); }
