/**
 * `@/store/remoteTrack` with nothing to publish: a song is handed over by
 * the address it carries, and nothing is served off the phone. The real one
 * reaches the server client and the phone's own HTTP server, neither of which
 * a test of what a speaker is told has any use for.
 */
import type { Song } from '../../src/api/subsonic';
import type { Served } from '../../src/lib/localHttp';
import type { RemoteTrackInfo } from '../../src/store/remoteTrack';

export function remoteTrackInfo(song: Song): RemoteTrackInfo {
  return { title: song.title, artist: song.artist, durationSec: song.duration ?? 0 };
}

/** With `startSec`, the address carries where the stream is to start, the
 *  way the server's own does (`timeOffset`). */
export function remoteTrackUrl(song: Song, startSec = 0): string | undefined {
  return song.url && startSec > 0 ? `${song.url}?timeOffset=${startSec}` : song.url;
}

export async function ensureLocalFilesServed(_songs: Song[], _extra: Served[] = []): Promise<void> {}
