/**
 * Songs kept because they were listened to, not because anybody asked.
 *
 * A drive plays the same records over and over, and every one of them went
 * back over the network. What is listened through is fetched once and kept, so
 * the second time is a file: no waiting, no data, and it plays in a tunnel.
 *
 * **Its own folder, deliberately.** Downloads are a promise the person made to
 * themselves — an album taken along on purpose — and nothing here may touch
 * them. So the cache keeps its own files, its own index, and its own ceiling,
 * and the only thing it ever deletes is what it put there. A song that is both
 * downloaded and cached is simply never cached: the download is already the
 * file the player will reach for.
 *
 * It fills while you listen and empties from the oldest listen when it is
 * full, which is the behaviour nobody has to be told about.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as Network from 'expo-network';
import { create } from 'zustand';

import { type Song } from '@/api/subsonic';
import { getItem, setItem } from '@/lib/storage';
import { useAuthStore } from './auth';
import { useSettings } from './settings';

/** One kept song: where the file is, how big, and when it was last heard. */
interface Kept {
  uri: string;
  bytes: number;
  /** Last listened to, in ms. What the ceiling evicts by. */
  at: number;
}

interface PlayCacheState {
  entries: Record<string, Kept>;
  hydrated: boolean;
}

/**
 * How much the cache may hold, from the setting. Two gigabytes by default: a
 * few hundred songs at the bitrates a server streams, which covers the records
 * somebody actually returns to without taking a noticeable share of a phone.
 */
export function cacheCeilingBytes(): number {
  return Math.max(1, useSettings.getState().playCacheGB) * 1024 * 1024 * 1024;
}

/** The sizes offered. Beyond ten, a phone is better served by downloading the
 *  records on purpose. */
export const PLAY_CACHE_SIZES = [1, 2, 5, 10, 20];

/** How much of a song has to be heard before it is worth keeping. Half: enough
 *  that it was not a skip, early enough that the file is there next time. */
export const KEEP_AFTER = 0.5;

const KEY = 'resonus.playCache';

export const usePlayCache = create<PlayCacheState>(() => ({ entries: {}, hydrated: false }));

/** True only on a mobile connection. In doubt, treated as mobile: the cache is
 *  a convenience, and the wrong guess here costs somebody money. */
async function onMobileData(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.type === Network.NetworkStateType.CELLULAR;
  } catch {
    return true;
  }
}

function folder() {
  const dir = new Directory(Paths.cache, 'playcache');
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save(entries: Record<string, Kept>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void setItem(KEY, JSON.stringify(entries)).catch(() => {}), 1000);
}

export async function hydratePlayCache(): Promise<void> {
  try {
    const raw = await getItem(KEY);
    const entries = raw ? (JSON.parse(raw) as Record<string, Kept>) : {};
    usePlayCache.setState({ entries, hydrated: true });
  } catch {
    usePlayCache.setState({ entries: {}, hydrated: true });
  }
}

/** The file kept for a song, if there is one. */
export function cachedUri(songId: string): string | undefined {
  const kept = usePlayCache.getState().entries[songId];
  if (!kept) return undefined;
  // The files live in the system cache, which Android empties on its own when
  // storage runs short. An index that outlived its files would hand the player
  // an address that plays nothing, so the file is asked about rather than
  // assumed, and a missing one is forgotten here and now.
  try {
    if (new File(kept.uri).exists) return kept.uri;
  } catch {
    // Unreadable counts as gone.
  }
  const entries = { ...usePlayCache.getState().entries };
  delete entries[songId];
  usePlayCache.setState({ entries });
  save(entries);
  return undefined;
}

/** Says a song was heard again, so the ceiling takes the others first. */
export function touchCached(songId: string): void {
  const entries = usePlayCache.getState().entries;
  const kept = entries[songId];
  if (!kept) return;
  const next = { ...entries, [songId]: { ...kept, at: Date.now() } };
  usePlayCache.setState({ entries: next });
  save(next);
}

/** What the cache is using, in bytes. */
export function cacheBytes(): number {
  let total = 0;
  for (const kept of Object.values(usePlayCache.getState().entries)) total += kept.bytes;
  return total;
}

/** Drops the oldest listens until the cache is under its ceiling. */
async function makeRoom(incoming: number): Promise<void> {
  const entries = { ...usePlayCache.getState().entries };
  let total = incoming;
  for (const kept of Object.values(entries)) total += kept.bytes;
  const ceiling = cacheCeilingBytes();
  if (total <= ceiling) return;
  const oldest = Object.entries(entries).sort((a, b) => a[1].at - b[1].at);
  for (const [id, kept] of oldest) {
    if (total <= ceiling) break;
    await remove(kept);
    delete entries[id];
    total -= kept.bytes;
  }
  usePlayCache.setState({ entries });
  save(entries);
}

async function remove(kept: Kept): Promise<void> {
  try {
    const file = new File(kept.uri);
    if (file.exists) file.delete();
  } catch {
    // Gone already, or a folder the system cleared: the index is what matters.
  }
}

/** Everything the cache holds, files and index. */
export async function clearPlayCache(): Promise<void> {
  const entries = usePlayCache.getState().entries;
  await Promise.all(Object.values(entries).map((kept) => remove(kept)));
  usePlayCache.setState({ entries: {} });
  save({});
}

/** Which songs are worth keeping at all: something the server streams, with an
 *  id to fetch it by. A radio has its own address and a phone file is already
 *  a file. */
function worthKeeping(song: Song, alreadyOnDisk: boolean): boolean {
  return !song.url && !song.localUri && !alreadyOnDisk && !!song.id;
}

/**
 * Keeps a song that has been listened through, if everything says it should
 * be: the setting, the connection, and its not being on the phone already.
 *
 * Never on mobile data — the point is to spend less of it, not to spend it
 * twice — and never twice for the same song. Failures are silent: this is a
 * convenience, and nothing that happens here should reach somebody's evening.
 */
export async function keepIfWorthIt(
  song: Song,
  alreadyOnDisk: boolean,
  /**
   * The very address the player would stream, and what opens it.
   *
   * Handed in rather than built here, and that is the point: the player knows
   * the quality somebody asked for and this does not. Built here it fetched
   * the original every time, so a phone set to stream at 192 kbps was quietly
   * filling up with lossless files — the setting ignored, and the ceiling
   * reached several times faster than anybody expected.
   */
  stream: { uri: string; headers?: Record<string, string> },
): Promise<void> {
  if (!useSettings.getState().playCache) return;
  if (!worthKeeping(song, alreadyOnDisk)) return;
  if (usePlayCache.getState().entries[song.id]) return;
  const { auth, offline } = useAuthStore.getState();
  if (!auth || offline) return;
  // Always Wi-Fi, whatever the download setting says: this is nobody's
  // request, and spending somebody's data plan on a second copy of what they
  // have just heard is the one thing it must never do.
  if (await onMobileData()) return;
  try {
    const file = new File(folder(), `${song.id}`);
    if (file.exists) file.delete();
    const out = await File.downloadFileAsync(stream.uri, file, {
      headers: stream.headers,
    });
    const bytes = out.size ?? 0;
    if (bytes <= 0) return;
    await makeRoom(bytes);
    const entries = { ...usePlayCache.getState().entries, [song.id]: { uri: out.uri, bytes, at: Date.now() } };
    usePlayCache.setState({ entries });
    save(entries);
  } catch {
    // No room, no network, a server that refused: the song still played.
  }
}
