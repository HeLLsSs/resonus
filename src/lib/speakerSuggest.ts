/**
 * Whether to offer a known LinkPlay speaker when the music starts on the
 * phone, and which one: the rules, with nothing of the phone in them, so
 * they can be tested on their own. `lib/speakerSuggestSync.ts` reads the
 * stores, asks the speakers and shows the toast.
 */

export interface SuggestFlags {
  /** The `suggestKnownSpeakers` setting. */
  enabled: boolean;
  /** The music just started on the phone itself, not on a remote output. */
  onPhone: boolean;
  /** On Wi-Fi: a speaker is only reachable from its own network. */
  wifi: boolean;
  /** In a Jam the output is the Jam's business, not a toast's. */
  jam: boolean;
  /** On the motorbike the music stays in the helmet. */
  ride: boolean;
}

/** A speaker played on before, and when it last was. */
export interface KnownSpeaker {
  host: string;
  usedAt: number;
}

export function shouldSuggest(flags: SuggestFlags): boolean {
  return flags.enabled && flags.onPhone && flags.wifi && !flags.jam && !flags.ride;
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
