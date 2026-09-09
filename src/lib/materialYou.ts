/**
 * The accent Android 12+ derives from the wallpaper (native module
 * `MaterialYou`), as seen from JS.
 *
 * One pair per appearance, the way the settings store keeps its own accents.
 * Without the module (another platform, an older build) or below Android 12
 * there is nothing to read and the answer is null, which the callers take as
 * "keep the accent that was picked".
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface SystemAccent {
  /** The tone the system uses on white. */
  light: string;
  /** The pale tone it uses on black. */
  dark: string;
}

const native = requireOptionalNativeModule<{
  getSystemAccent: () => SystemAccent | null;
}>('MaterialYou');

/** The device's current accent pair, or null where there is none. */
export function getSystemAccent(): SystemAccent | null {
  if (!native) return null;
  try {
    return native.getSystemAccent();
  } catch {
    return null;
  }
}

/** Whether this device has an accent to offer at all. Fixed for the life of
 *  the process: it is a question about the Android version, not the wallpaper. */
export const systemAccentAvailable = getSystemAccent() !== null;
