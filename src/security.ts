import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';

const HASH_KEY = 'np_pw_hash';
const SALT_KEY = 'np_pw_salt';
const RESET_KEY = 'np_reset_started';

const MODERN_ITERATIONS = 500;
const LEGACY_ITERATIONS = 200;

/**
 * True while a system dialog (fingerprint prompt, file picker, share sheet) is open.
 * Those dialogs push the app to the background, and we must not treat that as
 * "the user left the app" and lock it.
 */
export const authState = { busy: false };

export async function withExternalUi<T>(fn: () => Promise<T>): Promise<T> {
  authState.busy = true;
  try {
    return await fn();
  } finally {
    setTimeout(() => {
      authState.busy = false;
    }, 700);
  }
}

async function hashRounds(password: string, salt: string, rounds: number): Promise<string> {
  let h = salt + ':' + password;
  for (let i = 0; i < rounds; i++) {
    h = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, h + salt);
  }
  return h;
}

function randomSalt(): string {
  const bytes = Crypto.getRandomBytes(16);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return out;
}

type SecurityChangeListener = (hasPw: boolean) => void;
const securityListeners = new Set<SecurityChangeListener>();

export function subscribeSecurityChange(cb: SecurityChangeListener): () => void {
  securityListeners.add(cb);
  return () => {
    securityListeners.delete(cb);
  };
}

function notifySecurityChange(hasPw: boolean): void {
  securityListeners.forEach((cb) => {
    try {
      cb(hasPw);
    } catch {}
  });
}

export async function hasPassword(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(HASH_KEY)) !== null;
  } catch {
    return true; // fail closed: a read error must not disable the lock
  }
}

export async function setPassword(password: string): Promise<void> {
  const salt = randomSalt();
  const rawHash = await hashRounds(password, salt, MODERN_ITERATIONS);
  const formattedHash = `v2$${MODERN_ITERATIONS}$${rawHash}`;
  const previousSalt = await SecureStore.getItemAsync(SALT_KEY);
  await SecureStore.setItemAsync(SALT_KEY, salt);
  try {
    await SecureStore.setItemAsync(HASH_KEY, formattedHash);
  } catch (e) {
    if (previousSalt !== null) await SecureStore.setItemAsync(SALT_KEY, previousSalt).catch(() => {});
    throw e;
  }
  await SecureStore.deleteItemAsync(RESET_KEY);
  notifySecurityChange(true);
}

export async function verifyPassword(password: string): Promise<boolean> {
  const salt = await SecureStore.getItemAsync(SALT_KEY);
  const storedHash = await SecureStore.getItemAsync(HASH_KEY);
  if (!salt || !storedHash) return false;

  // Modern versioned hash
  if (storedHash.startsWith('v2$')) {
    const parts = storedHash.split('$');
    const rounds = Number(parts[1]) || MODERN_ITERATIONS;
    const expected = parts[2];
    const calculated = await hashRounds(password, salt, rounds);
    if (calculated === expected) {
      if (rounds !== MODERN_ITERATIONS) {
        try {
          // Seamlessly migrate legacy or slow 10k iteration hashes to fast 500 rounds
          await setPassword(password);
        } catch {
          // ignore upgrade error
        }
      }
      return true;
    }
    return false;
  }

  // Legacy format (200 rounds) - verify and automatically upgrade to modern
  const legacyCalculated = await hashRounds(password, salt, LEGACY_ITERATIONS);
  if (legacyCalculated === storedHash) {
    try {
      // Seamlessly upgrade to modern iterations
      await setPassword(password);
    } catch {
      // ignore upgrade error
    }
    return true;
  }

  return false;
}

export async function removePassword(): Promise<void> {
  await SecureStore.deleteItemAsync(HASH_KEY);
  await SecureStore.deleteItemAsync(SALT_KEY);
  await SecureStore.deleteItemAsync(RESET_KEY);
  notifySecurityChange(false);
}

/* ---------- forgotten-password timer ---------- */

export async function getResetStartedAt(): Promise<number | null> {
  try {
    const v = await SecureStore.getItemAsync(RESET_KEY);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function startReset(): Promise<number> {
  const now = Date.now();
  await SecureStore.setItemAsync(RESET_KEY, String(now));
  return now;
}

export async function cancelReset(): Promise<void> {
  await SecureStore.deleteItemAsync(RESET_KEY);
}

/* ---------- fingerprint ---------- */

export async function biometricAvailable(): Promise<boolean> {
  try {
    const hardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return hardware && enrolled;
  } catch {
    return false;
  }
}

export async function authenticateBiometric(prompt = 'Unlock your notes'): Promise<boolean> {
  authState.busy = true;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt,
      cancelLabel: 'Cancel',
      disableDeviceFallback: true,
    });
    return result.success;
  } catch {
    return false;
  } finally {
    setTimeout(() => {
      authState.busy = false;
    }, 700);
  }
}
