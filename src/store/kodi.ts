/**
 * Kodi as a remote output (`lib/kodi.ts`): the TV in the living room, reached
 * over its JSON-RPC API.
 *
 * The player store keeps the queue. Kodi is handed the track to play and the
 * ones after it, in its own music playlist, so that it moves from one to the
 * next by itself, phone asleep or not. Its playlist can be edited in place,
 * which is what sets it apart from Home Assistant's players: a tail the queue
 * has moved out from under (a reorder, a shuffle, a song taken out) is taken
 * out of Kodi from behind the track playing and written again, and the music
 * does not stop for it.
 *
 * Kodi says nothing on its own over HTTP. It is asked where it is every
 * second and a half for as long as the session lasts, and the answer is
 * turned into the same `RemoteEvents` the other outputs fire: where the
 * track is, whether it plays, which of the handed tracks it is on (by its
 * place in the playlist, checked against the address it was handed), and
 * whether it finished.
 *
 * The listen is this phone's to count, like with every other output: the
 * Resonuls add-on, when Kodi has it, only names what it is handed, and its
 * own service leaves the app's addresses alone.
 *
 * The address, user and password are the user's, kept once for every
 * profile: the TV does not change with the server the app is signed in to.
 */
import { create } from 'zustand';

import { type Song } from '@/api/backend';
import { tg } from '@/i18n';
import {
  describeKodi,
  fileFor,
  KodiError,
  kodiAdd,
  kodiGoTo,
  kodiPlay,
  kodiPlayPause,
  kodiSeek,
  kodiSetVolume,
  kodiState,
  kodiStop,
  kodiTrimAfter,
  normalizeKodiUrl,
  tailIndices,
  type KodiConfig,
  type KodiState,
} from '@/lib/kodi';
import { stopLocalHttp } from '@/lib/localHttp';
import { getItem, setItem } from '@/lib/storage';
import { everyMs } from '@/lib/ticker';
import { castStop } from './castMedia';
import type { CastQueueState } from './googleCast';
import { ensureLocalFilesServed, remoteTrackInfo, remoteTrackUrl } from './remoteTrack';
import { useToast } from './toast';
import type { RemoteEvents } from './upnp';

interface KodiStoreState {
  /** The switch, off until turned on: a house without Kodi never sees a row about it. */
  enabled: boolean;
  url: string;
  user: string;
  password: string;
  hydrated: boolean;
  connected: boolean;
  /** Kodi's own name, as it gave it the last time it was asked. */
  name: string;
  /** Kodi has the Resonuls add-on, which names what it is handed. */
  addon: boolean;
}

export const useKodi = create<KodiStoreState>(() => ({
  enabled: false,
  url: '',
  user: '',
  password: '',
  hydrated: false,
  connected: false,
  name: '',
  addon: false,
}));

/** Where the address and the account are kept: one key, not per profile. */
const STORAGE_KEY = 'resonus.kodi';
/** How often Kodi is asked where it is. */
const POLL_MS = 1500;
/** Polls in a row that go unanswered before the session is given up on. */
const MAX_FAILURES = 5;
/** Quiet polls after a load before it is given up on. */
const LOAD_QUIET_POLLS = 10;
/**
 * Polls of Kodi playing something that is none of ours before the session is
 * handed back: somebody picked something on the TV, and it is theirs now.
 */
const TAKEN_OVER_POLLS = 3;
/** A volume Kodi reports this soon after we set one is our own coming back. */
const VOLUME_ECHO_MS = 1500;
/** Within this of the end, a player that stops has finished the track. */
const NEAR_END_SEC = 5;

/** A track in Kodi's playlist, at the same place as in `handed`. */
interface Handed {
  /** What Kodi was given: through the add-on, or the address itself. */
  file: string;
  /** The address itself, which is what Kodi names once the add-on resolved it. */
  url: string;
  songId: string;
  key: string;
}

