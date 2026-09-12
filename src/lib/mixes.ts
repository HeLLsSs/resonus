/**
 * The "Made for you" shelf: mixes put together on the phone, out of what the
 * phone already knows.
 *
 * None of this needs anything from the server that it does not already offer.
 * A Subsonic server can hand over songs similar to one, random songs of a
 * genre or of a span of years, and the songs of an album; what it cannot do
 * is say which of those somebody would want, and that is what the play
 * history, the "recents" and the covers that have been on screen are for.
 *
 * Each mix is a card: what to call it, what to draw on it, and a `load` that
 * builds the queue only when the card is tapped, since a shelf of six cards
 * that each cost a handful of requests on every visit to Home is a shelf
 * nobody asked for. The functions below decide what the cards are and are
 * plain data in, data out; the requests live inside the `load`s.
 */
import {
  getAlbum,
  getRandomSongs,
  getSimilarSongs,
  type Album,
  type Genre,
  type Song,
} from '@/api/data';
import { type HistoryEntry } from '@/store/playHistory';

/** Something to write on a card, as an i18n key with its placeholders. */
export interface MixText {
  key: string;
  vars?: Record<string, string | number>;
}

export interface Mix {
  key: string;
  title: MixText;
  subtitle: MixText;
  /** Cover ids, what `coverArtUrl` takes. Up to four; the first stands alone
   *  when there are fewer than four to make a mosaic of. */
  covers: string[];
  /** The queue, built when the card is tapped and not before. */
  load: () => Promise<Song[]>;
}

/** How long a mix is. Long enough to listen through, short enough to read. */
const MIX_SIZE = 50;
/** How many covers a card shows. */
const COVERS = 4;

// ── Time of day ──────────────────────────────────────────────────────────────

export type DaySlot = 'morning' | 'afternoon' | 'evening' | 'night';

/** When morning, afternoon and evening start, in that order (see
 *  `greetingHours` in the i18n module, which is where these come from). */
export type DayHours = readonly [number, number, number];

/** The slot an hour falls in. The same split as the greeting at the top of
 *  Home, so the mix says the same thing the page does. */
export function daySlot(hour: number, [morning, afternoon, evening]: DayHours): DaySlot {
  if (hour >= morning && hour < afternoon) return 'morning';
  if (hour >= afternoon && hour < evening) return 'afternoon';
  if (hour >= evening) return 'evening';
  return 'night';
}

const SLOT_TITLE: Record<DaySlot, string> = {
  morning: 'Morning mix',
  afternoon: 'Afternoon mix',
  evening: 'Evening mix',
  night: 'Night mix',
};

const SLOT_SUBTITLE: Record<DaySlot, string> = {
  morning: 'What you play in the morning',
  afternoon: 'What you play in the afternoon',
  evening: 'What you play in the evening',
  night: 'What you play at night',
};

/**
 * How many plays a slot needs before it says something about the slot. Under
 * that, the mix is built from the whole history and says so, rather than from
 * two songs that happened to be on one morning.
 */
const MIN_SLOT_PLAYS = 3;
/** How many artists and genres the mix draws on, and how much from each. */
const SEED_ARTISTS = 3;
const SEED_GENRES = 2;
const PER_SEED = 15;

/** The most frequent keys first, each with the first item seen under it. */
function ranked<T>(items: T[], keyOf: (item: T) => string | undefined): { key: string; first: T }[] {
  const counts = new Map<string, { key: string; n: number; first: T }>();
  for (const it of items) {
    const key = keyOf(it);
    if (!key) continue;
    const hit = counts.get(key);
    if (hit) hit.n += 1;
    else counts.set(key, { key, n: 1, first: it });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n);
}

/** A song's cover id, the way every list resolves it. */
function coverOf(song: Song): string | undefined {
  return song.coverArt ?? song.albumId;
}

function firstCovers(songs: Song[]): string[] {
  const out: string[] = [];
  for (const s of songs) {
    const id = coverOf(s);
    if (id && !out.includes(id)) out.push(id);
    if (out.length === COVERS) break;
  }
  return out;
}

