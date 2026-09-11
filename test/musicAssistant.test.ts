/**
 * Music Assistant: the address it is reached at, the reading of a player, of
 * its queue and of the providers it holds, where a player is in its track,
 * which of the tracks we handed it is playing — by the queue's own index and,
 * failing that, by what it names — and the socket itself: its greeting, its
 * answers, its errors and the events that arrive between them.
 *
 * Nothing here opens a socket: the client takes the socket it is to use, and
 * the one below is an object that keeps what was sent and hands back what the
 * test says the server answered.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authenticate,
  handedIndexAt,
  handedIndexFor,
  libraryCandidates,
  MaClient,
  MusicAssistantError,
  nearEndOf,
  normalizeMaUrl,
  playerFrom,
  playersFrom,
  positionAt,
  providersFrom,
  queueFrom,
  queueTimeFrom,
  trackUri,
  wsUrlFor,
  type MaHanded,
  type MaSocket,
} from '@/lib/musicAssistant';

/** A player as `players/all` lists one. */
function rawPlayer(over: Record<string, unknown> = {}) {
  return {
    player_id: 'p1',
    name: 'Salon',
    provider: 'chromecast',
    available: true,
    powered: true,
    state: 'idle',
    volume_level: 60,
    volume_muted: false,
    elapsed_time: 0,
    elapsed_time_last_updated: 1_789_075_894.321,
    current_media: null,
    supported_features: ['play_media', 'seek'],
    ...over,
  };
}

describe('normalizeMaUrl', () => {
  it('gives a bare address the scheme and the port Music Assistant listens on', () => {
    assert.equal(normalizeMaUrl('192.0.2.10'), 'http://192.0.2.10:8095');
    assert.equal(normalizeMaUrl('  music.local  '), 'http://music.local:8095');
  });

  it('leaves an address that says its own scheme or port alone', () => {
    assert.equal(normalizeMaUrl('https://music.example.com'), 'https://music.example.com');
    assert.equal(normalizeMaUrl('192.0.2.10:8123'), 'http://192.0.2.10:8123');
    assert.equal(normalizeMaUrl('ws://192.0.2.10:8095'), 'ws://192.0.2.10:8095');
  });

  it('drops everything past the host, and answers nothing for nothing', () => {
    assert.equal(normalizeMaUrl('http://192.0.2.10:8095/settings/providers'), 'http://192.0.2.10:8095');
    assert.equal(normalizeMaUrl('   '), '');
  });
});

describe('wsUrlFor', () => {
  it('turns the address into the socket it is opened on', () => {
    assert.equal(wsUrlFor('192.0.2.10'), 'ws://192.0.2.10:8095/ws');
    assert.equal(wsUrlFor('https://music.example.com'), 'wss://music.example.com/ws');
    assert.equal(wsUrlFor(''), '');
  });
});

describe('playersFrom', () => {
  it('keeps the players that are there, by name, with the volume on the app’s scale', () => {
    const players = playersFrom([
      rawPlayer({ player_id: 'b', name: 'Cuisine', volume_level: 100 }),
      rawPlayer({ player_id: 'a', name: 'Bureau', available: false }),
      rawPlayer({ player_id: 'c', name: 'Attic', volume_level: 50 }),
      'not a player',
    ]);
    assert.deepEqual(
      players.map((p) => [p.playerId, p.name, p.volume]),
      [
        ['c', 'Attic', 0.5],
        ['b', 'Cuisine', 1],
      ],
    );
  });

  it('reads what a player is doing, and whether it is switched on', () => {
    const player = playerFrom(
      rawPlayer({
        state: 'playing',
        powered: false,
        current_media: { uri: 'library://track/3330', title: 'Parabola', duration: 365 },
      }),
    );
    assert.equal(player?.state, 'playing');
    assert.equal(player?.powered, false);
    assert.deepEqual(player?.media, { uri: 'library://track/3330', title: 'Parabola', durationSec: 365 });
  });

  it('says nothing about a power it was not told about, and knows no state it does not know', () => {
    const player = playerFrom(rawPlayer({ powered: undefined, state: 'wedged' }));
    assert.equal(player?.powered, null);
    assert.equal(player?.state, 'unknown');
  });

  it('prefers the name the house gave the player', () => {
    assert.equal(playerFrom(rawPlayer({ display_name: 'Salon (WiiM)' }))?.name, 'Salon (WiiM)');
  });

  it('is not a player without an id', () => {
    assert.equal(playerFrom({ name: 'Salon' }), null);
    assert.deepEqual(playersFrom('nonsense'), []);
  });
});

