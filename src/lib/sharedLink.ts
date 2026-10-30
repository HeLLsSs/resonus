/**
 * What another app shared with this one, read as something to play.
 *
 * The YouTube, YouTube Music, SoundCloud, Spotify, Deezer and Apple Music apps
 * all share the same way: a line of text, sometimes a title or a "Listen to …
 * on #SoundCloud" in front, with one link in it. This finds that link and says
 * what it points at, so the sheet that opens can offer to play it or file it.
 * The link handed on to the proxy is a clean one, without the `si=` tracking
 * and the timestamps the apps add, so that two shares of the same track look
 * the same to it.
 *
 * Plain data in and out, apart from the screen that uses it.
 */
import type { TFunction } from '@/i18n';

export type SharedLink =
  | { source: 'youtube'; kind: 'track'; videoId: string; url: string }
  | { source: 'youtube'; kind: 'playlist'; listId: string; url: string }
  /** A SoundCloud short link (`on.soundcloud.com/…`) says nothing of what it
   *  leads to until it is followed, hence `link`. */
  | { source: 'soundcloud'; kind: 'track' | 'playlist' | 'link'; url: string }
  /** Nothing of Spotify's, Deezer's or Apple Music's can be played: the proxy
   *  matches their tracks to YouTube and SoundCloud ones (`navifind/resolve`),
   *  hence the clean link. A Deezer short link (`deezer.page.link/…`) says
   *  nothing of what it leads to until it is followed, hence `link`. */
  | { source: 'spotify'; kind: 'track' | 'album' | 'playlist' | 'link'; url: string }
  | { source: 'deezer'; kind: 'track' | 'album' | 'playlist' | 'link'; url: string }
  | { source: 'apple'; kind: 'track' | 'album' | 'playlist'; url: string };

/** The sources the proxy resolves to songs of its own rather than knows by id. */
export const RESOLVED_SOURCES: ReadonlySet<SharedLink['source']> = new Set(['spotify', 'deezer', 'apple']);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const DIGITS = /^\d+$/;
const APPLE_PLAYLIST_ID = /^pl\.[A-Za-z0-9._-]+$/;
const COUNTRY = /^[a-z]{2}$/i;

/** Path segments that open a video on youtube.com: `/shorts/<id>` and kin. */
const VIDEO_PATHS = new Set(['shorts', 'live', 'embed', 'v']);

/** The first segment of a SoundCloud page that is not somebody's name. */
const SOUNDCLOUD_RESERVED = new Set([
  'discover',
  'stream',
  'search',
  'you',
  'upload',
  'charts',
  'pages',
  'settings',
  'messages',
  'notifications',
  'feed',
]);

/** The second segment of a SoundCloud page that lists rather than plays. */
const SOUNDCLOUD_PROFILE_TABS = new Set([
  'tracks',
  'albums',
  'sets',
  'reposts',
  'likes',
  'popular-tracks',
  'following',
  'followers',
  'comments',
]);

function firstUrl(text: string): URL | null {
  for (const candidate of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
    try {
      return new URL(candidate.replace(/[),.!?]+$/, ''));
    } catch {
      // Not a link after all; the next one might be.
    }
  }
  return null;
}

function youtube(url: URL, host: string): SharedLink | null {
  const music = host === 'music.youtube.com';
  const base = music ? 'https://music.youtube.com' : 'https://www.youtube.com';
  const track = (videoId: string | null | undefined): SharedLink | null =>
    videoId && VIDEO_ID.test(videoId)
      ? { source: 'youtube', kind: 'track', videoId, url: `${base}/watch?v=${videoId}` }
      : null;

  if (host === 'youtu.be') return track(url.pathname.split('/')[1]);

  const [first, second] = url.pathname.split('/').filter(Boolean);
  if (first === 'watch') return track(url.searchParams.get('v'));
  if (first && VIDEO_PATHS.has(first)) return track(second);
  if (first === 'playlist') {
    const listId = url.searchParams.get('list');
    // `RD…` lists are YouTube's own mixes, made for whoever is looking and
    // gone the next day: nothing to play back or to file.
    if (!listId || !LIST_ID.test(listId) || listId.startsWith('RD')) return null;
    return { source: 'youtube', kind: 'playlist', listId, url: `${base}/playlist?list=${listId}` };
  }
  return null;
}

