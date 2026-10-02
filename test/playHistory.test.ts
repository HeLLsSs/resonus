/**
 * The play history and the moment it is read: a song played while the file
 * is still on its way is kept, another profile's read landing late is
 * dropped, and the file is read once per profile.
 *
 * The store remembers which profile it has read, so each test signs in as an
 * account of its own.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { primaryUrl } from '@/lib/serverUrls';
import { type HistoryEntry, usePlayHistory } from '@/store/playHistory';

import { storage } from './stubs/lib-storage';
import { serverProfile, useAuthStore } from './stubs/store-auth';

const song = (id: string): Song => ({ id, title: id });
const entry = (id: string, playedAt: number): HistoryEntry => ({ song: song(id), playedAt });
const ids = () => usePlayHistory.getState().entries.map((e) => e.song.id);

function signIn(username: string): string {
  const auth = serverProfile({ username });
  useAuthStore.setState({ auth, offline: false });
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return `resonus.playHistory.server.${safe(primaryUrl(auth))}.${safe(username)}`;
}

describe('usePlayHistory.hydrate', () => {
  beforeEach(() => {
    storage.reset();
  });

  it('keeps a song played while the file was being read', async () => {
    const key = signIn('ana');
    storage.items.set(key, JSON.stringify([entry('s1', 2), entry('s2', 1)]));
    const reading = usePlayHistory.getState().hydrate();
    usePlayHistory.getState().record(song('s3'));
    await reading;
    assert.deepEqual(ids(), ['s3', 's1', 's2']);
  });

  it('drops a read overtaken by another profile', async () => {
    // Cris has nothing stored, so her read goes on to the old shared key and
    // lands after Dan's.
    signIn('cris');
    const slow = usePlayHistory.getState().hydrate();
    const danKey = signIn('dan');
    storage.items.set(danKey, JSON.stringify([entry('d1', 1)]));
    await usePlayHistory.getState().hydrate();
    await slow;
    assert.deepEqual(ids(), ['d1']);
  });

  it('reads the file once per profile', async () => {
    const key = signIn('eva');
    storage.items.set(key, JSON.stringify([entry('e1', 1)]));
    await usePlayHistory.getState().hydrate();
    usePlayHistory.getState().record(song('e2'));
    // The save has not happened yet: the file still says only e1.
    await usePlayHistory.getState().hydrate();
    assert.deepEqual(ids(), ['e2', 'e1']);
  });
});
