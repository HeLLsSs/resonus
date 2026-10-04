/**
 * The weekly report: on Sunday evening, how long you listened this week and
 * to whom most, as a notification that opens the stats on "This week", and
 * the week's most played songs as a playlist on the server, the same one
 * refreshed every week.
 *
 * This file is the calendar, the ranking and the words, kept pure so they
 * can be tested without a phone. What reads the log, notifies and writes the
 * playlist is `weeklyReportSync.ts`.
 *
 * A week runs Monday to Sunday, local time, which is how the stats screen
 * counts "This week" too.
 */
import { tg } from '@/i18n';

/** The day and hour the report is due, local time: Sunday, 19:00. */
const REPORT_WEEKDAY_OFFSET = 6;
const REPORT_HOUR = 19;
/** How many songs the week's playlist holds. */
export const PLAYLIST_SIZE = 30;

/** Monday 00:00 of the week `now` is in, local time. */
export function weekStart(now: Date): Date {
  const sinceMonday = (now.getDay() + 6) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday);
}

/** The week's name, its Monday as `YYYY-MM-DD`: what is kept to report it once. */
export function weekKey(now: Date): string {
  const monday = weekStart(now);
  const month = String(monday.getMonth() + 1).padStart(2, '0');
  const day = String(monday.getDate()).padStart(2, '0');
  return `${monday.getFullYear()}-${month}-${day}`;
}

/** When the report of the week `now` is in falls due: its Sunday at 19:00. */
export function reportTime(now: Date): Date {
  const monday = weekStart(now);
  // Built from the calendar rather than by adding hours, so a change of
  // clocks during the week does not move it.
  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + REPORT_WEEKDAY_OFFSET, REPORT_HOUR);
}

/**
 * Whether the report is to be made now: past Sunday 19:00 and not made yet
 * this week. A phone that was off at seven makes it whenever it comes back
 * before midnight; after that the week is over and so is its report.
 */
export function reportDue(now: Date, lastReported: string | null): boolean {
  return now.getTime() >= reportTime(now).getTime() && weekKey(now) !== lastReported;
}

/** The songs of the week's playlist, the most played first; equal counts keep the log's order. */
export function rankSongs(rows: { songId: string; plays: number }[], limit = PLAYLIST_SIZE): string[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => b.row.plays - a.row.plays || a.i - b.i)
    .slice(0, limit)
    .map(({ row }) => row.songId);
}

/** The time listened, in whole hours, or in minutes under an hour. */
function listened(seconds: number): string {
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return minutes === 1 ? tg('1 minute') : tg('{n} minutes', { n: minutes });
  }
  const hours = Math.round(seconds / 3600);
  return hours === 1 ? tg('1 hour') : tg('{n} hours', { n: hours });
}

/** The notification's words: "Your week: 12 hours, top artist X". */
export function weeklyMessage(seconds: number, topArtist?: string): string {
  const duration = listened(seconds);
  return topArtist
    ? tg('Your week: {duration}, top artist {artist}', { duration, artist: topArtist })
    : tg('Your week: {duration}', { duration });
}
