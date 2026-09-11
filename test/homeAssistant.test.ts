/**
 * Home Assistant's media players: which entities count as one, what a poll
 * of a player says about where it is, which handed track it is on, and the
 * requests the client makes.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  handedIndexFor,
  handedTrackFor,
  HomeAssistantError,
  listPlayers,
  nearEndOf,
  normalizeHaUrl,
  playersFrom,
  playerStateFrom,
  playMedia,
  positionAt,
  type HaPlayerState,
} from '@/lib/homeAssistant';

import { http } from './stubs/expo-fetch';

const SEEK = 2;
const TURN_ON = 128;
const PLAY_MEDIA = 512;
const CLEAR_PLAYLIST = 8_192;
const ENQUEUE = 2_097_152;

/** An entity as `/api/states` lists it. */
function entity(id: string, attributes: Record<string, unknown>, state = 'idle') {
  return { entity_id: id, state, attributes };
}

describe('playersFrom', () => {
  it('keeps the media players that can be handed a URL, by name', () => {
    const players = playersFrom([
      entity('media_player.kitchen', { friendly_name: 'Kitchen', supported_features: PLAY_MEDIA | 4 }),
      entity('media_player.tv', { friendly_name: 'TV', supported_features: 4 | 16 }),
      entity('light.kitchen', { friendly_name: 'Kitchen light', supported_features: PLAY_MEDIA }),
      entity('media_player.attic', { friendly_name: 'Attic', supported_features: PLAY_MEDIA }, 'playing'),
    ]);
    assert.deepEqual(
      players.map((p) => [p.entityId, p.name, p.state]),
      [
        ['media_player.attic', 'Attic', 'playing'],
        ['media_player.kitchen', 'Kitchen', 'idle'],
      ],
    );
  });

  it('notes which players take a queue, and which are Music Assistant', () => {
    const [cast, mass, named] = playersFrom([
      entity('media_player.cast', { friendly_name: 'A', supported_features: PLAY_MEDIA }),
      entity('media_player.mass', { friendly_name: 'B', supported_features: PLAY_MEDIA | ENQUEUE, mass_player_id: 'x' }),
      entity('media_player.app', { friendly_name: 'C', supported_features: PLAY_MEDIA, app_name: 'Music Assistant' }),
    ]);
    assert.deepEqual([cast.canEnqueue, cast.musicAssistant], [false, false]);
    assert.deepEqual([mass.canEnqueue, mass.musicAssistant], [true, true]);
    assert.deepEqual([named.canEnqueue, named.musicAssistant], [false, true]);
  });

  it('knows a Music Assistant player by the app it runs', () => {
    // What a real install answers: the player id the older builds carried is
    // nowhere, and this is all there is to go on.
    const [player] = playersFrom([
      entity('media_player.ma_salon', {
        friendly_name: 'Salon',
        supported_features: PLAY_MEDIA | ENQUEUE,
        app_id: 'music_assistant',
        mass_player_type: 'player',
      }),
    ]);
    assert.equal(player.musicAssistant, true);
  });

  it('keeps one row per speaker, the one that can do most', () => {
    // The same speaker three times over, as a house answers: the integration
    // that found it, its command entity, and Music Assistant's own.
    const players = playersFrom([
      entity('media_player.gh_salon', { friendly_name: 'Salon', supported_features: PLAY_MEDIA }),
      entity('media_player.salon_cmd', { friendly_name: 'Salon', supported_features: PLAY_MEDIA | SEEK }),
      entity('media_player.ma_salon', {
        friendly_name: 'Salon',
        supported_features: PLAY_MEDIA | ENQUEUE | CLEAR_PLAYLIST | SEEK,
        app_id: 'music_assistant',
      }),
    ]);
    assert.equal(players.length, 1);
    assert.equal(players[0].entityId, 'media_player.ma_salon');
    assert.deepEqual([players[0].canEnqueue, players[0].canSeek], [true, true]);
  });

  it('knows its own URL inside the one the player reports back', () => {
    // What Music Assistant answers: the address it was handed, wrapped in a
    // URI of its own. Read as a different track, the app would follow a queue
    // that never moved.
    const url = 'http://10.0.0.2:4533/rest/stream.view?u=me&t=abc&id=song1';
    const handed = [{ url, title: 'Parabola', songId: 'song1', key: 'song1@0' }];
    const state = {
      state: 'playing',
      positionSec: 4,
      positionUpdatedAt: null,
      durationSec: 365,
      title: 'Something else entirely',
      contentId: `builtin://track/${url}`,
      volume: null,
    };
    assert.equal(handedIndexFor(state, handed), 0);
  });

  it('does not take the placeholder URL of a load for a match', () => {
    const handed = [{ url: '', title: 'Parabola', songId: 'song1', key: 'song1@0' }];
    const state = {
      state: 'playing',
      positionSec: 0,
      positionUpdatedAt: null,
      durationSec: 0,
      title: 'Anything',
      contentId: 'builtin://track/http://elsewhere/song',
      volume: null,
    };
    assert.equal(handedIndexFor(state, handed), -1);
  });

  it('keeps, from the entity it drops, the one that can wake the speaker', () => {
    // What a real house answers: Music Assistant plays the speaker best but
    // cannot switch it on, and the integration that found it can.
    const players = playersFrom([
      entity('media_player.wiim', { friendly_name: 'Kitchen', supported_features: PLAY_MEDIA | TURN_ON }, 'off'),
      entity('media_player.ma_wiim', {
        friendly_name: 'Kitchen',
        supported_features: PLAY_MEDIA | ENQUEUE | SEEK,
        app_id: 'music_assistant',
      }),
    ]);
    assert.equal(players.length, 1);
    assert.equal(players[0].entityId, 'media_player.ma_wiim');
    assert.equal(players[0].powerEntityId, 'media_player.wiim');
  });

  it('leaves out a player the integration has lost sight of', () => {
    const players = playersFrom([
      entity('media_player.gone', { friendly_name: 'Gone', supported_features: PLAY_MEDIA }, 'unavailable'),
      entity('media_player.here', { friendly_name: 'Here', supported_features: PLAY_MEDIA }, 'off'),
    ]);
    assert.deepEqual(players.map((p) => p.entityId), ['media_player.here']);
  });

  it('notes which players can be made to drop what they hold', () => {
    const [plain, clearable] = playersFrom([
      entity('media_player.a', { friendly_name: 'A', supported_features: PLAY_MEDIA | ENQUEUE }),
      entity('media_player.b', { friendly_name: 'B', supported_features: PLAY_MEDIA | ENQUEUE | CLEAR_PLAYLIST }),
    ]);
    assert.equal(plain.canClearPlaylist, false);
    assert.equal(clearable.canClearPlaylist, true);
  });

  it('names a player without a friendly name after its entity', () => {
    const [player] = playersFrom([entity('media_player.garage_speaker', { supported_features: PLAY_MEDIA })]);
    assert.equal(player.name, 'garage_speaker');
  });

  it('is nothing for an answer that is not a list of entities', () => {
    assert.deepEqual(playersFrom({ message: 'API running.' }), []);
    assert.deepEqual(playersFrom([null, 42, { attributes: null }]), []);
  });
});

