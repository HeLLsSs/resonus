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
   * Whether this phone plays the music, or only shows and steers it: the
   * phone in your hand while the speakers are on the computer that opened
   * the session. Kept across sessions, since it is about the phone.
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

let hooks: JamHooks | null = null;
let token = '';
/** Server clock minus ours, in ms. */
let offsetMs = 0;
let pollAbort: AbortController | null = null;
/** Stop the align and clock beats (see `everyMs`); null while there are none. */
let stopAlign: (() => void) | null = null;
let stopClock: (() => void) | null = null;
let appStateSub: { remove: () => void } | null = null;
/** Which session the loops belong to, so a stale loop ends itself. */
let generation = 0;

/** Registers the player's hooks. Call once, from the player. */
export function initJam(h: JamHooks): void {
  hooks = h;
}

export function isJamActive(): boolean {
  return !!token && !!useJam.getState().session;
}

export function jamCode(): string | null {
  return useJam.getState().session?.code ?? null;
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

/** Who added the song at this position of the queue, by name. */
export function jamAddedBy(index: number): string {
  const id = useJam.getState().addedBy[index];
  return id ? jamMemberName(id) : '';
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
    await syncClock();
    let view = await createJam(auth(), auth().username);
    const here = hooks?.snapshot();
    if (here && here.songs.length > 0) {
      view = await jamCommand(auth(), view.token, {
        type: 'replace',
        songs: here.songs,
        index: here.index,
        position: Math.round(here.positionSec * 1000),
      });
      // Paused here stays paused there: `replace` starts playing, which is
      // right for a list somebody picked and wrong for one that was resting.
      if (!here.playing) view = await jamCommand(auth(), view.token, { type: 'pause' });
    }
    enter(view);
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
    await syncClock();
    enter(await joinJam(auth(), code, auth().username));
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

function enter(view: JamView): void {
  stop();
  const gen = ++generation;
  token = view.token;
  hooks?.silence(!useJam.getState().listenHere);
  take(view);
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
  hooks?.silence(false);
  useJam.setState({ session: null, me: '', addedBy: [] });
}

function positionAt(session: JamSession): () => number {
  return () => positionMs(session, serverNow()) / 1000;
}

/** A session as the proxy just told it: kept, and put into the player. */
function take(view: JamView): void {
  const { songs, addedBy } = splitQueue(view.session.queue);
  useJam.setState({ session: view.session, me: view.me, addedBy });
  void hooks?.follow(songs, view.session.index, view.session.playing, positionAt(view.session));
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
      if (e instanceof JamError && e.kind === 'gone') {
        stop();
        useToast.getState().show(tg('The Jam has ended'));
        return;
      }
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}
