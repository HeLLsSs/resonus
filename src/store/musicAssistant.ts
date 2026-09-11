/**
 * Integration with Music Assistant, spoken to directly over its own WebSocket
 * (`lib/musicAssistant.ts`) rather than through Home Assistant.
 *
 * Why this exists next to the Home Assistant output, which can reach the same
 * speakers: **no URL is ever handed out**. A track is named by the id the app
 * already holds, through the provider instance Music Assistant indexed the
 * same server with (`opensubsonic--XXXX://track/<song id>`), and Music
 * Assistant fetches it from the server itself. So this output never touches
 * `remoteTrack.ts`: no stream URL with the account's credentials in it, no
 * local file server, no header relay for a server behind a proxy — and,
 * because nothing is being served from here, the phone does not have to stay
 * awake for the music to go on playing. It is also the only output with no
 * timer of its own: the server pushes `player_updated`, `queue_updated` and
 * `queue_time_updated` on the same socket with nothing to subscribe to, so
 * where the player is, what it plays and whether it plays all arrive as they
 * change.
 *
 * The player store keeps the queue. The player is handed the current track
 * and the few that follow it in one call, and moves from one to the next by
 * itself; the app follows it there (`onTrackChanged`) without loading
 * anything. Which of them it is on is read off `queue_updated`, whose
 * `current_index` names a track this app itself wrote into that queue, and
 * only failing that off the media the player names — which is guesswork,
 * because Music Assistant renames what it plays. A tail the queue has moved
 * out from under (a reorder, a shuffle) is not cleared but written again from
 * the current track, for the reason `repairTail` gives.
 *
 * What this output cannot do is play a song Music Assistant's library does
 * not hold: see `playableHere`.
 *
 * The address and the credentials are the user's, kept once for every profile
 * in the phone's secure store, as the Home Assistant ones are.
 */
import { create } from 'zustand';

import { type Song } from '@/api/backend';
import { tg } from '@/i18n';
import {
  activeQueueIndex,
  authenticate,
  handedIndexAt,
  handedIndexFor,
  itemByUri,
  libraryCandidates,
  listPlayers,
  listProviders,
  MaClient,
  MusicAssistantError,
  nearEndOf,
  normalizeMaUrl,
  pause as cmdPause,
  play as cmdPlay,
  playerFrom,
  playMedia as cmdPlayMedia,
  positionAt,
  queueFrom,
  queueTimeFrom,
  seek as cmdSeek,
  setDontStopTheMusic,
  setPowered as cmdPower,
  setVolume as cmdVolume,
  stop as cmdStop,
  trackUri,
  type MaEvent,
  type MaPlayer,
  type MaQueue,
  wsUrlFor,
} from '@/lib/musicAssistant';
import { getItem, setItem } from '@/lib/storage';
import { useAuthStore } from './auth';
import { castStop } from './castMedia';
import type { CastQueueState } from './googleCast';
import { useToast } from './toast';
import type { RemoteEvents } from './upnp';

interface MusicAssistantStoreState {
  /**
   * The switch, off until turned on: like the Navifind and Home Assistant
   * ones, a house without Music Assistant should never see a row about it.
   */
  enabled: boolean;
  /** The address and credentials, empty until set up; the same for every profile. */
  url: string;
  username: string;
  password: string;
  /** The session token, kept so the password is not sent again for ninety days. */
  token: string;
  hydrated: boolean;
  /** A Music Assistant player is the output: what `remoteKind()` reads. */
  connected: boolean;
  playerId: string | null;
  /** Players found in the last look. */
  players: MaPlayer[];
  searching: boolean;
}

export const useMusicAssistant = create<MusicAssistantStoreState>(() => ({
  enabled: false,
  url: '',
  username: '',
  password: '',
  token: '',
  hydrated: false,
  connected: false,
  playerId: null,
  players: [],
  searching: false,
}));

/** Where the address and credentials are kept: one key, not per profile. */
const STORAGE_KEY = 'resonus.musicAssistant';

/** How many tracks after the current one the player is handed. */
const NEXT_ITEMS = 3;
/** A volume the player reports this soon after we set one is our own coming back. */
const VOLUME_ECHO_MS = 1500;
/**
 * A player heard playing this long after a load, without ever naming the
 * track it was handed, is taken to be on it: Music Assistant renames what it
 * plays into a library URI of its own, and a title is not always enough.
 */
const LOAD_SETTLE_MS = 4000;
/**
 * A load nothing came of. `player_queues/play_media` is answered OK whether or
 * not the player then makes a sound, so a speaker that cannot be reached comes
 * back as a player that simply never starts.
 */
const LOAD_QUIET_MS = 20_000;
/** An idle from a player still holding tracks is only believed after this:
 *  between two of its own items a player passes through idle. */
const IDLE_SETTLE_MS = 4000;
/** A player playing something that is none of ours for this long has been
 *  taken over by somebody else, and is given back rather than interrupted. */
const TAKEN_OVER_MS = 8000;
/** Tries at the seek or the pause a load asked for, on a player that was not ready. */
const SETTLE_TRIES = 3;
/** A position this far from the one asked for means the seek did not land. */
const SEEK_TOLERANCE_SEC = 3;
/** The socket is kept this long after the last look for players, then dropped. */
const IDLE_CLOSE_MS = 30_000;
/** Nothing at all on the socket for this long: it may be dead without having
 *  said so (a NAT that dropped the mapping), so it is prodded. */
const SILENT_MS = 300_000;
/** How often that is checked. Not a poll of the player: the player pushes. */
const KEEPALIVE_MS = 60_000;
/** Reconnection waits, doubling from the first up to the last. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** Reconnections in a row before the session is given up on. */
const MAX_RECONNECTS = 8;

/** A track handed to the player, and what an update is matched against. */
interface Handed {
  uri: string;
  title: string;
  songId: string;
  key: string;
}

let events: RemoteEvents | null = null;
/** The player's queue, for naming the index a handed track stands for. */
let queueOf: (() => { queue: Song[]; index: number }) | null = null;

let client: MaClient | null = null;
/** One connection attempt at a time; everybody waits on the same one. */
let opening: Promise<MaClient> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The provider instance that answers for the profile's server, once one has
 * been proved to hold a song of ours, and which profile it was proved for.
 */
