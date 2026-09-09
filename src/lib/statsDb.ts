/**
 * The listening log, in SQLite.
 *
 * The play history (`store/playHistory`) is a list of the last hundred songs,
 * one entry per song, which is what a "recently played" screen wants and
 * nothing a statistic can be built on: it forgets a listen the moment the same
 * song plays again, and it forgets everything past a hundred. This is the
 * other record, one row per honest listen (the same threshold the scrobble
 * uses), kept for good, and asked about in aggregate: which hour of the day
 * you listen at, which day of the week, who you listen to most.
 *
 * One database per profile, named after it, so the listening of one account
 * does not show up in another's charts. Nothing here is ever pruned: a row is
 * about sixty bytes, and a year of heavy listening is a few thousand of them.
 *
 * The counting is done by SQLite (`GROUP BY`), never by reading the rows out:
 * the whole point of keeping the log in a database rather than a JSON file is
 * that the screen only ever asks for the totals.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import type { Song } from '@/api/subsonic';
import { profileScopeId } from '@/store/auth';
import { hashKey } from './localLibrary';

const DIR = FileSystem.documentDirectory + 'stats/';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA journal_size_limit = 524288;
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT NOT NULL,
  title TEXT,
  artist TEXT,
  artist_id TEXT,
  album TEXT,
  album_id TEXT,
  cover_art TEXT,
  duration_sec INTEGER,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_played_at ON plays(played_at);
`;

/** One handle per profile, kept open (see `mirrorDb` on why not closing). */
const open = new Map<string, Promise<SQLite.SQLiteDatabase>>();

/**
 * Lets go of a profile's database, so its file can be deleted with it. The
 * handle would otherwise outlive what it points at, and adding the same
 * account back would reopen a database the account no longer owns: last
 * year's plays in this year's charts.
 */
export async function closeStatsFor(profile: string): Promise<void> {
  const handle = open.get(profile);
  if (!handle) return;
  open.delete(profile);
  await handle.then((db) => db.closeAsync()).catch(() => {});
}

/** The profile's id is a URL and a user name; the file name is its hash. */
function dbName(profile: string): string {
  return `stats-${hashKey(profile)}.db`;
}

