/**
 * What the helmet hears when a song starts: the title and the artist, the
 * title alone, and nothing for a radio that has not said what it plays. And
 * which songs of the queue "Prepare the ride" fetches.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { announcement, songsToPrepare } from '@/lib/rideMode';

const song = (over: Partial<Song> = {}): Song =>
  ({ id: 's1', title: 'Highway Star', artist: 'Deep Purple', ...over }) as Song;

describe('announcement', () => {
  it('reads the title and the artist', () => {
    assert.equal(announcement(song(), null), 'Highway Star, by Deep Purple');
  });

  it('reads the title alone when there is no artist', () => {
    assert.equal(announcement(song({ artist: undefined }), null), 'Highway Star');
  });

  it('says nothing for a song with no title', () => {
    assert.equal(announcement(song({ title: '  ' }), null), null);
  });

  it('reads what a radio says it is playing over the station name', () => {
    const station = song({ title: 'FIP', artist: undefined, url: 'https://radio.example/fip' });
    assert.equal(announcement(station, { title: 'So What', artist: 'Miles Davis' }), 'So What, by Miles Davis');
  });

  it('says nothing for a radio that has not said what it plays', () => {
    const station = song({ title: 'FIP', artist: undefined, url: 'https://radio.example/fip' });
    assert.equal(announcement(station, null), null);
  });
});

describe('songsToPrepare', () => {
  const queue = ['a', 'b', 'c', 'd', 'e'].map((id) => song({ id }));
  const ids = (songs: Song[]) => songs.map((s) => s.id);

  it('takes the song playing and the ones after it, up to the count', () => {
    assert.deepEqual(ids(songsToPrepare(queue, 1, 3, false, {})), ['b', 'c', 'd']);
  });

  it('stops at the end of a queue that does not repeat, and goes round one that does', () => {
    assert.deepEqual(ids(songsToPrepare(queue, 3, 4, false, {})), ['d', 'e']);
    assert.deepEqual(ids(songsToPrepare(queue, 3, 4, true, {})), ['d', 'e', 'a', 'b']);
  });

  it('takes the whole queue for a count of zero', () => {
    assert.deepEqual(ids(songsToPrepare(queue, 2, 0, false, {})), ['c', 'd', 'e']);
  });

  it('skips what is already on the phone and the radios, without counting them', () => {
    const mixed = [song({ id: 'a' }), song({ id: 'r', url: 'https://radio.example' }), song({ id: 'l', localUri: 'file:///l' }), song({ id: 'b' }), song({ id: 'c' })];
    assert.deepEqual(ids(songsToPrepare(mixed, 0, 2, false, { a: 'file:///a' })), ['b', 'c']);
  });

  it('asks for nothing from an empty queue', () => {
    assert.deepEqual(songsToPrepare([], 0, 30, true, {}), []);
  });
});
