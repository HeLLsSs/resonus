/**
 * Music Assistant's own WebSocket API, for the one part of it the app has a
 * use for: its players, and the library it has already made of the server the
 * app is signed in to.
 *
 * Music Assistant is reached directly here, not through Home Assistant. What
 * that buys is the whole reason this output exists:
 *
 * - **The app hands out no URL.** A track is named by the id it already has,
 *   through the provider instance Music Assistant indexed the same server
 *   with (`opensubsonic--4JU86B3S://track/<song id>`), and Music Assistant
 *   fetches it from the server itself. So nothing here serves files, relays a
 *   profile's headers or opens a port (`store/remoteTrack.ts` is not used at
 *   all), and the phone does not have to stay awake for the speaker to go on
 *   playing.
 * - **Nothing is polled.** The server pushes `player_updated`, `queue_updated`
 *   and `queue_time_updated` on the same socket, with no subscription to ask
 *   for, so where the player is and what it plays arrive as they change rather
 *   than every two seconds. The queue's own `current_index` is what says which
 *   track is playing; the player's media only has to agree.
 * - **A player says whether it is powered**, which is what a speaker in
 *   standby taking a song and staying silent looks like from the other side.
 *
 * Nothing here knows about the queue or the player store; that is
 * `store/musicAssistant.ts`. This file is the socket, the requests, and the
 * reading of what comes back, with the reading kept pure so it can be tested
 * without a server.
 *
 * The address and the credentials are the user's, not the account's: the same
 * house is there whichever server the app is signed in to.
 */

/** Long enough for a server on a Pi to answer, short enough that a tap is not
 *  held hostage by a Music Assistant that has gone away. */
const COMMAND_TIMEOUT_MS = 15_000;
/** The hello frame arrives the moment the socket opens, or the address is wrong. */
const OPEN_TIMEOUT_MS = 10_000;

/** The port Music Assistant listens on, for an address typed without one. */
const DEFAULT_PORT = 8095;

export type MusicAssistantErrorKind =
  /** The server answered and did not accept the token or the password. */
  | 'unauthorized'
  /** No answer at all: no network, a timeout, a socket that closed. */
  | 'network'
  /** The server answered and said no, for a reason in `message`. */
  | 'other';

export class MusicAssistantError extends Error {
  constructor(
    readonly kind: MusicAssistantErrorKind,
    message: string,
    /** The server's `error_code`, when it gave one. */
    readonly code?: number,
  ) {
    super(message);
    this.name = 'MusicAssistantError';
  }
}

/** Authentication is required (20), and the token is not good (23). */
const ERROR_AUTH_REQUIRED = 20;
const ERROR_INVALID_TOKEN = 23;

/** The hello frame, which every connection is greeted with. */
export interface MaServerInfo {
  serverId: string;
  name: string;
  version: string;
  schemaVersion: number;
}

/** What the app knows about a player of Music Assistant's. */
export interface MaPlayer {
  playerId: string;
  name: string;
  /** `chromecast`, `sonos`, `slimproto`… what found the player. */
  provider: string;
  available: boolean;
  /** Whether the player is switched on, or null when it does not say. */
  powered: boolean | null;
  state: 'playing' | 'paused' | 'idle' | 'unknown';
  /** 0..1, the app's scale; the server's own is 0..100. Null when it has no volume. */
  volume: number | null;
  /** Seconds into the track when `elapsedAtMs` was stamped, or null. */
  elapsedSec: number | null;
  /** Epoch milliseconds of the position above, or null. */
  elapsedAtMs: number | null;
  media: MaMedia | null;
  /** `play_media`, `seek`, `enqueue`, `volume_set`… as strings, not a bitfield. */
  features: string[];
}

/** What a player says it is playing. */
export interface MaMedia {
  /** Music Assistant's own name for it, which is not always the one we handed over. */
  uri: string | null;
  title: string | null;
  durationSec: number;
}

/** One of Music Assistant's providers, as `providers` lists them. */
export interface MaProvider {
  instanceId: string;
  /** `opensubsonic`, `jellyfin`, `filesystem_local`… */
  domain: string;
  name: string;
  available: boolean;
}

