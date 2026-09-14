/**
 * Reading a song's tags without downloading the song.
 *
 * A share is browsed as folders, so a track starts out as a filename and
 * nothing else. This fills in the name, the artist and the album afterwards,
 * in the background, by asking the server for the first few kilobytes of each
 * file rather than the file: two range requests, a few kilobytes each, against
 * a download of tens of megabytes.
 *
 * **Three containers, because a share is where the FLACs live.** MP3 carries
 * ID3, and the app's own parser has always read it. FLAC carries a Vorbis
 * comment, and M4A carries an `ilst` inside `moov`; both are read here, over
 * the same byte ranges. A share of lossless files used to come back as a list
 * of filenames with no artist and no album, which is the one library where
 * that hurts most.
 *
 * Everything else — an OGG, a WMA, an AIFF — still keeps its filename, and
 * says so by coming back empty rather than by failing.
 */
import { parseID3, type ID3Tags } from '@/lib/id3';

/** How much of a tag is worth fetching. Big enough for the words and a small
 *  cover, small enough that a folder of fifty songs is not a download. */
const TAG_CAP = 256 * 1024;

/** What is read to tell one container from another: ten bytes for an ID3
 *  header, and twelve to see an MP4's `ftyp` at offset four. */
const SNIFF = 16;

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

/**
 * A remote file read a piece at a time, and how long it is.
 *
 * The length comes free with the first range: a server answering one says
 * `Content-Range: bytes 0-15/7340032`, and the total after the slash is what
 * tells an MP4 parser where to look when the index sits at the end of the
 * file — which is where a file that was not made for streaming puts it.
 */
interface Reader {
  /** `length` bytes from `from`, or null if the server would not give them. */
  at: (from: number, length: number) => Promise<Uint8Array | null>;
  /** The file's length, once a range has been answered. */
  total: () => number | null;
}

