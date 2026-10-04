/**
 * What another app shared with this one, read as something to play.
 *
 * The YouTube, YouTube Music and SoundCloud apps all share the same way: a
 * line of text, sometimes a title or a "Listen to … on #SoundCloud" in front,
 * with one link in it. This finds that link and says what it points at, so
 * the sheet that opens can offer to play it or file it. The link handed on to
 * the proxy is a clean one, without the `si=` tracking and the timestamps the
 * apps add, so that two shares of the same track look the same to it.
 *
 * Plain data in and out, apart from the screen that uses it.
 */

export type SharedLink =
  | { source: 'youtube'; kind: 'track'; videoId: string; url: string }
  | { source: 'youtube'; kind: 'playlist'; listId: string; url: string }
  /** A SoundCloud short link (`on.soundcloud.com/…`) says nothing of what it
   *  leads to until it is followed, hence `link`. */
  | { source: 'soundcloud'; kind: 'track' | 'playlist' | 'link'; url: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,}$/;

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

/** The YouTube or SoundCloud track or playlist in a shared text, if any. */
export function parseSharedLink(text: string | null | undefined): SharedLink | null {
  const url = text ? firstUrl(text) : null;
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'music.youtube.com') return youtube(url, host);
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') return soundcloud(url, host);
  return null;
}