/** A track handed to a player, and what an update is matched against. */
export interface MaHanded {
  uri: string;
  title: string;
  songId: string;
}

/**
 * A player's queue: what `player_queues/get_active_queue` answers and what
 * `queue_updated` carries, which are the same shape.
 *
 * `current_index` is the server's own answer to which track is playing, and a
 * better one than reading the media the player names: Music Assistant renames
 * what it plays (a track handed over as `<provider>://track/<id>` comes back
 * as `library://track/3330`).
 */
export interface MaQueue {
  /** Equal to the player id. Null in an event that only says it in `object_id`. */
  queueId: string | null;
  /** Whether this queue is the one the player is on. */
  active: boolean;
  /** Where the queue is in its items, or null when it does not say. */
  currentIndex: number | null;
  /** Seconds into the current item, as the queue last knew it, or null. */
  elapsedSec: number | null;
  /** The queue adds songs of its own as it nears the end; null when unsaid. */
  fillsItself: boolean | null;
}

/**
 * The address as typed, made into one a socket can be opened on: a scheme
 * when none was given, the default port when none was given either (an
 * address for Music Assistant is an IP far more often than a domain), and
 * nothing past the host, since the socket always hangs off the root.
 *
 * Both `ws://` and `wss://` are accepted as typed, since the server
 * advertises an external `https://` URL of its own that people will paste.
 */
