/**
 * The die's modes: which names are modes, and what a discovery keeps of the
 * library and of YouTube.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DICE_MODES, discoverPool, isDiceMode } from '@/lib/diceModes';

interface S {
  id: string;
  playCount?: number;
}

const ids = (list: S[]) => list.map((s) => s.id).sort();

describe('isDiceMode', () => {
  it('knows the four modes and nothing else', () => {
    assert.deepEqual(
      [...DICE_MODES.map(isDiceMode), isDiceMode('random'), isDiceMode(undefined)],
      [true, true, true, true, false, false],
    );
  });
});

describe('discoverPool', () => {
  it('keeps the library songs the server never counted a play of', () => {
    const library: S[] = [{ id: 'a', playCount: 3 }, { id: 'b', playCount: 0 }, { id: 'c' }];
    assert.deepEqual(ids(discoverPool(library, [], new Set())), ['b', 'c']);
  });

  it('leaves out what the phone itself played, from either side', () => {
    assert.deepEqual(ids(discoverPool([{ id: 'a' }, { id: 'b' }], [{ id: 'y1' }, { id: 'y2' }], new Set(['a', 'y2']))), [
      'b',
      'y1',
    ]);
  });

  it('counts a song found on both sides once, and stops at the size', () => {
    const library: S[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(
      [discoverPool(library, [{ id: 'a' }], new Set()).length, discoverPool(library, [], new Set(), 2).length],
      [3, 2],
    );
  });
});
