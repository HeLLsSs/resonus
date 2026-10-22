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
 * (when asked for). Started by the intercom it also says so, with the
 * battery, the output and what is left of the queue after it (when asked
 * for), brings the ride screen up and, when asked, starts the queue again.
 * With **Volume with the speed** on, the media volume also rises over the
 * rider's own level as the bike goes faster, from the GPS (see `syncSpeed`).
 *
 * Car mode is the same start without the ride screen: a car connecting
 * sets its own volume, brings its own navigation app up, says hello and
 * starts the music, each as `RideConfig.car` says, and the songs are read
 * out and the music ducks while it is on. Ride mode, when both are on, is
 * the one whose settings count.
 *
 * The preparation of the ride on its own, which has nothing to do with
 * ride mode being on, is started from here too (`startAutoPrepare` in
 * `lib/ridePrepare.ts`).
 */
import { AppState } from 'react-native';

import { getStarred } from '@/api/data';
import { tg } from '@/i18n';
import { driveLog, driveLogWithAudio } from '@/lib/driveLog';
import { playForYou } from '@/lib/forYouMix';
import { playShuffle } from '@/lib/playShuffle';
import {
  announcement,
  canDrawOverlays,
  hideModeNotice,
  hideRideOverlay,
  isAndroidAutoConnected,
  nextSpeedSteps,
  onBattery,
  onCall,
  onIntercom,
  onRideAction,
  onSpeed,
  openNavigationApp,
  openRideScreen,
  rideModeAvailable,
  setRideActive,
  setShowWhenLocked,
  showModeNotice,
  showRideOverlay,
  smoothSpeed,
  speak,
  speedOffset,
  stopSpeaking,
  takePendingIntercom,
  updateRideOverlay,
  watchSpeed,
  type DriveConfig,
  type DriveKind,
  type EmptyQueueAction,
  type RideOverlayState,
} from '@/lib/rideMode';
import { startAutoPrepare } from '@/lib/ridePrepare';
import { pushOnce } from '@/lib/pushOnce';
import { rideStatus, statusSentence } from '@/lib/rideVoice';
import { waitFor, whenProfileReady } from '@/lib/storeWait';
import { onVolumeLevelChanged, setVolumeLevel, volumeLevel, volumeStep } from '@/lib/volumeLevel';
import { currentSong, setDuckOthers, SOURCE_FAVORITES, usePlayerStore } from '@/store/player';
import { useRideMode } from '@/store/rideMode';

/**
 * How long a lost intercom or car is given to come back before its mode stops:
 * a helmet intercom drops the link for a moment now and then, and the
 * overlay going away and coming back at every blink would be worse than
 * either.
 */
const RECONNECT_GRACE_MS = 15_000;

/** How long the resume waits for the saved queue to come back. The same wait the widget's play makes. */
const QUEUE_WAIT_MS = 8_000;

/**
 * How long the status read out at the start waits for the saved queue, so
 * what it says is left of the queue is not "nothing" because the queue was
 * still on its way back from disk. Shorter than the resume's wait: a
 * greeting that comes late is worse than a count that is off.
 */
const STATUS_QUEUE_WAIT_MS = 3_000;

/** Once per runtime, however many times the start is asked for. */
let started = false;

/** Whether the floating player is up, so it is only updated while it is. */
let overlayShown = false;

/** The song last read out, so a pause and a resume do not read it again. */
let announced = '';

const lostTimers: Partial<Record<DriveKind, ReturnType<typeof setTimeout>>> = {};

/** Whether an intercom, or a car, is connected right now, as the last connection or loss said. */
const connected: Record<DriveKind, boolean> = { ride: false, car: false };

/** What started each mode that is on, for the notification: a device's name, or the tile. */
const startedBy: Partial<Record<DriveKind, string>> = {};

/**
 * How long a car that just connected is watched for Android Auto before car
 * mode starts: wireless Android Auto comes up a few seconds after the
 * Bluetooth link. A car without it waits this long for its music, which is
 * about what its media link takes to come up anyway.
 */
const ANDROID_AUTO_SETTLE_MS = 10_000;

/** How often car mode looks again, while it is on, for Android Auto having come up late. */
const ANDROID_AUTO_RECHECK_MS = 15_000;

let androidAutoWatch: ReturnType<typeof setInterval> | undefined;

/**
 * How long ride mode started by hand, from the tile or another app stays on
 * with no intercom connected. Nothing else turns it off: started on the
 * bike's stand and forgotten, it would go on ducking the music and reading
 * songs out in the car for days.
 */
const RIDE_UNATTENDED_MS = 3 * 60 * 60 * 1000;

