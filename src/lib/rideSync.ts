/**
 * What ride mode does, once the native module has said what it hears.
 *
 * Started once per runtime from `bootstrap`, with no screen: the intercom
 * connecting with the app closed starts the runtime itself (see
 * `IntercomReceiver.kt` in modules/ride-mode), and the note it leaves is
 * found here. On platforms without the module it is a no-op, and the ride
 * screen, which anybody can open by hand, turns ride mode on and off on its
 * own through `activateRide` and `deactivateRide`.
 *
 * Ride mode on means: the music dips under other apps' prompts instead of
 * pausing, the floating player is up over whatever app is in front (when
 * asked for and allowed), and every new song is read out in the helmet
 * (when asked for). Started by the intercom it also says so, brings the
 * ride screen up and, when asked, starts the queue again.
 */
import { AppState } from 'react-native';

import { getStarred } from '@/api/data';
import { tg } from '@/i18n';
import { playForYou } from '@/lib/forYouMix';
import { playShuffle } from '@/lib/playShuffle';
import {
  announcement,
  canDrawOverlays,
  hideRideOverlay,
  onIntercom,
  onRideAction,
  openNavigationApp,
  openRideScreen,
  rideModeAvailable,
  setRideActive,
  setShowWhenLocked,
  showRideOverlay,
  speak,
  stopSpeaking,
  takePendingIntercom,
  updateRideOverlay,
  type RideOverlayState,
} from '@/lib/rideMode';
import { pushOnce } from '@/lib/pushOnce';
import { waitFor, whenProfileReady } from '@/lib/storeWait';
import { setVolumeLevel } from '@/lib/volumeLevel';
import { currentSong, setDuckOthers, SOURCE_FAVORITES, usePlayerStore } from '@/store/player';
import { useRideMode } from '@/store/rideMode';

/**
 * How long a lost intercom is given to come back before ride mode stops:
 * a helmet intercom drops the link for a moment now and then, and the
 * overlay going away and coming back at every blink would be worse than
 * either.
 */
const RECONNECT_GRACE_MS = 15_000;

/** How long the resume waits for the saved queue to come back. The same wait the widget's play makes. */
const QUEUE_WAIT_MS = 8_000;

/** Once per runtime, however many times the start is asked for. */
let started = false;

/** Whether the floating player is up, so it is only updated while it is. */
let overlayShown = false;

/** The song last read out, so a pause and a resume do not read it again. */
let announced = '';

let lostTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Puts the floating player up or takes it down, to match: ride mode on,
 * asked for and allowed, and another app in front. Over the app's own
 * screens it would only cover the buttons that do the same thing, so it
 * goes when the app comes to the front and comes back when it leaves.
 */
function syncOverlay(): void {
  const { active, config } = useRideMode.getState();
  const wanted = active && config.overlay && AppState.currentState !== 'active' && canDrawOverlays();
  if (wanted === overlayShown) return;
  overlayShown = wanted;
  if (wanted) showRideOverlay(overlayState());
  else hideRideOverlay();
}

function overlayState(): RideOverlayState {
  const state = usePlayerStore.getState();
  const song = currentSong(state);
  const live = song?.url ? state.streamInfo : null;
  return {
    title: live?.title ?? song?.title ?? '',
    isPlaying: state.isPlaying,
  };
}

/**
 * Starts whatever the saved queue holds, once it holds something: the
 * intercom may be what started this runtime, and the queue is still on its
 * way back from disk. Nothing there after the wait, and the setting says
 * what to start instead, if anything: the mix built from what this phone
 * plays, the favourites, or the whole library in random order.
 */
async function resumeSaved(): Promise<void> {
  await waitFor(usePlayerStore, (s) => s.queue.length > 0, QUEUE_WAIT_MS);
  const state = usePlayerStore.getState();
  if (state.isPlaying) return;
  if (state.queue.length > 0) {
    state.toggle();
    return;
  }
  const { emptyQueue } = useRideMode.getState().config;
  if (emptyQueue === 'foryou') {
    await playForYou();
  } else if (emptyQueue === 'favorites') {
    const { songs } = await getStarred();
    if (songs.length > 0) await state.playQueue(songs, 0, SOURCE_FAVORITES, '/favorites', { shuffled: true });
  } else if (emptyQueue === 'random') {
    await playShuffle();
  }
}