/** Deduplicates by id, keeping the first seen. */
function dedupeById(songs: Song[]): Song[] {
  const seen = new Set<string>();
  return songs.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

/**
 * How little of a song has to be heard for the play to be a rejection rather
 * than a taste. A song goes into the history the moment it starts, so without
 * this a mix is partly built out of what somebody skipped.
 *
 * A play with nothing recorded counts: those are the entries written before
 * the app kept track, and the songs with no duration to be a share of.
 */
const SKIPPED = 0.2;

export function wasListenedTo(entry: HistoryEntry): boolean {
  return entry.heard === undefined || entry.heard >= SKIPPED;
}

/** Shuffles a copy (Fisher-Yates). */
function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The mix for this time of day, or null with no history to build one from.
 *
 * Built from the songs played in the same slot on other days: the artists and
 * genres that come up most, each asked for similar songs or random songs of
 * that genre. A few of the songs themselves go in as well, so the mix opens on
 * something recognisable rather than on a guess.
 */
export function timeOfDayMix(
  entries: HistoryEntry[],
  slot: DaySlot,
  hours: DayHours,
): Mix | null {
  if (entries.length === 0) return null;
  const listened = entries.filter(wasListenedTo);
  const inSlot = listened.filter((e) => daySlot(new Date(e.playedAt).getHours(), hours) === slot);
  const fromSlot = inSlot.length >= MIN_SLOT_PLAYS;
  const pool = (fromSlot ? inSlot : listened).map((e) => e.song);
  const artistSeeds = ranked(pool, (s) => s.artistId ?? s.artist)
    .slice(0, SEED_ARTISTS)
    .map((r) => r.first);
  const genres = ranked(pool, (s) => s.genre ?? s.genres?.[0]?.name)
    .slice(0, SEED_GENRES)
    .map((r) => r.key);
  return {
    key: `slot-${slot}`,
    title: { key: SLOT_TITLE[slot] },
    subtitle: { key: fromSlot ? SLOT_SUBTITLE[slot] : 'Based on what you listen to' },
    covers: firstCovers(pool),
    load: async () => {
      // Each source on its own: a server without similar songs (or a genre
      // the server spells differently) costs that source, not the mix.
      const lists = await Promise.all([
        ...artistSeeds.map((s) => getSimilarSongs(s.id, PER_SEED).catch(() => [])),
        ...genres.map((g) => getRandomSongs(PER_SEED, g).catch(() => [])),
      ]);
      const fresh = shuffled(dedupeById(lists.flat()));
      // The pool is what was actually played; without anything similar to add
      // to it, it is still a mix of this time of day.
      const known = pool.slice(0, fresh.length > 0 ? 5 : MIX_SIZE);
      return dedupeById(shuffled([...known, ...fresh])).slice(0, MIX_SIZE);
    },
  };
}

// ── Rediscover ───────────────────────────────────────────────────────────────

/** How long something has to go unplayed before it counts as forgotten. */
const REDISCOVER_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** How many forgotten albums the mix draws on, and how much from each. */
const REDISCOVER_ALBUMS = 8;
const PER_ALBUM = 4;
/** How many forgotten songs from the history go in on their own. */
const REDISCOVER_SONGS = 20;

/**
 * Music that was played, and then not for a month: albums from the "recents"
 * (the Library's own record of what was opened, kept per profile) and songs
 * from the play history. Null when nothing is old enough yet, which is what a
 * new profile looks like for its first month.
 *
 * The server's own "recently played, but not lately" is the Discover shelf
 * beside this one; this one works off what this phone wrote down, which also
 * counts what was played with no connection.
 */
export function rediscoverMix(
  entries: HistoryEntry[],
  times: Record<string, number>,
  now: number,
): Mix | null {
  const cutoff = now - REDISCOVER_AFTER_MS;
  const albumIds = Object.entries(times)
    .filter(([href, ts]) => href.startsWith('/album/') && ts <= cutoff)
    // Oldest first: the longer it has been, the more of a rediscovery it is.
    .sort((a, b) => a[1] - b[1])
    .map(([href]) => href.slice('/album/'.length))
    .filter((id) => id)
    .slice(0, REDISCOVER_ALBUMS);
  // Newest first in the history, so the forgotten ones are at the end.
  const songs = entries
    .filter((e) => e.playedAt <= cutoff)
    .slice(-REDISCOVER_SONGS)
    .map((e) => e.song);
  if (albumIds.length === 0 && songs.length === 0) return null;
  return {
    key: 'rediscover',
    title: { key: 'Rediscover' },
    subtitle: { key: "Music you haven't played in a while" },
    covers: [...albumIds.slice(0, COVERS), ...firstCovers(songs)].slice(0, COVERS),
    load: async () => {
      const albums = await Promise.all(
        albumIds.map((id) => getAlbum(id).catch(() => ({ songs: [] as Song[] }))),
      );
      const fromAlbums = albums.flatMap((al) => shuffled(al.songs).slice(0, PER_ALBUM));
      return dedupeById(shuffled([...fromAlbums, ...songs])).slice(0, MIX_SIZE);
    },
  };
}

// ── Decades ──────────────────────────────────────────────────────────────────

/** How many albums a decade needs before it gets a card, and how many cards. */
const MIN_DECADE_ALBUMS = 3;
const MAX_DECADES = 4;

function albumYear(album: Album): number | undefined {
  return album.originalReleaseDate?.year ?? album.releaseDate?.year ?? album.year;
}

/**
 * One card per decade the library has enough of, most represented first.
 *
 * Which decades exist is read off whatever albums have already been seen (the
 * Home shelves, plus a random sample asked for on purpose) rather than off the
 * whole library, which nothing here could afford to list. A decade with a few
 * albums in that sample has a good many in the library; one with none is
 * probably thin, and a card that plays three songs on repeat is worse than no
 * card.
 */
export function decadeMixes(albums: Album[]): Mix[] {
  const byDecade = new Map<number, Album[]>();
  const seen = new Set<string>();
  for (const al of albums) {
    if (seen.has(al.id)) continue;
    seen.add(al.id);
    const year = albumYear(al);
    if (!year || year < 1000) continue;
    const decade = Math.floor(year / 10) * 10;
    const list = byDecade.get(decade);
    if (list) list.push(al);
    else byDecade.set(decade, [al]);
  }
  return [...byDecade.entries()]
    .filter(([, list]) => list.length >= MIN_DECADE_ALBUMS)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_DECADES)
    .map(([decade, list]) => ({
      key: `decade-${decade}`,
      title: { key: '{decade}s mix', vars: { decade } },
      subtitle: { key: 'Songs from those years' },
      covers: list.slice(0, COVERS).map((al) => al.coverArt ?? al.id),
      load: () => getRandomSongs(MIX_SIZE, undefined, { fromYear: decade, toYear: decade + 9 }),
    }));
}