describe('positionAt', () => {
  const stamp = '2026-09-10T10:00:00.250000+00:00';
  const stampMs = Date.parse('2026-09-10T10:00:00.250Z');

  it('lets the clock run from the stamp while playing', () => {
    const state = playerStateFrom(
      entity('media_player.a', { media_position: 30, media_position_updated_at: stamp, media_duration: 200 }, 'playing'),
    );
    assert.equal(positionAt(state, stampMs + 5_000), 35);
  });

  it('stays where it was while paused', () => {
    const state = playerStateFrom(
      entity('media_player.a', { media_position: 30, media_position_updated_at: stamp, media_duration: 200 }, 'paused'),
    );
    assert.equal(positionAt(state, stampMs + 5_000), 30);
  });

  it('never runs past the end of the track', () => {
    const state = playerStateFrom(
      entity('media_player.a', { media_position: 195, media_position_updated_at: stamp, media_duration: 200 }, 'playing'),
    );
    assert.equal(positionAt(state, stampMs + 60_000), 200);
  });

  it('is the start for a player that does not say', () => {
    const state = playerStateFrom(entity('media_player.a', {}, 'idle'));
    assert.equal(state.positionUpdatedAt, null);
    assert.equal(positionAt(state, stampMs), 0);
  });
});

describe('handedIndexFor', () => {
  const handed = [
    { url: 'http://music/stream?id=1', title: 'One' },
    { url: 'http://music/stream?id=2', title: 'Two' },
  ];
  const playing = (extra: Partial<HaPlayerState>): HaPlayerState => ({
    state: 'playing',
    positionSec: 0,
    positionUpdatedAt: null,
    durationSec: 0,
    title: null,
    contentId: null,
    volume: null,
    ...extra,
  });

  it('finds the track by the URL the player was handed', () => {
    assert.equal(handedIndexFor(playing({ contentId: 'http://music/stream?id=2', title: 'Something else' }), handed), 1);
  });

  it('falls back to the title for a player that names the media its own way', () => {
    assert.equal(handedIndexFor(playing({ contentId: 'library://track/9', title: 'Two' }), handed), 1);
  });

  it('is none of them for a player playing something else', () => {
    assert.equal(handedIndexFor(playing({ contentId: 'spotify:track:abc', title: 'Other' }), handed), -1);
  });
});

