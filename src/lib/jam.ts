/**
 * A Jam: several people hearing the same queue at the same moment, each on
 * their own device. The proxy keeps the session (`navifind`'s `JamStore`)
 * and is the clock: it holds no position, only where the track was at a
 * given moment of its own time and whether it is playing, and every member
 * works the position out from that (`positionMs`). So nothing here sends a
 * position anywhere; a command moves the anchor and everybody follows it.
 *
 * This file is the requests and the arithmetic, kept pure so the arithmetic
 * can be tested without a server or a player. What the arithmetic is applied
 * to is `store/jam.ts`.
 *
 * Everything lives under the proxy's `/rest/navifind/jam` path, which is the
 * one the front in front of it already relays, and the only route that asks
 * for the profile's credentials is the one that opens a session: from then on
 * a member is its token, which is what lets a guest in a browser take part
 * with no account at all.
 */
import { fetch } from 'expo/fetch';

import { authHeaders, type Song, type SubsonicAuth } from '@/api/subsonic';

/** How long one request may take. Above the proxy's own wait for an event. */
const TIMEOUT_MS = 20_000;
/** How many round trips measure the clock, keeping the shortest. */
export const CLOCK_ROUNDS = 4;

/** A song in the session's queue: the song, and who put it there. */
export type JamSong = Song & { addedBy?: string; addedAt?: number };

export interface JamMember {
  id: string;
  name: string;
}

/** The session as the proxy tells it. */
export interface JamSession {
  code: string;
  version: number;
  hostId: string;
  members: JamMember[];
  queue: JamSong[];
  index: number;
  playing: boolean;
  /** The moment, in the server's clock, `anchorPos` was true. */
  anchorAt: number;
  /** Milliseconds into the current track at `anchorAt`. */
  anchorPos: number;
  /** Where the server says the track was as it answered. */
  positionMs: number;
}

/** What every answer carries: the session, who we are in it, and the time it was sent. */
export interface JamView {
  now: number;
  me: string;
  token: string;
  session: JamSession;
}

export type JamCommand =
  | { type: 'play' | 'pause' | 'next' | 'previous' | 'clear' | 'leave' | 'end' }
  | { type: 'seek'; position: number }
  | { type: 'jump'; index: number }
  | { type: 'add'; songs: Song[]; where: 'next' | 'end' }
  | { type: 'remove'; index: number; id: string }
  | { type: 'move'; from: number; to: number }
  | { type: 'replace'; songs: Song[]; index: number; position?: number }
  | { type: 'kick'; memberId: string };

export class JamError extends Error {
  constructor(
    /** `gone`: the session is over or we are no longer in it. `refused`: the
     *  server said no. `network`: no answer at all. */
    readonly kind: 'gone' | 'refused' | 'network',
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'JamError';
  }
}

// ── Arithmetic ────────────────────────────────────────────────────────────

/** Where the current track is at `serverNowMs`, in ms, as every member computes it. */
export function positionMs(session: Pick<JamSession, 'queue' | 'index' | 'playing' | 'anchorAt' | 'anchorPos'>, serverNowMs: number): number {
  const song = session.queue[session.index];
  if (!song) return 0;
  let pos = session.anchorPos + (session.playing ? serverNowMs - session.anchorAt : 0);
  const duration = (song.duration ?? 0) * 1000;
  if (duration > 0) pos = Math.min(pos, duration);
  return Math.max(0, pos);
}

/**
 * One measurement of the server's clock against ours: asked at `sentAt`,
 * answered `serverNow` and received at `receivedAt`. The offset is what to
 * add to our clock to read the server's, assuming the answer was written
 * halfway through the round trip.
 */
export interface ClockSample {
  sentAt: number;
  receivedAt: number;
  serverNow: number;
}

/**
 * The offset the samples agree on: the one from the shortest round trip,
 * which is the one with the least room for the guess of "halfway" to be
 * wrong. Null with nothing to go on.
 */
export function bestOffset(samples: ClockSample[]): number | null {
  let best: ClockSample | null = null;
  for (const s of samples) {
    if (!best || s.receivedAt - s.sentAt < best.receivedAt - best.sentAt) best = s;
  }
  if (!best) return null;
  return best.serverNow - (best.sentAt + (best.receivedAt - best.sentAt) / 2);
}

/** How far the player may stray before it is moved, and before it is only hurried. */
export const SEEK_ABOVE_MS = 600;
export const NUDGE_ABOVE_MS = 120;
/** The rate a nudge plays at: enough to close a few hundred ms in seconds, not enough to hear. */
export const NUDGE_RATE = 0.04;

