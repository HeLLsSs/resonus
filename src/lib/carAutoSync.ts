/**
 * Keeps Android Auto in sync with playback:
 *  - Pushes the browse tree (at start and when the profile changes).
 *  - Mirrors the current track / queue / state to the native module.
 *  - Receives touch (play) and car transport buttons and applies them
 *    to the player store (which drives expo-audio).
 *  - Answers the car's search box with what the library holds, which is more
 *    than the tree it pushed.
 *
 * Started once per runtime from `bootstrap`, with no screen: the car service
 * starts the runtime on its own when a tap finds none (see `JsRuntime.kt` in
 * modules/car-auto), and what it asks for has to be answered whether or not
 * an Activity ever comes. On platforms without the native module it is a
 * no-op.
 */
import { CACHED_COVER, COVER, songCoverUrl, star, unstar, type Song } from '@/api/data';
import { type Starred } from '@/api/subsonic';
import {
  carAutoAvailable,
  onCarConnected,
  onCarSearch,
  onPlay,
  onTransport,
  setNodes,
  setNowPlaying,
  setPlaybackState,
  setQueue,
  setSearchResults,
  type CarTrack,
  type TransportEvent,
} from '@/lib/carAuto';
import { useBookmarks } from '@/lib/bookmarks';
import {
  buildBrowseTree,
  carCoverUrl,
  carSearch,
  handleBrowsePlay,
  knownCarCover,
  warmCarCover,
} from '@/lib/carAutoTree';
import { bump } from '@/lib/perfLog';
import { queryClient } from '@/lib/query';
import { waitFor, whenProfileReady } from '@/lib/storeWait';
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
/**
 * How long a transport button pressed before the saved queue is back waits
 * for it: the car's play with nothing restored yet is nothing. Same as the
 * pending commands in src/lib/intentsApi.ts.
 */
const QUEUE_WAIT_MS = 8_000;

let started = false;

/** `live` is what a radio says it is playing, which replaces the title and the
 *  artist and nothing else: the station is not an album. */
/**
 * The account's favourite songs, as the app's own screens know them.
 *
 * Read out of the query cache rather than fetched: `useFavoriteIds` keeps this
 * key filled for every heart the app draws, and asking the server again from
 * here would be a request per push with the phone in a pocket. Nothing there
 * yet means nothing is known, and the car is told nothing rather than told the
 * song is not a favourite, which would draw an empty heart over one the person
 * had just filled.
 */
function favoriteIds(): Set<string> | null {
  const starred = queryClient.getQueryData<Starred>(['starred']);
  if (!starred) return null;
  return new Set(starred.songs.map((x) => x.id));
}

function toCarTrack(song: Song, live?: StreamInfo | null, favorites?: Set<string> | null): CarTrack {
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
    favorite: favorites?.has(song.id) ?? false,
  };
}

/**
 * Keeps the song being played, or stops keeping it.
 *
 * What the button asked for is obeyed rather than worked out again here: the
 * car may be showing a heart drawn before the song changed, and doing what it
 * showed is what makes the press mean what the driver saw. Refreshing the
 * starred list is what puts the new heart on the car's screen, through the
 * same path every other screen of the app uses.
 */
async function toggleFavorite(wanted: boolean): Promise<void> {
  const { queue, index } = usePlayerStore.getState();
  const song = queue[index];
  if (!song) return;
  try {
    if (wanted) await star(song.id);
    else await unstar(song.id);
    bump(wanted ? 'car · favorited' : 'car · unfavorited');
  } catch {
    // Out of coverage, or the server refusing: the heart stays as it was and
    // the driver has a road to watch. Offline the call does not throw at all,
    // it goes to the outbox.
    bump('car · favorite failed');
    return;
  }
  await queryClient.invalidateQueries({ queryKey: ['starred'] });
}

function applyTransport(e: TransportEvent): void {
  const store = usePlayerStore.getState();
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
    case 'favorite':
      void toggleFavorite(Boolean(e.value));
      break;
    case 'repeat': {
      // The store cycles off→all→one; advance until the target is reached.
      for (let i = 0; i < 3 && usePlayerStore.getState().repeat !== e.value; i++) {
        usePlayerStore.getState().cycleRepeat();
      }
      break;
    }
  }
}

