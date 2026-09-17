/**
 * What a browser gives a page that plays: the media keys of the keyboard and
 * the media bandeau of the system, through `navigator.mediaSession`, and the
 * keyboard itself. Both are bound to the player store, not to the audio
 * element: a pause from a media key is then the same pause as from the
 * button, one a Jam sends to everybody and a remote output hears.
 *
 * expo-audio binds the session to its audio element on the web, and knows
 * nothing of the queue: next and previous are seeks of ten seconds there,
 * and left unset as the app asks. `bindMediaSession` is called after it, and
 * puts the store in its place.
 */

/** What the store does at the transport's request. */
export interface Transport {
  isPlaying(): boolean;
  toggle(): void;
  next(): void;
  previous(): void;
  /** Seconds from the start of the song. */
  seekTo(sec: number): void;
  positionSec(): number;
  durationSec(): number;
}

/** What a key asks for, with nothing happening in a field where one is typing. */
export type KeyAction = 'toggle' | 'next' | 'previous' | 'back' | 'forward' | null;

/** A left or right arrow moves this far; with shift, it changes track. */
export const KEY_SEEK_SEC = 10;

export function actionForKey(key: string, shift: boolean, typing: boolean): KeyAction {
  if (typing) return null;
  switch (key) {
    case ' ':
    case 'k':
    case 'K':
      return 'toggle';
    case 'ArrowRight':
      return shift ? 'next' : 'forward';
    case 'ArrowLeft':
      return shift ? 'previous' : 'back';
    case 'MediaPlayPause':
      return 'toggle';
    case 'MediaTrackNext':
      return 'next';
    case 'MediaTrackPrevious':
      return 'previous';
    default:
      return null;
  }
}

export function perform(action: KeyAction, t: Transport): void {
  switch (action) {
    case 'toggle':
      t.toggle();
      break;
    case 'next':
      t.next();
      break;
    case 'previous':
      t.previous();
      break;
    case 'forward':
      t.seekTo(Math.min(t.positionSec() + KEY_SEEK_SEC, Math.max(0, t.durationSec() - 1)));
      break;
    case 'back':
      t.seekTo(Math.max(0, t.positionSec() - KEY_SEEK_SEC));
      break;
    case null:
      break;
  }
}

/** Whether the key was pressed somewhere text is typed, where it is text. */
export function isTyping(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** The keyboard, for the whole page; the return value takes it back. */
export function installKeys(t: Transport, doc: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): () => void {
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.metaKey || k.ctrlKey || k.altKey) return;
    const action = actionForKey(k.key, k.shiftKey, isTyping(k.target));
    if (!action) return;
    k.preventDefault();
    perform(action, t);
  };
  doc.addEventListener('keydown', onKey);
  return () => doc.removeEventListener('keydown', onKey);
}

/** The media keys and the system's media bandeau, bound to the store. */
export function bindMediaSession(t: Transport, session: MediaSession | undefined = globalThis.navigator?.mediaSession): void {
  if (!session) return;
  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // An action this browser does not know.
    }
  };
  set('play', () => {
    if (!t.isPlaying()) t.toggle();
  });
  set('pause', () => {
    if (t.isPlaying()) t.toggle();
  });
  set('nexttrack', () => t.next());
  set('previoustrack', () => t.previous());
  set('seekto', (details) => {
    if (details.seekTime != null) t.seekTo(details.seekTime);
  });
  set('seekforward', () => perform('forward', t));
  set('seekbackward', () => perform('back', t));
}