// ── Genre radios ─────────────────────────────────────────────────────────────

/** How many genres get a card: the biggest ones, which is where the
 *  listening is. */
export const MAX_GENRE_MIXES = 4;

/** The genres that get a card, biggest first. Exported so the shelf can ask
 *  for their covers before the cards are made. */
export function topGenres(genres: Genre[]): Genre[] {
  return [...genres].sort((a, b) => (b.songCount ?? 0) - (a.songCount ?? 0)).slice(0, MAX_GENRE_MIXES);
}

/**
 * A radio per genre: random songs of it, the same thing the genre screen's
 * shuffle plays. `artOf` hands back the albums whose covers go on the card,
 * or nothing while they are still being asked for.
 */
export function genreMixes(genres: Genre[], artOf: (genre: string) => Album[] | undefined): Mix[] {
  return topGenres(genres).map((g) => ({
    key: `genre-${g.value}`,
    title: { key: '{genre} radio', vars: { genre: g.value } },
    subtitle: { key: 'Random songs from the genre' },
    covers: (artOf(g.value) ?? []).slice(0, COVERS).map((al) => al.coverArt ?? al.id),
    load: () => getRandomSongs(MIX_SIZE, g.value),
  }));
}

// ── The whole shelf ──────────────────────────────────────────────────────────

/**
 * What the cards above are made from, gathered by whoever wants the shelf.
 * Home reads these through hooks and the car through the stores and the query
 * cache directly; the choosing itself is the same in both places and lives in
 * `allMixes`, so a mix on the phone and its twin in the car have one name and
 * play one thing.
 */
export interface MixSources {
  entries: HistoryEntry[];
  /** When each source was last played, by href (`useLastPlayed`). */
  times: Record<string, number>;
  hours: DayHours;
  now: number;
  /** Every album seen so far, which is what says which decades exist. */
  albums: Album[];
  genres: Genre[];
  /** The albums whose covers go on a genre's card, or nothing yet. */
  artOf: (genre: string) => Album[] | undefined;
}

/** Every mix there is for these sources, in the order the shelf shows them. */
export function allMixes(src: MixSources): Mix[] {
  const slot = daySlot(new Date(src.now).getHours(), src.hours);
  return [
    timeOfDayMix(src.entries, slot, src.hours),
    rediscoverMix(src.entries, src.times, src.now),
    ...decadeMixes(src.albums),
    ...genreMixes(src.genres, src.artOf),
  ].filter((m): m is Mix => m !== null);
}
