/**
 * The Jam in the car: a row of Home that opens one, and, while one is on,
 * its QR code where the passengers can see it.
 *
 * Android Auto draws four tabs at most and the four are spoken for (Home,
 * Recents, Library, YouTube), so the Jam lives on Home. One row opens a
 * session in guest mode, the way "Show the code to guests" does on the
 * phone: the car plays, the passengers scan and add songs from their
 * browsers, with no app and no account. A session under way turns the row
 * into a folder holding the code as a tile, which is the QR code itself, and
 * a row that ends it.
 *
 * A head unit shows no picture outside a row's artwork and the playback
 * screen's cover, so the QR code is drawn as both: the tile in the folder,
 * and, for a while after a press, in place of the cover of the song playing.
 * That is the screen the car jumps to on any press of a playable row, which
 * is what puts the code up in front of everybody the moment the Jam opens.
 * The proxy draws the code (`jam/qr`), asked for as PNG: a head unit decodes
 * a bitmap and not an SVG.
 */
import { CACHED_COVER } from '@/api/data';
import { tg } from '@/i18n';
import { JamError, jamQrUrl, type JamSession } from '@/lib/jam';
import { navifindActive } from '@/lib/navifind';
import { useAuthStore } from '@/store/auth';
import { endJam, isJamHost, leaveJam, startJam, useJam } from '@/store/jam';
import { usePlayerStore } from '@/store/player';
import { useToast } from '@/store/toast';

import type { CarNode } from './carAuto';

/** The folder of Home a session under way opens onto. */
export const JAM_ID = 'jam';
const START_ID = 'jam:start';
const SHOW_ID = 'jam:show';
const END_ID = 'jam:end';

/** How long the QR code stands in for the cover on the playback screen. */
export const QR_ON_SCREEN_MS = 2 * 60_000;

let qrUntil = 0;
let qrTimer: ReturnType<typeof setTimeout> | null = null;
const qrListeners = new Set<() => void>();

/** Whether a Jam could be opened from here: a proxy, an account, a connection. */
export function carJamAvailable(): boolean {
  const { auth, offline } = useAuthStore.getState();
  return navifindActive() && !!auth && !offline;
}

/** The session's QR code as the car can be handed it: marked for the phone to
 *  fetch, since the host will not go to a remote address (`remoteCover`). */
function qrArtwork(): string | undefined {
  const { auth } = useAuthStore.getState();
  const { session } = useJam.getState();
  if (!auth || !session) return undefined;
  return CACHED_COVER + jamQrUrl(auth.serverUrl, session.code, 'png');
}

function listening(n: number): string {
  return n === 1 ? tg('1 listening') : tg('{n} listening', { n });
}

/** The row that opens a session. */
function startRow(): CarNode {
  return {
    id: START_ID,
    title: tg('Start a Jam'),
    subtitle: tg('Passengers scan the code and add songs'),
    artworkUrl: 'res://ic_car_jam',
    playable: true,
  };
}

/** The row that ends the session, or leaves it from a phone that only joined. */
function endRow(session: JamSession): CarNode {
  return {
    id: END_ID,
    title: isJamHost() ? tg('End the Jam') : tg('Leave the Jam'),
    subtitle: listening(session.members.length),
    artworkUrl: 'res://ic_car_stop',
    playable: true,
  };
}

/**
 * The row of Home, or null where no Jam can be opened. A session under way
 * is a folder named after its code; none is a row that opens one.
 */
export function jamHomeRow(): CarNode | null {
  if (!carJamAvailable()) return null;
  const { session } = useJam.getState();
  if (!session) return startRow();
  return {
    id: JAM_ID,
    title: tg('Jam {code}', { code: session.code }),
    subtitle: listening(session.members.length),
    artworkUrl: 'res://ic_car_jam',
    playable: false,
    contentStyle: 'grid',
  };
}

/** What the folder holds: the code as a tile, and the way out. Empty with no session. */
export function jamFolderRows(): CarNode[] {
  const { session } = useJam.getState();
  if (!session) return [];
  return [
    {
      id: SHOW_ID,
      title: tg('Jam {code}', { code: session.code }),
      subtitle: tg('Tap to show it big on the screen'),
      artworkUrl: qrArtwork(),
      playable: true,
    },
    endRow(session),
  ];
}

/**
 * The row a spoken "start a Jam" or "stop the Jam" lands on (`spokenJam` in
 * `carAutoLayout`), or null when it asks for what is not there: a Jam to
 * open while one is on, one to end with none, any with no proxy to keep it.
 */
export function jamSpokenRow(asked: 'start' | 'end'): CarNode | null {
  if (!carJamAvailable()) return null;
  const { session } = useJam.getState();
  if (asked === 'start') return session ? null : startRow();
  return session ? endRow(session) : null;
}

export function isJamTap(mediaId: string): boolean {
  return mediaId === START_ID || mediaId === SHOW_ID || mediaId === END_ID;
}

/** A press on one of the rows above. Nothing plays or stops playing for it. */
export async function handleJamTap(mediaId: string): Promise<void> {
  if (mediaId === END_ID) {
    await (isJamHost() ? endJam() : leaveJam());
    return;
  }
  const toast = useToast.getState().show;
  // A session opened around silence is one nobody hears, and the car has no
  // playback screen to put the code on until something plays: nor for a code
  // asked for again.
  if (usePlayerStore.getState().queue.length === 0) {
    toast(tg('Play something first: the Jam shares what is playing'));
    return;
  }
  if (mediaId === START_ID) {
    try {
      await startJam({ guests: true, from: 'car' });
    } catch (e) {
      if (e instanceof JamError && e.kind === 'refused') toast(e.message);
      else toast(tg('Could not reach the Jam'));
      return;
    }
  }
  showJamQrOnCar();
}

/** Puts the QR code up in place of the cover for `QR_ON_SCREEN_MS`, and tells
 *  whoever mirrors the cover (`carAutoSync`) now and when the time is up. */
export function showJamQrOnCar(): void {
  qrUntil = Date.now() + QR_ON_SCREEN_MS;
  if (qrTimer) clearTimeout(qrTimer);
  qrTimer = setTimeout(() => {
    qrTimer = null;
    qrListeners.forEach((cb) => cb());
  }, QR_ON_SCREEN_MS);
  qrListeners.forEach((cb) => cb());
}

/** Takes the QR code down before its time: the session is over, and the next
 *  one, opened from the phone, is not to find it up. */
export function hideJamQrOnCar(): void {
  qrUntil = 0;
  if (qrTimer) clearTimeout(qrTimer);
  qrTimer = null;
}

/** The marked QR code to draw as the cover right now, or undefined when the
 *  cover is the cover: time up, or no session left to join. */
export function jamQrOnCar(): string | undefined {
  if (Date.now() >= qrUntil) return undefined;
  return qrArtwork();
}

export function onJamQrOnCar(cb: () => void): () => void {
  qrListeners.add(cb);
  return () => qrListeners.delete(cb);
}
