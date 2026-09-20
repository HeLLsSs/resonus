/**
 * One account, one music.
 *
 * Signing in on a second device used to mean two players going at once, each
 * unaware of the other: the phone in a pocket and the browser on the desk
 * playing different songs on the same account, and nothing but a card on Home
 * to say so, because Subsonic gives no way to tell a player anything
 * (`PlayingElsewhereCard`). The proxy now holds a spot per account, and this
 * is the half of it that lives in the app:
 *
 *   · starting playback takes the spot, whoever had it;
 *   · while playing, a beat says the spot is still in use;
 *   · a beat that comes back naming somebody else means playback moved on
 *     without us, and this device pauses and says where the music went.
 *
 * The beat is the native ticker and not a timer, for the same reason the
 * speakers' polling is: React Native stops `setInterval` with the screen, and
 * a phone that stopped beating would look like a phone that stopped playing,
 * so the desk would take the spot from a phone that is happily playing on.
 *
 * Nothing of this applies without the proxy behind it, offline, or in a Jam —
 * a Jam is several devices playing the same thing on purpose, which is the one
 * case where two players on one account is the point.
 */
import { beatPlayback, claimPlayback, releasePlayback, type PlaybackHolder } from '@/api/subsonic';
import { tg } from '@/i18n';
import { navifindActive } from '@/lib/navifind';
import { bump } from '@/lib/perfLog';
import { getItem, setItem } from '@/lib/storage';
import { everyMs } from '@/lib/ticker';
import { useAuthStore } from './auth';
import { isJamActive } from './jam';
import { usePlayerStore } from './player';
import { useSettings } from './settings';
import { useToast } from './toast';

/**
 * How often a playing device says so.
 *
 * It is also how long two devices can overlap: nothing can reach a player that
 * is not asking, so the one that lost the spot plays on until its next beat
 * tells it. Ten seconds is short enough not to be a second song in the next
 * room and long enough to be six requests a minute from a phone that is
 * playing anyway. Well inside the proxy's patience, so several beats can go
 * missing on a bad connection without the spot being handed to anybody else.
 */
const BEAT_MS = 10_000;

/** Where this device's name for itself is kept. Written once and never again:
 *  it is what tells this device from the same account's other ones. */
const DEVICE_KEY = 'resonus.playback.device';

let deviceId: Promise<string> | null = null;

/**
 * This device, by a name only it uses. Kept, so that reopening the app is not
 * a different device taking the spot from itself.
 *
 * The promise and not the answer is what is held: two calls at once — a claim
 * and the beat behind it — would both miss the store and mint a different id,
 * and the device would then read `mine: false` for its own claim and pause
 * itself.
 */
function thisDevice(): Promise<string> {
  deviceId ??= (async () => {
    const kept = await getItem(DEVICE_KEY);
    if (kept) return kept;
    const made = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await setItem(DEVICE_KEY, made);
    return made;
  })().catch(() => {
    // Storage that will not answer must not pin one broken id for the session.
    deviceId = null;
    throw new Error('no device id');
  });
  return deviceId;
}

/**
 * What kind of thing this is, for the sentence the other device shows.
 *
 * A kind rather than a name: it crosses to a device that may be reading in
 * another language, and a word it knows can be said there in that language
 * (see `deviceLabel`).
 */
function deviceKind(): string {
  return typeof window !== 'undefined' && typeof document !== 'undefined' ? 'browser' : 'phone';
}

/** A holder's kind in the reader's own language, or whatever it called
 *  itself if it is not a kind this version knows. */
function deviceLabel(holder: PlaybackHolder): string {
  if (holder.name === 'browser') return tg('the browser');
  if (holder.name === 'phone') return tg('the phone');
  return holder.name || tg('another device');
}

/** Whether the spot applies at all right now. */
function applies(): boolean {
  const { auth, offline } = useAuthStore.getState();
  return (
    !!auth &&
    !offline &&
    navifindActive() &&
    useSettings.getState().exclusivePlayback &&
    !isJamActive()
  );
}

function currentTitle(): string {
  const { queue, index } = usePlayerStore.getState();
  return queue[index]?.title ?? '';
}

/** Playback moved to another device: stop here, and say where it went. */
function stoppedByAnother(holder: PlaybackHolder): void {
  const player = usePlayerStore.getState();
  if (player.isPlaying) player.toggle();
  bump('playback spot · handed over to another device');
  useToast.getState().show(tg('Playing on {device}', { device: deviceLabel(holder) }));
}

/** Reads what an answer says, and acts on it. True while the spot is ours. */
function apply(holder: PlaybackHolder | null): boolean {
  if (!holder || holder.mine) return true;
  stoppedByAnother(holder);
  return false;
}

let started = false;
let beating: (() => void) | null = null;
/** What the button asked for, known the moment it is pressed. The answers
 *  below arrive later, and a pause can land in between. */
let wants = false;
/** The proxy has been told, as far as this device knows. */
let held = false;

async function take(): Promise<void> {
  wants = true;
  if (!applies()) return;
  const { auth } = useAuthStore.getState();
  if (!auth) return;
  const device = await thisDevice().catch(() => null);
  if (!device) return;
  const holder = await claimPlayback(auth, device, deviceKind(), currentTitle()).catch(() => null);
  // A proxy that cannot be reached is not a reason to refuse to play: the
  // spot is a courtesy between this account's devices, not a licence.
  held = holder === null ? true : apply(holder);
  // Paused while the claim was in flight. Without this the spot sits taken by
  // a device that stopped playing, and the next device to open the app is
  // told the music is on a phone that went quiet a minute ago.
  if (!wants) void give();
}

async function beat(): Promise<void> {
  if (!wants || !held || !applies()) return;
  const { auth } = useAuthStore.getState();
  if (!auth) return;
  const device = await thisDevice().catch(() => null);
  if (!device) return;
  const holder = await beatPlayback(auth, device, currentTitle()).catch(() => undefined);
  // Unreachable: nothing is decided from silence, and least of all that this
  // device should stop.
  if (holder === undefined) return;
  // Nobody holds it: the proxy forgot us while the network was away, and this
  // device is the one actually playing. Taking it back is only right because
  // an empty answer now means empty — the proxy reads under its own lock, so
  // it is no longer the half-written file of somebody else's claim.
  if (holder === null) {
    void take();
    return;
  }
  held = apply(holder);
}

async function give(): Promise<void> {
  wants = false;
  if (!held) return;
  held = false;
  const { auth } = useAuthStore.getState();
  if (!auth || !navifindActive()) return;
  const device = await thisDevice().catch(() => null);
  if (!device) return;
  await releasePlayback(auth, device).catch(() => null);
}

/**
 * Starts watching (idempotent, from the same place the Jam and the car are
 * started). The player's own state is what drives it: whatever made playback
 * start — a tap, the car, a headset, a deep link — comes through here.
 */
export function startPlaybackLock(): void {
  if (started) return;
  started = true;
  usePlayerStore.subscribe((state, prev) => {
    if (state.isPlaying === prev.isPlaying) return;
    if (state.isPlaying) {
      void take();
      beating?.();
      beating = everyMs(BEAT_MS, () => void beat());
    } else {
      beating?.();
      beating = null;
      void give();
    }
  });
}
