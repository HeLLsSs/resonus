/**
 * The equaliser.
 *
 * The bands are the app's own, filtered inside the player (native module
 * `modules/audio-dsp`). They used to be Android's, and Android gives you the
 * bands the device feels like offering — five on most phones, three on some,
 * at frequencies nobody chose. Ten, at the octave centres every graphic
 * equaliser has used for forty years, are the same ten on every phone, on the
 * television and in the car, and a setting carried from one to another means
 * the same thing in both.
 *
 * Gains stay in millibels (100 mB = 1 dB), which is what the screen and
 * everything saved before this were written in.
 *
 * **The preamp is not decoration.** Boosting a band makes the signal louder,
 * and a track mastered near full scale will clip. Pulling the preamp down by
 * roughly the biggest boost is what buys the room back.
 *
 * Two boosts still come from the framework (`modules/audio-eq`), because they
 * are not equalisation: a bass boost (strength 0..1000) and a volume boost (a
 * gain in millibels). They attach to a player's audio session, which is why
 * `attach` is still here and still called for every player the app builds.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { create } from 'zustand';

import { getItem, setItem } from '@/lib/storage';

const KEY = 'resonus.equalizer';

/** A band of the equaliser. */
export interface EqBand {
  index: number;
  /** Center frequency in Hz. */
  centerFreq: number;
}

/**
 * The ten bands, at the octave centres a graphic equaliser has always used.
 *
 * Fixed rather than asked for: they are what makes a setting mean the same
 * thing on the phone, in the car and on the television, which the device's own
 * bands never could.
 */
export const EQ_BANDS: EqBand[] = [
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
].map((centerFreq, index) => ({ index, centerFreq }));

/** One octave wide, which is what ten bands across the range comes to. */
const BAND_Q = 1.41;

/** How far a band may be moved, in millibels. Twelve decibels either way is
 *  as much as is any use before it is the mastering you are fighting. */
export const EQ_MAX_LEVEL = 1200;

/** How far the preamp goes, in millibels. Down is what it is for. */
export const PREAMP_MIN = -1200;
export const PREAMP_MAX = 600;

/**
 * The presets, as gains in decibels per band, lowest frequency first.
 *
 * The app's own, because the device's were the device's: a list that differed
 * between two phones, named things like "Normal" that meant nothing in
 * particular. Each of these is a shape somebody would recognise, and none of
 * them boosts more than six decibels — past that the preamp is doing the work.
 */
