/**
 * JS ↔ `RideMode` native module bridge (ride mode, Android).
 *
 * Ride mode is the app for a motorbike: a screen of buttons a glove can hit
 * (`src/app/ride.tsx`), a floating player over the navigation app, each new
 * song read out in the helmet, and all of it started on its own when the
 * helmet's intercom connects. The module holds the native half: which
 * Bluetooth device is the intercom and the receiver that hears it connect,
 * the overlay window, the text-to-speech engine, and the app brought to the
 * front from behind another one. What ride mode does with them is
 * `src/lib/rideSync.ts`.
 *
 * On platforms without the module (web, iOS) everything here is a no-op and
 * `rideModeAvailable` is false; the screen itself still works anywhere.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { PermissionsAndroid, Platform } from 'react-native';

import { type Song } from '@/api/subsonic';
import { tg } from '@/i18n';
import type { StreamInfo } from '@/store/player';

export interface RideConfig {
  /** The intercom as the phone names it; empty for none, which is ride mode never starting by itself. */
  intercomName: string;
  /** Its Bluetooth address, for a device whose name the system will not give. */
  intercomAddress: string;
  /** The floating player over other apps. */
  overlay: boolean;
  /** Every new song read out loud. */
  announce: boolean;
  /** The queue starts again when the intercom connects. */
  resume: boolean;
  /** What plays when the queue is empty at that point. */
  emptyQueue: EmptyQueueAction;
  /** The package of the navigation app brought up after the ride screen; empty for none. */
  navigationApp: string;
  /** The media volume set when ride mode starts by itself, 0 to 1; 0 leaves it alone. */
  startVolume: number;
  /** The floating player's buttons. */
  overlaySize: OverlaySize;
  /** The station the ride screen's radio button plays; empty for no button. */
  radioStationId: string;
  radioStationName: string;
  /** The battery, the output and what is left of the queue said when the intercom connects. */
  status: boolean;
  /** How many songs of the queue "Prepare the ride" downloads; 0 for the whole queue. */
  prepareCount: number;
  /** The ride prepared on its own, on the charger and on Wi-Fi, at night or with the phone left alone. */
  autoPrepare: boolean;
  /** The media volume raised with the speed while ride mode is on, against the wind. */
  speedVolume: boolean;
  /** How far `speedVolume` raises it. */
  speedStrength: SpeedStrength;
}

/** The choices for `prepareCount`, 0 being the whole queue. */
export const PREPARE_COUNTS = [15, 30, 60, 0];

export type SpeedStrength = 'light' | 'medium' | 'strong';

export const SPEED_STRENGTHS: SpeedStrength[] = ['light', 'medium', 'strong'];

export type OverlaySize = 'normal' | 'large';

export type EmptyQueueAction = 'nothing' | 'foryou' | 'favorites' | 'random';

export const EMPTY_QUEUE_ACTIONS: EmptyQueueAction[] = ['nothing', 'foryou', 'favorites', 'random'];

export interface NavigationApp {
  package: string;
  name: string;
}

export interface BluetoothDevice {
  name: string;
  address: string;
}

/** What the floating player shows. */
export interface RideOverlayState {
  title: string;
  isPlaying: boolean;
}

/** The intercom coming or going, or the quick settings tile tapped, which asks for the same. */
export interface IntercomEvent {
  connected: boolean;
  name: string;
  source: 'intercom' | 'tile';
}

/** A button of the floating player. Its title opens the app on its own, natively. */
export type RideAction = 'toggle' | 'next' | 'previous';

interface NativeRideMode {
  getConfig: () => RideConfig;
  setConfig: (config: RideConfig) => void;
  hasBluetoothPermission: () => boolean;
  getBondedDevices: () => BluetoothDevice[];
  canDrawOverlays: () => boolean;
  requestOverlayPermission: () => void;
  showOverlay: (state: RideOverlayState) => void;
  updateOverlay: (state: RideOverlayState) => void;
  hideOverlay: () => void;
  openApp: (link: string) => void;
  speak: (text: string, queue: boolean) => void;
  stopSpeaking: () => void;
  takePendingIntercom: () => string | null;
  getNavigationApps: () => NavigationApp[];
  openNavigationApp: (pkg: string) => boolean;
  setShowWhenLocked: (on: boolean) => void;
  setScreenBrightness: (level: number) => void;
  setActive: (on: boolean) => void;
  canListen: () => boolean;
  listen: () => Promise<string>;
  isScreenOn: () => boolean;
  watchSpeed: (on: boolean) => void;
  addListener: {
    (event: 'screen', cb: (e: { on: boolean }) => void): { remove: () => void };
    (event: 'speed', cb: (e: { speed: number }) => void): { remove: () => void };
    (event: 'intercom', cb: (e: IntercomEvent) => void): { remove: () => void };
    (event: 'action', cb: (e: { action: RideAction }) => void): { remove: () => void };
    (event: 'call', cb: (e: { inCall: boolean }) => void): { remove: () => void };
    (event: 'battery', cb: (e: BatteryEvent) => void): { remove: () => void };
  };
}

