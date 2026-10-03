/**
 * What a track that will not play is allowed to cost: how many goes it gets,
 * how close together, and what stops the answer to a failure from being the
 * cause of the next one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  freshRetries,
  MAX_ATTEMPTS,
  onFailure,
  playingAgain,
  RETRY_DELAY_MS,
  MAX_SKIPS,
  MAX_UNREACHED,
  serverUnreached,
  settled,
  skipping,
  SOUND_HELD_MS,
  soundHeld,
} from '@/lib/playbackRetry';

/** A failure, with the reload it asks for carried through to its end. */
function fail(state: ReturnType<typeof freshRetries>, at: number, track = 's1', unreached = false) {
  const out = onFailure(state, track, at, unreached);
  return { act: out.act, state: out.act === 'retry' ? settled(out.state, track) : out.state };
}

/** A track failing until it is given up on: the attempts, then the verdict. */
function givenUp(state: ReturnType<typeof freshRetries>, at: number, track: string, unreached: boolean) {
  let s = state;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    s = fail(s, at, track, unreached).state;
    at += RETRY_DELAY_MS;
  }
  return { ...onFailure(s, track, at, unreached), at };
}

describe('onFailure', () => {
  it('loads the track again the first time', () => {
    assert.equal(onFailure(freshRetries(), 's1', 1000).act, 'retry');
  });

  it('says nothing while the reload it asked for is still in flight', () => {
    const first = onFailure(freshRetries(), 's1', 1000);
    assert.equal(first.act, 'retry');
    assert.equal(onFailure(first.state, 's1', 1001).act, 'wait');
  });

  it('treats a failure that follows straight on as the same one', () => {
    let s = fail(freshRetries(), 1000).state;
    assert.equal(onFailure(s, 's1', 1000 + RETRY_DELAY_MS - 1).act, 'wait');
  });

  it('gives the track its second go once the wait is over', () => {
    const s = fail(freshRetries(), 1000).state;
    assert.equal(onFailure(s, 's1', 1000 + RETRY_DELAY_MS).act, 'retry');
  });

  it('says it out loud once the attempts are spent', () => {
    let s = freshRetries();
    let at = 1000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      assert.equal(fail(s, at).act, 'retry');
      s = fail(s, at).state;
      at += RETRY_DELAY_MS;
    }
    assert.equal(onFailure(s, 's1', at).act, 'announce');
  });

  it('says it once and then holds its peace, however long it goes on', () => {
    let s = freshRetries();
    let at = 1000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      s = fail(s, at).state;
      at += RETRY_DELAY_MS;
    }
    const spoken = onFailure(s, 's1', at);
    assert.equal(spoken.act, 'announce');
    s = spoken.state;
    // The player goes on reporting the same failure with every status it
    // sends. None of them is worth another word, or another reload.
    for (let i = 0; i < 50; i++) {
      at += RETRY_DELAY_MS * 2;
      const again = onFailure(s, 's1', at);
      assert.equal(again.act, 'wait');
      s = again.state;
    }
  });

  it('counts a different track from the beginning', () => {
    let s = freshRetries();
    let at = 1000;
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      s = fail(s, at).state;
      at += RETRY_DELAY_MS;
    }
    assert.equal(onFailure(s, 's2', at).act, 'retry');
  });
});

describe('playingAgain', () => {
  it('gives a track that was given up on another chance', () => {
    let s = freshRetries();
    let at = 1000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      s = fail(s, at).state;
      at += RETRY_DELAY_MS;
    }
    s = onFailure(s, 's1', at).state;
    assert.equal(onFailure(s, 's1', at + 10_000).act, 'wait');
    assert.equal(onFailure(playingAgain(s), 's1', at + 10_000).act, 'retry');
  });

  it('leaves a state with nothing counted in it alone', () => {
    const s = freshRetries();
    assert.equal(playingAgain(s), s);
  });
});

describe('soundHeld', () => {
  it('does not forgive a track for the second it plays before seeking back to where it failed', () => {
    let s = freshRetries();
    let at = 1000;
    // A track broken at the same place, reloaded and sounding briefly each time.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      s = fail(s, at).state;
      s = soundHeld(s, at + 800, 's1');
      at += RETRY_DELAY_MS;
    }
    assert.equal(fail(s, at).act, 'announce');
  });

  it('forgives a track that has sounded for a while since its reload', () => {
    let s = fail(freshRetries(), 1000).state;
    s = soundHeld(s, 1000 + SOUND_HELD_MS, 's1');
    assert.equal(s.attempts, 0);
  });

  it('leaves a state with nothing counted in it alone', () => {
    const s = freshRetries();
    assert.equal(soundHeld(s, 99_999, 's1'), s);
  });

  it('lets go of a track given up on as soon as another one sounds, keeping the count of skips', () => {
    let s = freshRetries();
    let at = 1000;
    for (let i = 0; i <= MAX_ATTEMPTS; i++) {
      s = fail(s, at).state;
      at += RETRY_DELAY_MS;
    }
    s = skipping(s, at)!;
    s = soundHeld(s, at + 500, 's2');
    assert.deepEqual([s.gaveUp, s.skipped, onFailure(s, 's1', at + 600).act], [false, 1, 'retry']);
  });
});