describe('positionAt', () => {
  const base = playerFrom(rawPlayer({ state: 'playing', elapsed_time: 100, elapsed_time_last_updated: 1000 }))!;

  it('counts the seconds gone by since the position was last learned', () => {
    assert.equal(positionAt(base, 1_004_000), 104);
  });

  it('leaves a paused player where it was, whatever the clock did', () => {
    assert.equal(positionAt({ ...base, state: 'paused' }, 1_900_000), 100);
  });

  it('never runs past the end of the track', () => {
    const playing = { ...base, media: { uri: null, title: null, durationSec: 102 } };
    assert.equal(positionAt(playing, 1_090_000), 102);
  });

  it('is nowhere when the player did not say', () => {
    assert.equal(positionAt({ ...base, elapsedSec: null }, 1_004_000), 0);
  });
});

describe('handedIndexFor', () => {
  const handed: MaHanded[] = [
    { uri: 'opensubsonic--X://track/aaa', title: 'One', songId: 'aaa' },
    { uri: 'opensubsonic--X://track/bbb', title: 'Two', songId: 'bbb' },
  ];

  it('matches the URI it was handed', () => {
    assert.equal(handedIndexFor({ uri: 'opensubsonic--X://track/bbb', title: null, durationSec: 0 }, handed), 1);
  });

  it('finds the song id inside a URI Music Assistant renamed', () => {
    assert.equal(handedIndexFor({ uri: 'library://track/9?src=aaa', title: null, durationSec: 0 }, handed), 0);
  });

  it('falls back to the title when the URI says nothing of ours', () => {
    assert.equal(handedIndexFor({ uri: 'library://track/9', title: 'Two', durationSec: 0 }, handed), 1);
  });

  it('is none of them for media that is somebody else’s', () => {
    assert.equal(handedIndexFor({ uri: 'spotify://track/z', title: 'Something', durationSec: 0 }, handed), -1);
    assert.equal(handedIndexFor(null, handed), -1);
  });

  it('never matches the empty URI a load is stamped with before it is known', () => {
    assert.equal(handedIndexFor({ uri: 'library://track/9', title: null, durationSec: 0 }, [
      { uri: '', title: '', songId: '' },
    ]), -1);
  });
});

describe('queueFrom and handedIndexAt', () => {
  /** A queue as `queue_updated` carries one, and `get_active_queue` answers. */
  const rawQueue = (over: Record<string, unknown> = {}) => ({
    queue_id: 'p1',
    active: true,
    name: 'Salon',
    state: 'playing',
    current_index: 4,
    elapsed_time: 12.5,
    items: 6,
    shuffle_enabled: false,
    repeat_mode: 'off',
    ...over,
  });

  it('reads where the queue is and how far into the track', () => {
    assert.deepEqual(queueFrom(rawQueue()), {
      queueId: 'p1',
      active: true,
      currentIndex: 4,
      elapsedSec: 12.5,
      fillsItself: null,
    });
  });

  it('says whether the queue adds songs of its own, and nothing when unsaid', () => {
    // Measured on a live server: a queue with this on answered one added track
    // with twenty-seven, the rest of its own choosing.
    assert.equal(queueFrom(rawQueue({ dont_stop_the_music_enabled: true }))?.fillsItself, true);
    assert.equal(queueFrom(rawQueue({ dont_stop_the_music_enabled: false }))?.fillsItself, false);
    assert.equal(queueFrom(rawQueue())?.fillsItself, null);
  });

  it('is still a queue when only the event’s object_id names it', () => {
    const queue = queueFrom(rawQueue({ queue_id: undefined, current_index: undefined }));
    assert.equal(queue?.queueId, null);
    assert.equal(queue?.currentIndex, null);
    assert.equal(queue?.active, true);
    assert.equal(queueFrom('nonsense'), null);
  });

  it('names the handed track the queue’s index stands for, from where ours begins', () => {
    // Three tracks handed over, the first of them at index 4 of the player's
    // own queue: index 5 is the second of ours.
    assert.equal(handedIndexAt(4, 4, 3), 0);
    assert.equal(handedIndexAt(5, 4, 3), 1);
    assert.equal(handedIndexAt(6, 4, 3), 2);
  });

  it('refuses an index that is none of the tracks handed over', () => {
    assert.equal(handedIndexAt(7, 4, 3), -1);
    assert.equal(handedIndexAt(3, 4, 3), -1);
    assert.equal(handedIndexAt(null, 0, 3), -1);
    assert.equal(handedIndexAt(1.5, 0, 3), -1);
    assert.equal(handedIndexAt(0, 0, 0), -1);
  });
});