export function normalizeMaUrl(url: string): string {
  const typed = url.trim();
  if (!typed) return '';
  const hadScheme = /^(https?|wss?):\/\//i.test(typed);
  const withScheme = hadScheme ? typed : `http://${typed}`;
  const origin = /^([a-z]+:\/\/[^/?#]+)/i.exec(withScheme)?.[1] ?? '';
  if (!origin) return '';
  // A port only where the user gave neither a scheme nor a port: someone who
  // typed `https://music.example.com` meant 443 and nothing else.
  const host = origin.slice(origin.indexOf('://') + 3);
  const bare = !hadScheme && !/:\d+$/.test(host) && !host.includes('@');
  return bare ? `${origin}:${DEFAULT_PORT}` : origin;
}

/** The socket address for a normalized one: the scheme swapped, `/ws` on the end. */
export function wsUrlFor(url: string): string {
  const origin = normalizeMaUrl(url);
  if (!origin) return '';
  return `${origin.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')}/ws`;
}

/** How a track is named to Music Assistant: the provider it indexed the
 *  server with, and the id the app already holds for the song. */
export function trackUri(instanceId: string, songId: string): string {
  return `${instanceId}://track/${songId}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** What Music Assistant says it is playing, whatever shape it says it in. */
function mediaFrom(value: unknown): MaMedia | null {
  const raw = record(value);
  if (!raw) return null;
  const uri = str(raw.uri);
  const title = str(raw.title);
  if (!uri && !title) return null;
  return { uri, title, durationSec: num(raw.duration) ?? 0 };
}

/**
 * One player as `players/all` lists it, or as `player_updated` carries it.
 * Null for anything that is not a player, so a shape that changes under the
 * app costs the row rather than the session.
 */
export function playerFrom(value: unknown): MaPlayer | null {
  const raw = record(value);
  const playerId = raw ? str(raw.player_id) : null;
  if (!raw || !playerId) return null;
  const rawState = str(raw.state)?.toLowerCase() ?? '';
  const volume = num(raw.volume_level);
  return {
    playerId,
    name: str(raw.display_name) ?? str(raw.name) ?? playerId,
    provider: str(raw.provider) ?? '',
    // Said by every player seen so far; a player that stops saying it is
    // taken to be there rather than hidden.
    available: raw.available !== false,
    powered: typeof raw.powered === 'boolean' ? raw.powered : null,
    state: rawState === 'playing' || rawState === 'paused' || rawState === 'idle' ? rawState : 'unknown',
    // 0..100 on the wire, 0..1 everywhere in the app.
    volume: volume == null ? null : Math.max(0, Math.min(1, volume / 100)),
    elapsedSec: num(raw.elapsed_time),
    // A unix timestamp in seconds, as a float.
    elapsedAtMs: (() => {
      const at = num(raw.elapsed_time_last_updated);
      return at == null ? null : at * 1000;
    })(),
    media: mediaFrom(raw.current_media),
    features: Array.isArray(raw.supported_features)
      ? raw.supported_features.filter((f): f is string => typeof f === 'string')
      : [],
  };
}

/**
 * The players that can be played to, by name. Unavailable ones are left out:
 * every player appears exactly once here (there is none of Home Assistant's
 * one-speaker-several-entities), so a name in the list is a speaker that is
 * there.
 */
export function playersFrom(value: unknown): MaPlayer[] {
  if (!Array.isArray(value)) return [];
  const players: MaPlayer[] = [];
  for (const raw of value) {
    const player = playerFrom(raw);
    if (player?.available) players.push(player);
  }
  return players.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A queue, from the command that answers with one or from the event that
 * carries one. Null for anything that is not a queue; a queue that names no
 * `queue_id` is still one, since the event says it in `object_id` instead.
 */
export function queueFrom(value: unknown): MaQueue | null {
  const raw = record(value);
  if (!raw) return null;
  return {
    queueId: str(raw.queue_id),
    // Said by every queue seen so far; one that stops saying it is taken to be
    // the player's, as an inactive queue is not what gets pushed about.
    active: raw.active !== false,
    currentIndex: num(raw.current_index),
    elapsedSec: num(raw.elapsed_time),
    // Null when the queue does not say, which is how an older server reads.
    fillsItself: typeof raw.dont_stop_the_music_enabled === 'boolean' ? raw.dont_stop_the_music_enabled : null,
  };
}

/** The providers as `providers` lists them, music ones first where the server says. */
export function providersFrom(value: unknown): MaProvider[] {
  if (!Array.isArray(value)) return [];
  const out: MaProvider[] = [];
  for (const item of value) {
    const raw = record(item);
    const instanceId = raw ? str(raw.instance_id) : null;
    if (!raw || !instanceId) continue;
    // `type` says "music" on the servers that send it; where it is missing
    // nothing is dropped, since the domains below are the real filter.
    const type = str(raw.type)?.toLowerCase();
    if (type && type !== 'music') continue;
    out.push({
      instanceId,
      domain: str(raw.domain) ?? str(raw.provider_domain) ?? '',
      name: str(raw.name) ?? instanceId,
      available: raw.available !== false,
    });
  }
  return out;
}

/**
 * The provider domains that could be the server this profile is signed in to.
 * Navidrome, OpenSubsonic and Ampache are all one provider to Music Assistant
 * (`opensubsonic`, `subsonic` on older installs); Jellyfin is its own.
 */
function domainsFor(serverType: string | undefined): string[] {
  if (serverType === 'jellyfin') return ['jellyfin', 'emby'];
  return ['opensubsonic', 'subsonic'];
}

/**
 * Which of Music Assistant's libraries is the server the app is signed in to,
 * best guess first.
 *
 * A guess, because nothing in `providers` says which server a provider points
 * at: only that it speaks the same protocol. A house may have two of them, or
 * none, so this returns every candidate in order and the caller settles it by
 * asking one of them for a track id it already holds — an id from one server
 * does not exist on another.
 */
export function libraryCandidates(providers: MaProvider[], serverType: string | undefined): MaProvider[] {
  const wanted = domainsFor(serverType);
  return providers
    .filter((p) => wanted.includes(p.domain))
    .sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return wanted.indexOf(a.domain) - wanted.indexOf(b.domain);
    });
}

/**
 * Where the player is in the track right now. Music Assistant does not count
 * along: it reports the position it last learned and when it learned it, and
 * while the player plays the clock has run since. A paused player has not
 * moved, whatever the stamp says.
 */
export function positionAt(player: MaPlayer, nowMs: number): number {
  if (player.elapsedSec == null) return 0;
  let pos = player.elapsedSec;
  if (player.state === 'playing' && player.elapsedAtMs != null) {
    pos += Math.max(0, nowMs - player.elapsedAtMs) / 1000;
  }
  const duration = player.media?.durationSec ?? 0;
  if (duration > 0) pos = Math.min(pos, duration);
  return Math.max(0, pos);
}

/**
 * Which of the tracks handed over the player is on, or -1 for none of them.
 *
 * Not an equality on the URI: what was handed over is a provider URI
 * (`opensubsonic--X://track/abc`) and what comes back may be Music
 * Assistant's own name for the same track (`library://track/3330`), so the
 * song id inside the URI is the surer half of the match. The title is the
 * fallback, as for the other outputs.
 *
 * -1 is also what a player somebody else has taken over looks like, and that
 * is no reason to move the queue.
 */
export function handedIndexFor(media: MaMedia | null, handed: MaHanded[]): number {
  if (!media) return -1;
  const uri = media.uri;
  if (uri) {
    const exact = handed.findIndex((h) => h.uri === uri);
    if (exact >= 0) return exact;
    // An id is long and random enough that finding one inside a URI is not a
    // coincidence; an empty id (a load before its URI is known) matches nothing.
    const byId = handed.findIndex((h) => !!h.songId && uri.includes(h.songId));
    if (byId >= 0) return byId;
  }
  if (media.title) {
    const byTitle = handed.findIndex((h) => h.title === media.title);
    if (byTitle >= 0) return byTitle;
  }
  return -1;
}

/**
 * Which of the tracks handed over an index of the player's own queue names, or
 * -1 for one that is none of them.
 *
 * A subtraction, because the queue was written from here: the track at
 * `handed[0]` sits at `base` in the player's queue, and everything after it
 * follows in order. An index outside what was handed over is refused rather
 * than clamped — it is a queue somebody else has written, or one this app has
 * lost track of, and either way moving the app's queue on it would be a guess.
 */
export function handedIndexAt(currentIndex: number | null, base: number, count: number): number {
  if (currentIndex == null || !Number.isInteger(currentIndex)) return -1;
  const at = currentIndex - base;
  return at >= 0 && at < count ? at : -1;
}

/**
 * The position a `queue_time_updated` carries, in seconds, or null when it
 * carries none that can be read.
 *
 * Only the name of this event was ever seen on a live server, never its
 * payload, so nothing is assumed of it: a bare number, which is the plainest
 * thing an event named after one time value would be, and the `elapsed_time`
 * of a queue object, which is the only name a queue is known to give its
 * position. Anything else answers null, and the position goes on being derived
 * from the player's own `elapsed_time`, which works (`positionAt`).
 */
export function queueTimeFrom(value: unknown): number | null {
  const seconds = num(value) ?? num(record(value)?.elapsed_time);
  return seconds == null ? null : Math.max(0, seconds);
}

/**
 * Whether a player that has stopped stopped because the track ran out. The
 * window is wide, as for UPnP and Home Assistant: the last position seen can
 * be a moment old, and a player can stop reporting one in the closing
 * seconds. A track of unknown length is taken to have ended, since being
 * stuck is worse than moving on.
 */
export function nearEndOf(positionSec: number, durationSec: number): boolean {
  if (durationSec <= 0) return true;
  return positionSec >= durationSec - Math.max(5, durationSec * 0.1);
}

// ── The socket ──────────────────────────────────────────────────────────────

/** An event pushed on the socket, told from a reply by having no `message_id`. */
export interface MaEvent {
  event: string;
  objectId: string | null;
  data: unknown;
}

/**
 * The little of a WebSocket this client uses, so a test can hand it one that
 * is not a socket at all. React Native's global `WebSocket` fits it.
 */
export interface MaSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
}

export type MaSocketFactory = (url: string) => MaSocket;

function openSocket(url: string): MaSocket {
  const socket = new WebSocket(url);
  const wrapper: MaSocket = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  socket.onopen = () => wrapper.onopen?.();
  socket.onclose = () => wrapper.onclose?.();
  socket.onerror = (e) => wrapper.onerror?.(e);
  socket.onmessage = (e) => wrapper.onmessage?.({ data: e.data });
  return wrapper;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: MusicAssistantError) => void;
  timer: ReturnType<typeof setTimeout>;
  /** A long answer arrives in pieces, each `partial: true` until the last. */
  chunks: unknown[];
}

/**
 * One connection to Music Assistant: it opens, it is greeted, it carries
 * commands and their answers, and it pushes events all the while.
 *
 * The message ids are strings and are compared as strings on purpose: the
 * server echoes back whatever it was sent **as a string**, so a client that
 * numbered its requests would never recognise its own answers.
 */
export class MaClient {
  /** Events the server pushed; set by the owner before opening. */
  onEvent: ((event: MaEvent) => void) | null = null;
  /** The socket closed on its own: the owner decides whether to reconnect. */
  onClosed: (() => void) | null = null;

  private socket: MaSocket | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private closedByUs = false;
  private opening: Promise<MaServerInfo> | null = null;
  private hello: ((info: MaServerInfo) => void) | null = null;
  private helloFailed: ((error: MusicAssistantError) => void) | null = null;
  private info: MaServerInfo | null = null;
  /** When anything last arrived, for telling a quiet socket from a dead one. */
  private lastFrameAt = 0;

  constructor(
    private readonly url: string,
    private readonly factory: MaSocketFactory = openSocket,
  ) {}

  get serverInfo(): MaServerInfo | null {
    return this.info;
  }

  get idleMs(): number {
    return this.lastFrameAt === 0 ? 0 : Date.now() - this.lastFrameAt;
  }

  get isOpen(): boolean {
    return !!this.socket && !this.closedByUs;
  }

  /** Opens the socket and settles once the server has said hello. One use
   *  each: a connection that has closed is replaced, never reopened. */
  open(): Promise<MaServerInfo> {
    if (this.closedByUs) {
      return Promise.reject(new MusicAssistantError('network', 'This connection to Music Assistant is closed'));
    }
    if (this.opening) return this.opening;
    this.opening = new Promise<MaServerInfo>((resolve, reject) => {
      const timer = setTimeout(
        () => this.helloFailed?.(new MusicAssistantError('network', 'No answer from Music Assistant')),
        OPEN_TIMEOUT_MS,
      );
      this.hello = (info) => {
        clearTimeout(timer);
        this.hello = null;
        this.helloFailed = null;
        this.info = info;
        this.lastFrameAt = Date.now();
        resolve(info);
      };
      this.helloFailed = (error) => {
        clearTimeout(timer);
        this.hello = null;
        this.helloFailed = null;
        this.close();
        reject(error);
      };
      let socket: MaSocket;
      try {
        socket = this.factory(this.url);
      } catch (e) {
        this.helloFailed(new MusicAssistantError('network', e instanceof Error ? e.message : String(e)));
        return;
      }
      this.socket = socket;
      socket.onmessage = (message) => this.onFrame(message.data);
      socket.onerror = () => {
        // A socket that failed to open never says anything else; one that
        // failed later is followed by a close, which is where the cleanup is.
        this.helloFailed?.(new MusicAssistantError('network', 'Could not reach Music Assistant'));
      };
      socket.onclose = () => this.onClose();
    });
    return this.opening;
  }

  /**
   * One command and its answer. Every command needs the connection to have
   * been authenticated first, `auth` and `auth/login` excepted.
   */
  command<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || this.closedByUs) {
        reject(new MusicAssistantError('network', 'Not connected to Music Assistant'));
        return;
      }
      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MusicAssistantError('network', `Music Assistant did not answer ${name}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        chunks: [],
      });
      try {
        socket.send(JSON.stringify({ message_id: id, command: name, args }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new MusicAssistantError('network', e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /** Ends the connection. Anything still waiting is told the socket is gone. */
  close(): void {
    this.closedByUs = true;
    const socket = this.socket;
    this.socket = null;
    this.opening = null;
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.onopen = null;
      try {
        socket.close();
      } catch {
        // Already gone.
      }
    }
    this.failPending(new MusicAssistantError('network', 'The connection to Music Assistant closed'));
  }

  private failPending(error: MusicAssistantError): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) {
      clearTimeout(p.timer);
      p.reject(error);
    }
  }

  private onClose(): void {
    if (this.closedByUs) return;
    this.socket = null;
    this.opening = null;
    this.helloFailed?.(new MusicAssistantError('network', 'The connection to Music Assistant closed'));
    this.failPending(new MusicAssistantError('network', 'The connection to Music Assistant closed'));
    this.onClosed?.();
  }

  private onFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let frame: Record<string, unknown> | null;
    try {
      frame = record(JSON.parse(data));
    } catch {
      return;
    }
    if (!frame) return;
    this.lastFrameAt = Date.now();
    // The greeting: no `message_id`, no `event`, and a version on it.
    if (frame.message_id === undefined && frame.event === undefined) {
      const version = str(frame.server_version);
      if (!version) return;
      this.hello?.({
        serverId: str(frame.server_id) ?? '',
        name: str(frame.name) ?? '',
        version,
        schemaVersion: num(frame.schema_version) ?? 0,
      });
      return;
    }
    const event = str(frame.event);
    if (event) {
      this.onEvent?.({ event, objectId: str(frame.object_id), data: frame.data });
      return;
    }
    // The id comes back as a string whatever was sent, which is why it went
    // out as one (see the class comment).
    const id = frame.message_id === undefined ? null : String(frame.message_id);
    const waiting = id == null ? undefined : this.pending.get(id);
    if (!waiting || id == null) return;
    // A long answer arrives in pieces; only the last one settles the request.
    if (frame.partial === true) {
      if (Array.isArray(frame.result)) waiting.chunks.push(...frame.result);
      return;
    }
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    const code = num(frame.error_code);
    if (code != null) {
      const kind: MusicAssistantErrorKind =
        code === ERROR_AUTH_REQUIRED || code === ERROR_INVALID_TOKEN ? 'unauthorized' : 'other';
      waiting.reject(new MusicAssistantError(kind, str(frame.details) ?? `Music Assistant error ${code}`, code));
      return;
    }
    if (waiting.chunks.length > 0) {
      const tail = Array.isArray(frame.result) ? frame.result : [];
      waiting.resolve([...waiting.chunks, ...tail]);
      return;
    }
    // A `result` of null with `partial: false` is how a command that returns
    // nothing says it worked.
    waiting.resolve(frame.result ?? null);
  }
}

/** What a login answers with. */
interface LoginResult {
  success?: unknown;
  access_token?: unknown;
  error?: unknown;
}

/**
 * Signs the connection in: the token first, since it lasts ninety days, and
 * the username and password when it is refused or there is none yet. The
 * token that ends up in use is returned so the caller can keep it.
 *
 * The password never leaves this call, and neither the password nor the token
 * is ever logged.
 */
export async function authenticate(
  client: MaClient,
  credentials: { token?: string; username: string; password: string },
): Promise<string> {
  const { token, username, password } = credentials;
  if (token) {
    try {
      await client.command('auth', { token });
      return token;
    } catch (e) {
      // Anything but a refusal is the connection, and logging in again would
      // fail the same way with a worse message.
      if (!(e instanceof MusicAssistantError) || e.kind !== 'unauthorized') throw e;
    }
  }
  if (!username) {
    throw new MusicAssistantError('unauthorized', 'No username for Music Assistant');
  }
  const result = await client.command<LoginResult>('auth/login', { username, password });
  const fresh = str(result?.access_token);
  // A bad password is answered with `{success: false}` and no error code, so
  // the refusal has to be read off the body.
  if (result?.success !== true || !fresh) {
    throw new MusicAssistantError('unauthorized', str(result?.error) ?? 'Music Assistant refused the sign-in');
  }
  // Signing in hands out a token; it does not let this socket do anything.
  // Every command after it is still answered "Authentication is required"
  // until the token is presented back, on this same socket.
  await client.command('auth', { token: fresh });
  return fresh;
}

// ── The commands, all of them verified against a live server ────────────────

export function listPlayers(client: MaClient): Promise<MaPlayer[]> {
  return client.command<unknown>('players/all').then(playersFrom);
}

export function listProviders(client: MaClient): Promise<MaProvider[]> {
  return client.command<unknown>('providers').then(providersFrom);
}

/** Whether Music Assistant holds this track, by the URI the app made for it. */
export async function itemByUri(client: MaClient, uri: string): Promise<boolean> {
  try {
    const item = await client.command<unknown>('music/item_by_uri', { uri });
    return !!record(item);
  } catch (e) {
    // A URI it cannot resolve is answered with an error, which is the answer.
    if (e instanceof MusicAssistantError && e.kind === 'network') throw e;
    return false;
  }
}

export function play(client: MaClient, playerId: string): Promise<unknown> {
  return client.command('players/cmd/play', { player_id: playerId });
}

export function pause(client: MaClient, playerId: string): Promise<unknown> {
  return client.command('players/cmd/pause', { player_id: playerId });
}

export function stop(client: MaClient, playerId: string): Promise<unknown> {
  return client.command('players/cmd/stop', { player_id: playerId });
}

/**
 * Asks the player to move in the track — which, measured, it does not do.
 *
 * On the live server this and `player_queues/seek` are both answered OK and
 * both **restart the track from the beginning** on a Chromecast fed by the
 * opensubsonic provider: asked for 150 seconds, the player came back at zero
 * with a fresh `elapsed_time_last_updated`. The same speaker seeks correctly
 * through Home Assistant, so it is not the speaker; whether it is the
 * provider's stream, Music Assistant or a setting of the server was not
 * established. It is sent all the same and not worked around: a house where it
 * works is served by the same call, and pretending the app cannot seek would
 * be as wrong as pretending it can.
 */
export function seek(client: MaClient, playerId: string, sec: number): Promise<unknown> {
  return client.command('players/cmd/seek', { player_id: playerId, position: Math.max(0, Math.round(sec)) });
}

/** The app's 0..1 becomes the server's 0..100. */
export function setVolume(client: MaClient, playerId: string, volume: number): Promise<unknown> {
  return client.command('players/cmd/volume_set', {
    player_id: playerId,
    volume_level: Math.round(Math.max(0, Math.min(1, volume)) * 100),
  });
}

/** Wakes a speaker in standby, which takes a song and stays silent otherwise. */
export function setPowered(client: MaClient, playerId: string, powered: boolean): Promise<unknown> {
  return client.command('players/cmd/power', { player_id: playerId, powered });
}

/**
 * Hands the player's queue one or more tracks, by URI. `replace` starts the
 * first one now, `add` puts them behind what is already there.
 *
 * The queue id is the player id (they are the same string), so nothing has to
 * be looked up before a load.
 */
/**
 * Turns the queue's own filling on or off.
 *
 * Music Assistant can keep a queue from ever running dry, adding songs of its
 * choosing as the end comes near ("don't stop the music"). It is a good thing
 * when Music Assistant owns the queue and the wrong thing when this app does:
 * measured on a live server, adding one track to a queue of one left it
 * holding twenty-seven, twenty-five of which the app never chose and cannot
 * account for. So it is switched off for as long as the app drives the player,
 * and put back as it was on the way out.
 */
export function setDontStopTheMusic(
  client: MaClient,
  queueId: string,
  enabled: boolean,
): Promise<unknown> {
  return client.command('player_queues/dont_stop_the_music', {
    queue_id: queueId,
    dont_stop_the_music_enabled: enabled,
  });
}

export function playMedia(
  client: MaClient,
  queueId: string,
  uris: string[],
  option: 'replace' | 'add' | 'next',
): Promise<unknown> {
  return client.command('player_queues/play_media', { queue_id: queueId, media: uris, option });
}

/**
 * Where the player's own queue thinks it is, asked for outright. The same
 * answer arrives unasked on `queue_updated`, so this is only for the moment
 * one has not (a session joined mid-flight, an event missed).
 */
export async function activeQueueIndex(client: MaClient, playerId: string): Promise<number | null> {
  const queue = queueFrom(await client.command<unknown>('player_queues/get_active_queue', { player_id: playerId }));
  return queue?.currentIndex ?? null;
}
