/**
 * Plays random songs from the library (or a genre) instantly.
 *
 * This is an ACTION, not a destination: "random" literally means "don't make
 * me choose", so showing a list before playing contradicts what was asked.
 * Whatever plays is visible in the queue, which already exists and also lets
 * you reorder and remove — it was a better screen than whatever was here.
 */
import { getRandomSongs, youtubeHomeShelves, youtubeLikedSongs } from '@/api/data';
import { tg } from '@/i18n';
import { navifindActive } from '@/lib/navifind';
import { mixedPool } from '@/lib/playerMath';
import { tasteOf } from '@/lib/youtube';
import { useAuthStore } from '@/store/auth';
import { usePlayerStore } from '@/store/player';
import { useToast } from '@/store/toast';
import { withoutUnplayable } from '@/store/unplayable';

/** Not the entire library: the endpoint caps ~500 and a queue that size is unusable. */
const SHUFFLE_SIZE = 200;

/** How many of the liked songs YouTube is asked for. */
const YOUTUBE_LIKED = 100;

/**
 * Whether YouTube has a say: the proxy in front, an account to read, and a
 * network to read it over. The same test the YouTube tab makes.
 */
export function youtubeJoinsShuffle(): boolean {
  const { auth, offline } = useAuthStore.getState();
  return !!auth && !offline && navifindActive();
}

/**
 * What YouTube knows the account likes, for the shuffle to deal in. Nothing
 * when the account cannot be read, so the library plays alone as it always
 * did: the proxy saying no is not a reason for the button to. Without the
 * tracks the player gave up on this week: nobody chose them.
 */
async function youtubeTaste() {
  const [shelves, liked] = await Promise.all([
    youtubeHomeShelves().catch(() => []),
    youtubeLikedSongs(YOUTUBE_LIKED).catch(() => []),
  ]);
  return withoutUnplayable(tasteOf(shelves, liked));
}

/**
 * Empty `genre` = entire library, and with Navifind on, YouTube with it: the
 * library's random pick and the account's own YouTube picks dealt together.
 * Genres are server-side, so a genre stays the library's own.
 */
export async function playShuffle(genre?: string): Promise<void> {
  let songs;
  try {
    songs = await getRandomSongs(SHUFFLE_SIZE, genre);
  } catch {
    useToast.getState().show(tg("Couldn't load songs."));
    return;
  }
  if (!genre && youtubeJoinsShuffle()) {
    songs = mixedPool(songs, await youtubeTaste(), SHUFFLE_SIZE);
  }
  if (songs.length === 0) {
    useToast.getState().show(tg('Nothing to shuffle yet'));
    return;
  }
  // The server already returns them in random order (and the mix is dealt):
  // no shuffling here nor enabling shuffle mode, which would re-shuffle the
  // already-shuffled.
  await usePlayerStore.getState().playQueue(songs, 0, genre || tg('Shuffle'));
}
