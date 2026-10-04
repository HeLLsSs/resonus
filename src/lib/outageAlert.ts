/**
 * Word when YouTube can no longer be reached through the Navifind proxy, and
 * again when it can.
 *
 * The proxy reaches YouTube three ways: Invidious, Piped and yt-dlp on its own
 * machine. Any one of them is enough, so YouTube is only out when all three
 * are: Invidious and Piped each failing or not set up, and yt-dlp failing. The
 * proxy notes this down as its searches and streams run into it, and its
 * `sources` route says what it has noted (without asking the sources again,
 * which the Settings screen's "Check now" is for). This reads that every half
 * hour while the profile is online with Navifind on, and posts one
 * notification when YouTube goes out and one when it comes back. Never again
 * while nothing changes, across restarts too: what was said last is kept.
 *
 * The decision is `outageStep`, which knows nothing of notifications.
 */
import { AppState, Platform } from 'react-native';

import type { NavifindSources, SourceHealth } from '@/api/subsonic';
import { tg } from '@/i18n';
import { navifindActive } from '@/lib/navifind';
import { getItem, setItem } from '@/lib/storage';
import { everyMs } from '@/lib/ticker';
import { useAuthStore } from '@/store/auth';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';

/** What the three paths add up to. `unknown` while the proxy has not noted
 *  enough to say: nothing is decided from that. */
export type YoutubeVerdict = 'up' | 'down' | 'unknown';

/** What was said last: out, back, or nothing yet. */
export type OutageState = 'up' | 'down' | null;

type YoutubePaths = Pick<NavifindSources, 'invidious' | 'piped' | 'ytdlp'>;

const gone = (s: SourceHealth) => s.state === 'down' || s.state === 'off';

/** Whether YouTube can be reached through the proxy, by what it has noted. */
export function youtubeVerdict({ invidious, piped, ytdlp }: YoutubePaths): YoutubeVerdict {
  if (gone(invidious) && gone(piped) && ytdlp.state === 'down') return 'down';
  if ([invidious, piped, ytdlp].some((s) => s.state === 'ok')) return 'up';
  return 'unknown';
}

export interface OutageStep {
  next: OutageState;
  /** The notification to post, if any. */
  notify: 'down' | 'up' | null;
  /** Take the outage notification away without a word. */
  dismiss: boolean;
}

/**
 * What to say given what was said last and what the proxy says now.
 *
 * `byHand` is a check somebody ran from the Settings screen: they are looking
 * at the answer, so YouTube coming back clears the outage notification rather
 * than posting another one.
 */
export function outageStep(prev: OutageState, verdict: YoutubeVerdict, byHand = false): OutageStep {
  if (verdict === 'unknown' || verdict === prev) return { next: prev, notify: null, dismiss: false };
  if (verdict === 'down') return { next: 'down', notify: 'down', dismiss: false };
  if (prev !== 'down') return { next: 'up', notify: null, dismiss: false };
  return byHand ? { next: 'up', notify: null, dismiss: true } : { next: 'up', notify: 'up', dismiss: false };
}

/** Why YouTube is out, one path after the other, in the reader's language. */
export function outageReason({ invidious, piped, ytdlp }: YoutubePaths, t: (text: string) => string): string {
  const mirror = (s: SourceHealth) => (s.state === 'off' ? t('Not configured') : t('Not answering'));
  const tool = ytdlp.deno ? t('Does not run') : t('deno is missing, so YouTube cannot be read');
  return `Invidious: ${mirror(invidious)} · Piped: ${mirror(piped)} · yt-dlp: ${tool}`;
}

/** How often the proxy is asked. */
const EVERY_MS = 30 * 60 * 1000;
const STATE_KEY = 'resonus.youtubeOutage';
const NOTIFICATION_ID = 'youtube-outage';
const CHANNEL_ID = 'navifind';

/** Whose proxy the kept state is about: another account is another proxy. */
function profile(): string | null {
  const { auth, offline } = useAuthStore.getState();
  return auth && !offline ? `${auth.serverUrl}|${auth.username}` : null;
}

async function said(who: string): Promise<OutageState> {
  try {
    const kept = JSON.parse((await getItem(STATE_KEY)) ?? 'null') as { who?: string; state?: OutageState } | null;
    return kept?.who === who ? (kept.state ?? null) : null;
  } catch {
    return null;
  }
}

async function post(title: string, body: string): Promise<void> {
  // No notifications in a browser: a toast while the page is in front.
  if (Platform.OS === 'web') {
    if (AppState.currentState === 'active') useToast.getState().show(`${title}. ${body}`);
    return;
  }
  try {
    const Notifications = await import('expo-notifications');
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Navifind',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    // The same identifier for both, so "back" takes the place of "out".
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: { title, body },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
  } catch {
    // Not allowed, or nowhere to show one: the Settings screen still says.
  }
}

async function dismiss(): Promise<void> {
  try {
    const Notifications = await import('expo-notifications');
    await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
  } catch {
    // Nothing shown, or nowhere to show it.
  }
}

/** One answer from the proxy, acted on. */
async function observe(who: string, sources: NavifindSources, byHand: boolean): Promise<void> {
  const step = outageStep(await said(who), youtubeVerdict(sources), byHand);
  if (step.next === null) return;
  await setItem(STATE_KEY, JSON.stringify({ who, state: step.next })).catch(() => {});
  if (step.dismiss) await dismiss();
  if (!useSettings.getState().youtubeOutageAlert) return;
  if (step.notify === 'down') await post(tg('YouTube is unreachable through Navifind'), outageReason(sources, tg));
  if (step.notify === 'up') {
    await post(tg('YouTube is back through Navifind'), tg('Online tracks can be found and played again.'));
  }
}

let checking = false;

async function check(): Promise<void> {
  const who = profile();
  const { auth } = useAuthStore.getState();
  if (!who || !auth || checking || !navifindActive() || !useSettings.getState().youtubeOutageAlert) return;
  checking = true;
  try {
    // Imported here rather than at the top so the decision above loads in a
    // test without the whole API client.
    const { navifindSources } = await import('@/api/subsonic');
    await observe(who, await navifindSources(auth), false);
  } catch {
    // A proxy that does not answer, or too old to know the route: nothing
    // learnt, and the next half hour asks again.
  } finally {
    checking = false;
  }
}

/** A check run from Settings › Navifind › Sources that the proxy answered. */
export function sourcesCheckedByHand(sources: NavifindSources): void {
  const who = profile();
  if (who) void observe(who, sources, true);
}

let started = false;

/** Once, at app start. Waits for the settings, then every half hour. */
export function startOutageAlert(): void {
  if (started) return;
  started = true;
  everyMs(EVERY_MS, () => void check());
  // Asked once the profile's settings are in, and again when the profile, or
  // Navifind, or the switch changes; the half hour carries on from there.
  let key = '';
  const changed = () => {
    const s = useSettings.getState();
    const next = s.hydrated ? `${profile()}|${s.navifind}|${s.youtubeOutageAlert}` : '';
    if (!next || next === key) return;
    key = next;
    void check();
  };
  changed();
  useSettings.subscribe(changed);
  useAuthStore.subscribe(changed);
}