let library: { instanceId: string; scope: string } | null = null;

let lastPositionSec = 0;
let lastDurationSec = 0;
/** The last update heard the player playing: what a repair has to put back. */
let lastPlaying = false;
/** Prevents advancing the queue twice for the same track end. */
let finishedFired = false;
/** A load is in flight: what the player reports meanwhile is the old track's. */
let loading = false;
let loadSettleTimer: ReturnType<typeof setTimeout> | null = null;
let loadQuietTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** We have heard the player playing since the last load, so a finish is a real one. */
let wasPlaying = false;
/** We asked for the pause ourselves: an idle after one is not a track ending. */
let pausedByUs = false;
/**
 * The load settled on a player that does not name our media in our terms, so
 * what it plays without naming is still ours. Until it does, it is not.
 */
let unnamedIsOurs = false;
/** What the player holds, current track first. */
let handed: Handed[] = [];
/** Where `handed[0]` sits in the player's own queue, which only grows. */
let handedBase = 0;
/**
 * Whether the queue filled itself before the app took the player over, so it
 * can be put back that way. Null while nothing has been changed, which is
 * also what a server too old to say leaves it at (see `setDontStopTheMusic`).
 */
let filledItselfBefore: boolean | null = null;
/** Which write of the player's queue is current, so a late one can tell it was overtaken. */
let queueGeneration = 0;
let pendingSeekSec: number | null = null;
let pendingPause = false;
let seekTries = 0;
let pauseTries = 0;
/** When the player was first heard playing something that is none of ours. */
let foreignSince: number | null = null;
/** One queue write at a time: two overlapping ones hand the player the same songs twice. */
let inFlightSync: Promise<boolean> | null = null;
/** The volume we last sent (0..1) and when, to tell its echo from a real change. */
let sentVolume: { value: number; at: number } | null = null;
/** The last thing our player said, and when, for the timers that have to
 *  decide without an update of their own: a player sitting still says nothing. */
let lastSeen: MaPlayer | null = null;
let lastSeenAt = 0;
/** When the player was last handed a queue, so an update from before it is
 *  known for what it is: news about the track this load is replacing. */
let handedAt = 0;
/** The media we could not place, and the look at the player's own queue for it. */
let unplacedMedia: string | null = null;
let placing = false;
/**
 * What `queue_updated` last said about our player's queue. Its `current_index`
 * is the server's own answer to which of the handed tracks is playing, and it
 * saves the look-up `placeByQueue` would otherwise make. Forgotten whenever
 * the queue is written again, since the indices are then about to change.
 */
let lastQueue: MaQueue | null = null;
/** The first update after a reconnection says where the player got to while we
 *  were away, and must not be read as a track ending. */
let justReconnected = false;
/** When the output sheet last asked for the players. */
let lastSearchAt = 0;

export function isMaConnected(): boolean {
  return useMusicAssistant.getState().connected;
}

/** Switched on, and an address and a username given; nothing says they work. */
export function maConfigured(): boolean {
  const { enabled, url, username } = useMusicAssistant.getState();
  return enabled && !!url && !!username;
}

function currentPlayer(): MaPlayer | null {
  const { playerId, players } = useMusicAssistant.getState();
  return players.find((p) => p.playerId === playerId) ?? null;
}

/**
 * Registers player events. Call only once (from the player). Also the moment
 * the address and credentials are read back from the phone.
 */
export function initMusicAssistant(ev: RemoteEvents, queue: () => { queue: Song[]; index: number }): void {
  events = ev;
  queueOf = queue;
  void hydrateConfig();
}

async function hydrateConfig(): Promise<void> {
  try {
    const raw = await getItem(STORAGE_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as {
          enabled?: unknown;
          url?: unknown;
          username?: unknown;
          password?: unknown;
          token?: unknown;
        })
      : null;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    useMusicAssistant.setState({
      enabled: parsed?.enabled === true,
      url: text(parsed?.url),
      username: text(parsed?.username),
      password: text(parsed?.password),
      token: text(parsed?.token),
      hydrated: true,
    });
  } catch {
    useMusicAssistant.setState({ hydrated: true });
  }
}

function persistConfig(): void {
  const { enabled, url, username, password, token } = useMusicAssistant.getState();
  void setItem(STORAGE_KEY, JSON.stringify({ enabled, url, username, password, token }));
}

/**
 * Keeps the address and credentials, for every profile. Empty them all to
 * forget them. A different address or user makes the token meaningless, so it
 * goes with them, and the library that was matched on the old server with it.
 */
export function setMusicAssistantConfig(url: string, username: string, password: string): void {
  const previous = useMusicAssistant.getState();
  const next = { url: normalizeMaUrl(url), username: username.trim(), password };
  const moved = next.url !== previous.url || next.username !== previous.username;
  useMusicAssistant.setState({ ...next, ...(moved ? { token: '' } : {}) });
  if (moved) {
    library = null;
    closeClient();
  }
  persistConfig();
}

/** The switch. Off takes the output list's rows away, and a player with it. */
export function setMusicAssistantEnabled(enabled: boolean): void {
  useMusicAssistant.setState({ enabled });
  persistConfig();
  if (enabled) return;
  if (useMusicAssistant.getState().connected) {
    void maDisconnect();
    return;
  }
  closeClient();
}

// ── The connection ──────────────────────────────────────────────────────────

/**
 * The open, signed-in connection, opening one if there is none. Everything
 * that talks to the server goes through here, so a socket that dropped is
 * replaced by the next thing that needs it rather than by a timer.
 */
async function ensureClient(): Promise<MaClient> {
  if (client?.isOpen) return client;
  if (opening) return opening;
  if (client) closeClient();
  const { url, username, password, token } = useMusicAssistant.getState();
  const address = wsUrlFor(url);
  if (!address || !username) {
    throw new MusicAssistantError('other', 'Music Assistant is not set up');
  }
  const fresh = new MaClient(address);
  fresh.onEvent = onServerEvent;
  fresh.onClosed = () => onSocketClosed(fresh);
  const run = (async () => {
    await fresh.open();
    const inUse = await authenticate(fresh, { token, username, password });
    if (inUse !== useMusicAssistant.getState().token) {
      useMusicAssistant.setState({ token: inUse });
      persistConfig();
    }
    client = fresh;
    reconnectAttempt = 0;
    startKeepalive();
    return fresh;
  })();
  opening = run;
  try {
    return await run;
  } catch (e) {
    fresh.close();
    if (client === fresh) client = null;
    throw e;
  } finally {
    if (opening === run) opening = null;
  }
}

