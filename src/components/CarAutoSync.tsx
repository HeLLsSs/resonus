/**
 * Keeps Android Auto in sync with playback:
 *  - Pushes the browse tree (on mount and when the profile changes).
 *  - Mirrors the current track / queue / state to the native module.
 *  - Receives touch (play) and car transport buttons and applies them
 *    to the player store (which drives expo-audio).
 *
 * Renders nothing. On platforms without the native module it is a no-op.
 */
import { useEffect } from 'react';

import { CACHED_COVER, COVER, songCoverUrl, type Song } from '@/api/data';
import {
  carAutoAvailable,
  onCarConnected,
  onPlay,
  onTransport,
  setNodes,
  setNowPlaying,
  setPlaybackState,
  setQueue,
  type CarTrack,
} from '@/lib/carAuto';
import { useBookmarks } from '@/lib/bookmarks';
import { buildBrowseTree, carCoverUrl, handleBrowsePlay, knownCarCover, warmCarCover } from '@/lib/carAutoTree';
import { bump } from '@/lib/perfLog';
import { useAuthStore } from '@/store/auth';
import { useLastPlayed } from '@/store/lastPlayed';
import { usePins } from '@/store/pins';
import { usePlayerStore, type StreamInfo } from '@/store/player';
import { useQueueHistory } from '@/store/queueHistory';
import { useSmartPlaylists } from '@/store/smartPlaylists';

const REBUILD_DEBOUNCE_MS = 600;
/** How long after opening before the tree is filled in. Long enough that the
 *  app has finished starting; short enough to be ready for a drive. */
const DEEP_REBUILD_MS = 45_000;
/** How often a connecting car is allowed to set off a full rebuild. It asks
 *  for the root more than once per drive, and each one is dozens of requests. */
const DEEP_MIN_INTERVAL_MS = 5 * 60_000;
const POSITION_PUSH_MS = 1000;
/** How far the car's own idea of the position may stray before it is told. */
const POSITION_DRIFT_SEC = 1.5;

/** `live` is what a radio says it is playing, which replaces the title and the
 *  artist and nothing else: the station is not an album. */
function toCarTrack(song: Song, live?: StreamInfo | null): CarTrack {
  // A cover the host cannot fetch itself (a server that wants headers) goes as
  // the cached file when there is one, and as nothing until `warmCarCover` has
  // fetched it, which `pushNowPlaying` follows up on.
  const cover = carCoverUrl(songCoverUrl(song, COVER.card));
  return {
    id: song.id,
    title: live?.title ?? song.title ?? undefined,
    artist: live?.artist ?? song.artist ?? undefined,
    album: song.album || undefined,
    artworkUrl: (cover?.startsWith(CACHED_COVER) ? knownCarCover(cover) : cover) || undefined,
    durationMs: Math.round((song.duration ?? 0) * 1000),
  };
}

