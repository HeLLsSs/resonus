/**
 * Reading a song's tags without downloading the song.
 *
 * A share is browsed as folders, so a track starts out as a filename and
 * nothing else. This fills in the name, the artist and the album afterwards,
 * in the background, by asking the server for the first few kilobytes of each
 * file rather than the file: two range requests, a few kilobytes each, against
 * a download of tens of megabytes.
 *
 * **ID3 only, which means MP3.** The parser is the app's own, the one the
 * local library has always used, and it knows ID3 and nothing else. A FLAC or
 * an M4A comes back with no tags and keeps its filename — the same thing that
 * happens to it in the local library, so at least the app is consistent about
 * what it cannot read.
 */
import { parseID3, type ID3Tags } from '@/lib/id3';

/** How much of a tag is worth fetching. Big enough for the words and a small
 *  cover, small enough that a folder of fifty songs is not a download. */
const TAG_CAP = 256 * 1024;

/** What a tag's first ten bytes say about its length. Null when the file does
 *  not begin with an ID3 tag at all, which is the common case for everything
 *  that is not an MP3. */
export function id3Length(head: Uint8Array): number | null {
  if (head.length < 10) return null;
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null;
  // Four seven-bit groups, the top bit of each byte left out so the size can
  // never look like the tag's own marker.
  const size =
    ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  return size > 0 ? size : null;
}

/** Reads a byte range, or null if the server would not give it. */
async function range(url: string, headers: Record<string, string>, from: number, to: number) {
  const res = await fetch(url, { headers: { ...headers, Range: `bytes=${from}-${to}` } });
  // 206 is the answer to a range; a 200 means the whole file is coming, which
  // is exactly what this exists to avoid, so it is refused rather than read.
  if (res.status !== 206) return null;
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The tags of a file on a share, or null when there are none to be had.
 *
 * Never throws: this runs behind a list somebody is already reading, and a
 * song that keeps its filename is a smaller disappointment than a screen that
 * breaks.
 */
export async function readRemoteTags(
  url: string,
  headers: Record<string, string> = {},
): Promise<ID3Tags | null> {
  try {
    const head = await range(url, headers, 0, 9);
    if (!head) return null;
    const length = id3Length(head);
    if (length === null) return null;
    const whole = await range(url, headers, 0, Math.min(10 + length, TAG_CAP) - 1);
    return whole ? parseID3(whole) : null;
  } catch {
    return null;
  }
}

/**
 * Runs the work a few at a time.
 *
 * A folder of fifty songs is fifty pairs of requests, and firing them at once
 * is how a phone times out its own connections and a server starts refusing.
 */
export async function inBatches<T>(items: T[], at: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(at, items.length)) }, async () => {
    for (;;) {
      const mine = next++;
      if (mine >= items.length) return;
      await run(items[mine]);
    }
  });
  await Promise.all(workers);
}
