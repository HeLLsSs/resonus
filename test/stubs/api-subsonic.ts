/**
 * `@/api/subsonic` without the network: the types, and the two things a
 * module under test calls. `getSong` answers out of `songsById`.
 */
import type { Song } from '../../src/api/subsonic';

export const COVER = { thumb: 200, card: 600, full: 1200 } as const;

export const subsonic = {
  /** What `getSong` finds, by id. */
  songsById: new Map<string, Song>(),
};

export async function getSong(_auth: unknown, id: string): Promise<Song> {
  const song = subsonic.songsById.get(id);
  if (!song) throw new Error(`no song ${id}`);
  return song;
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
