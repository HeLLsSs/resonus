/**
 * Resume points, kept on the server as Subsonic bookmarks.
 *
 * A bookmark is a position in a song, one per song and account, and the
 * server keeps it across devices. Two things use them here. Somebody can set
 * one by hand from the song menu, on anything. And long songs get one on
 * their own: a mix, an audiobook or a podcast stored as a song is an hour you
 * do not start again from the top because the queue moved on, so while one of
 * those plays its position is written back now and then, and when it starts
 * again it picks up where it was.
 *
 * Everything that talks to the server is here, along with the copy of the list
 * the screens read (`useBookmarks`); the player only hands its state over
 * through `attachBookmarks`.
 */
import { create } from 'zustand';

import {
  createBookmark,
  deleteBookmark,
  getBookmarks,
  type Bookmark,
  type Song,
} from '@/api/data';
import { tg } from '@/i18n';
import { formatDuration } from '@/lib/format';
import { profileScopeId, useAuthStore } from '@/store/auth';
import { useToast } from '@/store/toast';

/**
 * Songs at least this long get a resume point without being asked: mixes,
 * audiobooks and podcasts stored as songs. Twenty minutes is past the longest
 * thing an album puts on one track and short of anything meant to be heard in
 * sittings.
 */
export const RESUME_MIN_SEC = 20 * 60;
/** How often the position goes to the server while one of those plays. */
const SAVE_EVERY_MS = 30_000;
/** This close to the end the song counts as heard, and the bookmark goes. */
const END_GRACE_SEC = 10;
/** Under this the song has not really started: nothing to come back to. */
const MIN_SAVE_SEC = 5;

interface BookmarksState {
  /** By song id; the profile they belong to is `loadedFor`. */
  byId: Record<string, Bookmark>;
  loadedFor: string | null;
}

export const useBookmarks = create<BookmarksState>(() => ({ byId: {}, loadedFor: null }));

/** Whether the active profile can hold bookmarks: a Subsonic server, online. */
export function bookmarksAvailable(): boolean {
  const { auth, offline } = useAuthStore.getState();
  return !!auth && !offline && auth.serverType !== 'jellyfin';
}

/** `bookmarksAvailable`, following the session. */
export function useBookmarksAvailable(): boolean {
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  return !!auth && !offline && auth.serverType !== 'jellyfin';
}

/** A song the server can keep a position in: its own, not a station's stream. */
function bookmarkable(song: Song | undefined): song is Song {
  return !!song && !song.url && bookmarksAvailable();
}

/** The read in flight, and the profile it is for: only that profile waits on it. */
let loading: Promise<void> | null = null;
let loadingFor: string | null = null;

/**
 * Reads the list once per profile, or again with `refresh`. The whole list in
 * one request, since that is the only shape the API has: there is no asking
 * for one song's bookmark.
 */
export function loadBookmarks(refresh = false): Promise<void> {
  if (!bookmarksAvailable()) return Promise.resolve();
  const profile = profileScopeId();
  const { loadedFor } = useBookmarks.getState();
  if (!refresh && loadedFor === profile) return Promise.resolve();
  if (loading && loadingFor === profile) return loading;
  // What is in memory is another profile's: not to be read, or resumed from,
  // while this one's list is on its way.
  if (loadedFor !== profile) useBookmarks.setState({ byId: {}, loadedFor: null });
  loadingFor = profile;
  loading = (async () => {
    try {
      const list = await getBookmarks();
      // Another profile by now: this list is somebody else's.
      if (profileScopeId() !== profile) return;
      const byId: Record<string, Bookmark> = {};
      for (const b of list) byId[b.song.id] = b;
      useBookmarks.setState({ byId, loadedFor: profile });
    } finally {
      // Unless a later read for another profile has taken the slot over.
      if (loadingFor === profile) {
        loading = null;
        loadingFor = null;
      }
    }
  })();
  return loading;
}

/**
 * Sets the song's bookmark at `positionSec`. The comment it had is handed back
 * to the server, which would otherwise wipe it: an automatic save must not
 * cost somebody the note they typed.
 */
