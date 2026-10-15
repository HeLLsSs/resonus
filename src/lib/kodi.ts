/**
 * Kodi's JSON-RPC API, for the part of it the app has a use for: its music
 * player and the playlist behind it.
 *
 * Kodi is a TV's player, reached over HTTP once "Allow remote control via
 * HTTP" is on (Settings › Services › Control). It is handed addresses the way
 * a Cast receiver is (see `store/remoteTrack.ts`), and unlike most outputs
 * its queue can be edited in place: tracks taken out from behind the one
 * playing, others added, without the music stopping.
 *
 * With the Resonuls add-on installed (`plugin.audio.resonuls`), each address
 * goes through it (`?action=stream`) so that Kodi shows the title, artist
 * and cover on the TV instead of a file name. Without it, Kodi plays the
 * bare address.
 *
 * Nothing here knows about the queue or the player store; that is
 * `store/kodi.ts`. This file is the requests and the reading of what comes
 * back, kept pure so that it can be tested without a TV.
 */
// Not the global `fetch`: React Native's stops answering in the background,
// and the player is asked where it is for as long as it plays, screen off
// included. See the note in `api/subsonic.ts`.
import { fetch } from 'expo/fetch';

/** Long enough for a Raspberry Pi in a cupboard, short enough that a tap is
 *  not held hostage by a TV that is off. */
const TIMEOUT_MS = 8_000;
/** Kodi's web server, as it comes out of the box. */
const DEFAULT_PORT = 8080;
/** The music playlist and the music player, which have fixed ids in Kodi. */
const MUSIC = 0;
/** The add-on that names what it is handed, when Kodi has it. */
export const KODI_ADDON = 'plugin.audio.resonuls';

export interface KodiConfig {
  /** `http://192.168.1.20:8080`, without a trailing slash. */
  url: string;
  /** The web server's user and password, empty when it asks for none. */
  user: string;
  password: string;
}

export class KodiError extends Error {
  constructor(
    readonly kind: 'unauthorized' | 'unreachable' | 'refused' | 'other',
    message: string,
  ) {
    super(message);
    this.name = 'KodiError';
  }
}

/** What Kodi is, as asked when it is picked. */
export interface KodiInfo {
  /** Its name in Kodi's settings (Services › General › Device name). */
  name: string;
  /** The Resonuls add-on is there and switched on. */
  addon: boolean;
}

/** What one poll says. */
export interface KodiState {
  /** The music player is open, whatever it is doing. */
  active: boolean;
  /** Playing, as opposed to paused. */
  playing: boolean;
  /** Where in the playlist it is; -1 when nothing is open. */
  position: number;
  positionSec: number;
  durationSec: number;
  /** The address of what it plays, as it was handed. */
  file: string;
  /** 0..1, or null when Kodi did not say. */
  volume: number | null;
}

/** How many tracks after the current one Kodi holds. */
export const NEXT_ITEMS = 10;

/** The shape of the queue the tail is read from (the store's `CastQueueState`). */
export interface QueueShape {
  queue: readonly unknown[];
  index: number;
  repeat: 'off' | 'all' | 'one';
  sleepAtSongEnd?: boolean;
}

/**
 * The places after the current one that Kodi should hold, in order: the
 * next few, going round with repeat "all". None with repeat "one" (the track
 * is handed again when it ends) or when the track is to be the last one
 * heard: the finish must reach the app for the sleep timer to act on it.
 */
export function tailIndices({ queue, index, repeat, sleepAtSongEnd }: QueueShape): number[] {
  if (repeat === 'one' || sleepAtSongEnd || queue.length === 0) return [];
  const out: number[] = [];
  for (let step = 1; step <= NEXT_ITEMS; step++) {
    const i = index + step;
    if (i < queue.length) out.push(i);
    else if (repeat === 'all' && queue.length > 1 && i % queue.length !== index) out.push(i % queue.length);
    else break;
  }
  return out;
}

/** What a track is handed with, for the add-on to show. */
export interface KodiTrack {
  url: string;
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  durationSec: number;
}

/**
 * The address typed in, as Kodi's web server is reached: a scheme when none
 * was given, its port when none was given, and without the path to the API,
 * which some copy from Kodi's own documentation.
 */
