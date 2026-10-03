/**
 * The wake-up alarm: what it is, when it next rings, and how loud it is at
 * each moment of its rise.
 *
 * The ringing itself happens with the app closed, so the time is kept twice:
 * here, in the settings (`alarm`), and in the `Alarm` native module
 * (`modules/alarm`), which `syncAlarm` hands the time and days to each time
 * they change. The module works out the next ring on its own, puts it in
 * `AlarmManager.setAlarmClock`, and when it rings sends the intents API's
 * `alarm` command (docs/INTENTS.md), which starts JS with no screen and plays
 * (`src/lib/intentsApi.ts`). What plays and where is read from the settings
 * at that moment, so only the time travels to the native side.
 *
 * `nextAlarm` is the same computation as the module's `AlarmScheduler.next`,
 * for the settings screen to say when it will ring; keep the two in step.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

/** What the alarm plays: the shuffle, one of the user's playlists, or "For you". */
export type AlarmWhat = 'shuffle' | 'playlist' | 'forYou';
/** Where: this phone, or the home speaker (`homeSpeakerHost`). */
export type AlarmWhere = 'phone' | 'speaker';

export interface AlarmConfig {
  enabled: boolean;
  /** 0 to 23, local time. */
  hour: number;
  /** 0 to 59. */
  minute: number;
  /** The days it rings, as `Date.getDay()` counts them: 0 is Sunday. None is never. */
  days: number[];
  what: AlarmWhat;
  /** The playlist, when `what` is `playlist`. */
  playlistId: string;
  where: AlarmWhere;
  /** How long the volume takes to rise from silence; 0 starts at full volume. */
  rampMinutes: number;
}

export const ALARM_WHATS: readonly AlarmWhat[] = ['shuffle', 'playlist', 'forYou'];
export const ALARM_WHERES: readonly AlarmWhere[] = ['phone', 'speaker'];
/** The rises offered, in minutes. */
export const ALARM_RAMPS: readonly number[] = [0, 1, 3, 5, 10, 15, 30];

export const DEFAULT_ALARM: AlarmConfig = {
  enabled: false,
  hour: 7,
  minute: 0,
  days: [1, 2, 3, 4, 5],
  what: 'shuffle',
  playlistId: '',
  where: 'phone',
  rampMinutes: 5,
};

/**
 * The quietest the alarm rises to. It rises to whatever the phone or the
 * speaker was left at, and one turned all the way down for the night would
 * otherwise wake nobody.
 */
export const ALARM_MIN_LEVEL = 0.3;

function wholeIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** A saved alarm read back, or null when what was saved is not one. */
export function parseAlarm(raw: unknown): AlarmConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.enabled !== 'boolean' || !wholeIn(a.hour, 0, 23) || !wholeIn(a.minute, 0, 59)) return null;
  const days = Array.isArray(a.days) ? a.days.filter((d): d is number => wholeIn(d, 0, 6)) : [];
  return {
    enabled: a.enabled,
    hour: a.hour,
    minute: a.minute,
    days: [...new Set(days)].sort((x, y) => x - y),
    what: ALARM_WHATS.find((w) => w === a.what) ?? DEFAULT_ALARM.what,
    playlistId: typeof a.playlistId === 'string' ? a.playlistId : '',
    where: ALARM_WHERES.find((w) => w === a.where) ?? DEFAULT_ALARM.where,
    rampMinutes: wholeIn(a.rampMinutes, 0, 60) ? a.rampMinutes : DEFAULT_ALARM.rampMinutes,
  };
}

/**
 * When the alarm next rings after `now`, or null when it never does (off, or
 * no day ticked). Today counts when the time is still ahead.
 *
 * Built from the local calendar date, so it is the wall clock's time across a
 * change of hour. A time the change skips (02:30 the night the clocks go
 * forward) lands where `Date` puts it, an hour off; that is left as it is.
 */
export function nextAlarm(config: AlarmConfig, now: Date): Date | null {
  if (!config.enabled || config.days.length === 0) return null;
  for (let i = 0; i <= 7; i++) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, config.hour, config.minute, 0, 0);
    if (at.getTime() > now.getTime() && config.days.includes(at.getDay())) return at;
  }
  return null;
}

/**
 * The volume `elapsedMs` into a rise to `target` over `rampMs`: from
 * silence, in a straight line, and the target at once with no rise.
 */
export function alarmRampLevel(target: number, rampMs: number, elapsedMs: number): number {
  if (rampMs <= 0) return target;
  return target * Math.min(1, Math.max(0, elapsedMs / rampMs));
}

interface NativeAlarm {
  schedule: (config: { enabled: boolean; hour: number; minute: number; days: number[] }) => number | null;
}

const native = requireOptionalNativeModule<NativeAlarm>('Alarm');

/** Whether the alarm can ring here: Android, with the module. */
export const alarmAvailable = native !== null;

/** Hands the time and days to the native side, which schedules the next ring. */
export function syncAlarm(config: AlarmConfig): void {
  if (!native) return;
  try {
    native.schedule({ enabled: config.enabled, hour: config.hour, minute: config.minute, days: config.days });
  } catch (e) {
    console.warn('[alarm] could not schedule', e);
  }
}
