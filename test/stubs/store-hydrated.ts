/**
 * The stores a restore asks to read their key again (`@/store/pins`,
 * `@/store/equalizer`, ...). They only need a `hydrate`, and a count of how
 * often it was called.
 */
import { create } from 'zustand';

interface Hydrated {
  hydrations: number;
  hydrate: () => Promise<void>;
}

function hydratedStore() {
  return create<Hydrated>((set) => ({
    hydrations: 0,
    hydrate: async () => set((s) => ({ hydrations: s.hydrations + 1 })),
  }));
}

export const useAutoDownloads = hydratedStore();
export const useEqualizer = hydratedStore();
export const usePins = hydratedStore();
export const useSmartPlaylists = hydratedStore();
export const useSortPrefs = hydratedStore();
