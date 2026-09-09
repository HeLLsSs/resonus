/**
 * ListenBrainz, from the phone, for the one thing the server will not do.
 *
 * Listens never come through here: Navidrome sends those itself for every
 * client at once (see the scrobbling screen). What it does not send is the
 * heart. A favourite on the server stays on the server, and ListenBrainz has
 * its own list of loved recordings that nothing here fed until now. So the app
 * talks to ListenBrainz directly for feedback and for nothing else, with a
 * user token of its own, which is the same token the server was given and has
 * to be pasted a second time because the server keeps its copy to itself.
 *
 * A recording is named by its MusicBrainz id, which Navidrome carries as
 * `musicBrainzId` on a song when the file is tagged with one. A song without
 * it cannot be named to ListenBrainz at all, so it is left out on both
 * directions rather than guessed at from artist and title.
 */
// Not the global `fetch`: React Native's stops answering in the background,
// and a love sent from the lock screen is exactly the one that would be lost.
// See the note in `api/subsonic.ts`.
import { fetch } from 'expo/fetch';

const BASE = 'https://api.listenbrainz.org/1';
/** Long enough for a slow mobile link, short enough that a tap is not held
 *  hostage by a service that is down. */
const TIMEOUT_MS = 15_000;
/** The most `get-feedback` hands over in one page. */
const PAGE = 100;
/**
 * How many loved recordings an import will read before stopping. Fifty pages
 * is what somebody who has loved a song a day for fourteen years has, and past
 * that the import is the thing standing between the screen and a hang.
 */
export const LOVED_MAX = 5_000;

/** 1 loves a recording, 0 takes the love (or the hate) back, -1 hates it. */
export type FeedbackScore = 1 | 0 | -1;

export type ListenBrainzErrorKind =
  /** The token is not one ListenBrainz knows. */
  | 'unauthorized'
  /** No answer at all: no network, a timeout, a refused connection. */
  | 'network'
  /** ListenBrainz answered and said no, for a reason in `message`. */
  | 'other';

export class ListenBrainzError extends Error {
  constructor(
    readonly kind: ListenBrainzErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ListenBrainzError';
  }
}

/** One request, with the token where ListenBrainz wants it and the answer
 *  parsed or turned into a typed error. `token` may be empty for the public
 *  reads, which need none. */
async function call<T>(path: string, token: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Token ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new ListenBrainzError('network', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
  // Errors come back as JSON too (`{code, error}`), and the text is worth
  // keeping: "Invalid authorization token" is more use than "401".
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.status === 401 || res.status === 403) {
    throw new ListenBrainzError('unauthorized', json?.error ?? 'Invalid token', res.status);
  }
  if (!res.ok) {
    throw new ListenBrainzError('other', json?.error ?? `HTTP ${res.status}`, res.status);
  }
  return json as T;
}

/**
 * Whose token this is, or null when it is nobody's. ListenBrainz answers a
 * wrong token here with 200 and `valid: false`, not with 401, so a bad paste
 * is an ordinary answer and only a service that cannot be reached throws.
 */
export async function validateToken(token: string): Promise<string | null> {
  const r = await call<{ valid: boolean; user_name?: string }>('/validate-token', token);
  return r.valid && r.user_name ? r.user_name : null;
}

/** Loves, unloves or hates one recording for the token's user. */
export async function setFeedback(
  token: string,
  recordingMbid: string,
  score: FeedbackScore,
): Promise<void> {
  await call('/feedback/recording-feedback', token, { recording_mbid: recordingMbid, score });
}

/**
 * Every recording the user has loved, newest first, as MusicBrainz ids.
 *
 * Read page by page to the end, since the list is what an import is for and
 * a first page of a hundred would be an import that stops in 2023. Capped at
 * `LOVED_MAX`, and the cap is reported through the length: whoever calls this
 * can tell the list was cut when it comes back exactly that long.
 */
export async function lovedRecordings(token: string, user: string): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; offset < LOVED_MAX; offset += PAGE) {
    const r = await call<{ feedback: { recording_mbid: string | null }[]; total_count: number }>(
      `/feedback/user/${encodeURIComponent(user)}/get-feedback?score=1&count=${PAGE}&offset=${offset}&metadata=false`,
      token,
    );
    for (const f of r.feedback) {
      // A love recorded against a MessyBrainz id alone has no MusicBrainz id
      // to look up in the library, so it is not one this app can act on.
      if (f.recording_mbid) out.push(f.recording_mbid);
    }
    if (r.feedback.length < PAGE || offset + PAGE >= r.total_count) break;
  }
  return out.slice(0, LOVED_MAX);
}
