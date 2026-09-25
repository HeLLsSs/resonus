/**
 * Home Assistant's REST API, for the one part of it the app has a use for:
 * its media players.
 *
 * Home Assistant is where a house's speakers end up whatever they are.
 * Music Assistant players, Chromecasts, DLNA renderers, Sonos rooms and the
 * rest all show up as `media_player.*` entities with the same handful of
 * services, and one of those services, `play_media`, takes a URL and has the
 * player fetch it. That is the same arrangement as UPnP and Google Cast at
 * this end (see `store/remoteTrack.ts`): a device on the network handed an
 * address it can reach, which is what makes a Home Assistant player one more
 * remote output rather than something new.
 *
 * Nothing here knows about the queue or the player store; that is
 * `store/homeAssistant.ts`. This file is the requests, and the reading of
 * what comes back, kept pure so the reading can be tested without a house.
 *
 * The address and the token are the user's, not the account's: the same
 * house is there whichever server the app is signed in to.
 */
// Not the global `fetch`: React Native's stops answering in the background,
// and the state of a player is asked for every two seconds for as long as it
// plays, screen off included. See the note in `api/subsonic.ts`.
import { fetch } from 'expo/fetch';

/** Long enough for a Raspberry Pi to answer, short enough that a tap is not
 *  held hostage by a Home Assistant that is down. */
const TIMEOUT_MS = 10_000;

/** `MediaPlayerEntityFeature`, the bits of `supported_features` read here. */
const FEATURE_SEEK = 2;
const FEATURE_TURN_ON = 128;
const FEATURE_PLAY_MEDIA = 512;
const FEATURE_CLEAR_PLAYLIST = 8_192;
const FEATURE_ENQUEUE = 2_097_152;

export interface HaConfig {
  /** `http://homeassistant.local:8123`, without a trailing slash. */
  url: string;
  /** A long-lived access token, from the bottom of the profile page. */
  token: string;
}

/** A media player that can be handed a URL. */
export interface HaPlayer {
  /** `media_player.living_room`: what every service is addressed to. */
  entityId: string;
  name: string;
  /** `playing`, `paused`, `idle`, `off`, `unavailable`… as Home Assistant reports it. */
  state: string;
  /** The player takes `enqueue` on `play_media`: it can hold what comes next. */
  canEnqueue: boolean;
  /** The player offers `clear_playlist`. Never asked of it, since on a Music
   *  Assistant player it stops what is sounding too; kept because a player that
   *  offers it is the fuller of two that are the same speaker. */
  canClearPlaylist: boolean;
  /** The player answers `media_seek`; a great many do not. */
  canSeek: boolean;
  /** A Music Assistant player, which is one that takes a queue best. */
  musicAssistant: boolean;
  /**
   * What to switch on before handing this player anything, when there is
   * something to switch on.
   *
   * A speaker in standby takes the song, says it is playing and makes no
   * sound: Music Assistant does not power it, and its own entity does not
   * even say it is off. The entity that found the speaker does say so, and
   * does offer `turn_on`, so it is that one that gets asked. Usually a
   * sibling of this player rather than this player itself; a Chromecast has
   * neither and needs neither, since it wakes on its own.
   */
  powerEntityId?: string;
}

/** What one poll of a player says. */
export interface HaPlayerState {
  state: string;
  /** Seconds into the track when `positionUpdatedAt` was stamped; null when the player does not say. */
  positionSec: number | null;
  /** Epoch milliseconds of the position above, or null. */
  positionUpdatedAt: number | null;
  durationSec: number;
  title: string | null;
  /** What the player says it is playing: the URL it was handed, for most players. */
  contentId: string | null;
  /** 0..1, or null when the player has no volume of its own. */
  volume: number | null;
}

export interface HaTrackMeta {
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
}

export type HomeAssistantErrorKind =
  /** Home Assistant answered and did not accept the token. */
  | 'unauthorized'
  /** No answer at all: no network, a timeout, a refused connection. */
  | 'network'
  /** Home Assistant answered and said no, for a reason in `message`. */
  | 'other';

export class HomeAssistantError extends Error {
  constructor(
    readonly kind: HomeAssistantErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HomeAssistantError';
  }
}

/**
 * The address as typed, made into one a request can be sent to: a scheme
 * when none was given (a house's address is an IP and a port more often than
 * not), and nothing past the host, since every path here starts from the
 * root. What gets pasted is whatever the browser was showing, dashboard and
 * all (`http://ha.local:8123/lovelace/0`), and left in it turns every request
 * into a 404 the user has no way to read as a wrong address.
 */
