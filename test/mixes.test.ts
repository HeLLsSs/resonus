/**
 * The "Made for you" shelf: which cards there are for a given history,
 * library and time of day, and what their `load` asks the server for.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { Album, Genre, Song } from '@/api/subsonic';
import { allMixes, daySlot, decadeMixes, genreMixes, MAX_GENRE_MIXES, rediscoverMix, timeOfDayMix, topGenres, type DayHours } from '@/lib/mixes';
import type { HistoryEntry } from '@/store/playHistory';

import { data } from './stubs/api-data';

const HOURS: DayHours = [6, 12, 19];
const DAY = 86_400_000;
/** A Monday at noon, local time, so the hour arithmetic below is plain. */
const NOON = new Date(2026, 5, 1, 12, 0, 0).getTime();

function song(overrides: Partial<Song> & { id: string }): Song {
  return { title: `Title ${overrides.id}`, ...overrides };
}

function album(id: string, year?: number, extra: Partial<Album> = {}): Album {
  return { id, name: `Album ${id}`, year, ...extra } as Album;
}

/** A play at the given hour of some day, of a song by the given artist. */
function play(hour: number, s: Song, daysAgo = 1): HistoryEntry {
  return { song: s, playedAt: new Date(2026, 5, 1 - daysAgo, hour, 0, 0).getTime() };
}

describe('daySlot', () => {
  it('splits the day at the three hours given', () => {
    assert.equal(daySlot(6, HOURS), 'morning');
    assert.equal(daySlot(11, HOURS), 'morning');
    assert.equal(daySlot(12, HOURS), 'afternoon');
    assert.equal(daySlot(19, HOURS), 'evening');
    assert.equal(daySlot(23, HOURS), 'evening');
    assert.equal(daySlot(3, HOURS), 'night');
  });
});

describe('timeOfDayMix', () => {
  const jazz = song({ id: 'j1', artistId: 'nina', genre: 'Jazz', coverArt: 'c-j1' });
  const jazz2 = song({ id: 'j2', artistId: 'nina', genre: 'Jazz', albumId: 'al-j2' });
  const rock = song({ id: 'r1', artistId: 'acdc', genre: 'Rock', coverArt: 'c-r1' });

  beforeEach(() => data.reset());

  it('is nothing without a history', () => {
    assert.equal(timeOfDayMix([], 'morning', HOURS), null);
  });

  it('builds from the same slot on other days once it has three plays there', () => {
    const entries = [play(8, jazz), play(9, jazz2), play(7, rock), play(22, rock), play(23, rock)];
    const mix = timeOfDayMix(entries, 'morning', HOURS);
    assert.equal(mix?.key, 'slot-morning');
    assert.equal(mix?.title.key, 'Morning mix');
    assert.equal(mix?.subtitle.key, 'What you play in the morning');
    assert.deepEqual(mix?.covers, ['c-j1', 'al-j2', 'c-r1']);
  });

  it('falls back to the whole history under three plays in the slot, and says so', () => {
    const entries = [play(8, jazz), play(22, rock), play(23, rock)];
    const mix = timeOfDayMix(entries, 'morning', HOURS);
    assert.equal(mix?.subtitle.key, 'Based on what you listen to');
    assert.deepEqual(mix?.covers, ['c-j1', 'c-r1']);
  });

  it('loads similar songs for the top artists and random songs of the top genres', async () => {
    const entries = [play(8, jazz), play(9, jazz2), play(7, rock)];
    data.similar = [song({ id: 'sim1' })];
    data.random = [song({ id: 'rnd1' })];
    const out = await timeOfDayMix(entries, 'morning', HOURS)!.load();
    const asked = data.calls.map((c) => [c.name, c.args[0], c.args[1]]);
    assert.deepEqual(asked, [
      ['getSimilarSongs', 'j1', 15],
      ['getSimilarSongs', 'r1', 15],
      ['getRandomSongs', 15, 'Jazz'],
      ['getRandomSongs', 15, 'Rock'],
    ]);
    assert.deepEqual(out.map((s) => s.id).sort(), ['j1', 'j2', 'r1', 'rnd1', 'sim1']);
  });

  it('plays the history itself when the server has nothing to add', async () => {
    data.failure = new Error('no such endpoint');
    const out = await timeOfDayMix([play(8, jazz), play(9, rock)], 'morning', HOURS)!.load();
    assert.deepEqual(out.map((s) => s.id).sort(), ['j1', 'r1']);
  });
});

