/**
 * Integration with UPnP/DLNA renderers (native module modules/upnp-cast).
 *
 * The player store remains the UI/source-of-truth queue. While connected to an
 * ordinary renderer, a native copy owns transport progression so Android can
 * continue between tracks while JS is suspended. Sonos keeps using its native
 * renderer-side queue.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { create } from 'zustand';

import { type Song } from '@/api/backend';
import { stopLocalHttp } from '@/lib/localHttp';
import { castStop } from './castMedia';
import {
  ensureLocalFilesServed,
  mp3StreamUrl,
  remoteMime,
  remoteTrackInfo,
  remoteTrackUrl,
  transcodedTo,
  type RemoteTrackInfo,
} from './remoteTrack';

/** Events the player registers to react to remote output (UPnP, Jukebox, Google Cast). */
export interface RemoteEvents {
  /** Session started: transfer the current track to the renderer. */
  onConnected: () => void;
  /** Session ended: return to the local player at this position. */
  onDisconnected: (lastPositionSec: number) => void;
  /** Renderer advanced to a different track in its queue. */
  onTrackChanged: (index: number, positionSec: number, durationSec: number) => void;
  onProgress: (positionSec: number, durationSec: number) => void;
  onPlayingChanged: (isPlaying: boolean, isBuffering: boolean) => void;
  onRepeatChanged?: (repeat: 'off' | 'all' | 'one') => void;
  /** The device's volume moved on its own side (a remote, another app), 0..1. */
  onVolume?: (volume: number) => void;
  /**
   * A session this app left on the device was found again (the app was
   * reopened, or came back from a network drop), with what the device is
   * playing: the id of the song if it is one of ours, and where it is in it.
   */
  onResumed?: (playing: RemoteNowPlaying) => void;
  /** Track finished naturally on the renderer. */
  onFinished: () => void;
}

export interface RemoteNowPlaying {
  songId: string | null;
  positionSec: number;
  durationSec: number;
  isPlaying: boolean;
}

export interface UpnpDevice {
  id: string;
  name: string;
  address: string;
  isTV: boolean;
  isSonos?: boolean;
  groupId?: string | null;
  coordinatorId?: string | null;
}

interface UpnpStoreState {
  connected: boolean;
  deviceId: string | null;
  /** Renderers found in the last search. */
  devices: UpnpDevice[];
  scanning: boolean;
}

export const useUpnp = create<UpnpStoreState>(() => ({
  connected: false,
  deviceId: null,
  devices: [],
  scanning: false,
}));

interface NativeState {
  playbackState: 'IDLE' | 'PLAYING' | 'PAUSED' | 'STOPPED' | 'BUFFERING' | 'ERROR';
  positionMs: number;
  durationMs: number;
  trackNumber?: number;
  playMode?: string;
  nativeQueueManaged?: boolean;
  /** Authoritative zero-based index for a native-managed ordinary renderer. */
  queueIndex?: number;
}

const native = requireOptionalNativeModule('UpnpCast');

export const upnpAvailable = !!native;

let events: RemoteEvents | null = null;
let stateSub: { remove: () => void } | undefined;
let lastPositionSec = 0;
let lastDurationSec = 0;
/** Prevents advancing the queue twice for the same track end. */
let finishedFired = false;
/** Ignores transient STOPPED while the renderer loads another track. */
let loading = false;
/** We have seen PLAYING since the last load/pause (to infer the end). */
let wasPlaying = false;
/** We requested the pause ourselves: a STOPPED after this is not a track end. */
let pausedByUs = false;
let lastNativeTrackNumber = 0;
let lastNativeQueueIndex = -1;
let lastRemoteRepeat: 'off' | 'all' | 'one' | null = null;

interface CachedDevice {
  device: UpnpDevice;
  expiresAtMs: number;
}

const discoveredDeviceCache = new Map<string, CachedDevice>();
const DEFAULT_DEVICE_CACHE_TTL_MS = 15_000;
let deviceCacheTtlMs = DEFAULT_DEVICE_CACHE_TTL_MS;

export function isUpnpConnected(): boolean {
  return useUpnp.getState().connected;
}

function currentUpnpDevice(): UpnpDevice | null {
  const state = useUpnp.getState();
  return state.deviceId ? state.devices.find((device) => device.id === state.deviceId) ?? null : null;
}

/** Registers player events. Call only once (from the player). */
export function initUpnp(ev: RemoteEvents): void {
  events = ev;
}

