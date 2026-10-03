/**
 * Whether to hand the music over to the home speaker, or back to the phone,
 * and which speaker: the rules, with nothing of the phone in them, so they
 * can be tested on their own. `lib/speakerSuggestSync.ts` reads the stores,
 * asks the speakers and shows the toast.
 */

/** The `homeHandoff` setting: leave it be, offer the speaker, or move to it. */
export type HandoffMode = 'off' | 'ask' | 'auto';

export function isHandoffMode(value: unknown): value is HandoffMode {
  return value === 'off' || value === 'ask' || value === 'auto';
}

/** What set the question off: the music starting, or the phone joining a Wi-Fi. */
export type HandoffTrigger = 'play' | 'wifi';

export interface HandoffFlags {
  mode: HandoffMode;
  trigger: HandoffTrigger;
  /** The music plays on the phone itself, not on a remote output. */
  onPhone: boolean;
  /** On Wi-Fi: a speaker is only reachable from its own network. */
  wifi: boolean;
  /** In a Jam the output is the Jam's business, not a toast's. */
  jam: boolean;
  /** On the motorbike the music stays in the helmet. */
  ride: boolean;
}

/**
 * Nothing, the "Continue at home?" offer, or the move itself. Joining a
 * Wi-Fi with the music already going is only acted on in `auto`: an offer
 * nobody asked for in the middle of a song is the nag the offer avoids.
 */
export function handoffAction(flags: HandoffFlags): 'none' | 'ask' | 'switch' {
  if (flags.mode === 'off' || !flags.onPhone || !flags.wifi || flags.jam || flags.ride) return 'none';
  if (flags.mode === 'auto') return 'switch';
  return flags.trigger === 'play' ? 'ask' : 'none';
}

export interface LeavingFlags {
  mode: HandoffMode;
  /** The music plays on the home speaker: the chosen one, or any when none is. */
  onHomeSpeaker: boolean;
  playing: boolean;
  /** Still on Wi-Fi, after the network changed. */
  wifi: boolean;
}

/**
 * Whether to bring the music back to the phone on leaving the Wi-Fi, rather
 * than wait for the speaker's silence to be noticed, which takes a good half
 * minute when every poll waits out its timeout. Only in `auto`.
 */
export function shouldReturnToPhone(flags: LeavingFlags): boolean {
  return flags.mode === 'auto' && flags.onHomeSpeaker && flags.playing && !flags.wifi;
}

/** A speaker played on before, and when it last was. */
export interface KnownSpeaker {
  host: string;
  usedAt: number;
}

/**
 * Which speaker to offer among those that answered: the home speaker when
 * one is chosen (`homeSpeakerHost`), and nothing else in its place when it
 * did not answer; otherwise the known one played on most recently. Null when
 * none fits. Two used at the same moment keep the order given.
 */
export function pickSpeaker(
  known: readonly KnownSpeaker[],
  answering: Iterable<string>,
  home = '',
): string | null {
  const heard = new Set(answering);
  if (home) return heard.has(home) ? home : null;
  let best: KnownSpeaker | null = null;
  for (const speaker of known) {
    if (!heard.has(speaker.host)) continue;
    if (!best || speaker.usedAt > best.usedAt) best = speaker;
  }
  return best?.host ?? null;
}
