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
 * The artists played most, best first.
 *
 * Counted over the history rather than over the server's own play counts:
 * this is what this phone has actually played, which is the taste the button
 * is named after. An artist heard once does not count as one.
 */
export function topArtists(history: HistoryEntry[], max = 8): string[] {
  const counts = new Map<string, number>();
  for (const { song } of history) {
    const artist = song.artist?.trim();
    if (!artist) continue;
    counts.set(artist, (counts.get(artist) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([artist]) => artist);
}

/** The genres played most, best first. Counted over every play, since a genre
 *  heard once is still a genre, unlike an artist heard once. */
export function topGenres(history: HistoryEntry[], max = 4): string[] {
  const counts = new Map<string, number>();
  for (const { song } of history) {
    const genre = song.genre?.trim();
    if (!genre) continue;
    counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
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
