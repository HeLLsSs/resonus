/**
 * How a song list the screen already holds is ordered and narrowed.
 *
 * Pure functions, kept apart from `useSongSort` so that what an order means can
 * be tested without a React tree: the hook is where the choice is remembered
 * and drawn, this is what the choice does to the list. `librarySort` is the
 * same arrangement for the lists of albums, artists and playlists.
 */
import type { Song } from '@/api/subsonic';

/** What a list of songs can be ordered by (see `useSongSort`). */
export type SongSortField =
  | 'recent'
  | 'added'
  | 'date'
  | 'alpha'
  | 'artist'
  | 'album'
  | 'year'
  | 'duration'
  | 'plays'
  | 'rating'
  | 'downloaded';

export type SongSortDir = 'asc' | 'desc';

/**
 * The narrowings a list can be put under while you are looking at it.
 *
 * Deliberately two, and deliberately throwaway. The durable rule-based version
 * of this idea already exists and is a different thing with a different name
 * (`smartPlaylists`): these are for "just the ones I have with me", asked and
 * answered in the same minute.
 */
export type SongFilter = 'downloaded' | 'favorites';

/** What the screen knows about these songs that they do not carry themselves. */
export interface SongListState {
  /** Which ones have a file on the phone (`useDownloads().files`). */
  files?: Record<string, string>;
  /**
   * Which ones are favorites. A song carries `starred` as well, but the detail
   * endpoints go stale the moment a heart is tapped (see `useFavoriteIds`), so
   * the central set wins wherever the screen has it.
   */
  favoriteIds?: Set<string>;
}

/** A song and where it sits in the list it came from. */
export interface SongEntry {
  song: Song;
  /** Its index in the source list, which is what "remove from this playlist"
   *  and the rest of the actions on a row are addressed by. */
  index: number;
}

/** A server's date string or the phone's own millisecond stamp, as a time. */
function whenMs(value: string | number | undefined): number | null {
  if (value == null) return null;
  const at = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * What a field compares, or null when the song does not carry it.
 *
 * Zero is not an answer for most of these: an untagged file reads as year 0 and
 * a song nobody rated as rating 0, and neither is a fact about the song. Play
 * count is the exception, because zero plays is something the server does know,
 * and "never played" is a real place at the bottom of a most-played list.
 *
 * `created` is when the server first saw the file; offline there is no server
 * and the phone's own `addedAt` says the same thing. The same reading a smart
 * playlist's "added" rule takes.
 */
function valueOf(song: Song, field: SongSortField): number | null {
  switch (field) {
    case 'date':
      return whenMs(song.created ?? song.addedAt);
    case 'year':
      return song.year || null;
    case 'duration':
      return song.duration || null;
    case 'plays':
      return song.playCount ?? null;
    case 'rating':
      return song.userRating || null;
    default:
      return null;
  }
}

/**
 * The way round an order reads before anybody flips it: newest, most and best
 * first, the rest forwards. The same choice a smart playlist makes, and for the
 * same reason — "most played" opening on the songs nobody has played is not an
 * answer to what was asked.
 */
export function naturalSongDir(field: SongSortField): SongSortDir {
  return field === 'date' || field === 'year' || field === 'plays' || field === 'rating'
    ? 'desc'
    : 'asc';
}

/** Whether a song survives a quick filter. */
export function keepsSong(song: Song, filter: SongFilter, state: SongListState = {}): boolean {
  if (filter === 'downloaded') return !!state.files?.[song.id];
  return state.favoriteIds ? state.favoriteIds.has(song.id) : !!song.starred;
}

/**
 * The list as it should be seen: narrowed first, then ordered, each entry still
 * knowing where it came from.
 *
 * A song that does not carry what the order compares goes to the end, whichever
 * way the order runs. The alternative is to count it as zero, which is what the
 * smart playlists do because there the list is built once and read; here the
 * direction is a button, and flipping it to see the oldest first should not
 * hand over a screenful of files whose date nobody ever knew.
 */
export function arrangeSongs(
  songs: Song[],
  sort: { field: SongSortField; dir: SongSortDir },
  filter: SongFilter | null = null,
  state: SongListState = {},
): SongEntry[] {
  const { field, dir } = sort;
  const entries: SongEntry[] = [];
  songs.forEach((song, index) => {
    if (!filter || keepsSong(song, filter, state)) entries.push({ song, index });
  });

  // 'recent' is the order the list arrived in, 'added' its reverse. Neither
  // compares anything, so turning them round is the whole of what direction
  // does. 'added' means "last in the list, first on screen", which is a real
  // order in a playlist the server appends to and nothing anywhere else: the
  // order by date is 'date', and it is a different question.
  if (field === 'recent' || field === 'added') {
    const backwards = field === 'added';
    if (backwards !== (dir === 'desc')) entries.reverse();
    return entries;
  }

  // Direction goes on the key being compared and not on the whole comparison,
  // so a tie-break never runs backwards: albums listed Z-A still play in disc
  // and track order inside each one.
  const sign = dir === 'asc' ? 1 : -1;
  const cmp = (a?: string, b?: string) => (a ?? '').localeCompare(b ?? '');
  const byTitle = (a: SongEntry, b: SongEntry) => cmp(a.song.title, b.song.title);

  if (field === 'alpha') {
    entries.sort((a, b) => sign * byTitle(a, b));
  } else if (field === 'artist') {
    entries.sort((a, b) => sign * cmp(a.song.artist, b.song.artist) || byTitle(a, b));
  } else if (field === 'album') {
    // albumId separates same-name albums from different artists; disc before
    // track because in multi-disc albums `track` values repeat per disc, and
    // without that key the songs interleave "randomly".
    entries.sort(
      (a, b) =>
        sign * cmp(a.song.album, b.song.album) ||
        cmp(a.song.albumId, b.song.albumId) ||
        (a.song.discNumber ?? 0) - (b.song.discNumber ?? 0) ||
        (a.song.track ?? 0) - (b.song.track ?? 0) ||
        byTitle(a, b),
    );
  } else if (field === 'downloaded') {
    // Downloaded first, keeping the order the list already had inside each
    // group (the sort is stable); descending sends them to the bottom.
    const files = state.files ?? {};
    entries.sort((a, b) => sign * ((files[a.song.id] ? 0 : 1) - (files[b.song.id] ? 0 : 1)));
  } else {
    // Keys worked out once per song rather than inside the comparator, which
    // asks for them about 2·n·log n times and would parse every date again on
    // each one (#50).
    const keyed = entries.map((entry) => ({ entry, key: valueOf(entry.song, field) }));
    keyed.sort(
      (a, b) =>
        (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) ||
        sign * ((a.key ?? 0) - (b.key ?? 0)) ||
        byTitle(a.entry, b.entry),
    );
    return keyed.map((k) => k.entry);
  }
  return entries;
}
