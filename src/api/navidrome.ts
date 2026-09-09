/**
 * Minimal Navidrome native API client (non-Subsonic). Only used for what the
 * Subsonic API doesn't cover: custom cover art for playlists (≥ 0.61) and for
 * radio stations, whether a share allows downloading, and listing songs and
 * albums in an order Subsonic has no way to ask for. Requires cleartext
 * username and password to obtain a JWT (`auth.ndPassword`); see SubsonicAuth.
 */
// Not the global `fetch`: it never resolves in the background. See the note
// in `src/api/subsonic.ts`.
import { File, UploadType, type UploadResult } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import { type Album, type Song, type SortDirection, type SubsonicAuth } from './subsonic';
import { assertCanRequest } from './netGate';

/** Typed error to provide useful messages in the UI. */
export class NavidromeError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'forbidden' | 'unsupported' | 'other',
    /**
     * What the server answered, when it answered at all. `kind` covers the ones
     * worth explaining in words; this is for the rest, which otherwise reach the
     * user as "it didn't work" and reach us as a report with nothing in it. A
     * number needs no translating and is the whole difference between guessing
     * and knowing which end is at fault.
     */
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * The JWT for the profile last logged in, so paging through a list is one
 * request per page and not two. Navidrome's tokens outlive this by a long way;
 * half an hour is short enough that nothing has to watch them expire, and a
 * rejected one is thrown away and asked for again (see `ndJson`).
 */
let cached: { key: string; token: string; at: number } | null = null;
const TOKEN_TTL = 30 * 60 * 1000;

function tokenKey(auth: SubsonicAuth): string {
  return `${auth.serverUrl}|${auth.username}`;
}

/** Logs into the native API and returns the JWT. */
async function ndLogin(auth: SubsonicAuth, fresh = false): Promise<string> {
  // `password` is there when the profile authenticates in cleartext, and it is
  // the same password: no reason to ask for it twice.
  const password = auth.ndPassword ?? auth.password;
  if (!password) throw new NavidromeError('Sin contraseña guardada', 'auth');
  const key = tokenKey(auth);
  if (!fresh && cached?.key === key && Date.now() - cached.at < TOKEN_TTL) return cached.token;
  // Offline mode stops here, before the socket (see netGate).
  assertCanRequest();
  let res: Response;
  try {
    res = await fetch(`${auth.serverUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password }),
    });
  } catch {
    throw new NavidromeError('No se pudo conectar con el servidor', 'other');
  }
  if (res.status === 401) throw new NavidromeError('Credenciales incorrectas', 'auth');
  if (!res.ok) throw new NavidromeError(`Error de red (${res.status})`, 'other');
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new NavidromeError('Respuesta inesperada del servidor', 'other');
  cached = { key, token: json.token, at: Date.now() };
  return json.token;
}

/** What an answer from the native API means, for the paths that write. */
function ndStatusError(status: number): NavidromeError {
  if (status === 401) return new NavidromeError('Credenciales incorrectas', 'auth');
  if (status === 403) return new NavidromeError('Subida de carátulas deshabilitada', 'forbidden');
  if (status === 404 || status === 405) {
    return new NavidromeError('El servidor no soporta carátulas', 'unsupported');
  }
  return new NavidromeError(`Error del servidor (${status})`, 'other', status);
}

/** Authenticated request to the native API, with errors mapped to NavidromeError. */
async function ndFetch(auth: SubsonicAuth, path: string, init: RequestInit): Promise<void> {
  const token = await ndLogin(auth, true);
  let res: Response;
  try {
    res = await fetch(`${auth.serverUrl}${path}`, {
      ...init,
      headers: { ...init.headers, 'x-nd-authorization': `Bearer ${token}` },
    });
  } catch {
    throw new NavidromeError('No se pudo conectar con el servidor', 'other');
  }
  if (res.ok) return;
  throw ndStatusError(res.status);
}

/**
 * Lets a share be downloaded, not just listened to.
 *
 * Subsonic's `createShare` takes an id, a description and an expiry and nothing
 * else, so this is the only way to reach that flag. The share is still created
 * through Subsonic, which is what returns the public link the server wants
 * handed out (it honours `ND_SHAREURL`, which we would have no way of guessing);
 * this only edits the one field afterwards.
 *
 * The description goes along because Navidrome writes both columns from what it
 * is sent, so leaving it out would blank the one just set.
 */
export async function setShareDownloadable(
  auth: SubsonicAuth,
  id: string,
  downloadable: boolean,
  description?: string,
): Promise<void> {
  await ndFetch(auth, `/api/share/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadable, description: description ?? '' }),
  });
}

