/**
 * Encryption of LOCKED notes / lists at rest.
 *
 * Text of a locked item is stored as  PREFIX + base64(iv | ciphertext | tag)  (AES-256-GCM, native).
 * The 256-bit key is random, created on first use and kept in the phone's secure storage
 * (Android Keystore), never inside the database file. A copy of the database (file extraction,
 * device backup) therefore contains no readable locked text.
 *
 * Anything that is not sealed passes through unchanged, so old data keeps working.
 */
import * as SecureStore from 'expo-secure-store';
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';

export const SEALED_PREFIX = '\u0001ENC1:';
const KEY_NAME = 'np_data_key';

export function isSealed(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.startsWith(SEALED_PREFIX);
}

/** Set by db.ts: true when the database already holds sealed text (so a missing key is an error, not a fresh start). */
let sealedDataProbe: (() => Promise<boolean>) | null = null;
export function setSealedDataProbe(fn: (() => Promise<boolean>) | null): void {
  sealedDataProbe = fn;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 text -> bytes (no dependency on atob / Buffer being present). */
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]);
    const b = B64.indexOf(clean[i + 1]);
    const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : -1;
    const d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : -1;
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}

/** UTF-8 bytes -> text. */
function utf8ToText(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return decodeURIComponent(escape(bin));
}

/**
 * Builds the sealed-data object from stored base64 text.
 * The native Android module does NOT accept a base64 string here (it fails with
 * "Value is a string, expected an Object"), so the bytes are passed. The other forms are only
 * fallbacks in case a different version of the library behaves differently.
 */
function sealedFromBase64(b64: string): AESSealedData {
  const bytes = base64ToBytes(b64);
  const attempts: (() => AESSealedData)[] = [
    () => AESSealedData.fromCombined(bytes),
    () => AESSealedData.fromCombined(bytes, { ivLength: 12, tagLength: 16 }),
    () => AESSealedData.fromCombined(b64),
  ];
  let firstError: unknown = null;
  for (const make of attempts) {
    try {
      return make();
    } catch (e) {
      if (firstError === null) firstError = e;
    }
  }
  throw firstError;
}

let keyPromise: Promise<AESEncryptionKey> | null = null;
let roundTripOk: Promise<void> | null = null;

async function loadKey(): Promise<AESEncryptionKey> {
  // A read error must never lead to a NEW key (that would orphan everything already sealed).
  const stored = await SecureStore.getItemAsync(KEY_NAME);
  if (stored) return AESEncryptionKey.import(stored, 'base64');
  if (sealedDataProbe && (await sealedDataProbe())) {
    throw new Error(
      'The key that protects your locked notes is missing from this device, so they cannot be opened. Nothing was changed.'
    );
  }
  const fresh = await AESEncryptionKey.generate(256);
  await SecureStore.setItemAsync(KEY_NAME, await fresh.encoded('base64'));
  return fresh;
}

function getKey(): Promise<AESEncryptionKey> {
  if (!keyPromise) {
    const p = loadKey();
    keyPromise = p;
    p.catch(() => {
      if (keyPromise === p) keyPromise = null; // retry next time
    });
  }
  return keyPromise;
}

async function decryptWithKey(b64: string, key: AESEncryptionKey): Promise<string> {
  const sealed = sealedFromBase64(b64);
  const out: unknown = await aesDecryptAsync(sealed, key, { output: 'bytes' });
  if (out instanceof Uint8Array) return utf8ToText(out);
  if (out instanceof ArrayBuffer) return utf8ToText(new Uint8Array(out));
  throw new Error('Unexpected result while decrypting a locked note. Nothing was changed.');
}

/**
 * Before anything is locked on this device, prove once that text sealed here can be opened again.
 * If it cannot, locking is refused (instead of storing text that could never be read back).
 */
function ensureRoundTrip(key: AESEncryptionKey): Promise<void> {
  if (!roundTripOk) {
    const p = (async () => {
      const probe = 'vault-self-test \u00e9\u4e2d\ud83d\ude00';
      const sealed = await aesEncryptAsync(new TextEncoder().encode(probe), key);
      const back = await decryptWithKey(await sealed.combined('base64'), key);
      if (back !== probe) throw new Error('Encryption self-test failed on this device. Nothing was locked.');
    })();
    roundTripOk = p;
    p.catch(() => {
      if (roundTripOk === p) roundTripOk = null; // retry next time
    });
  }
  return roundTripOk;
}

/** Encrypts plain text. Empty text and already-sealed text are returned as they are. */
export async function sealText(plain: string): Promise<string> {
  if (plain === '' || isSealed(plain)) return plain;
  const key = await getKey();
  await ensureRoundTrip(key);
  const sealed = await aesEncryptAsync(new TextEncoder().encode(plain), key);
  return SEALED_PREFIX + (await sealed.combined('base64'));
}

/** Decrypts sealed text. Anything not sealed is returned as it is. Throws if it cannot be decrypted. */
export async function openText(stored: string): Promise<string> {
  if (!isSealed(stored)) return stored;
  const key = await getKey();
  return decryptWithKey(stored.slice(SEALED_PREFIX.length), key);
}

/** For tests only. */
export function resetVaultCacheForTests(): void {
  keyPromise = null;
  roundTripOk = null;
}
