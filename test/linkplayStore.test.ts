/**
 * The LinkPlay store against a speaker played by the test: what the player
 * is told when the speaker still answers for the track before, ignores a
 * command, or is left while playing. The speaker is reached through a relay,
 * the way a browser reaches one, and asked where it is on a clock the test
 * turns.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { Song } from '@/api/subsonic';
import { cmd, type LinkPlayDevice, setLinkPlayRelay } from '@/lib/linkplay';
import { initLinkPlay, linkPlayConnect, linkPlayDisconnect, linkPlayLoad, linkPlayPause, linkPlayPlay } from '@/store/linkplay';
import type { RemoteEvents } from '@/store/upnp';

const T0 = 1_700_000_000_000;
/** How often the speaker is asked where it is, and how often around a load (the store's `POLL_MS` and `FAST_POLL_MS`). */
const POLL_MS = 1_500;
const FAST_POLL_MS = 400;
const DEVICE: LinkPlayDevice = { host: '10.0.0.5', name: 'Kitchen', model: 'WiiM_MINI', uuid: 'FF98', slave: false };
const SONGS: Song[] = [
  { id: 'one', title: 'One', duration: 200, url: 'http://s/one.mp3' },
  { id: 'two', title: 'Two', duration: 180, url: 'http://s/two.mp3' },
];

/** The speaker: what it answers when asked where it is, and every command it was given, in order. */
const speaker = {
  says: {} as Record<string, string>,
  commands: [] as string[],
  /** Which commands it holds the answer to until `answers()`: its API stalling. */
  holds: (_command: string) => false,
  held: [] as (() => void)[],
  answers(): void {
    this.held.shift()?.();
  },
};

function status(state: string, positionSec: number, durationSec: number): Record<string, string> {
  return { status: state, curpos: String(positionSec * 1000), totlen: String(durationSec * 1000), vol: '50' };
}

/** Everything the player was told, in order, each as the event's name and its arguments. */
const told: unknown[][] = [];
const events: RemoteEvents = {
  onConnected: () => void told.push(['connected']),
  onDisconnected: (...args) => void told.push(['disconnected', ...args]),
  onTrackChanged: (...args) => void told.push(['track', ...args]),
  onProgress: (...args) => void told.push(['progress', ...args]),
  onPlayingChanged: (...args) => void told.push(['playing', ...args]),
  onFinished: () => void told.push(['finished']),
};
const playingTold = () => told.filter(([event]) => event === 'playing');

initLinkPlay(events, () => ({ queue: SONGS, index: 0 }));
// After `initLinkPlay`, which looks for a proxy to relay through and, finding none, sets none.
setLinkPlayRelay({
  call: (_host, command) =>
    new Promise((resolve) => {
      if (command === cmd.player) {
        resolve(JSON.stringify(speaker.says));
      } else if (command === cmd.slaves) {
        resolve(JSON.stringify({ slaves: 0, slave_list: [] }));
      } else {
        speaker.commands.push(command);
        if (speaker.holds(command)) speaker.held.push(() => resolve('OK'));
        else resolve('OK');
      }
    }),
  list: async () => [],
});

/** Lets the answers on their way arrive. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The next poll, with what the speaker says by then. */
async function polled(says: Record<string, string>, afterMs = POLL_MS): Promise<void> {
  speaker.says = says;
  mock.timers.tick(afterMs);
  await settle();
}

/** The speaker taken as the output and heard once, with what the player was told so far forgotten. */
async function connected(says: Record<string, string>): Promise<void> {
  assert.equal(await linkPlayConnect(DEVICE), true);
  await polled(says);
  told.length = 0;
  speaker.commands = [];
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  speaker.says = status('stop', 0, 0);
  speaker.commands = [];
  speaker.holds = () => false;
  speaker.held = [];
  told.length = 0;
});

afterEach(async () => {
  await linkPlayDisconnect(true);
  speaker.held.splice(0).forEach((answer) => answer());
  mock.timers.reset();
});

