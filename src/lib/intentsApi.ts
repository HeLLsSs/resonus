/**
 * JS ↔ `IntentsApi` native module bridge (control from other apps, Android).
 *
 * Tasker, MacroDroid, Automate, an NFC app or `adb shell am broadcast` send
 * the app a `com.juananzzz.resonus.COMMAND` broadcast with a `command` extra,
 * and the app answers every change of track or of play/pause with a
 * `com.juananzzz.resonus.STATE` broadcast. Both are described, with examples,
 * in docs/INTENTS.md.
 *
 * Commands reach JS as events while it runs. Sent to an app that is not
 * running, they are queued in the process and the app is started; JS finds
 * them in the queue as it starts and runs them once the profile is restored.
 * On platforms without the module (web, iOS) everything is a no-op.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { type StoreApi } from 'zustand';

import { getAlbum, getArtist, getPlaylist, getStarred, getTopSongs, searchSongs } from '@/api/data';
import { type Song } from '@/api/subsonic';
import { tg } from '@/i18n';
import { playShuffle } from '@/lib/playShuffle';
import { queryClient } from '@/lib/query';
import { useAuthStore } from '@/store/auth';
import { type RepeatMode, usePlayerStore } from '@/store/player';

/** A command as the broadcast carried it: `command` and every other extra. */
type IntentCommand = Record<string, string | number | boolean>;

/** What goes out in every STATE broadcast. */
interface IntentsState {
  playing: boolean;
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  position: number;
}

interface NativeIntentsApi {
  takePending: () => IntentCommand[];
  sendState: (state: IntentsState) => Promise<void>;
  addListener: (event: 'command', cb: (command: IntentCommand) => void) => { remove: () => void };
}

const native = requireOptionalNativeModule<NativeIntentsApi>('IntentsApi');

/**
 * How long a command found on a cold start waits for the saved queue to come
 * back before giving up on it: `play` with nothing restored yet is nothing.
 */
const QUEUE_WAIT_MS = 8_000;

/** The least time between two STATE broadcasts about the same song and state. */
const STATE_MIN_GAP_MS = 1_000;

/** How many matches a `play_search` puts in the queue behind the first. */
const SEARCH_QUEUE_SIZE = 50;

/** How many of an artist's popular songs `play_artist` starts with. */
const TOP_SONGS = 20;

/** The longest sleep timer a command may set: ten hours, past any night. */
const MAX_SLEEP_MINUTES = 600;

const REPEAT_MODES: RepeatMode[] = ['off', 'all', 'one'];

let started = false;

/**
 * Starts listening for commands and broadcasting the state. Once per
 * process: called from the root layout's opening effect.
 */
export function startIntentsApi(): void {
  if (!native || started) return;
  started = true;
  native.addListener('command', (command) => {
    run(command).catch((e) => console.warn('[intents] command failed', e));
  });
  drainPending().catch((e) => console.warn('[intents] pending commands failed', e));
  usePlayerStore.subscribe((state, prev) => {
    if (
      state.queue !== prev.queue ||
      state.index !== prev.index ||
      state.isPlaying !== prev.isPlaying ||
      state.streamInfo !== prev.streamInfo
    ) {
      publishState();
    }
  });
}

/**
 * The commands that arrived before JS was listening. Run after the session
 * is restored, since most of them ask the server for something, and after
 * the saved queue is back when there is one to wait for.
 */
async function drainPending(): Promise<void> {
  const pending = native?.takePending() ?? [];
  if (pending.length === 0) return;
  await waitFor(useAuthStore, (s) => !s.hydrating);
  await waitFor(usePlayerStore, (s) => s.queue.length > 0, QUEUE_WAIT_MS);
  for (const command of pending) {
    await run(command).catch((e) => console.warn('[intents] pending command failed', e));
  }
}

/** Resolves when `ready` holds for the store's state, or after `timeoutMs`. */
function waitFor<T>(store: StoreApi<T>, ready: (state: T) => boolean, timeoutMs?: number): Promise<void> {
  if (ready(store.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = store.subscribe((state) => {
      if (!ready(state)) return;
      if (timer) clearTimeout(timer);
      unsub();
      resolve();
    });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        unsub();
        resolve();
      }, timeoutMs);
    }
  });
}

/** A string extra, trimmed; anything else as text. */
function text(command: IntentCommand, key: string): string {
  const value = command[key];
  return value === undefined ? '' : String(value).trim();
}

