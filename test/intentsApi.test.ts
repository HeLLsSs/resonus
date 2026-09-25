/**
 * Commands from other apps: how each extra is read (text, number, flag),
 * the bounds put on what they ask for, and what the app broadcasts back.
 *
 * The bridge starts once per process, so every test drives the same
 * listener and clears the scoreboard first.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { startIntentsApi } from '@/lib/intentsApi';

import { data } from './stubs/api-data';
import { intentsApi } from './stubs/expo-modules-core';
import { playShuffleCalls } from './stubs/lib-playShuffle';
import { serverProfile, useAuthStore } from './stubs/store-auth';
import { ha, useHomeAssistant } from './stubs/store-homeAssistant';
import { leaveCalls, playerCalls, resetPlayer, usePlayerStore } from './stubs/store-player';

const settle = () => new Promise((r) => setTimeout(r, 0));

async function send(command: Record<string, string | number | boolean>): Promise<void> {
  intentsApi.emit(command);
  await settle();
}

const names = () => playerCalls.map((c) => c.name);

startIntentsApi();
startIntentsApi();

beforeEach(() => {
  resetPlayer();
  data.reset();
  ha.reset();
  useHomeAssistant.setState({ connected: false, entityId: null });
  intentsApi.sent = [];
  useAuthStore.setState({ auth: serverProfile(), hydrating: false });
});

describe('startIntentsApi', () => {
  it('listens once however often it is called', () => {
    assert.equal(intentsApi.listeners.length, 1);
  });
});

describe('transport commands', () => {
  it('plays only when paused, pauses only when playing', async () => {
    await send({ command: 'play' });
    assert.deepEqual(names(), ['toggle']);
    await send({ command: 'play' });
    assert.deepEqual(names(), ['toggle'], 'already playing');
    await send({ command: 'pause' });
    assert.deepEqual(names(), ['toggle', 'toggle']);
    await send({ command: 'pause' });
    assert.deepEqual(names(), ['toggle', 'toggle'], 'already paused');
  });

  it('passes the simple ones straight through', async () => {
    await send({ command: 'toggle' });
    await send({ command: 'next' });
    await send({ command: 'previous' });
    await send({ command: 'stop' });
    assert.deepEqual(names(), ['toggle', 'next', 'previous', 'stopAndClear']);
  });

  it('warns about a command it does not know, and one with no name', async () => {
    const warned: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args.join(' '));
    try {
      await send({ command: 'dance' });
      await send({});
    } finally {
      console.warn = original;
    }
    assert.deepEqual(warned, ['[intents] unknown command "dance"', '[intents] unknown command ""']);
    assert.deepEqual(names(), []);
  });
});

describe('seek, volume and the sleep timer', () => {
  it('seeks to a position given as a number or as text, never below zero', async () => {
    await send({ command: 'seek', position: 42 });
    await send({ command: 'seek', position: ' 7.5 ' });
    await send({ command: 'seek', position: -3 });
    assert.deepEqual(playerCalls.map((c) => c.args), [[42], [7.5], [0]]);
  });

  it('ignores a seek with no usable position', async () => {
    await send({ command: 'seek' });
    await send({ command: 'seek', position: '' });
    await send({ command: 'seek', position: 'far' });
    assert.deepEqual(names(), []);
  });

  it('keeps the volume between 0 and 1', async () => {
    await send({ command: 'volume', level: 0.5 });
    await send({ command: 'volume', level: '2' });
    await send({ command: 'volume', level: -1 });
    assert.deepEqual(playerCalls.map((c) => c.args), [[0.5], [1], [0]]);
  });

  it('rounds the sleep timer to whole minutes, caps it at ten hours and cancels it at zero', async () => {
    await send({ command: 'sleep_timer', minutes: 29.6 });
    await send({ command: 'sleep_timer', minutes: 5000 });
    await send({ command: 'sleep_timer', minutes: 0 });
    await send({ command: 'sleep_timer', minutes: '-4' });
    await send({ command: 'sleep_timer' });
    assert.deepEqual(playerCalls, [
      { name: 'setSleepTimer', args: [30] },
      { name: 'setSleepTimer', args: [600] },
      { name: 'cancelSleepTimer', args: [] },
      { name: 'cancelSleepTimer', args: [] },
      { name: 'cancelSleepTimer', args: [] },
    ]);
  });
});

describe('shuffle and repeat', () => {
  it('reads the shuffle flag as a boolean, a number or a word, and only flips when needed', async () => {
    await send({ command: 'shuffle', on: true });
    assert.equal(usePlayerStore.getState().shuffle, true);
    await send({ command: 'shuffle', on: 'yes' });
    assert.deepEqual(names(), ['toggleShuffle'], 'already on');
    await send({ command: 'shuffle', on: 0 });
    assert.equal(usePlayerStore.getState().shuffle, false);
    await send({ command: 'shuffle', on: 'ON' });
    assert.equal(usePlayerStore.getState().shuffle, true);
    await send({ command: 'shuffle' });
    assert.equal(usePlayerStore.getState().shuffle, false, 'no flag means off');
  });

  it('cycles the repeat mode round to the one asked for', async () => {
    await send({ command: 'repeat', mode: 'one' });
    assert.equal(usePlayerStore.getState().repeat, 'one');
    assert.deepEqual(names(), ['cycleRepeat', 'cycleRepeat']);
    await send({ command: 'repeat', mode: 'one' });
    assert.deepEqual(names(), ['cycleRepeat', 'cycleRepeat'], 'already there');
  });

  it('leaves the repeat mode alone on a mode it does not know', async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      await send({ command: 'repeat', mode: 'twice' });
    } finally {
      console.warn = original;
    }
    assert.equal(usePlayerStore.getState().repeat, 'off');
    assert.deepEqual(names(), []);
  });
});

describe('output', () => {
  const kitchen = { entityId: 'media_player.kitchen', name: 'Kitchen', state: 'idle', canEnqueue: false, canClearPlaylist: false, canSeek: false, musicAssistant: false };

  it('brings the music back to the phone, out loud', async () => {
    await send({ command: 'output', id: 'phone' });
    assert.deepEqual(leaveCalls, [{ silent: false, keep: undefined }]);
  });

  it('hands the music to the house player it names, leaving the others quietly', async () => {
    ha.players.set(kitchen.entityId, kitchen);
    await send({ command: 'output', id: 'media_player.kitchen' });
    assert.deepEqual([leaveCalls, ha.connected], [[{ silent: true, keep: 'ha' }], [kitchen]]);
  });

  it('leaves a player it is already on alone', async () => {
    ha.players.set(kitchen.entityId, kitchen);
    useHomeAssistant.setState({ connected: true, entityId: 'media_player.kitchen' });
    await send({ command: 'output', id: 'media_player.kitchen' });
    assert.deepEqual([leaveCalls, ha.connected], [[], []]);
  });

  it('does nothing for a player the house does not have, or an id that is not one', async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      await send({ command: 'output', id: 'media_player.attic' });
      await send({ command: 'output', id: 'toaster' });
    } finally {
      console.warn = original;
    }
    assert.deepEqual([leaveCalls, ha.connected], [[], []]);
  });
});

describe('playing something', () => {
  const hits: Song[] = [{ id: 'h1', title: 'Hit' }, { id: 'h2', title: 'Hit 2' }];

  it('searches and plays the results under the query', async () => {
    data.searchResults = hits;
    await send({ command: 'play_search', query: '  nina  ' });
    assert.deepEqual(data.calls[0].args, ['nina', 50]);
    assert.deepEqual(playerCalls[0].args.slice(0, 3), [hits, 0, 'nina']);
  });

  it('plays nothing for an empty query or an empty result', async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      await send({ command: 'play_search', query: '' });
      await send({ command: 'play_search', query: 'nothing' });
    } finally {
      console.warn = original;
    }
    assert.deepEqual(names(), []);
  });

  it('plays the favourites, shuffled when asked', async () => {
    data.starred = hits;
    await send({ command: 'play_favorites', shuffle: '1' });
    assert.deepEqual(playerCalls[0].args, [hits, 0, 'Favorites', '/favorites', { shuffled: true }]);
  });

  it('plays an album through its query, under its name', async () => {
    data.albums.set('al1', { album: { id: 'al1', name: 'The Album' } as never, songs: hits });
    await send({ command: 'play_album', id: 'al1', shuffle: false });
    assert.deepEqual(playerCalls[0].args, [hits, 0, 'The Album', '/album/al1', { shuffled: false }]);
  });

  it('asks for nothing with no id', async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      await send({ command: 'play_album' });
    } finally {
      console.warn = original;
    }
    assert.deepEqual(data.calls, []);
  });

  it('hands play_random to the shuffle', async () => {
    const before = playShuffleCalls.count;
    await send({ command: 'play_random' });
    assert.equal(playShuffleCalls.count, before + 1);
  });
});

describe('the state broadcast', () => {
  const s: Song = { id: 'b1', title: 'Broadcast', artist: 'Someone', album: 'Album', duration: 200, coverArt: 'cov' };

  it('goes out on a change of song or of play/pause', async () => {
    usePlayerStore.setState({ queue: [s], index: 0, isPlaying: true, positionSec: 3 });
    assert.equal(intentsApi.sent.length, 1);
    assert.deepEqual(intentsApi.sent[0], {
      playing: true,
      id: 'b1',
      title: 'Broadcast',
      artist: 'Someone',
      album: 'Album',
      duration: 200,
      position: 3,
    });
    usePlayerStore.setState({ isPlaying: false });
    assert.equal(intentsApi.sent.length, 2);
    assert.equal(intentsApi.sent[1].playing, false);
  });

  it('does not repeat itself for a change that alters nothing it says', () => {
    usePlayerStore.setState({ queue: [s], index: 0, isPlaying: true });
    const before = intentsApi.sent.length;
    usePlayerStore.setState({ positionSec: 10 });
    usePlayerStore.setState({ queue: [s], index: 0 });
    assert.equal(intentsApi.sent.length, before);
  });

  it('names what a radio is playing rather than the station', () => {
    const station: Song = { id: 'radio', title: 'Station', url: 'http://stream', coverArt: 'cached-cover:x' };
    usePlayerStore.setState({ queue: [station], index: 0, isPlaying: true, streamInfo: { title: 'Live song', artist: 'Live artist' } });
    const last = intentsApi.sent.at(-1)!;
    assert.equal(last.title, 'Live song');
    assert.equal(last.artist, 'Live artist');
  });
});
