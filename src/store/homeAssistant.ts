/**
 * Integration with Home Assistant's media players (`lib/homeAssistant.ts`):
 * Music Assistant, Chromecast, DLNA, Sonos and whatever else the house has
 * put behind a `media_player.*` entity.
 *
 * The player store keeps the queue. The player is handed the track to play,
 * and, when it takes a queue (`canEnqueue`), the few that follow it, so that
 * it moves from one to the next by itself. Home Assistant only ever adds to
 * a player's queue and never edits it, so the tail is topped up as the player
 * uses it, and a tail the queue has moved out from under (a reorder, a
 * shuffle) is thrown away and written again rather than left to be played:
 * `clear_playlist` where the player has it, and the current track handed over
 * again where it does not. A player that runs into a track no longer in the
 * queue is moved on by this end. A player without a queue gets one track at a
 * time, the next loaded when the poll sees the last one end.
 *
 * There are no events from Home Assistant over REST. The player's state is
 * asked for every two seconds for as long as the session lasts, and the
 * answer is turned into the same `RemoteEvents` the Cast module fires from
 * its status listener: where the track is, whether it plays, which of the
 * handed tracks the player is on (matched by the URL it was given, then by
 * the title), and whether it finished. The position is read off the last
 * one Home Assistant learned and the time gone by since.
 *
 * The poll is also the only place a load is ever judged: `play_media` is
 * answered 200 by nearly every integration, so whether the player could play
 * what it was handed, and whether it is still playing ours at all or somebody
 * else has taken the speaker, is read off the states that follow.
 *
 * The player fetches for itself, from the URL it is handed, exactly as a
 * Cast receiver does (see `remoteTrack.ts`). The address and token are the
 * user's, kept once for every profile in the phone's secure store.
 */
import * as Crypto from 'expo-crypto';
import { create } from 'zustand';

import { type Song } from '@/api/backend';
import { tg } from '@/i18n';
import {
  findPlayer,
  handedIndexFor,
  handedTrackFor,
  HomeAssistantError,
  isActiveState,
  listPlayers,
  mediaPause,
  mediaPlay,
  mediaSeek,
  mediaStop,
  nearEndOf,
  normalizeHaUrl,
  playerState,
  playMedia,
  positionAt,
  turnOn,
  type HaConfig,
  type HaPlayer,
  type HaPlayerState,
  volumeSet,
} from '@/lib/homeAssistant';
import { stopLocalHttp } from '@/lib/localHttp';
import { getItem, setItem } from '@/lib/storage';
import { everyMs } from '@/lib/ticker';
import { castStop } from './castMedia';
import type { CastQueueState } from './googleCast';
import { ensureLocalFilesServed, mp3StreamUrl, remoteTrackInfo, remoteTrackUrl } from './remoteTrack';
import { useToast } from './toast';
import type { RemoteEvents } from './upnp';

interface HomeAssistantStoreState {
  /**
   * The switch, off until turned on: like the Navifind one, a house without
   * Home Assistant should never see a row about it.
   */
  enabled: boolean;
  /** The address and token, empty until set up; the same for every profile. */
  url: string;
  token: string;
  /**
   * The webhook the `resonus` integration listens on for what is playing
   * (`lib/haBridge.ts`), generated here and typed into Home Assistant when
   * the integration is set up. Empty until the screen is opened.
   */
  webhookId: string;
  hydrated: boolean;
  connected: boolean;
  entityId: string | null;
  /** Players found in the last search. */
  players: HaPlayer[];
  searching: boolean;
}

export const useHomeAssistant = create<HomeAssistantStoreState>(() => ({
  enabled: false,
  url: '',
  token: '',
  webhookId: '',
  hydrated: false,
  connected: false,
  entityId: null,
  players: [],
  searching: false,
}));

/** Where the address and token are kept: one key, not per profile. */
const STORAGE_KEY = 'resonus.homeAssistant';

