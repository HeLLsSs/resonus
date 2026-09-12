/**
 * What the "For you" button chooses: which artists and genres count as
 * somebody's taste, how the three sources are woven, and what is kept out.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { JUST_HEARD_MS, pickForYou, topArtists, topGenres } from '@/lib/forYou';
import type { HistoryEntry } from '@/store/playHistory';

const NOW = new Date(2026, 8, 11, 12, 0, 0).getTime();

function song(id: string, overrides: Partial<Song> = {}): Song {
  return { id, title: `Title ${id}`, artist: `Artist ${id}`, ...overrides };
}

function play(s: Song, msAgo: number): HistoryEntry {
  return { song: s, playedAt: NOW - msAgo };
}

/**
 * A draw that leaves the order alone, so the lists below read as written.
 * Fisher-Yates swaps `a[i]` with `a[j]` for `j = floor(rng() * (i + 1))`, so
 * the value that keeps every song where it is is the one just under 1 — a draw
 * of 0 rotates the list rather than leaving it be.
 */
const noShuffle = () => 0.999999;

function ids(songs: Song[]): string[] {
  return songs.map((s) => s.id);
}

describe('topArtists', () => {
  it('ranks by how often each was played', () => {
    const history = [
      play(song('a', { artist: 'Tool' }), 1),
      play(song('b', { artist: 'Tool' }), 2),
      play(song('c', { artist: 'Air' }), 3),
      play(song('d', { artist: 'Air' }), 4),
      play(song('e', { artist: 'Air' }), 5),
    ];
    assert.deepEqual(topArtists(history), ['Air', 'Tool']);
  });

  it('leaves out an artist heard only once, which is not a taste', () => {
    const history = [
      play(song('a', { artist: 'Tool' }), 1),
      play(song('b', { artist: 'Tool' }), 2),
      play(song('c', { artist: 'Passing fancy' }), 3),
    ];
    assert.deepEqual(topArtists(history), ['Tool']);
  });

  it('ignores plays with no artist on them', () => {
    assert.deepEqual(topArtists([play(song('a', { artist: undefined }), 1)]), []);
  });
});

describe('topArtists, against what was actually heard', () => {
  const heard = (s: Song, msAgo: number, share: number) => ({
    ...play(s, msAgo),
    heard: share,
  });

  it('ignores a song that was skipped', () => {
    const history = [
      heard(song('a', { artist: 'Skipped' }), 1, 0.02),
      heard(song('b', { artist: 'Skipped' }), 2, 0.05),
      heard(song('c', { artist: 'Heard' }), 3, 1),
      heard(song('d', { artist: 'Heard' }), 4, 1),
    ];
    assert.deepEqual(topArtists(history), ['Heard']);
  });

  it('counts half a song as half a taste', () => {
    const history = [
      heard(song('a', { artist: 'Half' }), 1, 0.5),
      heard(song('b', { artist: 'Half' }), 2, 0.5),
      heard(song('c', { artist: 'Whole' }), 3, 1),
      heard(song('d', { artist: 'Whole' }), 4, 1),
    ];
    assert.deepEqual(topArtists(history), ['Whole', 'Half']);
  });

  it('counts a play in full when nothing says how much was heard', () => {
    // Everything written before this existed, and anything the server gave no
    // duration for: unknown is not the same as rejected.
    const history = [
      play(song('a', { artist: 'Old' }), 1),
      play(song('b', { artist: 'Old' }), 2),
    ];
    assert.deepEqual(topArtists(history), ['Old']);
  });

  it('leaves out an artist whose only two plays were skipped', () => {
    const history = [
      heard(song('a', { artist: 'Skipped' }), 1, 0.01),
      heard(song('b', { artist: 'Skipped' }), 2, 0.01),
    ];
    assert.deepEqual(topArtists(history), []);
  });
});

