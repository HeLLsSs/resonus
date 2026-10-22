/**
 * The road's log: what car mode and ride mode did, which Bluetooth device
 * started them, the audio focus the player asked for and where the music
 * went. Kept on disk by the native side (`DriveLog.kt` in modules/crash-log),
 * which the Bluetooth receiver and the player write to as well, so a report
 * written at home still says what happened in the car.
 *
 * Android only; elsewhere every function does nothing and reads nothing.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

const native = requireOptionalNativeModule<{
  readDriveLog(): string;
  addDriveLog(message: string): void;
  clearDriveLog(): void;
  audioState(): string;
}>('CrashLog');

/** One line in the log. Never throws. */
export function driveLog(message: string): void {
  try {
    native?.addDriveLog(message);
  } catch {
    // A log line is never worth an error.
  }
}

/** One line, with where the sound is going right now after it. */
export function driveLogWithAudio(message: string): void {
  driveLog(`${message} · ${audioState()}`);
}

/** The lines, oldest first; empty with none. */
export function readDriveLog(): string {
  try {
    return native?.readDriveLog() ?? '';
  } catch {
    return '';
  }
}

export function clearDriveLog(): void {
  try {
    native?.clearDriveLog();
  } catch {
    // Nothing to clear.
  }
}

/** Where the sound is going, as one line; empty where that cannot be read. */
export function audioState(): string {
  try {
    return native?.audioState() ?? '';
  } catch {
    return '';
  }
}