function closeClient(): void {
  stopKeepalive();
  if (idleCloseTimer) clearTimeout(idleCloseTimer);
  idleCloseTimer = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const held = client;
  client = null;
  held?.close();
}

/**
 * The socket is only worth holding open for a session or for the output sheet
 * while it is up; without either it is dropped, so a house of twenty-six
 * players is not pushing updates at a phone that has stopped listening.
 */
function scheduleIdleClose(): void {
  if (idleCloseTimer) clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    if (isMaConnected() || Date.now() - lastSearchAt < IDLE_CLOSE_MS) return;
    closeClient();
  }, IDLE_CLOSE_MS);
}

/**
 * Nothing has arrived for a long while. The server pushes as things happen
 * and a quiet house is quiet, so this is not a poll of the player; it is the
 * one way a socket that died without saying so (a router that dropped the
 * connection while the phone slept) is ever noticed.
 */
function startKeepalive(): void {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    const held = client;
    if (!held?.isOpen || held.idleMs < SILENT_MS) return;
    void listPlayers(held).catch(() => {
      if (client !== held) return;
      closeClient();
      if (isMaConnected()) scheduleReconnect();
    });
  }, KEEPALIVE_MS);
}

function stopKeepalive(): void {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function onSocketClosed(closed: MaClient): void {
  if (client !== closed) return;
  client = null;
  stopKeepalive();
  if (isMaConnected()) scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer || !isMaConnected()) return;
  if (reconnectAttempt >= MAX_RECONNECTS) {
    useToast.getState().show(tg('Lost contact with Music Assistant'));
    void maDisconnect();
    return;
  }
  const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** reconnectAttempt);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void reconnectNow();
  }, wait);
}

async function reconnectNow(): Promise<void> {
  if (!isMaConnected()) return;
  try {
    const fresh = await ensureClient();
    if (!isMaConnected()) return;
    await resync(fresh);
  } catch (e) {
    if (e instanceof MusicAssistantError && e.kind === 'unauthorized') {
      useToast.getState().show(tg('Music Assistant does not accept these credentials.'));
      void maDisconnect();
      return;
    }
    scheduleReconnect();
  }
}

/**
 * Where the player got to while the connection was down. Its state is read
 * once, as if it had just been pushed, so the app catches up on the position
 * and the track — but a player found idle is not read as a song that ended:
 * what happened while nobody was listening cannot be told apart from a
 * speaker somebody stopped.
 */
async function resync(fresh: MaClient): Promise<void> {
  const { playerId } = useMusicAssistant.getState();
  if (!playerId) return;
  const players = await listPlayers(fresh);
  useMusicAssistant.setState({ players });
  const player = players.find((p) => p.playerId === playerId);
  if (!player) {
    useToast.getState().show(tg('Lost contact with Music Assistant'));
    void maDisconnect();
    return;
  }
  justReconnected = true;
  try {
    onPlayerUpdate(player);
  } finally {
    justReconnected = false;
  }
}

/**
 * Everything the server pushes. Three of them are acted on: the player, for
 * what it is doing and where it is; its queue, for which track that is; and
 * the queue's clock, for the position between the two. The rest
 * (`queue_items_updated`, `media_item_updated`, `tasks_updated`…) is the
 * library and the server's own chores, and the list is not assumed to be a
 * fixed one.
 */
function onServerEvent(event: MaEvent): void {
  switch (event.event) {
    case 'player_updated': {
      const player = playerFrom(event.data);
      if (player) onPlayerUpdate(player);
      return;
    }
    case 'queue_updated': {
      const queue = queueFrom(event.data);
      if (queue) onQueueUpdate(queue, event.objectId);
      return;
    }
    case 'queue_time_updated':
      onQueueTime(event.objectId, event.data);
      return;
    default:
      return;
  }
}

/**
 * The player's queue, as the server pushes it whenever it changes.
 *
 * `current_index` is the whole point of listening to this: the queue was
 * written from here, so the index names one of the tracks handed over
 * outright, with no matching of names against media Music Assistant has
 * renamed. An index outside what was handed over is refused, exactly as the
 * queue look-up's is: that is a queue somebody else has written.
 */
function onQueueUpdate(queue: MaQueue, objectId: string | null): void {
  const { playerId } = useMusicAssistant.getState();
  // The event says the queue in `object_id`; the payload says it again, and
  // either will do. A queue id is a player id, so this is our player's queue.
  const id = queue.queueId ?? objectId;
  if (!isMaConnected() || !playerId || id !== playerId || !queue.active) return;
  lastQueue = queue;
  // A load in flight is rewriting this very queue: until it has settled, what
  // the queue says is about the track being replaced.
  if (loading) return;
  const at = handedIndexAt(queue.currentIndex, handedBase, handed.length);
  // 0 is the track the app already thinks it is on, and nothing to do; -1 is
  // an index that is none of ours, and nothing to be done about.
  if (at <= 0) return;
  // A player between two of its own tracks goes through idle, and the wait to
  // see whether it names the next one was waiting for this: it has moved on,
  // so the idle was not the queue running out.
  if (idleTimer) clearLoadTimers();
  const pos = queue.elapsedSec ?? 0;
  lastPositionSec = pos;
  // The duration is left to the `player_updated` that comes with this; until
  // it does, the song's own is what the app shows.
  advanceTo(at, pos, 0);
}

/**
 * The queue's clock ticking. Taken only when it carries a position that can be
 * read at all (`queueTimeFrom`: the shape of this event was never captured
 * from a live server) and only while our own track is the one sounding.
 * Everywhere else the position goes on being derived from the player's
 * `elapsed_time` and `elapsed_time_last_updated`, which works.
 */