function repeatForPlayMode(playMode?: string): 'off' | 'all' | 'one' | null {
  if (!playMode) return null;
  const normalized = playMode.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized.includes('REPEAT_ONE')) return 'one';
  if (normalized === 'REPEAT_ALL' || normalized === 'SHUFFLE') return 'all';
  if (normalized === 'NORMAL' || normalized === 'SHUFFLE_NOREPEAT') return 'off';
  return null;
}

function onNativeState(e: NativeState) {
  if (!isUpnpConnected()) return;
  const repeat = repeatForPlayMode(e.playMode);
  if (repeat != null && repeat !== lastRemoteRepeat) {
    lastRemoteRepeat = repeat;
    events?.onRepeatChanged?.(repeat);
  }
  const pos = (e.positionMs ?? 0) / 1000;
  const dur = (e.durationMs ?? 0) / 1000;
  const trackNumber = Math.floor(e.trackNumber ?? 0);
  const nativeQueueIndex = Math.floor(e.queueIndex ?? -1);
  if (pos > 0) lastPositionSec = pos;
  if (dur > 0) lastDurationSec = dur;
  if (e.nativeQueueManaged && nativeQueueIndex >= 0) {
    const changed = nativeQueueIndex !== lastNativeQueueIndex;
    lastNativeQueueIndex = nativeQueueIndex;
    if (changed && !loading) {
      events?.onTrackChanged(nativeQueueIndex, pos, dur || lastDurationSec);
    }
  } else if (trackNumber > 0) {
    const changed = trackNumber !== lastNativeTrackNumber;
    lastNativeTrackNumber = trackNumber;
    if (changed && !loading) {
      events?.onTrackChanged(trackNumber - 1, pos, dur || lastDurationSec);
    }
  }
  switch (e.playbackState) {
    case 'PLAYING':
      loading = false;
      finishedFired = false;
      wasPlaying = true;
      pausedByUs = false;
      events?.onProgress(pos, dur || lastDurationSec);
      events?.onPlayingChanged(true, false);
      break;
    case 'BUFFERING':
      events?.onPlayingChanged(true, true);
      break;
    case 'PAUSED':
      wasPlaying = false;
      events?.onProgress(pos, dur || lastDurationSec);
      events?.onPlayingChanged(false, false);
      break;
    case 'STOPPED':
    case 'IDLE':
      // UPnP doesn't distinguish "ended" from "stopped": we infer a natural end
      // from a STOPPED that arrives after having been playing (not a pause we
      // requested). Wide window towards the end (10% of track, min 5 s):
      // polling is 1 s and some renderers stop reporting position in the last
      // seconds, so a fixed 3 s threshold was too tight and the queue wouldn't
      // advance. Without known duration, we trust we were playing (better to
      // advance than to get stuck).
      if (!e.nativeQueueManaged && !finishedFired && !loading && wasPlaying && !pausedByUs) {
        const window = Math.max(5, lastDurationSec * 0.1);
        const nearEnd = lastDurationSec <= 0 || lastPositionSec >= lastDurationSec - window;
        if (nearEnd) {
          finishedFired = true;
          wasPlaying = false;
          events?.onFinished();
        }
      }
      break;
    default:
      break;
  }
}

/**
 * Searches for renderers on the network (~5 s) and refreshes the visible list.
 *
 * Devices that are seen are updated immediately. Devices that are missed on one
 * round stay visible until the cache TTL expires, which smooths over SSDP loss
 * while still eventually removing stale entries.
 */
/** A name the library made up out of the address, not the device's own. */
function looksRaw(name: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}\b/.test(name.trim());
}

/**
 * One row per address, keeping the friendliest name.
 *
 * Sonos answers discovery more than once and the library names each answer
 * differently: the room ("Schlafzimmer") in one, "<ip> - Sonos Play:1 -
 * RINCON…" in another. That's two rows for one speaker, and the unreadable one
 * is as likely to be tapped as the good one.
 */
function dedupeDevices(devices: UpnpDevice[]): UpnpDevice[] {
  const byAddress = new Map<string, UpnpDevice>();
  for (const d of devices) {
    const key = d.address || d.id;
    const kept = byAddress.get(key);
    if (!kept || (looksRaw(kept.name) && !looksRaw(d.name))) byAddress.set(key, d);
  }
  return Array.from(byAddress.values());
}

