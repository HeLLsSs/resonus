/**
 * Rewrites the system's deep links before expo-router gets to resolve them.
 *
 * react-native-track-player opens the app, on notification tap, with the link
 * `trackplayer://notification.click` (and `trackplayer://service-bound` when
 * binding the service). Those routes don't exist and would show "Unmatched
 * Route", so the notification tap is routed to the player.
 *
 * `resonuls://play/album/<id>` (and `playlist`, `artist`) is the link for a
 * home-screen shortcut or an NFC tag on a record sleeve: open the app and play
 * that, no tap needed. There is no `/play` screen either; the link becomes the
 * ordinary screen with `?play=1`, and the screen starts playing once its songs
 * have loaded, which is the one place that knows when that is.
 *
 * `resonuls://play/random`, `play/favorites` and `play/resume` are the launcher
 * shortcuts (plugins/withShortcuts.js). Those are actions with no screen of
 * their own: the link lands on the player, and the action runs once the
 * stores are back.
 */
import { type StoreApi } from 'zustand';

// With or without the scheme in front: what arrives here for
// `resonuls://play/random` is the whole link, `play` being read as its host,
// and a path alone comes from the router's own handling.
const PLAY_LINK = /^(?:[a-z]+:\/\/)?\/?play\/(album|playlist|artist)\/([^/?#]+)/;
const ACTION_LINK = /^(?:[a-z]+:\/\/)?\/?play\/(random|favorites|resume)(?:[/?#]|$)/;

/**
 * How long an action on a cold start waits for the saved queue to come back
 * before going ahead without it: `resume` with nothing restored yet is
 * nothing, and a new queue started under the restore would be replaced by it.
 * Same as the pending commands in src/lib/intentsApi.ts.
 */
const QUEUE_WAIT_MS = 8_000;

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    if (path.includes('notification.click')) return '/player';
    // Other internal RNTP intents: to the main screen instead of failing.
    if (path.includes('trackplayer://')) return '/';
    const action = ACTION_LINK.exec(path);
    if (action) {
      runAction(action[1], initial).catch((e) => console.warn(`[shortcut] ${action[1]} failed`, e));
      // Somewhere to land: the router walks whatever comes back from here,
      // and a bare `play/random` is not a screen. The player is where the
      // music this link starts is going to be.
      return '/player';
    }
    const play = PLAY_LINK.exec(path);
    if (play) return `/${play[1]}/${play[2]}?play=1`;
    return path;
  } catch {
    return '/';
  }
}

/**
 * Runs a shortcut's action. The stores are imported here rather than at the
 * top: this file is loaded with the routes, before the root layout, and the
 * player store brings half the app with it.
 *
 * On a cold start the profile is restored first (everything asks the server
 * for something) and then the saved queue, which the root layout starts once
 * the session is ready; started warm, both are already there and nothing waits.
 */
async function runAction(name: string, initial: boolean): Promise<void> {
  const [{ useAuthStore }, { SOURCE_FAVORITES, usePlayerStore }] = await Promise.all([
    import('@/store/auth'),
    import('@/store/player'),
  ]);
  await waitFor(useAuthStore, (s) => !s.hydrating);
  if (initial) await waitFor(usePlayerStore, (s) => s.queue.length > 0, QUEUE_WAIT_MS);
  const player = usePlayerStore.getState();
  if (name === 'random') {
    const { playShuffle } = await import('@/lib/playShuffle');
    await playShuffle();
  } else if (name === 'favorites') {
    const { getStarred } = await import('@/api/data');
    const { songs } = await getStarred();
    if (songs.length === 0) return;
    await player.playQueue(songs, 0, SOURCE_FAVORITES, '/favorites', { shuffled: true });
  } else if (player.queue.length > 0) {
    // The one press that does not change track: what is there plays on.
    if (!player.isPlaying) player.toggle();
  } else {
    // Nothing in the queue: the last one put away comes back, the way the
    // past queues screen brings it back.
    const [{ useQueueHistory }, { getSongsByIds }] = await Promise.all([
      import('@/store/queueHistory'),
      import('@/api/data'),
    ]);
    await useQueueHistory.getState().hydrate();
    const past = useQueueHistory.getState().queues[0];
    if (!past) return;
    const songs = await getSongsByIds(past.songIds);
    if (songs.length === 0) return;
    const at = Math.max(
      0,
      songs.findIndex((s) => s.id === past.songIds[past.index]),
    );
    await player.playQueue(songs, at, past.title);
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
