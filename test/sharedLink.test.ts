/** Shared links: what the YouTube, YouTube Music and SoundCloud apps send. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSharedLink } from '@/lib/sharedLink';

const ID = 'dQw4w9WgXcQ';
const LIST = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';

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

  it('answers nothing for text without a link it knows', () => {
    assert.deepEqual(['', 'just words', 'https://open.spotify.com/track/1'].map(parseSharedLink), [null, null, null]);
  });
});
