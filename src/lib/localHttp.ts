/**
 * The phone as a source a renderer can fetch from (native module
 * `modules/local-http`).
 *
 * A UPnP renderer is not sent audio, it is sent a URL and goes and gets it. A
 * song on a server has one; a song on the phone is a `content://` nothing else
 * on the network can open, which is the whole reason casting the phone's own
 * music did nothing. This publishes the files under short keys and hands back
 * URLs pointing at this phone.
 *
 * The same door relays a server URL for a profile whose server wants extra
 * headers (`SubsonicAuth.headers`): a renderer cannot be told to send them, so
 * it is told to fetch from the phone, which fetches from the server with them
 * on. The headers stay on the phone; what the network sees is a key.
 *
 * Only up while casting. Keys are the app's, not the ids: a local song's id is
 * its own file URI, and putting that in a URL would be handing the network the
 * layout of somebody's storage.
 */
import * as Crypto from 'expo-crypto';
import { requireOptionalNativeModule } from 'expo-modules-core';

const native = requireOptionalNativeModule('LocalHttp');

export const localHttpAvailable = !!native;

/** Where the server can be reached, while it is up. */
let origin: string | null = null;
/** file URI or server URL → the key it is published under, so republishing is stable. */
const keys = new Map<string, string>();

/** A file on the phone, or a server URL to fetch from here with headers on. */
export type Served =
  | { uri: string; mime: string }
  | { url: string; headers: Record<string, string> };

/**
 * Random from end to end. The port is open to the whole network for as long
 * as the cast lasts, and the key is the only thing between it and the file:
 * a counter with a few characters after it was a guess away from the next
 * one.
 */
function keyFor(uri: string): string {
  const known = keys.get(uri);
  if (known) return known;
  const key = Crypto.randomUUID();
  keys.set(uri, key);
  return key;
}

/**
 * Starts the server if needed and publishes these, answering whether there is
 * somewhere to fetch them from. False when there is no native module (another
 * platform, an older build) or no address on the network.
 */
export async function publishLocalFiles(files: Served[]): Promise<boolean> {
  if (!native || files.length === 0) return false;
  try {
    // Idempotent on the native side: an already started server answers where it
    // already is.
    origin = ((await native.start()) as string | null) ?? null;
    if (!origin) return false;
    native.setEntries(
      JSON.stringify(
        files.map((f) =>
          'uri' in f
            ? { key: keyFor(f.uri), uri: f.uri, mime: f.mime }
            : { key: keyFor(f.url), url: f.url, headers: f.headers },
        ),
      ),
    );
    return true;
  } catch {
    origin = null;
    return false;
  }
}

/** The URL for a file already published, or undefined if it is not. */
export function localFileUrl(uri: string | undefined): string | undefined {
  if (!uri || !origin) return undefined;
  const key = keys.get(uri);
  return key ? `${origin}/${key}` : undefined;
}

/** The phone's address for a server URL already published for relaying, or
 *  undefined if it is not. The same lookup as `localFileUrl`, named for what
 *  it is handed. */
export function relayedUrl(url: string | undefined): string | undefined {
  return localFileUrl(url);
}

/** Closes the port and forgets the keys. Called when the cast ends. */
export async function stopLocalHttp(): Promise<void> {
  if (!native) return;
  origin = null;
  keys.clear();
  try {
    await native.stop();
  } catch {
    // Nothing to do about it: the session is over either way.
  }
}
