/**
 * The keyboard and the browser's media session, bound to the player store.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { actionForKey, bindMediaSession, installKeys, isTyping } from '@/lib/webMedia';

import { playerCalls, resetPlayer, usePlayerStore } from './stubs/store-player';

const calls = () => playerCalls.map((c) => (c.name === 'seekTo' ? `seek:${c.args[0]}` : c.name));

beforeEach(() => {
  resetPlayer();
  usePlayerStore.setState({ isPlaying: true, positionSec: 30, durationSec: 200 });
});

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

describe('installKeys', () => {
  it('handles a key, prevents its default, and lets a shortcut with a modifier through', () => {
    let handler: ((e: Event) => void) | null = null;
    const doc = {
      addEventListener: (_: string, h: EventListenerOrEventListenerObject) => (handler = h as (e: Event) => void),
      removeEventListener: () => (handler = null),
    };
    const off = installKeys(doc as unknown as Document);
    let prevented = 0;
    const press = (key: string, extra: Record<string, unknown> = {}) =>
      handler?.({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, target: {}, preventDefault: () => prevented++, ...extra } as unknown as Event);
    press(' ');
    press('ArrowRight', { shiftKey: true });
    press('ArrowLeft', { ctrlKey: true });
    press(' ', { target: { tagName: 'INPUT' } });
    off();
    assert.deepEqual([calls(), prevented, handler], [['toggle', 'next'], 2, null]);
  });
});

describe('bindMediaSession', () => {
  it('binds play and pause to the state, next to the queue and the seeks to the position', () => {
    const handlers = new Map<string, MediaSessionActionHandler | null>();
    const session = { setActionHandler: (a: string, h: MediaSessionActionHandler | null) => handlers.set(a, h) } as unknown as MediaSession;
    bindMediaSession(session);
    handlers.get('play')?.({ action: 'play' });
    handlers.get('pause')?.({ action: 'pause' });
    handlers.get('nexttrack')?.({ action: 'nexttrack' });
    handlers.get('seekto')?.({ action: 'seekto', seekTime: 42 });
    handlers.get('seekforward')?.({ action: 'seekforward' });
    assert.deepEqual(calls(), ['toggle', 'next', 'seek:42', 'seek:40']);
  });
});
