/**
 * What a remote output is handed for a song: where to fetch it, what it is,
 * and what to show while it plays.
 *
 * Shared by UPnP/DLNA (`upnp.ts`) and Google Cast (`googleCast.ts`), which
 * are the same problem at this end: a device on the network that fetches for
 * itself, and can only be sent a URL it can reach. The URL carries the
 * account's stream credentials (the server's `t`/`s` parameters), the same as
 * it always has for UPnP; the device is handed them, and so is anyone reading
 * the network the request crosses.
 *
 * What the URL cannot carry is the profile's extra headers
 * (`SubsonicAuth.headers`): a renderer is given an address and nothing else,
 * and it fetches the stream and the artwork on its own. A server behind an
 * authenticating proxy (Cloudflare Access and the like) would refuse it. So
 * for such a profile the renderer is handed this phone's address instead, and
 * the phone fetches from the server with the headers on and relays the bytes
 * (`relayedUrl`, the same server that hands out the phone's own files). The
 * phone has to stay awake for it, as it does for a download it serves; a
 * downloaded song is served off the phone directly rather than relayed.
 */
import { authHeaders, coverArtUrl as serverCoverArtUrl, streamUrl, type Song } from '@/api/backend';
import { COVER } from '@/api/data';
import { localFileUrl, publishLocalFiles, relayedUrl, type Served } from '@/lib/localHttp';
import { localCoverUrl } from '@/lib/localLibrary';
import { useAuthStore } from './auth';
import { useSettings } from './settings';

/** Bitrate for the MP3 fallback when streaming at original quality: a
 *  lossless track has no bitrate to inherit, and 320 is as good as MP3 gets. */
const CAST_MP3_BITRATE = 320;

export interface RemoteTrackInfo {
  title: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  artworkUrl?: string;
  durationSec: number;
}

function firstNonBlank(...values: (string | undefined | null)[]): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

export function remoteTrackInfo(song: Song): RemoteTrackInfo {
  const auth = useAuthStore.getState().auth;
  const listedArtists = firstNonBlank(song.artists?.map((a) => a.name).filter(Boolean).join(', '));
  const listedAlbumArtists = firstNonBlank(song.albumArtists?.map((a) => a.name).filter(Boolean).join(', '));
  // The picture comes from wherever the song does, and by the same test: a
  // cover on the server is no use to a renderer being handed a file off this
  // phone, which is what a download casts as with the server out of reach.
  // The phone's own copy goes out through the same door as the audio, and
  // `localFilesOf` opens it under exactly this condition — the two have to
  // agree or the URL points at something nobody published.
  const cover = song.albumId ?? song.coverArt;
  const artworkUrl = servedByPhone(song)
    ? localFileUrl(localCoverUrl(cover))
    : auth
      ? throughRelay(serverCoverArtUrl(auth, cover, COVER.card))
      : undefined;
  return {
    title: song.title,
    artist: firstNonBlank(song.artist, listedArtists, listedAlbumArtists),
    albumArtist: listedAlbumArtists,
    album: firstNonBlank(song.album),
    artworkUrl,
    durationSec: song.duration ?? 0,
  };
}

/**
 * The headers the profile's server wants on every request, when it wants any:
 * the one case where a renderer cannot be handed the server's URL as it is.
 */
