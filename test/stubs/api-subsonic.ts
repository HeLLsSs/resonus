/**
 * `@/api/subsonic` without the network: the types, and the two things a
 * module under test calls. `getSong` answers out of `songsById`.
 */
import type { Song, SubsonicAuth } from '../../src/api/subsonic';

export const COVER = { thumb: 200, card: 600, full: 1200 } as const;

export const subsonic = {
  /** What `getSong` finds, by id. */
  songsById: new Map<string, Song>(),
  /** Whether ids shaped like the proxy's online tracks count as such. */
  proxyActive: false,
};

export function isOnlineTrackId(id: string | undefined): boolean {
  return subsonic.proxyActive && !!id && (id.startsWith('yt_') || id.startsWith('sc_'));
}

export async function getSong(_auth: unknown, id: string): Promise<Song> {
  const song = subsonic.songsById.get(id);
  if (!song) throw new Error(`no song ${id}`);
  return song;
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function authHeaders(auth: Pick<SubsonicAuth, 'headers'>): Record<string, string> {
  return auth.headers ?? {};
}

export function authParams(auth: SubsonicAuth): URLSearchParams {
  const base = { u: auth.username, v: '1.16.1', c: 'Resonuls', f: 'json' };
  if (auth.password !== undefined) return new URLSearchParams({ ...base, p: `enc:${auth.password}` });
  return new URLSearchParams({ ...base, t: auth.token, s: auth.salt });
}
