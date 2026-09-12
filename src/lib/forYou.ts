/**
 * Choosing what "for you" plays, with nothing fetched.
 *
 * The gathering is elsewhere (`forYouMix`); this is the part that decides, so
 * what somebody gets handed can be read, and tested, without a server, a store
 * or an account behind it.
 *
 * Three things go in and one list comes out: what the account has starred,
 * what its own library answers for the artists and genres it plays most, and
 * what YouTube Music picks for it. They are woven rather than laid end to end,
 * since forty songs of one source followed by forty of another is two mixes
 * and not one. What has just been heard is left out: a mix that opens on the
 * song still in your ears is the one thing it must not do.
 */
import type { Song } from '@/api/data';
import type { HistoryEntry } from '@/store/playHistory';

/** Where a song in the mix came from, which is what the weave alternates. */
export type MixSource = 'favorites' | 'library' | 'youtube';

export interface MixSources {
  /** Songs the account has starred. */
  favorites: Song[];
  /** What the library answers for the artists and genres played most. */
  library: Song[];
  /** What YouTube Music picks for the account, empty when none is connected. */
  youtube: Song[];
}

export interface MixOptions {
  /** What the phone has played, for leaving the last hours' songs out. */
  history?: HistoryEntry[];
  /** How many songs the mix holds at most. */
  max?: number;
  /** Now, in ms. Handed in so a test does not depend on the clock. */
  now?: number;
  /** Handed in so a test does not depend on chance. */
  rng?: () => number;
}

/** How many songs a mix holds. Long enough for a drive, short enough that the
 *  tail is still something you would have chosen. */
export const MIX_SIZE = 40;

/**
 * How recently played is too recently. A song heard this morning is welcome
 * back in the afternoon; the one from twenty minutes ago is not.
 */
export const JUST_HEARD_MS = 3 * 60 * 60 * 1000;

/**
 * The order the three are drawn in, repeated until the mix is full.
 *
 * The library twice over: it is the music actually on the server, it plays
 * with nothing to fetch first, and it is the half that has to carry the mix
 * when no YouTube account is connected. A favourite every fifth song keeps
 * something familiar within earshot without the mix turning into the
 * favourites list, which the app already has a screen for.
 */
const WEAVE: readonly MixSource[] = ['library', 'youtube', 'library', 'favorites', 'youtube'];

/** Songs whose artist and title match are the same song, whatever their ids:
 *  a record on the server and its copy on YouTube must not both come up. */
function sameSongKey(song: Song): string {
  const title = (song.title ?? '').trim().toLowerCase();
  const artist = (song.artist ?? '').trim().toLowerCase();
  return title && artist ? `${artist} ${title}` : `id ${song.id}`;
}