/** What the image belongs to; both live under the same native API shape. */
export type CoverKind = 'playlist' | 'radio';

/**
 * Uploads a local image as the cover art of a playlist or a radio station.
 * Endpoint: POST /api/{kind}/{id}/image, multipart with "image" field
 * (jpeg/png/gif/webp). 403 if upload is disabled or the item doesn't belong
 * to the user; 404 on servers too old for it.
 *
 * The one request in this file that does not go through `ndFetch`, and it is
 * the multipart that decides it. This used to hand `fetch` a `FormData` with
 * React Native's own file part, `{uri, name, type}` — which is not a standard
 * form part at all, only something RN's networking knows how to read off the
 * disk on its way out. Moving off the global `fetch` (see the note at the top)
 * took that away: `expo/fetch` builds the multipart body itself, in JS, from
 * strings and blobs, and a part it cannot read is an exception before anything
 * reaches the network. So changing a cover started failing on every server and
 * every playlist, and the sheet said only that it could not do it — the throw
 * came out of the same `catch` that means the server is unreachable.
 *
 * `File.upload` is the multipart that does exist natively: the file is streamed
 * from disk by the same layer that the rest of the app's transfers use, with
 * nothing buffered in JS, and a completed request comes back as a status
 * whatever that status is.
 */
export async function uploadCoverImage(
  auth: SubsonicAuth,
  kind: CoverKind,
  id: string,
  image: { uri: string; type: string },
): Promise<void> {
  const token = await ndLogin(auth, true);
  let result: UploadResult;
  try {
    result = await new File(image.uri).upload(
      `${auth.serverUrl}/api/${kind}/${encodeURIComponent(id)}/image`,
      {
        httpMethod: 'POST',
        uploadType: UploadType.MULTIPART,
        // The field Navidrome reads the picture out of; the filename comes off
        // the file itself, which the picker has already written with the right
        // extension.
        fieldName: 'image',
        mimeType: image.type,
        headers: { 'x-nd-authorization': `Bearer ${token}` },
      },
    );
  } catch {
    throw new NavidromeError('No se pudo conectar con el servidor', 'other');
  }
  if (result.status < 200 || result.status >= 300) throw ndStatusError(result.status);
}

/** Removes the custom cover art; Navidrome falls back to its own default. */
export async function deleteCoverImage(
  auth: SubsonicAuth,
  kind: CoverKind,
  id: string,
): Promise<void> {
  await ndFetch(auth, `/api/${kind}/${encodeURIComponent(id)}/image`, {
    method: 'DELETE',
  });
}

// ── Listing songs ───────────────────────────────────────────────────────────

/**
 * What Navidrome's REST layer accepts for ordering media files. Subsonic has no
 * endpoint that lists songs in any order at all, and this one sorts and pages
 * like any other list, which is the whole reason to come down here.
 */
export type NdSongSort =
  | 'title'
  | 'album'
  | 'recently_added'
  | 'play_date'
  | 'play_count'
  | 'random';

/**
 * Which way round an order is meant to be read, before anybody says otherwise.
 *
 * A-Z for the ones that read as a list, newest first for the ones about time.
 * `album` is the first kind: it expands, server side, to the album's sort name
 * and then disc and track, so ascending is the record played in order. Only a
 * default: the menu can flip any of them.
 */
export function naturalSongDir(sort: NdSongSort): SortDirection {
  return sort === 'recently_added' || sort === 'play_date' || sort === 'play_count'
    ? 'desc'
    : 'asc';
}

