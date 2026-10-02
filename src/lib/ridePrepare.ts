/**
 * "Prepare the ride": the next songs of the queue downloaded before the bike
 * leaves the network behind, the way a song is downloaded from its menu (see
 * `store/downloads.ts`, which skips what is already on the phone and keeps
 * the Wi-Fi only rule). Which songs is `songsToPrepare` in `lib/rideMode.ts`;
 * this is the asking, and the word on how it is going.
 *
 * The ride screen shows the progress and may be closed before the downloads
 * are done, so what was asked for is kept here rather than in the screen,
 * and the toast at the end is shown wherever the app is by then.
 */
import { create } from 'zustand';

import { type Song } from '@/api/subsonic';
import { tg } from '@/i18n';
import { useDownloads } from '@/store/downloads';
import { useToast } from '@/store/toast';

interface RidePreparationState {
  /** The ids asked for, while the downloads run; nothing otherwise. */
  preparing: string[] | null;
}

export const useRidePreparation = create<RidePreparationState>(() => ({ preparing: null }));

/**
 * Downloads `songs` and says how many made it. Nothing while a preparation
 * is already running: a second tap on the button is impatience, not a
 * second request.
 */
export async function prepareRide(songs: Song[]): Promise<void> {
  if (useRidePreparation.getState().preparing || songs.length === 0) return;
  useRidePreparation.setState({ preparing: songs.map((s) => s.id) });
  try {
    await useDownloads.getState().downloadSongs(songs);
  } finally {
    useRidePreparation.setState({ preparing: null });
  }
  const { files } = useDownloads.getState();
  const done = songs.filter((s) => files[s.id]).length;
  // Nothing fetched is the download refusing to start (offline, or mobile
  // data with Wi-Fi only on), and it has said why itself.
  if (done === 0) return;
  useToast.getState().show(
    done === songs.length
      ? tg('Ride prepared: {n} songs downloaded', { n: done })
      : tg('Ride prepared: {done} of {total} songs downloaded', { done, total: songs.length }),
  );
}
