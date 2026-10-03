/**
 * The ⏮ history across lists: what is kept, what a list started again
 * forgets, and the cap.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { contextKey, type HistoryEntry, PlayHistoryStack } from '@/lib/playHistoryStack';

const songs = (...ids: string[]): Song[] => ids.map((id) => ({ id, title: id }));

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  queue: songs('a', 'b'),
  index: 0,
  source: 'Album',
  sourceHref: '/album/1',
  originalQueue: null,
  shuffle: false,
  queueDealt: false,
  radioMode: false,
  radioSeed: null,
  ...over,
});

describe('contextKey', () => {
  it('goes by the screen, then by the name, then by nothing', () => {
    assert.deepEqual(
      [contextKey('Album', '/album/1'), contextKey('Mix', null), contextKey(null, null)],
      ['/album/1', 'Mix', null],
    );
  });
});

describe('PlayHistoryStack', () => {
  it('hands back the last context first', () => {
    const stack = new PlayHistoryStack();
    stack.push(entry({ index: 0 }));
    stack.push(entry({ index: 1 }));
    assert.deepEqual([stack.pop()?.index, stack.pop()?.index, stack.pop()], [1, 0, undefined]);
  });

  it('keeps nothing for a context with no song where it points', () => {
    const stack = new PlayHistoryStack();
    stack.push(entry({ queue: [], index: 0 }));
    stack.push(entry({ index: 2 }));
    assert.equal(stack.size, 0);
  });

  it('drops the oldest past the cap', () => {
    const stack = new PlayHistoryStack(2);
    for (const index of [0, 1, 0]) stack.push(entry({ index, source: String(index) }));
    assert.deepEqual([stack.size, stack.pop()?.source, stack.pop()?.source], [2, '0', '1']);
  });

  it('forgets one list and keeps the others, in their order', () => {
    const stack = new PlayHistoryStack();
    stack.push(entry({ sourceHref: '/album/1' }));
    stack.push(entry({ sourceHref: null, source: 'Mix' }));
    stack.push(entry({ sourceHref: '/album/1' }));
    stack.push(entry({ sourceHref: '/playlist/2' }));
    stack.forget('/album/1');
    assert.deepEqual(
      [stack.size, stack.pop()?.sourceHref, stack.pop()?.source],
      [2, '/playlist/2', 'Mix'],
    );
  });

  it('empties on clear', () => {
    const stack = new PlayHistoryStack();
    stack.push(entry());
    stack.clear();
    assert.equal(stack.pop(), undefined);
  });
});
