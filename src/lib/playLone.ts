/**
 * A record or a playlist of one song, tapped: the song plays, rather than a
 * screen opening on a list of one that takes a second tap to start. The same
 * as the Kodi add-on's app does (`kodi/…/screens.py`, `lone_song`).
 *
 * Hung on the `<Link>` of a cover (its own `onPress`, which runs before it
 * navigates): preventing the press is what keeps the screen from opening.
 */
import { getAlbum, getPlaylist, type Album, type Playlist } from '@/api/data';
import { haptic } from '@/lib/haptics';
import { usePlayerStore } from '@/store/player';

/** A press on a Link, a tap on the phone or a click on the web: only its
 *  `preventDefault` is of use here. */
export type Press = { preventDefault(): void };

/** Whether there is one song behind it, as far as its count says. */
export function isLone(item: { songCount?: number }): boolean {
  return item.songCount === 1;
}

/** Plays a record of one song in place of opening it. */
export function playLoneAlbum(event: Press, album: Album): void {
  if (!isLone(album)) return;
  event.preventDefault();
  haptic('light');
  getAlbum(album.id)
    .then(({ album: full, songs }) =>
      usePlayerStore.getState().playQueue(songs, 0, full.name, `/album/${album.id}`),
    )
    // playQueue shows its own failure toast; a record that cannot be read is
    // what the screen would have shown as empty.
    .catch(() => {});
}

/** Plays a playlist of one song in place of opening it. */
export function playLonePlaylist(event: Press, playlist: Playlist): void {
  if (!isLone(playlist)) return;
  event.preventDefault();
  haptic('light');
  getPlaylist(playlist.id)
    .then(({ playlist: full, songs }) =>
      usePlayerStore.getState().playQueue(songs, 0, full.name, `/playlist/${playlist.id}`),
    )
    .catch(() => {});
}