function soundcloud(url: URL, host: string): SharedLink | null {
  const segments = url.pathname.split('/').filter(Boolean);
  if (host === 'on.soundcloud.com') {
    return segments.length === 1 ? { source: 'soundcloud', kind: 'link', url: `https://on.soundcloud.com/${segments[0]}` } : null;
  }
  const [user, second, third] = segments;
  if (!user || !second || SOUNDCLOUD_RESERVED.has(user)) return null;
  const clean = `https://soundcloud.com/${segments.join('/')}`;
  if (second === 'sets') return third ? { source: 'soundcloud', kind: 'playlist', url: clean } : null;
  if (SOUNDCLOUD_PROFILE_TABS.has(second)) return null;
  // `/<user>/<track>/s-<token>` is a private track's secret link: the token
  // is the permission, so it stays on.
  return { source: 'soundcloud', kind: 'track', url: clean };
}

function spotify(url: URL, host: string): SharedLink | null {
  // The app's own share link, which says nothing until it is followed.
  if (host === 'spotify.link') {
    return url.pathname.split('/').filter(Boolean).length === 1 ? { source: 'spotify', kind: 'link', url: url.href } : null;
  }
  // The web player puts its language in front: `/intl-fr/track/<id>`.
  const [kind, id] = url.pathname.split('/').filter((segment, i) => segment && !(i === 1 && segment.startsWith('intl-')));
  if ((kind !== 'track' && kind !== 'album' && kind !== 'playlist') || !id || !SPOTIFY_ID.test(id)) return null;
  return { source: 'spotify', kind, url: `https://open.spotify.com/${kind}/${id}` };
}

function deezer(url: URL, host: string): SharedLink | null {
  const segments = url.pathname.split('/').filter(Boolean);
  if (host === 'deezer.page.link') {
    return segments.length === 1 ? { source: 'deezer', kind: 'link', url: url.href } : null;
  }
  // The newer share link: `link.deezer.com/s/<id>`.
  if (host === 'link.deezer.com') {
    return segments[0] === 's' && segments.length === 2 ? { source: 'deezer', kind: 'link', url: url.href } : null;
  }
  // The site puts its language in front: `/fr/track/<id>`.
  const [kind, id] = segments[0] && COUNTRY.test(segments[0]) ? segments.slice(1) : segments;
  if ((kind !== 'track' && kind !== 'album' && kind !== 'playlist') || !id || !DIGITS.test(id)) return null;
  return { source: 'deezer', kind, url: `https://www.deezer.com/${kind}/${id}` };
}

function apple(url: URL): SharedLink | null {
  // `/<country>/<kind>/<slug>/<id>`, the slug being the name made into a path
  // and sometimes left out. A track shared out of its album is the album's
  // link with the track's id in `i=`.
  const [country, kind, ...rest] = url.pathname.split('/').filter(Boolean);
  const id = rest.at(-1);
  if (!country || !COUNTRY.test(country) || !id || rest.length > 2) return null;
  const clean = `https://music.apple.com/${country.toLowerCase()}/${kind}/${rest.join('/')}`;
  if (kind === 'playlist') return APPLE_PLAYLIST_ID.test(id) ? { source: 'apple', kind, url: clean } : null;
  if (!DIGITS.test(id)) return null;
  if (kind === 'song') return { source: 'apple', kind: 'track', url: clean };
  if (kind !== 'album') return null;
  const track = url.searchParams.get('i');
  if (track && DIGITS.test(track)) return { source: 'apple', kind: 'track', url: `${clean}?i=${track}` };
  return { source: 'apple', kind: 'album', url: clean };
}

/**
 * The YouTube, SoundCloud, Spotify, Deezer or Apple Music track or playlist
 * in a shared text, if any.
 */
export function parseSharedLink(text: string | null | undefined): SharedLink | null {
  const url = text ? firstUrl(text) : null;
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'music.youtube.com') return youtube(url, host);
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') return soundcloud(url, host);
  if (host === 'open.spotify.com' || host === 'spotify.link') return spotify(url, host);
  if (host === 'deezer.com' || host === 'deezer.page.link' || host === 'link.deezer.com') return deezer(url, host);
  if (host === 'music.apple.com') return apple(url);
  return null;
}

/**
 * The line under a resolved list's name: how many songs the proxy matched,
 * out of how many the service listed when it stopped short of them (the
 * proxy caps a list by count and by time), and how many it found nothing for.
 * "12 songs", "12 of 40 songs · 3 not found", "3 not found".
 */
export function resolvedCountsLabel(
  { found, unmatched, total }: { found: number; unmatched: number; total: number },
  t: TFunction,
  songsLabel: (n: number) => string,
): string {
  // Nothing at all, which the counts alone would say as nothing: a line of
  // its own, where the disabled play rows would otherwise go unexplained.
  if (found === 0 && unmatched === 0) return t('No song of that link was found');
  const listed = total > found + unmatched;
  return [
    listed ? t('{found} of {total} songs', { found, total }) : found ? songsLabel(found) : null,
    unmatched ? t('{n} not found', { n: unmatched }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
