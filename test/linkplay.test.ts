/**
 * LinkPlay speakers: what their answers mean and what they are told.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanHost, cmd, deviceFrom, fromHex, slavesFrom, statusFrom } from '@/lib/linkplay';

describe('deviceFrom', () => {
  it('reads a speaker out of its status, and whether it follows another', () => {
    const device = deviceFrom('10.0.0.5', {
      DeviceName: 'WiiMA-RDC',
      project: 'WiiM_AMP',
      uuid: 'FF98',
      group: '0',
    });
    assert.deepEqual(device, { host: '10.0.0.5', name: 'WiiMA-RDC', model: 'WiiM_AMP', uuid: 'FF98', slave: false });
    assert.equal(deviceFrom('10.0.0.5', { DeviceName: 'Kitchen', group: '1' })?.slave, true);
    assert.equal(deviceFrom('10.0.0.5', { DeviceName: 'Kitchen', master_uuid: 'AB' })?.slave, true);
  });

  it('is nothing for an answer that is not a speaker', () => {
    assert.equal(deviceFrom('10.0.0.5', 'OK'), null);
    assert.equal(deviceFrom('10.0.0.5', { firmware: 'x' }), null);
  });
});

describe('statusFrom', () => {
  it('turns milliseconds and percent into seconds and a level', () => {
    const status = statusFrom({ status: 'play', curpos: '12500', totlen: '200000', vol: '54', mute: '0' });
    assert.deepEqual(status, { state: 'play', positionSec: 12.5, durationSec: 200, volume: 0.54, muted: false });
  });

  it('knows the states it does not know', () => {
    assert.equal(statusFrom({ status: 'whatever' })?.state, 'none');
    assert.equal(statusFrom(null), null);
  });
});

describe('slavesFrom', () => {
  it('lists the followers by address, named when they are', () => {
    assert.deepEqual(
      slavesFrom({ slaves: 2, slave_list: [{ name: 'Kitchen', ip: '10.0.0.6' }, { ip: '10.0.0.7' }, { name: 'x' }] }),
      [
        { name: 'Kitchen', host: '10.0.0.6' },
        { name: '10.0.0.7', host: '10.0.0.7' },
      ],
    );
    assert.deepEqual(slavesFrom({ slaves: 0 }), []);
  });
});

describe('commands', () => {
  it('say what the speaker expects', () => {
    assert.equal(cmd.play('http://s/rest/stream?id=1&u=a'), 'setPlayerCmd:play:http://s/rest/stream?id=1&u=a');
    assert.equal(cmd.seek(12.6), 'setPlayerCmd:seek:13');
    assert.equal(cmd.volume(0.545), 'setPlayerCmd:vol:55');
    assert.equal(cmd.volume(2), 'setPlayerCmd:vol:100');
    assert.equal(cmd.join('10.0.0.5'), 'ConnectMasterAp:JoinGroupMaster:eth10.0.0.5:wifi0.0.0.0');
    assert.equal(cmd.kick('10.0.0.6'), 'multiroom:SlaveKickout:10.0.0.6');
  });
});

describe('text', () => {
  it('decodes the hex some fields come in', () => {
    assert.equal(fromHex('556E6B6E6F776E'), 'Unknown');
    assert.equal(fromHex('Envole-moi'), 'Envole-moi');
  });

  it('keeps only the host of what was typed', () => {
    assert.equal(cleanHost(' https://10.0.0.5:443/httpapi.asp '), '10.0.0.5');
    assert.equal(cleanHost('wiim-rdc.local'), 'wiim-rdc.local');
  });
});
