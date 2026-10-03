/**
 * The player's arithmetic on its own: a deal that loses nothing, the walk
 * through the queue under each repeat mode, what a ReplayGain tag is allowed
 * to do, when the sleep fade starts, and what an error keeps of itself.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dealt,
  errorTag,
  fadeProgress,
  GAIN_MAX,
  GAIN_MIN,
  gainFactor,
  isRepeatMode,
  nextQueueIndex,
  remoteFadeVolume,
  SLEEP_FADE_MS,
  sleepFadeSchedule, mixedPool } from '@/lib/playerMath';

describe('dealt', () => {
  it('keeps the same songs, and hands back a new list', () => {
    const list = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = dealt(list);
    assert.deepEqual([out === list, [...out].sort(), list], [false, list, [1, 2, 3, 4, 5, 6, 7, 8]]);
  });

  it('deals an empty list and a single song', () => {
    assert.deepEqual([dealt([]), dealt(['a'])], [[], ['a']]);
  });
});

describe('nextQueueIndex', () => {
  it('walks on, and stops at the end with repeat off', () => {
    assert.deepEqual([nextQueueIndex(3, 0, 'off'), nextQueueIndex(3, 2, 'off')], [1, null]);
  });

  it('wraps round with repeat all, through the current song when it is the only one', () => {
    assert.deepEqual([nextQueueIndex(3, 2, 'all'), nextQueueIndex(1, 0, 'all'), nextQueueIndex(0, 0, 'all')], [0, 0, null]);
  });

  it('leaves repeat one to the caller: a skip walks on like off', () => {
    assert.deepEqual([nextQueueIndex(3, 0, 'one'), nextQueueIndex(3, 2, 'one')], [1, null]);
  });

  it('skips what cannot play, and wraps to the first that can', () => {
    const playable = (i: number) => i !== 1 && i !== 3;
    assert.deepEqual(
      [nextQueueIndex(4, 0, 'off', playable), nextQueueIndex(4, 2, 'off', playable), nextQueueIndex(4, 2, 'all', playable)],
      [2, null, 0],
    );
  });

  it('ends a shuffled queue the same way: the deal is in the queue, not here', () => {
    assert.equal(nextQueueIndex(5, 4, 'off'), null);
  });
});

describe('isRepeatMode', () => {
  it('knows the three modes and nothing else', () => {
    assert.deepEqual(['off', 'all', 'one', 'loop', 1, undefined].map(isRepeatMode), [true, true, true, false, false, false]);
  });
});

describe('gainFactor', () => {
  const tags = { trackGain: -6, albumGain: 3, trackPeak: 0.5, albumPeak: 1.2 };

  it('is 1 with the setting off or no tags', () => {
    assert.deepEqual([gainFactor(tags, 'off', 0), gainFactor(undefined, 'track', 0), gainFactor({}, 'album', 0)], [1, 1, 1]);
  });

  it('turns the track gain and the pre-amp into a factor', () => {
    assert.ok(Math.abs(gainFactor({ trackGain: -6 }, 'track', 0) - 0.501) < 0.001);
    assert.ok(Math.abs(gainFactor({ trackGain: -6 }, 'track', 6) - 1) < 1e-9);
  });

  it('uses the other gain when the mode has none', () => {
    assert.equal(gainFactor({ trackGain: 0 }, 'album', 0), 1);
  });

  it('stays under the peak', () => {
    assert.ok(Math.abs(gainFactor(tags, 'album', 0) - 1 / 1.2) < 1e-9);
  });

  it('clamps a wild tag both ways', () => {
    assert.deepEqual([gainFactor({ trackGain: 60 }, 'track', 0), gainFactor({ trackGain: -60 }, 'track', 0)], [GAIN_MAX, GAIN_MIN]);
  });
});

describe('sleepFadeSchedule', () => {
  it('ends the fade at expiry', () => {
    assert.deepEqual(sleepFadeSchedule(10 * 60_000), { fadeMs: SLEEP_FADE_MS, wait: 10 * 60_000 - SLEEP_FADE_MS });
  });

  it('fades the whole of a timer shorter than the fade, from now', () => {
    assert.deepEqual(sleepFadeSchedule(5_000), { fadeMs: 5_000, wait: 0 });
  });
});

describe('fadeProgress', () => {
  it('runs from 0 to 1 and no further either way', () => {
    assert.deepEqual([fadeProgress(100, 50, 90), fadeProgress(100, 50, 125), fadeProgress(100, 50, 200)], [0, 0.5, 1]);
  });
});

describe('errorTag', () => {
  it('takes out addresses and paths, and keeps the first eighty characters', () => {
    assert.deepEqual(
      [
        errorTag('Cannot load https://user:pw@music.example.com/rest/stream?id=1   (404)'),
        errorTag('open failed: /data/user/0/app/files/downloads/abc.mp3'),
        errorTag('x'.repeat(100)).length,
      ],
      ['Cannot load url (404)', 'open failed: path', 81],
    );
  });
});

describe('mixedPool', () => {
  const song = (id: string) => ({ id });

  it('deals both sides together, each song once, no more than asked', () => {
    const pool = mixedPool([song('a'), song('b'), song('c')], [song('c'), song('yt_1'), song('yt_2')], 4);
    assert.equal(pool.length, 4);
    assert.equal(new Set(pool.map((s) => s.id)).size, 4);
    for (const s of pool) assert.ok(['a', 'b', 'c', 'yt_1', 'yt_2'].includes(s.id));
  });

  it('is the library alone when YouTube has nothing', () => {
    const pool = mixedPool([song('a'), song('b')], [], 10);
    assert.deepEqual(
      pool.map((s) => s.id).sort(),
      ['a', 'b'],
    );
  });
});

describe('remoteFadeVolume', () => {
  it('starts at the speaker volume and ends silent', () => {
    assert.deepEqual([remoteFadeVolume(0.6, 0), remoteFadeVolume(0.6, 0.5), remoteFadeVolume(0.6, 1)], [0.6, 0.3, 0]);
  });

  it('lands on whole percent and stays within bounds', () => {
    assert.deepEqual([remoteFadeVolume(0.333, 0.1), remoteFadeVolume(1.4, -1), remoteFadeVolume(0.5, 2)], [0.3, 1, 0]);
  });
});
