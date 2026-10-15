/**
 * Kodi's JSON-RPC: how the address typed in is read, what one poll says,
 * what a track is handed as, which tracks Kodi holds after the current one,
 * and the requests the client makes.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  describeKodi,
  fileFor,
  KodiError,
  kodiPlay,
  kodiSeek,
  kodiTrimAfter,
  normalizeKodiUrl,
  rpcBatch,
  secondsOf,
  stateFrom,
  tailIndices,
  timeOf,
} from '@/lib/kodi';

import { http } from './stubs/expo-fetch';

const KODI = { url: 'http://tv:8080', user: 'kodi', password: 'pässword' };

/** Kodi answering each call of a batch with what `results` gives for its method. */
function kodiAnswers(results: Record<string, unknown>) {
  http.answer = (_url, call) => ({
    status: 200,
    body: (call.body as { id: number; method: string }[]).map(({ id, method }) =>
      method in results ? { id, jsonrpc: '2.0', result: results[method] } : { id, jsonrpc: '2.0', error: { code: -32100, message: 'Failed' } },
    ),
  });
}

function methods(): string[] {
  return http.calls.flatMap((c) => (c.body as { method: string }[]).map((b) => b.method));
}

beforeEach(() => http.reset());

describe('normalizeKodiUrl', () => {
  it('adds the scheme and the port Kodi comes with', () => {
    assert.equal(normalizeKodiUrl('192.168.1.20'), 'http://192.168.1.20:8080');
  });

  it('keeps a port that was given', () => {
    assert.equal(normalizeKodiUrl('http://kodi.local:8081/'), 'http://kodi.local:8081');
  });

  it('drops the path to the API, copied from the documentation', () => {
    assert.equal(normalizeKodiUrl('tv:8080/jsonrpc'), 'http://tv:8080');
  });

  it('gives an IPv6 address its port after the bracket', () => {
    assert.equal(normalizeKodiUrl('[fe80::1]'), 'http://[fe80::1]:8080');
  });
});

describe('times', () => {
  it('reads Kodi time as seconds', () => {
    assert.equal(secondsOf({ hours: 1, minutes: 2, seconds: 3, milliseconds: 500 }), 3723.5);
  });

  it('writes seconds as Kodi time', () => {
    assert.deepEqual(timeOf(3723.5), { hours: 1, minutes: 2, seconds: 3, milliseconds: 500 });
  });
});

describe('stateFrom', () => {
  const playing: { result: unknown }[] = [
    { result: [{ playerid: 0, type: 'audio' }] },
    { result: { speed: 1, position: 2, time: { minutes: 1 }, totaltime: { minutes: 3 } } },
    { result: { item: { file: 'http://music/stream?id=1' } } },
    { result: { volume: 40 } },
  ];

  it('reads where the music player is', () => {
    assert.deepEqual(stateFrom(playing), {
      active: true,
      playing: true,
      position: 2,
      positionSec: 60,
      durationSec: 180,
      file: 'http://music/stream?id=1',
      volume: 0.4,
    });
  });

  it('reads a paused player as open and not playing', () => {
    const paused = [...playing];
    paused[1] = { result: { speed: 0, position: 2, time: {}, totaltime: {} } };
    assert.deepEqual([stateFrom(paused).active, stateFrom(paused).playing], [true, false]);
  });

  it('reads a video playing as nothing of the music player', () => {
    const video = [...playing];
    video[0] = { result: [{ playerid: 1, type: 'video' }] };
    assert.equal(stateFrom(video).active, false);
  });
});

describe('fileFor', () => {
  const track = { url: 'http://music/rest/stream.view?id=1&t=x', title: 'Faded', artist: 'Alan Walker', durationSec: 212.4 };

  it('goes through the add-on, with what to show', () => {
    const file = new URL(fileFor(track, true).replace('plugin://', 'http://'));
    assert.deepEqual(
      [file.host, file.searchParams.get('action'), file.searchParams.get('url'), file.searchParams.get('title'), file.searchParams.get('duration')],
      ['plugin.audio.resonuls', 'stream', track.url, 'Faded', '212'],
    );
  });

  it('is the address itself without the add-on', () => {
    assert.equal(fileFor(track, false), track.url);
  });
});

