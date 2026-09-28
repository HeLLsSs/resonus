/**
 * The Jam this phone is in, if any (see `lib/jam.ts` for what a Jam is).
 *
 * While it is in one, the player store still holds the queue and still
 * plays through this phone; what changes is who decides. A press on play,
 * next or the seek bar, a song added or removed, a whole album started: each
 * is sent to the session instead of being done, and done once the session
 * says so, on this phone and on every other one at the same moment. The
 * player asks `isJamActive` before every such action and hands the command
 * to `jamSend`; what comes back, and what the session pushes on its own, is
 * applied through the hooks the player registers here (`initJam`), which are
 * the only way into it that goes round its own interception.
 *
 * Keeping in time is `align`, once a second: the player's live position
 * against where the session says the track is, in the server's clock, which
 * this phone reads through the offset measured at the start and again now
 * and then.
 */
import { AppState } from 'react-native';
import { create } from 'zustand';

import { type Song } from '@/api/subsonic';
import { tg } from '@/i18n';
import {
  bestOffset,
  cleanCode,
  CLOCK_ROUNDS,
  clockSample,
  createJam,
  isCode,
  JamError,
  type JamCommand,
  type JamSession,
  type JamView,
  joinJam,
  jamCommand,
  jamState,
  positionMs,
  splitQueue,
} from '@/lib/jam';
import { everyMs } from '@/lib/ticker';
import { useAuthStore } from '@/store/auth';
import { useToast } from '@/store/toast';

/** How often the player is measured against the session. */
const ALIGN_EVERY_MS = 1_000;
/** How often the clock is measured again, in case it has drifted. */
const CLOCK_EVERY_MS = 5 * 60_000;
/** The pause after a failed poll before the next one. */
const RETRY_MS = 2_000;
/** What a session holds at most (the proxy's `JamStore::MAX_QUEUE`). */
const SESSION_MAX_QUEUE = 500;
/** Of a queue too long for it, how much of what was already played is kept. */
const KEEP_BEHIND = 50;
/** The least time between two volume commands from a slider or the keys. */
const VOLUME_EVERY_MS = 300;

/** What the player lends the session: the way to move it without asking it. */
export interface JamHooks {
  /**
   * Makes the player hold this queue at this index, playing or paused,
   * at the position `positionAt` gives when read. Loads what has to be.
   */
  follow: (songs: Song[], index: number, playing: boolean, positionAt: () => number) => Promise<void>;
  /**
   * Compares the live position with `positionAt()` and closes the gap, as
   * long as the player is on the song the session is on (`songId`): between
   * a track ending here and the session saying so, the two are a song apart
   * and there is nothing to align.
   */
  align: (positionAt: () => number, songId: string | undefined) => void;
  /** What the player holds right now, for a session opened around it. */
  snapshot: () => { songs: Song[]; index: number; playing: boolean; positionSec: number };
  /** Makes the player follow in silence, or gives it its voice back. */
  silence: (silent: boolean) => void;
  /** The Jam has just started or ended: what it changes about playback is applied to the song playing. */
  armed: () => void;
}

interface JamState {
  session: JamSession | null;
  /** Our member id in it. */
  me: string;
  /** Who added each song of the queue, by position (a member id). */
  addedBy: string[];
  /** Opening or joining a session right now. */
  busy: boolean;
  /**
   * Whether this phone plays the music, or only shows and steers it. The
   * one that opened the session plays; the ones that join it are silent, a
   * remote in the hand for the speakers that are elsewhere, unless they ask
   * to hear it here too. Decided on entering, and a switch for the rest.
   */
  listenHere: boolean;
}

export const useJam = create<JamState>(() => ({
  session: null,
  me: '',
  addedBy: [],
  busy: false,
  listenHere: true,
}));

/** Plays here, or only steers from here. */
export function setJamListenHere(listen: boolean): void {
  useJam.setState({ listenHere: listen });
  hooks?.silence(!listen);
}

/** The session's volume, 0..1; undefined for a proxy from before it had one. */
export function jamVolume(): number | undefined {
  return useJam.getState().session?.volume;
}