export function normalizeHaUrl(url: string): string {
  const typed = url.trim();
  if (!typed) return '';
  const withScheme = /^https?:\/\//i.test(typed) ? typed : `http://${typed}`;
  return /^(https?:\/\/[^/?#]+)/i.exec(withScheme)?.[1] ?? '';
}

/**
 * One request, with the token where Home Assistant wants it and the answer
 * parsed or turned into a typed error. A service call answers with the states
 * it changed, which nobody here reads, so the body is only parsed when asked.
 *
 * The timeout covers the body as well as the headers. A socket that dies
 * between the two leaves the read waiting on bytes that will never come, and
 * with the timer already cleared it would wait for ever: the poll that made
 * the request never finishes, never counts a failure, and the session is dead
 * without anything having said so.
 */
async function call<T>(config: HaConfig, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new HomeAssistantError('unauthorized', 'Token refused', res.status);
    }
    // Errors come back as JSON (`{message}`) when Home Assistant made them,
    // and as plain text when a proxy in front of it did.
    const text = await res.text();
    if (!res.ok) {
      // A page is not a message: a proxy or a wrong address answers with a
      // whole HTML document, and the status says as much as it does.
      let message = text && !text.trimStart().startsWith('<') ? text : `HTTP ${res.status}`;
      try {
        const json = JSON.parse(text) as { message?: string };
        if (json?.message) message = json.message;
      } catch {
        // Not JSON: the text is the message.
      }
      throw new HomeAssistantError('other', message, res.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HomeAssistantError('other', 'Not a Home Assistant answer', res.status);
    }
  } catch (e) {
    // Ours already says what happened; anything else is the request itself
    // failing, the abort above among them.
    if (e instanceof HomeAssistantError) throw e;
    throw new HomeAssistantError('network', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** An entity as `/api/states` lists it; anything else is skipped. */
interface RawState {
  entity_id?: unknown;
  state?: unknown;
  attributes?: Record<string, unknown> | null;
}

function attr(raw: RawState, name: string): unknown {
  return raw.attributes?.[name];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The media players in a states listing that can be handed a URL, sorted by
 * name. Whether the player is a Music Assistant one is read off the
 * attributes Music Assistant adds; there is no field that says so outright,
 * so the reading is generous and being wrong only costs the label.
 */
/**
 * How much a player is worth keeping when two of them are the same speaker:
 * a queue first, then the ability to empty it, then seeking, then being
 * Music Assistant's, then not being switched off.
 */
function capability(p: HaPlayer): number {
  return (
    (p.canEnqueue ? 16 : 0) +
    (p.canClearPlaylist ? 8 : 0) +
    (p.canSeek ? 4 : 0) +
    (p.musicAssistant ? 2 : 0) +
    (p.state === 'off' ? 0 : 1)
  );
}

export function playersFrom(states: unknown): HaPlayer[] {
  if (!Array.isArray(states)) return [];
  // One speaker is often several entities: the integration that found it, a
  // second one for the commands it takes, and Music Assistant's own. They
  // carry the same name, so a list of all of them is a list nobody can
  // choose from, and the wrong choice is the one that cannot hold a queue.
  // Kept by name, best first (a house of twenty speakers answers with fifty).
  const best = new Map<string, HaPlayer>();
  for (const raw of states as RawState[]) {
    const entityId = str(raw?.entity_id);
    if (!entityId?.startsWith('media_player.')) continue;
    const features = num(attr(raw, 'supported_features')) ?? 0;
    if (!(features & FEATURE_PLAY_MEDIA)) continue;
    const state = str(raw.state) ?? 'unknown';
    // Nothing can be handed to an entity the integration has lost sight of.
    if (state === 'unavailable') continue;
    // Music Assistant names itself in the app it is running, and gives its
    // players a type of its own; older builds carried a player id instead.
    const appName = str(attr(raw, 'app_name'))?.toLowerCase() ?? '';
    const appId = str(attr(raw, 'app_id'))?.toLowerCase() ?? '';
    const player: HaPlayer = {
      entityId,
      name: str(attr(raw, 'friendly_name')) ?? entityId.slice('media_player.'.length),
      state,
      canEnqueue: !!(features & FEATURE_ENQUEUE),
      canClearPlaylist: !!(features & FEATURE_CLEAR_PLAYLIST),
      canSeek: !!(features & FEATURE_SEEK),
      powerEntityId: features & FEATURE_TURN_ON ? entityId : undefined,
      musicAssistant:
        appId === 'music_assistant' ||
        !!str(attr(raw, 'mass_player_type')) ||
        !!str(attr(raw, 'mass_player_id')) ||
        appName.includes('music assistant'),
    };
    const held = best.get(player.name);
    if (!held) {
      best.set(player.name, player);
      continue;
    }
    // The two are the same speaker. Keep the one that plays best, and keep
    // from the other the one thing it may have that the winner has not.
    const winner = capability(player) > capability(held) ? player : held;
    const loser = winner === player ? held : player;
    winner.powerEntityId = winner.powerEntityId ?? loser.powerEntityId;
    best.set(player.name, winner);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * An ISO stamp as Home Assistant writes them, with six digits of fraction
 * (`2026-09-10T10:00:00.123456+00:00`). `Date.parse` is only promised three,
 * and the engine on the phone is not the one the tests run on, so the extra
 * digits are cut rather than trusted to be tolerated.
 */
function parseStamp(value: unknown): number | null {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(ms) ? ms : null;
}

/** One player's state as `/api/states/<entity>` answers it. */
export function playerStateFrom(raw: unknown): HaPlayerState {
  const state = (raw ?? {}) as RawState;
  return {
    state: str(state.state) ?? 'unknown',
    positionSec: num(attr(state, 'media_position')),
    positionUpdatedAt: parseStamp(attr(state, 'media_position_updated_at')),
    durationSec: num(attr(state, 'media_duration')) ?? 0,
    title: str(attr(state, 'media_title')),
    contentId: str(attr(state, 'media_content_id')),
    volume: num(attr(state, 'volume_level')),
  };
}

/**
 * Where the player is in the track right now. Home Assistant does not count
 * along: it reports the position it last learned and when it learned it, and
 * while the player plays the clock has run since. A paused player has not
 * moved, whatever the stamp says.
 */
export function positionAt(state: HaPlayerState, nowMs: number): number {
  if (state.positionSec == null) return 0;
  let pos = state.positionSec;
  if (state.state === 'playing' && state.positionUpdatedAt != null) {
    pos += Math.max(0, nowMs - state.positionUpdatedAt) / 1000;
  }
  if (state.durationSec > 0) pos = Math.min(pos, state.durationSec);
  return Math.max(0, pos);
}

/** A track handed to the player, as much of it as a poll can be matched to. */
export interface HandedTrack {
  url: string;
  title: string;
}

/**
 * Which of the tracks handed over the player is on, by what it says it is
 * playing: the URL it was given comes back as the content id from most
 * players, and the title is the fallback for one that names the media in
 * words of its own (Music Assistant keeps a URI of its own). -1 when it is
 * playing none of them, which is what a player taken over by another app
 * looks like, and no reason to move the queue.
 */
/**
 * Whether what the player says it is playing is the URL we handed it.
 *
 * Not an equality: a player is free to wrap the address it was given, and
 * Music Assistant does, handing back `builtin://track/<the whole URL>`. So a
 * URL of ours found inside what it reports is ours. A stream URL carries the
 * song id and the account's own token, which is far too much to collide by
 * accident, and the empty URL a load is stamped with before the real one is
 * known never matches anything.
 */
function sameTrackUrl(reported: string, handed: string): boolean {
  if (!handed) return false;
  return reported === handed || reported.includes(handed);
}

export function handedIndexFor(state: HaPlayerState, handed: HandedTrack[]): number {
  if (state.contentId) {
    const byUrl = handed.findIndex((h) => sameTrackUrl(state.contentId!, h.url));
    if (byUrl >= 0) return byUrl;
  }
  if (state.title) {
    const byTitle = handed.findIndex((h) => h.title === state.title);
    if (byTitle >= 0) return byTitle;
  }
  return -1;
}

/** The player has media loaded: playing it, about to, or holding it paused. */
export function isActiveState(state: string): boolean {
  return state === 'playing' || state === 'buffering' || state === 'paused';
}

/**
 * Which handed track a poll is about, or -1 for none of them.
 *
 * A player with nothing loaded is on none. A player naming one of the URLs it
 * was handed is on that one. What is left is a player playing something it
 * does not name in our terms, and there are two of those: the one that never
 * names the media our way (Music Assistant renames it), which a settled load
 * has already vouched for and which is taken to be on the track it holds; and
 * the one someone else has taken over, which is on nothing of ours and must
 * not be read as if it were.
 */
export function handedTrackFor(state: HaPlayerState, handed: HandedTrack[], unnamedIsOurs: boolean): number {
  if (!isActiveState(state.state)) return -1;
  const matched = handedIndexFor(state, handed);
  if (matched >= 0) return matched;
  return unnamedIsOurs && handed.length > 0 ? 0 : -1;
}

/**
 * Whether a player that has stopped stopped because the track ran out. The
 * window is wide, as for UPnP: the last position seen is up to a poll old,
 * and some players stop reporting one in the closing seconds. A track of
 * unknown length is taken to have ended, since being stuck is worse than
 * moving on.
 */
export function nearEndOf(positionSec: number, durationSec: number): boolean {
  if (durationSec <= 0) return true;
  return positionSec >= durationSec - Math.max(5, durationSec * 0.1);
}

/** Home Assistant's version, from `/api/config`, after `/api/` has vouched for the token. */
export async function haVersion(config: HaConfig): Promise<string> {
  await call<{ message?: string }>(config, '/api/');
  const info = await call<{ version?: unknown }>(config, '/api/config');
  return str(info.version) ?? '?';
}

export async function listPlayers(config: HaConfig): Promise<HaPlayer[]> {
  return playersFrom(await call<unknown>(config, '/api/states'));
}

/**
 * One player by entity, read the way `listPlayers` reads them all; null for
 * an entity that is not a player a URL can be handed to. For a caller that
 * holds the id and not the list, which is what a Home Assistant card sends.
 */
export async function findPlayer(config: HaConfig, entityId: string): Promise<HaPlayer | null> {
  const players = playersFrom([await call<unknown>(config, `/api/states/${encodeURIComponent(entityId)}`)]);
  return players[0] ?? null;
}

export async function playerState(config: HaConfig, entityId: string): Promise<HaPlayerState> {
  return playerStateFrom(await call<unknown>(config, `/api/states/${encodeURIComponent(entityId)}`));
}

async function service(config: HaConfig, name: string, data: Record<string, unknown>): Promise<void> {
  await call<unknown>(config, `/api/services/media_player/${name}`, data);
}

/**
 * Hands the player a URL. `enqueue` only for a player that advertised it:
 * the others refuse the whole call over a key they do not know. `extra` is
 * what Cast and Music Assistant players show while it plays; a player that
 * reads none of it ignores it.
 */
export async function playMedia(
  config: HaConfig,
  entityId: string,
  url: string,
  meta: HaTrackMeta,
  enqueue?: 'replace' | 'add',
): Promise<void> {
  await service(config, 'play_media', {
    entity_id: entityId,
    media_content_type: 'music',
    media_content_id: url,
    ...(enqueue ? { enqueue } : {}),
    extra: {
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      thumb: meta.artworkUrl,
      // The Cast receiver's own words for the same thing (`MusicTrackMediaMetadata`).
      metadata: {
        metadataType: 3,
        title: meta.title,
        artist: meta.artist,
        albumName: meta.album,
        images: meta.artworkUrl ? [{ url: meta.artworkUrl }] : [],
      },
    },
  });
}

export function mediaPlay(config: HaConfig, entityId: string): Promise<void> {
  return service(config, 'media_play', { entity_id: entityId });
}

export function mediaPause(config: HaConfig, entityId: string): Promise<void> {
  return service(config, 'media_pause', { entity_id: entityId });
}

/** Wakes a speaker in standby. Harmless on one that is already awake. */
export function turnOn(config: HaConfig, entityId: string): Promise<void> {
  return service(config, 'turn_on', { entity_id: entityId });
}

export function mediaStop(config: HaConfig, entityId: string): Promise<void> {
  return service(config, 'media_stop', { entity_id: entityId });
}


export function mediaSeek(config: HaConfig, entityId: string, sec: number): Promise<void> {
  return service(config, 'media_seek', { entity_id: entityId, seek_position: Math.max(0, sec) });
}

/** 0..1, which is Home Assistant's own scale. */
export function volumeSet(config: HaConfig, entityId: string, volume: number): Promise<void> {
  return service(config, 'volume_set', { entity_id: entityId, volume_level: Math.max(0, Math.min(1, volume)) });
}
