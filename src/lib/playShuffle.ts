/**
 * Plays random songs from the library (or a genre) instantly.
 *
 * This is an ACTION, not a destination: "random" literally means "don't make
 * me choose", so showing a list before playing contradicts what was asked.
 * Whatever plays is visible in the queue, which already exists and also lets
 * you reorder and remove — it was a better screen than whatever was here.
 *
 * What it deals is the die's mode (`lib/diceModes.ts`): the one asked for, or
 * the default from Settings › Quality & playback.
 */
import { getRandomSongs, youtubeHomeShelves, youtubeLikedSongs } from '@/api/data';
import { tg } from '@/i18n';
import { type DiceMode, DISCOVER_MIN, discoverPool } from '@/lib/diceModes';
import { navifindActive } from '@/lib/navifind';
import { mixedPool } from '@/lib/playerMath';
import { tasteOf } from '@/lib/youtube';
import { useAuthStore } from '@/store/auth';
import { usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { withoutUnplayable } from '@/store/unplayable';

/** Not the entire library: the endpoint caps ~500 and a queue that size is unusable. */
const SHUFFLE_SIZE = 200;

/** What a discovery draws from the library: as much as the endpoint gives,
 *  since most of it is sifted out as already played. */
const DISCOVER_DRAW = 500;

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

/** A mode's name, as every picker shows it. */
export function diceModeName(mode: DiceMode): string {
  switch (mode) {
    case 'mix':
      return tg('Library and YouTube');
    case 'library':
      return tg('Library only');
    case 'youtube':
      return tg('YouTube only');
    case 'discover':
      return tg('Discover::dice');
  }
}

/** A mode's line of explanation, under its name. */
export function diceModeHint(mode: DiceMode): string {
  switch (mode) {
    case 'mix':
      return tg('Your library and your YouTube likes, dealt together');
    case 'library':
      return tg('Random songs from your library');
    case 'youtube':
      return tg('Your likes and picks, dealt');
    case 'discover':
      return tg('Songs you have never played');
  }
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

/** The songs this phone has heard, by id. None when the stats cannot be read. */
async function playedIds(): Promise<Set<string>> {
  try {
    const { queryPlaysBySong } = await import('@/lib/statsDb');
    return new Set((await queryPlaysBySong(null)).map((r) => r.songId));
  } catch {
    return new Set();
  }
}

/**
 * Empty `genre` = entire library, dealt the way `mode` says (the default
 * mode when none is given). Genres are server-side, so a genre stays the
 * library's own whatever the mode.
 */
export async function playShuffle(genre?: string, mode?: DiceMode): Promise<void> {
  const toast = useToast.getState().show;
  let dice: DiceMode = genre ? 'library' : (mode ?? useSettings.getState().diceMode);
  // YouTube's die with no account to read is the library's instead, which
  // beats silence; said, so the music is not taken for YouTube's.
  if (dice === 'youtube' && !youtubeJoinsShuffle()) {
    toast(tg('YouTube is out of reach: shuffling your library'));
    dice = 'library';
  }
  const play = usePlayerStore.getState().playQueue;

  if (dice === 'youtube') {
    const pool = await youtubeTaste();
    if (pool.length === 0) {
      toast(tg('Nothing to shuffle yet'));
      return;
    }
    await play(pool, 0, tg('YouTube shuffle'), undefined, { shuffled: true, mix: true });
    return;
  }

  if (dice === 'discover') {
    const [library, online, played] = await Promise.all([
      getRandomSongs(DISCOVER_DRAW).catch(() => []),
      youtubeJoinsShuffle() ? youtubeTaste() : [],
      playedIds(),
    ]);
    const pool = discoverPool(library, online, played);
    if (pool.length < DISCOVER_MIN) {
      toast(tg('Not enough songs you have never played: here is the mix'));
      return playShuffle(undefined, 'mix');
    }
    await play(pool, 0, diceModeName('discover'), undefined, { mix: true });
    return;
  }

  let songs;
  try {
    songs = await getRandomSongs(SHUFFLE_SIZE, genre);
  } catch {
    toast(tg("Couldn't load songs."));
    return;
  }
  if (dice === 'mix' && youtubeJoinsShuffle()) {
    songs = mixedPool(songs, await youtubeTaste(), SHUFFLE_SIZE);
  }
  if (songs.length === 0) {
    toast(tg('Nothing to shuffle yet'));
    return;
  }
  // The server already returns them in random order (and the mix is dealt):
  // no shuffling here nor enabling shuffle mode, which would re-shuffle the
  // already-shuffled.
  await play(songs, 0, genre || tg('Shuffle'), undefined, { mix: true });
}
