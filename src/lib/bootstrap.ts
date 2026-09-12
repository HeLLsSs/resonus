/**
 * Everything the app does on its way up, with no screen in it.
 *
 * All of this used to live in effects of the root layout, which meant it only
 * ran once React had a tree to mount, and React only has one once an Activity
 * asks for it. The car, the widget and another app's broadcast can now start
 * the JavaScript runtime on their own (`JsRuntime.kt`, one per native module):
 * the bundle runs, the modules come up, and nothing draws. Left in effects,
 * none of this happened, and a song tapped on the car's screen with the phone
 * asleep in a pocket was handed to a runtime that had no session, no settings
 * and no queue.
 *
 * So it is plain functions, called from `index.js` as the runtime starts. The
 * layout keeps what is about drawing and reads the stores these fill in.
 */
import { removeLegacyRadioCovers } from '@/lib/legacyRadioCovers';
import { startPerfLog } from '@/lib/perfLog';
import { queryClient } from '@/lib/query';
import { primaryUrl } from '@/lib/serverUrls';
import { startCarAutoSync } from '@/lib/carAutoSync';
import { startIntentsApi } from '@/lib/intentsApi';
import { startNavifindWatch } from '@/lib/navifindWatch';
import { startWidgetSync } from '@/lib/widgetSync';
import { useAuthStore } from '@/store/auth';
import { useAutoDownloads } from '@/store/autoDownloads';
import { checkAutoUrlNow, initAutoUrl } from '@/store/autoUrl';
import { anyDownloads, useDownloads } from '@/store/downloads';
import { useEqualizer } from '@/store/equalizer';
import { useLastPlayed } from '@/store/lastPlayed';
import { useLibraries } from '@/store/libraries';
import { useLibraryMirror } from '@/store/libraryMirror';
import { initNetworkType } from '@/store/networkType';
import { useOfflineQueue } from '@/store/offlineQueue';
import { usePins } from '@/store/pins';
import { usePlayCounts } from '@/store/playCounts';
import { initRemoteIntegration, usePlayerStore } from '@/store/player';
import { hydratePlayCache } from '@/store/playCache';
import { usePlayHistory } from '@/store/playHistory';
import { useRecentSearches } from '@/store/recentSearches';
import { useSettings } from '@/store/settings';
import { useSmartPlaylists } from '@/store/smartPlaylists';
import { useSortPrefs } from '@/store/sortPrefs';

/** How long the offline copy of the library waits before being read, when the
 *  app has a server and nothing is going to ask for it yet. */
const MIRROR_DELAY_MS = 15_000;

/** The auth store's state, which the store keeps to itself as a type. */
type AuthState = ReturnType<typeof useAuthStore.getState>;

/** Once per runtime, however many times the start is asked for: the Activity
 *  may arrive long after the car did, and neither knows about the other. */
let started = false;

/**
 * What names the profile whose things are in memory. The profile's own name
 * and not the active URL: switching networks changes that URL while the
 * profile stays the same, and reading everything again would be for nothing.
 */
function profileKey(state: AuthState): string {
  const { auth, offline } = state;
  return auth ? `${primaryUrl(auth)}|${auth.username}` : offline ? 'offline' : '';
}

/** A profile far enough along to play something: an account, or offline with
 *  a source or downloads to play from. The layout's own test for a session. */
function playable(state: AuthState): boolean {
  return !!state.auth || (state.offline && (!!state.offlineSource || anyDownloads(useDownloads.getState())));
}

/**
 * Only what belongs to the phone rather than to whoever is signed in: the
 * equaliser, the network watcher, the remote control, the measuring.
 *
 * Apart from what the profile reads, which is below, because reading a
 * profile's settings before its session is restored gives back factory
 * defaults.
 */
function startOnce(): void {
  // Before anything else, so the first seconds count too.
  startPerfLog();
  void removeLegacyRadioCovers();
  // Equalizer: reads device capabilities and applies saved settings. Not the
  // profile's: it belongs to the phone and its output.
  void useEqualizer.getState().hydrate();
  initNetworkType();
  // Server URL switching on network change (profiles with multiple URLs).
  initAutoUrl();
  initRemoteIntegration();
  // Control from other apps (Tasker and the like, docs/INTENTS.md): the
  // phone's too, and its commands wait for the profile on their own.
  startIntentsApi();
  // Word from the Navifind proxy once what it was asked to fetch is in.
  startNavifindWatch();
}

/**
 * Everything the profile owns: its downloads, its mirror, its libraries, its
 * server. Run at the start and again on every change of profile, which is
 * what the layout's effect keyed on the profile used to do.
 */
