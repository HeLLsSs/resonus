/**
 * Play history: list of listened songs, most recent first and no duplicates (if
 * you play one again, it moves to the top). Persisted per profile (each server
 * and local mode have their own history) to avoid mixing songs the other
 * profile can't play. Feeds the Activity / History screen.
 */
import { create } from 'zustand';

import { type Song } from '@/api/subsonic';
import { primaryUrl } from '@/lib/serverUrls';
import { deleteItem, getItem, setItem } from '@/lib/storage';
import { useAuthStore } from './auth';

/** Old history key, shared across profiles (migrated). */
const LEGACY_KEY = 'resonus.playHistory';
const MAX = 100;

// SecureStore only accepts keys with [A-Za-z0-9._-]; sanitize serverUrl/username
// (the URL contains ':' and '/') to avoid passing an invalid key.
function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Whose history this is. The account first, and the mode not at all: the songs
 * an account plays are its songs whether or not there was a connection at the
 * time, and they play the same either way.
 *
 * Asking about the mode first put every account's offline listening into one
 * shared bucket, which is the mixing this was meant to avoid, and it moved the
 * key under the app's feet: nothing re-reads the history when the mode changes,
 * so the next song played wrote what was already in memory into the other
 * profile's bucket. Only a local profile, which has no account, keeps that key,
 * and it is the one it always had.
 */
function storageKey(): string {
  const { auth } = useAuthStore.getState();
  if (auth) return `resonus.playHistory.server.${safe(primaryUrl(auth))}.${safe(auth.username)}`;
  if (useAuthStore.getState().offline) return 'resonus.playHistory.offline';
  return LEGACY_KEY;
}

export interface HistoryEntry {
  song: Song;
  /** Time of last play (ms). */
  playedAt: number;
  /**
   * How much of it was actually heard, 0 to 1, or undefined for an entry
   * written before this was recorded.
   *
   * A play is written down the moment a track starts, because that is when the
   * history is worth showing. But a song skipped after three seconds went into
   * it exactly like one heard to the end, and everything built on this — the
   * mixes, "For you", what counts as a favourite artist — was reading a taste
   * out of what somebody had rejected. This is closed off when the track is
   * left, so the entry says which of the two it was.
   */
  heard?: number;
}

interface PlayHistoryState {
  entries: HistoryEntry[];
  hydrated: boolean;
  record: (song: Song) => void;
  /** Closes off the entry for a song that has just been left, with the share of
   *  it that was heard. Ignored for a song that is not the one at the top. */
  markHeard: (songId: string, heard: number) => void;
  /** Clears the history. Returns the function that restores it (for the «Undo»
   *  toast), or nothing if it was already empty. */
  clear: () => (() => void) | undefined;
  hydrate: () => Promise<void>;
}

let currentKey = '';

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(key: string, entries: HistoryEntry[]) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void setItem(key, JSON.stringify(entries));
  }, 1000);
}

export const usePlayHistory = create<PlayHistoryState>((set, get) => ({
  entries: [],
  hydrated: false,

  record: (song) => {
    if (!song?.id) return;
    const key = storageKey();
    // Whoever is in memory belongs to whoever was signed in when it was read.
    // Writing them under another profile's key is how one profile's listening
    // ends up in another's history, so a change of profile starts over here.
    if (currentKey && currentKey !== key) {
      currentKey = key;
      set({ entries: [] });
    }
    const rest = get().entries.filter((e) => e.song.id !== song.id);
    const entries = [{ song, playedAt: Date.now() }, ...rest].slice(0, MAX);
    set({ entries });
    scheduleSave(key, entries);
  },

  markHeard: (songId, heard) => {
    const entries = get().entries;
    const top = entries[0];
    // Only the one just left, and only upward: a song played twice in a row
    // keeps the better of the two listens, and a pause near the start does not
    // erase the fact that it was heard through the first time.
    if (!top || top.song.id !== songId) return;
    const share = Math.min(1, Math.max(0, heard));
    if (share <= (top.heard ?? 0)) return;
    const next = [{ ...top, heard: share }, ...entries.slice(1)];
    set({ entries: next });
    scheduleSave(storageKey(), next);
  },

  clear: () => {
    const prev = get().entries;
    if (prev.length === 0) return undefined;
    set({ entries: [] });
    scheduleSave(storageKey(), []);
    return () => {
      // Preserve anything that played while the toast was visible.
      const cur = get().entries;
      const ids = new Set(cur.map((e) => e.song.id));
      const entries = [...cur, ...prev.filter((e) => !ids.has(e.song.id))].slice(0, MAX);
      set({ entries });
      scheduleSave(storageKey(), entries);
    };
  },

  hydrate: async () => {
    try {
      // Clear in-memory history if coming from another profile.
      const key = storageKey();
      if (currentKey && currentKey !== key) set({ entries: [] });
      currentKey = key;
      let raw = await getItem(key);
      // Migration: the old history was global; the active profile inherits it
      // on first launch and the shared key is deleted.
      if (!raw && key !== LEGACY_KEY) {
        raw = await getItem(LEGACY_KEY);
        if (raw) {
          await setItem(key, raw);
          await deleteItem(LEGACY_KEY);
        }
      }
      set({ entries: raw ? (JSON.parse(raw) as HistoryEntry[]) : [], hydrated: true });
    } catch {
      set({ entries: [], hydrated: true });
    }
  },
}));