/** The same question for albums: the year, the arrival and the tally read
 *  backwards; the rest are lists and read forwards. */
export function naturalAlbumDir(sort: NdAlbumSort): SortDirection {
  return sort === 'recently_added' || sort === 'max_year' || sort === 'play_count'
    ? 'desc'
    : 'asc';
}

/** The fields of a media file this app has any use for. */
interface NdSong {
  id: string;
  title?: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  trackNumber?: number;
  discNumber?: number;
  year?: number;
  duration?: number;
  suffix?: string;
  bitRate?: number;
  bitDepth?: number;
  sampleRate?: number;
  channels?: number;
  genre?: string;
  comment?: string;
  /**
   * Parental advisory, but in the native model's own shorthand: `"e"` or `"c"`
   * where Subsonic spells out "explicit" and "clean". Translated in `toSong`,
   * so nothing downstream has to know there are two spellings.
   */
  explicitStatus?: string;
  size?: number;
  playCount?: number;
  /** When the server first saw the file, and when this user last played it:
   *  what a smart playlist's "added" and "last played" rules read. */
  createdAt?: string;
  playDate?: string;
  starred?: boolean;
  starredAt?: string;
  rating?: number;
  rgTrackGain?: number;
  rgTrackPeak?: number;
  rgAlbumGain?: number;
  rgAlbumPeak?: number;
}

/**
 * The native model's one-letter advisory into the word Subsonic uses. Anything
 * else, including the empty string a file with no tag arrives with, is left
 * undefined: absent and "not advised either way" are the same thing here.
 */
function spellExplicit(status?: string): string | undefined {
  return status === 'e' ? 'explicit' : status === 'c' ? 'clean' : undefined;
}

/** Native song into the shape the rest of the app speaks (Subsonic's). */
function toSong(m: NdSong): Song {
  const gain = m.rgTrackGain ?? m.rgAlbumGain ?? m.rgTrackPeak ?? m.rgAlbumPeak;
  return {
    id: m.id,
    title: m.title ?? '',
    album: m.album,
    albumId: m.albumId,
    artist: m.artist,
    artistId: m.artistId,
    // Ids are the same ones Subsonic uses here, so the cover, the stream and
    // everything else keep working through the usual endpoints.
    coverArt: m.albumId ?? m.id,
    duration: m.duration,
    track: m.trackNumber,
    discNumber: m.discNumber,
    year: m.year,
    suffix: m.suffix,
    bitRate: m.bitRate,
    bitDepth: m.bitDepth,
    samplingRate: m.sampleRate,
    channelCount: m.channels,
    genre: m.genre,
    comment: m.comment,
    explicitStatus: spellExplicit(m.explicitStatus),
    playCount: m.playCount,
    created: m.createdAt,
    played: m.playDate,
    starred: m.starred ? (m.starredAt ?? new Date().toISOString()) : undefined,
    userRating: m.rating || undefined,
    ...(gain === undefined
      ? {}
      : {
          replayGain: {
            trackGain: m.rgTrackGain,
            albumGain: m.rgAlbumGain,
            trackPeak: m.rgTrackPeak,
            albumPeak: m.rgAlbumPeak,
          },
        }),
  };
}

/** Authenticated GET returning JSON, retrying once with a fresh token. */
async function ndJson<T>(auth: SubsonicAuth, path: string): Promise<T> {
  for (const fresh of [false, true]) {
    const token = await ndLogin(auth, fresh);
    let res: Response;
    try {
      res = await fetch(`${auth.serverUrl}${path}`, {
        headers: { 'x-nd-authorization': `Bearer ${token}` },
      });
    } catch {
      throw new NavidromeError('No se pudo conectar con el servidor', 'other');
    }
    // A token this old server no longer accepts: drop it and ask for another,
    // once. Anything else is an answer, good or bad.
    if (res.status === 401 && !fresh) continue;
    if (res.status === 401) throw new NavidromeError('Credenciales incorrectas', 'auth');
    if (res.status === 403) throw new NavidromeError('Sin permiso', 'forbidden');
    if (res.status === 404) throw new NavidromeError('El servidor no lo soporta', 'unsupported');
    if (!res.ok) throw new NavidromeError(`Error del servidor (${res.status})`, 'other');
    return (await res.json()) as T;
  }
  throw new NavidromeError('Credenciales incorrectas', 'auth');
}

