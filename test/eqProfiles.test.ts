/**
 * One equaliser per output: which output a setting belongs to, which setting
 * is heard, and where a change is written.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { activeEqSetting, eqOutputKey, type EqSetting, storeEqSetting } from '@/lib/eqProfiles';

const flat: EqSetting = { enabled: false, levels: [0, 0], preamp: 0 };
const bass: EqSetting = { enabled: true, levels: [600, 0], preamp: -600 };
const vocal: EqSetting = { enabled: true, levels: [-200, 300], preamp: -300 };

describe('eqOutputKey', () => {
  it('tells Bluetooth devices apart by name', () => {
    assert.deepEqual(
      [eqOutputKey({ kind: 'bluetooth', name: 'Cardo PACKTALK ' }), eqOutputKey({ kind: 'bluetooth', name: 'Car' })],
      ['bluetooth:Cardo PACKTALK', 'bluetooth:Car'],
    );
  });

  it('keys the other outputs by kind', () => {
    assert.deepEqual(
      [eqOutputKey({ kind: 'speaker', name: 'Pixel 8' }), eqOutputKey({ kind: 'wired', name: 'Pixel 8' })],
      ['speaker', 'wired'],
    );
  });

  it('has no key without an output', () => {
    assert.deepEqual([eqOutputKey(null), eqOutputKey({ kind: '', name: '' })], [null, null]);
  });
});

describe('activeEqSetting', () => {
  const profiles = { speaker: bass, 'bluetooth:Car': vocal };

  it('is the single setting with the option off', () => {
    assert.equal(activeEqSetting(false, 'speaker', flat, profiles), flat);
  });

  it("is the output's own with the option on", () => {
    assert.equal(activeEqSetting(true, 'bluetooth:Car', flat, profiles), vocal);
  });

  it('starts a new output from the single setting', () => {
    assert.equal(activeEqSetting(true, 'wired', flat, profiles), flat);
  });

  it('keeps the single setting when no output is known', () => {
    assert.equal(activeEqSetting(true, null, flat, profiles), flat);
  });
});

describe('storeEqSetting', () => {
  it("writes to the output's profile with the option on", () => {
    assert.deepEqual(storeEqSetting(true, 'wired', flat, { speaker: bass }, vocal), {
      single: flat,
      profiles: { speaker: bass, wired: vocal },
    });
  });

  it('writes to the single setting with the option off', () => {
    assert.deepEqual(storeEqSetting(false, 'wired', flat, { speaker: bass }, vocal), {
      single: vocal,
      profiles: { speaker: bass },
    });
  });
});
