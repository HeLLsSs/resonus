/**
 * "For you": one press, music chosen from what this account actually plays,
 * and a playlist of it left behind.
 *
 * Three things happen, in this order and for a reason. The sources are
 * gathered and woven (`forYou`), the queue starts at once, and the playlist is
 * written afterwards. Playing first because that is what was pressed: nobody
 * waits on a playlist being written before hearing anything, and the writing
 * can take a while for reasons below.
 *
 * **Why the playlist arrives late.** A YouTube track has no file behind it
 * until the proxy has fetched one, and Navifind answers "not yet" (Subsonic
 * error 70) for a track it has only just started on. Playing one is what sets
 * that fetching off. So the playlist is created with the library's own songs,
 * which are there immediately, and each YouTube track joins it as it lands,
 * with a bounded number of tries. A mix is worth hearing before it is worth
 * keeping.
 */
import {
  addToPlaylist,
  createPlaylist,
  getSongsByGenre,
  getStarred,
  getTopSongs,
  type Song,
} from '@/api/data';
import {
  ERR_NOT_FOUND,
  isOnlineTrackId,
  SubsonicRequestError,
  youtubeHome,
  youtubeLiked,
} from '@/api/subsonic';
import { tg } from '@/i18n';
import { MIX_SIZE, pickForYou, topArtists, topGenres } from '@/lib/forYou';
import { navifindActive } from '@/lib/navifind';
import { bump } from '@/lib/perfLog';
import { queryClient } from '@/lib/query';
import { useAuthStore } from '@/store/auth';
import { usePlayerStore } from '@/store/player';
import { usePlayHistory } from '@/store/playHistory';

/** How many songs are asked of each artist and each genre. Small: the point is
 *  breadth across what is played, not depth into one name. */
const PER_ARTIST = 6;
const PER_GENRE = 12;

/** How many of the account's own favourites are drawn on. */
const FAVORITES = 60;

/** How much of YouTube's own picks are read. */
const YOUTUBE_LIKED = 40;

/**
 * How many times a YouTube track is offered to the playlist before it is left
 * out, and how long between tries. Roughly three minutes in all, which is
 * about what the proxy takes for a track it has to fetch and tag; past that it
 * has most likely failed rather than being slow.
 */
const JOIN_TRIES = 10;
const JOIN_WAIT_MS = 20_000;

/** What the mix is called, dated, since pressing the button twice in a week
 *  should leave two playlists and not one puzzling mixture of both. */
function mixName(now: Date): string {
  return tg('For you · {date}', { date: now.toLocaleDateString() });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Everything the library answers for the artists and genres played most. A
 *  source that fails is one source short, never the whole mix. */
async function fromLibrary(artists: string[], genres: string[]): Promise<Song[]> {
  const asked = [
    ...artists.map((artist) => getTopSongs(artist, PER_ARTIST)),
    ...genres.map((genre) => getSongsByGenre(genre, PER_GENRE)),
  ];
  const answers = await Promise.allSettled(asked);
  return answers.flatMap((a) => (a.status === 'fulfilled' ? a.value : []));
}

/**
 * What YouTube Music picks for the account: what it has thumbed up, and the
 * tracks sitting on its own home page, which is where its quick picks live.
 *
 * Only with an account connected. Signed out the proxy answers the public home
 * page, which is a chart and not a taste, and has no business in a mix named
 * after this one.
 */
async function fromYoutube(): Promise<Song[]> {
  const { auth, offline } = useAuthStore.getState();
  if (!auth || offline || !navifindActive()) return [];
  const [liked, shelves] = await Promise.all([
    youtubeLiked(auth, YOUTUBE_LIKED).catch(() => [] as Song[]),
    youtubeHome(auth, true).catch(() => []),
  ]);
  return [...liked, ...shelves.flatMap((shelf) => shelf.songs)];
}

/**
 * Adds one song to the playlist, waiting out a proxy that has not finished
 * fetching it. True once it is in, false when it never became playable.
 */
async function joinWhenReady(playlistId: string, songId: string): Promise<boolean> {
  for (let attempt = 0; attempt < JOIN_TRIES; attempt++) {
    try {
      await addToPlaylist(playlistId, songId);
      return true;
    } catch (e) {
      // The proxy says "not yet" with the same code Subsonic uses for "no such
      // song", so the two cannot be told apart from here. Trying again costs a
      // request and settles it either way: a song that does not exist goes on
      // saying so until the tries run out.
      if (!(e instanceof SubsonicRequestError) || e.code !== ERR_NOT_FOUND) return false;
      await sleep(JOIN_WAIT_MS);
    }
  }
  return false;
}

export interface ForYouResult {
  /** What is playing. Empty when nothing could be gathered at all. */
  songs: Song[];
  /** The playlist being filled, or null when none could be created. */
  playlistId: string | null;
  playlistName: string;
}

/**
 * Gathers, plays, and starts filling the playlist.
 *
 * Returns as soon as the music is playing. The playlist goes on being written
 * behind it, which is why nothing here waits on `fill`.
 */
export async function playForYou(): Promise<ForYouResult> {
  const history = usePlayHistory.getState().entries;
  const artists = topArtists(history);
  const genres = topGenres(history);

  const [starred, library, youtube] = await Promise.all([
    getStarred().catch(() => null),
    fromLibrary(artists, genres),
    fromYoutube(),
  ]);

  const songs = pickForYou(
    {
      favorites: (starred?.songs ?? []).slice(0, FAVORITES),
      library,
      youtube,
    },
    { history, max: MIX_SIZE },
  );

  const playlistName = mixName(new Date());
  if (songs.length === 0) {
    bump('for you · nothing to play');
    return { songs, playlistId: null, playlistName };
  }

  bump(`for you · ${songs.length} songs`);
  await usePlayerStore.getState().playQueue(songs, 0, playlistName);

  const playlistId = await createPlaylist(playlistName).catch(() => null);
  if (playlistId) void fill(playlistId, songs);
  return { songs, playlistId, playlistName };
}

/**
 * Writes the mix into the playlist: the library's songs at once, then the
 * YouTube ones as the proxy finishes fetching them.
 *
 * Order is kept for the songs that can be added straight away, and the fetched
 * ones land at the end in whatever order they arrive. Keeping the mix's exact
 * order would mean waiting for the slowest track before writing anything,
 * which is a playlist that stays empty for three minutes.
 */
async function fill(playlistId: string, songs: Song[]): Promise<void> {
  const waiting: string[] = [];
  for (const song of songs) {
    if (isOnlineTrackId(song.id)) {
      waiting.push(song.id);
      continue;
    }
    await addToPlaylist(playlistId, song.id).catch(() => {});
  }
  await queryClient.invalidateQueries({ queryKey: ['playlists'] });
  if (waiting.length === 0) return;

  // One at a time rather than all at once: each of these is a file the proxy
  // is fetching from YouTube, and asking it about twenty of them every twenty
  // seconds is a great deal of noise for something nobody is watching.
  let joined = 0;
  for (const id of waiting) {
    if (await joinWhenReady(playlistId, id)) joined++;
  }
  bump(`for you · ${joined}/${waiting.length} fetched tracks kept`);
  await queryClient.invalidateQueries({ queryKey: ['playlists'] });
}