/**
 * Turns ride mode on. From the ride screen (`manual`) that is all it does;
 * from the intercom, or a command from another app, it also says so, brings
 * the screen up over whatever is in front, the navigation app over that
 * when one is chosen, and starts the music again when asked to.
 */
export async function activateRide(from: 'intercom' | 'intent' | 'manual'): Promise<void> {
  const { active, config } = useRideMode.getState();
  if (active) return;
  useRideMode.setState({ active: true });
  setRideActive(true);
  setDuckOthers(true);
  // A phone locked in a pocket: the ride screen is worth nothing behind the
  // lock screen. Every screen of the app is reachable that way while ride
  // mode is on, which is the point of it and stops with it.
  setShowWhenLocked(true);
  syncOverlay();
  if (from === 'manual') return;
  // The phone's media volume, left low from the kitchen: set before anything
  // is said, so the word is heard at the level the music will be.
  if (config.startVolume > 0) setVolumeLevel(config.startVolume);
  if (config.announce) speak(tg('Ride mode'));
  // The app in front navigates itself; from behind another app, or with no
  // screen at all, the module brings it up, which Android allows to an app
  // that may draw over others (the same permission the overlay has). The
  // navigation app comes last, so it is what ends up in front, with the
  // floating player over it.
  if (AppState.currentState === 'active') pushOnce('/ride');
  else openRideScreen();
  if (config.navigationApp) openNavigationApp(config.navigationApp);
  if (config.resume) await resumeSaved();
}

/** Turns ride mode off: the overlay down, the voice quiet, the music back to pausing for prompts. */
export function deactivateRide(): void {
  if (lostTimer) clearTimeout(lostTimer);
  lostTimer = undefined;
  if (!useRideMode.getState().active) return;
  useRideMode.setState({ active: false });
  setRideActive(false);
  setDuckOthers(false);
  setShowWhenLocked(false);
  syncOverlay();
  stopSpeaking();
  announced = '';
}

async function intercomConnected(): Promise<void> {
  if (lostTimer) clearTimeout(lostTimer);
  lostTimer = undefined;
  if (useRideMode.getState().active) return;
  // The connection can be what started this runtime: the profile, and the
  // settings that say what to do, are still coming back from disk.
  await whenProfileReady();
  await activateRide('intercom');
}

function intercomLost(): void {
  if (lostTimer) clearTimeout(lostTimer);
  lostTimer = setTimeout(deactivateRide, RECONNECT_GRACE_MS);
}

/** Reads out the song now playing, unless it was the last one read out. */
function announceCurrent(): void {
  const state = usePlayerStore.getState();
  const song = currentSong(state);
  if (!song || !state.isPlaying) return;
  const live = song.url ? state.streamInfo : null;
  const key = `${song.id}|${live?.title ?? ''}`;
  if (key === announced) return;
  const text = announcement(song, live);
  if (!text) return;
  announced = key;
  speak(text);
}

export function startRideSync(): void {
  if (!rideModeAvailable || started) return;
  started = true;
  useRideMode.getState().hydrate();

  onIntercom(({ connected, source }) => {
    if (connected) void intercomConnected();
    // The tile asks for a stop now; a lost intercom gets its grace period.
    else if (source === 'tile') deactivateRide();
    else intercomLost();
  });
  // The connection that started this runtime, or arrived before it listened.
  if (takePendingIntercom()) void intercomConnected();

  AppState.addEventListener('change', syncOverlay);
  // The switch flipped in the settings while ride mode is on. A change of
  // size takes the pill down: the size is read as it is made, and it is
  // made again the next time another app is in front.
  useRideMode.subscribe((state, prev) => {
    if (state.config.overlay !== prev.config.overlay) syncOverlay();
    if (state.config.overlaySize !== prev.config.overlaySize && overlayShown) {
      overlayShown = false;
      hideRideOverlay();
      syncOverlay();
    }
  });

  onRideAction((action) => {
    const player = usePlayerStore.getState();
    if (action === 'toggle') player.toggle();
    else if (action === 'next') player.next();
    else if (action === 'previous') player.previous();
  });

  usePlayerStore.subscribe((state, prev) => {
    if (!useRideMode.getState().active) return;
    const changed =
      state.queue !== prev.queue ||
      state.index !== prev.index ||
      state.isPlaying !== prev.isPlaying ||
      state.streamInfo !== prev.streamInfo;
    if (!changed) return;
    if (overlayShown) updateRideOverlay(overlayState());
    if (useRideMode.getState().config.announce) announceCurrent();
  });
}