let rideUnattended: ReturnType<typeof setTimeout> | undefined;

/** Whether the music was going when a call came in, so it can be brought back after. */
let playingBeforeCall = false;

/**
 * How long after a call ends before the music is looked at: the phone
 * gives the audio focus back on its own, and the player follows a moment
 * later. Only when it has not is the music started again from here.
 */
const AFTER_CALL_MS = 2_500;

/** The battery levels read out, high to low, each once per ride while not charging. */
const BATTERY_WARNINGS = [20, 10, 5];

/** The levels already read out this ride. */
let batteryWarned = new Set<number>();

/** Whether the speed is being read for the volume. */
let speedWatched = false;

/** The speed, smoothed; null until the first reading of the ride. */
let speedKmh: number | null = null;

/** The whole volume steps the speed has added. */
let speedSteps = 0;

/**
 * The rider's own level, under what the speed adds, 0 to 1. Not held to
 * that range: turned all the way down at speed, it goes below 0 by what the
 * speed was adding, so slowing down keeps the music off instead of
 * bringing it back.
 */
let riderLevel = 0;

/** The level last set from here, to tell its echo from the rider's hand. */
let speedLevel = 0;

let stopVolumeWatch: (() => void) | undefined;

/**
 * Starts or stops the volume that follows the speed, to match: ride mode
 * on and the setting on. Started, the level as it is is the rider's own;
 * stopped, the phone goes back to it, without what the speed had added.
 */
function syncSpeed(): void {
  const { active, config } = useRideMode.getState();
  const wanted = active && config.speedVolume;
  if (wanted === speedWatched) return;
  speedWatched = wanted;
  watchSpeed(wanted);
  if (wanted) {
    speedKmh = null;
    speedSteps = 0;
    riderLevel = volumeLevel();
    speedLevel = riderLevel;
    stopVolumeWatch = onVolumeLevelChanged(riderMoved);
    return;
  }
  stopVolumeWatch?.();
  stopVolumeWatch = undefined;
  if (speedSteps > 0) setVolumeLevel(riderLevel);
  speedSteps = 0;
}

/**
 * A move of the level that this file did not make: the volume keys, the
 * ride screen's buttons, the start volume. It is the rider's say, so it is
 * kept, and what the speed adds goes on top of it from now on rather than
 * pulling it back.
 */
function riderMoved(level: number): void {
  if (Math.abs(level - speedLevel) < volumeStep() / 2) return;
  riderLevel += level - speedLevel;
  speedLevel = level;
}

/** A speed reading: the boost moved by a step when the smoothed speed is worth it. */
function speedRead(kmh: number): void {
  if (!speedWatched) return;
  speedKmh = smoothSpeed(speedKmh, kmh);
  const steps = nextSpeedSteps(speedSteps, speedOffset(speedKmh, useRideMode.getState().config.speedStrength));
  if (steps === speedSteps) return;
  speedSteps = steps;
  speedLevel = Math.max(0, Math.min(1, riderLevel + steps * volumeStep()));
  setVolumeLevel(speedLevel);
}

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
async function resumeSaved(emptyQueue: EmptyQueueAction): Promise<void> {
  await waitFor(usePlayerStore, (s) => s.queue.length > 0, QUEUE_WAIT_MS);
  const state = usePlayerStore.getState();
  if (state.isPlaying) return;
  if (state.queue.length > 0) {
    state.toggle();
    return;
  }
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
  batteryWarned = new Set();
  driveLogWithAudio(`ride mode on (${from})`);
  clearTimeout(rideUnattended);
  if (from !== 'intercom') {
    rideUnattended = setTimeout(() => {
      if (connected.ride) return;
      driveLog('ride mode off: on for hours with no intercom');
      deactivateRide();
    }, RIDE_UNATTENDED_MS);
  }
  // A phone locked in a pocket: the ride screen is worth nothing behind the
  // lock screen. Every screen of the app is reachable that way while ride
  // mode is on, which is the point of it and stops with it.
  setShowWhenLocked(true);
  syncOverlay();
  if (from === 'manual') return;
  // The phone's media volume, left low from the kitchen: set before anything
  // is said, so the word is heard at the level the music will be.
  if (config.startVolume > 0) setVolumeLevel(config.startVolume);
  // The app in front navigates itself; from behind another app, or with no
  // screen at all, the module brings it up, which Android allows to an app
  // that may draw over others (the same permission the overlay has). The
  // navigation app comes last, so it is what ends up in front, with the
  // floating player over it.
  if (AppState.currentState === 'active') pushOnce('/ride');
  else openRideScreen();
  if (config.navigationApp) openNavigationApp(config.navigationApp);
  await greetAndResume(config, tg('Ride mode'));
}