let events: RemoteEvents | null = null;
let queueOf: (() => { queue: Song[]; index: number }) | null = null;
let stopPolls: (() => void) | null = null;
let polling = false;
let failures = 0;
/** Kodi's playlist as handed, by position. */
let handed: Handed[] = [];
/** Where in it Kodi was last heard. */
let current = 0;
let loading = false;
let quietPolls = 0;
let foreignPolls = 0;
let lastPositionSec = 0;
let lastDurationSec = 0;
let wasPlaying = false;
let pausedByUs = false;
let finishedFired = false;
/** Kodi's player is closed: the queue ran out, or it was stopped on the TV. */
let idle = false;
/** Asked for with the load: Kodi starts a playlist from the top and playing. */
let pendingSeekSec: number | null = null;
let pendingPause = false;
/** One tail rewrite at a time: two overlapping ones would add the same songs twice. */
let inFlightSync: Promise<boolean> | null = null;
let sentVolume: { value: number; at: number } | null = null;

export function isKodiConnected(): boolean {
  return useKodi.getState().connected;
}

/** Switched on and an address given; nothing says it answers. */
export function kodiConfigured(): boolean {
  const { enabled, url } = useKodi.getState();
  return enabled && !!url;
}

function config(): KodiConfig {
  const { url, user, password } = useKodi.getState();
  return { url, user, password };
}

/** Registers player events. Call only once (from the player); also reads back the settings. */
export function initKodi(ev: RemoteEvents, queue: () => { queue: Song[]; index: number }): void {
  events = ev;
  queueOf = queue;
  void hydrate();
}

async function hydrate(): Promise<void> {
  try {
    const raw = await getItem(STORAGE_KEY);
    const p = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    useKodi.setState({
      enabled: p.enabled === true,
      url: str(p.url),
      user: str(p.user),
      password: str(p.password),
      name: str(p.name),
      addon: p.addon === true,
      hydrated: true,
    });
  } catch {
    useKodi.setState({ hydrated: true });
  }
}

function persist(): void {
  const { enabled, url, user, password, name, addon } = useKodi.getState();
  void setItem(STORAGE_KEY, JSON.stringify({ enabled, url, user, password, name, addon }));
}

/** Keeps the address and account, for every profile. Empty to forget them. */
export function setKodiConfig(url: string, user: string, password: string): void {
  useKodi.setState({ url: normalizeKodiUrl(url), user: user.trim(), password });
  persist();
}

/** The switch. Off takes the row away, and the session with it. */
export function setKodiEnabled(enabled: boolean): void {
  useKodi.setState({ enabled });
  persist();
  if (!enabled && isKodiConnected()) void kodiDisconnect();
}

/**
 * Asks Kodi what it is, and keeps the answer: its name for the row, and
 * whether the add-on is there. Throws what went wrong.
 */
export async function kodiTest(): Promise<{ name: string; addon: boolean }> {
  const info = await describeKodi(config());
  useKodi.setState(info);
  persist();
  return info;
}

/** A song of ours in Kodi's playlist: `songId@index`, the same key Cast uses. */
function keyFor(song: Song, index: number): string {
  return `${song.id}@${index}`;
}

/** Where in the queue a handed track sits, as for Home Assistant. */
function indexForKey(key: string, songId: string, queue: Song[], from: number): number {
  const at = Number(key.slice(key.lastIndexOf('@') + 1));
  if (Number.isInteger(at) && queue[at]?.id === songId) return at;
  const after = queue.findIndex((song, i) => i > from && song.id === songId);
  return after >= 0 ? after : queue.findIndex((song) => song.id === songId);
}

function resetTrackState(): void {
  failures = 0;
  handed = [];
  current = 0;
  loading = false;
  quietPolls = 0;
  foreignPolls = 0;
  lastPositionSec = 0;
  lastDurationSec = 0;
  wasPlaying = false;
  pausedByUs = false;
  finishedFired = false;
  idle = false;
  pendingSeekSec = null;
  pendingPause = false;
  inFlightSync = null;
}

