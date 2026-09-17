/**
 * An interval that goes on in the background.
 *
 * React Native pauses `setInterval` while the app is not in front, screen
 * locked among other things, and a poll of a speaker or a server that hangs
 * on one stops with it: a track ends over there and nobody hears it end until
 * the screen comes back. The native ticker (`modules/ticker`) is a coroutine
 * that sends an event on every beat, and events arrive whatever the screen is
 * doing. Where there is no native side, in a browser or in a test, this is a
 * plain `setInterval`.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeTicker {
  start(id: string, intervalMs: number): void;
  stop(id: string): void;
  addListener(event: 'tick', listener: (e: { id: string }) => void): { remove: () => void };
}

const native = requireOptionalNativeModule<NativeTicker>('Ticker');
let seq = 0;

/** Calls `fn` every `intervalMs`, in the background too. The return stops it. */
export function everyMs(intervalMs: number, fn: () => void): () => void {
  if (!native) {
    const timer = setInterval(fn, intervalMs);
    return () => clearInterval(timer);
  }
  const id = `tick-${++seq}`;
  const sub = native.addListener('tick', (e) => {
    if (e.id === id) fn();
  });
  native.start(id, intervalMs);
  return () => {
    sub.remove();
    native.stop(id);
  };
}
