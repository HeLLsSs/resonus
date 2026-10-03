/**
 * Online tracks that would not play, remembered for a week.
 *
 * A YouTube or SoundCloud track fails for a reason of its own when its video
 * has been taken down, is blocked where the phone is, or answers a 403 or a
 * 404. That is not the proxy being down (`serverUnreached`, which has its own
 * rule in `lib/playbackRetry`): it is the track, and it will answer the same
 * tomorrow. Left alone it came round on every shuffle and every mix, got its
 * two goes each time, and left a hole and a toast where a song should have
 * been. So the id is written down here when the player gives up on it, and
 * the places that deal online tracks without anybody choosing one (the
 * shuffles, the mixes) leave it out. A track somebody taps is never left out,
 * and when it does play, it is forgiven.
 *
 * A week, not for ever: a video blocked in one country plays from the next,
 * a proxy bug is fixed, and an id this old is not worth a file of its own.
 * The ids are the services' own, the same under every profile, so one list
 * for the phone.
 */
import { create } from 'zustand';

import { getPlainItem, setPlainItem } from '@/lib/plainStorage';

/** How long a track stays left out after the player gave up on it. */
export const UNPLAYABLE_DAYS = 7;

const KEY = 'resonus.unplayable';

/** Track id → when it stops being left out, in ms since the epoch. */
export type UnplayableEntries = Record<string, number>;

/** When a track marked at `now` stops being left out. */
export function expiry(now: number): number {
  return now + UNPLAYABLE_DAYS * 24 * 60 * 60 * 1000;
}

/** The entries still worth keeping at `now`: the same object when none has
 *  run out, so a store that compares by reference is not told of a change. */
export function prune(entries: UnplayableEntries, now: number): UnplayableEntries {
  const live = Object.entries(entries).filter(([, expiresAt]) => expiresAt > now);
  return live.length === Object.keys(entries).length ? entries : Object.fromEntries(live);
}

interface UnplayableState {
  entries: UnplayableEntries;
  /** The player gave up on this track for a reason of the track's own. */
  markUnplayable: (id: string) => void;
  /** Whether the shuffles and mixes should leave this track out today. */
  isUnplayable: (id: string) => boolean;
  /** The track played after all, or somebody wants it back in. */
  forget: (id: string) => void;
  hydrate: () => Promise<void>;
}

export const useUnplayable = create<UnplayableState>((set, get) => ({
  entries: {},

  markUnplayable: (id) => {
    const now = Date.now();
    const entries = { ...prune(get().entries, now), [id]: expiry(now) };
    set({ entries });
    void setPlainItem(KEY, JSON.stringify(entries));
  },

  isUnplayable: (id) => (get().entries[id] ?? 0) > Date.now(),

  forget: (id) => {
    if (!(id in get().entries)) return;
    const { [id]: _gone, ...entries } = get().entries;
    set({ entries });
    void setPlainItem(KEY, JSON.stringify(entries));
  },

  hydrate: async () => {
    try {
      const raw = await getPlainItem(KEY);
      const saved = raw ? (JSON.parse(raw) as UnplayableEntries) : {};
      const entries = prune(saved, Date.now());
      set({ entries });
      if (entries !== saved) void setPlainItem(KEY, JSON.stringify(entries));
    } catch {
      // An unreadable file is a list that starts over: the next failure
      // writes a fresh one.
      set({ entries: {} });
    }
  },
}));

/** `songs` without the ones the player gave up on this week. For the places
 *  that deal online tracks nobody chose; a track that was tapped is played
 *  as asked. */
export function withoutUnplayable<T extends { id: string }>(songs: T[]): T[] {
  const { entries } = useUnplayable.getState();
  const now = Date.now();
  return songs.filter((song) => (entries[song.id] ?? 0) <= now);
}
