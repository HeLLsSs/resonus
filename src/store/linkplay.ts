/**
 * A LinkPlay speaker (a WiiM, say) as a remote output: the phone hands it
 * one track at a time by URL and polls it for where it is, the way the
 * jukebox is driven, and moves the queue on when the track ends. Its
 * multiroom is exposed as the group the output sheet draws: the speaker
 * playing is the leader, and the others are brought in behind it or let go
 * one by one (see `lib/linkplay.ts` for what the speaker is told).
 *
 * The speakers found by the last search are kept, with those typed in by
 * hand, which are remembered on the phone: a search that finds nothing (a
 * network that swallows multicast) is not a reason to lose a speaker whose
 * address is known.
 */
import { create } from 'zustand';

import { fetch } from 'expo/fetch';

import { authHeaders, authParams, isOnlineTrackId, type Song, type SubsonicAuth } from '@/api/subsonic';
import { tg } from '@/i18n';
import { driveLog } from '@/lib/driveLog';
import {
  ask,
  cleanHost,
  cmd,
  describe,
  discover,
  type LinkPlayDevice,
  type LinkPlayRelay,
  type LinkPlaySlave,
  type LinkPlayStatus,
  type LinkPlayWatcher,
  linkPlayAvailable,
  linkPlayDiscovers,
  m3uFor,
  setLinkPlayRelay,
  slavesFrom,
  watchStatus,
} from '@/lib/linkplay';
import { localFileUrl, stopLocalHttp } from '@/lib/localHttp';
import { navifindActive } from '@/lib/navifind';
import { everyMs } from '@/lib/ticker';
import { getItem, setItem } from '@/lib/storage';
import { useAuthStore } from './auth';
import { castStop } from './castMedia';
import { useSettings } from './settings';
import { ensureLocalFilesServed, remoteTrackInfo, remoteTrackUrl } from './remoteTrack';
import { useToast } from './toast';
import type { RemoteEvents } from './upnp';

interface LinkPlayStoreState {
  /** Speakers found, or typed in. */
  devices: LinkPlayDevice[];
  searching: boolean;
  connected: boolean;
  /** The speaker playing, the leader of its group. */
  host: string | null;
  /** The speakers following it. */
  slaves: LinkPlaySlave[];
}

export const useLinkPlay = create<LinkPlayStoreState>(() => ({
  devices: [],
  searching: false,
  connected: false,
  host: null,
  slaves: [],
}));

/** Where the addresses typed in by hand are kept, for every profile. */
const STORAGE_KEY = 'resonus.linkplay.hosts';
/**
 * Where the speakers last found are kept: the sheet has them the moment it
 * opens, while the search that confirms or drops them is still listening.
 */
const SEEN_KEY = 'resonus.linkplay.seen';
/** How often the speaker is asked where it is. */
const POLL_MS = 1_500;
/**
 * How often while a track is being handed over or about to end: these are
 * the moments the answer changes what is shown and done (the spinner stops,
 * the next track is handed over), and waiting a poll and a half for them was
 * the better part of the silence between two songs.
 */
const FAST_POLL_MS = 400;
/** A track with this much left is about to end. */
const ENDING_SEC = 6;
/** Polls in a row that go unanswered before the session is given up on. */
const MAX_FAILURES = 6;
/**
 * How long a speaker that took a track may stay silent before it is said
 * so: a song fetched through the proxy from YouTube or SoundCloud takes
 * seconds to be found before the first byte comes, one on the server does not.
 */
const LOAD_QUIET_MS = 6_000;
const ONLINE_LOAD_QUIET_MS = 12_000;
/** How long after a play command went unanswered before it is sent once more. */
const PLAY_RETRY_MS = 1_000;
/** A poll slower than this is worth a line in the log: the speaker's API is stalling. */
const SLOW_POLL_MS = 2_000;
/** What the list handed to a speaker is published as on the phone (see `lib/localHttp`). */
const M3U_NAME = 'linkplay.m3u';
const M3U_MIME = 'audio/x-mpegurl';
/**
 * Polls in a row saying "stop" before a speaker holding more of its list is
 * taken to have ended the track: between two items of a list it may say so
 * for a moment while it moves on by itself, and that is not an end.
 */
