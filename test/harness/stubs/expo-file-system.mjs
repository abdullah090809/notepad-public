// In-memory file system. globalThis.__vfs.failWrite = (uri) => boolean injects write failures.
const vfs = (globalThis.__vfs ??= { files: new Map(), dirs: new Set(), failWrite: null });
const join = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
export const Paths = { cache: { uri: 'file:///cache/' }, document: { uri: 'file:///documents/' } };
export class Directory {
  constructor(parent, name) { this.uri = join(parent.uri, name) + '/'; }
  get exists() { return vfs.dirs.has(this.uri); }
  create() { vfs.dirs.add(this.uri); }
}
export class File {
  constructor(a, name) { this.uri = typeof a === 'string' ? a : join(a.uri, name); }
  get exists() { return vfs.files.has(this.uri); }
  delete() { vfs.files.delete(this.uri); }
  create() { vfs.files.set(this.uri, ''); }
  write(content) {
    if (vfs.failWrite && vfs.failWrite(this.uri)) throw new Error('ENOSPC: no space left on device');
    vfs.files.set(this.uri, content);
  }
  async text() { return vfs.files.get(this.uri) ?? ''; }
}
