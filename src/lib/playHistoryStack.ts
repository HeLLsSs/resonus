/**
 * Stack of already-played contexts so the previous button/gesture returns to
 * the prior song even if it comes from a different playlist or album (not the
 * previous track of the current context). Pushed on each advance/skip forward
 * and popped in previous(). Entries share the `queue` reference within the
 * same context, so they only weigh what changes between skips.
 */
import type { Song } from '@/api/subsonic';

export type HistoryEntry = {
  queue: Song[];
  index: number;
  source: string | null;
  sourceHref: string | null;
  originalQueue: Song[] | null;
  shuffle: boolean;
  queueDealt: boolean;
  // Whether that context was a mix, and around which song. Left out, going
  // back from a mix to the album it was started from kept the mix switched on,
  // and the album grew similar songs at its end as if it were one.
  radioMode: boolean;
  radioSeed: Song | null;
};

export const HISTORY_MAX = 100;

/** What tells one playing context from another: the screen it came from, and
 *  its name when it has no screen (the library shuffle, a mix). */
export function contextKey(source: string | null, sourceHref: string | null) {
  return sourceHref ?? source ?? null;
}

export class PlayHistoryStack {
  private entries: HistoryEntry[] = [];
  private readonly max: number;

  constructor(max = HISTORY_MAX) {
    this.max = max;
  }

  /** Keeps a context to come back to, unless it has no song to come back to.
   *  Past `max`, the oldest goes. */
  push(entry: HistoryEntry): void {
    if (!entry.queue[entry.index]) return;
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
  }

  /** The context played last, taken off the stack. */
  pop(): HistoryEntry | undefined {
    return this.entries.pop();
  }

  /**
   * Forgets the back history of a list being started again: its entries point
   * into the queue about to be replaced, so ⏮ walked back into the discarded
   * one (#100). Other lists keep theirs.
   */
  forget(key: string): void {
    this.entries = this.entries.filter((e) => contextKey(e.source, e.sourceHref) !== key);
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}