/** How often the player is asked where it is. */
const POLL_MS = 2000;
/** Polls in a row that go unanswered before the session is given up on. */
const MAX_FAILURES = 5;
/**
 * Idle polls in a row before a player still holding tracks is taken to have
 * finished: between two of its items a Cast player passes through idle, and
 * one poll can land on it.
 */
const IDLE_POLLS_WITH_TAIL = 3;
/**
 * Polls after a load before a player heard playing is taken to be on the
 * track it was handed even though it does not name it: Music Assistant
 * reports a URI of its own and, for a stream, a title of its own too.
 */
const LOAD_SETTLE_POLLS = 3;
/**
 * Quiet polls during a load before it is given up on. Home Assistant answers
 * 200 to `play_media` whatever the player then makes of the URL, so a file it
 * cannot decode or an address it cannot reach never comes back as a refusal:
 * it comes back as a player that says idle and stays there.
 */
const LOAD_QUIET_POLLS = 6;
/**
 * Polls of a player playing something that is none of ours before the session
 * is handed back: somebody casting to that speaker from elsewhere means the
 * speaker is theirs now, and one poll of it can be the moment between two of
 * our own tracks.
 */
const TAKEN_OVER_POLLS = 5;
/** Times a pause a load asked for is sent again to a player that plays on regardless. */
const PAUSE_TRIES = 3;
/** How many tracks after the current one a player with a queue holds. */
const NEXT_ITEMS = 3;
/** A volume the player reports this soon after we set one is our own coming back. */
const VOLUME_ECHO_MS = 1500;

/** A track handed to the player, with what a poll is matched against. */
interface Handed {
  url: string;
  title: string;
  songId: string;
  key: string;
}

let events: RemoteEvents | null = null;
/** The player's queue, for naming the index a handed track stands for. */
let queueOf: (() => { queue: Song[]; index: number }) | null = null;
/** Stops the poll's beat (see `everyMs`); null while there is none. */
let stopPolls: (() => void) | null = null;
/** A poll is waiting on its answer: the next tick is skipped rather than stacked. */
let polling = false;
let failures = 0;
let idlePolls = 0;
let loadPolls = 0;
/** Polls of a player that has taken a load and played nothing since. */
let quietPolls = 0;
/** Polls of a player playing something of somebody else's. */
let foreignPolls = 0;
let lastPositionSec = 0;
let lastDurationSec = 0;
/** The last poll heard the player playing: what a repair has to put back. */
let lastPlaying = false;
/** Prevents advancing the queue twice for the same track end. */
let finishedFired = false;
/** A load is in flight: what the player reports meanwhile is the old track's. */
let loading = false;
/** What the last load was, to offer the song again as MP3 when it is not played. */
let lastLoad: { state: CastQueueState; autoplay: boolean; startSec: number; asMp3: boolean } | null = null;
/** We have seen PLAYING since the last load, so a finish is a real one. */
let wasPlaying = false;
/** We asked for the pause ourselves: a player going idle after it is not a track ending. */
let pausedByUs = false;
/**
 * The load settled on a player that does not name our media in our terms, so
 * what it plays without naming is still ours. Until it does, it is not.
 */
let unnamedIsOurs = false;
/** What the player holds, current track first; a poll naming another is a track change. */
let handed: Handed[] = [];
/** Asked for with the load, sent as soon as it returns and again if it did not take. */
let pendingSeekSec: number | null = null;
let pendingPause = false;
let pauseTries = 0;
/** One tail rewrite at a time: two overlapping ones queue the same songs twice. */
let inFlightSync: Promise<boolean> | null = null;
/** The volume we last sent (0..1) and when, to tell its echo from a real change. */
let sentVolume: { value: number; at: number } | null = null;

export function isHaConnected(): boolean {
  return useHomeAssistant.getState().connected;
}

/** Switched on, and an address and a token given; nothing says they work. */
export function haConfigured(): boolean {
  const { enabled, url, token } = useHomeAssistant.getState();
  return enabled && !!url && !!token;
}

