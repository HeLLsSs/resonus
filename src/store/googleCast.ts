/**
 * Integration with Google Cast receivers (native module modules/google-cast):
 * Chromecast, Nest speakers, Android TV, and anything else running the Cast
 * receiver, a WiiM in Chromecast mode among them.
 *
 * The player store keeps the queue. The receiver is handed the track to play
 * and the few that follow it, and moves from one to the next by itself: the
 * change happens on the receiver, with no gap and without this app having to
 * be awake for it. Each item carries the song's id and a key, which come back
 * in every status, so when the receiver says it is on another item the player
 * only has to move its index (`onTrackChanged`), not load anything. Whenever
 * the queue changes at this end (shuffle, repeat, a reorder, the next track
 * being reached) the tail on the receiver is rewritten to match
 * (`syncCastQueue`). A receiver that refuses a queue gets one track at a time
 * instead, the next loaded when it reports the previous finished.
 *
 * The receiver fetches for itself, from the URL it is handed. That URL is the
 * server's stream address with the account's credentials in it, exactly as
 * for UPnP (see `remoteTrack.ts`), or the phone's own server for a file that
 * lives here.
 *
 * A session outlives the app: the framework keeps it in Google Play services,
 * and finds it again when the app is opened while the receiver still plays.
 * That comes in as `onResumed`, and the player picks up where the receiver
 * is rather than starting over.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { type Song } from '@/api/backend';
import { tg } from '@/i18n';
import { stopLocalHttp } from '@/lib/localHttp';
import { castStop } from './castMedia';
import {
  ensureLocalFilesServed,
  mp3StreamUrl,
  remoteMime,
  remoteTrackInfo,
  remoteTrackUrl,
  transcodedTo,
} from './remoteTrack';
import { useToast } from './toast';
import type { RemoteEvents } from './upnp';

export interface CastDevice {
  /** MediaRouter's route id: what `connect` takes. */
  id: string;
  name: string;
  model: string;
}

interface GoogleCastStoreState {
  connected: boolean;
  deviceId: string | null;
  /** Receivers found in the last search. */
  devices: CastDevice[];
  scanning: boolean;
}

export const useGoogleCast = create<GoogleCastStoreState>(() => ({
  connected: false,
  deviceId: null,
  devices: [],
  scanning: false,
}));

interface NativeState {
  connected: boolean;
  isPlaying: boolean;
  isBuffering: boolean;
  isIdle: boolean;
  /** Idle because the track played to its end: the one idle that advances the queue. */
  finished: boolean;
  idleReason: 'none' | 'finished' | 'cancelled' | 'interrupted' | 'error';
  positionMs: number;
  durationMs: number;
  /** The device's own volume, 0..100, or -1 when it could not be read. */
  volume: number;
  /** Of the media playing, as handed over in `customData`; empty when it is not ours. */
  songId: string;
  itemKey: string;
  /** The receiver holds (or is already fetching) an item after this one. */
  hasNextItem: boolean;
}

interface NativeSession {
  connected: boolean;
  /** Found again rather than started by `connect`. */
  resumed: boolean;
  device: CastDevice | null;
  error: number;
}

/** The receiver's answer to a load. */
interface LoadResult {
  ok: boolean;
  code: number;
  message: string | null;
  /** The receiver's own words, when it gave any: `NOT_SUPPORTED`, `GENERIC_LOAD_ERROR`… */
  reason: string | null;
  /** The receiver's detailed error code (`MediaError.DetailedErrorCode`). */
  detail: number | null;
}

/** What the player is handed to build the receiver's queue from. */
export interface CastQueueState {
  queue: Song[];
  index: number;
  repeat: 'off' | 'all' | 'one';
  /** The track is to end on its own and nothing follow it. */
  sleepAtSongEnd: boolean;
}

/** How many tracks after the current one the receiver holds. */
const NEXT_ITEMS = 3;

/** The receiver's repeat modes (`MediaStatus.REPEAT_MODE_*`). */
const REPEAT_OFF = 0;
const REPEAT_SINGLE = 2;

/** A volume the receiver reports this soon after we set one is our own coming back. */
const VOLUME_ECHO_MS = 1500;

const native = requireOptionalNativeModule('GoogleCast');

export const googleCastAvailable = !!native;

