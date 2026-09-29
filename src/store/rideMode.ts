/**
 * Ride mode: what it has been told and whether it is on.
 *
 * The configuration is the phone's rather than the profile's, the way the
 * Home Assistant one is: the helmet is the same whichever server is signed
 * in. It lives in the native module's own preferences, since the receiver
 * that hears the intercom connect reads it there with no JS running (see
 * `RideConfig.kt` in modules/ride-mode); this store is the copy in memory,
 * read from there at start and written back on every change.
 *
 * `active` is turned on and off by `src/lib/rideSync.ts`, which is what
 * starting and stopping ride mode means.
 */
import { create } from 'zustand';

import { getRideConfig, NO_RIDE_CONFIG, setRideConfig, type RideConfig } from '@/lib/rideMode';

interface RideModeState {
  config: RideConfig;
  /** Whether ride mode is on: the overlay up, songs announced, the music ducking. */
  active: boolean;
  /** Reads the configuration the native side holds. Once, at start. */
  hydrate: () => void;
  setConfig: (patch: Partial<RideConfig>) => void;
}

export const useRideMode = create<RideModeState>((set, get) => ({
  config: NO_RIDE_CONFIG,
  active: false,

  hydrate: () => set({ config: getRideConfig() }),

  setConfig: (patch) => {
    const config = { ...get().config, ...patch };
    set({ config });
    setRideConfig(config);
  },
}));