describe('rediscoverMix', () => {
  const oldSong = song({ id: 'old', coverArt: 'c-old' });
  const newSong = song({ id: 'new', coverArt: 'c-new' });
  const entries: HistoryEntry[] = [
    { song: newSong, playedAt: NOON - 2 * DAY },
    { song: oldSong, playedAt: NOON - 45 * DAY },
  ];

  it('is nothing until something is a month old', () => {
    assert.equal(rediscoverMix([{ song: newSong, playedAt: NOON - DAY }], { '/album/a': NOON - DAY }, NOON), null);
  });

  it('takes the albums opened a month ago, oldest first, and the old plays', () => {
    const times = { '/album/b': NOON - 40 * DAY, '/album/a': NOON - 90 * DAY, '/playlist/p': NOON - 90 * DAY, '/album/c': NOON - DAY };
    const mix = rediscoverMix(entries, times, NOON);
    assert.equal(mix?.key, 'rediscover');
    assert.deepEqual(mix?.covers, ['a', 'b', 'c-old']);
  });

  it('loads a few songs of each album alongside the forgotten plays', async () => {
    data.reset();
    data.albums.set('a', { album: album('a'), songs: [song({ id: 'a1' }), song({ id: 'a2' })] });
    const mix = rediscoverMix(entries, { '/album/a': NOON - 90 * DAY, '/album/gone': NOON - 90 * DAY }, NOON);
    const out = await mix!.load();
    assert.deepEqual(out.map((s) => s.id).sort(), ['a1', 'a2', 'old']);
  });
});

describe('decadeMixes', () => {
  it('gives a card to every decade with three albums, most represented first', () => {
    const albums = [
      album('a', 1991), album('b', 1995), album('c', 1999),
      album('d', 2003), album('e', 2004), album('f', 2005), album('g', 2009),
      album('h', 1975), album('i', 1976),
    ];
    const mixes = decadeMixes(albums);
    assert.deepEqual(mixes.map((m) => m.key), ['decade-2000', 'decade-1990']);
    assert.deepEqual(mixes[0].title, { key: '{decade}s mix', vars: { decade: 2000 } });
  });

  it('prefers the original release year and ignores albums seen twice or with no year', () => {
    const remaster = album('r', 2015, { originalReleaseDate: { year: 1988 } });
    const albums = [remaster, remaster, remaster, album('x', 1985), album('y', 1989), album('z')];
    assert.deepEqual(decadeMixes(albums).map((m) => m.key), ['decade-1980']);
  });

  it('asks for random songs of the decade', async () => {
    data.reset();
    const [mix] = decadeMixes([album('a', 1991), album('b', 1995), album('c', 1999)]);
    await mix.load();
    assert.deepEqual(data.calls[0].args, [50, undefined, { fromYear: 1990, toYear: 1999 }]);
  });
});

describe('genreMixes', () => {
  const genres: Genre[] = [
    { value: 'Rock', songCount: 300 },
    { value: 'Jazz', songCount: 900 },
    { value: 'Folk' },
    { value: 'Pop', songCount: 100 },
    { value: 'Soul', songCount: 200 },
  ];

  it('keeps the biggest genres, biggest first', () => {
    assert.deepEqual(topGenres(genres).map((g) => g.value), ['Jazz', 'Rock', 'Soul', 'Pop']);
    assert.equal(topGenres(genres).length, MAX_GENRE_MIXES);
  });

  it('makes a radio per genre with whatever covers are known', () => {
    const mixes = genreMixes(genres, (g) => (g === 'Jazz' ? [album('j', 1960, { coverArt: 'cj' })] : undefined));
    assert.equal(mixes[0].key, 'genre-Jazz');
    assert.deepEqual(mixes[0].covers, ['cj']);
    assert.deepEqual(mixes[1].covers, []);
  });
});

describe('allMixes', () => {
  it('lines the shelf up in order and leaves out the cards there is nothing for', () => {
    const mixes = allMixes({
      entries: [play(13, song({ id: 's' }))],
      times: {},
      hours: HOURS,
      now: NOON,
      albums: [],
      genres: [{ value: 'Jazz', songCount: 1 }],
      artOf: () => undefined,
    });
    assert.deepEqual(mixes.map((m) => m.key), ['slot-afternoon', 'genre-Jazz']);
  });
});
