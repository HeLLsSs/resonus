/**
 * "Continue at home?": when the music starts on the phone and a LinkPlay
 * speaker answers from the network, a toast offers it, and taking the offer
 * does what picking that speaker in the output sheet does. The speaker is
 * the home speaker from the settings when one is chosen, whether or not it
 * was ever played on; otherwise the one played on most recently.
 *
 * Set to switch on its own, the music moves without asking, also when the
 * phone joins a Wi-Fi with the music already going, with an "Undo" to bring
 * it back; and it comes back to the phone when the phone leaves the Wi-Fi
 * with the music on the home speaker.
 *
 * Once per speaker per run of the app, so the toast is a suggestion and not
 * a nag; the rules for when to ask are in `lib/speakerSuggest.ts`. Which
 * speakers were played on, and when, is kept on the phone: the LinkPlay
 * store remembers what it found, not what it was asked to play on.
 */
import { tg } from '@/i18n';
import { describe, type LinkPlayDevice, linkPlayAvailable } from '@/lib/linkplay';
import {
  handoffAction,
  type HandoffFlags,
  type HandoffTrigger,
  pickSpeaker,
  shouldReturnToPhone,
} from '@/lib/speakerSuggest';
import { getItem, setItem } from '@/lib/storage';
import { isJamActive } from '@/store/jam';
import { linkPlayConnect, useLinkPlay } from '@/store/linkplay';
import { useNetworkType } from '@/store/networkType';
import { applyTransport } from '@/lib/transport';
import { leaveRemoteOutputs, remoteKind, usePlayerStore } from '@/store/player';
import { useRideMode } from '@/store/rideMode';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';

/** Where the speakers played on are kept, by address, with when they last were. */
const USED_KEY = 'resonus.linkplay.used';
/** How long a speaker gets to answer before it is taken to be off or away. */
const PROBE_MS = 1_500;
/** How long after a probe the next play start is left alone: a pause and a
 *  resume a few seconds apart are one listening session, not two chances. */
const PROBE_COOLDOWN_MS = 60_000;
/** How long a Wi-Fi just joined gets to settle before a speaker on it is asked. */
const JOIN_SETTLE_MS = 3_000;
/** How long the Wi-Fi has to stay gone before the music leaves the speaker:
 *  a phone hopping between access points drops it for a moment. */
const LEAVE_CONFIRM_MS = 5_000;

let used: Record<string, number> = {};
/** The speakers already offered or switched to this run, taken up or not. */
const suggested = new Set<string>();
let probing = false;
let lastProbeAt = 0;

function onWifi(): boolean {
  const network = useNetworkType.getState();
  return network.connected && !network.cellular;
}

function flags(trigger: HandoffTrigger): HandoffFlags {
  return {
    mode: useSettings.getState().homeHandoff,
    trigger,
    onPhone: remoteKind() === null,
    wifi: onWifi(),
    jam: isJamActive(),
    ride: useRideMode.getState().active,
  };
}

/** Whether something at this address answers as a speaker within `PROBE_MS`. */
function answers(host: string): Promise<boolean> {
  return Promise.race([
    describe(host).then((device) => device !== null),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROBE_MS)),
  ]);
}

/** What the output sheet does when that speaker's row is tapped. */
async function playOn(device: LinkPlayDevice): Promise<boolean> {
  await leaveRemoteOutputs(true, 'linkplay');
  const ok = await linkPlayConnect(device);
  if (!ok) useToast.getState().show(tg("Couldn't complete the action"));
  return ok;
}

async function switchTo(device: LinkPlayDevice): Promise<void> {
  if (!(await playOn(device))) return;
  useToast.getState().show(tg('Now playing at home on {name}', { name: device.name }), {
    label: tg('Undo'),
    // What "This phone" in the output sheet does, if the music is still there.
    // Undo puts things back as they were, and they were playing: the return
    // to the phone lands paused, so it is set going again.
    run: () => {
      if (useLinkPlay.getState().host !== device.host) return;
      void leaveRemoteOutputs().then(() => applyTransport('resume'));
    },
  });
}

