/**
 * Word when one of the two links of Navifind's shared YouTube account drops.
 *
 * The account everybody without their own YouTube account reads is held two
 * ways on the server (see `CommonAccount`): a token for its likes and
 * playlists, and a cookie for its home page. Either can go: the token when
 * Google stops renewing it, the cookie when its session ends. Nothing stops
 * when one does, the other carries on, so nobody would notice; whoever looks
 * after the server should, so this asks the proxy every six hours and posts a
 * notification when a link that worked stops working, and takes it away when
 * it is back. Only on a profile that can do something about it: an
 * administrator of the server, or the account the shared session belongs to.
 *
 * The decision is `commonStep`, which knows nothing of notifications.
 */
import { AppState, Platform } from 'react-native';

import { tg } from '@/i18n';
import { navifindActive } from '@/lib/navifind';
import { getItem, setItem } from '@/lib/storage';
import { everyMs } from '@/lib/ticker';
import type { CommonAccount } from '@/lib/youtube';
import { useAuthStore } from '@/store/auth';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';

/** Which links have been seen working, and which have been reported down. */
export interface CommonMemory {
  token: 'ok' | 'down' | null;
  cookie: 'ok' | 'down' | null;
}

export interface CommonStep {
  next: CommonMemory;
  /** The links to report as down, in this order. */
  report: ('token' | 'cookie')[];
  /** Every reported link is working again: take the notification away. */
  dismiss: boolean;
}

/**
 * What to say given what was said last and what the proxy says now. A link
 * is reported when it is broken and was not already: `refused` for the token,
 * `expired` for the cookie. One that was never set up (`none`, `off`), or a
 * proxy that could not tell (`unreachable`), changes nothing.
 */
export function commonStep(prev: CommonMemory, now: CommonAccount): CommonStep {
  const verdict = (link: 'token' | 'cookie'): 'ok' | 'down' | null => {
    const state = now[link];
    if (state === 'ok') return 'ok';
    if (state === 'refused' || state === 'expired') return 'down';
    return null;
  };
  const next: CommonMemory = { token: verdict('token') ?? prev.token, cookie: verdict('cookie') ?? prev.cookie };
  const report = (['token', 'cookie'] as const).filter((link) => next[link] === 'down' && prev[link] !== 'down');
  const wasDown = prev.token === 'down' || prev.cookie === 'down';
  const isDown = next.token === 'down' || next.cookie === 'down';
  return { next, report: [...report], dismiss: wasDown && !isDown };
}

const EVERY_MS = 6 * 60 * 60 * 1000;
const STATE_KEY = 'resonus.youtubeCommon';
const NOTIFICATION_ID = 'youtube-common';
const CHANNEL_ID = 'navifind';

function profile(): string | null {
  const { auth, offline } = useAuthStore.getState();
  return auth && !offline ? `${auth.serverUrl}|${auth.username}` : null;
}

async function remembered(who: string): Promise<CommonMemory> {
  try {
    const kept = JSON.parse((await getItem(STATE_KEY)) ?? 'null') as ({ who?: string } & CommonMemory) | null;
    return kept?.who === who ? { token: kept.token ?? null, cookie: kept.cookie ?? null } : { token: null, cookie: null };
  } catch {
    return { token: null, cookie: null };
  }
}

async function post(title: string, body: string): Promise<void> {
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
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: { title, body },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
  } catch {
    // Not allowed, or nowhere to show one: Settings › Navifind › YouTube says.
  }
}

async function dismiss(): Promise<void> {
  try {
    const Notifications = await import('expo-notifications');
    await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
  } catch {
    // Nothing shown.
  }
}

/** What to tell whoever looks after the server, for one broken link. */
export function commonAlertText(link: 'token' | 'cookie', user: string | undefined): { title: string; body: string } {
  return link === 'token'
    ? {
        title: tg("The shared YouTube account's authorization was withdrawn"),
        body: tg('Run bin/youtube-oauth.php on the server again to give its likes and playlists back.'),
      }
    : {
        title: tg("The shared YouTube account's session has expired"),
        body: tg('Its home page is a stranger’s until you sign in to YouTube again with the {user} profile.', {
          user: user ?? 'proxy',
        }),
      };
}

let checking = false;
let allowed: { who: string; yes: boolean } | null = null;

async function check(): Promise<void> {
  const who = profile();
  const { auth } = useAuthStore.getState();
  if (!who || !auth || checking || !navifindActive() || !useSettings.getState().youtubeOutageAlert) return;
  checking = true;
  try {
    const { youtubeCommonAccount, isServerAdmin } = await import('@/api/subsonic');
    const common = await youtubeCommonAccount(auth);
    if (allowed?.who !== who) allowed = { who, yes: common.user === auth.username || (await isServerAdmin(auth)) };
    if (!allowed.yes) return;
    const step = commonStep(await remembered(who), common);
    await setItem(STATE_KEY, JSON.stringify({ who, ...step.next })).catch(() => {});
    if (step.dismiss) await dismiss();
    for (const link of step.report) {
      const { title, body } = commonAlertText(link, common.user);
      await post(title, body);
    }
  } catch {
    // A proxy that does not answer, or too old for the route: the next check asks again.
  } finally {
    checking = false;
  }
}

let started = false;

/** Once, at app start: then every six hours, and when the profile changes. */
export function startCommonAccountAlert(): void {
  if (started) return;
  started = true;
  everyMs(EVERY_MS, () => void check());
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
