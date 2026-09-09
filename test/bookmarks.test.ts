/**
 * Resume points: when the server is asked to keep one, when it is dropped,
 * and that a long song starting again picks up where it was.
 *
 * The module keeps state between calls (the last position written, the
 * song being resumed), so the tests run in order and each one starts from
 * a song of its own.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { Bookmark, Song } from '@/api/subsonic';
import { attachBookmarks, bookmarksAvailable, loadBookmarks, removeBookmark, RESUME_MIN_SEC, saveBookmark, useBookmarks, type PlaybackSnapshot } from '@/lib/bookmarks';

import { data } from './stubs/api-data';
import { serverProfile, useAuthStore } from './stubs/store-auth';
import { useToast } from './stubs/store-toast';

const LONG = RESUME_MIN_SEC + 600;

function song(id: string, duration = LONG): Song {
  return { id, title: id, duration };
}

function bookmark(s: Song, positionSec: number): Bookmark {
  return { song: s, position: positionSec * 1000, created: '2026-01-01T00:00:00Z', changed: '2026-01-01T00:00:00Z' };
}

/** A player whose state a test moves by hand; every change reaches the listeners. */
function fakePlayer(initial: Partial<PlaybackSnapshot> = {}) {
  const seeks: number[] = [];
  let state: PlaybackSnapshot = { queue: [], index: 0, positionSec: 0, durationSec: 0, isPlaying: false, seekTo: (sec) => seeks.push(sec), ...initial };
  const listeners: ((next: PlaybackSnapshot, prev: PlaybackSnapshot) => void)[] = [];
  return {
    seeks,
    getState: () => state,
    subscribe(listener: (next: PlaybackSnapshot, prev: PlaybackSnapshot) => void) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    set(patch: Partial<PlaybackSnapshot>): void {
      const prev = state;
      state = { ...state, ...patch };
      for (const l of listeners) l(state, prev);
    },
  };
}

