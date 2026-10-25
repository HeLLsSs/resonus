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
let lastPlaying: boolean | null = null;
/** We have heard the speaker playing this track: an end after it is a real one. */
let wasPlaying = false;
let finishedFired = false;
/** A load is in flight, or just landed: what the speaker says is the old track's. */
let loading = false;
/**
 * When the speaker took the last track handed to it. A status asked before
 * then is about the track before, even one that says "play": a poll in
 * flight as the track was handed over came back as the new one playing, and
 * the seek waiting for that moment was sent while the speaker was still
 * fetching, and lost; a "stop" after it read as the new track ending, and
 * moved the queue on once more.
 */
let loadAckedAt = 0;
/** When the last track was handed over, and how long its silence may last. */
let loadSentAt = 0;
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
/** The volume we last sent (0..1) and when, to tell its echo from a real change. */
let sentVolume: { value: number; at: number } | null = null;
const VOLUME_ECHO_MS = 1_500;

export function isLinkPlayConnected(): boolean {
  return useLinkPlay.getState().connected;
}

/** Registers player events. Call only once (from the player). Also reads back the addresses typed in. */
export function initLinkPlay(ev: RemoteEvents, queue: () => { queue: Song[]; index: number }): void {
  events = ev;
  queueOf = queue;
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
  castStop();
  // The phone's own server, up for a list or a file of the phone's: closed
  // the way every other output closes it, rather than left open on the
  // network until the next one did.
  void stopLocalHttp();
  useLinkPlay.setState({ connected: false, host: null, slaves: [] });
  const resumeAtSec = lastPositionSec;
  resetTrackState();
  sentVolume = null;
  if (!silent) events?.onDisconnected(resumeAtSec);
  if (host) await ask(host, cmd.stop).catch(() => undefined);
}

function resetTrackState(): void {
  failures = 0;
  lastPositionSec = 0;
  lastDurationSec = 0;
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
  if (loading) {
    if (status.askedAt !== undefined && status.askedAt < loadAckedAt) return;
    // The speaker still describes the track before, until it is heard
    // playing this one, or has said nothing for long enough to be told.
    if (!playing) {
      if (Date.now() - loadSentAt >= quietLimitMs) {
        loading = false;
        if (__DEV__) console.log(`[linkplay] load fell flat · speaker says ${status.state}`);
        useToast.getState().show(tg("The speaker couldn't play this song"));
        events?.onPlayingChanged(false, false);
        tunePolling();
      }
      return;
    }
    loading = false;
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
    lastPositionSec = status.positionSec;
    lastDurationSec = status.durationSec;
    if (__DEV__) console.log(`[linkplay] list · item ${status.listIndex}/${status.listCount}`);
    if (id !== undefined && index !== undefined && queueOf().queue[index]?.id === id) {
      events?.onTrackChanged(index, status.positionSec, status.durationSec);
    } else {
      list = null;
      finishedFired = true;
      events?.onFinished();
      return;
    }
  }
  if (__DEV__ && lastPlaying !== playing) console.log(`[linkplay] ${status.state} at ${status.positionSec.toFixed(1)}s`);
  if (status.durationSec > 0) lastDurationSec = status.durationSec;
  if (playing || status.positionSec > 0) lastPositionSec = status.positionSec;
  if (playing) {
    wasPlaying = true;
    finishedFired = false;
    pausedByUs = false;
    stopPolls = 0;
  }
  events?.onProgress(lastPositionSec, lastDurationSec);
  if (lastPlaying !== playing || buffering) {
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
): Promise<boolean> {
  const { host } = useLinkPlay.getState();
  if (!host || !isLinkPlayConnected()) return false;
  const seq = ++loadSeq;
  const held = list;
  const moveOn =
    held !== null && following.length > 0 && autoplay && startSec === 0 && held.ids[held.pos + 1] === song.id;
  let command: string;
  if (moveOn) {
    held.pos++;
    command = cmd.next;
  } else {
    list = null;
    const items = following.length > 0 ? await listFor(song, following) : null;
    // Publishing the list took a moment, and a newer load has started: its
    // command must be the last the speaker hears, so this one is not sent.
    if (seq !== loadSeq) return false;
    if (items) {
      command = cmd.playlist(items.url, 1);
      list = { ids: items.ids, indices: items.indices, pos: 0 };
    } else {
      await ensureLocalFilesServed([song]);
      const url = remoteTrackUrl(song);
      if (!url) return false;
      command = cmd.play(url);
    }
  }
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
  if (__DEV__) console.log(`[linkplay] load · ${command.replace(/[?&][ts]=[^&]*/g, '')} · ${autoplay ? 'playing' : 'paused'} at ${startSec.toFixed(1)}s`);
  pendingSeekSec = startSec > 0 ? startSec : null;
  pendingPause = !autoplay;
  tunePolling();
  try {
    await sendWithRetry(host, command, seq);
  } catch {
    // A newer load has the speaker now; this one has nothing left to say.
    if (seq !== loadSeq) return false;
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
  await ask(host, cmd.resume).catch(() => undefined);
}

export async function linkPlayPause(): Promise<void> {
  const { host } = useLinkPlay.getState();
  if (!host) return;
  pausedByUs = true;
  await ask(host, cmd.pause).catch(() => undefined);
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
  if (joined && lastPlaying && !loading) {
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
