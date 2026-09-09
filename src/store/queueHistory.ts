/**
 * The last queues, per profile.
 *
 * Starting an album throws away whatever was playing, and what was playing is
 * sometimes an hour of songs picked one by one that nobody wants to pick
 * again. So the queue being replaced is kept, as ids and a title, and can be
 * brought back from the queue screen (Finamp calls these past queues). Only a
 * replacement counts: adding to the queue or moving things around is the same
 * queue, and a queue of one song is not worth a row.
 *
 * Per profile because song ids are one server's. Stored under
 * `resonus.queueHistory.<profile hash>`, read on first use rather than on
 * startup: nothing needs it until a queue is replaced or the list is opened.
 */
import { create } from 'zustand';

import type { Song } from '@/api/data';
import { tg } from '@/i18n';
import { hashKey } from '@/lib/localLibrary';
import { profileScopeGuard } from '@/lib/profileScope';
import { getItem, setItem } from '@/lib/storage';
import { profileScopeId } from '@/store/auth';
import { useSettings } from '@/store/settings';

export interface PastQueue {
  id: string;
  /** When it was replaced (ms since 1970). */
  at: number;
  /** The album, playlist or mix it came from, or the day it was put away. */
  title: string;
  songIds: string[];
  /** Where the cursor was, so it plays on from there. */
  index: number;
}

const KEY = 'resonus.queueHistory';
function storeKey(): string {
  return `${KEY}.${hashKey(profileScopeId())}`;
}

/** Enough to find last week's queue in, few enough to still be a list. */
export const MAX_PAST_QUEUES = 10;
/** Where a snapshot stops: a queue longer than this is a library, not a queue. */
export const MAX_QUEUE_SONGS = 500;

const scope = profileScopeGuard();

interface QueueHistoryState {
  queues: PastQueue[];
  /** Keeps the queue being replaced. `sourceName` is what it was started from,
   *  if the player knows; without one it goes by the day. */
  push: (queue: Song[], index: number, sourceName: string | null) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Reads the profile's list if it is not the one in memory. */
  hydrate: () => Promise<void>;
}

export const useQueueHistory = create<QueueHistoryState>((set, get) => {
  const persist = (queues: PastQueue[]) => {
    set({ queues });
    const key = storeKey();
    if (scope.owns(key)) void setItem(key, JSON.stringify(queues));
  };
  // The read in flight and its key. A second caller waits on it rather than
  // starting its own: two reads of one key would make the first a stale one,
  // and whatever was pushed on its back gets wiped when the second lands.
  let hydrating: { key: string; token: number; done: Promise<void> } | null = null;
  return {
    queues: [],

    push: async (queue, index, sourceName) => {
      if (queue.length < 2) return;
      await get().hydrate();
      const songIds = queue.slice(0, MAX_QUEUE_SONGS).map((s) => s.id);
      const at = Date.now();
      const title =
        sourceName ??
        tg('Queue of {date}', {
          date: new Date(at).toLocaleDateString(useSettings.getState().language, {
            day: 'numeric',
            month: 'short',
          }),
        });
      // The same list again (an album started over) moves up rather than
      // filling the ten rows with itself.
      const rest = get().queues.filter((q) => !sameIds(q.songIds, songIds));
      const entry: PastQueue = {
        id: `q_${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        at,
        title,
        songIds,
        index: Math.min(Math.max(index, 0), songIds.length - 1),
      };
      persist([entry, ...rest].slice(0, MAX_PAST_QUEUES));
    },

    remove: async (id) => {
      await get().hydrate();
      persist(get().queues.filter((q) => q.id !== id));
    },

    hydrate: () => {
      const key = storeKey();
      if (scope.owns(key)) return Promise.resolve();
      if (hydrating?.key === key) return hydrating.done;
      const token = scope.start();
      const done = (async () => {
        try {
          const raw = await getItem(key);
          if (!scope.accept(token, key)) return;
          set({ queues: raw ? (JSON.parse(raw) as PastQueue[]) : [] });
        } catch {
          if (scope.accept(token, key)) set({ queues: [] });
        } finally {
          if (hydrating?.token === token) hydrating = null;
        }
      })();
      hydrating = { key, token, done };
      return done;
    },
  };
});

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