/** The battery as the system last reported it. */
export interface BatteryEvent {
  /** 0 to 100. */
  level: number;
  charging: boolean;
}

const native = requireOptionalNativeModule<NativeRideMode>('RideMode');

export const rideModeAvailable = !!native;

/** The deep link that opens the app on the ride screen, from the overlay, a shortcut or the module. */
export const RIDE_LINK = 'resonuls://ride';

export const NO_RIDE_CONFIG: RideConfig = {
  intercomName: '',
  intercomAddress: '',
  overlay: false,
  announce: false,
  resume: false,
  emptyQueue: 'nothing',
  navigationApp: '',
  startVolume: 0,
  overlaySize: 'normal',
  radioStationId: '',
  radioStationName: '',
  status: true,
  prepareCount: 30,
  autoPrepare: false,
  speedVolume: false,
  speedStrength: 'medium',
};

export function getRideConfig(): RideConfig {
  const config = native?.getConfig();
  if (!config) return NO_RIDE_CONFIG;
  // A value written by a later build, or by hand, is read as the default.
  const emptyQueue = EMPTY_QUEUE_ACTIONS.find((a) => a === config.emptyQueue) ?? 'nothing';
  const overlaySize = config.overlaySize === 'large' ? 'large' : 'normal';
  const prepareCount = PREPARE_COUNTS.includes(config.prepareCount) ? config.prepareCount : 30;
  const speedStrength = SPEED_STRENGTHS.find((s) => s === config.speedStrength) ?? 'medium';
  return { ...config, emptyQueue, overlaySize, prepareCount, speedStrength };
}

export function setRideConfig(config: RideConfig): void {
  native?.setConfig(config);
}

export function hasBluetoothPermission(): boolean {
  return native?.hasBluetoothPermission() ?? false;
}

/**
 * Asks for the permission to know which device connects. Granted with the
 * install before Android 12, where the question is never shown.
 */
export async function requestBluetoothPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (hasBluetoothPermission()) return true;
  try {
    const answer = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    return answer === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

/**
 * Asks for the phone's position, for the volume that follows the speed:
 * the precise one first, which is what the GPS needs, then the one that
 * goes on with the app behind the navigation app, which from Android 11 is
 * a choice on the system's own screen ("Allow all the time"). Answers
 * whether the speed can be read at all; without the second answer it can,
 * but only while the app is in front.
 */
export async function requestLocationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const { PERMISSIONS, RESULTS } = PermissionsAndroid;
  try {
    // Both asked together: from Android 12 the precise one asked alone is
    // ignored. "Approximate" is no answer here, since the speed is the GPS's.
    const answers = await PermissionsAndroid.requestMultiple([
      PERMISSIONS.ACCESS_FINE_LOCATION,
      PERMISSIONS.ACCESS_COARSE_LOCATION,
    ]);
    if (answers[PERMISSIONS.ACCESS_FINE_LOCATION] !== RESULTS.GRANTED) return false;
    // Android 10 is where the position in the background became a
    // permission of its own; before it the first answer covers both.
    if (Number(Platform.Version) >= 29 && !(await PermissionsAndroid.check(PERMISSIONS.ACCESS_BACKGROUND_LOCATION))) {
      await PermissionsAndroid.request(PERMISSIONS.ACCESS_BACKGROUND_LOCATION);
    }
    return true;
  } catch {
    return false;
  }
}

/** The devices paired with the phone; empty without the permission above. */
export function getBondedDevices(): BluetoothDevice[] {
  return native?.getBondedDevices() ?? [];
}

