/**
 * What a YouTube tile leads to, and which of them lead anywhere at all.
 *
 * The proxy hands the shelves over as YouTube arranges them, and YouTube puts
 * four or five kinds of thing side by side in one row: playlists, records,
 * artists, channels, the odd video. This app can open two of those — a list of
 * tracks, and a single track, both of which the proxy answers for — and has
 * nothing behind an artist page. A tile that would do nothing when pressed is
 * worse than one that is not there, so those are dropped, and a shelf left
 * with nothing goes with them.
 *
 * Kept apart from the screen because it is the one part of the tab that is
 * plain data in and plain data out, and it is where the awkward cases live: a
 * playlist tile that only carries a browse id, which is the same id with `VL`
 * in front of it, and a record whose browse id is not a playlist at all while
 * its playlist id is.
 *
 * The account the proxy is signed in with is read and repaired here too, for
 * the same reason: what the proxy says about it, and what a browser puts in
 * the clipboard when somebody copies a cookie out of it, are both data to be
 * made sense of before a screen can say anything about them.
 */
// Types only, and said so at the top of the statement rather than specifier by
// specifier: the API module reads the account through this one, and an import
// that survives compilation would make that a circle.
import type { YoutubeCard, YoutubeShelf } from '@/api/subsonic';

/**
 * The two refusals that must not read alike.
 *
 * Nobody ever gave the proxy a YouTube account (101), or the session it was
 * given has run out and needs signing in again (100). Both arrive as an
 * account with nothing in it, and only one of them is somebody's to fix, so
 * the code is the only thing that tells them apart.
 */
const NO_ACCOUNT = 101;
const EXPIRED = 100;

export type YoutubeRefusal = 'none' | 'expired' | null;

/**
 * What the proxy refused with, if it refused for one of those two reasons.
 *
 * Read off the code the failed request carries (`SubsonicRequestError`) rather
 * than by its class, which keeps this module plain logic with nothing of the
 * network in it. Anything else — a proxy that is not there, an address that
 * answers as an ordinary server would — is not an account problem and says so
 * in its own words.
 */
export function accountRefusal(error: unknown): YoutubeRefusal {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === NO_ACCOUNT) return 'none';
  if (code === EXPIRED) return 'expired';
  return null;
}

/**
 * How the proxy is doing with the account, in the four ways that must not read
 * alike: it can read it, the session it had has died, it never had one, and it
 * could not be asked at all.
 */
export type YoutubeAccountState = 'ok' | 'expired' | 'none' | 'unreachable';

/** Where the cookie it is using came from: pasted from a phone, the value the
 *  server was started with, or nothing at all. */
export type YoutubeAccountSource = 'stored' | 'env' | 'none';

export interface YoutubeAccount {
  source: YoutubeAccountSource;
  state: YoutubeAccountState;
  /** The account's own name, when the proxy could read it. */
  name?: string;
}

const STATES: YoutubeAccountState[] = ['ok', 'expired', 'none', 'unreachable'];
const SOURCES: YoutubeAccountSource[] = ['stored', 'env', 'none'];

/**
 * What the proxy answered about its account, taken at arm's length.
 *
 * The route answers `ok` even when the session is dead — an expired cookie is
 * a state to show, not a request that failed — so everything worth knowing is
 * in the body, and the body comes from a proxy that may be older than this
 * screen. A word neither side knows is not something to act on, so it lands on
 * `unreachable`, which is the state that says "ask again" rather than one that
 * claims anything about the account.
 */
export function readAccount(raw: unknown): YoutubeAccount {
  const node = (raw ?? {}) as { source?: unknown; state?: unknown; name?: unknown };
  const state = STATES.find((s) => s === node.state) ?? 'unreachable';
  const source = SOURCES.find((s) => s === node.source) ?? 'none';
  const name = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : undefined;
  return { source, state, name };
}

/**
 * Why a pasted cookie was not kept, as the three answers a person can do
 * something different about: YouTube looked at it and said no, YouTube could
 * not be reached at all and nothing was changed, or the proxy itself never got
 * that far — which is also what a proxy too old to have the route says.
 */
export type YoutubeSaveFailure = 'refused' | 'youtube' | 'proxy';

/** Subsonic's unnumbered error, which the save route uses for "YouTube did not
 *  answer": nothing was stored, and the cookie is not what is at fault. */
const GENERIC = 0;

export function saveFailure(error: unknown): YoutubeSaveFailure {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === EXPIRED) return 'refused';
  if (code === GENERIC) return 'youtube';
  return 'proxy';
}

/** A header name copied along with its value, which is what happens when the
 *  whole line is selected rather than the value alone. */
const COOKIE_LABEL = /^cookie\s*:\s*/i;
/** The whole thing in quotes, as "copy as cURL" and a few network panels give
 *  it. Only a matched pair, so a stray quote inside a value is left alone. */
