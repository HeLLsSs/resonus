/**
 * `@/store/player` as a scoreboard: the state a command reads, and every
 * action written down in `playerCalls` instead of played.
 */
import { create } from 'zustand';

import type { Song } from '../../src/api/subsonic';

export type RepeatMode = 'off' | 'all' | 'one';

export interface StreamInfo {
  title: string;
  artist?: string;
}

interface PlayerState {
  queue: Song[];
  index: number;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  positionSec: number;
  durationSec: number;
  volume: number;
  speed: number;
  streamInfo: StreamInfo | null;
  toggle: () => void;
  stopAndClear: () => Promise<undefined>;
  next: () => void;
  previous: () => void;
  seekTo: (sec: number) => void;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setSleepTimer: (minutes: number) => void;
  cancelSleepTimer: () => void;
  playQueue: (songs: Song[], index: number, source?: string, href?: string, options?: unknown) => Promise<void>;
}

export const playerCalls: { name: string; args: unknown[] }[] = [];

const REPEAT: RepeatMode[] = ['off', 'all', 'one'];

export const usePlayerStore = create<PlayerState>((set, get) => {
  const note = (name: string, ...args: unknown[]) => playerCalls.push({ name, args });
  return {
    queue: [],
    index: 0,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    positionSec: 0,
    durationSec: 0,
    volume: 1,
    speed: 1,
    streamInfo: null,
    toggle: () => {
      note('toggle');
      set({ isPlaying: !get().isPlaying });
    },
    stopAndClear: async () => {
      note('stopAndClear');
      set({ queue: [], index: 0, isPlaying: false });
      return undefined;
    },
    next: () => note('next'),
    previous: () => note('previous'),
    seekTo: (sec) => note('seekTo', sec),
    setVolume: (v) => note('setVolume', v),
    toggleShuffle: () => {
      note('toggleShuffle');
      set({ shuffle: !get().shuffle });
    },
    cycleRepeat: () => {
      note('cycleRepeat');
      set({ repeat: REPEAT[(REPEAT.indexOf(get().repeat) + 1) % REPEAT.length] });
    },
    setSleepTimer: (minutes) => note('setSleepTimer', minutes),
    cancelSleepTimer: () => note('cancelSleepTimer'),
    playQueue: async (songs, index, source, href, options) => {
      note('playQueue', songs, index, source, href, options);
      set({ queue: songs, index, isPlaying: true });
    },
  };
});

/** Back to a silent player with nothing written down. */
export function resetPlayer(): void {
  playerCalls.length = 0;
  leaveCalls.length = 0;
  output.id = 'phone';
  output.name = '';
  usePlayerStore.setState({
    queue: [],
    index: 0,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    positionSec: 0,
    durationSec: 0,
    volume: 1,
    streamInfo: null,
  });
}

export type RemoteKind = 'upnp' | 'jukebox' | 'cast' | 'ha' | 'ma' | 'linkplay';

export interface CurrentOutput {
  id: string;
  name: string;
}

/** No speaker is ever on in a test: the phone is what plays. */
export function remoteKind(): null {
  return null;
}

/** What `currentOutput` answers; a test moves the music by setting it. */
export const output: CurrentOutput = { id: 'phone', name: '' };

export function currentOutput(): CurrentOutput {
  return { ...output };
}

/** Every `leaveRemoteOutputs` call, as it was made. */
export const leaveCalls: { silent: boolean; keep?: RemoteKind }[] = [];

export async function leaveRemoteOutputs(silent = false, keep?: RemoteKind): Promise<void> {
  leaveCalls.push({ silent, keep });
}

const outputListeners = new Set<() => void>();

export function onOutputChanged(listener: () => void): () => void {
  outputListeners.add(listener);
  return () => {
    outputListeners.delete(listener);
  };
}

/** What the real store does when a speaker is taken or left. */
export function outputChanged(): void {
  outputListeners.forEach((listener) => listener());
}
