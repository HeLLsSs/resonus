/**
 * The lyrics this phone has already shown, kept where a search can read them.
 *
 * Nothing in the app can ask a server "which song says these words": Subsonic
 * has no such call, LRCLIB has no such call, and a local library has nobody to
 * ask at all. What the app does have is every set of lyrics it has ever put on
 * screen, because it fetched them, one song at a time. This is that pile with
 * an index on it, so the search tab can answer with the song a line came from
 * (`searchLyrics`) the way NaviBeat does.
 *
 * There is no "index my lyrics" button on purpose. Filling the index means
 * asking for the lyrics of every song in the library, which for a server is
 * one request per song and for LRCLIB one request per song to somebody else's
 * server, and a library of ten thousand songs is not a thing to do behind
 * somebody's back on their data plan. So the index fills itself as lyrics are
 * shown (`indexLyrics`, called from the lyrics query): whatever was played
 * with the lyrics card open, or with the player prefetching them, is there to
 * be found afterwards. What was never shown is not, and that is the trade.
 *
 * One database per profile, named after it like the listening log
 * (`statsDb`): a song id means nothing outside the server that issued it. The
 * search itself is FTS5's when the SQLite that ships with expo-sqlite was
 * built with it (it is, on both platforms, unless the build turns it off) and
 * a plain `LIKE` over the text when it was not, decided once when the database
 * opens. FTS5 folds case and accents and matches whole words or the start of
 * one; `LIKE` matches any substring and only folds ASCII case.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import type { Song, SongLyrics } from '@/api/subsonic';
import { profileScopeId } from '@/store/auth';
import { hashKey } from './localLibrary';

const DIR = FileSystem.documentDirectory + 'lyrics-index/';

/**
 * Everything a row of the search needs to draw itself and to play. The song's
 * own file is kept because a local profile has no other way back from an id
 * to a file, and the length so the row can be queued as a song.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA journal_size_limit = 524288;
CREATE TABLE IF NOT EXISTS lyrics (
  song_id TEXT PRIMARY KEY,
  title TEXT,
  artist TEXT,
  album_id TEXT,
  cover_art TEXT,
  duration_sec INTEGER,
  local_uri TEXT,
  text TEXT NOT NULL
);
`;

/**
 * The words, indexed. Its own table rather than an external-content one over
 * `lyrics`: those are addressed by rowid, and a replace on a text primary key
 * hands out a new rowid, which is exactly the kind of thing that leaves an
 * index pointing at nothing. Two writes per song is nothing.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS lyrics_fts USING fts5(song_id UNINDEXED, text);
INSERT INTO lyrics_fts (song_id, text)
  SELECT song_id, text FROM lyrics
   WHERE song_id NOT IN (SELECT song_id FROM lyrics_fts);
`;

interface Handle {
  db: SQLite.SQLiteDatabase;
  /** Whether `lyrics_fts` exists, which is whether this SQLite has FTS5. */
  fts: boolean;
}

/** One handle per profile, kept open (see `mirrorDb` on why not closing). */
const open = new Map<string, Promise<Handle>>();

/** Lets go of a profile's index, so its file can be deleted with it (see
 *  `closeStatsFor`, which this mirrors). */
export async function closeLyricsFor(profile: string): Promise<void> {
  const handle = open.get(profile);
  if (!handle) return;
  open.delete(profile);
  await handle.then(({ db }) => db.closeAsync()).catch(() => {});
}

/** The profile's id is a URL and a user name; the file name is its hash. */
function dbName(profile: string): string {
  return `lyrics-${hashKey(profile)}.db`;
}