export function canDrawOverlays(): boolean {
  return native?.canDrawOverlays() ?? false;
}

/** Opens the system's screen where drawing over other apps is allowed. */
export function requestOverlayPermission(): void {
  native?.requestOverlayPermission();
}

export function showRideOverlay(state: RideOverlayState): void {
  native?.showOverlay(state);
}

export function updateRideOverlay(state: RideOverlayState): void {
  native?.updateOverlay(state);
}

export function hideRideOverlay(): void {
  native?.hideOverlay();
}

/** Brings the app up on the ride screen, from behind whatever is in front. */
export function openRideScreen(): void {
  native?.openApp(RIDE_LINK);
}

/** Says a line in the helmet, over whatever was being said; after it with `queue`. */
export function speak(text: string, queue = false): void {
  native?.speak(text, queue);
}

export function stopSpeaking(): void {
  native?.stopSpeaking();
}

/** The intercom that connected while JS was not running, if any; read once and cleared. */
export function takePendingIntercom(): string | null {
  return native?.takePendingIntercom() ?? null;
}

/** The navigation apps installed, from the ones the module knows to look for. */
export function getNavigationApps(): NavigationApp[] {
  return native?.getNavigationApps() ?? [];
}

export function openNavigationApp(pkg: string): void {
  native?.openNavigationApp(pkg);
}

/** Whether the app shows over the lock screen, for the ride screen on a phone locked in a pocket. */
export function setShowWhenLocked(on: boolean): void {
  native?.setShowWhenLocked(on);
}

/** The screen's brightness while the app is in front, 0 to 1; -1 gives it back to the phone. */
export function setScreenBrightness(level: number): void {
  native?.setScreenBrightness(level);
}

/** Tells the quick settings tile whether ride mode is on. */
export function setRideActive(on: boolean): void {
  native?.setActive(on);
}

/** Whether the phone can turn speech into text (Google's app, on most phones). */
export function canListen(): boolean {
  return native?.canListen() ?? false;
}

/** Brings up the phone's speech dialog; what was said, or empty for nothing. */
export function listen(): Promise<string> {
  return native?.listen() ?? Promise.resolve('');
}

export function onCall(cb: (inCall: boolean) => void): { remove: () => void } | undefined {
  return native?.addListener('call', (e) => cb(e.inCall));
}

/**
 * The battery as last heard of, for the status read out at the start of a
 * ride: the system says it again at every change, from the moment somebody
 * listens, so this is a moment old at most. Nothing until it has spoken.
 */
let battery: BatteryEvent | null = null;

export function batteryState(): BatteryEvent | null {
  return battery;
}

export function onBattery(cb: (e: BatteryEvent) => void): { remove: () => void } | undefined {
  return native?.addListener('battery', (e) => {
    battery = e;
    cb(e);
  });
}

/** Whether the screen is lit, the lock screen included; true where nobody can say. */
export function isScreenOn(): boolean {
  return native?.isScreenOn() ?? true;
}

/** The screen going on or off, at every change. */
export function onScreen(cb: (on: boolean) => void): { remove: () => void } | undefined {
  return native?.addListener('screen', (e) => cb(e.on));
}

/** Starts or stops reading the speed off the GPS; nothing without the permission. */
export function watchSpeed(on: boolean): void {
  native?.watchSpeed(on);
}

/** The speed in km/h, every couple of seconds while `watchSpeed` is on and the GPS has a fix. */
export function onSpeed(cb: (kmh: number) => void): { remove: () => void } | undefined {
  return native?.addListener('speed', (e) => cb(e.speed * 3.6));
}

export function onIntercom(cb: (e: IntercomEvent) => void): { remove: () => void } | undefined {
  return native?.addListener('intercom', cb);
}

export function onRideAction(cb: (action: RideAction) => void): { remove: () => void } | undefined {
  return native?.addListener('action', (e) => cb(e.action));
}

/**
 * What the helmet hears when a song starts: its title and, when there is
 * one, its artist. A radio names what it plays itself, so what it says is
 * read over the station's own name; nothing at all is announced for a
 * station that says nothing, since "Radio X, by nobody" every few minutes
 * is not company.
 */
export function announcement(song: Song, live: StreamInfo | null): string | null {
  const title = (live?.title ?? song.title ?? '').trim();
  const artist = (live?.artist ?? song.artist ?? '').trim();
  if (!title) return null;
  if (song.url && !live?.title) return null;
  return artist ? tg('{title}, by {artist}', { title, artist }) : title;
}

