/**
 * Is this a television?
 *
 * Asked at module load, because the type scale is decided there and a screen
 * cannot be measured twice: a ladder that changed after the first render would
 * mean every screen laying itself out at phone size and then jumping.
 *
 * The answer comes from the native side, which asks Android whether the device
 * carries the leanback feature — the same question the Play Store asks, and the
 * one thing that is true of every Android TV and false of every phone. React
 * Native's own `Platform.isTV` reads the UI mode instead, which an emulator and
 * a few boxes report wrongly, so it is only the fallback for a build where the
 * module is missing (iOS, or a development client that has not been rebuilt).
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

const native = requireOptionalNativeModule<{ isTv?: boolean }>('TvFocus');

export const IS_TV: boolean = native?.isTv ?? Platform.isTV ?? false;

/**
 * How much bigger everything is on a television.
 *
 * A TV reports 960 points across where a phone reports 400, so the app is
 * already drawn small on it before anybody sits down: the same 16-point line
 * that fills a phone's width crosses a sixth of a television. These are the
 * multipliers that put it back, arrived at by reading the screens from a sofa
 * rather than from a rule — text gains the most, spacing less, corners barely,
 * because a corner scaled with the type stops looking like the same app.
 */
export const TV_TEXT = 1.6;
export const TV_SPACE = 1.35;
export const TV_RADIUS = 1.2;

/** A number on the ladder, at the size this screen wants. */
export function tvScale(value: number, factor: number): number {
  return IS_TV ? Math.round(value * factor) : value;
}
