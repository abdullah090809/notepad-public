// Clipboard fake. Defaults behave as before (empty clipboard, writes succeed); tests can set globalThis.__clip.
const clip = (globalThis.__clip ??= { text: '', failGet: false, failSet: false });
export async function getStringAsync() { if (clip.failGet) throw new Error('clipboard unavailable'); return clip.text ?? ''; }
export async function setStringAsync(t) { if (clip.failSet) throw new Error('clipboard unavailable'); clip.text = t; return true; }
