/**
 * One volume for a Jam, on the device that plays it.
 *
 * The others in the session are silent remotes, and a remote has volume keys:
 * pressing them moves this device's level, which is read here and sent to
 * the session, and the device that plays follows. The other way as well: the
 * session's volume is applied to every device in it, so the speakers move on
 * the one that plays and the keys on the others start from where the session
 * is. The level is whichever `lib/volumeLevel.ts` says: the phone's media
 * volume, a speaker's, or the gain where there is nothing else.
 *
 * Its own file rather than a part of the Jam store or the player: the volume
 * helpers read the player, the player drives the Jam, and the Jam store
 * cannot reach back to either without going round in a circle.
 */
import { onVolumeLevelChanged, setVolumeLevel, volumeLevel, volumeStep } from '@/lib/volumeLevel';
import { jamForgetLevel, jamReportVolume, setJamVolumeDevice } from '@/store/jam';
import { onOutputChanged } from '@/store/player';

let started = false;

/** Call once, from the bootstrap. */
export function startJamVolume(): void {
  if (started) return;
  started = true;
  setJamVolumeDevice({ apply: setVolumeLevel, read: volumeLevel, step: volumeStep });
  onVolumeLevelChanged((level) => jamReportVolume(level, true));
  onOutputChanged(jamForgetLevel);
}