describe('topArtists, weighted by the hour', () => {
  /** Plays made "now", against plays made at some other time. */
  const nowish = (playedAt: number) => playedAt >= NOW - 3600_000;

  it('puts the artist of this hour ahead of one played as often at another', () => {
    const history = [
      // Two plays each, but only one of them at this hour of the day.
      play(song('a', { artist: 'Night' }), 2),
      play(song('b', { artist: 'Night' }), 3),
      play(song('c', { artist: 'Morning' }), 40 * 3600_000),
      play(song('d', { artist: 'Morning' }), 41 * 3600_000),
    ];
    assert.deepEqual(topArtists(history, 8, nowish), ['Night', 'Morning']);
  });

  it('still leaves out an artist heard once, whatever the hour', () => {
    const history = [play(song('a', { artist: 'Once' }), 1)];
    assert.deepEqual(topArtists(history, 8, nowish), []);
  });

  it('ranks as before when no hour is given', () => {
    const history = [
      play(song('a', { artist: 'Air' }), 40 * 3600_000),
      play(song('b', { artist: 'Air' }), 41 * 3600_000),
      play(song('c', { artist: 'Tool' }), 1),
      play(song('d', { artist: 'Tool' }), 2),
    ];
    assert.deepEqual(topArtists(history).sort(), ['Air', 'Tool']);
  });
});

describe('topGenres', () => {
  it('keeps a genre heard once, unlike an artist', () => {
    assert.deepEqual(topGenres([play(song('a', { genre: 'Dub' }), 1)]), ['Dub']);
  });

  it('ranks by how often each was played and cuts to the ceiling', () => {
    const history = [
      play(song('a', { genre: 'Rock' }), 1),
      play(song('b', { genre: 'Rock' }), 2),
      play(song('c', { genre: 'Jazz' }), 3),
    ];
    assert.deepEqual(topGenres(history, 1), ['Rock']);
  });
});

describe('pickForYou', () => {
  const sources = (over: Partial<Parameters<typeof pickForYou>[0]> = {}) => ({
    favorites: [],
    library: [],
    youtube: [],
    ...over,
  });

  it('weaves the sources rather than laying them end to end', () => {
    const picked = pickForYou(
      sources({
        library: [song('L1'), song('L2'), song('L3')],
        youtube: [song('Y1'), song('Y2')],
        favorites: [song('F1')],
      }),
      { now: NOW, rng: noShuffle },
    );
    // The weave is library, youtube, library, favourite, youtube.
    assert.deepEqual(ids(picked), ['L1', 'Y1', 'L2', 'F1', 'Y2', 'L3']);
  });

  it('leaves out what was played in the last hours', () => {
    const heard = song('L1');
    const picked = pickForYou(sources({ library: [heard, song('L2')] }), {
      history: [play(heard, JUST_HEARD_MS - 1)],
      now: NOW,
      rng: noShuffle,
    });
    assert.deepEqual(ids(picked), ['L2']);
  });

  it('lets back in what was played longer ago than that', () => {
    const heard = song('L1');
    const picked = pickForYou(sources({ library: [heard] }), {
      history: [play(heard, JUST_HEARD_MS + 1)],
      now: NOW,
      rng: noShuffle,
    });
    assert.deepEqual(ids(picked), ['L1']);
  });

  it('takes the same song once when the server and YouTube both have it', () => {
    const picked = pickForYou(
      sources({
        library: [song('local', { artist: 'Tool', title: 'Parabola' })],
        youtube: [song('yt_abc', { artist: 'tool', title: ' Parabola ' })],
      }),
      { now: NOW, rng: noShuffle },
    );
    assert.deepEqual(ids(picked), ['local']);
  });

  it('still fills up when a source runs dry', () => {
    const picked = pickForYou(sources({ library: [song('L1'), song('L2'), song('L3')] }), {
      now: NOW,
      rng: noShuffle,
    });
    assert.deepEqual(ids(picked), ['L1', 'L2', 'L3']);
  });

  it('stops at the ceiling asked for', () => {
    const many = Array.from({ length: 20 }, (_, i) => song(`L${i}`));
    assert.equal(pickForYou(sources({ library: many }), { max: 5, now: NOW, rng: noShuffle }).length, 5);
  });

  it('hands back nothing when every source is empty, rather than pretending', () => {
    assert.deepEqual(pickForYou(sources(), { now: NOW }), []);
  });

  it('hands back nothing when everything there was has just been heard', () => {
    const heard = song('L1');
    const picked = pickForYou(sources({ library: [heard] }), {
      history: [play(heard, 60_000)],
      now: NOW,
      rng: noShuffle,
    });
    assert.deepEqual(picked, []);
  });
});
