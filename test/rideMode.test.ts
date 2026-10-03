/**
 * What the helmet hears when a song starts: the title and the artist, the
 * title alone, and nothing for a radio that has not said what it plays. And
 * which songs of the queue "Prepare the ride" fetches, when it fetches them
 * on its own, and how far the speed raises the volume.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import {
  announcement,
  AUTO_PREPARE_EVERY_MS,
  AUTO_PREPARE_IDLE_MS,
  nextSpeedSteps,
  shouldAutoPrepare,
  smoothSpeed,
  songsToPrepare,
  speedOffset,
} from '@/lib/rideMode';

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

describe('shouldAutoPrepare', () => {
  const now = 1_000_000_000_000;
  const base = { charging: true, wifi: true, hour: 23, lastAt: null, now, screenOffSince: null };

  it('prepares at night on the charger and on Wi-Fi', () => {
    assert.equal(shouldAutoPrepare(base), true);
  });

  it('waits for the charger', () => {
    assert.equal(shouldAutoPrepare({ ...base, charging: false }), false);
  });

  it('waits for Wi-Fi', () => {
    assert.equal(shouldAutoPrepare({ ...base, wifi: false }), false);
  });

  it('counts the early morning as night, and stops at six', () => {
    assert.equal(shouldAutoPrepare({ ...base, hour: 5 }), true);
    assert.equal(shouldAutoPrepare({ ...base, hour: 6 }), false);
  });

  it('prepares in the day once the screen has been off for ten minutes', () => {
    assert.equal(shouldAutoPrepare({ ...base, hour: 15, screenOffSince: now - AUTO_PREPARE_IDLE_MS }), true);
  });

  it('does not prepare in the day with the screen off for less', () => {
    assert.equal(shouldAutoPrepare({ ...base, hour: 15, screenOffSince: now - AUTO_PREPARE_IDLE_MS + 1 }), false);
  });

  it('prepares once in twelve hours at most', () => {
    assert.equal(shouldAutoPrepare({ ...base, lastAt: now - AUTO_PREPARE_EVERY_MS + 1 }), false);
    assert.equal(shouldAutoPrepare({ ...base, lastAt: now - AUTO_PREPARE_EVERY_MS }), true);
  });
});

describe('speedOffset', () => {
  it('adds nothing up to 30 km/h', () => {
    assert.equal(speedOffset(30, 'strong'), 0);
  });

  it('rises evenly to the strength at 110 km/h', () => {
    assert.equal(speedOffset(70, 'medium'), 1);
  });

  it('goes no further past 110 km/h', () => {
    assert.deepEqual([speedOffset(160, 'light'), speedOffset(160, 'medium'), speedOffset(160, 'strong')], [1, 2, 3]);
  });
});

describe('smoothSpeed', () => {
  it('takes the first reading as it is', () => {
    assert.equal(smoothSpeed(null, 80), 80);
  });

  it('moves part of the way towards a new reading', () => {
    assert.equal(smoothSpeed(100, 0), 70);
  });
});

describe('nextSpeedSteps', () => {
  it('stays put while the target is within three quarters of a step', () => {
    assert.equal(nextSpeedSteps(1, 1.7), 1);
  });

  it('moves one step at a time, up and down', () => {
    assert.deepEqual([nextSpeedSteps(0, 3), nextSpeedSteps(3, 0)], [1, 2]);
  });

  it('does not pump with a speed hovering around a threshold', () => {
    let applied = 0;
    const seen = new Set<number>();
    for (const kmh of [68, 72, 69, 71, 70, 73, 67]) {
      applied = nextSpeedSteps(applied, speedOffset(kmh, 'medium'));
      seen.add(applied);
    }
    assert.deepEqual([...seen], [1]);
  });
});