/**
 * A page of the library's songs, ordered by the server.
 *
 * Endpoint: GET /api/song, which takes `_sort`, `_order`, `_start` and `_end`
 * the way every list in Navidrome's own web UI does, plus a `library_id` per
 * library to keep to the ones that are turned on. It pages properly, so an alphabetical listing of a six-figure
 * library costs one page at a time and nothing is pulled onto the phone to be
 * sorted here.
 */
export async function listSongs(
  auth: SubsonicAuth,
  sort: NdSongSort = 'title',
  count = 50,
  offset = 0,
  libraryIds?: string[],
  genreId?: string,
  dir?: SortDirection,
): Promise<Song[]> {
  const order = (dir ?? naturalSongDir(sort)) === 'asc' ? 'ASC' : 'DESC';
  const q = new URLSearchParams({
    _sort: sort,
    _order: order,
    _start: String(offset),
    _end: String(offset + count),
  });
  // Narrowing to one genre is the same list with a filter on it, which is what
  // makes a genre's songs sortable at all: Subsonic's own endpoint for them
  // takes no order, so the only alternative was to sort the page that happened
  // to be loaded and call it alphabetical.
  if (genreId) q.set('genre_id', genreId);
  // Navidrome's own name for what Subsonic calls a music folder, and the ids
  // are the same ones, so a library turned off in the app stays off here.
  // Repeated, one per library: the REST layer turns a parameter given more than
  // once into a list, and the filter becomes an `IN`, so several libraries are
  // still one request and still one sorted list.
  for (const id of libraryIds ?? []) q.append('library_id', id);
  const rows = await ndJson<NdSong[]>(auth, `/api/song?${q.toString()}`);
  return Array.isArray(rows) ? rows.map(toSong) : [];
}

/**
 * What Navidrome's REST layer accepts for ordering albums.
 *
 * Mostly the names its own sort mappings declare, since an unknown one falls
 * through to a column and may well sort by nothing. `play_count` is the
 * exception and it is not a guess: Navidrome's own album table sorts by it
 * (the Play Count column sends `playCount`, which snake-cases to this), so the
 * column is there to be ordered by.
 */
export type NdAlbumSort =
  | 'name'
  | 'artist'
  | 'max_year'
  | 'recently_added'
  | 'play_count'
  | 'random';

/** The fields of an album this app has any use for. */
interface NdAlbum {
  id: string;
  name?: string;
  albumArtist?: string;
  albumArtistId?: string;
  artist?: string;
  artistId?: string;
  maxYear?: number;
  minYear?: number;
  songCount?: number;
  createdAt?: string;
  playCount?: number;
  playDate?: string;
  genre?: string;
  /** Same shorthand as the song's; see `NdSong`. */
  explicitStatus?: string;
}

function toAlbum(a: NdAlbum): Album {
  return {
    id: a.id,
    name: a.name ?? '',
    // The album artist is what an album is filed under; `artist` on this model
    // is the track artist and would put a compilation under whoever happened to
    // sing first.
    artist: a.albumArtist ?? a.artist,
    artistId: a.albumArtistId ?? a.artistId,
    // Same ids as Subsonic, so covers keep coming from the usual endpoint.
    coverArt: a.id,
    songCount: a.songCount,
    // The year an album is shown by is the one it finished on, which is what
    // Subsonic's `year` means here too.
    year: a.maxYear ?? a.minYear,
    created: a.createdAt,
    played: a.playDate,
    playCount: a.playCount,
    genre: a.genre,
    explicitStatus: spellExplicit(a.explicitStatus),
  };
}

/**
 * A page of albums, ordered by the server, optionally narrowed to one genre.
 *
 * Same reasoning as `listSongs`: Subsonic's `getAlbumList2` takes one of its
 * own fixed types OR a genre, never both, so a genre's albums arrive in
 * whatever order that server felt like and no client can ask for another.
 */
