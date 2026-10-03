/**
 * A mix batch picked out of what the server offered: no repeats, no online
 * tracks, a cap per artist, and a size it stops at.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { radioBatch } from '@/lib/radioBatch';

const keep = (songs: Song[]) => songs;
const by = (artist: string, ...ids: string[]): Song[] => ids.map((id) => ({ id, title: id, artist }));
const ids = (list: Song[]) => list.map((s) => s.id);

describe('radioBatch', () => {
  it('skips what the queue has and the online tracks', () => {
    const batch = radioBatch(new Set(['a']), 10, 5, keep);
    batch.take([...by('A', 'a', 'b'), { id: 'yt', title: 'yt', url: 'https://example.com' }]);
    assert.deepEqual(ids(batch.picked), ['b']);
  });

  it('caps each artist across pools, and does not pick the same song twice', () => {
    const batch = radioBatch(new Set(), 10, 2, keep);
    batch.take(by('A', 'a1', 'a2', 'a3'));
    batch.take([...by('A', 'a4'), ...by('B', 'b1', 'b1')]);
    assert.deepEqual(ids(batch.picked), ['a1', 'a2', 'b1']);
  });

  it('stops at its size', () => {
    const batch = radioBatch(new Set(), 2, 5, keep);
    batch.take(by('A', 'a1', 'a2', 'a3'));
    assert.deepEqual(ids(batch.picked), ['a1', 'a2']);
  });

  it('tells artists apart by id first, then by name', () => {
    const batch = radioBatch(new Set(), 10, 1, keep);
    batch.take([
      { id: '1', title: '1', artist: 'Same', artistId: 'x' },
      { id: '2', title: '2', artist: 'Same', artistId: 'y' },
      { id: '3', title: '3', artist: 'Same' },
      { id: '4', title: '4', artist: 'Same' },
      { id: '5', title: '5' },
      { id: '6', title: '6' },
    ]);
    assert.deepEqual(ids(batch.picked), ['1', '2', '3', '5']);
  });

  it('leaves the queue it was handed alone', () => {
    const have = new Set(['a']);
    radioBatch(have, 10, 5, keep).take(by('A', 'b'));
    assert.deepEqual([...have], ['a']);
  });
});
