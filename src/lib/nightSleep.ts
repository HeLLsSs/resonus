/**
 * "Late night: stop in 30 minutes?": when the music starts between 23:00 and
 * 05:00 with no sleep timer set, a toast offers one, and taking it does what
 * "30 min" in the sleep timer sheet does.
 *
 * Once a night, whatever the number of starts: a night is named by the
 * evening it began on, so 01:00 belongs to the day before, and the last one
 * offered is kept on disk so a restart of the app in the small hours does not
 * ask again. Not on the motorbike, where the music stays as it is, nor in a
 * Jam, whose playback is the session's business.
 */
import { tg } from '@/i18n';
import { getPlainItem, setPlainItem } from '@/lib/plainStorage';
import { isJamActive } from '@/store/jam';
import { usePlayerStore } from '@/store/player';
import { useRideMode } from '@/store/rideMode';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';

/** Where the last night offered is kept, by `nightKey`. */
const LAST_KEY = 'resonus.nightSleep.last';
/** The hour the night starts at, and the one it ends at, local time. */
const NIGHT_FROM = 23;
const NIGHT_TO = 5;
/** What the offer arms, in minutes. */
const SLEEP_MINUTES = 30;

/** Between 23:00 and 05:00, local time. */
export function isLateNight(date: Date): boolean {
  const hour = date.getHours();
  return hour >= NIGHT_FROM || hour < NIGHT_TO;
}

/** The evening the night began on, as `YYYY-MM-DD`: before 05:00 it is the
 *  day before. */
export function nightKey(date: Date): string {
  const evening = new Date(date);
  if (evening.getHours() < NIGHT_TO) evening.setDate(evening.getDate() - 1);
  const month = String(evening.getMonth() + 1).padStart(2, '0');
  const day = String(evening.getDate()).padStart(2, '0');
  return `${evening.getFullYear()}-${month}-${day}`;
}

export interface NightSleepFlags {
  now: Date;
  /** The `nightSleepSuggest` setting. */
  enabled: boolean;
  /** A sleep timer is set already, for a time or for the end of the song. */
  armed: boolean;
  ride: boolean;
  jam: boolean;
  /** The night already offered, by `nightKey`, or null. */
  lastNight: string | null;
}

export function shouldSuggestSleep(flags: NightSleepFlags): boolean {
  return (
    flags.enabled &&
    !flags.armed &&
    !flags.ride &&
    !flags.jam &&
    isLateNight(flags.now) &&
    flags.lastNight !== nightKey(flags.now)
  );
}

let lastNight: string | null = null;

function consider(): void {
  const now = new Date();
  const { sleepEndsAt, sleepAtSongEnd } = usePlayerStore.getState();
  const offer = shouldSuggestSleep({
    now,
    enabled: useSettings.getState().nightSleepSuggest,
    armed: sleepEndsAt !== null || sleepAtSongEnd,
    ride: useRideMode.getState().active,
    jam: isJamActive(),
    lastNight,
  });
  if (!offer) return;
  lastNight = nightKey(now);
  void setPlainItem(LAST_KEY, lastNight);
  useToast.getState().show(tg('Late night: stop in 30 minutes?'), {
    label: tg('Sleep in 30 min'),
    run: () => usePlayerStore.getState().setSleepTimer(SLEEP_MINUTES),
  });
}

/** Starts watching for the music starting late. Once, from `bootstrap.ts`. */
export function startNightSleep(): void {
  void getPlainItem(LAST_KEY)
    .then((raw) => {
      // A night offered meanwhile is the later one.
      lastNight ??= raw;
    })
    .catch(() => undefined);
  usePlayerStore.subscribe((state, prev) => {
    if (state.isPlaying && !prev.isPlaying) consider();
  });
}
