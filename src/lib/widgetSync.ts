/**
 * Keeps the Android home-screen widget showing what is playing: title,
 * artist, cover, whether it is playing and the next few songs of the queue,
 * pushed to the native module at every change. The widget's buttons do not
 * come back through here: they talk to the media session on their own (see
 * modules/home-widget). Its queue rows do, since the session has no key for
 * "that one": a tap arrives as a jump, live or left as a note while the app
 * was closed, and lands in the store once the queue holds the song.
 *
 * Started once per runtime from `bootstrap`, with no screen: a row tapped on
 * a phone whose app is not running starts the runtime itself (see
 * `JsRuntime.kt` in modules/home-widget), and there is no Activity behind it
 * to mount anything. On platforms without the native module it is a no-op.
 */
import { CACHED_COVER, COVER, songCoverUrl } from '@/api/data';
import { carCoverUrl, knownCarCover, warmCarCover } from '@/lib/carAutoTree';
import {
  HOME_WIDGET_UPCOMING,
  homeWidgetAvailable,
  onHomeWidgetJump,
  onHomeWidgetPlay,
  takePendingHomeWidgetJump,
  takePendingHomeWidgetPlay,
  updateHomeWidget,
  type HomeWidgetJump,
} from '@/lib/homeWidget';
import { waitFor, whenProfileReady } from '@/lib/storeWait';
import { usePlayerStore } from '@/store/player';

/** What was last handed over, so a store update that changes nothing the
 *  widget shows costs nothing native. */
let lastPushed = '';

/** Once per runtime, however many times the start is asked for. */
let started = false;

/** How long a note left by the closed app is worth acting on: past this the
 *  queue it named is not coming back. */
const PENDING_JUMP_MS = 60_000;

/** How long a tapped row waits for the saved queue to come back before it is
 *  given up on. The same wait the car's buttons make. */
const QUEUE_WAIT_MS = 8_000;

/**
 * Starts whatever the saved queue holds, once it holds something. What play
 * on the widget means when no session was there to take the key: the press
 * may be what started this runtime, so the profile and then the queue are
 * waited for.
 */
async function startSaved(): Promise<void> {
  await whenProfileReady();
  await waitFor(usePlayerStore, (s) => s.queue.length > 0, QUEUE_WAIT_MS);
  const state = usePlayerStore.getState();
  if (!state.isPlaying && state.queue.length > 0) state.toggle();
}

/**
 * Plays the song the row showed. By its place in the queue when the queue
 * still has it there, else wherever it is now, and not at all when it is
 * gone: the widget's picture can be a step behind the store.
 */
function applyJump(jump: HomeWidgetJump): boolean {
  const { queue, jumpTo } = usePlayerStore.getState();
  const at = queue[jump.index]?.id === jump.id ? jump.index : queue.findIndex((s) => s.id === jump.id);
  if (at < 0) return false;
  jumpTo(at);
  return true;
}

export function startWidgetSync(): void {
  if (!homeWidgetAvailable || started) return;
  started = true;

  // No timer between the store and the push: Android freezes JavaScript
  // timers while the app is in the background, which is exactly where the
  // widget is looked at, and a debounce made of one left the widget showing
  // the song before last until the app came back to the front. The push is
  // cheap enough to make on every change and skipped when nothing shown
  // would change.
  const push = () => {
    const { queue, index, isPlaying, streamInfo } = usePlayerStore.getState();
    const song = queue[index];
    let next: Parameters<typeof updateHomeWidget>[0];
    if (!song) {
      next = { isPlaying: false };
    } else {
      // A radio names what it is playing itself; the station is the queue item.
      const live = song.url ? streamInfo : null;
      const cover = carCoverUrl(songCoverUrl(song, COVER.card));
      next = {
        title: live?.title ?? song.title ?? undefined,
        artist: live?.artist ?? song.artist ?? undefined,
        // A cover the widget cannot fetch itself, offline or behind a server
        // that wants headers, goes as the cached file when there is one, and
        // as nothing until `warmCarCover` has fetched it (see below).
        artworkUrl: (cover?.startsWith(CACHED_COVER) ? knownCarCover(cover) : cover) || undefined,
        isPlaying,
        index,
        // Only what the tall widget draws: a queue of a thousand songs is
        // not carried over the bridge for three rows.
        upcoming: queue.slice(index + 1, index + 1 + HOME_WIDGET_UPCOMING).map((s) => ({
          id: s.id,
          title: s.title,
          artist: s.artist,
        })),
      };
    }
    const key = JSON.stringify(next);
    if (key === lastPushed) return;
    lastPushed = key;
    updateHomeWidget(next);
    if (!song || next.artworkUrl) return;
    // Pushed again once the picture is on the phone, if it is still the song.
    void warmCarCover(carCoverUrl(songCoverUrl(song, COVER.card))).then((ready) => {
      const now = usePlayerStore.getState();
      if (ready && now.queue[now.index] === song) push();
    });
  };

  // A row tapped while the app was closed: the app was opened on it, or the
  // runtime was started behind it, and the queue is on its way back from
  // storage or the server. Tried at every queue change until the song shows
  // up or the note is too old.
  let pending = takePendingHomeWidgetJump();
  const pendingUntil = Date.now() + PENDING_JUMP_MS;
  const settlePending = () => {
    if (!pending) return;
    if (Date.now() > pendingUntil || applyJump(pending)) pending = null;
  };

  // Not before there is something to show: on a runtime the widget itself
  // started, the queue is still coming back, and a push now would blank the
  // widget the user is looking at and fill it in again a second later.
  if (usePlayerStore.getState().queue.length > 0) push();
  settlePending();

  // Play pressed on a phone whose app was not running: the key reached no
  // session, so the press was left as a note and this runtime started for it.
  // Whatever the saved queue turns out to hold is what it starts.
  if (takePendingHomeWidgetPlay()) void startSaved();
  // Play pressed live, with JS up but nothing sounding: the media session
  // was not there to take the key, so it arrives here instead.
  onHomeWidgetPlay(() => {
    void startSaved();
  });
  onHomeWidgetJump((jump) => {
    // Like the car's buttons: a tap can be what started this runtime, so the
    // profile and then the saved queue are waited for. With the app already
    // up both are settled and the jump lands at once.
    void whenProfileReady()
      .then(() => waitFor(usePlayerStore, (s) => s.queue.length > 0, QUEUE_WAIT_MS))
      .then(() => applyJump(jump));
  });
  usePlayerStore.subscribe((state, prev) => {
    if (state.queue !== prev.queue) settlePending();
    if (
      state.queue !== prev.queue ||
      state.index !== prev.index ||
      state.isPlaying !== prev.isPlaying ||
      state.streamInfo !== prev.streamInfo
    ) {
      push();
    }
  });
}
