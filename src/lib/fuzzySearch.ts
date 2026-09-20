/**
 * What somebody meant, when the server has already answered with nothing.
 *
 * Navidrome matches a word exactly or by its start, and every word typed has
 * to match something, so one wrong letter answers with an empty screen however
 * right the rest of the name is: "Beatels" finds nothing at all. The server
 * cannot be taught to do better from here, so the app tries twice more, and
 * only ever after the server has found nothing:
 *
 *  - `broadenQuery` cuts the longest word back to its opening letters and asks
 *    the server again. It costs one request and catches what is by far the
 *    commonest mistake, a slip in the back half of a name, because what is
 *    left is a prefix the server does match.
 *  - `fuzzyLibrary` runs over the library the phone already holds and compares
 *    word by word, allowing a few edits. It catches a slip anywhere, answers
 *    with artists and albums as well as songs, and works offline.
 *
 * Both are here rather than in `data`, with nothing fetched and nothing
 * stored, so that what counts as close enough can be read and tested on its
 * own.
 */
import type { Album, Artist, Song } from '@/api/subsonic';

import { fold } from './text';

/** How many of each kind a fuzzy answer carries. The screen shows a row of
 *  each, and past this it is a list nobody reads through to the end. */
const MAX_ARTISTS = 10;
const MAX_ALBUMS = 20;
const MAX_SONGS = 30;

/** The opening letters kept when a word is cut back for a second try at the
 *  server. Four is short enough to survive a slip in the rest of the word and
 *  long enough not to answer with the whole library. */
const STEM_LETTERS = 4;

/** Below this a word is not worth cutting: what would be left is a stub that
 *  matches half the library, and the fuzzy pass answers better. */
const MIN_WORD_TO_CUT = 6;

/**
 * How far a word may sit from what was typed, by how long the word is.
 *
 * Nothing at all for a short word: at three letters one edit reaches "one",
 * "own" and "on" alike, and a search that answers with everything is the same
 * empty screen with more scrolling.
 */
export function slackFor(word: string): number {
  if (word.length <= 3) return 0;
  if (word.length <= 6) return 1;
  return 2;
}

/**
 * The edit distance between two words, or null once it is certain to pass
 * `max`.
 *
 * Bounded on purpose: this runs over every word of every song in the library,
 * and the answer is never wanted beyond the point where it stops meaning
 * "close". The length check alone throws out most pairs before any work.
 */
export function within(a: string, b: string, max: number): number | null {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return null;
  if (max === 0) return null;
  // Three rows, because a transposition is answered from two rows back.
  let twoAgo = new Array<number>(b.length + 1);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let best = current[0];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
      // Two letters the wrong way round, which is what a name typed in a
      // hurry usually is: "Beatels" for "Beatles" is one slip here and two
      // substitutions otherwise, so without this the commonest mistake of all
      // needs the widest slack.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], twoAgo[j - 2] + 1);
      }
      if (current[j] < best) best = current[j];
    }
    // Every distance from here on is at least this, so there is no answer
    // left worth having.
    if (best > max) return null;
    const spare = twoAgo;
    twoAgo = previous;
    previous = current;
    current = spare;
  }
  const distance = previous[b.length];
  return distance > max ? null : distance;
}

/** What a word costs to match: nothing when it is the word, a little when it
 *  only starts it, and more the further it had to reach. */
function wordCost(typed: string, word: string): number | null {
  if (word === typed) return 0;
  if (word.startsWith(typed)) return 1;
  const slack = slackFor(typed);
  if (slack === 0) return null;
  const distance = within(typed, word, slack);
  return distance === null ? null : 1 + distance;
}

/**
 * How well a name answers what was typed, lower being better, or null when it
 * does not answer at all.
 *
 * Every word typed has to find a word of the name, which is the rule the
 * server already goes by; what is new is that it may find it with a letter
 * wrong. A name whose words all match exactly comes out at zero and sorts
 * above one that had to reach.
 */
export function nameScore(name: string, typed: string[]): number | null {
  if (typed.length === 0) return null;
  const words = fold(name).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  let total = 0;
  for (const one of typed) {
    let best: number | null = null;
    for (const word of words) {
      const cost = wordCost(one, word);
      if (cost !== null && (best === null || cost < best)) best = cost;
      if (best === 0) break;
    }
    if (best === null) return null;
    total += best;
  }
  // A shorter name that matched is the likelier answer: "Muse" over "Museum
  // of Something" for the same words.
  return total * 100 + Math.min(words.length, 99);
}

