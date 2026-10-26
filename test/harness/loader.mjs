// ESM loader hooks used ONLY by the test-suite.
//  * transpiles the app's real .ts/.tsx sources with the TypeScript compiler already in devDependencies
//  * resolves extensionless relative imports (Metro-style) to .ts/.tsx
//  * replaces native/Expo/React-Native packages with in-memory fakes (test/harness/stubs)
//  * replaces UI-only app modules (ui, appearance, nav, settings) with test doubles when imported from src/screens or src/backup.ts
// db.ts, security.ts, backup.ts, format.ts and the screens under test are the REAL application code.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const stub = (f) => new URL(`./stubs/${f}`, import.meta.url).href;

const PACKAGE_STUBS = {
  'expo-sqlite': 'expo-sqlite.mjs',
  'expo-secure-store': 'expo-secure-store.mjs',
  'expo-crypto': 'expo-crypto.mjs',
  'expo-local-authentication': 'expo-local-authentication.mjs',
  'expo-file-system': 'expo-file-system.mjs',
  'expo-sharing': 'expo-sharing.mjs',
  'expo-document-picker': 'expo-document-picker.mjs',
  'expo-clipboard': 'expo-clipboard.mjs',
  'react-native': 'react-native.mjs',
  'react-native-safe-area-context': 'safe-area.mjs',
  '@expo/vector-icons': 'vector-icons.mjs',
};
const LOCAL_STUBS = new Set(['ui', 'appearance', 'nav', 'settings']);

export async function resolve(specifier, context, nextResolve) {
  if (PACKAGE_STUBS[specifier]) return { url: stub(PACKAGE_STUBS[specifier]), shortCircuit: true };

  const parent = context.parentURL ?? '';
  const rel = specifier.startsWith('.');
  if (rel && parent.includes('/src/') && !parent.includes('/test/')) {
    const base = specifier.split('/').pop().replace(/\.(tsx?|mjs)$/, '');
    // only UI-layer modules are doubled, and only for consumers that are screens or backup.ts
    if (LOCAL_STUBS.has(base) && (parent.includes('/src/screens/') || parent.endsWith('/src/backup.ts'))) {
      return { url: stub(`local-${base}.mjs`), shortCircuit: true };
    }
  }
  if (rel) {
    const target = new URL(specifier, parent);
    for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const u = new URL(target.href + suffix);
      if (existsSync(fileURLToPath(u)) && /\.(tsx?)$/.test(u.pathname)) {
        return { url: u.href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (/\.(ts|tsx)$/.test(url) && !url.includes('/node_modules/')) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const out = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    return { format: 'module', source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