function haConfig(): HaConfig {
  const { url, token } = useHomeAssistant.getState();
  return { url, token };
}

function currentPlayer(): HaPlayer | null {
  const { entityId, players } = useHomeAssistant.getState();
  return players.find((p) => p.entityId === entityId) ?? null;
}

/**
 * Registers player events. Call only once (from the player). Also the moment
 * the address and token are read back from the phone.
 */
export function initHomeAssistant(ev: RemoteEvents, queue: () => { queue: Song[]; index: number }): void {
  events = ev;
  queueOf = queue;
  void hydrateConfig();
}

async function hydrateConfig(): Promise<void> {
  try {
    const raw = await getItem(STORAGE_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as { enabled?: unknown; url?: unknown; token?: unknown; webhookId?: unknown })
      : null;
    useHomeAssistant.setState({
      enabled: parsed?.enabled === true,
      url: typeof parsed?.url === 'string' ? parsed.url : '',
      token: typeof parsed?.token === 'string' ? parsed.token : '',
      webhookId: typeof parsed?.webhookId === 'string' ? parsed.webhookId : '',
      hydrated: true,
    });
  } catch {
    useHomeAssistant.setState({ hydrated: true });
  }
}

/** Keeps the address and token, for every profile. Empty both to forget them. */
export function setHomeAssistantConfig(url: string, token: string): void {
  const next = { url: normalizeHaUrl(url), token: token.trim() };
  useHomeAssistant.setState(next);
  persistConfig();
}

/** The switch. Off takes the output list's rows away, and a player with it. */
export function setHomeAssistantEnabled(enabled: boolean): void {
  useHomeAssistant.setState({ enabled });
  persistConfig();
  if (!enabled && useHomeAssistant.getState().connected) void haDisconnect();
}

function persistConfig(): void {
  const { enabled, url, token, webhookId } = useHomeAssistant.getState();
  void setItem(STORAGE_KEY, JSON.stringify({ enabled, url, token, webhookId }));
}

/**
 * The webhook id, made on first ask and kept from then on: it is half of an
 * address and the integration is set up with it, so one that changed would
 * quietly stop the card from ever hearing about the music again. Short
 * enough to be typed into Home Assistant by hand, long enough that nobody on
 * the network guesses it.
 */
