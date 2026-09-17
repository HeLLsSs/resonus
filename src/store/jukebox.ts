/**
 * Subsonic Jukebox mode: the server plays through its own hardware audio
 * (speakers/DAC) and the app acts as a remote control. Nothing is streamed
 * to the phone; only `jukeboxControl` commands are sent to the server.
 *
 * Reuses the player's remote machinery (the same `RemoteEvents` as
 * UPnP): the queue still lives in the player store, so autoplay,
 * mixes, shuffle and reordering work the same. Here we control ONE track at
 * a time (`set` + `start`) and poll the server state, which is what carries
 * the clock; track end is inferred from a "stopped near the end", as in
 * UPnP.
 *
 * The poll rides the native ticker (`lib/ticker.ts`) rather than a JS
 * timer, which Android freezes in the background: with the app minimized the
 * queue still advances when the server finishes a track.
 *
 * Only Subsonic servers with the jukebox role enabled by the admin.
 */
import { create } from 'zustand';

import { type Song } from '@/api/backend';
import {
  hasJukeboxRole,
  jukeboxSet,
  jukeboxSetGain,
  jukeboxSkip,
  jukeboxStart,
  jukeboxStatus,
  jukeboxStop,
  type SubsonicAuth,
} from '@/api/subsonic';
import { everyMs } from '@/lib/ticker';
import { useAuthStore } from './auth';
import type { RemoteEvents } from './upnp';

interface JukeboxStoreState {
  /** Active jukebox session (the server is the active output). */
  active: boolean;
  /** The server supports jukebox for this user (role enabled). */
  available: boolean;
}

export const useJukebox = create<JukeboxStoreState>(() => ({
  active: false,
  available: false,
}));

const POLL_MS = 1000;

let events: RemoteEvents | null = null;
/** Stops the poll's beat (see `everyMs`); null while there is none. */
let stopPolls: (() => void) | null = null;
let lastPositionSec = 0;
let lastDurationSec = 0;
/** Prevents advancing the queue twice for the same track end. */
let finishedFired = false;
/** Ignores the "stopped" state while loading another track. */
let loading = false;
/** Distinguishes a user pause from a natural track end. */
let intendedPlaying = false;
/** Only emit onPlayingChanged when it actually changes (polling is continuous). */
let lastPlaying: boolean | null = null;

export function isJukeboxActive(): boolean {
  return useJukebox.getState().active;
}

/** Registers player events. Call only once (from the player). */
export function initJukebox(ev: RemoteEvents): void {
  events = ev;
}

/** Only Subsonic has `jukeboxControl` (Jellyfin uses a different API). */
function auth(): SubsonicAuth | null {
  const a = useAuthStore.getState().auth;
  if (!a || a.serverType === 'jellyfin') return null;
  return a;
}

/** Checks if the server offers jukebox and caches it in the store. */
export async function refreshJukeboxAvailability(): Promise<void> {
  const a = auth();
  if (!a) {
    useJukebox.setState({ available: false });
    return;
  }
  const ok = await hasJukeboxRole(a);
  useJukebox.setState({ available: ok });
}

async function poll() {
  const a = auth();
  if (!a || !isJukeboxActive()) return;
  let st;
  try {
    st = await jukeboxStatus(a);
  } catch {
    return; // a one-off network failure doesn't cut the session
  }
  if (!isJukeboxActive()) return;
  const pos = st.position;
  if (pos > 0) lastPositionSec = pos;
  if (st.playing) {
    loading = false;
    finishedFired = false;
    events?.onProgress(pos, lastDurationSec);
    if (lastPlaying !== true) {
      lastPlaying = true;
      events?.onPlayingChanged(true, false);
    }
    return;
  }
  // Stopped: natural end (near the end and we intended to play) or pause.
  events?.onProgress(pos, lastDurationSec);
  if (
    intendedPlaying &&
    !finishedFired &&
    !loading &&
    lastDurationSec > 0 &&
    lastPositionSec >= lastDurationSec - 3
  ) {
    finishedFired = true;
    events?.onFinished();
    return;
  }
  if (lastPlaying !== false) {
    lastPlaying = false;
    events?.onPlayingChanged(false, false);
  }
}

/** Opens the jukebox session and starts state polling. */
export async function jukeboxConnect(): Promise<boolean> {
  const a = auth();
  if (!a) return false;
  lastPositionSec = 0;
  lastDurationSec = 0;
  finishedFired = false;
  loading = false;
  intendedPlaying = false;
  lastPlaying = null;
  useJukebox.setState({ active: true });
  stopPolls?.();
  stopPolls = everyMs(POLL_MS, () => void poll());
  events?.onConnected();
  return true;
}

/** Closes the session; with `silent` it doesn't notify the player (when switching output). */
export async function jukeboxDisconnect(silent = false): Promise<void> {
  if (!isJukeboxActive()) return;
  stopPolls?.();
  stopPolls = null;
  useJukebox.setState({ active: false });
  const a = auth();
  try {
    if (a) await jukeboxStop(a);
  } catch {
    // ignore
  }
  if (!silent) events?.onDisconnected(lastPositionSec);
}

/**
 * Loads a track in the server's jukebox. Returns false if there is no session or
 * the track is not suitable for jukebox (radios and local files: the server only
 * plays by id from its own library).
 */
export async function jukeboxLoad(song: Song, autoplay: boolean, startSec = 0): Promise<boolean> {
  const a = auth();
  if (!a || !isJukeboxActive()) return false;
  if (song.url || song.localUri) return false;
  loading = true;
  finishedFired = false;
  intendedPlaying = autoplay;
  lastPlaying = null;
  lastPositionSec = startSec;
  lastDurationSec = song.duration ?? 0;
  try {
    await jukeboxSet(a, song.id);
    if (startSec > 0) await jukeboxSkip(a, 0, startSec);
    if (autoplay) await jukeboxStart(a);
    else await jukeboxStop(a);
    loading = false;
    return true;
  } catch {
    loading = false;
    return false;
  }
}

export async function jukeboxPlay(): Promise<void> {
  const a = auth();
  if (!a) return;
  intendedPlaying = true;
  try {
    await jukeboxStart(a);
  } catch {
    // ignore
  }
}

export async function jukeboxPause(): Promise<void> {
  const a = auth();
  if (!a) return;
  intendedPlaying = false;
  try {
    await jukeboxStop(a);
  } catch {
    // ignore
  }
}

export async function jukeboxSeek(sec: number): Promise<void> {
  const a = auth();
  if (!a) return;
  lastPositionSec = sec;
  try {
    await jukeboxSkip(a, 0, sec);
  } catch {
    // ignore
  }
}

/** Jukebox volume; the app slider goes 0..1 and Subsonic gain is the same. */
export function jukeboxSetVolume(volume: number): void {
  const a = auth();
  if (!a) return;
  try {
    void jukeboxSetGain(a, Math.max(0, Math.min(1, volume)));
  } catch {
    // ignore
  }
}
