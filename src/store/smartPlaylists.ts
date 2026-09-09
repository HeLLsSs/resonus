/**
 * The smart playlists somebody wrote, per profile.
 *
 * Only the rules live here: the songs are worked out when a list is opened
 * (see `lib/smartPlaylists.ts`), so nothing here goes stale when the library
 * changes. Kept per profile because the rules name genres and artists, which
 * are one server's, and a rating rule reads one account's ratings.
 */
import { create } from 'zustand';

import { hashKey } from '@/lib/localLibrary';
import { profileScopeGuard } from '@/lib/profileScope';
import type { SmartPlaylist } from '@/lib/smartPlaylists';
import { getItem, setItem } from '@/lib/storage';
import { profileScopeId } from '@/store/auth';

const KEY = 'resonus.smartPlaylists';
function storeKey(): string {
  return `${KEY}.${hashKey(profileScopeId())}`;
}

const scope = profileScopeGuard();

interface SmartPlaylistsState {
  lists: SmartPlaylist[];
  /** Adds the list, or replaces the one with its id. */
  save: (list: SmartPlaylist) => void;
  remove: (id: string) => void;
  hydrate: () => Promise<void>;
}

export const useSmartPlaylists = create<SmartPlaylistsState>((set, get) => {
  const persist = (lists: SmartPlaylist[]) => {
    set({ lists });
    const key = storeKey();
    if (scope.owns(key)) void setItem(key, JSON.stringify(lists));
  };
  return {
    lists: [],

    save: (list) => {
      const lists = get().lists;
      const at = lists.findIndex((l) => l.id === list.id);
      persist(at === -1 ? [...lists, list] : lists.map((l) => (l.id === list.id ? list : l)));
    },

    remove: (id) => persist(get().lists.filter((l) => l.id !== id)),

    hydrate: async () => {
      const key = storeKey();
      const token = scope.start();
      try {
        const raw = await getItem(key);
        if (!scope.accept(token, key)) return;
        set({ lists: raw ? (JSON.parse(raw) as SmartPlaylist[]) : [] });
      } catch {
        if (scope.accept(token, key)) set({ lists: [] });
      }
    },
  };
});

/** An id no server issued: it only ever names a list on this phone. */
export function newSmartPlaylistId(): string {
  return `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
