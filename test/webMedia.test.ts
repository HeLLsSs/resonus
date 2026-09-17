/**
 * The keyboard and the browser's media session, bound to the player store.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { actionForKey, bindMediaSession, installKeys, isTyping, perform, type Transport } from '@/lib/webMedia';

function transport(playing = true, position = 30, duration = 200) {
  const calls: string[] = [];
  const t: Transport = {
    isPlaying: () => playing,
    toggle: () => calls.push('toggle'),
    next: () => calls.push('next'),
    previous: () => calls.push('previous'),
    seekTo: (sec) => calls.push(`seek:${sec}`),
    positionSec: () => position,
    durationSec: () => duration,
  };
  return { t, calls };
}

describe('actionForKey', () => {
  it('maps the keys, and shift on an arrow changes track', () => {
    assert.equal(actionForKey(' ', false, false), 'toggle');
    assert.equal(actionForKey('k', false, false), 'toggle');
    assert.equal(actionForKey('ArrowRight', false, false), 'forward');
    assert.equal(actionForKey('ArrowRight', true, false), 'next');
    assert.equal(actionForKey('ArrowLeft', true, false), 'previous');
    assert.equal(actionForKey('MediaTrackNext', false, false), 'next');
    assert.equal(actionForKey('a', false, false), null);
  });

  it('does nothing where one is typing', () => {
    assert.equal(actionForKey(' ', false, true), null);
  });
});

describe('isTyping', () => {
  it('knows a field from the page', () => {
    assert.equal(isTyping({ tagName: 'input' }), true);
    assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isTyping({ tagName: 'DIV' }), false);
  });
});

describe('perform', () => {
  it('seeks ten seconds around the position, within the song', () => {
    const { t, calls } = transport(true, 5, 12);
    perform('back', t);
    perform('forward', t);
    assert.deepEqual(calls, ['seek:0', 'seek:11']);
  });
});

describe('installKeys', () => {
  it('handles a key, prevents its default, and lets a shortcut with a modifier through', () => {
    const { t, calls } = transport();
    let handler: ((e: Event) => void) | null = null;
    const doc = {
      addEventListener: (_: string, h: EventListenerOrEventListenerObject) => (handler = h as (e: Event) => void),
      removeEventListener: () => (handler = null),
    };
    const off = installKeys(t, doc as unknown as Document);
    let prevented = 0;
    const press = (key: string, extra: Record<string, unknown> = {}) =>
      handler?.({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, target: {}, preventDefault: () => prevented++, ...extra } as unknown as Event);
    press(' ');
    press('ArrowRight', { shiftKey: true });
    press('ArrowLeft', { ctrlKey: true });
    press(' ', { target: { tagName: 'INPUT' } });
    off();
    assert.deepEqual([calls, prevented, handler], [['toggle', 'next'], 2, null]);
  });
});

describe('bindMediaSession', () => {
  it('binds play and pause to the state, and next to the queue', () => {
    const { t, calls } = transport(true);
    const handlers = new Map<string, MediaSessionActionHandler | null>();
    const session = { setActionHandler: (a: string, h: MediaSessionActionHandler | null) => handlers.set(a, h) } as unknown as MediaSession;
    bindMediaSession(t, session);
    handlers.get('play')?.({ action: 'play' });
    handlers.get('pause')?.({ action: 'pause' });
    handlers.get('nexttrack')?.({ action: 'nexttrack' });
    handlers.get('seekto')?.({ action: 'seekto', seekTime: 42 });
    assert.deepEqual(calls, ['toggle', 'next', 'seek:42']);
  });
});
