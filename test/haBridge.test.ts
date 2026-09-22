/**
 * What is pushed to the Home Assistant card: the state the player is read
 * into, the address it goes to, and what is quiet enough not to be pushed at
 * all — a position that only ticked, against one that was seeked.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { bridgeStateFrom, publishHaState, webhookUrl } from '@/lib/haBridge';
import { useHomeAssistant } from '@/store/homeAssistant';

import { http } from './stubs/expo-fetch';
import { usePlayerStore } from './stubs/store-player';

/** A queue of one, playing, with the state the card would draw. */
function playing(fields: Partial<Parameters<typeof bridgeStateFrom>[1]> = {}) {
  return {
    isPlaying: true,
    queue: [{ id: '7', title: 'Blue Monday', artist: 'New Order', album: 'Power', albumId: 'a1', duration: 450 }],
    index: 0,
    streamInfo: null,
    durationSec: 450,
    positionSec: 12,
    shuffle: false,
    repeat: 'off' as const,
    ...fields,
  };
}

describe('bridgeStateFrom', () => {
  it('reads the song the queue is on', () => {
    assert.equal(bridgeStateFrom(0.6, playing()).title, 'Blue Monday');
  });

  it('lets a radio name what it is playing over the station', () => {
    const state = playing({
      queue: [{ id: '7', title: 'FIP', url: 'http://radio/stream' }],
      streamInfo: { title: 'Blue Monday', artist: 'New Order' },
    });
    assert.equal(bridgeStateFrom(0.6, state).title, 'Blue Monday');
  });

  it('falls back to the song duration when nothing is loaded yet', () => {
    assert.equal(bridgeStateFrom(0.6, playing({ durationSec: 0 })).duration, 450);
  });

  it('carries the volume it is handed, not the gain', () => {
    assert.equal(bridgeStateFrom(0.3, playing()).volume, 0.3);
  });

  it('rounds the position to the second', () => {
    assert.equal(bridgeStateFrom(0.6, playing({ positionSec: 12.7 })).position, 13);
  });
});

describe('webhookUrl', () => {
  it('is the house and the identifier', () => {
    const config = { enabled: true, url: 'http://ha.local:8123', webhookId: 'resonus_abc' };
    assert.equal(webhookUrl(config), 'http://ha.local:8123/api/webhook/resonus_abc');
  });

  it('is nothing while the identifier is missing', () => {
    assert.equal(webhookUrl({ enabled: true, url: 'http://ha.local:8123', webhookId: '' }), null);
  });

  it('is nothing while the switch is off', () => {
    assert.equal(webhookUrl({ enabled: false, url: 'http://ha.local:8123', webhookId: 'x' }), null);
  });
});

describe('publishHaState', () => {
  beforeEach(() => {
    http.reset();
    useHomeAssistant.setState({ enabled: true, url: 'http://ha.local:8123', webhookId: 'resonus_abc' });
    usePlayerStore.setState({ ...playing(), positionSec: 12, isPlaying: true });
    // Out of the way of whatever the last test left behind.
    publishHaState();
    http.reset();
  });

  it('says nothing while the position only ticked', () => {
    usePlayerStore.setState({ positionSec: 13 });
    publishHaState();
    assert.equal(http.calls.length, 0);
  });

  it('knows the clock runs faster at 1.5x', async () => {
    usePlayerStore.setState({ speed: 1.5 });
    publishHaState(true);
    http.reset();
    await new Promise((r) => setTimeout(r, 2_100));
    // 2.1 s at 1.5x is 3.15 s further on: the clock, not a seek.
    usePlayerStore.setState({ positionSec: 12 + 3.15 });
    publishHaState();
    assert.equal(http.calls.length, 0);
  });

  it('pushes a seek', () => {
    usePlayerStore.setState({ positionSec: 300 });
    publishHaState();
    assert.equal(http.calls.length, 1);
  });

  it('pushes a pause at once', () => {
    usePlayerStore.setState({ isPlaying: false });
    publishHaState();
    assert.equal(http.calls.length, 1);
  });

  it('pushes to the webhook', () => {
    usePlayerStore.setState({ isPlaying: false });
    publishHaState();
    assert.equal(http.calls[0]?.url, 'http://ha.local:8123/api/webhook/resonus_abc');
  });

  it('says nothing to a house that is not set up', () => {
    useHomeAssistant.setState({ webhookId: '' });
    usePlayerStore.setState({ isPlaying: false });
    publishHaState();
    assert.equal(http.calls.length, 0);
  });
});
