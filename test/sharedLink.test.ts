/** Shared links: what the YouTube, YouTube Music, SoundCloud, Spotify, Deezer and Apple Music apps send. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSharedLink, resolvedCountsLabel } from '@/lib/sharedLink';
import { tg } from '@/i18n';

const ID = 'dQw4w9WgXcQ';
const LIST = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';
const SPOTIFY_ID = '4cOdK2wGLETKBW3PvgPWqT';

describe('parseSharedLink', () => {
  describe('YouTube tracks', () => {
    it('reads a youtu.be link and drops the tracking', () => {
      assert.deepEqual(parseSharedLink(`https://youtu.be/${ID}?si=abc123`), {
        source: 'youtube',
        kind: 'track',
        videoId: ID,
        url: `https://www.youtube.com/watch?v=${ID}`,
      });
    });

    it('reads watch?v= among other parameters', () => {
      assert.equal(
        parseSharedLink(`https://www.youtube.com/watch?feature=share&v=${ID}&t=42s`)?.url,
        `https://www.youtube.com/watch?v=${ID}`,
      );
    });

    it('keeps a YouTube Music track on YouTube Music', () => {
      assert.equal(
        parseSharedLink(`https://music.youtube.com/watch?v=${ID}&si=xyz`)?.url,
        `https://music.youtube.com/watch?v=${ID}`,
      );
    });

    it('takes a track shared out of a playlist as the track', () => {
      assert.equal(parseSharedLink(`https://m.youtube.com/watch?v=${ID}&list=${LIST}`)?.kind, 'track');
    });

    it('reads a short', () => {
      assert.equal(parseSharedLink(`https://youtube.com/shorts/${ID}?si=1`)?.kind, 'track');
    });

    it('finds the link inside a sentence', () => {
      assert.equal(parseSharedLink(`Never Gonna Give You Up\nhttps://youtu.be/${ID}.`)?.kind, 'track');
    });

    it('refuses an id of the wrong length', () => {
      assert.equal(parseSharedLink('https://youtu.be/short'), null);
    });
  });

  describe('YouTube playlists', () => {
    it('reads /playlist?list=', () => {
      assert.deepEqual(parseSharedLink(`https://music.youtube.com/playlist?list=${LIST}&si=q`), {
        source: 'youtube',
        kind: 'playlist',
        listId: LIST,
        url: `https://music.youtube.com/playlist?list=${LIST}`,
      });
    });

    it('leaves out the mixes YouTube makes up', () => {
      assert.equal(parseSharedLink(`https://www.youtube.com/playlist?list=RD${ID}`), null);
    });

    it('leaves out a channel', () => {
      assert.equal(parseSharedLink('https://www.youtube.com/@somebody'), null);
    });
  });

  describe('SoundCloud', () => {
    it('reads a track and drops the query', () => {
      assert.deepEqual(parseSharedLink('Listen to X on #SoundCloud https://soundcloud.com/artist/track-name?utm_source=x'), {
        source: 'soundcloud',
        kind: 'track',
        url: 'https://soundcloud.com/artist/track-name',
      });
    });

    it('reads a set as a playlist', () => {
      assert.equal(parseSharedLink('https://m.soundcloud.com/artist/sets/summer')?.kind, 'playlist');
    });

    it('takes a short link as a link to follow', () => {
      assert.equal(parseSharedLink('https://on.soundcloud.com/AbCdEf')?.kind, 'link');
    });

    it('leaves out a profile and its tabs', () => {
      assert.deepEqual(
        ['https://soundcloud.com/artist', 'https://soundcloud.com/artist/likes', 'https://soundcloud.com/discover/sets'].map(
          parseSharedLink,
        ),
        [null, null, null],
      );
    });
  });

  describe('Spotify', () => {
    it('reads a track and drops the tracking', () => {
      assert.deepEqual(parseSharedLink(`https://open.spotify.com/track/${SPOTIFY_ID}?si=abc&context=spotify%3Aalbum%3A1`), {
        source: 'spotify',
        kind: 'track',
        url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
      });
    });

    it('drops the language prefix the web player adds', () => {
      assert.equal(
        parseSharedLink(`https://open.spotify.com/intl-fr/album/${SPOTIFY_ID}?si=x`)?.url,
        `https://open.spotify.com/album/${SPOTIFY_ID}`,
      );
    });

    it('reads a playlist out of a sentence', () => {
      assert.equal(parseSharedLink(`Road trip https://open.spotify.com/playlist/${SPOTIFY_ID}?si=q.`)?.kind, 'playlist');
    });

    it('leaves out an artist, a show and an id of the wrong shape', () => {
      assert.deepEqual(
        [
          `https://open.spotify.com/artist/${SPOTIFY_ID}`,
          `https://open.spotify.com/show/${SPOTIFY_ID}`,
          'https://open.spotify.com/track/1',
        ].map(parseSharedLink),
        [null, null, null],
      );
    });
  });

  describe('Deezer', () => {
    it('reads a track behind the language and drops the query', () => {
      assert.deepEqual(parseSharedLink('https://www.deezer.com/fr/track/3135556?utm_source=deezer&host=x'), {
        source: 'deezer',
        kind: 'track',
        url: 'https://www.deezer.com/track/3135556',
      });
    });

    it('reads an album and a playlist without a language', () => {
      assert.deepEqual(
        ['https://deezer.com/album/302127', 'https://www.deezer.com/en/playlist/1479458365'].map((s) => parseSharedLink(s)?.kind),
        ['album', 'playlist'],
      );
    });

    it('takes a short link as a link to follow, as it is', () => {
      assert.deepEqual(parseSharedLink('https://link.deezer.com/s/30abcDEFgh'), {
        source: 'deezer',
        kind: 'link',
        url: 'https://link.deezer.com/s/30abcDEFgh',
      });
      assert.deepEqual(parseSharedLink('https://spotify.link/AbCdEf123'), {
        source: 'spotify',
        kind: 'link',
        url: 'https://spotify.link/AbCdEf123',
      });
      assert.deepEqual(parseSharedLink('https://deezer.page.link/AbCdEf123'), {
        source: 'deezer',
        kind: 'link',
        url: 'https://deezer.page.link/AbCdEf123',
      });
    });

    it('leaves out an artist, a podcast and an id that is not a number', () => {
      assert.deepEqual(
        ['https://www.deezer.com/fr/artist/27', 'https://www.deezer.com/show/1', 'https://www.deezer.com/track/abc'].map(
          parseSharedLink,
        ),
        [null, null, null],
      );
    });
  });

  describe('Apple Music', () => {
    it('reads a track shared out of its album, keeping only the track id', () => {
      assert.deepEqual(parseSharedLink('https://music.apple.com/fr/album/never-gonna-give-you-up/1558533900?i=1558534271&l=en-GB'), {
        source: 'apple',
        kind: 'track',
        url: 'https://music.apple.com/fr/album/never-gonna-give-you-up/1558533900?i=1558534271',
      });
    });

    it('reads an album and drops the query', () => {
      assert.deepEqual(parseSharedLink('https://music.apple.com/us/album/whenever-you-need-somebody/1558533900?l=fr'), {
        source: 'apple',
        kind: 'album',
        url: 'https://music.apple.com/us/album/whenever-you-need-somebody/1558533900',
      });
    });

    it('reads a playlist', () => {
      assert.deepEqual(parseSharedLink('Road trip https://music.apple.com/gb/playlist/road-trip/pl.u-8aAVZ9oI4BkbE1?ls=1'), {
        source: 'apple',
        kind: 'playlist',
        url: 'https://music.apple.com/gb/playlist/road-trip/pl.u-8aAVZ9oI4BkbE1',
      });
    });

    it('reads a song page as a track', () => {
      assert.equal(parseSharedLink('https://music.apple.com/fr/song/never-gonna-give-you-up/1558534271')?.kind, 'track');
    });

    it('leaves out an artist, a station and a playlist id of the wrong shape', () => {
      assert.deepEqual(
        [
          'https://music.apple.com/fr/artist/rick-astley/669771',
          'https://music.apple.com/fr/station/hits/ra.1',
          'https://music.apple.com/fr/playlist/road-trip/1558533900',
        ].map(parseSharedLink),
        [null, null, null],
      );
    });
  });

  it('answers nothing for text without a link it knows', () => {
    assert.deepEqual(['', 'just words', 'https://example.com/track/1'].map(parseSharedLink), [null, null, null]);
  });
});

describe('resolvedCountsLabel', () => {
  const label = (counts: { found: number; unmatched: number; total: number }) =>
    resolvedCountsLabel(counts, tg, (n) => `${n} songs`);

  it('counts the songs when the proxy went through the whole list', () => {
    assert.equal(label({ found: 12, unmatched: 0, total: 12 }), '12 songs');
  });

  it('adds how many it found nothing for', () => {
    assert.equal(label({ found: 12, unmatched: 3, total: 15 }), '12 songs · 3 not found');
  });

  it('says how many the service listed when the proxy stopped short', () => {
    assert.equal(label({ found: 12, unmatched: 3, total: 40 }), '12 of 40 songs · 3 not found');
  });

  it('leaves out a count of nothing', () => {
    assert.equal(label({ found: 0, unmatched: 2, total: 2 }), '2 not found');
  });
});

describe('resolvedCountsLabel with nothing found', () => {
  it('says so in words rather than in an empty line', () => {
    assert.equal(resolvedCountsLabel({ found: 0, unmatched: 0, total: 0 }, tg, (n) => `${n} songs`), 'No song of that link was found');
  });
});
