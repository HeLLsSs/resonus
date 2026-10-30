/**
 * The passengers' additions to the Jam, said aloud in the car and the helmet.
 *
 * A guest who scanned the code and put a song in gets no other acknowledgement
 * where the screen is not being looked at: the queue grows behind the song
 * playing and nobody up front knows until it comes round. So while car mode
 * or ride mode is on, each addition is read out through the same voice as
 * the songs, after whatever is being said rather than over it. A burst of
 * them, a guest filling the queue from a playlist, is one line with a count:
 * six titles in a row is noise.
 *
 * On the phone alone nothing is said: the queue screen shows who added what.
 */
import { tg, type TFunction } from '@/i18n';
import { onCall, speak } from '@/lib/rideMode';
import { type GuestAddition, onGuestAdditions, useJam } from '@/store/jam';
import { useRideMode } from '@/store/rideMode';

/** How long additions wait for the ones right behind them before they are said. */
export const COALESCE_MS = 3_000;

/**
 * The lines for a burst of additions, one per guest in order of their first:
 * the title for one song, a count for more. A guest gone since is "a guest".
 */
export function additionSentences(additions: GuestAddition[], t: TFunction = tg): string[] {
  const byGuest = new Map<string, { title: string; n: number }>();
  for (const { name, title } of additions) {
    const who = name || t('A guest');
    byGuest.set(who, { title, n: (byGuest.get(who)?.n ?? 0) + 1 });
  }
  return Array.from(byGuest, ([name, { title, n }]) =>
    n === 1 ? t('{name} added {title}', { name, title }) : t('{name} added {n} songs', { name, n }),
  );
}

/** Whether the mode that is on, ride mode first, wants a voice at all: the switch the songs obey (`rideSync`). */
function announcing(): boolean {
  const { active, carActive, config } = useRideMode.getState();
  return active ? config.announce : carActive && config.car.announce;
}

let pending: GuestAddition[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let inCall = false;

/** Once per runtime, from `startRideSync`. */
export function startJamVoice(): void {
  onCall((on) => {
    inCall = on;
  });
  // Additions still waiting when the session ends are not read out after
  // "the Jam has ended".
  useJam.subscribe((state, prev) => {
    if (state.session || !prev.session) return;
    pending = [];
    if (timer) clearTimeout(timer);
    timer = null;
  });
  onGuestAdditions((additions) => {
    pending.push(...additions);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const burst = pending;
      pending = [];
      // Judged as they are said rather than as they arrived: a call that
      // came in between is not spoken over, and a mode started in between
      // wanted to hear them.
      if (!announcing() || inCall) return;
      for (const line of additionSentences(burst)) speak(line, true);
    }, COALESCE_MS);
  });
}
