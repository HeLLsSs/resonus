/**
 * The shape of the car's tabs and of what its search box answers, with nothing
 * fetched: what goes where, under which heading and how many of each.
 * `carAutoTree` gathers the rows and this decides the order, so the decisions
 * about what a driver sees first can be read, and tested, without a server or
 * a store behind them.
 */
import type { CarNode } from './carAuto';

/** One stretch of a tab: its rows, the heading over them and a ceiling. */
export interface CarSection {
  /** Drawn over the rows as a group title; none means plain rows. */
  heading?: string;
  nodes: CarNode[];
  /** How many of the rows are shown. The rest never leave the phone. */
  max?: number;
}

/**
 * How far through a song a resume point is, 0 to 1, or undefined when there is
 * no honest answer.
 *
 * The car draws this as a bar under the row, which is the one place a "resume"
 * row says how much is left without being opened. A song the server gave no
 * duration for gets nothing rather than a full bar, and a position past the end
 * — a duration that changed under a bookmark, a server rounding down — is a
 * full one rather than an overflowing one.
 */
export function resumeFraction(positionMs: number, durationSec: number | undefined): number | undefined {
  if (!durationSec || durationSec <= 0) return undefined;
  const fraction = positionMs / 1000 / durationSec;
  if (!Number.isFinite(fraction) || fraction <= 0) return undefined;
  return Math.min(fraction, 1);
}

/**
 * The rows of a tab drawn as one list, section after section. A section with
 * nothing in it takes no room, heading included: an empty "Continue listening"
 * is a promise the tab cannot keep. The ceiling is applied here rather than
 * where the rows are gathered, so the same rows can be cut differently for
 * Home and for a folder in the Library.
 */
export function tabLayout(sections: CarSection[]): CarNode[] {
  const out: CarNode[] = [];
  for (const s of sections) {
    const rows = s.max === undefined ? s.nodes : s.nodes.slice(0, s.max);
    for (const node of rows) out.push(s.heading ? { ...node, group: s.heading } : node);
  }
  return out;
}

/** A drawer of the Library and how many rows it opens onto. */
export interface CarDrawer {
  node: CarNode;
  /** What is behind the row, or `null` for a drawer filled in later. */
  count: number | null;
}

/**
 * The Library's rows, without the drawers that open onto nothing: a folder
 * that opens onto an empty list is a worse thing to offer than no folder.
 * `null` is for a drawer whose rows are fetched after the lists, and it stays.
 */
export function drawerLayout(drawers: CarDrawer[]): CarNode[] {
  return drawers.filter((d) => d.count === null || d.count > 0).map((d) => d.node);
}

/**
 * Whether a set of rows has outgrown Home. A few of them sit on Home under
 * "Continue listening"; past that the rest go behind a drawer in the Library,
 * so Home stays a screen and not a scroll.
 */
export function overflowsHome(count: number, homeMax: number): boolean {
  return count > homeMax;
}

// ── The search box ───────────────────────────────────────────────────────────

/** Lowercase, unaccented and single-spaced, the way the native side folds what
 *  was said: "bjork" is Björk in both places. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The kinds a search groups its rows under. */
export type SearchKind = 'song' | 'album' | 'artist' | 'playlist';

/** How many rows of one kind a search shows. A driver reads the top of a list
 *  and taps; past this it is a scroll nobody makes at the wheel. */
const MAX_PER_KIND = 25;

/** What a browse id says its row is, or nothing for the rows that are none of
 *  the four: a genre, a resume point, a mix, a way into the Library. */
function searchKind(id: string): SearchKind | null {
  if (id.startsWith('track|')) return 'song';
  if (id.startsWith('album:')) return 'album';
  if (id.startsWith('artist:')) return 'artist';
  if (id.startsWith('playlist:') || id.startsWith('smart:') || id === 'favorites') return 'playlist';
  return null;
}

/** The song a track row points at, so the same song found under an album and
 *  under its artist is one row. A track's id carries the parent it came from. */
function rowKey(id: string): string {
  return id.startsWith('track|') ? id.split('|').slice(2).join('|') : id;
}

/** How closely a row answers what was typed: its name, the start of its name,
 *  or neither. */
function titleScore(said: string, title: string): number {
  const name = fold(title);
  if (name === said) return 2;
  if (name.startsWith(said)) return 1;
  return 0;
}

/**
 * The rows a search in the car answers with: what the phone's own tree holds
 * and what the library found, as one list grouped by kind.
 *
 * The tree's come first, and not only because they arrive first: they are
 * what is downloaded, and what a search still finds with nothing reachable. A
 * row the two both hold is drawn once, the tree's copy, which is the one that
 * can be browsed rather than only played.
 *
 * The kinds are ordered by their best row, so what was typed decides what
 * sits at the top of the screen: "Radiohead" answers with the artist above
 * the songs, while a word that only turns up inside titles leaves the songs
 * where they are. The rows that are of no kind keep no heading and go last;
 * there are never many, and they are things like a genre or a resume point.
 */
export function searchRows(
  query: string,
  local: CarNode[],
  found: CarNode[],
  headings: Record<SearchKind, string>,
): CarNode[] {
  const said = fold(query);
  const seen = new Set<string>();
  const groups = new Map<SearchKind | '', CarNode[]>();
  const best = new Map<SearchKind | '', number>();
  for (const node of [...local, ...found]) {
    const key = rowKey(node.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = searchKind(node.id) ?? '';
    const rows = groups.get(kind);
    if (rows) rows.push(node);
    else groups.set(kind, [node]);
    best.set(kind, Math.max(best.get(kind) ?? 0, titleScore(said, node.title)));
  }
  // A kind of its own for the rest, always last: it is a heading nobody could
  // write, over rows that answer the query more loosely than the four do.
  const rank = (kind: SearchKind | '') => (kind === '' ? -1 : (best.get(kind) ?? 0));
  return Array.from(groups.keys())
    .sort((a, b) => rank(b) - rank(a))
    .flatMap((kind) => {
      // Whatever heading the tree drew a row under ("Made for you", "Pinned")
      // means nothing in an answer to a search, so it goes either way.
      const heading = kind === '' ? undefined : headings[kind];
      return (groups.get(kind) ?? []).slice(0, MAX_PER_KIND).map((node) => ({ ...node, group: heading }));
    });
}
