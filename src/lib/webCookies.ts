/**
 * The WebView's cookie jar, as seen from JS (native module `WebCookies`).
 *
 * A cookie that authenticates anybody is HttpOnly, which is exactly what stops
 * script inside the page from reading it: `document.cookie` answers with the
 * few that are not, and the result looks plausible enough to be sent somewhere
 * and fail. The jar is not bound by that rule, and only native code can open
 * it, hence the module.
 *
 * Without it — another platform, a build that predates it — there is nothing
 * to read and nothing to empty, and `available` is what the screens ask before
 * offering a sign-in that could not work.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

const native = requireOptionalNativeModule<{
  read: (url: string) => string | null;
  clear: () => Promise<void>;
}>('WebCookies');

/** Whether this build can read a cookie jar at all. Fixed for the life of the
 *  process: it is a question about the build, not about the jar. */
export const webCookiesAvailable = native !== null;

/**
 * The whole `Cookie` header a browser would send to that address, HttpOnly
 * included, or null where there is none. Never log what comes back: it is the
 * session itself.
 */
export function readWebCookie(url: string): string | null {
  if (!native) return null;
  try {
    return native.read(url) || null;
  } catch {
    return null;
  }
}

/** Empties the jar, so what follows starts from nothing and what came before is
 *  not left lying on the phone. */
export async function clearWebCookies(): Promise<void> {
  try {
    await native?.clear();
  } catch {
    // Nothing to empty is the same outcome as an empty jar.
  }
}
