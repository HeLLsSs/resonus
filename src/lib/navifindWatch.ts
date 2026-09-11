/**
 * Word from the proxy when it has finished fetching.
 *
 * An import or an "add to my library" hands the proxy work that takes a
 * while, and nothing came back to say when it was over: the Navifind screen
 * shows a count while it is open, and that was all. This watches the proxy's
 * status on behalf of the whole app and says so once the count of transfers
 * under way falls back to zero: a toast when the app is in front, a
 * notification when the answer arrives after the app has been left, which
 * opens the Navifind screen when tapped.
 *
 * Asked every twenty seconds and only while there is something to wait for:
 * from the moment work is handed over until the proxy is idle again, and again
 * on coming back to the foreground when the last answer had transfers under
 * way. Never in the background and never while idle, which is the same rule
 * as the "playing elsewhere" card (see `PlayingElsewhereCard`). The screen's
 * own five-second polling shares the query, so whichever of the two asks, the
 * answer passes through here.
 */
import * as Notifications from 'expo-notifications';
import { AppState, Linking, Platform } from 'react-native';

import { navifindStatus, type NavifindStatus } from '@/api/subsonic';
import { tg } from '@/i18n';
import { navifindActive } from '@/lib/navifind';
import { queryClient } from '@/lib/query';
import { useAuthStore } from '@/store/auth';
import { useToast } from '@/store/toast';

/** The proxy's status, one query for the screen that shows it and for this. */
export const NAVIFIND_STATUS_KEY = ['navifind', 'status'] as const;

/** How often the proxy is asked while something is under way. */
const POLL_MS = 20_000;
/**
 * How long, after work is handed over, an idle answer is taken as "not started
 * yet" rather than "nothing came of it". A playlist import enumerates its
 * links before the first transfer begins, and that can take a while.
 */
const GRACE_MS = 90_000;
/**
 * The session is restored on one render and the screens behind it mount on
 * the next; a link opened between the two is dropped by the router.
 */
const MOUNT_DELAY_MS = 500;
const CHANNEL_ID = 'navifind';
const SCREEN_URL = 'resonuls://settings/navifind';
/** The search results that carry the online badges. */
const SEARCH_KEYS = [['search'], ['searchSongs'], ['searchAlbums']] as const;

let timer: ReturnType<typeof setInterval> | null = null;
/** The last answer, for the one before it when an answer comes in. */
let last: NavifindStatus | null = null;
/**
 * The files the library had when the work under watch began, to count what
 * landed since. Null while nothing is being waited for.
 */
let before: Set<string> | null = null;
/** Whether a transfer has actually been seen under way since `before`. */
let sawProgress = false;
/** Until when an idle answer is still "not started yet" (see `GRACE_MS`). */
let graceUntil = 0;
/** The tap already acted on, in case it is reported twice (see `openScreen`). */
let handledTap = '';

function isStatus(data: unknown): data is NavifindStatus {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { done?: unknown }).done) &&
    typeof (data as { inProgress?: unknown }).inProgress === 'number'
  );
}

/** One request, through the shared query so every observer sees the answer. */
async function ask(): Promise<void> {
  const { auth, offline } = useAuthStore.getState();
  if (!navifindActive() || !auth || offline) {
    stopPolling();
    return;
  }
  try {
    await queryClient.fetchQuery({
      queryKey: NAVIFIND_STATUS_KEY,
      queryFn: () => navifindStatus(auth),
      staleTime: 0,
      retry: false,
    });
  } catch {
    // A proxy that does not answer has not finished; the next tick asks again.
  }
}

function startPolling(): void {
  if (timer) return;
  timer = setInterval(() => void ask(), POLL_MS);
  void ask();
}