/**
 * What to do about being `driftMs` behind (positive) or ahead (negative) of
 * where the session is. A gap you would hear as a jump is closed by playing
 * a touch faster or slower instead, until it is closed; a gap too big for
 * that is jumped, once. Within tolerance, the rate goes back to normal.
 */
export function driftPlan(driftMs: number): { action: 'seek' } | { action: 'nudge'; rate: number } | { action: 'none' } {
  const abs = Math.abs(driftMs);
  if (abs > SEEK_ABOVE_MS) return { action: 'seek' };
  if (abs > NUDGE_ABOVE_MS) return { action: 'nudge', rate: driftMs > 0 ? 1 + NUDGE_RATE : 1 - NUDGE_RATE };
  return { action: 'none' };
}

/** The queue's songs, as the player keeps them, and who added each one. */
export function splitQueue(queue: JamSong[]): { songs: Song[]; addedBy: string[] } {
  const songs: Song[] = [];
  const addedBy: string[] = [];
  for (const { addedBy: by, addedAt: _at, ...song } of queue) {
    songs.push(song);
    addedBy.push(by ?? '');
  }
  return { songs, addedBy };
}

/** Whether two queues hold the same songs in the same order. */
export function sameQueue(a: Pick<Song, 'id'>[], b: Pick<Song, 'id'>[]): boolean {
  return a.length === b.length && a.every((s, i) => s.id === b[i]?.id);
}

/** A code as somebody typed it: upper case, without spaces or dashes. */
export function cleanCode(code: string): string {
  return code.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

export function isCode(code: string): boolean {
  return /^[A-Z2-9]{6}$/.test(code);
}

/** The page a guest opens in a browser: short enough to read out, and what the QR code carries. */
export function jamPageUrl(serverUrl: string, code: string): string {
  return `${serverUrl}/jam/${code}`;
}

/** The QR code of that page, drawn by the proxy. */
export function jamQrUrl(serverUrl: string, code: string): string {
  return `${serverUrl}/rest/navifind/jam/qr?code=${code}`;
}

// ── Requests ──────────────────────────────────────────────────────────────

async function call<T>(
  auth: Pick<SubsonicAuth, 'serverUrl' | 'headers'>,
  path: string,
  init: { method?: 'GET' | 'POST'; token?: string; json?: unknown; form?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  init.signal?.addEventListener('abort', () => controller.abort());
  const headers: Record<string, string> = { ...authHeaders(auth) };
  if (init.token) headers['X-Jam-Token'] = init.token;
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  }
  try {
    const res = await fetch(`${auth.serverUrl}/rest/navifind/jam${path}`, {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: { error?: string; ended?: boolean } & T;
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new JamError('refused', res.ok ? 'Not a Jam answer' : `HTTP ${res.status}`, res.status);
    }
    if (res.status === 401 || res.status === 410 || data.ended) {
      throw new JamError('gone', data.error ?? 'The Jam has ended', res.status);
    }
    if (!res.ok) throw new JamError('refused', data.error ?? `HTTP ${res.status}`, res.status);
    return data;
  } catch (e) {
    if (e instanceof JamError) throw e;
    throw new JamError('network', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** One reading of the server's clock, timed at both ends. */
export async function clockSample(auth: Pick<SubsonicAuth, 'serverUrl' | 'headers'>): Promise<ClockSample> {
  const sentAt = Date.now();
  const { now } = await call<{ now: number }>(auth, '/time');
  return { sentAt, receivedAt: Date.now(), serverNow: now };
}

/**
 * Opens a session, with the profile's own credentials: the proxy lets a
 * Navidrome user open one, and only that. The name is what the others see.
 */
export function createJam(auth: SubsonicAuth, name: string): Promise<JamView> {
  const form: Record<string, string> = { u: auth.username, name };
  if (auth.password !== undefined) form.p = auth.password;
  else {
    form.t = auth.token;
    form.s = auth.salt;
  }
  return call<JamView>(auth, '/create', { form });
}

export function joinJam(auth: Pick<SubsonicAuth, 'serverUrl' | 'headers'>, code: string, name: string): Promise<JamView> {
  return call<JamView>(auth, '/join', { json: { code, name } });
}

/**
 * The session now, or, with `since`, the session once it has changed from
 * that version, which the proxy waits a few seconds for before answering
 * with what it has.
 */
export function jamState(
  auth: Pick<SubsonicAuth, 'serverUrl' | 'headers'>,
  token: string,
  since?: number,
  signal?: AbortSignal,
): Promise<JamView> {
  return call<JamView>(auth, since === undefined ? '/state' : `/state?since=${since}`, { token, signal });
}

export function jamCommand(
  auth: Pick<SubsonicAuth, 'serverUrl' | 'headers'>,
  token: string,
  command: JamCommand,
): Promise<JamView> {
  return call<JamView>(auth, '/command', { token, json: command });
}