let events: RemoteEvents | null = null;
/** The player's queue, for naming the index the receiver's item stands for. */
let queueOf: (() => { queue: Song[]; index: number }) | null = null;
let stateSub: { remove: () => void } | undefined;
let sessionSub: { remove: () => void } | undefined;
let errorSub: { remove: () => void } | undefined;
let lastPositionSec = 0;
let lastDurationSec = 0;
let lastSongId: string | null = null;
let lastPlaying = false;
/** Prevents advancing the queue twice for the same track end. */
let finishedFired = false;
/** A load is in flight: the idle the receiver reports meanwhile is the old track's. */
let loading = false;
/** We have seen PLAYING since the last load, so a finish is a real one. */
let wasPlaying = false;
/** The key of the item we believe the receiver is on; a status naming another is a track change. */
let currentKey = '';
/** False once this receiver has refused a queue: one track at a time from then on. */
let queueSupported = true;
/** `connect` is waiting on the framework: its session announcement is not a resume. */
let connecting = false;
/** A session was found again and its first status is what the player is waiting for. */
let pendingResume = false;
/** The volume we last sent (0..100) and when, to tell its echo from a real change. */
let sentVolume: { value: number; at: number } | null = null;
/** The following items last handed to the receiver, so an unchanged tail is not rewritten. */
let lastTailSignature: string | null = null;
let inFlightSync: Promise<boolean> | null = null;

export function isCastConnected(): boolean {
  return useGoogleCast.getState().connected;
}

/**
 * Registers player events. Call only once (from the player). Also the moment
 * to ask the framework whether a session was left running, and again on every
 * return to the foreground: what the receiver does while the app is away is
 * only learned by asking.
 */
export function initGoogleCast(ev: RemoteEvents, queue: () => { queue: Song[]; index: number }): void {
  events = ev;
  queueOf = queue;
  if (!native) return;
  sessionSub?.remove();
  sessionSub = native.addListener('session', onNativeSession);
  errorSub?.remove();
  errorSub = native.addListener('error', onNativeError);
  void castResume();
  AppState.addEventListener('change', (st) => {
    if (st === 'active') void castResume();
  });
}

/** A song of ours the receiver is playing: `songId@index` when it was handed over. */
function keyFor(song: Song, index: number): string {
  return `${song.id}@${index}`;
}

/**
 * Where in the queue the item the receiver is on sits. The key names the index
 * it had when handed over, which still holds unless the queue was rewritten
 * since; then the song is looked for from the current position on, and
 * failing that anywhere.
 */
function indexForKey(key: string, songId: string, queue: Song[], from: number): number {
  const at = Number(key.slice(key.lastIndexOf('@') + 1));
  if (Number.isInteger(at) && queue[at]?.id === songId) return at;
  const after = queue.findIndex((song, i) => i > from && song.id === songId);
  return after >= 0 ? after : queue.findIndex((song) => song.id === songId);
}

function onNativeSession(e: NativeSession) {
  if (!e.connected) {
    // Ended on the other side: stopped from the TV, or the device went away.
    if (isCastConnected()) void castDisconnect();
    return;
  }
  // The session `connect` asked for is answered through its promise.
  if (connecting || isCastConnected()) return;
  adoptSession(e.device);
}

/**
 * Takes over a session the framework found running: the store says
 * connected, the device joins the list so the output sheet can name it, and
 * the first status tells the player what is playing.
 */
function adoptSession(device: CastDevice | null) {
  resetTrackState();
  const { devices } = useGoogleCast.getState();
  const known = device ? devices.some((d) => d.id === device.id) : true;
  useGoogleCast.setState({
    connected: true,
    deviceId: device?.id ?? null,
    devices: device && !known ? [...devices, device].sort((a, b) => a.name.localeCompare(b.name)) : devices,
  });
  pendingResume = true;
  stateSub?.remove();
  stateSub = native.addListener('state', onNativeState);
  // Asked for once the listener is in place: the status that came with the
  // session may have gone out before it was.
  void native.requestState().catch(() => undefined);
}

/** Asks the framework for a session left running, and adopts it if there is one. */
async function castResume(): Promise<void> {
  if (!native || isCastConnected() || connecting) return;
  let device: CastDevice | null = null;
  try {
    device = ((await native.resumeSession()) as CastDevice | null) ?? null;
  } catch {
    return;
  }
  if (!device || isCastConnected() || connecting) return;
  adoptSession(device);
}

function resetTrackState() {
  lastPositionSec = 0;
  lastDurationSec = 0;
  lastSongId = null;
  lastPlaying = false;
  finishedFired = false;
  loading = false;
  wasPlaying = false;
  currentKey = '';
  pendingResume = false;
  lastTailSignature = null;
  inFlightSync = null;
}