export async function saveBookmark(song: Song, positionSec: number, comment?: string): Promise<void> {
  const profile = profileScopeId();
  const prev = useBookmarks.getState().byId[song.id];
  const text = comment ?? prev?.comment;
  const position = Math.round(positionSec * 1000);
  await createBookmark(song.id, position, text);
  if (profileScopeId() !== profile) return;
  const now = new Date().toISOString();
  useBookmarks.setState((s) => ({
    byId: {
      ...s.byId,
      [song.id]: { song, position, comment: text, created: prev?.created ?? now, changed: now },
    },
  }));
}

/** The song whose bookmark was removed by hand while it was playing. */
let removedByHand: string | null = null;

/** Removes the song's bookmark, here and on the server. */
export async function removeBookmark(id: string): Promise<void> {
  const profile = profileScopeId();
  await deleteBookmark(id);
  if (profileScopeId() !== profile) return;
  useBookmarks.setState((s) => {
    const byId = { ...s.byId };
    delete byId[id];
    return { byId };
  });
}

/**
 * The menu's "Remove bookmark", for a song that may be playing: a long one
 * would get its bookmark straight back on the next save, so the automatic
 * saves stand down until another song is playing.
 */
export async function removeBookmarkByHand(id: string): Promise<void> {
  removedByHand = id;
  await removeBookmark(id);
}

/** The menu's "Bookmark here": lifts what `removeBookmarkByHand` put down. */
export async function saveBookmarkByHand(song: Song, positionSec: number): Promise<void> {
  if (removedByHand === song.id) removedByHand = null;
  await saveBookmark(song, positionSec);
}

// ── The automatic part ───────────────────────────────────────────────────────

/** What is read off the player. A slice of its state, so it is not imported. */
export interface PlaybackSnapshot {
  queue: Song[];
  index: number;
  positionSec: number;
  durationSec: number;
  isPlaying: boolean;
  seekTo: (sec: number) => void;
}

interface PlayerLike {
  getState(): PlaybackSnapshot;
  subscribe(listener: (state: PlaybackSnapshot, prev: PlaybackSnapshot) => void): () => void;
}

/** The last position written for a song, so the same one is not written twice. */
let lastSaved: { id: string; positionSec: number; at: number } | null = null;

/**
 * The song whose bookmark is being dropped at its end. The store forgets the
 * bookmark only once the server has answered, and the beats keep coming
 * meanwhile: without this each one would send the delete again.
 */
let removing: string | null = null;

/**
 * A long song that just started, waiting on two things before it can be put
 * back where it was: its bookmark from the server, and a first beat of audio
 * from the new source. The beat matters because the queue is installed before
 * the player is, and a seek sent in between lands on the source being thrown
 * out, or on nothing.
 */
let pending: { id: string; bookmark: Bookmark | null | undefined; heard: boolean } | null = null;
/** Past this much of the song, picking up elsewhere is a jump, not a resume. */
const RESUME_WINDOW_SEC = 30;

function lengthOf(song: Song, durationSec: number): number {
  return Math.max(durationSec, song.duration ?? 0);
}

/**
 * Writes the song's position, or drops the bookmark when the song is as good
 * as over. `now` is for the moments that matter (a pause, a stop, another song
 * taking over); otherwise this is the heartbeat and it is throttled. Never a
 * timer of its own: Android freezes JS timers in the background, and the
 * player's own status beat is the one clock that keeps going there.
 */
function keep(song: Song, positionSec: number, durationSec: number, now: boolean): void {
  if (!bookmarkable(song) || lengthOf(song, durationSec) < RESUME_MIN_SEC) return;
  if (removedByHand === song.id) return;
  if (lengthOf(song, durationSec) - positionSec <= END_GRACE_SEC) {
    if (useBookmarks.getState().byId[song.id] && removing !== song.id) {
      lastSaved = null;
      removing = song.id;
      void removeBookmark(song.id)
        .catch(() => {})
        .finally(() => {
          if (removing === song.id) removing = null;
        });
    }
    return;
  }
  if (positionSec < MIN_SAVE_SEC) return;
  const same = lastSaved?.id === song.id ? lastSaved : null;
  if (same && !now && Date.now() - same.at < SAVE_EVERY_MS) return;
  if (same && Math.abs(same.positionSec - positionSec) < 1) return;
  lastSaved = { id: song.id, positionSec, at: Date.now() };
  void saveBookmark(song, positionSec).catch(() => {});
}

