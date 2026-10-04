/**
 * "Continue where you stopped", across this account's devices: whether Home
 * offers to pick up what another device was playing when it stopped.
 *
 * Two answers go into it. The proxy's playback spot says which device played
 * last and when it stopped (`navifind/playback/last`), which is the only way
 * to tell this account's devices apart: they all send the same client name.
 * The server's saved queue (`getPlayQueue`) holds what that device was on and
 * how far into it. Without the proxy, a queue written by another Subsonic
 * player (its client name differs from ours) is offered the same way.
 */

/** How long after a stop it is still worth offering to pick it up. */
export const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * How much older the saved queue may be than the stop and still be what that
 * device was on. A playing device saves every twenty seconds and a paused one
 * a few seconds after the pause, so a queue minutes older than the stop is one
 * it never managed to write, and resuming it would resume something else.
 */
export const STALE_QUEUE_MS = 5 * 60 * 1000;

/** Within this of where the other device stopped, this one is already there. */
export const SAME_SPOT_MS = 10_000;

/** What the proxy answers about the last device that played. */
export interface LastStop {
  /** The device's kind as it called itself ("phone", "browser") or a name. */
  name: string;
  /** The proxy's clock when it stopped, or when it last said it played. */
  at: number;
  /** Whether that is this very device. */
  mine: boolean;
  /** Whether it has stopped; a device still playing is the other card's. */
  stopped: boolean;
}

/** The parts of the server's saved queue the decision reads. */
export interface ServerQueue {
  entries: readonly { id: string }[];
  current?: string;
  position: number;
  changed?: number;
  changedBy?: string;
}

export interface ResumeInput {
  now: number;
  /** Whether anything is playing here right now. */
  playing: boolean;
  saved: ServerQueue | null;
  /** The proxy's answer, or null without the proxy (or nobody played yet). */
  stop: LastStop | null;
  /** Our own client name, to tell another Subsonic player's queue from ours. */
  ourClient: string;
  /** Where this device's own queue stands. */
  here: { id?: string; positionMs: number };
}

export interface ResumeOffer {
  /** Where in the saved queue to start. */
  index: number;
  /** How far into that song, in milliseconds. */
  positionMs: number;
  /** When the other device stopped. */
  at: number;
  /** What it calls itself; empty when nothing says. */
  device: string;
}

/** The offer to make, or null when there is nothing to pick up. */
export function resumeOffer({ now, playing, saved, stop, ourClient, here }: ResumeInput): ResumeOffer | null {
  if (playing || !saved?.current) return null;
  const index = saved.entries.findIndex((s) => s.id === saved.current);
  if (index < 0) return null;

  let at: number | undefined;
  let device: string;
  if (stop) {
    if (stop.mine || !stop.stopped) return null;
    if (saved.changed !== undefined && saved.changed < stop.at - STALE_QUEUE_MS) return null;
    at = stop.at;
    device = stop.name;
  } else if (saved.changedBy && saved.changedBy !== ourClient) {
    at = saved.changed;
    device = saved.changedBy;
  } else {
    return null;
  }
  if (at === undefined || now - at > RESUME_WINDOW_MS) return null;
  if (here.id === saved.current && Math.abs(here.positionMs - saved.position) < SAME_SPOT_MS) return null;
  return { index, positionMs: saved.position, at, device };
}
