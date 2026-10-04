/**
 * What the die deals, with nothing of the device in it: the four ways it can
 * play, and the sifting that makes "never played" out of what the library
 * and YouTube hand over. `playShuffle` fetches and plays; this decides.
 */
import { mixedPool } from '@/lib/playerMath';

/**
 * - `mix`: the library's random pick and YouTube's taste dealt together.
 * - `library`: the library alone, as before YouTube had a say.
 * - `youtube`: what YouTube knows the account likes, alone.
 * - `discover`: songs of either that were never played.
 */
export type DiceMode = 'mix' | 'library' | 'youtube' | 'discover';

/** In the order every picker lists them. */
export const DICE_MODES: DiceMode[] = ['mix', 'library', 'youtube', 'discover'];

export function isDiceMode(v: unknown): v is DiceMode {
  return DICE_MODES.some((m) => m === v);
}

/** How many songs a discovery aims for. */
export const DISCOVER_SIZE = 100;

/**
 * Below this a discovery is not worth the name: a queue of a dozen songs is
 * over before the drive is, so the die deals the mix instead and says so.
 */
export const DISCOVER_MIN = 20;

/**
 * The songs nobody has played yet, from the library's random pick and from
 * YouTube's taste, dealt together. A library song counts as played when the
 * server counted it (`playCount`) or the phone's own stats did (`played`, ids
 * of `statsDb`); a YouTube song only by the phone's stats, since the server
 * never saw it.
 */
export function discoverPool<T extends { id: string; playCount?: number }>(
  library: T[],
  online: T[],
  played: ReadonlySet<string>,
  size: number = DISCOVER_SIZE,
): T[] {
  return mixedPool(
    library.filter((s) => (s.playCount ?? 0) === 0 && !played.has(s.id)),
    online.filter((s) => !played.has(s.id)),
    size,
  );
}
