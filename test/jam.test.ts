/**
 * A Jam's arithmetic and its requests: where the track is by the server's
 * clock, how that clock is read, what to do about a player that has drifted,
 * and what goes over the wire to open, join, watch and command a session.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  bestOffset,
  cleanCode,
  createJam,
  driftPlan,
  isCode,
  JamError,
  jamCommand,
  jamPageUrl,
  jamState,
  joinJam,
  NUDGE_RATE,
  positionMs,
  sameQueue,
  splitQueue,
  type JamSession,
} from '@/lib/jam';

import { http } from './stubs/expo-fetch';

const T0 = 1_700_000_000_000;

function session(over: Partial<JamSession> = {}): JamSession {
  return {
    code: 'ABC234',
    version: 1,
    hostId: 'h',
    members: [{ id: 'h', name: 'Gaëtan' }],
    queue: [{ id: 'a', title: 'A', duration: 200, addedBy: 'h' }],
    index: 0,
    playing: true,
    anchorAt: T0,
    anchorPos: 5_000,
    positionMs: 5_000,
    ...over,
  };
}

const auth = {
  serverUrl: 'http://proxy.test',
  username: 'gaetan',
  token: 'tok',
  salt: 'salt',
};

describe('positionMs', () => {
  it('runs with the clock while playing and stands still paused', () => {
    assert.equal(positionMs(session(), T0 + 3_000), 8_000);
    assert.equal(positionMs(session({ playing: false }), T0 + 3_000), 5_000);
  });

  it('never leaves the track', () => {
    assert.equal(positionMs(session(), T0 + 999_000), 200_000);
    assert.equal(positionMs(session({ anchorPos: -50 }), T0), 0);
    assert.equal(positionMs(session({ queue: [] }), T0), 0);
  });
});

describe('bestOffset', () => {
  it('trusts the shortest round trip', () => {
    const offset = bestOffset([
      { sentAt: 1_000, receivedAt: 1_400, serverNow: 51_200 },
      { sentAt: 2_000, receivedAt: 2_100, serverNow: 52_060 },
    ]);
    // 52 060 − (2 000 + 50): the second sample, halfway through its trip.
    assert.equal(offset, 50_010);
    assert.equal(bestOffset([]), null);
  });
});

describe('driftPlan', () => {
  it('jumps a big gap, hurries a small one and leaves the rest alone', () => {
    assert.deepEqual(driftPlan(900), { action: 'seek' });
    assert.deepEqual(driftPlan(300), { action: 'nudge', rate: 1 + NUDGE_RATE });
    assert.deepEqual(driftPlan(-300), { action: 'nudge', rate: 1 - NUDGE_RATE });
    assert.deepEqual(driftPlan(50), { action: 'none' });
  });
});

describe('queues', () => {
  it('splits who added what from the songs themselves', () => {
    const { songs, addedBy } = splitQueue([
      { id: 'a', title: 'A', addedBy: 'h', addedAt: 1 },
      { id: 'b', title: 'B' },
    ]);
    assert.deepEqual(songs, [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]);
    assert.deepEqual(addedBy, ['h', '']);
  });

  it('compares queues by their songs in order', () => {
    assert.ok(sameQueue([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b' }]));
    assert.ok(!sameQueue([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }]));
    assert.ok(!sameQueue([{ id: 'a' }], [{ id: 'a' }, { id: 'a' }]));
  });
});

describe('codes and links', () => {
  it('cleans what people type and knows a code when it sees one', () => {
    assert.equal(cleanCode(' ab2-cd 3 '), 'AB2CD3');
    assert.ok(isCode('AB2CD3'));
    assert.ok(!isCode('AB2CD'));
    assert.ok(!isCode('ABCDE0'));
  });

  it('points a browser at the proxy page with the code filled in', () => {
    assert.equal(jamPageUrl('http://proxy.test', 'AB2CD3'), 'http://proxy.test/jam/AB2CD3');
  });
});

describe('requests', () => {
  beforeEach(() => http.reset());

  const view = (over: Partial<JamSession> = {}) => ({ now: T0, me: 'h', token: 'tk', session: session(over) });

  it('opens a session with the profile’s own credentials, as a form', async () => {
    http.answer = () => ({ status: 200, body: view() });

    const got = await createJam(auth, 'Gaëtan');

    assert.equal(got.token, 'tk');
    const call = http.calls[0];
    assert.equal(call.url, 'http://proxy.test/rest/navifind/jam/create');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(call.rawBody, 'u=gaetan&name=Ga%C3%ABtan&t=tok&s=salt');
  });

  it('sends the password itself for a profile that signs in with one', async () => {
    http.answer = () => ({ status: 200, body: view() });

    await createJam({ ...auth, password: 'pw' }, 'Gaëtan');

    assert.equal(http.calls[0].rawBody, 'u=gaetan&name=Ga%C3%ABtan&p=pw');
  });

  it('joins by code and name, with no credentials at all', async () => {
    http.answer = () => ({ status: 200, body: view() });

    await joinJam(auth, 'AB2CD3', 'Léa');

    const call = http.calls[0];
    assert.equal(call.url, 'http://proxy.test/rest/navifind/jam/join');
    assert.deepEqual(call.body, { code: 'AB2CD3', name: 'Léa' });
    assert.equal(call.headers['X-Jam-Token'], undefined);
  });

  it('watches with the token and the version it already has', async () => {
    http.answer = () => ({ status: 200, body: view({ version: 4 }) });

    const got = await jamState(auth, 'tk', 3);

    assert.equal(got.session.version, 4);
    assert.equal(http.calls[0].url, 'http://proxy.test/rest/navifind/jam/state?since=3');
    assert.equal(http.calls[0].headers['X-Jam-Token'], 'tk');
  });

  it('commands as JSON and gets the session back', async () => {
    http.answer = () => ({ status: 200, body: view({ playing: false }) });

    const got = await jamCommand(auth, 'tk', { type: 'seek', position: 12_000 });

    assert.equal(got.session.playing, false);
    assert.deepEqual(http.calls[0].body, { type: 'seek', position: 12_000 });
  });

  it('tells a session that is over from a refusal and from no answer', async () => {
    http.answer = () => ({ status: 410, body: { error: 'La session est finie.', ended: true } });
    await assert.rejects(jamState(auth, 'tk'), (e: unknown) => e instanceof JamError && e.kind === 'gone');

    http.answer = () => ({ status: 403, body: { error: "Seul l'hôte peut faire ça." } });
    await assert.rejects(
      jamCommand(auth, 'tk', { type: 'end' }),
      (e: unknown) => e instanceof JamError && e.kind === 'refused' && e.message === "Seul l'hôte peut faire ça.",
    );

    http.answer = () => ({ status: -1 });
    await assert.rejects(jamState(auth, 'tk'), (e: unknown) => e instanceof JamError && e.kind === 'network');
  });
});