export async function kodiConnect(): Promise<boolean> {
  if (!kodiConfigured()) return false;
  try {
    await kodiTest();
  } catch (e) {
    useToast.getState().show(e instanceof KodiError && e.kind === 'unauthorized' ? tg('Kodi refused the user or password') : tg("Couldn't reach Kodi"));
    return false;
  }
  resetTrackState();
  useKodi.setState({ connected: true });
  if (__DEV__) console.log(`[kodi] connected · ${useKodi.getState().name} · add-on ${useKodi.getState().addon}`);
  startPolling();
  events?.onConnected();
  return true;
}

/**
 * Ends the session; with `silent` it doesn't notify the player (when
 * switching output), and with `leaveSounding` it doesn't stop Kodi, which is
 * for when what plays there is not ours to stop.
 */
export async function kodiDisconnect(silent = false, leaveSounding = false): Promise<void> {
  if (!isKodiConnected()) return;
  if (__DEV__) console.log(`[kodi] disconnect · ${silent ? 'silent' : 'back to the phone'}${leaveSounding ? ' · left playing' : ''}`);
  stopPolling();
  castStop();
  void stopLocalHttp();
  useKodi.setState({ connected: false });
  const resumeAtSec = lastPositionSec;
  resetTrackState();
  sentVolume = null;
  // The app first and Kodi second: a TV that went away is a timeout, and the
  // song is not going to wait that long to come back to the phone.
  if (!silent) events?.onDisconnected(resumeAtSec);
  if (!leaveSounding) await kodiStop(config()).catch(() => undefined);
}

function startPolling(): void {
  stopPolling();
  stopPolls = everyMs(POLL_MS, () => void poll());
  void poll();
}

function stopPolling(): void {
  stopPolls?.();
  stopPolls = null;
  polling = false;
}

async function poll(): Promise<void> {
  if (!isKodiConnected() || polling) return;
  polling = true;
  try {
    const state = await kodiState(config());
    failures = 0;
    if (isKodiConnected()) onState(state);
  } catch (e) {
    failures++;
    if (__DEV__) console.log(`[kodi] poll failed (${failures}) · ${e instanceof Error ? e.message : String(e)}`);
    const refused = e instanceof KodiError && e.kind === 'unauthorized';
    if ((refused || failures >= MAX_FAILURES) && isKodiConnected()) {
      useToast.getState().show(refused ? tg('Kodi refused the user or password') : tg('Lost contact with Kodi'));
      void kodiDisconnect();
    }
  } finally {
    polling = false;
  }
}

/** Kodi names a resolved add-on item by the address behind it. */
function isHanded(state: KodiState, at: number): boolean {
  const h = handed[at];
  return !!h && (state.file === h.file || state.file === h.url);
}

function onState(state: KodiState): void {
  if (state.volume != null) reportVolume(state.volume);
  if (loading) {
    // What Kodi says until it is on the first track handed is about what it
    // played before.
    if (!(state.active && state.position === 0 && isHanded(state, 0))) {
      if (++quietPolls >= LOAD_QUIET_POLLS) loadFellFlat();
      return;
    }
    loading = false;
    quietPolls = 0;
    current = 0;
  }
  idle = !state.active;
  if (!state.active) {
    // Stopped. After the last track handed and near its end, that is the
    // queue running out (or a track with nothing handed behind it: repeat
    // one, the sleep timer), and the app decides what comes next. Otherwise
    // it was stopped on the TV, which is a pause as far as the app goes.
    if (wasPlaying && !pausedByUs && !finishedFired && current >= handed.length - 1 && lastPositionSec >= lastDurationSec - NEAR_END_SEC) {
      finishedFired = true;
      wasPlaying = false;
      events?.onFinished();
      return;
    }
    wasPlaying = false;
    events?.onPlayingChanged(false, false);
    return;
  }
  if (!isHanded(state, state.position)) {
    // Something else on the TV: somebody picked it there. It is theirs now,
    // and is left playing.
    if (++foreignPolls >= TAKEN_OVER_POLLS) {
      useToast.getState().show(tg('Something else is playing on Kodi'));
      void kodiDisconnect(false, true);
    }
    return;
  }
  foreignPolls = 0;
  if (state.position !== current) {
    current = state.position;
    const now = queueOf?.();
    const h = handed[current];
    const index = now ? indexForKey(h.key, h.songId, now.queue, now.index) : -1;
    if (index < 0) {
      // A track that has left the queue since it was handed: Kodi is not
      // followed into it, the queue's own next is loaded instead.
      finishedFired = true;
      wasPlaying = false;
      events?.onFinished();
      return;
    }
    finishedFired = false;
    lastDurationSec = state.durationSec;
    if (__DEV__) console.log(`[kodi] on to place ${current} · queue index ${index}`);
    events?.onTrackChanged(index, state.positionSec, state.durationSec);
  }
  lastPositionSec = state.positionSec;
  if (state.durationSec > 0) lastDurationSec = state.durationSec;
  if (state.playing) {
    wasPlaying = true;
    pausedByUs = false;
    finishedFired = false;
    if (pendingSeekSec != null || pendingPause) {
      void settleLoad();
      return;
    }
  }
  events?.onProgress(state.positionSec, state.durationSec || lastDurationSec);
  events?.onPlayingChanged(state.playing, false);
}

