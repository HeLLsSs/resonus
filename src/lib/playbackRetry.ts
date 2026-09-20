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
}

export function freshRetries(): RetryState {
  return { trackId: null, attempts: 0, gaveUp: false, lastAt: 0, busy: false };
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
  // for the one before has nothing to say about this one.
  const here = state.trackId === trackId ? state : { ...freshRetries(), trackId };
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
 * Sound: whatever it took, this track is not the failing one any more.
 *
 * Also what a press of play does. A track given up on is given up on until
 * somebody asks for it, and asking is exactly what that press is: without this
 * the only way back was to play something else first.
 */
export function playingAgain(state: RetryState): RetryState {
  return state.attempts === 0 && !state.gaveUp && !state.busy ? state : freshRetries();
}
