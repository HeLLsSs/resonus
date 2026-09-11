/** How a song list is ordered and narrowed: every order, the songs that carry
 *  nothing to order by, and the two quick filters. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import {
  arrangeSongs,
  keepsSong,
  naturalSongDir,
  type SongFilter,
  type SongSortDir,
  type SongSortField,
} from '@/lib/songSort';

function song(overrides: Partial<Song> & { id: string }): Song {
  return { title: `Title ${overrides.id}`, ...overrides };
}

/** The ids in the order they come out, which is what every test here reads. */
function order(
  songs: Song[],
  field: SongSortField,
  dir: SongSortDir = 'asc',
  filter: SongFilter | null = null,
  state = {},
): string[] {
  return arrangeSongs(songs, { field, dir }, filter, state).map((e) => e.song.id);
}

const library: Song[] = [
  song({
    id: 'b',
    title: 'Bravo',
    artist: 'Zeta',
    album: 'Second',
    albumId: '2',
    track: 1,
    created: '2024-03-01T00:00:00Z',
    year: 1999,
    duration: 200,
    playCount: 10,
    userRating: 5,
  }),
  song({
    id: 'a',
    title: 'Alpha',
    artist: 'Alpha Band',
    album: 'First',
    albumId: '1',
    track: 2,
    created: '2026-01-01T00:00:00Z',
    year: 2020,
    duration: 100,
    playCount: 2,
    userRating: 3,
  }),
  song({
    id: 'c',
    title: 'Charlie',
    artist: 'Mid',
    album: 'First',
    albumId: '1',
    track: 1,
    created: '2025-01-01T00:00:00Z',
    year: 2005,
    duration: 300,
    playCount: 6,
    userRating: 1,
  }),
];

