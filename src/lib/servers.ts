/**
 * Reading from more than one server at a time.
 *
 * The app has always had several profiles and shown one of them: signing in to
 * the second means leaving the first. That is the right default — a library is
 * a place, and most of the time you are in one of them — but it makes the one
 * question nobody can answer "which of my servers has this album?".
 *
 * So a search may go to every server at once. What comes back has to say where
 * it came from, or playing it would ask the wrong server for a track it has
 * never heard of: an id from another profile is wrapped, exactly as a file on a
 * WebDAV share is (`store/webdav`), with the profile that answered. Unwrapping
 * it gives back the id the server itself used, which is what every request has
 * to carry.
 *
 * **The wrapping is the whole design.** Everything downstream — the stream URL,
 * the cover, the row somebody taps — asks `parseForeign` first and uses that
 * profile's credentials instead of the active one's. Nothing else in the app
 * needs to know that more than one server exists, and anything that has not
 * been taught keeps working on the active profile alone, because an id without
 * the prefix is exactly what it always was.
 */
import { type SubsonicAuth } from "@/api/subsonic";
import { hashKey } from "@/lib/localLibrary";
import { primaryUrl } from "@/lib/serverUrls";
import { useAuthStore, type ServerProfile } from "@/store/auth";

const PREFIX = "srv:";

/**
 * How a profile is named inside an id. The same thing `profileScopeId` makes a
 * scope from — the primary URL and the username — hashed, because an id ends
 * up in a queue, a history entry and a media session, and none of those is a
 * place to put somebody's server address.
 */
export function serverKey(
  auth: Pick<SubsonicAuth, "urls" | "serverUrl" | "scopeUrl" | "username">,
): string {
  return hashKey(`${primaryUrl(auth)}|${auth.username}`);
}

/** Wraps an id (song, album, artist, cover) with the server it belongs to.
 *  An id already wrapped is left alone, so tagging twice is harmless. */
export function foreignId(key: string, id: string): string {
  return id.startsWith(PREFIX) ? id : `${PREFIX}${key}|${id}`;
}

/** The server and the server's own id behind a wrapped one, or null when the
 *  id belongs to the active profile and never needed wrapping. */
export function parseForeign(
  id: string | undefined,
): { key: string; id: string } | null {
  if (!id?.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const at = rest.indexOf("|");
  if (at < 0) return null;
  return { key: rest.slice(0, at), id: rest.slice(at + 1) };
}

/** The profile an id belongs to, or undefined if that profile is gone —
 *  forgotten between the search and the tap, which has to be survivable. */
export function authForKey(key: string): SubsonicAuth | undefined {
  return serverProfiles().find((p) => serverKey(p) === key);
}

/**
 * Everything a wrapped id needs at once: whose it is, and what it is called
 * there. Null for an ordinary id, which is the common case and must stay the
 * cheap one.
 */
export function foreignSource(
  id: string | undefined,
): { auth: SubsonicAuth; id: string } | null {
  const parsed = parseForeign(id);
  if (!parsed) return null;
  const auth = authForKey(parsed.key);
  return auth ? { auth, id: parsed.id } : null;
}

/** Every signed-in server profile, in the order they are shown. */
export function serverProfiles(): ServerProfile[] {
  return useAuthStore
    .getState()
    .profiles.filter((p): p is ServerProfile => p._type === "server");
}

/** The servers that are not the one signed in. Empty when there is only one,
 *  which is what makes searching everywhere cost nothing for most people. */
export function otherServers(): ServerProfile[] {
  const active = useAuthStore.getState().auth;
  if (!active) return [];
  const mine = serverKey(active);
  return serverProfiles().filter((p) => serverKey(p) !== mine);
}

/**
 * What to call a server in a list of results. A profile has no name of its own
 * — it is an address and a username — so the host is the label, and the
 * username joins it only when two profiles share a host, which is the one case
 * where the host alone would name two different libraries.
 */
export function serverLabel(auth: SubsonicAuth): string {
  let host: string;
  try {
    host = new URL(primaryUrl(auth)).hostname;
  } catch {
    return auth.username;
  }
  const shared = serverProfiles().filter((p) => {
    try {
      return new URL(primaryUrl(p)).hostname === host;
    } catch {
      return false;
    }
  });
  return shared.length > 1 ? `${host} (${auth.username})` : host;
}
