import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' };
export async function digestStringAsync(_alg, data) { return createHash('sha256').update(data).digest('hex'); }
export function getRandomBytes(n) { return new Uint8Array(randomBytes(n)); }

// ---- AES-GCM (same layout as the native module: iv(12) | ciphertext | tag(16)) ----
const aesState = (globalThis.__aes ??= { failDecrypt: false });
export class AESEncryptionKey {
  constructor(buf) { this.buf = buf; }
  static async generate() { return new AESEncryptionKey(randomBytes(32)); }
  static async import(x, enc) {
    return new AESEncryptionKey(typeof x === 'string' ? Buffer.from(x, enc === 'hex' ? 'hex' : 'base64') : Buffer.from(x));
  }
  async encoded(enc) { return this.buf.toString(enc); }
  async bytes() { return new Uint8Array(this.buf); }
  get size() { return 256; }
}
export class AESSealedData {
  constructor(buf) { this.buf = buf; }
  // Strict like the real Android module: a base64 STRING is rejected, only bytes are accepted
  // (this is exactly the error seen on a real phone: "Value is a string, expected an Object").
  static fromCombined(c) {
    if (typeof c === 'string') {
      throw new Error("[fromCombined] Cannot convert '" + c.slice(0, 12) + "' to a Kotlin type. Value is a string, expected an Object");
    }
    return new AESSealedData(Buffer.from(c));
  }
  async combined(enc) { return enc === 'base64' ? this.buf.toString('base64') : new Uint8Array(this.buf); }
}
export async function aesEncryptAsync(plain, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key.buf, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plain)), c.final()]);
  return new AESSealedData(Buffer.concat([iv, ct, c.getAuthTag()]));
}
export async function aesDecryptAsync(sealed, key) {
  if (aesState.failDecrypt) throw new Error('decrypt failed');
  const b = sealed.buf;
  const d = createDecipheriv('aes-256-gcm', key.buf, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return new Uint8Array(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]));
}