describe('a track handed over', () => {
  it('keeps what the speaker says of the track before from the player until it has taken the new one', async () => {
    await connected(status('play', 150, 200));
    // The speaker is slow to take the track. Asked where it is meanwhile, it
    // answers for the track before, and says it is playing.
    speaker.holds = (command) => command.startsWith('setPlayerCmd:play:');
    const load = linkPlayLoad(SONGS[1], true, 30);
    await settle();
    const duringTheRoundTrip = { told: [...told], commands: [...speaker.commands] };
    mock.timers.tick(50);
    speaker.answers();
    assert.equal(await load, true);
    await polled(status('play', 0.5, 180), FAST_POLL_MS);
    assert.deepEqual(duringTheRoundTrip, { told: [], commands: [cmd.play('http://s/two.mp3')] });
    assert.deepEqual(speaker.commands, [cmd.play('http://s/two.mp3'), cmd.seek(30)]);
    assert.deepEqual(told.slice(0, 2), [
      ['progress', 0.5, 180],
      ['playing', true, false],
    ]);
  });

  it("hands a stream started partway in as it is, and puts the song's time back on what the speaker counts", async () => {
    await connected(status('stop', 0, 0));
    assert.equal(await linkPlayLoad(SONGS[1], true, 120, [], true), true);
    // The speaker counts from the start of what it was handed, and knows only the remainder.
    await polled(status('play', 5, 60), FAST_POLL_MS);
    assert.deepEqual(
      [speaker.commands, told[0]],
      [[cmd.play('http://s/two.mp3?timeOffset=120')], ['progress', 125, 180]],
    );
  });
});

describe('play and pause', () => {
  it('puts the player back when the speaker lets a play go by', async () => {
    await connected(status('pause', 40, 200));
    speaker.holds = (command) => command === cmd.resume;
    const play = linkPlayPlay();
    // Asked while the resume is still on its way, the speaker can only say
    // "pause": that is no word against the button just pressed.
    await polled(status('pause', 40, 200));
    const duringTheRoundTrip = playingTold();
    mock.timers.tick(50);
    speaker.answers();
    await play;
    // The resume was swallowed: the speaker still says so a poll later, and
    // the player hears it.
    await polled(status('pause', 40, 200));
    assert.deepEqual({ duringTheRoundTrip, afterwards: playingTold() }, { duringTheRoundTrip: [], afterwards: [['playing', false, false]] });
  });

  it('puts the player back when the speaker lets a pause go by', async () => {
    await connected(status('play', 40, 200));
    await linkPlayPause();
    await polled(status('play', 41, 200));
    assert.deepEqual(playingTold(), [['playing', true, false]]);
  });

  it('hands a speaker that stopped the track again, where it was, rather than a resume it would ignore', async () => {
    await connected(status('play', 120, 200));
    // The stream dropped: the speaker stopped where it was.
    await polled(status('stop', 120, 200));
    await linkPlayPlay();
    await polled(status('play', 120.5, 200), FAST_POLL_MS);
    assert.deepEqual(speaker.commands, [cmd.play('http://s/one.mp3'), cmd.seek(120)]);
  });
});

describe('leaving the speaker', () => {
  it('tells the player whether the speaker was playing', async () => {
    await connected(status('play', 90, 200));
    await linkPlayDisconnect();
    const left = [told.find(([event]) => event === 'disconnected')];
    await connected(status('pause', 90, 200));
    await linkPlayDisconnect();
    left.push(told.find(([event]) => event === 'disconnected'));
    assert.deepEqual(left, [
      ['disconnected', 90, true],
      ['disconnected', 90, false],
    ]);
  });

  it('takes a track asked to play, and not heard yet, as playing', async () => {
    await connected(status('stop', 0, 0));
    speaker.holds = (command) => command.startsWith('setPlayerCmd:play:');
    void linkPlayLoad(SONGS[0], true, 30);
    await settle();
    await linkPlayDisconnect();
    assert.deepEqual(
      told.find(([event]) => event === 'disconnected'),
      ['disconnected', 30, true],
    );
  });
});