describe('queueTimeFrom', () => {
  it('takes the position however the event carries one', () => {
    assert.equal(queueTimeFrom(93), 93);
    assert.equal(queueTimeFrom({ queue_id: 'p1', elapsed_time: 93.5 }), 93.5);
    assert.equal(queueTimeFrom(-2), 0);
  });

  it('says nothing rather than guess at a shape it does not recognise', () => {
    // The payload of this event was never seen from a live server; anything
    // that is not plainly a position leaves the player's own to be used.
    assert.equal(queueTimeFrom({ seconds: 93 }), null);
    assert.equal(queueTimeFrom('93'), null);
    assert.equal(queueTimeFrom(null), null);
  });
});

describe('providersFrom and libraryCandidates', () => {
  const providers = providersFrom([
    { instance_id: 'opensubsonic--4JU86B3S', domain: 'opensubsonic', name: 'OpenSubsonic Library', available: true },
    { instance_id: 'spotify--1', domain: 'spotify', name: 'Spotify', available: true },
    { instance_id: 'subsonic--old', domain: 'subsonic', name: 'An older one', available: false },
    { instance_id: 'jellyfin--1', domain: 'jellyfin', name: 'Jellyfin', available: true },
    { instance_id: 'chromecast', domain: 'chromecast', name: 'Chromecast', type: 'player' },
  ]);

  it('keeps the music providers, and drops what is not one where the server says', () => {
    assert.deepEqual(
      providers.map((p) => p.instanceId),
      ['opensubsonic--4JU86B3S', 'spotify--1', 'subsonic--old', 'jellyfin--1'],
    );
  });

  it('offers the libraries that could be this profile’s server, likeliest first', () => {
    assert.deepEqual(
      libraryCandidates(providers, 'navidrome').map((p) => p.instanceId),
      ['opensubsonic--4JU86B3S', 'subsonic--old'],
    );
    assert.deepEqual(
      libraryCandidates(providers, 'jellyfin').map((p) => p.instanceId),
      ['jellyfin--1'],
    );
  });

  it('offers none when the house has no library of that kind', () => {
    assert.deepEqual(libraryCandidates(providersFrom([]), 'navidrome'), []);
  });
});

describe('trackUri and nearEndOf', () => {
  it('names a track by the provider instance and the id the app already holds', () => {
    assert.equal(trackUri('opensubsonic--4JU86B3S', 'fadHVSLegiIfDFS6Vm8Vvn'), 'opensubsonic--4JU86B3S://track/fadHVSLegiIfDFS6Vm8Vvn');
  });

  it('takes a stop near the end of a track for the track ending', () => {
    assert.equal(nearEndOf(295, 300), true);
    assert.equal(nearEndOf(10, 300), false);
    assert.equal(nearEndOf(0, 0), true);
  });
});

// ── The socket ──────────────────────────────────────────────────────────────

/** The greeting a real server opens with. */
const HELLO = {
  server_id: 's1',
  server_version: '2.10.2',
  schema_version: 65,
  name: 'Maison',
};

/** A socket that is not a socket: it keeps what was sent and answers to order. */
class FakeSocket implements MaSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  /** What the server does with each command it is sent. */
  answer: ((message: Record<string, unknown>) => void) | null = null;

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    this.answer?.(message);
  }

  close(): void {
    this.closed = true;
  }

  /** The server saying something of its own accord. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** An open, greeted client and the socket under it. */
async function connected(): Promise<{ client: MaClient; socket: FakeSocket }> {
  const socket = new FakeSocket();
  const client = new MaClient('ws://host:8095/ws', () => socket);
  const opening = client.open();
  socket.receive(HELLO);
  await opening;
  return { client, socket };
}