export function CarAutoSync() {
  useEffect(() => {
    if (!carAutoAvailable) return;
    let cancelled = false;
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

    // ── Browse tree ──
    // Twice: the lists as soon as there is a session, and the songs of every
    // album in them once the app is done opening. Filling it in is dozens of
    // requests, and doing that within a second of launch competed with the
    // start itself for anyone who was never going to plug in a car (#50).
    const rebuild = (deep: boolean) => {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(async () => {
        const { auth, offline } = useAuthStore.getState();
        if (!auth && !offline) return;
        const tree = await buildBrowseTree(deep).catch(() => null);
        if (!cancelled && tree) setNodes(tree);
      }, REBUILD_DEBOUNCE_MS);
    };
    // The lists now, the songs once the app has settled. `scheduleDeep` is also
    // what any later change restarts: the session store emits several times
    // while hydrating, and each of those used to mean the full fetch again.
    let deepTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDeepAt = 0;
    const scheduleDeep = (delay = DEEP_REBUILD_MS) => {
      if (deepTimer) clearTimeout(deepTimer);
      deepTimer = setTimeout(() => {
        lastDeepAt = Date.now();
        rebuild(true);
      }, delay);
    };
    rebuild(false);
    scheduleDeep();
    const unsubAuth = useAuthStore.subscribe(() => {
      rebuild(false);
      scheduleDeep();
    });
    // Starting an album or a playlist writes it down as recently played, and
    // the car's Recents tab is built out of exactly that. Without this the tab
    // only ever knew what had been played before the app opened. Deep on
    // purpose: what has just moved to the top of Recents is the likeliest
    // thing to be tapped next, and the lists alone would leave it with no
    // songs of its own.
    const unsubRecent = useLastPlayed.subscribe(() => scheduleDeep());
    // A smart playlist written, changed or deleted on the phone is a row that
    // has to appear, move or go in the car's Library, and its songs a list
    // that has to be run again: the lists at once, the songs after the usual
    // wait. Not on hydration of an empty store, which is every launch for
    // anybody who has none, and would be one more build for nothing.
    const unsubSmart = useSmartPlaylists.subscribe((state, prev) => {
      if (state.lists === prev.lists || (state.lists.length === 0 && prev.lists.length === 0)) return;
      rebuild(false);
      scheduleDeep();
    });
    // The rows of Home that come from the phone alone, kept current with the
    // lists rebuilt and nothing fetched: a queue put away or brought back, a
    // playlist pinned, a resume point set or cleared. The bookmarks store
    // changes every half minute while a long song plays, so only a bookmark
    // appearing or going counts, not one moving.
    const unsubQueues = useQueueHistory.subscribe((state, prev) => {
      if (state.queues !== prev.queues) rebuild(false);
    });
    const unsubPins = usePins.subscribe((state, prev) => {
      if (state.pins !== prev.pins) rebuild(false);
    });
    const sameSongs = (a: Record<string, unknown>, b: Record<string, unknown>) => {
      const ids = Object.keys(a);
      return ids.length === Object.keys(b).length && ids.every((id) => id in b);
    };
    const unsubBookmarks = useBookmarks.subscribe((state, prev) => {
      if (state.byId !== prev.byId && !sameSongs(state.byId, prev.byId)) rebuild(false);
    });
    // Plugging into a car is the one moment the tree is certain to be needed,
    // and the wait was being counted from the launch: forty five seconds of
    // app in the foreground is a thing that never happens to somebody who
    // opens Resonus, puts the phone in a pocket and drives off, so what the
    // car got were the lists with no songs inside them.
    const connectSub = onCarConnected(() => {
      if (Date.now() - lastDeepAt > DEEP_MIN_INTERVAL_MS) scheduleDeep(0);
    });

    // ── Mirror playback state ──
    const pushNowPlaying = () => {
      const { queue, index, streamInfo } = usePlayerStore.getState();
      const current = queue[index] ?? null;
      const track = current ? toCarTrack(current, current.url ? streamInfo : null) : null;
      setNowPlaying(track);
      if (!current || track?.artworkUrl) return;
      // Told again once the picture is on the phone, if it is still the song.
      void warmCarCover(carCoverUrl(songCoverUrl(current, COVER.card))).then((ready) => {
        const now = usePlayerStore.getState();
        if (ready && now.queue[now.index] === current) pushNowPlaying();
      });
    };
    const pushQueue = () => {
      const { queue, index } = usePlayerStore.getState();
      // The queue holds the station, not what it happens to be playing.
      setQueue(
        queue.map((s) => toCarTrack(s)),
        index,
      );
    };
    // What the car was last told, and when: it runs the position forward on
    // its own from there while playing, so it only needs telling again when
    // the player has moved somewhere else. Every push is a whole timeline
    // rebuilt on the native side, queue and artwork included, and sending one
    // a second, paused or not, car or no car, was most of what the app did
    // while it sat in a pocket.
    let told = { at: 0, positionSec: 0, isPlaying: false };
    const pushState = () => {
      const { isPlaying, positionSec, shuffle, repeat } = usePlayerStore.getState();
      told = { at: Date.now(), positionSec, isPlaying };
      setPlaybackState({
        isPlaying,
        positionMs: Math.round(positionSec * 1000),
        shuffle,
        repeatMode: repeat,
      });
    };
    const positionDrifted = () => {
      const { positionSec } = usePlayerStore.getState();
      const expected = told.isPlaying
        ? told.positionSec + (Date.now() - told.at) / 1000
        : told.positionSec;
      return Math.abs(positionSec - expected) > POSITION_DRIFT_SEC;
    };
    pushNowPlaying();
    pushQueue();
    pushState();

    const unsubPlayer = usePlayerStore.subscribe((state, prev) => {
      let told = false;
      // The "Continue listening" row on Home is the queue as it stands, named
      // for what it was started from. A queue replaced by another, or one
      // appearing where there was none, is a new row; a track change inside
      // it is not, since the row resumes the queue wherever it is.
      if (
        state.queue !== prev.queue &&
        (state.source !== prev.source || (state.queue.length === 0) !== (prev.queue.length === 0))
      ) {
        rebuild(false);
      }
      if (state.queue !== prev.queue || state.index !== prev.index) {
        pushNowPlaying();
        pushQueue();
        // The state goes with it, always. Handing the car a track restarts the
        // clock it counts the position with but leaves the second it counts
        // from where it was, so a queue that changed under an unmoved position
        // (a mix filling itself in, a song added to the queue, a station
        // naming a new song) left the car's progress bar running a minute
        // behind with nothing below to notice: the drift check compares the
        // player against what we last said, and we had said nothing wrong.
        pushState();
        told = true;
      }
      // A radio changes track without the queue moving: it is one item for the
      // whole broadcast, and only the stream knows when a song ends.
      if (state.streamInfo !== prev.streamInfo) {
        pushNowPlaying();
        if (!told) {
          pushState();
          told = true;
        }
      }
      if (
        !told &&
        (state.isPlaying !== prev.isPlaying ||
          state.shuffle !== prev.shuffle ||
          state.repeat !== prev.repeat)
      ) {
        pushState();
      }
    });
    // A seek, a stall, a speed other than 1: whatever leaves the car's count
    // behind is caught here, and nothing else costs it a push.
    const interval = setInterval(() => {
      if (positionDrifted()) pushState();
    }, POSITION_PUSH_MS);

    // ── Events from the car ──
    const playSub = onPlay((e) => {
      // Something is playing from the car, so the wait no longer applies: fill
      // the tree in now rather than at the end of the delay.
      scheduleDeep(0);
      void handleBrowsePlay(e.mediaId, e.parentId);
    });
    const transportSub = onTransport((e) => {
      const store = usePlayerStore.getState();
      // One count per button pressed in the car, so a report says what was
      // asked for out there. Everything below this line happens with the app in
      // the background, and the only other record of it is whatever the player
      // ends up doing.
      bump(`car · ${e.action}`);
      switch (e.action) {
        case 'play':
          if (!store.isPlaying) store.toggle();
          break;
        case 'pause':
          if (store.isPlaying) store.toggle();
          break;
        case 'next':
          store.next();
          break;
        case 'previous':
          store.previous();
          break;
        case 'seek':
          store.seekTo((e.value ?? 0) / 1000);
          break;
        case 'seekToIndex':
          store.jumpTo(Math.round(e.value ?? 0));
          break;
        case 'shuffle':
          if (Boolean(e.value) !== store.shuffle) store.toggleShuffle();
          break;
        case 'repeat': {
          // The store cycles off→all→one; advance until the target is reached.
          for (let i = 0; i < 3 && usePlayerStore.getState().repeat !== e.value; i++) {
            usePlayerStore.getState().cycleRepeat();
          }
          break;
        }
      }
    });

    return () => {
      cancelled = true;
      if (rebuildTimer) clearTimeout(rebuildTimer);
      if (deepTimer) clearTimeout(deepTimer);
      clearInterval(interval);
      unsubAuth();
      unsubRecent();
      unsubSmart();
      unsubQueues();
      unsubPins();
      unsubBookmarks();
      unsubPlayer();
      connectSub?.remove();
      playSub?.remove();
      transportSub?.remove();
    };
  }, []);

  return null;
}
