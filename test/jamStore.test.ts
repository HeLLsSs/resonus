/**
 * The Jam's one volume and who plays it: the phone that opened the session
 * plays, a phone that joined is silent, and a volume moved on any of them
 * reaches the session once, not on every step, and not when it is only the
 * session's own volume landing.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { JamSession } from '@/lib/jam';
import { jamReportVolume, joinJamByCode, leaveJam, setJamVolumeDevice, startJam, useJam } from '@/store/jam';

import { http } from './stubs/expo-fetch';
import { serverProfile, useAuthStore } from './stubs/store-auth';

const T0 = 1_700_000_000_000;

function session(over: Partial<JamSession> = {}): JamSession {
  return {
    code: 'ABC234',
    version: 1,
    hostId: 'h',
    members: [{ id: 'h', name: 'Gaëtan' }],
    queue: [],
    index: 0,
    playing: false,
    anchorAt: T0,
    anchorPos: 0,
    positionMs: 0,
    volume: 0.5,
    ...over,
  };
}

/** The proxy: a session for whoever opens or joins, a volume command kept, and no news on the watch. */
function proxy(me: string, over: Partial<JamSession> = {}) {
  let held = session(over);
  http.answer = (url, call) => {
    if (url.includes('/jam/state')) return { status: -1 };
    if (url.includes('/jam/time')) return { status: 200, body: { now: T0 } };
    const command = call.body as { type?: string; level?: number } | undefined;
    if (url.endsWith('/jam/command') && command?.type === 'volume' && held.volume !== undefined) {
      held = { ...held, version: held.version + 1, volume: command.level };
    }
    return { status: 200, body: { now: T0, me, token: 'tk', session: held } };
  };
}

const commands = () => http.calls.filter((c) => c.url.endsWith('/jam/command')).map((c) => c.body);
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('who plays, and how loud', () => {
  const applied: number[] = [];
  /** A phone at 30%, in fifteenths. */
  const phone = { apply: (level: number) => applied.push(level), read: () => 0.3, step: () => 1 / 15 };

  beforeEach(() => {
    http.reset();
    applied.length = 0;
    setJamVolumeDevice(phone);
    useAuthStore.setState({ auth: serverProfile(), hydrating: false });
  });

  afterEach(async () => {
    await leaveJam();
  });

  it('plays on the phone that opened the session, which opens at the phone’s own level', async () => {
    proxy('h', { volume: 0.3 });
    await startJam();
    const opened = commands().find((c) => (c as { type: string }).type === 'volume');
    assert.deepEqual([useJam.getState().listenHere, opened, applied], [true, { type: 'volume', level: 0.3 }, []]);
  });

  it('takes the session’s volume on joining', async () => {
    proxy('g');
    await joinJamByCode('ABC234');
    assert.deepEqual(applied, [0.5]);
  });

  it('leaves the volume alone with a proxy that has none', async () => {
    proxy('g', { volume: undefined });
    await joinJamByCode('ABC234');
    jamReportVolume(0.9);
    await settle(50);
    assert.deepEqual([applied, commands()], [[], []]);
  });

  it('does not report the grid the session’s level landed on, but reports the key press after it', async () => {
    proxy('g');
    await joinJamByCode('ABC234');
    http.reset();
    proxy('g', { volume: 0.53 });
    // 0.5 on a phone of fifteen steps is 8/15: the echo, then one press up.
    jamReportVolume(8 / 15);
    jamReportVolume(9 / 15);
    await settle(50);
    assert.deepEqual(commands(), [{ type: 'volume', level: 0.6 }]);
  });

  it('is silent on a phone that joined', async () => {
    proxy('g', { members: [{ id: 'h', name: 'Gaëtan' }, { id: 'g', name: 'Léa' }] });
    await joinJamByCode('ABC234');
    assert.equal(useJam.getState().listenHere, false);
  });

  it('starts playing when the host leaves and the session falls to it', async () => {
    const two = [{ id: 'h', name: 'Gaëtan' }, { id: 'g', name: 'Léa' }];
    proxy('g', { members: two });
    await joinJamByCode('ABC234');
    // A command answered by a session the host has left.
    proxy('g', { version: 2, hostId: 'g', members: two.slice(1) });
    jamReportVolume(0.9);
    await settle(400);
    assert.equal(useJam.getState().listenHere, true);
  });

  it('gives a phone that only steered its own level back on leaving', async () => {
    proxy('g');
    await joinJamByCode('ABC234');
    await leaveJam();
    assert.deepEqual(applied, [0.5, 0.3]);
  });

  it('sends a slider’s move however small, where a key’s echo of the session is kept', async () => {
    proxy('g');
    await joinJamByCode('ABC234');
    http.reset();
    proxy('g', { volume: 0.5 });
    jamReportVolume(0.53, true);
    jamReportVolume(0.55, false);
    await settle(50);
    assert.deepEqual(commands(), [{ type: 'volume', level: 0.55 }]);
  });

  it('sends the first move at once and the burst behind it as one, last value winning', async () => {
    proxy('g');
    await joinJamByCode('ABC234');
    http.reset();
    proxy('g', { volume: 0.9 });
    jamReportVolume(0.7);
    jamReportVolume(0.8);
    jamReportVolume(0.9);
    assert.deepEqual(commands(), [{ type: 'volume', level: 0.7 }], 'at once');
    await settle(400);
    assert.deepEqual(commands(), [{ type: 'volume', level: 0.7 }, { type: 'volume', level: 0.9 }]);
  });
});