/** Lets every promise the module chained settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const calls = (name: string) => data.calls.filter((c) => c.name === name);

beforeEach(() => {
  data.reset();
  useAuthStore.setState({ auth: serverProfile(), offline: false });
  useToast.setState({ messages: [] });
});

describe('bookmarksAvailable', () => {
  it('needs a Subsonic server, online', () => {
    assert.equal(bookmarksAvailable(), true);
    useAuthStore.setState({ offline: true });
    assert.equal(bookmarksAvailable(), false);
    useAuthStore.setState({ offline: false, auth: serverProfile({ serverType: 'jellyfin' }) });
    assert.equal(bookmarksAvailable(), false);
    useAuthStore.setState({ auth: null });
    assert.equal(bookmarksAvailable(), false);
  });
});

describe('loadBookmarks', () => {
  it('reads the list once per profile, keyed by song', async () => {
    data.bookmarks = [bookmark(song('l1'), 100), bookmark(song('l2'), 200)];
    await loadBookmarks(true);
    assert.deepEqual(Object.keys(useBookmarks.getState().byId).sort(), ['l1', 'l2']);
    await loadBookmarks();
    assert.equal(calls('getBookmarks').length, 1);
  });

  it('empties the list and reads again when the profile changes', async () => {
    useAuthStore.setState({ auth: serverProfile({ username: 'bob' }) });
    data.bookmarks = [];
    const read = loadBookmarks();
    assert.deepEqual(useBookmarks.getState().byId, {});
    await read;
    assert.equal(calls('getBookmarks').length, 1);
    assert.equal(useBookmarks.getState().loadedFor, 'https://music.example|bob');
  });

  it('does nothing without a server to ask', async () => {
    useAuthStore.setState({ auth: null });
    await loadBookmarks(true);
    assert.equal(calls('getBookmarks').length, 0);
  });
});

describe('saveBookmark and removeBookmark', () => {
  it('writes the position in milliseconds and keeps the note the bookmark had', async () => {
    const s = song('sv1');
    useBookmarks.setState({ byId: { sv1: { ...bookmark(s, 10), comment: 'my note' } } });
    await saveBookmark(s, 123.4);
    assert.deepEqual(calls('createBookmark')[0].args, ['sv1', 123_400, 'my note']);
    assert.equal(useBookmarks.getState().byId.sv1.position, 123_400);
    assert.equal(useBookmarks.getState().byId.sv1.comment, 'my note');
  });

  it('forgets a removed bookmark here and on the server', async () => {
    useBookmarks.setState({ byId: { rm1: bookmark(song('rm1'), 10) } });
    await removeBookmark('rm1');
    assert.deepEqual(calls('deleteBookmark')[0].args, ['rm1']);
    assert.equal('rm1' in useBookmarks.getState().byId, false);
  });
});

describe('attachBookmarks', () => {
  it('lets a short song go by', async () => {
    const short = song('short', 200);
    const player = fakePlayer({ queue: [short], isPlaying: true, durationSec: 200 });
    attachBookmarks(player);
    player.set({ positionSec: 100 });
    player.set({ isPlaying: false });
    await settle();
    assert.equal(calls('createBookmark').length, 0);
  });

  it('writes a long song down when it is paused', async () => {
    const long = song('p1');
    const player = fakePlayer({ queue: [long], isPlaying: true, durationSec: LONG, positionSec: 100 });
    attachBookmarks(player);
    player.set({ positionSec: 101 });
    player.set({ isPlaying: false });
    await settle();
    assert.deepEqual(calls('createBookmark').map((c) => c.args), [['p1', 101_000, undefined]]);
  });

  it('does not write the first seconds of a song', async () => {
    const long = song('p2');
    const player = fakePlayer({ queue: [long], isPlaying: true, durationSec: LONG, positionSec: 2 });
    attachBookmarks(player);
    player.set({ positionSec: 3 });
    player.set({ isPlaying: false });
    await settle();
    assert.equal(calls('createBookmark').length, 0);
  });

  it('writes the heartbeat once, not on every beat', async () => {
    const long = song('p3');
    const player = fakePlayer({ queue: [long], isPlaying: true, durationSec: LONG, positionSec: 50 });
    attachBookmarks(player);
    for (let sec = 51; sec < 60; sec++) player.set({ positionSec: sec });
    await settle();
    assert.equal(calls('createBookmark').length, 1);
  });

  it('ignores a beat that jumps, which is the previous song still reporting', async () => {
    const long = song('p4');
    const player = fakePlayer({ queue: [long], isPlaying: true, durationSec: LONG, positionSec: 50 });
    attachBookmarks(player);
    player.set({ positionSec: 900 });
    await settle();
    assert.equal(calls('createBookmark').length, 0);
  });

  it('drops the bookmark once the song is as good as over', async () => {
    const long = song('p5');
    useBookmarks.setState({ byId: { ...useBookmarks.getState().byId, p5: bookmark(long, 100) } });
    const player = fakePlayer({ queue: [long], isPlaying: true, durationSec: LONG, positionSec: LONG - 12 });
    attachBookmarks(player);
    player.set({ positionSec: LONG - 11 });
    player.set({ positionSec: LONG - 10 });
    player.set({ positionSec: LONG - 9 });
    await settle();
    assert.deepEqual(calls('deleteBookmark').map((c) => c.args), [['p5']]);
  });

  it('writes the song leaving, at the position it left from', async () => {
    const leaving = song('p6');
    const next = song('p7');
    const player = fakePlayer({ queue: [leaving, next], isPlaying: true, durationSec: LONG, positionSec: 300 });
    attachBookmarks(player);
    player.set({ index: 1, positionSec: 0 });
    await settle();
    assert.deepEqual(calls('createBookmark').map((c) => c.args), [['p6', 300_000, undefined]]);
  });

  it('picks a long song up where it was on its first beat, and says so', async () => {
    const long = song('r1');
    data.bookmarks = [bookmark(long, 1500)];
    await loadBookmarks(true);
    const player = fakePlayer({ queue: [song('other', 100), long], isPlaying: true, durationSec: LONG, positionSec: 0 });
    attachBookmarks(player);
    player.set({ index: 1 });
    await settle();
    assert.deepEqual(player.seeks, [], 'nothing until the new source has produced a beat');
    player.set({ positionSec: 1 });
    await settle();
    assert.deepEqual(player.seeks, [1500]);
    assert.deepEqual(useToast.getState().messages, ['Resumed at 25:00']);
    player.set({ positionSec: 1501 });
    player.set({ positionSec: 1502 });
    await settle();
    assert.equal(calls('createBookmark').length, 0, 'what was just resumed from is what the server has');
  });

  it('does not seek when the song was already moved past its start', async () => {
    const long = song('r2');
    data.bookmarks = [bookmark(long, 1500)];
    await loadBookmarks(true);
    const player = fakePlayer({ queue: [song('other2', 100), long], isPlaying: true, durationSec: LONG, positionSec: 0 });
    attachBookmarks(player);
    player.set({ index: 1 });
    await settle();
    player.set({ positionSec: 45 });
    player.set({ positionSec: 46 });
    await settle();
    assert.deepEqual(player.seeks, []);
  });
});