/** This device's own level, for the session's volume to be read from and applied to (`lib/jamVolume.ts`). */
export interface JamVolumeDevice {
  /** Moves the device's level: the phone's media volume, or the speaker's. */
  apply: (level: number) => void;
  /** The level right now. */
  read: () => number;
  /** The size of one step of the level, which is what the keys move by. */
  step: () => number;
}

let device: JamVolumeDevice | null = null;
/**
 * The level this device is known to be at: what the session last had applied
 * here, or what the device itself last said. What comes back from applying a
 * level lands on the device's own grid, up to half a step away, and that is
 * not a move to report; a key press is a whole step from it.
 */
let knownLevel = -1;
/** The device's level before the session's was put on it, given back on leaving. */
let levelBefore: number | null = null;
let volumeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingVolume: number | null = null;

export function setJamVolumeDevice(d: JamVolumeDevice): void {
  device = d;
}

/** The music moved to a speaker or back to the phone: the level is another
 *  thing's now, and the session's is put on it afresh. */
export function jamForgetLevel(): void {
  knownLevel = -1;
}

/** A level as the proxy keeps it, with two decimals. */
function toProxyLevel(level: number): number {
  return Math.round(level * 100) / 100;
}

/** Whether two levels are the same to the proxy. */
function sameLevel(a: number, b: number): boolean {
  return toProxyLevel(a) === toProxyLevel(b);
}

function nearKnown(level: number): boolean {
  return knownLevel >= 0 && Math.abs(level - knownLevel) <= (device?.step() ?? 0.05) / 2 + 1e-6;
}

/**
 * This device's volume moved: the session is told, so the device that plays
 * follows. The first move goes at once and the ones right behind it wait
 * their turn, the last value winning. `fromDevice` is a move read off the
 * device itself, the keys or a speaker, which is the one kind that can be the
 * session's own volume landing here and settling on the device's grid;
 * nothing goes out for that. A slider's move is meant, whatever its size.
 */
export function jamReportVolume(level: number, fromDevice = true): void {
  const held = jamVolume();
  // A proxy from before the session had a volume would refuse the command,
  // with a toast for every press of a key.
  if (!token || held === undefined) return;
  if (fromDevice && nearKnown(level)) {
    // The device's grid answering the level it was set to: remembered as
    // where the device really is, so the next key press counts from there.
    knownLevel = level;
    return;
  }
  knownLevel = level;
  if (sameLevel(level, held)) return;
  if (volumeTimer) {
    pendingVolume = level;
    return;
  }
  sendVolume(level);
  volumeTimer = setTimeout(() => {
    volumeTimer = null;
    const next = pendingVolume;
    pendingVolume = null;
    const now = jamVolume();
    if (next !== null && token && now !== undefined && !sameLevel(next, now)) sendVolume(next);
  }, VOLUME_EVERY_MS);
}

function sendVolume(level: number): void {
  void jamSend({ type: 'volume', level: toProxyLevel(level) });
}

let hooks: JamHooks | null = null;
let token = '';
/** Server clock minus ours, in ms. */
let offsetMs = 0;
let pollAbort: AbortController | null = null;
/** Stop the align and clock beats (see `everyMs`); null while there are none. */
let stopAlign: (() => void) | null = null;
let stopClock: (() => void) | null = null;
let appStateSub: { remove: () => void } | null = null;
let unsubAuth: (() => void) | null = null;
/** Which session the loops belong to, so a stale loop ends itself. */
let generation = 0;

/** Registers the player's hooks. Call once, from the player. */
export function initJam(h: JamHooks): void {
  hooks = h;
}

export function isJamActive(): boolean {
  return !!token && !!useJam.getState().session;
}

/** Whether this phone opened the session, or inherited it. */
export function isJamHost(): boolean {
  const { session, me } = useJam.getState();
  return !!session && session.hostId === me;
}

/** The name of a member, or nothing for one who has left. */
export function jamMemberName(id: string): string {
  return useJam.getState().session?.members.find((m) => m.id === id)?.name ?? '';
}

