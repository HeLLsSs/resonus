/**
 * How much of the listening came through the navifind proxy, for the stats
 * screen's YouTube section.
 *
 * Pure: the screen hands over one row per song heard in the period (from
 * `statsDb.queryPlaysBySong`) and the songs the proxy filed into the library
 * (from `importedFromNavifind`), and gets the totals back.
 *
 * A listen counts as YouTube's when the song was an online track at the time
 * (a `yt_` or `sc_` id) or is one the proxy filed into the library. The log
 * keeps no path, so a filed song is only recognised by its id being among the
 * filed songs the screen could list (the latest arrivals); a filed song older
 * than that counts as one of the library's own.
 */
import { isOnlineTrackId, type Song } from '@/api/subsonic';

/** One song heard in the period, with how many times. */
export interface SongPlayRow {
  songId: string;
  artist: string | null;
  artistId: string | null;
  plays: number;
}

export interface DiscoveredArtist {
  id?: string;
  name: string;
  plays: number;
}

export interface YoutubeListening {
  /** Listens of online or filed songs. */
  plays: number;
  /** Their share of every listen in the period, from 0 to 1. */
  share: number;
  /** The artists heard only through the proxy, most played first. */
  discovered: DiscoveredArtist[];
}

/** How many discovered artists the screen shows. */
const TOP = 5;

export function youtubeListening(
  rows: readonly SongPlayRow[],
  filedIds: ReadonlySet<string>,
): YoutubeListening {
  let total = 0;
  let plays = 0;
  // Grouped like the screen's top artists: by id where there is one, by name
  // where there is not.
  const artists = new Map<string, DiscoveredArtist & { onlyYoutube: boolean }>();
  for (const row of rows) {
    const fromYoutube = isOnlineTrackId(row.songId) || filedIds.has(row.songId);
    total += row.plays;
    if (fromYoutube) plays += row.plays;
    const key = row.artistId ?? row.artist ?? '';
    const artist = artists.get(key);
    if (artist) {
      artist.plays += row.plays;
      artist.onlyYoutube &&= fromYoutube;
      if (!artist.id && row.artistId) artist.id = row.artistId;
    } else {
      artists.set(key, {
        id: row.artistId ?? undefined,
        name: row.artist ?? '',
        plays: row.plays,
        onlyYoutube: fromYoutube,
      });
    }
  }
  const discovered = [...artists.values()]
    .filter((a) => a.onlyYoutube && a.name)
    .sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name))
    .slice(0, TOP)
    .map(({ id, name, plays: n }) => ({ id, name, plays: n }));
  return { plays, share: total === 0 ? 0 : plays / total, discovered };
}

/**
 * The filed songs that arrived in the period, by the date the server first saw
 * them. A song without one cannot be placed and only counts for all time.
 */
export function filedSince<T extends Pick<Song, 'created'>>(songs: readonly T[], sinceMs: number | null): T[] {
  if (sinceMs === null) return [...songs];
  return songs.filter((s) => {
    const at = s.created ? Date.parse(s.created) : NaN;
    return at >= sinceMs;
  });
}
