/**
 * What the helmet hears when a song starts: the title and the artist, the
 * title alone, and nothing for a radio that has not said what it plays.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { announcement } from '@/lib/rideMode';

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
