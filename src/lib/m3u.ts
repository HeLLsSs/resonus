/**
 * Playlists as M3U8 files, out and back in.
 *
 * A playlist lives on the server and nowhere else, so moving one to another
 * server, or keeping a copy that outlives the account, means writing it down
 * as something every player reads, and M3U is that. The file carries what a
 * player expects (`#EXTINF` and a path per song) plus a comment line with the
 * server's id, so a file that comes back to the same server lands on the
 * exact songs rather than on a search for them. Symfonium does the same with
 * its own tag, and players that know neither skip both as comments.
 *
 * Reading one is the reverse, with the guesswork that entails: the id first,
 * then the path, then the artist and title, and an honest list of what none
 * of those found.
 */
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { createPlaylist, reorderPlaylist, searchSongs } from '@/api/data';
import { getSong, isOnlineTrackId, type Song } from '@/api/subsonic';
import { tg } from '@/i18n';
import { clearExportCache } from '@/lib/exportSong';
import { useAuthStore } from '@/store/auth';
import { useToast } from '@/store/toast';

/**
 * A song as the server sends it. The path is in every `getPlaylist` and
 * `search3` entry, the app just never had a reader for it until this one.
 */
type ServerSong = Song & { path?: string };

export interface M3uEntry {
  /** The path or URL on the entry's own line, as written. */
  location: string;
  seconds?: number;
  artist?: string;
  title?: string;
  album?: string;
  /** The server id from our own comment line, when the file came from us. */
  id?: string;
}

export interface ParsedM3u {
  /** From `#PLAYLIST:`, which not every writer includes. */
  name?: string;
  entries: M3uEntry[];
  /** The file went on past `MAX_ENTRIES` and the rest was not read. */
  truncated: boolean;
}

export interface M3uImportResult {
  name: string;
  /** Absent when nothing in the file was found: no empty playlist for that. */
  playlistId?: string;
  found: number;
  total: number;
  /** What the file called the entries nothing matched, in file order. */
  unresolved: string[];
  truncated: boolean;
}

/**
 * Where reading stops. Every entry costs up to two searches, and a playlist
 * longer than this is a library, not something to rebuild from a text file.
 */
export const MAX_ENTRIES = 500;

/**
 * The most a picked file may weigh. The picker takes any file, and the text
 * of the one chosen is read whole into memory: a playlist of `MAX_ENTRIES`
 * lines is a few hundred KB at the very most, and a video or a backup picked
 * by mistake is what this keeps out of the JS heap.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Searches running at once. Enough to hide the latency, not enough to be a flood. */
const IN_FLIGHT = 4;

/** Folder the song export shares files from; Clear cache empties it too. */
function exportDir(): Directory {
  return new Directory(Paths.cache, 'export');
}