/**
 * The position and the pause a load asked for: Kodi starts its playlist from
 * the top and playing whatever it is told, so both are sent once it is on
 * the track, and again from the next poll if it played on regardless.
 */
async function settleLoad(): Promise<void> {
  const seek = pendingSeekSec;
  const pause = pendingPause;
  pendingSeekSec = null;
  pendingPause = false;
  try {
    if (seek != null) {
      await kodiSeek(config(), seek);
      lastPositionSec = seek;
    }
    if (pause) {
      pausedByUs = true;
      await kodiPlayPause(config(), false);
    }
  } catch {
    return;
  }
  if (!isKodiConnected()) return;
  events?.onProgress(seek ?? lastPositionSec, lastDurationSec);
  events?.onPlayingChanged(!pause, false);
}

function loadFellFlat(): void {
  loading = false;
  quietPolls = 0;
  handed = [];
  useToast.getState().show(tg("Kodi couldn't play this song"));
  events?.onPlayingChanged(false, false);
}

function reportVolume(volume: number): void {
  if (sentVolume) {
    if (Math.abs(sentVolume.value - volume) < 0.01) {
      sentVolume = null;
      return;
    }
    if (Date.now() - sentVolume.at < VOLUME_ECHO_MS) return;
    sentVolume = null;
  }
  events?.onVolume?.(volume);
}

/** What Kodi is handed for the song at this place, or null when nothing can serve it. */
function handOf(song: Song | undefined, index: number): Handed | null {
  if (!song) return null;
  const url = remoteTrackUrl(song);
  if (!url) return null;
  const info = remoteTrackInfo(song);
  const file = fileFor({ url, ...info }, useKodi.getState().addon);
  return { file, url, songId: song.id, key: keyFor(song, index) };
}

/** The songs at these places, up to the first that cannot be served. */
function handsOf(queue: Song[], indices: number[]): Handed[] {
  const out: Handed[] = [];
  for (const i of indices) {
    const h = handOf(queue[i], i);
    if (!h) break;
    out.push(h);
  }
  return out;
}

/**
 * Loads the track at the state's index on Kodi, with what follows it behind.
 * Returns false if there is no session, nothing can serve the song, or Kodi
 * refused; the reason is shown from here.
 */