function auth() {
  const a = useAuthStore.getState().auth;
  if (!a) throw new JamError('refused', tg('Jam needs a server account'));
  return a;
}

/** The server's idea of now. */
function serverNow(): number {
  return Date.now() + offsetMs;
}

async function syncClock(): Promise<void> {
  const samples = [];
  for (let i = 0; i < CLOCK_ROUNDS; i++) {
    try {
      samples.push(await clockSample(auth()));
    } catch {
      // One reading fewer.
    }
  }
  const offset = bestOffset(samples);
  if (offset !== null) offsetMs = offset;
}

/**
 * Opens a session, with the profile's name on it, around what this phone is
 * playing: the queue goes in as it stands, at the second it is at, so the
 * others hear it from there rather than from silence.
 */
export async function startJam(): Promise<void> {
  if (isJamActive()) return;
  useJam.setState({ busy: true });
  try {
    // The clock is measured while the session opens: neither waits for the other.
    let [, view] = await Promise.all([syncClock(), createJam(auth(), auth().username)]);
    const here = hooks?.snapshot();
    if (here && here.songs.length > 0) {
      // A queue longer than the session holds is cut around the song playing:
      // a little of what was played, and as much of what is to come as fits.
      const from = here.songs.length > SESSION_MAX_QUEUE ? Math.max(0, here.index - KEEP_BEHIND) : 0;
      const songs = here.songs.slice(from, from + SESSION_MAX_QUEUE);
      view = await jamCommand(auth(), view.token, {
        type: 'replace',
        songs,
        index: here.index - from,
        position: Math.round(here.positionSec * 1000),
        playing: here.playing,
      });
      // Paused here stays paused there. A proxy from before `playing` was
      // part of `replace` starts playing regardless, and is told again.
      if (!here.playing && view.session.playing) view = await jamCommand(auth(), view.token, { type: 'pause' });
    }
    // The session opens at this device's own level, not at full volume: it
    // is the level everybody hears, and this is the device they hear.
    let level: number | undefined;
    if (view.session.volume !== undefined && device) {
      level = device.read();
      view = await jamCommand(auth(), view.token, { type: 'volume', level: toProxyLevel(level) });
    }
    enter(view, level);
  } finally {
    useJam.setState({ busy: false });
  }
}

/** Joins the session at this code, with the profile's name. */
export async function joinJamByCode(rawCode: string): Promise<void> {
  const code = cleanCode(rawCode);
  if (!isCode(code)) throw new JamError('refused', tg('A code has six letters or digits'));
  if (isJamActive()) await leaveJam();
  useJam.setState({ busy: true });
  try {
    const [, view] = await Promise.all([syncClock(), joinJam(auth(), code, auth().username)]);
    enter(view);
  } finally {
    useJam.setState({ busy: false });
  }
}

/** Leaves the session. What was playing keeps playing, on this phone alone. */
export async function leaveJam(): Promise<void> {
  const had = token;
  const a = useAuthStore.getState().auth;
  stop();
  if (had && a) await jamCommand(a, had, { type: 'leave' }).catch(() => {});
}

/** Ends the session for everybody. Only the host may. */
export async function endJam(): Promise<void> {
  const had = token;
  const a = useAuthStore.getState().auth;
  stop();
  if (had && a) await jamCommand(a, had, { type: 'end' }).catch(() => {});
}

/**
 * Sends a command and applies the session that comes back. A refusal is
 * shown; a session that is over is left.
 */
export async function jamSend(command: JamCommand): Promise<void> {
  if (!token) return;
  try {
    take(await jamCommand(auth(), token, command));
  } catch (e) {
    if (e instanceof JamError && e.kind === 'gone') {
      stop();
      useToast.getState().show(tg('The Jam has ended'));
    } else if (e instanceof JamError && e.kind === 'refused') {
      useToast.getState().show(e.message);
    } else {
      useToast.getState().show(tg('Could not reach the Jam'));
    }
  }
}

