// Registers the TypeScript/Expo-stub loader. Use:  node --import ./test/harness/register.mjs --test ...
import { register } from 'node:module';
if (!globalThis.__loaderRegistered) {
  globalThis.__loaderRegistered = true;
  register('./loader.mjs', import.meta.url);
}
