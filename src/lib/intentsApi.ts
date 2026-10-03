/**
 * JS ↔ `IntentsApi` native module bridge (control from other apps, Android).
 *
 * Tasker, MacroDroid, Automate, an NFC app or `adb shell am broadcast` send
 * the app a `com.hellsss.resonuls.COMMAND` broadcast with a `command` extra,
 * and the app answers every change of track or of play/pause with a
 * `com.hellsss.resonuls.STATE` broadcast. Both are described, with examples,
 * in docs/INTENTS.md.
 *
 * Commands reach JS as events while it runs. Sent to an app that is not
 * running, they are queued in the process and the app is started; JS finds
 * them in the queue as it starts and runs them once the profile is restored.
 * On platforms without the module (web, iOS) everything is a no-op.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { type StoreApi } from 'zustand';

import { getAlbum, getArtist, getPlaylist, getSongsByIds, getStarred, getTopSongs, searchSongs } from '@/api/data';
import { type Song } from '@/api/subsonic';
import { tg } from '@/i18n';
import { ALARM_MIN_LEVEL, alarmRampLevel } from '@/lib/alarm';
import { publishHaState } from '@/lib/haBridge';
import { playShuffle } from '@/lib/playShuffle';
import { isRepeatMode } from '@/lib/playerMath';
import { queryClient } from '@/lib/query';
import { applyTransport } from '@/lib/transport';
import { onVolumeLevelChanged, setVolumeLevel, volumeLevel, volumeStep } from '@/lib/volumeLevel';
import { useAuthStore } from '@/store/auth';
import { haConnect, haPlayerById, useHomeAssistant } from '@/store/homeAssistant';
import { leaveRemoteOutputs, usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';

/** A command as the broadcast carried it: `command` and every other extra. */
type IntentCommand = Record<string, string | number | boolean>;

/** What goes out in every STATE broadcast. */
interface IntentsState {
  playing: boolean;
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  position: number;
}

interface NativeIntentsApi {
  takePending: () => IntentCommand[];
  sendState: (state: IntentsState) => Promise<void>;
  addListener: (event: 'command', cb: (command: IntentCommand) => void) => { remove: () => void };
}

const native = requireOptionalNativeModule<NativeIntentsApi>('IntentsApi');

/**
 * How long a command found on a cold start waits for the saved queue to come
 * back before giving up on it: `play` with nothing restored yet is nothing.
 */
const QUEUE_WAIT_MS = 8_000;

/** The least time between two STATE broadcasts about the same song and state. */
const STATE_MIN_GAP_MS = 1_000;

/** How many matches a `play_search` puts in the queue behind the first. */
const SEARCH_QUEUE_SIZE = 50;

/** How many of an artist's popular songs `play_artist` starts with. */
const TOP_SONGS = 20;

/** The longest sleep timer a command may set: ten hours, past any night. */
const MAX_SLEEP_MINUTES = 600;

let started = false;

/**
 * Starts listening for commands and broadcasting the state. Once per
 * process: called from the root layout's opening effect.
 */
export function startIntentsApi(): void {
  if (!native || started) return;
  started = true;
  native.addListener('command', (command) => {
    run(command).catch((e) => console.warn('[intents] command failed', e));
  });
  drainPending().catch((e) => console.warn('[intents] pending commands failed', e));
  usePlayerStore.subscribe((state, prev) => {
    if (
      state.queue !== prev.queue ||
      state.index !== prev.index ||
      state.isPlaying !== prev.isPlaying ||
      state.streamInfo !== prev.streamInfo
    ) {
      publishState();
    }
  });
}

/**
 * The commands that arrived before JS was listening. Run after the session
 * is restored, since most of them ask the server for something, and after
 * the saved queue is back when there is one to wait for.
 */
async function drainPending(): Promise<void> {
  const pending = native?.takePending() ?? [];
  if (pending.length === 0) return;
  await waitFor(useAuthStore, (s) => !s.hydrating);
  await waitFor(usePlayerStore, (s) => s.queue.length > 0, QUEUE_WAIT_MS);
  for (const command of pending) {
    await run(command).catch((e) => console.warn('[intents] pending command failed', e));
  }
}