/** `ownLevel`: the level this device is at, when the session was just opened at it. */
function enter(view: JamView, ownLevel?: number): void {
  stop();
  const gen = ++generation;
  token = view.token;
  knownLevel = ownLevel ?? -1;
  // The one that opened it plays; the rest are silent until they ask.
  const listen = view.me === view.session.hostId;
  useJam.setState({ listenHere: listen });
  hooks?.silence(!listen);
  hooks?.armed();
  take(view);
  // A profile that goes away takes its session with it: the token was the
  // profile's, and steering a session it can no longer reach is worse than
  // leaving it.
  const profile = useAuthStore.getState().auth;
  unsubAuth = useAuthStore.subscribe((s) => {
    if (s.auth?.serverUrl !== profile?.serverUrl || s.auth?.username !== profile?.username) stop();
  });
  void poll(gen);
  let beats = 0;
  stopAlign = everyMs(ALIGN_EVERY_MS, () => {
    // Counted in development: whether the beat goes on with the screen off
    // is the one thing about it that cannot be seen any other way.
    if (__DEV__ && ++beats % 15 === 0) console.log(`[jam] beat ${beats}`);
    const { session } = useJam.getState();
    if (session?.playing) hooks?.align(positionAt(session), session.queue[session.index]?.id);
  });
  stopClock = everyMs(CLOCK_EVERY_MS, () => void syncClock());
  // Back from the background the timers above have been asleep: measure and
  // catch up now rather than at their next turn.
  appStateSub = AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    void syncClock().then(() => {
      const { session } = useJam.getState();
      if (session) hooks?.align(positionAt(session), session.queue[session.index]?.id);
    });
  });
}

function stop(): void {
  ++generation;
  token = '';
  pollAbort?.abort();
  pollAbort = null;
  stopAlign?.();
  stopClock?.();
  stopAlign = null;
  stopClock = null;
  appStateSub?.remove();
  appStateSub = null;
  unsubAuth?.();
  unsubAuth = null;
  if (volumeTimer) clearTimeout(volumeTimer);
  volumeTimer = null;
  pendingVolume = null;
  knownLevel = -1;
  // A phone that only steered had the session's level put on it for its
  // keys' sake; what plays on it now, alone, plays at its own level again.
  if (levelBefore !== null && !useJam.getState().listenHere) device?.apply(levelBefore);
  levelBefore = null;
  hooks?.silence(false);
  useJam.setState({ session: null, me: '', addedBy: [] });
  hooks?.armed();
}

function positionAt(session: JamSession): () => number {
  return () => positionMs(session, serverNow()) / 1000;
}

/** A session as the proxy just told it: kept, and put into the player. */
function take(view: JamView): void {
  const { songs, addedBy } = splitQueue(view.session.queue);
  const before = useJam.getState();
  useJam.setState({ session: view.session, me: view.me, addedBy });
  // The host left and the session fell to this phone: the music was coming
  // out of the phone that left, and somebody has to play it now.
  if (before.session && before.session.hostId !== view.me && view.session.hostId === view.me && !before.listenHere) {
    setJamListenHere(true);
  }
  void hooks?.follow(songs, view.session.index, view.session.playing, positionAt(view.session));
  // The session's volume, on every device in it: on the one that plays it
  // is the sound, on the others it is what their keys start from. Not from
  // a proxy that has none: that would be full volume everywhere.
  // Not while a move of this device's own is still on its way out: the
  // answer to the first of a burst would pull the level back before the
  // last of it lands.
  const level = view.session.volume;
  if (level !== undefined && pendingVolume === null && !nearKnown(level)) {
    if (levelBefore === null && device) levelBefore = device.read();
    knownLevel = level;
    device?.apply(level);
  }
}

/** Waits on the session for as long as we are in it. */
async function poll(gen: number): Promise<void> {
  while (gen === generation && token) {
    pollAbort = new AbortController();
    try {
      const since = useJam.getState().session?.version;
      const view = await jamState(auth(), token, since, pollAbort.signal);
      if (gen !== generation) return;
      take(view);
    } catch (e) {
      if (gen !== generation) return;
      if (e instanceof JamError && e.kind !== 'network') {
        stop();
        useToast.getState().show(e.kind === 'gone' ? tg('The Jam has ended') : tg('Could not reach the Jam'));
        return;
      }
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}