describe('skipping', () => {
  it('passes over a few bad tracks in a row, then stops', () => {
    let s = freshRetries();
    for (let i = 0; i < MAX_SKIPS; i++) {
      const next = skipping(s, 1000 * (i + 1));
      assert.notEqual(next, null, `skip ${i + 1}`);
      s = next!;
      // The next track's own failures start from nothing, but remember the skips.
      s = onFailure(s, `s${i + 2}`, 1000 * (i + 1)).state;
    }
    assert.equal(skipping(s, 5000), null);
  });

  it('forgets the skips once a track has sounded for a while', () => {
    let s = skipping(freshRetries(), 900)!;
    s = fail(s, 1000, 's2').state;
    s = soundHeld(s, 1000 + SOUND_HELD_MS, 's2');
    assert.equal(s.skipped, 0);
  });

  it('keeps the skips while the next track is only buffering', () => {
    // A track being loaded reports itself as playing before it has sounded,
    // and used to count as sound held since the beginning of time.
    const s = skipping(freshRetries(), 50_000)!;
    assert.equal(soundHeld(s, 50_500, 's2').skipped, 1);
  });
});

describe('serverUnreached', () => {
  it('reads a server error off the status the player reports', () => {
    assert.equal(serverUnreached('Response code: 502'), true);
  });

  it('reads a lost connection', () => {
    assert.equal(serverUnreached('Unable to connect'), true);
  });

  it('leaves a refusal alone', () => {
    assert.equal(serverUnreached('Response code: 404'), false);
  });

  it('lets the status decide over the words around it', () => {
    assert.equal(serverUnreached('Source error: Response code: 404'), false);
    assert.equal(serverUnreached('Source error: Response code: 503'), true);
    assert.equal(serverUnreached('Source error'), true);
  });
});

describe('stop', () => {
  /** Online tracks given up on in a row, each one skipped over to the next. */
  function outage(state: ReturnType<typeof freshRetries>, at: number, count: number) {
    let s = state;
    const acts: string[] = [];
    for (let i = 0; i < count; i++) {
      const out = givenUp(s, at, `yt_${i}`, true);
      acts.push(out.act);
      s = skipping(out.state, out.at) ?? out.state;
      at = out.at + 100;
    }
    return { state: s, acts, at };
  }

  it('stops the queue once a few online tracks in a row have answered a server error', () => {
    const { acts } = outage(freshRetries(), 1000, MAX_UNREACHED);
    assert.deepEqual(acts, ['announce', 'announce', 'stop']);
  });

  it('does not count online tracks failing for reasons of their own', () => {
    let s = freshRetries();
    let at = 1000;
    for (let i = 0; i < MAX_UNREACHED + 1; i++) {
      const out = givenUp(s, at, `yt_${i}`, false);
      assert.equal(out.act, 'announce');
      s = skipping(out.state, out.at) ?? out.state;
      at = out.at + 100;
    }
  });

  it('starts the count over at a track of the library\'s own', () => {
    const first = outage(freshRetries(), 1000, MAX_UNREACHED - 1);
    const library = givenUp(first.state, first.at, 'lib', false);
    const s = skipping(library.state, library.at) ?? library.state;
    assert.equal(givenUp(s, library.at + 100, 'yt_9', true).act, 'announce');
  });

  it('starts the count over at a press of play', () => {
    const stopped = outage(freshRetries(), 1000, MAX_UNREACHED);
    const s = playingAgain(stopped.state);
    assert.equal(s.unreached, 0);
  });

  it('starts the count over at the next track asked for by hand', () => {
    // Nothing moves the queue on from a stop but a hand, and that hand gets
    // a fresh count: the track fails on its own terms, with its own goes.
    const stopped = outage(freshRetries(), 1000, MAX_UNREACHED);
    assert.equal(givenUp(stopped.state, stopped.at, 'yt_9', true).act, 'announce');
  });
});

describe('settled', () => {
  it('opens the way for the next failure of the track it was for', () => {
    const busy = onFailure(freshRetries(), 's1', 1000).state;
    const done = settled(busy, 's1');
    assert.equal(onFailure(done, 's1', 1000 + RETRY_DELAY_MS).act, 'retry');
  });

  it("leaves another track's reload alone", () => {
    // Track A fails and is being reloaded; the user skips to B, which fails
    // too and starts its own. A's reload landing must not clear B's flag.
    const a = onFailure(freshRetries(), 'a', 1000).state;
    const b = onFailure(a, 'b', 2000).state;
    assert.equal(b.busy, true);
    assert.equal(settled(b, 'a').busy, true);
    assert.equal(onFailure(settled(b, 'a'), 'b', 2001).act, 'wait');
  });
});
