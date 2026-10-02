/**
 * Persistent storage for what is big and not secret.
 *
 * `storage.ts` goes through expo-secure-store, which encrypts every value on
 * the way in and decrypts it on the way out. That is right for a password and
 * wrong for the play queue: up to five hundred whole songs rewritten as one
 * JSON blob whenever the queue moves, and read back on the path the opening
 * waits for, with nothing in it anybody needs hidden. This keeps a file per
 * key in the app's own documents folder instead, which no other app can read
 * either, and falls back to localStorage on web exactly as `storage.ts` does.
 *
 * Keys are used as file names, so they are limited to `[A-Za-z0-9._-]`, the
 * same alphabet SecureStore accepts.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { deleteItem, getItem } from './storage';

const isWeb = Platform.OS === 'web';

function fileFor(key: string): File {
  const dir = new Directory(Paths.document, 'plain-storage');
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `${key}.json`);
}

/** Null when nothing was saved; a read that fails is left to throw, as in
 *  `storage.ts`, so the caller does not take an unreadable file for an empty
 *  one. */
export async function getPlainItem(key: string): Promise<string | null> {
  if (isWeb) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  const file = fileFor(key);
  if (!file.exists) return null;
  return file.text();
}

export async function setPlainItem(key: string, value: string): Promise<void> {
  if (isWeb) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // On web without localStorage we simply don't persist.
    }
    return;
  }
  try {
    fileFor(key).write(value);
  } catch (e) {
    // A full disk, a folder that could not be made: the value is lost either
    // way, and the callers write without awaiting, so this is where it ends.
    if (__DEV__) console.warn('[plainStorage] could not save', key, e);
  }
}

export async function deletePlainItem(key: string): Promise<void> {
  if (isWeb) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // ignore
    }
    return;
  }
  try {
    const file = fileFor(key);
    if (file.exists) file.delete();
  } catch (e) {
    if (__DEV__) console.warn('[plainStorage] could not delete', key, e);
  }
}

/**
 * Reads `key`, taking it over from SecureStore the first time.
 *
 * A value that used to live in `storage.ts` under the same key is read from
 * there once, written here and deleted there, so a phone updated with a queue
 * saved the old way opens on that queue rather than on an empty one. Nothing
 * here on web, where both stores are the same localStorage and the first read
 * already finds it. A read of this store that fails is left to throw; one of
 * the old store is not worth more than an empty answer, since what it held is
 * only ever the copy of what has not been written here yet.
 */
export async function getPlainItemMigrating(key: string): Promise<string | null> {
  const here = await getPlainItem(key);
  if (here != null || isWeb) return here;
  let legacy: string | null = null;
  try {
    legacy = await getItem(key);
  } catch {
    return null;
  }
  if (legacy == null) return null;
  await setPlainItem(key, legacy);
  void deleteItem(key);
  return legacy;
}
