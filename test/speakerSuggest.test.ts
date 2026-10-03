/**
 * The "Continue at home?" rules: when to ask, and which speaker.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickSpeaker, shouldSuggest, type SuggestFlags } from '@/lib/speakerSuggest';

const ok: SuggestFlags = { enabled: true, onPhone: true, wifi: true, jam: false, ride: false };

describe('shouldSuggest', () => {
  it('asks when the music starts on the phone, on Wi-Fi, with nothing else going on', () => {
    assert.equal(shouldSuggest(ok), true);
  });

  it('stays quiet when switched off', () => {
    assert.equal(shouldSuggest({ ...ok, enabled: false }), false);
  });

  it('stays quiet when the music is already somewhere else', () => {
    assert.equal(shouldSuggest({ ...ok, onPhone: false }), false);
  });

  it('stays quiet off Wi-Fi', () => {
    assert.equal(shouldSuggest({ ...ok, wifi: false }), false);
  });

  it('stays quiet in a Jam', () => {
    assert.equal(shouldSuggest({ ...ok, jam: true }), false);
  });

  it('stays quiet in ride mode', () => {
    assert.equal(shouldSuggest({ ...ok, ride: true }), false);
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