export async function loadKodiQueue(state: CastQueueState, autoplay: boolean, startSec = 0): Promise<boolean> {
  if (!isKodiConnected()) return false;
  const song = state.queue[state.index];
  if (!song) return false;
  // Already in Kodi's playlist, next or a few further (the next button):
  // Kodi is moved there rather than handed everything again, which keeps the
  // gap between the two songs to Kodi's own.
  const key = keyFor(song, state.index);
  const at = handed.findIndex((h, i) => i > current && h.key === key);
  if (at > 0 && autoplay && startSec === 0 && !loading && !idle) {
    try {
      await kodiGoTo(config(), at);
      return true;
    } catch {
      // Handed again below.
    }
  }
  const tail = tailIndices(state);
  await ensureLocalFilesServed([song, ...tail.map((i) => state.queue[i])].filter((s): s is Song => !!s));
  const first = handOf(song, state.index);
  if (!first) return false;
  resetTrackState();
  handed = [first, ...handsOf(state.queue, tail)];
  loading = true;
  lastPositionSec = startSec;
  lastDurationSec = song.duration ?? 0;
  pendingSeekSec = startSec > 0 ? startSec : null;
  pendingPause = !autoplay;
  pausedByUs = !autoplay;
  if (__DEV__) console.log(`[kodi] load · ${handed.length} tracks · ${autoplay ? 'playing' : 'paused'} at ${startSec.toFixed(1)}s`);
  try {
    await kodiPlay(config(), handed.map((h) => h.file));
  } catch (e) {
    loading = false;
    handed = [];
    const reason = e instanceof KodiError ? e.message : '';
    useToast.getState().show(reason ? `${tg("Kodi couldn't play this song")} (${reason})` : tg("Kodi couldn't play this song"));
    return false;
  }
  return true;
}

/**
 * Brings what Kodi holds after the track playing in line with the queue:
 * topped up while it still begins the way the queue does, taken out and
 * written again when it does not. Nothing is done while Kodi is not on the
 * queue's current track: the load that is coming sets everything anyway.
 */
export async function syncKodiQueue(state: CastQueueState): Promise<boolean> {
  if (!isKodiConnected() || loading) return false;
  const song = state.queue[state.index];
  if (!song || handed[current]?.key !== keyFor(song, state.index)) return false;
  if (inFlightSync) return inFlightSync;
  const run = (async () => {
    const wanted = tailIndices(state);
    let held = handed.slice(current + 1);
    const stillRight = held.every((h, i) => {
      const at = wanted[i];
      const s = at === undefined ? undefined : state.queue[at];
      return !!s && keyFor(s, at) === h.key;
    });
    if (!stillRight) {
      await kodiTrimAfter(config(), current, handed.length);
      handed = handed.slice(0, current + 1);
      held = [];
    }
    const missing = wanted.slice(held.length);
    if (missing.length === 0) return true;
    await ensureLocalFilesServed(missing.map((i) => state.queue[i]).filter((s): s is Song => !!s));
    const more = handsOf(state.queue, missing);
    await kodiAdd(config(), more.map((h) => h.file));
    handed.push(...more);
    return true;
  })();
  inFlightSync = run;
  try {
    return await run;
  } catch {
    return false;
  } finally {
    if (inFlightSync === run) inFlightSync = null;
  }
}

/**
 * The queue's current song handed to Kodi again, from `sec`: what play and
 * seek come to once Kodi's player is closed, since there is nothing left
 * there to resume or move. The repeat setting is the player's to restore,
 * which it does with the next sync.
 */
function reload(autoplay: boolean, sec: number): Promise<boolean> {
  const now = queueOf?.();
  if (!now) return Promise.resolve(false);
  return loadKodiQueue({ ...now, repeat: 'off', sleepAtSongEnd: false }, autoplay, sec);
}

export async function kodiResume(): Promise<void> {
  pendingPause = false;
  pausedByUs = false;
  if (idle) {
    await reload(true, lastPositionSec >= lastDurationSec - NEAR_END_SEC ? 0 : lastPositionSec);
    return;
  }
  await kodiPlayPause(config(), true).catch(() => undefined);
}

export async function kodiPause(): Promise<void> {
  pendingPause = false;
  pausedByUs = true;
  await kodiPlayPause(config(), false).catch(() => undefined);
}

export async function kodiSeekTo(sec: number): Promise<void> {
  pendingSeekSec = null;
  lastPositionSec = sec;
  if (idle) {
    await reload(false, sec);
    return;
  }
  await kodiSeek(config(), sec).catch(() => undefined);
}

/** Kodi's own volume; the app slider goes 0..1. */
export function kodiVolume(volume: number): void {
  const value = Math.max(0, Math.min(1, volume));
  sentVolume = { value, at: Date.now() };
  void kodiSetVolume(config(), value).catch(() => undefined);
}