export function normalizeKodiUrl(input: string): string {
  let url = input.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '').replace(/\/jsonrpc$/i, '');
  // No colon after the host: no port given. A bracketed IPv6 address has
  // colons of its own, and is only given one after its closing bracket.
  const host = url.replace(/^https?:\/\//i, '');
  if (!/(^[^:\[\]]+|\])(:\d+)$/.test(host)) url = `${url}:${DEFAULT_PORT}`;
  return url;
}

/** `user:password` in base64, from UTF-8: `btoa` alone refuses anything past Latin-1. */
function basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

interface RpcCall {
  method: string;
  params?: Record<string, unknown>;
}

interface RpcAnswer {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Sends one call, or several in one request (Kodi answers a list with a
 * list), and gives back what each one answered, in order. A call Kodi
 * refused comes back as its error rather than failing the others: asking
 * the player where it is while it is closed is refused, and that is an
 * answer too.
 */
export async function rpcBatch(config: KodiConfig, calls: RpcCall[]): Promise<RpcAnswer[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.user) headers.Authorization = basic(config.user, config.password);
  const body = calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params ?? {} }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${config.url}/jsonrpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new KodiError('unreachable', 'Kodi does not answer');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new KodiError('unauthorized', 'Kodi refused the user or password');
  if (!res.ok) throw new KodiError('other', `HTTP ${res.status}`);
  let answers: unknown;
  try {
    answers = JSON.parse(await res.text());
  } catch {
    throw new KodiError('other', 'Not an answer from Kodi');
  }
  if (!Array.isArray(answers)) throw new KodiError('other', 'Not an answer from Kodi');
  const byId = new Map<number, RpcAnswer>();
  for (const a of answers as RpcAnswer[]) if (typeof a?.id === 'number') byId.set(a.id, a);
  return calls.map((_, id) => byId.get(id) ?? { error: { message: 'No answer' } });
}

/** One call; a refusal throws. */
export async function rpc<T = unknown>(config: KodiConfig, method: string, params?: Record<string, unknown>): Promise<T> {
  const [answer] = await rpcBatch(config, [{ method, params }]);
  if (answer.error) throw new KodiError('refused', answer.error.message ?? method);
  return answer.result as T;
}

/** Kodi's `{hours, minutes, seconds, milliseconds}`, in seconds. */
export function secondsOf(time: unknown): number {
  if (!time || typeof time !== 'object') return 0;
  const t = time as Record<string, unknown>;
  const n = (k: string) => (typeof t[k] === 'number' ? (t[k] as number) : 0);
  return n('hours') * 3600 + n('minutes') * 60 + n('seconds') + n('milliseconds') / 1000;
}

/** Seconds, the way Kodi takes a time. */
export function timeOf(sec: number): { hours: number; minutes: number; seconds: number; milliseconds: number } {
  const ms = Math.max(0, Math.round(sec * 1000));
  return {
    hours: Math.floor(ms / 3_600_000),
    minutes: Math.floor(ms / 60_000) % 60,
    seconds: Math.floor(ms / 1000) % 60,
    milliseconds: ms % 1000,
  };
}

/** Kodi's name, and whether the add-on is there. */
export async function describeKodi(config: KodiConfig): Promise<KodiInfo> {
  const [labels, addon] = await rpcBatch(config, [
    { method: 'XBMC.GetInfoLabels', params: { labels: ['System.FriendlyName'] } },
    { method: 'Addons.GetAddonDetails', params: { addonid: KODI_ADDON, properties: ['enabled'] } },
  ]);
  if (labels.error) throw new KodiError('other', 'Not a Kodi');
  const name = (labels.result as Record<string, unknown> | undefined)?.['System.FriendlyName'];
  const details = (addon.result as { addon?: { enabled?: unknown } } | undefined)?.addon;
  return { name: typeof name === 'string' && name.trim() ? name.trim() : 'Kodi', addon: details?.enabled === true };
}

