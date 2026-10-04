/**
 * The weekly report put to work (see `weeklyReport.ts` for what it says and
 * when): every few minutes while the app is alive, and on coming back to the
 * front, it asks whether this week's report is due, and when it is, reads
 * the week out of the listening log, notifies, and refreshes the week's
 * playlist on the server.
 *
 * Only while the app is alive: nothing wakes the phone for it. A phone that
 * plays music on Sunday evening is alive anyway, and one that was not makes
 * the report when it is opened before midnight.
 *
 * What is kept, per profile: the last week reported, and the id of the
 * playlist, which is filled again every week rather than made anew, so the
 * library holds one "Your week" and not one per Sunday.
 */
import * as Notifications from 'expo-notifications';
import { AppState, Linking, Platform } from 'react-native';

import { createPlaylist, reorderPlaylist } from '@/api/data';
import { isOnlineTrackId } from '@/api/subsonic';
import { tg } from '@/i18n';
import { askNotificationPermission } from '@/lib/navifindWatch';
import { getPlainItem, setPlainItem } from '@/lib/plainStorage';
import { queryClient } from '@/lib/query';
import { queryPlaysBySong, queryStats } from '@/lib/statsDb';
import { everyMs } from '@/lib/ticker';
import { rankSongs, reportDue, weekKey, weeklyMessage, weekStart } from '@/lib/weeklyReport';
import { profileScopeId, useAuthStore } from '@/store/auth';
import { useSettings } from '@/store/settings';

const STORE_KEY = 'resonus.weeklyReport';
/** How often the report is asked about: "around 19:00" is within this. */
const CHECK_EVERY_MS = 5 * 60_000;
const CHANNEL_ID = 'weekly-report';
const STATS_URL = 'resonuls://stats';

interface Kept {
  week?: string;
  playlistId?: string;
}

/** Per profile, read once and written whole. */
let kept: Record<string, Kept> | null = null;
let running = false;
let handledTap = '';

async function load(): Promise<Record<string, Kept>> {
  if (kept) return kept;
  try {
    const raw = await getPlainItem(STORE_KEY);
    kept = raw ? (JSON.parse(raw) as Record<string, Kept>) : {};
  } catch {
    kept = {};
  }
  return kept;
}

function save(): void {
  if (kept) void setPlainItem(STORE_KEY, JSON.stringify(kept));
}

async function notify(message: string): Promise<void> {
  try {
    // Asked only with the app in front: a question out of nowhere from the
    // background is one nobody sees.
    if (AppState.currentState === 'active') await askNotificationPermission();
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: tg('Weekly report'),
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    await Notifications.scheduleNotificationAsync({
      content: { title: tg('Weekly report'), body: message, data: { url: STATS_URL } },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
  } catch {
    // Not allowed, or nowhere to show one: the playlist is still made.
  }
}

/**
 * The week's songs into the playlist kept for it, or into a new one when
 * there is none yet or the old one was deleted. Songs the server does not
 * hold (found online through the proxy) are left out: adding one would start
 * a download rather than add it.
 */
async function refreshPlaylist(entry: Kept, since: number): Promise<void> {
  const ids = rankSongs((await queryPlaysBySong(since)).filter((r) => !isOnlineTrackId(r.songId)));
  if (ids.length === 0) return;
  if (entry.playlistId) {
    try {
      await reorderPlaylist(entry.playlistId, ids);
      return;
    } catch {
      // Deleted from the server meanwhile: made again below.
    }
  }
  const id = await createPlaylist(tg('Your week'));
  await reorderPlaylist(id, ids);
  entry.playlistId = id;
}

async function check(): Promise<void> {
  if (running || !useSettings.getState().hydrated || !useSettings.getState().weeklyReport) return;
  const { auth, offline } = useAuthStore.getState();
  if (!auth || offline) return;
  const profile = profileScopeId();
  const now = new Date();
  running = true;
  try {
    const all = await load();
    const entry = (all[profile] ??= {});
    if (!reportDue(now, entry.week ?? null)) return;
    // Marked first: a failure below is not worth a second notification.
    entry.week = weekKey(now);
    save();
    const since = weekStart(now).getTime();
    const stats = await queryStats(since);
    if (stats.total === 0) return;
    await notify(weeklyMessage(stats.totalListenedSec, stats.topArtists[0]?.name || undefined));
    await refreshPlaylist(entry, since).catch(() => {});
    save();
    void queryClient.invalidateQueries({ queryKey: ['playlists'] });
  } catch {
    // The log could not be read: next week, then.
  } finally {
    running = false;
  }
}

/** A tap on the report: the stats, which open on "This week". */
function openStats(response: Notifications.NotificationResponse | null): void {
  if (!response) return;
  const { identifier, content } = response.notification.request;
  if (identifier === handledTap || content.data?.url !== STATS_URL) return;
  handledTap = identifier;
  // Late enough for the screens to be up when the app was launched by it.
  setTimeout(() => void Linking.openURL(STATS_URL).catch(() => {}), 1_000);
}

/** Once, from `bootstrap.ts`. */
export function startWeeklyReport(): void {
  try {
    Notifications.addNotificationResponseReceivedListener(openStats);
    openStats(Notifications.getLastNotificationResponse());
  } catch {
    // No native module (web): no notification to tap.
  }
  everyMs(CHECK_EVERY_MS, () => void check());
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void check();
  });
  useSettings.subscribe((s, prev) => {
    if (s.hydrated && (!prev.hydrated || s.weeklyReport !== prev.weeklyReport)) void check();
  });
}