/** A name a filesystem takes: the same set the song export strips. */
function fileName(name: string): string {
  return (
    name
      .replace(/[/\\]/g, '-')
      .replace(/[:*?"<>|]/g, '')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 100) || 'playlist'
  );
}

/** One line of text, since every M3U field is one. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** `Artist - Title` split on the first dash, the way every writer joins them. */
function splitArtistTitle(text: string): { artist?: string; title?: string } {
  const at = text.indexOf(' - ');
  if (at < 0) return { title: text || undefined };
  return { artist: text.slice(0, at).trim() || undefined, title: text.slice(at + 3).trim() || undefined };
}

// ── Writing ──

/**
 * Where the file says the song is. The server's own path when it sent one,
 * else something shaped like a path so a player that goes by folders has a
 * fair chance: `Artist/Album/Title.ext`.
 */
function locationOf(song: ServerSong): string {
  if (song.path) return song.path;
  const segment = (text: string) => oneLine(text).replace(/[/\\]/g, '-') || 'Unknown';
  return `${segment(song.artist ?? '')}/${segment(song.album ?? '')}/${segment(song.title)}.${song.suffix ?? 'mp3'}`;
}

/** The whole file, as text. `-1` is what M3U says for a duration it lacks. */
export function serialiseM3u(name: string, songs: Song[]): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${oneLine(name)}`];
  for (const song of songs) {
    const artist = song.artist ? `${oneLine(song.artist)} - ` : '';
    lines.push(`#EXTINF:${Math.round(song.duration ?? -1)},${artist}${oneLine(song.title)}`);
    if (song.album) lines.push(`#EXTALB:${oneLine(song.album)}`);
    lines.push(`#RESONUS:id=${song.id}`);
    lines.push(locationOf(song));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Writes the playlist to the cache and hands it to another app through the
 * share sheet. False when the device has no share sheet to open, which is
 * the caller's message to give; the sheet being dismissed is not a failure.
 */
export async function shareM3u(name: string, songs: Song[]): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  // Same folder and same rule as the song copies: one share sheet per file,
  // and the previous one goes when the next one is written.
  clearExportCache();
  const dir = exportDir();
  dir.create({ intermediates: true });
  const file = new File(dir, `${fileName(name)}.m3u8`);
  file.write(serialiseM3u(name, songs));
  await Sharing.shareAsync(file.uri, {
    mimeType: 'audio/x-mpegurl',
    UTI: 'public.m3u-playlist',
  });
  return true;
}

// ── Reading ──

/**
 * Reads an M3U or M3U8. Tolerant on purpose: `#EXTINF` is optional, CRLF and
 * a BOM are common, and any comment it does not know is somebody else's.
 */
export function parseM3u(text: string): ParsedM3u {
  const entries: M3uEntry[] = [];
  let name: string | undefined;
  let truncated = false;
  /** Tags read since the last entry line; they describe the next one. */
  let pending: Omit<M3uEntry, 'location'> = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      // `#EXTINF:225,Artist - Title`, sometimes with attributes before the
      // comma (`#EXTINF:225 tvg-id="x",Title`), which is why the comma and
      // not the number is what ends the first part.
      const inf = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)?[^,]*,(.*)$/i.exec(line);
      if (inf) {
        const seconds = inf[1] === undefined ? Number.NaN : Number(inf[1]);
        pending = {
          ...pending,
          seconds: seconds >= 0 ? Math.round(seconds) : undefined,
          ...splitArtistTitle(inf[2].trim()),
        };
        continue;
      }
      const tag = /^#(PLAYLIST|EXTALB|RESONUS):\s*(.*)$/i.exec(line);
      if (!tag) continue;
      const value = tag[2].trim();
      switch (tag[1].toUpperCase()) {
        case 'PLAYLIST':
          name = value || name;
          break;
        case 'EXTALB':
          pending.album = value || undefined;
          break;
        default: {
          const id = /^id=(.+)$/.exec(value);
          if (id) pending.id = id[1].trim();
        }
      }
      continue;
    }
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ location: line, ...pending });
    pending = {};
  }
  return { name, entries, truncated };
}

/**
 * Opens the system picker on any file and returns the text of the one chosen
 * along with its name without the extension, or null when nobody chose.
 * Any file rather than a MIME type: a `.m3u8` is `audio/x-mpegurl` on one
 * phone and `application/octet-stream` on the next, and a file manager that
 * hides it is worse than one that shows a bit too much.
 */
export async function pickM3uFile(): Promise<{ name: string; text: string } | null> {
  const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
  if (picked.canceled) return null;
  const asset = picked.assets[0];
  if (!asset) return null;
  const file = new File(asset.uri);
  // Weighed before it is read. The size comes with the pick where the
  // picker knows it, and from the copy in the cache otherwise. Said here as
  // a toast and answered as "nobody chose": the import only knows that the
  // pick failed, and "couldn't read the file" would send someone looking for
  // a permission problem that is not there.
  if ((asset.size ?? file.size ?? 0) > MAX_FILE_BYTES) {
    useToast.getState().show(tg('That file is too big to be a playlist.'));
    return null;
  }
  const text = await file.text();
  return { name: asset.name.replace(/\.m3u8?$/i, ''), text };
}

/**
 * A path as something two writers would agree on: forward slashes, lower
 * case, no scheme, drive letter or leading `./`, and decoded when it was
 * written as a URL. Compared by suffix afterwards, because the file's root
 * (`/music/`, `D:\`) is the writer's and the server's path starts under it.
 */
function normalisePath(location: string): string {
  let path = location.trim();
  if (path.includes('%')) {
    try {
      path = decodeURIComponent(path);
    } catch {
      // Not URL-encoded after all: a literal percent sign stays as written.
    }
  }
  return path
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/^[a-z]:/i, '')
    .replace(/^(\.{1,2}\/)+/, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

/** `Artist/Album/Song.mp3` to `Song.mp3`. */
function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? '';
}

function withoutExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, '');
}

/** Same song, spelt differently: case, accents and punctuation set aside. */
function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The library's answer to a query. A proxy that adds online tracks to a
 * search puts them in the same list; they are not in the library and have
 * no path, so they are not what a playlist file can point at.
 */
async function libraryHits(query: string): Promise<ServerSong[]> {
  const hits: ServerSong[] = await searchSongs(query, 5);
  return hits.filter((song) => !isOnlineTrackId(song.id));
}

/** The exact song, when the file came from this server and it still has it. */
async function byId(entry: M3uEntry): Promise<Song | null> {
  const auth = useAuthStore.getState().auth;
  // Only the Subsonic client has `getSong`; a Jellyfin id would be asked of
  // an endpoint it lacks.
  if (!entry.id || !auth || auth.serverType === 'jellyfin') return null;
  try {
    return await getSong(auth, entry.id);
  } catch {
    return null;
  }
}

/** The song whose path on the server ends the way the file's path does. */
async function byPath(entry: M3uEntry): Promise<Song | null> {
  const wanted = normalisePath(entry.location);
  const query = withoutExtension(baseName(wanted));
  if (!query) return null;
  const hits = await libraryHits(query);
  return (
    hits.find((song) => {
      if (!song.path) return false;
      const path = normalisePath(song.path);
      return path === wanted || path.endsWith(`/${wanted}`) || wanted.endsWith(`/${path}`);
    }) ?? null
  );
}

/**
 * The song with that title, by that artist when the file names one. Without
 * `#EXTINF` the file name is what there is, and most of them are
 * `Artist - Title.ext`. The title decides and the artist ranks: a title
 * match by another artist is still more likely the song than nothing.
 */
async function byName(entry: M3uEntry): Promise<Song | null> {
  const { artist, title } = entry.title
    ? entry
    : splitArtistTitle(withoutExtension(baseName(entry.location)));
  if (!title) return null;
  const wantedTitle = normalise(title);
  const wantedArtist = artist ? normalise(artist) : '';
  const hits = (await libraryHits(`${artist ?? ''} ${title}`.trim())).filter(
    (song) => normalise(song.title) === wantedTitle,
  );
  if (!wantedArtist) return hits[0] ?? null;
  return (
    hits.find(
      (song) =>
        normalise(song.artist ?? '') === wantedArtist ||
        song.artists?.some((a) => normalise(a.name) === wantedArtist),
    ) ??
    hits[0] ??
    null
  );
}

async function resolveEntry(entry: M3uEntry): Promise<Song | null> {
  return (await byId(entry)) ?? (await byPath(entry)) ?? (await byName(entry));
}

/** What the summary calls an entry nothing matched. */
function labelOf(entry: M3uEntry): string {
  if (entry.title) return entry.artist ? `${entry.artist} - ${entry.title}` : entry.title;
  return baseName(entry.location) || entry.location;
}

/** `Promise.all` with at most `limit` calls running, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Finds every entry on the server and makes the playlist out of the ones it
 * found, in the file's order. The name is the file's `#PLAYLIST:` when it
 * has one, else what the file was called. A search that fails outright is
 * thrown, not counted as "not found": a server that is down should not read
 * as a file full of songs it does not have.
 */
export async function importM3u(text: string, fallbackName: string): Promise<M3uImportResult> {
  const parsed = parseM3u(text);
  const name = parsed.name ?? fallbackName;
  const songs = await mapLimit(parsed.entries, IN_FLIGHT, resolveEntry);
  const ids = songs.flatMap((song) => (song ? [song.id] : []));
  const unresolved = parsed.entries.filter((_, i) => !songs[i]).map(labelOf);
  let playlistId: string | undefined;
  if (ids.length > 0) {
    playlistId = await createPlaylist(name);
    // The whole list in one request rather than one per song: Subsonic's
    // "reorder" rewrites the entries, and a new playlist has none to lose.
    await reorderPlaylist(playlistId, ids);
  }
  return {
    name,
    playlistId,
    found: ids.length,
    total: parsed.entries.length,
    unresolved,
    truncated: parsed.truncated,
  };
}