export async function upnpSearch(): Promise<void> {
  if (!native || useUpnp.getState().scanning) return;
  useUpnp.setState({ scanning: true });
  try {
    const now = Date.now();
    // Three questions a second apart, and the speakers get MX=3 s to answer
    // the last one; anything shorter cuts the slow ones off.
    const found = dedupeDevices((await native.search(6000)) as UpnpDevice[]);
    const seen = new Set<string>();

    for (const device of found) {
      seen.add(device.id);
      discoveredDeviceCache.set(device.id, {
        device,
        expiresAtMs: now + deviceCacheTtlMs,
      });
    }

    for (const [id, cached] of discoveredDeviceCache) {
      if (!seen.has(id) && cached.expiresAtMs <= now) discoveredDeviceCache.delete(id);
    }

    const visible = dedupeDevices(Array.from(discoveredDeviceCache.values()).map((v) => v.device));
    useUpnp.setState({
      devices: visible,
    });
  } catch {
    // keep the previous list
  } finally {
    useUpnp.setState({ scanning: false });
  }
}

export async function upnpConnect(device: UpnpDevice): Promise<boolean> {
  if (!native) return false;
  const current = useUpnp.getState();
  // Remote-to-remote handoff: stop the previous renderer first so playback
  // doesn't continue there while the new device takes over.
  if (current.connected && current.deviceId && current.deviceId !== device.id) {
    await upnpDisconnect(true);
  }
  const ok = (await native.connect(device.id)) as boolean;
  if (!ok) return false;
  lastPositionSec = 0;
  lastDurationSec = 0;
  lastNativeTrackNumber = 0;
  lastNativeQueueIndex = -1;
  lastRemoteRepeat = null;
  finishedFired = false;
  wasPlaying = false;
  pausedByUs = false;
  stateSub?.remove();
  stateSub = native.addListener('state', onNativeState);
  useUpnp.setState({ connected: true, deviceId: device.id });
  events?.onConnected();
  return true;
}

/** Cuts the session; with silent it doesn't notify the player (e.g. when switching to cast). */
export async function upnpDisconnect(silent = false): Promise<void> {
  if (!isUpnpConnected()) return;
  stateSub?.remove();
  stateSub = undefined;
  // Closes the casting media session on any disconnect path
  // (including silent ones: output switch, reset), not just the normal one.
  castStop();
  // And the port with it: it is only ever open for a renderer that is listening,
  // and this is the moment there is none.
  void stopLocalHttp();
  useUpnp.setState({ connected: false, deviceId: null });
  // Read before the reset below: it is where the local player picks the song
  // back up, and clearing it first handed 0:00 to every disconnect.
  const resumeAtSec = lastPositionSec;
  lastNativeTrackNumber = 0;
  lastNativeQueueIndex = -1;
  lastRemoteRepeat = null;
  lastPositionSec = 0;
  lastDurationSec = 0;
  try {
    await native?.disconnect();
  } catch {
    // ignore
  }
  if (!silent) events?.onDisconnected(resumeAtSec);
}

function buildUpnpQueuePayload(queue: Song[]) {
  const tracks = queue.map((song) => {
    const url = remoteTrackUrl(song);
    if (!url) return null;
    const info = remoteTrackInfo(song);
    return { url, mime: remoteMime(song, transcodedTo(song)), ...info };
  });
  if (tracks.some((track) => track == null)) return null;
  return tracks as (RemoteTrackInfo & { url: string; mime: string })[];
}

/**
 * Loads a track on the renderer. Returns false if there is no session or the song
 * is not castable (local files: the renderer cannot reach them).
 */
export async function upnpLoad(
  queue: Song[],
  index: number,
  autoplay: boolean,
  startTimeSec = 0,
  playMode: string,
): Promise<boolean> {
  if (!native || !isUpnpConnected()) return false;
  const current = queue[index];
  if (!current) return false;
  loading = true;
  finishedFired = false;
  wasPlaying = false;
  pausedByUs = false;
  lastPositionSec = startTimeSec;
  lastDurationSec = current.duration ?? 0;
  try {
    // Both renderer-side Sonos queues and native-managed ordinary queues need
    // every phone-served URL to remain reachable after JS is suspended.
    const sonos = currentUpnpDevice()?.isSonos;
    await ensureLocalFilesServed(queue);
    const ok = sonos
      ? await loadSonosQueue(queue, index, autoplay, startTimeSec, playMode)
      : await loadGenericUpnpQueue(queue, index, autoplay, startTimeSec, playMode);
    if (ok && startTimeSec > 0) void native.seek(startTimeSec * 1000);
    // Not every renderer starts on its own after being handed a URI: Sonos
    // waits for an explicit Play and otherwise sits silent while the app
    // believes it's playing. Sending it always is harmless — one that already
    // started ignores it — and skipping it left whole devices mute.
    if (ok && autoplay) void native.play();
    // The ones that DO start on their own have to be stopped when we didn't
    // want playback yet.
    if (ok && !autoplay) void native.pause();
    if (!ok) loading = false;
    return ok;
  } catch {
    loading = false;
    return false;
  }
}

