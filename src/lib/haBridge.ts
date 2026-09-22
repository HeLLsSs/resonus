/**
 * What is playing, pushed to Home Assistant, for the `resonus` integration's
 * `media_player` entity (docs/HOME-ASSISTANT.md).
 *
 * The other direction, Home Assistant telling this app what to play, needs
 * nothing new: it goes through the intents API (`lib/intentsApi.ts`), which
 * the Companion app's `command_broadcast_intent` can send from a script. What
 * had no way home was the state, since a broadcast only reaches apps on the
 * phone, and this is it: a POST to a webhook Home Assistant holds open, on
 * every change worth a repaint of the card.
 *
 * The address and token are the ones the output sheet already uses
 * (`store/homeAssistant.ts`); the webhook id is generated here and typed into
 * the integration when it is set up. A webhook takes no token, so nothing
 * secret goes out: the id is what makes the address hard to guess, and the
 * payload is a song title.
 *
 * `publishState` in `lib/intentsApi.ts` does the same job for the broadcast,
 * and the two are deliberately apart: that one is Android's and carries what
 * a Tasker profile reacts to, this one carries what a card draws.
 */
// Not the global `fetch`, for the reason `lib/homeAssistant.ts` gives: this
// goes out with the screen off as often as not.
import { fetch } from 'expo/fetch';

import { onMediaVolumeChanged } from '@/lib/audioOutput';
import { volumeLevel } from '@/lib/volumeLevel';
import { useHomeAssistant } from '@/store/homeAssistant';
import { remoteKind, usePlayerStore, type RepeatMode, type StreamInfo } from '@/store/player';

/** Short enough that a house that is down doesn't hold a socket all day. */
const TIMEOUT_MS = 5_000;
/**
 * How far the position may sit from where it would have drifted on its own
 * before it is worth telling Home Assistant. The card extrapolates between
 * pushes, so a tick is nothing to it and a seek is everything.
 */
const SEEK_TOLERANCE_SEC = 2;

/** What goes out on every push. Ids, not URLs: the integration has the
 *  server's credentials and fetches the cover itself. */
export interface HaBridgeState {
  playing: boolean;
  songId: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  coverArt: string;
  duration: number;
  position: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

/**
 * The player's state as the card wants it, with the volume as the outside
 * sees it (`lib/volumeLevel.ts`) handed in. Pure, so it can be tested.
 */
export function bridgeStateFrom(volume: number, state: {
  isPlaying: boolean;
  queue: { id: string; title: string; artist?: string; album?: string; albumId?: string; coverArt?: string; duration?: number; url?: string }[];
  index: number;
  streamInfo: StreamInfo | null;
  durationSec: number;
  positionSec: number;
  shuffle: boolean;
  repeat: RepeatMode;
}): HaBridgeState {
  const song = state.queue[state.index];
  // A radio names what it is playing itself; the station is the queue item.
  const live = song?.url ? state.streamInfo : null;
  return {
    playing: state.isPlaying,
    songId: song?.id ?? '',
    title: live?.title ?? song?.title ?? '',
    artist: live?.artist ?? song?.artist ?? '',
    album: song?.album ?? '',
    albumId: song?.albumId ?? '',
    coverArt: song?.coverArt ?? '',
    duration: state.durationSec || song?.duration || 0,
    position: Math.max(0, Math.round(state.positionSec)),
    volume,
    shuffle: state.shuffle,
    repeat: state.repeat,
  };
}

/** The address a push goes to, or null while Home Assistant is not set up. */
export function webhookUrl(config: { enabled: boolean; url: string; webhookId: string }): string | null {
  if (!config.enabled || !config.url || !config.webhookId) return null;
  return `${config.url}/api/webhook/${config.webhookId}`;
}

let started = false;
/** What was last pushed, so a tick of the clock is not a push. */
let lastSent: { state: HaBridgeState; at: number } | null = null;

/**
 * Starts pushing. Call once, from the bootstrap: the subscription is what
 * decides a push is due, and nothing else in the app has to know about it.
 */
export function startHaBridge(): void {
  if (started) return;
  started = true;
  // The phone's own volume moves under the hardware keys as well, which the
  // player store never hears about. Only while the phone is what plays: a
  // key pressed with a speaker on moves that speaker, through the store.
  onMediaVolumeChanged(() => {
    if (!remoteKind()) publishHaState();
  });
  usePlayerStore.subscribe((state, prev) => {
    if (
      state.queue !== prev.queue ||
      state.index !== prev.index ||
      state.isPlaying !== prev.isPlaying ||
      state.streamInfo !== prev.streamInfo ||
      state.volume !== prev.volume ||
      state.shuffle !== prev.shuffle ||
      state.repeat !== prev.repeat ||
      seeked(state.positionSec, state.isPlaying, state.speed)
    ) {
      publishHaState();
    }
  });
}

/**
 * Whether the position is somewhere the clock alone could not have taken it:
 * a seek, a track restarted, a queue jumped. Without this the position would
 * be a push a second for as long as the music plays.
 */
function seeked(positionSec: number, playing: boolean, speed: number): boolean {
  if (!lastSent) return false;
  // At the speed it plays: a track at 1.5x is 15 s further on after 10 s,
  // and that is the clock, not a seek.
  const drift = playing ? ((Date.now() - lastSent.at) / 1000) * speed : 0;
  return Math.abs(positionSec - (lastSent.state.position + drift)) > SEEK_TOLERANCE_SEC;
}

/**
 * One push, if there is a house to push to and something new to say.
 * `force` says it again anyway, for a Home Assistant that has just restarted
 * and holds nothing: to it, nothing new to say is not nothing to say.
 */
export function publishHaState(force = false): void {
  const url = webhookUrl(useHomeAssistant.getState());
  if (!url) return;
  const player = usePlayerStore.getState();
  const state = bridgeStateFrom(volumeLevel(), player);
  // Where it got to on its own is not news: the card counts the seconds
  // between pushes by itself. Everything else is, the moment it happens —
  // nothing is held back for a quiet moment, since without a timer the last
  // of a burst would be the one held, and the last is the one that is true.
  if (!force && lastSent && sameSong(state, lastSent.state) && !seeked(state.position, state.playing, player.speed)) {
    return;
  }
  lastSent = { state, at: Date.now() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Nothing waits on it: the push is for somebody else, and a house that is
  // off is not an error here.
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
    signal: controller.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}

/** Everything the card draws, position aside, unchanged. */
function sameSong(a: HaBridgeState, b: HaBridgeState): boolean {
  return (
    a.playing === b.playing &&
    a.songId === b.songId &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.duration === b.duration &&
    a.volume === b.volume &&
    a.shuffle === b.shuffle &&
    a.repeat === b.repeat
  );
}