/**
 * The greeting and the status as one line: two lines would be the second
 * cutting the first short, or replacing it while the engine comes up. The
 * first song of the ride waits for it (see `announceCurrent`). Then the
 * music, when asked for.
 */
async function greetAndResume(settings: DriveConfig, name: string): Promise<void> {
  if (settings.status) await waitFor(usePlayerStore, (s) => s.queue.length > 0, STATUS_QUEUE_WAIT_MS);
  const greeting = [settings.announce ? name : '', settings.status ? statusSentence(rideStatus()) : ''];
  if (settings.announce || settings.status) speak(greeting.filter(Boolean).join('. '));
  if (settings.resume) await resumeSaved(settings.emptyQueue);
}

/** Turns ride mode off: the overlay down, the voice quiet, the music back to pausing for prompts. */
export function deactivateRide(): void {
  clearLost('ride');
  const { active, carActive } = useRideMode.getState();
  if (!active) return;
  useRideMode.setState({ active: false });
  setRideActive(false);
  setDuckOthers(carActive);
  clearTimeout(rideUnattended);
  driveLog('ride mode off');
  startedBy.ride = undefined;
  setShowWhenLocked(false);
  syncOverlay();
  stopSpeaking();
  announced = '';
}

/**
 * Turns car mode on, as the car connecting asks: the volume, the navigation
 * app, the greeting and the music, each as car mode's settings say. The app
 * stays where it is; the phone is on a mount, and its screens are fine.
 */
async function activateCar(): Promise<void> {
  const { carActive, config } = useRideMode.getState();
  if (carActive) return;
  useRideMode.setState({ carActive: true });
  setDuckOthers(true);
  batteryWarned = new Set();
  driveLogWithAudio('car mode on');
  const { car } = config;
  // Android Auto coming up after car mode started: car mode steps aside.
  if (car.notWithAndroidAuto) {
    androidAutoWatch = setInterval(() => {
      if (!isAndroidAutoConnected()) return;
      driveLog('car mode off: Android Auto came up');
      deactivateCar();
    }, ANDROID_AUTO_RECHECK_MS);
  }
  if (car.startVolume > 0) setVolumeLevel(car.startVolume);
  if (car.navigationApp) openNavigationApp(car.navigationApp);
  await greetAndResume(car, tg('Car mode'));
}

/** Turns car mode off, as the car leaving would, with no grace period: the settings screen's Stop. */
export function deactivateCar(): void {
  clearLost('car');
  const { active, carActive } = useRideMode.getState();
  if (!carActive) return;
  useRideMode.setState({ carActive: false });
  clearInterval(androidAutoWatch);
  androidAutoWatch = undefined;
  driveLog('car mode off');
  startedBy.car = undefined;
  if (active) return;
  setDuckOthers(false);
  stopSpeaking();
  announced = '';
}

function clearLost(kind: DriveKind): void {
  clearTimeout(lostTimers[kind]);
  delete lostTimers[kind];
}

async function deviceConnected(kind: DriveKind, name: string): Promise<void> {
  clearLost(kind);
  connected[kind] = true;
  startedBy[kind] = name;
  // The connection can be what started this runtime: the profile, and the
  // settings that say what to do, are still coming back from disk.
  await whenProfileReady();
  if (kind === 'ride') {
    clearTimeout(rideUnattended);
    await activateRide('intercom');
    return;
  }
  if (useRideMode.getState().config.car.notWithAndroidAuto && (await androidAutoWithin(ANDROID_AUTO_SETTLE_MS))) {
    driveLog('car mode left off: Android Auto is on');
    return;
  }
  // Gone again while Android Auto was being waited for.
  if (!connected.car) return;
  await activateCar();
}