export async function listAlbums(
  auth: SubsonicAuth,
  sort: NdAlbumSort = 'name',
  count = 30,
  offset = 0,
  libraryIds?: string[],
  genreId?: string,
  dir?: SortDirection,
): Promise<Album[]> {
  const order = (dir ?? naturalAlbumDir(sort)) === 'asc' ? 'ASC' : 'DESC';
  const q = new URLSearchParams({
    _sort: sort,
    _order: order,
    _start: String(offset),
    _end: String(offset + count),
  });
  for (const id of libraryIds ?? []) q.append('library_id', id);
  if (genreId) q.set('genre_id', genreId);
  const rows = await ndJson<NdAlbum[]>(auth, `/api/album?${q.toString()}`);
  return Array.isArray(rows) ? rows.map(toAlbum) : [];
}

/** A genre as this server names it. The id is what its own filters take. */
export interface NdGenre {
  id: string;
  name: string;
}

/**
 * Every genre the server knows.
 *
 * Subsonic hands back genre NAMES and nothing else, which is what the app
 * routes by, and Navidrome's own lists filter by id. So the name has to be
 * turned into one before a genre's songs can be asked for in any order. The
 * whole list comes in one request and is small enough to keep: a library with
 * a thousand distinct genres is already unusual, and this is a name and an id
 * each.
 */
export async function listGenres(auth: SubsonicAuth): Promise<NdGenre[]> {
  const rows = await ndJson<NdGenre[]>(auth, '/api/genre?_sort=name&_start=0&_end=1000');
  return Array.isArray(rows) ? rows.filter((g) => g?.id && g?.name) : [];
}

// ── Composers and record labels ─────────────────────────────────────────────
// Two lists Subsonic has no endpoint for. Navidrome keeps every credit an
// artist holds (0.55 onwards) and files the record label tag with an id of its
// own, so both are one listing down here, and its album list narrows to
// either.

/**
 * Whether the native API is open to this profile: a Navidrome server, and a
 * password to log into it with. The same test the data layer makes before
 * listing anything natively; a profile from before the password was kept gets
 * what Subsonic can do until it logs in again.
 */
export function canUseNative(auth: SubsonicAuth | null | undefined): auth is SubsonicAuth {
  return !!auth && auth.serverType === 'navidrome' && !!(auth.ndPassword ?? auth.password);
}

/** The fields of an artist row this app reads, credits included. */
export interface NdArtist {
  id: string;
  name?: string;
  albumCount?: number;
  /**
   * One entry per credit the artist holds, with how much of the library it
   * covers. `stats.composer` is the one that matters here, and its absence is
   * what tells a server from before artist roles: that one ignores `role=` and
   * answers with every artist, none of them carrying this.
   */
  stats?: Partial<Record<string, { albumCount?: number; songCount?: number }>>;
}

/** A composer, in the shape an artist row is drawn from. */
export interface Composer {
  id: string;
  name: string;
  /** How many records they are credited on, whoever performed them. */
  albumCount?: number;
}

/** A tag row as the server files it: `tagValue` is the label's name. */
export interface NdTag {
  id: string;
  tagName?: string;
  tagValue?: string;
}

/** A record label. The id is what the album list filters by. */
export interface RecordLabel {
  id: string;
  name: string;
}

/**
 * Walks a list to its end, a thousand rows at a time.
 *
 * The whole list rather than a page, like the artist index the app already
 * keeps: the box on screen then filters what is loaded, and nothing pages
 * under a filter. The server's own `name` filter was the alternative and it
 * does not answer for these lists — combined with `role` it matches on more
 * than the name. The ceiling is there so this ends; no real library reaches it.
 */
