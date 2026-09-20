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
  settled,
} from '@/lib/playbackRetry';

/** A failure, with the reload it asks for carried through to its end. */
function fail(state: ReturnType<typeof freshRetries>, at: number, track = 's1') {
  const out = onFailure(state, track, at);
  return { act: out.act, state: out.act === 'retry' ? settled(out.state, track) : out.state };
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