const QUOTED = /^(["'])([\s\S]*)\1$/;

/**
 * A cookie as a browser handed it over, made into the one line the proxy wants.
 *
 * It arrives about seventeen hundred characters long, and everything that goes
 * wrong on the way is the browser's doing rather than the person's: the header
 * name in front of it, quotes around it, and the line breaks a panel wrapped it
 * at, which are inside the text once it is pasted. Cookie values carry no
 * whitespace of their own, so any run of it is something that was added.
 */
export function cleanCookie(pasted: string): string {
  const quoted = QUOTED.exec(pasted.trim());
  return (quoted ? quoted[2] : pasted)
    .trim()
    .replace(COOKIE_LABEL, '')
    .replace(/\s+/g, ' ')
    .replace(/;+$/, '')
    .trim();
}

/**
 * Whether the paste carries the pair every signed request is signed with. The
 * proxy refuses a cookie without one outright, and it is the difference between
 * the whole `Cookie` header and some shorter thing that was copied by mistake,
 * so it is worth saying here rather than after a round trip.
 */
const SAPISID = /(?:^|;\s*)(?:__Secure-[13]PAPISID|SAPISID)=[^;\s]/;

export function hasSapisid(cookie: string): boolean {
  return SAPISID.test(cookie);
}

/**
 * The first of the accounts a browser is signed in to, which is what it sends
 * when only one of them is.
 *
 * A browser numbers the accounts signed in to it and says which one a request
 * belongs to, so a cookie copied out of one needs that number copied with it.
 * A sign-in done inside the app starts from an empty jar and ends with exactly
 * one account in it, so there the number is never anything else, and whatever
 * somebody typed for a paste has nothing to do with it.
 */
export const FIRST_ACCOUNT = '0';

/**
 * The account number that goes with the cookie, out of whatever was typed:
 * the `X-Goog-AuthUser` header's value, sometimes with its name in front of it.
 */
export function cleanAuthUser(pasted: string): string {
  return pasted.replace(/\D+/g, '') || FIRST_ACCOUNT;
}

// ── Signing in from the app ──────────────────────────────────────────────────
// Google's own page, opened in a WebView, instead of a trip to the developer
// tools of a desktop browser. What makes it work is that it is a real browser:
// two-factor, passkeys and account recovery all behave, because none of them
// are being imitated. What the app has to work out is only when it is over.

/**
 * Where the sign-in starts. `service=youtube` is what makes Google hand out
 * YouTube's own set of cookies at the end rather than only google.com's, and
 * `continue` is where it puts you once it has.
 */
export const SIGN_IN_URL =
  'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F';

/**
 * Where adding a second account starts.
 *
 * `AddSession` is Google's own "add an account" entry: it keeps the accounts
 * already signed in and puts another beside them, which is what makes one
 * cookie carry several. Signing in again from the front page would replace the
 * session instead, and the proxy would be back to reading one account.
 */
export const ADD_ACCOUNT_URL =
  'https://accounts.google.com/AddSession?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F';

/** The address whose jar is the one to read, and the one the sign-in ends on. */
export const MUSIC_ORIGIN = 'https://music.youtube.com';

/**
 * Arrived: the page is YouTube Music itself, not somewhere on the way to it.
 *
 * Anchored at the start and stopped at a character that can only end a host, so
 * a page hosted at `music.youtube.com.example.org` — or the sign-in page
 * carrying that address as its `continue` — is not mistaken for the end of the
 * journey.
 */
const MUSIC_URL = /^https:\/\/music\.youtube\.com(?:[/?#]|$)/i;

/**
 * Whether the sign-in is done: on YouTube Music, with a jar that carries the
 * pair a signed request is signed with.
 *
 * Both halves are needed and neither is enough. The address alone is reached
 * while signed in to nobody, which is what YouTube Music shows a stranger; the
 * cookie alone is set on the way through Google's own pages, before YouTube has
 * a session at all. The proxy makes the final judgement — it signs a real
 * request with the cookie before it keeps anything — so this only has to be
 * right about when there is something worth sending.
 */
export function signedIn(url: string, jar: string | null | undefined): boolean {
  return MUSIC_URL.test(url) && !!jar && hasSapisid(jar);
}

/** Where a tile goes: a playlist of the proxy's, or a track to play. */
export type YoutubeTarget =
  | { kind: 'playlist'; id: string }
  | { kind: 'song'; id: string };

/** YouTube's own prefix for "the page of this playlist", which the endpoint
 *  that fetches one does not want. */
const BROWSE_PREFIX = 'VL';

export function cardTarget(card: YoutubeCard): YoutubeTarget | null {
  if (card.type === 'video') {
    // The id the proxy gives a track it found on YouTube, which is the id the
    // player streams and the library ends up filing it under.
    return card.videoId ? { kind: 'song', id: `yt_${card.videoId}` } : null;
  }
  if (card.type !== 'playlist' && card.type !== 'album') return null;
  // The playlist id first: on a record the browse id names a release page the
  // proxy has no endpoint for, while the playlist id is the audio behind it.
  const id = card.playlistId || stripBrowsePrefix(card.browseId);
  return id ? { kind: 'playlist', id } : null;
}

function stripBrowsePrefix(browseId: string | null | undefined): string {
  if (!browseId) return '';
  return browseId.startsWith(BROWSE_PREFIX) ? browseId.slice(BROWSE_PREFIX.length) : browseId;
}

/** The shelves with the dead tiles taken out, and the empty shelves with them.
 *  A shelf of tracks is kept whole: every track can be played. */
export function openableShelves(shelves: YoutubeShelf[]): YoutubeShelf[] {
  return shelves
    .map((shelf) => ({ ...shelf, items: shelf.items.filter((card) => cardTarget(card)) }))
    .filter((shelf) => shelf.items.length > 0 || shelf.songs.length > 0);
}
