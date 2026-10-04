/**
 * Which equaliser setting is heard, when there is one per output.
 *
 * Headphones, the phone's speaker and the car do not sound alike, and the
 * setting that fixes one makes another worse. With "One equalizer per output"
 * on, each of the phone's outputs keeps a setting of its own: the speaker,
 * wired headphones, USB, a hearing aid, and every Bluetooth device by its
 * name (a car, an intercom, a pair of earbuds). Moving the music to another
 * output brings its setting back; changing the equaliser changes the setting
 * of the output playing.
 *
 * Only the phone's own outputs: the filtering happens in the app's player, and
 * a speaker on the network (Cast, UPnP, a WiiM, Home Assistant) plays the
 * stream by itself, out of its reach.
 *
 * Pure on purpose (no stores, no native module) so it can be tested as is.
 */

/** What the equaliser sets: the switch, the ten gains and the preamp, in millibels. */
export interface EqSetting {
  enabled: boolean;
  levels: number[];
  preamp: number;
}

/** A phone output, as `lib/audioOutput.ts` describes it. */
export interface EqOutputDevice {
  kind: string;
  name: string;
}

/** The settings kept per output, by `eqOutputKey`. */
export type EqProfiles = Record<string, EqSetting>;

const BLUETOOTH = 'bluetooth:';

/**
 * The key an output's setting is kept under, or null when no output is known
 * (no module, nothing reported). Bluetooth devices are told apart by name,
 * since two of them are two different sounds; the rest by their kind, of which
 * a phone only ever has one.
 */
export function eqOutputKey(device: EqOutputDevice | null | undefined): string | null {
  if (!device?.kind) return null;
  return device.kind === 'bluetooth' ? `${BLUETOOTH}${device.name.trim()}` : device.kind;
}

/**
 * The setting heard on `key`: the single one with the option off or no output
 * known, the output's own otherwise. An output met for the first time starts
 * from the single one, so turning the option on changes nothing until a
 * setting is actually changed.
 */
export function activeEqSetting(
  perOutput: boolean,
  key: string | null,
  single: EqSetting,
  profiles: EqProfiles,
): EqSetting {
  if (!perOutput || !key) return single;
  return profiles[key] ?? single;
}

/** Where a change of `setting` is written: the output's profile, or the single setting. */
export function storeEqSetting(
  perOutput: boolean,
  key: string | null,
  single: EqSetting,
  profiles: EqProfiles,
  setting: EqSetting,
): { single: EqSetting; profiles: EqProfiles } {
  if (!perOutput || !key) return { single: setting, profiles };
  return { single, profiles: { ...profiles, [key]: setting } };
}