function statsDb(profile: string): Promise<SQLite.SQLiteDatabase> {
  const existing = open.get(profile);
  if (existing) return existing;
  // A failed open is forgotten rather than handed to every later caller; see
  // `downloadsDb` for the session-long breakage that remembering it causes.
  const handle: Promise<SQLite.SQLiteDatabase> = (async () => {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
    // SQLite joins directory and name as plain text and knows nothing about
    // the `file://` the file system module speaks.
    const db = await SQLite.openDatabaseAsync(dbName(profile), {}, DIR.replace(/^file:\/\//, ''));
    await db.execAsync(SCHEMA);
    return db;
  })().catch((e) => {
    if (open.get(profile) === handle) open.delete(profile);
    throw e;
  });
  open.set(profile, handle);
  return handle;
}

/**
 * Writes one listen down. Called when the scrobble threshold is crossed, so
 * a skipped song leaves no trace, and called the same way offline: the log is
 * about this phone, not about what the server was told.
 *
 * Best effort. A statistic that misses a row is still a statistic, and the
 * player must never wait on, or fail because of, a bookkeeping write.
 */
export async function recordPlay(song: Song, at: number): Promise<void> {
  if (!song?.id) return;
  try {
    const db = await statsDb(profileScopeId());
    await db.runAsync(
      `INSERT INTO plays
         (song_id, title, artist, artist_id, album, album_id, cover_art, duration_sec, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        song.id,
        song.title ?? null,
        song.artist ?? null,
        song.artistId ?? null,
        song.album ?? null,
        song.albumId ?? null,
        song.coverArt ?? null,
        song.duration ?? null,
        at,
      ],
    );
  } catch {
    // Nothing to do about it here, and nothing the player should hear about.
  }
}

export interface TopArtist {
  id?: string;
  name: string;
  plays: number;
}

export interface TopAlbum {
  id?: string;
  name: string;
  artist?: string;
  coverArt?: string;
  plays: number;
}

export interface TopSong {
  id: string;
  title: string;
  artist?: string;
  albumId?: string;
  coverArt?: string;
  plays: number;
}

export interface ListeningStats {
  /** Listens in the period. */
  total: number;
  /** Seconds of music, added up from each song's length. */
  totalListenedSec: number;
  /** Listens by hour of the day (local time), midnight first. */
  byHour: number[];
  /** Listens by day of the week and hour; the days run Sunday to Saturday,
   *  which is how SQLite counts them. */
  byWeekdayHour: number[][];
  topArtists: TopArtist[];
  topAlbums: TopAlbum[];
  topSongs: TopSong[];
}

/** How many of each list the screen shows. */
const TOP = 5;

/**
 * SQLite's clock reads the timestamps as seconds and answers in UTC unless
 * told otherwise; the hours a person listens at are the hours on their wall.
 */
const LOCAL_HOUR = "CAST(strftime('%H', played_at / 1000, 'unixepoch', 'localtime') AS INTEGER)";
const LOCAL_WEEKDAY = "CAST(strftime('%w', played_at / 1000, 'unixepoch', 'localtime') AS INTEGER)";

/**
 * The totals since a moment, or for ever with `null`. Every number here comes
 * from a `GROUP BY`; the rows themselves are never read out.
 */
export async function queryStats(sinceMs: number | null): Promise<ListeningStats> {
  const db = await statsDb(profileScopeId());
  const where = sinceMs === null ? '' : 'WHERE played_at >= ?';
  const args = sinceMs === null ? [] : [sinceMs];

  const totals = await db.getFirstAsync<{ n: number; secs: number | null }>(
    `SELECT COUNT(*) AS n, SUM(duration_sec) AS secs FROM plays ${where}`,
    args,
  );

  const byHour = Array.from({ length: 24 }, () => 0);
  for (const r of await db.getAllAsync<{ h: number; n: number }>(
    `SELECT ${LOCAL_HOUR} AS h, COUNT(*) AS n FROM plays ${where} GROUP BY h`,
    args,
  )) {
    byHour[r.h] = r.n;
  }

  const byWeekdayHour = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const r of await db.getAllAsync<{ d: number; h: number; n: number }>(
    `SELECT ${LOCAL_WEEKDAY} AS d, ${LOCAL_HOUR} AS h, COUNT(*) AS n
       FROM plays ${where} GROUP BY d, h`,
    args,
  )) {
    byWeekdayHour[r.d][r.h] = r.n;
  }

  // Grouped by id where there is one and by name where there is not: a local
  // profile files its artists under a made-up id, and a song with no artist at
  // all should still count once rather than vanish. The name shown is whatever
  // the most recent listen called them, in case the tags were cleaned up.
  const topArtists = (
    await db.getAllAsync<{ id: string | null; name: string | null; n: number }>(
      `SELECT artist_id AS id, MAX(artist) AS name, COUNT(*) AS n FROM plays ${where}
        GROUP BY COALESCE(artist_id, artist) ORDER BY n DESC, name COLLATE NOCASE LIMIT ?`,
      [...args, TOP],
    )
  ).map((r) => ({ id: r.id ?? undefined, name: r.name ?? '', plays: r.n }));

  const topAlbums = (
    await db.getAllAsync<{
      id: string | null;
      name: string | null;
      artist: string | null;
      cover: string | null;
      n: number;
    }>(
      `SELECT album_id AS id, MAX(album) AS name, MAX(artist) AS artist,
              MAX(cover_art) AS cover, COUNT(*) AS n
         FROM plays ${where}
        GROUP BY COALESCE(album_id, album) ORDER BY n DESC, name COLLATE NOCASE LIMIT ?`,
      [...args, TOP],
    )
  ).map((r) => ({
    id: r.id ?? undefined,
    name: r.name ?? '',
    artist: r.artist ?? undefined,
    coverArt: r.cover ?? undefined,
    plays: r.n,
  }));

  const topSongs = (
    await db.getAllAsync<{
      id: string;
      title: string | null;
      artist: string | null;
      album_id: string | null;
      cover: string | null;
      n: number;
    }>(
      `SELECT song_id AS id, MAX(title) AS title, MAX(artist) AS artist,
              MAX(album_id) AS album_id, MAX(cover_art) AS cover, COUNT(*) AS n
         FROM plays ${where}
        GROUP BY song_id ORDER BY n DESC, title COLLATE NOCASE LIMIT ?`,
      [...args, TOP],
    )
  ).map((r) => ({
    id: r.id,
    title: r.title ?? '',
    artist: r.artist ?? undefined,
    albumId: r.album_id ?? undefined,
    coverArt: r.cover ?? undefined,
    plays: r.n,
  }));

  return {
    total: totals?.n ?? 0,
    totalListenedSec: totals?.secs ?? 0,
    byHour,
    byWeekdayHour,
    topArtists,
    topAlbums,
    topSongs,
  };
}