/** A numeric extra, whether it came as a number (`--ef`) or as text (`--es`). */
function num(command: IntentCommand, key: string): number | undefined {
  const value = command[key];
  if (value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
}

/** A boolean extra: a real boolean (`--ez`), or "true", "1", "on", "yes" as text. */
function flag(command: IntentCommand, key: string): boolean {
  const value = command[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

async function run(command: IntentCommand): Promise<void> {
  const name = text(command, 'command');
  const player = usePlayerStore.getState();
  switch (name) {
    case 'play':
      if (!player.isPlaying) player.toggle();
      return;
    case 'pause':
      if (player.isPlaying) player.toggle();
      return;
    case 'toggle':
      player.toggle();
      return;
    case 'stop':
      await player.stopAndClear();
      return;
    case 'next':
      player.next();
      return;
    case 'previous':
      player.previous();
      return;
    case 'seek': {
      const position = num(command, 'position');
      if (position !== undefined) player.seekTo(Math.max(0, position));
      return;
    }
    case 'volume': {
      const level = num(command, 'level');
      if (level !== undefined) player.setVolume(Math.min(1, Math.max(0, level)));
      return;
    }
    case 'shuffle':
      if (flag(command, 'on') !== player.shuffle) player.toggleShuffle();
      return;
    case 'repeat': {
      const mode = text(command, 'mode');
      if (!REPEAT_MODES.some((m) => m === mode)) {
        console.warn(`[intents] repeat: unknown mode "${mode}"`);
        return;
      }
      // Through the same cycle the button turns, so everything the button
      // does (the player's loop, the queue sync) happens here too.
      for (let i = 0; i < REPEAT_MODES.length && usePlayerStore.getState().repeat !== mode; i++) {
        usePlayerStore.getState().cycleRepeat();
      }
      return;
    }
    case 'play_album':
    case 'play_playlist':
    case 'play_artist':
      await playContainer(name.slice('play_'.length), text(command, 'id'), flag(command, 'shuffle'));
      return;
    case 'play_search': {
      const query = text(command, 'query');
      if (!query) return;
      const songs = await searchSongs(query, SEARCH_QUEUE_SIZE);
      if (songs.length === 0) {
        console.warn(`[intents] play_search: nothing found for "${query}"`);
        return;
      }
      await player.playQueue(songs, 0, query);
      return;
    }
    case 'play_favorites': {
      const { songs } = await getStarred();
      if (songs.length === 0) return;
      await player.playQueue(songs, 0, tg('Favorites'), '/favorites', { shuffled: flag(command, 'shuffle') });
      return;
    }
    case 'play_random':
      await playShuffle();
      return;
    case 'sleep_timer': {
      // Whole minutes within reason: past a day the timeout would overflow
      // and fire at once, which is the opposite of what was asked.
      const minutes = Math.min(MAX_SLEEP_MINUTES, Math.max(0, Math.round(num(command, 'minutes') ?? 0)));
      if (minutes > 0) player.setSleepTimer(minutes);
      else player.cancelSleepTimer();
      return;
    }
    default:
      console.warn(`[intents] unknown command "${name}"`);
  }
}

/**
 * Plays an album, a playlist or an artist by id, the way the
 * `resonus://play/<kind>/<id>` link does: through the screens' own queries,
 * and for an artist the popular songs first, the discography from the
 * earliest album on when the server keeps no play counts.
 */
async function playContainer(kind: string, id: string, shuffled: boolean): Promise<void> {
  if (!id) {
    console.warn(`[intents] play_${kind}: no id`);
    return;
  }
  let songs: Song[] = [];
  let name = '';
  const href = `/${kind}/${id}`;
  if (kind === 'album') {
    const detail = await queryClient.fetchQuery({ queryKey: ['album', id], queryFn: () => getAlbum(id) });
    songs = detail.songs;
    name = detail.album.name;
  } else if (kind === 'playlist') {
    const detail = await queryClient.fetchQuery({ queryKey: ['playlist', id], queryFn: () => getPlaylist(id) });
    songs = detail.songs;
    name = detail.playlist.name;
  } else {
    const { artist, albums } = await getArtist(id);
    name = artist.name;
    songs = name ? await getTopSongs(name, TOP_SONGS) : [];
    if (songs.length === 0) {
      const chrono = [...albums].sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));
      const parts = await Promise.all(
        chrono.map((a) =>
          queryClient.fetchQuery({ queryKey: ['album', a.id], queryFn: () => getAlbum(a.id) }),
        ),
      );
      songs = parts.flatMap((p) => p.songs);
    }
  }
  if (songs.length === 0) {
    console.warn(`[intents] play_${kind}: nothing to play for "${id}"`);
    return;
  }
  await usePlayerStore.getState().playQueue(songs, 0, name, href, { shuffled });
}

/** What was last broadcast, so nothing goes out twice and bursts are thinned. */
let lastSent = { playing: false, id: '', key: '', at: 0 };

/**
 * Broadcasts the state after a change. Whether it is playing and which song
 * it is always go out at once: those are what a profile reacts to, and the
 * app may be paused for an hour with nothing else to carry a late one. What
 * is held to one a second is the rest, which is a radio renaming its song.
 * No timer is involved: one would sleep with the app in the background, which
 * is exactly where these broadcasts are listened to.
 */
function publishState(): void {
  if (!native) return;
  const state = usePlayerStore.getState();
  const song = state.queue[state.index];
  // A radio names what it is playing itself; the station is the queue item.
  const live = song?.url ? state.streamInfo : null;
  const next: IntentsState = {
    playing: state.isPlaying,
    id: song?.id ?? '',
    title: live?.title ?? song?.title ?? '',
    artist: live?.artist ?? song?.artist ?? '',
    album: song?.album ?? '',
    duration: state.durationSec || song?.duration || 0,
    position: state.positionSec,
  };
  const key = [next.playing, next.id, next.title, next.artist, next.album].join('|');
  if (key === lastSent.key) return;
  const now = Date.now();
  const flipped = next.playing !== lastSent.playing || next.id !== lastSent.id;
  if (!flipped && now - lastSent.at < STATE_MIN_GAP_MS) return;
  lastSent = { playing: next.playing, id: next.id, key, at: now };
  // Nothing waits on it: the broadcast is for somebody else.
  void native.sendState(next);
}
