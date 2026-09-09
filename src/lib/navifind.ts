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
