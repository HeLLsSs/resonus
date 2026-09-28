/**
 * The volume as somebody outside the app sees it, 0..1: the speaker's while
 * one plays, the phone's media volume while the phone does.
 *
 * The app's own gain (`player.volume`) is neither. It is what ReplayGain and
 * the fades work on, and it sits under the media volume: a phone at 30% is
 * at 30% whatever the gain says. So a slider on a Home Assistant card, or a
 * `volume` intent from Tasker, moves what the hardware keys would move.
 * Without the module (web, iOS) the gain is all there is, and it is what
 * moves.
 */
import { audioOutputAvailable, getMediaVolume, onMediaVolumeChanged, setMediaVolume } from '@/lib/audioOutput';
import { remoteKind, usePlayerStore } from '@/store/player';

/** Whether the level is the phone's media volume rather than a speaker's or the gain. */
function phonesOwn(): boolean {
  return audioOutputAvailable && !remoteKind();
}

export function volumeLevel(): number {
  if (phonesOwn()) {
    const { value, max } = getMediaVolume();
    return max > 0 ? value / max : 0;
  }
  return usePlayerStore.getState().volume;
}

export function setVolumeLevel(level: number): void {
  const clamped = Math.max(0, Math.min(1, level));
  if (phonesOwn()) {
    const { max } = getMediaVolume();
    if (max > 0) setMediaVolume(clamped * max);
    return;
  }
  usePlayerStore.getState().setVolume(clamped);
}

/**
 * One step of the level: what a press of the keys moves it by on the phone,
 * and what a slider on a speaker moves in, which has no steps of its own.
 */
export function volumeStep(): number {
  if (phonesOwn()) {
    const { max } = getMediaVolume();
    return max > 0 ? 1 / max : 1;
  }
  return 0.05;
}

/**
 * Every move of the level `volumeLevel` reads, from whichever side is
 * playing: the hardware keys while the phone is, the player's own volume
 * while a speaker is (or the gain, without the module). Handed the new
 * level. The return stops listening.
 */
export function onVolumeLevelChanged(cb: (level: number) => void): () => void {
  const stopMedia = onMediaVolumeChanged(({ value, max }) => {
    if (phonesOwn() && max > 0) cb(value / max);
  });
  const stopStore = usePlayerStore.subscribe((state, prev) => {
    if (state.volume !== prev.volume && !phonesOwn()) cb(state.volume);
  });
  return () => {
    stopMedia();
    stopStore();
  };
}
