/**
 * The home speaker rules: when to offer it, when to move to it and back, and
 * which speaker.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  handoffAction,
  type HandoffFlags,
  isHandoffMode,
  type LeavingFlags,
  pickSpeaker,
  shouldReturnToPhone,
} from '@/lib/speakerSuggest';

const ok: HandoffFlags = {
  mode: 'ask',
  trigger: 'play',
  onPhone: true,
  wifi: true,
  jam: false,
  ride: false,
};

describe('handoffAction', () => {
  it('asks when the music starts on the phone, on Wi-Fi, with nothing else going on', () => {
    assert.equal(handoffAction(ok), 'ask');
  });

  it('switches instead of asking when set to', () => {
    assert.equal(handoffAction({ ...ok, mode: 'auto' }), 'switch');
  });

  it('switches on joining a Wi-Fi with the music going, when set to', () => {
    assert.equal(handoffAction({ ...ok, mode: 'auto', trigger: 'wifi' }), 'switch');
  });

  it('does not ask on joining a Wi-Fi mid-song', () => {
    assert.equal(handoffAction({ ...ok, trigger: 'wifi' }), 'none');
  });

  it('does nothing when switched off', () => {
    assert.equal(handoffAction({ ...ok, mode: 'off' }), 'none');
  });

  for (const mode of ['ask', 'auto'] as const) {
    describe(`in ${mode}`, () => {
      it('does nothing when the music is already somewhere else', () => {
        assert.equal(handoffAction({ ...ok, mode, onPhone: false }), 'none');
      });

      it('does nothing off Wi-Fi', () => {
        assert.equal(handoffAction({ ...ok, mode, wifi: false }), 'none');
      });

      it('does nothing in a Jam', () => {
        assert.equal(handoffAction({ ...ok, mode, jam: true }), 'none');
      });

      it('does nothing in ride mode', () => {
        assert.equal(handoffAction({ ...ok, mode, ride: true }), 'none');
      });
    });
  }
});

describe('shouldReturnToPhone', () => {
  const away: LeavingFlags = { mode: 'auto', onHomeSpeaker: true, playing: true, wifi: false };

  it('brings the music back on leaving the Wi-Fi with it on the home speaker', () => {
    assert.equal(shouldReturnToPhone(away), true);
  });

  it('leaves it be when only asking', () => {
    assert.equal(shouldReturnToPhone({ ...away, mode: 'ask' }), false);
  });

  it('leaves it be when switched off', () => {
    assert.equal(shouldReturnToPhone({ ...away, mode: 'off' }), false);
  });

  it('leaves it be on another output', () => {
    assert.equal(shouldReturnToPhone({ ...away, onHomeSpeaker: false }), false);
  });

  it('leaves it be when paused', () => {
    assert.equal(shouldReturnToPhone({ ...away, playing: false }), false);
  });

  it('leaves it be still on Wi-Fi', () => {
    assert.equal(shouldReturnToPhone({ ...away, wifi: true }), false);
  });
});

describe('isHandoffMode', () => {
  it('takes the three modes', () => {
    assert.deepEqual(['off', 'ask', 'auto'].map(isHandoffMode), [true, true, true]);
  });

  it('refuses anything else, the old switch included', () => {
    assert.deepEqual([true, 'on', undefined].map(isHandoffMode), [false, false, false]);
  });
});

describe('pickSpeaker', () => {
  const known = [
    { host: '10.0.0.5', usedAt: 100 },
    { host: '10.0.0.6', usedAt: 300 },
    { host: '10.0.0.7', usedAt: 200 },
  ];

  it('takes the one played on most recently among those that answered', () => {
    assert.equal(pickSpeaker(known, ['10.0.0.5', '10.0.0.6', '10.0.0.7']), '10.0.0.6');
  });

  it('passes over a speaker that did not answer', () => {
    assert.equal(pickSpeaker(known, ['10.0.0.5', '10.0.0.7']), '10.0.0.7');
  });

  it('is nothing when none answered', () => {
    assert.equal(pickSpeaker(known, []), null);
  });

  it('is nothing for an answer from a speaker never played on', () => {
    assert.equal(pickSpeaker(known, ['10.0.0.9']), null);
  });

  it('keeps the order given between two used at the same moment', () => {
    const tied = [
      { host: 'a', usedAt: 5 },
      { host: 'b', usedAt: 5 },
    ];
    assert.equal(pickSpeaker(tied, ['b', 'a']), 'a');
  });

  describe('with a home speaker', () => {
    it('takes it over one played on more recently', () => {
      assert.equal(pickSpeaker(known, ['10.0.0.5', '10.0.0.6'], '10.0.0.5'), '10.0.0.5');
    });

    it('takes it even when never played on', () => {
      assert.equal(pickSpeaker(known, ['10.0.0.9'], '10.0.0.9'), '10.0.0.9');
    });

    it('is nothing, not another speaker, when it did not answer', () => {
      assert.equal(pickSpeaker(known, ['10.0.0.6', '10.0.0.7'], '10.0.0.5'), null);
    });

    it('falls back to the most recent one when none is chosen', () => {
      assert.equal(pickSpeaker(known, ['10.0.0.5', '10.0.0.6'], ''), '10.0.0.6');
    });
  });
});
