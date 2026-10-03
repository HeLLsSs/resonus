/**
 * The queue as this device writes it to disk, and what reading it back is
 * allowed to make of it. What was written by an older version, or by a crash
 * halfway through, still comes back as a state the player can take.
 */
import type { Song } from '@/api/subsonic';
import { isRepeatMode, type RepeatMode } from '@/lib/playerMath';

export interface StoredQueue {
  queue: Song[];
  index: number;
  positionSec: number;
  /** The queue was a radio: when restoring it must keep extending itself. */
  radioMode?: boolean;
  /** Track the radio was started from, so it keeps extending from the same
   *  place after a restart. Absent in queues saved by older versions: those
   *  fall back to seeding off the tail. */
  radioSeed?: Song | null;
  /** Where the queue came from, for the player's "playing from" header. */
  source?: string | null;
  /** Route of that origin, so tapping the header still navigates there. */
  sourceHref?: string | null;
  /**
   * Shuffle and repeat as they were left (#102). Both are how someone listens
   * rather than something they set up once, and finding them off after every
   * cold start meant turning them on again each morning. `originalQueue` is
   * NOT saved: it would double what a queue weighs, and turning shuffle off
   * without it keeps the order that is playing instead of restoring the
   * album's, which is a fair price for a session that already ended.
   */
  shuffle?: boolean;
  repeat?: RepeatMode;
  /** The queue was dealt when it was started (see `queueDealt`). */
  dealt?: boolean;
  /**
   * When this device last wrote it (ms). Only read to compare against the
   * server's copy: what is newer decides which of the two is somebody's last
   * word, and a phone that listened all afternoon with no connection must not
   * be handed yesterday's queue from another player on reconnecting.
   */
  savedAt?: number;
}

/** How the person was listening, which comes back even with an empty queue. */
export function storedListening(saved: StoredQueue): {
  shuffle: boolean;
  queueDealt: false;
  repeat: RepeatMode;
} {
  return {
    shuffle: saved.shuffle === true,
    queueDealt: false,
    repeat: isRepeatMode(saved.repeat) ? saved.repeat : 'off',
  };
}

/**
 * The player state a saved queue comes back as, for a non-empty `queue`: the
 * index kept inside it, a position that is a number of seconds, and each
 * optional field reduced to what it can be. The queue is the saved array
 * itself, so the caller can tell later whether it is still the one playing.
 */
export function restoredQueueState(saved: StoredQueue) {
  const index = Math.min(Math.max(0, saved.index ?? 0), saved.queue.length - 1);
  const positionSec =
    typeof saved.positionSec === 'number' && Number.isFinite(saved.positionSec)
      ? Math.max(0, saved.positionSec)
      : 0;
  return {
    queue: saved.queue,
    index,
    positionSec,
    durationSec: saved.queue[index]?.duration ?? 0,
    // Restored like `radioMode`: without this the "playing from" header
    // vanished once Android killed the app in the background and the queue
    // came back from disk.
    source: typeof saved.source === 'string' ? saved.source : null,
    sourceHref: typeof saved.sourceHref === 'string' ? saved.sourceHref : null,
    // If it was a radio, it still is: closing the app should not leave it
    // silent when reaching the end of what was already queued.
    radioMode: saved.radioMode === true,
    radioSeed: saved.radioSeed ?? null,
    // The queue was saved already shuffled, so this only restores the button:
    // nothing is reordered on the way back in. `originalQueue` stays null
    // (see `StoredQueue`), which turning shuffle off handles on its own.
    shuffle: saved.shuffle === true,
    queueDealt: saved.dealt === true,
    repeat: isRepeatMode(saved.repeat) ? saved.repeat : 'off',
  };
}
