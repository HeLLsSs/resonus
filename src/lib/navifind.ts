import type { Song } from '@/api/subsonic';

/**
 * Whether the navifind features are switched on for the profile in use.
 *
 * navifind is a proxy in front of Navidrome that answers searches with tracks
 * it can fetch from the web and copies them into the library once heard
 * (see `api/subsonic.ts`). None of that exists on an ordinary server, and an
 * app that showed badges, menu entries and a settings page for it would be
 * showing them for nothing. So everything of the proxy's hangs off one
 * setting, off unless somebody turns it on, and this flag is that setting
 * mirrored where the lowest layers can read it without reaching up into the
 * settings store: the API module reads it on every track it takes in, and a
 * store importing a store that imports the API is a circle nothing should
 * start.
 */
let active = false;

export function navifindActive(): boolean {
  return active;
}

/** Set by the settings store, on hydration and on every change. */
export function setNavifindActive(value: boolean): void {
  active = value;
}

/**
 * The folder the proxy files its imports under, at the root of the library:
 * `Navifind/<artist>/<artist> - <title>.m4a`. The tags are no guide, since a
 * track whose source named its album keeps that album, so the path is the one
 * mark every import carries.
 */
const IMPORT_FOLDER = /(^|\/)Navifind\//;

/**
 * Whether a library song was put there by the proxy after being listened to.
 * The path comes relative to the music folder over Subsonic and may carry the
 * folder on disk in front of it over Navidrome's own API, hence a segment
 * anywhere rather than a prefix.
 */
export function isImportedByNavifind(song: Pick<Song, 'path'>): boolean {
  return !!song.path && IMPORT_FOLDER.test(song.path);
}
