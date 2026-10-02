/**
 * The offline outbox and whose it is: what was recorded before the file was
 * read is kept, and a change of profile never carries one account's queue
 * into another's file.
 *
 * The store keeps which file it has loaded between tests, so each test signs
 * in as accounts of its own.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { primaryUrl } from '@/lib/serverUrls';
import { useOfflineQueue } from '@/store/offlineQueue';

import { documentDirectory, legacyFileSystem } from './stubs/expo-file-system-legacy';
import { hashKey } from './stubs/lib-localLibrary';
import { serverProfile, useAuthStore } from './stubs/store-auth';

function signIn(username: string): string {
  const auth = serverProfile({ username });
  useAuthStore.setState({ auth, offline: false });
  return `${documentDirectory}offline-queue/${hashKey(`${primaryUrl(auth)}|${auth.username}`)}.json`;
}

/** Lets the serialised writes behind `persist` reach the file. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('useOfflineQueue', () => {
  beforeEach(() => {
    legacyFileSystem.reset();
    useOfflineQueue.setState({ data: {}, loadedFile: null });
  });

  it('reads the profile file', async () => {
    const file = signIn('ana');
    legacyFileSystem.files.set(file, JSON.stringify({ favs: { a: { type: 'song', starred: true } } }));
    await useOfflineQueue.getState().load();
    const { data, loadedFile } = useOfflineQueue.getState();
    assert.equal(loadedFile, file);
    assert.deepEqual(data.favs, { a: { type: 'song', starred: true } });
  });

  it('leaves the previous profile queue behind on a change of profile', async () => {
    const bobFile = signIn('bob');
    useOfflineQueue.getState().setFav('a', 'song', true);
    await useOfflineQueue.getState().load();
    await settle();
    const crisFile = signIn('cris');
    await useOfflineQueue.getState().load();
    assert.equal(useOfflineQueue.getState().loadedFile, crisFile);
    assert.deepEqual(useOfflineQueue.getState().data.favs ?? {}, {});
    // Not lost: it is in the file of the account that made it.
    const kept = JSON.parse(legacyFileSystem.files.get(bobFile) ?? '{}') as { favs?: object };
    assert.deepEqual(kept.favs, { a: { type: 'song', starred: true } });
  });

  it('drops a read overtaken by another profile', async () => {
    const danFile = signIn('dan');
    legacyFileSystem.files.set(danFile, JSON.stringify({ favs: { d: { type: 'song', starred: true } } }));
    // Dan's file takes two round trips to read; Eva has none, so hers lands first.
    const slow = useOfflineQueue.getState().load();
    const evaFile = signIn('eva');
    await useOfflineQueue.getState().load();
    await slow;
    assert.equal(useOfflineQueue.getState().loadedFile, evaFile);
    assert.deepEqual(useOfflineQueue.getState().data.favs ?? {}, {});
  });
});