/**
 * The songs "Prepare the ride" downloads: the one playing and the `count`
 * after it in the order they will play, round to the start of the queue
 * when it repeats, the whole queue for a `count` of 0. A song already on the
 * phone and a radio stream are left out and do not count, so what is asked
 * for is `count` songs the bike could not play without a network, not
 * `count` places in the queue. A track the proxy found online is fetched
 * like any other: the proxy streams it, and the download menu offers it too.
 */
export function songsToPrepare(
  queue: Song[],
  index: number,
  count: number,
  repeats: boolean,
  downloaded: Record<string, string>,
): Song[] {
  if (queue.length === 0) return [];
  const start = Math.max(0, Math.min(index, queue.length - 1));
  const span = repeats ? queue.length : queue.length - start;
  const wanted = count > 0 ? count : Infinity;
  const picked: Song[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < span && picked.length < wanted; i++) {
    const song = queue[(start + i) % queue.length];
    if (!song || seen.has(song.id)) continue;
    seen.add(song.id);
    if (song.url || song.localUri || downloaded[song.id]) continue;
    picked.push(song);
  }
  return picked;
}

/** The longest a ride stays prepared before the next one is worth fetching. */
export const AUTO_PREPARE_EVERY_MS = 12 * 60 * 60 * 1000;

/** How long the screen stays off before a phone on its charger counts as left alone. */
export const AUTO_PREPARE_IDLE_MS = 10 * 60 * 1000;

/** Night, in the phone's local hours: from 22:00 to 06:00. */
const NIGHT_FROM = 22;
const NIGHT_TO = 6;

/**
 * Whether the ride should be prepared on its own now: on the charger, on
 * Wi-Fi, and either at night or with the screen off for ten minutes, the
 * phone put down for the evening. Once in twelve hours at most, so a phone
 * on its charger all day is not fetching the queue again at every turn.
 * `lastAt` and `screenOffSince` are null for never and for a lit screen.
 */
export function shouldAutoPrepare(c: {
  charging: boolean;
  wifi: boolean;
  hour: number;
  lastAt: number | null;
  now: number;
  screenOffSince: number | null;
}): boolean {
  if (!c.charging || !c.wifi) return false;
  if (c.lastAt !== null && c.now - c.lastAt < AUTO_PREPARE_EVERY_MS) return false;
  const night = c.hour >= NIGHT_FROM || c.hour < NIGHT_TO;
  const idle = c.screenOffSince !== null && c.now - c.screenOffSince >= AUTO_PREPARE_IDLE_MS;
  return night || idle;
}

/** Below this the wind is no louder than the engine, and the volume is the rider's alone. */
const SPEED_FLOOR_KMH = 30;
/** From this the boost is all it will ever be. */
const SPEED_TOP_KMH = 110;
const SPEED_STEPS: Record<SpeedStrength, number> = { light: 1, medium: 2, strong: 3 };

/**
 * How many volume steps the wind at `kmh` is worth, as a fraction: none up
 * to 30 km/h, rising evenly to 1, 2 or 3 steps (light, medium, strong) at
 * 110 km/h, and no more past it.
 */
export function speedOffset(kmh: number, strength: SpeedStrength): number {
  const share = (kmh - SPEED_FLOOR_KMH) / (SPEED_TOP_KMH - SPEED_FLOOR_KMH);
  return Math.max(0, Math.min(1, share)) * SPEED_STEPS[strength];
}

/**
 * The speed smoothed over the last few readings (one every two seconds),
 * so a hard brake, a gust in the GPS or a moment without a fix does not
 * move the volume on its own. Null before the first reading.
 */
export function smoothSpeed(previous: number | null, kmh: number): number {
  return previous === null ? kmh : previous + (kmh - previous) * 0.3;
}

/**
 * The whole steps of boost to apply, from the ones applied now and the
 * fraction the speed is worth: one step at a time, and only once the
 * fraction is three quarters of a step away, so a speed that hovers around
 * a threshold does not pump the volume up and down.
 */
export function nextSpeedSteps(applied: number, target: number): number {
  if (target >= applied + 0.75) return applied + 1;
  if (target <= applied - 0.75) return applied - 1;
  return applied;
}