function onNativeError(e: { reason: string | null; detail: number | null }) {
  if (!isCastConnected()) return;
  // A load that was accepted and then could not be played: the state event
  // that comes with it is an idle "error", and this is the reason for it.
  loading = false;
  useToast.getState().show(withReason(tg("The receiver couldn't play this song"), e.reason, e.detail));
}

/** The receiver's reason, when it gave one, after the sentence. */
function withReason(text: string, reason: string | null, detail: number | null): string {
  const why = reason ?? (detail != null ? String(detail) : null);
  return why ? `${text} (${why})` : text;
}

/** What to tell about a load the receiver refused. */
function loadErrorMessage(result: LoadResult): string {
  const detail = result.detail ?? 0;
  // The receiver's detailed codes: 104 is a source it cannot play, the 100s
  // and 300s are fetching, 905 is a load that failed for no better reason.
  if (detail === 104 || result.reason === 'NOT_SUPPORTED') return tg("The receiver can't play this format");
  if (detail === 103 || (detail >= 300 && detail < 400) || detail === 905 || result.reason === 'GENERIC_LOAD_ERROR') {
    return tg("The receiver couldn't fetch this song");
  }
  return withReason(tg("This song can't be cast"), result.reason, result.detail);
}

function onNativeState(e: NativeState) {
  if (!isCastConnected()) return;
  const pos = (e.positionMs ?? 0) / 1000;
  const dur = (e.durationMs ?? 0) / 1000;
  if (pos > 0) lastPositionSec = pos;
  if (dur > 0) lastDurationSec = dur;
  lastSongId = e.songId || null;
  lastPlaying = e.isPlaying || e.isBuffering;
  if (e.volume >= 0) reportVolume(e.volume);
  if (pendingResume) {
    pendingResume = false;
    currentKey = e.itemKey;
    events?.onResumed?.({
      songId: e.songId || null,
      positionSec: pos,
      durationSec: dur,
      isPlaying: lastPlaying,
    });
  } else if (e.itemKey && e.itemKey !== currentKey && !loading) {
    // The receiver moved on to another of the items it was handed.
    currentKey = e.itemKey;
    finishedFired = false;
    const current = queueOf?.();
    const index = current && e.songId ? indexForKey(e.itemKey, e.songId, current.queue, current.index) : -1;
    if (index >= 0) events?.onTrackChanged(index, pos, dur);
  }
  if (e.finished) {
    // Once per track. The receiver repeats its idle status, and the previous
    // track's FINISHED can still arrive while the next one is loading: only a
    // finish after having played counts, and only until the next load. With
    // more of the queue on the receiver it is not a finish at all, only the
    // moment between two items.
    if (!finishedFired && !loading && wasPlaying && !e.hasNextItem) {
      finishedFired = true;
      wasPlaying = false;
      events?.onFinished();
    }
    return;
  }
  if (e.isPlaying) {
    loading = false;
    finishedFired = false;
    wasPlaying = true;
    events?.onProgress(pos, dur || lastDurationSec);
    events?.onPlayingChanged(true, false);
    return;
  }
  if (e.isBuffering) {
    events?.onPlayingChanged(true, true);
    return;
  }
  if (e.isIdle) {
    // A load that was accepted and then could not be played (a codec the
    // receiver turns out not to have) ends here, not in a failed load: left
    // as "loading", the app would spin on it for ever.
    if (e.idleReason === 'error') loading = false;
    if (loading) return;
    events?.onPlayingChanged(false, false);
    return;
  }
  events?.onProgress(pos, dur || lastDurationSec);
  events?.onPlayingChanged(false, false);
}

/**
 * The device's volume as it reports it. What we set comes back the same way
 * a moment later, and is not news; anything else (the remote, the Home app,
 * the receiver's own buttons) is, and the player's slider follows it.
 */
function reportVolume(volume: number) {
  if (sentVolume) {
    if (sentVolume.value === volume) {
      sentVolume = null;
      return;
    }
    if (Date.now() - sentVolume.at < VOLUME_ECHO_MS) return;
    sentVolume = null;
  }
  events?.onVolume?.(volume / 100);
}

/**
 * Searches for receivers (~5 s) and refreshes the visible list. MediaRouter
 * keeps the routes it has found between searches, so a receiver that misses a
 * round is not dropped for it.
 */