function reader(url: string, headers: Record<string, string>): Reader {
  let total: number | null = null;
  return {
    total: () => total,
    at: async (from, length) => {
      if (length <= 0) return new Uint8Array(0);
      const res = await fetch(url, {
        headers: { ...headers, Range: `bytes=${from}-${from + length - 1}` },
      });
      if (res.status !== 206) return null;
      if (total === null) {
        const said = res.headers.get('content-range')?.split('/')[1];
        const parsed = said ? Number.parseInt(said, 10) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) total = parsed;
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Four bytes as a big-endian number, which is how every MP4 atom and every
 *  FLAC block says how long it is. */
function be32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/** The same, the other way round: a Vorbis comment counts in little-endian,
 *  alone among the three formats read here. */
function le32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0);
}

/** Four bytes as the ASCII name they stand for. */
function name(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

const utf8 = new TextDecoder('utf-8');


/**
 * What a Vorbis comment says, from the block's own bytes.
 *
 * The shape is a vendor string nobody wants, then a count, then that many
 * `KEY=value` strings in UTF-8. Everything is little-endian, alone among the
 * three containers read here, which is the one detail that catches people out.
 *
 * Keys are compared uppercased because the standard only asks for
 * case-insensitivity, and taggers disagree: `Title`, `TITLE` and `title` all
 * turn up in the same folder.
 */
export function parseVorbisComment(block: Uint8Array): ID3Tags {
  const tags: ID3Tags = {};
  if (block.length < 8) return tags;
  let at = 4 + le32(block, 0);
  if (at + 4 > block.length) return tags;
  let count = le32(block, at);
  at += 4;
  // A count is four bytes and a corrupt file can claim four billion entries:
  // the loop stops at the buffer either way, but the ceiling keeps a broken
  // header from spinning through a million iterations of nothing.
  count = Math.min(count, 512);
  for (let i = 0; i < count; i++) {
    if (at + 4 > block.length) break;
    const length = le32(block, at);
    at += 4;
    if (length <= 0 || at + length > block.length) break;
    const entry = utf8.decode(block.subarray(at, at + length));
    at += length;
    const split = entry.indexOf('=');
    if (split <= 0) continue;
    const key = entry.slice(0, split).toUpperCase();
    const value = entry.slice(split + 1).trim();
    if (value === '') continue;
    if (key === 'TITLE') tags.title ??= value;
    else if (key === 'ARTIST') tags.artist ??= value;
    else if (key === 'ALBUMARTIST' || key === 'ALBUM ARTIST') tags.albumArtist ??= value;
    else if (key === 'ALBUM') tags.album ??= value;
    else if (key === 'TRACKNUMBER') {
      // "3" or "3/12": the total is not ours to keep.
      const number = Number.parseInt(value.split('/')[0], 10);
      if (Number.isFinite(number) && number > 0) tags.track ??= number;
    } else if (key === 'DATE' || key === 'YEAR') {
      const year = Number.parseInt(value.slice(0, 4), 10);
      if (Number.isFinite(year) && year > 0) tags.year ??= year;
    }
  }
  return tags;
}

/**
 * A FLAC's tags, walking its metadata blocks.
 *
 * After `fLaC` come blocks, each a four-byte header — one byte for the type
 * and whether it is the last, three for the length — then the block itself.
 * The one wanted is type 4. The walk is done over the bytes already in hand
 * and asks for more only when a block runs past them, which on a file whose
 * comment sits behind an embedded cover is one extra range rather than the
 * cover itself.
 */
async function flacTags(read: Reader, head: Uint8Array): Promise<ID3Tags | null> {
  let window = head;
  let at = 4;
  for (let block = 0; block < 32; block++) {
    if (at + 4 > window.length) {
      const more = await read.at(at, 4096);
      if (!more || more.length < 4) return null;
      window = join(window, at, more);
    }
    const kind = window[at] & 0x7f;
    const last = (window[at] & 0x80) !== 0;
    const length = (window[at + 1] << 16) | (window[at + 2] << 8) | window[at + 3];
    const from = at + 4;
    if (kind === 4) {
      if (length > TAG_CAP) return null;
      let body = window.subarray(from, from + length);
      if (body.length < length) {
        const whole = await read.at(from, length);
        if (!whole || whole.length < length) return null;
        body = whole;
      }
      return parseVorbisComment(body);
    }
    if (last) return {};
    at = from + length;
  }
  return {};
}

/** The window with a piece read at `at` put where it belongs. Blocks are walked
 *  by absolute offset, so the buffer has to stay addressable the same way. */
function join(window: Uint8Array, at: number, more: Uint8Array): Uint8Array {
  const grown = new Uint8Array(Math.max(window.length, at + more.length));
  grown.set(window, 0);
  grown.set(more, at);
  return grown;
}

/**
 * What an MP4's `ilst` says. Each entry is an atom whose name is the field —
 * `©nam` for the title, `©ART` for the artist — holding a `data` atom whose
 * payload is the value, after eight bytes of version, flags and padding.
 *
 * The © is `0xA9`, which is not a character anybody can type, so the names are
 * compared by their bytes.
 */
export function parseIlst(list: Uint8Array): ID3Tags {
  const tags: ID3Tags = {};
  let at = 0;
  while (at + 8 <= list.length) {
    const size = be32(list, at);
    if (size < 8 || at + size > list.length) break;
    const field = name(list, at + 4);
    // Inside each entry, the `data` atom carries the value.
    const body = list.subarray(at + 8, at + size);
    const value = dataAtom(body);
    if (value) {
      if (field === '\xA9nam') tags.title ??= text(value);
      else if (field === '\xA9ART') tags.artist ??= text(value);
      else if (field === 'aART') tags.albumArtist ??= text(value);
      else if (field === '\xA9alb') tags.album ??= text(value);
      else if (field === '\xA9day') {
        const year = Number.parseInt(text(value).slice(0, 4), 10);
        if (Number.isFinite(year) && year > 0) tags.year ??= year;
      } else if (field === 'trkn' && value.length >= 4) {
        // Two shorts: an unused one, then the track. The total follows and is
        // not ours to keep.
        const number = (value[2] << 8) | value[3];
        if (number > 0) tags.track ??= number;
      }
    }
    at += size;
  }
  return tags;
}

/** The payload of the `data` atom inside an entry, or null if there is none. */
function dataAtom(entry: Uint8Array): Uint8Array | null {
  let at = 0;
  while (at + 8 <= entry.length) {
    const size = be32(entry, at);
    if (size < 8 || at + size > entry.length) return null;
    if (name(entry, at + 4) === 'data') {
      // Four bytes of type, four of locale, then the value.
      return size >= 16 ? entry.subarray(at + 16, at + size) : null;
    }
    at += size;
  }
  return null;
}

function text(value: Uint8Array): string {
  return utf8.decode(value).trim();
}

/**
 * An M4A's tags, from the `moov` index.
 *
 * Atoms are a length and a name, nested. What is wanted is
 * `moov > udta > meta > ilst`, and `meta` is the awkward one: it puts four
 * bytes of version and flags before its children, which every parser that has
 * ever got this wrong forgets.
 *
 * `moov` sits at the front of a file made for streaming and at the back of one
 * that was not, and both turn up on a share. The top-level atoms are walked by
 * their headers — eight bytes each, whatever the atom's size — so finding one
 * at the end costs a handful of tiny ranges rather than the file.
 */
async function mp4Tags(read: Reader): Promise<ID3Tags | null> {
  const total = read.total();
  let at = 0;
  for (let atom = 0; atom < 32; atom++) {
    if (total !== null && at + 8 > total) return {};
    const header = await read.at(at, 8);
    if (!header || header.length < 8) return {};
    let size = be32(header, 0);
    const kind = name(header, 4);
    // A 64-bit size: the 32-bit field reads 1 and the real length follows the
    // name. Rare, and a file big enough to need one is not a song.
    if (size === 1) return {};
    if (size === 0) size = total !== null ? total - at : 0;
    if (size < 8) return {};
    if (kind === 'moov') {
      if (size > TAG_CAP) {
        // A `moov` bigger than the cap is one carrying artwork we do not want.
        // Its own children are walked instead of the whole thing being pulled.
        return await ilstIn(read, at + 8, size - 8, 0);
      }
      const body = await read.at(at + 8, size - 8);
      return body ? findIlst(body) : {};
    }
    at += size;
  }
  return {};
}

/** `ilst`, hunted through nested atoms already in hand. */
function findIlst(atoms: Uint8Array): ID3Tags {
  let at = 0;
  while (at + 8 <= atoms.length) {
    const size = be32(atoms, at);
    if (size < 8 || at + size > atoms.length) break;
    const kind = name(atoms, at + 4);
    if (kind === 'ilst') return parseIlst(atoms.subarray(at + 8, at + size));
    if (kind === 'udta' || kind === 'meta' || kind === 'moov') {
      // `meta` carries four bytes of version and flags before its children;
      // the others start straight away.
      const skip = kind === 'meta' ? 4 : 0;
      const found = findIlst(atoms.subarray(at + 8 + skip, at + size));
      if (Object.keys(found).length > 0) return found;
    }
    at += size;
  }
  return {};
}

/** The same hunt, for a `moov` too big to pull in one go: its children are
 *  read one header at a time and only `udta` is followed. */
async function ilstIn(read: Reader, from: number, length: number, depth: number): Promise<ID3Tags> {
  if (depth > 3) return {};
  let at = from;
  const end = from + length;
  while (at + 8 <= end) {
    const header = await read.at(at, 8);
    if (!header || header.length < 8) return {};
    const size = be32(header, 0);
    const kind = name(header, 4);
    if (size < 8 || at + size > end) return {};
    if (kind === 'udta' || kind === 'meta' || kind === 'ilst') {
      if (size <= TAG_CAP) {
        const body = await read.at(at + 8, size - 8);
        if (!body) return {};
        return kind === 'ilst' ? parseIlst(body) : findIlst(body);
      }
      const skip = kind === 'meta' ? 4 : 0;
      return await ilstIn(read, at + 8 + skip, size - 8 - skip, depth + 1);
    }
    at += size;
  }
  return {};
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
    const read = reader(url, headers);
    // The first range does three things at once: it says whether the server
    // serves ranges at all, it says how long the file is, and it carries
    // enough of the start to tell one container from another.
    const head = await read.at(0, SNIFF);
    if (!head || head.length < SNIFF) return null;

    const id3 = id3Length(head);
    if (id3 !== null) {
      const whole = await read.at(0, Math.min(10 + id3, TAG_CAP));
      return whole ? parseID3(whole) : null;
    }
    if (name(head, 0) === 'fLaC') {
      // Four kilobytes hold the stream info and, on most files, the comment
      // straight after it: one request rather than two.
      const start = await read.at(0, 4096);
      return start ? await flacTags(read, start) : null;
    }
    // An MP4 begins with a size and then `ftyp`, never with a name of its own.
    if (name(head, 4) === 'ftyp') {
      return await mp4Tags(read);
    }
    // An OGG, a WMA, an AIFF: nothing here reads them, and a filename is the
    // honest answer rather than a wrong one.
    return null;
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
