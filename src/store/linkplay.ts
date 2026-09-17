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

import { type Song } from '@/api/subsonic';
import { tg } from '@/i18n';
import {
  ask,
  cleanHost,
  cmd,
  describe,
  discover,
  type LinkPlayDevice,
  type LinkPlaySlave,
  linkPlayAvailable,
  slavesFrom,
  watchStatus,
} from '@/lib/linkplay';
import { getItem, setItem } from '@/lib/storage';
import { castStop } from './castMedia';
import { ensureLocalFilesServed, remoteTrackUrl } from './remoteTrack';
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
/** How often the speaker is asked where it is. */
const POLL_MS = 1_500;
/** Polls in a row that go unanswered before the session is given up on. */
const MAX_FAILURES = 6;
/** Polls of a speaker that took a track and stayed silent, before it is said so. */
const LOAD_QUIET_POLLS = 8;

let events: RemoteEvents | null = null;
/** Stops the native asking (see `watchStatus`); null while there is none. */
let stopWatching: (() => void) | null = null;
let failures = 0;
let lastPositionSec = 0;
let lastDurationSec = 0;
let lastPlaying: boolean | null = null;
/** We have heard the speaker playing this track: an end after it is a real one. */
let wasPlaying = false;
let finishedFired = false;
/** A load is in flight, or just landed: what the speaker says is the old track's. */
let loading = false;
let quietPolls = 0;
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
export function initLinkPlay(ev: RemoteEvents): void {
  events = ev;
  void hydrateManual();
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
    merge(described.filter((d): d is LinkPlayDevice => d !== null));
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
  quietPolls = 0;
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
  stopWatching = watchStatus(host, POLL_MS, (status, error) => {
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
  stopWatching?.();
  stopWatching = null;
}

function onStatus(status: { state: string; positionSec: number; durationSec: number; volume: number }): void {
  reportVolume(status.volume);
  const playing = status.state === 'play';
  const buffering = status.state === 'load';
  if (loading) {
    // The speaker still describes the track before, until it is heard
    // playing this one, or has said nothing for long enough to be told.
    if (!playing) {
      if (++quietPolls >= LOAD_QUIET_POLLS) {
        loading = false;
        if (__DEV__) console.log(`[linkplay] load fell flat · speaker says ${status.state}`);
        useToast.getState().show(tg("The speaker couldn't play this song"));
        events?.onPlayingChanged(false, false);
      }
      return;
    }
    loading = false;
    quietPolls = 0;
    void settleLoad();
  }
  if (__DEV__ && lastPlaying !== playing) console.log(`[linkplay] ${status.state} at ${status.positionSec.toFixed(1)}s`);
  if (status.durationSec > 0) lastDurationSec = status.durationSec;
  if (playing || status.positionSec > 0) lastPositionSec = status.positionSec;
  if (playing) {
    wasPlaying = true;
    finishedFired = false;
    pausedByUs = false;
  }
  events?.onProgress(lastPositionSec, lastDurationSec);
  if (lastPlaying !== playing || buffering) {
    lastPlaying = playing;
    events?.onPlayingChanged(playing, buffering);
  }
  // Stopped after playing, and not by us: the track ended. A speaker that
  // stops reports the position it stopped at, or zero, so the end is told
  // from the state more than from the position.
  const ended = (status.state === 'stop' || status.state === 'none') && wasPlaying && !pausedByUs && !finishedFired;
  if (ended && (lastDurationSec === 0 || lastPositionSec >= lastDurationSec - 3 || status.positionSec === 0)) {
    finishedFired = true;
    wasPlaying = false;
    events?.onFinished();
  }
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
 * Hands the speaker one track. Returns false if there is no session or
 * nothing can serve the song; a speaker that takes the URL and plays nothing
 * is told a few polls later (see `onStatus`).
 */
export async function linkPlayLoad(song: Song, autoplay: boolean, startSec = 0): Promise<boolean> {
  const { host } = useLinkPlay.getState();
  if (!host || !isLinkPlayConnected()) return false;
  await ensureLocalFilesServed([song]);
  const url = remoteTrackUrl(song);
  if (!url) return false;
  loading = true;
  quietPolls = 0;
  wasPlaying = false;
  finishedFired = false;
  pausedByUs = !autoplay;
  lastPositionSec = startSec;
  lastDurationSec = song.duration ?? 0;
  lastPlaying = null;
  if (__DEV__) console.log(`[linkplay] load · ${url.replace(/[?&][ts]=[^&]*/g, '')} · ${autoplay ? 'playing' : 'paused'} at ${startSec.toFixed(1)}s`);
  pendingSeekSec = startSec > 0 ? startSec : null;
  pendingPause = !autoplay;
  try {
    await ask(host, cmd.play(url));
    return true;
  } catch {
    loading = false;
    pendingSeekSec = null;
    pendingPause = false;
    return false;
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
  pendingSeekSec = null;
  lastPositionSec = sec;
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
  // The speaker takes a moment to be listed by its leader.
  await new Promise((r) => setTimeout(r, 1_500));
  await refreshSlaves();
  return useLinkPlay.getState().slaves.some((s) => s.host === host);
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
  await new Promise((r) => setTimeout(r, 1_000));
  await refreshSlaves();
  return !useLinkPlay.getState().slaves.some((s) => s.host === host);
}
