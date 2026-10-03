/**
 * What editing the queue does to it, with nothing of the player in it: where
 * an added song lands, what removing or moving one does to the current index
 * and to the "queued" block (index+1..index+queuedCount), and how shuffle
 * deals the queue and puts it back. The store hands over its state and sets
 * what comes back; loading, syncing and the Jam stay on its side.
 */
import type { Song } from '@/api/subsonic';
import { dealt } from '@/lib/playerMath';

/** The same song as it goes into the queue by hand: autoplay's mark comes off
 *  (it is here because you put it here, whatever it was doing before) and it
 *  takes one of its own, which is what the player announces while it plays. */
export function handAdded(song: Song): Song {
  const { fromMix: _fromMix, ...rest } = song;
  return { ...rest, queued: true };
}

/** The same song with neither mark on it, for when the queue stops having the
 *  blocks they name (see `toggleShuffle`). */
export function unmarked(song: Song): Song {
  if (!song.fromMix && !song.queued) return song;
  const { fromMix: _fromMix, queued: _queued, ...rest } = song;
  return rest;
}

/**
 * The songs at the very end, after everything. The "queued" block is left
 * alone: what is in it was put there by "Play next", and these are not
 * joining it.
 */
export function appendedToQueue(queue: Song[], songs: Song[]): Song[] {
  return queue.concat(songs.map(handAdded));
}

/**
 * The songs straight after the current one, in the order given, at the front
 * of the "queued" block, which grows with them.
 */
export function insertedNext(
  queue: Song[],
  index: number,
  queuedCount: number,
  songs: Song[],
): { queue: Song[]; queuedCount: number } {
  const at = index + 1;
  // Built by hand rather than spread into `splice`: a playlist of thousands
  // would be that many arguments in one call.
  return {
    queue: queue.slice(0, at).concat(songs.map(handAdded), queue.slice(at)),
    queuedCount: queuedCount + songs.length,
  };
}

/** What taking one song out leaves. See `removedFromQueue`. */
export type QueueRemoval =
  | { kind: 'emptied' }
  | { kind: 'current'; queue: Song[]; index: number; queuedCount: number }
  | { kind: 'other'; queue: Song[]; index: number; queuedCount: number; inQueuedBlock: boolean };

/**
 * The queue without the song at `at`, null when there is none there.
 *
 * Removing the current one leaves the index on the song that took its place
 * (the one before, when it was the last), and that song now plays, so if it
 * was the first of the "queued" block it is consumed. Removing any other keeps
 * the index on the same song, and the block shrinks when the song was in it.
 */
export function removedFromQueue(
  queue: Song[],
  at: number,
  index: number,
  queuedCount: number,
): QueueRemoval | null {
  if (at < 0 || at >= queue.length) return null;
  const next = queue.filter((_, i) => i !== at);
  if (next.length === 0) return { kind: 'emptied' };
  if (at === index) {
    return {
      kind: 'current',
      queue: next,
      index: Math.min(index, next.length - 1),
      queuedCount: Math.max(0, queuedCount - 1),
    };
  }
  const inQueuedBlock = at > index && at <= index + queuedCount;
  return {
    kind: 'other',
    queue: next,
    index: at < index ? index - 1 : index,
    queuedCount: inQueuedBlock ? queuedCount - 1 : queuedCount,
    inQueuedBlock,
  };
}

/**
 * The undo of a removal that was not the current song: `song` back at `at`,
 * with the index and the block put right for whatever moved since (auto-advance
 * keeps the same queue and only moves the index).
 */
export function reinserted(
  queue: Song[],
  at: number,
  song: Song,
  index: number,
  queuedCount: number,
  inQueuedBlock: boolean,
): { queue: Song[]; index: number; queuedCount: number } {
  const q = [...queue];
  q.splice(at, 0, song);
  return {
    queue: q,
    index: index >= at ? index + 1 : index,
    queuedCount: inQueuedBlock ? queuedCount + 1 : queuedCount,
  };
}

/**
 * The queue with the song at `from` moved to `to`, null when that is not a
 * move (same place, or either end outside the queue).
 *
 * The index keeps pointing at the same song. The "queued" block is preserved
 * when reordering within what's coming: a song that enters its zone becomes
 * queued, and a queued one that leaves it stops being (Spotify-style). Any
 * move that touches the current song or what's already played dissolves it.
 */
export function movedInQueue(
  queue: Song[],
  from: number,
  to: number,
  index: number,
  queuedCount: number,
): { queue: Song[]; index: number; queuedCount: number } | null {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) {
    return null;
  }
  const next = [...queue];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  let newIndex = index;
  if (from === index) newIndex = to;
  else if (from < index && to >= index) newIndex = index - 1;
  else if (from > index && to <= index) newIndex = index + 1;
  let newQueuedCount = 0;
  if (from > index && to > index) {
    const fromQueued = from - (index + 1) < queuedCount;
    const toQueued = to - (index + 1) < queuedCount;
    newQueuedCount = Math.max(
      0,
      queuedCount + (!fromQueued && toQueued ? 1 : 0) - (fromQueued && !toQueued ? 1 : 0),
    );
  }
  return { queue: next, index: newIndex, queuedCount: newQueuedCount };
}

/**
 * The queue dealt by the shuffle button, and where the current song ends up.
 *
 * The current song keeps playing at the front and the rest is dealt behind
 * it. With `keepHead` (a device that holds a queue of its own), what was
 * already played stays where it is and only the upcoming songs are dealt, so
 * its queue and the app's stay aligned. Either way both marks come off: they
 * name blocks, and there are no blocks left in a dealt queue.
 */
export function shuffledQueue(
  queue: Song[],
  index: number,
  keepHead: boolean,
  deal: (songs: Song[]) => Song[] = dealt,
): { queue: Song[]; index: number } {
  const current = queue[index];
  if (keepHead && current) {
    const preservedHead = queue.slice(0, index + 1);
    const shuffledTail = deal(queue.slice(index + 1));
    return { queue: [...preservedHead, ...shuffledTail].map(unmarked), index };
  }
  const rest = deal(queue.filter((_, i) => i !== index));
  return { queue: (current ? [current, ...rest] : rest).map(unmarked), index: 0 };
}

/**
 * Where the current song sits once shuffle is turned off and the order from
 * before it is back: its first appearance there, or the top when it is not in
 * it at all.
 */
export function unshuffledIndex(originalQueue: Song[], current: Song): number {
  return Math.max(0, originalQueue.findIndex((s) => s.id === current.id));
}

/** The candidates worth appending: neither already in the queue (`have`
 *  holds its ids) nor an online track. */
export function notYetQueued(candidates: Song[], have: ReadonlySet<string>): Song[] {
  return candidates.filter((s) => !have.has(s.id) && !s.url);
}

/**
 * The order shuffle goes back to, given what was just added to the queue.
 * While shuffle is on, songs added to the queue join the original order at
 * its end: turning shuffle off used to drop them, since the order kept was
 * the one from before they came. Nothing to merge without an original order.
 */
export function originalWith(originalQueue: Song[] | null, added: Song[]): { originalQueue?: Song[] } {
  return originalQueue ? { originalQueue: [...originalQueue, ...added] } : {};
}

/** The original order without one occurrence of a removed song (the first),
 *  so a song taken out while shuffled does not come back when it ends. */
export function withoutOne(originalQueue: Song[], removed: Song): Song[] {
  const at = originalQueue.findIndex((s) => s.id === removed.id);
  return at < 0 ? originalQueue : [...originalQueue.slice(0, at), ...originalQueue.slice(at + 1)];
}
