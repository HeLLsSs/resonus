/**
 * Whether Home offers to continue what another device stopped on.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESUME_WINDOW_MS, resumeOffer, type ResumeInput, STALE_QUEUE_MS } from '@/lib/resumeElsewhere';

const NOW = 1_800_000_000_000;

const saved = {
  entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  current: 'b',
  position: 83_000,
  changed: NOW - 60_000,
  changedBy: 'Resonuls',
};
const stop = { name: 'browser', at: NOW - 55_000, mine: false, stopped: true };

const base: ResumeInput = {
  now: NOW,
  playing: false,
  saved,
  stop,
  ourClient: 'Resonuls',
  here: { id: 'a', positionMs: 0 },
};

describe('resumeOffer', () => {
  it('offers the song and second another device stopped on', () => {
    assert.deepEqual(resumeOffer(base), { index: 1, positionMs: 83_000, at: NOW - 55_000, device: 'browser' });
  });
  it('offers nothing while something plays here', () => {
    assert.equal(resumeOffer({ ...base, playing: true }), null);
  });
  it('offers nothing when this device stopped last', () => {
    assert.equal(resumeOffer({ ...base, stop: { ...stop, mine: true } }), null);
  });
  it('leaves a device still playing to the other card', () => {
    assert.equal(resumeOffer({ ...base, stop: { ...stop, stopped: false } }), null);
  });
  it('offers nothing after twelve hours', () => {
    assert.equal(resumeOffer({ ...base, now: stop.at + RESUME_WINDOW_MS + 1 }), null);
  });
  it('offers nothing when the saved queue predates the stop', () => {
    assert.equal(resumeOffer({ ...base, saved: { ...saved, changed: stop.at - STALE_QUEUE_MS - 1 } }), null);
  });
  it('offers nothing when this device is already at that spot', () => {
    assert.equal(resumeOffer({ ...base, here: { id: 'b', positionMs: 80_000 } }), null);
  });
  it('offers nothing when the saved song is not in the queue', () => {
    assert.equal(resumeOffer({ ...base, saved: { ...saved, current: 'z' } }), null);
  });
  it('offers nothing without the proxy when the queue is our own', () => {
    assert.equal(resumeOffer({ ...base, stop: null }), null);
  });
  it('names another Subsonic player by its client name without the proxy', () => {
    assert.equal(resumeOffer({ ...base, stop: null, saved: { ...saved, changedBy: 'Feishin' } })?.device, 'Feishin');
  });
});