/** Reads one poll's four answers (see `kodiState`). */
export function stateFrom(answers: RpcAnswer[]): KodiState {
  const [players, props, item, app] = answers;
  const active =
    Array.isArray(players.result) &&
    (players.result as { playerid?: unknown; type?: unknown }[]).some((p) => p.playerid === MUSIC && p.type === 'audio');
  const p = (active ? props.result : undefined) as Record<string, unknown> | undefined;
  const file = (active ? (item.result as { item?: { file?: unknown } } | undefined)?.item?.file : undefined) ?? '';
  const volume = (app.result as { volume?: unknown } | undefined)?.volume;
  return {
    active,
    playing: active && typeof p?.speed === 'number' && p.speed !== 0,
    position: active && typeof p?.position === 'number' ? p.position : -1,
    positionSec: secondsOf(p?.time),
    durationSec: secondsOf(p?.totaltime),
    file: typeof file === 'string' ? file : '',
    volume: typeof volume === 'number' ? Math.max(0, Math.min(1, volume / 100)) : null,
  };
}

/** Where the music player is, in one request. */
export async function kodiState(config: KodiConfig): Promise<KodiState> {
  return stateFrom(
    await rpcBatch(config, [
      { method: 'Player.GetActivePlayers' },
      { method: 'Player.GetProperties', params: { playerid: MUSIC, properties: ['time', 'totaltime', 'speed', 'position'] } },
      { method: 'Player.GetItem', params: { playerid: MUSIC, properties: ['file'] } },
      { method: 'Application.GetProperties', params: { properties: ['volume'] } },
    ]),
  );
}

/**
 * The address Kodi is handed for a track: through the add-on with what to
 * show, when it is there, or bare.
 */
export function fileFor(track: KodiTrack, addon: boolean): string {
  if (!addon) return track.url;
  const params = new URLSearchParams({ action: 'stream', url: track.url, title: track.title });
  if (track.artist) params.set('artist', track.artist);
  if (track.album) params.set('album', track.album);
  if (track.artworkUrl) params.set('art', track.artworkUrl);
  if (track.durationSec > 0) params.set('duration', String(Math.round(track.durationSec)));
  return `plugin://${KODI_ADDON}/?${params.toString()}`;
}

/** Empties the music playlist, fills it with these and starts the first. */
export async function kodiPlay(config: KodiConfig, files: string[]): Promise<void> {
  const answers = await rpcBatch(config, [
    { method: 'Playlist.Clear', params: { playlistid: MUSIC } },
    { method: 'Playlist.Add', params: { playlistid: MUSIC, item: files.map((file) => ({ file })) } },
    { method: 'Player.Open', params: { item: { playlistid: MUSIC, position: 0 } } },
  ]);
  const refused = answers.find((a) => a.error);
  if (refused) throw new KodiError('refused', refused.error?.message ?? 'Player.Open');
}

/** Adds these behind what the playlist holds. */
export async function kodiAdd(config: KodiConfig, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await rpc(config, 'Playlist.Add', { playlistid: MUSIC, item: files.map((file) => ({ file })) });
}

/**
 * Takes out every track after `position`, last first so that the positions
 * still to go do not move. The one playing cannot be taken out, and is not.
 */
export async function kodiTrimAfter(config: KodiConfig, position: number, length: number): Promise<void> {
  const calls: RpcCall[] = [];
  for (let p = length - 1; p > position; p--) calls.push({ method: 'Playlist.Remove', params: { playlistid: MUSIC, position: p } });
  if (calls.length > 0) await rpcBatch(config, calls);
}

/** To that place in the playlist. */
export async function kodiGoTo(config: KodiConfig, position: number): Promise<void> {
  await rpc(config, 'Player.GoTo', { playerid: MUSIC, to: position });
}

export async function kodiPlayPause(config: KodiConfig, play: boolean): Promise<void> {
  await rpc(config, 'Player.PlayPause', { playerid: MUSIC, play });
}

/** To this second of the track, rather than by it: `seconds` alone is a step. */
export async function kodiSeek(config: KodiConfig, sec: number): Promise<void> {
  await rpc(config, 'Player.Seek', { playerid: MUSIC, value: { time: timeOf(sec) } });
}

/** Stops, and lets the playlist go: it holds addresses with this account's key in them. */
export async function kodiStop(config: KodiConfig): Promise<void> {
  await rpcBatch(config, [
    { method: 'Player.Stop', params: { playerid: MUSIC } },
    { method: 'Playlist.Clear', params: { playlistid: MUSIC } },
  ]);
}

/** 0..1, as Kodi's 0..100. */
export async function kodiSetVolume(config: KodiConfig, volume: number): Promise<void> {
  await rpc(config, 'Application.SetVolume', { volume: Math.round(Math.max(0, Math.min(1, volume)) * 100) });
}