/** Shuffles a copy (Fisher-Yates), with the draw handed in. */
function shuffled<T>(items: T[], rng: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * How much a play made at this time of day is worth against one made at any
 * other.
 *
 * Nobody listens to the same thing at eight in the morning and at eleven at
 * night, and a mix built from a flat count of the whole history is a mix for
 * the average hour, which is no hour at all. Two rather than ten: the point is
 * to tilt the list, not to hide everything somebody plays at another time —
 * a taste is still a taste outside its usual hour.
 */
const THIS_HOUR = 2;

/** Whether a play was made in the stretch of day we are in now. Handed in, so
 *  this file knows nothing of clocks or of how a day is cut up. */
export type AtThisHour = (playedAt: number) => boolean;

/**
 * How little of a song has to be heard for the play to mean the opposite of a
 * taste.
 *
 * A song is written into the history the moment it starts, so the one skipped
 * after three seconds used to count exactly like the one heard through. A
 * fifth of the way in is generous — nobody reaches it by accident, and past it
 * somebody was listening.
 */
const SKIPPED = 0.2;

/**
 * What one play is worth: nothing at all if it was skipped, and otherwise the
 * share of the song that was heard, so half a song counts for half a taste.
 *
 * A play with no share recorded counts in full. Those are the entries written
 * before any of this existed, and the songs a server gave no duration for:
 * not knowing how much was heard is not evidence that it was rejected.
 */
function worth(entry: HistoryEntry): number {
  if (entry.heard === undefined) return 1;
  if (entry.heard < SKIPPED) return 0;
  return Math.min(1, entry.heard);
}

/** Counts each name, weighted by how much of each song was actually heard and
 *  doubled for the plays of this hour, and keeps the count of the plays that
 *  were not skipped beside it. */
function tally(
  history: HistoryEntry[],
  nameOf: (entry: HistoryEntry) => string | undefined,
  atThisHour?: AtThisHour,
): Map<string, { weight: number; plays: number }> {
  const counts = new Map<string, { weight: number; plays: number }>();
  for (const entry of history) {
    const name = nameOf(entry)?.trim();
    if (!name) continue;
    const heard = worth(entry);
    if (heard === 0) continue;
    const now = counts.get(name) ?? { weight: 0, plays: 0 };
    now.weight += heard * (atThisHour?.(entry.playedAt) ? THIS_HOUR : 1);
    now.plays += 1;
    counts.set(name, now);
  }
  return counts;
}

/**
 * The artists played most, best first, with what is played at this hour of the
 * day counting for more.
 *
 * Counted over the history rather than over the server's own play counts:
 * this is what this phone has actually played, which is the taste the button
 * is named after. An artist heard once does not count as one, and that is the
 * true count rather than the weighted one — a single play should not qualify
 * for having happened at the right hour.
 */
export function topArtists(history: HistoryEntry[], max = 8, atThisHour?: AtThisHour): string[] {
  return Array.from(tally(history, (e) => e.song.artist, atThisHour).entries())
    .filter(([, n]) => n.plays > 1)
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, max)
    .map(([artist]) => artist);
}

/** The genres played most, best first, on the same weighting. Counted over
 *  every play, since a genre heard once is still a genre. */
export function topGenres(history: HistoryEntry[], max = 4, atThisHour?: AtThisHour): string[] {
  return Array.from(tally(history, (e) => e.song.genre, atThisHour).entries())
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, max)
    .map(([genre]) => genre);
}

/**
 * The mix: the three sources woven together, without what was just heard and
 * without the same song twice.
 *
 * A source that runs out is skipped rather than waited for, so a mix with no
 * YouTube account behind it is the library and the favourites, and one built
 * on a phone whose library answered nothing is still whatever YouTube had.
 * Empty means every source was, which the caller has to say out loud rather
 * than start playing silence.
 */
export function pickForYou(sources: MixSources, opts: MixOptions = {}): Song[] {
  const { history = [], max = MIX_SIZE, now = Date.now(), rng = Math.random } = opts;

  const justHeard = new Set<string>();
  for (const entry of history) {
    if (now - entry.playedAt <= JUST_HEARD_MS) justHeard.add(entry.song.id);
  }

  const seen = new Set<string>();
  const buckets: Record<MixSource, Song[]> = {
    favorites: shuffled(sources.favorites, rng),
    library: shuffled(sources.library, rng),
    youtube: shuffled(sources.youtube, rng),
  };
  const cursors: Record<MixSource, number> = { favorites: 0, library: 0, youtube: 0 };

  /** The next song of that source that is neither a repeat nor just heard. */
  const take = (which: MixSource): Song | null => {
    const bucket = buckets[which];
    while (cursors[which] < bucket.length) {
      const song = bucket[cursors[which]++];
      if (justHeard.has(song.id)) continue;
      const key = sameSongKey(song);
      if (seen.has(key)) continue;
      seen.add(key);
      return song;
    }
    return null;
  };

  const out: Song[] = [];
  let step = 0;
  // One whole turn of the weave handing back nothing is what ends this: every
  // source is empty, or everything left in them has been seen or just heard.
  let barren = 0;
  while (out.length < max && barren < WEAVE.length) {
    const song = take(WEAVE[step % WEAVE.length]);
    step++;
    if (song) {
      out.push(song);
      barren = 0;
    } else {
      barren++;
    }
  }
  return out;
}
