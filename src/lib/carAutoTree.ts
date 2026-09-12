/**
 * Builds the Android Auto browse tree from the data layer (online Subsonic
 * or offline local, interchangeably) and resolves what to play when the car
 * taps an item.
 *
 * The tree is a flat parentId → children map pushed in full to the native
 * module (`setNodes`), because the native service doesn't fetch: it reads
 * from the cached tree. That's why we prefetch each album/playlist's tracks.
 *
 * What goes where, and how many of each, is decided in `carAutoLayout`; this
 * file gathers the rows and answers the taps.
 *
 * Adapted from the wavio pattern (github.com/Joel-Mercier/wavio, MIT).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';

import * as data from '@/api/data';
import {
  type Album,
  type Artist,
  type Bookmark,
  type Genre,
  type Playlist,
  type Song,
} from '@/api/subsonic';
import { songsLabel, tg } from '@/i18n';
import { greetingHours } from '@/i18n/languages';
import { bookmarksAvailable, loadBookmarks, useBookmarks } from '@/lib/bookmarks';
import { formatDuration } from '@/lib/format';
import { bump } from '@/lib/perfLog';
import { playForYou } from '@/lib/forYouMix';
import { getPlaylists as getLocalPlaylists } from '@/lib/localQueries';
import { navifindActive } from '@/lib/navifind';
import { cardTarget } from '@/lib/youtube';
import { queryClient } from '@/lib/query';
import { profileScopeId, useAuthStore } from '@/store/auth';
import { anyDownloads, getDownloadShelf, useDownloads } from '@/store/downloads';
import { useLastPlayed } from '@/store/lastPlayed';
import { usePins } from '@/store/pins';
import { usePlayerStore } from '@/store/player';
import { usePlayHistory } from '@/store/playHistory';
import { useQueueHistory, type PastQueue } from '@/store/queueHistory';
import { useSettings } from '@/store/settings';
import { useSmartPlaylists } from '@/store/smartPlaylists';
import { type CarNode, type CarTree } from './carAuto';
import { drawerLayout, fold, overflowsHome, resumeFraction, searchRows, tabLayout } from './carAutoLayout';
import { allMixes, topGenres, type Mix } from './mixes';
import { resolveSmartPlaylist, type SmartPlaylist } from './smartPlaylists';

const ROOT = 'root';
const HOME_SIZE = 15;

/** An album's tracklist, shared with the album screen's own query rather than
 *  fetched a second time for the car. */
function albumDetail(id: string): Promise<{ songs: Song[] }> {
  return queryClient.fetchQuery({ queryKey: ['album', id], queryFn: () => data.getAlbum(id) });
}

/** The same, for a playlist and the playlist screen's query. */
function playlistDetail(id: string): Promise<{ songs: Song[] }> {
  return queryClient.fetchQuery({ queryKey: ['playlist', id], queryFn: () => data.getPlaylist(id) });
}
const CONCURRENCY = 4;
/**
 * Ceilings for what gets fetched ahead of a car that may never be plugged in.
 * Everything above them still appears in the browse tree; what it doesn't have
 * yet is the list of songs inside, which arrives on the next rebuild.
 */
const MAX_PREFETCH_ALBUMS = 40;
const MAX_PREFETCH_ARTISTS = 15;
const MAX_PREFETCH_PLAYLISTS = 20;
const MAX_ARTIST_ALBUMS = 5;

// ── Snapshot to resolve taps without refetching data ─────────────────────────
type Resolve = {
  songById: Map<string, Song>;
  /** parentId → track mediaIds (in order) to queue the collection on tap. */
  parentTracks: Map<string, string[]>;
  /** Collection id → what it is called, to name the source a car started. */
  nodeTitles: Map<string, string>;
  /** Mix key → the mix, whose `load` is what a tap on its tile runs. */
  mixes: Map<string, Mix>;
  /** Song id → its bookmark, for the position a "Continue listening" row
   *  picks up from when the store has not read the list yet. */
  bookmarks: Map<string, Bookmark>;
  /** Past queue id → the queue, for a row the store has not hydrated for. */
  pastQueues: Map<string, PastQueue>;
};

function emptyResolve(): Resolve {
  return {
    songById: new Map(),
    parentTracks: new Map(),
    nodeTitles: new Map(),
    mixes: new Map(),
    bookmarks: new Map(),
    pastQueues: new Map(),
  };
}

/**
 * What a tap in the car is answered from. A full build fills a set of its own
 * and swaps it in whole once it is done: emptying this one at the start left
 * every tap for the length of the build, a minute of requests on a big
 * library, with no way to tell which collection the song belongs to, so the
 * car got the one song instead of the album. A build of the lists alone adds
 * to it in place, since it knows nothing about any album's songs.
 */
let resolve: Resolve = emptyResolve();
/** The account `resolve` was filled from: another account's is thrown away. */
let mapsProfile: string | null = null;
/**
 * The last full tree, for the albums a rebuild fails to fetch. Each one used
 * to be published empty, and a full tree is what the native side writes to
 * disk for a car that starts the service on its own: one request lost to a
 * bad moment on the network, and that album opened onto nothing until the
 * next rebuild, in the car and in the snapshot alike.
 */
let lastTree: Record<string, CarNode[]> | null = null;

/** Runs `fn` over `items` with at most `n` in parallel (avoids 429). */
async function mapConcurrent<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

// Track mediaId embeds its parent to know which collection to queue.
function trackMediaId(parentId: string, songId: string): string {
  return `track|${parentId}|${songId}`;
}

/**
 * A plain URL: the car host downloads the artwork itself.
 *
 * Offline the data layer hands back a marked URL that only the image cache
 * can answer (`CACHED_COVER`); `resolveCachedArt` turns those into files at
 * the end of a build, once for the whole tree. A profile whose server wants
 * extra headers gets the same treatment online (`carCoverUrl`), since the car
 * host cannot be told to send them.
 */
function art(id: string | undefined): string | undefined {
  return carCoverUrl(data.coverArtUrl(id, data.COVER.card));
}

/**
 * A cover as the car can draw it. The host fetches a URL for itself, with no
 * headers, so for a profile whose server wants some (`SubsonicAuth.headers`)
 * the URL is marked cache-only instead: `resolveCachedArt` turns it into the
 * image cache's file, fetching it with the headers on when it is not there
 * yet, and the native side embeds the file like a download's cover.
 */
export function carCoverUrl(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return url;
  return data.serverImageSource(url).headers ? data.CACHED_COVER + url : url;
}

/** Where covers fetched for the car are kept. Its own folder, so clearing it
 *  cannot take anything else with it. */
