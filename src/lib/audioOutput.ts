/**
 * JS ↔ `AudioOutput` native module bridge (the phone's own outputs and the
 * media volume, Android).
 *
 * The module lists the outputs the phone has (speaker, wired, Bluetooth, USB,
 * hearing aids), says which one media is going to, and reads and sets the
 * media stream's volume. It cannot move the music to an output of its choice:
 * Android only lets an app do that on its own player, and the player is
 * expo-audio's. What it can do is open the system's media output dialog, the
 * one behind the volume panel's output button, which is where the choice is
 * made. Without the module (web, iOS) there are no outputs and no volume.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useSyncExternalStore } from 'react';

export type AudioOutputKind = 'speaker' | 'wired' | 'bluetooth' | 'usb' | 'hearingAid';

export interface AudioOutputDevice {
  id: number;
  kind: AudioOutputKind;
  /** The product name: the Bluetooth device's own, the phone's model for the rest. */
  name: string;
}

export interface AudioOutputs {
  devices: AudioOutputDevice[];
  /** The id of the output media goes to; -1 when there is none to tell. */
  activeId: number;
}

/** The media stream's volume in the system's own steps, 0 to `max`. */
export interface MediaVolume {
  value: number;
  max: number;
}

/** Which dialog `openSystemOutputPicker` managed to bring up. */
export type SystemOutputPicker = 'picker' | 'bluetooth' | '';

interface NativeAudioOutput {
  getDevices: () => AudioOutputs;
  select: (id: number) => boolean;
  getVolume: () => MediaVolume;
  setVolume: (value: number) => void;
  openSystemPicker: () => SystemOutputPicker;
  addListener: (
    event: 'devicesChanged' | 'volumeChanged',
    cb: (payload: AudioOutputs & MediaVolume) => void,
  ) => { remove: () => void };
}

const native = requireOptionalNativeModule<NativeAudioOutput>('AudioOutput');

export const audioOutputAvailable = !!native;

const NO_OUTPUTS: AudioOutputs = { devices: [], activeId: -1 };
const NO_VOLUME: MediaVolume = { value: 0, max: 0 };

/** How often the active output is asked again while someone is looking:
 *  Android tells us when an output comes or goes, not when the music moves
 *  from one to another, and the system dialog can move it at any time. */
const ACTIVE_POLL_MS = 2000;

export function getAudioOutputs(): AudioOutputs {
  return native?.getDevices() ?? NO_OUTPUTS;
}

export function getMediaVolume(): MediaVolume {
  return native?.getVolume() ?? NO_VOLUME;
}

export function setMediaVolume(value: number): void {
  native?.setVolume(Math.round(value));
}

/**
 * The media volume's every move, hardware keys included, for as long as the
 * caller keeps the subscription: on its own, without the outputs and the
 * poll that `useAudioOutput` adds for the sheet. Nothing, without the module.
 */
export function onMediaVolumeChanged(cb: (volume: MediaVolume) => void): () => void {
  const sub = native?.addListener('volumeChanged', ({ value, max }) => cb({ value, max }));
  return () => sub?.remove();
}

export function openSystemOutputPicker(): SystemOutputPicker {
  return native?.openSystemPicker() ?? '';
}

/** What the sheet reads: one object, replaced whole whenever something changes. */
interface AudioOutputSnapshot {
  outputs: AudioOutputs;
  volume: MediaVolume;
}

const IDLE: AudioOutputSnapshot = { outputs: NO_OUTPUTS, volume: NO_VOLUME };
let snapshot = IDLE;
const listeners = new Set<() => void>();
let subscriptions: { remove: () => void }[] = [];
let poll: ReturnType<typeof setInterval> | undefined;

function publish(next: Partial<AudioOutputSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

/**
 * Listens to the phone while at least one component does. The native module
 * only registers with the system while it has listeners, so this costs
 * nothing while the sheet is down.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && native) {
    subscriptions = [
      native.addListener('devicesChanged', ({ devices, activeId }) => publish({ outputs: { devices, activeId } })),
      native.addListener('volumeChanged', ({ value, max }) => publish({ volume: { value, max } })),
    ];
    poll = setInterval(() => {
      const outputs = getAudioOutputs();
      // Only a change is news; a fresh copy of the same list would redraw for nothing.
      if (JSON.stringify(outputs) !== JSON.stringify(snapshot.outputs)) publish({ outputs });
    }, ACTIVE_POLL_MS);
  }
  // Fresh on every opening: whatever moved while nobody was looking.
  snapshot = { outputs: getAudioOutputs(), volume: getMediaVolume() };
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    subscriptions.forEach((sub) => sub.remove());
    subscriptions = [];
    clearInterval(poll);
    poll = undefined;
  };
}

const getSnapshot = () => snapshot;
const idle = () => () => {};
const getIdle = () => IDLE;

/**
 * The outputs and the media volume, kept current while `active`: the sheet
 * that shows them is mounted all along and only needs them while it is up.
 */
export function useAudioOutput(active: boolean): AudioOutputSnapshot {
  return useSyncExternalStore(active ? subscribe : idle, active ? getSnapshot : getIdle);
}
