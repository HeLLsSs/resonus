/**
 * What `node --test` loads before any test file.
 *
 * Two things on top of `scripts/ts-resolve.mjs`, which already turns `@/x`
 * and extensionless relative imports into the app's TypeScript:
 *
 * - A fixed list of modules is answered with a file from `test/stubs/`
 *   instead of the real one. The modules under test are pure, but they
 *   import things that are not (`expo-*`, `react-native`, the stores), and
 *   those would fail to load outside a phone. A module of the app's own is
 *   swapped by the file it resolves to, so `@/store/auth` and a store's
 *   `./auth` both land on the stub. The list is closed on purpose: a module
 *   that is not on it is the real one, so a test that passes here passed
 *   against the code that ships.
 * - `__DEV__`, which the app reads as a global that Metro defines.
 *
 * Run with `pnpm test`. See `test/README.md`.
 */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolve as resolveTs } from '../scripts/ts-resolve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const STUBS_DIR = path.join(ROOT, 'test', 'stubs');

/**
 * Module as the app names it (a package, or `@/` and its path under `src/`),
 * and the file under `test/stubs/` that answers for it.
 */
const STUBS = new Map([
  ['react-native', 'react-native.ts'],
  ['expo-constants', 'expo-constants.ts'],
  ['expo-crypto', 'expo-crypto.ts'],
  ['expo-file-system', 'expo-file-system.ts'],
  ['expo-secure-store', 'expo-secure-store.ts'],
  ['expo-sharing', 'expo-sharing.ts'],
  ['@/api/data', 'api-data.ts'],
  ['@/api/subsonic', 'api-subsonic.ts'],
  ['@/i18n', 'i18n.ts'],
  ['@/lib/exportSong', 'lib-exportSong.ts'],
  ['@/lib/localLibrary', 'lib-localLibrary.ts'],
  ['@/lib/localQueries', 'lib-localQueries.ts'],
  ['@/lib/query', 'lib-query.ts'],
  ['@/lib/storage', 'lib-storage.ts'],
  ['@/store/auth', 'store-auth.ts'],
  ['@/store/autoDownloads', 'store-hydrated.ts'],
  ['@/store/equalizer', 'store-hydrated.ts'],
  ['@/store/pins', 'store-hydrated.ts'],
  ['@/store/settings', 'store-settings.ts'],
  ['@/store/smartPlaylists', 'store-hydrated.ts'],
  ['@/store/sortPrefs', 'store-hydrated.ts'],
  ['@/store/toast', 'store-toast.ts'],
]);

/** `@/lib/thing` for a file under `src/`, else null. */
function aliasOf(url) {
  if (!url.startsWith('file:')) return null;
  const file = fileURLToPath(url);
  const relative = path.relative(SRC, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const withoutExt = relative.replace(/(\/index)?\.tsx?$/, '');
  return `@/${withoutExt.split(path.sep).join('/')}`;
}

function stubUrl(file) {
  return { url: pathToFileURL(path.join(STUBS_DIR, file)).href, shortCircuit: true };
}

globalThis.__DEV__ = false;

registerHooks({
  resolve(specifier, context, next) {
    const byName = STUBS.get(specifier);
    if (byName) return stubUrl(byName);
    const resolved = resolveTs(specifier, context, next);
    const alias = aliasOf(resolved.url);
    const byFile = alias && STUBS.get(alias);
    return byFile ? stubUrl(byFile) : resolved;
  },
});