function loadProfile(): void {
  // Everything below is the profile's, and read under its own key: the
  // settings, what you searched, what you played, what you pinned. Read
  // before the session is restored they come back as factory defaults.
  const authReady = useAuthStore.getState().hydrate();
  void authReady.then(() => {
    useSettings.getState().hydrate();
    useRecentSearches.getState().hydrate();
    usePlayCounts.getState().hydrate();
    usePlayHistory.getState().hydrate();
    useSortPrefs.getState().hydrate();
    void useLastPlayed.getState().hydrate();
    void usePins.getState().hydrate();
    void useAutoDownloads.getState().hydrate();
    void useSmartPlaylists.getState().hydrate();
    // What earlier listening kept, so the player can reach for it instead of
    // the network from the first song.
    void hydratePlayCache();
  });
  // After the session is restored, never before: the downloads store reads
  // the account's own catalog, and with no account yet it falls back to
  // reading every one of them, which is both slow and wrong (#50).
  const downloadsReady = authReady.then(() => useDownloads.getState().hydrate());
  // Mirror + outbox for offline. Offline it is the library, so it is opened
  // right away: a query could otherwise resolve before it is readable and
  // stay empty until manually reloaded. Online nothing reads it, only writes
  // to it, so it waits.
  //
  // The wait was written for the mirror that was one JSON file, where opening
  // it meant parsing tens of MB on the JS thread in the middle of the cold
  // start, which is where the app was left showing placeholders (#50). It has
  // been SQLite since 0.6.0 and opening it is cheap, but the first open after
  // upgrading still migrates whatever JSON is on disk, and that one is as
  // expensive as it ever was (see `migrateFromJson`).
  const startMirror = () =>
    Promise.all([useLibraryMirror.getState().load(), useOfflineQueue.getState().load()]).then(() => {
      if (useAuthStore.getState().offline) {
        void queryClient.invalidateQueries({ queryKey: ['playlists'] });
        void queryClient.invalidateQueries({ queryKey: ['starred'] });
      }
    });
  const mirrorReady = useAuthStore.getState().offline
    ? startMirror()
    : new Promise<void>((resolve) => setTimeout(() => resolve(startMirror()), MIRROR_DELAY_MS));
  // Clearing out a mirror grown before there was a rule for what belongs in
  // it. After the downloads, never before: an album whose songs are on disk
  // is worth keeping, and until they're hydrated it doesn't look like it.
  void Promise.all([downloadsReady, mirrorReady]).then(() => {
    useLibraryMirror.getState().prune(useDownloads.getState());
  });
  // The server may be a different one, so where it answers is asked again.
  checkAutoUrlNow();
  // Libraries: hydrates the saved filter and refreshes the server list.
  void useLibraries
    .getState()
    .hydrate()
    .then(() => {
      const current = useAuthStore.getState().auth;
      if (current) void useLibraries.getState().load(current);
    });
}

/** Reads the profile in, now and on every change of profile from here on. */
function watchProfile(): void {
  let current = profileKey(useAuthStore.getState());
  loadProfile();
  useAuthStore.subscribe((state) => {
    const next = profileKey(state);
    if (next === current) return;
    current = next;
    loadProfile();
  });
}

/**
 * Resumes the saved queue, without playing it: first the device copy, then
 * the server's if there is none.
 *
 * Never before the downloads are in memory: a server profile is ready as soon
 * as the session is restored, which is earlier, and offline a queue loaded
 * against an empty map looks like nothing in it was downloaded. Nor before
 * the settings, which say whether a title from the proxy is read with its
 * source or without. Once per profile, since three stores settle in whatever
 * order they finish in and a queue restored twice is the second one winning.
 */
function watchQueueRestore(): void {
  let done: string | null = null;
  const check = () => {
    const auth = useAuthStore.getState();
    if (!playable(auth) || !useDownloads.getState().hydrated || !useSettings.getState().hydrated) return;
    const key = profileKey(auth);
    if (key === done) return;
    done = key;
    void usePlayerStore.getState().restoreQueue();
  };
  check();
  useAuthStore.subscribe(check);
  useDownloads.subscribe(check);
  useSettings.subscribe(check);
}

/** The whole of the above, in the order it has to happen. Safe to call again:
 *  the Activity's own start finds it done. */
export function startApp(): void {
  if (started) return;
  started = true;
  startOnce();
  watchProfile();
  watchQueueRestore();
  startCarAutoSync();
  startWidgetSync();
}