function stopPolling(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** What the answers say, whoever asked for them. */
function observe(next: NavifindStatus): void {
  const prev = last;
  last = next;
  // The first answer after work was handed over with nothing known before it:
  // the count starts from here.
  if (before === null && Date.now() < graceUntil) before = new Set(next.done);

  if (next.inProgress > 0) {
    // Under way, whether asked for from here or from another client: what was
    // there when it was first seen is the point to count from.
    before ??= new Set((prev ?? next).done);
    sawProgress = true;
    if (AppState.currentState === 'active') startPolling();
    return;
  }

  if (before === null) {
    stopPolling();
    return;
  }
  const fresh = next.done.filter((name) => !before?.has(name)).length;
  // Idle, nothing new, and the proxy was given work a moment ago: it has not
  // picked it up yet.
  if (!sawProgress && fresh === 0 && Date.now() < graceUntil) return;

  before = null;
  sawProgress = false;
  graceUntil = 0;
  stopPolling();
  announce(fresh);
  for (const queryKey of SEARCH_KEYS) void queryClient.invalidateQueries({ queryKey });
  void queryClient.invalidateQueries({ queryKey: NAVIFIND_STATUS_KEY });
}

function announce(fresh: number): void {
  const message =
    fresh === 0
      ? tg('Nothing new in the library')
      : fresh === 1
        ? tg('1 track is in the library now')
        : tg('{n} tracks are in the library now', { n: fresh });
  if (AppState.currentState === 'active') {
    useToast.getState().show(message);
    return;
  }
  void notify(message);
}

async function notify(message: string): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Navifind',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    await Notifications.scheduleNotificationAsync({
      content: { title: 'Navifind', body: message, data: { url: SCREEN_URL } },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
  } catch {
    // Not allowed, or nowhere to show one: the screen still has the count.
  }
}

/** Resolves once the session is restored and the screens behind it are up. */
function whenScreensMounted(): Promise<void> {
  return new Promise((resolve) => {
    const settle = () => setTimeout(resolve, MOUNT_DELAY_MS);
    if (!useAuthStore.getState().hydrating) {
      settle();
      return;
    }
    const unsub = useAuthStore.subscribe((s) => {
      if (s.hydrating) return;
      unsub();
      settle();
    });
  });
}

/**
 * A tap on the notification. Android reports the one that launched the app
 * both to the listener and as the last response, hence the identifier.
 */
function openScreen(response: Notifications.NotificationResponse | null): void {
  if (!response) return;
  const { identifier, content } = response.notification.request;
  if (identifier === handledTap || content.data?.url !== SCREEN_URL) return;
  handledTap = identifier;
  void whenScreensMounted().then(() => Linking.openURL(SCREEN_URL));
}

/**
 * Work has been handed to the proxy: watch until it is idle again. `queued`
 * is what the proxy answered when it was asked; nothing to fetch, or a
 * refusal, is nothing to wait for.
 */
export function navifindWorkStarted(queued?: Promise<number>): void {
  const known = queryClient.getQueryData(NAVIFIND_STATUS_KEY);
  before ??= isStatus(known) ? new Set(known.done) : null;
  graceUntil = Date.now() + GRACE_MS;
  startPolling();
  const standDown = () => {
    if (sawProgress) return;
    before = null;
    graceUntil = 0;
    stopPolling();
  };
  void queued?.then((n) => {
    if (n === 0) standDown();
  }, standDown);
}

/**
 * The permission to notify, asked for the first time an import is started
 * from the Navifind screen: that is when a notification has a reason, and a
 * question at app start would have none. Granted on its own before Android
 * 13; answered once and remembered after.
 */
export async function askNotificationPermission(): Promise<void> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted || !current.canAskAgain) return;
    await Notifications.requestPermissionsAsync();
  } catch {
    // Nowhere to ask (web): nothing to notify with either.
  }
}

/** Once, at app start. Everything here waits for work before it does anything. */
export function startNavifindWatch(): void {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    Notifications.addNotificationResponseReceivedListener(openScreen);
    openScreen(Notifications.getLastNotificationResponse());
  } catch {
    // No native module (web): no notification could have been tapped.
  }

  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const [scope, what] = event.query.queryKey;
    if (scope !== NAVIFIND_STATUS_KEY[0] || what !== NAVIFIND_STATUS_KEY[1]) return;
    if (isStatus(event.action.data)) observe(event.action.data);
  });

  // Back in front with transfers under way when last heard: ask again. Left
  // behind: stop asking, whatever the proxy is up to.
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') {
      stopPolling();
      return;
    }
    if (before !== null || (last?.inProgress ?? 0) > 0) startPolling();
  });
}
