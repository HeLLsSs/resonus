/** Smart playlists: each rule operator, all/any, ordering and the limit. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import {
  defaultOp,
  naturalDir,
  OPS_FOR_KIND,
  resolveSmartPlaylist,
  RULE_FIELDS,
  RULE_KIND,
  ruleMatches,
  songMatches,
  type Rule,
  type SmartPlaylist,
} from '@/lib/smartPlaylists';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T12:00:00Z');

function song(overrides: Partial<Song> & { id: string }): Song {
  return { title: `Title ${overrides.id}`, ...overrides };
}

function list(overrides: Partial<SmartPlaylist>): SmartPlaylist {
  return { id: 'l', name: 'L', match: 'all', rules: [], sort: 'title', dir: 'asc', createdAt: 0, ...overrides };
}

const rule = (field: Rule['field'], op: Rule['op'], value = ''): Rule => ({ field, op, value });

describe('ruleMatches', () => {
  describe('numbers', () => {
    const rated = song({ id: 'a', userRating: 4, playCount: 7, year: 1999, duration: 300 });
    const bare = song({ id: 'b' });

    it('compares a rating with gte, lte and eq', () => {
      assert.equal(ruleMatches(rated, rule('rating', 'gte', '4')), true);
      assert.equal(ruleMatches(rated, rule('rating', 'gte', '5')), false);
      assert.equal(ruleMatches(rated, rule('rating', 'lte', '4')), true);
      assert.equal(ruleMatches(rated, rule('rating', 'eq', '3')), false);
    });

    it('treats a missing rating, play count or duration as zero', () => {
      assert.equal(ruleMatches(bare, rule('rating', 'eq', '0')), true);
      assert.equal(ruleMatches(bare, rule('playCount', 'lte', '0')), true);
      assert.equal(ruleMatches(bare, rule('duration', 'gte', '1')), false);
    });

    it('reads an unparseable value as zero', () => {
      assert.equal(ruleMatches(bare, rule('playCount', 'eq', 'lots')), true);
    });

    it('never matches a song with no year, whichever way the rule points', () => {
      assert.equal(ruleMatches(bare, rule('year', 'lte', '2000')), false);
      assert.equal(ruleMatches(bare, rule('year', 'gte', '0')), false);
      assert.equal(ruleMatches(rated, rule('year', 'lte', '2000')), true);
    });

    it('compares a duration in seconds', () => {
      assert.equal(ruleMatches(rated, rule('duration', 'gte', '300')), true);
      assert.equal(ruleMatches(rated, rule('duration', 'lte', '299')), false);
    });
  });

  describe('days', () => {
    const recent = song({ id: 'r', created: new Date(NOW - 3 * DAY).toISOString(), played: new Date(NOW - 1 * DAY).toISOString() });
    const old = song({ id: 'o', created: new Date(NOW - 400 * DAY).toISOString(), played: new Date(NOW - 100 * DAY).toISOString() });
    const never = song({ id: 'n' });

    it('says whether the song was added within the last N days', () => {
      assert.equal(ruleMatches(recent, rule('added', 'within', '7'), NOW), true);
      assert.equal(ruleMatches(old, rule('added', 'within', '7'), NOW), false);
      assert.equal(ruleMatches(old, rule('added', 'notWithin', '7'), NOW), true);
    });

    it('counts never played as "not played within" any span', () => {
      assert.equal(ruleMatches(never, rule('lastPlayed', 'notWithin', '90'), NOW), true);
      assert.equal(ruleMatches(never, rule('lastPlayed', 'within', '90'), NOW), false);
    });

    it('reads a millisecond stamp as well as a date string', () => {
      const stamped = song({ id: 's', addedAt: NOW - 2 * DAY } as Partial<Song> & { id: string });
      assert.equal(ruleMatches(stamped, rule('added', 'within', '3'), NOW), true);
      assert.equal(ruleMatches(stamped, rule('added', 'within', '1'), NOW), false);
    });

    it('takes the exact boundary as within', () => {
      const edge = song({ id: 'e', played: new Date(NOW - 7 * DAY).toISOString() });
      assert.equal(ruleMatches(edge, rule('lastPlayed', 'within', '7'), NOW), true);
    });
  });

  describe('text', () => {
    const jazzy = song({ id: 'j', artist: 'Nina Simone', album: 'Pastel Blues', genre: 'Jazz', genres: [{ name: 'Vocal Jazz' }, { name: 'Soul' }], suffix: 'flac' });

    it('compares the artist, album and title exactly, folding case and accents', () => {
      assert.equal(ruleMatches(jazzy, rule('artist', 'is', 'nina simoné')), true);
      assert.equal(ruleMatches(jazzy, rule('artist', 'isNot', 'Nina Simone')), false);
      assert.equal(ruleMatches(jazzy, rule('album', 'contains', 'blue')), true);
      assert.equal(ruleMatches(jazzy, rule('title', 'notContains', 'zzz')), true);
    });

    it('matches nothing on "contains" with an empty value and everything on "notContains"', () => {
      assert.equal(ruleMatches(jazzy, rule('artist', 'contains', '')), false);
      assert.equal(ruleMatches(jazzy, rule('artist', 'notContains', '')), true);
    });

    it('treats a missing field as empty text', () => {
      const bare = song({ id: 'b' });
      assert.equal(ruleMatches(bare, rule('artist', 'is', '')), true);
      assert.equal(ruleMatches(bare, rule('artist', 'isNot', 'x')), true);
      assert.equal(ruleMatches(bare, rule('album', 'contains', 'x')), false);
    });

    it('looks at every genre of the song, not only the first', () => {
      assert.equal(ruleMatches(jazzy, rule('genre', 'is', 'soul')), true);
      assert.equal(ruleMatches(jazzy, rule('genre', 'isNot', 'soul')), false);
      assert.equal(ruleMatches(jazzy, rule('genre', 'contains', 'vocal')), true);
      assert.equal(ruleMatches(jazzy, rule('genre', 'notContains', 'jazz')), false);
      assert.equal(ruleMatches(jazzy, rule('genre', 'contains', '')), false);
    });

    it('compares the format without a leading dot', () => {
      assert.equal(ruleMatches(jazzy, rule('format', 'is', '.FLAC')), true);
      assert.equal(ruleMatches(jazzy, rule('format', 'isNot', 'mp3')), true);
    });
  });

  describe('starred', () => {
    it('reads the star as a flag, whatever the value says', () => {
      const starred = song({ id: 's', starred: '2026-01-01T00:00:00Z' });
      assert.equal(ruleMatches(starred, rule('starred', 'is')), true);
      assert.equal(ruleMatches(starred, rule('starred', 'isNot')), false);
      assert.equal(ruleMatches(song({ id: 'u' }), rule('starred', 'isNot')), true);
    });
  });
});

describe('songMatches', () => {
  const s = song({ id: 'x', userRating: 5, genre: 'Rock' });

  it('matches everything when there are no rules', () => {
    assert.equal(songMatches(s, list({ rules: [] })), true);
  });

  it('needs every rule under "all"', () => {
    const rules = [rule('rating', 'gte', '5'), rule('genre', 'is', 'jazz')];
    assert.equal(songMatches(s, list({ match: 'all', rules })), false);
  });

  it('needs any one rule under "any"', () => {
    const rules = [rule('rating', 'gte', '5'), rule('genre', 'is', 'jazz')];
    assert.equal(songMatches(s, list({ match: 'any', rules })), true);
  });
});

describe('resolveSmartPlaylist', () => {
  const songs = [
    song({ id: '1', title: 'Beta', artist: 'Zed', year: 2001, playCount: 3, duration: 100 }),
    song({ id: '2', title: 'alpha', artist: 'Amy', year: 1999, playCount: 9, duration: 300 }),
    song({ id: '3', title: 'Gamma', artist: 'Bob', playCount: 3, duration: 200 }),
    song({ id: '4', title: 'Delta', artist: 'Cat', year: 2010, playCount: 0, duration: 50, starred: 'yes' }),
  ];
  const ids = (out: Song[]) => out.map((s) => s.id);

  it('filters, then sorts by title without regard to case', () => {
    const out = resolveSmartPlaylist(songs, list({ rules: [rule('duration', 'gte', '100')], sort: 'title', dir: 'asc' }));
    assert.deepEqual(ids(out), ['2', '1', '3']);
  });

  it('sorts a number descending and keeps library order on ties', () => {
    const out = resolveSmartPlaylist(songs, list({ sort: 'playCount', dir: 'desc' }));
    assert.deepEqual(ids(out), ['2', '1', '3', '4']);
  });

  it('puts songs with no year first when ascending by year', () => {
    const out = resolveSmartPlaylist(songs, list({ sort: 'year', dir: 'asc' }));
    assert.deepEqual(ids(out), ['3', '2', '1', '4']);
  });

  it('cuts to the limit after sorting and ignores a limit of zero', () => {
    const two = resolveSmartPlaylist(songs, list({ sort: 'artist', dir: 'asc', limit: 2 }));
    assert.deepEqual(ids(two), ['2', '3']);
    const all = resolveSmartPlaylist(songs, list({ sort: 'artist', limit: 0 }));
    assert.equal(all.length, 4);
  });

  it('deals a random order over the same set of songs', () => {
    const out = resolveSmartPlaylist(songs, list({ sort: 'random' }));
    assert.deepEqual(ids(out).sort(), ['1', '2', '3', '4']);
  });

  it('does not touch the input', () => {
    const before = ids(songs);
    resolveSmartPlaylist(songs, list({ sort: 'title', dir: 'desc' }));
    assert.deepEqual(ids(songs), before);
  });
});

describe('the rule tables', () => {
  it('starts every field on the first operator of its kind', () => {
    for (const field of RULE_FIELDS) {
      assert.equal(defaultOp(field), OPS_FOR_KIND[RULE_KIND[field]][0], field);
    }
  });

  it('reads counts and dates newest and most first, names forwards', () => {
    assert.equal(naturalDir('added'), 'desc');
    assert.equal(naturalDir('rating'), 'desc');
    assert.equal(naturalDir('title'), 'asc');
    assert.equal(naturalDir('random'), 'asc');
  });
});
