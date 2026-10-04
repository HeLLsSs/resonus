/**
 * The late night sleep timer offer: when the night is, what night a time
 * belongs to, and when to ask.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isLateNight, type NightSleepFlags, nightKey, shouldSuggestSleep } from '@/lib/nightSleep';

/** Local time, as the phone reads it. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

const ok: NightSleepFlags = {
  now: at(3, 23, 30),
  enabled: true,
  armed: false,
  ride: false,
  jam: false,
  lastNight: null,
};

describe('isLateNight', () => {
  it('starts at 23:00', () => {
    assert.equal(isLateNight(at(3, 23)), true);
  });
  it('is not night yet at 22:59', () => {
    assert.equal(isLateNight(at(3, 22, 59)), false);
  });
  it('is still night at 04:59', () => {
    assert.equal(isLateNight(at(4, 4, 59)), true);
  });
  it('is over at 05:00', () => {
    assert.equal(isLateNight(at(4, 5)), false);
  });
});

describe('nightKey', () => {
  it('names the night by its evening', () => {
    assert.equal(nightKey(at(3, 23)), '2026-10-03');
  });
  it('gives the small hours to the day before', () => {
    assert.equal(nightKey(at(4, 2)), '2026-10-03');
  });
  it('crosses the start of a month', () => {
    assert.equal(nightKey(at(1, 1)), '2026-09-30');
  });
});

describe('shouldSuggestSleep', () => {
  it('asks late at night with nothing else going on', () => {
    assert.equal(shouldSuggestSleep(ok), true);
  });
  it('leaves the evening alone', () => {
    assert.equal(shouldSuggestSleep({ ...ok, now: at(3, 21) }), false);
  });
  it('does not ask when switched off', () => {
    assert.equal(shouldSuggestSleep({ ...ok, enabled: false }), false);
  });
  it('does not ask with a sleep timer set', () => {
    assert.equal(shouldSuggestSleep({ ...ok, armed: true }), false);
  });
  it('does not ask on the motorbike', () => {
    assert.equal(shouldSuggestSleep({ ...ok, ride: true }), false);
  });
  it('does not ask in a Jam', () => {
    assert.equal(shouldSuggestSleep({ ...ok, jam: true }), false);
  });
  it('asks once a night, past midnight included', () => {
    assert.equal(shouldSuggestSleep({ ...ok, now: at(4, 1), lastNight: '2026-10-03' }), false);
  });
  it('asks again the next night', () => {
    assert.equal(shouldSuggestSleep({ ...ok, now: at(4, 23), lastNight: '2026-10-03' }), true);
  });
});