export function ensureHaWebhookId(): string {
  const kept = useHomeAssistant.getState().webhookId;
  if (kept) return kept;
  const webhookId = `resonus_${Crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  useHomeAssistant.setState({ webhookId });
  persistConfig();
  return webhookId;
}

/** A song of ours the player is handed: `songId@index`, the same key Cast uses. */
function keyFor(song: Song, index: number): string {
  return `${song.id}@${index}`;
}

/**
 * Where in the queue the handed track sits. The key names the index it had
 * when handed over, which still holds unless the queue was rewritten since;
 * then the song is looked for from the current position on, and failing
 * that anywhere.
 */
function indexForKey(key: string, songId: string, queue: Song[], from: number): number {
  const at = Number(key.slice(key.lastIndexOf('@') + 1));
  if (Number.isInteger(at) && queue[at]?.id === songId) return at;
  const after = queue.findIndex((song, i) => i > from && song.id === songId);
  return after >= 0 ? after : queue.findIndex((song) => song.id === songId);
}

function resetTrackState() {
  failures = 0;
  idlePolls = 0;
  loadPolls = 0;
  quietPolls = 0;
  foreignPolls = 0;
  lastPositionSec = 0;
  lastDurationSec = 0;
  lastPlaying = false;
  finishedFired = false;
  loading = false;
  lastLoad = null;
  wasPlaying = false;
  pausedByUs = false;
  unnamedIsOurs = false;
  handed = [];
  pendingSeekSec = null;
  pendingPause = false;
  pauseTries = 0;
  inFlightSync = null;
}

/** Asks Home Assistant for its media players and refreshes the visible list. */
export async function haSearch(): Promise<void> {
  if (!haConfigured() || useHomeAssistant.getState().searching) return;
  useHomeAssistant.setState({ searching: true });
  try {
    useHomeAssistant.setState({ players: await listPlayers(haConfig()) });
  } catch {
    // keep the previous list
  } finally {
    useHomeAssistant.setState({ searching: false });
  }
}

/**
 * One of the house's players by entity id, or null when Home Assistant is not
 * set up, does not answer, or has no such player. The `output` intent's way
 * in (`lib/intentsApi.ts`): the card names the player, the phone looks it up.
 */
export async function haPlayerById(entityId: string): Promise<HaPlayer | null> {
  if (!haConfigured()) return null;
  try {
    return await findPlayer(haConfig(), entityId);
  } catch {
    return null;
  }
}

export async function haConnect(player: HaPlayer): Promise<boolean> {
  if (!haConfigured()) return false;
  const current = useHomeAssistant.getState();
  // Remote-to-remote handoff: stop the previous player first so playback
  // doesn't continue there while the new one takes over.
  if (current.connected && current.entityId && current.entityId !== player.entityId) {
    await haDisconnect(true);
  }
  resetTrackState();
  const known = current.players.some((p) => p.entityId === player.entityId);
  useHomeAssistant.setState({
    connected: true,
    entityId: player.entityId,
    players: known ? current.players : [...current.players, player],
  });
  startPolling();
  events?.onConnected();
  return true;
}

/**
 * Ends the session; with silent it doesn't notify the player (e.g. when
 * switching output), and with leaveSounding it doesn't quieten the speaker,
 * which is for the one case where what plays there is not ours to stop.
 */
export async function haDisconnect(silent = false, leaveSounding = false): Promise<void> {
  if (!isHaConnected()) return;
  stopPolling();
  const { entityId } = useHomeAssistant.getState();
  // Closes the casting media session on any disconnect path (including silent
  // ones: output switch, reset), not just the normal one.
  castStop();
  // And the port with it: it is only ever open for a player that is
  // listening, and this is the moment there is none.
  void stopLocalHttp();
  useHomeAssistant.setState({ connected: false, entityId: null });
  // Read before the reset below: it is where the local player picks the song
  // back up.
  const resumeAtSec = lastPositionSec;
  resetTrackState();
  sentVolume = null;
  // The app is told first and the speaker second: on a Home Assistant that
  // has gone away these two calls are two ten-second timeouts, and the song
  // is not going to wait that long to come back to the phone.
  if (!silent) events?.onDisconnected(resumeAtSec);
  if (entityId && !leaveSounding) {
    // Stopped rather than left playing: the sound is meant to move, not to
    // double. A player without a stop takes a pause.
    try {
      await mediaStop(haConfig(), entityId);
    } catch {
      await mediaPause(haConfig(), entityId).catch(() => undefined);
    }
  }
}

function startPolling() {
  stopPolling();
  stopPolls = everyMs(POLL_MS, () => void poll());
  void poll();
}

function stopPolling() {
  stopPolls?.();
  stopPolls = null;
  polling = false;
}

/**
 * One look at the player. An answer that does not come is counted, and a run
 * of them is the player, or Home Assistant, gone: the session ends the way a
 * Cast session ends when its device goes away, with one line to say so.
 */
async function poll(): Promise<void> {
  const { entityId } = useHomeAssistant.getState();
  if (!isHaConnected() || !entityId || polling) return;
  polling = true;
  try {
    const state = await playerState(haConfig(), entityId);
    failures = 0;
    if (isHaConnected()) onPlayerState(state);
  } catch (e) {
    failures++;
    const refused = e instanceof HomeAssistantError && e.kind === 'unauthorized';
    if ((refused || failures >= MAX_FAILURES) && isHaConnected()) {
      useToast.getState().show(
        refused ? tg('Home Assistant refused the token') : tg('Lost contact with Home Assistant'),
      );
      void haDisconnect();
    }
  } finally {
    polling = false;
  }
}

function onPlayerState(state: HaPlayerState) {
  const pos = positionAt(state, Date.now());
  const dur = state.durationSec;
  if (state.volume != null) reportVolume(state.volume);
  const sounding = state.state === 'playing' || state.state === 'buffering';
  const active = isActiveState(state.state);
  lastPlaying = sounding;
  const matched = active ? handedIndexFor(state, handed) : -1;
  if (loading) {
    // A load is in flight: what the player says is about the track before,
    // until it names the one it was just handed, or has been playing for
    // long enough that it can only be that one.
    loadPolls++;
    if (matched < 0 && !(sounding && loadPolls >= LOAD_SETTLE_POLLS)) {
      if (!sounding && ++quietPolls >= LOAD_QUIET_POLLS) loadFellFlat();
      return;
    }
    loading = false;
    quietPolls = 0;
    // Heard playing without ever naming the track: this player renames the
    // media, and what it plays unnamed is taken to be ours from here on.
    unnamedIsOurs = matched < 0;
  }
  const at = handedTrackFor(state, handed, unnamedIsOurs);
  if (at < 0 && active) {
    // The player is on media that is none of ours: somebody cast to that
    // speaker from somewhere else. None of what it says is about our song,
    // so nothing of it is written down, and a speaker that stays theirs is
    // given back rather than interrupted at the end of their track.
    if (handed.length > 0 && ++foreignPolls >= TAKEN_OVER_POLLS) {
      useToast.getState().show(tg('Something else is playing on this player'));
      // Left playing: it is their song, and stopping it is what a session
      // that has not noticed it lost the speaker would do.
      void haDisconnect(false, true);
      return;
    }
    events?.onPlayingChanged(false, false);
    return;
  }
  foreignPolls = 0;
  if (at > 0) {
    // The player moved on to another of the tracks it was handed. Those
    // before it are used up; the rest is what it still holds.
    handed = handed.slice(at);
    idlePolls = 0;
    const current = queueOf?.();
    const head = handed[0];
    const index = current ? indexForKey(head.key, head.songId, current.queue, current.index) : -1;
    if (index < 0) {
      // A track that has left the queue since it was handed over: the player
      // is not followed into it, the queue's own next is loaded instead.
      finishedFired = true;
      wasPlaying = false;
      events?.onFinished();
      return;
    }
    finishedFired = false;
    events?.onTrackChanged(index, pos, dur);
  }
  if (at >= 0) {
    lastPositionSec = pos;
    if (dur > 0) lastDurationSec = dur;
  }
  switch (state.state) {
    case 'playing':
      idlePolls = 0;
      finishedFired = false;
      wasPlaying = true;
      pausedByUs = false;
      if (pendingSeekSec != null || (pendingPause && pauseTries < PAUSE_TRIES)) {
        // Handed over with a position, or paused, and the player is playing
        // all the same: what was asked for as the load returned did not take,
        // so it is asked for again while there is any chance of it landing.
        void settleLoad();
        return;
      }
      pendingPause = false;
      events?.onProgress(pos, dur || lastDurationSec);
      events?.onPlayingChanged(true, false);
      return;
    case 'buffering':
      idlePolls = 0;
      events?.onPlayingChanged(true, true);
      return;
    case 'paused':
      idlePolls = 0;
      // The pause a load asked for has landed, and a pause is not a track
      // running out: an idle after one is the player going away.
      pendingPause = false;
      wasPlaying = false;
      events?.onProgress(pos, dur || lastDurationSec);
      events?.onPlayingChanged(false, false);
      return;
    default:
      // idle, off, standby, unavailable: nothing playing. A natural end is
      // an idle after having played, and never one after a pause of ours: a
      // Cast session timing out, a speaker powering down and Home Assistant
      // restarting all look like this, and none of them is a song ending.
      // A player still holding tracks is given a few polls to move on to
      // the next by itself before the idle is believed.
      idlePolls++;
      if (!finishedFired && wasPlaying && !pausedByUs && (handed.length <= 1 || idlePolls >= IDLE_POLLS_WITH_TAIL)) {
        if (nearEndOf(lastPositionSec, lastDurationSec)) {
          finishedFired = true;
          wasPlaying = false;
          events?.onFinished();
          return;
        }
      }
      events?.onPlayingChanged(false, false);
  }
}

/**
 * The seek and the pause a load asked for. `play_media` only ever starts the
 * track from the top and playing, and there is no way to ask it for anything
 * else, so both go out the moment the call returns rather than on the poll
 * that follows: waiting for that poll is two to six seconds of a song nobody
 * asked to hear, at the speaker's own volume, which is what picking a speaker
 * for a paused queue sounded like. A player that was not ready for them is
 * caught by the first poll that still hears it playing, which asks again.
 */
async function settleLoad(): Promise<void> {
  const { entityId } = useHomeAssistant.getState();
  const seek = pendingSeekSec;
  const pause = pendingPause;
  if (!entityId || (seek == null && !pause)) return;
  if (pause) pauseTries++;
  try {
    if (seek != null) {
      await mediaSeek(haConfig(), entityId, seek);
      lastPositionSec = seek;
      // Kept until it is taken, so the poll can ask again for a player that
      // was still fetching the track when this went out.
      if (pendingSeekSec === seek) pendingSeekSec = null;
    }
    if (pause) {
      await mediaPause(haConfig(), entityId);
      pausedByUs = true;
    }
  } catch {
    // The player plays on from where it is; the next poll says where.
    return;
  }
  if (!isHaConnected()) return;
  events?.onProgress(seek ?? lastPositionSec, lastDurationSec);
  events?.onPlayingChanged(!pause, false);
}

/**
 * A load Home Assistant took and the player never played. `play_media` is
 * answered 200 by nearly every integration whatever the player then makes of
 * the URL, so a FLAC a Chromecast cannot decode, or an address off this phone
 * it cannot reach, never comes back as a refusal: it comes back as a player
 * that goes quiet and stays there. The song gets the second chance the other
 * outputs give it, as MP3, and is given up on after that rather than leaving
 * the app buffering for ever.
 */
function loadFellFlat(): void {
  loading = false;
  quietPolls = 0;
  const retry = lastLoad;
  lastLoad = null;
  if (retry && !retry.asMp3) {
    const song = retry.state.queue[retry.state.index];
    const mp3Url = song ? mp3StreamUrl(song) : undefined;
    if (song && mp3Url && mp3Url !== remoteTrackUrl(song)) {
      void runLoad(retry.state, retry.autoplay, retry.startSec, true);
      return;
    }
  }
  handed = [];
  useToast.getState().show(tg("Home Assistant couldn't play this song"));
  events?.onPlayingChanged(false, false);
}

/**
 * The player's volume as it reports it. What we set comes back the same way
 * a moment later, and is not news; anything else (the Home Assistant
 * dashboard, the speaker's own buttons) is, and the player's slider follows.
 */
function reportVolume(volume: number) {
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
 * The tracks after the current one that a player with a queue should hold,
 * in order: the next few, going round with repeat "all". None with repeat
 * "one" (the track is handed again when it ends) or when the track is to be
 * the last one heard: the finish must reach the app for the sleep timer to
 * act on it.
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

/** What to tell about a load Home Assistant refused. */
function loadErrorMessage(e: unknown): string {
  const text = tg("Home Assistant couldn't play this song");
  const reason = e instanceof HomeAssistantError ? e.message : '';
  return reason ? `${text} (${reason})` : text;
}

/**
 * Hands one track to the player, as MP3 the second time if the first was
 * refused (a lossless file the server passes through, say). Returns what
 * was handed, or throws the last refusal.
 */
async function handOver(
  song: Song,
  index: number,
  enqueue: 'replace' | 'add' | undefined,
  asMp3 = false,
): Promise<Handed> {
  const { entityId } = useHomeAssistant.getState();
  const url = (asMp3 ? mp3StreamUrl(song) : undefined) ?? remoteTrackUrl(song);
  if (!entityId || !url) throw new HomeAssistantError('other', 'Nothing can serve this song');
  const info = remoteTrackInfo(song);
  const record = (u: string): Handed => ({ url: u, title: info.title, songId: song.id, key: keyFor(song, index) });
  try {
    await playMedia(haConfig(), entityId, url, info, enqueue);
    return record(url);
  } catch (e) {
    const mp3Url = mp3StreamUrl(song);
    if (!mp3Url || mp3Url === url) throw e;
    await playMedia(haConfig(), entityId, mp3Url, info, enqueue);
    return record(mp3Url);
  }
}

/**
 * Loads the track at the state's index on the player, with what follows it
 * behind when the player takes a queue. Returns false if there is no session
 * or the song is not castable (nothing can serve it), or if Home Assistant
 * refused the call; the reason is shown from here. A call it took and the
 * player did not play is not known yet at this point: that is `loadFellFlat`,
 * a few polls later.
 */
export function loadHaQueue(state: CastQueueState, autoplay: boolean, startSec = 0): Promise<boolean> {
  return runLoad(state, autoplay, startSec, false);
}

async function runLoad(
  state: CastQueueState,
  autoplay: boolean,
  startSec: number,
  asMp3: boolean,
): Promise<boolean> {
  if (!isHaConnected()) return false;
  const song = state.queue[state.index];
  if (!song) return false;
  const player = currentPlayer();
  // A speaker in standby takes the song and stays silent, so it is woken
  // first. The entity that offers it is often not this one but the one the
  // integration found the speaker with, which is why the list keeps it (see
  // `powerEntityId`). Asked of a speaker already awake it does nothing, and a
  // refusal is not a reason to give up on the load.
  if (player?.powerEntityId) {
    await turnOn(haConfig(), player.powerEntityId).catch(() => {});
  }
  loading = true;
  lastLoad = { state, autoplay, startSec, asMp3 };
  finishedFired = false;
  wasPlaying = false;
  pausedByUs = false;
  unnamedIsOurs = false;
  foreignPolls = 0;
  idlePolls = 0;
  lastPositionSec = startSec;
  lastDurationSec = song.duration ?? 0;
  loadPolls = 0;
  quietPolls = 0;
  pendingSeekSec = null;
  pendingPause = false;
  pauseTries = 0;
  // Written down before the calls below rather than after them: a poll landing
  // in between would otherwise still find the track before this one, take its
  // position for this one's and, against the duration already written here,
  // read a song at 6:30 of seven minutes as a three-minute one about to end —
  // skipped before it started. The URL follows from the load, which is what
  // settles whether the song goes out as itself or as MP3.
  handed = [{ url: '', title: remoteTrackInfo(song).title, songId: song.id, key: keyFor(song, state.index) }];
  const tail = player?.canEnqueue ? tailIndices(state) : [];
  try {
    await ensureLocalFilesServed([song, ...tail.map((i) => state.queue[i])]);
    if (!remoteTrackUrl(song)) {
      loading = false;
      handed = [];
      return false;
    }
    const current = await handOver(song, state.index, player?.canEnqueue ? 'replace' : undefined, asMp3);
    handed = [current];
    pendingSeekSec = startSec > 0 ? startSec : null;
    pendingPause = !autoplay;
  } catch (e) {
    loading = false;
    handed = [];
    useToast.getState().show(loadErrorMessage(e));
    return false;
  }
  // Before the tail, and before any poll: this is where the song is put back
  // where it was and, if nothing asked for it out loud, quietened.
  await settleLoad();
  if (tail.length > 0) await addTail(state.queue, tail);
  return true;
}

/**
 * Adds these positions behind what the player holds, stopping at the first
 * it would not take: reached that way, the app is asked to load it and says
 * why it cannot, rather than the player skipping it in silence.
 */
async function addTail(queue: Song[], indices: number[]): Promise<void> {
  for (const i of indices) {
    const song = queue[i];
    if (!song || !isHaConnected()) return;
    try {
      handed.push(await handOver(song, i, 'add'));
    } catch {
      return;
    }
  }
}

/**
 * Brings the tail on the player in line with the queue: topped up while it
 * still begins the way the queue does, thrown away and written again when it
 * does not (`repairTail`). One rewrite at a time, as for Cast: the queue
 * changing and the track changing both ask for this, they overlap easily, and
 * two of them reading the same `handed` before either has pushed anything
 * hand the player the same songs twice, which it then plays twice.
 */
export async function syncHaQueue(state: CastQueueState): Promise<boolean> {
  if (!isHaConnected() || !currentPlayer()?.canEnqueue || loading) return false;
  if (inFlightSync) return inFlightSync;
  const run = (async () => {
    const wanted = tailIndices(state);
    const held = handed.slice(1);
    const stillRight = held.every((h, i) => {
      const song = state.queue[wanted[i] ?? -1];
      return !!song && keyFor(song, wanted[i]) === h.key;
    });
    if (!stillRight) return repairTail(state, wanted);
    const missing = wanted.slice(held.length);
    if (missing.length === 0) return true;
    await ensureLocalFilesServed(
      [state.queue[state.index], ...missing.map((i) => state.queue[i])].filter((s): s is Song => !!s),
    );
    await addTail(state.queue, missing);
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
 * The tail the player holds is not the queue's any more: the songs were
 * reordered or shuffled under it. Home Assistant cannot edit a player's
 * queue, only add to it, so the wrong tail is thrown away and written again.
 * Left alone it is what the player plays next, and since it is still a track
 * this end handed over, the app follows it there and undoes the reorder in
 * front of the person who made it.
 *
 * `clear_playlist` where the player offers it. Where it does not, the only
 * way to take a tail back is to hand the current track over again, which
 * costs the gap of a reload and the seek back to where the song was.
 */
/**
 * Puts right a tail the player is holding that the queue no longer agrees
 * with, after a reorder, a shuffle or a song taken out.
 *
 * By handing the current song over again, from where it had got to, and the
 * new tail behind it. Emptying the player's queue would be the obvious way
 * and it is the wrong one: `clear_playlist` on a Music Assistant player
 * stops what is sounding as well as dropping what comes after it (tried on a
 * Google Home: twenty-seven items and a playing track became none and idle),
 * so a reorder would cut the music. Re-handing costs the gap of one load and
 * keeps the song.
 */
async function repairTail(state: CastQueueState, wanted: number[]): Promise<boolean> {
  const { entityId } = useHomeAssistant.getState();
  if (!entityId) return false;
  return runLoad(state, lastPlaying, lastPositionSec, false);
}

export async function haPlay(): Promise<void> {
  const { entityId } = useHomeAssistant.getState();
  if (!entityId) return;
  // Asked to be heard: whatever a load still wanted quietened is off.
  pendingPause = false;
  pausedByUs = false;
  try {
    await mediaPlay(haConfig(), entityId);
  } catch {
    // ignore
  }
}

export async function haPause(): Promise<void> {
  const { entityId } = useHomeAssistant.getState();
  if (!entityId) return;
  pendingPause = false;
  pausedByUs = true;
  try {
    await mediaPause(haConfig(), entityId);
  } catch {
    // ignore
  }
}

export async function haSeek(sec: number): Promise<void> {
  const { entityId } = useHomeAssistant.getState();
  if (!entityId) return;
  // Where the song is now is what was asked for here, not what a load asked
  // for before it.
  pendingSeekSec = null;
  lastPositionSec = sec;
  try {
    await mediaSeek(haConfig(), entityId, sec);
  } catch {
    // ignore
  }
}

/** Player volume; the app slider and Home Assistant both go 0..1. */
export function haSetVolume(volume: number): void {
  const { entityId } = useHomeAssistant.getState();
  if (!entityId) return;
  const value = Math.max(0, Math.min(1, volume));
  sentVolume = { value, at: Date.now() };
  void volumeSet(haConfig(), entityId, value).catch(() => undefined);
}
