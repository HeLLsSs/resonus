/**
 * A saved queue read back: what each field is allowed to become when it was
 * written by an older version, or not quite written at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { restoredQueueState, storedListening, type StoredQueue } from '@/lib/storedQueue';

const songs = (...ids: string[]): Song[] => ids.map((id) => ({ id, title: id, duration: id.length * 100 }));

describe('storedListening', () => {
  it('brings shuffle and repeat back, never the dealt flag', () => {
    assert.deepEqual(storedListening({ queue: [], index: 0, positionSec: 0, shuffle: true, repeat: 'all', dealt: true }), {
      shuffle: true,
      queueDealt: false,
      repeat: 'all',
    });
  });

  it('turns anything it does not know into off', () => {
    const saved = { queue: [], index: 0, positionSec: 0, shuffle: 'yes', repeat: 'loop' } as unknown as StoredQueue;
    assert.deepEqual(storedListening(saved), { shuffle: false, queueDealt: false, repeat: 'off' });
  });
});

describe('restoredQueueState', () => {
  it('hands back the saved queue itself, with every field as it was', () => {
    const queue = songs('a', 'bb');
    const seed = songs('s')[0];
    const out = restoredQueueState({
      queue,
      index: 1,
      positionSec: 42,
      radioMode: true,
      radioSeed: seed,
      source: 'Album',
      sourceHref: '/album/1',
      shuffle: true,
      repeat: 'one',
      dealt: true,
    });
    assert.deepEqual(
      [out.queue === queue, out],
      [
        true,
        {
          queue,
          index: 1,
          positionSec: 42,
          durationSec: 200,
          source: 'Album',
          sourceHref: '/album/1',
          radioMode: true,
          radioSeed: seed,
          shuffle: true,
          queueDealt: true,
          repeat: 'one',
        },
      ],
    );
  });

  it('keeps the index inside the queue', () => {
    const queue = songs('a', 'b');
    assert.deepEqual(
      [
        restoredQueueState({ queue, index: 9, positionSec: 0 }).index,
        restoredQueueState({ queue, index: -3, positionSec: 0 }).index,
        restoredQueueState({ queue, positionSec: 0 } as unknown as StoredQueue).index,
      ],
      [1, 0, 0],
    );
  });

  it('reads a position that is not a number of seconds as the start', () => {
    const queue = songs('a');
    const at = (positionSec: unknown) =>
      restoredQueueState({ queue, index: 0, positionSec } as StoredQueue).positionSec;
    assert.deepEqual([at(-5), at(Number.NaN), at('12'), at(Infinity), at(7.5)], [0, 0, 0, 0, 7.5]);
  });

  it('fills in what an older version did not write', () => {
    const queue = [{ id: 'a', title: 'a' }];
    assert.deepEqual(restoredQueueState({ queue, index: 0, positionSec: 0 }), {
      queue,
      index: 0,
      positionSec: 0,
      durationSec: 0,
      source: null,
      sourceHref: null,
      radioMode: false,
      radioSeed: null,
      shuffle: false,
      queueDealt: false,
      repeat: 'off',
    });
  });
});
