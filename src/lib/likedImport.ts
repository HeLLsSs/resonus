/**
 * The YouTube liked songs, filed in the library on their own.
 *
 * With `autoImportLiked` on, and only while the app has a server with the
 * Navifind proxy in front, the account's liked songs are read at most once
 * every six hours and those the library does not have yet are handed to the
 * proxy, as the "add to my library" entry of a song's menu would. Silently:
 * a toast once it is over, and only if the app is in front to show it.
 *
 * The proxy fetches each song it is handed in a process of its own, so twenty
 * at once would be twenty downloads at once. They go a few at a time, the next
 * few once the proxy says it is down to fewer transfers than that. Asking it
 * twice for a song it has is harmless (it answers and does nothing), but each
 * ask still costs it a lookup, so a song already filed under the same name, or
 * handed over in the last week, is not asked for again.
 *
 * The proxy's status is read here directly and not through the shared query
 * that `lib/navifindWatch.ts` listens to: that one announces what lands, and
 * this is meant to be quiet.
 */
import { AppState } from 'react-native';

import * as data from '@/api/data';
import * as api from '@/api/subsonic';
import { tg } from '@/i18n';
import { navifindActive } from '@/lib/navifind';
import { getPlainItem, setPlainItem } from '@/lib/plainStorage';
import { primaryUrl } from '@/lib/serverUrls';
import { useAuthStore } from '@/store/auth';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';

/** How long between two runs. */
export const RUN_EVERY_MS = 6 * 60 * 60 * 1000;
/** The most songs handed over in one run; the rest wait for the next. */
export const MAX_PER_RUN = 20;
/** How long a song handed over is not asked for again, filed or not. */
export const RESEND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** How many liked songs are read, newest first. */
const LIKED_READ = 100;
/** Songs handed over together, and the transfers the proxy is let to have before the next ones. */
const BATCH = 3;
/** How often the proxy is asked whether it has room for the next few. */
const WAIT_STEP_MS = 20_000;
/** Past this, the next few go anyway: a stuck transfer must not stop the run. */
const WAIT_MAX_MS = 5 * 60 * 1000;
/** How often whether a run is due is checked while the app is up. */
const CHECK_EVERY_MS = 15 * 60 * 1000;
/** Kept out of the app's first seconds, which have enough to do. */
const FIRST_CHECK_MS = 60_000;
const STORAGE_KEY = 'liked-import';

/** What is remembered, per profile: the last run, and when each song was handed over. */
interface Memory {
  lastRun: number;
  sent: Record<string, number>;
}

/**
 * The name the proxy gives a song's file, `Artist - Title` with what a file
 * name cannot hold replaced, lower-cased to compare. Mirrors `safe()` and
 * `finalBasename()` in navifind's `LibraryDownloader`.
 */
export function fileKey(artist: string | undefined, title: string): string {
  return `${artist || 'Inconnu'} - ${title}`.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').toLowerCase();
}

/**
 * Which of the liked songs to hand to the proxy now: YouTube ones, not filed
 * under the same name, not handed over within `RESEND_AFTER_MS`, each once, in
 * the order YouTube gave them (newest first), and at most `max`.
 */
export function likedToSend(
  liked: readonly Pick<api.Song, 'id' | 'artist' | 'title'>[],
  filed: readonly string[],
  sent: Readonly<Record<string, number>>,
  now: number,
  max = MAX_PER_RUN,
): string[] {
  const filedKeys = new Set(filed.map((name) => name.toLowerCase()));
  const picked = new Set<string>();
  for (const song of liked) {
    if (picked.size >= max) break;
    if (!song.id.startsWith('yt_') || picked.has(song.id)) continue;
    if (now - (sent[song.id] ?? -Infinity) < RESEND_AFTER_MS) continue;
    if (filedKeys.has(fileKey(song.artist, song.title))) continue;
    picked.add(song.id);
  }
  return [...picked];
}

/** Drops what was handed over long enough ago to be asked for again. */
export function pruneSent(sent: Readonly<Record<string, number>>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(sent).filter(([, at]) => now - at < RESEND_AFTER_MS));
}

let running = false;

/** The profile to run for, or null when this is not the moment. */
function ready(): { auth: api.SubsonicAuth; profile: string } | null {
  const { auth, offline, hydrating } = useAuthStore.getState();
  const settings = useSettings.getState();
  if (!auth || offline || hydrating || !settings.hydrated || !navifindActive() || !settings.autoImportLiked) return null;
  return { auth, profile: `${primaryUrl(auth)}|${auth.username}` };
}

async function readMemory(): Promise<Record<string, Memory>> {
  try {
    const parsed: unknown = JSON.parse((await getPlainItem(STORAGE_KEY)) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Memory>) : {};
  } catch {
    return {};
  }
}

async function remember(profile: string, memory: Memory): Promise<void> {
  const all = await readMemory();
  all[profile] = memory;
  await setPlainItem(STORAGE_KEY, JSON.stringify(all)).catch(() => {});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Until the proxy has fewer than `BATCH` transfers under way, or long enough. */
async function waitForRoom(auth: api.SubsonicAuth, profile: string): Promise<void> {
  const until = Date.now() + WAIT_MAX_MS;
  while (Date.now() < until) {
    await sleep(WAIT_STEP_MS);
    if (ready()?.profile !== profile) return;
    const status = await api.navifindStatus(auth).catch(() => null);
    if (!status || status.inProgress < BATCH) return;
  }
}

async function run(): Promise<void> {
  const start = ready();
  if (running || !start) return;
  const { auth, profile } = start;
  const now = Date.now();
  const memory = (await readMemory())[profile] ?? { lastRun: 0, sent: {} };
  if (now - memory.lastRun < RUN_EVERY_MS) return;
  running = true;
  try {
    // Written before the network is asked: a run that fails (no YouTube
    // account, a proxy that does not answer) waits as long as one that worked.
    const sent = pruneSent(memory.sent, now);
    await remember(profile, { lastRun: now, sent });
    const [liked, status] = await Promise.all([
      data.youtubeLikedSongs(LIKED_READ),
      api.navifindStatus(auth).catch(() => null),
    ]);
    const ids = likedToSend(liked, status?.done ?? [], sent, now);
    let handed = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      if (i > 0) await waitForRoom(auth, profile);
      // Turned off, signed out or another profile since: what is left stays.
      if (ready()?.profile !== profile) break;
      const batch = ids.slice(i, i + BATCH);
      const answers = await Promise.allSettled(batch.map((id) => api.addOnlineTrackToLibrary(auth, id)));
      answers.forEach((answer, j) => {
        if (answer.status !== 'fulfilled') return;
        sent[batch[j]] = Date.now();
        handed++;
      });
      await remember(profile, { lastRun: now, sent });
    }
    if (handed > 0 && AppState.currentState === 'active') {
      useToast
        .getState()
        .show(
          handed === 1
            ? tg('1 liked song sent to Navifind for the library')
            : tg('{n} liked songs sent to Navifind for the library', { n: handed }),
        );
    }
  } catch {
    // No YouTube account, or no answer: the next run, six hours on, tries again.
  } finally {
    running = false;
  }
}

/** Once, at app start: checks now and then whether a run is due, and runs it. */
export function startLikedImport(): void {
  const check = () => void run();
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
  AppState.addEventListener('change', (state) => {
    if (state === 'active') check();
  });
  // Turned on, or the settings of a profile just read in: no need to wait for the next check.
  useSettings.subscribe((s, prev) => {
    if (s.hydrated && s.autoImportLiked && (!prev.hydrated || !prev.autoImportLiked)) check();
  });
}