describe('arrangeSongs', () => {
  describe('the order the list came in', () => {
    it('leaves it alone', () => {
      assert.deepEqual(order(library, 'recent'), ['b', 'a', 'c']);
    });

    it('turns it round when the direction says so', () => {
      assert.deepEqual(order(library, 'recent', 'desc'), ['c', 'a', 'b']);
    });

    it('reads a playlist backwards for "added", which is the reverse of that', () => {
      assert.deepEqual(order(library, 'added'), ['c', 'a', 'b']);
      assert.deepEqual(order(library, 'added', 'desc'), ['b', 'a', 'c']);
    });

    it('does not touch the list it was given', () => {
      const copy = library.slice();
      order(library, 'added');
      assert.deepEqual(library, copy);
    });
  });

  describe('by words', () => {
    it('orders by title, and backwards', () => {
      assert.deepEqual(order(library, 'alpha'), ['a', 'b', 'c']);
      assert.deepEqual(order(library, 'alpha', 'desc'), ['c', 'b', 'a']);
    });

    it('orders by artist, then by title', () => {
      assert.deepEqual(order(library, 'artist'), ['a', 'c', 'b']);
    });

    it('keeps an album in disc and track order even when the albums run Z-A', () => {
      const out = order(library, 'album', 'desc');
      assert.deepEqual(out, ['b', 'c', 'a']);
    });

    it('separates same-name albums by their id', () => {
      const twins = [
        song({ id: 'x', album: 'Greatest Hits', albumId: '2', track: 1 }),
        song({ id: 'y', album: 'Greatest Hits', albumId: '1', track: 1 }),
      ];
      assert.deepEqual(order(twins, 'album'), ['y', 'x']);
    });
  });

  describe('by a number the song carries', () => {
    it('puts the newest first when the date runs descending', () => {
      assert.deepEqual(order(library, 'date', 'desc'), ['a', 'c', 'b']);
      assert.deepEqual(order(library, 'date'), ['b', 'c', 'a']);
    });

    it('takes the phone\'s own stamp where there is no server date', () => {
      const local = [
        song({ id: 'old', addedAt: Date.parse('2020-01-01T00:00:00Z') }),
        song({ id: 'new', addedAt: Date.parse('2026-01-01T00:00:00Z') }),
      ];
      assert.deepEqual(order(local, 'date', 'desc'), ['new', 'old']);
    });

    it('orders by year, by length, by plays and by rating', () => {
      assert.deepEqual(order(library, 'year'), ['b', 'c', 'a']);
      assert.deepEqual(order(library, 'duration'), ['a', 'b', 'c']);
      assert.deepEqual(order(library, 'plays', 'desc'), ['b', 'c', 'a']);
      assert.deepEqual(order(library, 'rating', 'desc'), ['b', 'a', 'c']);
    });

    it('breaks a tie by title', () => {
      const same = [
        song({ id: 'z', title: 'Zulu', year: 2000 }),
        song({ id: 'm', title: 'Mike', year: 2000 }),
      ];
      assert.deepEqual(order(same, 'year'), ['m', 'z']);
      assert.deepEqual(order(same, 'year', 'desc'), ['m', 'z']);
    });
  });

  describe('a song that does not carry what the order compares', () => {
    const mixed = [
      song({ id: 'none' }),
      song({ id: 'zero', year: 0, userRating: 0, duration: 0 }),
      song({ id: 'has', year: 1990, userRating: 4, duration: 150, created: '2024-01-01T00:00:00Z' }),
    ];

    it('goes last whichever way the order runs', () => {
      for (const field of ['date', 'year', 'duration', 'rating'] as SongSortField[]) {
        assert.deepEqual(order(mixed, field), ['has', 'none', 'zero'], `${field} ascending`);
        assert.deepEqual(order(mixed, field, 'desc'), ['has', 'none', 'zero'], `${field} descending`);
      }
    });

    it('counts a zero play count as an answer, since never played is one', () => {
      const plays = [song({ id: 'unknown' }), song({ id: 'never', playCount: 0 }), song({ id: 'often', playCount: 9 })];
      assert.deepEqual(order(plays, 'plays', 'desc'), ['often', 'never', 'unknown']);
      assert.deepEqual(order(plays, 'plays'), ['never', 'often', 'unknown']);
    });
  });

  describe('by what is on the phone', () => {
    const files = { a: 'file:///a.mp3' };

    it('groups the downloaded ones first, keeping the list order inside each group', () => {
      assert.deepEqual(order(library, 'downloaded', 'asc', null, { files }), ['a', 'b', 'c']);
    });

    it('sends them to the bottom when turned round, still in the list order', () => {
      assert.deepEqual(order(library, 'downloaded', 'desc', null, { files }), ['b', 'c', 'a']);
    });
  });

  describe('with a quick filter', () => {
    const files = { a: 'file:///a.mp3', c: 'file:///c.mp3' };

    it('keeps only what it was asked for, in the order asked for', () => {
      assert.deepEqual(order(library, 'alpha', 'asc', 'downloaded', { files }), ['a', 'c']);
    });

    it('remembers where each song came from, so a row still acts on the right one', () => {
      const kept = arrangeSongs(library, { field: 'alpha', dir: 'asc' }, 'downloaded', { files });
      assert.deepEqual(kept.map((e) => e.index), [1, 2]);
    });

    it('can leave nothing at all', () => {
      assert.deepEqual(order(library, 'recent', 'asc', 'downloaded', {}), []);
    });
  });
});

describe('keepsSong', () => {
  const one = song({ id: 'a' });

  it('keeps a song with a file on the phone', () => {
    assert.equal(keepsSong(one, 'downloaded', { files: { a: 'file:///a.mp3' } }), true);
    assert.equal(keepsSong(one, 'downloaded', { files: {} }), false);
    assert.equal(keepsSong(one, 'downloaded'), false);
  });

  it('asks the central favorites list where there is one', () => {
    const starred = song({ id: 'a', starred: '2026-01-01T00:00:00Z' });
    assert.equal(keepsSong(starred, 'favorites', { favoriteIds: new Set() }), false);
    assert.equal(keepsSong(one, 'favorites', { favoriteIds: new Set(['a']) }), true);
  });

  it('falls back to what the song says when there is no list', () => {
    assert.equal(keepsSong(song({ id: 'a', starred: '2026-01-01T00:00:00Z' }), 'favorites'), true);
    assert.equal(keepsSong(one, 'favorites'), false);
  });
});

describe('naturalSongDir', () => {
  it('opens the orders about newest, most and best the way they are meant to read', () => {
    for (const field of ['date', 'year', 'plays', 'rating'] as SongSortField[]) {
      assert.equal(naturalSongDir(field), 'desc');
    }
  });

  it('leaves the rest running forwards', () => {
    for (const field of ['recent', 'added', 'alpha', 'artist', 'album', 'duration', 'downloaded'] as SongSortField[]) {
      assert.equal(naturalSongDir(field), 'asc');
    }
  });
});
