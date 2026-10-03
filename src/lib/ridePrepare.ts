/**
 * "Prepare the ride": the next songs of the queue downloaded before the bike
 * leaves the network behind, the way a song is downloaded from its menu (see
 * `store/downloads.ts`, which skips what is already on the phone and keeps
 * the Wi-Fi only rule). Which songs is `songsToPrepare` in `lib/rideMode.ts`;
 * this is the asking, and the word on how it is going.
 *
 * The ride screen shows the progress and may be closed before the downloads
 * are done, so what was asked for is kept here rather than in the screen,
 * and the toast at the end is shown wherever the app is by then.
 *
 * With **Prepare on its own** on, the same is asked for without a tap: on
 * the charger, on Wi-Fi, and at night or with the screen off for ten
 * minutes, once in twelve hours at most (`shouldAutoPrepare`). Looked at
 * whenever one of those changes while the app's process is alive: there
 * is no job scheduled with the system, so a process the phone has killed
 * prepares nothing until it is started again.
 */
import * as Network from 'expo-network';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { type Song } from '@/api/subsonic';
import { tg } from '@/i18n';
import { getPlainItem, setPlainItem } from '@/lib/plainStorage';
import {
  AUTO_PREPARE_IDLE_MS,
  batteryState,
  isScreenOn,
  onBattery,
  onScreen,
  shouldAutoPrepare,
  songsToPrepare,
} from '@/lib/rideMode';
import { whenProfileReady } from '@/lib/storeWait';
import { useDownloads } from '@/store/downloads';
import { useNetworkType } from '@/store/networkType';
import { usePlayerStore } from '@/store/player';
import { useRideMode } from '@/store/rideMode';
import { useToast } from '@/store/toast';

interface RidePreparationState {
  /** The ids asked for, while the downloads run; nothing otherwise. */
  preparing: string[] | null;
}

export const useRidePreparation = create<RidePreparationState>(() => ({ preparing: null }));

/**
 * Downloads `songs` and says how many made it. Nothing while a preparation
 * is already running: a second tap on the button is impatience, not a
 * second request. One that started on its own (`auto`) only says so to a
 * lit screen: a toast at three in the morning is for nobody.
 */
export async function prepareRide(songs: Song[], auto = false): Promise<void> {
  if (useRidePreparation.getState().preparing || songs.length === 0) return;
  useRidePreparation.setState({ preparing: songs.map((s) => s.id) });
  try {
    await useDownloads.getState().downloadSongs(songs);
  } finally {
    useRidePreparation.setState({ preparing: null });
  }
  const { files } = useDownloads.getState();
  const done = songs.filter((s) => files[s.id]).length;
  // Nothing fetched is the download refusing to start (offline, or mobile
  // data with Wi-Fi only on), and it has said why itself.
  if (done === 0 || (auto && !isScreenOn())) return;
  useToast.getState().show(
    done === songs.length
      ? tg('Ride prepared: {n} songs downloaded', { n: done })
      : tg('Ride prepared: {done} of {total} songs downloaded', { done, total: songs.length }),
  );
}

/** When the ride was last prepared on its own, kept across launches; the phone's, not the profile's. */
const AUTO_PREPARED_KEY = 'ride-auto-prepared-at';

/** Read from disk at the first look; null for never. */
let autoPreparedAt: number | null | undefined;

/** Since when the screen has been off; null while it is on. */
let screenOffSince: number | null = null;

let idleTimer: ReturnType<typeof setTimeout> | undefined;

/** Whether a look is under way, so the events that come in a burst make one. */
let looking = false;

/** Prepares the ride when the moment is right; see the top of the file. */
async function autoPrepare(): Promise<void> {
  const { config } = useRideMode.getState();
  const charging = batteryState()?.charging ?? false;
  if (!config.autoPrepare || !charging || looking || useRidePreparation.getState().preparing) return;
  looking = true;
  try {
    if (autoPreparedAt === undefined) autoPreparedAt = Number(await getPlainItem(AUTO_PREPARED_KEY)) || null;
    const network = await Network.getNetworkStateAsync();
    const wifi = network.type === Network.NetworkStateType.WIFI || network.type === Network.NetworkStateType.ETHERNET;
    const now = Date.now();
    const hour = new Date(now).getHours();
    if (!shouldAutoPrepare({ charging, wifi, hour, lastAt: autoPreparedAt, now, screenOffSince })) return;
    await whenProfileReady();
    const { queue, index, repeat } = usePlayerStore.getState();
    const songs = songsToPrepare(queue, index, config.prepareCount, repeat === 'all', useDownloads.getState().files);
    // Nothing left to fetch is not a preparation: the next look may find a
    // queue that has changed, and costs nothing.
    if (songs.length === 0) return;
    autoPreparedAt = now;
    void setPlainItem(AUTO_PREPARED_KEY, String(now));
    void prepareRide(songs, true);
  } catch {
    // An unreadable date or a network that would not say: the next change looks again.
  } finally {
    looking = false;
  }
}

/** Starts looking, once per runtime, from `startRideSync`. */
export function startAutoPrepare(): void {
  const look = () => void autoPrepare();
  screenOffSince = isScreenOn() ? null : Date.now();
  onScreen((on) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    screenOffSince = on ? null : Date.now();
    // Ten minutes of a dark screen is not an event of its own: a look is
    // set for when they are up. On the charger the phone does not doze, so
    // the timer goes off on time.
    if (!on) idleTimer = setTimeout(look, AUTO_PREPARE_IDLE_MS + 1_000);
  });
  onBattery(look);
  useNetworkType.subscribe(look);
  useRideMode.subscribe((state, prev) => {
    if (state.config.autoPrepare && !prev.config.autoPrepare) look();
  });
  AppState.addEventListener('change', look);
}