function relayHeaders(): Record<string, string> | undefined {
  const auth = useAuthStore.getState().auth;
  if (!auth) return undefined;
  const headers = authHeaders(auth);
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * A server URL as the renderer should be handed it: as it is, or through the
 * phone when the server wants headers. Undefined then if the phone has nothing
 * to relay from (no address on the network, or the URL was never published),
 * which reads to the caller as "nothing can serve this".
 */
function throughRelay(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return relayHeaders() ? relayedUrl(url) : url;
}

/**
 * The server's own address for a song, when the server is the one that can
 * serve it: an account, and a connection to reach it through. Bare: this is
 * the URL the server answers, whether or not it wants headers with it.
 */
function bareServerStreamUrl(song: Song): string | undefined {
  const { auth, offline } = useAuthStore.getState();
  if (!auth || offline || song.url) return undefined;
  const settings = useSettings.getState();
  return streamUrl(auth, song.id, settings.maxBitRate, 0, settings.streamFormat);
}

/** The same, as MP3 (see `mp3StreamUrl`). */
function bareMp3StreamUrl(song: Song): string | undefined {
  const { auth } = useAuthStore.getState();
  if (!auth || !bareServerStreamUrl(song)) return undefined;
  const settings = useSettings.getState();
  return streamUrl(
    auth,
    song.id,
    settings.maxBitRate > 0 ? settings.maxBitRate : CAST_MP3_BITRATE,
    0,
    'mp3',
  );
}

/**
 * The server's address for a song as the renderer will be handed it.
 *
 * Preferred over the phone even for a song that is downloaded. The renderer
 * fetches for itself, so a URL on the server is one this phone does not have to
 * stay awake to answer. Unless the server wants headers: then the phone is
 * awake either way, and the download is served straight off it instead.
 */
function serverStreamUrl(song: Song): string | undefined {
  if (servedByPhone(song)) return undefined;
  return throughRelay(bareServerStreamUrl(song));
}

/**
 * Is this phone the one that will be answering for this song, out of its own
 * files?
 *
 * The same question `remoteTrackUrl` ends up asking, in one place because
 * two things depend on the answer and they must not drift: what gets published
 * to the network, and whether the cover named in the DIDL is the phone's or the
 * server's. A station brings its own address and its own picture, and neither
 * is anything to do with this.
 */
function servedByPhone(song: Song): boolean {
  if (song.url || !song.localUri) return false;
  return !bareServerStreamUrl(song) || !!relayHeaders();
}

/**
 * Where the renderer should go for this song.
 *
 * A radio brings its own address. A server account online hands over the
 * server's. What is left is a file on this phone — the local profile's music,
 * or a download with the server out of reach — and that is what the phone's own
 * server is for.
 *
 * It used to end here, at `undefined`, for anything with a `localUri`. And one
 * uncastable track was not one silent track: the UPnP queue payload is all or
 * nothing (see `buildUpnpQueuePayload`), so a single downloaded song in the
 * queue was a Sonos that played none of it.
 */
export function remoteTrackUrl(song: Song): string | undefined {
  if (song.url) return song.url;
  return serverStreamUrl(song) ?? localFileUrl(song.localUri);
}

/** The same song asked for as MP3, or undefined when the server isn't the one
 *  serving it — a file coming off this phone, or a URL of its own. Asked the
 *  same way `serverStreamUrl` asks it, since this is the second attempt at
 *  exactly that URL. */
export function mp3StreamUrl(song: Song): string | undefined {
  if (servedByPhone(song)) return undefined;
  return throughRelay(bareMp3StreamUrl(song));
}

/** The image mime of a cover this phone wrote, which it named for its format. */
function coverMime(uri: string): string {
  return uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}

/**
 * What these songs would need served from the phone: the files no server can
 * be asked for, and the covers that go with them; and, for a server that wants
 * headers, the server URLs to relay, the MP3 fallback and the cover among them.
 *
 * Nothing else is published. A renderer can only ask for what is in here, so
 * this is also the whole of what the network can reach.
 */
function localFilesOf(songs: Song[]): Served[] {
  const files: Served[] = [];
  const seen = new Set<string>();
  const add = (uri: string | undefined, mime: string) => {
    if (!uri || seen.has(uri)) return;
    seen.add(uri);
    files.push({ uri, mime });
  };
  const headers = relayHeaders();
  const relay = (url: string | undefined) => {
    if (!url || !headers || seen.has(url)) return;
    seen.add(url);
    files.push({ url, headers });
  };
  const auth = useAuthStore.getState().auth;
  for (const song of songs) {
    if (servedByPhone(song)) {
      add(song.localUri, remoteMime(song));
      const cover = localCoverUrl(song.albumId ?? song.coverArt);
      if (cover) add(cover, coverMime(cover));
    } else if (headers && auth) {
      relay(bareServerStreamUrl(song));
      relay(bareMp3StreamUrl(song));
      relay(serverCoverArtUrl(auth, song.albumId ?? song.coverArt, COVER.card));
    }
  }
  return files;
}

/**
 * Opens the phone's server and publishes what this load will need, before any
 * URL is built: `localFileUrl` answers out of what has been published, so the
 * order is the whole of it.
 */
export async function ensureLocalFilesServed(songs: Song[]): Promise<void> {
  const files = localFilesOf(songs);
  if (files.length === 0) return;
  await publishLocalFiles(files);
}

/**
 * What the file will have been turned into by the time it arrives, which is
 * only ever something the SERVER does on the way out.
 *
 * A file coming off this phone is served exactly as it lies on disk, so the
 * transcoding settings have nothing to do with it. Reading them anyway
 * announced a local FLAC as whatever codec the server had been told to send —
 * the type in the DIDL disagreeing with the type the phone then served it as,
 * which is the one thing a renderer is entitled to give up over.
 */
export function transcodedTo(song: Song): string | undefined {
  if (servedByPhone(song) || !bareServerStreamUrl(song)) return undefined;
  const settings = useSettings.getState();
  return settings.maxBitRate > 0 ? settings.streamFormat : undefined;
}

/**
 * The format of a file on the phone, which is written down nowhere but its own
 * name: the local catalog has no `suffix`, since nothing asked it for one until
 * a speaker did. Without this every local file went out announced as MP3, and a
 * renderer handed a FLAC under that name is entitled to refuse it — which is
 * the same mistake as #70, from the other end.
 */
function localSuffix(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  let path = uri.split('?')[0];
  try {
    // A SAF document id carries the file name percent-encoded inside it.
    path = decodeURIComponent(path);
  } catch {
    // Malformed escapes: the raw form still ends in the extension.
  }
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : undefined;
}

/**
 * What to tell the renderer this track is.
 *
 * A DLNA renderer decides whether it can play something from the type it is
 * handed, and a speaker refuses anything that isn't audio. The stream URL says
 * nothing about the file (`/rest/stream.view?…`), so the type has to come from
 * what we know about the song: what the server was asked to transcode to, or
 * failing that the file's own format — or, for a file on the phone, the only
 * place that ever said (see `localSuffix`).
 */
export function remoteMime(song: Song, transcodedTo?: string): string {
  const suffix = (transcodedTo || song.suffix || localSuffix(song.localUri) || '').toLowerCase();
  switch (suffix) {
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'audio/ogg';
    case 'm4a':
    case 'mp4':
    case 'aac':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'wma':
      return 'audio/x-ms-wma';
    case 'aif':
    case 'aiff':
      return 'audio/aiff';
    default:
      // Unknown is still audio, and saying so beats letting it be guessed:
      // guessing is what announced every song as a video and left speakers
      // refusing all of them (#70).
      return 'audio/mpeg';
  }
}