describe('tailIndices', () => {
  const queue = Array.from({ length: 14 }, (_, i) => i);

  it('holds the next ten', () => {
    assert.deepEqual(tailIndices({ queue, index: 0, repeat: 'off' }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('stops at the end of the queue', () => {
    assert.deepEqual(tailIndices({ queue, index: 12, repeat: 'off' }), [13]);
  });

  it('goes round with repeat all, short of the current one', () => {
    assert.deepEqual(tailIndices({ queue: [0, 1, 2], index: 1, repeat: 'all' }), [2, 0]);
  });

  it('holds nothing when the app must hear the track end', () => {
    assert.deepEqual(
      [tailIndices({ queue, index: 0, repeat: 'one' }), tailIndices({ queue, index: 0, repeat: 'off', sleepAtSongEnd: true })],
      [[], []],
    );
  });
});

describe('requests', () => {
  it('signs in with the web server account, in UTF-8', async () => {
    kodiAnswers({ 'JSONRPC.Ping': 'pong' });
    await rpcBatch(KODI, [{ method: 'JSONRPC.Ping' }]);
    assert.equal(http.calls[0].headers.Authorization, `Basic ${Buffer.from('kodi:pässword').toString('base64')}`);
  });

  it('says a refused password is one', async () => {
    http.answer = () => ({ status: 401 });
    await assert.rejects(rpcBatch(KODI, [{ method: 'JSONRPC.Ping' }]), (e: unknown) => e instanceof KodiError && e.kind === 'unauthorized');
  });

  it('says a TV that is off does not answer', async () => {
    http.answer = () => ({ status: -1 });
    await assert.rejects(rpcBatch(KODI, [{ method: 'JSONRPC.Ping' }]), (e: unknown) => e instanceof KodiError && e.kind === 'unreachable');
  });

  it('reads the name and whether the add-on is there', async () => {
    kodiAnswers({ 'XBMC.GetInfoLabels': { 'System.FriendlyName': 'Salon' }, 'Addons.GetAddonDetails': { addon: { enabled: true } } });
    assert.deepEqual(await describeKodi(KODI), { name: 'Salon', addon: true });
  });

  it('takes a Kodi without the add-on for one', async () => {
    kodiAnswers({ 'XBMC.GetInfoLabels': { 'System.FriendlyName': 'Salon' } });
    assert.deepEqual(await describeKodi(KODI), { name: 'Salon', addon: false });
  });

  it('replaces the playlist and starts it in one request', async () => {
    kodiAnswers({ 'Playlist.Clear': 'OK', 'Playlist.Add': 'OK', 'Player.Open': 'OK' });
    await kodiPlay(KODI, ['a', 'b']);
    assert.deepEqual([http.calls.length, methods()], [1, ['Playlist.Clear', 'Playlist.Add', 'Player.Open']]);
  });

  it('takes the tail out last first, and never the track playing', async () => {
    kodiAnswers({ 'Playlist.Remove': 'OK' });
    await kodiTrimAfter(KODI, 1, 4);
    assert.deepEqual(
      (http.calls[0].body as { params: { position: number } }[]).map((b) => b.params.position),
      [3, 2],
    );
  });

  it('seeks to a time rather than by one', async () => {
    kodiAnswers({ 'Player.Seek': {} });
    await kodiSeek(KODI, 75);
    assert.deepEqual((http.calls[0].body as { params: unknown }[])[0].params, {
      playerid: 0,
      value: { time: { hours: 0, minutes: 1, seconds: 15, milliseconds: 0 } },
    });
  });
});