const LIST_STOP_POLLS = 3;

let events: RemoteEvents | null = null;
let queueOf: () => { queue: Song[]; index: number } = () => ({ queue: [], index: 0 });
/**
 * The list the speaker holds, when it was handed one (see `linkPlayLoad`):
 * the songs by id, where each sits in the queue, and the item it is on.
 */
let list: { ids: string[]; indices: number[]; pos: number } | null = null;
let stopPolls = 0;
/** The native asking (see `watchStatus`); null while there is none. */
let watcher: LinkPlayWatcher | null = null;
let pollMs = POLL_MS;
let failures = 0;
let lastPositionSec = 0;
let lastDurationSec = 0;
/**
 * What the player shows: the speaker's last word, or the play or pause it
 * was last asked for. A status that disagrees once the speaker has had its
 * chance to obey puts the player right (see `onStatus`).
 */
let lastPlaying: boolean | null = null;
/** We have heard the speaker playing this track: an end after it is a real one. */
let wasPlaying = false;
let finishedFired = false;
/** A load is in flight, or just landed: what the speaker says is the old track's. */
let loading = false;
/**
 * When the last track was handed over, and when the speaker took it. Until
 * it has, and for a status asked before it had, the speaker describes the
 * track before, even when it says "play": a poll in flight as the track was
 * handed over came back as the new one playing, and the seek waiting for
 * that moment was sent while the speaker was still fetching, and lost; a
 * "stop" after it read as the new track ending, and moved the queue on once
 * more.
 */
let loadSentAt = 0;
let loadAckedAt = 0;
/** How long the silence after the last load may last (see `LOAD_QUIET_MS`). */
let quietLimitMs = LOAD_QUIET_MS;
/** Counts the loads, so one still being retried can tell a newer one has started. */
let loadSeq = 0;
/** We asked for the pause ourselves: a speaker stopped after it is not a track ending. */
let pausedByUs = false;
/**
 * Asked for with the load and sent once the speaker is heard playing: a
 * seek or a pause sent while it is still fetching the track is ignored.
 */
let pendingSeekSec: number | null = null;
let pendingPause = false;
/**
 * Where the stream handed to the speaker starts in the song, when it was
 * asked of the server from partway in (`startInStream`): the speaker counts
 * from the start of what it was handed, and its count is put back into the
 * song's time here. Zero for a stream that begins at the beginning.
 */
let streamOffsetSec = 0;
let startsInStream: (song: Song, startSec: number) => Promise<boolean> = async () => false;
/**
 * Plays and pauses still on their way, and when the speaker took the last
 * one: a status asked before then says nothing about whether it was obeyed,
 * and the player is not put back on its word (see `onStatus`).
 */
let transportPending = 0;
let transportAckedAt = 0;
/** The volume we last sent (0..1) and when, to tell its echo from a real change. */
let sentVolume: { value: number; at: number } | null = null;
const VOLUME_ECHO_MS = 1_500;

export function isLinkPlayConnected(): boolean {
  return useLinkPlay.getState().connected;
}

/** Registers player events. Call only once (from the player). Also reads back the addresses typed in. */
export function initLinkPlay(
  ev: RemoteEvents,
  queue: () => { queue: Song[]; index: number },
  /** Whether a song handed over from a second has to be asked of the server
   *  from there (see `startInStream` on `linkPlayLoad`): the player's rule,
   *  lent here for the one load this store makes on its own. */
  startsIn: (song: Song, startSec: number) => Promise<boolean> = async () => false,
): void {
  events = ev;
  queueOf = queue;
  startsInStream = startsIn;
  void hydrateManual();
  void hydrateSeen();
  // In a browser the speakers are reached through the proxy, when there is
  // one: the relay follows the profile and the Navifind switch.
  if (!linkPlayDiscovers()) {
    const arm = () => {
      const auth = useAuthStore.getState().auth;
      // The store's own word rather than `navifindActive()`: the settings
      // store writes its state before it mirrors the flag, and this runs on
      // the write.
      setLinkPlayRelay(auth && useSettings.getState().navifind ? relayThrough(auth) : null);
    };
    arm();
    useAuthStore.subscribe(arm);
    useSettings.subscribe((s, prev) => {
      if (s.navifind !== prev.navifind) arm();
    });
  }
}