function onQueueTime(objectId: string | null, data: unknown): void {
  const { playerId } = useMusicAssistant.getState();
  if (!isMaConnected() || !playerId || objectId !== playerId) return;
  const sec = queueTimeFrom(data);
  if (sec == null || handed.length === 0 || !lastPlaying) return;
  // Not while a load is in flight, nor while what a load asked for has still
  // to land, nor on a player somebody else has started something on: in all
  // three the clock is running on a track that is not the app's.
  if (loading || pendingSeekSec != null || foreignSince != null) return;
  lastPositionSec = sec;
  events?.onProgress(sec, lastDurationSec);
}

// ── The session ─────────────────────────────────────────────────────────────

/** Asks Music Assistant for its players and refreshes the visible list. */
export async function maSearch(): Promise<void> {
  if (!maConfigured() || useMusicAssistant.getState().searching) return;
  lastSearchAt = Date.now();
  useMusicAssistant.setState({ searching: true });
  try {
    const fresh = await ensureClient();
    useMusicAssistant.setState({ players: await listPlayers(fresh) });
  } catch {
    // Keep the previous list; the settings screen is where a broken address
    // is told about.
  } finally {
    useMusicAssistant.setState({ searching: false });
    if (!isMaConnected()) scheduleIdleClose();
  }
}

export async function maConnect(player: MaPlayer): Promise<boolean> {
  if (!maConfigured()) return false;
  const current = useMusicAssistant.getState();
  // Remote-to-remote handoff: stop the previous player first so playback
  // doesn't continue there while the new one takes over.
  if (current.connected && current.playerId && current.playerId !== player.playerId) {
    await maDisconnect(true);
  }
  try {
    await ensureClient();
  } catch {
    return false;
  }
  resetTrackState();
  const known = useMusicAssistant.getState().players.some((p) => p.playerId === player.playerId);
  useMusicAssistant.setState({
    connected: true,
    playerId: player.playerId,
    players: known
      ? useMusicAssistant.getState().players
      : [...useMusicAssistant.getState().players, player].sort((a, b) => a.name.localeCompare(b.name)),
  });
  events?.onConnected();
  return true;
}

/**
 * Ends the session; with silent it doesn't notify the player (e.g. when
 * switching output), and with leaveSounding it doesn't quieten the speaker,
 * which is for the one case where what plays there is not ours to stop.
 */
export async function maDisconnect(silent = false, leaveSounding = false): Promise<void> {
  if (!isMaConnected()) return;
  clearLoadTimers();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  const { playerId } = useMusicAssistant.getState();
  // The queue is handed back the way it was found, before anything else: a
  // player left with its own filling switched off would never play on by
  // itself again, which is not a thing the app is entitled to leave behind.
  if (playerId && filledItselfBefore === true) {
    const held = client;
    if (held) void letTheQueueFillAgain(held, playerId);
    else filledItselfBefore = null;
  }
  // Closes the casting media session on any disconnect path (including silent
  // ones: output switch, reset), not just the normal one.
  castStop();
  useMusicAssistant.setState({ connected: false, playerId: null });
  // Read before the reset below: it is where the local player picks the song
  // back up.
  const resumeAtSec = lastPositionSec;
  resetTrackState();
  sentVolume = null;
  // The app is told first and the speaker second: on a server that has gone
  // away the call below waits out its timeout, and the song is not going to
  // wait that long to come back to the phone.
  if (!silent) events?.onDisconnected(resumeAtSec);
  const held = client;
  if (held && playerId && !leaveSounding) {
    // Stopped rather than left playing: the sound is meant to move, not to
    // double.
    try {
      await cmdStop(held, playerId);
    } catch {
      // The speaker keeps whatever it was doing; there is nothing else to try.
    }
  }
  scheduleIdleClose();
}

function resetTrackState(): void {
  lastPositionSec = 0;
  lastDurationSec = 0;
  lastPlaying = false;
  finishedFired = false;
  loading = false;
  wasPlaying = false;
  pausedByUs = false;
  unnamedIsOurs = false;
  handed = [];
  handedBase = 0;
  queueGeneration++;
  pendingSeekSec = null;
  pendingPause = false;
  seekTries = 0;
  pauseTries = 0;
  foreignSince = null;
  inFlightSync = null;
  unplacedMedia = null;
  placing = false;
  lastQueue = null;
  lastSeen = null;
  lastSeenAt = 0;
  handedAt = 0;
  clearLoadTimers();
}

