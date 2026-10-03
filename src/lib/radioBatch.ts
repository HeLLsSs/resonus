/**
 * How one batch of a mix is picked out of what the server offered. The
 * asking is the player's (`radioCandidates`); this only decides what of the
 * answer goes in, so a mix does not turn into one artist's discography.
 */
import type { Song } from '@/api/subsonic';
import { dealt } from '@/lib/playerMath';

/**
 * A batch being filled, pool after pool. `take` adds what fits from one, in
 * dealt order: no online track, nothing in `have` or picked already, no more
 * than `maxPerArtist` songs by one artist, and nothing past `size`. `picked`
 * is the batch so far.
 */
export function radioBatch(
  have: ReadonlySet<string>,
  size: number,
  maxPerArtist: number,
  deal: (songs: Song[]) => Song[] = dealt,
): { picked: Song[]; take: (songs: Song[]) => void } {
  const picked: Song[] = [];
  const seen = new Set(have);
  const perArtist = new Map<string, number>();
  const take = (songs: Song[]) => {
    for (const s of deal(songs)) {
      if (picked.length >= size) return;
      if (s.url || seen.has(s.id)) continue;
      const artist = s.artistId ?? s.artist ?? '';
      const n = perArtist.get(artist) ?? 0;
      if (n >= maxPerArtist) continue;
      perArtist.set(artist, n + 1);
      seen.add(s.id);
      picked.push(s);
    }
  };
  return { picked, take };
}