/** The proxy as the way to the speakers (see `LinkPlayRelay`). */
function relayThrough(auth: SubsonicAuth): LinkPlayRelay {
  const url = (path: string, extra: Record<string, string> = {}) => {
    const params = authParams(auth);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return `${auth.serverUrl}/rest/navifind/linkplay/${path}?${params.toString()}`;
  };
  return {
    async call(host, command) {
      const res = await fetch(url('call', { host, command }), { headers: authHeaders(auth) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    async list() {
      const res = await fetch(url('list'), { headers: authHeaders(auth) });
      if (res.status === 403) {
        // The speakers are the host's: this account is not let at them
        // (`LINKPLAY_USERS` on the proxy). For it, there are none.
        setLinkPlayRelay(null);
        return [];
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { devices } = (await res.json()) as { devices: { name: string; host: string }[] };
      return devices;
    },
  };
}

/**
 * What a phone found, told to the proxy, so that a browser signed in to the
 * same server has the speakers without typing an address.
 */
async function tellProxy(found: LinkPlayDevice[]): Promise<void> {
  const auth = useAuthStore.getState().auth;
  if (!auth || !navifindActive() || found.length === 0 || !linkPlayDiscovers()) return;
  const params = authParams(auth);
  await fetch(`${auth.serverUrl}/rest/navifind/linkplay/seen?${params.toString()}`, {
    method: 'POST',
    headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
    body: JSON.stringify({ devices: found.map((d) => ({ host: d.host, name: d.name, model: d.model })) }),
  }).catch(() => undefined);
}

async function hydrateManual(): Promise<void> {
  try {
    const raw = await getItem(STORAGE_KEY);
    const hosts = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(hosts)) return;
    const manual = hosts
      .filter((h): h is string => typeof h === 'string' && h !== '')
      .map((host): LinkPlayDevice => ({ host, name: host, model: '', uuid: '', slave: false, manual: true }));
    if (manual.length > 0) merge(manual);
  } catch {
    // Nothing typed in yet.
  }
}

async function hydrateSeen(): Promise<void> {
  try {
    const raw = await getItem(SEEN_KEY);
    const seen = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(seen)) return;
    merge(
      seen
        .filter((d): d is Pick<LinkPlayDevice, 'host' | 'name' | 'model' | 'uuid'> => typeof d?.host === 'string' && typeof d?.name === 'string')
        .map((d) => ({ host: d.host, name: d.name, model: d.model ?? '', uuid: d.uuid ?? '', slave: false, manual: false })),
    );
  } catch {
    // Nothing found yet.
  }
}

/** Keeps what a search found, and drops from it what it did not find this time. */
function persistSeen(found: LinkPlayDevice[]): void {
  void setItem(SEEN_KEY, JSON.stringify(found.map(({ host, name, model, uuid }) => ({ host, name, model, uuid }))));
}

function persistManual(): void {
  const hosts = useLinkPlay
    .getState()
    .devices.filter((d) => d.manual)
    .map((d) => d.host);
  void setItem(STORAGE_KEY, JSON.stringify(hosts));
}

/** Puts these speakers in the list, by address, keeping what was typed in. */
function merge(found: LinkPlayDevice[]): void {
  const byHost = new Map(useLinkPlay.getState().devices.map((d) => [d.host, d]));
  for (const d of found) {
    const known = byHost.get(d.host);
    byHost.set(d.host, { ...d, manual: known?.manual || d.manual });
  }
  useLinkPlay.setState({ devices: [...byHost.values()].sort((a, b) => a.name.localeCompare(b.name)) });
}

/**
 * Looks for speakers on the network and reads each one, the typed-in ones
 * included: a name typed as an address becomes the speaker's own name.
 */
export async function linkPlaySearch(): Promise<void> {
  if (!linkPlayAvailable() || useLinkPlay.getState().searching) return;
  useLinkPlay.setState({ searching: true });
  try {
    const found = await discover();
    const hosts = new Set([...found.map((f) => f.host), ...useLinkPlay.getState().devices.map((d) => d.host)]);
    const described = await Promise.all([...hosts].map((host) => describe(host)));
    const devices = described.filter((d): d is LinkPlayDevice => d !== null);
    merge(devices);
    // A remembered speaker that answers nobody any more goes.
    const answering = new Set(devices.map((d) => d.host));
    useLinkPlay.setState({ devices: useLinkPlay.getState().devices.filter((d) => d.manual || answering.has(d.host)) });
    persistSeen(devices.filter((d) => !d.manual));
    void tellProxy(devices.filter((d) => !d.manual));
    if (isLinkPlayConnected()) await refreshSlaves();
  } finally {
    useLinkPlay.setState({ searching: false });
  }
}

/**
 * Adds a speaker by its address. Returns what it says it is, or null when
 * nothing there answers as one, in which case nothing is kept.
 */
export async function linkPlayAdd(address: string): Promise<LinkPlayDevice | null> {
  const host = cleanHost(address);
  if (!host) return null;
  const device = await describe(host);
  if (!device) return null;
  merge([{ ...device, manual: true }]);
  persistManual();
  return device;
}

export function linkPlayForget(host: string): void {
  useLinkPlay.setState({ devices: useLinkPlay.getState().devices.filter((d) => d.host !== host) });
  persistManual();
}

export async function linkPlayConnect(device: LinkPlayDevice): Promise<boolean> {
  if (!linkPlayAvailable()) return false;
  const current = useLinkPlay.getState();
  if (current.connected && current.host && current.host !== device.host) await linkPlayDisconnect(true);
  resetTrackState();
  merge([device]);
  driveLog(`speaker: on ${device.name} (${device.host})`);
  useLinkPlay.setState({ connected: true, host: device.host, slaves: [] });
  void refreshSlaves();
  startPolling();
  events?.onConnected();
  return true;
}

/** Ends the session; with `silent` it doesn't notify the player (when switching output). */
export async function linkPlayDisconnect(silent = false): Promise<void> {
  if (!isLinkPlayConnected()) return;
  stopPolling();
  const { host } = useLinkPlay.getState();
  driveLog(`speaker: off${silent ? ' (switching output)' : ''}`);
  castStop();
  // The phone's own server, up for a list or a file of the phone's: closed
  // the way every other output closes it, rather than left open on the
  // network until the next one did.
  void stopLocalHttp();
  useLinkPlay.setState({ connected: false, host: null, slaves: [] });
  const resumeAtSec = lastPositionSec;
  // What the player shows, or, before the speaker has answered for this
  // track, what it was asked for: the phone goes on the same way.
  const playing = lastPlaying ?? !pausedByUs;
  resetTrackState();
  sentVolume = null;
  if (!silent) events?.onDisconnected(resumeAtSec, playing);
  if (host) await ask(host, cmd.stop).catch(() => undefined);
}

function resetTrackState(): void {
  failures = 0;
  lastPositionSec = 0;
  lastDurationSec = 0;
  streamOffsetSec = 0;
  lastPlaying = null;
  wasPlaying = false;
  finishedFired = false;
  loading = false;
  loadAckedAt = 0;
  loadSeq++;
  list = null;
  stopPolls = 0;
  pausedByUs = false;
  pendingSeekSec = null;
  pendingPause = false;
}

/**
 * Has the speaker asked where it is, from native code so that it goes on
 * with the screen locked. Runs of unanswered polls end the session the way a
 * Cast session ends when its device goes away, with one line to say so.
 */
function startPolling(): void {
  stopPolling();
  const { host } = useLinkPlay.getState();
  if (!host) return;
  pollMs = POLL_MS;
  watcher = watchStatus(host, pollMs, (status, error) => {
    if (!isLinkPlayConnected() || useLinkPlay.getState().host !== host) return;
    if (status && !error) {
      failures = 0;
      onStatus(status);
      return;
    }
    failures++;
    if (failures >= MAX_FAILURES) {
      driveLog(`speaker: lost contact, ${failures} polls unanswered (${error ?? 'no status'})`);
      useToast.getState().show(tg('Lost contact with the speaker'));
      void linkPlayDisconnect();
    }
  });
}

function stopPolling(): void {
  watcher?.stop();
  watcher = null;
}

/** Asks fast while it matters (see `FAST_POLL_MS`), at the usual pace otherwise. */
function tunePolling(): void {
  const ending = lastPlaying === true && lastDurationSec > 0 && lastDurationSec - lastPositionSec < ENDING_SEC;
  const wanted = loading || ending ? FAST_POLL_MS : POLL_MS;
  if (wanted === pollMs) return;
  pollMs = wanted;
  watcher?.every(wanted);
}

function onStatus(status: LinkPlayStatus): void {
  reportVolume(status.volume);
  const playing = status.state === 'play';
  const buffering = status.state === 'load';
  if (status.askedAt !== undefined && Date.now() - status.askedAt > SLOW_POLL_MS) {
    driveLog(`speaker: a poll took ${Date.now() - status.askedAt} ms`);
  }
  if (loading) {
    // Not taken yet, or asked before it was: about the track before, whatever
    // it says (see `loadSentAt`). The speaker is heard once it is playing
    // this one, or has said nothing for long enough to be told.
    const stale = loadAckedAt < loadSentAt || (status.askedAt !== undefined && status.askedAt < loadAckedAt);
    if (stale || !playing) {
      if (!playing && Date.now() - loadSentAt >= quietLimitMs) {
        loading = false;
        driveLog(`speaker: silent for ${Math.round((Date.now() - loadSentAt) / 1000)} s after the load, says ${status.state}`);
        if (__DEV__) console.log(`[linkplay] load fell flat · speaker says ${status.state}`);
        useToast.getState().show(tg("The speaker couldn't play this song"));
        events?.onPlayingChanged(false, false);
        tunePolling();
      }
      return;
    }
    loading = false;
    driveLog(`speaker: playing ${Date.now() - loadSentAt} ms after the load`);
    void settleLoad();
  }
  if (list && status.listIndex !== undefined && status.listIndex - 1 !== list.pos && (playing || buffering)) {
    // The speaker moved on to another item of its list by itself. The
    // player follows it there when the queue still says that song comes
    // next; a queue that has changed since the list was handed over moves
    // on from where it is instead, and hands the speaker what comes now.
    const pos = status.listIndex - 1;
    const id = list.ids[pos];
    const index = list.indices[pos];
    list.pos = pos;
    wasPlaying = false;
    finishedFired = false;
    pausedByUs = false;
    pendingSeekSec = null;
    pendingPause = false;
    streamOffsetSec = 0;
    lastPositionSec = status.positionSec;
    lastDurationSec = status.durationSec;
    const follows = id !== undefined && index !== undefined && queueOf().queue[index]?.id === id;
    driveLog(`speaker: moved on to item ${status.listIndex}/${status.listCount}${follows ? '' : ', queue changed since: handing over again'}`);
    if (__DEV__) console.log(`[linkplay] list · item ${status.listIndex}/${status.listCount}`);
    if (follows) {
      events?.onTrackChanged(index, status.positionSec, status.durationSec);
    } else {
      list = null;
      finishedFired = true;
      events?.onFinished();
      return;
    }
  }
  if (__DEV__ && lastPlaying !== playing) console.log(`[linkplay] ${status.state} at ${status.positionSec.toFixed(1)}s`);
  // Of a stream started partway in, the speaker knows the remainder and
  // counts from its start: the song's length and time are the known ones.
  if (status.durationSec > 0 && streamOffsetSec === 0) lastDurationSec = status.durationSec;
  if (playing || status.positionSec > 0) lastPositionSec = streamOffsetSec + status.positionSec;
  if (playing) {
    wasPlaying = true;
    finishedFired = false;
    pausedByUs = false;
    stopPolls = 0;
  }
  events?.onProgress(lastPositionSec, lastDurationSec);
  // Asked once the speaker had taken the last play or pause, a status that
  // disagrees with the player is the speaker having ignored it (a stall of
  // its API, a resume while stopped), and the player follows the speaker.
  const afterTransport =
    transportPending === 0 && (status.askedAt === undefined || status.askedAt >= transportAckedAt);
  if (afterTransport && (lastPlaying !== playing || buffering)) {
    lastPlaying = playing;
    events?.onPlayingChanged(playing, buffering);
  }
  // Stopped after playing, and not by us: the track ended. A speaker that
  // stops reports the position it stopped at, or zero, so the end is told
  // from the state more than from the position.
  const stopped = status.state === 'stop' || status.state === 'none';
  stopPolls = stopped ? stopPolls + 1 : 0;
  const holdsMore = list !== null && list.pos < list.ids.length - 1;
  const ended = stopped && wasPlaying && !pausedByUs && !finishedFired && (!holdsMore || stopPolls >= LIST_STOP_POLLS);
  if (ended && (lastDurationSec === 0 || lastPositionSec >= lastDurationSec - 3 || status.positionSec === 0)) {
    finishedFired = true;
    wasPlaying = false;
    driveLog(`speaker: track ended at ${Math.round(lastPositionSec)}/${Math.round(lastDurationSec)} s (${status.state})`);
    events?.onFinished();
  }
  tunePolling();
}

/** What the load asked for and could only be done once the speaker was playing. */
async function settleLoad(): Promise<void> {
  const { host } = useLinkPlay.getState();
  if (!host) return;
  const seek = pendingSeekSec;
  const pause = pendingPause;
  pendingSeekSec = null;
  pendingPause = false;
  if (seek !== null && seek > 0) {
    lastPositionSec = seek;
    await ask(host, cmd.seek(seek)).catch(() => undefined);
  }
  if (pause) {
    pausedByUs = true;
    await ask(host, cmd.pause).catch(() => undefined);
  }
}

function reportVolume(volume: number): void {
  if (sentVolume && Date.now() - sentVolume.at < VOLUME_ECHO_MS) return;
  events?.onVolume?.(volume);
}

/**
 * Hands the speaker one track, or, with `following`, that track at the head
 * of a list it plays through on its own (see `m3uFor`), published on the
 * phone for it to read. Where the list it already holds has this song next,
 * it is only told to move on to it. Returns false if there is no session or
 * nothing can serve the song; a speaker that takes the URL and plays nothing
 * is told a few polls later (see `onStatus`).
 */
export async function linkPlayLoad(
  song: Song,
  autoplay: boolean,
  startSec = 0,
  following: { song: Song; index: number }[] = [],
  /**
   * Ask the server for the song from `startSec` rather than seek the speaker
   * there: for a transcoded stream, which the speaker cannot seek in (it is
   * made as it is sent and has no length), and only where the server knows
   * how (`timeOffset`). The caller decides, since it knows the song and the
   * server; the speaker then plays what it was handed from its own zero, and
   * `streamOffsetSec` puts the song's time back on what it reports.
   */
  startInStream = false,
): Promise<boolean> {
  const { host } = useLinkPlay.getState();
  if (!host || !isLinkPlayConnected()) return false;
  const seq = ++loadSeq;
  const held = list;
  const moveOn =
    held !== null && following.length > 0 && autoplay && startSec === 0 && held.ids[held.pos + 1] === song.id;
  let offset = startInStream && startSec > 0 ? startSec : 0;
  let command: string;
  if (moveOn) {
    held.pos++;
    command = cmd.next;
  } else {
    list = null;
    // A stream started partway in is handed on its own: a list is of whole
    // songs, and the next load, from the beginning, hands one again.
    const items = following.length > 0 && offset === 0 ? await listFor(song, following) : null;
    // Publishing the list took a moment, and a newer load has started: its
    // command must be the last the speaker hears, so this one is not sent.
    if (seq !== loadSeq) return false;
    if (items) {
      command = cmd.playlist(items.url, 1);
      list = { ids: items.ids, indices: items.indices, pos: 0 };
    } else {
      await ensureLocalFilesServed([song]);
      const url = remoteTrackUrl(song, offset);
      if (!url) return false;
      // A file served off the phone cannot start partway in: handed from the
      // beginning and seeked, as any song the server does not transcode.
      if (offset > 0 && url === remoteTrackUrl(song)) offset = 0;
      command = cmd.play(url);
    }
  }
  streamOffsetSec = offset;
  stopPolls = 0;
  loading = true;
  loadSentAt = Date.now();
  quietLimitMs = isOnlineTrackId(song.id) ? ONLINE_LOAD_QUIET_MS : LOAD_QUIET_MS;
  wasPlaying = false;
  finishedFired = false;
  pausedByUs = !autoplay;
  lastPositionSec = startSec;
  lastDurationSec = song.duration ?? 0;
  lastPlaying = null;
  driveLog(
    `speaker: ${moveOn ? 'next item' : list ? `list of ${list.ids.length}` : 'one track'} · ${song.title} · ${autoplay ? 'playing' : 'paused'} at ${Math.round(startSec)} s`,
  );
  if (__DEV__) console.log(`[linkplay] load · ${command.replace(/[?&][ts]=[^&]*/g, '')} · ${autoplay ? 'playing' : 'paused'} at ${startSec.toFixed(1)}s`);
  pendingSeekSec = startSec > 0 && offset === 0 ? startSec : null;
  pendingPause = !autoplay;
  tunePolling();
  try {
    await sendWithRetry(host, command, seq);
  } catch (e) {
    // A newer load has the speaker now; this one has nothing left to say.
    if (seq !== loadSeq) return false;
    driveLog(`speaker: no answer to the load (${e instanceof Error ? e.message : String(e)})`);
    loading = false;
    list = null;
    pendingSeekSec = null;
    pendingPause = false;
    tunePolling();
    // Said here, as the player says nothing for this output: a speaker whose
    // API sits silent for a while (seen on a WiiM Pro Plus) left the song on
    // screen, paused, with no word as to why.
    useToast.getState().show(tg("The speaker didn't answer"));
    return false;
  }
  if (seq === loadSeq) loadAckedAt = Date.now();
  driveLog(`speaker: took it in ${Date.now() - loadSentAt} ms`);
  return true;
}

/**
 * The list of this song and the ones after it, published on the phone, with
 * what it holds. Null when the phone cannot publish (no server of its own,
 * in a browser) or nothing can serve the first song; a later song nothing
 * can serve ends the list there, so what the speaker is handed is all
 * playable.
 */
async function listFor(
  song: Song,
  following: { song: Song; index: number }[],
): Promise<{ url: string; ids: string[]; indices: number[] } | null> {
  const songs = [song, ...following.map((f) => f.song)];
  const indices = [queueOf().index, ...following.map((f) => f.index)];
  await ensureLocalFilesServed(songs);
  const urls: string[] = [];
  for (const s of songs) {
    const url = remoteTrackUrl(s);
    if (!url) break;
    urls.push(url);
  }
  if (urls.length === 0) return null;
  const kept = songs.slice(0, urls.length);
  const text = m3uFor(
    kept.map((s, i) => {
      const { title, artist, durationSec } = remoteTrackInfo(s);
      return { url: urls[i], title: artist ? `${artist} - ${title}` : title, durationSec };
    }),
  );
  await ensureLocalFilesServed(kept, [{ name: M3U_NAME, text, mime: M3U_MIME }]);
  const url = localFileUrl(M3U_NAME);
  if (!url) return null;
  return { url, ids: kept.map((s) => s.id), indices: indices.slice(0, urls.length) };
}

/**
 * A command sent once more after a moment when it goes unanswered: a
 * speaker's API can sit silent for a few seconds and come back (a WiiM Pro
 * Plus was seen doing so), and one such moment was one song that never
 * played. Not sent again once a newer load has taken the speaker.
 */
async function sendWithRetry(host: string, command: string, seq: number): Promise<void> {
  try {
    await ask(host, command);
  } catch (e) {
    driveLog(`speaker: no answer in ${Date.now() - loadSentAt} ms, asking again`);
    await new Promise<void>((resolve) => {
      const stop = everyMs(PLAY_RETRY_MS, () => {
        stop();
        resolve();
      });
    });
    if (seq !== loadSeq || useLinkPlay.getState().host !== host) throw e;
    await ask(host, command);
  }
}

export async function linkPlayPlay(): Promise<void> {
  const { host } = useLinkPlay.getState();
  if (!host) return;
  pausedByUs = false;
  pendingPause = false;
  // A speaker heard stopped (its stream dropped, or the track ended) ignores
  // a resume: it is handed the track again, where it was, or from the start
  // when it had ended. A paused speaker takes the resume, as does one that
  // nothing can be handed to, so that the next poll says how it went.
  const { queue, index } = queueOf();
  const song = queue[index];
  if (stopPolls > 0 && song) {
    const from = finishedFired ? 0 : lastPositionSec;
    if (await linkPlayLoad(song, true, from, [], await startsInStream(song, from))) return;
  }
  await tellToPlay(host, true);
}

export async function linkPlayPause(): Promise<void> {
  const { host } = useLinkPlay.getState();
  if (!host) return;
  pausedByUs = true;
  await tellToPlay(host, false);
}

/** Resume or pause: what the player shows from now (see `lastPlaying`), and when the speaker took it. */
async function tellToPlay(host: string, playing: boolean): Promise<void> {
  lastPlaying = playing;
  transportPending++;
  await ask(host, playing ? cmd.resume : cmd.pause).catch(() => undefined);
  transportPending--;
  transportAckedAt = Date.now();
}

export async function linkPlaySeek(sec: number): Promise<void> {
  const { host } = useLinkPlay.getState();
  if (!host) return;
  lastPositionSec = sec;
  // Sent while the speaker is still fetching the track, a seek is dropped:
  // it waits for the first moment the speaker is heard playing.
  if (loading) {
    pendingSeekSec = sec;
    return;
  }
  pendingSeekSec = null;
  await ask(host, cmd.seek(sec)).catch(() => undefined);
}

/** Speaker volume; the app slider goes 0..1 and the speaker takes percent. */
export function linkPlaySetVolume(volume: number): void {
  const { host } = useLinkPlay.getState();
  if (!host) return;
  const value = Math.max(0, Math.min(1, volume));
  sentVolume = { value, at: Date.now() };
  void ask(host, cmd.volume(value)).catch(() => undefined);
}

// ── Multiroom ─────────────────────────────────────────────────────────────

async function refreshSlaves(): Promise<void> {
  const { host } = useLinkPlay.getState();
  if (!host) return;
  try {
    const slaves = slavesFrom(await ask(host, cmd.slaves));
    if (useLinkPlay.getState().host === host) useLinkPlay.setState({ slaves });
  } catch {
    // The list stays as it was.
  }
}

/** Brings this speaker in behind the one playing. */
export async function linkPlayJoin(host: string): Promise<boolean> {
  const leader = useLinkPlay.getState().host;
  if (!leader || host === leader) return false;
  try {
    await ask(host, cmd.join(leader));
  } catch {
    return false;
  }
  const joined = await slavesSettle((slaves) => slaves.some((s) => s.host === host));
  // A speaker that joins a leader already playing is listed, yet now and
  // then never picks the stream up: it sits silent in the group (seen on a
  // WiiM Amp with a Sound Lite). Pausing and resuming changes nothing; a
  // seek does, as the leader starts its stream over for the whole group.
  // So the leader is moved to where it is, at the cost of a skip of up to
  // a poll, and every speaker in the group is heard.
  // Not for a stream started partway in: the leader cannot seek in it, and
  // the group picks it up as the stream is.
  if (joined && lastPlaying && !loading && streamOffsetSec === 0) {
    await ask(leader, cmd.seek(lastPositionSec)).catch(() => undefined);
  }
  return joined;
}

/** Lets this speaker go from the group. */
export async function linkPlayLeave(host: string): Promise<boolean> {
  const leader = useLinkPlay.getState().host;
  if (!leader) return false;
  try {
    await ask(leader, cmd.kick(host));
  } catch {
    return false;
  }
  return slavesSettle((slaves) => !slaves.some((s) => s.host === host));
}

/** How often the leader's list is read after a change, and for how long at most. */
const SLAVES_EVERY_MS = 300;
const SLAVES_WAIT_MS = 3_000;

/**
 * The leader takes a moment to list a change to its group: reads its list
 * until `done` says the change shows, or gives up. Returns whether it did.
 */
async function slavesSettle(done: (slaves: LinkPlaySlave[]) => boolean): Promise<boolean> {
  const until = Date.now() + SLAVES_WAIT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, SLAVES_EVERY_MS));
    await refreshSlaves();
    if (done(useLinkPlay.getState().slaves)) return true;
    if (Date.now() >= until) return false;
  }
}