/** Whether Android Auto is on, or comes up within `ms`; looked at once a second. */
async function androidAutoWithin(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (isAndroidAutoConnected()) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function deviceLost(kind: DriveKind): void {
  clearLost(kind);
  connected[kind] = false;
  lostTimers[kind] = setTimeout(kind === 'car' ? deactivateCar : deactivateRide, RECONNECT_GRACE_MS);
}

/**
 * The notification that says which mode is on, with its Stop button, or
 * none with neither on.
 */
function syncNotice(): void {
  const { active, carActive } = useRideMode.getState();
  if (!active && !carActive) {
    hideModeNotice();
    return;
  }
  const title =
    active && carActive ? tg('Ride mode and car mode are on') : active ? tg('Ride mode is on') : tg('Car mode is on');
  const by = (active ? startedBy.ride : startedBy.car) ?? '';
  showModeNotice(
    tg('Car mode and ride mode'),
    title,
    by ? tg('Started by {name}', { name: by }) : tg('Started by hand'),
    tg('Stop'),
  );
}

/** The settings of the mode that is on, ride mode first; null with neither on. */
function driving(): DriveConfig | null {
  const { active, carActive, config } = useRideMode.getState();
  return active ? config : carActive ? config.car : null;
}

/**
 * Reads out the song now playing, unless it was the last one read out. The
 * first song of a ride waits for the greeting and the status to be said;
 * any later one cuts whatever was still being said, since a song announced
 * after the next one has started is noise.
 */
function announceCurrent(): void {
  const state = usePlayerStore.getState();
  const song = currentSong(state);
  if (!song || !state.isPlaying) return;
  const live = song.url ? state.streamInfo : null;
  const key = `${song.id}|${live?.title ?? ''}`;
  if (key === announced) return;
  const text = announcement(song, live);
  if (!text) return;
  const first = announced === '';
  announced = key;
  speak(text, first);
}

export function startRideSync(): void {
  if (!rideModeAvailable || started) return;
  started = true;
  useRideMode.getState().hydrate();

  onIntercom(({ connected: on, name, source, kind }) => {
    // The notification's Stop: both modes off, now.
    if (kind === 'all') {
      deactivateRide();
      deactivateCar();
      return;
    }
    if (source === 'tile') {
      startedBy.ride = undefined;
      if (on) void activateRide('intent');
      else deactivateRide();
      return;
    }
    // A lost device gets its grace period.
    if (on) void deviceConnected(kind, name);
    else deviceLost(kind);
  });
  // The connection that started this runtime, or arrived before it listened.
  const pending = takePendingIntercom();
  if (pending?.source === 'tile') void activateRide('intent');
  else if (pending) void deviceConnected(pending.kind, pending.name);
  // A notification left by a runtime that ended with a mode on.
  hideModeNotice();

  AppState.addEventListener('change', syncOverlay);
  onSpeed(speedRead);
  startAutoPrepare();
  // A switch flipped in the settings while ride mode is on, or ride mode
  // itself turned on and off, which the speed follows. A change of
  // size takes the pill down: the size is read as it is made, and it is
  // made again the next time another app is in front.
  useRideMode.subscribe((state, prev) => {
    if (state.active !== prev.active || state.carActive !== prev.carActive) syncNotice();
    if (state.active !== prev.active || state.config.speedVolume !== prev.config.speedVolume) syncSpeed();
    if (state.config.overlay !== prev.config.overlay) syncOverlay();
    if (state.config.overlaySize !== prev.config.overlaySize && overlayShown) {
      overlayShown = false;
      hideRideOverlay();
      syncOverlay();
    }
  });

  // A call in the middle of the ride: what was playing comes back after,
  // when the phone has not brought it back itself.
  onCall((inCall) => {
    if (!driving()) return;
    driveLogWithAudio(inCall ? 'call started' : 'call ended');
    if (inCall) {
      playingBeforeCall = usePlayerStore.getState().isPlaying;
      return;
    }
    if (!playingBeforeCall) return;
    playingBeforeCall = false;
    setTimeout(() => {
      const state = usePlayerStore.getState();
      if (driving() && !state.isPlaying && state.queue.length > 0) state.toggle();
    }, AFTER_CALL_MS);
  });

  // The battery going down on a mount with no charger: said once at each
  // step, in the helmet, where the screen is not being looked at.
  onBattery(({ level, charging }) => {
    if (!driving()?.announce || charging) return;
    const step = BATTERY_WARNINGS.find((w) => level <= w && !batteryWarned.has(w));
    if (step === undefined) return;
    for (const w of BATTERY_WARNINGS) if (w >= step) batteryWarned.add(w);
    speak(tg('Battery at {n} %', { n: level }));
  });

  onRideAction((action) => {
    const player = usePlayerStore.getState();
    if (action === 'toggle') player.toggle();
    else if (action === 'next') player.next();
    else if (action === 'previous') player.previous();
  });

  usePlayerStore.subscribe((state, prev) => {
    const settings = driving();
    if (!settings) return;
    const changed =
      state.queue !== prev.queue ||
      state.index !== prev.index ||
      state.isPlaying !== prev.isPlaying ||
      state.streamInfo !== prev.streamInfo;
    if (!changed) return;
    if (overlayShown) updateRideOverlay(overlayState());
    if (settings.announce) announceCurrent();
  });
}
