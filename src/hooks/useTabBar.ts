/**
 * Where the navigation bar is, for everything that has to sit above it.
 *
 * The tabs own that bar on their own three screens. With "Always show the
 * navigation bar" on, `GlobalTabBar` draws the same thing everywhere else, and
 * then the MiniPlayer, the lists and their padding all have to move up by the
 * same amount they already do inside the tabs (#96).
 *
 * Full-screen modals are the exception: the player, the queue and the lyrics
 * cover everything, and the song picker keeps its own search bar down there.
 */
import { useSegments } from 'expo-router';

import { currentSong, usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';

/** Screens that never take the bar, whatever the setting says. */
const NO_BAR = ['player', 'queue', 'lyrics', 'favorites-add', 'login', 'ride'];

/** Screens that cover the MiniPlayer. `GlobalMiniPlayer` fades it out on these. */
export const NO_MINI_PLAYER = ['player', 'queue', 'lyrics', 'favorites-add', 'ride'];

export function useTabBarShown(): boolean {
  const always = useSettings((s) => s.alwaysShowTabs);
  const segments = useSegments();
  const root = segments[0];
  // `undefined` is the root route resolving to the tabs on the first frame.
  const inTabs = root === '(tabs)' || root === undefined;
  if (inTabs) return true;
  return always && !NO_BAR.includes(root as string);
}

/**
 * Whether the MiniPlayer is on screen right now: something has to be playing
 * (`MiniPlayer` draws nothing without a song) and the screen has to be one
 * that doesn't cover it. Two conditions, and the bar it draws is 60 px that
 * anything floating at the bottom has to clear only while they both hold.
 */
export function useMiniPlayerShown(): boolean {
  const segments = useSegments();
  const hasSong = usePlayerStore((s) => currentSong(s) !== null);
  return hasSong && !NO_MINI_PLAYER.includes(segments[0] as string);
}