/** Resolves when `ready` holds for the store's state, or after `timeoutMs`. */
function waitFor<T>(store: StoreApi<T>, ready: (state: T) => boolean, timeoutMs?: number): Promise<void> {
  if (ready(store.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = store.subscribe((state) => {
      if (!ready(state)) return;
      if (timer) clearTimeout(timer);
      unsub();
      resolve();
    });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        unsub();
        resolve();
      }, timeoutMs);
    }
  });
}

/** A string extra, trimmed; anything else as text. */
function text(command: IntentCommand, key: string): string {
  const value = command[key];
  return value === undefined ? '' : String(value).trim();
}

/** A numeric extra, whether it came as a number (`--ef`) or as text (`--es`). */
function num(command: IntentCommand, key: string): number | undefined {
  const value = command[key];
  if (value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
}

/** A boolean extra: a real boolean (`--ez`), or "true", "1", "on", "yes" as text. */
function flag(command: IntentCommand, key: string): boolean {
  const value = command[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

async function run(command: IntentCommand): Promise<void> {
  const name = text(command, 'command');
  const player = usePlayerStore.getState();
  switch (name) {
    case 'play':
      applyTransport('resume');
      return;
    case 'pause':
    case 'toggle':
    case 'next':
    case 'previous':
      applyTransport(name);
      return;
    case 'stop':
      await player.stopAndClear();
      return;
    case 'seek': {
      const position = num(command, 'position');
      if (position !== undefined) applyTransport('seek', position);
      return;
    }
    case 'volume': {
      const level = num(command, 'level');
      if (level !== undefined) setVolumeLevel(level);
      return;
    }
    case 'shuffle':
      applyTransport('shuffle', flag(command, 'on'));
      return;
    case 'repeat': {
      const mode = text(command, 'mode');
      if (!isRepeatMode(mode)) {
        console.warn(`[intents] repeat: unknown mode "${mode}"`);
        return;
      }
      applyTransport('repeat', mode);
      return;
    }
    case 'play_album':
    case 'play_playlist':
    case 'play_artist':
      await playContainer(name.slice('play_'.length), text(command, 'id'), flag(command, 'shuffle'));
      return;
    case 'play_song': {
      const id = text(command, 'id');
      if (!id) {
        console.warn('[intents] play_song: no id');
        return;
      }
      const [song] = await getSongsByIds([id]);
      if (!song) {
        console.warn(`[intents] play_song: no song with id "${id}"`);
        return;
      }
      await player.playQueue([song], 0, song.title);
      return;
    }
    case 'play_search': {
      const query = text(command, 'query');
      if (!query) return;
      const songs = await searchSongs(query, SEARCH_QUEUE_SIZE);
      if (songs.length === 0) {
        console.warn(`[intents] play_search: nothing found for "${query}"`);
        return;
      }
      await player.playQueue(songs, 0, query);
      return;
    }
    case 'play_favorites': {
      const { songs } = await getStarred();
      if (songs.length === 0) return;
      await player.playQueue(songs, 0, tg('Favorites'), '/favorites', { shuffled: flag(command, 'shuffle') });
      return;
    }
    case 'play_random':
      await playShuffle();
      return;
    case 'ride_on':
    case 'ride_off': {
      // Ride mode from a tag on the bike or a Tasker profile, the way the
      // intercom starts it (docs/RIDE-MODE.md). Loaded here rather than at
      // the top: the ride module brings the router with it, which nothing
      // else here needs.
      const ride = await import('@/lib/rideSync');
      if (name === 'ride_on') await ride.activateRide('intent');
      else ride.deactivateRide();
      return;
    }
    case 'publish_state':
      // Home Assistant asking what is playing, which it has no other way to
      // find out: the push is one-way, so a house that restarted would show
      // an idle card until the next track (see `lib/haBridge.ts`).
      publishHaState(true);
      return;
    case 'output': {
      // Where to play, as the Home Assistant card picks it: this phone, or
      // one of the house's players by entity id. The other outputs the sheet
      // offers are found on the network by the phone and have no id a card
      // could hold.
      const id = text(command, 'id');
      if (id === 'phone') {
        await leaveRemoteOutputs();
        return;
      }
      if (!id.startsWith('media_player.')) {
        console.warn(`[intents] output: "${id}" is neither phone nor a Home Assistant media player`);
        return;
      }
      const { connected, entityId } = useHomeAssistant.getState();
      if (connected && entityId === id) return;
      const target = await haPlayerById(id);
      if (!target) {
        console.warn(`[intents] output: no player "${id}" a URL can be handed to, or Home Assistant is not set up here`);
        return;
      }
      await leaveRemoteOutputs(true, 'ha');
      await haConnect(target);
      return;
    }
    case 'alarm':
      await ringAlarm();
      return;
    case 'sleep_timer': {
      // Whole minutes within reason: past a day the timeout would overflow
      // and fire at once, which is the opposite of what was asked.
      const minutes = Math.min(MAX_SLEEP_MINUTES, Math.max(0, Math.round(num(command, 'minutes') ?? 0)));
      if (minutes > 0) player.setSleepTimer(minutes);
      else player.cancelSleepTimer();
      return;
    }
    default:
      console.warn(`[intents] unknown command "${name}"`);
  }
}

/**
 * Plays an album, a playlist or an artist by id, the way the
 * `resonuls://play/<kind>/<id>` link does: through the screens' own queries,
 * and for an artist the popular songs first, the discography from the
 * earliest album on when the server keeps no play counts.
 */
async function playContainer(kind: string, id: string, shuffled: boolean): Promise<void> {
  if (!id) {
    console.warn(`[intents] play_${kind}: no id`);
    return;
  }
  let songs: Song[] = [];
  let name = '';
  const href = `/${kind}/${id}`;
  if (kind === 'album') {
    const detail = await queryClient.fetchQuery({ queryKey: ['album', id], queryFn: () => getAlbum(id) });
    songs = detail.songs;
    name = detail.album.name;
  } else if (kind === 'playlist') {
    const detail = await queryClient.fetchQuery({ queryKey: ['playlist', id], queryFn: () => getPlaylist(id) });
    songs = detail.songs;
    name = detail.playlist.name;
  } else {
    const { artist, albums } = await getArtist(id);
    name = artist.name;
    songs = name ? await getTopSongs(name, TOP_SONGS) : [];
    if (songs.length === 0) {
      const chrono = [...albums].sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));
      const parts = await Promise.all(
        chrono.map((a) =>
          queryClient.fetchQuery({ queryKey: ['album', a.id], queryFn: () => getAlbum(a.id) }),
        ),
      );
      songs = parts.flatMap((p) => p.songs);
    }
  }
  if (songs.length === 0) {
    console.warn(`[intents] play_${kind}: nothing to play for "${id}"`);
    return;
  }
  await usePlayerStore.getState().playQueue(songs, 0, name, href, { shuffled });
}

/** How often the alarm's rise moves while nothing else moves it. */
const ALARM_TICK_MS = 1_000;

/** Stops the alarm's rise in progress, if any. */
let stopAlarmRise: (() => void) | null = null;

/**
 * The wake-up alarm, sent by its own module when it rings (`lib/alarm.ts`):
 * the music chosen in the settings, on the phone or on the home speaker,
 * from silence up to the volume that was left there. Music already playing
 * is somebody awake and is left alone. A speaker that does not answer leaves
 * the phone to ring: an alarm silent because the Wi-Fi is down wakes nobody.
 */
async function ringAlarm(): Promise<void> {
  // Started from nothing, the settings are still being read back, and the
  // factory alarm is off.
  await waitFor(useSettings, (s) => s.hydrated, QUEUE_WAIT_MS);
  const { alarm, homeSpeakerHost } = useSettings.getState();
  if (!alarm.enabled || usePlayerStore.getState().isPlaying) return;
  const speakerLevel = alarm.where === 'speaker' && homeSpeakerHost ? await alarmSpeaker(homeSpeakerHost) : null;
  if (speakerLevel === null) await leaveRemoteOutputs(true);
  const target = Math.max(ALARM_MIN_LEVEL, speakerLevel ?? volumeLevel());
  const rampMs = alarm.rampMinutes * 60_000;
  if (rampMs > 0) setVolumeLevel(0);
  try {
    if (alarm.what === 'playlist' && alarm.playlistId) await playContainer('playlist', alarm.playlistId, false);
    else if (alarm.what === 'forYou') await (await import('@/lib/forYouMix')).playForYou();
    else await playShuffle();
  } catch (e) {
    // The server out of reach: whatever queue was left still wakes somebody.
    console.warn('[intents] alarm: could not gather the music', e);
    applyTransport('resume');
  }
  if (rampMs <= 0) {
    setVolumeLevel(target);
    return;
  }
  stopAlarmRise?.();
  const t0 = Date.now();
  let sent = 0;
  const tick = () => {
    const level = Math.round(alarmRampLevel(target, rampMs, Date.now() - t0) * 100) / 100;
    if (level !== sent) {
      sent = level;
      setVolumeLevel(level);
    }
    if (level >= target) stopAlarmRise?.();
  };
  const timer = setInterval(tick, ALARM_TICK_MS);
  // The interval sleeps with the screen off, as the sleep fade's does; the
  // player's own updates go on arriving there and move the rise along.
  const stopPlayer = usePlayerStore.subscribe(tick);
  // A hand on the volume is somebody awake: the rise stops where they put it.
  const stopVolume = onVolumeLevelChanged((level) => {
    if (Math.abs(level - sent) > volumeStep() * 1.5) stopAlarmRise?.();
  });
  stopAlarmRise = () => {
    clearInterval(timer);
    stopPlayer();
    stopVolume();
    stopAlarmRise = null;
  };
}

/**
 * The home speaker taken as the output, the way its row in the output sheet
 * is. Returns its volume, which the alarm rises back to, or null when it does
 * not answer.
 */
async function alarmSpeaker(host: string): Promise<number | null> {
  const [lp, { linkPlayConnect, useLinkPlay }] = await Promise.all([import('@/lib/linkplay'), import('@/store/linkplay')]);
  const status = lp.statusFrom(await lp.ask(host, lp.cmd.player).catch(() => null));
  if (!status) return null;
  const { connected, host: current } = useLinkPlay.getState();
  if (!connected || current !== host) {
    const device = await lp.describe(host);
    if (!device) return null;
    await leaveRemoteOutputs(true, 'linkplay');
    if (!(await linkPlayConnect(device))) return null;
  }
  return status.volume;
}

/** What was last broadcast, so nothing goes out twice and bursts are thinned. */
let lastSent = { playing: false, id: '', key: '', at: 0 };

/**
 * Broadcasts the state after a change. Whether it is playing and which song
 * it is always go out at once: those are what a profile reacts to, and the
 * app may be paused for an hour with nothing else to carry a late one. What
 * is held to one a second is the rest, which is a radio renaming its song.
 * No timer is involved: one would sleep with the app in the background, which
 * is exactly where these broadcasts are listened to.
 */
function publishState(): void {
  if (!native) return;
  const state = usePlayerStore.getState();
  const song = state.queue[state.index];
  // A radio names what it is playing itself; the station is the queue item.
  const live = song?.url ? state.streamInfo : null;
  const next: IntentsState = {
    playing: state.isPlaying,
    id: song?.id ?? '',
    title: live?.title ?? song?.title ?? '',
    artist: live?.artist ?? song?.artist ?? '',
    album: song?.album ?? '',
    duration: state.durationSec || song?.duration || 0,
    position: state.positionSec,
  };
  const key = [next.playing, next.id, next.title, next.artist, next.album].join('|');
  if (key === lastSent.key) return;
  const now = Date.now();
  const flipped = next.playing !== lastSent.playing || next.id !== lastSent.id;
  if (!flipped && now - lastSent.at < STATE_MIN_GAP_MS) return;
  lastSent = { playing: next.playing, id: next.id, key, at: now };
  // Nothing waits on it: the broadcast is for somebody else.
  void native.sendState(next);
}
