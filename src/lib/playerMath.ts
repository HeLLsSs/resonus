/**
 * The player's arithmetic, with nothing of the device in it: how a queue is
 * dealt and walked, what ReplayGain makes of a tag, when a sleep fade starts,
 * and what an error is reduced to before it is counted. The store reads its
 * state and hands it over; what it gets back is the same whether expo-audio
 * is loaded or not, which is what lets it be tested in Node.
 */
import type { Song } from '@/api/subsonic';

export type RepeatMode = 'off' | 'all' | 'one';

export const REPEAT_MODES: RepeatMode[] = ['off', 'all', 'one'];

export function isRepeatMode(v: unknown): v is RepeatMode {
  return REPEAT_MODES.some((m) => m === v);
}

/**
 * A list in a new order, without touching the one handed in. Fisher-Yates,
 * shared by the shuffle button, by starting a list while shuffle is already
 * on and by the mixes, because those have to deal the same way: the second
 * used to turn shuffle off instead of dealing at all.
 */
export function dealt<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The index played after `index` in a queue of `count`, or null when playback
 * should stop. `playable` rules an index out (offline, a song with no local
 * file). With repeat 'all' the end wraps round, through the current index
 * too, so a single playable song repeats. Repeat 'one' is the caller's
 * business: a song that ends on its own stays, a skip walks on like 'off'.
 * Shuffle changes nothing here, because the queue itself is dealt.
 */
export function nextQueueIndex(
  count: number,
  index: number,
  repeat: RepeatMode,
  playable: (i: number) => boolean = () => true,
): number | null {
  for (let i = index + 1; i < count; i++) {
    if (playable(i)) return i;
  }
  if (repeat === 'all') {
    for (let i = 0; i <= index && i < count; i++) {
      if (playable(i)) return i;
    }
  }
  return null;
}

export type ReplayGainTags = NonNullable<Song['replayGain']>;

/** The least and the most a ReplayGain tag may do to the volume. */
export const GAIN_MIN = 0.05;
export const GAIN_MAX = 4;

/**
 * Linear ReplayGain factor for a song's tags in the given mode. Album mode
 * without an album gain (or the reverse) uses whatever the tags have; with no
 * tag at all, or the setting off, the factor is 1.
 */
export function gainFactor(rg: ReplayGainTags | undefined, mode: 'off' | 'album' | 'track', preampDb: number): number {
  if (mode === 'off' || !rg) return 1;
  const gain = mode === 'album' ? (rg.albumGain ?? rg.trackGain) : (rg.trackGain ?? rg.albumGain);
  if (typeof gain !== 'number' || !Number.isFinite(gain)) return 1;
  // The pre-amp rides on top of the tag: it moves the target loudness the whole
  // library normalizes to, which is the point of having one (#93).
  let f = Math.pow(10, (gain + preampDb) / 20);
  // With positive gain, don't exceed the file's peak (prevents clipping).
  const peak = mode === 'album' ? (rg.albumPeak ?? rg.trackPeak) : (rg.trackPeak ?? rg.albumPeak);
  if (typeof peak === 'number' && peak > 0) f = Math.min(f, 1 / peak);
  // Safety clamp for wild tags.
  return Math.min(Math.max(f, GAIN_MIN), GAIN_MAX);
}

/** How long the sleep timer's fade to silence takes, at most. */
export const SLEEP_FADE_MS = 30_000;

/**
 * When the sleep fade starts and how long it runs, `msLeft` before the timer
 * fires: the fade FINISHES at expiry, not starts then. "Stop in 30 minutes"
 * means at 30 minutes there is silence, and a timer shorter than the fade
 * fades from the moment it is set.
 */
export function sleepFadeSchedule(msLeft: number): { fadeMs: number; wait: number } {
  const fadeMs = Math.min(SLEEP_FADE_MS, msLeft);
  return { fadeMs, wait: msLeft - fadeMs };
}

/** How far a fade begun at `t0` for `ms` has got at `now`, 0 to 1. */
export function fadeProgress(t0: number, ms: number, now: number): number {
  return Math.min(1, Math.max(0, (now - t0) / ms));
}

/**
 * The error in its own words, with anything that looks like an address taken
 * out: this is counted, and counts are what the Diagnostics report is made of.
 * A stream URL carries the credentials, so none of them can go in it.
 */
export function errorTag(message: string): string {
  const clean = message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, 'url')
    .replace(/\/[\w./-]{16,}/g, 'path')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}
