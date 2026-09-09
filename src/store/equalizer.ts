/**
 * Equalizer (native module modules/audio-eq, Android).
 *
 * Processing is handled by the Android framework; here we only store the state
 * (enabled + per-band gain) and pass it to the native effect. The player calls
 * `attach` with the session id of each AudioPlayer it creates (it uses two
 * alternating ones for crossfade), so the equalizer applies to all.
 *
 * Gains are in millibels (100 mB = 1 dB), which is the unit of
 * android.media.audiofx.Equalizer.
 *
 * The same module carries two boosts on the same sessions: a bass boost
 * (strength 0..1000, as android.media.audiofx.BassBoost counts it) and a volume
 * boost (a gain in millibels, android.media.audiofx.LoudnessEnhancer). Kept and
 * restored here alongside the bands, and attached natively to every session the
 * way the bands are.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { create } from 'zustand';

import { getItem, setItem } from '@/lib/storage';

const KEY = 'resonus.equalizer';

/** A band of the device's equalizer. */
export interface EqBand {
  index: number;
  /** Center frequency in Hz. */
  centerFreq: number;
}

/** Capabilities of the device's equalizer. */
interface EqInfo {
  supported: boolean;
  bands?: EqBand[];
  /** Gain range in millibels. */
  minLevel?: number;
  maxLevel?: number;
  presets?: string[];
  /** The device offers a bass boost. */
  bassBoost?: boolean;
  /** The device offers a volume boost. */
  loudness?: boolean;
}

interface NativeAudioEq {
  getInfo: () => EqInfo;
  attach: (sessionId: number) => void;
  detach: (sessionId: number) => void;
  setEnabled: (on: boolean) => void;
  setBandLevels: (millibels: number[]) => void;
  setBandLevel: (band: number, millibels: number) => void;
  usePreset: (preset: number) => number[];
  getBandLevels: () => number[];
  setBassBoost: (strength: number) => void;
  getBassBoost: () => number;
  setLoudness: (gainMb: number) => void;
  getLoudness: () => number;
}

/** The framework's own top for the bass boost strength. */
export const BASS_BOOST_MAX = 1000;
/**
 * The top offered for the volume boost, in millibels. The effect goes to 1500,
 * but past +10 dB nearly everything clips, so the slider stops there.
 */
export const LOUDNESS_MAX_MB = 1000;

// Optional: in a build without the module (or iOS) there is simply no equalizer.
const native = requireOptionalNativeModule<NativeAudioEq>('AudioEq');

interface Stored {
  enabled: boolean;
  levels: number[];
  bassBoost?: number;
  loudness?: number;
}

interface EqState {
  /** The device exposes an equalizer and the module is present. */
  supported: boolean;
  bands: EqBand[];
  minLevel: number;
  maxLevel: number;
  presets: string[];
  enabled: boolean;
  /** Per-band gain in millibels. */
  levels: number[];
  bassBoostSupported: boolean;
  loudnessSupported: boolean;
  /** Bass boost strength, 0 (off) to `BASS_BOOST_MAX`. */
  bassBoost: number;
  /** Volume boost in millibels, 0 (off) to `LOUDNESS_MAX_MB`. */
  loudness: number;
  hydrate: () => Promise<void>;
  /** Attaches the equalizer to a player's audio session (called by the player). */
  attach: (sessionId: number) => void;
  detach: (sessionId: number) => void;
  setEnabled: (on: boolean) => void;
  setBandLevel: (band: number, millibels: number) => void;
  /** Applies a device preset (not named `usePreset` so it doesn't look like a
   *  React hook). */
  applyPreset: (preset: number) => void;
  /** Resets all bands to 0 dB. */
  reset: () => void;
  setBassBoost: (strength: number) => void;
  setLoudness: (gainMb: number) => void;
}

function persist(s: Pick<EqState, 'enabled' | 'levels' | 'bassBoost' | 'loudness'>) {
  const data: Stored = {
    enabled: s.enabled,
    levels: s.levels,
    bassBoost: s.bassBoost,
    loudness: s.loudness,
  };
  void setItem(KEY, JSON.stringify(data));
}

/** A whole number inside `[0, max]`, whatever the disk or a finger handed over. */
function clampBoost(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(0, Math.round(value)))
    : 0;
}

export const useEqualizer = create<EqState>((set, get) => ({
  supported: false,
  bands: [],
  minLevel: -1500,
  maxLevel: 1500,
  presets: [],
  enabled: false,
  levels: [],
  bassBoostSupported: false,
  loudnessSupported: false,
  bassBoost: 0,
  loudness: 0,

  hydrate: async () => {
    if (!native) return;
    const info = native.getInfo();
    if (!info.supported || !info.bands?.length) {
      set({ supported: false });
      return;
    }
    // Saved state; if it doesn't match the device's bands, it's ignored.
    let stored: Stored | null = null;
    try {
      const raw = await getItem(KEY);
      if (raw) stored = JSON.parse(raw) as Stored;
    } catch {
      // no previous data
    }
    const flat = info.bands.map(() => 0);
    const levels =
      stored && Array.isArray(stored.levels) && stored.levels.length === info.bands.length
        ? stored.levels
        : flat;
    const enabled = !!stored?.enabled;
    const bassBoost = info.bassBoost ? clampBoost(stored?.bassBoost, BASS_BOOST_MAX) : 0;
    const loudness = info.loudness ? clampBoost(stored?.loudness, LOUDNESS_MAX_MB) : 0;
    set({
      supported: true,
      bands: info.bands,
      minLevel: info.minLevel ?? -1500,
      maxLevel: info.maxLevel ?? 1500,
      presets: info.presets ?? [],
      enabled,
      levels,
      bassBoostSupported: !!info.bassBoost,
      loudnessSupported: !!info.loudness,
      bassBoost,
      loudness,
    });
    // Dumps saved state to the native effect (already attached sessions, if any,
    // pick it up; future ones receive it on attach).
    native.setBandLevels(levels);
    native.setEnabled(enabled);
    native.setBassBoost(bassBoost);
    native.setLoudness(loudness);
  },

  attach: (sessionId) => {
    if (!native || !get().supported) return;
    native.attach(sessionId);
  },

  detach: (sessionId) => {
    if (!native) return;
    native.detach(sessionId);
  },

  setEnabled: (on) => {
    if (!native) return;
    native.setEnabled(on);
    set({ enabled: on });
    persist(get());
  },

  setBandLevel: (band, millibels) => {
    if (!native) return;
    native.setBandLevel(band, millibels);
    const levels = get().levels.slice();
    levels[band] = millibels;
    set({ levels });
    persist(get());
  },

  applyPreset: (preset) => {
    if (!native) return;
    // The system applies the preset: it returns the resulting gains so the
    // sliders show what's actually set.
    const levels = native.usePreset(preset);
    set({ levels });
    persist(get());
  },

  reset: () => {
    if (!native) return;
    const levels = get().bands.map(() => 0);
    native.setBandLevels(levels);
    set({ levels });
    persist(get());
  },

  setBassBoost: (strength) => {
    if (!native) return;
    native.setBassBoost(clampBoost(strength, BASS_BOOST_MAX));
    // What the effect rounded it to, so the slider shows what is actually set.
    set({ bassBoost: native.getBassBoost() });
    persist(get());
  },

  setLoudness: (gainMb) => {
    if (!native) return;
    native.setLoudness(clampBoost(gainMb, LOUDNESS_MAX_MB));
    set({ loudness: native.getLoudness() });
    persist(get());
  },
}));