export function startCarAutoSync(): void {
  if (!carAutoAvailable || started) return;
  started = true;
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
      if (tree) setNodes(tree);
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
  useAuthStore.subscribe(() => {
    rebuild(false);
    scheduleDeep();
  });
  // Starting an album or a playlist writes it down as recently played, and
  // the car's Recents tab is built out of exactly that. Without this the tab
  // only ever knew what had been played before the app opened. Deep on
  // purpose: what has just moved to the top of Recents is the likeliest
  // thing to be tapped next, and the lists alone would leave it with no
  // songs of its own.
  useLastPlayed.subscribe(() => scheduleDeep());
  // A smart playlist written, changed or deleted on the phone is a row that
  // has to appear, move or go in the car's Library, and its songs a list
  // that has to be run again: the lists at once, the songs after the usual
  // wait. Not on hydration of an empty store, which is every launch for
  // anybody who has none, and would be one more build for nothing.
  useSmartPlaylists.subscribe((state, prev) => {
    if (state.lists === prev.lists || (state.lists.length === 0 && prev.lists.length === 0)) return;
    rebuild(false);
    scheduleDeep();
  });
  // The rows of Home that come from the phone alone, kept current with the
  // lists rebuilt and nothing fetched: a queue put away or brought back, a
  // playlist pinned, a resume point set or cleared. The bookmarks store
  // changes every half minute while a long song plays, so only a bookmark
  // appearing or going counts, not one moving.
  useQueueHistory.subscribe((state, prev) => {
    if (state.queues !== prev.queues) rebuild(false);
  });
  usePins.subscribe((state, prev) => {
    if (state.pins !== prev.pins) rebuild(false);
  });
  const sameSongs = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const ids = Object.keys(a);
    return ids.length === Object.keys(b).length && ids.every((id) => id in b);
  };
  useBookmarks.subscribe((state, prev) => {
    if (state.byId !== prev.byId && !sameSongs(state.byId, prev.byId)) rebuild(false);
  });
  // Plugging into a car is the one moment the tree is certain to be needed,
  // and the wait was being counted from the launch: forty five seconds of
  // app in the foreground is a thing that never happens to somebody who
  // opens Resonuls, puts the phone in a pocket and drives off, so what the
  // car got were the lists with no songs inside them.
  //
  // After the profile, not before: the car opening the app can be what
  // started this runtime, and a build set off before the session is back
  // is one that finds no session and builds nothing.
  onCarConnected(() => {
    void whenProfileReady().then(() => {
      if (Date.now() - lastDeepAt > DEEP_MIN_INTERVAL_MS) scheduleDeep(0);
    });
  });

  // ── Mirror playback state ──
  const pushNowPlaying = () => {
    const { queue, index, streamInfo } = usePlayerStore.getState();
    const current = queue[index] ?? null;
    const track = current ? toCarTrack(current, current.url ? streamInfo : null, favoriteIds()) : null;
    setNowPlaying(track);
    if (!current || track?.artworkUrl) return;
    // Told again once the picture is on the phone, if it is still the song.
    void warmCarCover(carCoverUrl(songCoverUrl(current, COVER.card))).then((ready) => {
      const now = usePlayerStore.getState();
      if (ready && now.queue[now.index] === current) pushNowPlaying();
    });
  };
  const pushQueue = () => {
    const { queue, index, source } = usePlayerStore.getState();
    // The queue holds the station, not what it happens to be playing.
    const favorites = favoriteIds();
    setQueue(
      queue.map((s) => toCarTrack(s, null, favorites)),
      index,
      source ?? undefined,
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
    const { isPlaying, positionSec, shuffle, repeat, playbackError } = usePlayerStore.getState();
    told = { at: Date.now(), positionSec, isPlaying };
    setPlaybackState({
      isPlaying,
      positionMs: Math.round(positionSec * 1000),
      shuffle,
      repeatMode: repeat,
      // Left out rather than sent as null: a null crosses as the four letters
      // of "null" on the other side (see `setPlaybackState` in CarAutoModule).
      error: playbackError ?? undefined,
    });
  };
  const positionDrifted = () => {
    const { positionSec } = usePlayerStore.getState();
    const expected = told.isPlaying
      ? told.positionSec + (Date.now() - told.at) / 1000
      : told.positionSec;
    return Math.abs(positionSec - expected) > POSITION_DRIFT_SEC;
  };
  // Only with a song in hand. At start the queue is always empty, and the
  // car's player is either empty too or showing the song whose tap started
  // this runtime (`applyTappedItem`): "nothing playing" over that would blank
  // the car until the song is fetched and started. The queue coming back, or
  // the tap resolving, is a change below and gets pushed as one.
  if (usePlayerStore.getState().queue.length > 0) {
    pushNowPlaying();
    pushQueue();
    pushState();
  }

  // A song favourited on the phone, or from the car a moment ago: the heart
  // the car draws comes from this list, so it is redrawn whenever the list is.
  // Both pushes, since the heart hangs on the current track and the queue rows
  // carry their own.
  queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== 'starred') return;
    if (usePlayerStore.getState().queue.length === 0) return;
    pushNowPlaying();
    pushQueue();
  });

  usePlayerStore.subscribe((state, prev) => {
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
        state.repeat !== prev.repeat ||
        state.playbackError !== prev.playbackError)
    ) {
      pushState();
    }
  });
  // A seek, a stall, a speed other than 1: whatever leaves the car's count
  // behind is caught here, and nothing else costs it a push.
  setInterval(() => {
    if (positionDrifted()) pushState();
  }, POSITION_PUSH_MS);

  // ── Events from the car ──
  // Each waits for the profile first. A tap can be what started this runtime,
  // and then it arrives before the session is back; with the app already up
  // the wait is nothing, and the events keep their order through it.
  onPlay((e) => {
    void whenProfileReady().then(() => {
      // Something is playing from the car, so the wait no longer applies: fill
      // the tree in now rather than at the end of the delay.
      scheduleDeep(0);
      return handleBrowsePlay(e.mediaId, e.parentId);
    });
  });
  // The car's search box. The native side has searched the tree it holds and
  // sends what it found along with the words, since the library itself can
  // only be reached from here; the two are laid out as one answer and handed
  // back. The car is waiting on it, with a few seconds' patience and the
  // tree's own hits to fall back on, so nothing is added to the wait but the
  // profile, which is instant with the app up.
  onCarSearch((e) => {
    void whenProfileReady()
      .then(() => carSearch(e.query, e.local))
      .then((nodes) => setSearchResults(e.query, nodes))
      .catch(() => setSearchResults(e.query, e.local));
  });

  onTransport((e) => {
    // One count per button pressed in the car, so a report says what was
    // asked for out there. Everything below this line happens with the app in
    // the background, and the only other record of it is whatever the player
    // ends up doing.
    bump(`car · ${e.action}`);
    void whenProfileReady()
      // The saved queue comes back after the profile, and a button pressed
      // on a runtime the car just started has nothing to act on until it
      // has: play with an empty queue is nothing.
      .then(() => waitFor(usePlayerStore, (s) => s.queue.length > 0, QUEUE_WAIT_MS))
      .then(() => applyTransport(e));
  });
}
