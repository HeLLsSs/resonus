/**
 * "Continue on <speaker>?": when the music starts on the phone and a LinkPlay
 * speaker played on before answers from the network, a toast offers it, and
 * taking the offer does what picking that speaker in the output sheet does.
 *
 * Once per speaker per run of the app, so the toast is a suggestion and not
 * a nag; the rules for when to ask are in `lib/speakerSuggest.ts`. Which
 * speakers were played on, and when, is kept on the phone: the LinkPlay
 * store remembers what it found, not what it was asked to play on.
 */
import { tg } from '@/i18n';
import { describe, type LinkPlayDevice, linkPlayAvailable } from '@/lib/linkplay';
import { pickSpeaker, shouldSuggest, type SuggestFlags } from '@/lib/speakerSuggest';
import { getItem, setItem } from '@/lib/storage';
import { isJamActive } from '@/store/jam';
import { linkPlayConnect, useLinkPlay } from '@/store/linkplay';
import { useNetworkType } from '@/store/networkType';
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

let used: Record<string, number> = {};
/** The speakers already offered this run, taken up or not. */
const suggested = new Set<string>();
let probing = false;
let lastProbeAt = 0;

function flags(): SuggestFlags {
  const network = useNetworkType.getState();
  return {
    enabled: useSettings.getState().suggestKnownSpeakers,
    onPhone: remoteKind() === null,
    wifi: network.connected && !network.cellular,
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
async function playOn(device: LinkPlayDevice): Promise<void> {
  await leaveRemoteOutputs(true, 'linkplay');
  const ok = await linkPlayConnect(device);
  if (!ok) useToast.getState().show(tg("Couldn't complete the action"));
}

async function consider(): Promise<void> {
  if (probing || !shouldSuggest(flags())) return;
  const candidates = useLinkPlay
    .getState()
    .devices.filter((d) => used[d.host] !== undefined && !suggested.has(d.host));
  if (candidates.length === 0 || Date.now() - lastProbeAt < PROBE_COOLDOWN_MS) return;
  probing = true;
  lastProbeAt = Date.now();
  try {
    const heard = await Promise.all(candidates.map((d) => answers(d.host)));
    const answering = candidates.filter((_, i) => heard[i]).map((d) => d.host);
    const host = pickSpeaker(
      candidates.map((d) => ({ host: d.host, usedAt: used[d.host] ?? 0 })),
      answering,
    );
    const device = candidates.find((d) => d.host === host);
    // The probe took a moment: the music may have stopped or moved meanwhile.
    if (!device || !usePlayerStore.getState().isPlaying || !shouldSuggest(flags())) return;
    suggested.add(device.host);
    useToast.getState().show(tg('Continue on {name}?', { name: device.name }), {
      label: tg('Play on {name}', { name: device.name }),
      run: () => void playOn(device),
    });
  } finally {
    probing = false;
  }
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
    if (state.isPlaying && !prev.isPlaying) void consider();
  });
}
