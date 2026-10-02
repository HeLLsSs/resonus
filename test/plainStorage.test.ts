/**
 * Plain storage, and how a value saved the old way (in SecureStore) is taken
 * over: read from there once, kept here from then on, and gone from there.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { getPlainItem, getPlainItemMigrating, setPlainItem } from '@/lib/plainStorage';

import { fileSystem } from './stubs/expo-file-system';
import { storage } from './stubs/lib-storage';

const KEY = 'resonus.queue.offline';

describe('plainStorage migration', () => {
  beforeEach(() => {
    fileSystem.reset();
    storage.reset();
  });

  it('answers null when neither store has the key', async () => {
    assert.equal(await getPlainItemMigrating(KEY), null);
  });

  it('prefers what it holds over the old store', async () => {
    await setPlainItem(KEY, 'new');
    storage.items.set(KEY, 'old');
    assert.equal(await getPlainItemMigrating(KEY), 'new');
    assert.equal(storage.items.get(KEY), 'old');
  });

  it('moves the old value over once and deletes it there', async () => {
    storage.items.set(KEY, 'old');
    assert.equal(await getPlainItemMigrating(KEY), 'old');
    assert.equal(await getPlainItem(KEY), 'old');
    assert.equal(storage.items.has(KEY), false);
    assert.equal(await getPlainItemMigrating(KEY), 'old');
  });

  it('treats an unreadable old store as empty', async () => {
    storage.failing = true;
    assert.equal(await getPlainItemMigrating(KEY), null);
  });
});