function lyricsDb(profile: string): Promise<Handle> {
  const existing = open.get(profile);
  if (existing) return existing;
  // A failed open is forgotten rather than handed to every later caller; see
  // `downloadsDb` for the session-long breakage that remembering it causes.
  const handle: Promise<Handle> = (async () => {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
    // SQLite joins directory and name as plain text and knows nothing about
    // the `file://` the file system module speaks.
    const db = await SQLite.openDatabaseAsync(dbName(profile), {}, DIR.replace(/^file:\/\//, ''));
    await db.execAsync(SCHEMA);
    // The only way to know whether FTS5 was compiled in is to ask for the
    // table, and only the first time: once it exists, the answer is known, and
    // the backfill that comes with creating it (rows written by a build that
    // had no FTS5, should one ever gain it) is a scan not worth repeating.
    const fts =
      !!(await db.getFirstAsync("SELECT 1 FROM sqlite_master WHERE name = 'lyrics_fts'")) ||
      (await db
        .execAsync(FTS_SCHEMA)
        .then(() => true)
        .catch(() => false));
    return { db, fts };
  })().catch((e) => {
    if (open.get(profile) === handle) open.delete(profile);
    throw e;
  });
  open.set(profile, handle);
  return handle;
}

/**
 * Writes a song's lyrics down, replacing whatever was there for it. Called
 * whenever the lyrics query answers, wherever the answer came from, so the
 * index sees every set of lyrics exactly once per session.
 *
 * Best effort. A search that misses a song is still a search, and the lyrics
 * card must never wait on, or fail because of, a bookkeeping write.
 */
export async function indexLyrics(song: Song, lyrics: SongLyrics): Promise<void> {
  const text = lyrics.lines
    .map((l) => l.value.trim())
    .filter(Boolean)
    .join('\n');
  if (!song?.id || !text) return;
  try {
    const { db, fts } = await lyricsDb(profileScopeId());
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT OR REPLACE INTO lyrics
           (song_id, title, artist, album_id, cover_art, duration_sec, local_uri, text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          song.id,
          song.title ?? null,
          song.artist ?? null,
          song.albumId ?? null,
          song.coverArt ?? null,
          song.duration ?? null,
          song.localUri ?? null,
          text,
        ],
      );
      if (!fts) return;
      await db.runAsync('DELETE FROM lyrics_fts WHERE song_id = ?', [song.id]);
      await db.runAsync('INSERT INTO lyrics_fts (song_id, text) VALUES (?, ?)', [song.id, text]);
    });
  } catch {
    // Nothing to do about it here, and nothing the lyrics card should hear about.
  }
}

export interface LyricsMatch {
  song: Song;
  /** The line the words were found on, to show under the title. */
  excerpt: string;
}

interface Row {
  song_id: string;
  title: string | null;
  artist: string | null;
  album_id: string | null;
  cover_art: string | null;
  duration_sec: number | null;
  local_uri: string | null;
  text: string;
}

/** How many songs the search tab lists at most. */
const LIMIT = 20;

/**
 * The words typed, as one FTS5 phrase with a prefix on the end: the quotes
 * keep FTS5 from reading its own operators (AND, NOT, a stray `*`) into what
 * somebody typed, and the star lets the last word be unfinished, which is
 * what a search box is while you type in it.
 */
function ftsQuery(q: string): string {
  return `"${q.replace(/"/g, '""')}"*`;
}

/** `LIKE`'s wildcards, and its escape, taken literally. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Lower case, no accents: how FTS5's tokenizer sees the text, near enough. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * The first line the words are on. FTS5 matched on words, so the fold here
 * finds the same line it did in nearly every case; when it does not (an
 * apostrophe, a hyphen the tokenizer split on), the first word alone is tried,
 * and failing that the song opens on its first line, which is still the song
 * that matched.
 */
function excerpt(text: string, q: string): string {
  const lines = text.split('\n');
  const needle = fold(q);
  const firstWord = needle.split(/\s+/)[0];
  return (
    lines.find((l) => fold(l).includes(needle)) ??
    lines.find((l) => fold(l).includes(firstWord)) ??
    lines[0]
  );
}

function rowToSong(r: Row): Song {
  return {
    id: r.song_id,
    title: r.title ?? '',
    artist: r.artist ?? undefined,
    albumId: r.album_id ?? undefined,
    coverArt: r.cover_art ?? undefined,
    duration: r.duration_sec ?? undefined,
    localUri: r.local_uri ?? undefined,
  };
}

/**
 * The songs of this profile whose lyrics contain the words, best match first
 * with FTS5 and by title without it. Under three characters nothing is asked:
 * two letters are in every song there is.
 */
export async function searchLyrics(query: string): Promise<LyricsMatch[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const { db, fts } = await lyricsDb(profileScopeId());
  const rows = fts
    ? await db.getAllAsync<Row>(
        `SELECT l.* FROM lyrics_fts f JOIN lyrics l ON l.song_id = f.song_id
          WHERE lyrics_fts MATCH ? ORDER BY f.rank LIMIT ?`,
        [ftsQuery(q), LIMIT],
      )
    : await db.getAllAsync<Row>(
        `SELECT * FROM lyrics WHERE text LIKE ? ESCAPE '\\'
          ORDER BY title COLLATE NOCASE LIMIT ?`,
        [likePattern(q), LIMIT],
      );
  return rows.map((r) => ({ song: rowToSong(r), excerpt: excerpt(r.text, q) }));
}
