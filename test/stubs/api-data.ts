/**
 * `@/api/data` with every request answered from `data`, which a test fills
 * in. Calls are written down in `data.calls` so a test can say what was
 * asked of the server, not only what came back.
 */
import type { Album, Genre, Song } from '../../src/api/subsonic';

export const COVER = { thumb: 200, card: 600, full: 1200 } as const;
export const CACHED_COVER = 'cached-cover:';

export const data = {
  calls: [] as { name: string; args: unknown[] }[],
  /** `searchSongs` answers with these, whatever the query. */
  searchResults: [] as Song[],
  /** `getSimilarSongs` and `getRandomSongs` answer with these. */
  similar: [] as Song[],
  random: [] as Song[],
  albums: new Map<string, { album: Album; songs: Song[] }>(),
  starred: [] as Song[],
  /** Handed back by `createPlaylist`. */
  nextPlaylistId: 'pl-new',
  /** When set, every request rejects with it. */
  failure: null as Error | null,
  reset(): void {
    this.calls = [];
    this.searchResults = [];
    this.similar = [];
    this.random = [];
    this.albums.clear();
    this.starred = [];
    this.nextPlaylistId = 'pl-new';
    this.failure = null;
  },
};

async function call<T>(name: string, args: unknown[], answer: () => T): Promise<T> {
  data.calls.push({ name, args });
  if (data.failure) throw data.failure;
  return answer();
}

export function searchSongs(query: string, count?: number): Promise<Song[]> {
  return call('searchSongs', [query, count], () => data.searchResults.slice(0, count));
}

export function getSimilarSongs(id: string, count?: number): Promise<Song[]> {
  return call('getSimilarSongs', [id, count], () => data.similar.slice(0, count));
}

export function getRandomSongs(size: number, genre?: string, years?: { fromYear?: number; toYear?: number }): Promise<Song[]> {
  return call('getRandomSongs', [size, genre, years], () => data.random.slice(0, size));
}

export function getAlbum(id: string): Promise<{ album: Album; songs: Song[] }> {
  return call('getAlbum', [id], () => {
    const hit = data.albums.get(id);
    if (!hit) throw new Error(`no album ${id}`);
    return hit;
  });
}

export function getArtist(id: string): Promise<{ artist: { id: string; name: string }; albums: Album[] }> {
  return call('getArtist', [id], () => ({ artist: { id, name: '' }, albums: [] }));
}

export function getTopSongs(artist: string, count?: number): Promise<Song[]> {
  return call('getTopSongs', [artist, count], () => []);
}

export function getPlaylist(id: string): Promise<{ playlist: { id: string; name: string }; songs: Song[] }> {
  return call('getPlaylist', [id], () => ({ playlist: { id, name: '' }, songs: [] }));
}

export function getStarred(): Promise<{ songs: Song[]; albums: Album[]; artists: unknown[] }> {
  return call('getStarred', [], () => ({ songs: data.starred, albums: [], artists: [] }));
}

export function createPlaylist(name: string): Promise<string> {
  return call('createPlaylist', [name], () => data.nextPlaylistId);
}

export function reorderPlaylist(id: string, songIds: string[]): Promise<void> {
  return call('reorderPlaylist', [id, songIds], () => undefined);
}

/** A cover already in the cache keeps its prefix, the way the app hands it back offline. */
export function coverArtUrl(id: string | undefined, _size?: number): string | undefined {
  if (!id) return undefined;
  return id.startsWith(CACHED_COVER) ? id : `https://covers.test/${id}`;
}

export function songCoverUrl(song: Song, size?: number): string | undefined {
  return coverArtUrl(song.coverArt ?? song.albumId, size);
}

export function getGenres(): Promise<Genre[]> {
  return call('getGenres', [], () => []);
}
