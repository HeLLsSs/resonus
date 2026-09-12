/**
 * JS ↔ `CarAuto` native module bridge (Android Auto / Automotive OS).
 *
 * The native module holds ONE MediaLibrarySession (Media3) that provides the
 * car controls and the browse tree. From JS:
 *  - `setNodes` pushes the browse tree (root → albums/artists/...).
 *  - `setNowPlaying`/`setQueue`/`setPlaybackState` keep the car session in
 *    sync with actual playback.
 *  - `onPlay` fires when a playable leaf is tapped in the car.
 *  - `onTransport` fires with transport buttons (play/pause/next...).
 *  - `onCarSearch` fires with something typed in the car's search box, and
 *    `setSearchResults` is the answer to it.
 *
 * On platforms without the module (web, iOS) everything is a no-op.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

const native = requireOptionalNativeModule('CarAuto');

export const carAutoAvailable = !!native;

/** A node of the browse tree shown in the car. */
export interface CarNode {
  id: string;
  title: string;
  subtitle?: string;
  /** http(s) → downloaded by host; file:// → embedded; data: unsupported. */
  artworkUrl?: string;
  /** true = playable leaf; false = browsable folder. */
  playable: boolean;
  /** How to render children of a browsable node: "list" | "grid". */
  contentStyle?: 'list' | 'grid';
  /**
   * What the item is. The car draws each kind its own way — an artist's cover
   * comes out round, an album's square — and without this everything browsable
   * is a folder to it. Left out, it falls back to that.
   */
  mediaType?: 'album' | 'artist' | 'playlist';
  /**
   * The heading this item sits under. Consecutive items sharing one are drawn
   * as a group beneath it, which is how a tab holds several shelves without
   * spending a screen on each.
   */
  group?: string;
  /**
   * How far through this one already is, 0 to 1, which the car draws as a bar
   * under the title. Only for a row that resumes rather than starts; left out
   * everywhere else, where a bar would say something untrue.
   */
  progress?: number;
}

/** Tree: parentId → children map. Root is the "root" key. */
export interface CarTree {
  nodes: Record<string, CarNode[]>;
  /**
   * True for a tree that holds the lists but not the songs inside them. The
   * native side lays one of these over what it already has instead of taking
   * it as the whole truth, and keeps it out of the snapshot it writes: that
   * file is what the car reads when it starts the service on its own, and a
   * partial tree written there is an album that opens onto nothing.
   */
  partial?: boolean;
  /** The account it was built from, so one profile's tree is never merged
   *  into another's. `profileScopeId()`. */
  profile?: string;
}

export interface CarTrack {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  durationMs?: number;
  /** One of the account's favourites, which is the heart the car draws on its
   *  playback screen and what pressing it will undo. */
  favorite?: boolean;
}

export type TransportEvent =
  | { action: 'play' | 'pause' | 'next' | 'previous' }
  | { action: 'seek'; value: number } // ms
  | { action: 'seekToIndex'; value: number }
  | { action: 'shuffle'; value: number } // 1/0
  | { action: 'favorite'; value: number } // 1 = make it one, 0 = stop
  | { action: 'repeat'; value: 'off' | 'all' | 'one' };

export interface PlayEvent {
  mediaId: string;
  parentId?: string;
}

/** Something typed in the car's search box. */
export interface CarSearchEvent {
  query: string;
  /** What the browse tree on the phone answers it with, best match first. The
   *  library's own hits are laid behind these. */
  local: CarNode[];
}

export function setNodes(tree: CarTree): void {
  native?.setNodes(JSON.stringify(tree));
}

export function setNowPlaying(track: CarTrack | null): void {
  native?.setNowPlaying(track ? JSON.stringify(track) : null);
}

/**
 * The queue, and what it came from. The name heads the car's queue screen,
 * which without it is a list of songs with nothing saying where they are from.
 */
export function setQueue(tracks: CarTrack[], currentIndex: number, title?: string): void {
  native?.setQueue(JSON.stringify({ tracks, currentIndex, title }));
}

export function setPlaybackState(state: {
  isPlaying: boolean;
  positionMs: number;
  shuffle: boolean;
  repeatMode: 'off' | 'all' | 'one';
  /** What the player gave up on, for the car to put on its screen. A phone in
   *  a pocket shows its toast to nobody. Left out when nothing is wrong; never
   *  null, which does not survive the crossing (see `CarAutoModule`). */
  error?: string;
}): void {
  native?.setPlaybackState(JSON.stringify(state));
}

export function onPlay(cb: (e: PlayEvent) => void): { remove: () => void } | undefined {
  return native?.addListener('play', cb);
}

export function onTransport(cb: (e: TransportEvent) => void): { remove: () => void } | undefined {
  return native?.addListener('transport', cb);
}

/** A car asked for the browse tree's root, which is Android Auto opening. */
export function onCarConnected(cb: () => void): { remove: () => void } | undefined {
  return native?.addListener('connect', cb);
}

/**
 * Something typed in the car's search box. The nodes the native side already
 * has for it travel as JSON, the way the tree does: an event payload is a map
 * of plain values.
 */
export function onCarSearch(cb: (e: CarSearchEvent) => void): { remove: () => void } | undefined {
  return native?.addListener('search', (e: { query: string; local?: string }) => {
    let local: CarNode[] = [];
    try {
      local = e.local ? (JSON.parse(e.local) as CarNode[]) : [];
    } catch {
      local = [];
    }
    cb({ query: e.query, local });
  });
}

/**
 * The answer to a search. The car has usually stopped waiting by the time a
 * slow one arrives, and the native side keeps it for the next try rather than
 * dropping it (`CarSearch.kt`), so this is worth sending whenever it is ready.
 */
export function setSearchResults(query: string, nodes: CarNode[]): void {
  native?.setSearchResults(JSON.stringify({ query, nodes }));
}
