/**
 * The past queues: what counts as one, how many are kept, and that each
 * profile reads its own list once.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { MAX_PAST_QUEUES, MAX_QUEUE_SONGS, useQueueHistory } from '@/store/queueHistory';

import { hashKey } from './stubs/lib-localLibrary';
import { storage } from './stubs/lib-storage';
import { serverProfile, useAuthStore } from './stubs/store-auth';

const songs = (...ids: string[]): Song[] => ids.map((id) => ({ id, title: id }));

const keyFor = (scope: string) => `resonus.queueHistory.${hashKey(scope)}`;

describe('useQueueHistory', () => {
  beforeEach(async () => {
    storage.reset();
    useAuthStore.setState({ auth: serverProfile({ username: 'ana' }), offline: false });
    // Start each test on an empty list for this profile: the store is read
    // once per profile, so the list is emptied through the store itself.
    await useQueueHistory.getState().hydrate();
    for (const q of useQueueHistory.getState().queues) await useQueueHistory.getState().remove(q.id);
  });

  it('keeps a replaced queue with its title, ids and cursor', async () => {
    await useQueueHistory.getState().push(songs('a', 'b', 'c'), 1, 'An album');
    const [entry] = useQueueHistory.getState().queues;
    assert.equal(entry.title, 'An album');
    assert.deepEqual(entry.songIds, ['a', 'b', 'c']);
    assert.equal(entry.index, 1);
    assert.ok(entry.id.startsWith('q_'));
  });

  it('ignores a queue of one song', async () => {
    await useQueueHistory.getState().push(songs('a'), 0, 'Solo');
    assert.equal(useQueueHistory.getState().queues.length, 0);
  });

  it('names a queue with no source by the day', async () => {
    await useQueueHistory.getState().push(songs('a', 'b'), 0, null);
    assert.match(useQueueHistory.getState().queues[0].title, /^Queue of /);
  });

  it('clamps the cursor to the queue', async () => {
    await useQueueHistory.getState().push(songs('a', 'b'), 9, 'x');
    await useQueueHistory.getState().push(songs('c', 'd'), -3, 'y');
    const [y, x] = useQueueHistory.getState().queues;
    assert.equal(x.index, 1);
    assert.equal(y.index, 0);
  });

  it('moves the same list to the top rather than keeping it twice', async () => {
    await useQueueHistory.getState().push(songs('a', 'b'), 0, 'First');
    await useQueueHistory.getState().push(songs('c', 'd'), 0, 'Second');
    await useQueueHistory.getState().push(songs('a', 'b'), 1, 'First again');
    assert.deepEqual(
      useQueueHistory.getState().queues.map((q) => q.title),
      ['First again', 'Second'],
    );
  });

  it(`keeps the last ${MAX_PAST_QUEUES} only`, async () => {
    for (let i = 0; i < MAX_PAST_QUEUES + 2; i++) {
      await useQueueHistory.getState().push(songs(`s${i}`, `t${i}`), 0, `Queue ${i}`);
    }
    const titles = useQueueHistory.getState().queues.map((q) => q.title);
    assert.equal(titles.length, MAX_PAST_QUEUES);
    assert.equal(titles[0], `Queue ${MAX_PAST_QUEUES + 1}`);
    assert.equal(titles.at(-1), 'Queue 2');
  });

  it(`cuts a snapshot at ${MAX_QUEUE_SONGS} songs`, async () => {
    const long = songs(...Array.from({ length: MAX_QUEUE_SONGS + 5 }, (_, i) => `s${i}`));
    await useQueueHistory.getState().push(long, MAX_QUEUE_SONGS + 2, 'Long');
    const [entry] = useQueueHistory.getState().queues;
    assert.equal(entry.songIds.length, MAX_QUEUE_SONGS);
    assert.equal(entry.index, MAX_QUEUE_SONGS - 1);
  });

  it("writes the list under the profile's own key", async () => {
    await useQueueHistory.getState().push(songs('a', 'b'), 0, 'Mine');
    const raw = storage.items.get(keyFor('https://music.example|ana'));
    assert.equal(JSON.parse(raw ?? '[]')[0].title, 'Mine');
  });

  it('removes one queue by id', async () => {
    await useQueueHistory.getState().push(songs('a', 'b'), 0, 'Keep');
    await useQueueHistory.getState().push(songs('c', 'd'), 0, 'Drop');
    const drop = useQueueHistory.getState().queues.find((q) => q.title === 'Drop')!;
    await useQueueHistory.getState().remove(drop.id);
    assert.deepEqual(useQueueHistory.getState().queues.map((q) => q.title), ['Keep']);
  });

  it("reads another profile's list when the profile changes, and shares one read between callers", async () => {
    storage.items.set(keyFor('https://music.example|bob'), JSON.stringify([{ id: 'q1', at: 1, title: 'Bob queue', songIds: ['x', 'y'], index: 0 }]));
    useAuthStore.setState({ auth: serverProfile({ username: 'bob' }) });
    const store = useQueueHistory.getState();
    const first = store.hydrate();
    const second = store.hydrate();
    assert.equal(first, second, 'the second caller waits on the first read');
    await first;
    assert.deepEqual(useQueueHistory.getState().queues.map((q) => q.title), ['Bob queue']);
  });

  it('comes back empty, not broken, when the store cannot be read', async () => {
    useAuthStore.setState({ auth: serverProfile({ username: 'carol' }) });
    storage.failing = true;
    await useQueueHistory.getState().hydrate();
    assert.deepEqual(useQueueHistory.getState().queues, []);
  });
});