describe('MaClient', () => {
  it('settles on the greeting, which is what says this is Music Assistant', async () => {
    const { client } = await connected();
    assert.equal(client.serverInfo?.version, '2.10.2');
    assert.equal(client.serverInfo?.name, 'Maison');
    client.close();
  });

  it('recognises its own answer even though the server echoes the id as a string', async () => {
    const { client, socket } = await connected();
    socket.answer = (message) => {
      // Exactly what the server does: the id comes back as text, whatever it
      // was sent as. A client comparing numbers would wait for ever.
      socket.receive({ message_id: String(message.message_id), result: [rawPlayer()], partial: false });
    };
    const players = await client.command<unknown[]>('players/all');
    assert.equal(socket.sent[0].command, 'players/all');
    assert.equal(typeof socket.sent[0].message_id, 'string');
    assert.equal(players.length, 1);
    client.close();
  });

  it('puts the pieces of a long answer back together', async () => {
    const { client, socket } = await connected();
    socket.answer = (message) => {
      const id = message.message_id;
      socket.receive({ message_id: id, result: [1, 2], partial: true });
      socket.receive({ message_id: id, result: [3], partial: false });
    };
    assert.deepEqual(await client.command('music/search'), [1, 2, 3]);
    client.close();
  });

  it('takes a refused token for a refusal and anything else for a no', async () => {
    const { client, socket } = await connected();
    socket.answer = (message) => {
      const bad = (message.command as string) === 'auth' ? 23 : 12;
      socket.receive({ message_id: message.message_id, error_code: bad, details: 'no' });
    };
    await assert.rejects(
      client.command('auth', { token: 'x' }),
      (e: unknown) => e instanceof MusicAssistantError && e.kind === 'unauthorized' && e.code === 23,
    );
    await assert.rejects(
      client.command('players/cmd/mute'),
      (e: unknown) => e instanceof MusicAssistantError && e.kind === 'other',
    );
    client.close();
  });

  it('hands events to the listener and never to a waiting command', async () => {
    const { client, socket } = await connected();
    const heard: string[] = [];
    client.onEvent = (event) => heard.push(`${event.event}:${event.objectId}`);
    socket.answer = (message) => {
      socket.receive({ event: 'player_updated', object_id: 'p1', data: rawPlayer() });
      socket.receive({ message_id: message.message_id, result: null, partial: false });
    };
    assert.equal(await client.command('players/cmd/play'), null);
    assert.deepEqual(heard, ['player_updated:p1']);
    client.close();
  });

  it('carries the queue the server pushes, index and all', async () => {
    const { client, socket } = await connected();
    const seen: (number | null)[] = [];
    client.onEvent = (event) => {
      if (event.event === 'queue_updated') seen.push(queueFrom(event.data)?.currentIndex ?? null);
    };
    // Unasked for, and interleaved with the events that are not acted on.
    socket.receive({ event: 'queue_items_updated', object_id: 'p1', data: {} });
    socket.receive({ event: 'queue_updated', object_id: 'p1', data: { queue_id: 'p1', current_index: 2 } });
    assert.deepEqual(seen, [2]);
    client.close();
  });

  it('tells whatever is waiting when the socket goes away, and says so once', async () => {
    const { client, socket } = await connected();
    let closed = 0;
    client.onClosed = () => closed++;
    socket.answer = () => {
      // The answer never comes: the connection drops instead.
      socket.onclose?.();
    };
    await assert.rejects(
      client.command('players/all'),
      (e: unknown) => e instanceof MusicAssistantError && e.kind === 'network',
    );
    assert.equal(closed, 1);
    // And a command after that does not wait on a socket that is gone.
    await assert.rejects(client.command('players/all'), MusicAssistantError);
  });
});

describe('authenticate', () => {
  it('uses the token it was given and keeps it', async () => {
    const { client, socket } = await connected();
    socket.answer = (message) => socket.receive({ message_id: message.message_id, result: null, partial: false });
    assert.equal(await authenticate(client, { token: 'kept', username: 'me', password: 'pw' }), 'kept');
    assert.deepEqual(socket.sent.map((m) => m.command), ['auth']);
    client.close();
  });

  it('signs in again when the token is refused, and comes back with the new one', async () => {
    const { client, socket } = await connected();
    // The stale token is refused, the sign-in hands out a fresh one, and that
    // one is presented back: signing in does not by itself let the socket do
    // anything, which the live server answers "Authentication is required".
    socket.answer = (message) => {
      if (message.command === 'auth' && (message.args as { token?: string })?.token === 'stale') {
        socket.receive({ message_id: message.message_id, error_code: 23, details: 'expired' });
        return;
      }
      if (message.command === 'auth') {
        socket.receive({ message_id: message.message_id, result: { authenticated: true }, partial: false });
        return;
      }
      socket.receive({
        message_id: message.message_id,
        result: { success: true, access_token: 'fresh', user: { name: 'me' } },
        partial: false,
      });
    };
    assert.equal(await authenticate(client, { token: 'stale', username: 'me', password: 'pw' }), 'fresh');
    assert.deepEqual(socket.sent.map((m) => m.command), ['auth', 'auth/login', 'auth']);
    assert.equal((socket.sent.at(-1)?.args as { token?: string })?.token, 'fresh');
    client.close();
  });

  it('reads a bad password off the body, which carries no error code', async () => {
    const { client, socket } = await connected();
    socket.answer = (message) =>
      socket.receive({
        message_id: message.message_id,
        result: { success: false, error: 'Invalid username or password' },
        partial: false,
      });
    await assert.rejects(
      authenticate(client, { username: 'me', password: 'wrong' }),
      (e: unknown) =>
        e instanceof MusicAssistantError && e.kind === 'unauthorized' && e.message === 'Invalid username or password',
    );
    client.close();
  });
});
