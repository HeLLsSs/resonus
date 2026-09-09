/** `@/store/settings`: the language, and a `hydrate` that counts. The types come from the real module. */
import { create } from 'zustand';

export type { LibrarySort } from '../../src/store/settings';

interface SettingsState {
  language: string;
  hydrations: number;
  hydrate: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set) => ({
  language: 'en',
  hydrations: 0,
  hydrate: async () => set((s) => ({ hydrations: s.hydrations + 1 })),
}));