function clearLoadTimers(): void {
  if (loadSettleTimer) clearTimeout(loadSettleTimer);
  loadSettleTimer = null;
  if (loadQuietTimer) clearTimeout(loadQuietTimer);
  loadQuietTimer = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

// ── What the player says ────────────────────────────────────────────────────

/** A song of ours the player is handed: `songId@index`, the same key Cast uses. */
function keyFor(song: Song, index: number): string {
  return `${song.id}@${index}`;
}

/**
 * Where in the queue the handed track sits. The key names the index it had
 * when handed over, which still holds unless the queue was rewritten since;
 * then the song is looked for from the current position on, and failing that
 * anywhere.
 */
function indexForKey(key: string, songId: string, queue: Song[], from: number): number {
  const at = Number(key.slice(key.lastIndexOf('@') + 1));
  if (Number.isInteger(at) && queue[at]?.id === songId) return at;
  const after = queue.findIndex((song, i) => i > from && song.id === songId);
  return after >= 0 ? after : queue.findIndex((song) => song.id === songId);
}

function onPlayerUpdate(player: MaPlayer): void {
  const { playerId } = useMusicAssistant.getState();
  // Every player in the house is pushed on this socket. The visible list only
  // follows ours and, while the output sheet is up, the rest: a house of
  // twenty-six speakers would otherwise redraw the app for each of them all
  // day long.
  if (player.playerId === playerId || Date.now() - lastSearchAt < IDLE_CLOSE_MS) refreshPlayerInList(player);
  if (!isMaConnected() || player.playerId !== playerId) return;
  lastSeen = player;
  lastSeenAt = Date.now();
  if (!player.available) {
    useToast.getState().show(tg('Lost contact with Music Assistant'));
    void maDisconnect(false, true);
    return;
  }
  if (player.volume != null) reportVolume(player.volume);
  const pos = positionAt(player, Date.now());
  const dur = player.media?.durationSec ?? 0;
  const sounding = player.state === 'playing';
  const active = sounding || player.state === 'paused';
  lastPlaying = sounding;
  const matched = active ? handedIndexFor(player.media, handed) : -1;
  if (loading) {
    // A load is in flight: everything the player says is about the track
    // before it until it names the one it was just handed. A player that
    // never names it is settled by `settleBlind`, on a timer, since a player
    // that has taken a track and sat down on it says nothing more — and the
    // timer is armed again here for a speaker slow enough to have missed the
    // first one.
    if (matched < 0) {
      const going = sounding || (pendingPause && player.state === 'paused');
      if (going && !loadSettleTimer && handedAt > 0) loadSettleTimer = setTimeout(settleBlind, LOAD_SETTLE_MS);
      return;
    }
    loading = false;
    clearLoadTimers();
    unnamedIsOurs = false;
  }
  const at = matched >= 0 ? matched : active && unnamedIsOurs && handed.length > 0 ? 0 : -1;
  if (at < 0 && active) {
    // The player is on media that is none of ours: somebody started something
    // on that speaker from somewhere else. Nothing it says is about our song,
    // and a speaker that stays theirs is given back rather than interrupted.
    if (handed.length > 0) {
      foreignSince ??= Date.now();
      if (Date.now() - foreignSince >= TAKEN_OVER_MS) {
        useToast.getState().show(tg('Something else is playing on this player'));
        void maDisconnect(false, true);
        return;
      }
    }
    events?.onPlayingChanged(false, false);
    return;
  }
  foreignSince = null;
  if (at > 0) {
    advanceTo(at, pos, dur);
    if (!isMaConnected()) return;
  } else if (at === 0 && matched < 0 && handed.length > 1) {
    // Playing ours, but naming something we cannot place, with more than one
    // track handed over: it may have moved on to one of them. Its own queue
    // is asked where it is, once per media it names, rather than guessed at.
    placeByQueue(player);
  }
  if (at >= 0) {
    lastPositionSec = pos;
    if (dur > 0) lastDurationSec = dur;
  }
  switch (player.state) {
    case 'playing':
      finishedFired = false;
      wasPlaying = true;
      pausedByUs = false;
      if (idleTimer) clearLoadTimers();
      // The seek a load asked for has landed once the player is near it.
      if (pendingSeekSec != null && Math.abs(pos - pendingSeekSec) <= SEEK_TOLERANCE_SEC) pendingSeekSec = null;
      if ((pendingSeekSec != null && seekTries < SETTLE_TRIES) || (pendingPause && pauseTries < SETTLE_TRIES)) {
        // Handed over with a position, or paused, and the player is playing
        // all the same: what was asked for as the load returned did not take,
        // so it is asked for again while there is any chance of it landing.
        void settleLoad();
        return;
      }
      // Out of tries: the player is playing, and fighting it any longer only
      // makes the song stutter.
      pendingSeekSec = null;
      pendingPause = false;
      events?.onProgress(pos, dur || lastDurationSec);
      events?.onPlayingChanged(true, false);
      return;
    case 'paused':
      // The pause a load asked for has landed, and a pause is not a track
      // running out: an idle after one is the player going away.
      pendingPause = false;
      wasPlaying = false;
      if (idleTimer) clearLoadTimers();
      events?.onProgress(pos, dur || lastDurationSec);
      events?.onPlayingChanged(false, false);
      return;
    default:
      // idle, or a state this version does not know: nothing playing. A
      // natural end is an idle after having played, and never one after a
      // pause of ours or straight after a reconnection.
      if (finishedFired || !wasPlaying || pausedByUs || justReconnected) {
        events?.onPlayingChanged(false, false);
        return;
      }
      if (!nearEndOf(lastPositionSec, lastDurationSec)) {
        events?.onPlayingChanged(false, false);
        return;
      }
      if (handed.length <= 1) {
        fireFinished();
        return;
      }
      // Still holding tracks: this is very likely the moment between two of
      // them, and the update that names the next one is on its way.
      if (!idleTimer) idleTimer = setTimeout(onIdlePersisted, IDLE_SETTLE_MS);
      events?.onPlayingChanged(false, false);
  }
}

/** Keeps the visible list in step with what the server pushes about a player. */
function refreshPlayerInList(player: MaPlayer): void {
  const { players } = useMusicAssistant.getState();
  const at = players.findIndex((p) => p.playerId === player.playerId);
  if (at < 0) {
    if (!player.available) return;
    useMusicAssistant.setState({
      players: [...players, player].sort((a, b) => a.name.localeCompare(b.name)),
    });
    return;
  }
  const next = [...players];
  next[at] = player;
  useMusicAssistant.setState({ players: next });
}

/** The player moved on to another of the tracks it was handed. */
function advanceTo(at: number, pos: number, dur: number): void {
  handed = handed.slice(at);
  handedBase += at;
  unplacedMedia = null;
  const current = queueOf?.();
  const head = handed[0];
  const index = current && head ? indexForKey(head.key, head.songId, current.queue, current.index) : -1;
  if (index < 0) {
    // A track that has left the queue since it was handed over: the player is
    // not followed into it, the queue's own next is loaded instead.
    fireFinished();
    return;
  }
  finishedFired = false;
  events?.onTrackChanged(index, pos, dur);
}

/**
 * The player names media we cannot place. Its own queue knows where it is,
 * and the queue we wrote is exactly the tracks we handed over, so its
 * `current_index` names one of them. Asked once per media it names, never
 * while another look is in flight, and only believed when it lands inside
 * what we hold.
 *
 * Asked, that is, only when `queue_updated` has not already said it: the event
 * carries the same queue, so the round trip is for a session that has not
 * heard one yet.
 */
function placeByQueue(player: MaPlayer): void {
  const key = player.media?.uri ?? player.media?.title ?? '';
  if (!key || key === unplacedMedia || placing) return;
  unplacedMedia = key;
  const known = lastQueue ? handedIndexAt(lastQueue.currentIndex, handedBase, handed.length) : -1;
  if (known >= 0) {
    // Including 0, which is the queue saying the player is where the app
    // already has it — an answer, and no reason to go and ask again.
    if (known > 0) advanceTo(known, positionAt(player, Date.now()), player.media?.durationSec ?? 0);
    return;
  }
  const held = client;
  const { playerId } = useMusicAssistant.getState();
  if (!held || !playerId) return;
  placing = true;
  const generation = queueGeneration;
  void activeQueueIndex(held, playerId)
    .then((index) => {
      if (index == null || generation !== queueGeneration || !isMaConnected()) return;
      const at = index - handedBase;
      if (at <= 0 || at >= handed.length) return;
      advanceTo(at, positionAt(player, Date.now()), player.media?.durationSec ?? 0);
    })
    .catch(() => {
      // The queue could not be read; the title match is all there is.
    })
    .finally(() => {
      placing = false;
    });
}

function fireFinished(): void {
  finishedFired = true;
  wasPlaying = false;
  clearLoadTimers();
  events?.onFinished();
}

/** The player was still idle a moment after it went idle holding tracks. */
function onIdlePersisted(): void {
  idleTimer = null;
  if (!isMaConnected() || finishedFired || !wasPlaying || pausedByUs) return;
  fireFinished();
}

/**
 * The player's volume as it reports it. What we set comes back the same way a
 * moment later, and is not news; anything else (the Music Assistant web page,
 * the speaker's own buttons) is, and the player's slider follows.
 */
function reportVolume(volume: number): void {
  if (sentVolume) {
    if (Math.abs(sentVolume.value - volume) < 0.005) {
      sentVolume = null;
      return;
    }
    if (Date.now() - sentVolume.at < VOLUME_ECHO_MS) return;
    sentVolume = null;
  }
  events?.onVolume?.(volume);
}

/**
 * The seek and the pause a load asked for. `play_media` only ever starts the
 * queue from the top and playing, and there is no way to ask it for anything
 * else, so both go out the moment the call returns rather than on the update
 * that follows: waiting is seconds of a song nobody asked to hear, at the
 * speaker's own volume, which is what picking a speaker for a paused queue
 * sounded like. A player that was not ready for them is caught by the first
 * update that still hears it playing, which asks again.
 *
 * On a player where seeking restarts the track instead of moving in it — which
 * is what was measured on a Chromecast fed by the opensubsonic provider, see
 * `seek` in `lib/musicAssistant.ts` — the seek never lands, and the tries here
 * are all it costs before the player is left where it is.
 */
async function settleLoad(): Promise<void> {
  const held = client;
  const { playerId } = useMusicAssistant.getState();
  const wantedSeek = pendingSeekSec;
  const wantedPause = pendingPause;
  if (!held || !playerId || (wantedSeek == null && !wantedPause)) return;
  try {
    if (wantedSeek != null) {
      seekTries++;
      await cmdSeek(held, playerId, wantedSeek);
      lastPositionSec = wantedSeek;
    }
    if (wantedPause) {
      pauseTries++;
      await cmdPause(held, playerId);
      pausedByUs = true;
    }
  } catch {
    // The player plays on from where it is; the next update says where.
    return;
  }
  if (!isMaConnected()) return;
  events?.onProgress(wantedSeek ?? lastPositionSec, lastDurationSec);
  events?.onPlayingChanged(!wantedPause, false);
}

// ── Loading ─────────────────────────────────────────────────────────────────

/** The scope the library match was made for: a match is a server's, not a house's. */
function profileScopeKey(): string {
  const auth = useAuthStore.getState().auth;
  return auth ? `${auth.username}@${auth.serverUrl}` : '';
}

/**
 * Whether Music Assistant could possibly be asked for this song.
 *
 * Only a song the signed-in server holds can be named to Music Assistant,
 * because the name is the server's own id for it. That leaves three kinds of
 * song out, and each of them is refused rather than replaced by something
 * else:
 *
 * - a radio station, which brings its own address;
 * - a file on the phone in a local profile, which no server has ever seen;
 * - a song whose id Music Assistant's library does not hold.
 *
 * `music/search` would find *a* track of that title, and that is exactly why
 * it is not used: a search on "Parabola" comes back with a live version, a
 * remaster or somebody else's cover, and playing one of those without saying
 * so is worse than refusing. The app says it cannot, in the same words the
 * other outputs use for a song they cannot cast.
 */
function playableHere(song: Song): boolean {
  return !song.url && !!song.id && !!useAuthStore.getState().auth;
}

/** A track named to Music Assistant, once the library is known. */
function uriFor(song: Song): string | null {
  if (!playableHere(song) || !library) return null;
  return trackUri(library.instanceId, song.id);
}

/**
 * The URI for a song, proved against Music Assistant's library.
 *
 * The library that answered before is tried first; when it does not hold this
 * song the others are tried too, since a house can have two providers of the
 * same kind and nothing in `providers` says which server either points at. An
 * id that resolves is the proof: ids do not travel between servers.
 */
async function verifiedUri(held: MaClient, song: Song): Promise<string | null> {
  if (!playableHere(song)) return null;
  const scope = profileScopeKey();
  if (library && library.scope === scope) {
    const uri = trackUri(library.instanceId, song.id);
    if (await itemByUri(held, uri)) return uri;
  }
  const serverType = useAuthStore.getState().auth?.serverType;
  for (const candidate of libraryCandidates(await listProviders(held), serverType)) {
    if (library?.scope === scope && candidate.instanceId === library.instanceId) continue;
    const uri = trackUri(candidate.instanceId, song.id);
    if (await itemByUri(held, uri)) {
      library = { instanceId: candidate.instanceId, scope };
      return uri;
    }
  }
  return null;
}

/**
 * The tracks after the current one that the player should hold, in order: the
 * next few, going round with repeat "all". None with repeat "one" (the track
 * is handed again when it ends) or when the track is to be the last one heard:
 * the finish must reach the app for the sleep timer to act on it.
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

/** What to tell about a load Music Assistant refused. */
function loadErrorMessage(e: unknown): string {
  const text = tg("Music Assistant couldn't play this song");
  const reason = e instanceof MusicAssistantError && e.kind !== 'network' ? e.message : '';
  return reason ? `${text} (${reason})` : text;
}

/**
 * Loads the track at the state's index on the player, with what follows it
 * behind, in one call. Returns false when there is no session, when Music
 * Assistant's library does not hold the song, or when the call was refused;
 * the reason is shown from here. A call it took and the player never played
 * is not known yet at this point: that is `loadFellFlat`, seconds later.
 */
export function loadMaQueue(state: CastQueueState, autoplay: boolean, startSec = 0): Promise<boolean> {
  return runLoad(state, autoplay, startSec);
}

/**
 * Stops the queue filling itself while the app owns it, remembering how it
 * was. Once per session: the first load asks, and the answer is put back by
 * `letTheQueueFillAgain` on the way out.
 */
async function holdTheQueueStill(client: MaClient, playerId: string): Promise<void> {
  if (filledItselfBefore !== null) return;
  try {
    const queue = queueFrom(await client.command('player_queues/get_active_queue', { player_id: playerId }));
    if (queue?.fillsItself !== true) return;
    filledItselfBefore = true;
    await setDontStopTheMusic(client, playerId, false);
  } catch {
    // A server that will not say, or will not be told, is one whose queue may
    // grow songs of its own. The app reads what it handed over by name, so it
    // carries on rather than refusing to play.
  }
}

/** Puts it back the way it was found. */
async function letTheQueueFillAgain(client: MaClient, playerId: string): Promise<void> {
  if (filledItselfBefore !== true) return;
  filledItselfBefore = null;
  await setDontStopTheMusic(client, playerId, true).catch(() => {});
}

async function runLoad(state: CastQueueState, autoplay: boolean, startSec: number): Promise<boolean> {
  if (!isMaConnected()) return false;
  const song = state.queue[state.index];
  const { playerId } = useMusicAssistant.getState();
  if (!song || !playerId) return false;
  let held: MaClient;
  try {
    held = await ensureClient();
  } catch {
    useToast.getState().show(tg('Lost contact with Music Assistant'));
    return false;
  }
  if (!isMaConnected()) return false;
  await holdTheQueueStill(held, playerId);
  // Written down before anything is sent rather than after: an update landing
  // in between would otherwise still find the track before this one, take its
  // position for this one's and, against the duration already written here,
  // read a song at 6:30 of seven minutes as a three-minute one about to end.
  // The URI follows from the check below.
  loading = true;
  queueGeneration++;
  handedBase = 0;
  handed = [{ uri: '', title: song.title, songId: song.id, key: keyFor(song, state.index) }];
  finishedFired = false;
  wasPlaying = false;
  pausedByUs = false;
  unnamedIsOurs = false;
  foreignSince = null;
  unplacedMedia = null;
  // The player's queue is about to be written again: what the last
  // `queue_updated` said is about to stop meaning anything.
  lastQueue = null;
  lastPositionSec = startSec;
  lastDurationSec = song.duration ?? 0;
  pendingSeekSec = null;
  pendingPause = false;
  seekTries = 0;
  pauseTries = 0;
  clearLoadTimers();
  let head: string | null;
  try {
    head = await verifiedUri(held, song);
  } catch (e) {
    loading = false;
    handed = [];
    useToast.getState().show(loadErrorMessage(e));
    return false;
  }
  if (!head || !isMaConnected()) {
    loading = false;
    handed = [];
    // Two different noes, and they are worth telling apart: a station or a
    // file on the phone is one this output can never play, in the words every
    // output uses for that; a song of the server's that the library does not
    // hold is one Music Assistant has not indexed yet.
    if (isMaConnected()) {
      useToast
        .getState()
        .show(playableHere(song) ? tg("Music Assistant doesn't have this song in its library") : tg("This song can't be cast"));
    }
    return false;
  }
  const generation = queueGeneration;
  const tail = tailIndices(state)
    .map((i) => ({ song: state.queue[i], index: i }))
    .filter((item): item is { song: Song; index: number } => !!item.song);
  const items: Handed[] = [{ uri: head, title: song.title, songId: song.id, key: keyFor(song, state.index) }];
  for (const item of tail) {
    const uri = uriFor(item.song);
    // Stopping at the first one that cannot be named: reached that way, the
    // app is asked to load it and says why it cannot, rather than the player
    // skipping it in silence.
    if (!uri) break;
    items.push({ uri, title: item.song.title, songId: item.song.id, key: keyFor(item.song, item.index) });
  }
  // A speaker in standby takes the song and stays silent. Music Assistant is
  // the one output that says so outright, so it is asked, and a refusal is
  // not a reason to give up on the load.
  const player = currentPlayer();
  if (player?.powered !== true) {
    await cmdPower(held, playerId, true).catch(() => undefined);
  }
  try {
    await cmdPlayMedia(held, playerId, items.map((i) => i.uri), 'replace');
  } catch (e) {
    loading = false;
    handed = [];
    useToast.getState().show(loadErrorMessage(e));
    return false;
  }
  // Overtaken by a newer load while this one was in flight: that one owns
  // playback now, and saying "nothing was installed" here would put the app
  // back on the track this load was for.
  if (generation !== queueGeneration) return true;
  if (!isMaConnected()) return false;
  handed = items;
  handedAt = Date.now();
  pendingSeekSec = startSec > 0 ? startSec : null;
  pendingPause = !autoplay;
  loadSettleTimer = setTimeout(settleBlind, LOAD_SETTLE_MS);
  loadQuietTimer = setTimeout(loadFellFlat, LOAD_QUIET_MS);
  // Before any update: this is where the song is put back where it was and,
  // if nothing asked for it out loud, quietened.
  await settleLoad();
  return true;
}

/**
 * A load the player took without ever naming the track it was handed.
 *
 * Music Assistant renames what it plays into a library URI of its own, and
 * the title is not always enough to recognise, so a player heard playing (or
 * sitting where the load itself asked it to sit) a moment after a load is
 * taken to be on our track, and what it plays unnamed is ours from here on.
 * On a timer because a player that has settled says nothing more: waiting for
 * one more update is waiting for ever.
 */
function settleBlind(): void {
  loadSettleTimer = null;
  const player = lastSeen;
  // Only what the player said after it was handed the queue counts: before
  // that it was still describing the track this load is replacing.
  if (!loading || !isMaConnected() || !player || lastSeenAt < handedAt) return;
  const settled = player.state === 'playing' || (pendingPause && player.state === 'paused');
  if (!settled) return;
  loading = false;
  unnamedIsOurs = true;
  clearLoadTimers();
  // Read again now that the load is out of the way, so the position and the
  // play state reach the app from the same words the player used.
  onPlayerUpdate(player);
}

/**
 * A load Music Assistant took and the player never played. The call is
 * answered whatever the player then makes of it, so a speaker that has gone
 * off the network comes back not as a refusal but as a player that stays
 * quiet. Given up on rather than leaving the app buffering for ever.
 */
function loadFellFlat(): void {
  loadQuietTimer = null;
  if (!loading || !isMaConnected()) return;
  loading = false;
  handed = [];
  useToast.getState().show(tg("Music Assistant couldn't play this song"));
  events?.onPlayingChanged(false, false);
}

/**
 * Brings the tail the player holds in line with the queue: topped up while it
 * still begins the way the queue does, written again when it does not
 * (`repairTail`). One write at a time: the queue changing and the track
 * changing both ask for this, they overlap easily, and two of them reading
 * the same `handed` before either has sent anything hand the player the same
 * songs twice, which it then plays twice.
 */
export async function syncMaQueue(state: CastQueueState): Promise<boolean> {
  if (!isMaConnected() || loading) return false;
  if (inFlightSync) return inFlightSync;
  const run = (async () => {
    const wanted = tailIndices(state);
    const held = handed.slice(1);
    const stillRight = held.every((h, i) => {
      const at = wanted[i] ?? -1;
      const song = state.queue[at];
      return !!song && keyFor(song, at) === h.key;
    });
    if (!stillRight) return repairTail(state);
    const missing = wanted.slice(held.length);
    if (missing.length === 0) return true;
    const socket = client;
    const { playerId } = useMusicAssistant.getState();
    if (!socket || !playerId) return false;
    const items: Handed[] = [];
    for (const i of missing) {
      const song = state.queue[i];
      const uri = song ? uriFor(song) : null;
      if (!song || !uri) break;
      items.push({ uri, title: song.title, songId: song.id, key: keyFor(song, i) });
    }
    if (items.length === 0) return true;
    const generation = queueGeneration;
    try {
      await cmdPlayMedia(socket, playerId, items.map((i) => i.uri), 'add');
    } catch {
      return false;
    }
    // A load in the meantime rewrote the player's whole queue, and the server
    // applied it after this: what was just added is not there any more, so it
    // is not written down either.
    if (generation !== queueGeneration) return false;
    handed.push(...items);
    return true;
  })();
  inFlightSync = run;
  try {
    return await run;
  } finally {
    if (inFlightSync === run) inFlightSync = null;
  }
}

/**
 * Puts right a tail the player is holding that the queue no longer agrees
 * with, after a reorder, a shuffle or a song taken out.
 *
 * By handing the current song over again, from where it had got to, and the
 * new tail behind it. Emptying the player's queue (`player_queues/clear`)
 * would be the obvious way and it is the wrong one: on a Music Assistant
 * player it stops what is sounding as well as dropping what comes after it,
 * so a reorder would cut the music. Re-handing costs the gap of one load and
 * keeps the song.
 */
function repairTail(state: CastQueueState): Promise<boolean> {
  return runLoad(state, lastPlaying, lastPositionSec);
}

// ── The transport ───────────────────────────────────────────────────────────

export async function maPlay(): Promise<void> {
  const held = client;
  const { playerId } = useMusicAssistant.getState();
  if (!held || !playerId) return;
  // Asked to be heard: whatever a load still wanted quietened is off.
  pendingPause = false;
  pausedByUs = false;
  try {
    // A speaker that was switched off between two songs takes the play and
    // makes no sound, the same as it does with a load.
    if (currentPlayer()?.powered !== true) await cmdPower(held, playerId, true).catch(() => undefined);
    await cmdPlay(held, playerId);
  } catch {
    // The next update says what the player actually did.
  }
}

export async function maPause(): Promise<void> {
  const held = client;
  const { playerId } = useMusicAssistant.getState();
  if (!held || !playerId) return;
  pendingPause = false;
  pausedByUs = true;
  try {
    await cmdPause(held, playerId);
  } catch {
    // ignore
  }
}

/**
 * Moves the player in the track, as far as the player is willing: measured on
 * a Chromecast fed by the opensubsonic provider, Music Assistant answers this
 * OK and starts the track again from the beginning instead (`seek` in
 * `lib/musicAssistant.ts` has the measurement). Nothing here works around it.
 */
export async function maSeek(sec: number): Promise<void> {
  const held = client;
  const { playerId } = useMusicAssistant.getState();
  if (!held || !playerId) return;
  // Where the song is now is what was asked for here, not what a load asked
  // for before it.
  pendingSeekSec = null;
  lastPositionSec = sec;
  try {
    await cmdSeek(held, playerId, sec);
  } catch {
    // ignore
  }
}

/** Player volume; the app slider goes 0..1 and Music Assistant takes 0..100. */
export function maSetVolume(volume: number): void {
  const held = client;
  const { playerId } = useMusicAssistant.getState();
  if (!held || !playerId) return;
  const value = Math.max(0, Math.min(1, volume));
  sentVolume = { value, at: Date.now() };
  void cmdVolume(held, playerId, value).catch(() => undefined);
}

// ── The settings screen ─────────────────────────────────────────────────────

/** What one look at a server said, for the screen that asked. */
export interface MaCheck {
  name: string;
  version: string;
  players: number;
  /** The library that answers for this profile's server, when one does. */
  library: string | null;
}

/**
 * Connects, signs in, and says what is there: the server, how many players it
 * can reach, and which of its music libraries is the server this profile is
 * signed in to. Throws a `MusicAssistantError` when any of that fails.
 *
 * The connection made here is the session's: leaving it open is what the
 * output sheet would have opened a moment later anyway.
 */
export async function maCheck(): Promise<MaCheck> {
  const held = await ensureClient();
  const [players, providers] = await Promise.all([listPlayers(held), listProviders(held)]);
  useMusicAssistant.setState({ players });
  const serverType = useAuthStore.getState().auth?.serverType;
  const candidates = libraryCandidates(providers, serverType);
  const info = held.serverInfo;
  if (!isMaConnected()) scheduleIdleClose();
  return {
    name: info?.name ?? '',
    version: info?.version ?? '?',
    players: players.length,
    // The first candidate, which is the one a load will try first. Which of
    // several is really this server is only settled by a song id, and there
    // is none to hand here.
    library: candidates[0]?.name ?? null,
  };
}