/** Seeks to the pending bookmark once both halves of `pending` are in. */
function applyResume(player: PlayerLike): void {
  const p = pending;
  if (!p || p.bookmark === undefined || !p.heard) return;
  pending = null;
  if (!p.bookmark) return;
  // Still this song, and still near its start: a seek landing under a thumb
  // already on the slider would take the song from where it had just been put.
  const st = player.getState();
  if (st.queue[st.index]?.id !== p.id || st.positionSec >= RESUME_WINDOW_SEC) return;
  const sec = p.bookmark.position / 1000;
  st.seekTo(sec);
  // What was just seeked to is what the server has: nothing to write back yet.
  lastSaved = { id: p.id, positionSec: sec, at: Date.now() };
  useToast.getState().show(tg('Resumed at {time}', { time: formatDuration(sec) }));
}

/** A long song has started: asks for its bookmark, to be applied on first beat. */
function startResume(song: Song, player: PlayerLike): void {
  if (!bookmarkable(song) || lengthOf(song, player.getState().durationSec) < RESUME_MIN_SEC) {
    return;
  }
  const id = song.id;
  pending = { id, bookmark: undefined, heard: false };
  loadBookmarks()
    .then(() => {
      if (pending?.id !== id) return;
      const bm = useBookmarks.getState().byId[id];
      pending.bookmark = bm && bm.position >= MIN_SAVE_SEC * 1000 ? bm : null;
      applyResume(player);
    })
    .catch(() => {
      if (pending?.id === id) pending = null;
    });
}

/**
 * Follows playback: the song leaving, the one starting, a pause and the
 * heartbeat while playing. Watching the store instead of hooking the actions
 * is what makes this cover every way a song stops or changes, the way the
 * server reports do.
 */
export function attachBookmarks(player: PlayerLike): void {
  player.subscribe((st, prev) => {
    const song = st.queue[st.index];
    const was = prev.queue[prev.index];
    if (was && was.id !== song?.id) {
      keep(was, prev.positionSec, prev.durationSec, true);
      pending = null;
      if (removedByHand === was.id) removedByHand = null;
    }
    if (!song) return;
    if (song.id !== was?.id) {
      // Only a song that is playing: a queue brought back on a cold start is
      // at the position it was left at, which is the one to keep.
      if (st.isPlaying) startResume(song, player);
      return;
    }
    if (prev.isPlaying && !st.isPlaying) {
      keep(song, st.positionSec, st.durationSec, true);
      return;
    }
    // Play pressed on a song still at its start: a list started while paused
    // puts its song in before it plays, so the change above saw it paused.
    if (!prev.isPlaying && st.isPlaying && st.positionSec < MIN_SAVE_SEC && !pending) {
      startResume(song, player);
      return;
    }
    if (!st.isPlaying || st.positionSec === prev.positionSec) return;
    if (pending?.id === song.id) {
      // The same guard as below: a beat still carrying the previous song's
      // position would call this one past its start and drop the resume.
      if (Math.abs(st.positionSec - prev.positionSec) > 2) return;
      if (st.positionSec >= RESUME_WINDOW_SEC) pending = null;
      else if (st.positionSec > 0) {
        pending.heard = true;
        applyResume(player);
      }
      return;
    }
    // One beat on from the last, not a jump: in the moment between the queue
    // changing and the player following it, a beat still carries the previous
    // song's position, and that is not where this one is.
    if (Math.abs(st.positionSec - prev.positionSec) <= 2) {
      keep(song, st.positionSec, st.durationSec, false);
    }
  });
}