describe('handedTrackFor', () => {
  const handed = [
    { url: 'http://music/stream?id=1', title: 'One' },
    { url: 'http://music/stream?id=2', title: 'Two' },
  ];
  const poll = (state: string, extra: Partial<HaPlayerState> = {}): HaPlayerState => ({
    state,
    positionSec: 0,
    positionUpdatedAt: null,
    durationSec: 0,
    title: null,
    contentId: null,
    volume: null,
    ...extra,
  });

  it('is the track the player names, whatever it is doing with it', () => {
    assert.equal(handedTrackFor(poll('playing', { contentId: 'http://music/stream?id=2' }), handed, false), 1);
    assert.equal(handedTrackFor(poll('paused', { contentId: 'http://music/stream?id=1' }), handed, false), 0);
  });

  it('is none of them for a player with nothing loaded', () => {
    assert.equal(handedTrackFor(poll('idle', { contentId: 'http://music/stream?id=1' }), handed, true), -1);
    assert.equal(handedTrackFor(poll('off'), handed, true), -1);
  });

  it('is the track it holds for a player that renames the media it was handed', () => {
    const renamed = poll('playing', { contentId: 'library://track/9', title: 'Track 9' });
    assert.equal(handedTrackFor(renamed, handed, true), 0);
  });

  it('is none of them while somebody else is playing on the player', () => {
    const theirs = poll('playing', { contentId: 'spotify:track:abc', title: 'Their podcast' });
    assert.equal(handedTrackFor(theirs, handed, false), -1);
    assert.equal(handedTrackFor(theirs, [], true), -1);
  });
});

describe('nearEndOf', () => {
  it('is the last tenth of the track, and at least its last five seconds', () => {
    assert.equal(nearEndOf(175, 200), false);
    assert.equal(nearEndOf(181, 200), true);
    assert.equal(nearEndOf(20, 30), false);
    assert.equal(nearEndOf(26, 30), true);
  });

  it('takes a track of unknown length to have ended', () => {
    assert.equal(nearEndOf(0, 0), true);
  });
});

describe('normalizeHaUrl', () => {
  it('adds the scheme a bare address lacks and drops the trailing slash', () => {
    assert.equal(normalizeHaUrl(' 192.0.2.30:8123/ '), 'http://192.0.2.30:8123');
    assert.equal(normalizeHaUrl('https://ha.example.org/'), 'https://ha.example.org');
    assert.equal(normalizeHaUrl(''), '');
  });

  it('keeps the origin of a dashboard address that was pasted whole', () => {
    assert.equal(normalizeHaUrl('http://ha.local:8123/lovelace/0'), 'http://ha.local:8123');
    assert.equal(normalizeHaUrl('ha.local:8123/lovelace/0?edit=1#view'), 'http://ha.local:8123');
    assert.equal(normalizeHaUrl('https://ha.example.org/history?entity_id=media_player.a'), 'https://ha.example.org');
  });

  it('is nothing for an address with no host in it', () => {
    assert.equal(normalizeHaUrl('http://'), '');
    assert.equal(normalizeHaUrl('/lovelace/0'), '');
  });
});

describe('the client', () => {
  const config = { url: 'http://ha.local:8123', token: 'secret' };

  beforeEach(() => http.reset());

  it('asks for the states with the token as a bearer', async () => {
    http.answer = () => ({ status: 200, body: [entity('media_player.a', { supported_features: PLAY_MEDIA })] });
    const players = await listPlayers(config);
    assert.equal(players.length, 1);
    assert.equal(http.calls[0].url, 'http://ha.local:8123/api/states');
    assert.equal(http.calls[0].headers.Authorization, 'Bearer secret');
  });

  it('hands a player a URL as music, with a queue instruction only when asked', async () => {
    await playMedia(config, 'media_player.a', 'http://music/1', { title: 'One', artist: 'Ana' });
    await playMedia(config, 'media_player.a', 'http://music/2', { title: 'Two' }, 'add');
    const [first, second] = http.calls.map((c) => c.body as Record<string, unknown>);
    assert.equal(http.calls[0].url, 'http://ha.local:8123/api/services/media_player/play_media');
    assert.equal(first.entity_id, 'media_player.a');
    assert.equal(first.media_content_type, 'music');
    assert.equal(first.media_content_id, 'http://music/1');
    assert.equal('enqueue' in first, false);
    assert.equal(second.enqueue, 'add');
  });

  it('tells a refused token from a service that is down', async () => {
    http.answer = () => ({ status: 401, body: '401: Unauthorized' });
    await assert.rejects(listPlayers(config), (e: unknown) => e instanceof HomeAssistantError && e.kind === 'unauthorized');
    http.answer = () => ({ status: -1 });
    await assert.rejects(listPlayers(config), (e: unknown) => e instanceof HomeAssistantError && e.kind === 'network');
  });

  it('does not wait for ever on an answer whose body never arrives', async () => {
    http.answer = () => ({ status: 200, bodyFails: true });
    await assert.rejects(listPlayers(config), (e: unknown) => e instanceof HomeAssistantError && e.kind === 'network');
  });

  it("reports Home Assistant's own reason for a refusal", async () => {
    http.answer = () => ({ status: 400, body: { message: 'Entity media_player.a does not support this service.' } });
    await assert.rejects(
      playMedia(config, 'media_player.a', 'http://music/1', { title: 'One' }),
      (e: unknown) =>
        e instanceof HomeAssistantError && e.kind === 'other' && e.message.includes('does not support this service'),
    );
  });
});
