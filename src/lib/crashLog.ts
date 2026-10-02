/**
 * What killed the app, written down before it dies.
 *
 * A crash on a phone in a pocket, or on a car's screen, leaves nothing to
 * read: the process is gone and logcat with it by the time anybody gets to a
 * computer. So the uncaught error and the unhandled rejection are appended to
 * `crash.log` in the app's own files before the runtime's own handler gets
 * them, and the native side writes its exceptions to the same file
 * (`modules/crash-log`). Settings › Diagnostics reads it back and shares it.
 *
 * One entry is `ISO date  KIND  message`, the stack under it, and a blank line
 * after. The file is capped: past `CRASH_LOG_MAX` the oldest half goes.
 */
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { bump } from '@/lib/perfLog';

/** Past this many characters the oldest half of the file is dropped. */
export const CRASH_LOG_MAX = 64 * 1024;

/** The most entries the diagnostics screen shows. */
export const CRASH_LOG_SHOWN = 20;

/**
 * The most entries one run of the app writes. Every entry rewrites the whole
 * file, on the JS thread, and a rejection fired from a loop (a request failing
 * on every tick out of coverage) would otherwise do that on every turn of it.
 * The first of them is what the report needs; the rest say the same thing.
 */
export const CRASH_LOG_PER_RUN = 50;

/** How many entries this run has written. */
let written = 0;

/**
 * `text` cut down to its newest half once it is longer than `max`, cut at an
 * entry boundary so the first entry kept is whole.
 */
export function trimLog(text: string, max = CRASH_LOG_MAX): string {
  if (text.length <= max) return text;
  const half = Math.floor(text.length / 2);
  const boundary = text.indexOf('\n\n', half);
  return boundary < 0 ? text.slice(half) : text.slice(boundary + 2);
}

/** The entries of a log, newest first, at most `limit` of them. */
export function crashEntries(text: string, limit = CRASH_LOG_SHOWN): string[] {
  return text
    .split('\n\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .reverse()
    .slice(0, limit);
}

/** On a phone only: a browser has no file to write to and no `ErrorUtils`. */
const onPhone = Platform.OS !== 'web';

function logFile(): File {
  return new File(Paths.document, 'crash.log');
}

/** The whole file, or nothing when there is none. */
export function readCrashLog(): string {
  if (!onPhone) return '';
  try {
    const file = logFile();
    return file.exists ? file.textSync() : '';
  } catch {
    return '';
  }
}

export function clearCrashLog(): void {
  if (!onPhone) return;
  try {
    const file = logFile();
    if (file.exists) file.delete();
  } catch {
    // Nothing to clear, or nowhere to clear it from.
  }
}

/**
 * Appends one entry. Synchronous on purpose: the process may be about to go,
 * and a promise would never resolve.
 */
export function appendCrash(kind: 'JS' | 'REJECTION', message: string, stack?: string): void {
  if (!onPhone || written >= CRASH_LOG_PER_RUN) return;
  written += 1;
  try {
    const entry = `${new Date().toISOString()}  ${kind}  ${message}\n${stack ?? ''}`.trimEnd();
    logFile().write(trimLog(`${readCrashLog()}${entry}\n\n`));
  } catch {
    // Writing the log must never be the thing that crashes.
  }
}

function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: `${error.name}: ${error.message}`, stack: error.stack };
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

/**
 * Installs the two handlers. The runtime's own error handler keeps running
 * after ours, so the red box in development and the crash in release are
 * what they were; this only adds the line on disk before them.
 *
 * Rejections go through Hermes' own tracker where there is one, which is the
 * engine's `Promise`, and through the `promise` package's otherwise, which is
 * the polyfill React Native installs in its place. React Native only turns
 * either on in development; here they are on in release too, since that is
 * where the reports come from.
 */
export function installCrashLog(): void {
  if (!onPhone || typeof ErrorUtils === 'undefined') return;
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    const { message, stack } = describe(error);
    appendCrash('JS', `${isFatal ? 'fatal ' : ''}${message}`, stack);
    bump('crash · js');
    previous?.(error, isFatal);
  });
  const tracking = {
    allRejections: true,
    onUnhandled: (id: number, rejection: unknown) => {
      const { message, stack } = describe(rejection);
      appendCrash('REJECTION', `(id ${id}) ${message}`, stack);
      bump('crash · rejection');
      // In development the tracker this replaces put the rejection on the
      // screen; the console does the same through LogBox.
      if (__DEV__) console.error(`Uncaught (in promise, id: ${id}): ${message}`);
    },
    onHandled: () => {},
  };
  const hermes = (
    globalThis as {
      HermesInternal?: { hasPromise?: () => boolean; enablePromiseRejectionTracker?: (o: typeof tracking) => void };
    }
  ).HermesInternal;
  // The same question React Native asks before it keeps Hermes' `Promise`
  // (`polyfillPromise.js`): an engine that has the tracker but not the
  // `Promise` in use would be watching promises nobody makes.
  if (hermes?.hasPromise?.() && hermes.enablePromiseRejectionTracker) {
    hermes.enablePromiseRejectionTracker(tracking);
  } else {
    // A `require`, as React Native itself loads this polyfill: the module is
    // only wanted on an engine without a tracker of its own.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('promise/setimmediate/rejection-tracking').enable(tracking);
  }
}
