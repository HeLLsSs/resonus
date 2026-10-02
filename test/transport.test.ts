/**
 * The one switch over the transport buttons: a state asked for is reached
 * and not toggled past, a toggle is a toggle, and a repeat mode is reached
 * through the store's own cycle, whichever way round it turns.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { applyTransport, SEEK_STEP_SEC, setRepeat } from '@/lib/transport';

import { playerCalls, resetPlayer, usePlayerStore } from './stubs/store-player';

const names = () => playerCalls.map((c) => c.name);
const seeks = () => playerCalls.filter((c) => c.name === 'seekTo').map((c) => c.args[0]);

beforeEach(() => {
  resetPlayer();
});

describe('applyTransport', () => {
  it('resumes only when paused and pauses only when playing', () => {
    applyTransport('resume');
    applyTransport('resume');
    applyTransport('pause');
    applyTransport('pause');
    assert.deepEqual([names(), usePlayerStore.getState().isPlaying], [['toggle', 'toggle'], false]);
  });

  it('toggles whatever the state', () => {
    applyTransport('toggle');
    applyTransport('toggle');
    assert.deepEqual(names(), ['toggle', 'toggle']);
  });

  it('passes next and previous straight through', () => {
    applyTransport('next');
    applyTransport('previous');
    assert.deepEqual(names(), ['next', 'previous']);
  });

  it('seeks no earlier than the start', () => {
    applyTransport('seek', 12.5);
    applyTransport('seek', -3);
    assert.deepEqual(seeks(), [12.5, 0]);
  });

  it('steps around the position, within the song', () => {
    usePlayerStore.setState({ positionSec: 5, durationSec: 12 });
    applyTransport('back');
    applyTransport('forward');
    usePlayerStore.setState({ positionSec: 30, durationSec: 200 });
    applyTransport('forward');
    assert.deepEqual(seeks(), [0, 11, 30 + SEEK_STEP_SEC]);
  });

  it('turns shuffle only when it is not already as asked', () => {
    applyTransport('shuffle', true);
    applyTransport('shuffle', true);
    applyTransport('shuffle', false);
    assert.deepEqual([names(), usePlayerStore.getState().shuffle], [['toggleShuffle', 'toggleShuffle'], false]);
  });

  it('reaches a repeat mode through the cycle', () => {
    applyTransport('repeat', 'one');
    assert.deepEqual([names(), usePlayerStore.getState().repeat], [['cycleRepeat', 'cycleRepeat'], 'one']);
  });
});

describe('setRepeat', () => {
  it('does nothing when the mode is already on', () => {
    usePlayerStore.setState({ repeat: 'all' });
    setRepeat('all');
    assert.deepEqual(names(), []);
  });

  it('does not cycle for ever after a mode the store never reaches', () => {
    setRepeat('loop' as never);
    assert.equal(names().length, 3);
  });
});