export async function castSearch(): Promise<void> {
  if (!native || useGoogleCast.getState().scanning) return;
  useGoogleCast.setState({ scanning: true });
  try {
    const found = (await native.search(5000)) as CastDevice[];
    useGoogleCast.setState({
      devices: [...found].sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch {
    // keep the previous list
  } finally {
    useGoogleCast.setState({ scanning: false });
  }
}

export async function castConnect(device: CastDevice): Promise<boolean> {
  if (!native) return false;
  const current = useGoogleCast.getState();
  // Remote-to-remote handoff: end the previous session first so playback
  // doesn't continue there while the new device takes over.
  if (current.connected && current.deviceId && current.deviceId !== device.id) {
    await castDisconnect(true);
  }
  let ok = false;
  connecting = true;
  try {
    ok = (await native.connect(device.id)) as boolean;
  } catch {
    ok = false;
  } finally {
    connecting = false;
  }
  if (!ok) return false;
  resetTrackState();
  queueSupported = true;
  stateSub?.remove();
  stateSub = native.addListener('state', onNativeState);
  useGoogleCast.setState({ connected: true, deviceId: device.id });
  events?.onConnected();
  return true;
}

/** Ends the session; with silent it doesn't notify the player (e.g. when switching output). */
export async function castDisconnect(silent = false): Promise<void> {
  if (!isCastConnected()) return;
  stateSub?.remove();
  stateSub = undefined;
  // Closes the casting media session on any disconnect path (including silent
  // ones: output switch, reset), not just the normal one.
  castStop();
  // And the port with it: it is only ever open for a receiver that is
  // listening, and this is the moment there is none.
  void stopLocalHttp();
  useGoogleCast.setState({ connected: false, deviceId: null });
  // Read before the reset below: it is where the local player picks the song
  // back up.
  const resumeAtSec = lastPositionSec;
  resetTrackState();
  sentVolume = null;
  try {
    await native?.disconnect();
  } catch {
    // ignore
  }
  if (!silent) events?.onDisconnected(resumeAtSec);
}

/** What the receiver is playing right now, by the last status it sent. */
export function castNowPlaying() {
  return {
    songId: lastSongId,
    positionSec: lastPositionSec,
    durationSec: lastDurationSec,
    isPlaying: lastPlaying,
  };
}

interface TrackSpec {
  url: string;
  mime: string;
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  durationSec: number;
  songId: string;
  key: string;
}

/**
 * The tracks after the current one that the receiver should hold, in order:
 * the next few, going round with repeat "all". None with repeat "one" (the
 * receiver repeats the item itself) or when the track is to be the last one
 * heard: the finish must reach the app for the sleep timer to act on it.
 */
function tailIndices(state: CastQueueState): number[] {
  const { queue, index, repeat, sleepAtSongEnd } = state;
  if (repeat === 'one' || sleepAtSongEnd || queue.length === 0) return [];
  const out: number[] = [];
  for (let step = 1; step <= NEXT_ITEMS; step++) {
    const i = index + step;
    if (i < queue.length) out.push(i);
    else if (repeat === 'all' && queue.length > 1) out.push(i % queue.length);
    else break;
  }
  return out;
}

function specFor(song: Song, index: number, url: string, mime: string): TrackSpec {
  const { title, artist, album, artworkUrl, durationSec } = remoteTrackInfo(song);
  return { url, mime, title, artist, album, artworkUrl, durationSec, songId: song.id, key: keyFor(song, index) };
}

/**
 * The items for these positions, stopping at the first the receiver could not
 * be sent for: reached that way, the app is asked to load it and says why it
 * cannot, rather than the receiver skipping it in silence.
 */
function specsFor(queue: Song[], indices: number[]): TrackSpec[] {
  const out: TrackSpec[] = [];
  for (const i of indices) {
    const song = queue[i];
    const url = song ? remoteTrackUrl(song) : undefined;
    if (!song || !url) break;
    out.push(specFor(song, i, url, remoteMime(song, transcodedTo(song))));
  }
  return out;
}

function repeatModeFor(state: CastQueueState): number {
  return state.repeat === 'one' ? REPEAT_SINGLE : REPEAT_OFF;
}

/**
 * Loads the track at the state's index on the receiver, with what follows it
 * behind. Returns false if there is no session or the song is not castable
 * (nothing can serve it), or if the receiver refused it even as MP3; the
 * reason, when there is one, is shown from here.
 */
export async function loadCastQueue(state: CastQueueState, autoplay: boolean, startSec = 0): Promise<boolean> {
  if (!native || !isCastConnected()) return false;
  const song = state.queue[state.index];
  if (!song) return false;
  loading = true;
  finishedFired = false;
  wasPlaying = false;
  lastPositionSec = startSec;
  lastDurationSec = song.duration ?? 0;
  currentKey = keyFor(song, state.index);
  lastTailSignature = null;
  try {
    const tail = tailIndices(state);
    await ensureLocalFilesServed([song, ...tail.map((i) => state.queue[i])]);
    const url = remoteTrackUrl(song);
    if (!url) {
      loading = false;
      return false;
    }
    const current = specFor(song, state.index, url, remoteMime(song, transcodedTo(song)));
    const following = specsFor(state.queue, tail);
    const result = await loadOn(current, following, state, autoplay, startSec);
    if (!result.ok) {
      loading = false;
      useToast.getState().show(loadErrorMessage(result));
      return false;
    }
    lastTailSignature = following.map((s) => s.key).join(',') + `|${repeatModeFor(state)}`;
    return true;
  } catch {
    loading = false;
    return false;
  }
}

/**
 * The load itself, tried the ways there are: as a queue, then as one track if
 * the queue is what the receiver refused, then again as MP3, the same
 * fallback UPnP makes for a format the receiver cannot play (a lossless one
 * the server is asked to pass through, say).
 */
async function loadOn(
  current: TrackSpec,
  following: TrackSpec[],
  state: CastQueueState,
  autoplay: boolean,
  startSec: number,
): Promise<LoadResult> {
  const single = (spec: TrackSpec) =>
    native.load(JSON.stringify(spec), autoplay, startSec * 1000) as Promise<LoadResult>;
  const asQueue = (spec: TrackSpec) =>
    native.loadQueue(
      JSON.stringify({
        items: [spec, ...following],
        startIndex: 0,
        autoplay,
        positionMs: startSec * 1000,
        repeatMode: repeatModeFor(state),
      }),
    ) as Promise<LoadResult>;
  const load = async (spec: TrackSpec) => {
    if (!queueSupported) return single(spec);
    const result = await asQueue(spec);
    if (result.ok) return result;
    // The same track alone: if that one takes, the queue is what it will not
    // have, and it is not offered one again this session.
    const alone = await single(spec);
    if (alone.ok) queueSupported = false;
    return alone.ok ? alone : result;
  };
  const result = await load(current);
  if (result.ok) return result;
  const mp3Url = mp3StreamUrl(state.queue[state.index]);
  if (!mp3Url || mp3Url === current.url) return result;
  const fallback = await load({ ...current, url: mp3Url, mime: 'audio/mpeg' });
  return fallback.ok ? fallback : result;
}

/**
 * Brings the tail on the receiver in line with the queue: what follows the
 * current track, and the repeat mode. Nothing is sent when nothing changed
 * since the last time, and one rewrite at a time; `force` rewrites anyway,
 * for a session found again whose tail this app never saw.
 */
export async function syncCastQueue(state: CastQueueState, force = false): Promise<boolean> {
  if (!native || !isCastConnected() || !queueSupported || loading) return false;
  if (inFlightSync) return inFlightSync;
  const tail = tailIndices(state);
  const repeatMode = repeatModeFor(state);
  const run = (async () => {
    // The current track stays published with them: what is published is
    // replaced as a whole, and the receiver is still fetching this one.
    await ensureLocalFilesServed(
      [state.queue[state.index], ...tail.map((i) => state.queue[i])].filter((s): s is Song => !!s),
    );
    const items = specsFor(state.queue, tail);
    const signature = items.map((s) => s.key).join(',') + `|${repeatMode}`;
    if (!force && signature === lastTailSignature) return true;
    let ok = false;
    try {
      ok = (await native.setNextItems(JSON.stringify({ items, repeatMode }))) as boolean;
    } catch {
      ok = false;
    }
    if (ok) lastTailSignature = signature;
    return ok;
  })();
  inFlightSync = run;
  try {
    return await run;
  } finally {
    if (inFlightSync === run) inFlightSync = null;
  }
}

export async function castPlay(): Promise<void> {
  try {
    await native?.play();
  } catch {
    // ignore
  }
}

export async function castPause(): Promise<void> {
  try {
    await native?.pause();
  } catch {
    // ignore
  }
}

export async function castSeek(sec: number): Promise<void> {
  try {
    await native?.seek(sec * 1000);
  } catch {
    // ignore
  }
}

/** Receiver volume; the app slider goes 0..1 and the session takes 0..100. */
export function castSetVolume(volume: number): void {
  const value = Math.round(Math.max(0, Math.min(1, volume)) * 100);
  sentVolume = { value, at: Date.now() };
  try {
    void native?.setVolume(value);
  } catch {
    // ignore
  }
}