function carArtDir() {
  const dir = new Directory(Paths.cache, 'carart');
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * Fetches a cover to a file of our own and hands back its `file://` path, or
 * undefined when it could not be had.
 *
 * Named after the address rather than after the song: two rows showing the
 * same picture share one file, and a second build finds it already there.
 */
async function downloadedCover(url: string, headers?: Record<string, string>): Promise<string | undefined> {
  try {
    const name = `${hashUrl(url)}.img`;
    const file = new File(carArtDir(), name);
    if (file.exists) return file.uri;
    const out = await File.downloadFileAsync(url, file, headers ? { headers } : undefined);
    return out.uri;
  } catch {
    return undefined;
  }
}

/** A short, stable name for an address. Not a cryptographic hash: it only has
 *  to tell two covers apart on a filesystem. */
function hashUrl(url: string): string {
  let h = 2166136261;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + url.length.toString(36);
}

/**
 * A picture on somebody else's host — a YouTube thumbnail — marked so the
 * phone fetches it and the car is handed the file.
 *
 * The car will not go and get a remote picture itself, whatever the address:
 * the rows came out as bare text next to their titles. Marking it here puts it
 * through the same path the server's own covers take.
 */
function remoteCover(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return url;
  return data.CACHED_COVER + url;
}

/**
 * The file already known for a marked cover, for what goes to the car outside
 * the tree (now playing, the queue) and cannot wait: undefined until
 * `warmCarCover` has looked it up.
 */
export function knownCarCover(marked: string): string | undefined {
  return cachedArt.get(marked.slice(data.CACHED_COVER.length))?.path;
}

/** Looks a marked cover up, fetching it if need be, and says whether there is
 *  now a file for it. False straight away for a URL the car can fetch itself. */
export async function warmCarCover(url: string | undefined): Promise<boolean> {
  if (!url?.startsWith(data.CACHED_COVER)) return false;
  return !!(await cachedCoverPath(url.slice(data.CACHED_COVER.length)));
}

/**
 * One of our own icons for a row that leads somewhere rather than to a song.
 * The native side turns this into a resource uri of the running package, and
 * the car tints the white drawable to whatever its theme is (`VD-2`). Without
 * one, a category row is bare text, and telling four of those apart at a
 * glance means reading them.
 */
function icon(name: string): string {
  return `res://${name}`;
}

/** A row of the Library that opens onto a list or a grid of its own. */
function drawer(id: string, title: string, style: 'list' | 'grid', iconName: string): CarNode {
  return { id, title, playable: false, contentStyle: style, artworkUrl: icon(iconName) };
}

function songNode(into: Resolve, s: Song, parentId: string): CarNode {
  into.songById.set(s.id, s);
  return {
    id: trackMediaId(parentId, s.id),
    title: s.title || tg('Unknown title'),
    subtitle: s.artist,
    artworkUrl: art(s.coverArt ?? s.albumId),
    playable: true,
  };
}

function albumNode(into: Resolve, a: Album): CarNode {
  into.nodeTitles.set(`album:${a.id}`, a.name);
  return {
    id: `album:${a.id}`,
    title: a.name,
    subtitle: a.artist,
    artworkUrl: art(a.coverArt ?? a.id),
    playable: false,
    contentStyle: 'list',
    mediaType: 'album',
  };
}

function playlistNode(into: Resolve, p: Playlist): CarNode {
  into.nodeTitles.set(`playlist:${p.id}`, p.name);
  return {
    id: `playlist:${p.id}`,
    title: p.name,
    // Who it belongs to, which is what tells two lists of the same name apart
    // on a shared server. Falls back to the length for servers that send no
    // owner at all.
    subtitle:
      p.owner ||
      (p.songCount != null ? songsLabel(p.songCount, useSettings.getState().language) : undefined),
    artworkUrl: art(p.coverArt ?? p.id),
    playable: false,
    contentStyle: 'list',
    mediaType: 'playlist',
  };
}

function artistNode(into: Resolve, a: Artist): CarNode {
  into.nodeTitles.set(`artist:${a.id}`, a.name);
  return {
    id: `artist:${a.id}`,
    title: a.name,
    artworkUrl: art(a.coverArt ?? a.id),
    playable: false,
    contentStyle: 'list',
    mediaType: 'artist',
  };
}

// ── Continue listening ───────────────────────────────────────────────────────

/** The row that picks the queue up where the phone left it. */
const RESUME_ID = 'resume:queue';
/** How many resume points Home shows; past that they get a drawer in the
 *  Library too. A driver reaching for last night's audiobook wants one row,
 *  not the whole shelf. */
const HOME_BOOKMARKS = 3;

/**
 * The queue as the phone holds it now: one row, which is what a driver who
 * paused on the doorstep taps first. The song's own cover, so the row looks
 * like what it will play, and the collection it was started from under it.
 */
function resumeNode(): CarNode | null {
  const { queue, index, source } = usePlayerStore.getState();
  const song = queue[index];
  if (!song) return null;
  return {
    id: RESUME_ID,
    title: song.title || tg('Unknown title'),
    subtitle: source ?? song.artist ?? tg('Queue'),
    artworkUrl: carCoverUrl(data.songCoverUrl(song, data.COVER.card)),
    playable: true,
  };
}

/**
 * A bookmark as a row: the song, and under it where it will pick up from. The
 * position goes under the title rather than in it, so a spoken title still
 * matches the row exactly.
 */
function bookmarkNode(into: Resolve, b: Bookmark): CarNode {
  into.songById.set(b.song.id, b.song);
  into.bookmarks.set(b.song.id, b);
  const at = tg('at {time}', { time: formatDuration(b.position / 1000) });
  return {
    id: `bookmark:${b.song.id}`,
    title: b.song.title || tg('Unknown title'),
    subtitle: b.song.artist ? `${at} · ${b.song.artist}` : at,
    artworkUrl: art(b.song.coverArt ?? b.song.albumId),
    playable: true,
    // The bar the car draws under the row, which says at a glance how much of
    // a two-hour set is left.
    progress: resumeFraction(b.position, b.song.duration),
  };
}

/**
 * The resume points, newest moved first, as the Bookmarks screen lists them.
 *
 * A full build reads the list again, since another device may have moved
 * one; a build of the lists alone takes what the store holds, which is the
 * profile's own list or nothing. Offline only the songs on the phone are
 * rows: a resume point in a song that cannot be played is a tap into a toast.
 */
async function bookmarkList(deep: boolean, profile: string): Promise<Bookmark[]> {
  if (deep && bookmarksAvailable()) await loadBookmarks(true).catch(() => {});
  const { byId, loadedFor } = useBookmarks.getState();
  if (loadedFor !== profile) return [];
  const list = Object.values(byId).sort((a, b) => b.changed.localeCompare(a.changed));
  const playable = new Set(
    data
      .markUnplayableOffline(list.map((b) => b.song))
      .filter((s) => !s.unavailable)
      .map((s) => s.id),
  );
  return list.filter((b) => playable.has(b.song.id));
}

// ── Past queues ──────────────────────────────────────────────────────────────

/** A queue put away when another replaced it, brought back whole on a tap.
 *  "12 songs · 8 Sept" under the name it was started from. */
function pastQueueNode(into: Resolve, q: PastQueue): CarNode {
  into.pastQueues.set(q.id, q);
  const lang = useSettings.getState().language;
  const date = new Date(q.at).toLocaleDateString(lang, { day: 'numeric', month: 'short' });
  return {
    id: `queue:${q.id}`,
    title: q.title,
    subtitle: `${songsLabel(q.songIds.length, lang)} · ${date}`,
    artworkUrl: icon('ic_car_queue'),
    playable: true,
  };
}

// ── Shuffle ──────────────────────────────────────────────────────────────────

/** Plays songs picked at random, resolved only when it is tapped. */
/** The mix built from what this account plays, which is the one row on the
 *  car's Home worth pressing without reading anything first. */
const FOR_YOU_ID = 'foryou:mix';
const SHUFFLE_ID = 'shuffle:all';
/** The favourites dealt once and played through, the way the button on the
 *  Favorites screen plays them. */
const SHUFFLE_FAVORITES_ID = 'shuffle:favorites';
/** How many it queues. Enough for a drive without asking again. */
const SHUFFLE_SONGS = 100;

// ── Genres ───────────────────────────────────────────────────────────────────

/** How many genres the Library offers. The biggest ones, where the listening
 *  is; a whole list of them is a thing to read, not to drive with. */
const LIBRARY_GENRES = 8;

/**
 * The genres, biggest first, from the same query the Genres screen and the
 * "Made for you" shelf share. Online only: offline the phone has no genre
 * index to shuffle by, and a row that opens onto a toast is worse than none.
 */
async function genreList(deep: boolean): Promise<Genre[]> {
  const { auth, offline } = useAuthStore.getState();
  if (!auth || offline) return [];
  const genres = deep
    ? await queryClient
        .fetchQuery({ queryKey: ['genres'], queryFn: () => data.getGenres(), retry: false })
        .catch(() => queryClient.getQueryData<Genre[]>(['genres']))
    : queryClient.getQueryData<Genre[]>(['genres']);
  return [...(genres ?? [])]
    .sort((a, b) => (b.songCount ?? 0) - (a.songCount ?? 0))
    .slice(0, LIBRARY_GENRES);
}

/**
 * A genre is a leaf that shuffles it, like the genre screen's own button. Its
 * cover is the first of the albums the "Made for you" shelf fetched for the
 * genre's card, when the cache has them; otherwise the genre icon.
 */
function genreNode(g: Genre): CarNode {
  const covers = queryClient.getQueryData<Album[]>(['mixes', 'genreArt', g.value]);
  const first = covers?.[0];
  return {
    id: `genre:${g.value}`,
    title: g.value,
    subtitle: g.songCount != null ? songsLabel(g.songCount, useSettings.getState().language) : undefined,
    artworkUrl: (first && art(first.coverArt ?? first.id)) ?? icon('ic_car_genres'),
    playable: true,
  };
}

// ── Downloaded ───────────────────────────────────────────────────────────────

/**
 * The albums and the playlists kept on the phone, from the same query the
 * Library's Downloaded tab reads: whoever gets there first pays, and the shelf
 * itself is a cached read of the downloads database, not of the server.
 *
 * A downloaded playlist is the server's playlist online and the phone's copy
 * of it offline, as it is on the Library tab: its id is the server's there,
 * and the `dl_` copy's here, so a tap opens the one that can be played.
 */
async function downloadedLists(): Promise<{ albums: Album[]; playlists: Playlist[] }> {
  const { auth, offline } = useAuthStore.getState();
  const files = Object.keys(useDownloads.getState().files).length;
  const { albums, playlists } = await queryClient
    .fetchQuery({
      queryKey: ['downloads', 'shelf', files],
      queryFn: async () => {
        const [shelf, lists] = await Promise.all([getDownloadShelf(), getLocalPlaylists()]);
        return { albums: shelf.albums, playlists: lists.filter((p) => p.id.startsWith('dl_')) };
      },
    })
    .catch(() => ({ albums: [] as Album[], playlists: [] as Playlist[] }));
  const serverIds = !!auth && !offline;
  return {
    albums,
    playlists: playlists.map((p) => (serverIds ? { ...p, id: p.id.slice('dl_'.length) } : p)),
  };
}

// ── Made for you ─────────────────────────────────────────────────────────────

/**
 * How many albums are sampled to find out which decades the library has, and
 * how many covers a genre card gets. The same numbers, under the same query
 * keys, as the shelf on Home (`MixesShelf`): the two share one answer in the
 * cache rather than asking the server twice for the same list.
 */
const YEAR_SAMPLE = 100;
const GENRE_COVERS = 4;
/** How many mixes Home shows. The rest exist, on the phone. */
const HOME_MIXES = 4;

/**
 * The mixes of Home's "Made for you" shelf as the phone would draw them now,
 * and none of their songs: a mix is a `load` that runs when it is tapped.
 *
 * The history and the recents come from the stores; the rest goes through the
 * query cache under the shelf's own keys. A build of the lists alone reads
 * what the cache already holds and asks the server for nothing: at launch
 * Home is asking for the same things, or the settings have left the shelf
 * out, and either way the car is not the one to pay for it (#50). So the
 * mixes built from the history alone are there at once, and a full build
 * fetches what the genre radios and the decades need.
 */
async function mixList(deep: boolean): Promise<Mix[]> {
  const { auth, offline } = useAuthStore.getState();
  // Server only, like the shelf: the mixes are drawn from what the server can
  // pick at random or by likeness, and offline there is neither.
  if (!auth || offline) return [];
  const cached = <T>(queryKey: readonly unknown[]) => queryClient.getQueryData<T>(queryKey);
  const get = <T>(queryKey: readonly unknown[], queryFn: () => Promise<T>, staleTime?: number) =>
    deep
      ? queryClient.fetchQuery({ queryKey, queryFn, staleTime, retry: false }).catch(() => cached<T>(queryKey))
      : Promise.resolve(cached<T>(queryKey));
  const [sample, genres] = await Promise.all([
    get(['mixes', 'albumSample'], () => data.getAlbumList('random', YEAR_SAMPLE)),
    get(['genres'], () => data.getGenres()),
  ]);
  const picked = topGenres(genres ?? []);
  const art = await Promise.all(
    picked.map((g) =>
      get(['mixes', 'genreArt', g.value], () => data.getAlbumsByGenre(g.value, GENRE_COVERS), Infinity),
    ),
  );
  const artByGenre = new Map(picked.map((g, i) => [g.value, art[i]]));
  // Every album already on screen says which decades the library has: the
  // shelves' lists sit in the cache under this key, whatever their type, and
  // the car's own build has just put one of them there.
  const seen = queryClient
    .getQueriesData<Album[]>({ queryKey: ['albumList'] })
    .flatMap(([, albums]) => albums ?? []);
  return allMixes({
    entries: usePlayHistory.getState().entries,
    times: useLastPlayed.getState().times,
    hours: greetingHours(useSettings.getState().language),
    now: Date.now(),
    albums: [...seen, ...(sample ?? [])],
    genres: picked,
    artOf: (genre) => artByGenre.get(genre),
  });
}

/** A mix is a leaf: nothing is fetched for it until the tile is pressed. */
function mixNode(into: Resolve, mix: Mix): CarNode {
  into.mixes.set(mix.key, mix);
  return {
    id: `mix:${mix.key}`,
    title: tg(mix.title.key, mix.title.vars),
    subtitle: tg(mix.subtitle.key, mix.subtitle.vars),
    // The first cover stands in for the mosaic on the phone, since a tile in
    // the car is one picture. A mix with no cover yet, a genre whose art has
    // not come back, wears the shuffle icon: that is what it does.
    artworkUrl: art(mix.covers[0]) ?? icon('ic_car_shuffle'),
    playable: true,
  };
}

// ── Smart playlists ──────────────────────────────────────────────────────────

/**
 * Ceiling on the songs a smart playlist shows in the car. A list with no rules
 * is the whole library, and every song of it would ride the bridge and the
 * snapshot on disk on each full build. Playing the list whole, from a spoken
 * request or its own row, still resolves all of it (`handleBrowsePlay`).
 */
const MAX_SMART_SONGS = 500;
/** How long the library's song list is reused, the same as the smart playlist
 *  screen's query, which is also whose cache entry this is. */
const LIBRARY_STALE_MS = 10 * 60 * 1000;

/** Every song the profile can see: what a smart playlist's rules sift. */
function allSongs(): Promise<Song[]> {
  return queryClient.fetchQuery({
    queryKey: ['allSongs'],
    queryFn: () => data.getAllSongs(),
    staleTime: LIBRARY_STALE_MS,
  });
}

/**
 * The same sparkles the phone draws for every smart playlist, rather than a
 * cover: the songs are worked out when the list is opened, and the first
 * cover of a random list would change on every build.
 */
function smartNode(list: SmartPlaylist): CarNode {
  return {
    id: `smart:${list.id}`,
    title: list.name,
    subtitle: tg('Smart playlist'),
    artworkUrl: icon('ic_car_smart_playlists'),
    playable: false,
    contentStyle: 'list',
    mediaType: 'playlist',
  };
}

/**
 * Newest played first, and whatever was never played keeps the order the
 * server sent. The car's lists are long and what you put on last week is a
 * better guess at what you want now than wherever the alphabet left it.
 */
function byLastPlayed<T>(items: T[], href: (item: T) => string): T[] {
  const { times } = useLastPlayed.getState();
  return items
    .map((item, i) => ({ item, i, ts: times[href(item)] ?? 0 }))
    .sort((a, b) => b.ts - a.ts || a.i - b.i)
    .map((x) => x.item);
}

/** How many go in the Recents tab. A screenful is three rows of five. */
const RECENTS_SIZE = 20;

/** What each kind of source is called under its tile. */
const KIND_LABEL = { album: 'Album', artist: 'Artist', playlist: 'Playlist' } as const;

/**
 * The Recents tab: what was last played, newest first, whatever kind it is.
 *
 * Read straight from the store the Library's "Recents" order and Home's grid
 * already use, so it needs nothing from the server: the name was written down
 * when it played and the cover comes from the id inside the href. Songs are
 * left out — what gets played again is the album or the playlist it came from,
 * and a car full of single tracks is a worse thing to steer through.
 */
function recentNodes(into: Resolve): CarNode[] {
  const { times, names } = useLastPlayed.getState();
  const nodes: CarNode[] = [];
  for (const [href] of Object.entries(times).sort((a, b) => b[1] - a[1])) {
    if (nodes.length >= RECENTS_SIZE) break;
    const [, kind, id] = href.split('/');
    const name = names[href];
    if (!name || !id || !(kind in KIND_LABEL)) continue;
    const type = kind as keyof typeof KIND_LABEL;
    into.nodeTitles.set(`${type}:${id}`, name);
    nodes.push({
      id: `${type}:${id}`,
      title: name,
      subtitle: tg(KIND_LABEL[type]),
      artworkUrl: art(id),
      playable: false,
      contentStyle: 'list',
      mediaType: type,
    });
  }
  return nodes;
}

/** How many of the newest albums Home shows, and how many pinned playlists.
 *  Four of each: a group, not a shelf, on a tab that is read and not
 *  scrolled. */
const HOME_RECENT_ALBUMS = 4;
const HOME_PINNED = 4;

/**
 * The playlists pinned on the phone, in the order they were pinned. Pins are
 * keys of the form `playlist:<id>`, matched against the list the Library
 * shows; a pin on a playlist that is gone matches nothing and draws nothing.
 */
function pinnedPlaylists(playlists: Playlist[]): Playlist[] {
  const pins = usePins.getState().pins;
  const byId = new Map(playlists.map((p) => [p.id, p]));
  return Object.entries(pins)
    .filter(([key]) => key.startsWith('playlist:'))
    .sort((a, b) => a[1] - b[1])
    .flatMap(([key]) => byId.get(key.slice('playlist:'.length)) ?? []);
}

// ── Covers offline ───────────────────────────────────────────────────────────

/**
 * How many marked covers a build asks the image cache about. The tree walks
 * shelves first and songs last, so what the ceiling cuts is the tail of the
 * tracklists, whose rows are small tiles the driver rarely looks at.
 *
 * Raised when the YouTube tab arrived: its shelves carry a hundred and fifty
 * pictures of their own, and at the old ceiling they would have been taken out
 * of the library's share rather than added to it. They are fetched once and
 * read from the disk cache after that.
 */
const MAX_CACHE_LOOKUPS = 500;
/** The sizes a cover may have been seen at on the phone, tried when the size
 *  the car asks for misses. The same list as the `Cover` component's. */
const CACHE_SIZES = [data.COVER.card, data.COVER.full, data.COVER.thumb, 500, 300, 100] as const;
/** A miss is kept for a minute: back online the mirror does save covers. */
const MISS_TTL = 60_000;
const cachedArt = new Map<string, { path?: string; at: number }>();

/**
 * The file behind a marked cover, if the image cache has one, else nothing.
 *
 * Offline the data layer marks every cover that is not on disk
 * (`CACHED_COVER`), and only the image loader's cache can say whether it was
 * seen while online. The car host cannot ask it, and cannot draw the marked
 * URL either, so it is asked here: a hit becomes a `file://` the native side
 * embeds like a download's cover, and a miss becomes no picture at all, which
 * is what it was showing anyway.
 */
async function cachedCoverPath(url: string): Promise<string | undefined> {
  const seen = cachedArt.get(url);
  if (seen && (seen.path || Date.now() - seen.at < MISS_TTL)) return seen.path;
  const sized = (n: number) => url.replace(/([?&](?:size|fillWidth|fillHeight)=)\d+/g, `$1${n}`);
  const look = async (candidate: string) => {
    const path = await Image.getCachePathAsync(candidate).catch(() => null);
    return path ? (path.startsWith('file://') ? path : `file://${path}`) : undefined;
  };
  let found = await look(url);
  if (!found) {
    const others = await Promise.all(CACHE_SIZES.map((n) => look(sized(n))));
    found = others.find(Boolean);
  }
  // Marked because the car cannot fetch it itself: a server that wants headers
  // it does not have, or a host it will not go to at all — which is every
  // remote picture, as far as the head unit is concerned. Either way the phone
  // fetches it and the car is handed the file.
  const { headers } = data.serverImageSource(url);
  if (!found && !useAuthStore.getState().offline) {
    await Image.prefetch(url, headers ? { headers, cachePolicy: 'disk' } : { cachePolicy: 'disk' }).catch(
      () => false,
    );
    found = await look(url);
  }
  // The image cache is asked first because it usually already holds what the
  // app has drawn on screen. When it does not — and it did not for the YouTube
  // thumbnails, whose rows came out bare — the picture is fetched to a file of
  // our own. Deterministic, where the cache's own idea of a path is not.
  if (!found && !useAuthStore.getState().offline) {
    found = await downloadedCover(url, headers);
  }
  cachedArt.set(url, { path: found, at: Date.now() });
  return found;
}

/** Replaces every marked cover in the tree with its cached file, or drops it. */
async function resolveCachedArt(tree: Record<string, CarNode[]>): Promise<void> {
  const marked = new Map<string, CarNode[]>();
  for (const nodes of Object.values(tree)) {
    for (const node of nodes) {
      const url = node.artworkUrl;
      if (!url?.startsWith(data.CACHED_COVER)) continue;
      const bare = url.slice(data.CACHED_COVER.length);
      const list = marked.get(bare);
      if (list) list.push(node);
      else if (marked.size < MAX_CACHE_LOOKUPS) marked.set(bare, [node]);
      else delete node.artworkUrl;
    }
  }
  await mapConcurrent(Array.from(marked.entries()), 8, async ([url, nodes]) => {
    const path = await cachedCoverPath(url);
    for (const node of nodes) {
      if (path) node.artworkUrl = path;
      else delete node.artworkUrl;
    }
  });
}

/**
 * The whole browse tree, or only its lists.
 *
 * Filling it in means asking the server for the songs of every album on the
 * shelves and every favourite, plus each favourite artist's albums and their
 * songs. That was happening within a second of every launch, whether or not a
 * car was ever going to be plugged in, and it is dozens of requests before the
 * app has finished opening (#50). The lists themselves are nearly free: they
 * come from the same queries the app has already made.
 *
 * So the lists go up straight away and the songs follow later, once the app is
 * done starting or as soon as a car is plugged in. A tree without the songs is
 * marked `partial` and the native side lays it over the one it already has,
 * rather than taking it for the whole library: it was replacing the songs of
 * every album with nothing, in memory and in the snapshot it keeps for a car
 * that starts the service on its own.
 *
 * Offline every list here comes from the phone: the downloads database, the
 * library mirror, the stores. Nothing that would need the server (the mixes,
 * the genres) is offered at all, since a row that opens onto a toast is worse
 * than no row.
 */
/**
 * The one row shown in place of a tree there is no way to fill, or null when
 * there is a library to draw.
 *
 * Not playable and with nothing under it: it is a sentence, and the car has no
 * other way of carrying one into the browser. What it cannot do is be acted
 * on from the car, which is the point — signing in is a thing for the phone,
 * standing still.
 */
/** How many of the account's YouTube playlists get their tracks fetched ahead
 *  of a drive. Each is a request the proxy passes on to YouTube. */
const MAX_YOUTUBE_PLAYLISTS = 4;
/** How much of each list is carried. A car screen shows a dozen rows. */
const YOUTUBE_TRACKS = 50;

/**
 * The YouTube tab: what the account signed in to the proxy has, in the car.
 *
 * Its own tab rather than rows on Home, because it is a library of its own and
 * because Android Auto draws four tabs at most and there was room for exactly
 * one more. Null where it would be empty — no proxy, no account, offline, or a
 * session that has run out — which is what keeps the tab from appearing at all
 * rather than appearing and opening onto nothing.
 *
 * Everything here is an ordinary song with a `yt_` id, so playing one is the
 * same path as playing anything else: the proxy streams it and files it into
 * the library on its own.
 */
/** Whether the YouTube tab could hold anything at all. Free to ask: it is
 *  about the profile and the switch, not about what YouTube would answer. */
function youtubeReachable(): boolean {
  const { auth, offline } = useAuthStore.getState();
  return !!auth && !offline && navifindActive();
}

async function youtubeTab(into: Resolve, tree: Record<string, CarNode[]>): Promise<CarNode[] | null> {
  if (!youtubeReachable()) return null;

  const [liked, playlists, shelves] = await Promise.all([
    data.youtubeLikedSongs(YOUTUBE_TRACKS).catch(() => [] as Song[]),
    data.youtubePlaylistCards().catch(() => [] as { id: string; name: string; thumbnail?: string }[]),
    data.youtubeHomeShelves().catch(() => []),
  ]);
  if (liked.length === 0 && playlists.length === 0 && shelves.length === 0) return null;

  const rows: CarNode[] = [];
  const shelfRows: CarNode[] = [];
  if (liked.length > 0) {
    tree['yt:liked'] = liked.map((song) => songNode(into, song, 'yt:liked'));
    into.parentTracks.set('yt:liked', tree['yt:liked'].map((n) => n.id));
    rows.push({
      id: 'yt:liked',
      title: tg('Liked songs'),
      subtitle: songsLabel(liked.length, useSettings.getState().language),
      artworkUrl: icon('ic_car_favorites'),
      playable: false,
      contentStyle: 'list',
      mediaType: 'playlist',
    });
  }

  for (const list of playlists) {
    into.nodeTitles.set(`yt:pl:${list.id}`, list.name);
    rows.push({
      id: `yt:pl:${list.id}`,
      title: list.name,
      artworkUrl: remoteCover(list.thumbnail),
      playable: false,
      contentStyle: 'list',
      mediaType: 'playlist',
    });
  }

  // The home page's own shelves, in its order, each a folder of what it holds.
  //
  // Nothing here is fetched: the tracks arrive with the page, and a tile is a
  // row that resolves when it is pressed rather than a folder that had to be
  // filled first (`handleBrowsePlay`). That is what makes twenty shelves and a
  // hundred and thirty tiles cost the one request the page already costs.
  shelves.forEach((shelf, at) => {
    const parent = `yt:shelf:${at}`;
    const rows: CarNode[] = [
      ...shelf.songs.map((song) => songNode(into, song, parent)),
      ...shelf.items.flatMap((card) => {
        const target = cardTarget(card);
        if (!target) return [];
        const id = target.kind === 'song' ? `yt:v:${target.id}` : `yt:pl:${target.id}`;
        // Kept so the queue it starts can say which tile it came from.
        into.nodeTitles.set(id, card.title);
        return [
          {
            id,
            title: card.title,
            subtitle: card.subtitle,
            artworkUrl: remoteCover(card.thumbnail ?? undefined),
            playable: true,
          },
        ];
      }),
    ];
    if (rows.length === 0) return;
    tree[parent] = rows;
    // The shelf wears the cover of what it opens on. Free: the picture came
    // with the page, and a row of bare text in a car is a row nobody reads.
    const cover = rows.find((n) => n.artworkUrl)?.artworkUrl;
    into.parentTracks.set(parent, rows.filter((n) => n.id.startsWith('track|')).map((n) => n.id));
    into.nodeTitles.set(parent, shelf.title);
    shelfRows.push({
      id: parent,
      title: shelf.title,
      subtitle: songsLabel(rows.length, useSettings.getState().language),
      artworkUrl: cover,
      playable: false,
      contentStyle: 'list',
      mediaType: 'playlist',
    });
  });

  // The first few opened ahead of time: a list with nothing in it is a row
  // that does nothing at the wheel, and the rest fill in when asked.
  await mapConcurrent(playlists.slice(0, MAX_YOUTUBE_PLAYLISTS), CONCURRENCY, async (list) => {
    const parent = `yt:pl:${list.id}`;
    try {
      const songs = await data.youtubePlaylistSongs(list.id, YOUTUBE_TRACKS);
      tree[parent] = songs.map((song) => songNode(into, song, parent));
      into.parentTracks.set(parent, tree[parent].map((n) => n.id));
    } catch {
      tree[parent] = [];
    }
  });

  // The account's own things first — they are what somebody came for — and
  // the home page's shelves behind them, in its order.
  return [...rows, ...shelfRows];
}

function nothingToBrowse(): CarNode | null {
  const { auth, offline } = useAuthStore.getState();
  if (auth) return null;
  if (!offline) {
    return {
      id: 'notice:signed-out',
      title: tg('Sign in on your phone'),
      subtitle: tg('Resonuls has no account on this phone yet'),
      playable: false,
    };
  }
  if (anyDownloads(useDownloads.getState())) return null;
  return {
    id: 'notice:offline-empty',
    title: tg('Nothing downloaded'),
    subtitle: tg('Offline, only downloads can play'),
    playable: false,
  };
}

export async function buildBrowseTree(deep = true): Promise<CarTree> {
  const profile = profileScopeId();
  // Another account's is dropped at once, whatever the build: nothing here can
  // resolve it. Then a full build fills a set of its own, swapped in at the
  // end, and a partial one adds to the live set (see `resolve`).
  if (profile !== mapsProfile) {
    resolve = emptyResolve();
    lastTree = null;
  }
  mapsProfile = profile;
  // Nothing is reachable, and three empty tabs say so in the worst way: the
  // car draws them, the driver opens each one and finds nothing, and no part
  // of it explains that the app has no account or that the phone is offline
  // with nothing on it. One row that says it is the whole tree instead.
  const missing = nothingToBrowse();
  if (missing) return { nodes: { [ROOT]: [missing] }, profile };
  const into = deep ? emptyResolve() : resolve;
  const tree: Record<string, CarNode[]> = {};
  const lang = useSettings.getState().language;
  // What the last build had for a collection this one cannot fetch. Its songs
  // are still in `resolve` then, since a failed fetch adds nothing to `into`,
  // so the tap resolves against the same list the car is showing.
  const keep = (parent: string) => {
    const before = lastTree?.[parent];
    tree[parent] = before ?? [];
    if (before) {
      const ids = resolve.parentTracks.get(parent);
      if (ids) into.parentTracks.set(parent, ids);
      for (const id of ids ?? []) {
        const song = resolve.songById.get(songIdFromTrackMediaId(id));
        if (song) into.songById.set(song.id, song);
      }
    }
  };

  // Root: the tabs Android Auto draws, and no more than four.
  tree[ROOT] = [
    { id: 'tab:home', title: tg('Home'), playable: false, contentStyle: 'list', artworkUrl: icon('ic_car_home') },
    { id: 'tab:recents', title: tg('Recents'), playable: false, contentStyle: 'grid', artworkUrl: icon('ic_car_recent') },
    { id: 'tab:library', title: tg('Library'), playable: false, contentStyle: 'list', artworkUrl: icon('ic_car_library') },
  ];
  // The fourth and last tab Android Auto will draw, and only on a full build:
  // it is several requests the proxy passes on to YouTube, which is not
  // something to spend on a rebuild that is only re-laying the lists. A
  // partial build keeps whatever the last full one found.
  if (deep) {
    const youtube = await youtubeTab(into, tree);
    if (youtube) {
      tree[ROOT].push({
        id: 'tab:youtube',
        title: 'YouTube',
        playable: false,
        contentStyle: 'list',
        artworkUrl: icon('ic_car_youtube'),
      });
      tree['tab:youtube'] = youtube;
    }
  } else if (youtubeReachable()) {
    // The tab is put back from what it costs nothing to know — a proxy, an
    // account, a connection — and its contents are left exactly where they
    // are: a partial push is laid over what the car already holds rather than
    // replacing it, so naming none of the `yt:` parents is what keeps them.
    //
    // Deciding this from the last tree instead was wrong in the one case that
    // matters: a runtime the car has just started has no last tree, so the tab
    // vanished from the moment the lists were pushed until the songs followed
    // seconds later, which is exactly when somebody is looking at it.
    tree[ROOT].push({
      id: 'tab:youtube',
      title: 'YouTube',
      playable: false,
      contentStyle: 'list',
      artworkUrl: icon('ic_car_youtube'),
    });
  }
  tree['tab:recents'] = recentNodes(into);

  // Which albums get their songs fetched, in the order they deserve them. The
  // cap further down cuts the tail of this, and it was cutting the wrong end:
  // the starred albums went in last, behind up to fifty ids from the recents
  // and the shelves, so the one grid Library opens onto was the one whose
  // albums opened onto nothing.
  //
  // Recents lead all the same: what was played last is the likeliest thing to
  // be tapped again.
  const albumIds = new Set<string>(
    tree['tab:recents'].filter((n) => n.mediaType === 'album').map((n) => n.id.slice('album:'.length)),
  );

  // The lists, all at once. Through the query cache, with the keys the screens
  // use: Home asks for these very lists, and the car was asking again for its
  // own copy on every launch. Whoever gets there first pays; the other reads
  // it. The stores (past queues, pins, smart lists) cost nothing at all.
  const [newest, starred, playlists, bookmarks, downloaded, genres] = await Promise.all([
    queryClient
      .fetchQuery({
        queryKey: ['albumList', 'newest'],
        queryFn: () => data.getAlbumList('newest', HOME_SIZE),
      })
      .catch(() => [] as Album[]),
    queryClient
      .fetchQuery({ queryKey: ['starred'], queryFn: () => data.getStarred() })
      .catch(() => ({ songs: [] as Song[], albums: [] as Album[], artists: [] as Artist[] })),
    // The same query the Library and the Home grid ask for: in the car it is
    // free, since by the time this runs somebody has usually paid for it.
    queryClient
      .fetchQuery({ queryKey: ['playlists'], queryFn: () => data.getPlaylists() })
      .catch(() => [] as Playlist[]),
    bookmarkList(deep, profile),
    downloadedLists(),
    genreList(deep),
    useQueueHistory.getState().hydrate().catch(() => {}),
  ]);
  const pastQueues = useQueueHistory.getState().queues;
  const smartLists = useSmartPlaylists.getState().lists;

  // ── Library ──
  // A few ways in, each opening onto a grid of covers or a list of rows. A
  // list of rows is cheap to read at a glance, which a grid of tiles would not
  // be. A drawer only exists once there is something behind it (see
  // `drawerLayout`): the smart playlists come from the phone's own store, the
  // past queues and the bookmarks likewise, and the genres from the server
  // when there is one.
  const favoritesNode: CarNode = {
    id: 'favorites',
    title: tg('Favorites'),
    subtitle: songsLabel(starred.songs.length, lang),
    artworkUrl: icon('ic_car_favorites'),
    playable: false,
    contentStyle: 'list',
    mediaType: 'playlist',
  };
  // Favourites lead the playlists: they are the one list nobody made and
  // everybody plays, and on a phone they sit above them too.
  const orderedPlaylists = byLastPlayed(playlists, (p) => `/playlist/${p.id}`);
  tree['lib:playlists'] = [favoritesNode, ...orderedPlaylists.map((p) => playlistNode(into, p))];

  tree['favorites'] = starred.songs.map((s) => songNode(into, s, 'favorites'));
  into.parentTracks.set('favorites', tree['favorites'].map((n) => n.id));

  const starredAlbums = byLastPlayed(starred.albums, (a) => `/album/${a.id}`);
  tree['lib:albums'] = starredAlbums.map((a) => albumNode(into, a));
  // Behind the recents and ahead of the shelf, in the order the grid shows
  // them. And of the shelf only what Home shows, not the whole list it was
  // cut from: the songs of ten albums nobody can see cost ten albums somebody
  // can. The downloads come last: offline they are a read of the database
  // each, and online they are the albums least likely to be missing.
  starredAlbums.forEach((a) => albumIds.add(a.id));
  newest.slice(0, HOME_RECENT_ALBUMS).forEach((a) => albumIds.add(a.id));
  downloaded.albums.forEach((a) => albumIds.add(a.id));

  tree['lib:artists'] = starred.artists.map((a) => artistNode(into, a));
  tree['lib:genres'] = genres.map(genreNode);
  tree['lib:downloaded'] = [
    ...byLastPlayed(downloaded.playlists, (p) => `/playlist/${p.id}`).map((p) => playlistNode(into, p)),
    ...byLastPlayed(downloaded.albums, (a) => `/album/${a.id}`).map((a) => albumNode(into, a)),
  ];
  tree['lib:queues'] = pastQueues.map((q) => pastQueueNode(into, q));
  const bookmarkNodes = bookmarks.map((b) => bookmarkNode(into, b));
  tree['lib:bookmarks'] = bookmarkNodes;
  if (smartLists.length > 0) tree['lib:smart'] = smartLists.map(smartNode);

  tree['tab:library'] = drawerLayout([
    { node: drawer('lib:playlists', tg('Playlists'), 'grid', 'ic_car_playlists'), count: null },
    { node: drawer('lib:albums', tg('Albums'), 'grid', 'ic_car_albums'), count: null },
    { node: drawer('lib:artists', tg('Artists'), 'grid', 'ic_car_artists'), count: tree['lib:artists'].length },
    { node: drawer('lib:genres', tg('Genres'), 'list', 'ic_car_genres'), count: tree['lib:genres'].length },
    {
      node: drawer('lib:downloaded', tg('Downloaded::library'), 'grid', 'ic_car_downloaded'),
      count: tree['lib:downloaded'].length,
    },
    { node: drawer('lib:queues', tg('Past queues'), 'list', 'ic_car_queue'), count: tree['lib:queues'].length },
    // On Home while they are few; the drawer is for when they outgrow it.
    {
      node: drawer('lib:bookmarks', tg('Bookmarks'), 'list', 'ic_car_bookmark'),
      count: overflowsHome(bookmarkNodes.length, HOME_BOOKMARKS) ? bookmarkNodes.length : 0,
    },
    { node: drawer('lib:smart', tg('Smart playlists'), 'list', 'ic_car_smart_playlists'), count: smartLists.length },
  ]);

  // After the shelf, whose list it reads back out of the cache.
  const mixes = await mixList(deep);

  // ── Home ──
  // What a driver taps with the engine running, in the order they ask for it.
  // The queue and the resume points first: picking up is the commonest thing
  // to want. Then two things that need no choosing, which play on the tap:
  // they are leaves, not folders, and nothing is fetched for them until
  // somebody presses. The mixes next, made out of what this driver plays,
  // which is a better guess than what came in last; then the newest records,
  // and the playlists pinned on the phone. Each group is cut short: the tab
  // is read, not scrolled, and the Library has the rest.
  const resume = resumeNode();
  tree['tab:home'] = tabLayout([
    {
      heading: tg('Continue listening'),
      nodes: [...(resume ? [resume] : []), ...bookmarkNodes],
      max: (resume ? 1 : 0) + HOME_BOOKMARKS,
    },
    {
      nodes: [
        // First of the three: it is the one that needs no choice made about
        // it, which is the only kind of row worth pressing while driving.
        {
          id: FOR_YOU_ID,
          title: tg('For you'),
          subtitle: tg('Built from what you play'),
          artworkUrl: icon('ic_car_foryou'),
          playable: true,
        },
        { id: SHUFFLE_ID, title: tg('Shuffle everything'), artworkUrl: icon('ic_car_shuffle'), playable: true },
        {
          id: SHUFFLE_FAVORITES_ID,
          title: tg('Favorites'),
          subtitle: songsLabel(starred.songs.length, lang),
          artworkUrl: icon('ic_car_favorites'),
          playable: true,
        },
      ],
    },
    { heading: tg('Made for you'), nodes: mixes.map((m) => mixNode(into, m)), max: HOME_MIXES },
    { heading: tg('Recently added'), nodes: newest.map((a) => albumNode(into, a)), max: HOME_RECENT_ALBUMS },
    { heading: tg('Pinned'), nodes: pinnedPlaylists(playlists).map((p) => playlistNode(into, p)), max: HOME_PINNED },
  ]);

  // Marked for what it is: the lists, and none of the songs inside them. The
  // native side lays it over the tree it already has rather than taking it for
  // the whole library.
  if (!deep) {
    await resolveCachedArt(tree);
    return { nodes: tree, partial: true, profile };
  }

  // The songs of each playlist, so they can be browsed and not only played
  // whole. Capped like everything else here: a car that is never plugged in
  // should not cost a request per playlist on every launch (#50). The cap
  // follows the order they are shown in, so what it pays for is what a driver
  // sees first and not whatever the server happened to send first: the pinned
  // ones, then the recently played, then the copies kept on the phone.
  const playlistIds = new Set<string>([
    ...pinnedPlaylists(playlists).map((p) => p.id),
    ...orderedPlaylists.map((p) => p.id),
    ...downloaded.playlists.map((p) => p.id),
  ]);
  await mapConcurrent(Array.from(playlistIds).slice(0, MAX_PREFETCH_PLAYLISTS), CONCURRENCY, async (id) => {
    const parent = `playlist:${id}`;
    try {
      const { songs } = await playlistDetail(id);
      tree[parent] = songs.map((s) => songNode(into, s, parent));
      into.parentTracks.set(parent, tree[parent].map((n) => n.id));
    } catch {
      keep(parent);
    }
  });

  // Prefetch songs for each album (to browse them in the car), up to a point.
  // Measured on a real account: fifty eight favourite artists meant six
  // hundred and forty four album requests in a single minute, plus their top
  // songs, every time the app opened. What a car needs at hand is the top of
  // each list; the rest can be empty until someone asks for it (#50).
  await mapConcurrent(Array.from(albumIds).slice(0, MAX_PREFETCH_ALBUMS), CONCURRENCY, async (id) => {
    try {
      const { songs } = await albumDetail(id);
      const parent = `album:${id}`;
      tree[parent] = songs.map((s) => songNode(into, s, parent));
      into.parentTracks.set(parent, tree[parent].map((n) => n.id));
    } catch {
      keep(`album:${id}`);
    }
  });

  // Prefetch for starred artists: top songs + albums (and their tracks).
  await mapConcurrent(starred.artists.slice(0, MAX_PREFETCH_ARTISTS).map((a) => a.id), CONCURRENCY, async (id) => {
    try {
      const { artist, albums } = await data.getArtist(id);
      const top = artist.name ? await data.getTopSongs(artist.name, 10).catch(() => [] as Song[]) : [];
      const parent = `artist:${id}`;
      const children: CarNode[] = [
        ...top.map((s) => songNode(into, s, parent)),
        ...albums.map((a) => albumNode(into, a)),
      ];
      tree[parent] = children;
      into.parentTracks.set(parent, children.filter((n) => n.playable).map((n) => n.id));
      for (const a of albums.slice(0, MAX_ARTIST_ALBUMS)) {
        const ap = `album:${a.id}`;
        if (!tree[ap]) {
          try {
            const { songs } = await albumDetail(a.id);
            tree[ap] = songs.map((s) => songNode(into, s, ap));
            into.parentTracks.set(ap, tree[ap].map((n) => n.id));
          } catch {
            keep(ap);
          }
        }
      }
    } catch {
      keep(`artist:${id}`);
    }
  });

  // The songs of each smart playlist, run over the whole library the way the
  // phone runs them. Last, because the library comes down a page at a time
  // and the albums above are the likelier tap; it is kept for a while under
  // the smart playlist screen's own key, so the second list costs nothing and
  // neither does opening one on the phone afterwards. A random list is dealt
  // here and stays dealt until the next build: what the car shows is what a
  // tap on a row will queue.
  if (smartLists.length > 0) {
    try {
      const library = await allSongs();
      for (const list of smartLists) {
        const parent = `smart:${list.id}`;
        tree[parent] = resolveSmartPlaylist(library, list)
          .slice(0, MAX_SMART_SONGS)
          .map((s) => songNode(into, s, parent));
        into.parentTracks.set(parent, tree[parent].map((n) => n.id));
      }
    } catch {
      smartLists.forEach((list) => keep(`smart:${list.id}`));
    }
  }

  await resolveCachedArt(tree);

  // Only now, with every song in it, and only if the account is still the one
  // it was built for.
  if (profile === mapsProfile) {
    resolve = into;
    lastTree = tree;
  }
  return { nodes: tree, profile };
}

// ── The car's search box ─────────────────────────────────────────────────────

/**
 * How many of each kind the library adds to a search. A driver reads the top
 * of a list and taps; the rest is a scroll nobody makes at the wheel, and the
 * rows all have to fit in one answer over the bridge.
 */
const FOUND_SONGS = 25;
const FOUND_ALBUMS = 15;
const FOUND_ARTISTS = 15;

/** The parent a song found by the search box is queued from. A fixed id and
 *  not the query: a track's mediaId is split on `|`, and what was typed can
 *  hold anything. */
const FOUND_ID = 'found';

/** What the last search found, kept aside from `resolve` because a rebuild
 *  swaps that whole set and a row on the car's screen has to still play. */
let lastFound: { query: string; songs: Song[] } = { query: '', songs: [] };

/**
 * A found album or artist as a row that plays rather than one that opens: the
 * tree holds none of its songs, so opening it would show an empty list, while
 * a tap on it queues the whole thing (`handleBrowsePlay`). The tree's own hits
 * are left as they are, since an album that is in it does open onto its songs.
 */
function playableLeaf(node: CarNode): CarNode {
  const leaf: CarNode = { ...node, playable: true };
  delete leaf.contentStyle;
  return leaf;
}

/**
 * What the car's search box shows for `query`: what the phone's tree already
 * answers with (`local`, ranked by the native side) and what the library has
 * behind it.
 *
 * The library is the point of it. The tree carries the shelves, the pinned
 * playlists, the downloads and the songs of the albums that were prefetched,
 * so a record nobody had played lately was not found however plainly it was
 * typed. Here it is asked of the server, which is the same road a spoken
 * request already takes (`playSpoken`).
 *
 * Nothing waits on this for long and nothing here decides that: the native
 * side gives up after a few seconds and shows the tree's own hits, and what
 * arrives late is kept for the next try. Offline the search runs over the
 * songs on the phone, and one whose file is not there is left out, since a
 * row that plays nothing is worse than a row less.
 */
export async function carSearch(query: string, local: CarNode[]): Promise<CarNode[]> {
  const { auth, offline } = useAuthStore.getState();
  if (!auth && !offline) return local;
  const found = await data
    .search(query)
    .catch(() => ({ artists: [] as Artist[], albums: [] as Album[], songs: [] as Song[] }));
  const songs = data.markUnplayableOffline(found.songs.slice(0, FOUND_SONGS)).filter((s) => !s.unavailable);
  lastFound = { query, songs };
  const nodes = [
    ...songs.map((s) => songNode(resolve, s, FOUND_ID)),
    ...found.albums.slice(0, FOUND_ALBUMS).map((a) => playableLeaf(albumNode(resolve, a))),
    ...found.artists.slice(0, FOUND_ARTISTS).map((a) => playableLeaf(artistNode(resolve, a))),
  ];
  // Before the rows are laid out, which copies them: a cover the car host
  // cannot fetch for itself is a file of the phone's or nothing at all, the
  // same as everywhere else in the tree.
  await resolveCachedArt({ [FOUND_ID]: nodes });
  return searchRows(query, local, nodes, {
    song: tg('Songs'),
    album: tg('Albums'),
    artist: tg('Artists'),
    playlist: tg('Playlists'),
  });
}

// ── Playback resolution on car tap ───────────────────────────────────────────

function songIdFromTrackMediaId(mediaId: string): string {
  // format: track|<parentId>|<songId>
  return mediaId.split('|').slice(2).join('|');
}

/**
 * Where a car started playing from, in the app's own terms: the href of the
 * screen that collection has on the phone, and what it is called.
 *
 * Handed to `playQueue`, which is what writes the source down as recently
 * played. Without it a car left no trace at all: the Recents tab is built out
 * of exactly that store, so for anyone who only ever plays from the car it
 * stayed empty no matter how much they listened.
 */
function sourceOf(collectionId: string | undefined): [string, string] | [] {
  if (!collectionId) return [];
  if (collectionId === 'favorites') return [tg('Favorites'), '/favorites'];
  const [prefix, ...rest] = collectionId.split(':');
  const id = rest.join(':');
  if (!id) return [];
  // Named from the store rather than from `nodeTitles`: that is where the
  // name lives, and it is current after a rename on the phone.
  if (prefix === 'smart') {
    const list = useSmartPlaylists.getState().lists.find((l) => l.id === id);
    return [list?.name ?? '', `/smart-playlist/${id}`];
  }
  // The YouTube tab's own lists. Their names are the account's, so they come
  // from what the tree wrote down; the liked songs have no screen of their own
  // and lead back to the tab.
  if (prefix === 'yt') {
    if (id === 'liked') return [tg('Liked songs'), '/youtube'];
    // A shelf of the home page has no screen of its own; the tab is where it
    // is shown, and its own name is what the queue is called after.
    if (id.startsWith('shelf:')) return [resolve.nodeTitles.get(collectionId) ?? 'YouTube', '/youtube'];
    const listId = id.startsWith('pl:') ? id.slice(3) : '';
    if (!listId) return [];
    return [resolve.nodeTitles.get(collectionId) ?? '', `/youtube/${listId}`];
  }
  if (prefix !== 'album' && prefix !== 'playlist' && prefix !== 'artist') return [];
  return [resolve.nodeTitles.get(collectionId) ?? '', `/${prefix}/${id}`];
}

/** The favourite songs, from the cache when the tree was built from it. */
function starredSongs(): Promise<Song[]> {
  return queryClient
    .fetchQuery({ queryKey: ['starred'], queryFn: () => data.getStarred() })
    .then((s) => s.songs);
}

/**
 * Picks the song up where its bookmark is, the way a row on the Bookmarks
 * screen does: the song alone, then a seek once the player has taken it.
 * The bookmark from the store first, which is current after a move on another
 * device; the build's copy for a car that started from the snapshot; and the
 * server as a last resort.
 */
async function playBookmark(songId: string): Promise<void> {
  const store = usePlayerStore.getState();
  const known = useBookmarks.getState().byId[songId] ?? resolve.bookmarks.get(songId);
  let bm = known;
  if (!bm) {
    await loadBookmarks().catch(() => {});
    bm = useBookmarks.getState().byId[songId];
  }
  if (!bm) return;
  const ok = await store.playQueue([bm.song], 0, tg('Bookmarks'), '/bookmarks');
  if (ok) usePlayerStore.getState().seekTo(bm.position / 1000);
}

/**
 * Brings a past queue back and plays on from where it was, as the Past queues
 * screen does: the songs asked for by id, so one the server no longer has
 * drops out, and the cursor on the song it was on if that one is still there.
 */
async function playPastQueue(id: string): Promise<void> {
  const history = useQueueHistory.getState();
  await history.hydrate().catch(() => {});
  const q = useQueueHistory.getState().queues.find((x) => x.id === id) ?? resolve.pastQueues.get(id);
  if (!q) return;
  const songs = await data.getSongsByIds(q.songIds).catch(() => [] as Song[]);
  if (songs.length === 0) return;
  const wanted = q.songIds[q.index];
  const at = Math.max(
    0,
    songs.findIndex((s) => s.id === wanted),
  );
  await usePlayerStore.getState().playQueue(songs, at, q.title);
}

/** Ceiling on what a spoken request queues from a search of songs. */
const SPOKEN_SONGS = 50;

/**
 * "Play <something>" for a something the tree does not hold: the native side
 * searched what it has and found nothing, so the library is asked.
 *
 * A name first, a song last. A playlist, an artist or an album called exactly
 * what was said is the answer to "play X" far more often than a song of that
 * name, and each of those is one tap's worth of music rather than one track.
 * Failing an exact name, the closest album or artist the server offers; and
 * failing those, the songs it found, dealt once, which is at least the right
 * kind of music. Offline the same search runs over what is on the phone.
 */
async function playSpoken(query: string): Promise<void> {
  const store = usePlayerStore.getState();
  const said = fold(query);
  if (!said) return;
  const [found, playlists] = await Promise.all([
    data.search(query).catch(() => ({ artists: [] as Artist[], albums: [] as Album[], songs: [] as Song[] })),
    queryClient
      .fetchQuery({ queryKey: ['playlists'], queryFn: () => data.getPlaylists() })
      .catch(() => [] as Playlist[]),
  ]);
  const exact = <T>(items: T[], name: (item: T) => string | undefined) =>
    items.find((item) => fold(name(item) ?? '') === said);

  const playlist = exact(playlists, (p) => p.name);
  if (playlist) {
    const { songs } = await playlistDetail(playlist.id).catch(() => ({ songs: [] as Song[] }));
    if (songs.length > 0) await store.playQueue(songs, 0, playlist.name, `/playlist/${playlist.id}`);
    return;
  }
  const artist = exact(found.artists, (a) => a.name) ?? found.artists[0];
  const album = exact(found.albums, (a) => a.name) ?? found.albums[0];
  // An exact artist beats a close album; an exact album beats a close artist;
  // both close, the album, which is a record and not a guess at a catalogue.
  const pick: { kind: 'artist'; item: Artist } | { kind: 'album'; item: Album } | null =
    artist && fold(artist.name) === said
      ? { kind: 'artist', item: artist }
      : album
        ? { kind: 'album', item: album }
        : artist
          ? { kind: 'artist', item: artist }
          : null;
  if (pick?.kind === 'artist') {
    const songs = await data.getTopSongs(pick.item.name, SPOKEN_SONGS).catch(() => [] as Song[]);
    if (songs.length > 0) {
      await store.playQueue(songs, 0, pick.item.name, `/artist/${pick.item.id}`);
      return;
    }
  }
  if (pick?.kind === 'album') {
    const { songs } = await albumDetail(pick.item.id).catch(() => ({ songs: [] as Song[] }));
    if (songs.length > 0) {
      await store.playQueue(songs, 0, pick.item.name, `/album/${pick.item.id}`);
      return;
    }
  }
  const songs = found.songs.slice(0, SPOKEN_SONGS);
  if (songs.length > 0) await store.playQueue(songs, 0, query, undefined, { shuffled: true });
}

/**
 * Handles a car tap: if it's a track within a collection, queues the whole
 * collection starting from the tapped one; if it's an album/playlist/artist/favorites,
 * plays everything. The leaves of Home and the Library (the queue, a resume
 * point, a past queue, a genre, a mix, the two shuffles) each play their own
 * thing, and a spoken request the tree could not answer goes to the library.
 */
export async function handleBrowsePlay(mediaId: string, parentId?: string): Promise<void> {
  const store = usePlayerStore.getState();

  // Asked for only now, which is the point of it: a shelf of random albums
  // would have to be fetched on every rebuild to sit there unplayed. No source
  // href goes with it, because there is no screen to go back to and a handful
  // of songs picked at random is not a thing to list among the recents.
  // Gathered now rather than at every rebuild: it asks the server for several
  // artists and genres and YouTube for its own picks, which is a great deal of
  // traffic for a row that is usually not pressed. The playlist it leaves
  // behind is written on its own behind the music (`forYouMix`).
  if (mediaId === FOR_YOU_ID) {
    await playForYou().catch(() => {});
    return;
  }

  if (mediaId === SHUFFLE_ID) {
    const songs = await data.getRandomSongs(SHUFFLE_SONGS).catch(() => [] as Song[]);
    if (songs.length > 0) await store.playQueue(songs, 0, tg('Shuffle'));
    return;
  }

  // The favourites dealt once, under their own name: the same thing the
  // Favorites screen's shuffle button does.
  if (mediaId === SHUFFLE_FAVORITES_ID) {
    const songs = await starredSongs().catch(() => [] as Song[]);
    if (songs.length > 0) await store.playQueue(songs, 0, tg('Favorites'), '/favorites', { shuffled: true });
    return;
  }

  // The queue as it stands: nothing is replaced, it is only set going. A
  // queue that is already playing is left alone, and no queue at all is
  // nothing to resume (the row is not drawn then; a stale snapshot may still
  // hold it).
  if (mediaId === RESUME_ID) {
    if (store.queue.length > 0 && !store.isPlaying) store.toggle();
    return;
  }

  // A tile of the YouTube tab. Nothing was fetched to draw it, so this is
  // where it turns into music: a playlist or a record becomes its tracks, a
  // video becomes the one song. Fetched at the press rather than ahead of
  // time, which is what lets the tab carry every shelf of the home page for
  // the cost of the one request that drew it.
  if (mediaId.startsWith('yt:pl:') || mediaId.startsWith('yt:v:')) {
    const isList = mediaId.startsWith('yt:pl:');
    const id = mediaId.slice(isList ? 'yt:pl:'.length : 'yt:v:'.length);
    const name = resolve.nodeTitles.get(mediaId) ?? '';
    const songs = await (isList
      ? data.youtubePlaylistSongs(id, YOUTUBE_TRACKS)
      : data.getSongsByIds([id])
    ).catch(() => [] as Song[]);
    if (songs.length === 0) {
      bump('car · youtube tile resolved to nothing');
      return;
    }
    bump(isList ? 'car · youtube list played' : 'car · youtube track played');
    await store.playQueue(songs, 0, name || 'YouTube');
    return;
  }

  if (mediaId.startsWith('track|')) {
    const parts = mediaId.split('|');
    const parent = parts[1] || parentId;
    const songId = parts.slice(2).join('|');
    // A row of the car's search box: what was found is the queue, so the rest
    // of the answer plays on behind the song that was tapped, under the words
    // that found it.
    if (parent === FOUND_ID) {
      const at = lastFound.songs.findIndex((s) => s.id === songId);
      if (at >= 0) {
        await store.playQueue(lastFound.songs, at, lastFound.query);
        return;
      }
    }
    const ids = parent ? resolve.parentTracks.get(parent) : undefined;
    if (ids && ids.length > 0) {
      const songs = ids
        .map((id) => resolve.songById.get(songIdFromTrackMediaId(id)))
        .filter((s): s is Song => !!s);
      const startIndex = Math.max(0, ids.indexOf(mediaId));
      if (songs.length > 0) {
        const [name, href] = sourceOf(parent);
        await store.playQueue(songs, Math.min(startIndex, songs.length - 1), name, href);
        return;
      }
    }
    // Nothing in the maps for it. That is not a strange case: the car can
    // start this runtime itself and browse the tree written to disk by an
    // earlier one, while the maps that turn a row back into a song are built
    // fresh each time and may not be ready yet. Giving up here is how a tap
    // came to do nothing at all, now and then, with no way to tell why.
    const single =
      resolve.songById.get(songId) ??
      (await data
        .getSongsByIds([songId])
        .then((found) => found[0])
        .catch(() => undefined));
    if (single) {
      bump('car · played by asking the server');
      await store.playQueue([single], 0);
    } else {
      bump('car · tap resolved to nothing');
    }
    return;
  }

  const [prefix, ...rest] = mediaId.split(':');
  const id = rest.join(':');

  if (prefix === 'bookmark') return playBookmark(id);
  if (prefix === 'queue') return playPastQueue(id);
  if (prefix === 'search') return playSpoken(id);

  // A genre shuffles itself, like the genre screen's own button, under the
  // genre's name and screen.
  if (prefix === 'genre') {
    const songs = await data.getRandomSongs(SHUFFLE_SONGS, id).catch(() => [] as Song[]);
    if (songs.length > 0) await store.playQueue(songs, 0, id, `/genre/${encodeURIComponent(id)}`);
    return;
  }

  // A mix is built when it is tapped, like the card on Home, and plays under
  // the mix's name with no href: there is no screen a mix lives on. The tile
  // came from a build of this process, so the mix is in hand; if the car
  // started from the snapshot before any build ran, the list is made again
  // from what the stores and the cache hold, which is what the tile was made
  // from too.
  if (prefix === 'mix') {
    const mix = resolve.mixes.get(id) ?? (await mixList(false)).find((m) => m.key === id);
    if (!mix) return;
    const songs = await mix.load().catch(() => [] as Song[]);
    if (songs.length > 0) await store.playQueue(songs, 0, tg(mix.title.key, mix.title.vars));
    return;
  }

  let songs: Song[] = [];
  try {
    if (prefix === 'album') songs = (await albumDetail(id)).songs;
    else if (prefix === 'playlist') songs = (await playlistDetail(id)).songs;
    else if (prefix === 'favorites') songs = await starredSongs();
    else if (prefix === 'artist') {
      const { artist } = await data.getArtist(id);
      songs = artist.name ? await data.getTopSongs(artist.name, 20) : [];
    } else if (prefix === 'smart') {
      // Resolved now rather than read off the tree: the rules are the list,
      // and a random one is dealt afresh, as it is when it is opened on the
      // phone. The library itself is the cached copy the tree was built from.
      const list = useSmartPlaylists.getState().lists.find((l) => l.id === id);
      if (list) songs = resolveSmartPlaylist(await allSongs(), list);
    }
  } catch {
    songs = [];
  }
  if (songs.length > 0) {
    const [name, href] = sourceOf(mediaId);
    await store.playQueue(songs, 0, name, href);
  }
}
