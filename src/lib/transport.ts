/**
 * The transport buttons, as everything outside the app presses them: a car,
 * a browser's media keys, a Tasker intent, the cast notification, a voice in
 * a helmet. Each of those used to carry its own copy of the same switch over
 * the player store, and they drifted: one clamped a seek, another did not.
 * Here is the one copy, over the store, so a pause from a car is the pause
 * the button makes, with everything that goes with it (a Jam, a speaker).
 *
 * `resume` and `pause` are what a system sends when it means a state, and do
 * nothing when the player is already there; `toggle` is a key that means
 * "the other one". Callers name which they mean.
 */
import { REPEAT_MODES, type RepeatMode } from '@/lib/playerMath';
import { usePlayerStore } from '@/store/player';

/** How far `forward` and `back` move, in seconds. */
export const SEEK_STEP_SEC = 10;

export type TransportAction =
  | 'resume'
  | 'pause'
  | 'toggle'
  | 'next'
  | 'previous'
  | 'forward'
  | 'back'
  | 'seek'
  | 'shuffle'
  | 'repeat';

/**
 * Puts the player in `mode`, through the same cycle the button turns, so
 * everything the button does (the player's loop, the queue sync) happens
 * here too. Reads the store again at each step: the cycle's order is the
 * store's own business.
 */
export function setRepeat(mode: RepeatMode): void {
  for (let i = 0; i < REPEAT_MODES.length && usePlayerStore.getState().repeat !== mode; i++) {
    usePlayerStore.getState().cycleRepeat();
  }
}

export function applyTransport(action: Exclude<TransportAction, 'seek' | 'shuffle' | 'repeat'>): void;
/** `sec` from the start of the song; a position before it is the start. */
export function applyTransport(action: 'seek', sec: number): void;
export function applyTransport(action: 'shuffle', on: boolean): void;
export function applyTransport(action: 'repeat', mode: RepeatMode): void;
export function applyTransport(action: TransportAction, value?: number | boolean | RepeatMode): void {
  const store = usePlayerStore.getState();
  switch (action) {
    case 'resume':
      if (!store.isPlaying) store.toggle();
      return;
    case 'pause':
      if (store.isPlaying) store.toggle();
      return;
    case 'toggle':
      store.toggle();
      return;
    case 'next':
      store.next();
      return;
    case 'previous':
      store.previous();
      return;
    case 'forward':
      store.seekTo(Math.min(store.positionSec + SEEK_STEP_SEC, Math.max(0, store.durationSec - 1)));
      return;
    case 'back':
      store.seekTo(Math.max(0, store.positionSec - SEEK_STEP_SEC));
      return;
    case 'seek':
      if (typeof value === 'number') store.seekTo(Math.max(0, value));
      return;
    case 'shuffle':
      if (Boolean(value) !== store.shuffle) store.toggleShuffle();
      return;
    case 'repeat':
      if (typeof value === 'string') setRepeat(value);
      return;
  }
}
