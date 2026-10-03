/**
 * Editing the queue: where added songs land, and that removing or moving one
 * keeps the index on the song that is playing and the "queued" block on the
 * songs that were put there.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { appendedToQueue,
  handAdded,
  insertedNext,
  movedInQueue,
  notYetQueued,
  reinserted,
  removedFromQueue,
  shuffledQueue,
  unmarked,
  unshuffledIndex, originalWith, withoutOne } from '@/lib/queueOps';

const songs = (...ids: string[]): Song[] => ids.map((id) => ({ id, title: id }));
const ids = (list: Song[]) => list.map((s) => s.id);
const reversed = (list: Song[]) => [...list].reverse();

describe('handAdded and unmarked', () => {
  it('swaps the mix mark for the queued one', () => {
    assert.deepEqual(handAdded({ id: 'a', title: 'a', fromMix: true }), { id: 'a', title: 'a', queued: true });
  });

  it('takes both marks off, and hands an unmarked song back as it is', () => {
    const plain = { id: 'b', title: 'b' };
    assert.deepEqual(
      [unmarked({ id: 'a', title: 'a', fromMix: true, queued: true }), unmarked(plain) === plain],
      [{ id: 'a', title: 'a' }, true],
    );
  });
});

describe('appendedToQueue', () => {
  it('puts the songs at the very end, marked, without touching the queue', () => {
    const queue = songs('a', 'b');
    const out = appendedToQueue(queue, songs('x', 'y'));
    assert.deepEqual(
      [ids(out), out.slice(2).every((s) => s.queued), ids(queue)],
      [['a', 'b', 'x', 'y'], true, ['a', 'b']],
    );
  });
});

describe('insertedNext', () => {
  it('goes straight after the current song, in order, and grows the block', () => {
    const out = insertedNext(songs('a', 'b', 'c'), 0, 1, songs('x', 'y'));
    assert.deepEqual([ids(out.queue), out.queuedCount], [['a', 'x', 'y', 'b', 'c'], 3]);
  });

  it('lands at the end when the current song is the last', () => {
    assert.deepEqual(ids(insertedNext(songs('a', 'b'), 1, 0, songs('x')).queue), ['a', 'b', 'x']);
  });

  it('lands in front of the earlier "play next" songs, as splice did', () => {
    const queue = songs('a', 'b', 'c');
    const spliced = [...queue];
    spliced.splice(1, 0, handAdded({ id: 'x', title: 'x' }));
    assert.deepEqual(insertedNext(queue, 0, 1, songs('x')).queue, spliced);
  });
});

describe('removedFromQueue', () => {
  const queue = songs('a', 'b', 'c', 'd', 'e');

  it('is null outside the queue, and on an empty one', () => {
    assert.deepEqual(
      [removedFromQueue(queue, -1, 0, 0), removedFromQueue(queue, 5, 0, 0), removedFromQueue([], 0, 0, 0)],
      [null, null, null],
    );
  });

  it('says so when the last song goes', () => {
    assert.deepEqual(removedFromQueue(songs('a'), 0, 0, 0), { kind: 'emptied' });
  });

  it('removing the current song leaves the index on the one after, and consumes it from the block', () => {
    const out = removedFromQueue(queue, 2, 2, 2);
    assert.deepEqual(out, { kind: 'current', queue: songs('a', 'b', 'd', 'e'), index: 2, queuedCount: 1 });
  });

  it('removing the current song when it is the last steps back, and the block stays at zero', () => {
    const out = removedFromQueue(queue, 4, 4, 0);
    assert.deepEqual(out, { kind: 'current', queue: songs('a', 'b', 'c', 'd'), index: 3, queuedCount: 0 });
  });

  it('removing before the current song moves the index back with it', () => {
    const out = removedFromQueue(queue, 0, 2, 1);
    assert.deepEqual(out, {
      kind: 'other',
      queue: songs('b', 'c', 'd', 'e'),
      index: 1,
      queuedCount: 1,
      inQueuedBlock: false,
    });
  });

  it('removing a queued song after the current one shrinks the block', () => {
    const out = removedFromQueue(queue, 3, 1, 2);
    assert.deepEqual(out, {
      kind: 'other',
      queue: songs('a', 'b', 'c', 'e'),
      index: 1,
      queuedCount: 1,
      inQueuedBlock: true,
    });
  });

  it('removing past the block leaves both alone', () => {
    const out = removedFromQueue(queue, 4, 1, 2);
    assert.deepEqual(out, {
      kind: 'other',
      queue: songs('a', 'b', 'c', 'd'),
      index: 1,
      queuedCount: 2,
      inQueuedBlock: false,
    });
  });
});

describe('reinserted', () => {
  it('undoes a removal before the current song', () => {
    const queue = songs('a', 'b', 'c', 'd');
    const removal = removedFromQueue(queue, 0, 2, 1);
    assert.ok(removal?.kind === 'other');
    const back = reinserted(removal.queue, 0, queue[0], removal.index, removal.queuedCount, removal.inQueuedBlock);
    assert.deepEqual(back, { queue, index: 2, queuedCount: 1 });
  });

  it('undoes a removal from the block', () => {
    const queue = songs('a', 'b', 'c', 'd');
    const removal = removedFromQueue(queue, 2, 0, 2);
    assert.ok(removal?.kind === 'other');
    const back = reinserted(removal.queue, 2, queue[2], removal.index, removal.queuedCount, removal.inQueuedBlock);
    assert.deepEqual(back, { queue, index: 0, queuedCount: 2 });
  });

  it('follows an index that advanced onto the slot since', () => {
    // 'c' removed while 'a' played, then playback moved on to 'd' (index 2).
    const back = reinserted(songs('a', 'b', 'd'), 2, { id: 'c', title: 'c' }, 2, 0, false);
    assert.deepEqual([ids(back.queue), back.index], [['a', 'b', 'c', 'd'], 3]);
  });
});

describe('movedInQueue', () => {
  const queue = songs('a', 'b', 'c', 'd', 'e');

  it('is null for a move that goes nowhere or leaves the queue', () => {
    assert.deepEqual(
      [
        movedInQueue(queue, 1, 1, 0, 0),
        movedInQueue(queue, -1, 2, 0, 0),
        movedInQueue(queue, 1, 5, 0, 0),
        movedInQueue([], 0, 1, 0, 0),
      ],
      [null, null, null, null],
    );
  });

  it('moving the current song carries the index with it and dissolves the block', () => {
    const out = movedInQueue(queue, 1, 3, 1, 2);
    assert.deepEqual(out, { queue: songs('a', 'c', 'd', 'b', 'e'), index: 3, queuedCount: 0 });
  });

  it('moving a song from before the current one to after it steps the index back', () => {
    const out = movedInQueue(queue, 0, 3, 2, 1);
    assert.deepEqual(out, { queue: songs('b', 'c', 'd', 'a', 'e'), index: 1, queuedCount: 0 });
  });

  it('moving a song from after the current one to before it steps the index on', () => {
    const out = movedInQueue(queue, 4, 1, 2, 0);
    assert.deepEqual(out, { queue: songs('a', 'e', 'b', 'c', 'd'), index: 3, queuedCount: 0 });
  });

  it('moving onto the current slot from before counts as crossing it', () => {
    const out = movedInQueue(queue, 0, 2, 2, 0);
    assert.deepEqual([ids(out?.queue ?? []), out?.index], [['b', 'c', 'a', 'd', 'e'], 1]);
  });

  it('a move inside the block keeps it', () => {
    const out = movedInQueue(queue, 3, 1, 0, 3);
    assert.deepEqual(out, { queue: songs('a', 'd', 'b', 'c', 'e'), index: 0, queuedCount: 3 });
  });

  it('a song moved into the block joins it, and one moved out leaves it', () => {
    assert.deepEqual(
      [movedInQueue(queue, 4, 1, 0, 2)?.queuedCount, movedInQueue(queue, 1, 4, 0, 2)?.queuedCount],
      [3, 1],
    );
  });
});

describe('shuffledQueue', () => {
  it('puts the current song first, deals the rest and takes the marks off', () => {
    const queue: Song[] = [
      { id: 'a', title: 'a' },
      { id: 'b', title: 'b', queued: true },
      { id: 'c', title: 'c', fromMix: true },
    ];
    const out = shuffledQueue(queue, 1, false, reversed);
    assert.deepEqual(out, { queue: songs('b', 'c', 'a'), index: 0 });
  });

  it('with the head kept, deals only what is after the current song', () => {
    const out = shuffledQueue(songs('a', 'b', 'c', 'd', 'e'), 1, true, reversed);
    assert.deepEqual(out, { queue: songs('a', 'b', 'e', 'd', 'c'), index: 1 });
  });

  it('deals everything when there is no current song, even asked to keep the head', () => {
    assert.deepEqual(shuffledQueue(songs('a', 'b'), 5, true, reversed), { queue: songs('b', 'a'), index: 0 });
  });

  it('deals an empty queue into an empty queue', () => {
    assert.deepEqual(shuffledQueue([], 0, false), { queue: [], index: 0 });
  });

  it('keeps every song with the real deal', () => {
    const queue = songs('a', 'b', 'c', 'd', 'e', 'f');
    const out = shuffledQueue(queue, 3, false);
    assert.deepEqual([out.queue[0].id, ids(out.queue).sort()], ['d', ids(queue)]);
  });
});

describe('shuffle on and off', () => {
  it('comes back to the same order on the same song', () => {
    const original = songs('a', 'b', 'c', 'd', 'e');
    const on = shuffledQueue(original, 2, false);
    // Playback walks on a couple of songs in the dealt order.
    const current = on.queue[2];
    assert.equal(original[unshuffledIndex(original, current)].id, current.id);
  });

  it('with the head kept, the index survives the round trip untouched', () => {
    const original = songs('a', 'b', 'c', 'd');
    const on = shuffledQueue(original, 1, true);
    assert.deepEqual([on.index, unshuffledIndex(original, on.queue[on.index])], [1, 1]);
  });

  it('falls back to the top for a song the old order never had', () => {
    assert.equal(unshuffledIndex(songs('a', 'b'), { id: 'z', title: 'z' }), 0);
  });
});

describe('notYetQueued', () => {
  it('drops what is already queued and the online tracks, in order', () => {
    const candidates: Song[] = [
      { id: 'a', title: 'a' },
      { id: 'x', title: 'x' },
      { id: 'yt', title: 'yt', url: 'https://example.com/yt' },
      { id: 'y', title: 'y' },
    ];
    assert.deepEqual(ids(notYetQueued(candidates, new Set(['a']))), ['x', 'y']);
  });
});

describe('originalQueue follows queue edits made while shuffled', () => {
  const s = (id: string) => ({ id, title: id }) as Song;

  it('keeps added songs for when shuffle is turned off', () => {
    assert.deepEqual(
      originalWith([s('a'), s('b')], [s('c')]).originalQueue?.map((x) => x.id),
      ['a', 'b', 'c'],
    );
    assert.deepEqual(originalWith(null, [s('c')]), {});
  });

  it('drops one occurrence of a removed song', () => {
    assert.deepEqual(
      withoutOne([s('a'), s('b'), s('a')], s('a')).map((x) => x.id),
      ['b', 'a'],
    );
    const same = [s('a')];
    assert.equal(withoutOne(same, s('z')), same);
  });
});