export async function upnpSyncQueue(
  queue: Song[],
  index: number,
  startTimeSec = 0,
  playMode: string,
): Promise<boolean> {
  if (!native || !isUpnpConnected()) return false;
  await ensureLocalFilesServed(queue);
  const payload = buildUpnpQueuePayload(queue);
  if (!payload) return false;
  try {
    return (await native.syncQueue(
      JSON.stringify({
        tracks: payload,
        currentIndex: index,
        positionMs: startTimeSec * 1000,
        playMode,
      }),
    )) as boolean;
  } catch {
    return false;
  }
}

export async function upnpSetPlayMode(playMode: string): Promise<boolean> {
  if (!native || !isUpnpConnected()) return false;
  try {
    return (await native.setPlayMode(playMode)) as boolean;
  } catch {
    return false;
  }
}

export async function upnpSetCrossfade(enabled: boolean): Promise<boolean> {
  if (!native || !isUpnpConnected()) return false;
  if (!currentUpnpDevice()?.isSonos) return true;
  try {
    return (await native.setCrossfadeMode(enabled)) as boolean;
  } catch {
    return false;
  }
}

export async function upnpSetSleepTimer(durationSec: number | null): Promise<boolean> {
  if (!native || !isUpnpConnected()) return false;
  if (!currentUpnpDevice()?.isSonos) return true;
  const seconds = Math.max(0, Math.round(durationSec ?? 0));
  try {
    return (await native.setSleepTimer(seconds)) as boolean;
  } catch {
    return false;
  }
}

async function loadSonosQueue(
  queue: Song[],
  index: number,
  autoplay: boolean,
  startTimeSec: number,
  playMode: string,
): Promise<boolean> {
  const payload = buildUpnpQueuePayload(queue);
  if (!payload) return false;
  return (await native.loadQueue(
    JSON.stringify({
      tracks: payload,
      currentIndex: index,
      autoplay,
      positionMs: startTimeSec * 1000,
      playMode,
    }),
  )) as boolean;
}

async function loadGenericUpnpQueue(
  queue: Song[],
  index: number,
  autoplay: boolean,
  startTimeSec: number,
  playMode: string,
): Promise<boolean> {
  const payload = buildUpnpQueuePayload(queue);
  if (!payload) return false;
  const load = (tracks: typeof payload) => native.loadQueue(JSON.stringify({
    tracks,
    currentIndex: index,
    autoplay,
    positionMs: startTimeSec * 1000,
    playMode,
  })) as Promise<boolean>;
  let ok = await load(payload);
  // Preserve the existing format fallback without throwing away the native
  // queue: replace only the selected URI and submit the complete queue again.
  if (!ok) {
    const mp3Url = mp3StreamUrl(queue[index]);
    if (mp3Url && mp3Url !== payload[index]?.url) {
      const fallback = [...payload];
      fallback[index] = { ...fallback[index], url: mp3Url, mime: 'audio/mpeg' };
      ok = await load(fallback);
    }
  }
  return ok;
}

export async function upnpJoinDevice(deviceId: string, targetDeviceId: string): Promise<boolean> {
  if (!native) return false;
  try {
    return (await native.join(deviceId, targetDeviceId)) as boolean;
  } catch {
    return false;
  }
}

export async function upnpUngroupDevice(deviceId: string): Promise<boolean> {
  if (!native) return false;
  try {
    return (await native.ungroup(deviceId)) as boolean;
  } catch {
    return false;
  }
}

export async function upnpPlay(): Promise<void> {
  pausedByUs = false;
  try {
    await native?.play();
  } catch {
    // ignore
  }
}

export async function upnpPause(): Promise<void> {
  // Marks the pause as ours: if the renderer reports STOPPED instead of
  // PAUSED, we don't confuse it with a track end (the queue wouldn't advance).
  pausedByUs = true;
  try {
    await native?.pause();
  } catch {
    // ignore
  }
}

export async function upnpSeek(sec: number): Promise<void> {
  try {
    await native?.seek(sec * 1000);
  } catch {
    // ignore
  }
}

/** Renderer volume; the app slider goes 0..1 and UPnP uses 0..100. */
export function upnpSetVolume(volume: number): void {
  try {
    void native?.setVolume(Math.round(Math.max(0, Math.min(1, volume)) * 100));
  } catch {
    // ignore
  }
}