export async function listAll<T>(auth: SubsonicAuth, path: string): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let start = 0; start < 20000; start += PAGE) {
    const rows = await ndJson<T[]>(auth, `${path}&_start=${start}&_end=${start + PAGE}`);
    if (!Array.isArray(rows)) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/**
 * Every artist credited as a composer, A-Z. The id is the one `getArtist`
 * takes, so a row opens the artist screen like any other.
 *
 * Endpoint: GET /api/artist?role=composer. Only rows with a composer credit
 * are kept (see `NdArtist`), so a server that ignores the role answers with an
 * empty list rather than with everybody.
 */
export async function listComposers(auth: SubsonicAuth): Promise<Composer[]> {
  const rows = await listAll<NdArtist>(auth, '/api/artist?role=composer&_sort=name&_order=ASC');
  return rows.flatMap((r) => {
    const credit = r.stats?.composer;
    return credit
      ? [{ id: r.id, name: r.name ?? '', albumCount: credit.albumCount ?? r.albumCount }]
      : [];
  });
}

/**
 * Every record label the library is tagged with, A-Z.
 *
 * Endpoint: GET /api/tag?tag_name=recordlabel, which is where Navidrome keeps
 * the values of a tag it indexes; a server too old for it answers 404, which
 * `ndJson` turns into `unsupported`. The rows carry no counts.
 */
export async function listRecordLabels(auth: SubsonicAuth): Promise<RecordLabel[]> {
  const rows = await listAll<NdTag>(auth, '/api/tag?tag_name=recordlabel&_sort=tagValue&_order=ASC');
  return rows.flatMap((r) => (r.id && r.tagValue ? [{ id: r.id, name: r.tagValue }] : []));
}

/** Which of the two lists this server has anything for. */
export interface CatalogueExtras {
  composers: boolean;
  labels: boolean;
}

/**
 * Asks, one row each, whether the server has composers and record labels to
 * show, so the Explore tab draws chips for what exists and none for what does
 * not. A server without the endpoint, without the role or with a library
 * tagged with neither is a no on that side. Anything else that goes wrong is
 * left to throw: a network that was down for a second is not an answer worth
 * remembering.
 */
export async function probeCatalogueExtras(auth: SubsonicAuth): Promise<CatalogueExtras> {
  const absent = (e: unknown) => {
    if (e instanceof NavidromeError && e.kind === 'unsupported') return [];
    throw e;
  };
  const [artists, tags] = await Promise.all([
    ndJson<NdArtist[]>(auth, '/api/artist?role=composer&_start=0&_end=1').catch(absent),
    ndJson<NdTag[]>(auth, '/api/tag?tag_name=recordlabel&_start=0&_end=1').catch(absent),
  ]);
  return {
    composers: Array.isArray(artists) && artists.some((r) => !!r.stats?.composer),
    labels: Array.isArray(tags) && tags.length > 0,
  };
}

/** What an album page is narrowed to: the artist who composed it, or the
 *  label that put it out. */
export type AlbumFilter = { composerId: string } | { labelId: string };

/**
 * A page of albums narrowed to a composer or a record label, ordered by the
 * server.
 *
 * The filters are the ones Navidrome's own pages send: `role_composer_id` is
 * how an artist page lists the records somebody only composed on, which never
 * arrive with `getArtist` because that files a record under whoever performed
 * it; `recordlabel` takes a tag id from `listRecordLabels`. Anything else
 * (`recordlabel_id`, `composer_id`) is quietly ignored and answers with the
 * whole library, which is why these two and no others.
 */
export async function listAlbumsFiltered(
  auth: SubsonicAuth,
  filter: AlbumFilter,
  sort: NdAlbumSort = 'max_year',
  count = 30,
  offset = 0,
  libraryIds?: string[],
  dir?: SortDirection,
): Promise<Album[]> {
  const order = (dir ?? naturalAlbumDir(sort)) === 'asc' ? 'ASC' : 'DESC';
  const q = new URLSearchParams({
    _sort: sort,
    _order: order,
    _start: String(offset),
    _end: String(offset + count),
  });
  if ('composerId' in filter) q.set('role_composer_id', filter.composerId);
  else q.set('recordlabel', filter.labelId);
  for (const id of libraryIds ?? []) q.append('library_id', id);
  const rows = await ndJson<NdAlbum[]>(auth, `/api/album?${q.toString()}`);
  return Array.isArray(rows) ? rows.map(toAlbum) : [];
}