/** The words of a query, folded, as everything here compares them. */
export function queryWords(query: string): string[] {
  return fold(query).split(' ').filter(Boolean);
}

/**
 * The same question asked more loosely, for one more try at the server, or
 * null when there is nothing looser to ask.
 *
 * Only the longest word survives: the others are as likely to carry the
 * mistake, and the server requires every word to match, so keeping them is
 * keeping the reason there was no answer.
 */
export function broadenQuery(query: string): string | null {
  const words = queryWords(query);
  if (words.length === 0) return null;
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
  if (longest.length < MIN_WORD_TO_CUT) return null;
  const stem = longest.slice(0, STEM_LETTERS);
  // Asking the same thing twice is a request for nothing.
  return words.length === 1 && stem === longest ? null : stem;
}

interface Scored<T> {
  item: T;
  score: number;
}

function best<T>(scored: Scored<T>[], limit: number): T[] {
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((s) => s.item);
}

/** What a fuzzy pass found, in the shape the search screen already draws. */
export interface FuzzyResult {
  artists: Artist[];
  albums: Album[];
  songs: Song[];
  /** The closest name of the lot, for "did you mean". Absent when what was
   *  typed already matches it word for word, which is nothing to suggest. */
  suggestion?: string;
}

/**
 * The library, searched the way the server would have if it could.
 *
 * Artists and albums are gathered from the songs themselves: that is all the
 * phone holds in one place, and a library's artists are exactly the artists of
 * its songs. Each is scored once, under the name it is listed by, so a hundred
 * songs of one artist cost one comparison rather than a hundred.
 */
export function fuzzyLibrary(songs: Song[], query: string): FuzzyResult {
  const typed = queryWords(query);
  if (typed.length === 0) return { artists: [], albums: [], songs: [] };

  const artists = new Map<string, Artist>();
  const albums = new Map<string, Album>();
  for (const song of songs) {
    if (song.artistId && song.artist && !artists.has(song.artistId)) {
      artists.set(song.artistId, {
        id: song.artistId,
        name: song.artist,
        coverArt: song.coverArt,
      });
    }
    if (song.albumId && song.album && !albums.has(song.albumId)) {
      albums.set(song.albumId, {
        id: song.albumId,
        name: song.album,
        artist: song.artist,
        artistId: song.artistId,
        coverArt: song.coverArt ?? song.albumId,
      });
    }
  }

  const scoredArtists: Scored<Artist>[] = [];
  for (const artist of artists.values()) {
    const score = nameScore(artist.name, typed);
    if (score !== null) scoredArtists.push({ item: artist, score });
  }
  const scoredAlbums: Scored<Album>[] = [];
  for (const album of albums.values()) {
    // The record, or the record by whoever it is by: typing an artist and a
    // word of the title is how anybody looks for one album of a discography.
    const score =
      nameScore(album.name, typed) ??
      nameScore(`${album.name} ${album.artist ?? ''}`, typed);
    if (score !== null) scoredAlbums.push({ item: album, score });
  }
  const scoredSongs: Scored<Song>[] = [];
  for (const song of songs) {
    const score =
      nameScore(song.title, typed) ??
      nameScore(`${song.title} ${song.artist ?? ''}`, typed);
    if (score !== null) scoredSongs.push({ item: song, score });
  }

  // An artist first, then a record: what somebody who misspelled a name was
  // reaching for, in the order they would have wanted it.
  const named = [...scoredArtists, ...scoredAlbums].sort((a, b) => a.score - b.score)[0];
  const song = [...scoredSongs].sort((a, b) => a.score - b.score)[0];
  const name = named ? named.item.name : song?.item.title;

  return {
    artists: best(scoredArtists, MAX_ARTISTS),
    albums: best(scoredAlbums, MAX_ALBUMS),
    songs: best(scoredSongs, MAX_SONGS),
    // Nothing to suggest when what was typed is already in the name: the rows
    // themselves say it, and "did you mean Muse?" over a search for "muse"
    // reads as the app not having understood.
    suggestion: name && nameScore(name, typed) !== null && !exactly(name, typed) ? name : undefined,
  };
}

/** Whether every word typed is a word of the name, spelled the same. Then the
 *  name is not a correction of anything. */
function exactly(name: string, typed: string[]): boolean {
  const words = fold(name).split(' ').filter(Boolean);
  return typed.every((one) => words.some((word) => word === one || word.startsWith(one)));
}
