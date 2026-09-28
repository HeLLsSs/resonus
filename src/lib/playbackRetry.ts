/**
 * How many times a track that will not play is given another go, and how
 * quickly.
 *
 * The player reports a failure with every status it sends, twice a second,
 * and the answer to a failure is to load the track again. Left to itself that
 * is a loop: each reload installs a source, the source fails, the failure
 * arrives, and the next reload is already on its way. On the web it ran at two
 * thousand players a second, each one asking the server for the stream again,
 * until the server stopped answering anything at all. What had been meant to
 * stop it — two attempts and then give up — never applied, because the way out
 * was only taken when the app believed it was not playing, which during
 * playback it never does.
 *
 * So the rule lives here instead, as a state and a decision over it, with no
 * player and no clock of its own:
 *
 *  · a failure while a reload is still in flight is not news, it is the same
 *    failure arriving again;
 *  · two failures in a row close together are one failure;
 *  · past the attempts, the track is given up on and stays given up on until
 *    somebody asks for it again.
 */

/** Two: enough to ride out a hiccup, few enough not to retry a dead source. */
export const MAX_ATTEMPTS = 2;

/** How long after a reload another failure is taken at face value. Below this
 *  it is the one that was already being answered. */
export const RETRY_DELAY_MS = 1_000;

/**
 * How long a reloaded track has to sound before its failures are forgotten.
 * A reload starts the track from the top and only then seeks back to where it
 * failed, so a moment of sound proves nothing: a track broken at 1:30 played
 * its first second on every go, was forgiven on every go, and went round for
 * ever, restarting each time. Sound this long past the reload is a track that
 * got over its hiccup.
 */
export const SOUND_HELD_MS = 10_000;

/**
 * How many tracks in a row may be given up on and passed over before the
 * queue stops instead. One bad file in an album is passed over, the way a
 * scratched track on a record is; a whole album of them is not walked
 * through in silence with a toast per song.
 */
export const MAX_SKIPS = 3;

export interface RetryState {
  /** The track the attempts below belong to. */
  trackId: string | null;
  attempts: number;
  /** Both attempts spent: its failures are old news from here. */
  gaveUp: boolean;
  /** When the last reload was started, by the caller's clock. */
  lastAt: number;
  /** A reload is in flight; nothing it reports counts until it has landed. */
  busy: boolean;
  /** Tracks given up on and passed over, one after another, without a sound between. */
  skipped: number;
}

export function freshRetries(): RetryState {
  return { trackId: null, attempts: 0, gaveUp: false, lastAt: 0, busy: false, skipped: 0 };
}

/**
 * What to do about a failure:
 *
 *  · `retry` — load the track again, and tell this module when that is over.
 *  · `announce` — say it out loud; this track is not going to play.
 *  · `wait` — nothing. Either something is already being done about it, or it
 *    has been said once already.
 */
export type RetryAction = 'retry' | 'announce' | 'wait';

/** The decision, and the state to keep for the next one. */
export function onFailure(
  state: RetryState,
  trackId: string,
  now: number,
): { state: RetryState; act: RetryAction } {
  // Another track's failure is another track's story: whatever was counted
  // for the one before has nothing to say about this one, except how many
  // were passed over on the way here.
  const here = state.trackId === trackId ? state : { ...freshRetries(), trackId, skipped: state.skipped };
  if (here.busy) return { state: here, act: 'wait' };
  if (here.gaveUp) return { state: here, act: 'wait' };
  if (here.attempts > 0 && now - here.lastAt < RETRY_DELAY_MS) return { state: here, act: 'wait' };
  if (here.attempts >= MAX_ATTEMPTS) {
    return { state: { ...here, gaveUp: true }, act: 'announce' };
  }
  return {
    state: { ...here, attempts: here.attempts + 1, lastAt: now, busy: true },
    act: 'retry',
  };
}

/**
 * The reload this module asked for is over, however it went.
 *
 * Named with the track it was for, because the queue moves: skipping to
 * another track while a reload is in flight starts that one's own attempt,
 * and the first reload landing afterwards would otherwise clear a flag it
 * never set, letting a failure through while a source is still being
 * installed.
 */
export function settled(state: RetryState, trackId: string): RetryState {
  return state.busy && state.trackId === trackId ? { ...state, busy: false } : state;
}

/**
 * A press of play: the track is asked for again, whatever it did before. A
 * track given up on is given up on until somebody asks for it, and asking is
 * exactly what that press is: without this the only way back was to play
 * something else first.
 */
export function playingAgain(state: RetryState): RetryState {
  return state.attempts === 0 && !state.gaveUp && !state.busy ? state : freshRetries();
}

/**
 * The track was given up on and the next one is being started in its place.
 * Null when enough have been passed over already: the queue is to stop here.
 */
export function skipping(state: RetryState): RetryState | null {
  return state.skipped < MAX_SKIPS ? { ...state, skipped: state.skipped + 1 } : null;
}

/**
 * Sound, at `now`, from `trackId`: the track is not the failing one any
 * more, once it has sounded for `SOUND_HELD_MS` past the reload that brought
 * it back (see there). Until then the count stands, and a track that fails
 * again at the same place runs out of goes rather than round in a circle.
 * Another track sounding is another track's story: the one counted here is
 * let go of at once, so coming back to it starts it over rather than meeting
 * a failure filed as old news; only the tracks passed over stay counted,
 * until the sound has held.
 */
export function soundHeld(state: RetryState, now: number, trackId: string | undefined): RetryState {
  if (state.attempts === 0 && !state.gaveUp && state.skipped === 0) return state;
  const held = !state.busy && now - state.lastAt >= SOUND_HELD_MS;
  if (held) return freshRetries();
  if (state.trackId !== null && trackId !== undefined && trackId !== state.trackId) {
    return { ...freshRetries(), skipped: state.skipped };
  }
  return state;
}
