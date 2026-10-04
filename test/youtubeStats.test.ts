/** The stats screen's YouTube section: what came through the proxy. */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { filedSince, youtubeListening, type SongPlayRow } from '@/lib/youtubeStats';

import { subsonic } from './stubs/api-subsonic';

function row(songId: string, artist: string, plays: number, artistId: string | null = null): SongPlayRow {
  return { songId, artist, artistId, plays };
}

describe('youtubeListening', () => {
  beforeEach(() => {
    subsonic.proxyActive = true;
  });

  it('counts the listens of online tracks', () => {
    const rows = [row('yt_a', 'A', 3), row('sc_b', 'B', 1), row('lib', 'C', 4)];
    assert.equal(youtubeListening(rows, new Set()).plays, 4);
  });

  it('counts the listens of songs the proxy filed', () => {
    const rows = [row('filed', 'A', 2), row('lib', 'C', 2)];
    assert.equal(youtubeListening(rows, new Set(['filed'])).plays, 2);
  });

  it('gives their share of every listen', () => {
    const rows = [row('yt_a', 'A', 1), row('lib', 'C', 3)];
    assert.equal(youtubeListening(rows, new Set()).share, 0.25);
  });

  it('gives no share when nothing was played', () => {
    assert.deepEqual(youtubeListening([], new Set()), { plays: 0, share: 0, discovered: [] });
  });

  it('counts nothing as online with the proxy switched off', () => {
    subsonic.proxyActive = false;
    assert.equal(youtubeListening([row('yt_a', 'A', 3)], new Set()).plays, 0);
  });

  it('lists the artists heard only through the proxy, most played first', () => {
    const rows = [
      row('yt_a1', 'A', 1),
      row('filed', 'B', 3),
      row('yt_b2', 'B', 1),
      row('yt_c', 'C', 5),
      row('lib_c', 'C', 1),
    ];
    assert.deepEqual(youtubeListening(rows, new Set(['filed'])).discovered, [
      { id: undefined, name: 'B', plays: 4 },
      { id: undefined, name: 'A', plays: 1 },
    ]);
  });

  it('groups an artist by id across the online and filed copies', () => {
    const rows = [row('yt_a', 'Aa', 1, 'ar1'), row('filed', 'Aa', 2, 'ar1')];
    assert.deepEqual(youtubeListening(rows, new Set(['filed'])).discovered, [
      { id: 'ar1', name: 'Aa', plays: 3 },
    ]);
  });

  it('keeps five artists', () => {
    const rows = ['A', 'B', 'C', 'D', 'E', 'F'].map((a, i) => row(`yt_${a}`, a, 10 - i));
    assert.deepEqual(
      youtubeListening(rows, new Set()).discovered.map((a) => a.name),
      ['A', 'B', 'C', 'D', 'E'],
    );
  });
});

describe('filedSince', () => {
  const songs = [
    { id: 'old', created: '2026-01-01T10:00:00Z' },
    { id: 'new', created: '2026-09-30T10:00:00Z' },
    { id: 'undated' },
  ];

  it('keeps the songs filed since the start of the period', () => {
    assert.deepEqual(
      filedSince(songs, Date.parse('2026-09-01T00:00:00Z')).map((s) => s.id),
      ['new'],
    );
  });

  it('keeps them all for all time', () => {
    assert.equal(filedSince(songs, null).length, 3);
  });
});