async function consider(trigger: HandoffTrigger): Promise<void> {
  if (probing || handoffAction(flags(trigger)) === 'none') return;
  const home = useSettings.getState().homeSpeakerHost;
  const candidates = useLinkPlay
    .getState()
    .devices.filter(
      (d) => (home ? d.host === home : used[d.host] !== undefined) && !suggested.has(d.host),
    );
  if (candidates.length === 0 || Date.now() - lastProbeAt < PROBE_COOLDOWN_MS) return;
  probing = true;
  lastProbeAt = Date.now();
  try {
    const heard = await Promise.all(candidates.map((d) => answers(d.host)));
    const answering = candidates.filter((_, i) => heard[i]).map((d) => d.host);
    const host = pickSpeaker(
      candidates.map((d) => ({ host: d.host, usedAt: used[d.host] ?? 0 })),
      answering,
      home,
    );
    const device = candidates.find((d) => d.host === host);
    // The probe took a moment: the music may have stopped or moved meanwhile.
    const action = handoffAction(flags(trigger));
    if (!device || !usePlayerStore.getState().isPlaying || action === 'none') return;
    suggested.add(device.host);
    if (action === 'switch') {
      await switchTo(device);
      return;
    }
    useToast.getState().show(tg('Continue at home?'), {
      label: tg('Play on {name}', { name: device.name }),
      run: () => void playOn(device),
    });
  } finally {
    probing = false;
  }
}

function leaving(): boolean {
  const home = useSettings.getState().homeSpeakerHost;
  const { host } = useLinkPlay.getState();
  return shouldReturnToPhone({
    mode: useSettings.getState().homeHandoff,
    onHomeSpeaker: remoteKind() === 'linkplay' && (!home || host === home),
    playing: usePlayerStore.getState().isPlaying,
    wifi: onWifi(),
  });
}

/**
 * The music back on the phone, where the speaker last said it was, as soon
 * as the Wi-Fi is gone for good. A speaker that still answers means the
 * internet went, not the phone: the music stays on it.
 */
async function considerLeaving(): Promise<void> {
  const { host } = useLinkPlay.getState();
  if (!host || !leaving() || (await answers(host))) return;
  if (leaving() && useLinkPlay.getState().host === host) await leaveRemoteOutputs();
}

/** Starts watching for the music starting on the phone. Once, from `bootstrap.ts`. */
export function startSpeakerSuggest(): void {
  if (!linkPlayAvailable()) return;
  void getItem(USED_KEY).then((raw) => {
    try {
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      if (parsed && typeof parsed === 'object') {
        for (const [host, at] of Object.entries(parsed)) {
          if (typeof at === 'number') used[host] = at;
        }
      }
    } catch {
      // Nothing played on yet.
    }
  });
  useLinkPlay.subscribe((state, prev) => {
    if (!state.host || state.host === prev.host) return;
    used = { ...used, [state.host]: Date.now() };
    void setItem(USED_KEY, JSON.stringify(used));
  });
  usePlayerStore.subscribe((state, prev) => {
    if (state.isPlaying && !prev.isPlaying) void consider('play');
  });
  useNetworkType.subscribe((state, prev) => {
    const wifi = state.connected && !state.cellular;
    const wasWifi = prev.connected && !prev.cellular;
    if (wifi === wasWifi || useSettings.getState().homeHandoff !== 'auto') return;
    if (wifi) {
      setTimeout(() => {
        if (onWifi() && usePlayerStore.getState().isPlaying) void consider('wifi');
      }, JOIN_SETTLE_MS);
    } else if (leaving()) {
      setTimeout(() => void considerLeaving(), LEAVE_CONFIRM_MS);
    }
  });
}