export const EQ_PRESETS: { name: string; gains: number[] }[] = [
  { name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Bass', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { name: 'Treble', gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 5] },
  { name: 'Vocal', gains: [-2, -2, -1, 1, 3, 4, 3, 1, 0, 0] },
  { name: 'Rock', gains: [5, 4, 2, 0, -1, 0, 2, 4, 4, 3] },
  { name: 'Electronic', gains: [5, 4, 1, 0, -2, 1, 2, 3, 4, 4] },
  { name: 'Classical', gains: [3, 2, 0, 0, 0, 0, -1, -1, 1, 2] },
  { name: 'Podcast', gains: [-4, -3, -1, 2, 4, 4, 3, 1, -1, -2] },
];

/** Which of the framework's two boosts this device has. */
interface EqInfo {
  /** The device offers a bass boost. */
  bassBoost?: boolean;
  /** The device offers a volume boost. */
  loudness?: boolean;
}

interface NativeAudioEq {
  getInfo: () => EqInfo;
  attach: (sessionId: number) => void;
  detach: (sessionId: number) => void;
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

interface NativeAudioDsp {
  available?: boolean;
  apply: (
    enabled: boolean,
    preampDb: number,
    bands: { hz: number; db: number; q: number }[],
  ) => void;
}

// Optional: in a build without the modules (or iOS) there is simply no
// equalizer. The two are separate because they answer for different things —
// the bands are ours, the boosts are the framework's — and a build can have
// one without the other.
const native = requireOptionalNativeModule<NativeAudioEq>('AudioEq');
const dsp = requireOptionalNativeModule<NativeAudioDsp>('AudioDsp');

interface Stored {
  enabled: boolean;
  levels: number[];
  preamp?: number;
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
  /** Gain applied before the bands, in millibels. Negative is the useful
   *  direction: it is where the room for a boost comes from. */
  preamp: number;
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
  /** Applies one of `EQ_PRESETS` (not named `usePreset` so it doesn't look
   *  like a React hook). */
  applyPreset: (preset: number) => void;
  setPreamp: (millibels: number) => void;
  /** Resets all bands to 0 dB. */
  reset: () => void;
  setBassBoost: (strength: number) => void;
  setLoudness: (gainMb: number) => void;
}

function persist(s: Pick<EqState, 'enabled' | 'levels' | 'preamp' | 'bassBoost' | 'loudness'>) {
  const data: Stored = {
    enabled: s.enabled,
    levels: s.levels,
    preamp: s.preamp,
    bassBoost: s.bassBoost,
    loudness: s.loudness,
  };
  void setItem(KEY, JSON.stringify(data));
}

/** Hands the whole setting to the audio path. Called for every change: the
 *  bands are one state down there, not ten. */
function pushToDsp(s: Pick<EqState, 'enabled' | 'levels' | 'preamp'>) {
  dsp?.apply(
    s.enabled,
    s.preamp / 100,
    EQ_BANDS.map((band) => ({ hz: band.centerFreq, db: (s.levels[band.index] ?? 0) / 100, q: BAND_Q })),
  );
}

/** A gain inside its range, whatever the disk or a finger handed over. */
function clampLevel(value: unknown, min = -EQ_MAX_LEVEL, max = EQ_MAX_LEVEL): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : 0;
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
  preamp: 0,
  bassBoostSupported: false,
  loudnessSupported: false,
  bassBoost: 0,
  loudness: 0,

  hydrate: async () => {
    // The framework is still asked about itself, but only for the two boosts:
    // whether there are bands to show no longer depends on what a device
    // offers, since the bands are the app's.
    const info = native?.getInfo();
    let stored: Stored | null = null;
    try {
      const raw = await getItem(KEY);
      if (raw) stored = JSON.parse(raw) as Stored;
    } catch {
      // no previous data
    }
    // A setting saved before the bands became ours has five numbers in it, or
    // three, and they meant frequencies these ten are not. Ignored rather than
    // stretched onto the new ones: a guess at what somebody meant is worse
    // than flat, which they can hear is flat.
    const mine =
      stored && Array.isArray(stored.levels) && stored.levels.length === EQ_BANDS.length
        ? stored.levels.map((mb) => clampLevel(mb))
        : null;
    const levels = mine ?? EQ_BANDS.map(() => 0);
    // And the switch goes with them. Keeping it on while the gains it belonged
    // to have been dropped leaves an equaliser that is on and does nothing:
    // the screen says it is working, the ears say otherwise, and the audio is
    // kept off the device's low-power path for no benefit at all. What was
    // left behind is left behind whole.
    const enabled = !!dsp && !!stored?.enabled && null !== mine;
    const preamp = clampLevel(stored?.preamp ?? 0, PREAMP_MIN, PREAMP_MAX);
    const bassBoost = info?.bassBoost ? clampBoost(stored?.bassBoost, BASS_BOOST_MAX) : 0;
    const loudness = info?.loudness ? clampBoost(stored?.loudness, LOUDNESS_MAX_MB) : 0;
    set({
      supported: !!dsp,
      bands: EQ_BANDS,
      minLevel: -EQ_MAX_LEVEL,
      maxLevel: EQ_MAX_LEVEL,
      presets: EQ_PRESETS.map((p) => p.name),
      enabled,
      levels,
      preamp,
      bassBoostSupported: !!info?.bassBoost,
      loudnessSupported: !!info?.loudness,
      bassBoost,
      loudness,
    });
    pushToDsp({ enabled, levels, preamp });
    native?.setBassBoost(bassBoost);
    native?.setLoudness(loudness);
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
    if (!dsp) return;
    set({ enabled: on });
    pushToDsp(get());
    persist(get());
  },

  setBandLevel: (band, millibels) => {
    if (!dsp) return;
    const levels = get().levels.slice();
    levels[band] = clampLevel(millibels);
    set({ levels });
    pushToDsp(get());
    persist(get());
  },

  applyPreset: (preset) => {
    if (!dsp) return;
    const chosen = EQ_PRESETS[preset];
    if (!chosen) return;
    const levels = EQ_BANDS.map((band) => clampLevel((chosen.gains[band.index] ?? 0) * 100));
    set({ levels });
    pushToDsp(get());
    persist(get());
  },

  setPreamp: (millibels) => {
    if (!dsp) return;
    set({ preamp: clampLevel(millibels, PREAMP_MIN, PREAMP_MAX) });
    pushToDsp(get());
    persist(get());
  },

  reset: () => {
    if (!dsp) return;
    set({ levels: EQ_BANDS.map(() => 0), preamp: 0 });
    pushToDsp(get());
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
