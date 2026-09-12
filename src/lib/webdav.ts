/**
 * Reading a WebDAV folder: Nextcloud, ownCloud, a plain Apache, a NAS.
 *
 * Only what browsing needs — list a folder, and hand the player an address it
 * can stream. There is no scanning and no catalogue: the folders are the
 * library, which is what makes this work the day it is switched on rather than
 * after somebody's whole collection has been read through a phone.
 *
 * **Why the parsing is done by hand.** A `PROPFIND` answers in XML and React
 * Native has no XML parser; pulling one in for four fields would be a
 * dependency for nothing. WebDAV's answer is regular enough to read directly —
 * a flat list of `<response>` elements, each with a href and a couple of
 * properties — and everything below is written against what servers actually
 * send rather than against the standard's full generality: namespaces come in
 * several spellings (`d:`, `D:`, none at all), and the parts we do not
 * understand are ignored rather than guessed at.
 */

/** One thing in a folder. */
export interface DavEntry {
  /** Its name as shown, already unescaped. */
  name: string;
  /** The path from the server root, as the href gave it, still encoded. */
  href: string;
  isFolder: boolean;
  /** Bytes, when the server said. */
  size?: number;
  /** What the server calls it, when it said: `audio/flac` and the like. */
  contentType?: string;
}

/** The extensions worth showing. A folder of a thousand photographs has no
 *  business in a music app, and the server's own content type is not always
 *  there to tell us. */
const AUDIO = /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|aiff?|wma|alac|ape|wv|mpc|dsf|dff)$/i;

/** Whether an entry is music: what the server says first, its name second. */
export function isAudio(entry: DavEntry): boolean {
  if (entry.isFolder) return false;
  if (entry.contentType?.startsWith('audio/')) return true;
  return AUDIO.test(entry.name);
}

/** The tag's content, whatever namespace prefix it came with. */
function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${name}>`, 'i'));
  return m ? m[1].trim() : undefined;
}

/** Whether a self-closing or paired tag is present at all, which is how a
 *  collection says it is one: `<d:collection/>` inside `<d:resourcetype>`. */
function hasTag(block: string, name: string): boolean {
  return new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}[^>]*(?:/>|>)`, 'i').test(block);
}

/** The last segment of a path, decoded, with any trailing slash gone. */
export function nameFromHref(href: string): string {
  const trimmed = href.replace(/\/+$/, '');
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    // A href the server encoded in a way this cannot undo is still better
    // shown as it stands than not shown at all.
    return last;
  }
}

/**
 * The entries of a `PROPFIND` answer, with the folder itself left out.
 *
 * A `Depth: 1` request answers with the folder first and its children after,
 * and that first one is dropped by comparing hrefs rather than by position:
 * not every server puts it first, and one that did not would otherwise show a
 * folder containing itself.
 */
export function parsePropfind(xml: string, ofHref: string): DavEntry[] {
  const self = ofHref.replace(/\/+$/, '');
  const out: DavEntry[] = [];
  const blocks = xml.match(/<(?:[a-zA-Z0-9]+:)?response[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?response>/gi) ?? [];
  for (const block of blocks) {
    const href = tag(block, 'href');
    if (!href) continue;
    if (href.replace(/\/+$/, '') === self) continue;
    const isFolder = hasTag(tag(block, 'resourcetype') ?? '', 'collection');
    const rawSize = tag(block, 'getcontentlength');
    const size = rawSize && /^\d+$/.test(rawSize) ? Number(rawSize) : undefined;
    out.push({
      name: nameFromHref(href),
      href,
      isFolder,
      size,
      contentType: tag(block, 'getcontenttype') || undefined,
    });
  }
  return out;
}

/** Folders first, then names, the way a file manager does it. Case and accents
 *  ignored, so `Étoile` sits where somebody looks for it. */
export function sortEntries(entries: DavEntry[]): DavEntry[] {
  return entries
    .slice()
    .sort((a, b) =>
      a.isFolder === b.isFolder ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isFolder ? -1 : 1,
    );
}
