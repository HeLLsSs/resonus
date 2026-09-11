/**
 * Waiting on the stores from outside React.
 *
 * What starts the app (`bootstrap`) and what answers the car and the widget
 * are plain functions, with no component to re-render when a store changes,
 * so this is how they wait for one: a promise settled by the state, and no
 * sooner.
 */
import { type StoreApi } from 'zustand';

import { useAuthStore } from '@/store/auth';
import { useDownloads } from '@/store/downloads';
import { useSettings } from '@/store/settings';

/** Resolves when `ready` holds for the store's state, or after `timeoutMs`. */
export function waitFor<T>(store: StoreApi<T>, ready: (state: T) => boolean, timeoutMs?: number): Promise<void> {
  if (ready(store.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = store.subscribe((state) => {
      if (!ready(state)) return;
      if (timer) clearTimeout(timer);
      unsub();
      resolve();
    });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        unsub();
        resolve();
      }, timeoutMs);
    }
  });
}

/**
/**
 * How long each of the three waits below is given. Every one of them settles
 * in a fraction of this in practice, since each store ends its read in a
 * `finally`; the limit is there so that a read stuck on the phone's storage
 * cannot leave a button pressed in a car queued for ever, which is worse
 * than acting on a profile that is not quite finished.
 */
const READY_WAIT_MS = 10_000;

/**
 * Resolves once the session is restored and the profile's settings and
 * downloads are in memory: what a play needs before it can start, the same
 * three things the saved queue waits for (see `bootstrap`). With the app
 * already up it resolves at once.
 *
 * Needed because the car, the widget and another app can now start the
 * runtime themselves, and what they asked for arrives before any of this is
 * back: a tap acted on then would ask a server it has no session for, play a
 * downloaded song from the network, or read the stream format off factory
 * settings.
 */
export async function whenProfileReady(): Promise<void> {
  await waitFor(useAuthStore, (s) => !s.hydrating, READY_WAIT_MS);
  await waitFor(useSettings, (s) => s.hydrated, READY_WAIT_MS);
  await waitFor(useDownloads, (s) => s.hydrated, READY_WAIT_MS);
}
